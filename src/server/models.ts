import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export interface OmpModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface OmpModelInfo {
  id: string;
  label: string;
  contextWindow?: number;
  cost?: OmpModelCost;
  priced: boolean;
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
    out.push({
      id: `${provider}/${id}`,
      label: typeof rec.name === "string" && rec.name ? rec.name : `${provider}/${id}`,
      contextWindow: typeof rec.contextWindow === "number" ? rec.contextWindow : undefined,
      priced: cost != null && !isFreeCost(cost),
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

export async function listOmpModels(
  options: { command?: string; force?: boolean; args?: string[]; env?: Record<string, string> } = {},
): Promise<OmpModelInfo[]> {
  const command = options.command ?? "omp";
  const args = options.args ?? ["models", "ls", "--json"];
  const key = createHash("sha256").update(command + "\0" + JSON.stringify(args) + "\0" + JSON.stringify(options.env ?? {})).digest("hex").slice(0, 16);
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
  const stdout = await new Promise<string>((resolve) => {
    execFile(command, args, { timeout: 20_000, env: options.env ? { ...process.env, ...options.env } : undefined },
      (err, out) => resolve(err ? "" : String(out)),
    );
  });
  const models = parseOmpModelsJson(stdout);
  // Cache successes only; failures retry next call.
  if (models.length > 0) cache.set(key, { at: Date.now(), models });
  return models;
}
