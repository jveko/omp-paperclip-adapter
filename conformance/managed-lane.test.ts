import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "../src/server/acp.js";
import { readLedgerRecords } from "../src/host/ledger.js";
import { readDiscovery } from "../src/host/socket.js";
import { checkGolden, normalizeGolden, runReplacements } from "./golden.js";
import { materializeProfile } from "./profiles.js";

/**
 * The managed-lane golden run: the adapter spawns the REAL supervisor binary
 * (`dist/omp-host.js`, built by test/global-setup.ts) exactly as it does in
 * production, which drives a scripted `omp --mode rpc` worker. No Paperclip
 * instance, no network.
 *
 * Asserted:
 * - the supervisor's journal order for a run,
 * - the usage the run reports (worker stats, before/after delta),
 * - session reuse across two runs on one worker (no `new_session` on the second),
 * - the subagent events the managed lane exposes (bounded and content-free).
 */

const fakeRpcDirs: string[] = [];
const runs: Array<Record<string, unknown>> = [];

let home: string;
let instanceRoot: string;

beforeEach(async () => {
  // Short paths on purpose: a Unix socket path is capped at 108 bytes, and the
  // supervisor's socket lives under PAPERCLIP_HOME/instances/<id>/omp-host.
  home = await mkdtemp(path.join(os.tmpdir(), "ompcf-"));
  instanceRoot = path.join(home, "instances", "cf");
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "cf");
  // The spawned host inherits this env and drains by itself after the run.
  vi.stubEnv("OMP_HOST_IDLE_MS", "400");
  vi.stubEnv("OMP_HOST_WORKER_IDLE_MS", "400");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await killSupervisor();
  await rm(home, { recursive: true, force: true });
  for (const dir of fakeRpcDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function killSupervisor(): Promise<void> {
  const discovery = await readDiscovery(path.join(instanceRoot, "omp-host"));
  if (discovery === null) return;
  try {
    process.kill(discovery.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function ctx(config: Record<string, unknown>, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: `run-${Math.random().toString(16).slice(2)}`,
    agent: { id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null },
    runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: "task" },
    config,
    context: {},
    onLog: async () => {},
    onEvent: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

/** The managed lane's worker is `buildWorkerCommand`, not the ACP command. */
async function managedConfig(rpcMode: string, statsFile: string, logFile: string): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omp-conformance-worker-"));
  fakeRpcDirs.push(dir);
  const build = await materializeProfile(dir, {
    name: "managed",
    commandName: "omp",
    version: "18.14.0",
    settingsKeys: ["session.maxCost", "tools.restrictedFolders", "defaultThinkingLevel"],
    topVerbs: ["acp", "config", "gc", "models", "session"],
    modelsVerbs: ["ls", "refresh"],
    sessionVerbs: ["lease"],
    rpcMode,
    expectedDiagnostics: [],
  });
  return {
    executionMode: "managed",
    command: build.script,
    env: { FAKE_RPC_MODE: rpcMode, FAKE_RPC_STATS: statsFile, FAKE_RPC_LOG: logFile },
  };
}

describe("managed-lane conformance", () => {
  it("settles two runs on one worker: journal order, usage, and session reuse", async () => {
    const statsFile = path.join(home, "stats.json");
    const logFile = path.join(home, "frames.log");
    const config = await managedConfig("", statsFile, logFile);
    const run = createOmpAcpExecutor();

    const events: string[] = [];
    const usages: AdapterUsageCheckpoint[] = [];
    const cold = await run(ctx(config, {
      onEvent: async (event) => { events.push(`${event.eventType}:${event.level ?? "info"}`); },
      onUsage: async (receipt) => { usages.push(receipt); },
    }));
    // `toMatchObject` prints the whole result, so a failure names the error
    // code and message instead of just an exit-code mismatch.
    expect(cold).toMatchObject({ exitCode: 0 });
    expect(cold.usage).toEqual({ inputTokens: 110, outputTokens: 20, cachedInputTokens: 40 });
    expect(usages).toHaveLength(1);

    // The second run reuses the stored session: the supervisor must open it,
    // never create a new one.
    const warm = await run(ctx(config, {
      runtime: {
        sessionId: typeof cold.sessionParams?.acpSessionId === "string" ? cold.sessionParams.acpSessionId : null,
        sessionParams: cold.sessionParams ?? {},
        sessionDisplayId: null,
        taskKey: "task",
      },
    }));
    expect(warm).toMatchObject({ exitCode: 0 });
    expect(warm.sessionParams?.acpSessionId).toBe(cold.sessionParams?.acpSessionId);

    const frames = (await readFile(logFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
      type: string; [key: string]: unknown;
    });
    const opens = frames.filter((frame) => frame.type === "new_session" || frame.type === "open_session");
    // One `new_session` for the pair: the second run finds the session already
    // open on the warm worker, so it asks for nothing instead of re-creating it.
    expect(opens.map((frame) => frame.type)).toEqual(["new_session"]);
    expect(cold.sessionParams?.acpSessionId).toBe("sess-new-1");

    const records = await readLedgerRecords(path.join(instanceRoot, "omp-host"));
    const states = records.map((record) => record.state);
    expect(states).toEqual([
      "leased", "worker_ready", "session_open", "prompting", "settled", "closed",
      "leased", "worker_ready", "session_open", "prompting", "settled", "closed",
    ]);

    runs.push(normalizeGolden({
      lane: "managed",
      states,
      usage: cold.usage ?? null,
      sessionReused: true,
      events,
    }, runReplacements()));
  }, 60_000);

  it("reports subagent lifecycle events from the worker", async () => {
    const statsFile = path.join(home, "stats-sa.json");
    const logFile = path.join(home, "frames-sa.log");
    const config = await managedConfig("subagents", statsFile, logFile);
    const events: Array<{ eventType: string; level?: string; payload?: Record<string, unknown> }> = [];
    const result: AdapterExecutionResult = await createOmpAcpExecutor()(ctx(
      { ...config, subagentObservability: "events" },
      { onEvent: async (event) => { events.push(event); } },
    ));
    expect(result).toMatchObject({ exitCode: 0 });

    const subagents = events.filter((event) => event.eventType === "omp.subagent");
    // started/progress/completed for sa-1, started/failed for sa-2, started for sa-3.
    expect(subagents.length).toBeGreaterThanOrEqual(5);
    expect(subagents).toHaveLength(7);
    const statuses = subagents.map((event) => event.payload?.status);
    expect(statuses).toEqual(
      expect.arrayContaining(["running", "completed", "failed"]),
    );
    expect(subagents.map((event) => event.payload?.agent))
      .toEqual(expect.arrayContaining(["explore", "plan", "task"]));
    // Bounded and content-free: no prompt text, tool arguments or transcripts.
    expect(JSON.stringify(events)).not.toMatch(/SENTINEL/);

    runs.push(normalizeGolden({
      lane: "managed-subagents",
      subagents: subagents.map((event) => ({
        agent: event.payload?.agent,
        status: event.payload?.status,
      })),
      events: [...new Set(events.map((event) => `${event.eventType}:${event.level ?? "info"}`))],
    }, runReplacements()));
  }, 60_000);

  it("matches the recorded golden", async () => {
    await checkGolden("managed-lane", runs);
  });
});
