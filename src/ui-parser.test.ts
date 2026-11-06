import { describe, expect, it } from "vitest";
import { parseStdoutLine } from "./ui-parser";

/**
 * The managed lane's adapter relays `AdapterRuntimeEvent` objects through
 * `onEvent`; Paperclip renders them as JSON lines. These are the shapes this
 * parser must read.
 */
const event = (eventType: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ eventType, stream: "stdout", ...fields });

const toolEvent = (phase: "tool_call" | "tool_result", fields: Record<string, unknown> = {}) =>
  event("omp.tool_call", {
    payload: { phase, toolName: "bash", toolCallId: "call_1", ...fields },
  });

describe("parseStdoutLine", () => {
  it("maps a turn text line to an assistant entry", () => {
    const line = event("omp.turn", { message: "All done.", payload: { messageId: "m1", text: "All done." } });
    expect(parseStdoutLine(line, "t0")).toEqual([
      { kind: "assistant", ts: "t0", text: "All done." },
    ]);
  });

  it("maps a tool-call line to a tool_call entry keyed by its id", () => {
    expect(parseStdoutLine(toolEvent("tool_call"), "t0")).toEqual([
      { kind: "tool_call", ts: "t0", name: "bash", toolUseId: "call_1", input: {} },
    ]);
  });

  it("maps the tool-call argsSummary to the entry input", () => {
    const line = toolEvent("tool_call", { argsSummary: "echo ARG-SENTINEL" });
    expect(parseStdoutLine(line, "t0")).toEqual([
      {
        kind: "tool_call",
        ts: "t0",
        name: "bash",
        toolUseId: "call_1",
        input: { summary: "echo ARG-SENTINEL" },
      },
    ]);
  });

  it("maps a tool-result line to the paired tool_result entry", () => {
    expect(parseStdoutLine(toolEvent("tool_result"), "t0")).toEqual([
      { kind: "tool_result", ts: "t0", toolUseId: "call_1", toolName: "bash", content: "", isError: false },
    ]);
  });

  it("labels a shell tool by its command word", () => {
    const line = toolEvent("tool_call", { toolName: '$ ls -la /tmp 2>/dev/null | head -5' });
    const entries = parseStdoutLine(line, "t0");
    expect(entries[0]).toMatchObject({ kind: "tool_call", name: "ls" });
  });

  it("maps a run.system line to a system entry", () => {
    const line = event("run.system", { stream: "system", level: "warn", message: "the ledger could not record the settle" });
    expect(parseStdoutLine(line, "t0")).toEqual([
      { kind: "system", ts: "t0", text: "the ledger could not record the settle" },
    ]);
  });

  it("maps a subagent line to a system entry", () => {
    const line = event("omp.subagent", { stream: "system", message: "explore running" });
    expect(parseStdoutLine(line, "t0")).toEqual([
      { kind: "system", ts: "t0", text: "explore running" },
    ]);
  });

  it("maps a relayed log chunk to its stream", () => {
    const line = event("omp.log", { stream: "stderr", payload: { stream: "stderr", chunk: "boom\n" } });
    expect(parseStdoutLine(line, "t0")).toEqual([
      { kind: "stderr", ts: "t0", text: "boom" },
    ]);
  });

  it("drops a turn lifecycle line that carries no content", () => {
    const line = event("omp.turn", { payload: { event: "agent_start" } });
    expect(parseStdoutLine(line, "t0")).toEqual([]);
  });

  it.each([
    '{"event":"agent_start"}',
    '{"event":"turn_end"}',
    '{"messageId":"msg-2"}',
  ])("drops the control frame %s", (line) => {
    expect(parseStdoutLine(line, "t0")).toEqual([]);
  });

  it("renders a raw message_update frame as one system entry, never stdout", () => {
    const line = JSON.stringify({
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "start", partial: { role: "assistant", content: [] } },
    });
    const entries = parseStdoutLine(line, "t0");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "system",
      ts: "t0",
      text: expect.stringContaining("message_update"),
    });
  });

  it("renders an unknown adapter event type as one system entry naming it", () => {
    const line = event("omp.usage", { payload: { complete: true } });
    const entries = parseStdoutLine(line, "t0");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "system",
      ts: "t0",
      text: expect.stringContaining("omp.usage"),
    });
  });

  it.each([
    ["malformed JSON", '{"eventType":"omp.turn","message":"unterminated'],
    ["plain text", "just some output"],
    ["a non-event JSON object", JSON.stringify({ type: "notice", text: "not an adapter event" })],
  ])("renders %s as one system entry, never stdout", (_label, line) => {
    expect(parseStdoutLine(line, "t0")).toEqual([
      { kind: "system", ts: "t0", text: line },
    ]);
  });

  it.each(["glob", "bash"])("renders a bare %s line as one system entry", (line) => {
    expect(parseStdoutLine(line, "t0")).toEqual([
      { kind: "system", ts: "t0", text: line },
    ]);
  });
});
