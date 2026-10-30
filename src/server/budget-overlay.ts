import { writeOverlay } from "./run/overlays.js";

/**
 * Run-child-only settings overlay that turns the adapter's soft budget into
 * omp's own session cost gate.
 *
 * `governancePolicy.budgetCapUsd` is the bridge's soft, per-session cap: it can
 * only refuse a TOOL call, so a turn that never reaches the bridge — or a
 * subagent that keeps a copy of the cap — can spend past it. omp owns the real
 * stop: `session.maxCost` refuses the next model request once the session tree
 * (subagents included) reaches it, and `session.warnCost` is the earlier
 * notice. The adapter does not re-implement either; it only forwards the
 * operator's number.
 */
export { BUDGET_CONFIG_FILE } from "./run/overlays.js";

/**
 * The warning threshold the adapter derives from the one configured number:
 * four fifths of the hard cap, rounded to cents. This is the adapter's own
 * early-warning heuristic, not an omp default. A threshold that would round to
 * zero (no signal) or to the cap itself (no lead time) is omitted.
 */
export function budgetWarnUsd(capUsd: number): number | null {
  const warn = Math.round(capUsd * 0.8 * 100) / 100;
  return warn > 0 && warn < capUsd ? warn : null;
}

export type BudgetOverlayResult =
  | { status: "none" }
  | { status: "ok"; path: string }
  | { status: "error"; error: string };

/**
 * `String(1e-7)` is `"1e-7"`, which a YAML 1.1 reader returns as a string and
 * omp's cost validation then rejects (dropping the whole overlay). Write plain
 * decimals; ordinary caps are already plain and pass through unchanged.
 */
function plainDecimal(value: number): string {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Write this run's budget overlay, overwriting the fixed filename in place so
 * PI_CONFIG_FILES carries a stable path (a changing path would rotate the
 * session via the fingerprint; changing the content does not). Never throws:
 * a failed write returns "error" and the caller warns and continues, exactly
 * like the other overlay writers.
 */
export async function materializeBudgetOverlay(
  capUsd: number | undefined,
  dir: string,
): Promise<BudgetOverlayResult> {
  if (typeof capUsd !== "number" || !Number.isFinite(capUsd) || capUsd <= 0) {
    return { status: "none" };
  }
  const warn = budgetWarnUsd(capUsd);
  const lines = [
    "session:",
    `  maxCost: ${plainDecimal(capUsd)}`,
    ...(warn === null ? [] : [`  warnCost: ${plainDecimal(warn)}`]),
  ];
  return writeOverlay("budget", `${lines.join("\n")}\n`, dir);
}
