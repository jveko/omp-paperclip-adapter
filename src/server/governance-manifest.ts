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

/** One `approvalRequired` rule as an operator writes it (T5). */
export interface GovernanceApprovalRule {
  /** Exact tool name, or a `prefix*` pattern such as `mcp__*`. */
  tool: string;
  /** Optional note surfaced on the board card with the request. */
  reason?: string;
  /** Optional risk label; the request reports `high` when unset. */
  risk?: string;
}

/** A rule may also be written as just the tool name. */
export type GovernanceApprovalRuleInput = string | GovernanceApprovalRule;

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
  /**
   * Soft USD cap enforced per bridge session epoch (fresh module per
   * `session/new`, so subagents each get their own cap); finite and > 0 to
   * be enforceable. Accumulates across runs only under a warm handle.
   */
  budgetCapUsd?: number;
  /**
   * Provider ids allowed by endpoint routing. The adapter writes the complement
   * to the run child as omp's `disabledProviders` (governance-overlay.ts); the
   * bridge never reads this key.
   */
  approvedEndpoints?: string[];
  /**
   * Tools a human must approve before the bridge lets them run (T5). Kept in
   * the shape the operator wrote — a bare tool name or a
   * `{ tool, reason?, risk? }` object, where `tool` may end in `*` for a prefix
   * pattern such as `mcp__*` — and validated so a rule that can never match
   * (no usable `tool`) is dropped rather than guessed at. The bridge's
   * `tool_call` handler posts a `request_board_approval` and blocks the call;
   * that is ADVISORY — approving wakes a NEW run, this one never resumes.
   */
  approvalRequired?: GovernanceApprovalRuleInput[];
  /**
   * Folders where every tool call that touches them must be held for a human,
   * in every approval mode. Enforced twice, on purpose:
   * - omp's own `tools.restrictedFolders` (written by governance-overlay.ts)
   *   raises a prompt, which this lane's ACP proxy would auto-answer under
   *   `approve-all`;
   * - the bridge (paperclip-bridge.ts) matches the call's paths against these
   *   folders and posts a board approval, which is the ask a human actually
   *   sees under the single-gate `yolo`.
   * Paths are handed to omp as written: `~` and relative entries resolve
   * against the run cwd there, and the bridge mirrors that.
   */
  restrictedFolders?: string[];
  [key: string]: unknown;
}

export type GovernanceParse =
  | { kind: "off"; vacuous?: string[] }
  | { kind: "ok"; policy: GovernancePolicy; enforceable: boolean; vacuous?: string[] }
  | { kind: "error"; error: string };

/**
 * The keys `paperclip-bridge.ts` reads as rules — from the `guardrails` bag when
 * there is one, from the document root otherwise (its `normalizeGuardrails`
 * `bag` fallback). Listed in one place so this audit and the handler cannot drift
 * apart silently: a key outside it is reported to the operator, never guessed at.
 */
const RULE_BAG_KEYS = [
  "pathScopes", "bashDeny", "denyTools", "argRevisions", "approvalRequired",
] as const;

/** Why a written key carries no rule, phrased for the operator. */
const INERT_REASON: Record<(typeof RULE_BAG_KEYS)[number], string> = {
  pathScopes: "no usable scope",
  bashDeny: "no compilable pattern",
  denyTools: "no usable tool name",
  argRevisions: "no usable revision",
  approvalRequired: "no usable tool rule",
};

/**
 * Keys that ARE rules somewhere else in the document but are inert here. The
 * bridge hoists `budgetCapUsd` and the adapter reads `approvedEndpoints` from
 * the policy ROOT only, so either one inside `guardrails` enforces nothing.
 */
const MISPLACED_REASON: Record<string, string> = {
  budgetCapUsd: "only read at the policy root, not inside guardrails",
  approvedEndpoints: "only read at the policy root, not inside guardrails",
};

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

/**
 * Validate `approvalRequired` rules (T5). Accepted shapes: a bare tool name, a
 * `{ tool, reason?, risk? }` object, or a list of either — a single rule object
 * or string is read as a one-item list. A rule is kept only when it can name a
 * tool: an object without a usable `tool` is dropped rather than guessed at,
 * because an approval rule that never matches is a silently missing rail, and
 * a document whose only content was such a rule must not count as live.
 */
function normalizeApprovalRules(value: unknown): GovernanceApprovalRuleInput[] | null {
  const items = Array.isArray(value) ? value : [value];
  const kept: GovernanceApprovalRuleInput[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const tool = item.trim();
      if (tool) kept.push(tool);
      continue;
    }
    if (!isPlainObject(item)) continue;
    const tool = typeof item.tool === "string" ? item.tool.trim() : "";
    if (!tool) continue;
    const rule: GovernanceApprovalRule = { ...item, tool };
    if ("reason" in item && typeof item.reason !== "string") delete rule.reason;
    if ("risk" in item && typeof item.risk !== "string") delete rule.risk;
    kept.push(rule);
  }
  return kept.length > 0 ? kept : null;
}

/**
 * Does this `pathScopes` value restrict anything once the bridge normalizes it?
 * An allow list only bites when out-of-scope calls are denied, and an empty list
 * means "the run cwd" — `denyOutside: false` is therefore no rule at all.
 */
function pathScopesEffective(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return cleanStrings(value).length > 0;
  if (!isPlainObject(value)) return false;
  return value.denyOutside !== false;
}

/** At least one `bashDeny` source the bridge will not skip as unparseable. */
function bashDenyEffective(value: unknown): boolean {
  return cleanStrings(value).some((source) => {
    try {
      new RegExp(source);
      return true;
    } catch {
      return false;
    }
  });
}

/** Is this `argRevisions` bag a tool→partial-args map with something to merge? */
function argRevisionsEffective(value: unknown): boolean {
  return isPlainObject(value)
    && Object.values(value).some((revision) => isPlainObject(revision) && Object.keys(revision).length > 0);
}

/**
 * Audit a guardrails bag in key order, naming every entry that carries no rule:
 * a family that normalized to nothing, or a key the bridge never reads. Unknown
 * keys are reported rather than guessed at, because `denyToolz` is a rail the
 * operator believes exists — and arming auto-approval on the strength of a
 * document that enforces nothing is the fail-open this audit exists to stop.
 *
 * `reportUnknown` is off for the root-shorthand bag: there, unrecognized keys
 * are documented pass-through for a newer bridge, not operator typos.
 */
function auditGuardrails(
  bag: Record<string, unknown>,
  reportUnknown: boolean,
): { enforceable: boolean; vacuous: string[] } {
  let enforceable = false;
  const vacuous: string[] = [];
  const usable: Record<(typeof RULE_BAG_KEYS)[number], boolean> = {
    pathScopes: pathScopesEffective(bag.pathScopes),
    bashDeny: bashDenyEffective(bag.bashDeny),
    denyTools: cleanStrings(bag.denyTools).length > 0,
    argRevisions: argRevisionsEffective(bag.argRevisions),
    approvalRequired: normalizeApprovalRules(bag.approvalRequired) !== null,
  };
  for (const key of Object.keys(bag)) {
    const ruleKey = (RULE_BAG_KEYS as readonly string[]).includes(key)
      ? key as (typeof RULE_BAG_KEYS)[number]
      : null;
    if (ruleKey ? usable[ruleKey] : false) {
      enforceable = true;
      continue;
    }
    if (ruleKey) vacuous.push(`${ruleKey}: ${INERT_REASON[ruleKey]}`);
    // Non-rule keys are only a typo INSIDE a `guardrails` bag: at the policy
    // root, `approvedEndpoints` is a real key and anything else the bridge does
    // not know is documented pass-through for a newer bridge.
    else if (reportUnknown) {
      vacuous.push(MISPLACED_REASON[key]
        ? `${key}: ${MISPLACED_REASON[key]}`
        : `${key}: not a guardrail key`);
    }
  }
  return { enforceable, vacuous };
}

/**
 * Normalize a parsed document and audit what its rules can actually do.
 *
 * Only known keys are validated; a known key with an unusable shape is dropped
 * rather than guessed at, so a typo can't silently weaken a rule. `live` says
 * the document configured anything at all (a bridge rail or endpoint routing);
 * `enforceable` says the BRIDGE has a rule to run — the only condition under
 * which omp's own approval gate may be relaxed. They differ on purpose: a
 * routing-only policy needs no bridge handler, so it must never arm auto-
 * approval, and a `{denyTools: []}` policy arms nothing at all.
 */
function normalizePolicy(raw: Record<string, unknown>): {
  policy: GovernancePolicy;
  live: boolean;
  enforceable: boolean;
  vacuous: string[];
} {
  const policy: GovernancePolicy = { ...raw };
  const bag = isPlainObject(raw.guardrails) ? raw.guardrails : null;
  // Mirrors the bridge's `normalizeGuardrails` bag choice exactly: a canonical
  // `guardrails` map when there is one, the document root otherwise.
  const bagIsGuardrails = bag !== null && Object.keys(bag).length > 0;
  const audit = auditGuardrails(bagIsGuardrails && bag ? bag : raw, bagIsGuardrails);

  if (bagIsGuardrails && bag) {
    policy.guardrails = bag;
  } else {
    delete policy.guardrails;
  }

  const cap = typeof raw.budgetCapUsd === "string" ? Number(raw.budgetCapUsd) : raw.budgetCapUsd;
  if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
    policy.budgetCapUsd = cap;
  } else {
    delete policy.budgetCapUsd;
  }

  const endpoints = cleanStrings(raw.approvedEndpoints);
  if (endpoints.length > 0) {
    policy.approvedEndpoints = endpoints;
  } else {
    delete policy.approvedEndpoints;
  }

  const approvals = normalizeApprovalRules(raw.approvalRequired);
  if (approvals) {
    policy.approvalRequired = approvals;
  } else {
    delete policy.approvalRequired;
  }

  // A restricted-folder rail is enforced by the bridge as an approval rule, so
  // it counts as bridge-enforceable: the manifest must exist (and the run must
  // keep the single gate) or the fence has no handler. A key that names no
  // usable path is dropped and reported rather than emitted as an empty list,
  // which omp would read as "nothing restricted".
  const vacuous = [...audit.vacuous];
  const restrictedFolders = cleanStrings(raw.restrictedFolders);
  if (restrictedFolders.length > 0) {
    policy.restrictedFolders = restrictedFolders;
  } else {
    delete policy.restrictedFolders;
    if (raw.restrictedFolders !== undefined) vacuous.push("restrictedFolders: no usable path");
  }

  // The root budget and approval lanes are read off the document by the bridge
  // itself; an `approvalRequired` inside the bag is already counted by the audit
  // (the bridge reads `document.approvalRequired ?? bag.approvalRequired`).
  const enforceable = audit.enforceable
    || policy.budgetCapUsd !== undefined
    || policy.approvalRequired !== undefined
    || policy.restrictedFolders !== undefined;
  const routing = policy.approvedEndpoints !== undefined;
  return {
    policy,
    live: enforceable || routing,
    enforceable,
    vacuous,
  };
}

/**
 * Parse `config.governancePolicy` (JSON or YAML-ish text, or an already-parsed
 * object). `off` means "no governance configured" (absent, blank, or nothing
 * the bridge or the overlay can act on); `error` means the document was
 * unreadable and the caller must say so rather than run ungoverned silently.
 * `enforceable` separates "the bridge has rules" from "the operator only asked
 * for endpoint routing", which is what decides the single-gate relaxation.
 * Never throws.
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
  const { policy, live, enforceable, vacuous } = normalizePolicy(raw);
  const inert = vacuous.length > 0 ? { vacuous } : {};
  if (!live) return { kind: "off", ...inert };
  return { kind: "ok", policy, enforceable, ...inert };
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

/**
 * True when a policy is configured AND the bridge has a rule to enforce. This
 * is the arming predicate, not "the document parsed": endpoint routing is
 * enforced by omp's own config and never justifies auto-approval on its own.
 */
export function governancePolicyActive(config: Record<string, unknown>): boolean {
  const parsed = parseGovernancePolicy(config.governancePolicy);
  return parsed.kind === "ok" && parsed.enforceable;
}

/**
 * Reject `permissionMode: deny-all` on top of a policy that scopes or rewrites
 * tool calls.
 *
 * `deny-all` lives in omp's permission proxy, not in the bridge: every request
 * omp still raises — a critical bash command, a restricted folder, and every
 * gated tool when omp's own approval mode is in force — is refused by the
 * proxy before the bridge's handler can allow the call. A policy whose
 * `pathScopes`/`argRevisions` presume those calls run therefore describes a run
 * that cannot happen, and the operator sees a governed-looking config that
 * vetoes its own tools. Fail at config time instead of at the first call.
 *
 * A deny-only policy is coherent with `deny-all` (both layers agree), and so is
 * `deny-all` alone, so neither is rejected.
 */
export function validateGovernanceGate(config: Record<string, unknown>): string | null {
  const rawMode = config.permissionMode ?? config.acpPermissionMode;
  const mode = typeof rawMode === "string" && rawMode.trim() !== "" ? rawMode.trim() : "approve-all";
  if (mode !== "deny-all") return null;
  const parsed = parseGovernancePolicy(config.governancePolicy);
  if (parsed.kind !== "ok") return null;
  // Same bag choice the bridge and the audit make: a `guardrails` map when
  // there is one, the document root otherwise (the hand-written shorthand).
  const guardrails = (parsed.policy.guardrails ?? parsed.policy) as Record<string, unknown>;
  const scoped = guardrails.pathScopes !== undefined;
  const revised = typeof guardrails.argRevisions === "object"
    && guardrails.argRevisions !== null
    && Object.keys(guardrails.argRevisions).length > 0;
  if (!scoped && !revised) return null;
  return "permissionMode is 'deny-all' while the governance policy scopes or rewrites tool calls "
    + `(${scoped ? "pathScopes" : "argRevisions"}): the ACP proxy refuses every permission request omp `
    + "still raises, before the bridge can allow it, so those governed calls cannot run. Use "
    + "'approve-all' (or 'approve-reads') with the governance policy as the single gate, or remove the "
    + "scope/revision rules and keep deny-all as the only gate.";
}

/**
 * Materialize the governance manifest for the paperclip bridge extension.
 * Returns the path written, or null when governance is off, carries no
 * bridge-enforceable rule (endpoint routing alone), the document is
 * unreadable, or the write failed — every null-but-configured case routes a
 * `warn` so the board shows why policy is not in effect. Mirrors the v0.7
 * skills-manifest fix: create the state dir (recursive) BEFORE writing.
 *
 * Writing ONLY an enforceable policy is load-bearing: the returned path is what
 * arms the `--extension` append and, through it, the single-gate relaxation.
 * A manifest the bridge would read as zero rules must not exist.
 */
export async function materializeGovernanceManifest(
  config: Record<string, unknown>,
  dir: string,
  warn?: (message: string) => void | Promise<void>,
): Promise<string | null> {
  const parsed = parseGovernancePolicy(config.governancePolicy);
  if (parsed.kind === "error") {
    await warn?.(`omp governance policy ignored: could not parse governancePolicy (${parsed.error})`);
    return null;
  }
  if (parsed.vacuous && parsed.vacuous.length > 0) {
    const listed = parsed.vacuous.join("; ");
    if (parsed.kind === "ok" && parsed.enforceable) {
      await warn?.(`omp governance policy ignored key(s) that carry no rule: ${listed}`);
    } else {
      await warn?.(
        `omp governance policy has no enforceable rule after normalization (${listed}); `
        + "nothing was written, so governance is not armed and omp's own approval gate stays in force",
      );
    }
  }
  if (parsed.kind !== "ok" || !parsed.enforceable) return null;
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
