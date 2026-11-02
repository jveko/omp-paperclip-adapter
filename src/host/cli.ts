import { unlink } from "node:fs/promises";
import { HostClient } from "./client.js";
import { isTerminalState, readLedgerRecords, readLedgerTail, type LedgerRecord } from "./ledger.js";
import type { LedgerCause, LedgerState } from "./protocol.js";
import { reconcile, startHost } from "./server.js";
import {
  acquireHostLock, clearDiscovery, hostRootDir, isDiscoveryStale, readDiscovery,
  readProcessStartIdentity,
} from "./socket.js";

/**
 * `omp-host` — the operator surface for the supervisor. Not required for
 * function: the adapter starts the host lazily. These commands exist to answer
 * "is it running", "stop it", "clean up after a crash" and "what happened".
 */

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  rootDir?: string;
}

const USAGE = [
  "usage: omp-host <command>",
  "",
  "  serve            run the supervisor in the foreground (the adapter starts this itself)",
  "  status           print the running supervisor, or 'host not running'",
  "  stop             drain and stop the running supervisor",
  "  gc               reap a crashed supervisor's ledger orphans, run-context files and stale socket",
  "  ledger tail [n]  print the last n run-ledger records (default 20)",
  "  stats [--json] [--since <duration>]",
  "                   summarize the run ledger: runs, states, causes, latency, worker reuse",
  "                   (duration: <n>s|m|h|d; reads a bounded tail, never writes)",
].join("\n");

/**
 * Dispatch one CLI invocation. Returns the process exit code: 0 success,
 * 1 "nothing to do / not running", 2 usage error.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const rootDir = io.rootDir ?? hostRootDir();
  const [command, ...args] = argv;
  switch (command) {
    case "serve": {
      const host = await startHost({ rootDir });
      const drain = () => {
        void host.close("signal");
      };
      process.once("SIGTERM", drain);
      process.once("SIGINT", drain);
      io.out(`omp-host listening pid=${process.pid} socket=${host.socketPath}\n`);
      await host.closed;
      process.removeListener("SIGTERM", drain);
      process.removeListener("SIGINT", drain);
      return 0;
    }
    case "status":
      return printStatus(rootDir, io);
    case "stop":
      return stopHost(rootDir, io);
    case "gc": {
      // Only a host that holds the lock may reconcile: compaction swaps the
      // ledger inode under a live host, and the reconcile would kill its workers
      // and delete its run-context tokens. Refuse while a supervisor is live.
      let lock: { release: () => Promise<void> };
      try {
        lock = await acquireHostLock(rootDir);
      } catch (err) {
        io.err(`refusing to gc: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      try {
        const result = await reconcile(rootDir);
        let socket = "kept";
        const discovery = await readDiscovery(rootDir);
        if (discovery !== null) {
          const identity = await readProcessStartIdentity(discovery.pid);
          if (isDiscoveryStale(discovery, identity)) {
            await unlink(discovery.socket).catch(() => {});
            await clearDiscovery(rootDir);
            socket = "removed";
          }
        }
        io.out(
          `gc: killed=${result.killed.length} lost=${result.lost} run-context=${result.runContexts} socket=${socket}\n`,
        );
        return 0;
      } finally {
        await lock.release();
      }
    }
    case "ledger": {
      if (args[0] !== "tail") {
        io.err(USAGE + "\n");
        return 2;
      }
      const raw = args[1] ?? "20";
      const limit = Number(raw);
      if (!Number.isFinite(limit) || limit <= 0) {
        io.err(`ledger tail expects a positive count, got '${raw}'\n`);
        return 2;
      }
      const records = await readLedgerRecords(rootDir);
      for (const record of records.slice(-Math.floor(limit))) {
        io.out(`${JSON.stringify(record)}\n`);
      }
      return 0;
    }
    case "stats": {
      let json = false;
      let sinceMs: number | null = null;
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--json") {
          json = true;
          continue;
        }
        if (arg === "--since") {
          const value = args[index + 1];
          if (value === undefined) {
            io.err(`stats --since expects a duration (<n>s|m|h|d)\n${USAGE}\n`);
            return 2;
          }
          sinceMs = parseSince(value);
          if (sinceMs === null) {
            io.err(`stats --since expects a duration (<n>s|m|h|d), got '${value}'\n`);
            return 2;
          }
          index += 1;
          continue;
        }
        io.err(`stats does not understand '${arg}'\n${USAGE}\n`);
        return 2;
      }
      return printStats(rootDir, io, { json, sinceMs });
    }
    case "--help":
    case "-h":
    case undefined:
      io.out(`${USAGE}\n`);
      return command === undefined ? 2 : 0;
    default:
      io.err(`unknown command '${command}'\n${USAGE}\n`);
      return 2;
  }
}

async function printStatus(rootDir: string, io: CliIo): Promise<number> {
  const client = await HostClient.connect({ rootDir }).catch(() => null);
  if (client === null) {
    io.out("host not running\n");
    return 1;
  }
  try {
    client.send({ id: "status", type: "hello", v: 1, instanceId: "cli", adapterVersion: "cli" });
    const hello = await client.waitFor((frame) => frame.type === "hello_ok", 2_000);
    if (hello.type !== "hello_ok") throw new Error("unexpected reply");
    io.out(`host ${hello.hostVersion} pid=${hello.hostPid} epoch=${hello.epoch} workers=${hello.workers}\n`);
    return 0;
  } catch {
    io.out("host not running\n");
    return 1;
  } finally {
    client.close();
  }
}

async function stopHost(rootDir: string, io: CliIo): Promise<number> {
  const discovery = await readDiscovery(rootDir);
  if (discovery === null) {
    io.out("host not running\n");
    return 1;
  }
  const identity = await readProcessStartIdentity(discovery.pid);
  if (isDiscoveryStale(discovery, identity)) {
    await unlink(discovery.socket).catch(() => {});
    await clearDiscovery(rootDir);
    io.out(`host not running (removed the stale record for pid ${discovery.pid})\n`);
    return 0;
  }
  // isDiscoveryStale is conservative about an unknown identity; a LIVE pid whose
  // identity cannot be confirmed may be an unrelated process that recycled the
  // pid, so signal only on positive evidence.
  if (discovery.startIdentity === null || identity === null) {
    io.err(`cannot verify that pid ${discovery.pid} is this instance's supervisor; refusing to signal it\n`);
    return 1;
  }
  try {
    process.kill(discovery.pid, "SIGTERM");
  } catch (err) {
    io.err(`could not signal pid ${discovery.pid}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await readProcessStartIdentity(discovery.pid);
    if (current === null) break;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 100);
    await tick.promise;
  }
  const still = await readProcessStartIdentity(discovery.pid);
  if (still !== null) {
    io.err(`pid ${discovery.pid} is still alive after SIGTERM (it drains in-flight runs first)\n`);
    return 1;
  }
  io.out(`stopped pid ${discovery.pid}\n`);
  return 0;
}

const STATS_NEWEST_RUNS = 10;
/** Enough of a run id to find it again without printing the whole uuid. */
const SHORT_RUN_ID_CHARS = 8;
const DURATION_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
/** Presentation order follows the state machine, never hash order. */
const STATE_ORDER: readonly LedgerState[] = [
  "leased", "worker_ready", "session_open", "prompting", "settled", "closed", "refused", "lost",
];
const CAUSE_ORDER: readonly LedgerCause[] = [
  "clean", "worker_exit", "host_exit", "adapter_gone", "cancel", "timeout", "lease_held",
  "config_error", "capacity",
];

interface StatsRun {
  runId: string;
  agentId: string;
  firstMs: number;
  lastMs: number;
  lastAt: string;
  leasedMs: number | null;
  settledMs: number | null;
  /** The run's last non-`closed` state; a run compacted to its close reports `closed`. */
  state: LedgerState;
  closed: boolean;
  cause: LedgerCause | null;
  workerPid: number | null;
}

interface LedgerStats {
  runs: number;
  /**
   * `records`/`runs` count the filtered (`--since`) window; `truncated`
   * describes the tail read itself, so it is set even when a filter is also
   * applied on top.
   */
  window: { records: number; runs: number; truncated: boolean; since: string | null };
  states: Partial<Record<LedgerState, number>>;
  causes: Partial<Record<LedgerCause, number>>;
  capacityRefusals: number;
  settleLatencyMs: { p50: number | null; p90: number | null; samples: number };
  workerReuse: {
    runsWithWorker: number;
    distinctWorkers: number;
    sharedWorkerRuns: number;
    reuseRate: number;
  };
  newestRuns: Array<{
    runId: string;
    agentId: string;
    state: LedgerState;
    cause: LedgerCause | null;
    durationMs: number;
    at: string;
  }>;
}

/** `<n>s|m|h|d`, positive; null when the operator typed something else. */
function parseSince(raw: string): number | null {
  const match = /^([1-9]\d*)([smhd])$/.exec(raw.trim());
  if (match === null) return null;
  return Number(match[1]) * DURATION_UNIT_MS[match[2]];
}

/**
 * Nearest-rank percentile: the smallest sample at or above `p` percent. With
 * small samples this is the honest answer (no interpolation inventing a
 * latency no run saw).
 */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * One summary over the records in the window. A run is counted once: its state
 * is the last state it reached before `closed`, its cause the one that ended
 * it (a clean close supplies `clean` when nothing else did).
 */
function summarizeStats(
  records: readonly LedgerRecord[],
  truncated: boolean,
  since: string | null,
): LedgerStats {
  const runs = new Map<string, StatsRun>();
  for (const record of records) {
    const atMs = Date.parse(record.at);
    if (!Number.isFinite(atMs)) continue;
    let run = runs.get(record.runId);
    if (run === undefined) {
      run = {
        runId: record.runId,
        agentId: record.agentId,
        firstMs: atMs,
        lastMs: atMs,
        lastAt: record.at,
        leasedMs: null,
        settledMs: null,
        state: record.state,
        closed: record.state === "closed",
        cause: null,
        workerPid: null,
      };
      runs.set(record.runId, run);
    }
    if (atMs >= run.lastMs) {
      run.lastMs = atMs;
      run.lastAt = record.at;
    }
    if (record.state !== "closed") {
      run.state = record.state;
    } else {
      run.closed = true;
    }
    if (record.cause !== undefined && (record.state !== "closed" || run.cause === null)) {
      run.cause = record.cause;
    }
    if (record.state === "leased" && run.leasedMs === null) run.leasedMs = atMs;
    if (record.state === "settled" && run.settledMs === null) run.settledMs = atMs;
    const pid = record.worker?.pid;
    if (typeof pid === "number" && pid > 0) run.workerPid = pid;
  }

  const states: Partial<Record<LedgerState, number>> = {};
  const causes: Partial<Record<LedgerCause, number>> = {};
  const latencies: number[] = [];
  const pidRuns = new Map<number, number>();
  let capacityRefusals = 0;
  let runsWithWorker = 0;
  for (const run of runs.values()) {
    // A run whose last transition was `closed` reports the terminal state it
    // reached before it; a run with only in-flight states plus a close (a
    // compacted ledger) is just `closed`.
    if (!isTerminalState(run.state) && run.closed) run.state = "closed";
    states[run.state] = (states[run.state] ?? 0) + 1;
    if (run.cause !== null) causes[run.cause] = (causes[run.cause] ?? 0) + 1;
    if (run.state === "refused" && run.cause === "capacity") capacityRefusals += 1;
    if (run.leasedMs !== null && run.settledMs !== null && run.settledMs >= run.leasedMs) {
      latencies.push(run.settledMs - run.leasedMs);
    }
    if (run.workerPid !== null) {
      runsWithWorker += 1;
      pidRuns.set(run.workerPid, (pidRuns.get(run.workerPid) ?? 0) + 1);
    }
  }
  let sharedWorkerRuns = 0;
  for (const count of pidRuns.values()) {
    if (count > 1) sharedWorkerRuns += count;
  }
  latencies.sort((a, b) => a - b);

  const newestRuns = [...runs.values()]
    .sort((a, b) => b.lastMs - a.lastMs || a.runId.localeCompare(b.runId))
    .slice(0, STATS_NEWEST_RUNS)
    .map((run) => ({
      runId: run.runId.slice(0, SHORT_RUN_ID_CHARS),
      agentId: run.agentId,
      state: run.state,
      cause: run.cause,
      durationMs: Math.max(0, run.lastMs - run.firstMs),
      at: run.lastAt,
    }));

  return {
    runs: runs.size,
    window: { records: records.length, runs: runs.size, truncated, since },
    states,
    causes,
    capacityRefusals,
    settleLatencyMs: {
      p50: latencies.length === 0 ? null : percentile(latencies, 50),
      p90: latencies.length === 0 ? null : percentile(latencies, 90),
      samples: latencies.length,
    },
    workerReuse: {
      runsWithWorker,
      distinctWorkers: pidRuns.size,
      sharedWorkerRuns,
      reuseRate: runsWithWorker === 0 ? 0 : sharedWorkerRuns / runsWithWorker,
    },
    newestRuns,
  };
}

function formatCounts(
  counts: Partial<Record<string, number>>,
  order: readonly string[],
): string {
  const parts = order
    .filter((key) => counts[key] !== undefined)
    .map((key) => `${key}=${counts[key]}`);
  return parts.length === 0 ? "none" : parts.join(" ");
}

function formatStats(stats: LedgerStats): string {
  const lines = [
    `runs ${stats.runs} | records ${stats.window.records}`
      + `${stats.window.truncated ? " | truncated" : ""}`
      + `${stats.window.since === null ? "" : ` | since ${stats.window.since}`}`,
    `states ${formatCounts(stats.states, STATE_ORDER)}`,
    `causes ${formatCounts(stats.causes, CAUSE_ORDER)}`,
    `latency ${stats.settleLatencyMs.p50 === null
      ? "p50=n/a p90=n/a"
      : `p50=${stats.settleLatencyMs.p50}ms p90=${stats.settleLatencyMs.p90}ms`} (n=${stats.settleLatencyMs.samples})`,
    `workers ${stats.workerReuse.distinctWorkers} pids for ${stats.workerReuse.runsWithWorker} runs;`
      + ` reuse ${(stats.workerReuse.reuseRate * 100).toFixed(1)}%`
      + ` (${stats.workerReuse.sharedWorkerRuns}/${stats.workerReuse.runsWithWorker} runs share a pid);`
      + ` capacity refusals ${stats.capacityRefusals}`,
  ];
  if (stats.newestRuns.length === 0) {
    lines.push("newest: none");
  } else {
    lines.push("newest:");
    for (const run of stats.newestRuns) {
      lines.push(`  ${run.runId} ${run.agentId} ${run.state} ${run.cause ?? "-"} ${run.durationMs}ms ${run.at}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function printStats(
  rootDir: string,
  io: CliIo,
  options: { json: boolean; sinceMs: number | null },
): Promise<number> {
  // Bounded tail read: the operator view never loads the whole journal and
  // never writes it, so it is safe beside a live host and a torn append.
  const tail = await readLedgerTail(rootDir);
  const cutoff = options.sinceMs === null ? null : Date.now() - options.sinceMs;
  const records = cutoff === null
    ? tail.records
    : tail.records.filter((record) => {
      const at = Date.parse(record.at);
      return Number.isFinite(at) && at >= cutoff;
    });
  const stats = summarizeStats(
    records,
    tail.truncated,
    cutoff === null ? null : new Date(cutoff).toISOString(),
  );
  io.out(options.json ? `${JSON.stringify(stats)}\n` : formatStats(stats));
  return 0;
}
