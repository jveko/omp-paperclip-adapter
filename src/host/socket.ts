import { execFile } from "node:child_process";
import { chmod, link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { pidAlive } from "../server/session-lease.js";

/**
 * Where one instance's supervisor lives on disk.
 *
 * Everything is under `resolvePaperclipInstanceRootForAdapter()` so two
 * Paperclip instances on one host never share a socket, a ledger or a worker.
 * The directory is 0700 and the socket file is named after a random token:
 * only a process that can read the instance root can learn the token, which is
 * the only authentication a single-user host needs (no ports, no HTTP, no auth
 * story to invent).
 *
 * `host.json` is the discovery record the adapter reads to find a running
 * supervisor. It is 0600 and replaced atomically. Its `startIdentity` is what
 * makes a stale record distinguishable from a live one after a pid is reused.
 */

export const HOST_DISCOVERY_VERSION = 1;

/** How long an unreadable lock record is trusted before it is reclaimed. */
const LOCK_PUBLISH_GRACE_MS = 10_000;

export interface HostDiscovery {
  v: typeof HOST_DISCOVERY_VERSION;
  socket: string;
  token: string;
  pid: number;
  startedAt: string;
  /** Process identity from `readProcessStartIdentity`, or null when unreadable. */
  startIdentity: string | null;
  epoch: string;
  version: string;
}

export function hostRootDir(): string {
  return path.join(resolvePaperclipInstanceRootForAdapter(), "omp-host");
}

export function hostDiscoveryIn(rootDir: string): string {
  return path.join(rootDir, "host.json");
}

export function hostLockIn(rootDir: string): string {
  return path.join(rootDir, "host.lock");
}

export function hostDiscoveryPath(): string {
  return hostDiscoveryIn(hostRootDir());
}

export function hostLockPath(): string {
  return hostLockIn(hostRootDir());
}

export function socketPathIn(rootDir: string, token: string): string {
  return path.join(rootDir, `host-${token}.sock`);
}

export function socketPathFor(token: string): string {
  return socketPathIn(hostRootDir(), token);
}

/** A fresh filename token; 24 hex chars keeps well under the 108-byte sun_path limit. */
export function newHostToken(): string {
  return randomBytes(12).toString("hex");
}

/** The socket (or its directory) is not same-uid-only; the host refuses it. */
export class HostSocketSecurityError extends Error {
  constructor(message: string, readonly path: string, readonly mode: number) {
    super(message);
    this.name = "HostSocketSecurityError";
  }
}

export interface SocketSecurity {
  mode: number;
  dirMode: number;
  uid: number;
}

/**
 * Stat the socket and its directory and refuse anything a second user could
 * reach: mode wider than 0600 (socket) / 0700 (directory), or an owner other
 * than this uid. The token in the filename is the only authentication, and it
 * is useless if the directory lists its contents or another user owns either
 * end. Enforced at `serve` startup and at every connect, so "same uid only" is
 * a checked invariant rather than a convention.
 */
export async function checkSocketSecurity(socketPath: string, dir: string): Promise<SocketSecurity> {
  const [socket, directory] = await Promise.all([stat(socketPath), stat(dir)]);
  const mode = socket.mode & 0o777;
  const dirMode = directory.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new HostSocketSecurityError(
      `refusing the omp-host socket ${socketPath}: mode 0${mode.toString(8)} is wider than 0600 (group/other access)`,
      socketPath,
      mode,
    );
  }
  if ((dirMode & 0o077) !== 0) {
    throw new HostSocketSecurityError(
      `refusing the omp-host directory ${dir}: mode 0${dirMode.toString(8)} is wider than 0700 (group/other access)`,
      dir,
      dirMode,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : socket.uid;
  if (socket.uid !== uid) {
    throw new HostSocketSecurityError(
      `refusing the omp-host socket ${socketPath}: owned by uid ${socket.uid}, not this process's uid ${uid}`,
      socketPath,
      mode,
    );
  }
  if (directory.uid !== uid) {
    throw new HostSocketSecurityError(
      `refusing the omp-host directory ${dir}: owned by uid ${directory.uid}, not this process's uid ${uid}`,
      dir,
      dirMode,
    );
  }
  return { mode, dirMode, uid };
}

/** Create the host directory and force its mode: mkdir's mode is umask-masked. */
export async function ensureHostDirIn(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700);
}

export async function ensureHostDir(): Promise<void> {
  await ensureHostDirIn(hostRootDir());
}

/**
 * One supervisor per instance root, enforced by a lock file that is published
 * atomically.
 *
 * The record is written to a temp file and `link`ed into place, so the lock
 * path never holds a partial record: a concurrent starter either sees a
 * complete record (live → refuse) or EEXIST on a record it can judge. Treating
 * an unreadable lock as stale is wrong in the open→write window of a
 * non-atomic create — two hosts would both start, and the loser's reconcile
 * would kill the winner's runs.
 */
export async function acquireHostLock(rootDir: string = hostRootDir()): Promise<{ release: () => Promise<void> }> {
  await ensureHostDirIn(rootDir);
  const target = hostLockIn(rootDir);
  const record = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    startIdentity: await readProcessStartIdentity(process.pid),
  };
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(tmp, target);
        return {
          release: async () => {
            try {
              const current = JSON.parse(await readFile(target, "utf8")) as { pid?: unknown };
              if (current.pid === process.pid) await unlink(target);
            } catch {
              // A missing/altered lock is not this host's failure to report.
            }
          },
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      let holder: { pid?: unknown; startIdentity?: unknown } = {};
      try {
        holder = JSON.parse(await readFile(target, "utf8")) as typeof holder;
      } catch {
        // Unreadable is only stale once it is old enough that no writer can
        // still be publishing it; the temp-file publish makes this window tiny.
        const age = await stat(target).then((info) => Date.now() - info.mtimeMs).catch(() => Infinity);
        if (age < LOCK_PUBLISH_GRACE_MS) {
          throw new Error("another omp-host is starting for this instance (lock being published)");
        }
      }
      const pid = typeof holder.pid === "number" ? holder.pid : 0;
      const identity = typeof holder.startIdentity === "string" ? holder.startIdentity : null;
      const current = pid > 0 ? await readProcessStartIdentity(pid) : null;
      const live = pid > 0 && pidAlive(pid)
        && (identity === null || current === null || identity === current);
      if (live) {
        throw new Error(`another omp-host is running for this instance (pid ${pid})`);
      }
      await unlink(target).catch(() => {});
    }
    throw new Error(`the omp-host lock at ${target} kept being reclaimed; refusing to start a second supervisor`);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function writeDiscovery(
  discovery: HostDiscovery,
  rootDir: string = hostRootDir(),
): Promise<void> {
  await ensureHostDirIn(rootDir);
  const target = hostDiscoveryIn(rootDir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(discovery, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

export async function clearDiscovery(rootDir: string = hostRootDir()): Promise<void> {
  await unlink(hostDiscoveryIn(rootDir)).catch(() => {});
}

/**
 * Remove the discovery record only when it still names this host. A losing or
 * replaced supervisor must never erase the record of the one serving the
 * instance.
 */
export async function clearDiscoveryOwned(rootDir: string, pid: number, epoch: string): Promise<void> {
  const current = await readDiscovery(rootDir);
  if (current === null || current.pid !== pid || current.epoch !== epoch) return;
  await unlink(hostDiscoveryIn(rootDir)).catch(() => {});
}

function parseDiscovery(raw: string): HostDiscovery | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== HOST_DISCOVERY_VERSION) return null;
  if (typeof record.socket !== "string" || typeof record.token !== "string"
    || typeof record.pid !== "number" || typeof record.startedAt !== "string"
    || typeof record.epoch !== "string" || typeof record.version !== "string") {
    return null;
  }
  if (record.startIdentity !== null && typeof record.startIdentity !== "string") return null;
  return record as unknown as HostDiscovery;
}

/** The running supervisor's record, or null when there is none (or it is unreadable). */
export async function readDiscovery(rootDir: string = hostRootDir()): Promise<HostDiscovery | null> {
  try {
    return parseDiscovery(await readFile(hostDiscoveryIn(rootDir), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The pid's start identity, in a form comparable across calls:
 * `linux:<starttime ticks>` on Linux (field 22 of `/proc/<pid>/stat`), otherwise
 * `ps:<lstart>`; null when the process is gone or unreachable. A reused pid has
 * a different identity, which is exactly what stale-socket takeover needs.
 *
 * A zombie still has a `/proc` entry (its parent has not reaped it yet), but it
 * has already exited and will never serve a socket again: it is reported as
 * gone. `pidAlive` is deliberately left as `kill(pid, 0)`, because session
 * leases must not steal from a process that is merely between exit and reaping.
 */
export async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // Field 2 (`comm`) may contain spaces and parentheses: split after the
      // last `)`, where fields 3.. follow. State is field 3 (index 0),
      // starttime is field 22 (index 19).
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      const state = after[0];
      if (state === "Z" || state === "X") return null;
      const starttime = after[19];
      return starttime ? `linux:${starttime}` : null;
    } catch {
      return null;
    }
  }
  const ps = Promise.withResolvers<string | null>();
  execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1_500 },
    (error, stdout) => {
      const value = typeof stdout === "string" ? stdout.trim() : "";
      ps.resolve(error || value === "" ? null : `ps:${value}`);
    });
  return ps.promise;
}

/**
 * True when the discovery record cannot name a live supervisor.
 *
 * `currentIdentity` is the caller's fresh read (null when the process is gone).
 * A live pid whose identity differs from the record is a reused pid, not the
 * supervisor. When the identity cannot be read at all the record is treated as
 * live: refusing to start is recoverable, killing a running supervisor is not.
 */
export function isDiscoveryStale(discovery: HostDiscovery, currentIdentity: string | null): boolean {
  if (!pidAlive(discovery.pid)) return true;
  if (discovery.startIdentity !== null && currentIdentity !== null
    && discovery.startIdentity !== currentIdentity) {
    return true;
  }
  return false;
}
