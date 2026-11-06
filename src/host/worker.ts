import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
import { resolveOmpAgentCommand } from "../server/adapters/acp/launch.js";

/**
 * A single `omp --mode rpc` process: the host's only way to run a turn.
 *
 * RPC is JSONL on the worker's stdio. `prompt_result` is a terminal frame the
 * worker reports as a fact (`sessionSettled`), and `session_settled` closes the
 * background-work case — settlement is never inferred here. This class owns the
 * process, the frame correlation and the chunk decoder; run state, leases and
 * the ledger live in `server.ts`.
 *
 * The worker is spawned `detached` so it gets its own process group: the host is
 * the only reaper (Paperclip deliberately never kills an `omp_local` child), and
 * a group kill is the only kill that takes subagents with it.
 */

export type RpcFrame = { type: string } & Record<string, unknown>;

export interface WorkerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface WorkerSpawnOptions {
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** Keys the host must never pass into a worker, whatever a config env says. */
const FORBIDDEN_WORKER_ENV: Record<string, true> = { PAPERCLIP_API_KEY: true };

/**
 * A worker that emits an unterminated line forever must not grow the supervisor
 * without bound (omp caps a frame at 1 MiB and reassembles at 64 MiB, so this is
 * well above anything legitimate).
 */
const MAX_WORKER_BUFFER_CHARS = 64 * 1024 * 1024;

/**
 * The worker's command line: the existing `resolveOmpAgentCommand` (which
 * already carries `--extension` and `--thinking`) with the standalone `acp`
 * subcommand removed and `--mode rpc` appended.
 *
 * The text is kept intact — not tokenized — because the engine launches the
 * same string through a login shell (`sh -lc "exec <command>"`,
 * adapter-utils `execute.js:1436-1441`). Tokenizing would lose shell quoting
 * (paths with spaces) and bypass the profile PATH an `omp` installed outside
 * the server's own PATH depends on.
 */
export function buildWorkerCommand(config: Record<string, unknown>, bridge: string): string {
  const command = resolveOmpAgentCommand(config, bridge).replace(/(^|\s)acp(?=\s|$)\s?/, "$1").trim();
  return `${command} --mode rpc`;
}

/**
 * The spawn spec: a login shell that `exec`s the command, so the shell is
 * replaced by omp (same pid, same process group) exactly like the engine lane.
 */
export function buildWorkerArgv(
  config: Record<string, unknown>,
  bridge: string,
): { command: string; args: string[] } {
  return { command: "sh", args: ["-lc", `exec ${buildWorkerCommand(config, bridge)}`] };
}

/**
 * The worker's env additions: string entries of the config env plus the host's
 * own values. The run JWT is stripped unconditionally — it lives in the
 * run-context file, never in a live process's environment (env cannot change in
 * a warm worker, which is the whole reason the token moved to a file).
 */
export function buildWorkerEnv(
  config: Record<string, unknown>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries((config.env ?? {}) as Record<string, unknown>)) {
    if (typeof value === "string" && FORBIDDEN_WORKER_ENV[key] !== true) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (FORBIDDEN_WORKER_ENV[key] !== true) env[key] = value;
  }
  return env;
}

interface PendingChunks {
  count: number;
  nextIndex: number;
  parts: Buffer[];
}

interface PendingRequest {
  resolve: (frame: RpcFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

export class RpcWorker {
  readonly pid: number;
  readonly pgid: number | null;
  readonly startedAt: string;
  readonly exited: Promise<WorkerExit>;

  private readonly child: ChildProcess;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(frame: RpcFrame) => void>();
  private readonly stderrListeners = new Set<(chunk: string) => void>();
  private readonly retained: RpcFrame[] = [];
  private readonly chunks = new Map<string, PendingChunks>();
  private hostToolHandler: ((frame: RpcFrame) => Promise<Record<string, unknown>> | Record<string, unknown>) | null = null;
  private nextRequest = 0;
  private dead = false;
  private stderrTail = "";

  private constructor(child: ChildProcess, options: WorkerSpawnOptions) {
    this.child = child;
    this.pid = child.pid ?? -1;
    this.pgid = child.pid ?? null;
    this.startedAt = new Date().toISOString();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    const exit = Promise.withResolvers<WorkerExit>();
    this.exited = exit.promise;
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > MAX_WORKER_BUFFER_CHARS) {
        buffer = "";
        this.kill("SIGKILL");
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") this.acceptLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-4_000);
      for (const listener of this.stderrListeners) listener(text);
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.dead) return;
      this.dead = true;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(
          `omp worker exited (${signal ?? code}) before answering ${request.command}${this.stderrSuffix()}`,
        ));
      }
      this.pending.clear();
      exit.resolve({ code, signal });
    };
    child.on("error", () => finish(null, null));
    child.on("exit", (code, signal) => finish(code, signal));
  }

  /** Spawn and wait for the worker's `ready` frame. */
  static async spawn(spec: WorkerSpec, options: WorkerSpawnOptions = {}): Promise<RpcWorker> {
    const env: Record<string, string> = { ...process.env as Record<string, string>, ...spec.env };
    for (const key of Object.keys(FORBIDDEN_WORKER_ENV)) delete env[key];
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group: a group kill reaches subagents, and the host can reap
      // this worker after a restart without guessing at a shared group.
      detached: true,
    });
    child.stdin?.on("error", () => {});
    const worker = new RpcWorker(child, options);
    const ready = worker.waitForFrame((frame) => frame.type === "ready",
      options.readyTimeoutMs ?? 20_000);
    try {
      await ready;
    } catch (err) {
      await worker.stop(500);
      throw err;
    }
    return worker;
  }

  get alive(): boolean {
    return !this.dead;
  }

  /** Frames retained for diagnostics and for `waitForFrame`; bounded. */
  get frames(): readonly RpcFrame[] {
    return this.retained;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  private stderrSuffix(): string {
    const trimmed = this.stderrTail.trim();
    return trimmed === "" ? "" : `: ${trimmed}`;
  }

  onFrame(listener: (frame: RpcFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stream the worker's stderr; the run log relays it 1:1. */
  onStderr(listener: (chunk: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  /**
   * Resolve with the first frame (already seen or future) matching `predicate`.
   * Rejects when the worker exits first or the deadline passes; used for the
   * terminal frames (`prompt_result`, `session_settled`) whose arrival the
   * server treats as settlement.
   */
  waitForFrame(
    predicate: (frame: RpcFrame) => boolean,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<RpcFrame> {
    const seen = this.retained.find(predicate);
    if (seen) return Promise.resolve(seen);
    if (this.dead) return Promise.reject(new Error("omp worker is not running"));
    const result = Promise.withResolvers<RpcFrame>();
    const off = this.onFrame((frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      off();
      result.resolve(frame);
    });
    const timer = setTimeout(() => {
      off();
      result.reject(new Error(`timed out after ${timeoutMs}ms waiting for an RPC frame${this.stderrSuffix()}`));
    }, timeoutMs);
    void this.exited.then(() => {
      clearTimeout(timer);
      off();
      result.reject(new Error(`omp worker exited before the frame arrived${this.stderrSuffix()}`));
    });
    return result.promise;
  }

  /** Send one command and resolve on its `response` frame; rejects on failure or exit. */
  request(command: RpcFrame, timeoutMs = this.requestTimeoutMs): Promise<RpcFrame> {
    if (this.dead) return Promise.reject(new Error("omp worker is not running"));
    // A caller-supplied id is the wire id: `prompt_result` correlates on it, so
    // a prompt's terminal frame must carry the id the run chose.
    const id = typeof command.id === "string" && command.id !== ""
      ? command.id
      : `c${++this.nextRequest}`;
    const result = Promise.withResolvers<RpcFrame>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      result.reject(new Error(`omp worker did not answer ${String(command.type)} within ${timeoutMs}ms${this.stderrSuffix()}`));
    }, timeoutMs);
    this.pending.set(id, {
      resolve: result.resolve,
      reject: result.reject,
      timer,
      command: String(command.type),
    });
    this.write({ ...command, id });
    return result.promise;
  }

  async newSession(): Promise<{ cancelled: boolean }> {
    const response = await this.request({ type: "new_session" });
    const data = (response.data ?? {}) as Record<string, unknown>;
    return { cancelled: data.cancelled === true };
  }

  async openSession(
    sessionDir: string,
    model?: { provider: string; modelId: string },
  ): Promise<{ cancelled: boolean; resumed: boolean; sessionId: string; sessionFile?: string }> {
    const response = await this.request({
      type: "open_session",
      sessionDir,
      ...(model ?? {}),
    });
    const data = (response.data ?? {}) as Record<string, unknown>;
    return {
      cancelled: data.cancelled === true,
      resumed: data.resumed === true,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : "",
      ...(typeof data.sessionFile === "string" ? { sessionFile: data.sessionFile } : {}),
    };
  }

  async prompt(message: string, promptId: string): Promise<{ agentInvoked: boolean }> {
    const response = await this.request({ id: promptId, type: "prompt", message });
    const data = (response.data ?? {}) as Record<string, unknown>;
    return { agentInvoked: data.agentInvoked !== false };
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  async steer(message: string): Promise<void> {
    await this.request({ type: "steer", message });
  }

  async followUp(message: string): Promise<void> {
    await this.request({ type: "follow_up", message });
  }

  async getState(): Promise<Record<string, unknown>> {
    const response = await this.request({ type: "get_state" });
    return (response.data ?? {}) as Record<string, unknown>;
  }

  async getStats(): Promise<Record<string, unknown>> {
    const response = await this.request({ type: "get_session_stats" });
    return (response.data ?? {}) as Record<string, unknown>;
  }

  async setHostTools(tools: unknown[]): Promise<string[]> {
    const response = await this.request({ type: "set_host_tools", tools });
    // A refusal is the caller's to name: the run warns "connection tools are
    // unavailable" either way, and the supervisor records what the worker
    // actually answered for this frame.
    if (response.success === false) {
      throw new Error(typeof response.error === "string" ? response.error : "set_host_tools was refused");
    }
    const data = (response.data ?? {}) as Record<string, unknown>;
    return Array.isArray(data.toolNames) ? data.toolNames.filter((n): n is string => typeof n === "string") : [];
  }

  /**
   * The running subagents omp still holds at settle. Finished subagents leave
   * omp's registry, so this is the live remainder, not the run's history.
   */
  async getSubagents(timeoutMs?: number): Promise<unknown[]> {
    const response = await this.request({ type: "get_subagents" }, timeoutMs);
    const data = (response.data ?? {}) as Record<string, unknown>;
    return Array.isArray(data.subagents) ? data.subagents : [];
  }

  /**
   * Answer `host_tool_call` frames. `null` clears the handler at settle, so a
   * warm worker never answers a later run with an earlier run's credentials.
   */
  onHostToolCall(
    handler: ((frame: RpcFrame) => Promise<Record<string, unknown>> | Record<string, unknown>) | null,
  ): void {
    this.hostToolHandler = handler;
  }

  private write(frame: RpcFrame): void {
    this.child.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  private acceptLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const frame = parsed as RpcFrame;
    if (typeof frame.type !== "string") return;
    if (frame.type === "rpc_chunk") {
      const assembled = this.acceptChunk(frame);
      if (assembled !== null) this.dispatch(assembled);
      return;
    }
    this.dispatch(frame);
  }

  /** Reassemble protocol-v2 chunk frames; null until the sequence completes. */
  private acceptChunk(frame: RpcFrame): RpcFrame | null {
    const chunkId = frame.chunkId;
    const index = frame.index;
    const count = frame.count;
    const data = frame.data;
    if (typeof chunkId !== "string" || typeof index !== "number"
      || typeof count !== "number" || typeof data !== "string") {
      return null;
    }
    const pending = this.chunks.get(chunkId) ?? { count, nextIndex: 0, parts: [] };
    if (pending.count !== count || pending.nextIndex !== index) {
      this.chunks.delete(chunkId);
      return null;
    }
    pending.parts.push(Buffer.from(data, "base64"));
    pending.nextIndex += 1;
    const bytes = pending.parts.reduce((sum, part) => sum + part.byteLength, 0);
    if (bytes > MAX_WORKER_BUFFER_CHARS) {
      this.chunks.delete(chunkId);
      this.kill("SIGKILL");
      return null;
    }
    if (pending.nextIndex < pending.count) {
      this.chunks.set(chunkId, pending);
      return null;
    }
    this.chunks.delete(chunkId);
    try {
      const value: unknown = JSON.parse(Buffer.concat(pending.parts).toString("utf8"));
      if (typeof value === "object" && value !== null && !Array.isArray(value)
        && typeof (value as Record<string, unknown>).type === "string") {
        return value as RpcFrame;
      }
    } catch {
      // A malformed reassembled frame is dropped like any other malformed line.
    }
    return null;
  }

  private dispatch(frame: RpcFrame): void {
    if (frame.type === "response") {
      const requestId = typeof frame.id === "string" ? frame.id : null;
      const pending = requestId !== null ? this.pending.get(requestId) : undefined;
      if (pending) {
        this.pending.delete(requestId as string);
        clearTimeout(pending.timer);
        if (frame.success === true) pending.resolve(frame);
        else pending.reject(new Error(String(frame.error ?? `${pending.command} failed`)));
      }
      return;
    }
    if (frame.type === "host_tool_call") {
      void this.answerHostToolCall(frame);
      return;
    }
    this.retained.push(frame);
    if (this.retained.length > 1_000) this.retained.splice(0, this.retained.length - 1_000);
    for (const listener of this.listeners) listener(frame);
  }

  private async answerHostToolCall(frame: RpcFrame): Promise<void> {
    const id = typeof frame.id === "string" ? frame.id : null;
    if (id === null) return;
    if (this.hostToolHandler === null) {
      this.write({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: "this host does not serve host tools" }] },
      });
      return;
    }
    try {
      const result = await this.hostToolHandler(frame);
      this.write({ type: "host_tool_result", id, ...result });
    } catch (err) {
      this.write({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] },
      });
    }
  }

  /** Signal the worker's group; a dead or missing process is not an error. */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.dead) return;
    const group = this.pgid;
    try {
      if (group !== null && group > 1) process.kill(-group, signal);
      else this.child.kill(signal);
    } catch {
      this.child.kill(signal);
    }
  }

  /** SIGTERM, wait `graceMs`, then SIGKILL the group. */
  async stop(graceMs = 5_000): Promise<void> {
    if (this.dead) return;
    this.kill("SIGTERM");
    const timer = setTimeout(() => this.kill("SIGKILL"), graceMs);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
