import { parseAcpxStdoutLine } from "./server/adapters/acp/ui.js";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * omp packs everything into one display string, in two shapes:
 *
 *   announce (status=pending) "<name> (pending): <argument>"
 *   update   (status=*)       "tool call (<status>): <payload>"
 *
 * For a shell tool the announce argument just repeats the command in `name`
 * and the update payload is `<command>\n<output>`. For every other tool the
 * announce argument is the real target (a path, a glob, a skill:// ref) and
 * the update payload is the result. So the interesting half is the tail in
 * both cases; `detail` peels off whichever head is present.
 */
const STATUS = "pending|in_progress|completed|failed|cancelled";
const UPDATE_HEAD_RE = new RegExp(`^tool call \\((?:${STATUS})\\):[ \\t]*`, "i");
const ANNOUNCE_HEAD_RE = new RegExp(`^[\\s\\S]*?\\s+\\((?:${STATUS})\\):[ \\t]*`, "i");

function toolDetail(text: string): string {
  const update = text.match(UPDATE_HEAD_RE);
  if (update) return text.slice(update[0].length);
  const announce = text.match(ANNOUNCE_HEAD_RE);
  return announce ? text.slice(announce[0].length) : text;
}

/** The bare command for a shell tool call, or null if `name` is not one. */
function shellCommand(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.startsWith("$") ? trimmed.slice(1).trim() || null : null;
}

/**
 * Shown instead of an empty result when omp's display cap left no room for the
 * output. Without it a card that captured nothing is indistinguishable from a
 * command that genuinely printed nothing.
 */
const OUTPUT_OMITTED = "[output not captured — omp truncated this event]";

/**
 * Drop omp's trailing ACP terminal handle, then tighten the blank run it
 * leaves in front of the wall-time footer.
 */
function stripTerminalFooter(output: string): string {
  const at = output.lastIndexOf("\n[");
  if (at === -1) return tidyWallTime(output);
  const last = output.slice(at + 1);
  const cut = last.replace(/…$/, "");
  const isFooter =
    last.startsWith("[terminal]") ||
    // The handle line can itself be cut off by omp's cap, leaving "[t…".
    (last.endsWith("…") && cut.length > 1 && "[terminal] ".startsWith(cut));
  return tidyWallTime(isFooter ? output.slice(0, at).replace(/\s+$/, "") : output);
}

function tidyWallTime(output: string): string {
  return output.replace(/\n{3,}(?=Wall time:)/, "\n\n");
}

/**
 * A shell update payload re-echoes the command before the output. The command
 * is already the card's headline, so drop the echo and keep only the output.
 */
function commandOutput(payload: string, name: string): string {
  const echo = name.trim();
  // A payload that is exactly the echo means the command really printed nothing.
  if (payload === echo) return "";
  if (payload.startsWith(echo)) {
    return stripTerminalFooter(payload.slice(echo.length).replace(/^\r?\n/, ""));
  }
  // omp caps the display text at ~500 chars, so a command longer than that
  // consumes the whole budget and the payload is a cut-off echo.
  const cut = payload.replace(/…$/, "");
  if (cut && echo.startsWith(cut)) return OUTPUT_OMITTED;
  return stripTerminalFooter(payload);
}

/**
 * True when `input` is the record the upstream parser synthesizes from omp's
 * flat event ({text, status}) rather than a real structured tool input, which
 * must be passed through untouched.
 */
function isSynthesizedInput(record: Record<string, unknown>): boolean {
  return Object.keys(record).every((key) => key === "text" || key === "status");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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

/**
 * Reshape a tool_call so the board renders it well.
 *
 * The board decides between its terminal-style command renderer and the generic
 * tool card on `input.command`/`input.cmd` being a string, so a shell call must
 * expose the command under `command` — `text` gets the wrench card and a
 * capitalized command as the title. Everything else gets its target under
 * `target`, which the board's input summarizer also looks for.
 *
 * The board folds later events for the same toolUseId into the first card by
 * shallow-merging their `input`, and skips an empty record. So a status update
 * (whose payload is the result, not the input) deliberately carries no keys for
 * a non-shell tool: that keeps the target captured at announce time instead of
 * overwriting the Input pane with the result.
 */
function polishToolCall(entry: Extract<TranscriptEntry, { kind: "tool_call" }>): TranscriptEntry {
  const name = toolDisplayName(entry.name);
  const record = asRecord(entry.input);
  if (!record || !isSynthesizedInput(record)) return { ...entry, name };

  const command = shellCommand(entry.name);
  if (command) return { ...entry, name, input: { command } };

  const status = typeof record.status === "string" ? record.status : "";
  const announced = status === "" || status === "pending";
  const text = typeof record.text === "string" ? record.text : "";
  const target = announced ? toolDetail(text).trim() : "";
  return { ...entry, name, input: target ? { target } : {} };
}

/**
 * The result pane should hold the output alone: the command (or target) is
 * already the headline right above it, and omp repeats it in the payload.
 */
function polishToolResult(entry: Extract<TranscriptEntry, { kind: "tool_result" }>): TranscriptEntry {
  const raw = entry.toolName ?? "";
  const command = shellCommand(raw);
  const payload = toolDetail(entry.content);
  return {
    ...entry,
    toolName: entry.toolName === undefined ? undefined : toolDisplayName(entry.toolName),
    content: command ? commandOutput(payload, raw) : payload,
  };
}

/** Tidy a single entry for display; returns [] to drop it. */
function polish(entry: TranscriptEntry): TranscriptEntry[] {
  if (entry.kind === "tool_call") return [polishToolCall(entry)];
  if (entry.kind === "tool_result") return [polishToolResult(entry)];
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
