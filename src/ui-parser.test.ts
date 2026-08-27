import { describe, it, expect } from "vitest";
import { parseStdoutLine } from "./ui-parser";

const toolCall = (entries: ReturnType<typeof parseStdoutLine>) =>
  entries.find((e) => e.kind === "tool_call") as
    | { name: string; input?: { text?: string }; toolUseId?: string }
    | undefined;

const toolResult = (entries: ReturnType<typeof parseStdoutLine>) =>
  entries.find((e) => e.kind === "tool_result") as
    | { toolName?: string; content: string; toolUseId: string; isError: boolean }
    | undefined;

describe("parseStdoutLine", () => {
  it("passes through a normal text_delta as assistant", () => {
    const line = JSON.stringify({ type: "acpx.text_delta", text: "Hello", channel: "output" });
    const entries = parseStdoutLine(line, "t0");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("assistant");
  });

  describe("tool_call display", () => {
    it("collapses the full shell command to a short label in the name", () => {
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: '$ ls -la /home/dimaz/foo 2>/dev/null | head -50; echo "---"; pwd',
        status: "pending",
        text: '$ ls -la /home/dimaz/foo 2>/dev/null | head -50; echo "---"; pwd',
      });
      expect(toolCall(parseStdoutLine(line, "t0"))?.name).toBe("ls");
    });

    it("skips leading VAR=/export/$(...) noise when picking the label", () => {
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: '$ JWT=$(cat /tmp/jwt) curl -s -H "Authorization: Bearer $JWT" http://codan:3100/api/issues',
        status: "pending",
        text: "$ JWT=$(cat /tmp/jwt) curl -s http://codan:3100/api/issues",
      });
      expect(toolCall(parseStdoutLine(line, "t0"))?.name).toBe("curl");
    });

    it("skips `cd <dir>` and wrapper commands to reach the real command", () => {
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: '$ cd /home/dimaz/ws\nsudo /usr/bin/python3 -c "import json"',
        status: "pending",
      });
      expect(toolCall(parseStdoutLine(line, "t0"))?.name).toBe("python3");
    });

    it("keeps a bare command that happens to look like a wrapper", () => {
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: "$ env | grep -i paperclip | sort",
        status: "pending",
      });
      expect(toolCall(parseStdoutLine(line, "t0"))?.name).toBe("env");
    });

    it("skips command-substitution debris left behind by redaction", () => {
      // Redaction ate the "$(cat" of JWT=$(cat /tmp/jwt2.txt).
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: '$ JWT=***REDACTED*** /tmp/jwt2.txt); RUN="a096f2f2"\ncurl -s http://codan:3100/api',
        status: "pending",
      });
      expect(toolCall(parseStdoutLine(line, "t0"))?.name).toBe("curl");
    });

    it("falls back to 'shell' when no command token is recoverable", () => {
      const line = JSON.stringify({ type: "acpx.tool_call", name: "$ | grep foo", status: "pending" });
      expect(toolCall(parseStdoutLine(line, "t0"))?.name).toBe("shell");
    });

    it("leaves a human-authored (non-shell) tool label untouched", () => {
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: "Reading JWT API access skill",
        status: "pending",
        text: "Reading JWT API access skill (pending): skill://paperclip-agent-jwt-api-access",
      });
      expect(toolCall(parseStdoutLine(line, "t0"))?.name).toBe("Reading JWT API access skill");
    });

    it("strips the leading 'tool call (status):' prefix from text", () => {
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: "$ ls -la",
        status: "completed",
        text: "tool call (completed): $ ls -la",
      });
      expect(toolCall(parseStdoutLine(line, "t0"))?.input?.text).toBe("$ ls -la");
    });

    it("strips the trailing ' (pending): cmd' suffix from text", () => {
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: "$ env | grep -i paperclip | sort",
        status: "pending",
        text: "$ env | grep -i paperclip | sort (pending): env | grep -i paperclip | sort",
      });
      expect(toolCall(parseStdoutLine(line, "t0"))?.input?.text).toBe("$ env | grep -i paperclip | sort");
    });

    it("strips the trailing suffix when the echoed command spans lines", () => {
      const cmd = '$ LOG=/tmp/run.ndjson\ngrep -o \'"runId"\' "$LOG" | head';
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: cmd,
        status: "pending",
        text: `${cmd} (pending): ${cmd.slice(2)}`,
      });
      expect(toolCall(parseStdoutLine(line, "t0"))?.input?.text).toBe(cmd);
    });

    it("labels the tool_result toolName the same way", () => {
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: '$ python3 -c "import json"',
        status: "completed",
        text: 'tool call (completed): $ python3 -c "import json"',
      });
      expect(toolResult(parseStdoutLine(line, "t0"))?.toolName).toBe("python3");
    });

    it("strips the status prefix from tool_result content but keeps the output", () => {
      const line = JSON.stringify({
        type: "acpx.tool_call",
        name: "$ env | grep -i paperclip",
        status: "completed",
        text: "tool call (completed): $ env | grep -i paperclip\nPAPERCLIP_RUN_ID=abc (pending): leave me",
      });
      expect(toolResult(parseStdoutLine(line, "t0"))?.content).toBe(
        "$ env | grep -i paperclip\nPAPERCLIP_RUN_ID=abc (pending): leave me",
      );
    });
  });

  describe("redaction-mangled ACP events", () => {
    // The log redactor substitutes secrets after JSON encoding, so a redacted
    // value can leave a raw quote inside a JSON string.
    const mangled =
      '{"type":"acpx.tool_call","name":"$ JWT=***REDACTED***"***REDACTED***\\"\\ncurl -s -H \\"Authorization: Bearer ***REDACTED***" http://codan:3100/api/issues","toolCallId":"call_999bc2b3","status":"completed","text":"tool call (completed): $ JWT=***REDACTED***"***REDACTED***\\"\\ncurl","tag":"tool_call_update"}';

    it("repairs the JSON and recovers a real tool_call instead of a placeholder", () => {
      const entries = parseStdoutLine(mangled, "t0");
      const call = toolCall(entries);
      expect(call?.name).toBe("curl");
      expect(call?.toolUseId).toBe("call_999bc2b3");
      expect(call?.input?.text).toContain("***REDACTED***");
    });

    it("still pairs the recovered result with its call", () => {
      const result = toolResult(parseStdoutLine(mangled, "t0"));
      expect(result?.toolUseId).toBe("call_999bc2b3");
      expect(result?.isError).toBe(false);
    });

    it("recovers a mangled status event as a readable system line", () => {
      const line =
        '{"type":"acpx.status","text":"session updated for ***REDACTED***"***REDACTED***\\" ok"}';
      const entries = parseStdoutLine(line, "t0");
      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe("system");
      expect(entries[0].text).toContain("session updated");
    });

    it("closes an unterminated line so a truncated event still parses", () => {
      const line = '{"type":"acpx.tool_call","name":"$ curl http://x","status":"pending","text":"$ cur';
      expect(toolCall(parseStdoutLine(line, "t0"))?.name).toBe("curl");
    });

    it("falls back to a system placeholder when repair cannot rescue the line", () => {
      const line = '{"type":"acpx.tool_call","name":"$ x", ,,,"status":}';
      const entries = parseStdoutLine(line, "t0");
      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe("system");
      expect(entries[0].text).toContain("tool call");
    });
  });

  describe("status noise", () => {
    it("drops ACP transport plumbing that only restates a tool call", () => {
      for (const text of [
        'terminal/create running terminal/create: /usr/bin/bash "-l" "-c" "ls -la"',
        "terminal/output completed terminal/output: 44748818-9338-429e-8dac-59a47ce4ca98",
        "terminal/release completed terminal/release: 44748818",
        "terminal/wait_for_exit completed terminal/wait_for_exit: 44748818",
        "fs/read_text_file running read_text_file: /tmp/issues.json",
      ]) {
        expect(parseStdoutLine(JSON.stringify({ type: "acpx.status", text }), "t0")).toEqual([]);
      }
    });

    it("keeps plumbing that did not succeed", () => {
      const line = JSON.stringify({ type: "acpx.status", text: "terminal/create failed: EACCES" });
      const entries = parseStdoutLine(line, "t0");
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toContain("EACCES");
    });

    it("keeps session-level status events", () => {
      for (const text of ["session updated", "available commands updated (71)", "usage updated: 12"]) {
        const entries = parseStdoutLine(JSON.stringify({ type: "acpx.status", text }), "t0");
        expect(entries).toHaveLength(1);
        expect(entries[0].kind).toBe("system");
      }
    });
  });

  it("leaves ordinary non-ACP stdout untouched", () => {
    const entries = parseStdoutLine("just some output", "t0");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("stdout");
    expect(entries[0].text).toBe("just some output");
  });

  it("does not treat agent output that quotes an ACP event as an event", () => {
    const line = 'grepped: "type":"acpx.tool_call" appears 42 times';
    const entries = parseStdoutLine(line, "t0");
    expect(entries[0].kind).toBe("stdout");
    expect(entries[0].text).toBe(line);
  });
});
