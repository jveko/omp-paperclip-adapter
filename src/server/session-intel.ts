import { driveAcpSession, type AcpFrameRequest } from "./acp.js";

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
export interface OmpSubagentInfo {
  id: string;
  index: number | null;
  agent: string;
  status: string | null;
  description: string | null;
  parentToolCallId: string | null;
  lastUpdate: number | null;
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
  /**
   * Subagents spawned by this run's session, present only under the operator
   * diagnostic switch. omp's ACP mode has no subagent bridge today (see
   * docs/upstream/omp-acp-subagent-bridge.md), so in practice this is absent;
   * an empty array means the method answered and the tree is empty.
   */
  subagents?: OmpSubagentInfo[];
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
 * Mirror of omp's `RpcSubagentSnapshot` (modes/rpc/rpc-types.ts), reduced to the
 * fields a board summary needs. Unknown/omitted fields become null rather than
 * being passed through, so the work product shape stays stable across omp
 * versions. Entries without an id carry no observable meaning and are dropped.
 */
function parseSubagent(raw: unknown): OmpSubagentInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  if (!id) return null;
  return {
    id,
    index: typeof r.index === "number" ? r.index : null,
    agent: typeof r.agent === "string" ? r.agent : "",
    status: typeof r.status === "string" ? r.status : null,
    description: typeof r.description === "string" ? r.description : null,
    parentToolCallId: typeof r.parentToolCallId === "string" ? r.parentToolCallId : null,
    lastUpdate: typeof r.lastUpdate === "number" ? r.lastUpdate : null,
  };
}

function parseSubagents(value: unknown): OmpSubagentInfo[] {
  return Array.isArray(value)
    ? value.map(parseSubagent).filter((s): s is OmpSubagentInfo => s !== null)
    : [];
}

/**
 * Read the run's own session landscape over an initialize-only ACP side
 * channel. Never sends session/new: session/list reads persisted state and
 * needs no session, while session/new always persists a new record that would
 * pollute the listings this function reads. Any failure degrades to a typed
 * error — callers log and skip, never fail the run.
 *
 * The single required frame is ACP `session/list` with the run's cwd
 * (acp-agent.ts:897-911). Its cwd filter resolves the sessions bucket for THIS
 * workspace under the agent dir the child resolved, so it is the tenant-scoped
 * replacement for `_omp/sessions/listAll` (a host-wide scan) and
 * `_omp/projects/list` (same scan, bucketed). There is deliberately no
 * `_omp/*` fallback: on an omp that cannot list sessions the snapshot is
 * skipped with a warning rather than widened to every tenant on the host.
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
    // A capability probe for THIS run's own session, not a listing: it is what
    // the snapshot card reports as the subagent tree, so it stays on the default
    // path. omp answers it only on versions that implement it (an unimplemented
    // `_omp/*` method is an immediate JSON-RPC error, never a hang), which
    // costs one round-trip and cannot starve the required read.
    { method: "_omp/subagents", params: {} },
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
  const drive = await driveAcpSession(omp, requests, opts.timeoutMs ?? 10_000);
  if (!drive.ok) return { ok: false, error: drive.error ?? "ACP drive failed" };
  const byMethod = new Map(
    requests.map((request, index) => [request.method, drive.responses[index]]),
  );
  const listing = byMethod.get("session/list");
  if (!listing) return { ok: false, error: "session/list returned no response" };
  if (listing.error) return { ok: false, error: listing.error.message };
  const sessions = parseSessions(listing.result?.sessions);
  const truncated = typeof listing.result?.nextCursor === "string"
    && listing.result.nextCursor.length > 0;
  const snapshot: OmpSessionsSnapshot = {
    projects: projectBuckets(sessions),
    sessions,
    // A paged listing cannot claim a complete count.
    total: truncated ? null : sessions.length,
    truncated,
  };
  // The subagent frame is a capability probe, never a requirement: an omp that
  // does not implement it leaves the snapshot exactly as it was.
  const subagentsResponse = byMethod.get("_omp/subagents");
  if (!subagentsResponse?.error && Array.isArray(subagentsResponse?.result?.subagents)) {
    snapshot.subagents = parseSubagents(subagentsResponse.result.subagents);
  }
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
