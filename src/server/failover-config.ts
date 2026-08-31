import { promises as fs } from "node:fs";
import path from "node:path";

/** Fixed overlay filename (overwritten in place on every run with a chain). */
export const FAILOVER_CONFIG_FILE = "omp-failover-config.yml";

/** One selector per line, blank lines ignored. */
function parseFallbackChain(config: Record<string, unknown>): string[] {
  if (typeof config.fallbackChain !== "string") return [];
  return config.fallbackChain
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Materialize the retry.fallbackChains overlay for this run's omp child so the
 * per-agent model fallback chain (one selector per line in config.fallbackChain)
 * takes effect. Writes the FIXED filename in <dir>, overwriting in place.
 * Returns a discriminated result: "none" when there is no chain, "ok" with the
 * overlay path on success, or "error" with the message when the write fails.
 * A failed write never throws: the run proceeds without the overlay.
 */
export async function materializeFailoverOverlay(
  config: Record<string, unknown>,
  dir: string,
): Promise<{ status: "none" } | { status: "ok"; path: string } | { status: "error"; error: string }> {
  const chain = parseFallbackChain(config);
  if (chain.length === 0) return { status: "none" };
  const yaml = [
    "retry:",
    "  fallbackChains:",
    "    default:",
    ...chain.map((sel) => `      - ${JSON.stringify(sel)}`),
    "",
  ].join("\n");
  const file = path.join(dir, FAILOVER_CONFIG_FILE);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, yaml, "utf8");
    return { status: "ok", path: file };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
