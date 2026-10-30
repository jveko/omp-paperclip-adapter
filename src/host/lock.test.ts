import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireHostLock, readProcessStartIdentity } from "./socket.js";

describe("host lock publication", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "omp-lock-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a fresh, unreadable lock instead of reclaiming it mid-publish", async () => {
    const target = path.join(root, "host.lock");
    await writeFile(target, "", { mode: 0o600 });
    await expect(acquireHostLock(root)).rejects.toThrow(/starting|running/);
  });

  it("reclaims an old unreadable lock", async () => {
    const target = path.join(root, "host.lock");
    await writeFile(target, "{garbage", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(target, old, old);
    const lock = await acquireHostLock(root);
    await lock.release();
  });

  it("reclaims a lock whose pid is dead and refuses one whose pid is live", async () => {
    const target = path.join(root, "host.lock");
    await writeFile(target, JSON.stringify({ pid: 2_000_000, startIdentity: null }), { mode: 0o600 });
    const lock = await acquireHostLock(root);
    await lock.release();
    await writeFile(target, JSON.stringify({
      pid: process.pid, startIdentity: await readProcessStartIdentity(process.pid),
    }), { mode: 0o600 });
    await expect(acquireHostLock(root)).rejects.toThrow(/another omp-host/);
  });
});
