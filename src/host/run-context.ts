import { chmod, mkdir, readFile, readdir, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Credentials, Manifests } from "./protocol.js";

/**
 * The per-run credential context (reshape-architecture.md §3.3, C5).
 *
 * A warm worker's env cannot change, so the run JWT cannot live there. The
 * worker's env carries one stable path (`PAPERCLIP_RUN_CONTEXT`) and the host
 * rebinds the file behind it before each prompt:
 *
 *   run-context/<runId>.json   the 0600 credential + manifest record
 *   run-context/current.json   an atomically replaced symlink to it
 *
 * The bridge re-reads `current.json` per call, so a run's token never outlives
 * its settle (the file and the pointer are unlinked together) and a crashed
 * host's leftovers are reaped on the next start.
 */

export const RUN_CONTEXT_FILE = "current.json";

export interface RunContextRecord {
  v: 1;
  runId: string;
  credentials: Credentials;
  manifests: Manifests;
}

export function runContextDir(hostRoot: string): string {
  return path.join(hostRoot, "run-context");
}

export function runContextPointer(hostRoot: string): string {
  return path.join(runContextDir(hostRoot), RUN_CONTEXT_FILE);
}

/**
 * Write the run's record and point the stable path at it. The record is written
 * first (0600), then `current.json` is replaced atomically: a bridge call
 * either sees the previous run's complete record or this run's, never a partial
 * file. Returns the env-stable path.
 */
export async function writeRunContext(
  hostRoot: string,
  runId: string,
  credentials: Credentials,
  manifests: Manifests,
): Promise<string> {
  const dir = runContextDir(hostRoot);
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
    // bridge reads either shape the same way.
    await writeFile(pointerTmp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(pointerTmp, 0o600);
    await rename(pointerTmp, pointer);
  }
  return pointer;
}

/**
 * Unlink this run's record and, only when it still points at this run, the
 * stable pointer. A newer run's context is never removed by an older settle.
 */
export async function clearRunContext(hostRoot: string, runId: string): Promise<void> {
  const dir = runContextDir(hostRoot);
  const pointer = path.join(dir, RUN_CONTEXT_FILE);
  try {
    const link = await readlink(pointer);
    if (path.basename(link) === `${runId}.json`) await unlink(pointer);
  } catch {
    // A plain-copy pointer (or no pointer) cannot name a run; leave the pointer
    // to reapRunContexts, which reads the record it contains.
  }
  await unlink(path.join(dir, `${runId}.json`)).catch(() => {});
}

/**
 * Remove leftovers: every `<runId>.json` whose run is terminal, plus a pointer
 * that names a terminal or missing run. Returns how many files were removed.
 */
export async function reapRunContexts(
  hostRoot: string,
  isTerminal: (runId: string) => boolean,
): Promise<number> {
  const dir = runContextDir(hostRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (entry === RUN_CONTEXT_FILE || !entry.endsWith(".json")) continue;
    const runId = entry.slice(0, -".json".length);
    if (!isTerminal(runId)) continue;
    await unlink(path.join(dir, entry)).catch(() => {});
    removed += 1;
  }
  // The pointer is safe to drop only when it names a terminal run. A symlink
  // names its run; a plain copy carries it in the record.
  const pointer = path.join(dir, RUN_CONTEXT_FILE);
  let pointerRunId = "";
  try {
    pointerRunId = path.basename(await readlink(pointer)).replace(/\.json$/, "");
  } catch {
    try {
      const record = JSON.parse(await readFile(pointer, "utf8")) as { runId?: unknown };
      pointerRunId = typeof record.runId === "string" ? record.runId : "";
    } catch {
      pointerRunId = "";
    }
  }
  if (pointerRunId !== "" && isTerminal(pointerRunId)) {
    await unlink(pointer).catch(() => {});
    removed += 1;
  }
  return removed;
}
