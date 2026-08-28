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
export interface OmpSessionsSnapshot {
  projects: OmpProjectInfo[];
  sessions: OmpSessionInfo[];
  total: number | null;
  byCwd: OmpSessionInfo[];
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
 * Read omp's persisted session landscape over an initialize-only ACP side
 * channel. Never sends session/new: omp's extMethod handlers read session
 * files from disk and need no session, and session/new would persist a new
 * record that pollutes the listings this function reads. Any failure degrades
 * to a typed error — callers log and skip, never fail the run.
 */
export async function queryOmpSessions(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<OmpQueryResult> {
  const drive = await driveAcpSession(omp, [
    { method: "_omp/projects/list", params: {} },
    { method: "_omp/sessions/listAll", params: {} },
    { method: "_omp/chats/byCwd", params: { cwd: opts.cwd ?? process.cwd() } },
  ], opts.timeoutMs ?? 10_000);
  if (!drive.ok) return { ok: false, error: drive.error ?? "ACP drive failed" };
  const failed = drive.responses.find((r) => r.error);
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
  return {
    ok: true,
    snapshot: {
      projects,
      sessions,
      total: typeof listAllRaw?.total === "number" ? listAllRaw.total : null,
      byCwd: parseSessions(byCwdRaw?.sessions),
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
