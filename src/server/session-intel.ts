import { createAcpSideChannel } from "./adapters/acp/side-channel.js";
import type {
  OmpForkResult, OmpQueryResult, OmpSessionCwdResult, OmpSideChannelTarget, SessionCwdQuery,
} from "./ports/side-channel.js";

/**
 * Session intelligence: the run's own session landscape, the fork-source cwd,
 * and the fork itself.
 *
 * The reads are specified by `ports/side-channel.ts` and implemented over ACP
 * by `adapters/acp/side-channel.ts`; this module only binds an omp target to
 * that implementation and keeps the package's long-standing entry points. No
 * ACP frame, payload or paging cursor appears above the port, so a second
 * transport swaps the binding without touching any caller.
 */
export type {
  OmpForkResult, OmpHostDiagnostic, OmpProjectInfo, OmpQueryResult, OmpSessionCwdResult,
  OmpSessionInfo, OmpSessionsSnapshot,
} from "./ports/side-channel.js";

/**
 * Read the run's own session landscape (cwd-scoped `session/list`, bounded and
 * paged) plus, under the operator's diagnostic switch, the host-wide counts.
 * Any failure degrades to a typed error — callers log and skip, never fail the
 * run.
 */
export async function queryOmpSessions(
  omp: OmpSideChannelTarget,
  opts: { cwd: string; diagnostic?: boolean; timeoutMs?: number },
): Promise<OmpQueryResult> {
  return createAcpSideChannel(omp).listSessions({
    cwd: opts.cwd,
    diagnostic: opts.diagnostic,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * The cwd a session recorded, for the fork precondition: omp opens the fork at
 * the client's cwd and rejects a switch to a source that recorded another one.
 */
export async function findOmpSessionCwd(
  omp: OmpSideChannelTarget,
  sessionId: string,
  opts: SessionCwdQuery = {},
): Promise<OmpSessionCwdResult> {
  return createAcpSideChannel(omp).findSessionCwd(sessionId, opts);
}

/**
 * Fork a persisted omp session. omp rejects sources that are not persisted on
 * disk or that have a prompt in flight; both surface as typed errors for the
 * caller to log and continue from.
 */
export async function forkOmpSession(
  omp: OmpSideChannelTarget,
  sourceSessionId: string,
  cwd: string,
  timeoutMs = 10_000,
): Promise<OmpForkResult> {
  return createAcpSideChannel(omp).forkSession(sourceSessionId, cwd, timeoutMs);
}
