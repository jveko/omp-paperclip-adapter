import {
  chmod, mkdir, readFile, readdir, readlink, rename, rmdir, symlink, unlink, writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Credentials, Manifests } from "./protocol.js";

/**
 * The per-run credential context (reshape-architecture.md §3.3, C5).
 *
 * A warm worker's env cannot change, so the run JWT cannot live there. Each
 * worker gets its own stable directory and its env carries one path into it:
 *
 *   run-context/<workerId>/<runId>.json   the 0600 credential record
 *   run-context/<workerId>/current.json   an atomically replaced pointer to it
 *
 * The directory is per worker (not host-global) because concurrent runs share
 * this host: a single `current.json` would let run B's begin rebind the file
 * run A's bridge reads, writing A's approvals as B's company. One worker runs
 * at most one run at a time, so a per-worker pointer cannot be rebound under a
 * live run.
 *
 * The bridge re-reads `current.json` per call, so a run's token never outlives
 * its settle, and a crashed host's leftovers are reaped on the next start.
 */

export const RUN_CONTEXT_FILE = "current.json";
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertWorkerId(workerId: string): void {
  if (!WORKER_ID.test(workerId) || workerId === "." || workerId === "..") {
    throw new Error(`invalid run-context worker id '${workerId}'`);
  }
}

export interface RunContextRecord {
  v: 1;
  runId: string;
  credentials: Credentials;
  manifests: Manifests;
}

export function runContextRoot(hostRoot: string): string {
  return path.join(hostRoot, "run-context");
}

export function runContextDir(hostRoot: string, workerId: string): string {
  assertWorkerId(workerId);
  return path.join(runContextRoot(hostRoot), workerId);
}

export function runContextPointer(hostRoot: string, workerId: string): string {
  return path.join(runContextDir(hostRoot, workerId), RUN_CONTEXT_FILE);
}

/**
 * Write the run's record and point the worker's stable path at it. The record is
 * written first (0600), then `current.json` is replaced atomically: a bridge call
 * either sees the previous run's complete record or this run's, never a partial
 * file. Returns the env-stable path.
 */
export async function writeRunContext(
  hostRoot: string,
  workerId: string,
  runId: string,
  credentials: Credentials,
  manifests: Manifests,
): Promise<string> {
  const dir = runContextDir(hostRoot, workerId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const record: RunContextRecord = { v: 1, runId, credentials, manifests };
  const target = path.join(dir, `${runId}.json`);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);

  const pointer = path.join(dir, RUN_CONTEXT_FILE);
  const pointerTmp = `${pointer}.${process.pid}.${Date.now()}.tmp`;
  try {
    await symlink(path.basename(target), pointerTmp);
    await rename(pointerTmp, pointer);
  } catch {
    // Filesystems without symlinks: the pointer becomes a plain copy. The
    // bridge reads either shape the same way, and clear/reap can tell them apart.
    await writeFile(pointerTmp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(pointerTmp, 0o600);
    await rename(pointerTmp, pointer);
  }
  return pointer;
}

/** The run a pointer names, whether it is a symlink or a plain copy. */
async function pointerRunId(pointer: string): Promise<string | null> {
  try {
    return path.basename(await readlink(pointer)).replace(/\.json$/, "");
  } catch {
    try {
      const record = JSON.parse(await readFile(pointer, "utf8")) as { runId?: unknown };
      return typeof record.runId === "string" ? record.runId : null;
    } catch {
      return null;
    }
  }
}

/**
 * Unlink this run's record and pointer. The worker directory is exclusive to one
 * run at a time, so the pointer can only name this run (or a stale predecessor);
 * the check keeps a late settle from removing a newer run's context.
 */
export async function clearRunContext(hostRoot: string, workerId: string, runId: string): Promise<void> {
  const dir = runContextDir(hostRoot, workerId);
  const pointer = path.join(dir, RUN_CONTEXT_FILE);
  const named = await pointerRunId(pointer);
  if (named === null || named === runId) await unlink(pointer).catch(() => {});
  await unlink(path.join(dir, `${runId}.json`)).catch(() => {});
  await rmdir(dir).catch(() => {});
}

/**
 * Remove leftovers: every worker directory whose pointer names a terminal run,
 * plus individual `<runId>.json` records for terminal runs. Returns how many
 * files were removed.
 */
export async function reapRunContexts(
  hostRoot: string,
  isTerminal: (runId: string) => boolean,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(runContextRoot(hostRoot));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const workerId of entries) {
    if (!WORKER_ID.test(workerId) || workerId === "." || workerId === "..") continue;
    const dir = path.join(runContextRoot(hostRoot), workerId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of files) {
      if (entry === RUN_CONTEXT_FILE || !entry.endsWith(".json")) continue;
      const runId = entry.slice(0, -".json".length);
      if (!isTerminal(runId)) continue;
      await unlink(path.join(dir, entry)).catch(() => {});
      removed += 1;
    }
    const pointer = path.join(dir, RUN_CONTEXT_FILE);
    const named = await pointerRunId(pointer);
    if (named !== null && isTerminal(named)) {
      await unlink(pointer).catch(() => {});
      removed += 1;
    }
    await rmdir(dir).catch(() => {});
  }
  return removed;
}
