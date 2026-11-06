import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  acquireSessionLease, pidAlive, SESSION_LEASE_TIMEOUT_GRACE_MS,
} from "../server/session-lease.js";
import { sessionIntelDir } from "../server/session-state.js";
import {
  LedgerWriteError, RunLedger, isTerminalState, type LedgerInput,
  type LedgerRecord, type LedgerUsage, type LedgerWorker,
} from "./ledger.js";
import {
  HOST_PROTOCOL_VERSION, encodeFrame, parseFrame, isHostFrame,
  type HostFrame, type HostReply, type HostRuntime, type LedgerCause, type RunBeginFrame,
  type RunEventKind, type RunSettledFrame, type SettledBy,
  type WorkerCapabilityObservations,
} from "./protocol.js";
import { clearRunContext, reapRunContexts, runContextPointer, writeRunContext } from "./run-context.js";
import {
  acquireHostLock, checkSocketSecurity, clearDiscovery, clearDiscoveryOwned, ensureHostDirIn,
  hostRootDir, isDiscoveryStale, newHostToken, readDiscovery, readProcessStartIdentity, socketPathIn,
  writeDiscovery, type HostDiscovery,
} from "./socket.js";
import { McpHttpClient } from "./mcp.js";
import {
  SUBAGENT_EVENT_FRAME_CAP,
  boundedEventText,
  buildSubagentSnapshot,
  readSubagentFrame,
  readSubagentSnapshot,
  rpcSubagentLevel,
  type RpcSubagentLevel,
  type SubagentObservation,
  type SubagentSummary,
} from "./subagents.js";
import { RpcWorker, type RpcFrame } from "./worker.js";

/**
 * The supervisor: one per Paperclip instance, lazily spawned by the adapter.
 *
 * It owns workers (spawn, reuse, capacity, reaping), owns the run ledger and the
 * run-context credentials, and turns `omp --mode rpc` frames into the settle
 * result the adapter returns. It never infers settlement from a timer: a run
 * ends on `prompt_result.sessionSettled` / `session_settled`, on a worker exit,
 * on an operator/adapter cancel, or on the run lease expiring — each with its
 * own ledger cause.
 *
 * Nothing here may be a background service: it exits after `hostIdleMs` with no
 * workers, and `close()` settles or journals every in-flight run before exit.
 */

export interface HostOptions {
  /** Defaults to the instance root's `omp-host`; tests pass a temp dir. */
  rootDir?: string;
  hostIdleMs?: number;
  workerIdleMs?: number;
  maxWorkers?: number;
  runLeaseTtlMs?: number;
  drainMs?: number;
  cancelGraceMs?: number;
  /**
   * Keep a worker warm between runs of the same `(company, agent, cwd,
   * sessionKey)` unit. On by default; `false` is the v0.12 phase-1 cold lane and
   * a test/rollback seam.
   */
  reuseWorkers?: boolean;
  version?: string;
}

export interface RunningHost {
  socketPath: string;
  discovery: HostDiscovery;
  /** Resolves when the host has closed (idle, shutdown frame, SIGTERM or close()). */
  closed: Promise<void>;
  close(reason?: string): Promise<void>;
  readonly workers: number;
  readonly runs: number;
}

const DEFAULT_HOST_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_WORKER_IDLE_MS = 20 * 60 * 1000;
const DEFAULT_MAX_WORKERS = 8;
const DEFAULT_RUN_LEASE_TTL_MS = 90_000;
const DEFAULT_DRAIN_MS = 30_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
/** Bytes of unterminated frame one connection may buffer before it is dropped. */
const MAX_IPC_LINE_CHARS = 16 * 1024 * 1024;

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hashText(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/** `omp --version` once per command; null when the probe is useless. */
function probeOmpVersion(command: string): Promise<string | null> {
  const result = Promise.withResolvers<string | null>();
  execFile(command, ["--version"], { encoding: "utf8", timeout: 1_500 }, (error, stdout) => {
    const text = typeof stdout === "string" ? stdout.trim() : "";
    const match = text.match(/\d+\.\d+\.\d+/);
    result.resolve(error === null && match !== null ? match[0] : null);
  });
  return result.promise;
}

interface Fingerprint {
  argvHash: string;
  bridgeHash: string;
  agentDir: string | null;
  /**
   * The named omp profile the worker resolved at spawn. A profile run carries
   * no PI_CODING_AGENT_DIR, so without this a shared -> profile flip would
   * reuse the old worker and keep reading the old store.
   */
  profile: string | null;
  cwd: string;
  ompVersion: string | null;
}

interface WorkerEntry {
  key: string;
  /** Stable, filesystem-safe identity for this worker's run-context directory. */
  workerId: string;
  runContextPointer: string;
  worker: RpcWorker;
  fingerprint: Fingerprint;
  sessionDir: string;
  sessionKey: string;
  startIdentity: string | null;
  /** The omp session this process currently has open, if any. */
  ompSessionId: string | null;
  sessionFile: string | null;
  /** The last settle snapshot this worker reported; the next run's baseline. */
  settledUsage: UsageBaseline | null;
  /**
   * This worker's answer for the managed frames, probed once after its first
   * session opened. Persisted on the entry so a warm worker is never re-probed
   * and every run on it reads the same evidence.
   */
  capabilities: WorkerCapabilityObservations;
  currentRun: string | null;
  lastUsedAt: number;
}

interface StatsSnapshot {
  /** The session these totals belong to; null when the worker omits it. */
  sessionId: string | null;
  input: number;
  output: number;
  cacheRead: number;
  /** Provider-billed cache-creation tokens; UsageSummary counts them as input. */
  cacheWrite: number;
  cost: number;
  routedModels: Record<string, number>;
  contextUsage: { used: number; size: number } | null;
}

/** The baseline for a session this run created: cumulative totals start at zero. */
const ZERO_STATS: StatsSnapshot = {
  sessionId: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  routedModels: {}, contextUsage: null,
};

/** The last settle snapshot a worker reported, and the session it belongs to. */
interface UsageBaseline {
  sessionId: string;
  snapshot: StatsSnapshot;
}

interface PromptOutcome {
  status: "completed" | "aborted" | "error";
  agentInvoked: boolean;
  sessionSettled: boolean;
  errorMessage: string | null;
}

interface RunState {
  runId: string;
  begin: RunBeginFrame;
  worker: WorkerEntry;
  reusedWorker: boolean;
  sessionOpening: "new" | "open";
  ompSessionId: string;
  sessionFile: string | null;
  seq: number;
  /** Every connection waiting on this run (a retried begin attaches, never duplicates). */
  connections: Set<Connection>;
  runContextPath: string;
  leaseOwner: string;
  leaseRelease: () => Promise<void>;
  leaseDeadline: number;
  leaseMisses: number;
  leaseTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
  outcome: PromptOutcome | null;
  /** Set when the caller is gone: the settle is journaled as lost, not settled. */
  abandoned: "adapter_gone" | null;
  terminal: boolean;
  startedAtMs: number;
  statsBefore: StatsSnapshot | null;
  /** This run created its session, so its cumulative totals start at zero. */
  freshSession: boolean;
  unsubscribe: Array<() => void>;
  lastAssistantText: string | null;
  /** Whether this run installed the connection tools on its worker. */
  hostToolsInstalled: boolean;
  /** The omp subagent subscription this run applied (always reset per run). */
  subagentLevel: RpcSubagentLevel;
  /** Whether any subagent frame arrived, so the settle knows to ask for a roster. */
  subagentSeen: boolean;
  subagentFrames: number;
  subagentCapWarned: boolean;
  /** Bounded per-subagent observations, keyed by omp's subagent id. */
  subagents: Map<string, SubagentObservation>;
}

interface Connection {
  socket: net.Socket;
  buffer: string;
  decoder: StringDecoder;
  runId: string | null;
  closed: boolean;
}

/** The canonical object guard for this file's IPC/JSON boundary reads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStats(data: Record<string, unknown>): StatsSnapshot | null {
  const tokens = data.tokens;
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) return null;
  const record = tokens as Record<string, unknown>;
  const input = typeof record.input === "number" ? record.input : 0;
  const output = typeof record.output === "number" ? record.output : 0;
  const cacheRead = typeof record.cacheRead === "number" ? record.cacheRead : 0;
  const cacheWrite = typeof record.cacheWrite === "number" ? record.cacheWrite : 0;
  const routed: Record<string, number> = {};
  if (typeof data.routedModels === "object" && data.routedModels !== null && !Array.isArray(data.routedModels)) {
    for (const [model, count] of Object.entries(data.routedModels as Record<string, unknown>)) {
      if (typeof count === "number") routed[model] = count;
    }
  }
  // omp's wire shape is `{ tokens, contextWindow, percent }` (RPC
  // rpc-wire.generated.ts:413-417); accept the `{used,size}` spelling too so a
  // future rename does not silently drop the signal.
  const usage = data.contextUsage;
  let contextUsage: StatsSnapshot["contextUsage"] = null;
  if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) {
    const record = usage as Record<string, unknown>;
    const used = typeof record.tokens === "number" ? record.tokens : record.used;
    const size = typeof record.contextWindow === "number" ? record.contextWindow : record.size;
    if (typeof used === "number" && typeof size === "number") contextUsage = { used, size };
  }
  return {
    sessionId: typeof data.sessionId === "string" && data.sessionId !== "" ? data.sessionId : null,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: typeof data.cost === "number" ? data.cost : 0,
    routedModels: routed,
    contextUsage,
  };
}

function delta(base: StatsSnapshot, top: StatsSnapshot): StatsSnapshot {
  // Model turn counts are cumulative too: subtracting the baseline is what makes
  // a warm session's second run report its own model rather than the sum.
  const routedModels: Record<string, number> = {};
  for (const [model, count] of Object.entries(top.routedModels)) {
    const own = count - (base.routedModels[model] ?? 0);
    if (own > 0) routedModels[model] = own;
  }
  return {
    sessionId: top.sessionId,
    input: Math.max(0, top.input - base.input),
    output: Math.max(0, top.output - base.output),
    cacheRead: Math.max(0, top.cacheRead - base.cacheRead),
    cacheWrite: Math.max(0, top.cacheWrite - base.cacheWrite),
    cost: Math.max(0, top.cost - base.cost),
    routedModels,
    contextUsage: top.contextUsage,
  };
}

/** The last assistant text a `message_end` frame carried, if any. */
function assistantText(frame: RpcFrame): string | null {
  const message = frame.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  // A user message's content is text too; only an assistant message is turn
  // content (a prompt echoed as assistant text would leak the operator's text).
  if (record.role !== undefined && record.role !== "assistant") return null;
  const content = record.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => (typeof block === "object" && block !== null && !Array.isArray(block)
      ? (block as Record<string, unknown>).text
      : null))
    .filter((value): value is string => typeof value === "string")
    .join("");
  return text.trim() === "" ? null : text;
}

/** The provider error text a `prompt_result.error` carries, when it carries one. */
function promptErrorMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!("message" in value) || typeof value.message !== "string") return null;
  return value.message;
}

class Supervisor {
  private readonly options: Required<Pick<HostOptions, "hostIdleMs" | "workerIdleMs" | "maxWorkers"
    | "runLeaseTtlMs" | "drainMs" | "cancelGraceMs" | "reuseWorkers" | "version">> & { rootDir: string };
  private readonly runs = new Map<string, RunState>();
  private readonly workers = new Map<string, WorkerEntry>();
  private readonly connections = new Set<Connection>();
  private readonly versionCache = new Map<string, string | null>();
  /** Runs whose begin is still in setup; EOF here must not leave a ghost run. */
  private readonly pendingRuns = new Map<string, Connection>();
  private readonly abandonedBeforePrompt = new Set<string>();
  /** A cancel that arrived while the run was still in setup. */
  private readonly pendingCancels = new Map<string, "operator" | "timeout" | "shutdown">();
  /** Every omp session this supervisor has run: the fork cwd precondition source. */
  private readonly sessionIndex = new Map<string, { cwd: string; sessionFile: string | null }>();
  /** Worker slots claimed but not yet spawned, so interleaved begins respect maxWorkers. */
  private reservedWorkers = 0;
  private ledger: RunLedger | null = null;
  private server: net.Server | null = null;
  private lock: { release: () => Promise<void> } | null = null;
  private socketPath = "";
  private epoch = "";
  private closedAt: number | null = null;
  private lastActivity = Date.now();
  private sweepTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private readonly closed = Promise.withResolvers<void>();
  private discovery: HostDiscovery | null = null;
  private closeReason = "";

  constructor(options: HostOptions) {
    this.options = {
      rootDir: options.rootDir ?? hostRootDir(),
      hostIdleMs: options.hostIdleMs ?? positiveEnv("OMP_HOST_IDLE_MS", DEFAULT_HOST_IDLE_MS),
      workerIdleMs: options.workerIdleMs ?? positiveEnv("OMP_HOST_WORKER_IDLE_MS", DEFAULT_WORKER_IDLE_MS),
      maxWorkers: options.maxWorkers ?? positiveEnv("OMP_HOST_MAX_WORKERS", DEFAULT_MAX_WORKERS),
      runLeaseTtlMs: options.runLeaseTtlMs ?? positiveEnv("OMP_HOST_RUN_LEASE_TTL_MS", DEFAULT_RUN_LEASE_TTL_MS),
      drainMs: options.drainMs ?? positiveEnv("OMP_HOST_DRAIN_MS", DEFAULT_DRAIN_MS),
      cancelGraceMs: options.cancelGraceMs ?? positiveEnv("OMP_HOST_CANCEL_GRACE_MS", DEFAULT_CANCEL_GRACE_MS),
      reuseWorkers: options.reuseWorkers ?? true,
      version: options.version ?? "0.12.0",
    };
  }

  get root(): string {
    return this.options.rootDir;
  }

  async start(): Promise<RunningHost> {
    await ensureHostDirIn(this.root);
    await this.takeOver();
    this.lock = await acquireHostLock(this.root);
    this.ledger = await RunLedger.open(this.root);
    this.epoch = `host-${randomBytes(3).toString("hex")}`;
    await reconcileWith(this.root, this.ledger);
    this.rebuildSessionIndex();
    await this.listen();
    this.sweepTimer = setInterval(() => this.sweep(), sweepInterval(this.options));
    this.sweepTimer.unref();
    const supervisor = this;
    return {
      socketPath: this.socketPath,
      discovery: this.discovery as HostDiscovery,
      closed: this.closed.promise,
      close: (reason = "requested") => this.close(reason),
      get workers() { return supervisor.workers.size; },
      get runs() { return supervisor.runs.size; },
    };
  }

  /** Refuse to start over a live supervisor; remove a stale record and socket. */
  private async takeOver(): Promise<void> {
    const existing = await readDiscovery(this.root);
    if (existing === null) return;
    const identity = await readProcessStartIdentity(existing.pid);
    if (!isDiscoveryStale(existing, identity)) {
      throw new Error(`another omp-host is already serving this instance (pid ${existing.pid})`);
    }
    await unlink(existing.socket).catch(() => {});
    await clearDiscovery(this.root);
  }

  private async listen(): Promise<void> {
    const token = newHostToken();
    this.socketPath = socketPathIn(this.root, token);
    if (Buffer.byteLength(this.socketPath) > 100) {
      throw new Error(`the omp-host socket path is too long for a Unix socket: ${this.socketPath}`);
    }
    const server = net.createServer((socket) => this.accept(socket));
    const listening = Promise.withResolvers<void>();
    server.once("error", (err) => listening.reject(err));
    server.listen(this.socketPath, () => listening.resolve());
    await listening.promise;
    this.server = server;
    await chmod(this.socketPath, 0o600).catch(() => {});
    // Prove the invariant before advertising the socket: a chmod that did not
    // take (or a directory that was widened) must stop the host, never publish
    // a token a second user could reach.
    try {
      await checkSocketSecurity(this.socketPath, this.root);
    } catch (err) {
      const done = Promise.withResolvers<void>();
      server.close(() => done.resolve());
      await done.promise;
      await unlink(this.socketPath).catch(() => {});
      throw err;
    }
    this.discovery = {
      v: 1,
      socket: this.socketPath,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      startIdentity: await readProcessStartIdentity(process.pid),
      epoch: this.epoch,
      version: this.options.version,
    };
    await writeDiscovery(this.discovery, this.root);
  }

  private accept(socket: net.Socket): void {
    const connection: Connection = {
      socket,
      buffer: "",
      decoder: new StringDecoder("utf8"),
      runId: null,
      closed: false,
    };
    this.connections.add(connection);
    this.touch();
    socket.on("data", (chunk: Buffer) => {
      connection.buffer += connection.decoder.write(chunk);
      // A frame that never ends must not grow the shared supervisor without
      // bound: prompts are large but finite, and 16 MiB is far above one.
      if (connection.buffer.length > MAX_IPC_LINE_CHARS) {
        this.send(connection, { type: "error", code: "frame_too_large", message: "the frame exceeded the supervisor's line limit" });
        socket.destroy();
        return;
      }
      let newline = connection.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = connection.buffer.slice(0, newline);
        connection.buffer = connection.buffer.slice(newline + 1);
        if (line.trim() !== "") this.readFrame(connection, line);
        newline = connection.buffer.indexOf("\n");
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      connection.closed = true;
      this.connections.delete(connection);
      this.touch();
      const runId = connection.runId;
      if (runId !== null) {
        const run = this.runs.get(runId);
        if (run === undefined) {
          // Still in setup: remember it so beginRun stops before prompting
          // instead of running a turn nobody is waiting for.
          if (this.pendingRuns.get(runId) === connection) this.abandonedBeforePrompt.add(runId);
          return;
        }
        if (run.terminal) return;
        run.connections.delete(connection);
        if (run.connections.size === 0) void this.adapterGone(run);
      }
    });
  }

  private readFrame(connection: Connection, line: string): void {
    const frame = parseFrame(line);
    if (frame === null || !isHostFrame(frame)) {
      this.send(connection, { type: "error", code: "bad_frame", message: "the supervisor did not understand that frame" });
      return;
    }
    this.touch();
    void this.dispatch(connection, frame).catch((err: unknown) => {
      this.send(connection, {
        type: "error",
        ...("id" in frame && typeof frame.id === "string" ? { id: frame.id } : {}),
        code: "host_error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async dispatch(connection: Connection, frame: HostFrame): Promise<void> {
    switch (frame.type) {
      case "hello":
        this.send(connection, {
          type: "hello_ok",
          hostVersion: this.options.version,
          hostPid: process.pid,
          epoch: this.epoch,
          workers: this.workers.size,
        });
        return;
      case "run.begin":
        await this.beginRun(connection, frame);
        return;
      case "run.heartbeat": {
        const run = this.runs.get(frame.runId);
        if (run !== undefined) {
          run.leaseMisses = 0;
          run.leaseDeadline = Date.now() + run.begin.limits.runLeaseTtlMs;
        }
        return;
      }
      case "run.cancel": {
        const run = this.runs.get(frame.runId);
        if (run !== undefined) {
          if (!run.terminal) void this.cancelRun(run, frame.reason);
          return;
        }
        // A cancel can beat its own begin's setup (open_session is slow). Hold it
        // so the run is aborted as soon as it starts, instead of being ignored.
        if (this.pendingRuns.has(frame.runId)) this.pendingCancels.set(frame.runId, frame.reason);
        return;
      }
      case "run.status":
        this.send(connection, await this.statusOf(frame.id, frame.runId));
        return;
      case "run.steer": {
        const run = this.runs.get(frame.runId);
        if (run === undefined || run.terminal) {
          this.send(connection, {
            type: "run.steer.result", id: frame.id, runId: frame.runId,
            ok: false, error: "no live run with that id",
          });
          return;
        }
        if (run.begin.steering !== true) {
          this.send(connection, {
            type: "run.steer.result", id: frame.id, runId: frame.runId,
            ok: false, error: "steering is disabled for this run (set steering: 'on' on the agent)",
          });
          return;
        }
        // A message queued as the turn ends would be drained as an autonomous
        // turn omp starts on its own: nothing here would track it, host tools are
        // already cleared, and the next run would find a busy worker.
        if (run.outcome !== null) {
          this.send(connection, {
            type: "run.steer.result", id: frame.id, runId: frame.runId,
            ok: false, error: "the run's turn has already ended; nothing to steer",
          });
          return;
        }
        try {
          if (frame.kind === "follow_up") await run.worker.worker.followUp(frame.message);
          else await run.worker.worker.steer(frame.message);
          if (run.terminal || run.outcome !== null) {
            void run.worker.worker.abort().catch(() => {});
          }
          this.emitEvent(run, "run.system", {
            level: "info",
            message: `steering delivered to the running turn (${frame.kind})`,
          });
          this.send(connection, {
            type: "run.steer.result", id: frame.id, runId: frame.runId, ok: true,
          });
        } catch (err) {
          this.send(connection, {
            type: "run.steer.result", id: frame.id, runId: frame.runId,
            ok: false, error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "probe":
        this.send(connection, this.probe(frame));
        return;
      case "shutdown":
        await this.close(frame.reason ?? "operator");
        return;
    }
  }

  private send(connection: Connection, frame: HostReply): void {
    if (connection.closed) return;
    connection.socket.write(encodeFrame(frame));
  }

  private emitEvent(run: RunState, kind: RunEventKind, payload: Record<string, unknown>): void {
    run.seq += 1;
    const frame: HostReply = {
      type: "run.event",
      runId: run.runId,
      seq: run.seq,
      at: new Date().toISOString(),
      kind,
      payload,
    };
    for (const connection of run.connections) this.send(connection, frame);
  }

  private sendSettled(connection: Connection, runId: string, result: AdapterExecutionResult): void {
    const frame: RunSettledFrame = { type: "run.settled", runId, result };
    this.send(connection, frame);
  }

  private broadcastSettled(run: RunState, result: AdapterExecutionResult): void {
    for (const connection of run.connections) this.sendSettled(connection, run.runId, result);
  }

  private rebuildSessionIndex(): void {
    const ledger = this.ledger;
    if (ledger === null) return;
    for (const record of ledger.snapshot().values()) {
      if (record.ompSessionId === undefined || record.ompSessionId === "") continue;
      this.sessionIndex.set(record.ompSessionId, {
        cwd: record.cwd,
        sessionFile: record.sessionFile ?? null,
      });
    }
  }

  private probe(frame: Extract<HostFrame, { type: "probe" }>): HostReply {
    if (frame.kind === "sessions") {
      // The fork precondition: the cwd the source session recorded. Only
      // sessions THIS supervisor ran are indexed; anything else is the
      // adapter's ACP-probe fallback.
      const payload = frame.payload ?? {};
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const found = this.sessionIndex.get(sessionId);
      return {
        type: "probe.result",
        id: frame.id,
        kind: frame.kind,
        payload: found === undefined
          ? { ok: false, error: "the supervisor has not run that session" }
          : { ok: true, cwd: found.cwd, sessionFile: found.sessionFile },
      };
    }
    if (frame.kind !== "capabilities") {
      return {
        type: "probe.result",
        id: frame.id,
        kind: frame.kind,
        payload: { ok: false, error: `the supervisor does not serve '${frame.kind}' probes; use the ACP probe lane` },
      };
    }
    return {
      type: "probe.result",
      id: frame.id,
      kind: frame.kind,
      payload: {
        ok: true,
        protocol: HOST_PROTOCOL_VERSION,
        hostVersion: this.options.version,
        epoch: this.epoch,
        workers: this.workers.size,
        runs: this.runs.size,
        uptimeMs: this.closedAt === null ? Date.now() - Date.parse(this.discovery?.startedAt ?? new Date().toISOString()) : 0,
      },
    };
  }

  private async statusOf(id: string, runId: string): Promise<HostReply> {
    const run = this.runs.get(runId);
    if (run !== undefined) {
      return { type: "run.status.result", id, runId, state: "prompting" };
    }
    const ledger = this.ledger;
    if (ledger !== null) {
      const record = ledger.snapshot().get(runId);
      if (record !== undefined) return { type: "run.status.result", id, runId, state: record.state };
    }
    return { type: "run.status.result", id, runId, state: "lost" };
  }

  /* ------------------------------------------------------------------ */
  /*  Run lifecycle                                                      */
  /* ------------------------------------------------------------------ */

  private async beginRun(connection: Connection, begin: RunBeginFrame): Promise<void> {
    const ledger = this.ledger as RunLedger;
    const refuse = async (cause: LedgerCause, errorCode: string, errorMessage: string): Promise<void> => {
      await this.journal({
        epoch: this.epoch,
        runId: begin.runId,
        companyId: begin.agent.companyId,
        agentId: begin.agent.id,
        sessionKey: begin.sessionKey,
        cwd: begin.cwd,
        state: "refused",
        cause,
      }).catch(() => {});
      this.sendSettled(connection, begin.runId, {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode,
        errorMessage,
      });
    };

    if (connection.runId !== null && connection.runId !== begin.runId) {
      this.sendSettled(connection, begin.runId, {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "omp_host_connection_busy",
        errorMessage: `this connection already carries run ${connection.runId}; one connection carries one run`,
      });
      return;
    }
    const known = this.runs.get(begin.runId);
    if (known !== undefined) {
      // A retried begin after a transport hiccup joins the live run instead of
      // starting a second prompt; it will receive the same terminal frame.
      known.connections.add(connection);
      connection.runId = known.runId;
      this.sendAccepted(connection, known);
      return;
    }
    const prior = ledger.snapshot().get(begin.runId);
    if (prior !== undefined && isTerminalState(prior.state)) {
      this.sendSettled(connection, begin.runId, {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "omp_host_run_ended",
        errorMessage: `run ${begin.runId} already ended (ledger state '${prior.state}') in this supervisor's epoch; it is not replayed`,
      });
      return;
    }
    if (this.shuttingDown) {
      await refuse("config_error", "omp_host_shutting_down", "the omp supervisor is draining and does not accept new runs");
      return;
    }
    this.pendingRuns.set(begin.runId, connection);
    connection.runId = begin.runId;
    const mismatch = this.sessionKeyMismatch(begin);
    if (mismatch !== null) {
      await refuse("config_error", "omp_config_error", mismatch);
      return;
    }

    const lease = await acquireSessionLease({
      dir: sessionIntelDir(begin.agent.companyId, begin.agent.id),
      key: begin.sessionKey,
      pid: process.pid,
      ...(begin.limits.timeoutMs !== null ? { ttlMs: begin.limits.timeoutMs + SESSION_LEASE_TIMEOUT_GRACE_MS } : {}),
    });
    if (!lease.ok) {
      await refuse("lease_held", "omp_session_lease_held", lease.error);
      return;
    }
    try {
      await this.journal({
        epoch: this.epoch,
        runId: begin.runId,
        companyId: begin.agent.companyId,
        agentId: begin.agent.id,
        sessionKey: begin.sessionKey,
        cwd: begin.cwd,
        state: "leased",
        lease: {
          owner: lease.owner,
          expiresAt: new Date(
            Date.now() + (begin.limits.timeoutMs ?? 0) + SESSION_LEASE_TIMEOUT_GRACE_MS,
          ).toISOString(),
        },
      });
    } catch (err) {
      await lease.release();
      this.sendSettled(connection, begin.runId, {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "omp_host_unwritable",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let worker: WorkerEntry;
    let reused = false;
    try {
      const ensured = await this.ensureWorker(begin);
      worker = ensured.worker;
      reused = ensured.reused;
    } catch (err) {
      await lease.release();
      const message = err instanceof Error ? err.message : String(err);
      const capacity = message.includes("omp_host_capacity");
      await refuse(
        capacity ? "capacity" : "config_error",
        capacity ? "omp_host_capacity" : "omp_host_worker_failed",
        message,
      );
      return;
    }

    // Claim the worker before the setup awaits: the idle sweep must never
    // retire a process a run is opening a session on.
    worker.currentRun = begin.runId;
    const run: RunState = {
      runId: begin.runId,
      begin,
      worker,
      reusedWorker: reused,
      sessionOpening: begin.session.ompSessionId ? "open" : "new",
      ompSessionId: begin.session.ompSessionId ?? "",
      sessionFile: null,
      seq: 0,
      connections: new Set([connection]),
      runContextPath: "",
      leaseOwner: lease.owner,
      leaseRelease: lease.release,
      leaseDeadline: Date.now() + begin.limits.runLeaseTtlMs,
      leaseMisses: 0,

      outcome: null,
      abandoned: null,
      terminal: false,
      startedAtMs: Date.now(),
      statsBefore: null,
      freshSession: false,
      unsubscribe: [],
      lastAssistantText: null,
      hostToolsInstalled: false,
      subagentLevel: "off",
      subagentSeen: false,
      subagentFrames: 0,
      subagentCapWarned: false,
      subagents: new Map(),
    };

    let promptAccepted = false;
    let disconnected = false;
    try {
      await this.journal(this.runRecord(run, "worker_ready", {
        worker: this.ledgerWorker(worker),
      }));

      const sessionDir = worker.sessionDir;
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      let sessionId = run.ompSessionId;
      let freshSession = false;
      const alreadyOpen = sessionId !== "" && worker.ompSessionId === sessionId;
      if (alreadyOpen) {
        run.sessionFile = worker.sessionFile;
      } else if (sessionId !== "") {
        const named = sessionId;
        let opened: Awaited<ReturnType<RpcWorker["openSession"]>> | null = null;
        try {
          opened = await worker.worker.openSession(sessionDir);
        } catch (err) {
          // An error response (not a `cancelled` one) is still a failed resume:
          // omp answers `success:false` when the stored session cannot be
          // switched (e.g. a cwd change). Fall back to a fresh session instead
          // of failing a run over a stale session.
          this.emitEvent(run, "run.system", {
            level: "warn",
            message: `omp could not open the stored session ${named} (${err instanceof Error ? err.message : String(err)}); starting a fresh session`,
          });
        }
        if (opened === null || opened.cancelled) {
          const fresh = await worker.worker.newSession();
          if (fresh.cancelled) throw new Error("omp refused to open or create a session for this run");
          freshSession = true;
          sessionId = "";
        } else {
          sessionId = opened.sessionId;
          run.sessionFile = opened.sessionFile ?? null;
          // A named session that could not be resumed (fresh directory, moved
          // workspace) is adopted as a new one, but never silently: the operator
          // is looking for that transcript, and the adapter records the new id.
          if (opened.resumed === false) {
            freshSession = true;
            this.emitEvent(run, "run.system", {
              level: "warn",
              message: `stored omp session ${named} could not be resumed in this session directory; this run started ${sessionId || "a new session"}`,
            });
          }
          // The worker resumes by session DIRECTORY (omp picks the newest
          // session there), so a stored id and the opened id may legitimately
          // differ (rotation, adoption) — the opened id is then the truth and is
          // reported back. A FORK is the exception: its transcript lives in
          // omp's agent-dir storage, so the directory never opens it, and
          // continuing the source would consume the operator's fork silently.
          if (begin.session.forked === true && sessionId !== named) {
            throw new Error(
              `omp opened session ${sessionId} but the forked run named ${named}; refusing to continue another session under a fork directive`,
            );
          }
        }
      } else {
        const fresh = await worker.worker.newSession();
        if (fresh.cancelled) throw new Error("omp refused to create a session for this run");
        freshSession = true;
      }
      if (sessionId === "") {
        const state = await worker.worker.getState();
        sessionId = typeof state.sessionId === "string" ? state.sessionId : "";
        if (typeof state.sessionFile === "string") run.sessionFile = state.sessionFile;
      }
      // A fork copies another session's transcript, so its counters are not
      // this run's even when omp opens it fresh.
      run.freshSession = freshSession && begin.session.forked !== true;
      run.ompSessionId = sessionId;
      worker.ompSessionId = sessionId === "" ? null : sessionId;
      worker.sessionFile = run.sessionFile;
      await this.journal(this.runRecord(run, "session_open", {
        worker: this.ledgerWorker(worker),
        ompSessionId: sessionId,
        ...(run.sessionFile !== null ? { sessionFile: run.sessionFile } : {}),
      }));

      // The run's own calls ARE the probe: they happen after the session is
      // open, on the worker this run will use, and their answers are cached on
      // the worker entry (one observation per worker epoch, never a second
      // spawn or duplicate frame).
      const statsData = await this.workerFrame(worker, "get_session_stats", { type: "get_session_stats" });
      run.statsBefore = readStats(statsData ?? {});

      // Subscribe before the prompt so the run sees subagents it starts. omp
      // filters at the subscription; `off` still has to be sent to clear a level
      // a previous run left on a warm worker.
      const wantedLevel = rpcSubagentLevel(begin.subagentObservability ?? "summary");
      const subscription = await this.workerFrame(worker, "set_subagent_subscription", {
        type: "set_subagent_subscription", level: wantedLevel,
      });
      if (subscription === null) {
        this.emitEvent(run, "run.system", {
          level: "warn",
          message: "omp subagent observability is unavailable this run (the worker did not accept the subscription); continuing without it",
        });
      } else {
        const applied = subscription.level;
        run.subagentLevel = applied === "off" || applied === "progress" || applied === "events"
          ? applied
          : wantedLevel;
      }

      if (begin.connectionTools !== undefined && begin.connectionTools !== null) {
        await this.installHostTools(run, begin.connectionTools);
      }

      // The setup awaits are where a caller can vanish (open_session is slow).
      // Never prompt for a caller that is already gone.
      if (this.abandonedBeforePrompt.delete(run.runId)) {
        disconnected = true;
        throw new Error("the adapter disconnected before the run started");
      }
      run.runContextPath = await writeRunContext(
        this.root, worker.workerId, run.runId, begin.credentials, begin.manifests,
      );
      this.attach(run);
      await this.journal(this.runRecord(run, "prompting", {
        // The worker block rides every in-flight record: it is what the next
        // host reconciles a crashed run against (pid + start identity).
        worker: this.ledgerWorker(worker),
        lease: { owner: run.leaseOwner, expiresAt: new Date(run.leaseDeadline).toISOString() },
      }));
      this.runs.set(run.runId, run);
      connection.runId = run.runId;
      this.startLeaseWatch(run);
      this.sendAccepted(connection, run);
      await worker.worker.prompt(begin.prompt, begin.runId);
      promptAccepted = true;
      const earlyCancel = this.pendingCancels.get(run.runId);
      if (earlyCancel !== undefined) {
        this.pendingCancels.delete(run.runId);
        void this.cancelRun(run, earlyCancel);
      }
      if (begin.limits.timeoutMs !== null) {
        run.timeoutTimer = setTimeout(() => {
          void this.timeoutRun(run);
        }, begin.limits.timeoutMs);
        run.timeoutTimer.unref();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const unwritable = err instanceof LedgerWriteError;
      const deadBeforeTurn = !promptAccepted && !worker.worker.alive;
      await this.settle(run, {
        kind: "lost",
        settledBy: "begin_error",
        cause: disconnected ? "adapter_gone" : (worker.worker.alive || deadBeforeTurn ? "config_error" : "worker_exit"),
        errorCode: unwritable
          ? "omp_host_unwritable"
          : deadBeforeTurn
            ? "omp_host_worker_failed"
            : "omp_host_run_failed",
        errorMessage: message,
        // Only a turn that actually started can offer Paperclip's interrupted-
        // run recovery; a worker that never accepted a prompt did no work.
        executionRecovery: promptAccepted && !worker.worker.alive
          ? { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" }
          : undefined,
      });
    } finally {
      if (this.pendingRuns.get(begin.runId) === connection) this.pendingRuns.delete(begin.runId);
      this.abandonedBeforePrompt.delete(begin.runId);
      this.pendingCancels.delete(begin.runId);
      if (connection.runId === begin.runId && !this.runs.has(begin.runId)) connection.runId = null;
    }
  }

  /**
   * Record what this worker answered for one managed frame. A resolved
   * response proves the command exists; a rejection carrying `Unknown command`
   * proves it does not; any other failure (a timeout, a dead worker) proves
   * nothing and leaves the row `unknown`. Returns the response data, or null
   * when the worker did not serve the frame.
   */
  private async workerFrame(
    worker: WorkerEntry,
    frame: keyof WorkerCapabilityObservations,
    command: RpcFrame,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await worker.worker.request(command);
      worker.capabilities[frame] = "yes";
      return (response.data ?? {}) as Record<string, unknown>;
    } catch (err) {
      // `request` rejects a failed response, so the refusal arrives here: the
      // explicit `Unknown command` is an absence; any other failure (a timeout,
      // a dead worker) proves nothing and stays unknown.
      const message = err instanceof Error ? err.message : String(err);
      if (/Unknown command/i.test(message)) worker.capabilities[frame] = "no";
      return null;
    }
  }

  /**
   * A successful use is better evidence than an earlier refusal: if the worker
   * first said `Unknown command` and then serves the frame, the next run's
   * accepted frame carries `yes` and the adapter withdraws its warning for
   * this worker.
   */
  private recordWorkerCapability(worker: WorkerEntry, frame: keyof WorkerCapabilityObservations): void {
    worker.capabilities[frame] = "yes";
  }

  /** A refusal names the frame; only `Unknown command` proves it is missing. */
  private recordWorkerRefusal(worker: WorkerEntry, frame: keyof WorkerCapabilityObservations, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    worker.capabilities[frame] = /Unknown command/i.test(message) ? "no" : "unknown";
  }

  private sendAccepted(connection: Connection, run: RunState): void {
    this.send(connection, {
      type: "run.accepted",
      id: run.begin.id,
      runId: run.runId,
      worker: {
        pid: run.worker.worker.pid,
        pgid: run.worker.worker.pgid,
        startedAt: run.worker.worker.startedAt,
      },
      reusedWorker: run.reusedWorker,
      sessionOpening: run.sessionOpening,
      ompSessionId: run.ompSessionId,
      runContextPath: run.runContextPath,
      workerCapabilities: run.worker.capabilities,
    });
  }

  private attach(run: RunState): void {
    const worker = run.worker.worker;
    run.unsubscribe.push(worker.onFrame((frame) => this.onWorkerFrame(run, frame)));
    run.unsubscribe.push(worker.onStderr((chunk) => {
      this.emitEvent(run, "omp.log", { stream: "stderr", chunk });
    }));
    void worker.exited.then((exit) => {
      if (run.terminal) return;
      void this.settle(run, {
        kind: "lost",
        settledBy: "worker_exit",
        cause: run.abandoned ?? "worker_exit",
        errorCode: "omp_host_worker_exit",
        errorMessage: `omp worker exited (${exit.signal ?? exit.code}) mid-run`,
        executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
      });
    });
  }

  private onWorkerFrame(run: RunState, frame: RpcFrame): void {
    if (run.terminal) return;
    switch (frame.type) {
      case "prompt_result": {
        if (typeof frame.id === "string" && frame.id !== run.runId) return;
        run.outcome = {
          status: frame.status === "completed" || frame.status === "aborted" || frame.status === "error"
            ? frame.status
            : "error",
          agentInvoked: frame.agentInvoked === true,
          sessionSettled: frame.sessionSettled === true,
          errorMessage: promptErrorMessage(frame.error),
        };
        if (run.outcome.sessionSettled) void this.finishFromOutcome(run);
        return;
      }
      case "session_settled":
        if (run.outcome !== null) void this.finishFromOutcome(run);
        return;
      // The RPC lane's tool events are `tool_execution_start`/`_end`
      // (rpc-wire.generated.ts:3790-3870); `tool_call`/`tool_result` are the
      // retired engine's frame names and never arrive on this wire. The card
      // gets the tool identity plus a bounded, credential-redacted argument
      // summary; the result never crosses.
      case "tool_execution_start":
      case "tool_execution_end": {
        const argsSummary = frame.type === "tool_execution_start" && frame.args !== undefined
          ? boundedEventText(JSON.stringify(frame.args))
          : null;
        this.emitEvent(run, "omp.tool_call", {
          phase: frame.type === "tool_execution_start" ? "tool_call" : "tool_result",
          toolName: typeof frame.toolName === "string" ? frame.toolName : null,
          toolCallId: typeof frame.toolCallId === "string" ? frame.toolCallId : null,
          ...(argsSummary !== null ? { argsSummary } : {}),
        });
        return;
      }
      case "message_end": {
        const text = assistantText(frame);
        if (text === null) return;
        run.lastAssistantText = text;
        this.emitEvent(run, "omp.turn", {
          ...(typeof frame.messageId === "string" ? { messageId: frame.messageId } : {}),
          text,
        });
        return;
      }
      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
        // Lifecycle only: there is no content to show, and relaying it put raw
        // control frames on the board. The settle facts carry this.
        return;
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event":
        this.onSubagentFrame(run, frame);
        return;
      default:
        // Token deltas and UI frames never reach the board: the board only ever
        // saw turn-level activity, and a per-token event is not one.
        return;
    }
  }

  /**
   * Turn one of omp's subagent frames into a bounded `omp.subagent` event.
   *
   * The observation map is updated before the frame cap is checked, so the
   * settlement snapshot still counts every subagent the run saw; only the live
   * event stream is capped. omp emits nothing at level `off`, and its event
   * frames only at `events`; both are re-checked defensively because a warm
   * worker's level changes between runs.
   */
  private onSubagentFrame(run: RunState, frame: RpcFrame): void {
    if (run.subagentLevel === "off") return;
    if (frame.type === "subagent_event" && run.subagentLevel !== "events") return;
    const read = readSubagentFrame(frame);
    if (read === null) return;
    const existing = run.subagents.get(read.id);
    // An event frame for an id this run never saw start is a straggler from an
    // earlier run: it carries no index or agent here, so it is not this run's
    // evidence and must not become a phantom observation.
    if (existing === undefined && frame.type === "subagent_event") return;
    run.subagentSeen = true;
    // A terminal status stays terminal: omp removes finished subagents from its
    // roster, and a late progress frame must not count one as running again.
    const status = read.status === null
      ? existing?.status ?? "running"
      : existing !== undefined && existing.status !== "running" && read.status === "running"
        ? existing.status
        : read.status;
    const observation: SubagentObservation = {
      id: read.id,
      index: read.index ?? existing?.index ?? run.subagents.size,
      agent: read.agent ?? existing?.agent ?? "subagent",
      status,
      description: read.description ?? existing?.description ?? null,
      parentToolCallId: read.parentToolCallId ?? existing?.parentToolCallId ?? null,
      lastUpdate: Date.now(),
    };
    run.subagents.set(read.id, observation);
    if (run.subagentFrames >= SUBAGENT_EVENT_FRAME_CAP) {
      if (!run.subagentCapWarned) {
        run.subagentCapWarned = true;
        this.emitEvent(run, "run.system", {
          level: "warn",
          message: `subagent event cap (${SUBAGENT_EVENT_FRAME_CAP}) reached for this run; further subagent frames are dropped, and the settlement snapshot still counts every subagent`,
        });
      }
      return;
    }
    run.subagentFrames += 1;
    const payload: Record<string, unknown> = {
      id: observation.id,
      index: observation.index,
      agent: observation.agent,
      status: observation.status,
      ...(observation.description !== null ? { description: observation.description } : {}),
      ...(observation.parentToolCallId !== null ? { parentToolCallId: observation.parentToolCallId } : {}),
      lastUpdate: observation.lastUpdate,
    };
    if (run.subagentLevel === "events" && read.event !== null) {
      payload.event = read.event;
      if (read.summary !== null) payload.summary = read.summary;
    }
    this.emitEvent(run, "omp.subagent", payload);
  }

  /**
   * The run's compact subagent evidence at settle: the lifecycle this run
   * observed, merged with the roster omp still reports running. Null when the
   * run saw nothing, so runs without subagents keep their resultJson unchanged.
   */
  private async subagentSummary(run: RunState): Promise<SubagentSummary | null> {
    // Evidence is what this run observed. omp's roster keeps detached
    // stragglers from earlier runs (it is per worker/session, not per run), so
    // an unobserved roster entry would be another run's subagent misattributed.
    if (!run.subagentSeen) return null;
    const roster = await run.worker.worker.getSubagents(5_000).catch(() => []);
    const running = roster
      .map((entry) => readSubagentSnapshot(entry))
      .filter((entry): entry is SubagentObservation => entry !== null);
    return buildSubagentSnapshot(run.subagents.values(), running);
  }

  /**
   * Install the run's Paperclip connection tools as omp host tools.
   *
   * The bearer stays here: the worker gets tool DEFINITIONS, and each call
   * comes back as a `host_tool_call` frame this process answers against the MCP
   * endpoint. A warm worker is rebound on every run (set_host_tools replaces
   * the handler set), so the token rotates without a respawn.
   *
   * Failure is a warning, not a failed run: a run without connection tools is
   * ordinary.
   */
  private async installHostTools(
    run: RunState,
    access: { endpoint: string; bearerToken: string; expiresAt: string | null; tools: string[] },
  ): Promise<void> {
    // A connection search can legitimately outlive a prompt token tick; 10 s
    // (the client default) would turn a slow upstream into a tool error.
    const client = new McpHttpClient({ endpoint: access.endpoint, bearer: access.bearerToken, timeoutMs: 30_000 });
    try {
      await client.initialize();
      const available = await client.listTools();
      const wanted = new Set(access.tools);
      const selected = available.filter((tool) => wanted.size === 0 || wanted.has(tool.name));
      if (selected.length === 0) {
        this.emitEvent(run, "run.system", {
          level: "warn",
          message: "omp connection tools are unavailable this run: the MCP endpoint listed no tool the run was granted",
        });
        return;
      }
      const names = await run.worker.worker.setHostTools(selected.map((tool) => ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        loadMode: "essential",
      }))).then(
        (installed) => {
          this.recordWorkerCapability(run.worker, "set_host_tools");
          return installed;
        },
        (err: unknown) => {
          this.recordWorkerRefusal(run.worker, "set_host_tools", err);
          throw err;
        },
      );
      run.worker.worker.onHostToolCall(async (frame) => {
        const toolName = typeof frame.toolName === "string" ? frame.toolName : "";
        if (!selected.some((tool) => tool.name === toolName)) {
          return {
            isError: true,
            result: { content: [{ type: "text", text: `tool '${toolName}' is not part of this run` }] },
          };
        }
        const args = isRecord(frame.arguments) ? frame.arguments : {};
        const result = await client.callTool(toolName, args);
        return {
          result: { content: [{ type: "text", text: result.text }] },
          ...(result.isError ? { isError: true } : {}),
        };
      });
      run.hostToolsInstalled = true;
      this.emitEvent(run, "run.system", {
        level: "info",
        message: `omp connection tools installed as host tools: ${names.join(", ")}`,
      });
    } catch (err) {
      run.worker.worker.onHostToolCall(null);
      // Clear any definition set that landed before the failure, so the warm
      // worker cannot keep serving a later run from a dead handler.
      void run.worker.worker.setHostTools([]).catch(() => {});
      this.emitEvent(run, "run.system", {
        level: "warn",
        message: `omp connection tools are unavailable this run: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async finishFromOutcome(run: RunState): Promise<void> {
    const outcome = run.outcome;
    if (outcome === null || run.terminal) return;
    if (run.abandoned !== null) {
      await this.settle(run, { kind: "lost", settledBy: "adapter_gone", cause: run.abandoned });
      return;
    }
    if (outcome.status === "completed") {
      await this.settle(run, { kind: "settled", settledBy: "outcome", stopReason: "end_turn" });
      return;
    }
    if (outcome.status === "aborted") {
      await this.settle(run, { kind: "settled", settledBy: "outcome", cause: "cancel", stopReason: "aborted" });
      return;
    }
    await this.settle(run, {
      kind: "settled",
      settledBy: "outcome",
      stopReason: "error",
      errorCode: "omp_rpc_turn_failed",
      errorMessage: outcome.errorMessage ?? "the omp turn ended in error",
    });
  }

  private async timeoutRun(run: RunState): Promise<void> {
    if (run.terminal) return;
    run.timeoutTimer = undefined;
    // settle() marks the run terminal before its first await, so the abort it
    // triggers cannot race in a competing 'cancel' outcome.
    const settling = this.settle(run, {
      kind: "settled",
      settledBy: "timeout",
      cause: "timeout",
      stopReason: "timeout",
      timedOut: true,
      errorCode: "omp_host_timeout",
      errorMessage: `the run exceeded its ${run.begin.limits.timeoutMs}ms timeout`,
    });
    await run.worker.worker.abort().catch(() => {});
    await settling;
  }

  private async cancelRun(run: RunState, reason: "operator" | "timeout" | "shutdown"): Promise<void> {
    if (run.terminal) return;
    await run.worker.worker.abort().catch(() => {});
    const settled = await this.waitForSettle(run, this.options.cancelGraceMs);
    if (!settled) {
      const settling = this.settle(run, {
        kind: "settled",
        settledBy: "cancel",
        cause: "cancel",
        stopReason: "cancelled",
        detail: { cancelUnconfirmed: true, reason },
      });
      run.worker.worker.kill("SIGKILL");
      await settling;
    }
  }

  private async adapterGone(run: RunState): Promise<void> {
    if (run.terminal) return;
    run.abandoned = "adapter_gone";
    await run.worker.worker.abort().catch(() => {});
    const settled = await this.waitForSettle(run, this.options.cancelGraceMs);
    if (settled) return;
    if (run.worker.worker.alive) run.worker.worker.kill("SIGKILL");
    await this.settle(run, { kind: "lost", settledBy: "adapter_gone", cause: "adapter_gone" });
  }

  /** Resolve true if the run reached a terminal state within `ms`. */
  private async waitForSettle(run: RunState, ms: number): Promise<boolean> {
    if (run.terminal) return true;
    const done = Promise.withResolvers<boolean>();
    const unsubscribe = run.worker.worker.onFrame((frame) => {
      if (frame.type !== "prompt_result") return;
      if (typeof frame.id === "string" && frame.id !== run.runId) return;
      done.resolve(true);
    });
    const timer = setTimeout(() => done.resolve(false), ms);
    try {
      return await done.promise;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }

  private startLeaseWatch(run: RunState): void {
    const ttl = Math.max(50, Math.floor(run.begin.limits.runLeaseTtlMs / 3));
    run.leaseTimer = setInterval(() => {
      if (run.terminal) return;
      if (Date.now() <= run.leaseDeadline) return;
      run.leaseMisses += 1;
      if (run.leaseMisses === 1) {
        this.emitEvent(run, "run.system", {
          level: "warn",
          message: `run ${run.runId}: no adapter heartbeat within ${run.begin.limits.runLeaseTtlMs}ms; aborting the prompt (the worker is kept one more window)`,
        });
        run.leaseDeadline = Date.now() + run.begin.limits.runLeaseTtlMs;
        void run.worker.worker.abort().catch(() => {});
        return;
      }
      const settling = this.settle(run, { kind: "lost", settledBy: "lease", cause: "adapter_gone" });
      run.worker.worker.kill("SIGKILL");
      void settling;
    }, ttl);
    run.leaseTimer.unref();
  }

  /* ------------------------------------------------------------------ */
  /*  Settlement                                                         */
  /* ------------------------------------------------------------------ */

  private async settle(
    run: RunState,
    outcome: {
      kind: "settled" | "lost";
      /** Which terminal path reached this settle; rides resultJson.hostRuntime. */
      settledBy: SettledBy;
      stopReason?: string;
      cause?: LedgerCause;
      errorCode?: string;
      errorMessage?: string;
      timedOut?: boolean;
      detail?: Record<string, unknown>;
      executionRecovery?: { kind: "interrupted"; providerStopped: true; sessionPreserved: true; actionOutcomes: "settled" };
    },
  ): Promise<void> {
    if (run.terminal) return;
    run.terminal = true;
    clearInterval(run.leaseTimer);
    run.leaseTimer = undefined;
    clearTimeout(run.timeoutTimer);
    run.timeoutTimer = undefined;
    for (const off of run.unsubscribe) off();
    run.unsubscribe = [];
    this.runs.delete(run.runId);
    run.worker.currentRun = null;
    run.worker.lastUsedAt = Date.now();

    const statsAfter = readStats(await run.worker.worker.getStats().catch(() => ({})));
    // Ask before the worker is reused/retired; a run with no subagent activity
    // and observability off skips the request and adds no empty field.
    const subagents = await this.subagentSummary(run);
    const sessionId = statsAfter?.sessionId ?? run.ompSessionId;
    const baseline = this.usageBaseline(run, statsAfter, sessionId);
    // Keep the settle snapshot: it is the baseline for the next run on this
    // worker and session (a retry, a warm heartbeat, or a run after a failed
    // begin-time stats read).
    if (statsAfter !== null) run.worker.settledUsage = { sessionId, snapshot: statsAfter };
    const perRun = baseline !== null;
    // `null` when the worker did not report stats at all: the run has no usage
    // evidence, and claiming zeros would be a lie the ledger could not correct.
    const used = statsAfter === null ? null : perRun ? delta(baseline, statsAfter) : statsAfter;
    const model = this.singleModel(used?.routedModels ?? {}) ?? run.begin.cell.model;
    const status = run.outcome?.status ?? (outcome.kind === "settled" ? "completed" : "error");
    const agentInvoked = run.outcome?.agentInvoked ?? false;
    // Cache-write tokens are prompt tokens the provider billed to create cache
    // entries, so they count as input.
    const reported = used === null ? null : {
      usage: {
        inputTokens: used.input + used.cacheWrite,
        outputTokens: used.output,
        cachedInputTokens: used.cacheRead,
      },
      basis: (perRun ? "per_run" : "session_cumulative") as "per_run" | "session_cumulative",
      costUsd: used.cost,
      routedModels: used.routedModels,
      contextUsage: used.contextUsage,
    };
    const usage: LedgerUsage | null = reported === null ? null : {
      inputTokens: reported.usage.inputTokens,
      outputTokens: reported.usage.outputTokens,
      cachedInputTokens: reported.usage.cachedInputTokens,
      costUsd: reported.costUsd,
      routedModels: reported.routedModels,
      ...(reported.contextUsage !== null ? { contextUsage: reported.contextUsage } : {}),
    };
    const record = this.runRecord(run, outcome.kind, {
      ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
      detail: {
        stopReason: outcome.stopReason ?? null,
        agentInvoked,
        sessionSettled: run.outcome?.sessionSettled ?? false,
        status,
        ...(reported !== null && reported.basis === "session_cumulative"
          ? { usageBasis: "session_cumulative" }
          : {}),
        ...(outcome.detail ?? {}),
      },
      ...(usage !== null ? { usage } : {}),
      worker: this.ledgerWorker(run.worker),
      ompSessionId: run.ompSessionId,
      ...(run.sessionFile !== null ? { sessionFile: run.sessionFile } : {}),
    });
    let ledgerSeq = 0;
    await this.journal(record).then((written) => {
      ledgerSeq = written.seq;
    }).catch((err: unknown) => {
      this.emitEvent(run, "run.system", {
        level: "warn",
        message: `the run ledger could not record the settle: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
    // The board's runtime evidence: what the host alone knows (was the worker
    // reused, which path settled the turn, what the worker's age was). Read
    // after the journal so `ledgerSeq` names the settle record itself.
    const workerStartMs = Date.parse(run.worker.worker.startedAt);
    const hostRuntime: HostRuntime = {
      workerPid: run.worker.worker.pid,
      reusedWorker: run.reusedWorker,
      settledBy: outcome.settledBy,
      ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
      ledgerSeq,
      workerAgeMs: Number.isFinite(workerStartMs) ? Math.max(0, Date.now() - workerStartMs) : 0,
    };
    const result: AdapterExecutionResult & { executionRecovery?: Record<string, unknown> } = {
      exitCode: status === "completed" ? 0 : 1,
      signal: null,
      timedOut: outcome.timedOut === true,
      ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
      sessionId: run.ompSessionId,
      sessionDisplayId: run.ompSessionId,
      sessionParams: {
        acpSessionId: run.ompSessionId,
        sessionKey: run.begin.sessionKey,
        cwd: run.begin.cwd,
      },
      model,
      ...(reported !== null
        ? { usage: reported.usage, usageBasis: reported.basis, costUsd: reported.costUsd }
        : {}),
      resultJson: {
        status,
        stopReason: outcome.stopReason ?? null,
        agentInvoked,
        sessionSettled: run.outcome?.sessionSettled ?? false,
        transport: "host-rpc",
        workerPid: run.worker.worker.pid,
        reusedWorker: run.reusedWorker,
        hostRuntime,
        routedModels: reported?.routedModels ?? {},
        ...(reported?.contextUsage != null ? { contextUsage: reported.contextUsage } : {}),
        ...(subagents !== null ? { subagents } : {}),
      },
      summary: run.lastAssistantText ?? outcome.stopReason ?? status,
      ...(outcome.executionRecovery !== undefined ? { executionRecovery: outcome.executionRecovery } : {}),
    };
    if (run.hostToolsInstalled) {
      // The handler closes over this run's bearer: drop it before the worker is
      // reused by the next run (which installs its own).
      run.worker.worker.onHostToolCall(null);
      void run.worker.worker.setHostTools([]).catch(() => {
        // A missed clear is recoverable (the handler is already gone; a call
        // would answer "this host does not serve host tools"), and the next run
        // rebinds the set anyway: never let it fail the settle.
      });
    }
    await clearRunContext(this.root, run.worker.workerId, run.runId).catch(() => {});
    if ([...run.connections].some((connection) => !connection.closed)) {
      if (reported === null) {
        this.emitEvent(run, "run.system", {
          level: "warn",
          message: "this run's usage is unknown: the worker did not report session stats at settle",
        });
      } else if (reported.basis === "session_cumulative") {
        this.emitEvent(run, "run.system", {
          level: "warn",
          message: "this run's usage is session-cumulative: the host has no baseline for this session (a cold or restarted worker, or a session it did not open)",
        });
      }
      if (reported !== null) {
        const receipt = {
          usage: reported.usage,
          usageBasis: reported.basis,
          model,
          costUsd: reported.costUsd,
          complete: true,
        };
        this.emitEvent(run, "omp.usage", receipt);
      }
      this.broadcastSettled(run, result);
    }
    // The connection is free again: a sequential begin on it may carry the next
    // run, while a concurrent second one is still refused.
    for (const waiter of run.connections) {
      if (waiter.runId === run.runId) waiter.runId = null;
    }
    await this.journal(this.runRecord(run, "closed", {
      cause: outcome.cause ?? "clean",
      // Kept on the final record: compaction leaves only this line per run, and
      // the session index (fork cwd) must survive a host restart.
      ompSessionId: run.ompSessionId,
      ...(run.sessionFile !== null ? { sessionFile: run.sessionFile } : {}),
    })).catch(() => {});
    await run.leaseRelease().catch(() => {});
    if (!this.options.reuseWorkers) await this.retireWorker(run.worker);
    this.touch();
  }

  private singleModel(routed: Record<string, number>): string | null {
    const models = Object.keys(routed);
    return models.length === 1 ? models[0] : null;
  }

  /**
   * The cumulative snapshot this run's usage is measured against, or null when
   * the host cannot know it.
   *
   * The begin-time read is the freshest baseline. The last settle snapshot on
   * this worker covers a begin read that came back empty (a cold worker whose
   * session counters were not ready yet) and a run that joined a session this
   * host had already settled. A session this run created starts at zero; a
   * fork's copied transcript does not, so it needs one of the other sources.
   */
  private usageBaseline(
    run: RunState,
    after: StatsSnapshot | null,
    sessionId: string,
  ): StatsSnapshot | null {
    if (after === null) return null;
    const before = run.statsBefore;
    const switched = before !== null && before.sessionId !== null && after.sessionId !== null
      && before.sessionId !== after.sessionId;
    if (before !== null && !switched) return before;
    const settled = run.worker.settledUsage;
    if (settled !== null && settled.sessionId === sessionId) return settled.snapshot;
    if (run.freshSession && sessionId === run.ompSessionId) return ZERO_STATS;
    return null;
  }

  /* ------------------------------------------------------------------ */
  /*  Workers                                                            */
  /* ------------------------------------------------------------------ */

  private workerKey(begin: RunBeginFrame): string {
    return [begin.agent.companyId, begin.agent.id, begin.cwd, begin.sessionKey].join("\u0000");
  }

  private sessionDirFor(begin: RunBeginFrame): string {
    // Tenant identity is part of the directory: a sessionKey that names another
    // agent must never resume that agent's transcript. The prefix check below
    // rejects the mismatch up front; the hash keeps the path tenant-scoped anyway.
    return `${this.root}/sessions/${hashText(begin.agent.companyId, begin.agent.id, begin.sessionKey)}`;
  }

  /** A sessionKey minted for another agent is a caller bug, not a resume. */
  private sessionKeyMismatch(begin: RunBeginFrame): string | null {
    const match = /^paperclip:([^:]+):([^:]+):/.exec(begin.sessionKey);
    if (match === null) return null;
    if (match[1] === begin.agent.companyId && match[2] === begin.agent.id) return null;
    return `sessionKey '${begin.sessionKey}' belongs to another agent (company '${match[1]}', agent '${match[2]}')`;
  }

  private async ompVersionOf(command: string): Promise<string | null> {
    if (!this.versionCache.has(command)) {
      this.versionCache.set(command, await probeOmpVersion(command));
    }
    return this.versionCache.get(command) ?? null;
  }

  private async ensureWorker(begin: RunBeginFrame): Promise<{ worker: WorkerEntry; reused: boolean }> {
    const key = this.workerKey(begin);
    const fingerprint: Fingerprint = {
      argvHash: begin.cell.argvHash,
      bridgeHash: begin.cell.bridgeHash,
      agentDir: begin.cell.agentDir,
      profile: begin.cell.profile ?? null,
      cwd: begin.cwd,
      ompVersion: await this.ompVersionOf(begin.worker.command),
    };
    const existing = this.workers.get(key);
    if (existing !== undefined && this.options.reuseWorkers && this.sameFingerprint(existing.fingerprint, fingerprint)) {
      // A crashed worker stays in the registry until the idle sweep; reusing the
      // dead entry would fail every later run of this key for up to 20 minutes.
      if (existing.worker.alive) return { worker: existing, reused: true };
      await this.retireWorker(existing);
    }
    if (existing !== undefined) {
      await this.retireWorker(existing);
    }
    // Reserve the slot BEFORE the first await: two interleaved begins would
    // otherwise both read the same `workers.size` and overshoot the hard cap.
    this.reserveWorkerSlot();
    try {
      return await this.spawnWorker(begin, key, fingerprint);
    } finally {
      this.reservedWorkers -= 1;
    }
  }

  /** Synchronously free or take a worker slot, or refuse with `omp_host_capacity`. */
  private reserveWorkerSlot(): void {
    if (this.workers.size + this.reservedWorkers >= this.options.maxWorkers) {
      const idle = [...this.workers.values()]
        .filter((entry) => entry.currentRun === null)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (idle === undefined) {
        throw new Error(
          `omp_host_capacity: the supervisor already runs ${this.workers.size} workers (max ${this.options.maxWorkers}) and none is idle`,
        );
      }
      // retireWorker detaches the entry from the map before its first await, so
      // the freed slot is visible to the next reservation immediately.
      void this.retireWorker(idle);
    }
    this.reservedWorkers += 1;
  }

  private async spawnWorker(
    begin: RunBeginFrame,
    key: string,
    fingerprint: Fingerprint,
  ): Promise<{ worker: WorkerEntry; reused: boolean }> {
    const sessionDir = this.sessionDirFor(begin);
    const workerId = hashText(key);
    const runContext = runContextPointer(this.root, workerId);
    const worker = await RpcWorker.spawn({
      command: begin.worker.command,
      args: begin.worker.args,
      env: { ...begin.worker.env, PAPERCLIP_RUN_CONTEXT: runContext },
      cwd: begin.cwd,
    });
    const entry: WorkerEntry = {
      key,
      workerId,
      runContextPointer: runContext,
      worker,
      fingerprint,
      sessionDir,
      sessionKey: begin.sessionKey,
      startIdentity: await readProcessStartIdentity(worker.pid),
      ompSessionId: null,
      sessionFile: null,
      settledUsage: null,
      capabilities: {
        get_session_stats: "unknown",
        set_host_tools: "unknown",
        set_subagent_subscription: "unknown",
      },
      currentRun: null,
      lastUsedAt: Date.now(),
    };
    this.workers.set(key, entry);
    return { worker: entry, reused: false };
  }

  private sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
    return a.argvHash === b.argvHash
      && a.bridgeHash === b.bridgeHash
      && a.agentDir === b.agentDir
      && a.profile === b.profile
      && a.cwd === b.cwd
      && a.ompVersion === b.ompVersion;
  }

  private async retireWorker(entry: WorkerEntry): Promise<void> {
    // Detach first: callers reserve slots synchronously and must observe the
    // freed worker before this method's first await.
    if (this.workers.get(entry.key) === entry) this.workers.delete(entry.key);
    if (entry.worker.alive) await entry.worker.stop(this.options.cancelGraceMs);
  }

  private ledgerWorker(entry: WorkerEntry): LedgerWorker {
    return {
      pid: entry.worker.pid,
      pgid: entry.worker.pgid,
      startedAt: entry.worker.startedAt,
      startIdentity: entry.startIdentity,
      argvHash: entry.fingerprint.argvHash,
      bridgeHash: entry.fingerprint.bridgeHash,
      ompVersion: entry.fingerprint.ompVersion,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Journal                                                            */
  /* ------------------------------------------------------------------ */

  private async journal(input: LedgerInput): Promise<LedgerRecord> {
    const ledger = this.ledger;
    if (ledger === null) throw new LedgerWriteError("the ledger is not open");
    const record = await ledger.append(input);
    if (record.ompSessionId !== undefined && record.ompSessionId !== "") {
      this.sessionIndex.set(record.ompSessionId, {
        cwd: record.cwd,
        sessionFile: record.sessionFile ?? null,
      });
    }
    return record;
  }

  private runRecord(
    run: RunState,
    state: LedgerInput["state"],
    extra: Partial<LedgerInput> = {},
  ): LedgerInput {
    return {
      epoch: this.epoch,
      runId: run.runId,
      companyId: run.begin.agent.companyId,
      agentId: run.begin.agent.id,
      sessionKey: run.begin.sessionKey,
      cwd: run.begin.cwd,
      state,
      ...extra,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Sweeps, close, reaping                                             */
  /* ------------------------------------------------------------------ */

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private sweep(): void {
    const now = Date.now();
    for (const entry of [...this.workers.values()]) {
      if (entry.currentRun !== null) continue;
      if (now - entry.lastUsedAt < this.options.workerIdleMs) continue;
      void this.retireWorker(entry);
    }
    if (this.shuttingDown || this.closedAt !== null) return;
    if (this.workers.size > 0 || this.runs.size > 0 || this.connections.size > 0) return;
    if (now - this.lastActivity < this.options.hostIdleMs) return;
    void this.close("idle");
  }

  async close(reason = "requested"): Promise<void> {
    if (this.closedAt !== null) return;
    this.shuttingDown = true;
    const deadline = Date.now() + this.options.drainMs;
    while (this.runs.size > 0 && Date.now() < deadline) {
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, 25);
      await tick.promise;
    }
    for (const run of [...this.runs.values()]) {
      run.worker.worker.kill("SIGKILL");
      await this.settle(run, { kind: "lost", settledBy: "host_exit", cause: "host_exit" }).catch(() => {});
    }
    for (const entry of [...this.workers.values()]) await this.retireWorker(entry);
    for (const connection of [...this.connections]) connection.socket.destroy();
    this.connections.clear();
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    const server = this.server;
    this.server = null;
    if (server !== null) {
      const done = Promise.withResolvers<void>();
      server.close(() => done.resolve());
      await done.promise;
    }
    await unlink(this.socketPath).catch(() => {});
    await clearDiscoveryOwned(this.root, process.pid, this.epoch);
    if (this.ledger !== null) await this.ledger.close().catch(() => {});
    this.ledger = null;
    if (this.lock !== null) await this.lock.release().catch(() => {});
    this.lock = null;
    this.closedAt = Date.now();
    this.closed.resolve();
    // `reason` is operator-facing only: the ledger already records the per-run
    // cause, and the CLI prints the discovery/pid it stopped.
    this.closeReason = reason;
  }
}

/** The sweep cadence: fast enough for tests, cheap enough for a real host. */
function sweepInterval(options: { hostIdleMs: number; workerIdleMs: number }): number {
  return Math.max(50, Math.min(5_000, Math.floor(options.hostIdleMs / 4), Math.floor(options.workerIdleMs / 4)));
}

/**
 * Reconcile a previous host's ledger: every run that never reached a terminal
 * state is `lost/host_exit`. Its worker is killed by process group when the pid
 * and start identity still name it; a reused pid is never killed. Leftover
 * run-context files for terminal runs are removed.
 *
 * Shared by host start and `omp-host gc`.
 */
export async function reconcile(rootDir: string = hostRootDir()): Promise<{
  killed: number[];
  lost: number;
  runContexts: number;
}> {
  const ledger = await RunLedger.open(rootDir);
  try {
    return await reconcileWith(rootDir, ledger);
  } finally {
    await ledger.close();
  }
}

async function reconcileWith(rootDir: string, ledger: RunLedger): Promise<{
  killed: number[];
  lost: number;
  runContexts: number;
}> {
  const killed: number[] = [];
  let lost = 0;
  const terminal = new Set<string>();
  for (const [runId, record] of ledger.snapshot()) {
    if (isTerminalState(record.state)) {
      terminal.add(runId);
      continue;
    }
    let orphan: "killed" | "gone" | "unverified" | "none" = "none";
    const pid = record.worker?.pid ?? 0;
    if (pid > 0) {
      const alive = pidAlive(pid);
      const identity = alive ? await readProcessStartIdentity(pid) : null;
      const expected = record.worker?.startIdentity ?? null;
      if (!alive) {
        orphan = "gone";
      } else if (expected === null || identity === null || expected !== identity) {
        // A live pid we cannot match to the recorded start identity may be a
        // recycled pid owned by an unrelated process: never signal it.
        orphan = "unverified";
      } else {
        const pgid = record.worker?.pgid ?? pid;
        try {
          if (pgid > 1) process.kill(-pgid, "SIGKILL");
          else process.kill(pid, "SIGKILL");
          orphan = "killed";
          killed.push(pid);
        } catch {
          orphan = "gone";
        }
      }
    }
    await ledger.append({
      epoch: record.epoch,
      runId,
      companyId: record.companyId,
      agentId: record.agentId,
      sessionKey: record.sessionKey,
      cwd: record.cwd,
      state: "lost",
      cause: "host_exit",
      detail: { orphan },
    });
    lost += 1;
    terminal.add(runId);
  }
  const runContexts = await reapRunContexts(rootDir, (runId) => terminal.has(runId));
  return { killed, lost, runContexts };
}

/** Start the instance's supervisor. Refuses when another live host owns it. */
export async function startHost(options: HostOptions = {}): Promise<RunningHost> {
  const supervisor = new Supervisor(options);
  return supervisor.start();
}
