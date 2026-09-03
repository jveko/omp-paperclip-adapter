import { promises as fs } from "node:fs";
import path from "node:path";
import { governancePolicyActive } from "./governance-manifest.js";

/**
 * Fixed overlay filename (overwritten in place on every run that has anything
 * to say to the omp child's config). The name predates v0.8, but the file is the
 * run's whole `PI_CONFIG_FILES` overlay: model fallback chains and, from v0.8,
 * the governance section.
 */
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
 * Materialize this run's omp config overlay: the per-agent model fallback chain
 * (one selector per line in config.fallbackChain) plus the v0.8 governance keys.
 * Writes the FIXED filename in <dir>, overwriting in place, so one path carries
 * every section (PI_CONFIG_FILES is appended once by the caller).
 * Returns a discriminated result: "none" when there is nothing to overlay, "ok"
 * with the overlay path on success, or "error" with the message when the write
 * fails. A failed write never throws: the run proceeds without the overlay.
 */
export async function materializeFailoverOverlay(
  config: Record<string, unknown>,
  dir: string,
): Promise<{ status: "none" } | { status: "ok"; path: string } | { status: "error"; error: string }> {
  const chain = parseFallbackChain(config);
  // A policy that parses but has nothing enforceable must NOT reach the fold:
  // approvalMode is auto-approve, and arming it without guardrails would loosen
  // the run for nothing (governancePolicyActive is the single source of truth
  // for "is governance on", shared with the manifest writer).
  const governed = governancePolicyActive(config);
  if (chain.length === 0 && !governed) return { status: "none" };
  const lines: string[] = [];
  if (chain.length > 0) {
    lines.push(
      "retry:",
      "  fallbackChains:",
      "    default:",
      ...chain.map((sel) => `      - ${JSON.stringify(sel)}`),
    );
  }
  if (governed) {
    // Single-gate recipe: omp resolves auto-approval from the MERGED settings
    // view (not just the schema default), so folding `tools.approvalMode: yolo`
    // in here makes the ACP permission proxy always-allow and leaves the
    // bridge's tool_call gate as the only deterministic deny point.
    lines.push("tools:", "  approvalMode: yolo");
  }
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
