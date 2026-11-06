import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

/**
 * The adapter ↔ supervisor wire format.
 *
 * One JSON object per line, `id`-correlated, `v: 1`. The adapter is the client;
 * the supervisor is the server on a Unix socket. `run.settled` is the only
 * terminal frame for a run — a refusal or a failure is a settled result with an
 * `errorCode`, so a caller never has two terminal paths to await.
 *
 * Nothing in this module does I/O. The field names are the contract every other
 * host module reads, and the ledger copies them by name.
 */

export const HOST_PROTOCOL_VERSION = 1;

/** The run's state machine, as journaled. */
export type LedgerState =
  | "leased"
  | "worker_ready"
  | "session_open"
  | "prompting"
  | "settled"
  | "closed"
  | "refused"
  | "lost";

/** Why a run left the happy path; `settled` records carry the stop reason instead. */
export type LedgerCause =
  | "clean"
  | "worker_exit"
  | "host_exit"
  | "adapter_gone"
  | "cancel"
  | "timeout"
  | "lease_held"
  | "config_error"
  | "capacity";

/** The exact process the host must run. Env never carries the run JWT. */
export interface WorkerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The worker's reuse identity. The host compares these values (plus cwd, the
 * agent dir and the omp version it observes) before it reuses a warm worker;
 * a mismatch retires the worker and spawns a new one.
 */
export interface Cell {
  argvHash: string;
  bridgeHash: string;
  agentDir: string | null;
  /** The named omp profile this run uses (`sessionScope: "profile"`), else null. */
  profile: string | null;
  model: string | null;
  thinking: string | null;
  approval: string | null;
}

/**
 * Per-run Paperclip credentials. This object is written to the run-context file
 * (0600) and is NEVER placed in a worker env or a ledger record.
 */
export interface Credentials {
  apiUrl: string;
  apiKey: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
}

/** The run's connection-tools access, held by the host (never the worker). */
export interface ConnectionTools {
  endpoint: string;
  bearerToken: string;
  expiresAt: string | null;
  tools: string[];
}

/** Manifest paths the bridge reads; stable across runs for one agent. */
export interface Manifests {
  skills: string | null;
  governance: string | null;
  budget: string | null;
  failover: string | null;
  thinking: string | null;
}

export interface Limits {
  /** The adapter's wall clock bound, or null for none. */
  timeoutMs: number | null;
  /** The adapter promises a heartbeat at least this often; the host refuses silence. */
  runLeaseTtlMs: number;
}

export interface WorkerIdentity {
  pid: number;
  pgid: number | null;
  startedAt: string;
}

export interface HelloFrame {
  id: string;
  type: "hello";
  v: typeof HOST_PROTOCOL_VERSION;
  instanceId: string;
  adapterVersion: string;
}

export interface RunBeginFrame {
  id: string;
  type: "run.begin";
  runId: string;
  agent: { id: string; companyId: string };
  sessionKey: string;
  cwd: string;
  /** The omp session this run wants to resume, if any. */
  session: { ompSessionId: string | null; forked?: boolean };
  cell: Cell;
  worker: WorkerSpec;
  /** The rendered Paperclip prompt. Content: never journaled, never logged. */
  prompt: string;
  credentials: Credentials;
  connectionTools?: ConnectionTools | null;
  manifests: Manifests;
  limits: Limits;
  /** When true the supervisor forwards `run.steer` to the live turn. */
  steering?: boolean;
  /**
   * How much of omp's subagent lifecycle this run observes. `summary` streams
   * lifecycle/progress as `omp.subagent`; `events` adds the subagent's own
   * event type; `off` observes nothing. Absent means `summary` (managed lane).
   */
  subagentObservability?: SubagentObservability;
}

export type SubagentObservability = "off" | "summary" | "events";

export interface RunHeartbeatFrame {
  id: string;
  type: "run.heartbeat";
  runId: string;
}

export interface RunCancelFrame {
  id: string;
  type: "run.cancel";
  runId: string;
  reason: "operator" | "timeout" | "shutdown";
}

export interface RunStatusFrame {
  id: string;
  type: "run.status";
  runId: string;
}

export interface RunSteerFrame {
  id: string;
  type: "run.steer";
  runId: string;
  message: string;
  kind: "steer" | "follow_up";
}

export interface ProbeFrame {
  id: string;
  type: "probe";
  kind: "capabilities" | "models" | "sessions" | "fork";
  payload?: Record<string, unknown>;
}

export interface ShutdownFrame {
  id: string;
  type: "shutdown";
  reason?: string;
}

export type HostFrame =
  | HelloFrame
  | RunBeginFrame
  | RunHeartbeatFrame
  | RunCancelFrame
  | RunStatusFrame
  | RunSteerFrame
  | ProbeFrame
  | ShutdownFrame;

export interface HelloOkFrame {
  type: "hello_ok";
  hostVersion: string;
  hostPid: number;
  epoch: string;
  workers: number;
}

export interface RunAcceptedFrame {
  type: "run.accepted";
  /** Echo of the `run.begin` id. */
  id: string;
  runId: string;
  worker: WorkerIdentity;
  reusedWorker: boolean;
  sessionOpening: "new" | "open";
  ompSessionId: string;
  runContextPath: string;
  /**
   * What this worker answered for the managed frames, observed on the run's
   * own calls after its session opened. Absent from a supervisor that predates
   * the probe; the adapter then reports no managed-capability diagnostics.
   */
  workerCapabilities?: WorkerCapabilityObservations;
}

/** The managed worker's answer for one requestable frame. */
export type WorkerCapabilityState = "yes" | "no" | "unknown";

export interface WorkerCapabilityObservations {
  get_session_stats: WorkerCapabilityState;
  set_host_tools: WorkerCapabilityState;
  set_subagent_subscription: WorkerCapabilityState;
}

/**
 * The event vocabulary the adapter maps onto its own sinks. The tool event is
 * `omp.tool_call`; the pre-v0.17 spelling `acpx.tool_call` is still accepted by
 * the adapter relay from an older supervisor, and is never emitted here.
 */
export type RunEventKind = "omp.tool_call" | "run.system" | "omp.turn" | "omp.usage" | "omp.log" | "omp.subagent";

export interface RunEventFrame {
  type: "run.event";
  runId: string;
  /** Monotonic per run; the adapter drops a frame at or below the last seq it saw. */
  seq: number;
  at: string;
  kind: RunEventKind;
  payload: Record<string, unknown>;
}

export interface RunSettledFrame {
  type: "run.settled";
  runId: string;
  /** A finished result; error classification stays the adapter's job. */
  result: AdapterExecutionResult;
}

/** The settlement site that ended a run, in the supervisor's own words. */
export type SettledBy =
  | "outcome"
  | "timeout"
  | "cancel"
  | "adapter_gone"
  | "lease"
  | "worker_exit"
  | "host_exit"
  | "begin_error";

/**
 * The supervisor's own account of a finished run, carried on
 * `resultJson.hostRuntime`. Ids and accounting only: never a credential, a
 * prompt or a transcript. Absent on a result the supervisor did not produce
 * (an unreachable host, a refused begin), so a board can tell "the host ran
 * this" from "the adapter never reached one".
 */
export interface HostRuntime {
  workerPid: number;
  reusedWorker: boolean;
  settledBy: SettledBy;
  cause?: LedgerCause;
  /** The settle record's `seq`; 0 when the ledger write itself failed. */
  ledgerSeq: number;
  /** How long the worker had been alive when the run settled. */
  workerAgeMs: number;
}

export interface RunStatusResultFrame {
  type: "run.status.result";
  id: string;
  runId: string;
  state: LedgerState;
  settled?: AdapterExecutionResult;
}

export interface RunSteerResultFrame {
  type: "run.steer.result";
  id: string;
  runId: string;
  ok: boolean;
  error?: string;
}

export interface ProbeResultFrame {
  type: "probe.result";
  id: string;
  kind: ProbeFrame["kind"];
  payload: Record<string, unknown>;
}

export interface HostErrorFrame {
  type: "error";
  id?: string;
  code: string;
  message: string;
}

export type HostReply =
  | HelloOkFrame
  | RunAcceptedFrame
  | RunEventFrame
  | RunSettledFrame
  | RunStatusResultFrame
  | RunSteerResultFrame
  | ProbeResultFrame
  | HostErrorFrame;

export function encodeFrame(frame: HostFrame | HostReply): string {
  return `${JSON.stringify(frame)}\n`;
}

const COMMAND_TYPES: Record<HostFrame["type"], true> = {
  hello: true,
  "run.begin": true,
  "run.heartbeat": true,
  "run.cancel": true,
  "run.status": true,
  "run.steer": true,
  probe: true,
  shutdown: true,
};

const REPLY_TYPES: Record<HostReply["type"], true> = {
  hello_ok: true,
  "run.accepted": true,
  "run.event": true,
  "run.settled": true,
  "run.status.result": true,
  "run.steer.result": true,
  "probe.result": true,
  error: true,
};

/**
 * The one object guard this boundary needs: IPC input is untrusted, so every
 * nested frame is proven an object before a field is read. It narrows to
 * `Record<string, unknown>`; fields are still checked one by one.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * Identifiers the supervisor turns into filesystem names (run-context files,
 * session directories) or trusts as tenant boundaries. `..`, path separators
 * and empty strings are rejected at the protocol boundary.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isSafeId = (value: unknown): value is string =>
  typeof value === "string" && value !== "." && value !== ".." && SAFE_ID.test(value);

/**
 * Shape checks for the frames whose fields the host acts on. A malformed frame
 * is dropped by the reader (null), never half-applied: the host spawns a
 * process from `run.begin`, so every field it needs must be a string.
 */
function isWellFormed(frame: Record<string, unknown>): boolean {
  switch (frame.type) {
    case "hello":
      return frame.v === HOST_PROTOCOL_VERSION
        && isString(frame.id) && isString(frame.instanceId) && isString(frame.adapterVersion);
    case "run.begin": {
      const worker = frame.worker;
      return isString(frame.id)
        && isSafeId(frame.runId)
        && isString(frame.sessionKey)
        && isString(frame.cwd)
        && isString(frame.prompt)
        && isRecord(frame.agent)
        && isSafeId(frame.agent.id)
        && isSafeId(frame.agent.companyId)
        && isRecord(worker)
        && isString(worker.command)
        && Array.isArray(worker.args)
        && worker.args.every(isString)
        && isRecord(worker.env)
        && Object.values(worker.env).every(isString)
        && isRecord(frame.cell)
        && isRecord(frame.session)
        && (frame.session.forked === undefined || typeof frame.session.forked === "boolean")
        && isRecord(frame.credentials)
        && isString((frame.credentials as Record<string, unknown>).apiUrl)
        && isString((frame.credentials as Record<string, unknown>).apiKey)
        && isRecord(frame.manifests)
        && isRecord(frame.limits)
        && typeof (frame.limits as Record<string, unknown>).runLeaseTtlMs === "number"
        && (frame.steering === undefined || typeof frame.steering === "boolean")
        && (frame.subagentObservability === undefined
          || frame.subagentObservability === "off"
          || frame.subagentObservability === "summary"
          || frame.subagentObservability === "events")
        && (frame.connectionTools === undefined || frame.connectionTools === null
          || (isRecord(frame.connectionTools)
            && isString(frame.connectionTools.endpoint)
            && isString(frame.connectionTools.bearerToken)
            && Array.isArray(frame.connectionTools.tools)
            && frame.connectionTools.tools.every(isString)));
    }
    case "run.heartbeat":
    case "run.status":
      return isString(frame.id) && isString(frame.runId);
    case "run.steer":
      return isString(frame.id) && isString(frame.runId) && isString(frame.message)
        && (frame.kind === "steer" || frame.kind === "follow_up");
    case "run.cancel":
      return isString(frame.id) && isString(frame.runId)
        && (frame.reason === "operator" || frame.reason === "timeout" || frame.reason === "shutdown");
    case "probe":
      return isString(frame.id)
        && (frame.kind === "capabilities" || frame.kind === "models"
          || frame.kind === "sessions" || frame.kind === "fork");
    case "shutdown":
      return isString(frame.id);
    case "hello_ok":
      return isString(frame.hostVersion) && typeof frame.hostPid === "number"
        && isString(frame.epoch) && typeof frame.workers === "number";
    case "run.accepted":
      return isString(frame.id) && isString(frame.runId) && isRecord(frame.worker)
        && typeof (frame.worker as Record<string, unknown>).pid === "number"
        && typeof frame.reusedWorker === "boolean"
        && (frame.sessionOpening === "new" || frame.sessionOpening === "open")
        && isString(frame.ompSessionId) && isString(frame.runContextPath);
    case "run.event":
      return isString(frame.runId) && typeof frame.seq === "number" && isString(frame.at)
        && isString(frame.kind) && isRecord(frame.payload);
    case "run.settled":
      return isString(frame.runId) && isRecord(frame.result);
    case "run.status.result":
      return isString(frame.id) && isString(frame.runId) && isString(frame.state);
    case "run.steer.result":
      return isString(frame.id) && isString(frame.runId) && typeof frame.ok === "boolean";
    case "probe.result":
      return isString(frame.id) && isString(frame.kind) && isRecord(frame.payload);
    case "error":
      return isString(frame.code) && isString(frame.message);
    default:
      return false;
  }
}

/**
 * Parse one JSONL line into a frame, or null when it is not a well-formed frame
 * of this protocol. Unknown types and other versions are dropped rather than
 * coerced: a host that cannot understand a frame must not act on it.
 */
export function parseFrame(line: string): HostFrame | HostReply | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isString(value.type)) return null;
  if (!COMMAND_TYPES[value.type as HostFrame["type"]] && !REPLY_TYPES[value.type as HostReply["type"]]) {
    return null;
  }
  if (!isWellFormed(value)) return null;
  return value as unknown as HostFrame | HostReply;
}

/** True when the frame is one the adapter sends (the host validates incoming frames). */
export function isHostFrame(frame: HostFrame | HostReply): frame is HostFrame {
  return COMMAND_TYPES[frame.type as HostFrame["type"]] === true;
}
