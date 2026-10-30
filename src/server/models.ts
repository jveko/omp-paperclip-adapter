import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { validThinkingSuffix } from "./thinking-levels.js";

export interface OmpModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * omp's user-facing interpretation of a model's token-rate card
 * (`packages/catalog/src/types.ts`). `free` is a declared zero card, `included`
 * is covered by a subscription, and `unknown` means omp has no rate card at
 * all — the three are not interchangeable, so the adapter carries the status
 * instead of guessing from the numbers.
 */
export type OmpPricingStatus = "fixed" | "free" | "included" | "variable" | "unknown";

const PRICING_STATUSES: Readonly<Record<OmpPricingStatus, true>> = {
  fixed: true, free: true, included: true, variable: true, unknown: true,
};

export interface OmpModelInfo {
  id: string;
  label: string;
  contextWindow?: number;
  cost?: OmpModelCost;
  pricingStatus?: OmpPricingStatus;
}

/**
 * Returns true when the cost card is present and all four fields are zero
 * (missing/undefined fields are treated as zero). Returns false for absent
 * cost (null/undefined) or any nonzero field.
 */
export function isFreeCost(cost: OmpModelCost | null | undefined): boolean {
  if (!cost) return false;
  return (cost.input ?? 0) === 0 &&
    (cost.output ?? 0) === 0 &&
    (cost.cacheRead ?? 0) === 0 &&
    (cost.cacheWrite ?? 0) === 0;
}

export function parseOmpModelsJson(stdout: string): OmpModelInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: OmpModelInfo[] = [];
  for (const m of models) {
    if (typeof m !== "object" || m === null) continue;
    const rec = m as Record<string, unknown>;
    const provider = typeof rec.provider === "string" ? rec.provider : "";
    const id = typeof rec.id === "string" ? rec.id : "";
    if (!provider || !id) continue;
    const cost =
      typeof rec.cost === "object" && rec.cost !== null
        ? (rec.cost as OmpModelInfo["cost"])
        : undefined;
    const pricingStatus =
      typeof rec.pricingStatus === "string"
      && Object.hasOwn(PRICING_STATUSES, rec.pricingStatus)
        ? (rec.pricingStatus as OmpPricingStatus)
        : undefined;
    out.push({
      id: `${provider}/${id}`,
      label: typeof rec.name === "string" && rec.name ? rec.name : `${provider}/${id}`,
      contextWindow: typeof rec.contextWindow === "number" ? rec.contextWindow : undefined,
      pricingStatus,
      cost,
    });
  }
  return out;
}

/**
 * Resolve a possibly-fuzzy model reference to the exact `provider/id` form
 * omp's ACP `set_config_option` requires. Matches exact id, label (ignoring
 * case), the bare id suffix, or the bare id prefix (handles versioned ids).
 * Returns null when unresolvable (pass-through).
 */
export function normalizeOmpModelId(model: string, models: OmpModelInfo[]): string | null {
  const candidate = model.trim();
  if (!candidate) return null;
  for (const m of models) {
    if (m.id === candidate) return m.id;
  }
  for (const m of models) {
    if (m.label.toLowerCase() === candidate.toLowerCase()) return m.id;
    if (m.id.split("/").pop() === candidate) return m.id;
  }
  for (const m of models) {
    if (m.id.split("/").pop()?.startsWith(candidate) === true) return m.id;
  }
  return null;
}

const cache = new Map<string, { at: number; models: OmpModelInfo[] }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Bounded `omp` invocation; a missing binary, non-zero exit or timeout resolves "". */
// `Promise.withResolvers` is ES2024; this package compiles against the ES2022
// lib, so the executor form is the one that type-checks here.
function runOmp(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env: env ? { ...process.env, ...env } : undefined },
      (err, out) => resolve(err ? "" : String(out)),
    );
  });
}

function catalogKey(command: string, args: string[], env?: Record<string, string>): string {
  return createHash("sha256")
    .update(command + "\0" + JSON.stringify(args) + "\0" + JSON.stringify(env ?? {}))
    .digest("hex").slice(0, 16);
}

export async function listOmpModels(
  options: { command?: string; force?: boolean; args?: string[]; env?: Record<string, string> } = {},
): Promise<OmpModelInfo[]> {
  const command = options.command ?? "omp";
  const args = options.args ?? ["models", "ls", "--json"];
  const key = catalogKey(command, args, options.env);
  if (!options.force) {
    // Evict expired entries on access so a fleet of differently-env'd agents
    // each keep a live slot without unbounded growth.
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
    }
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.models;
  }
  const models = parseOmpModelsJson(await runOmp(command, args, 20_000, options.env));
  // Cache successes only; failures retry next call.
  if (models.length > 0) cache.set(key, { at: Date.now(), models });
  return models;
}

const REFRESH_TIMEOUT_MS = 60_000;
/**
 * A refresh is an ONLINE catalog re-fetch, so it is the expensive half of
 * discovery: hold the last completed refresh for a minute so a double-clicked
 * "refresh models" (or a board auto-refresh) cannot spawn a storm of them.
 * The listing below is still forced, so the returned catalog is never the
 * adapter's 5-minute cache.
 */
const REFRESH_COOLDOWN_MS = 60_000;
const refreshes = new Map<string, { inFlight: Promise<OmpModelInfo[]> | null; lastAt: number }>();

/**
 * Refresh omp's model catalog, then list it. Single-flight per command/env and
 * cooldown-gated, so concurrent or repeated callers share one network fetch
 * and still receive a freshly listed catalog (`force` bypasses the 5-minute
 * cache, which is what makes a retired model disappear on the first refresh).
 */
export function refreshOmpModelCatalog(
  options: { command?: string; env?: Record<string, string> } = {},
): Promise<OmpModelInfo[]> {
  const command = options.command ?? "omp";
  const key = catalogKey(command, ["models", "refresh"], options.env);
  const existing = refreshes.get(key);
  if (existing?.inFlight) return existing.inFlight;
  const lastAt = existing?.lastAt ?? 0;
  const entry: { inFlight: Promise<OmpModelInfo[]> | null; lastAt: number } = { inFlight: null, lastAt };
  const run = (async () => {
    if (Date.now() - lastAt >= REFRESH_COOLDOWN_MS) {
      // Best-effort: omp's own refresh keeps whatever it already had when a
      // provider is unreachable, and the forced listing below is the answer.
      await runOmp(command, ["models", "refresh"], REFRESH_TIMEOUT_MS, options.env);
      entry.lastAt = Date.now();
    }
    return listOmpModels({ command, force: true, env: options.env });
  })();
  entry.inFlight = run;
  refreshes.set(key, entry);
  void run.finally(() => { entry.inFlight = null; });
  return run;
}

/**
 * Read omp's configured default model without creating a session. ACP's
 * `session/new` (the old probe) always persists a throwaway session and there
 * is no ACP delete, so detection reads the `modelRoles` setting instead. The
 * selector is resolved against the catalog because the board stores
 * `provider/id` and compares it with the model list. Returns null rather than
 * passing a selector through that omp cannot resolve.
 */
export async function detectOmpConfiguredModel(
  options: { command?: string } = {},
): Promise<{ model: string; provider: string; source: string } | null> {
  const command = options.command ?? "omp";
  const stdout = await runOmp(command, ["config", "get", "modelRoles", "--json"], 20_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("value" in parsed)) return null;
  const value = parsed.value;
  if (typeof value !== "object" || value === null || !("default" in value)) return null;
  const raw = value.default;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const resolved = resolveConfiguredSelector(raw.trim(), await listOmpModels({ command }));
  if (!resolved) return null;
  const provider = resolved.slice(0, resolved.indexOf("/"));
  return { model: resolved, provider, source: "config:modelRoles.default" };
}

/**
 * Resolve a role value to a catalog id. omp writes roles as
 * `provider/id[:<thinking>]` (`modelRoles.default: "prov/m:high"` on a real
 * install), so a full-pattern match wins first — an id may itself contain a
 * colon (OpenRouter `:exacto`) — and only a suffix that parses as a thinking
 * selector is stripped, exactly like omp's own resolver. The effort never
 * becomes part of the returned model.
 */
function resolveConfiguredSelector(selector: string, listing: OmpModelInfo[]): string | null {
  const direct = normalizeOmpModelId(selector, listing);
  if (direct) return direct;
  const colon = selector.lastIndexOf(":");
  if (colon <= 0) return null;
  if (!validThinkingSuffix(selector.slice(colon + 1))) return null;
  return normalizeOmpModelId(selector.slice(0, colon).trim(), listing);
}
