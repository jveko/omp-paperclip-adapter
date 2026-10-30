import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The four run-child settings overlays, written by one writer.
 *
 * Each kind owns a FIXED filename and is overwritten in place every run. That
 * is the fingerprint rule, and it is why the rule lives here once instead of in
 * four writers: `PI_CONFIG_FILES` is part of the engine's session fingerprint,
 * so a path that changed with the content (or with a value) would rotate the
 * session on every edit. Only the bytes change; the path never does.
 *
 * The order of `OverlayKind` is the precedence order `PI_CONFIG_FILES` merges
 * in — omp reads the list left to right, so a later file wins.
 */

export const FAILOVER_CONFIG_FILE = "omp-failover-config.yml";
export const GOVERNANCE_CONFIG_FILE = "omp-governance-config.yml";
export const BUDGET_CONFIG_FILE = "omp-budget-config.yml";
export const THINKING_CONFIG_FILE = "omp-thinking-config.yml";

export type OverlayKind = "failover" | "governance" | "budget" | "thinking";

export const OVERLAY_FILES: Readonly<Record<OverlayKind, string>> = {
  failover: FAILOVER_CONFIG_FILE,
  governance: GOVERNANCE_CONFIG_FILE,
  budget: BUDGET_CONFIG_FILE,
  thinking: THINKING_CONFIG_FILE,
};

/** The writers' common union: nothing to write, a landed path, or a failure. */
export type OverlayWrite =
  | { status: "none" }
  | { status: "ok"; path: string }
  | { status: "error"; error: string };

/** An overlay this run actually landed, in `PI_CONFIG_FILES` precedence order. */
export interface OverlayEntry {
  kind: OverlayKind;
  path: string;
}

/**
 * Write one kind's body to its fixed filename under `dir`. Never throws: a
 * failed write returns "error" and the caller warns and continues, so an
 * unwritable overlay degrades one feature instead of failing the run.
 */
export async function writeOverlay(
  kind: OverlayKind,
  body: string,
  dir: string,
): Promise<OverlayWrite> {
  const file = path.join(dir, OVERLAY_FILES[kind]);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, body, "utf8");
    return { status: "ok", path: file };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The run child's `PI_CONFIG_FILES`: the operator's own file first, then every
 * overlay this run landed in precedence order. Empty when neither exists.
 */
export function mergePiConfigFiles(
  operatorPath: string,
  overlays: readonly OverlayEntry[],
): string {
  return [operatorPath, ...overlays.map((overlay) => overlay.path)]
    .filter((entry) => entry.length > 0)
    .join(path.delimiter);
}
