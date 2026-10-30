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
  /** The build advertises ACP `session/fork`, the run directive's dependency. */
  supportsSessionFork?: boolean;
  /** `_session/steering` answers (advertised in `_meta` or behaviourally). */
  supportsSteering?: boolean;
  /** `_omp/extensions` answers with the loaded-extension list. */
  supportsExtensions?: boolean;
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
  error?: { code: number; message: string; data?: unknown };
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
            ...("data" in (err as object) ? { data: (err as { data?: unknown }).data } : {}),
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
 * Whether the agent's initialize result advertises one ACP session
 * capability. The snapshot read has no host-wide fallback by design (see
 * `queryOmpSessions`), so an omp build without `list` silently produces no
 * session-snapshot card — the environment test is the only place that can say
 * so up front. Unknown shape counts as absent.
 */
function advertisesSessionCapability(
  initializeInfo: Record<string, unknown> | undefined,
  capability: "list" | "fork",
): boolean {
  if (!initializeInfo) return false;
  const capabilities = initializeInfo.agentCapabilities;
  if (!isRecordObject(capabilities)) return false;
  const sessionCapabilities = capabilities.sessionCapabilities;
  if (!isRecordObject(sessionCapabilities)) return false;
  return sessionCapabilities[capability] !== undefined && sessionCapabilities[capability] !== null;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `_meta.steering.supported`, the bit claude-agent-acp/codex-acp advertise. */
function advertisesSteering(initializeInfo: Record<string, unknown> | undefined): boolean {
  if (!initializeInfo) return false;
  const meta = initializeInfo._meta;
  if (!isRecordObject(meta)) return false;
  const steering = meta.steering;
  return isRecordObject(steering) && steering.supported === true;
}

/** A session id no build can hold, so the steering probe does no work. */
const STEERING_PROBE_SESSION_ID = "paperclip-capability-probe";

/** The `details` string of a JSON-RPC error, when the build sends one. */
function errorDetails(error: { data?: unknown }): string | null {
  const data = error.data;
  if (typeof data !== "object" || data === null || !("details" in data)) return null;
  return typeof data.details === "string" ? data.details : null;
}

/**
 * Whether an error means "this build has no such method". omp answers an
 * unknown method with -32601, and an unknown `_omp/*` ext method with -32603
 * whose `data.details` names the method (`acp-agent.ts` "Unknown ACP ext
 * method: <name>"). The message alone is just "Internal error", so the details
 * field is what identifies an absent ext surface.
 */
function isMethodAbsent(error: { code: number; message: string; data?: unknown }, method: string): boolean {
  if (error.code === -32601) return true;
  const text = [error.message, errorDetails(error) ?? ""].join("\n");
  return /Unknown ACP ext method/i.test(text) && text.includes(method);
}

export function probeOmpAcpSession(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  timeoutMs = 10_000,
): Promise<OmpAcpProbeResult> {
  const cwd = process.cwd();
  // One process, one handshake, four questions: the advertised capability
  // block, the config-option id set, and two behavioural probes that mark the
  // surfaces a build may simply not have. All are read-only: the steering
  // probe names a session that cannot exist, and `_omp/extensions` is a disk
  // scan.
  return driveAcpSession(omp, [
    { method: "session/new", params: { cwd, mcpServers: [] } },
    { method: "_omp/extensions", params: { cwd } },
    {
      method: "_session/steering",
      params: {
        sessionId: STEERING_PROBE_SESSION_ID,
        prompt: [{ type: "text", text: "capability probe" }],
      },
    },
  ], timeoutMs).then((drive): OmpAcpProbeResult => {
    const supportsSessionList = advertisesSessionCapability(drive.initializeInfo, "list");
    const supportsSessionFork = advertisesSessionCapability(drive.initializeInfo, "fork");
    const advertisedSteering = advertisesSteering(drive.initializeInfo);
    if (!drive.ok) {
      return {
        ok: false, protocolVersion: drive.protocolVersion, supportsSessionList,
        supportsSessionFork, supportsSteering: advertisedSteering, error: drive.error,
      };
    }
    const response = drive.responses[0];
    if (response?.error) {
      return {
        ok: false, supportsSessionList, supportsSessionFork,
        supportsSteering: advertisedSteering,
        error: `ACP error on request id ${response.id}: ${response.error.message}`,
      };
    }
    const options = Array.isArray(response?.result?.configOptions)
      ? (response.result?.configOptions as Array<Record<string, unknown>>)
      : [];
    const model = options.find((o) => o.id === "model") as { currentValue?: unknown } | undefined;
    const extensions = drive.responses[1];
    const steering = drive.responses[2];
    return {
      ok: true,
      protocolVersion: 1,
      currentModel: typeof model?.currentValue === "string" ? model.currentValue : undefined,
      supportsSessionList,
      supportsSessionFork,
      // A method that exists answers the bogus session id with invalid params
      // (or its outcome); only method-not-found means the build lacks it.
      supportsSteering: steering?.error
        ? !isMethodAbsent(steering.error, "_session/steering")
        : steering !== undefined || advertisedSteering,
      supportsExtensions: extensions?.error
        ? !isMethodAbsent(extensions.error, "_omp/extensions")
        : Array.isArray(extensions?.result?.extensions),
      configOptionIds: options
        .map((option) => (typeof option.id === "string" ? option.id : ""))
        .filter((id) => id.length > 0),
    };
  });
}
