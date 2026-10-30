/**
 * omp's thinking selectors, shared by the run directive (`--thinking`) and the
 * model-config reader: a role value is `provider/id[:<selector>]`, so both
 * features must agree on what a valid selector is.
 *
 * `inherit` is intentionally excluded (omp rejects it on the CLI) and `default`
 * is the adapter's sentinel meaning "emit no flag". omp accepts unambiguous
 * abbreviations of at least two characters for the same selector surfaces, so
 * `med` and `xhi` must parse here too — otherwise a role value omp resolves
 * would come back as "undetected" from the adapter.
 */
export const THINKING_LEVELS = [
  "off", "auto", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

/** Canonical selector for an exact or unambiguous-abbreviation value, else null. */
export function validThinkingLevel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Trim so padded values from the API (" medium ") still match: a padded value
  // that failed matching would silently drop the directive AND raise a
  // misleading warn.
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const exact = THINKING_LEVELS.find((level) => level === trimmed);
  if (exact) return exact;
  // Mirrors omp's `getOwnSelector`: a two-character minimum keeps single
  // letters from guessing.
  if (trimmed.length < 2) return null;
  const matches = THINKING_LEVELS.filter((level) => level.startsWith(trimmed));
  return matches.length === 1 ? matches[0] : null;
}
