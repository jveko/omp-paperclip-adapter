import { describe, it, expect } from "vitest";
import { parseStdoutLine } from "./ui-parser";

type Entries = ReturnType<typeof parseStdoutLine>;

const toolCall = (entries: Entries) =>
  entries.find((e) => e.kind === "tool_call") as
    | { name: string; input?: Record<string, unknown>; toolUseId?: string }
    | undefined;

const toolResult = (entries: Entries) =>
  entries.find((e) => e.kind === "tool_result") as
    | { toolName?: string; content: string; toolUseId: string; isError: boolean }
    | undefined;

/**
 * The board picks its terminal-style command renderer over the generic tool
 * card when `input.command` (or `.cmd`) is a string — see isCommandTool in
 * paperclip/ui/src/components/transcript/RunTranscriptView.tsx.
 */
const rendersAsCommand = (input: unknown): boolean => {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
  return Boolean(record && (typeof record.command === "string" || typeof record.cmd === "string"));
};

const ompToolCall = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: "acpx.tool_call", toolCallId: "call_1", ...fields });

describe("parseStdoutLine", () => {
  it("passes through a normal text_delta as assistant", () => {
    const line = JSON.stringify({ type: "acpx.text_delta", text: "Hello", channel: "output" });
    const entries = parseStdoutLine(line, "t0");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("assistant");
  });

  describe("shell tool calls", () => {
    const cmd = '$ ls -la /home/dimaz/foo 2>/dev/null | head -50; echo "---"; pwd';

    it("exposes the command so the board uses its terminal renderer", () => {
      const call = toolCall(parseStdoutLine(
        ompToolCall({ name: cmd, status: "pending", text: `${cmd} (pending): ${cmd.slice(2)}` }),
        "t0",
      ));
      expect(rendersAsCommand(call?.input)).toBe(true);
      expect(call?.input?.command).toBe(cmd.slice(2));
    });

    it("keeps the command identical across status updates so the merge is a no-op", () => {
      const announce = toolCall(parseStdoutLine(
        ompToolCall({ name: cmd, status: "pending", text: `${cmd} (pending): ${cmd.slice(2)}` }),
        "t0",
      ));
      const update = toolCall(parseStdoutLine(
        ompToolCall({ name: cmd, status: "in_progress", text: `tool call (in_progress): ${cmd}\n[terminal] abc` }),
        "t1",
      ));
      expect(update?.input).toEqual(announce?.input);
    });

    it("returns only the output as the result, not the echoed command", () => {
      const result = toolResult(parseStdoutLine(
        ompToolCall({
          name: "$ env | grep -i paperclip",
          status: "completed",
          text: "tool call (completed): $ env | grep -i paperclip\nPAPERCLIP_RUN_ID=abc\nWall time: 0.07 seconds\n[terminal] 2466bd20-e29f-4180",
        }),
        "t0",
      ));
      expect(result?.content).toBe("PAPERCLIP_RUN_ID=abc\nWall time: 0.07 seconds");
    });

    it("says so when omp truncated the payload to a cut-off command echo", () => {
      // omp caps display text at ~500 chars; a longer command leaves no room
      // for output, so the payload is just the command, cut short. That is not
      // the same as a command printing nothing, so say which it was.
      const long = `$ ${"echo ".repeat(120)}done`;
      const result = toolResult(parseStdoutLine(
        ompToolCall({ name: long, status: "completed", text: `tool call (completed): ${long.slice(0, 300)}…` }),
        "t0",
      ));
      expect(result?.content).toContain("not captured");
    });

    it("reports genuinely empty output as empty", () => {
      const result = toolResult(parseStdoutLine(
        ompToolCall({ name: "$ cd /tmp", status: "completed", text: "tool call (completed): $ cd /tmp" }),
        "t0",
      ));
      expect(result?.content).toBe("");
    });

    it("strips omp's terminal handle even when the handle line is itself cut off", () => {
      const result = toolResult(parseStdoutLine(
        ompToolCall({
          name: "$ pwd",
          status: "completed",
          text: "tool call (completed): $ pwd\n/home/dimaz\n\n\nWall time: 0.06 seconds\n[t…",
        }),
        "t0",
      ));
      expect(result?.content).toBe("/home/dimaz\n\nWall time: 0.06 seconds");
    });

    it("does not mistake real output for an echo", () => {
      const result = toolResult(parseStdoutLine(
        ompToolCall({ name: "$ pwd", status: "completed", text: "tool call (completed): $ pwd\n/home/dimaz" }),
        "t0",
      ));
      expect(result?.content).toBe("/home/dimaz");
    });
  });

  describe("non-shell tool calls", () => {
    it("puts the target in the input, not the tool's own label", () => {
      const call = toolCall(parseStdoutLine(
        ompToolCall({
          name: "Reading JWT API access skill",
          status: "pending",
          text: "Reading JWT API access skill (pending): skill://paperclip-agent-jwt-api-access",
        }),
        "t0",
      ));
      expect(call?.input).toEqual({ target: "skill://paperclip-agent-jwt-api-access" });
      expect(rendersAsCommand(call?.input)).toBe(false);
    });

    it("sends an empty input on updates so the board keeps the announced target", () => {
      // The board shallow-merges later inputs for the same toolUseId and skips
      // an empty record — otherwise the result would overwrite the Input pane.
      const call = toolCall(parseStdoutLine(
        ompToolCall({
          name: "Searching for cross-issue write error",
          status: "completed",
          text: "tool call (completed): No matches found",
        }),
        "t0",
      ));
      expect(call?.input).toEqual({});
    });

    it("keeps the payload as the result", () => {
      const result = toolResult(parseStdoutLine(
        ompToolCall({
          name: "Glob for Paperclip server source",
          status: "completed",
          text: "tool call (completed): No files found matching pattern",
        }),
        "t0",
      ));
      expect(result?.content).toBe("No files found matching pattern");
    });

    it("leaves a real structured input from omp untouched", () => {
      const call = toolCall(parseStdoutLine(
        ompToolCall({
          name: "Read",
          status: "pending",
          input: { path: "/tmp/a.txt", limit: 10 },
        }),
        "t0",
      ));
      expect(call?.input).toMatchObject({ path: "/tmp/a.txt", limit: 10 });
    });
  });

  describe("tool display label", () => {
    const labelOf = (name: string) =>
      toolCall(parseStdoutLine(ompToolCall({ name, status: "pending" }), "t0"))?.name;

    it("collapses a full shell command to the command word", () => {
      expect(labelOf('$ ls -la /home 2>/dev/null | head -50; echo "---"; pwd')).toBe("ls");
    });

    it("skips VAR=/export/$(...) noise", () => {
      expect(labelOf('$ JWT=$(cat /tmp/jwt) curl -s -H "Authorization: Bearer $JWT" http://x')).toBe("curl");
    });

    it("skips `cd <dir>` and wrapper commands", () => {
      expect(labelOf('$ cd /home/dimaz/ws\nsudo /usr/bin/python3 -c "import json"')).toBe("python3");
    });

    it("keeps a bare command that happens to look like a wrapper", () => {
      expect(labelOf("$ env | grep -i paperclip | sort")).toBe("env");
    });

    it("skips command-substitution debris left behind by redaction", () => {
      // Redaction ate the "$(cat" of JWT=$(cat /tmp/jwt2.txt).
      expect(labelOf('$ JWT=***REDACTED*** /tmp/jwt2.txt); RUN="a09"\ncurl -s http://x')).toBe("curl");
    });

    it("falls back to 'shell' when no command token is recoverable", () => {
      expect(labelOf("$ | grep foo")).toBe("shell");
    });

    it("leaves a human-authored tool label untouched", () => {
      expect(labelOf("Reading JWT API access skill")).toBe("Reading JWT API access skill");
    });
  });

  describe("redaction-mangled ACP events", () => {
    // The log redactor substitutes secrets after JSON encoding, so a redacted
    // value can leave a raw quote inside a JSON string.
    const mangled =
      '{"type":"acpx.tool_call","name":"$ JWT=***REDACTED***"***REDACTED***\\"\\ncurl -s -H \\"Authorization: Bearer ***REDACTED***" http://codan:3100/api/issues","toolCallId":"call_999bc2b3","status":"completed","text":"tool call (completed): $ JWT=***REDACTED***"***REDACTED***\\"\\ncurl","tag":"tool_call_update"}';

    it("repairs the JSON and recovers a real tool_call instead of a placeholder", () => {
      const call = toolCall(parseStdoutLine(mangled, "t0"));
      expect(call?.name).toBe("curl");
      expect(call?.toolUseId).toBe("call_999bc2b3");
      expect(call?.input?.command).toContain("***REDACTED***");
    });

    it("still pairs the recovered result with its call", () => {
      const result = toolResult(parseStdoutLine(mangled, "t0"));
      expect(result?.toolUseId).toBe("call_999bc2b3");
      expect(result?.isError).toBe(false);
    });

    it("recovers a mangled status event as a readable system line", () => {
      const line = '{"type":"acpx.status","text":"session updated for ***REDACTED***"***REDACTED***\\" ok"}';
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
