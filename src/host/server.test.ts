import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, type HostFrame, type HostReply, type RunBeginFrame } from "./protocol.js";
import { startHost, reconcile, type RunningHost } from "./server.js";
import { RunLedger, readLedgerRecords } from "./ledger.js";
import { RUN_CONTEXT_FILE } from "./run-context.js";
import { readProcessStartIdentity } from "./socket.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/fake-rpc.mjs",
);

interface Client {
  frames: HostReply[];
  send(frame: HostFrame): void;
  waitFor(predicate: (frame: HostReply) => boolean): Promise<HostReply>;
  close(): void;
}

function connectClient(socketPath: string): Promise<Client> {
  const socket = net.createConnection(socketPath);
  const frames: HostReply[] = [];
  let buffer = "";
  const opened = Promise.withResolvers<void>();
  socket.once("connect", () => opened.resolve());
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        frames.push(JSON.parse(line) as HostReply);
      } catch {
        // Ignore a partial line from a torn read.
      }
      newline = buffer.indexOf("\n");
    }
  });
  const client: Client = {
    frames,
    send(frame) {
      socket.write(encodeFrame(frame));
    },
    async waitFor(predicate) {
      const found = await vi.waitFor(() => {
        const frame = frames.find(predicate);
        if (frame === undefined) throw new Error("frame not observed yet");
        return frame;
      }, { timeout: 5_000, interval: 10 });
      return found;
    },
    close() {
      socket.destroy();
    },
  };
  return opened.promise.then(() => client);
}

function beginFrame(
  overrides: Partial<RunBeginFrame> & { runId: string; mode?: string } = { runId: "run-1" },
): HostFrame {
  const { mode = "", ...rest } = overrides;
  return {
    id: "b1",
    type: "run.begin",
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1" },
    sessionKey: "paperclip:co-1:agent-1:task",
    cwd: process.cwd(),
    session: { ompSessionId: null },
    cell: {
      argvHash: "argv", bridgeHash: "bridge", agentDir: null,
      model: "prov/m", thinking: "high", approval: "yolo",
    },
    worker: {
      command: process.execPath,
      args: [fixture, "--mode", "rpc"],
      env: { FAKE_RPC_MODE: mode },
    },
    prompt: "do the thing",
    credentials: {
      apiUrl: "http://127.0.0.1:3100", apiKey: "jwt-SENTINEL", companyId: "co-1",
      taskId: null, issueId: null,
    },
    manifests: { skills: null, governance: null, budget: null, failover: null, thinking: null },
    limits: { timeoutMs: 60_000, runLeaseTtlMs: 60_000 },
    ...rest,
  };
}

describe("supervisor", () => {
  let root: string;
  let host: RunningHost | null;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "omp-host-server-"));
    host = null;
  });

  afterEach(async () => {
    if (host !== null) await host.close("test").catch(() => {});
    host = null;
    await rm(root, { recursive: true, force: true });
  });

  async function start(options: Parameters<typeof startHost>[0] = {}): Promise<RunningHost> {
    host = await startHost({ rootDir: root, ...options });
    return host;
  }

  function ledgerStates(): Promise<string[]> {
    return readLedgerRecords(root).then((records) => records.map((record) => record.state));
  }

  it("settles a managed run with a real result and a complete ledger", async () => {
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send({ id: "h1", type: "hello", v: 1, instanceId: "default", adapterVersion: "0.12.0" });
      await client.waitFor((frame) => frame.type === "hello_ok");
      client.send(beginFrame({ runId: "run-1" }));
      const accepted = await client.waitFor((frame) => frame.type === "run.accepted");
      expect(accepted).toMatchObject({ runId: "run-1", sessionOpening: "new", reusedWorker: false });
      const settled = await client.waitFor((frame) => frame.type === "run.settled");
      if (settled.type !== "run.settled") throw new Error("unreachable");
      expect(settled.result).toMatchObject({
        exitCode: 0,
        timedOut: false,
        usageBasis: "per_run",
        sessionParams: { acpSessionId: "sess-new-1", sessionKey: "paperclip:co-1:agent-1:task" },
        model: "prov/m",
      });
      expect(settled.result.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 });
      expect(settled.result.costUsd).toBeCloseTo(0.5);
      expect(settled.result.resultJson).toMatchObject({ transport: "host-rpc", status: "completed", agentInvoked: true });
      expect(client.frames.some((frame) => frame.type === "run.event" && frame.kind === "omp.usage")).toBe(true);
      await vi.waitFor(async () => {
        expect(await ledgerStates()).toEqual([
          "leased", "worker_ready", "session_open", "prompting", "settled", "closed",
        ]);
      });
      await vi.waitFor(async () => {
        const dirs = await readdir(path.join(root, "run-context")).catch(() => []);
        expect(dirs).toEqual([]);
      });
      expect(running.workers).toBe(0);
    } finally {
      client.close();
    }
  }, 20_000);

  it("answers a retried run.begin from the terminal ledger state without prompting twice", async () => {
    const log = path.join(root, "frames.log");
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({ runId: "run-1", worker: {
        command: process.execPath, args: [fixture], env: { FAKE_RPC_MODE: "", FAKE_RPC_LOG: log },
      } }));
      await client.waitFor((frame) => frame.type === "run.settled");
      client.frames.length = 0;
      client.send(beginFrame({ runId: "run-1" }));
      const again = await client.waitFor((frame) => frame.type === "run.settled");
      if (again.type !== "run.settled") throw new Error("unreachable");
      expect(again.result.errorCode).toBe("omp_host_run_ended");
      const prompts = (await readFile(log, "utf8")).split("\n").filter((line) => line.includes('"prompt"'));
      expect(prompts).toHaveLength(1);
    } finally {
      client.close();
    }
  }, 20_000);

  it("refuses a run past maxWorkers instead of thrashing the host", async () => {
    const running = await start({ maxWorkers: 1 });
    const first = await connectClient(running.socketPath);
    const second = await connectClient(running.socketPath);
    try {
      first.send(beginFrame({ runId: "run-1", mode: "hang", sessionKey: "sk-1" }));
      await first.waitFor((frame) => frame.type === "run.accepted");
      second.send(beginFrame({ runId: "run-2", mode: "hang", sessionKey: "sk-2" }));
      const refused = await second.waitFor((frame) => frame.type === "run.settled");
      if (refused.type !== "run.settled") throw new Error("unreachable");
      expect(refused.result.errorCode).toBe("omp_host_capacity");
      expect((await readLedgerRecords(root)).some((record) => record.state === "refused" && record.cause === "capacity")).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  }, 20_000);

  it("expires the run lease, aborts, then kills the worker on the second window", async () => {
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({ runId: "run-1", mode: "deaf", limits: { timeoutMs: 60_000, runLeaseTtlMs: 150 } }));
      const accepted = await client.waitFor((frame) => frame.type === "run.accepted");
      if (accepted.type !== "run.accepted") throw new Error("unreachable");
      const pid = accepted.worker.pid;
      await client.waitFor((frame) => frame.type === "run.settled");
      await vi.waitFor(async () => {
        const records = await readLedgerRecords(root);
        expect(records.some((record) => record.state === "lost" && record.cause === "adapter_gone")).toBe(true);
      });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      client.close();
    }
  }, 20_000);

  it("drains a hung run as lost/host_exit when the host closes", async () => {
    const running = await start({ drainMs: 100 });
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({ runId: "run-1", mode: "hang" }));
      await client.waitFor((frame) => frame.type === "run.accepted");
      await running.close("operator");
      const records = await readLedgerRecords(root);
      const lost = records.filter((record) => record.state === "lost");
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({ runId: "run-1", cause: "host_exit" });
    } finally {
      client.close();
    }
  }, 20_000);

  it("keeps concurrent runs' credential pointers separate", async () => {
    const running = await start({ maxWorkers: 4 });
    const first = await connectClient(running.socketPath);
    const second = await connectClient(running.socketPath);
    try {
      first.send(beginFrame({ runId: "run-1", mode: "hang", sessionKey: "sk-1" }));
      second.send(beginFrame({ runId: "run-2", mode: "hang", sessionKey: "sk-2" }));
      const a = await first.waitFor((frame) => frame.type === "run.accepted");
      const b = await second.waitFor((frame) => frame.type === "run.accepted");
      if (a.type !== "run.accepted" || b.type !== "run.accepted") throw new Error("unreachable");
      expect(a.runContextPath).not.toBe(b.runContextPath);
      const recordA = JSON.parse(await readFile(a.runContextPath, "utf8")) as { runId: string };
      const recordB = JSON.parse(await readFile(b.runContextPath, "utf8")) as { runId: string };
      expect(recordA.runId).toBe("run-1");
      expect(recordB.runId).toBe("run-2");
      // Each worker's pointer resolves inside its own directory, so a second
      // run can never rebind the file the first run's bridge reads.
      expect(path.dirname(a.runContextPath)).not.toBe(path.dirname(b.runContextPath));
    } finally {
      first.close();
      second.close();
    }
  }, 20_000);

  it("writes the run JWT to a 0600 run-context file and removes it after settle", async () => {
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({ runId: "run-1", mode: "hang" }));
      const accepted = await client.waitFor((frame) => frame.type === "run.accepted");
      if (accepted.type !== "run.accepted") throw new Error("unreachable");
      const pointer = accepted.runContextPath;
      expect(pointer.endsWith(RUN_CONTEXT_FILE)).toBe(true);
      expect((await stat(pointer)).mode & 0o777).toBe(0o600);
      const record = JSON.parse(await readFile(pointer, "utf8")) as { runId: string; credentials: { apiKey: string } };
      expect(record.runId).toBe("run-1");
      expect(record.credentials.apiKey).toBe("jwt-SENTINEL");
      client.send({ id: "c1", type: "run.cancel", runId: "run-1", reason: "operator" });
      await client.waitFor((frame) => frame.type === "run.settled");
      await vi.waitFor(async () => {
        await expect(stat(pointer)).rejects.toThrow();
      });
    } finally {
      client.close();
    }
  }, 20_000);

  it("refuses a second supervisor on the same root", async () => {
    await start();
    await expect(startHost({ rootDir: root })).rejects.toThrow(/another omp-host|lock/i);
  });

  it("refuses to signal an orphan whose start identity is unknown", async () => {
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const pid = child.pid as number;
    child.unref();
    try {
      const ledger = await RunLedger.open(root);
      await ledger.append({
        epoch: "old-host", runId: "run-old", companyId: "co-1", agentId: "agent-1",
        sessionKey: "sk-old", cwd: root, state: "prompting",
        worker: {
          pid, pgid: pid, startedAt: new Date().toISOString(), startIdentity: null,
          argvHash: "a", bridgeHash: "b", ompVersion: null,
        },
      });
      await ledger.close();
      const result = await reconcile(root);
      expect(result.killed).toEqual([]);
      expect((await readLedgerRecords(root)).find((record) => record.state === "lost")?.detail)
        .toMatchObject({ orphan: "unverified" });
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      process.kill(pid, "SIGKILL");
    }
  });

  it("reconciles a crashed host: kills the orphan and journals one lost/host_exit", async () => {
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const pid = child.pid as number;
    child.unref();
    const identity = await readProcessStartIdentity(pid);
    const ledger = await RunLedger.open(root);
    await ledger.append({
      epoch: "old-host",
      runId: "run-old",
      companyId: "co-1",
      agentId: "agent-1",
      sessionKey: "sk-old",
      cwd: root,
      state: "prompting",
      worker: {
        pid, pgid: pid, startedAt: new Date().toISOString(), startIdentity: identity,
        argvHash: "a", bridgeHash: "b", ompVersion: null,
      },
    });
    await ledger.close();
    const result = await reconcile(root);
    expect(result.killed).toEqual([pid]);
    expect(result.lost).toBe(1);
    const records = await readLedgerRecords(root);
    expect(records.filter((record) => record.state === "lost" && record.cause === "host_exit")).toHaveLength(1);
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
  }, 20_000);

  it("serves a capabilities probe and a run status from the ledger", async () => {
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send({ id: "p1", type: "probe", kind: "capabilities" });
      const probe = await client.waitFor((frame) => frame.type === "probe.result");
      expect(probe).toMatchObject({ id: "p1", payload: { ok: true, protocol: 1 } });
      client.send(beginFrame({ runId: "run-1" }));
      await client.waitFor((frame) => frame.type === "run.settled");
      client.frames.length = 0;
      client.send({ id: "s1", type: "run.status", runId: "run-1" });
      const status = await client.waitFor((frame) => frame.type === "run.status.result");
      expect(status).toMatchObject({ id: "s1", runId: "run-1" });
      if (status.type === "run.status.result") expect(["settled", "closed"]).toContain(status.state);
    } finally {
      client.close();
    }
  }, 20_000);

  it("exits after hostIdleMs with nothing running", async () => {
    const running = await start({ hostIdleMs: 100, workerIdleMs: 100 });
    const closed = running.closed;
    await closed;
    await expect(stat(running.socketPath)).rejects.toThrow();
  }, 20_000);

  it("seeds a live ledger whose terminal runs are not touched by a second reconcile", async () => {
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({ runId: "run-1" }));
      await client.waitFor((frame) => frame.type === "run.settled");
    } finally {
      client.close();
    }
    await running.close("test");
    host = null;
    const result = await reconcile(root);
    expect(result.lost).toBe(0);
    expect((await readLedgerRecords(root)).filter((record) => record.state === "lost")).toEqual([]);
  }, 20_000);
});
