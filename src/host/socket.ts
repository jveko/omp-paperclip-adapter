import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
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

export function hostDiscoveryPath(): string {
  return path.join(hostRootDir(), "host.json");
}

export function socketPathFor(token: string): string {
  return path.join(hostRootDir(), `host-${token}.sock`);
}

/** A fresh filename token; 24 hex chars keeps well under the 108-byte sun_path limit. */
export function newHostToken(): string {
  return randomBytes(12).toString("hex");
}

/** Create the host directory and force its mode: mkdir's mode is umask-masked. */
export async function ensureHostDir(): Promise<void> {
  await mkdir(hostRootDir(), { recursive: true, mode: 0o700 });
  await chmod(hostRootDir(), 0o700);
}

export async function writeDiscovery(discovery: HostDiscovery): Promise<void> {
  await ensureHostDir();
  const target = hostDiscoveryPath();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(discovery, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

export async function clearDiscovery(): Promise<void> {
  await unlink(hostDiscoveryPath()).catch(() => {});
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
export async function readDiscovery(): Promise<HostDiscovery | null> {
  try {
    return parseDiscovery(await readFile(hostDiscoveryPath(), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The pid's start identity, in a form comparable across calls:
 * `linux:<starttime ticks>` on Linux (field 22 of `/proc/<pid>/stat`), otherwise
 * `ps:<lstart>`; null when the process is gone or unreadable. A reused pid has a
 * different identity, which is exactly what stale-socket takeover needs.
 */
export async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // Field 2 (`comm`) may contain spaces and parentheses: split after the
      // last `)`, where fields 3.. follow. starttime is field 22 -> index 19.
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
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
