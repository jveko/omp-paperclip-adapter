import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const RECENT_RUNS_LIMIT = 20;

interface HeartbeatRunRow {
  id: string;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  result_json: unknown;
  usage_json: unknown;
}

interface CostEventRow {
  run_id: string;
  model: string | null;
  cost_cents: number;
}

interface SessionRuntime {
  fork: string | null;
  rotation: number | null;
  mcpServerCount: number | null;
}

interface RunOverview {
  id: string;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  sessionRuntime: SessionRuntime | null;
  usage: Record<string, number> | null;
  costUsd: number;
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

function parseSessionRuntime(value: unknown): SessionRuntime | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  return {
    fork: typeof o.fork === "string" ? o.fork : null,
    rotation: typeof o.rotation === "number" ? o.rotation : null,
    mcpServerCount: typeof o.mcpServerCount === "number" ? o.mcpServerCount : null,
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
        `SELECT id, status, started_at, ended_at, result_json, usage_json
         FROM heartbeat_runs
         WHERE agent_id = $1
         ORDER BY started_at DESC
         LIMIT ${RECENT_RUNS_LIMIT}`,
        [agentId],
      );

      const costRows = await ctx.db.query<CostEventRow>(
        `SELECT run_id, model, cost_cents
         FROM cost_events
         WHERE agent_id = $1`,
        [agentId],
      );

      // Build cost map: run_id -> totalCents
      const costByRun = new Map<string, number>();
      let totalCostCents = 0;
      for (const row of costRows) {
        const cents = typeof row.cost_cents === "number" ? row.cost_cents : 0;
        costByRun.set(row.run_id, (costByRun.get(row.run_id) ?? 0) + cents);
        totalCostCents += cents;
      }

      let totalSessionSeconds: number | null = null;
      const totalUsage: Record<string, number> = {};
      const parsedRuns: RunOverview[] = [];

      for (const row of runs) {
        const resultJson = tryParseJson(row.result_json);
        const sessionRuntime = parseSessionRuntime(
          typeof resultJson === "object" && resultJson !== null
            ? (resultJson as Record<string, unknown>).sessionRuntime
            : null,
        );
        const usage = parseUsage(row.usage_json);

        // Compute session duration from timestamps
        let sessionSeconds: number | null = null;
        if (row.started_at && row.ended_at) {
          const start = new Date(row.started_at).getTime();
          const end = new Date(row.ended_at).getTime();
          if (!isNaN(start) && !isNaN(end) && end >= start) {
            sessionSeconds = (end - start) / 1000;
          }
        }

        const runCost = costByRun.get(row.id) ?? 0;

        parsedRuns.push({
          id: row.id,
          status: row.status ?? null,
          startedAt: row.started_at ?? null,
          endedAt: row.ended_at ?? null,
          sessionRuntime,
          usage,
          costUsd: runCost / 100,
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