import { link, mkdir, open, readFile, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * Per-session, cross-process exclusion for a run.
 *
 * The engine refuses to reuse a warm handle for a run that carries a
 * run-scoped credential (and this adapter pins reuse off), so consecutive
 * heartbeats are close-and-relaunch. Two overlapping runs of the SAME omp
 * session are then two processes writing one session file. omp does not
 * corrupt that file — the non-owner silently moves the session to a fresh
 * sibling id on its first write (`session/session-manager.ts` `#claimSession`)
 * — which is worse for an employee: the transcript forks invisibly and the
 * later writes land in a session the next heartbeat never resumes.
 *
 * The lease is the adapter's own mutual exclusion, under the agent's state dir
 * so every adapter process on the host sees it. A held lease fails the run
 * closed with `omp_session_lease_held`; there is no queue, because a heartbeat
 * that waits is a heartbeat that reports late.
 */

export const SESSION_LEASE_DIR = "leases";

/**
 * Upper bound on a lease's validity when the run configures no timeout. It
 * bounds how long a crashed owner's lease (or a reused pid) can block the
 * employee — a dead pid is reclaimed immediately, this is the backstop. A run
 * with a longer `timeoutSec` gets that plus grace (see execute.ts).
 */
export const DEFAULT_SESSION_LEASE_TTL_MS = 4 * 60 * 60 * 1000;

/** Grace added to a configured run timeout before its lease may be stolen. */
export const SESSION_LEASE_TIMEOUT_GRACE_MS = 5 * 60 * 1000;

const MAX_RECLAIM_ATTEMPTS = 3;

export interface SessionLeaseRecord {
  /** Random per-acquire token; release only removes a record it still owns. */
  owner: string;
  pid: number;
  startedAt: string;
  expiresAt: string;
  /** Diagnostics only: company/agent/task ids and a fingerprint hash, no secrets. */
  sessionKey: string;
}

export type SessionLease =
  | { ok: true; owner: string; release: () => Promise<void> }
  | { ok: false; error: string };

/**
 * The key a run's lease is filed under: the engine's `sessionKey` when the run
 * resumes a persisted session (identical for every overlapping run of that
 * session), else an agent-scoped key so two first-ever runs still serialize.
 */
export function sessionLeaseKey(
  agent: { companyId: string; id: string },
  runtime: { sessionParams?: unknown; taskKey?: unknown },
): string {
  const params = runtime.sessionParams;
  if (typeof params === "object" && params !== null) {
    const stored = (params as Record<string, unknown>).sessionKey;
    if (typeof stored === "string" && stored.trim() !== "") return stored.trim();
  }
  const taskKey = typeof runtime.taskKey === "string" && runtime.taskKey.trim() !== ""
    ? runtime.taskKey.trim()
    : "default";
  return `paperclip:${agent.companyId}:${agent.id}:${taskKey}`;
}

/** `true` when `pid` names a live process (EPERM means it exists, unowned). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function leaseFile(dir: string, key: string): string {
  const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return path.join(dir, SESSION_LEASE_DIR, `${name}.json`);
}

function parseRecord(raw: string): SessionLeaseRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionLeaseRecord>;
    if (typeof parsed.owner !== "string" || parsed.owner === "") return null;
    if (typeof parsed.pid !== "number") return null;
    if (typeof parsed.startedAt !== "string" || typeof parsed.expiresAt !== "string") return null;
    return {
      owner: parsed.owner,
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      expiresAt: parsed.expiresAt,
      sessionKey: typeof parsed.sessionKey === "string" ? parsed.sessionKey : "",
    };
  } catch {
    return null;
  }
}

/** Expired, unreadable, or owned by a process that is gone. */
function isStale(record: SessionLeaseRecord | null, now: number): boolean {
  if (record === null) return true;
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(expires) || now > expires) return true;
  return !pidAlive(record.pid);
}

function heldMessage(record: SessionLeaseRecord, file: string): string {
  return `another omp run (pid ${record.pid}, started ${record.startedAt}) holds this session's lease, `
    + "and two processes must not write one omp session file (the non-owner's session would move "
    + `to a new id and stop being the one this employee resumes). The lease expires at ${record.expiresAt}; `
    + `if that run is gone, delete ${file}.`;
}

/** The canonical lease file's current state, distinguishing "gone" from "unreadable". */
type LeaseScan =
  | { state: "gone" }
  | { state: "record"; record: SessionLeaseRecord | null };

async function scanLease(file: string): Promise<LeaseScan> {
  try {
    return { state: "record", record: parseRecord(await readFile(file, "utf8")) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "gone" };
    // Unreadable is not absent: treat it as a present, unparseable record so a
    // permission oddity cannot be mistaken for a free session.
    return { state: "record", record: null };
  }
}

/**
 * Filesystems without hard links (FAT/exFAT, some FUSE mounts) reject `link`
 * with one of these; the claim then falls back to an exclusive create.
 */
const LINK_UNSUPPORTED: Record<string, true> = {
  EPERM: true, ENOTSUP: true, ENOSYS: true, EXDEV: true, EOPNOTSUPP: true,
};

/**
 * Fallback claim for a filesystem without hard links: `open(wx)` then write,
 * then verify the path still resolves to the inode this handle wrote. The file
 * is briefly EMPTY between open and write, so a concurrent acquirer can remove
 * it in that window; the inode check detects exactly that and retries instead
 * of claiming a file someone else now owns.
 */
async function claimExclusive(
  file: string,
  record: SessionLeaseRecord,
): Promise<{ state: "claimed" | "exists" | "retry" } | { state: "error"; error: string }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, "wx");
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    const mine = await handle.stat();
    await handle.close();
    handle = undefined;
    const onPath = await stat(file).catch(() => null);
    if (!onPath || onPath.ino !== mine.ino) return { state: "retry" };
    return { state: "claimed" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return { state: "exists" };
    // A failed write/close may leave a record naming this (live) pid, which
    // would refuse every run for this session until its TTL. Remove only a
    // record this call owns.
    if (handle) {
      await handle.close().catch(() => {});
      const onPath = await readFile(file, "utf8").then(parseRecord).catch(() => null);
      if (onPath?.owner === record.owner) await unlink(file).catch(() => {});
    }
    return { state: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Publish a complete record at `file`, or report that one already exists.
 *
 * Written to a unique temp file first and then `link`ed into place: `link` is
 * atomic create-if-absent, so the canonical path never holds a partially
 * written record. `open(wx)` + write would expose an EMPTY file between the
 * two calls, and a concurrent acquirer reading that emptiness as "stale" could
 * evict a claim that is about to succeed — two holders on one session.
 */
async function claim(
  file: string,
  record: SessionLeaseRecord,
): Promise<{ state: "claimed" | "exists" | "retry" } | { state: "error"; error: string }> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await link(tmp, file);
    return { state: "claimed" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return { state: "exists" };
    if (LINK_UNSUPPORTED[code]) return claimExclusive(file, record);
    return { state: "error", error: err instanceof Error ? err.message : String(err) };
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Claim the run's session lease. Succeeds when the file is absent, or when the
 * holder is provably gone (dead pid) or past its TTL. Never throws.
 */
export async function acquireSessionLease(input: {
  dir: string;
  key: string;
  ttlMs?: number;
  pid?: number;
  now?: number;
}): Promise<SessionLease> {
  const file = leaseFile(input.dir, input.key);
  const now = input.now ?? Date.now();
  const pid = input.pid ?? process.pid;
  const ttl = Math.max(
    DEFAULT_SESSION_LEASE_TTL_MS,
    Number.isFinite(input.ttlMs) ? Number(input.ttlMs) : 0,
  );
  const record: SessionLeaseRecord = {
    owner: randomUUID(),
    pid,
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    sessionKey: input.key,
  };
  try {
    await mkdir(path.dirname(file), { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not create the session lease dir: ${err instanceof Error ? err.message : String(err)}` };
  }

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    const claimed = await claim(file, record);
    if (claimed.state === "retry") continue;
    if (claimed.state === "error") {
      return { ok: false, error: `could not write the session lease: ${claimed.error}` };
    }
    if (claimed.state === "claimed") {
      const owner = record.owner;
      return {
        ok: true,
        owner,
        release: async () => {
          try {
            const current = parseRecord(await readFile(file, "utf8"));
            if (current?.owner === owner) await unlink(file);
          } catch {
            // A missing/altered lease file is not the run's failure to report.
          }
        },
      };
    }

    const scan = await scanLease(file);
    if (scan.state === "gone") {
      // Another process removed it between the claim and this read: retry the
      // claim instead of unlinking anything (there is nothing to unlink).
      continue;
    }
    if (!isStale(scan.record, now)) {
      return { ok: false, error: heldMessage(scan.record as SessionLeaseRecord, file) };
    }
    // Re-read right before removing: another process may have replaced the
    // stale record with a live one since the read above, and an
    // unconditional unlink would erase a legitimate holder. A changed owner
    // means this round lost the race — loop and read it as held. A record that
    // is still unparseable is a crashed/legacy file (this module never
    // publishes partial ones) and is reclaimed.
    const latest = await scanLease(file);
    if (latest.state === "gone") continue;
    if (latest.record !== null && latest.record.owner !== scan.record?.owner) continue;
    // Reclaim: remove the stale record and race the next claim with any other
    // process doing the same. A lost race is just another held/retry round.
    // (POSIX has no atomic compare-and-unlink, so the window between this
    // read and the unlink is the one residual race; the temp-file claim keeps
    // a stolen file from ever being a *partial* record.)
    await unlink(file).catch(() => {});
    continue;
  }
  return {
    ok: false,
    error: `the session lease for this omp session kept being reclaimed by another run; `
      + `refusing to start a second writer for ${file}.`,
  };
}
