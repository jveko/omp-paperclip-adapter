import { validThinkingLevel } from "./thinking-levels.js";
import { writeOverlay } from "./run/overlays.js";

/**
 * Run-child-only settings overlay that carries the operator's thinking level.
 *
 * The level used to ride `agentCommand` as `--thinking <level>`, which is part
 * of the engine's session fingerprint: every level edit started a fresh
 * session. `defaultThinkingLevel` is the settings key for the same choice
 * (omp's settings reference), so the value lives in a file with a fixed name instead —
 * the engine hashes the env (the path), never the content, so an edit does not
 * rotate the session.
 *
 * The setting is not the strongest source: omp resolves a run's level as
 * CLI flag → persisted `thinking_level_change` entry → model-selector suffix →
 * default-role suffix → model catalog default → `defaultThinkingLevel`
 * (sdk.ts:2139-2162), and ACP `session/load` restores from the stored entry
 * (`agent-session.ts:12811-12835`). A resumed session therefore keeps the level
 * it stored; the adapter rotates when the operator asks for a different one
 * (see `thinkingLevelChanged`).
 */
export { THINKING_CONFIG_FILE } from "./run/overlays.js";

/**
 * The level this run asks omp for, canonicalized; `""` means "ask for nothing"
 * (unset, the `default` sentinel, or an invalid value the run already warned
 * about).
 */
export function requestedThinkingLevel(config: Record<string, unknown>): string {
  return validThinkingLevel(config.thinking) ?? "";
}

/**
 * The level the settings overlay can express, else null. omp's
 * `defaultThinkingLevel` takes minimal|low|medium|high|xhigh|max|auto; an `off`
 * value is discarded and the run reads the default (`high`), so `off` stays a
 * CLI flag.
 */
export function settingsThinkingLevel(config: Record<string, unknown>): string | null {
  const level = requestedThinkingLevel(config);
  return level === "" || level === "off" ? null : level;
}

export type ThinkingOverlayResult =
  | { status: "none" }
  | { status: "ok"; path: string }
  | { status: "error"; error: string };

/**
 * Write this run's thinking overlay, overwriting the fixed filename in place.
 * Never throws: a failed write returns "error" and the caller warns and
 * continues, exactly like the other overlay writers.
 */
export async function materializeThinkingOverlay(
  config: Record<string, unknown>,
  dir: string,
): Promise<ThinkingOverlayResult> {
  const level = settingsThinkingLevel(config);
  if (level === null) return { status: "none" };
  return writeOverlay("thinking", `defaultThinkingLevel: ${level}\n`, dir);
}
