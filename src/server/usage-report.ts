import { createHash } from "node:crypto";
import type { OmpModelCost } from "./models.js";
import type { WorkProductPayload } from "./session-directives.js";
import type { RunUsage } from "./session-state.js";

/**
 * Mean tokens across recent runs × the rate card, normalized to USD per
 * heartbeat. Null when there is no rate card or no run history.
 */
export function estimateCostPerHeartbeat(runs: RunUsage[], cost: OmpModelCost | null | undefined): number | null {
  if (!cost || runs.length === 0) return null;
  const inTok = runs.reduce((s, r) => s + r.inputTokens, 0) / runs.length;
  const outTok = runs.reduce((s, r) => s + r.outputTokens, 0) / runs.length;
  const cachedTok = runs.reduce((s, r) => s + (r.cachedInputTokens ?? 0), 0) / runs.length;
  return (inTok / 1e6) * cost.input + (outTok / 1e6) * cost.output + (cachedTok / 1e6) * (cost.cacheRead ?? 0);
}

/**
 * GET the omp auth-broker usage endpoint. Never throws: any failure (network,
 * non-2xx, bad body) degrades to `{ok:false,error}` so the run path can fall
 * back to a cost-only report.
 */
export async function fetchBrokerUsage(
  deps: { url: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: true; reports: unknown[] } | { ok: false; error: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.url.replace(/\/+$/, "")}/v1/usage`, {
      headers: { authorization: `Bearer ${deps.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (!res.ok) return { ok: false, error: `broker /v1/usage HTTP ${res.status}` };
    const body = await res.json() as { reports?: unknown[] };
    return { ok: true, reports: Array.isArray(body.reports) ? body.reports : [] };
  } catch (err) {
    return { ok: false, error: `broker /v1/usage failed: ${String(err)}` };
  }
}

/**
 * Dedup key: broker reports + a relative cost bucket (2 significant figures,
 * ~1-10% band) so per-run token jitter does not re-trigger emission while
 * still detecting real drift across cheap and expensive models alike.
 */
export function usageDigest(reports: unknown[], cost: number | null): string {
  const bucket = cost == null ? "na" : cost.toPrecision(2);
  return createHash("sha256").update(JSON.stringify({ reports, bucket })).digest("hex").slice(0, 16);
}

export function buildUsageWorkProduct(ctx: {
  reports: unknown[]; costPerHeartbeatUsd: number | null; runId: string; capturedAt: string;
}): WorkProductPayload {
  const cost = ctx.costPerHeartbeatUsd != null ? `$${ctx.costPerHeartbeatUsd.toFixed(4)}/heartbeat est.` : "cost estimate unavailable";
  const lines = [cost, ...(ctx.reports.length ? ctx.reports.map((r) => JSON.stringify(r)).slice(0, 8) : ["(broker usage unavailable — cost-only report)"])];
  return {
    type: "artifact", provider: "omp-usage",
    title: `Usage & cost — ${ctx.reports.length} provider report(s), ${cost}`,
    summary: lines.join("\n"),
    metadata: { reports: ctx.reports, costPerHeartbeatUsd: ctx.costPerHeartbeatUsd, runId: ctx.runId, capturedAt: ctx.capturedAt },
  };
}
