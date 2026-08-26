// Scripted ACP responder for unit tests. Reads NDJSON requests on stdin,
// answers initialize and session/new; ignores everything else.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const mode = process.env.FAKE_ACP_MODE ?? "";

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
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
  }
});
