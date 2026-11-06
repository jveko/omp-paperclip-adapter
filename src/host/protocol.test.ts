import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL_VERSION,
  encodeFrame,
  parseFrame,
  type HostFrame,
  type HostReply,
} from "./protocol.js";

function begin(overrides: Partial<Extract<HostFrame, { type: "run.begin" }>> = {}) {
  return {
    id: "2",
    type: "run.begin",
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1" },
    sessionKey: "paperclip:co-1:agent-1:task",
    cwd: "/repo",
    session: { ompSessionId: null },
    cell: {
      argvHash: "argv", bridgeHash: "bridge", agentDir: null, profile: null,
      model: "prov/m", thinking: "high", approval: "yolo",
    },
    worker: { command: "omp", args: ["--mode", "rpc"], env: { A: "B" } },
    prompt: "do work",
    credentials: { apiUrl: "http://127.0.0.1:3100", apiKey: "jwt", companyId: "co-1", taskId: null, issueId: null },
    manifests: { skills: null, governance: null, budget: null, failover: null, thinking: null },
    limits: { timeoutMs: 1_800_000, runLeaseTtlMs: 90_000 },
    ...overrides,
  } as Extract<HostFrame, { type: "run.begin" }>;
}

describe("host protocol frames", () => {
  it("encodes one JSONL line per frame", () => {
    const line = encodeFrame({ id: "1", type: "hello", v: HOST_PROTOCOL_VERSION, instanceId: "default", adapterVersion: "0.12.0" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({ type: "hello", v: 1 });
  });

  it("round-trips every command and reply frame", () => {
    const commands: HostFrame[] = [
      { id: "1", type: "hello", v: 1, instanceId: "default", adapterVersion: "0.12.0" },
      begin(),
      { id: "3", type: "run.heartbeat", runId: "run-1" },
      { id: "4", type: "run.cancel", runId: "run-1", reason: "operator" },
      { id: "5", type: "run.status", runId: "run-1" },
      { id: "5b", type: "run.steer", runId: "run-1", message: "look at the tests", kind: "steer" },
      { id: "6", type: "probe", kind: "capabilities", payload: {} },
      { id: "7", type: "shutdown", reason: "operator" },
    ];
    const replies: HostReply[] = [
      { type: "hello_ok", hostVersion: "0.12.0", hostPid: 42, epoch: "host-1", workers: 0 },
      {
        type: "run.accepted", id: "2", runId: "run-1", reusedWorker: false,
        worker: { pid: 7, pgid: 7, startedAt: "2026-10-30T00:00:00.000Z" },
        sessionOpening: "new", ompSessionId: "sess-1", runContextPath: "/tmp/current.json",
      },
      { type: "run.event", runId: "run-1", seq: 1, at: "2026-10-30T00:00:00.000Z", kind: "run.system", payload: { message: "hi" } },
      { type: "run.settled", runId: "run-1", result: { exitCode: 0, signal: null, timedOut: false } },
      { type: "run.status.result", id: "5", runId: "run-1", state: "settled", settled: { exitCode: 0, signal: null, timedOut: false } },
      { type: "run.steer.result", id: "5b", runId: "run-1", ok: true },
      { type: "probe.result", id: "6", kind: "capabilities", payload: { ok: true } },
      { type: "error", id: "1", code: "bad_frame", message: "nope" },
    ];
    for (const frame of [...commands, ...replies]) {
      expect(parseFrame(encodeFrame(frame).slice(0, -1))).toEqual(frame);
    }
  });

  it("rejects malformed, unknown, and version-mismatched frames", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame("{}")).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "wat" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ id: "1", type: "hello", v: 2, instanceId: "x", adapterVersion: "1" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ id: "1", type: "hello", instanceId: "x", adapterVersion: "1" }))).toBeNull();
  });

  it("rejects identifiers that would become filesystem names", () => {
    for (const runId of ["../host", "a/b", "..", "", ".hidden"]) {
      expect(parseFrame(JSON.stringify(begin({ runId }))), runId).toBeNull();
    }
    expect(parseFrame(JSON.stringify(begin({ agent: { id: "../x", companyId: "co-1" } })))).toBeNull();
    expect(parseFrame(JSON.stringify(begin({ agent: { id: "a", companyId: "../../c" } })))).toBeNull();
  });

  it("rejects a malformed connection-tools block", () => {
    expect(parseFrame(JSON.stringify(begin({
      connectionTools: { endpoint: "http://x", bearerToken: 1 as never, tools: [] },
    })))).toBeNull();
  });

  it("requires the run.begin identity fields the host spawns from", () => {
    const { worker: _worker, ...noWorker } = begin();
    expect(parseFrame(JSON.stringify(noWorker))).toBeNull();
    const { prompt: _prompt, ...noPrompt } = begin();
    expect(parseFrame(JSON.stringify(noPrompt))).toBeNull();
    expect(parseFrame(JSON.stringify(begin()))).toMatchObject({ type: "run.begin", runId: "run-1" });
  });
});
