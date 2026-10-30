import { driveAcpSession, type AcpFrameRequest, type AcpFrameResponse } from "./acp.js";

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

function parseSession(raw: unknown): OmpSessionInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sessionId = typeof r.sessionId === "string" ? r.sessionId : null;
  if (!sessionId) return null;
  const meta = (typeof r._meta === "object" && r._meta !== null ? r._meta : {}) as Record<string, unknown>;
  return {
    sessionId,
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    title: typeof r.title === "string" ? r.title : null,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
    messageCount: typeof meta.messageCount === "number" ? meta.messageCount : null,
    size: typeof meta.size === "number" ? meta.size : null,
  };
}

function parseSessions(value: unknown): OmpSessionInfo[] {
  return Array.isArray(value)
    ? value.map(parseSession).filter((s): s is OmpSessionInfo => s !== null)
    : [];
}

/**
 * Mirror of omp's `_omp/projects/list` bucketing (acp-agent.ts:1428-1455),
 * computed from the cwd-scoped listing instead of a host-wide scan: group by
 * cwd, keep the newest activity, newest first.
 */
function projectBuckets(sessions: OmpSessionInfo[]): OmpProjectInfo[] {
  const buckets = new Map<string, OmpProjectInfo & { lastMs: number }>();
  for (const session of sessions) {
    if (!session.cwd) continue;
    const ms = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
    const previous = buckets.get(session.cwd);
    if (previous) {
      previous.sessionCount = (previous.sessionCount ?? 0) + 1;
      if (Number.isFinite(ms) && ms > previous.lastMs) {
        previous.lastMs = ms;
        previous.lastActivityAt = session.updatedAt;
        previous.lastTitle = session.title;
      }
    } else {
      buckets.set(session.cwd, {
        cwd: session.cwd,
        sessionCount: 1,
        lastActivityAt: session.updatedAt,
        lastTitle: session.title,
        lastMs: Number.isFinite(ms) ? ms : 0,
      });
    }
  }
  return [...buckets.values()]
    .sort((a, b) => b.lastMs - a.lastMs)
    .map(({ lastMs: _lastMs, ...rest }) => rest);
}

/**
 * Page cap for the snapshot read. omp's `session/list` pages at 50
 * (acp-agent.ts:111) and offers the next offset as an opaque `nextCursor`
 * (acp-agent.ts:897-912), so a bounded read covers 250 sessions — well past any
 * workspace an employee works in — while keeping one heartbeat's side channel
 * from walking an unbounded listing. The cap is reported, never hidden: past it
 * the landscape says `truncated` and claims no count.
 */
const MAX_SNAPSHOT_PAGES = 5;

/**
 * Read the run's own session landscape over an initialize-only ACP side
 * channel. Never sends session/new: session/list reads persisted state and
 * needs no session, while session/new always persists a new record that would
 * pollute the listings this function reads. Any failure degrades to a typed
 * error — callers log and skip, never fail the run.
 *
 * The required frames are ACP `session/list` with the run's cwd
 * (acp-agent.ts:897-912), followed through `nextCursor` up to
 * MAX_SNAPSHOT_PAGES. Its cwd filter resolves the sessions bucket for THIS
 * workspace under the agent dir the child resolved, so it is the tenant-scoped
 * replacement for `_omp/sessions/listAll` (a host-wide scan) and
 * `_omp/projects/list` (same scan, bucketed). Every page carries that cwd: a
 * cursor page without it would list every tenant on the host. There is
 * deliberately no `_omp/*` fallback: on an omp that cannot list sessions the
 * snapshot is skipped with a warning rather than widened to every tenant on the
 * host.
 *
 * `diagnostic` adds the host-wide `_omp/*` reads for an operator who explicitly
 * turned the switch on. They contribute counts only (`OmpHostDiagnostic`) —
 * ids, cwds and titles stay off the work product — and their failure degrades
 * to `hostDiagnostic.error` instead of failing the snapshot.
 */
export async function queryOmpSessions(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  opts: { cwd: string; diagnostic?: boolean; timeoutMs?: number },
): Promise<OmpQueryResult> {
  const requests: AcpFrameRequest[] = [
    { method: "session/list", params: { cwd: opts.cwd } },
  ];
  if (opts.diagnostic) {
    // Host-wide reads, gated behind the operator switch. Their results are
    // reduced to counts (see OmpHostDiagnostic) before anything leaves this
    // function.
    requests.push(
      { method: "_omp/sessions/listAll", params: {} },
      { method: "_omp/projects/list", params: {} },
    );
  }
  // The page responses sit at known indices (diagnostics are queued once, ahead
  // of the followed pages), so the cursor is read by index rather than by
  // sniffing the payload.
  const pageIndices = [0];
  let truncated = false;
  const follow = (responses: AcpFrameResponse[]): AcpFrameRequest[] | null => {
    const cursor = responses[pageIndices[pageIndices.length - 1]]?.result?.nextCursor;
    if (typeof cursor !== "string" || cursor.length === 0) return null;
    if (pageIndices.length >= MAX_SNAPSHOT_PAGES) {
      // The cap was hit with more to read: the landscape is incomplete.
      truncated = true;
      return null;
    }
    pageIndices.push(responses.length);
    return [{ method: "session/list", params: { cwd: opts.cwd, cursor } }];
  };
  const drive = await driveAcpSession(omp, requests, opts.timeoutMs ?? 10_000, follow);
  if (!drive.ok) return { ok: false, error: drive.error ?? "ACP drive failed" };
  const byMethod = new Map(
    requests.map((request, index) => [request.method, drive.responses[index]]),
  );
  const pages = pageIndices
    .map((index) => drive.responses[index])
    .filter((response): response is AcpFrameResponse => Boolean(response));
  if (pages.length === 0) return { ok: false, error: "session/list returned no response" };
  const failed = pages.find((response) => response.error);
  if (failed?.error) return { ok: false, error: failed.error.message };
  const sessions = pages.flatMap((response) => parseSessions(response.result?.sessions));
  const snapshot: OmpSessionsSnapshot = {
    projects: projectBuckets(sessions),
    sessions,
    // A listing that stopped short cannot claim a complete count.
    total: truncated ? null : sessions.length,
    truncated,
  };
  if (!opts.diagnostic) return { ok: true, snapshot };
  const listAll = byMethod.get("_omp/sessions/listAll");
  const projects = byMethod.get("_omp/projects/list");
  const diagnosticFailed = [listAll, projects].find((r) => r?.error);
  if (diagnosticFailed?.error) {
    return {
      ok: true,
      snapshot,
      hostDiagnostic: {
        sessionCount: null,
        projectCount: null,
        error: diagnosticFailed.error.message,
      },
    };
  }
  return {
    ok: true,
    snapshot,
    hostDiagnostic: {
      sessionCount: typeof listAll?.result?.total === "number" ? listAll.result.total : null,
      projectCount: Array.isArray(projects?.result?.projects) ? projects.result.projects.length : null,
    },
  };
}

export type OmpSessionCwdResult =
  | { ok: true; cwd: string }
  | { ok: false; error: string };

/** Bounded pages for the fork-source lookup (50 sessions/page in omp). */
const MAX_SOURCE_LOOKUP_PAGES = 5;

/**
 * The cwd a session recorded, for the fork precondition.
 *
 * omp's `session/fork` opens the new session at the CLIENT's cwd and then
 * switches to the source file without an `onCwdChange` callback; the switch
 * rejects when the source's recorded cwd differs (`agent-session.ts:12689`,
 * `SESSION_CWD_CHANGE_REJECTED`, surfaced as -32603). The source can live
 * under any workspace, so the lookup is deliberately UNFILTERED — a cwd-scoped
 * `session/list` would only find sessions of this run's workspace. Only the
 * cwd of the id the operator already named is returned; nothing here is
 * published, and the listing is bounded to a few pages.
 */
export async function findOmpSessionCwd(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  sessionId: string,
  opts: { timeoutMs?: number; maxPages?: number } = {},
): Promise<OmpSessionCwdResult> {
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? MAX_SOURCE_LOOKUP_PAGES));
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const drive = await driveAcpSession(omp, [
      { method: "session/list", params: cursor ? { cursor } : {} },
    ], opts.timeoutMs ?? 10_000);
    if (!drive.ok) return { ok: false, error: drive.error ?? "ACP drive failed" };
    const response = drive.responses[0];
    if (response?.error) return { ok: false, error: response.error.message };
    const match = parseSessions(response?.result?.sessions)
      .find((session) => session.sessionId === sessionId);
    if (match) {
      return match.cwd.trim() !== ""
        ? { ok: true, cwd: match.cwd }
        : { ok: false, error: `session ${sessionId} has no recorded cwd` };
    }
    const next = response?.result?.nextCursor;
    if (typeof next !== "string" || next.length === 0) break;
    cursor = next;
  }
  return {
    ok: false,
    error: `session ${sessionId} is not in this omp agent dir's session listing`,
  };
}

export type OmpForkResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

/**
 * Fork a persisted omp session over the side channel. omp rejects sources
 * that are not persisted on disk or that have a prompt in flight; both surface
 * here as typed errors for the caller to log and continue from.
 */
export async function forkOmpSession(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  sourceSessionId: string,
  cwd: string,
  timeoutMs = 10_000,
): Promise<OmpForkResult> {
  const drive = await driveAcpSession(omp, [
    { method: "session/fork", params: { sessionId: sourceSessionId, cwd, mcpServers: [] } },
  ], timeoutMs);
  if (!drive.ok) return { ok: false, error: drive.error ?? "ACP drive failed" };
  const response = drive.responses[0];
  if (response?.error) return { ok: false, error: response.error.message };
  const sessionId = typeof response?.result?.sessionId === "string" ? response.result.sessionId : null;
  if (!sessionId) return { ok: false, error: "session/fork returned no sessionId" };
  return { ok: true, sessionId };
}
