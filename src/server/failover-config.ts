import { resolveProviderQualifiedSelector, type OmpModelInfo } from "./models.js";
import { writeOverlay } from "./run/overlays.js";

/**
 * Fixed filename for this run's failover overlay, overwritten in place whenever
 * there is something to say about model availability. From v0.8 this file
 * carries NO governance keys: they live in their own overlay
 * (governance-overlay.ts) because they must reach the run child without ever
 * reaching the side channels that read this one.
 */
export { FAILOVER_CONFIG_FILE } from "./run/overlays.js";

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

/** `retry.fallbackOn`: which failures walk the chain (omp's settings reference). */
export const FALLBACK_ON = ["any", "usage-limit", "except-usage-limit"] as const;
/** `retry.fallbackRevertPolicy`: whether the primary model comes back. */
export const FALLBACK_REVERT_POLICY = ["cooldown-expiry", "never"] as const;

export interface RetryFallbackSettings {
  fallbackOn?: (typeof FALLBACK_ON)[number];
  fallbackRevertPolicy?: (typeof FALLBACK_REVERT_POLICY)[number];
  waitForUsageReset?: boolean;
  maxDelayMs?: number;
}

export type RetryFallbackRead =
  | { ok: true; settings: RetryFallbackSettings }
  | { ok: false; error: string };

/** `true`/`false` as a board field may deliver them, else null. */
function boolish(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function numberish(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Read and validate the quota-aware retry knobs. omp validates these at config
 * load and, for a value outside an enum, DISCARDS the key and reads its default
 * (`fallbackOn: sometimes` reads back `any`) — a knob that would silently do
 * nothing, so the adapter refuses it instead of writing the file.
 */
export function readRetryFallbackSettings(config: Record<string, unknown>): RetryFallbackRead {
  const settings: RetryFallbackSettings = {};
  const on = config.fallbackOn;
  if (on !== undefined && on !== null && on !== "") {
    const match = FALLBACK_ON.find((value) => value === on);
    if (!match) {
      return {
        ok: false,
        error: `fallbackOn is '${String(on)}' but expected one of ${FALLBACK_ON.join(", ")}.`,
      };
    }
    settings.fallbackOn = match;
  }
  const revert = config.fallbackRevertPolicy;
  if (revert !== undefined && revert !== null && revert !== "") {
    const match = FALLBACK_REVERT_POLICY.find((value) => value === revert);
    if (!match) {
      return {
        ok: false,
        error: `fallbackRevertPolicy is '${String(revert)}' but expected one of ${FALLBACK_REVERT_POLICY.join(", ")}.`,
      };
    }
    settings.fallbackRevertPolicy = match;
  }
  const wait = config.waitForUsageReset;
  if (wait !== undefined && wait !== null && wait !== "") {
    const parsed = boolish(wait);
    if (parsed === null) {
      return {
        ok: false,
        error: `waitForUsageReset is '${String(wait)}' but expected true or false.`,
      };
    }
    settings.waitForUsageReset = parsed;
  }
  const delay = config.maxDelayMs;
  if (delay !== undefined && delay !== null && delay !== "") {
    const parsed = numberish(delay);
    if (parsed === null || parsed < 0) {
      return {
        ok: false,
        error: `maxDelayMs is '${String(delay)}' but expected a non-negative number of milliseconds (0 disables the cap).`,
      };
    }
    settings.maxDelayMs = parsed;
  }
  return { ok: true, settings };
}

/** Actionable message when a retry knob is outside its documented values, else null. */
export function validateRetryFallbackConfig(config: Record<string, unknown>): string | null {
  const read = readRetryFallbackSettings(config);
  return read.ok ? null : read.error;
}

/** One operator-supplied selector omp treats as provider-qualified (`/`). */
export interface ProviderQualifiedSelector {
  field: "model" | "fallbackChain";
  selector: string;
}

/**
 * Every selector omp resolves exactly rather than fuzzily: the primary `model`
 * and each `fallbackChain` leg that contains `/`. Bare selectors (`opus`) are
 * deliberately absent — fuzzy matching for those is an adapter feature and omp
 * keeps it on 18.14.
 */
export function providerQualifiedSelectors(
  config: Record<string, unknown>,
): ProviderQualifiedSelector[] {
  const out: ProviderQualifiedSelector[] = [];
  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (model.includes("/")) out.push({ field: "model", selector: model });
  for (const selector of parseFallbackChain(config)) {
    if (selector.includes("/")) out.push({ field: "fallbackChain", selector });
  }
  return out;
}

/**
 * Refuse a config omp 18.14 would quietly degrade: a provider-qualified
 * selector that is not an exact catalog id makes a `--model` fail and a
 * `fallbackChain` leg be skipped (warn + continue upstream), which narrows the
 * chain the operator wrote. Same posture as the enum refusals above: name the
 * value, say why, and do not write a config that does nothing.
 */
export function validateProviderQualifiedSelectors(
  config: Record<string, unknown>,
  models: OmpModelInfo[],
): string | null {
  const unresolved = providerQualifiedSelectors(config)
    .filter(({ selector }) => resolveProviderQualifiedSelector(selector, models) === null);
  if (unresolved.length === 0) return null;
  const named = unresolved.map(({ field, selector }) => `${field} '${selector}'`).join(", ");
  return `${named} ${unresolved.length === 1 ? "is a provider-qualified selector that does" : "are provider-qualified selectors that do"} not name an exact id in the omp model catalog. omp 18.14 resolves a provider-qualified selector exactly: a near match fails instead of selecting a sibling, and a fallbackChain leg that does not resolve is skipped, so this config would run a narrower chain than written. Use an id from \`omp models ls --json\` for ${unresolved.length === 1 ? "it" : "them"}; bare selectors still match fuzzily.`;
}

/**
 * Materialize this run's failover overlay: the per-agent model fallback chain
 * (one selector per line in config.fallbackChain) plus the quota-aware retry
 * knobs, all under one `retry:` block. `fallbackChains.default` is the
 * CHAT-session chain (omp's `default` role); model-kind roles never inherit it,
 * so it must not be rewritten as a role-specific chain.
 *
 * Injected through `PI_CONFIG_FILES`. Writes the FIXED filename in <dir>,
 * overwriting in place, so one path carries the settings (PI_CONFIG_FILES is
 * appended once by the caller) and an edit never rotates the session. Returns a
 * discriminated result: "none" when there is nothing to overlay, "ok" with the
 * overlay path on success, or "error" with the message when the write fails or
 * a knob is invalid. Never throws: the run proceeds without the overlay.
 */
export async function materializeFailoverOverlay(
  config: Record<string, unknown>,
  dir: string,
): Promise<{ status: "none" } | { status: "ok"; path: string } | { status: "error"; error: string }> {
  const chain = parseFallbackChain(config);
  const read = readRetryFallbackSettings(config);
  if (!read.ok) return { status: "error", error: read.error };
  const { settings } = read;
  const knobs = [
    settings.fallbackOn === undefined ? null : `  fallbackOn: ${settings.fallbackOn}`,
    settings.fallbackRevertPolicy === undefined ? null : `  fallbackRevertPolicy: ${settings.fallbackRevertPolicy}`,
    settings.waitForUsageReset === undefined ? null : `  waitForUsageReset: ${String(settings.waitForUsageReset)}`,
    settings.maxDelayMs === undefined ? null : `  maxDelayMs: ${settings.maxDelayMs}`,
  ].filter((line): line is string => line !== null);
  if (chain.length === 0 && knobs.length === 0) return { status: "none" };
  const lines: string[] = [
    "retry:",
    ...(chain.length === 0
      ? []
      : ["  fallbackChains:", "    default:", ...chain.map((sel) => `      - ${JSON.stringify(sel)}`)]),
    ...knobs,
  ];
  const yaml = `${lines.join("\n")}\n`;
  return writeOverlay("failover", yaml, dir);
}
