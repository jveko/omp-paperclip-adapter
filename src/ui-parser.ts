import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * The managed lane's transcript parser.
 *
 * The supervisor relays the worker's RPC frames to the adapter as
 * `AdapterRuntimeEvent` objects, and Paperclip records them as JSON lines. The
 * shapes this module recognises:
 *
 *   {"eventType":"omp.turn","payload":{"text":"..."}}                 -> assistant
 *   {"eventType":"omp.tool_call","payload":{"phase":"tool_call",...}} -> tool_call
 *   {"eventType":"omp.tool_call","payload":{"phase":"tool_result",...}} -> tool_result
 *   {"eventType":"run.system","message":"..."}                        -> system
 *   {"eventType":"omp.subagent","message":"explore running"}          -> system
 *   {"eventType":"omp.log","payload":{"stream":"stderr","chunk":"..."}} -> stderr / stdout
 *
 * Everything else — an unknown event type, a JSON object that is not an event,
 * a malformed line, or plain text — is passed through verbatim as a `stdout`
 * entry. A parser that throws would take the whole transcript down with one bad
 * line.
 */

/** The label for a tool event that carries no usable name. */
const FALLBACK_TOOL_NAME = "omp_tool";

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A non-empty string, or null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stdout(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}

/** Wrappers to skip when looking for the real command in a shell line. */
const SHELL_WRAPPERS: Record<string, true> = {
  sudo: true,
  nohup: true,
  time: true,
  exec: true,
  export: true,
};

/**
 * A plausible command word. Redaction can chew a `$(` off the front of a
 * substitution ("JWT=$(cat /tmp/jwt.txt)" -> "JWT=***REDACTED*** /tmp/jwt.txt)"),
 * leaving debris that is not a command; anything with quotes, parens, globs or
 * `*` (including "***REDACTED***" itself) is skipped rather than labelled.
 */
const COMMAND_WORD_RE = /^[A-Za-z0-9_.+-]+$/;

/**
 * Derive a short display label for a tool call. A shell call arrives with the
 * command as its name, which the board renders with text-transform:capitalize
 * and HTML-escaping — producing "Used $ Ls /Home/Dimaz/... 2&gt;/Dev/Null; Echo".
 * Naming the command word avoids that mangling; any other name is already a
 * human-authored label and is left alone.
 */
function toolDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return FALLBACK_TOOL_NAME;
  if (!trimmed.startsWith("$")) return trimmed;
  // Drop $(...) / `...` substitutions so a token like "/tmp/jwt)" can't leak in.
  const stripped = trimmed
    .slice(1)
    .replace(/\$\([^)]*\)/g, "")
    .replace(/`[^`]*`/g, "");
  const words = stripped.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // An operator before any command means there is nothing useful to label.
    if (/^[|&;<>(){}]/.test(word)) break;
    if (word.includes("=")) continue; // VAR=value assignment
    if (SHELL_WRAPPERS[word] === true) continue;
    if (word === "cd") {
      i++; // also skip the directory argument
      continue;
    }
    // "/usr/bin/python3" reads better as "python3" once capitalized.
    const label = word.slice(word.lastIndexOf("/") + 1).replace(/[;&]+$/, "");
    if (COMMAND_WORD_RE.test(label)) return label;
  }
  return "shell";
}

/**
 * A tool event carries a phase and identity, never the arguments or output:
 * `tool_call` opens the board's card, `tool_result` closes it. The result
 * content is empty because the relay does not carry it.
 */
function toolEntries(
  payload: Record<string, unknown>,
  message: string | null,
  ts: string,
): TranscriptEntry[] {
  const name = toolDisplayName(asString(payload.toolName) ?? message ?? "");
  const toolUseId = asString(payload.toolCallId);
  if (payload.phase === "tool_result") {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: toolUseId ?? name,
      toolName: name,
      content: "",
      isError: false,
    }];
  }
  return [{
    kind: "tool_call",
    ts,
    name,
    ...(toolUseId !== null ? { toolUseId } : {}),
    input: {},
  }];
}

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const event = parseJson(line);
  if (event === null) return stdout(line, ts);
  const payload = asRecord(event.payload);
  switch (asString(event.eventType)) {
    case "omp.turn": {
      // Lifecycle-only turns (`agent_start`, `turn_end`, ...) carry no content.
      const text = asString(payload?.text) ?? asString(event.message);
      return text === null ? [] : [{ kind: "assistant", ts, text }];
    }
    case "omp.tool_call":
      return toolEntries(payload ?? {}, asString(event.message), ts);
    case "run.system": {
      const text = asString(event.message) ?? asString(payload?.message);
      return text === null ? [] : [{ kind: "system", ts, text }];
    }
    case "omp.subagent": {
      const agent = asString(payload?.agent);
      const status = asString(payload?.status);
      const text = asString(event.message)
        ?? (agent !== null && status !== null ? `${agent} ${status}` : null);
      return text === null ? [] : [{ kind: "system", ts, text }];
    }
    case "omp.log": {
      const chunk = asString(payload?.chunk);
      if (chunk === null) return [];
      return [{
        kind: payload?.stream === "stdout" ? "stdout" : "stderr",
        ts,
        text: chunk.replace(/\r?\n$/, ""),
      }];
    }
    default:
      return stdout(line, ts);
  }
}
