import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_LEASE_DIR, acquireSessionLease, sessionLeaseKey, type SessionLease,
} from "./session-lease.js";

type AcquiredLease = { ok: true; release: () => Promise<void> };

interface LeaseRecord {
  owner: string;
  pid: number;
  startedAt: string;
  expiresAt: string;
  sessionKey: string;
}

/** A pid above every supported platform's pid_max, so it can never name a live process. */
const DEAD_PID = 2_147_483_647;

function expectAcquired(lease: SessionLease): asserts lease is AcquiredLease {
  expect(lease.ok).toBe(true);
  if (!lease.ok) throw new Error(`expected the lease to be acquired, got: ${lease.error}`);
}

function leaseFile(dir: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return path.join(dir, SESSION_LEASE_DIR, `${digest}.json`);
}

async function writeLeaseRecord(dir: string, key: string, record: LeaseRecord): Promise<string> {
  const file = leaseFile(dir, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(record), "utf8");
  return file;
}

async function readLeaseRecord(file: string): Promise<LeaseRecord> {
  return JSON.parse(await readFile(file, "utf8")) as LeaseRecord;
}

describe("sessionLeaseKey", () => {
  const agent = { companyId: "company-abc", id: "agent-xyz" };

  it("returns sessionParams.sessionKey when it is a non-empty string", () => {
    expect(
      sessionLeaseKey(agent, { sessionParams: { sessionKey: "session-key-1" }, taskKey: "task-42" }),
    ).toBe("session-key-1");
  });

  it("falls back to a key carrying company, agent and task", () => {
    const cases: Array<{ name: string; runtime: Parameters<typeof sessionLeaseKey>[1]; task: string }> = [
      { name: "task key present", runtime: { sessionParams: null, taskKey: "task-42" }, task: "task-42" },
      { name: "task key absent", runtime: { sessionParams: undefined, taskKey: undefined }, task: "default" },
      { name: "empty sessionKey", runtime: { sessionParams: { sessionKey: "" }, taskKey: "task-42" }, task: "task-42" },
      { name: "non-string sessionKey", runtime: { sessionParams: { sessionKey: 42 }, taskKey: "task-7" }, task: "task-7" },
    ];

    for (const { name, runtime, task } of cases) {
      const key = sessionLeaseKey(agent, runtime);
      expect(key, name).toContain("company-abc");
      expect(key, name).toContain("agent-xyz");
      expect(key, name).toContain(task);
    }
  });

  it("returns different keys for different tasks of one agent", () => {
    const first = sessionLeaseKey(agent, { sessionParams: null, taskKey: "task-a" });
    const second = sessionLeaseKey(agent, { sessionParams: null, taskKey: "task-b" });
    expect(first).not.toBe(second);
  });
});

describe("acquireSessionLease", () => {
  let dir: string;
  const dirs: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "omp-session-lease-"));
    dirs.push(dir);
  });

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
  });

  it("writes a sha256-named record with the lease fields", async () => {
    const lease = await acquireSessionLease({ dir, key: "lease-key-1" });
    expectAcquired(lease);

    const files = await readdir(path.join(dir, SESSION_LEASE_DIR));
    const expectedName = `${createHash("sha256").update("lease-key-1").digest("hex").slice(0, 32)}.json`;
    expect(files).toEqual([expectedName]);

    const record = await readLeaseRecord(path.join(dir, SESSION_LEASE_DIR, expectedName));
    expect(Object.keys(record).sort()).toEqual(["expiresAt", "owner", "pid", "sessionKey", "startedAt"]);
    expect(record.sessionKey).toBe("lease-key-1");
    expect(record.pid).toBe(process.pid);
    const startedAt = Date.parse(record.startedAt);
    const expiresAt = Date.parse(record.expiresAt);
    expect(Number.isFinite(startedAt)).toBe(true);
    expect(Number.isFinite(expiresAt)).toBe(true);
    expect(expiresAt).toBeGreaterThan(startedAt);

    await lease.release();
  });

  it("refuses a second acquire on a key whose owner is alive, naming the pid", async () => {
    const first = await acquireSessionLease({ dir, key: "lease-held" });
    expectAcquired(first);

    const second = await acquireSessionLease({ dir, key: "lease-held" });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected the second acquire to be refused");
    expect(second.error).toContain(String(process.pid));

    await first.release();
  });

  it("allows a fresh acquire after release", async () => {
    const first = await acquireSessionLease({ dir, key: "lease-released" });
    expectAcquired(first);
    await first.release();

    const second = await acquireSessionLease({ dir, key: "lease-released" });
    expectAcquired(second);
    const record = await readLeaseRecord(leaseFile(dir, "lease-released"));
    expect(record.sessionKey).toBe("lease-released");

    await second.release();
  });

  it("reclaims a record whose pid is dead", async () => {
    const now = Date.now();
    await writeLeaseRecord(dir, "lease-dead", {
      owner: "dead-owner",
      pid: DEAD_PID,
      startedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      sessionKey: "lease-dead",
    });

    const lease = await acquireSessionLease({ dir, key: "lease-dead" });
    expectAcquired(lease);
    const record = await readLeaseRecord(leaseFile(dir, "lease-dead"));
    expect(record.pid).toBe(process.pid);
    expect(record.owner).not.toBe("dead-owner");

    await lease.release();
  });

  it("reclaims an expired record even when its pid is still alive", async () => {
    const now = Date.now();
    await writeLeaseRecord(dir, "lease-expired", {
      owner: "expired-owner",
      pid: process.pid,
      startedAt: new Date(now - 7_200_000).toISOString(),
      expiresAt: new Date(now - 60_000).toISOString(),
      sessionKey: "lease-expired",
    });

    const lease = await acquireSessionLease({ dir, key: "lease-expired" });
    expectAcquired(lease);
    const record = await readLeaseRecord(leaseFile(dir, "lease-expired"));
    expect(record.owner).not.toBe("expired-owner");
    expect(Date.parse(record.expiresAt)).toBeGreaterThan(now);

    await lease.release();
  });

  it("lets two different keys hold leases in the same directory", async () => {
    const [first, second] = await Promise.all([
      acquireSessionLease({ dir, key: "lease-key-a" }),
      acquireSessionLease({ dir, key: "lease-key-b" }),
    ]);
    expectAcquired(first);
    expectAcquired(second);

    const files = await readdir(path.join(dir, SESSION_LEASE_DIR));
    expect(files.sort()).toEqual(
      [path.basename(leaseFile(dir, "lease-key-a")), path.basename(leaseFile(dir, "lease-key-b"))].sort(),
    );

    await Promise.all([first.release(), second.release()]);
  });

  it("does not delete a record another owner replaced before release", async () => {
    const lease = await acquireSessionLease({ dir, key: "lease-swapped" });
    expectAcquired(lease);

    const now = Date.now();
    const foreign: LeaseRecord = {
      owner: "intruder-owner",
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      sessionKey: "lease-swapped",
    };
    const file = await writeLeaseRecord(dir, "lease-swapped", foreign);

    await lease.release();

    const record = await readLeaseRecord(file);
    expect(record.owner).toBe("intruder-owner");
  });
});
