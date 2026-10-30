import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * The ACP side-channel client: a hand-written, initialize-only JSON-RPC driver.
 *
 * It exists beside the acpx engine because the engine is the run lane, not a
 * read lane: these reads (`session/list`, `session/fork`, `_omp/*`) must not
 * call `session/new` — that always persists a new session record and would
 * pollute the listings they read — so they drive the same `omp acp` binary
 * directly. Nothing here knows about runs, overlays or Paperclip.
 */

export interface OmpAcpProbeResult {
  ok: boolean;
  protocolVersion?: number;
  currentModel?: string;
  /** The build advertises ACP `session/list`, the read the snapshot depends on. */
  supportsSessionList?: boolean;
  /** Ids the handshake advertised; omp accepts only mode|model|thinking. */
  configOptionIds?: string[];
  error?: string;
}

export interface AcpFrameRequest {
  method: string;
  params?: Record<string, unknown>;
}
export interface AcpFrameResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}
export interface AcpDriveResult {
  ok: boolean;
  initializeInfo?: Record<string, unknown>;
  responses: AcpFrameResponse[];
  error?: string;
  /** Received protocolVersion when the initialize handshake failed on a mismatch. */
  protocolVersion?: number;
}

/**
 * Spawn `omp acp`, complete the initialize handshake, then issue `requests`
 * sequentially and collect their responses. Read-only request sets must omit
 * `session/new`: omp's extMethod handlers read persisted state from disk and
 * need no session, while `session/new` always persists a new session record
 * and would pollute session listings. Kills the child on completion, error,
 * or timeout; never throws.
 *
 * `follow` (optional) is called every time the queue drains, with the responses
 * so far in request order; the frames it returns are appended and driven on the
 * same connection (a paged read needs the next cursor, which only a response can
 * supply, and re-spawning the child per page would pay the ACP handshake once
 * per page). Returning null/[] finishes the drive. The caller owns the cap: an
 * unbounded follow runs until the timeout.
 */
export function driveAcpSession(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  requests: AcpFrameRequest[],
  timeoutMs = 10_000,
  follow?: (responses: AcpFrameResponse[]) => AcpFrameRequest[] | null,
): Promise<AcpDriveResult> {
  return new Promise<AcpDriveResult>((resolve) => {
    const queue = [...requests];
    const child = spawn(omp.command, omp.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: omp.env ? { ...process.env, ...omp.env } : undefined,
    });
    child.stdin.on("error", () => {});
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    const suffix = () => {
      const trimmed = stderrTail.trim();
      return trimmed ? `: ${trimmed}` : "";
    };
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const responses: AcpFrameResponse[] = [];
    let initializeInfo: Record<string, unknown> | undefined;
    // nextId 1 is initialize; requests take 2..n in order.
    let nextIndex = 0;
    const finish = (r: AcpDriveResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(r);
    };
    timer = setTimeout(
      () => finish({ ok: false, responses, error: `ACP drive timed out after ${timeoutMs}ms${suffix()}` }),
      timeoutMs,
    );
    child.on("error", (err) => {
      finish({ ok: false, responses, error: String(err) });
    });
    child.on("close", () => {
      finish({ ok: false, responses, error: `ACP child exited before the drive completed${suffix()}` });
    });
    const sendNext = () => {
      if (nextIndex >= queue.length) {
        const more = follow?.(responses) ?? null;
        if (more && more.length > 0) queue.push(...more);
        else { finish({ ok: true, initializeInfo, responses }); return; }
      }
      const req = queue[nextIndex];
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: nextIndex + 2, method: req.method, params: req.params ?? {} }) + "\n",
      );
    };
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { return; }
      if (typeof msg !== "object" || msg === null || !("id" in msg)) return;
      const id = Number((msg as { id: unknown }).id);
      const err = (msg as { error?: unknown }).error;
      const result = (msg as { result?: unknown }).result;
      if (id === 1) {
        if (typeof err === "object" && err !== null) {
          const detail = "message" in (err as object) ? String((err as { message: unknown }).message) : JSON.stringify(err);
          finish({ ok: false, responses, error: `ACP initialize error: ${detail}` });
          return;
        }
        if (typeof result !== "object" || result === null || Number((result as { protocolVersion?: unknown }).protocolVersion) !== 1) {
          const received = Number((result as { protocolVersion?: unknown } | null)?.protocolVersion);
          finish({
            ok: false,
            responses,
            protocolVersion: Number.isFinite(received) ? received : undefined,
            error: `unexpected protocolVersion ${Number.isFinite(received) ? received : "missing"}`,
          });
          return;
        }
        initializeInfo = result as Record<string, unknown>;
        sendNext();
        return;
      }
      const expectedId = nextIndex + 2;
      if (id !== expectedId) return;
      if (typeof err === "object" && err !== null) {
        responses.push({
          id,
          error: {
            code: Number((err as { code?: unknown }).code ?? 0),
            message: "message" in (err as object) ? String((err as { message: unknown }).message) : JSON.stringify(err),
          },
        });
      } else if (typeof result === "object" && result !== null) {
        responses.push({ id, result: result as Record<string, unknown> });
      } else {
        responses.push({ id });
      }
      nextIndex += 1;
      sendNext();
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n",
    );
  });
}

/**
 * Whether the agent's initialize result advertises ACP `session/list`. The
 * snapshot read has no host-wide fallback by design (see `queryOmpSessions`),
 * so an omp build without it silently produces no session-snapshot card — the
 * environment test is the only place that can say so up front. Unknown shape
 * counts as absent.
 */
function advertisesSessionList(initializeInfo: Record<string, unknown> | undefined): boolean {
  if (!initializeInfo || !("agentCapabilities" in initializeInfo)) return false;
  const capabilities = initializeInfo.agentCapabilities;
  if (typeof capabilities !== "object" || capabilities === null) return false;
  if (!("sessionCapabilities" in capabilities)) return false;
  const sessionCapabilities = capabilities.sessionCapabilities;
  if (typeof sessionCapabilities !== "object" || sessionCapabilities === null) return false;
  return "list" in sessionCapabilities && sessionCapabilities.list !== null;
}

export function probeOmpAcpSession(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  timeoutMs = 10_000,
): Promise<OmpAcpProbeResult> {
  return driveAcpSession(omp, [
    { method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } },
  ], timeoutMs).then((drive): OmpAcpProbeResult => {
    const supportsSessionList = advertisesSessionList(drive.initializeInfo);
    if (!drive.ok) {
      return { ok: false, protocolVersion: drive.protocolVersion, supportsSessionList, error: drive.error };
    }
    const response = drive.responses[0];
    if (response?.error) {
      return { ok: false, supportsSessionList, error: `ACP error on request id ${response.id}: ${response.error.message}` };
    }
    const options = Array.isArray(response?.result?.configOptions)
      ? (response.result?.configOptions as Array<Record<string, unknown>>)
      : [];
    const model = options.find((o) => o.id === "model") as { currentValue?: unknown } | undefined;
    return {
      ok: true,
      protocolVersion: 1,
      currentModel: typeof model?.currentValue === "string" ? model.currentValue : undefined,
      supportsSessionList,
      configOptionIds: options
        .map((option) => (typeof option.id === "string" ? option.id : ""))
        .filter((id) => id.length > 0),
    };
  });
}
