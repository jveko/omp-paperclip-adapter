import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RpcWorker,
  buildWorkerArgv,
  buildWorkerEnv,
  type RpcFrame,
} from "./worker.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/fake-rpc.mjs",
);

function workerSpec(mode: string, env: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: [fixture, "--mode", "rpc"],
    env: { FAKE_RPC_MODE: mode, ...env },
    cwd: process.cwd(),
  };
}

describe("rpc worker", () => {
  it("opens a session and settles a prompt", async () => {
    const worker = await RpcWorker.spawn(workerSpec(""));
    try {
      expect(worker.pid).toBeGreaterThan(0);
      expect(worker.pgid).toBe(worker.pid);
      const opened = await worker.openSession("/tmp/fake-sessions");
      expect(opened.resumed).toBe(true);
      await worker.prompt("do work", "p-1");
      const result = await worker.waitForFrame((f) => f.type === "prompt_result");
      expect(result).toMatchObject({ id: "p-1", status: "completed", agentInvoked: true, sessionSettled: true });
      const stats = await worker.getStats();
      expect((stats.tokens as Record<string, number>).input).toBe(100);
      await worker.waitForFrame((f) => f.type === "session_settled");
      expect(worker.frames.some((f) => f.type === "message_end")).toBe(true);
    } finally {
      await worker.stop(2_000);
    }
  });

  it("aborts a hung prompt and settles it", async () => {
    const worker = await RpcWorker.spawn(workerSpec("hang"));
    try {
      await worker.newSession();
      await worker.prompt("hang", "p-2");
      await worker.abort();
      const result = await worker.waitForFrame((f) => f.type === "prompt_result");
      expect(result).toMatchObject({ id: "p-2", status: "aborted", sessionSettled: true });
    } finally {
      await worker.stop(2_000);
    }
  });

  it("reassembles a logical frame split into rpc_chunk frames", async () => {
    const worker = await RpcWorker.spawn(workerSpec("chunk"));
    try {
      await worker.newSession();
      await worker.prompt("chunk", "p-3");
      const reassembled = await worker.waitForFrame((f) => f.type === "message_end" && f.text === "hello chunk");
      expect(reassembled).toMatchObject({ messageId: "chunked-1" });
    } finally {
      await worker.stop(2_000);
    }
  });

  it("resolves the exit and rejects pending requests when the worker crashes", async () => {
    const worker = await RpcWorker.spawn(workerSpec("crash"));
    try {
      await worker.prompt("crash", "p-4");
      await expect(worker.getStats()).rejects.toThrow(/exited/i);
      const exit = await worker.exited;
      expect(exit.code).toBe(3);
      expect(worker.alive).toBe(false);
    } finally {
      await worker.stop(1_000);
    }
  });

  it("derives the worker command from the ACP command minus acp, launched through a login shell", () => {
    expect(buildWorkerArgv({ command: "omp" }, "/bridge.js")).toEqual({
      command: "sh", args: ["-lc", "exec omp --mode rpc"],
    });
    expect(buildWorkerArgv({ command: "omp", thinking: "off" }, "/bridge.js")).toEqual({
      command: "sh", args: ["-lc", "exec omp --thinking off --mode rpc"],
    });
    expect(buildWorkerArgv({ agentCommand: "node /x.mjs" }, "/bridge.js")).toEqual({
      command: "sh", args: ["-lc", "exec node /x.mjs --mode rpc"],
    });
    expect(buildWorkerArgv({
      command: "omp",
      env: { PAPERCLIP_SKILLS_MANIFEST: "/m.json" },
    }, "/bridge.js")).toEqual({
      command: "sh", args: ["-lc", "exec omp --extension /bridge.js --mode rpc"],
    });
    // The engine lane's shell form is preserved, including a quoted path.
    expect(buildWorkerArgv({ agentCommand: "node \"/opt/my agent/omp.js\"" }, "/bridge.js")).toEqual({
      command: "sh", args: ["-lc", "exec node \"/opt/my agent/omp.js\" --mode rpc"],
    });
  });

  it("never places the run JWT in a worker env", () => {
    const env = buildWorkerEnv(
      { env: { PI_CONFIG_FILES: "/a.yml", PAPERCLIP_API_KEY: "jwt-SENTINEL", A: 1 } },
      { PAPERCLIP_RUN_CONTEXT: "/ctx/current.json" },
    );
    expect(env).toEqual({ PI_CONFIG_FILES: "/a.yml", PAPERCLIP_RUN_CONTEXT: "/ctx/current.json" });
  });
});
