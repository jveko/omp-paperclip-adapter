import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const RECENT_RUNS_LIMIT = 20;

interface HeartbeatRunRow {
  id: string;
  status: string | null;
  started_at: string | null;
  /** `heartbeat_runs.finished_at` (there is no `ended_at` column). */
  finished_at: string | null;
  result_json: unknown;
  usage_json: unknown;
}

interface CostEventRow {
  /** `cost_events.heartbeat_run_id` (there is no `run_id` column). */
  heartbeat_run_id: string;
  /** `cost_events.model` is `text NOT NULL`. */
  model: string;
  /**
   * `numeric(24,7)`: postgres.js leaves numerics as strings (no type parser),
   * so this is a string at runtime even when it looks like a number.
   */
  cost_cents: number | string;
}

interface SessionRuntime {
  fork: { requested: string; applied: boolean; activeSessionId: string } | null;
  rotation: { reason: string; at: string; sessionKey: string } | null;
  mcpServerCount: number | null;
}

/**
 * `resultJson.hostRuntime`: the supervisor's account of a managed run. Absent
 * when the run never reached a supervisor, which is why it is nullable rather
 * than defaulted. Ids and accounting only; no content.
 */
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
  // Distinct cost_events.model values for the run, first-seen order, joined
  // with ", " (a failover run can span models); null when the run has no
  // cost events.
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

function tryParseJson(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function parseFork(value: unknown): { requested: string; applied: boolean; activeSessionId: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.applied !== "boolean" || typeof o.activeSessionId !== "string") return null;
  return {
    requested: typeof o.requested === "string" ? o.requested : "",
    applied: o.applied,
    activeSessionId: o.activeSessionId,
  };
}

function parseRotation(value: unknown): { reason: string; at: string; sessionKey: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.reason !== "string" || typeof o.at !== "string") return null;
  return {
    reason: o.reason,
    at: o.at,
    sessionKey: typeof o.sessionKey === "string" ? o.sessionKey : "",
  };
}

function parseSessionRuntime(value: unknown): SessionRuntime | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  return {
    fork: parseFork(o.fork),
    rotation: parseRotation(o.lastRotation),
    mcpServerCount: typeof o.mcpServerCount === "number" ? o.mcpServerCount : null,
  };
}

/**
 * The three identity fields are the contract; the two accounting fields are
 * tolerated as zeros so a summary from an older supervisor still renders.
 */
function parseHostRuntime(value: unknown): HostRuntime | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.workerPid !== "number"
    || typeof o.reusedWorker !== "boolean"
    || typeof o.settledBy !== "string") {
    return null;
  }
  return {
    workerPid: o.workerPid,
    reusedWorker: o.reusedWorker,
    settledBy: o.settledBy,
    cause: typeof o.cause === "string" ? o.cause : null,
    ledgerSeq: typeof o.ledgerSeq === "number" ? o.ledgerSeq : 0,
    workerAgeMs: typeof o.workerAgeMs === "number" ? o.workerAgeMs : 0,
  };
}

function parseUsage(value: unknown): Record<string, number> | null {
  const obj = tryParseJson(value);
  if (typeof obj !== "object" || obj === null) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("omp-session plugin worker starting");

    ctx.data.register("omp-session-overview", async (params) => {
      const agentId = params.agentId as string | undefined;
      if (!agentId) {
        return {
          runs: [],
          summary: {
            runCount: 0,
            totalSessionSeconds: null,
            totalUsage: {},
            totalCostUsd: 0,
          },
        } satisfies OmpSessionOverview;
      }

      const runs = await ctx.db.query<HeartbeatRunRow>(
        `SELECT id, status, started_at, finished_at, result_json, usage_json
         FROM heartbeat_runs
         WHERE agent_id = $1
         ORDER BY started_at DESC
         LIMIT ${RECENT_RUNS_LIMIT}`,
        [agentId],
      );

      const costRows = await ctx.db.query<CostEventRow>(
        `SELECT heartbeat_run_id, model, cost_cents
         FROM cost_events
         WHERE agent_id = $1 AND heartbeat_run_id = ANY($2)`,
        [agentId, runs.map((r) => r.id)],
      );

      // Build cost map: heartbeat_run_id -> totalCents, and model map:
      // heartbeat_run_id -> distinct models in row order. `cost_cents` arrives
      // as a string, so a `typeof === "number"` check would silently total
      // $0.00.
      const costByRun = new Map<string, number>();
      const modelsByRun = new Map<string, Set<string>>();
      for (const row of costRows) {
        const cents = Number(row.cost_cents);
        costByRun.set(
          row.heartbeat_run_id,
          (costByRun.get(row.heartbeat_run_id) ?? 0) + (Number.isFinite(cents) ? cents : 0),
        );
        const models = modelsByRun.get(row.heartbeat_run_id) ?? new Set<string>();
        models.add(row.model);
        modelsByRun.set(row.heartbeat_run_id, models);
      }

      // Summary cost is scoped to the SAME recent-runs window as Runs/Duration
      // (LIMIT ${RECENT_RUNS_LIMIT}) — never the lifetime total. Compute the
      // sum from the returned page runs, not from costRows, so the windowing
      // is robust even if the DB-level scoping is inadvertently removed.
      let totalCostCents = 0;
      for (const row of runs) {
        totalCostCents += costByRun.get(row.id) ?? 0;
      }

      let totalSessionSeconds: number | null = null;
      const totalUsage: Record<string, number> = {};
      const parsedRuns: RunOverview[] = [];

      for (const row of runs) {
        const resultJson = tryParseJson(row.result_json);
        const resultObject = typeof resultJson === "object" && resultJson !== null
          ? resultJson as Record<string, unknown>
          : null;
        const sessionRuntime = parseSessionRuntime(resultObject?.sessionRuntime ?? null);
        const runtime = parseHostRuntime(resultObject?.hostRuntime ?? null);
        const usage = parseUsage(row.usage_json);

        // Compute session duration from timestamps
        let sessionSeconds: number | null = null;
        if (row.started_at && row.finished_at) {
          const start = new Date(row.started_at).getTime();
          const end = new Date(row.finished_at).getTime();
          if (!isNaN(start) && !isNaN(end) && end >= start) {
            sessionSeconds = (end - start) / 1000;
          }
        }

        const runCost = costByRun.get(row.id) ?? 0;
        const runModels = modelsByRun.get(row.id);

        parsedRuns.push({
          id: row.id,
          status: row.status ?? null,
          startedAt: row.started_at ?? null,
          endedAt: row.finished_at ?? null,
          sessionRuntime,
          runtime,
          usage,
          costUsd: runCost / 100,
          model: runModels && runModels.size > 0 ? [...runModels].join(", ") : null,
        });

        // Accumulate totals
        if (sessionSeconds !== null) {
          totalSessionSeconds = (totalSessionSeconds ?? 0) + sessionSeconds;
        }
        if (usage) {
          for (const [k, v] of Object.entries(usage)) {
            totalUsage[k] = (totalUsage[k] ?? 0) + v;
          }
        }
      }

      return {
        runs: parsedRuns,
        summary: {
          runCount: parsedRuns.length,
          totalSessionSeconds,
          totalUsage: Object.keys(totalUsage).length > 0 ? totalUsage : {},
          totalCostUsd: totalCostCents / 100,
        },
      } satisfies OmpSessionOverview;
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);