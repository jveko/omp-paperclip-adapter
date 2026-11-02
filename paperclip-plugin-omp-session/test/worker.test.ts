import { describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { TestHarness } from "@paperclipai/plugin-sdk";
import plugin from "../src/worker.js";
import { assertQueryColumns, postgresRows } from "./paperclip-schema.js";

interface SessionRuntime {
  fork: { requested: string; applied: boolean; activeSessionId: string } | null;
  rotation: { reason: string; at: string; sessionKey: string } | null;
  mcpServerCount: number | null;
}

interface HostRuntime {
  workerPid: number;
  reusedWorker: boolean;
  settledBy: string;
  cause: string | null;
  ledgerSeq: number;
  workerAgeMs: number;
}

interface RunOverview {
  id: string;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  sessionRuntime: SessionRuntime | null;
  runtime: HostRuntime | null;
  usage: Record<string, number> | null;
  costUsd: number;
  model: string | null;
}

interface OmpSessionOverview {
  runs: RunOverview[];
  summary: {
    runCount: number;
    totalSessionSeconds: number | null;
    totalUsage: Record<string, number>;
    totalCostUsd: number;
  };
}

type RunRow = Record<string, unknown>;

async function makeHarness(): Promise<TestHarness> {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

function stubDb(harness: TestHarness, runs: RunRow[], cost: RunRow[]) {
  // The SDK harness records (and discards) all queries; override so the
  // handler under test receives rows shaped exactly as postgres.js returns them
  // for the real schema (numeric as string, jsonb parsed).
  const byTable: Record<string, RunRow[]> = { heartbeat_runs: runs, cost_events: cost };
  harness.ctx.db.query = vi.fn(async (sql: string) => {
    const table = sql.includes("cost_events") ? "cost_events" : "heartbeat_runs";
    assertQueryColumns(sql, table);
    return postgresRows(table, byTable[table]!);
  }) as unknown as typeof harness.ctx.db.query;
}

const RUN_1 = {
  id: "run-1",
  status: "completed",
  started_at: "2026-09-01T10:00:00Z",
  finished_at: "2026-09-01T10:30:00Z",
  result_json: {
    sessionRuntime: {
      fork: { requested: "sess-a", applied: true, activeSessionId: "sess-a" },
      lastRotation: { reason: "maxRuns", at: "2026-09-01T09:00:00Z", sessionKey: "sk" },
      mcpServerCount: 2,
    },
    hostRuntime: {
      workerPid: 4242,
      reusedWorker: true,
      settledBy: "outcome",
      ledgerSeq: 17,
      workerAgeMs: 90_000,
    },
  },
  usage_json: { prompt_tokens: 1500, completion_tokens: 800 },
};

const RUN_2 = {
  id: "run-2",
  status: "failed",
  started_at: "2026-09-01T11:00:00Z",
  finished_at: "2026-09-01T11:05:00Z",
  result_json: {
    sessionRuntime: {
      fork: { requested: "sess-x", applied: false, activeSessionId: "sess-b" },
      lastRotation: { reason: "maxAgeHours", at: "2026-09-01T10:00:00Z", sessionKey: "sk2" },
    },
  },
  usage_json: { prompt_tokens: 500, completion_tokens: 100 },
};

describe("omp-session-overview data handler", () => {
  it("returns the expected overview shape from heartbeat_runs + cost_events", async () => {
    const harness = await makeHarness();
    stubDb(harness, [RUN_1, RUN_2], [
      { heartbeat_run_id: "run-1", model: "gpt-4", cost_cents: 500 },
      { heartbeat_run_id: "run-1", model: "gpt-4", cost_cents: 200 },
      { heartbeat_run_id: "run-1", model: "gpt-4", cost_cents: 0 },
      { heartbeat_run_id: "run-2", model: "claude-3", cost_cents: 300 },
    ]);

    const overview = await harness.getData<OmpSessionOverview>(
      "omp-session-overview",
      { agentId: "test-agent-1" },
    );

    expect(overview.runs).toHaveLength(2);
    expect(overview.summary.runCount).toBe(2);

    const r1 = overview.runs[0];
    expect(r1.id).toBe("run-1");
    expect(r1.status).toBe("completed");
    expect(r1.startedAt).toBe("2026-09-01T10:00:00Z");
    expect(r1.endedAt).toBe("2026-09-01T10:30:00Z");
    expect(r1.sessionRuntime).toEqual({
      fork: { requested: "sess-a", applied: true, activeSessionId: "sess-a" },
      rotation: { reason: "maxRuns", at: "2026-09-01T09:00:00Z", sessionKey: "sk" },
      mcpServerCount: 2,
    });
    expect(r1.usage).toEqual({ prompt_tokens: 1500, completion_tokens: 800 });
    // Result evidence is rendered as-is; an absent cause (a clean turn) is null.
    expect(r1.runtime).toEqual({
      workerPid: 4242,
      reusedWorker: true,
      settledBy: "outcome",
      cause: null,
      ledgerSeq: 17,
      workerAgeMs: 90_000,
    });
    // 500 + 200 + 0 cents = 700 -> 7.00 USD
    expect(r1.costUsd).toBe(7);
    expect(r1.model).toBe("gpt-4");

    const r2 = overview.runs[1];
    expect(r2.id).toBe("run-2");
    expect(r2.status).toBe("failed");
    expect(r2.sessionRuntime).toEqual({
      fork: { requested: "sess-x", applied: false, activeSessionId: "sess-b" },
      rotation: { reason: "maxAgeHours", at: "2026-09-01T10:00:00Z", sessionKey: "sk2" },
      mcpServerCount: null,
    });
    expect(r2.usage).toEqual({ prompt_tokens: 500, completion_tokens: 100 });
    // The run never reported host runtime evidence: null, not a default object.
    expect(r2.runtime).toBeNull();
    expect(r2.costUsd).toBe(3);
    expect(r2.model).toBe("claude-3");

    // 30 min + 5 min = 2100 seconds
    expect(overview.summary.totalSessionSeconds).toBe(2100);
    expect(overview.summary.totalUsage).toEqual({ prompt_tokens: 2000, completion_tokens: 900 });
    expect(overview.summary.totalCostUsd).toBe(10);
  });

  it("parses a numeric cost_cents string instead of rendering $0.00", async () => {
    const harness = await makeHarness();
    stubDb(harness, [RUN_1], [{ heartbeat_run_id: "run-1", model: "gpt-4", cost_cents: 123.45 }]);

    const overview = await harness.getData<OmpSessionOverview>(
      "omp-session-overview",
      { agentId: "test-agent-1" },
    );

    // 123.45 cents = $1.2345 (fractional cents are real: numeric(24,7))
    expect(overview.runs[0].costUsd).toBeCloseTo(1.2345);
    expect(overview.summary.totalCostUsd).toBeCloseTo(1.2345);
  });

  it("scopes summary cost to the recent-runs window (excludes cost of runs outside the page)", async () => {
    const harness = await makeHarness();
    // RUN_1 is the only run in the returned page; run-99 is NOT in the page but
    // has cost events. The summary total must reflect only the windowed runs.
    stubDb(harness, [RUN_1], [
      { heartbeat_run_id: "run-1", model: "gpt-4", cost_cents: 200 },
      { heartbeat_run_id: "run-99", model: "gpt-4", cost_cents: 5000 },
    ]);

    const overview = await harness.getData<OmpSessionOverview>(
      "omp-session-overview",
      { agentId: "test-agent-1" },
    );

    expect(overview.runs).toHaveLength(1);
    expect(overview.runs[0].costUsd).toBe(2);
    // run-99's $50.00 must NOT leak into the windowed summary.
    expect(overview.summary.totalCostUsd).toBe(2);
  });

  it("joins distinct per-run models in first-seen order (failover retries)", async () => {
    const harness = await makeHarness();
    stubDb(harness, [RUN_1], [
      { heartbeat_run_id: "run-1", model: "gpt-4", cost_cents: 100 },
      { heartbeat_run_id: "run-1", model: "gpt-4", cost_cents: 100 },
      { heartbeat_run_id: "run-1", model: "claude-3", cost_cents: 100 },
    ]);

    const overview = await harness.getData<OmpSessionOverview>(
      "omp-session-overview",
      { agentId: "test-agent-1" },
    );

    // duplicates dropped, first-seen order kept (fallbackChain retries span models)
    expect(overview.runs[0].model).toBe("gpt-4, claude-3");
  });

  it("reports no model when the run has no cost events", async () => {
    const harness = await makeHarness();
    stubDb(harness, [RUN_1], []);

    const overview = await harness.getData<OmpSessionOverview>(
      "omp-session-overview",
      { agentId: "test-agent-1" },
    );

    expect(overview.runs[0].model).toBeNull();
    expect(overview.runs[0].costUsd).toBe(0);
  });

  it("degrades gracefully on malformed usage_json", async () => {
    const harness = await makeHarness();
    stubDb(harness, [{ ...RUN_1, usage_json: "not-json" }], []);

    const overview = await harness.getData<OmpSessionOverview>(
      "omp-session-overview",
      { agentId: "test-agent-1" },
    );

    expect(overview.runs).toHaveLength(1);
    expect(overview.runs[0].usage).toBeNull();
    // no cost_events at all -> model is null, not undefined/throwing
    expect(overview.runs[0].model).toBeNull();
    // Other fields still populated
    expect(overview.runs[0].sessionRuntime).toEqual({
      fork: { requested: "sess-a", applied: true, activeSessionId: "sess-a" },
      rotation: { reason: "maxRuns", at: "2026-09-01T09:00:00Z", sessionKey: "sk" },
      mcpServerCount: 2,
    });
  });

  it("degrades gracefully on malformed result_json", async () => {
    const harness = await makeHarness();
    stubDb(harness, [{ ...RUN_1, result_json: "invalid-json" }], []);

    const overview = await harness.getData<OmpSessionOverview>(
      "omp-session-overview",
      { agentId: "test-agent-1" },
    );

    expect(overview.runs[0].sessionRuntime).toBeNull();
    expect(overview.runs[0].runtime).toBeNull();
    expect(overview.runs[0].usage).toEqual({ prompt_tokens: 1500, completion_tokens: 800 });
    expect(overview.runs[0].model).toBeNull();
  });

  it("returns an empty overview when agentId is missing", async () => {
    const harness = await makeHarness();
    harness.ctx.db.query = vi.fn().mockResolvedValue([]) as unknown as typeof harness.ctx.db.query;

    const overview = await harness.getData<OmpSessionOverview>(
      "omp-session-overview",
      {},
    );

    expect(overview.runs).toHaveLength(0);
    expect(overview.summary.runCount).toBe(0);
    expect(overview.summary.totalCostUsd).toBe(0);
    expect(harness.ctx.db.query).not.toHaveBeenCalled();
  });
});
