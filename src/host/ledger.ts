import { mkdir, open as openFile, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { LedgerCause, LedgerState } from "./protocol.js";

/**
 * The run journal (reshape-architecture.md §3.4).
 *
 * Append-only JSONL, one line per state transition, `fsync`ed before the
 * transition is acked to the adapter. It answers the three questions Paperclip
 * cannot: is a worker still alive for this run, did the turn settle, and what
 * killed it. The board stays authoritative for product truth.
 *
 * Read semantics are last-record-per-runId. The file is compacted on host
 * start, so a crash leaves at most the transition in flight, and a truncated
 * tail line is dropped rather than failing the open.
 *
 * What must never enter a line: credentials, prompt text, tool arguments.
 * `append` enforces that structurally (forbidden key names at any depth) in
 * addition to the record type not having fields for them.
 */

export const LEDGER_VERSION = 1;
export const LEDGER_FILE = "ledger.jsonl";

export interface LedgerWorker {
  pid: number;
  pgid: number | null;
  startedAt: string;
  /** Process start identity at spawn: what makes pid reuse detectable. */
  startIdentity: string | null;
  argvHash: string;
  bridgeHash: string;
  ompVersion: string | null;
}

export interface LedgerUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
  routedModels?: Record<string, number>;
  contextUsage?: { used: number; size: number };
}

export interface LedgerLease {
  owner: string;
  expiresAt: string;
}

export interface LedgerRecord {
  v: typeof LEDGER_VERSION;
  seq: number;
  at: string;
  epoch: string;
  runId: string;
  companyId: string;
  agentId: string;
  sessionKey: string;
  cwd: string;
  state: LedgerState;
  cause?: LedgerCause;
  worker?: LedgerWorker;
  ompSessionId?: string;
  sessionFile?: string;
  detail?: Record<string, unknown>;
  usage?: LedgerUsage;
  lease?: LedgerLease;
}

export type LedgerInput = Omit<LedgerRecord, "v" | "seq" | "at"> & { at?: string };

/** The journal refused the record; nothing was written. */
export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInvariantError";
  }
}

/** The journal could not write; the run must not proceed on an unjournaled state. */
export class LedgerWriteError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LedgerWriteError";
  }
}

/**
 * Keys that mean content rather than accounting. A record carrying one is a bug
 * in the caller, and a journal nobody can safely ship is worse than a refused
 * run. `token` is checked case-insensitively as a whole key only, so
 * `inputTokens`/`routedModels` stay legal.
 */
const FORBIDDEN_KEY = /^(api[_-]?key|apikey|bearer|bearer[_-]?token|token|authorization|password|passwd|secret|credential|credentials|prompt|prompt[_-]?text|arguments|tool[_-]?args|tool[_-]?arguments|input)$/i;

/** The first forbidden key at any depth, or null. */
export function findForbiddenLedgerKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForbiddenLedgerKey(entry);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) return key;
    const found = findForbiddenLedgerKey(entry);
    if (found !== null) return found;
  }
  return null;
}

function parseRecord(line: string): LedgerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== LEDGER_VERSION) return null;
  if (typeof record.seq !== "number" || typeof record.at !== "string" || typeof record.epoch !== "string") return null;
  for (const key of ["runId", "companyId", "agentId", "sessionKey", "cwd", "state"] as const) {
    if (typeof record[key] !== "string") return null;
  }
  return record as unknown as LedgerRecord;
}

/** Every well-formed record on disk, in file order. A truncated tail is ignored. */
export async function readLedgerRecords(dir: string): Promise<LedgerRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, LEDGER_FILE), "utf8");
  } catch {
    return [];
  }
  const records: LedgerRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecord(line);
    if (record !== null) records.push(record);
  }
  return records;
}

/** Last record per runId, in first-seen order. */
export function lastPerRun(records: readonly LedgerRecord[]): Map<string, LedgerRecord> {
  const map = new Map<string, LedgerRecord>();
  for (const record of records) map.set(record.runId, record);
  return map;
}

const TERMINAL_STATES: Record<string, true> = { settled: true, closed: true, refused: true, lost: true };

export function isTerminalState(state: LedgerState): boolean {
  return TERMINAL_STATES[state] === true;
}

export class RunLedger {
  private readonly file: string;
  private handle: FileHandle | null;
  private seq: number;
  private readonly records: Map<string, LedgerRecord>;

  private constructor(file: string, handle: FileHandle, seq: number, records: Map<string, LedgerRecord>) {
    this.file = file;
    this.handle = handle;
    this.seq = seq;
    this.records = records;
  }

  /**
   * Open (creating if absent), compact to the last record per runId when the
   * file holds obsolete lines, and keep the handle for appends.
   */
  static async open(dir: string, options: { compact?: boolean } = {}): Promise<RunLedger> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, LEDGER_FILE);
    const records = await readLedgerRecords(dir);
    const byRun = lastPerRun(records);
    let seq = records.reduce((max, record) => Math.max(max, record.seq), 0);
    if (options.compact !== false && records.length > byRun.size) {
      const compacted = [...byRun.values()].sort((a, b) => a.seq - b.seq);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      const handle = await openFile(tmp, "w", 0o600);
      try {
        await handle.writeFile(compacted.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, file);
    }
    const handle = await openFile(file, "a", 0o600);
    return new RunLedger(file, handle, seq, byRun);
  }

  get currentSeq(): number {
    return this.seq;
  }

  snapshot(): Map<string, LedgerRecord> {
    return new Map(this.records);
  }

  /** The last `limit` records on disk (compaction means one per run in practice). */
  last(limit: number): LedgerRecord[] {
    return [...this.records.values()].slice(-limit);
  }

  /**
   * Validate, assign `seq`/`at`, write one line, fsync, then update the
   * in-memory index. A failed write leaves nothing acked and throws
   * `LedgerWriteError` so the host can refuse the run (`omp_host_unwritable`).
   */
  async append(input: LedgerInput): Promise<LedgerRecord> {
    const record: LedgerRecord = {
      ...input,
      v: LEDGER_VERSION,
      seq: this.seq + 1,
      at: input.at ?? new Date().toISOString(),
    };
    const forbidden = findForbiddenLedgerKey(record);
    if (forbidden !== null) {
      throw new LedgerInvariantError(
        `refusing to journal the ledger field '${forbidden}': the ledger carries accounting facts, never credentials, prompt text or tool arguments`,
      );
    }
    this.assertTransition(record);
    const handle = this.handle;
    if (handle === null) throw new LedgerWriteError("the ledger is closed");
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } catch (err) {
      throw new LedgerWriteError(
        `the run ledger could not be written: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    this.seq = record.seq;
    this.records.set(record.runId, record);
    return record;
  }

  /**
   * The three invariants §3.4 makes structural:
   * one open `prompting` per sessionKey; a `settled` record names how the turn
   * ended and whether the agent was invoked; no content fields.
   */
  private assertTransition(record: LedgerRecord): void {
    if (record.state === "prompting") {
      for (const other of this.records.values()) {
        if (other.runId === record.runId) continue;
        if (other.sessionKey !== record.sessionKey) continue;
        if (other.state === "prompting") {
          throw new LedgerInvariantError(
            `session ${record.sessionKey} already has run ${other.runId} in 'prompting': one writer per omp session is structural, not advisory`,
          );
        }
      }
    }
    if (record.state === "settled") {
      const stopReason = record.detail?.stopReason;
      if ((typeof stopReason !== "string" || stopReason.trim() === "") && record.cause === undefined) {
        throw new LedgerInvariantError(
          `a settled record for ${record.runId} must name a stop reason (detail.stopReason) or a cause`,
        );
      }
      if (typeof record.detail?.agentInvoked !== "boolean") {
        throw new LedgerInvariantError(
          `a settled record for ${record.runId} must carry detail.agentInvoked: 'the model did nothing' and 'the turn failed' are different facts`,
        );
      }
    }
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle !== null) await handle.close();
  }
}

/** Remove the ledger file; `gc` and tests only. */
export async function removeLedger(dir: string): Promise<void> {
  await unlink(path.join(dir, LEDGER_FILE)).catch(() => {});
}
