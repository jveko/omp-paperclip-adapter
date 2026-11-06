import { mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { RunLedger } from "./ledger.js";
import { profileConfigRoot } from "../server/omp-profile.js";
import { startHost, type RunningHost } from "./server.js";
import { clearDiscovery, readDiscovery, writeDiscovery } from "./socket.js";

describe("omp-host cli", () => {
  let root: string;
  let host: RunningHost | null;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "omp-host-cli-"));
    host = null;
  });

  afterEach(async () => {
    if (host !== null) await host.close("test").catch(() => {});
    host = null;
    await rm(root, { recursive: true, force: true });
  });

  function capture(): { out: string[]; err: string[]; io: Parameters<typeof runCli>[1] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        rootDir: root,
        out: (text: string) => out.push(text),
        err: (text: string) => err.push(text),
      },
    };
  }

  it("tails the ledger", async () => {
    const ledger = await RunLedger.open(root);
    for (const runId of ["run-1", "run-2", "run-3"]) {
      await ledger.append({
        epoch: "e", runId, companyId: "co", agentId: "a", sessionKey: `sk-${runId}`,
        cwd: root, state: "leased",
      });
    }
    await ledger.close();
    const { out, io } = capture();
    expect(await runCli(["ledger", "tail", "2"], io)).toBe(0);
    const lines = out.join("").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ runId: "run-3" });
  });

  it("reports a missing host and a usage error", async () => {
    const missing = capture();
    expect(await runCli(["status"], missing.io)).toBe(1);
    expect(missing.out.join("")).toContain("host not running");
    const bad = capture();
    expect(await runCli(["frobnicate"], bad.io)).toBe(2);
    expect(bad.err.join("")).toContain("unknown command");
    expect(await runCli(["ledger", "tail", "nope"], capture().io)).toBe(2);
  });

  it("reports a running host", async () => {
    host = await startHost({ rootDir: root });
    const { out, io } = capture();
    expect(await runCli(["status"], io)).toBe(0);
    expect(out.join("")).toMatch(/^host 0\.12\.0 pid=\d+ epoch=host-[0-9a-f]+ workers=0$/m);
    expect(out.join("")).toMatch(/^socket 0600 owner=\d+ ok$/m);
  }, 20_000);

  it("refuses to gc while a supervisor is live", async () => {
    host = await startHost({ rootDir: root });
    const { err, io } = capture();
    expect(await runCli(["gc"], io)).toBe(1);
    expect(err.join("")).toMatch(/refusing to gc|another omp-host/);
    // The live host's ledger was not compacted or reaped.
    expect(host.workers).toBe(0);
  }, 20_000);

  it("gc removes a crashed host's stale discovery and socket", async () => {
    const socket = path.join(root, "host-deadbeef.sock");
    await writeFile(socket, "");
    await writeDiscovery({
      v: 1, socket, token: "deadbeef", pid: 2_000_000, startedAt: "x",
      startIdentity: null, epoch: "host-dead", version: "0.12.0",
    }, root);
    const { out, io } = capture();
    expect(await runCli(["gc"], io)).toBe(0);
    expect(out.join("")).toContain("socket=removed");
    expect(await readDiscovery(root)).toBeNull();
    await expect(stat(socket)).rejects.toThrow();
  });

  it("stop on a stale record cleans it and says so", async () => {
    const socket = path.join(root, "host-deadbeef.sock");
    await writeFile(socket, "");
    await writeDiscovery({
      v: 1, socket, token: "deadbeef", pid: 2_000_000, startedAt: "x",
      startIdentity: null, epoch: "host-dead", version: "0.12.0",
    }, root);
    const { out, io } = capture();
    expect(await runCli(["stop"], io)).toBe(0);
    expect(out.join("")).toContain("host not running");
    await clearDiscovery(root);
  });
});

describe("omp-host stats", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "omp-host-stats-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function capture(): { out: string[]; err: string[]; io: Parameters<typeof runCli>[1] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { rootDir: root, out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    };
  }

  function worker(pid: number) {
    return {
      pid,
      pgid: pid,
      startedAt: "2026-10-01T00:00:00.000Z",
      startIdentity: `linux:${pid}`,
      argvHash: "argv",
      bridgeHash: "bridge",
      ompVersion: "18.14.0",
    };
  }

  function record(
    seq: number,
    runId: string,
    sessionKey: string,
    state: string,
    at: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      v: 1,
      seq,
      at,
      epoch: "host-test",
      runId,
      companyId: "co",
      agentId: "agent-1",
      sessionKey,
      cwd: "/tmp/work",
      state,
      ...extra,
    };
  }

  /** The ledger as a fixture writes it: one line per transition, in order. */
  const FIXTURE = [
    record(1, "run-alpha", "sk-a", "leased", "2026-10-01T00:00:00.000Z", { worker: worker(100) }),
    record(2, "run-alpha", "sk-a", "settled", "2026-10-01T00:00:02.000Z", {
      worker: worker(100),
      detail: { stopReason: "end_turn", agentInvoked: true, prompt: "PROMPT-SENTINEL", apiKey: "jwt-SENTINEL" },
    }),
    record(3, "run-alpha", "sk-a", "closed", "2026-10-01T00:00:02.100Z", { cause: "clean" }),
    record(4, "run-bravo", "sk-b", "leased", "2026-10-01T00:01:00.000Z", { worker: worker(100) }),
    record(5, "run-bravo", "sk-b", "settled", "2026-10-01T00:01:04.000Z", {
      worker: worker(100),
      detail: { stopReason: "end_turn", agentInvoked: true },
    }),
    record(6, "run-bravo", "sk-b", "closed", "2026-10-01T00:01:04.100Z", { cause: "clean" }),
    record(7, "run-charlie", "sk-c", "refused", "2026-10-01T00:02:00.000Z", { cause: "capacity" }),
    record(8, "run-delta", "sk-d", "leased", "2026-10-01T00:03:00.000Z", { worker: worker(200) }),
    record(9, "run-delta", "sk-d", "lost", "2026-10-01T00:03:05.000Z", {
      cause: "worker_exit", worker: worker(200),
    }),
    record(10, "run-echo", "sk-e", "prompting", "2026-10-01T00:04:00.000Z", { worker: worker(200) }),
    record(11, "run-foxtrot", "sk-f", "leased", "2026-10-01T00:05:00.000Z", { worker: worker(300) }),
    record(12, "run-foxtrot", "sk-f", "closed", "2026-10-01T00:05:01.000Z", { cause: "clean" }),
  ];

  async function writeFixture(lines: readonly unknown[]): Promise<string> {
    const file = path.join(root, "ledger.jsonl");
    await writeFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
    return file;
  }

  it("summarizes the ledger as JSON with exact counts and latencies", async () => {
    await writeFixture(FIXTURE);
    const { out, io } = capture();
    expect(await runCli(["stats", "--json"], io)).toBe(0);
    const stats = JSON.parse(out.join(""));

    expect(stats.window).toMatchObject({ records: 12, runs: 6, truncated: false, since: null });
    expect(stats.runs).toBe(6);
    expect(stats.states).toEqual({ settled: 2, refused: 1, lost: 1, prompting: 1, closed: 1 });
    expect(stats.causes).toEqual({ clean: 3, capacity: 1, worker_exit: 1 });
    expect(stats.capacityRefusals).toBe(1);
    // leased->settled: 2000ms and 4000ms (nearest-rank p50/p90).
    expect(stats.settleLatencyMs).toEqual({ p50: 2000, p90: 4000, samples: 2 });
    expect(stats.workerReuse).toEqual({
      runsWithWorker: 5, distinctWorkers: 3, sharedWorkerRuns: 4, reuseRate: 0.8,
    });

    expect(stats.newestRuns.map((run: { runId: string }) => run.runId)).toEqual([
      "run-foxt", "run-echo", "run-delt", "run-char", "run-brav", "run-alph",
    ]);
    expect(stats.newestRuns[0]).toEqual({
      runId: "run-foxt",
      agentId: "agent-1",
      state: "closed",
      cause: "clean",
      durationMs: 1000,
      at: "2026-10-01T00:05:01.000Z",
    });
    // Content fields on a record have no path into the summary: only ids and
    // accounting are projected.
    expect(out.join("")).not.toContain("PROMPT-SENTINEL");
    expect(out.join("")).not.toContain("jwt-SENTINEL");
  });

  it("prints a human summary", async () => {
    await writeFixture(FIXTURE);
    const { out, io } = capture();
    expect(await runCli(["stats"], io)).toBe(0);
    const text = out.join("");
    expect(text).toContain("runs 6");
    expect(text).toContain("records 12");
    expect(text).toContain("settled=2");
    expect(text).toContain("capacity=1");
    expect(text).toContain("p50=2000ms p90=4000ms (n=2)");
    expect(text).toContain("reuse 80.0% (4/5 runs share a pid)");
    expect(text).toContain("run-foxt agent-1 closed clean 1000ms");
  });

  it("prints a zero summary for an empty ledger, not an error", async () => {
    const missing = capture();
    expect(await runCli(["stats", "--json"], missing.io)).toBe(0);
    expect(JSON.parse(missing.out.join(""))).toMatchObject({
      runs: 0,
      window: { records: 0, runs: 0, truncated: false },
      states: {},
      causes: {},
      capacityRefusals: 0,
      settleLatencyMs: { p50: null, p90: null, samples: 0 },
      workerReuse: { runsWithWorker: 0, distinctWorkers: 0, sharedWorkerRuns: 0, reuseRate: 0 },
      newestRuns: [],
    });

    await writeFile(path.join(root, "ledger.jsonl"), "", "utf8");
    const empty = capture();
    expect(await runCli(["stats"], empty.io)).toBe(0);
    expect(empty.out.join("")).toContain("runs 0");
    expect(empty.out.join("")).toContain("p50=n/a p90=n/a (n=0)");
  });

  it("never writes the ledger and tolerates a torn tail", async () => {
    const file = await writeFixture(FIXTURE);
    // A crash mid-append leaves half a line; a live host may hold an unread byte.
    await writeFile(file, `${JSON.stringify(FIXTURE[0])}\n{"v":1,"seq":13,`, "utf8");
    const before = await readFile(file);
    const { out, io } = capture();
    expect(await runCli(["stats", "--json"], io)).toBe(0);
    expect(JSON.parse(out.join("")).runs).toBe(1);
    expect(await readFile(file)).toEqual(before);
  });

  it("filters with --since and rejects a malformed duration", async () => {
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();
    await writeFixture([
      record(1, "run-old", "sk-1", "closed", iso(48 * 3_600_000), { cause: "clean" }),
      record(2, "run-new", "sk-2", "closed", iso(1_000), { cause: "clean" }),
    ]);

    const recent = capture();
    expect(await runCli(["stats", "--json", "--since", "1h"], recent.io)).toBe(0);
    const stats = JSON.parse(recent.out.join(""));
    expect(stats.runs).toBe(1);
    expect(stats.newestRuns[0].runId).toBe("run-new");
    expect(stats.window.since).toMatch(/Z$/);

    const all = capture();
    expect(await runCli(["stats", "--json", "--since", "7d"], all.io)).toBe(0);
    expect(JSON.parse(all.out.join("")).runs).toBe(2);

    for (const bad of ["1h30", "banana", "0s", "-5m"]) {
      const invalid = capture();
      expect(await runCli(["stats", "--since", bad], invalid.io)).toBe(2);
      expect(invalid.err.join("")).toContain("--since");
    }

    const unknown = capture();
    expect(await runCli(["stats", "--bogus"], unknown.io)).toBe(2);
  });

  it("summarizes a 10k-record ledger under a second", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      lines.push(JSON.stringify(record(
        i + 1,
        `run-${i}`,
        `sk-${i}`,
        i % 2 === 0 ? "leased" : "closed",
        new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 1000).toISOString(),
        i % 2 === 0 ? { worker: worker(1000 + i) } : { cause: "clean" },
      )));
    }
    await writeFile(path.join(root, "ledger.jsonl"), `${lines.join("\n")}\n`, "utf8");

    const { out, io } = capture();
    const started = performance.now();
    expect(await runCli(["stats", "--json"], io)).toBe(0);
    const elapsedMs = performance.now() - started;
    expect(JSON.parse(out.join("")).runs).toBe(10_000);
    expect(elapsedMs).toBeLessThan(1_000);
  }, 20_000);
});

describe("omp-host profile rm", () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "omp-host-profile-home-"));
    root = path.join(home, "host-root");
    await mkdir(root, { recursive: true });
    vi.stubEnv("HOME", home);
    // A relative config dir keeps profileConfigRoot inside the temp HOME.
    vi.stubEnv("PI_CONFIG_DIR", "omp-config");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function capture(): { out: string[]; err: string[]; io: Parameters<typeof runCli>[1] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { rootDir: root, out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    };
  }

  it("removes a profile's config root and names the directory", async () => {
    const name = "pc-inst-1-co-1-agent-1";
    const dir = profileConfigRoot(name);
    await mkdir(path.join(dir, "agent"), { recursive: true });
    await writeFile(path.join(dir, "config.yml"), "providers: {}\n", "utf8");
    expect(dir.startsWith(home)).toBe(true);

    const { out, io } = capture();
    expect(await runCli(["profile", "rm", name], io)).toBe(0);
    expect(out.join("")).toContain(dir);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("exits 1 when the profile does not exist", async () => {
    expect(await runCli(["profile", "rm", "pc-inst-1-co-1-missing"], capture().io)).toBe(1);
  });

  it("exits 2 for an invalid or missing name", async () => {
    expect(await runCli(["profile", "rm", "Bad Name"], capture().io)).toBe(2);
    expect(await runCli(["profile", "rm", ".."], capture().io)).toBe(2);
    expect(await runCli(["profile", "rm"], capture().io)).toBe(2);
  });
});
