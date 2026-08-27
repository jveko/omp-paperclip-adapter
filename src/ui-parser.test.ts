import { describe, it, expect } from "vitest";
import { parseStdoutLine } from "./ui-parser";

describe("parseStdoutLine", () => {
  it("passes through a normal text_delta as assistant", () => {
    const line = JSON.stringify({ type: "acpx.text_delta", text: "Hello", channel: "output" });
    const entries = parseStdoutLine(line, "t0");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("assistant");
  });

  it("strips the tool call status prefix from tool_call text", () => {
    const line = JSON.stringify({
      type: "acpx.tool_call",
      name: "$ ls -la",
      status: "completed",
      text: "tool call (completed): $ ls -la",
    });
    const entries = parseStdoutLine(line, "t0");
    const toolCall = entries.find((e) => e.kind === "tool_call");
    expect(toolCall).toBeDefined();
    expect((toolCall as { input?: { text?: string } }).input?.text).toBe("$ ls -la");
  });

  it("surfaces a redaction-mangled tool_call line as a system event, not raw stdout", () => {
    // name contains an unescaped quote from redaction -> invalid JSON.
    const line = '{"type":"acpx.tool_call","name":"$ JWT=***REDACTED***"***REDACTED***\\"","status":"pending"}';
    const entries = parseStdoutLine(line, "t0");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("system");
    expect(entries[0].text).toContain("tool call");
  });

  it("leaves ordinary non-ACP stdout untouched", () => {
    const entries = parseStdoutLine("just some output", "t0");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("stdout");
    expect(entries[0].text).toBe("just some output");
  });
});
