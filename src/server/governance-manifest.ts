import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Governance policy materialization (v0.8).
 *
 * The board's `governancePolicy` textarea holds a small rule document (JSON or
 * YAML-ish). The adapter parses + normalizes it into `governance.json` inside
 * the agent's state dir and hands the path to the run child via
 * `PAPERCLIP_GOVERNANCE_MANIFEST`, where the paperclip bridge extension reads it
 * as the policy input for its tool-call and budget handlers.
 *
 * Parsing is deliberately forgiving on style and strict on shape: an
 * unparseable document must never abort a run, so nothing here throws —
 * failures surface as a warn (through the caller's callback) plus a null path,
 * exactly like the failover overlay's guarded write.
 */

/** Fixed manifest filename (overwritten in place on every run with a policy). */
export const GOVERNANCE_MANIFEST_FILE = "governance.json";

/**
 * Normalized policy. The known keys are what the governance handlers read;
 * anything else the operator wrote is passed through untouched (the bridge owns
 * interpreting it), so a newer policy field never gets silently dropped by an
 * older adapter.
 */
export interface GovernancePolicy {
  /**
   * Guardrail rule families, interpreted by the bridge's `tool_call` handler:
   * `pathScopes` (`{ allow: [roots], denyOutside }`, or a bare root/root list;
   * no allow list means the run cwd), `bashDeny` (regex sources matched against
   * whole and compound bash commands), `denyTools` (exact tool names) and
   * `argRevisions` (`{ [tool]: partialArgs }` merged into the executed args of
   * the plain-argument tools). Unknown keys are kept for a newer bridge.
   */
  guardrails?: Record<string, unknown>;
  /** Soft per-process USD cap; finite and > 0 to be enforceable. */
  budgetCapUsd?: number;
  /** Provider ids allowed by endpoint routing. */
  approvedEndpoints?: string[];
  /** Rules that need a human approval before the call runs. */
  approvalRequired?: unknown[];
  [key: string]: unknown;
}

export type GovernanceParse =
  | { kind: "off" }
  | { kind: "ok"; policy: GovernancePolicy }
  | { kind: "error"; error: string };

/** Signals a malformed document; caught by parseGovernancePolicy, never escapes. */
class PolicySyntaxError extends Error {}

/* -------------------------------------------------------------------------- */
/*  YAML-ish reader                                                           */
/* -------------------------------------------------------------------------- */

interface RuleLine {
  indent: number;
  body: string;
}

/** `key:` / `key: value` (bare or quoted key); anything else is a scalar line. */
const MAP_LINE = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.$#-]+)\s*:(\s|$)/;

/** Flow (`[...]`/`{...}`) values, single-pass, quote-aware. */
function parseFlow(text: string): unknown {
  let pos = 0;
  const ws = (): void => {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
  };
  const fail = (what: string): never => {
    throw new PolicySyntaxError(`${what} in "${text}"`);
  };
  const token = (): string => {
    ws();
    const quote = text[pos];
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, pos + 1);
      if (end < 0) fail("unterminated quoted scalar");
      const value = text.slice(pos + 1, end);
      pos = end + 1;
      return value;
    }
    const start = pos;
    while (pos < text.length && !",]}".includes(text[pos])) pos += 1;
    const raw = text.slice(start, pos).trim();
    if (raw === "") fail("empty value");
    return raw;
  };
  const value = (): unknown => {
    ws();
    if (text[pos] === "[") return sequence();
    if (text[pos] === "{") return mapping();
    return plainScalar(token());
  };
  function sequence(): unknown[] {
    pos += 1;
    const out: unknown[] = [];
    ws();
    if (text[pos] === "]") {
      pos += 1;
      return out;
    }
    for (;;) {
      out.push(value());
      ws();
      if (text[pos] === ",") {
        pos += 1;
        continue;
      }
      if (text[pos] === "]") {
        pos += 1;
        return out;
      }
      fail("unterminated flow sequence");
    }
  }
  function mapping(): Record<string, unknown> {
    pos += 1;
    const out: Record<string, unknown> = {};
    ws();
    if (text[pos] === "}") {
      pos += 1;
      return out;
    }
    for (;;) {
      const key = token();
      ws();
      if (text[pos] !== ":") fail('expected ":" in flow mapping');
      pos += 1;
      out[key] = value();
      ws();
      if (text[pos] === ",") {
        pos += 1;
        continue;
      }
      if (text[pos] === "}") {
        pos += 1;
        return out;
      }
      fail("unterminated flow mapping");
    }
  }
  const parsed = value();
  ws();
  if (pos < text.length) fail("trailing characters");
  return parsed;
}

/** A plain (block or flow) scalar: quoted text wins verbatim, else typed. */
function plainScalar(value: string): unknown {
  if (value === "" || value === "~" || value.toLowerCase() === "null") {
    return null;
  }
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1 && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }
  if (value === "true" || value === "false") return value === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function blockScalar(value: string): unknown {
  if (value.startsWith("[") || value.startsWith("{")) return parseFlow(value);
  return plainScalar(value);
}

/**
 * Turn the document into indent-tagged lines. A `- …` item is split into a bare
 * `-` marker plus its content at the content's real column, so list items that
 * open a map (`- tool: bash` + continuation lines) and plain scalars both read
 * as nested blocks without positional hacks.
 */
function toRuleLines(text: string): RuleLine[] {
  const out: RuleLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const expanded = raw.replace(/\t/g, "  ");
    const trimmed = expanded.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = expanded.length - expanded.trimStart().length;
    if (trimmed === "-") {
      out.push({ indent, body: "-" });
      continue;
    }
    if (trimmed.startsWith("- ")) {
      const rest = trimmed.slice(2).trim();
      out.push({ indent, body: "-" });
      if (rest !== "") out.push({ indent: indent + (trimmed.length - rest.length), body: rest });
      continue;
    }
    out.push({ indent, body: trimmed });
  }
  return out;
}

/** Indent-scoped YAML-ish reader: nested maps, lists, block + flow scalars. */
function parseYamlish(text: string): Record<string, unknown> {
  const lines = toRuleLines(text);
  if (lines.length === 0) return {};
  let pos = 0;

  const parseValue = (indent: number): unknown => {
    const line = lines[pos];
    const start = pos;
    let value: unknown;
    if (line.body === "-") value = parseList(indent);
    else if (!MAP_LINE.test(line.body)) {
      pos += 1;
      value = blockScalar(line.body);
    } else value = parseMap(indent);
    if (pos === start) throw new PolicySyntaxError(`could not read "${line.body}"`);
    return value;
  };

  function parseMap(indent: number): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent !== indent || line.body === "-") break;
      if (!MAP_LINE.test(line.body)) {
        throw new PolicySyntaxError(`expected "key: value", got "${line.body}"`);
      }
      const colon = line.body.indexOf(":");
      const key = line.body.slice(0, colon).trim();
      const rest = line.body.slice(colon + 1).trim();
      pos += 1;
      if (rest !== "") {
        map[key] = blockScalar(rest);
        continue;
      }
      const next = lines[pos];
      // A nested block, or a sequence written at the key's own indent.
      if (next && (next.indent > indent || (next.indent === indent && next.body === "-"))) {
        map[key] = parseValue(next.indent);
      } else {
        map[key] = null;
      }
    }
    return map;
  }

  function parseList(indent: number): unknown[] {
    const list: unknown[] = [];
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent !== indent || line.body !== "-") break;
      pos += 1;
      const next = lines[pos];
      list.push(next && next.indent > indent ? parseValue(next.indent) : null);
    }
    return list;
  }

  const root = parseValue(lines[0].indent);
  if (pos < lines.length) {
    throw new PolicySyntaxError(`unexpected indentation at "${lines[pos].body}"`);
  }
  if (!isPlainObject(root)) {
    throw new PolicySyntaxError("the policy document must be a mapping of keys to values");
  }
  return root;
}

/* -------------------------------------------------------------------------- */
/*  Normalization                                                             */
/* -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanStrings(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Approval rules arrive as a list, a single rule object, or a tool name. */
function ruleList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    const kept = value.filter((item) =>
      (typeof item === "string" && item.trim().length > 0) || isPlainObject(item));
    return kept.length > 0 ? kept : null;
  }
  if (typeof value === "string") return value.trim() ? [value.trim()] : null;
  if (isPlainObject(value)) return [value];
  return null;
}

/**
 * Normalize a parsed document. Only known keys are validated; a known key with
 * an unusable shape is dropped rather than guessed at, so a typo can't silently
 * weaken a rule. `live` reports whether anything is actually enforceable — an
 * all-empty document must not auto-approve via the overlay fold.
 */
function normalizePolicy(raw: Record<string, unknown>): { policy: GovernancePolicy; live: boolean } {
  const policy: GovernancePolicy = { ...raw };
  let live = false;

  if (isPlainObject(raw.guardrails) && Object.keys(raw.guardrails).length > 0) {
    policy.guardrails = raw.guardrails;
    live = true;
  } else {
    delete policy.guardrails;
  }

  const cap = typeof raw.budgetCapUsd === "string" ? Number(raw.budgetCapUsd) : raw.budgetCapUsd;
  if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
    policy.budgetCapUsd = cap;
    live = true;
  } else {
    delete policy.budgetCapUsd;
  }

  const endpoints = cleanStrings(raw.approvedEndpoints);
  if (endpoints.length > 0) {
    policy.approvedEndpoints = endpoints;
    live = true;
  } else {
    delete policy.approvedEndpoints;
  }

  const approvals = ruleList(raw.approvalRequired);
  if (approvals) {
    policy.approvalRequired = approvals;
    live = true;
  } else {
    delete policy.approvalRequired;
  }

  return { policy, live };
}

/**
 * Parse `config.governancePolicy` (JSON or YAML-ish text, or an already-parsed
 * object). `off` means "no governance configured" (absent, blank, or nothing
 * enforceable); `error` means the document was unreadable and the caller should
 * say so. Never throws.
 */
export function parseGovernancePolicy(value: unknown): GovernanceParse {
  if (value === undefined || value === null) return { kind: "off" };
  let raw: unknown;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return { kind: "off" };
    try {
      raw = readDocument(text);
    } catch (err) {
      return { kind: "error", error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    raw = value;
  }
  if (!isPlainObject(raw)) {
    return { kind: "error", error: "the policy must be a mapping of keys to values" };
  }
  const { policy, live } = normalizePolicy(raw);
  return live ? { kind: "ok", policy } : { kind: "off" };
}

/** JSON when the document is JSON-shaped and parses; the YAML-ish reader else. */
function readDocument(text: string): unknown {
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      // JSON-shaped but broken: the YAML-ish reader also understands flow
      // style, and reports a precise syntax error for what it cannot read.
    }
  }
  return parseYamlish(text);
}

/** True when a policy is configured AND has something enforceable to run. */
export function governancePolicyActive(config: Record<string, unknown>): boolean {
  return parseGovernancePolicy(config.governancePolicy).kind === "ok";
}

/**
 * Materialize the governance manifest for the paperclip bridge extension.
 * Returns the path written, or null when governance is off, the document is
 * unreadable, or the write failed — the last two route a `warn` message so the
 * board shows why policy is not in effect. Mirrors the v0.7 skills-manifest
 * fix: create the state dir (recursive) BEFORE writing.
 */
export async function materializeGovernanceManifest(
  config: Record<string, unknown>,
  dir: string,
  warn?: (message: string) => void | Promise<void>,
): Promise<string | null> {
  const parsed = parseGovernancePolicy(config.governancePolicy);
  if (parsed.kind === "off") return null;
  if (parsed.kind === "error") {
    await warn?.(`omp governance policy ignored: could not parse governancePolicy (${parsed.error})`);
    return null;
  }
  const file = path.join(dir, GOVERNANCE_MANIFEST_FILE);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(parsed.policy, null, 2)}\n`, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await warn?.(`omp governance policy ignored: writing ${file} failed (${message})`);
    return null;
  }
  return file;
}
