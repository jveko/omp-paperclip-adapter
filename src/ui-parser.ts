import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/** Tool-call statuses omp splices into its display text. */
const STATUS = "pending|in_progress|completed|failed|cancelled";
const STATUS_PREFIX_RE = new RegExp(`^tool call \\((?:${STATUS})\\):\\s*`, "i");
const STATUS_SUFFIX_RE = new RegExp(`\\s+\\((?:${STATUS})\\):[\\s\\S]*$`, "i");

/**
 * Strip the redundant status prefix/suffix omp injects into tool_call text.
 * omp emits two shapes: "tool call (pending): $ cmd ..." and "$ cmd ... (pending): cmd".
 * We want the bare command for both. `[\s\S]*$` (not `.*$`) so the suffix form is
 * still recognised when the echoed command spans multiple lines.
 */
function cleanToolText(text: string): string {
  return text.replace(STATUS_PREFIX_RE, "").replace(STATUS_SUFFIX_RE, "").trim();
}

/**
 * tool_result content is `text` too, so it carries the same "tool call (status):"
 * prefix — but its tail is real command output, which must never be stripped.
 */
function cleanToolResultContent(content: string): string {
  return content.replace(STATUS_PREFIX_RE, "");
}

/** Wrappers to skip when looking for the real command in a shell line. */
const SHELL_WRAPPERS = new Set(["sudo", "nohup", "time", "exec", "export"]);

/**
 * A plausible command word. Redaction can chew a `$(` off the front of a
 * substitution ("JWT=$(cat /tmp/jwt.txt)" -> "JWT=***REDACTED*** /tmp/jwt.txt)"),
 * leaving debris that is not a command; anything with quotes, parens, globs or
 * `*` (including "***REDACTED***" itself) is skipped rather than labelled.
 */
const COMMAND_WORD_RE = /^[A-Za-z0-9_.+-]+$/;

/**
 * Derive a short display label for a tool call. omp sets `name` to the full
 * shell command, which the board renders with text-transform:capitalize and
 * HTML-escaping — producing "Used $ Ls /Home/Dimaz/... 2&gt;/Dev/Null; Echo".
 * A concise command label avoids that mangling while the full command stays
 * in `input.text`.
 */
function toolDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "acp_tool";
  // Non-"$" names are already human-authored labels ("Reading JWT API skill").
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
    if (SHELL_WRAPPERS.has(word)) continue;
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
 * ACP events that failed JSON parse (e.g. redaction-mangled JSON) still carry
 * the `"type":"acpx.*"` signature.
 */
const ACP_EVENT_RE = /"type"\s*:\s*"acpx\.[a-z_]+"/;

/** Did the upstream parser give up on a line that is clearly an ACP event? */
function isUnparsedAcpEvent(entries: TranscriptEntry[], line: string): boolean {
  return (
    entries.length === 1 &&
    entries[0].kind === "stdout" &&
    line.trimStart().startsWith("{") &&
    ACP_EVENT_RE.test(line)
  );
}

/**
 * Guess the event kind from a mangled (non-JSON) ACP-like line for display.
 */
function guessAcpxKind(line: string): string {
  const m = line.match(/"type"\s*:\s*"acpx\.([a-z_]+)"/);
  return m ? m[1].replace(/_/g, " ") : "acp event";
}

/**
 * omp's log redactor substitutes secrets *after* JSON encoding, so a redacted
 * value can leave a raw `"` inside a string ("$ JWT=***REDACTED***"***REDACTED***\"")
 * and the whole event fails to parse — losing every tool call that touched a
 * secret. Re-escape those strays: inside a JSON string a `"` only ends the
 * string when the next non-space char is one of `,}]:`; anything else means the
 * quote is content. Also re-escapes raw control characters and closes an
 * unterminated tail so a cut-off line still yields a partial event.
 */
function repairMangledJson(line: string): string {
  const out: string[] = [];
  const closers: string[] = [];
  let inString = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!inString) {
      if (ch === '"') inString = true;
      else if (ch === "{") closers.push("}");
      else if (ch === "[") closers.push("]");
      else if (ch === "}" || ch === "]") closers.pop();
      out.push(ch);
      continue;
    }
    if (ch === "\\") {
      out.push(ch, line[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < line.length && /\s/.test(line[j])) j++;
      if (j >= line.length || ",}]:".includes(line[j])) {
        inString = false;
        out.push(ch);
      } else {
        out.push('\\"');
      }
      continue;
    }
    // Raw control characters are illegal inside a JSON string.
    out.push(ch < " " ? JSON.stringify(ch).slice(1, -1) : ch);
  }

  if (inString) out.push('"');
  while (closers.length) out.push(closers.pop() as string);
  return out.join("");
}

/**
 * ACP transport chatter that only restates a tool call the board already shows
 * as a card — with the raw escaped bash spliced in. Successful plumbing is
 * dropped; anything that is not a plain running/completed transition (a
 * failure, a cancellation) is kept.
 */
const PLUMBING_STATUS_RE = /^(?:terminal|fs)\/\S+\s+(?:running|completed)\b/;

function isPlumbingStatus(text: string): boolean {
  return PLUMBING_STATUS_RE.test(text.trim());
}

/** Tidy a single entry for display; returns [] to drop it. */
function polish(entry: TranscriptEntry): TranscriptEntry[] {
  if (entry.kind === "tool_call") {
    let input = entry.input;
    const record =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null;
    if (record && typeof record.text === "string") {
      input = { ...record, text: cleanToolText(record.text) };
    }
    return [{ ...entry, name: toolDisplayName(entry.name), input }];
  }

  if (entry.kind === "tool_result") {
    return [
      {
        ...entry,
        toolName: entry.toolName === undefined ? undefined : toolDisplayName(entry.toolName),
        content: cleanToolResultContent(entry.content),
      },
    ];
  }

  if (entry.kind === "system" && isPlumbingStatus(entry.text)) return [];

  return [entry];
}

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  let entries = parseAcpxStdoutLine(line, ts);

  // Redaction-mangled ACP event: repair the JSON and re-parse rather than
  // dumping the raw NDJSON (or a contentless placeholder) into the nice view.
  if (isUnparsedAcpEvent(entries, line)) {
    const repaired = repairMangledJson(line);
    const reparsed = repaired === line ? null : parseAcpxStdoutLine(repaired, ts);
    if (reparsed && !isUnparsedAcpEvent(reparsed, repaired)) {
      entries = reparsed;
    } else {
      return [{ kind: "system", ts, text: `[${guessAcpxKind(line)}] (unparseable event)` }];
    }
  }

  return entries.flatMap(polish);
}
