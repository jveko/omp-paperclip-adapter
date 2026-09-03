import { driveAcpSession } from "./acp.js";

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
export interface OmpSessionsSnapshot {
  projects: OmpProjectInfo[];
  sessions: OmpSessionInfo[];
  total: number | null;
  byCwd: OmpSessionInfo[];
  /**
   * Subagents spawned by this run's session, present only when omp answers
   * `_omp/subagents`. omp's ACP mode has no subagent bridge today (see
   * docs/upstream/omp-acp-subagent-bridge.md), so in practice this is absent;
   * an empty array means the method answered and the tree is empty.
   */
  subagents?: OmpSubagentInfo[];
}
export type OmpQueryResult =
  | { ok: true; snapshot: OmpSessionsSnapshot }
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
 * Frames whose failure means the snapshot has no trustworthy content. The
 * subagent frame is deliberately excluded: it is a capability probe, not a
 * requirement (see `queryOmpSessions`).
 */
const REQUIRED_READ_COUNT = 3;

/**
 * Read omp's persisted session landscape over an initialize-only ACP side
 * channel. Never sends session/new: omp's extMethod handlers read session
 * files from disk and need no session, and session/new would persist a new
 * record that pollutes the listings this function reads. Any failure degrades
 * to a typed error — callers log and skip, never fail the run.
 *
 * The `_omp/subagents` frame is optional by design: omp answers it on the
 * versions that implement it and errors on those that do not, in which case the
 * snapshot is returned exactly as it was before subagents were ever asked about.
 */
export async function queryOmpSessions(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<OmpQueryResult> {
  const drive = await driveAcpSession(omp, [
    { method: "_omp/projects/list", params: {} },
    { method: "_omp/sessions/listAll", params: {} },
    { method: "_omp/chats/byCwd", params: { cwd: opts.cwd ?? process.cwd() } },
    // Capability-gated and ordered last: omp's ACP mode bridges no subagent
    // events (RPC mode alone subscribes task:subagent:* — see
    // docs/upstream/omp-acp-subagent-bridge.md), and an unimplemented `_omp/*`
    // method is answered with an immediate JSON-RPC error rather than a hang,
    // so this costs one round-trip and cannot starve the required reads.
    { method: "_omp/subagents", params: {} },
  ], opts.timeoutMs ?? 10_000);
  if (!drive.ok) return { ok: false, error: drive.error ?? "ACP drive failed" };
  const failed = drive.responses.slice(0, REQUIRED_READ_COUNT).find((r) => r.error);
  if (failed) return { ok: false, error: failed.error?.message ?? "extMethod error" };
  const projectsRaw = drive.responses[0]?.result;
  const listAllRaw = drive.responses[1]?.result;
  const byCwdRaw = drive.responses[2]?.result;
  const projects = Array.isArray(projectsRaw?.projects)
    ? (projectsRaw.projects as Array<Record<string, unknown>>).map((p) => ({
        cwd: typeof p.cwd === "string" ? p.cwd : "",
        sessionCount: typeof p.sessionCount === "number" ? p.sessionCount : null,
        lastActivityAt: typeof p.lastActivityAt === "string" ? p.lastActivityAt : null,
        lastTitle: typeof p.lastTitle === "string" ? p.lastTitle : null,
      }))
    : [];
  const sessions = parseSessions(listAllRaw?.sessions);
  const subagentsResponse = drive.responses[REQUIRED_READ_COUNT];
  const subagentsPayload = subagentsResponse?.error
    ? undefined
    : subagentsResponse?.result?.subagents;
  const subagents = Array.isArray(subagentsPayload) ? parseSubagents(subagentsPayload) : null;
  const snapshot: OmpSessionsSnapshot = {
    projects,
    sessions,
    total: typeof listAllRaw?.total === "number" ? listAllRaw.total : null,
    byCwd: parseSessions(byCwdRaw?.sessions),
  };
  if (subagents) snapshot.subagents = subagents;
  return { ok: true, snapshot };
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
