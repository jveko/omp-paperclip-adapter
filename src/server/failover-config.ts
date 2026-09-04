import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Fixed filename for this run's failover overlay, overwritten in place whenever
 * there is something to say about model availability. From v0.8 this file
 * carries ONLY `retry.fallbackChains`: the governance keys live in their own
 * overlay (governance-overlay.ts) because they must reach the run child without
 * ever reaching the side channels that read this one.
 */
export const FAILOVER_CONFIG_FILE = "omp-failover-config.yml";

/**
 * One selector per line, blank lines ignored. Exported because endpoint routing
 * needs the same list: a chained provider must never be disabled.
 */
export function parseFallbackChain(config: Record<string, unknown>): string[] {
  if (typeof config.fallbackChain !== "string") return [];
  return config.fallbackChain
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Materialize this run's failover overlay: the per-agent model fallback chain
 * (one selector per line in config.fallbackChain), injected through
 * `PI_CONFIG_FILES`. Writes the FIXED filename in <dir>, overwriting in place,
 * so one path carries the chain (PI_CONFIG_FILES is appended once by the
 * caller). Returns a discriminated result: "none" when there is nothing to
 * overlay, "ok" with the overlay path on success, or "error" with the message
 * when the write fails. A failed write never throws: the run proceeds without
 * the overlay.
 */
export async function materializeFailoverOverlay(
  config: Record<string, unknown>,
  dir: string,
): Promise<{ status: "none" } | { status: "ok"; path: string } | { status: "error"; error: string }> {
  const chain = parseFallbackChain(config);
  if (chain.length === 0) return { status: "none" };
  const lines: string[] = [
    "retry:",
    "  fallbackChains:",
    "    default:",
    ...chain.map((sel) => `      - ${JSON.stringify(sel)}`),
  ];
  const yaml = `${lines.join("\n")}\n`;
  const file = path.join(dir, FAILOVER_CONFIG_FILE);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, yaml, "utf8");
    return { status: "ok", path: file };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
