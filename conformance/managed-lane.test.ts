import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionResult, AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "../src/server/acp.js";
import { profileAgentDir, profileConfigRoot } from "../src/server/omp-profile.js";
import { prepareSessionScope } from "../src/server/session-scope.js";
import { readLedgerRecords } from "../src/host/ledger.js";
import { checkGolden, normalizeGolden, runReplacements } from "./golden.js";
import { conformanceEnv, ctx, managedWorker, type ConformanceEnv } from "./managed-harness.js";

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

const runs: Array<Record<string, unknown>> = [];

let env: ConformanceEnv;

beforeEach(async () => {
  env = await conformanceEnv("cf");
});

afterEach(async () => {
  await env.dispose();
});

describe("managed-lane conformance", () => {
  it("settles two runs on one worker: journal order, usage, and session reuse", async () => {
    const statsFile = path.join(env.home, "stats.json");
    const logFile = path.join(env.home, "frames.log");
    const config = await managedWorker(env, "", { stats: statsFile, log: logFile });
    const run = createOmpAcpExecutor();

    const events: string[] = [];
    const warnings: string[] = [];
    const usages: AdapterUsageCheckpoint[] = [];
    const cold = await run(ctx(config, {
      onEvent: async (event) => {
        events.push(`${event.eventType}:${event.level ?? "info"}`);
        if (event.level === "warn") warnings.push(event.message ?? "");
      },
      onUsage: async (receipt) => { usages.push(receipt); },
    }));
    // `toMatchObject` prints the whole result, so a failure names the error
    // code and message instead of just an exit-code mismatch.
    expect(cold).toMatchObject({ exitCode: 0 });
    // A worker that answers every managed frame yields no capability warning:
    // the accepted frame's observations are all `yes`, not a degraded guess.
    expect(warnings.filter((message) =>
      message.includes("usage receipt")
      || message.includes("connection tools are unavailable")
      || message.includes("subagent observability"))).toEqual([]);
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

    const records = await readLedgerRecords(env.hostRoot);
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
    const statsFile = path.join(env.home, "stats-sa.json");
    const logFile = path.join(env.home, "frames-sa.log");
    const config = await managedWorker(env, "subagents", { stats: statsFile, log: logFile });
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

  it("prepares distinct named profiles for two agents of one company", async () => {
    vi.stubEnv("HOME", env.home);
    // Keep profileConfigRoot inside this scenario's throwaway HOME.
    vi.stubEnv("PI_CONFIG_DIR", "omp-config");
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    const config = { sessionScope: "profile", credentialMode: "broker", env: {} };

    const first = await prepareSessionScope(config, { companyId: "co-1", agentId: "agent-1" });
    const second = await prepareSessionScope(config, { companyId: "co-1", agentId: "agent-2" });
    if (!first.ok) throw new Error(first.error);
    if (!second.ok) throw new Error(second.error);

    const firstEnv = first.prepared.config.env as Record<string, unknown>;
    const secondEnv = second.prepared.config.env as Record<string, unknown>;
    const firstName = firstEnv.OMP_PROFILE;
    const secondName = secondEnv.OMP_PROFILE;
    expect(typeof firstName).toBe("string");
    expect(typeof secondName).toBe("string");
    expect(first.prepared.scope).toBe("profile");
    expect(second.prepared.scope).toBe("profile");
    // The two employees of one company must never share a profile.
    expect(firstName).not.toBe(secondName);
    expect(first.prepared.agentDir).toBe(profileAgentDir(firstName as string));
    expect(second.prepared.agentDir).toBe(profileAgentDir(secondName as string));
    expect(first.prepared.agentDir).not.toBe(second.prepared.agentDir);

    for (const name of [firstName as string, secondName as string]) {
      const stats = await stat(profileConfigRoot(name));
      expect(stats.isDirectory()).toBe(true);
    }
  });
});
