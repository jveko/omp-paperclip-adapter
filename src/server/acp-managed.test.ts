import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "./acp.js";
import { readLedgerRecords } from "../host/ledger.js";
import { startHost } from "../host/server.js";
import { steerManagedRun } from "./run/host-transport.js";

/**
 * The adapter against the REAL supervisor: `dist/omp-host.js` is spawned on the
 * instance socket and drives the scripted `omp --mode rpc` worker. The plan
 * tests in `acp.test.ts` stub this transport; these prove the composed lane.
 */

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const fakeRpc = path.resolve(fixtureDir, "../../test-fixtures/fake-rpc.mjs");
const fakeAcp = path.resolve(fixtureDir, "../../test-fixtures/fake-acp.mjs");

/** Paperclip issue ids are UUIDs; only those runs may post work products. */
const ISSUE_ID = "0b8f0d5e-9a10-4f6a-8f2b-1c2d3e4f5a6b";

interface AcpFrame {
  method: string;
  params: Record<string, unknown>;
}

async function readAcpFrames(file: string): Promise<AcpFrame[]> {
  let raw = "";
  try { raw = await readFile(file, "utf8"); } catch { return []; }
  return raw.split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return {
      method: tab < 0 ? line : line.slice(0, tab),
      params: tab < 0 ? {} : JSON.parse(line.slice(tab + 1)) as Record<string, unknown>,
    };
  });
}

function baseCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null },
    runtime: {
      sessionId: "old",
      sessionParams: { acpSessionId: "old", sessionKey: "sk", cwd: process.cwd(), configFingerprint: "f" },
      sessionDisplayId: "old", taskKey: "t",
    },
    config: {},
    context: { taskId: ISSUE_ID },
    onLog: async () => {},
    onEvent: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

describe("managed lane", () => {
  let tmpRoot: string;
  let host: Awaited<ReturnType<typeof startHost>> | null;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "omp-managed-test-"));
  });
  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(path.join(tmpRoot, "instances"), { recursive: true, force: true });
    vi.stubEnv("PAPERCLIP_HOME", tmpRoot);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-managed");
    host = await startHost({
      rootDir: path.join(tmpRoot, "instances", "test-managed", "omp-host"),
      hostIdleMs: 50,
      workerIdleMs: 50,
    });
  });
  afterEach(async () => {
    if (host !== null) await host.close("test").catch(() => {});
    host = null;
    vi.unstubAllEnvs();
  });

  it("runs through the supervisor and maps events, worker and usage", async () => {
    const events: Array<{ eventType?: string; level?: string; message?: string }> = [];
    const spawns: Array<{ pid: number; processGroupId: number | null; startedAt: string }> = [];
    const usages: Array<Record<string, unknown>> = [];
    const run = createOmpAcpExecutor();
    const result = await run(baseCtx({
      config: {
        agentCommand: `${process.execPath} ${fakeRpc}`,
      },
      authToken: "run-jwt",
      onEvent: async (event: unknown) => { events.push(event as { eventType?: string }); },
      onSpawn: async (meta: { pid: number; processGroupId: number | null; startedAt: string }) => { spawns.push(meta); },
      onUsage: async (receipt: Record<string, unknown>) => { usages.push(receipt); },
      runtimeMcp: { getServers: () => [] },
    }));
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams?.acpSessionId).toBe("sess-1");
    expect(result.usage).toEqual({ inputTokens: 110, outputTokens: 20, cachedInputTokens: 40 });
    expect(result.usageBasis).toBe("per_run");
    expect(result.model).toBe("prov/m");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].pid).toBeGreaterThan(0);
    expect(spawns[0].processGroupId).toBe(spawns[0].pid);
    expect(events.some((event) => event.eventType === "omp.turn")).toBe(true);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ usageBasis: "per_run", complete: true });
    expect(JSON.stringify(events)).not.toContain("run-jwt");
    const ledger = await readLedgerRecords(path.join(tmpRoot, "instances", "test-managed", "omp-host"));
    expect(ledger.map((record) => record.state)).toEqual([
      "leased", "worker_ready", "session_open", "prompting", "settled", "closed",
    ]);
    expect(JSON.stringify(ledger)).not.toContain("run-jwt");
  }, 30_000);

  it("steers a running managed turn only when steering is enabled", async () => {
    for (const steering of ["on", "off"] as const) {
      const controller = new AbortController();
      const spawned = Promise.withResolvers<void>();
      const ctx = baseCtx({
        runId: `run-steer-${steering}`,
        config: {
          agentCommand: `${process.execPath} ${fakeRpc}`,
          env: { FAKE_RPC_MODE: "hang" },
          steering,
        },
        onSpawn: async () => spawned.resolve(),
        signal: controller.signal,
      } as never);
      const running = createOmpAcpExecutor()(ctx);
      await spawned.promise;
      const steered = await steerManagedRun({ runId: ctx.runId, message: "look at the failing test" });
      if (steering === "on") {
        expect(steered).toEqual({ ok: true });
      } else {
        expect(steered.ok).toBe(false);
        expect(steered.error).toContain("steering is disabled");
      }
      controller.abort();
      const result = await running;
      expect(result.resultJson).toMatchObject({ status: "aborted" });
    }
  }, 30_000);

  it("cancels an already-aborted run after the begin reaches the supervisor", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createOmpAcpExecutor()(baseCtx({
      config: {
        agentCommand: `${process.execPath} ${fakeRpc}`,
        env: { FAKE_RPC_MODE: "hang" },
      },
      signal: controller.signal,
    } as never));
    expect(result.resultJson).toMatchObject({ status: "aborted" });
    const ledger = await readLedgerRecords(path.join(tmpRoot, "instances", "test-managed", "omp-host"));
    expect(ledger.some((record) => record.state === "settled" && record.cause === "cancel")).toBe(true);
  }, 30_000);

  it("answers the fork cwd from the host session index without an ACP list probe", async () => {
    const work = path.join(tmpRoot, "work-fork");
    const other = path.join(tmpRoot, "work-fork-other");
    await mkdir(work, { recursive: true });
    await mkdir(other, { recursive: true });
    // One wrapper serves both lanes: `acp` for the probe lane, everything else
    // (--mode rpc) for the worker.
    const wrapper = path.join(tmpRoot, "fake-omp.sh");
    await writeFile(
      wrapper,
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "acp" ]; then exec "${process.execPath}" "${fakeAcp}"; fi; done\nexec "${process.execPath}" "${fakeRpc}" "$@"\n`,
      { mode: 0o755 },
    );
    const frameFile = path.join(tmpRoot, "fork-frames.log");
    vi.stubEnv("FAKE_ACP_FRAME_LOG", frameFile);
    const first = await createOmpAcpExecutor()(baseCtx({
      runId: "run-fork-1",
      config: { command: wrapper, cwd: work, sessionBrowser: false },
      runtime: {
        sessionId: null,
        sessionParams: { sessionKey: "sk-fork-1", cwd: work },
        sessionDisplayId: null,
        taskKey: "task",
      },
    }));
    expect(first.exitCode).toBe(0);
    const second = await createOmpAcpExecutor()(baseCtx({
      runId: "run-fork-2",
      config: {
        command: wrapper, cwd: other, sessionBrowser: false,
        sessionForkSourceId: "sess-new-1", sessionForkToken: "t1",
      },
      runtime: {
        sessionId: null,
        sessionParams: { acpSessionId: "sess-new-1", sessionKey: "sk-fork-2", cwd: work },
        sessionDisplayId: null,
        taskKey: "task",
      },
    }));
    // Managed fork finds the source cwd without the ACP list probe, but the
    // forked transcript lives in omp's agent-dir storage while the worker
    // resumes by directory: the run must refuse rather than silently continue
    // the source session under the fork's id (v0.12 limitation, documented).
    expect(second.errorCode).toBe("omp_host_run_failed");
    expect(second.errorMessage).toContain("refusing to continue another session");
    const frames = await readAcpFrames(frameFile);
    const fork = frames.find((frame) => frame.method === "session/fork");
    expect(fork?.params.cwd).toBe(work);
    expect(frames.some((frame) => frame.method === "session/list")).toBe(false);
  }, 30_000);

  it("does not warn about a missing MCP server", async () => {
    const events: Array<{ message?: string }> = [];
    const result = await createOmpAcpExecutor()(baseCtx({
      config: { agentCommand: `${process.execPath} ${fakeRpc}` },
      runtimeTools: { mcpEndpoint: "http://paperclip.test/runtime-tools/mcp", bearerToken: "ct-x" },
      runtimeMcp: { getServers: () => [] },
      onEvent: async (event: unknown) => { events.push(event as { message?: string }); },
    } as never));
    expect(result.exitCode).toBe(0);
    expect(events.some((event) => (event.message ?? "").includes("connection tools are unavailable this run: Paperclip delivered no MCP server"))).toBe(false);
  }, 30_000);
});
