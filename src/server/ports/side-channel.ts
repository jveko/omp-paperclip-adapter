/**
 * The READ lane: every initialize-only read of omp state, as an interface.
 *
 * ACP is one implementation (`adapters/acp/side-channel.ts`). These methods are
 * the whole vocabulary a transport has to provide: none of them may create a
 * session (`session/new`) — they read persisted state, and a created session
 * record would pollute the very listings they return. Callers above this port
 * (session-intel, the run plan, the environment test) never see a frame.
 */

/** The omp executable a side channel is bound to (command, args, child env). */
export interface OmpSideChannelTarget {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface OmpSessionInfo {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  messageCount: number | null;
  size: number | null;
}
export interface OmpProjectInfo {
  cwd: string;
  sessionCount: number | null;
  lastActivityAt: string | null;
  lastTitle: string | null;
}
/**
 * The session landscape for ONE workspace. Every read that produced it is
 * scoped to the run's cwd, so this type can never carry another tenant's
 * sessions: `sessions` is the cwd bucket omp resolved for this run, and
 * `projects` is that same bucket summarized (one entry in practice).
 */
export interface OmpSessionsSnapshot {
  projects: OmpProjectInfo[];
  sessions: OmpSessionInfo[];
  /** Session count for the cwd, or null when the first page was truncated. */
  total: number | null;
  /** omp paged the listing (session/list page size 50): more sessions exist. */
  truncated: boolean;
}
/**
 * What the operator-gated diagnostic is allowed to publish: counts, never ids,
 * cwds or titles. A host-wide listing exists to show the blast radius of
 * `_omp/*`, not to render other companies' sessions.
 */
export interface OmpHostDiagnostic {
  sessionCount: number | null;
  projectCount: number | null;
  error?: string;
}
export type OmpQueryResult =
  | { ok: true; snapshot: OmpSessionsSnapshot; hostDiagnostic?: OmpHostDiagnostic }
  | { ok: false; error: string };

export type OmpSessionCwdResult =
  | { ok: true; cwd: string }
  | { ok: false; error: string };

export type OmpForkResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

export interface SessionListQuery {
  cwd: string;
  /**
   * Also read the host-wide `_omp/*` counts on the same connection. They are
   * reduced to counts here; ids, cwds and titles never leave the side channel.
   */
  diagnostic?: boolean;
  timeoutMs?: number;
}

export interface SessionCwdQuery {
  timeoutMs?: number;
  /** Page cap for the lookup; the source may live under any workspace. */
  maxPages?: number;
}

export interface OmpSideChannel {
  /**
   * A cwd-scoped, bounded `session/list` read: the run's own session
   * landscape. A listing that stopped at the page cap reports `truncated` and
   * claims no total. There is deliberately no `_omp/*` fallback — an omp that
   * cannot list sessions yields an error, never a widened listing.
   */
  listSessions(query: SessionListQuery): Promise<OmpQueryResult>;
  /**
   * The cwd a persisted session recorded, read from an UNFILTERED listing (a
   * source session can live under any workspace). Used as the fork
   * precondition: omp rejects a fork whose source recorded another cwd.
   */
  findSessionCwd(sessionId: string, query?: SessionCwdQuery): Promise<OmpSessionCwdResult>;
  /** Fork a persisted session. omp rejects a source that is not on disk. */
  forkSession(sessionId: string, cwd: string, timeoutMs?: number): Promise<OmpForkResult>;
}
