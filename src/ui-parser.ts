import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * Strip the "tool call (pending|in_progress|completed|failed): " prefix from
 * tool_call text fields so the board shows a clean command summary.
 */
function stripToolCallPrefix(text: string): string {
  return text.replace(/^tool call \((?:pending|in_progress|completed|failed)\):\s*/i, "");
}

/**
 * ACP events that failed JSON parse (e.g. redaction-mangled JSON) still carry
 * the `"type":"acpx.*"` signature.  Surface them as system events instead of
 * raw stdout so the nice view doesn't show a wall of unfiltered NDJSON.
 */
const ACP_EVENT_RE = /"type"\s*:\s*"acpx\.[a-z_]+"/;

/**
 * Guess the event kind from a mangled (non-JSON) ACP-like line for display.
 */
function guessAcpxKind(line: string): string {
  const m = line.match(/"type"\s*:\s*"acpx\.([a-z_]+)"/);
  return m ? m[1].replace(/_/g, " ") : "acp event";
}

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const entries = parseAcpxStdoutLine(line, ts);

  // Post-process: clean up tool_call text prefixes.
  for (const entry of entries) {
    if (entry.kind === "tool_call" && typeof entry.input === "object" && entry.input && "text" in entry.input) {
      const text = (entry.input as Record<string, unknown>).text;
      if (typeof text === "string") {
        (entry.input as Record<string, unknown>).text = stripToolCallPrefix(text);
      }
    }
  }

  // If the standard parser fell back to stdout but the line looks like an ACP
  // event (redaction-mangled JSON), surface it as a system event instead.
  if (
    entries.length === 1 &&
    entries[0].kind === "stdout" &&
    ACP_EVENT_RE.test(line)
  ) {
    return [{ kind: "system", ts, text: `[${guessAcpxKind(line)}] (unparseable event)` }];
  }

  return entries;
}