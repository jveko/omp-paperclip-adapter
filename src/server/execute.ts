import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "./acp.js";
import { sessionIntelDir } from "./session-state.js";
import {
  acquireSessionLease, sessionLeaseKey, SESSION_LEASE_TIMEOUT_GRACE_MS,
} from "./session-lease.js";

const executor = createOmpAcpExecutor();

/**
 * The run's configured timeout, coerced like `buildOmpAcpConfig` does: finite
 * numbers and numeric strings only, and only a positive value is a bound
 * (0 means "no timeout").
 */
function configuredTimeoutMs(config: Record<string, unknown>): number | null {
  const raw = config.timeoutSec ?? config.acpTimeoutSec;
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" && raw.trim() !== ""
      ? Number(raw)
      : NaN;
  return Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  // One writer per omp session file, for the whole call. See session-lease.ts:
  // a second process on the same session does not corrupt it, it silently
  // forks the transcript, so the run is refused instead. A configured timeout
  // extends the lease past the default bound, so a legitimately long run is
  // never displaced mid-turn.
  const timeoutMs = configuredTimeoutMs(ctx.config);
  const lease = await acquireSessionLease({
    dir: sessionIntelDir(ctx.agent.companyId, ctx.agent.id),
    key: sessionLeaseKey(ctx.agent, ctx.runtime),
    ...(timeoutMs !== null ? { ttlMs: timeoutMs + SESSION_LEASE_TIMEOUT_GRACE_MS } : {}),
  });
  if (!lease.ok) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "omp_session_lease_held",
      errorMessage: lease.error,
    };
  }
  try {
    return await executor(ctx);
  } finally {
    await lease.release();
  }
}
