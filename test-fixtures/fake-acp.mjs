// Scripted ACP responder for unit tests. Reads NDJSON requests on stdin and
// answers initialize, session/new, session/list, session/fork, and _omp/*
// extMethods.
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const mode = process.env.FAKE_ACP_MODE ?? "";
// Every method the client issued, in order, for tests that assert which frames
// a code path must not send (a response cannot carry that list for request sets
// whose trailing frames are optional).
const seenFile = process.env.FAKE_ACP_SEEN_FILE;
// Every incoming frame WITH its params, for tests that must assert what the
// client actually asked (e.g. which cwd a fork targets). `seenFile` stays the
// method-only log; this one is opt-in so neither seam disturbs the other.
const frameLog = process.env.FAKE_ACP_FRAME_LOG;

// Shape emitted by real omp for any `_omp/*` method it does not implement.
const unknownExtMethod = (method) => ({
  code: -32603,
  message: "Internal error",
  data: { details: `Unknown ACP ext method: ${method}` },
});

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  globalThis.__seen ??= [];
  globalThis.__seen.push(msg.method);
  if (seenFile) {
    try { appendFileSync(seenFile, `${msg.method}\n`); } catch { /* test seam only */ }
  }
  if (frameLog) {
    try {
      appendFileSync(frameLog, `${msg.method}\t${JSON.stringify(msg.params ?? {})}\n`);
    } catch { /* test seam only */ }
  }
  if (msg.method === "initialize") {
    if (mode === "error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: mode === "badversion" ? 99 : 1,
      agentInfo: { name: "fake-acp", title: "Fake", version: "0.0.1" },
      authMethods: [{ id: "agent", name: "agent" }],
      agentCapabilities: mode === "nolist" ? {} : { sessionCapabilities: { list: {} } },
    } });
  } else if (msg.method === "session/list") {
    // ACP session/list: cwd-scoped when the client passes one, paged at 50 by
    // real omp (acp-agent.ts:897-911). `page2` returns a cursor so the caller
    // must report the listing as truncated rather than complete.
    if (mode === "listerror") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32003, message: "session/list boom" } });
      return;
    }
    if (mode === "pages" || mode === "cap" || mode === "page2error") {
      // Offset paging like omp: the cursor is the next offset. `pages` ends on
      // page 3, `cap` never ends, `page2error` fails every cursor page.
      const cursor = typeof msg.params?.cursor === "string" ? Number(msg.params.cursor) : 0;
      if (mode === "page2error" && cursor > 0) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32004, message: "page 2 boom" } });
        return;
      }
      const pages = [["s-a", "s-b"], ["s-c", "s-d"], ["s-e"]];
      const ids = mode === "pages" ? (pages[cursor / 2] ?? []) : [`s-${cursor}`];
      let next;
      if (mode === "pages") next = cursor / 2 >= pages.length - 1 ? undefined : String(cursor + 2);
      else if (mode === "page2error") next = "2";
      else next = String(cursor + 1);
      const cwd = typeof msg.params?.cwd === "string" ? msg.params.cwd : "/workspace";
      send({ jsonrpc: "2.0", id: msg.id, result: {
        sessions: ids.map(id => ({
          sessionId: id, cwd, title: id, updatedAt: "2026-08-28T00:00:00Z",
          _meta: { messageCount: 1, size: 10 },
        })),
        ...(next === undefined ? {} : { nextCursor: next }),
      } });
      return;
    }
    // An unscoped listing (no client cwd) must expose sessions from DIFFERENT
    // workspaces: that is how a caller resolves a source session's own cwd
    // before forking it. A client-sent cwd is still echoed unchanged.
    const sentCwd = typeof msg.params?.cwd === "string" ? msg.params.cwd : null;
    const cwdA = sentCwd ?? "/workspace";
    const cwdB = sentCwd ?? "/other";
    send({ jsonrpc: "2.0", id: msg.id, result: {
      sessions: [
        { sessionId: "sess-a", cwd: cwdA, title: "First", updatedAt: "2026-08-28T00:00:00Z",
          _meta: { messageCount: 3, size: 120 } },
        { sessionId: "sess-b", cwd: cwdB, title: "Second", updatedAt: "2026-08-28T01:00:00Z",
          _meta: { messageCount: 1, size: 40 } },
      ],
      ...(mode === "page2" ? { nextCursor: "2" } : {}),
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
    } else if (msg.method === "_omp/subagents") {
      // omp's ACP extMethod switch has no subagent bridge (only RPC mode
      // subscribes the task:subagent:* EventBus channels), so this always
      // answers the unknown-method error. Kept so a client that still probes it
      // sees exactly what a real omp returns.
      send({ jsonrpc: "2.0", id: msg.id, error: unknownExtMethod(msg.method) });
    } else {
      // Verified against omp 18.1.6: an unrecognized `_omp/*` method is a
      // JSON-RPC error, not an empty result.
      send({ jsonrpc: "2.0", id: msg.id, error: unknownExtMethod(msg.method) });
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
