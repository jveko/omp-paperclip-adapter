import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "../server/acp.js";
import { readLedgerRecords } from "./ledger.js";
import { startHost } from "./server.js";
import { readDiscovery } from "./socket.js";
import { startFakeMcp } from "../../test/fake-mcp.js";

/**
 * Phase-1 acceptance on the shipped binary: the adapter spawns `dist/omp-host.js`
 * exactly as it does in production, drives a fake `omp --mode rpc` worker, and
 * must survive the supervisor being killed mid-run.
 */

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/fake-rpc.mjs",
);
const hostScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../dist/omp-host.js",
);

function ctx(
  mode: string,
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext & { onUsage?: (receipt: Record<string, unknown>) => Promise<void> } {
  return {
    runId: `run-${mode || "default"}-${process.pid}`,
    agent: {
      id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null,
    },
    runtime: {
      sessionId: null,
      sessionParams: { acpSessionId: "sess-0", sessionKey: "paperclip:co-1:agent-1:task" },
      sessionDisplayId: null,
      taskKey: "task",
    },
    config: {
      agentCommand: `${process.execPath} ${fixture}`,
    },
    context: { taskId: "0b8f0d5e-9a10-4f6a-8f2b-1c2d3e4f5a6b" },
    authToken: "run-jwt-ACCEPTANCE",
    onLog: async () => {},
    onEvent: async () => {},
    ...overrides,
  } as AdapterExecutionContext & { onUsage?: (receipt: Record<string, unknown>) => Promise<void> };
}

function envMode(overrides: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

describe("phase 1 acceptance on dist/omp-host.js", () => {
  let home: string;
  let instanceRoot: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "omp-accept-"));
    instanceRoot = path.join(home, "instances", "accept");
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "accept");
    // The spawned host inherits this env and drains by itself after the run.
    envMode({ OMP_HOST_IDLE_MS: "400", OMP_HOST_WORKER_IDLE_MS: "400" });
    expect(existsSync(hostScript), "test/global-setup.ts must build dist/omp-host.js").toBe(true);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await killSupervisor();
    await rm(home, { recursive: true, force: true });
  });

  async function killSupervisor(): Promise<void> {
    const discovery = await readDiscovery(path.join(instanceRoot, "omp-host"));
    if (discovery === null) return;
    try {
      process.kill(discovery.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, 25);
      await tick.promise;
      try {
        process.kill(discovery.pid, 0);
      } catch {
        return;
      }
    }
  }

  it("settles a managed run through the spawned supervisor binary", async () => {
    const run = createOmpAcpExecutor({ hostScript });
    const spawns: Array<{ pid: number; processGroupId: number | null }> = [];
    const usages: Array<Record<string, unknown>> = [];
    const result = await run(ctx("", {
      onSpawn: async (meta) => {
        spawns.push({ pid: meta.pid, processGroupId: meta.processGroupId });
      },
      onUsage: async (receipt) => {
        usages.push(receipt);
      },
    }));
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 110, outputTokens: 20, cachedInputTokens: 40 });
    expect(result.sessionParams).toMatchObject({
      acpSessionId: "sess-1",
      sessionKey: "paperclip:co-1:agent-1:task",
    });
    expect(spawns).toHaveLength(1);
    expect(usages).toHaveLength(1);
    // The adapter forwards the supervisor's own runtime evidence unchanged.
    expect((result.resultJson as Record<string, unknown>).hostRuntime).toMatchObject({
      workerPid: spawns[0].pid,
      reusedWorker: false,
      settledBy: "outcome",
    });

    const hostRoot = path.join(instanceRoot, "omp-host");
    // `run.settled` is sent before the `closed` journal line, and the idle host
    // may exit as soon as the connection drops; poll the on-disk truth.
    await vi.waitFor(async () => {
      const records = await readLedgerRecords(hostRoot);
      expect(records.map((record) => record.state)).toEqual([
        "leased", "worker_ready", "session_open", "prompting", "settled", "closed",
      ]);
    }, { timeout: 5_000, interval: 25 });
    const raw = await readFile(path.join(hostRoot, "ledger.jsonl"), "utf8");
    expect(raw).not.toContain("run-jwt-ACCEPTANCE");
    const contextDirs = await readdir(path.join(hostRoot, "run-context")).catch(() => []);
    expect(contextDirs).toEqual([]);
  }, 45_000);

  it("omits hostRuntime when the supervisor never starts", async () => {
    // A run that never reaches a supervisor has no worker, no settle record and
    // therefore no runtime evidence: the adapter must not invent any.
    const run = createOmpAcpExecutor({ hostScript: path.join(home, "no-such-omp-host.js") });
    const result = await run(ctx("unreachable"));
    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe("omp_host_unavailable");
    expect(result.resultJson).toBeUndefined();
  }, 30_000);

  it("serves the run's connection tools as host tools through the spawned binary", async () => {
    const mcp = await startFakeMcp();
    try {
      const run = createOmpAcpExecutor({ hostScript });
      const result = await run(ctx("", {
        config: {
          agentCommand: `${process.execPath} ${fixture}`,
          env: { FAKE_RPC_MODE: "hosttool" },
        },
        runtimeTools: {
          version: 1,
          guidance: "Connection tools",
          mcpEndpoint: mcp.url,
          rest: { connectionsSearch: `${mcp.url}/search`, connectionRequest: `${mcp.url}/request` },
          bearerToken: "ct-ACCEPTANCE",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          tools: ["connections_search", "connection_request"],
        },
      } as never));
      expect(result.exitCode).toBe(0);
      expect(mcp.calls).toHaveLength(1);
      expect(mcp.calls[0]).toMatchObject({
        tool: "connections_search",
        arguments: { query: "acme" },
        authorization: "Bearer ct-ACCEPTANCE",
      });
      const raw = await readFile(path.join(instanceRoot, "omp-host", "ledger.jsonl"), "utf8");
      expect(raw).not.toContain("ct-ACCEPTANCE");
    } finally {
      await mcp.close();
    }
  }, 45_000);

  it("survives kill -9 of the supervisor, then reaps the orphan on restart", async () => {
    const run = createOmpAcpExecutor({ hostScript });
    const spawned = Promise.withResolvers<number>();
    const running = run(ctx("", {
      // A hung worker: the host is killed while the run is still prompting.
      config: {
        agentCommand: `${process.execPath} ${fixture}`,
        env: { FAKE_RPC_MODE: "survive" },
      },
      onSpawn: async (meta) => {
        spawned.resolve(meta.pid);
      },
    }));
    const workerPid = await spawned.promise;
    const hostRoot = path.join(instanceRoot, "omp-host");
    const discovery = await readDiscovery(hostRoot);
    expect(discovery?.pid).toBeGreaterThan(0);

    process.kill(discovery.pid as number, "SIGKILL");

    const result: AdapterExecutionResult = await running;
    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe("omp_host_unavailable");
    // The worker is truly orphaned at this point: it ignores stdin EOF, its host
    // is gone, and nothing has reaped it yet.
    expect(() => process.kill(workerPid, 0)).not.toThrow();

    const host = await startHost({ rootDir: hostRoot, hostIdleMs: 200, workerIdleMs: 200 });
    try {
      const lost = (await readLedgerRecords(hostRoot)).filter(
        (record) => record.state === "lost" && record.cause === "host_exit",
      );
      expect(lost).toHaveLength(1);
      expect(lost[0].detail).toMatchObject({ orphan: "killed" });
      // SIGKILL is synchronous to deliver, not to reap: an orphan reparented to
      // init stays a zombie for a moment, so poll for the pid to disappear.
      await vi.waitFor(() => {
        expect(() => process.kill(workerPid, 0)).toThrow();
      }, { timeout: 5_000, interval: 25 });
    } finally {
      await host.close("test");
    }
  }, 45_000);
});
