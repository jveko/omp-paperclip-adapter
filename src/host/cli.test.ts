import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { RunLedger } from "./ledger.js";
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
