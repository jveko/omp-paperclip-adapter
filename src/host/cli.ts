import { unlink } from "node:fs/promises";
import { HostClient } from "./client.js";
import { readLedgerRecords } from "./ledger.js";
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
