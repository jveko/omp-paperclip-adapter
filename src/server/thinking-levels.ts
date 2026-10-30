/**
 * omp's thinking selectors, shared by the run directive (`--thinking`) and the
 * model-role reader: a role value is `provider/id[:<selector>]`, and both
 * features must agree on which selectors omp accepts.
 *
 * The two surfaces are not identical in omp:
 * - the CLI flag takes `off|auto|minimal|low|medium|high|xhigh|max`
 *   (`CLI_THINKING_LEVELS`); `inherit` is rejected and `default` is the
 *   adapter's sentinel for "emit no flag";
 * - a model-pattern suffix is split with `splitThinkingSuffix`, which does NOT
 *   accept `auto`, and accepts unambiguous abbreviations of at least two
 *   characters (`getOwnSelector`).
 */
export const THINKING_LEVELS = [
  "off", "auto", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

/** The levels omp accepts as a `:suffix` on a model pattern (no `auto`). */
export const MODEL_SUFFIX_THINKING_LEVELS = THINKING_LEVELS.filter((level) => level !== "auto");

/**
 * Canonical level for the run's `--thinking` directive, else null. Exact
 * levels only: the adapter appends the value verbatim, so an abbreviation
 * would be forwarded rather than normalized.
 */
export function validThinkingLevel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Trim so padded values from the API (" medium ") still match: a padded value
  // that failed matching would silently drop the directive AND raise a
  // misleading warn.
  const trimmed = value.trim();
  return THINKING_LEVELS.find((level) => level === trimmed) ?? null;
}

/**
 * Canonical level for a model-role `:suffix`, else null. Mirrors omp's
 * `getOwnSelector`: exact match first, then a unique prefix of at least two
 * characters (single letters never guess).
 */
export function validThinkingSuffix(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const exact = MODEL_SUFFIX_THINKING_LEVELS.find((level) => level === trimmed);
  if (exact) return exact;
  if (trimmed.length < 2) return null;
  const matches = MODEL_SUFFIX_THINKING_LEVELS.filter((level) => level.startsWith(trimmed));
  return matches.length === 1 ? matches[0] : null;
}
