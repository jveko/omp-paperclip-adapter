import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

/**
 * The engine's error taxonomy. The package declares the union on the result
 * but does not re-export the name, so derive it from the field it types.
 */
type AdapterExecutionErrorFamily = NonNullable<AdapterExecutionResult["errorFamily"]>;

export interface RetryConfig {
  enabled: boolean;
  freshRetries: number;
}

/**
 * Read the adapter's fresh-session retry knobs from per-agent config.
 * Defaults keep existing agents unchanged (retry on, 2 fresh attempts).
 */
export function readRetryConfig(config: Record<string, unknown>): RetryConfig {
  const rawEnabled = config.retryEnabled;
  const enabled = typeof rawEnabled === "boolean" ? rawEnabled : true;
  const raw = config.retryFreshRetries;
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : 2;
  const freshRetries = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 2;
  return { enabled, freshRetries };
}

/**
 * Turn-phase errors that survive omp's native recovery are candidates for a
 * fresh-session retry: the poisoned/refused context is discarded, and a clean
 * context may succeed. Auth, config, and backend-missing errors are NOT
 * retried — a fresh session cannot fix them (retrying would waste tokens).
 */
const FRESH_RETRYABLE_CODES = new Set([
  "acpx_turn_failed",
  "acpx_protocol_error",
  "acpx_runtime_error",
]);

/** omp >=18.6.3 refuses to open a session whose recorded model is gone. */
const RESTORE_MODEL_PATTERN = /Could not restore model/i;

/**
 * `Could not restore model <provider/id>` is omp >= 18.6.3 refusing to open a
 * session that recorded a model the catalog no longer has
 * (`agent-session.ts` `switchSession`, `sdk.ts` `createAgentSession`). It is
 * not a broken build and not a poisonable turn: the session file itself names
 * a model that no longer resolves, and the ACP request cannot substitute one.
 *
 * A fresh session is the only recovery — it starts from the run's CURRENT
 * model rather than the stored one — so this is exactly the case the
 * fresh-session retry exists for, and the reason it must outrank the generic
 * `acpx_session_init_failed` exclusion (a real init failure, e.g. a missing
 * binary or an unreadable session, stays terminal).
 *
 * The retry uses the chain's existing `OMP_PAPERCLIP_RETRY` marker, which
 * changes the config fingerprint: the recovered session is saved under the
 * retry fingerprint, so the next normal run starts one more fresh session
 * before resuming. That is one extra cold start in exchange for an employee
 * that recovers inside the run; changing the chain's marker shape is
 * deliberately out of scope.
 */
export function isRestoreModelFailure(
  result: Pick<AdapterExecutionResult, "errorCode" | "errorMessage" | "errorMeta">,
): boolean {
  if (result.errorCode !== "acpx_session_init_failed") return false;
  const errorMeta = (result.errorMeta ?? {}) as Record<string, unknown>;
  // The engine surfaces omp's ACP error text in errorMessage and, when the
  // error wrapped a cause, in errorMeta.causeMessage.
  return [result.errorMessage, errorMeta.causeMessage]
    .filter((value): value is string => typeof value === "string")
    .some((text) => RESTORE_MODEL_PATTERN.test(text));
}

/**
 * The engine's own error taxonomy, as its classification sets it on the
 * result. A fresh session can only help when the failure was the context:
 * a configuration error, a provider refusal and an auth family all survive a
 * new session, and retrying them only burns tokens. `provider_quota` is
 * retryable in principle — the window resets — so the timestamp decides.
 */
const FAMILY_RETRYABLE: Record<AdapterExecutionErrorFamily, boolean> = {
  transient_upstream: true,
  provider_quota: true,
  configuration: false,
  model_refusal: false,
  refresh_token_reused: false,
  refresh_token_expired: false,
  refresh_token_invalidated: false,
};

/** The engine's "do not retry before" instruction, when it is still ahead. */
function retryNotBeforeIsFuture(retryNotBefore: string | null | undefined, now: number): boolean {
  if (typeof retryNotBefore !== "string" || retryNotBefore.trim() === "") return false;
  const at = Date.parse(retryNotBefore);
  return Number.isFinite(at) && at > now;
}

export function isTerminalRetryable(
  result: Pick<
    AdapterExecutionResult,
    "errorCode" | "errorMessage" | "errorMeta" | "errorFamily" | "retryNotBefore"
  >,
  now: number = Date.now(),
): boolean {
  const code = result.errorCode ?? null;
  if (!code) return false;
  const errorMeta = (result.errorMeta ?? {}) as Record<string, unknown>;
  // Hard exclusions: these are never recoverable with a fresh session, so they
  // are not retried even if the engine flags retryable.
  if (code === "acpx_auth_required") return false;
  if (code === "acpx_session_config_failed") return false;
  // A removed model is recoverable this way; every other init failure is not.
  if (code === "acpx_session_init_failed") return isRestoreModelFailure(result);
  if (code === "acpx_backend_missing") return false;
  if (code === "acpx_backend_unavailable") return false;
  // The engine's classification is the most specific read of the failure: it
  // saw the provider text before redaction. Its timestamp outranks the family
  // (a quota window is a time, not a verdict) and the code table below.
  if (retryNotBeforeIsFuture(result.retryNotBefore, now)) return false;
  const family = result.errorFamily ?? null;
  if (family !== null && family in FAMILY_RETRYABLE) return FAMILY_RETRYABLE[family];
  // An explicit engine retryable flag overrides the code-based default.
  if (errorMeta.retryable === false) return false;
  if (errorMeta.retryable === true) return true;
  return FRESH_RETRYABLE_CODES.has(code);
}

export interface RetryChainEntry {
  attempt: number;
  model: string | null | undefined;
  errorCode: string | null | undefined;
  fresh: boolean;
}

/**
 * Return a copy of config that starts a FRESH ACP session on the next
 * executor invocation. Adding a unique env var changes `resolvedAdapterEnv` →
 * `adapterEnvHash` → session fingerprint → sessionKey, so the engine sees an
 * incompatible resume and issues `session/new` instead of resuming the
 * (possibly poisoned) warm handle. The marker must not collide with a
 * Paperclip-reserved or per-wake runtime key, so it uses a namespaced OMP_*
 * prefix.
 */
export function forceFreshSession(
  config: Record<string, unknown>,
  attempt: number,
): Record<string, unknown> {
  const env = { ...((config.env ?? {}) as Record<string, string>) };
  env.OMP_PAPERCLIP_RETRY = String(attempt);
  return { ...config, env };
}

/**
 * Attach the retry chain to resultJson so the board shows what happened.
 * Returns the result unchanged when no retry occurred (no chain noise).
 */
export function withRetryChain(
  result: AdapterExecutionResult,
  retryChain: RetryChainEntry[],
): AdapterExecutionResult {
  if (retryChain.length === 0) return result;
  return {
    ...result,
    resultJson: { ...(result.resultJson ?? {}), retryChain },
  };
}

export interface RunRetryResult {
  result: AdapterExecutionResult;
  chain: RetryChainEntry[];
}

/**
 * Run an executor turn, and if it fails terminally (surviving omp's native
 * TurnRecovery), re-run on a fresh ACP session up to `retry.freshRetries`
 * times. Each fresh attempt busts the session fingerprint (via
 * `forceFreshSession`) so the engine starts a brand-new session rather than
 * resuming a possibly-poisoned warm handle. Returns the final result plus the
 * full attempt chain for surfacing.
 */
export async function runWithFreshSessionRetry(
  executor: (ctx: { config: Record<string, unknown> }) => Promise<AdapterExecutionResult>,
  retry: RetryConfig,
  config: Record<string, unknown>,
): Promise<RunRetryResult> {
  const attempts = retry.enabled ? retry.freshRetries : 0;
  let runConfig = config;
  let result = await executor({ config: runConfig });
  // No chain noise: only report a chain when a fresh-session retry actually ran.
  if (attempts === 0 || !isTerminalRetryable(result)) {
    return { result, chain: [] };
  }
  const chain: RetryChainEntry[] = [
    { attempt: 0, model: result.model ?? null, errorCode: result.errorCode ?? null, fresh: false },
  ];
  for (let attempt = 1; attempt <= attempts && isTerminalRetryable(result); attempt += 1) {
    runConfig = forceFreshSession(runConfig, attempt);
    result = await executor({ config: runConfig });
    chain.push({
      attempt,
      model: result.model ?? null,
      errorCode: result.errorCode ?? null,
      fresh: true,
    });
  }
  return { result, chain };
}