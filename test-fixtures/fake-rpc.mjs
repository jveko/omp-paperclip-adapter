// Scripted `omp --mode rpc` responder for host tests. Speaks the JSONL RPC
// subset the supervisor uses: ready, new_session, open_session, prompt,
// abort, get_state, get_session_stats, set_host_tools, steer, follow_up.
//
// Modes (FAKE_RPC_MODE):
//   "" (default)  prompt settles immediately
//   hang          prompt settles only after abort
//   crash         the worker exits 3 right after acknowledging a prompt
//   chunk         emits one logical frame split into two rpc_chunk frames
//   hosttool      emits a host_tool_call on prompt and waits for the result
//   nosettle      prompt_result reports sessionSettled:false; only session_settled follows
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const mode = process.env.FAKE_RPC_MODE ?? "";
const logFile = process.env.FAKE_RPC_LOG;
const statsFile = process.env.FAKE_RPC_STATS;
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let sessionId = "sess-1";
let sessionFile = "/tmp/fake-session-1.json";
let seq = 0;
let pendingPrompt = null;
let hostToolWaiter = null;

let memoryStats = { input: 0, output: 0, cacheRead: 0, cost: 0 };
const stats = () => {
  if (!statsFile) return memoryStats;
  try {
    return JSON.parse(readFileSync(statsFile, "utf8"));
  } catch {
    return memoryStats;
  }
};
const addUsage = () => {
  const current = stats();
  current.input += 100;
  current.output += 20;
  current.cacheRead += 40;
  current.cost += 0.5;
  memoryStats = current;
  if (statsFile) writeFileSync(statsFile, JSON.stringify(current));
};

const log = (frame) => {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${JSON.stringify(frame)}\n`);
  } catch {
    /* test seam only */
  }
};

const succeed = (id, command, data) =>
  send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });

const settlePrompt = (status) => {
  if (!pendingPrompt) return;
  const { id } = pendingPrompt;
  pendingPrompt = null;
  addUsage();
  send({
    type: "prompt_result",
    id,
    agentInvoked: true,
    status,
    sessionSettled: mode !== "nosettle",
  });
  // Real omp emits the settle frame once the session goes quiet; every mode
  // here goes quiet immediately after the prompt's own work.
  send({ type: "session_settled" });
};

send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  log(frame);
  const id = frame.id;
  switch (frame.type) {
    case "new_session":
      seq += 1;
      sessionId = `sess-new-${seq}`;
      sessionFile = `/tmp/fake-session-new-${seq}.json`;
      return succeed(id, "new_session", { cancelled: false });
    case "open_session":
      return succeed(id, "open_session", {
        cancelled: false, resumed: true, sessionId, sessionFile,
      });
    case "get_state":
      return succeed(id, "get_state", { sessionId, sessionFile, isStreaming: false, isSettled: true });
    case "get_session_stats": {
      const current = stats();
      return succeed(id, "get_session_stats", {
        sessionId,
        sessionFile,
        tokens: {
          input: current.input, output: current.output, reasoning: 0,
          cacheRead: current.cacheRead, cacheWrite: 0,
          total: current.input + current.output + current.cacheRead,
        },
        cost: current.cost,
        routedModels: { "prov/m": 1 },
        contextUsage: { used: 4000, size: 200000 },
      });
    }
    case "set_host_tools": {
      const names = Array.isArray(frame.tools) ? frame.tools.map((t) => t.name) : [];
      return send({ id, type: "response", command: "set_host_tools", success: true, data: { toolNames: names } });
    }
    case "steer":
    case "follow_up":
      if (mode === "hang") send({ type: "message_end", messageId: "steer-1", text: frame.message });
      return succeed(id, frame.type);
    case "abort":
      succeed(id, "abort");
      if (pendingPrompt) settlePrompt("aborted");
      return;
    case "host_tool_result":
      if (hostToolWaiter) {
        const waiter = hostToolWaiter;
        hostToolWaiter = null;
        waiter(frame);
      }
      return;
    case "prompt": {
      if (mode === "chunk") {
        const logical = { type: "message_end", messageId: "chunked-1", text: "hello chunk" };
        const json = JSON.stringify(logical);
        const half = Math.floor(json.length / 2);
        send({ type: "rpc_chunk", chunkId: "rpc-1", index: 0, count: 2, byteLength: Buffer.byteLength(json), data: Buffer.from(json.slice(0, half)).toString("base64") });
        send({ type: "rpc_chunk", chunkId: "rpc-1", index: 1, count: 2, byteLength: Buffer.byteLength(json), data: Buffer.from(json.slice(half)).toString("base64") });
      }
      succeed(id, "prompt");
      if (mode === "crash") {
        process.exit(3);
      }
      if (mode === "hosttool") {
        hostToolWaiter = () => {
          send({ type: "message_end", messageId: "m-tool", text: "tool done" });
          settlePrompt("completed");
        };
        send({ type: "host_tool_call", id: "htc-1", toolCallId: "tc-1", toolName: "connections_search", arguments: { query: "acme" } });
        return;
      }
      if (mode === "hang") {
        pendingPrompt = { id };
        return;
      }
      pendingPrompt = { id };
      send({ type: "message_end", messageId: "m1", text: "working" });
      settlePrompt("completed");
      return;
    }
    default:
      return send({ id, type: "response", command: frame.type, success: false, error: `unsupported: ${frame.type}` });
  }
});
