import { execFile } from "node:child_process";

export interface OmpModelInfo {
  id: string;
  label: string;
  contextWindow?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  priced: boolean;
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
      priced:
        cost != null &&
        !["input", "output"].every((k) => Number((cost as Record<string, unknown>)[k] ?? 0) === 0),
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

let cache: { at: number; models: OmpModelInfo[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function listOmpModels(
  options: { command?: string; force?: boolean } = {},
): Promise<OmpModelInfo[]> {
  const command = options.command ?? "omp";
  if (!options.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
  const stdout = await new Promise<string>((resolve) => {
    execFile(command, ["models", "ls", "--json"], { timeout: 20_000 }, (err, out) =>
      resolve(err ? "" : String(out)),
    );
  });
  const models = parseOmpModelsJson(stdout);
  // Cache successes only; failures retry next call.
  if (models.length > 0) cache = { at: Date.now(), models };
  return models;
}
