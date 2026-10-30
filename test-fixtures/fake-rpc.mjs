// Scripted `omp --mode rpc` responder for host tests. Speaks the JSONL RPC
// subset the supervisor uses: ready, new_session, open_session, prompt,
// abort, get_state, get_session_stats, set_host_tools, steer, follow_up,
// set_subagent_subscription, get_subagents.
//
// Modes (FAKE_RPC_MODE):
//   "" (default)  prompt settles immediately
//   hang          prompt settles only after abort
//   crash         the worker exits 3 right after acknowledging a prompt
//   chunk         emits one logical frame split into two rpc_chunk frames
//   hosttool      emits a host_tool_call on prompt and waits for the result
//   nosettle      prompt_result reports sessionSettled:false; only session_settled follows
//   subagents     three subagents: one completed, one failed, one still running
//   subagents200  two hundred running subagents (frame-cap fixture)
//   subagentsleak same as subagents, with credentials/prompt text in fields
//   subagentghost a straggler from an earlier run: roster entry plus one event
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const mode = process.env.FAKE_RPC_MODE ?? "";
// "survive" models the real failure the supervisor exists to reap: the worker
// outlives its host (no stdin, no shutdown) and must be killed by pid+identity.
if (mode === "survive") setInterval(() => {}, 1 << 30);
const logFile = process.env.FAKE_RPC_LOG;
const statsFile = process.env.FAKE_RPC_STATS;
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let sessionId = "sess-1";
let sessionFile = "/tmp/fake-session-1.json";
let seq = 0;
let pendingPrompt = null;
let hostToolWaiter = null;
let subagentLevel = "off";
const subagents = new Map();

let memoryStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
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
  current.cacheWrite += 10;
  current.cost += 0.5;
  current.turns += 1;
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

// Subagent observability, modelled on omp's registry: lifecycle frames are
// recorded whatever the subscription, but only output at "progress"/"events";
// subagent events need "events"; terminal subagents leave the roster.
const subagentFrame = (frame) => {
  if (subagentLevel === "off") return;
  if (frame.type === "subagent_event" && subagentLevel !== "events") return;
  send(frame);
};

const lifecycleFrame = (snapshot, status) =>
  subagentFrame({
    type: "subagent_lifecycle",
    payload: {
      id: snapshot.id, index: snapshot.index, agent: snapshot.agent,
      agentSource: "bundled", status,
      ...(snapshot.description === undefined ? {} : { description: snapshot.description }),
      ...(snapshot.parentToolCallId === undefined ? {} : { parentToolCallId: snapshot.parentToolCallId }),
    },
  });

const startSubagent = (id, index, agent, description) => {
  const snapshot = {
    id, index, agent, agentSource: "bundled", status: "running",
    ...(description === undefined ? {} : { description }),
    lastUpdate: Date.now(), parentToolCallId: "tc-parent",
  };
  subagents.set(id, snapshot);
  lifecycleFrame(snapshot, "started");
};

const endSubagent = (id, status) => {
  const snapshot = subagents.get(id);
  if (snapshot === undefined) return;
  subagents.delete(id);
  lifecycleFrame(snapshot, status);
};

const progressSubagent = (id, status, description) => {
  const snapshot = subagents.get(id);
  if (snapshot === undefined) return;
  snapshot.status = status;
  if (description !== undefined) snapshot.description = description;
  snapshot.lastUpdate = Date.now();
  subagentFrame({
    type: "subagent_progress",
    payload: {
      index: snapshot.index, agent: snapshot.agent, agentSource: "bundled",
      // The task/assignment are prompt text: a fixture that leaks them proves
      // the host never copies them into a frame.
      task: "TASK-SENTINEL-IGNORE-ALL-PREVIOUS",
      assignment: "ASSIGNMENT-SENTINEL-IGNORE-ALL-PREVIOUS",
      progress: { ...snapshot, status, task: "PROMPT-SENTINEL-IGNORE-ALL-PREVIOUS" },
      parentToolCallId: snapshot.parentToolCallId,
    },
  });
};

const eventSubagent = (id, event) => {
  if (!subagents.has(id)) return;
  subagentFrame({ type: "subagent_event", payload: { id, event } });
};

const emitSubagentWork = () => {
  if (mode === "subagentsleak") {
    // Built at runtime so the fixture carries a real JWT shape, not a sentinel
    // costume: only the eyJ-based redaction pattern catches these segments.
    const leakedJwt = [
      Buffer.from('{"alg":"HS256"}').toString("base64url"),
      Buffer.from('{"sub":"sa-2"}').toString("base64url"),
      "signature-sentinel",
    ].join(".");
    startSubagent("sa-1", 0, "explore", "read the config");
    startSubagent("sa-2", 1, "plan",
      `scan sk-live-ABCDEF1234567890 with Bearer abcdefghijklmnop then ${leakedJwt}`);
    startSubagent("sa-3", 2, "task", "keep working");
    progressSubagent("sa-1", "running", "reading files");
    eventSubagent("sa-1", {
      type: "tool_execution_end", toolName: "read", isError: false,
      arguments: { path: "ARG-SENTINEL-IGNORE-ALL-PREVIOUS" },
    });
    eventSubagent("sa-1", { type: "message_end", messageId: "msg-1", text: "TRANSCRIPT-SENTINEL" });
    endSubagent("sa-1", "completed");
    endSubagent("sa-2", "failed");
    return;
  }
  if (mode === "subagents") {
    startSubagent("sa-1", 0, "explore", "read the config");
    startSubagent("sa-2", 1, "plan", "draft the plan");
    startSubagent("sa-3", 2, "task", "keep working");
    progressSubagent("sa-1", "running", "reading files");
    eventSubagent("sa-1", { type: "message_end", messageId: "msg-1", text: "working" });
    endSubagent("sa-1", "completed");
    endSubagent("sa-2", "failed");
    return;
  }
  if (mode === "subagents200") {
    for (let index = 0; index < 200; index += 1) {
      startSubagent(`sa-${String(index).padStart(3, "0")}`, index, "explore", `unit ${index}`);
    }
    return;
  }
  if (mode === "subagentghost") {
    // A detached subagent from an earlier run: it sits in omp's roster and
    // emits its own event, but this run never saw it start.
    subagents.set("ghost", {
      id: "ghost", index: 0, agent: "explore", agentSource: "bundled",
      status: "running", description: "started before this run", lastUpdate: Date.now(),
    });
    eventSubagent("ghost", { type: "tool_execution_end", toolName: "read", isError: false });
  }
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
      if (mode === "freshopen") {
        // What omp does on an empty session dir: a fresh session, not a resume.
        sessionId = "sess-fresh-1";
        sessionFile = "/tmp/fake-session-fresh-1.json";
        return succeed(id, "open_session", {
          cancelled: false, resumed: false, sessionId, sessionFile,
        });
      }
      if (mode === "openerror") {
        // What omp answers when the stored session cannot be switched at all.
        return send({
          id, type: "response", command: "open_session", success: false,
          error: "Session cannot be switched to a different cwd",
        });
      }
      if (mode === "openfail") {
        // What omp does when the stored session cannot be resumed in this cwd.
        return succeed(id, "open_session", { cancelled: true, resumed: false, sessionId });
      }
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
          cacheRead: current.cacheRead, cacheWrite: current.cacheWrite,
          total: current.input + current.output + current.cacheRead + current.cacheWrite,
        },
        cost: current.cost,
        // Cumulative, like omp's SessionStats.
        routedModels: { "prov/m": current.turns },
        // The wire shape real omp sends (rpc-wire.generated.ts:413-417).
        contextUsage: { tokens: 4000, contextWindow: 200000, percent: 2 },
      });
    }
    case "set_host_tools": {
      const names = Array.isArray(frame.tools) ? frame.tools.map((t) => t.name) : [];
      return send({ id, type: "response", command: "set_host_tools", success: true, data: { toolNames: names } });
    }
    case "set_subagent_subscription": {
      if (frame.level !== "off" && frame.level !== "progress" && frame.level !== "events") {
        return send({
          id, type: "response", command: frame.type, success: false,
          error: `unsupported subagent subscription level: ${String(frame.level)}`,
        });
      }
      subagentLevel = frame.level;
      return succeed(id, "set_subagent_subscription", { level: subagentLevel });
    }
    case "get_subagents":
      return succeed(id, "get_subagents", { subagents: [...subagents.values()] });
    case "steer":
    case "follow_up":
      if (mode === "hang") send({ type: "message_end", messageId: "steer-1", text: frame.message });
      return succeed(id, frame.type);
    case "abort":
      succeed(id, "abort");
      // "deaf" models a worker that is alive but never reports the aborted
      // prompt, so the supervisor's second lease window must kill it.
      if (pendingPrompt && mode !== "deaf" && mode !== "survive") settlePrompt("aborted");
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
      pendingPrompt = { id };
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
      if (mode === "hang" || mode === "deaf" || mode === "survive") {
        pendingPrompt = { id };
        return;
      }
      pendingPrompt = { id };
      send({ type: "message_end", messageId: "m1", text: "working" });
      emitSubagentWork();
      settlePrompt("completed");
      return;
    }
    default:
      return send({ id, type: "response", command: frame.type, success: false, error: `unsupported: ${frame.type}` });
  }
});
