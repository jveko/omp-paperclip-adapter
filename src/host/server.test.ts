import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import { startFakeMcp } from "../../test/fake-mcp.js";

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
      expect(settled.result.usage).toEqual({ inputTokens: 110, outputTokens: 20, cachedInputTokens: 40 });
      expect(settled.result.costUsd).toBeCloseTo(0.5);
      expect(settled.result.resultJson).toMatchObject({
        transport: "host-rpc", status: "completed", agentInvoked: true,
        contextUsage: { used: 4000, size: 200000 },
      });
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
      // Warm reuse: the worker outlives the run (retired after workerIdleMs).
      expect(running.workers).toBe(1);
    } finally {
      client.close();
    }
  }, 20_000);

  it("serves the run's connection tools as host tools with the run's own bearer", async () => {
    const mcp = await startFakeMcp();
    const running = await start();
    const client = await connectClient(running.socketPath);
    const connectionTools = (bearer: string) => ({
      endpoint: mcp.url,
      bearerToken: bearer,
      expiresAt: null,
      tools: ["connections_search", "connection_request"],
    });
    try {
      client.send(beginFrame({
        runId: "run-1", sessionKey: "sk-tools", mode: "hosttool",
        connectionTools: connectionTools("ct-SENTINEL"),
      }));
      await client.waitFor((frame) => frame.type === "run.settled" && frame.runId === "run-1");
      expect(mcp.calls).toEqual([
        { tool: "connections_search", arguments: { query: "acme" }, authorization: "Bearer ct-SENTINEL" },
      ]);
      expect(JSON.stringify(client.frames)).not.toContain("ct-SENTINEL");
      expect(await readFile(path.join(root, "ledger.jsonl"), "utf8")).not.toContain("ct-SENTINEL");

      // Warm worker + fresh bearer: set_host_tools rebinds the run's tools.
      client.send(beginFrame({
        runId: "run-2", sessionKey: "sk-tools", mode: "hosttool",
        session: { ompSessionId: "sess-new-1" },
        connectionTools: connectionTools("ct-SECOND"),
      }));
      const accepted = await client.waitFor(
        (frame) => frame.type === "run.accepted" && frame.runId === "run-2",
      );
      if (accepted.type !== "run.accepted") throw new Error("unreachable");
      expect(accepted.reusedWorker).toBe(true);
      await client.waitFor((frame) => frame.type === "run.settled" && frame.runId === "run-2");
      expect(mcp.calls[1]?.authorization).toBe("Bearer ct-SECOND");
    } finally {
      client.close();
      await mcp.close();
    }
  }, 20_000);

  it("does not fail a run when the connection-tools endpoint is unreachable", async () => {
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({
        runId: "run-1", sessionKey: "sk-dead-tools",
        connectionTools: {
          endpoint: "http://127.0.0.1:1/mcp", bearerToken: "ct-dead", expiresAt: null,
          tools: ["connections_search"],
        },
      }));
      const settled = await client.waitFor((frame) => frame.type === "run.settled");
      if (settled.type !== "run.settled") throw new Error("unreachable");
      expect(settled.result.exitCode).toBe(0);
      expect(client.frames.some(
        (frame) => frame.type === "run.event" && frame.kind === "run.system"
          && String(frame.payload.message).includes("connection tools are unavailable"),
      )).toBe(true);
    } finally {
      client.close();
    }
  }, 20_000);

  it("delivers steering to a live run only when the run enabled it", async () => {
    const log = path.join(root, "steer.log");
    const worker = {
      command: process.execPath,
      args: [fixture],
      env: { FAKE_RPC_MODE: "hang", FAKE_RPC_LOG: log },
    };
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({ runId: "run-1", mode: "hang", worker, sessionKey: "sk-steer", steering: true }));
      await client.waitFor((frame) => frame.type === "run.accepted");
      client.send({ id: "s1", type: "run.steer", runId: "run-1", message: "look at the tests", kind: "steer" });
      const ok = await client.waitFor((frame) => frame.type === "run.steer.result");
      expect(ok).toMatchObject({ id: "s1", ok: true });
      const commands = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; message?: string });
      expect(commands.find((command) => command.type === "steer")?.message).toBe("look at the tests");
      client.send({ id: "s2", type: "run.steer", runId: "run-1", message: "again", kind: "follow_up" });
      await client.waitFor((frame) => frame.type === "run.steer.result" && frame.id === "s2");
      const followUp = (await readFile(log, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      expect(followUp.some((command) => command.type === "follow_up")).toBe(true);
    } finally {
      client.close();
    }
  }, 20_000);

  it("refuses steering for a run that did not enable it", async () => {
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({ runId: "run-1", mode: "hang", sessionKey: "sk-no-steer" }));
      await client.waitFor((frame) => frame.type === "run.accepted");
      client.send({ id: "s1", type: "run.steer", runId: "run-1", message: "hello", kind: "steer" });
      const refused = await client.waitFor((frame) => frame.type === "run.steer.result");
      if (refused.type !== "run.steer.result") throw new Error("unreachable");
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("steering is disabled");
    } finally {
      client.close();
    }
  }, 20_000);

  it("reuses one warm worker across runs and does not reopen the active session", async () => {
    const log = path.join(root, "frames.log");
    const worker = {
      command: process.execPath,
      args: [fixture],
      env: { FAKE_RPC_MODE: "", FAKE_RPC_LOG: log },
    };
    const running = await start();
    const first = await connectClient(running.socketPath);
    try {
      first.send(beginFrame({
        runId: "run-1", sessionKey: "sk-warm", worker, session: { ompSessionId: "sess-0" },
      }));
      const acceptedA = await first.waitFor((frame) => frame.type === "run.accepted");
      await first.waitFor((frame) => frame.type === "run.settled");
      if (acceptedA.type !== "run.accepted") throw new Error("unreachable");
      first.send(beginFrame({
        runId: "run-2", sessionKey: "sk-warm", worker, session: { ompSessionId: "sess-1" },
      }));
      const acceptedB = await first.waitFor(
        (frame) => frame.type === "run.accepted" && frame.runId === "run-2",
      );
      await first.waitFor((frame) => frame.type === "run.settled" && frame.runId === "run-2");
      if (acceptedB.type !== "run.accepted") throw new Error("unreachable");
      expect(acceptedB.reusedWorker).toBe(true);
      expect(acceptedB.worker.pid).toBe(acceptedA.worker.pid);
      const commands = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
      expect(commands.filter((command) => command.type === "open_session")).toHaveLength(1);
      expect(commands.filter((command) => command.type === "new_session")).toHaveLength(0);
      expect(running.workers).toBe(1);
    } finally {
      first.close();
    }
  }, 20_000);

  const slowTests = process.env.OMP_HOST_SLOW_TESTS === "1";

  // The brief's wall-clock acceptance: two heartbeats a real minute apart. The
  // sweep/worker-idle logic is driven by the platform clock, so deterministic
  // time control cannot exercise it; this test is opt-in to keep the suite fast.
  it.skipIf(!slowTests)("keeps one warm worker across heartbeats 60 s apart", async () => {
    const log = path.join(root, "frames.log");
    const worker = {
      command: process.execPath,
      args: [fixture],
      env: { FAKE_RPC_MODE: "", FAKE_RPC_LOG: log },
    };
    const running = await start({ workerIdleMs: 5 * 60_000, hostIdleMs: 30 * 60_000 });
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({
        runId: "run-1", sessionKey: "sk-minute", worker, session: { ompSessionId: "sess-0" },
      }));
      const acceptedA = await client.waitFor((frame) => frame.type === "run.accepted");
      await client.waitFor((frame) => frame.type === "run.settled");
      if (acceptedA.type !== "run.accepted") throw new Error("unreachable");
      const heartbeatGap = Promise.withResolvers<void>();
      setTimeout(heartbeatGap.resolve, 60_000);
      await heartbeatGap.promise;
      client.send(beginFrame({
        runId: "run-2", sessionKey: "sk-minute", worker, session: { ompSessionId: "sess-1" },
      }));
      const acceptedB = await client.waitFor(
        (frame) => frame.type === "run.accepted" && frame.runId === "run-2",
      );
      await client.waitFor((frame) => frame.type === "run.settled" && frame.runId === "run-2");
      if (acceptedB.type !== "run.accepted") throw new Error("unreachable");
      expect(acceptedB.reusedWorker).toBe(true);
      expect(acceptedB.worker.pid).toBe(acceptedA.worker.pid);
      const commands = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
      expect(commands.filter((command) => command.type === "open_session")).toHaveLength(1);
      expect(commands.filter((command) => command.type === "new_session")).toHaveLength(0);
    } finally {
      client.close();
    }
  }, 90_000);

  it("spawns a second worker for another cwd and leaves the first warm", async () => {
    const a = path.join(root, "work-a");
    const b = path.join(root, "work-b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    const running = await start({ maxWorkers: 4 });
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({ runId: "run-a", sessionKey: "sk-a", cwd: a }));
      const acceptedA = await client.waitFor((frame) => frame.type === "run.accepted");
      await client.waitFor((frame) => frame.type === "run.settled" && frame.runId === "run-a");
      client.send(beginFrame({ runId: "run-b", sessionKey: "sk-b", cwd: b }));
      const acceptedB = await client.waitFor(
        (frame) => frame.type === "run.accepted" && frame.runId === "run-b",
      );
      await client.waitFor((frame) => frame.type === "run.settled" && frame.runId === "run-b");
      if (acceptedA.type !== "run.accepted" || acceptedB.type !== "run.accepted") throw new Error("unreachable");
      expect(acceptedB.worker.pid).not.toBe(acceptedA.worker.pid);
      expect(running.workers).toBe(2);
      expect(() => process.kill(acceptedA.worker.pid, 0)).not.toThrow();
    } finally {
      client.close();
    }
  }, 20_000);

  it("retires a worker whose argv hash changed", async () => {
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({ runId: "run-1", sessionKey: "sk-rotate" }));
      const acceptedA = await client.waitFor((frame) => frame.type === "run.accepted");
      await client.waitFor((frame) => frame.type === "run.settled" && frame.runId === "run-1");
      client.send(beginFrame({
        runId: "run-2",
        sessionKey: "sk-rotate",
        cell: {
          argvHash: "changed", bridgeHash: "bridge", agentDir: null,
          model: "prov/m", thinking: "high", approval: "yolo",
        },
      }));
      const acceptedB = await client.waitFor(
        (frame) => frame.type === "run.accepted" && frame.runId === "run-2",
      );
      await client.waitFor((frame) => frame.type === "run.settled" && frame.runId === "run-2");
      if (acceptedA.type !== "run.accepted" || acceptedB.type !== "run.accepted") throw new Error("unreachable");
      expect(acceptedB.worker.pid).not.toBe(acceptedA.worker.pid);
      expect(running.workers).toBe(1);
      await vi.waitFor(() => {
        expect(() => process.kill(acceptedA.worker.pid, 0)).toThrow();
      }, { timeout: 5_000, interval: 25 });
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

  it("refuses a concurrent second run on one connection", async () => {
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({ runId: "run-1", mode: "hang", sessionKey: "sk-1" }));
      await client.waitFor((frame) => frame.type === "run.accepted");
      client.send(beginFrame({ runId: "run-2", mode: "hang", sessionKey: "sk-2" }));
      const refused = await client.waitFor(
        (frame) => frame.type === "run.settled" && frame.runId === "run-2",
      );
      if (refused.type !== "run.settled") throw new Error("unreachable");
      expect(refused.result.errorCode).toBe("omp_host_connection_busy");
      // A sequential run on the same connection is fine once the first settles.
      client.send({ id: "c1", type: "run.cancel", runId: "run-1", reason: "operator" });
      await client.waitFor((frame) => frame.type === "run.settled" && frame.runId === "run-1");
      client.send(beginFrame({ runId: "run-3", sessionKey: "sk-3" }));
      await client.waitFor((frame) => frame.type === "run.accepted" && frame.runId === "run-3");
      await client.waitFor((frame) => frame.type === "run.settled" && frame.runId === "run-3");
    } finally {
      client.close();
    }
  }, 20_000);

  it("refuses interleaved begins past maxWorkers", async () => {
    const running = await start({ maxWorkers: 1 });
    const first = await connectClient(running.socketPath);
    const second = await connectClient(running.socketPath);
    try {
      first.send(beginFrame({ runId: "run-a", mode: "hang", sessionKey: "sk-a" }));
      second.send(beginFrame({ runId: "run-b", mode: "hang", sessionKey: "sk-b" }));
      const outcomes = await Promise.all([
        first.waitFor((frame) => frame.type === "run.accepted" || frame.type === "run.settled"),
        second.waitFor((frame) => frame.type === "run.accepted" || frame.type === "run.settled"),
      ]);
      const accepted = outcomes.filter((frame) => frame.type === "run.accepted");
      const refused = outcomes.filter((frame) => frame.type === "run.settled");
      expect(accepted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      if (refused[0].type !== "run.settled") throw new Error("unreachable");
      expect(refused[0].result.errorCode).toBe("omp_host_capacity");
      expect(running.workers).toBe(1);
    } finally {
      first.close();
      second.close();
    }
  }, 20_000);

  it("reports a worker that cannot start as a configuration failure, not a recoverable interruption", async () => {
    const running = await start();
    const client = await connectClient(running.socketPath);
    try {
      client.send(beginFrame({
        runId: "run-1",
        worker: { command: "sh", args: ["-lc", "exec omp-binary-that-does-not-exist"], env: {} },
      }));
      const settled = await client.waitFor((frame) => frame.type === "run.settled");
      if (settled.type !== "run.settled") throw new Error("unreachable");
      expect(settled.result.errorCode).toBe("omp_host_worker_failed");
      expect(settled.result.executionRecovery).toBeUndefined();
      const records = await readLedgerRecords(root);
      expect(records.some((record) => record.state === "refused" && record.cause === "config_error")).toBe(true);
    } finally {
      client.close();
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
      // The session index answers the fork cwd precondition for a source this
      // host ran, and says so when it did not.
      client.send({ id: "q1", type: "probe", kind: "sessions", payload: { sessionId: "sess-new-1" } });
      const known = await client.waitFor((frame) => frame.type === "probe.result" && frame.id === "q1");
      expect(known).toMatchObject({ payload: { ok: true, cwd: process.cwd() } });
      client.send({ id: "q2", type: "probe", kind: "sessions", payload: { sessionId: "sess-never" } });
      const unknown = await client.waitFor((frame) => frame.type === "probe.result" && frame.id === "q2");
      expect(unknown).toMatchObject({ payload: { ok: false } });
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
