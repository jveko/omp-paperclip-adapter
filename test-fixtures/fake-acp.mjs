// Scripted ACP responder for unit tests. Reads NDJSON requests on stdin and
// answers initialize, session/new, session/fork, and _omp/* extMethods.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const mode = process.env.FAKE_ACP_MODE ?? "";

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  globalThis.__seen ??= [];
  globalThis.__seen.push(msg.method);
  if (msg.method === "initialize") {
    if (mode === "error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: mode === "badversion" ? 99 : 1,
      agentInfo: { name: "fake-acp", title: "Fake", version: "0.0.1" },
      authMethods: [{ id: "agent", name: "agent" }],
      agentCapabilities: {},
    } });
  } else if (msg.method === "session/new") {
    if (mode === "newerror") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "no session" } });
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1",
      update: { sessionUpdate: "session_info_update" } } });
    send({ jsonrpc: "2.0", id: msg.id, result: {
      sessionId: "s1",
      configOptions: [
        { id: "mode", name: "Mode", type: "select", currentValue: "default", options: [] },
        { id: "model", name: "Model", type: "select", currentValue: "prov/model-a",
          options: [{ value: "prov/model-a", name: "Model A" }] },
      ],
    } });
  } else if (typeof msg.method === "string" && msg.method.startsWith("_omp/")) {
    if (mode === "exterror") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "ext boom" } });
      return;
    }
    if (msg.method === "_omp/sessions/listAll") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessions: [
        { sessionId: "sess-a", cwd: "/w", title: "First", updatedAt: "2026-08-28T00:00:00Z",
          _meta: { messageCount: 3, size: 120 } },
        { sessionId: "sess-b", cwd: "/w", title: "Second", updatedAt: "2026-08-28T01:00:00Z",
          _meta: { messageCount: 1, size: 40 } },
      ], total: 2,
      // record mode: echo the frames seen SO FAR (initialize + all requests up to
      // and including this one — the response is written after this push).
      ...(mode === "record" ? { seen: [...globalThis.__seen] } : {}) } });
    } else if (msg.method === "_omp/projects/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { projects: [
        { cwd: "/w", sessionCount: 2, lastActivityAt: "2026-08-28T01:00:00Z", lastTitle: "Second" },
      ], totalSessions: 2 } });
    } else if (msg.method === "_omp/chats/byCwd") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessions: [
        { sessionId: "sess-a", cwd: msg.params?.cwd ?? "/w", title: "First",
          updatedAt: "2026-08-28T00:00:00Z", _meta: { messageCount: 3, size: 120 } },
      ] } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  } else if (msg.method === "session/fork") {
    if (mode === "forkerror") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002,
        message: "ACP session cannot be forked before it is persisted" } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fork-1", modes: [], configOptions: [] } });
  }
});
