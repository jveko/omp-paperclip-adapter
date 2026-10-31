import { createHash } from "node:crypto";
import { promises as fs, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Paperclip bridge: the adapter's one static omp ExtensionAPI extension, loaded
 * via `--extension <dist/paperclip-bridge.js>`. It carries two independent
 * lanes, each armed by its own manifest env and a no-op without it:
 *
 * - **Skills (v0.7)** — on `session_start`, register one zero-arg
 *   `loadMode:"essential"` native tool per enabled Paperclip company skill from
 *   `PAPERCLIP_SKILLS_MANIFEST`; each tool's `execute()` returns the skill's
 *   SKILL.md **on demand**, re-reading the file fresh per call so content edits
 *   land on the next invocation even in a warm session.
 * - **Governance (v0.8)** — on `session_start`, subscribe a `tool_call`
 *   guardrail and a `message_end` cost tally armed by
 *   `PAPERCLIP_GOVERNANCE_MANIFEST` (governance.json). The gate evaluates
 *   path scopes, bash deny patterns, denied tool names and argument
 *   revisions; the tally enforces `budgetCapUsd` as a soft per-session cap
 *   that blocks mutating tools past the cap. The whole lane is deliberately
 *   independent of the skills lane: a governance-only agent (skillsAsTools
 *   off) must still be enforced.
 * - **Human approval (v0.8 T5)** — a tool call that matches an
 *   `approvalRequired` rule (and passed every guardrail) posts a
 *   `request_board_approval` to the Paperclip control plane and blocks the
 *   call. This is the one path where the handler awaits: every control-plane
 *   call is self-bound to ~10s, far under omp's 30s `toolCallTimeoutMs`, and
 *   a pending entry older than the dedup window resolves its verdict with
 *   ONE bounded status read — so a warm-handle session survives a granted
 *   approval instead of holding it forever. Never a poll loop.
 *
 * omp's `#beforeToolCall` awaits this handler before the tool runs and before
 * any approval proxy, and fail-closes (blocks the call) if a handler throws or
 * outlives `extensionHandlers.toolCallTimeoutMs` — so the handler stays
 * synchronous and throw-free on the guardrail path (its only I/O is a `stat`
 * of the manifest plus, when its mtime moved, one small read), and the
 * approval path bounds its own network wait.
 *
 * Self-contained on purpose: runtime imports are node builtins only, so esbuild
 * bundles this file cleanly and omp loads it via dynamic `import()`. The types
 * below are minimal structural mirrors of omp's ExtensionAPI/event shapes
 * (oh-my-pi packages/coding-agent/src/extensibility/extensions/types.ts) — they
 * are erased at build time, not imported.
 */

interface SkillManifestEntry {
  name: string;
  toolName: string;
  description: string;
  markdownPath: string;
}

interface BridgeToolResult {
  content: { type: "text"; text: string }[];
}

/** Structural subset of omp's ToolDefinition. */
interface BridgeTool {
  name: string;
  label: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, never> };
  loadMode: "essential" | "discoverable";
  execute: () => Promise<BridgeToolResult>;
}

/** Structural mirror of omp's ToolCallEvent (only the fields we consume). */
interface BridgeToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** Structural mirror of the `cwd` slice of omp's ExtensionContext. */
interface BridgeToolCallContext {
  cwd: string;
}

/** Structural mirror of omp's ToolCallEventResult. */
interface BridgeToolCallResult {
  block?: boolean;
  reason?: string;
  input?: Record<string, unknown>;
}

/** Structural mirror of the `usage.cost` slice of omp's message_end event. */
interface BridgeMessageEndEvent {
  type: "message_end";
  message?: { usage?: { cost?: { total?: number } } };
}

type BridgeMessageEndHandler = (event: BridgeMessageEndEvent) => void;

/**
 * Structural mirror of omp's `tool_call` handler contract. It is normally
 * synchronous (the guardrail path is pure), and returns a promise ONLY on the
 * approval path — omp awaits whatever a handler returns, and the approval
 * handler bounds itself well inside `toolCallTimeoutMs`.
 */
type BridgeToolCallHandler = (
  event: BridgeToolCallEvent,
  ctx: BridgeToolCallContext,
) => BridgeToolCallResult | undefined | Promise<BridgeToolCallResult | undefined>;

/** Structural subset of omp's ExtensionAPI. */
interface BridgePi {
  on(event: "session_start", handler: () => void | Promise<void>): unknown;
  on(event: "tool_call", handler: BridgeToolCallHandler): unknown;
  on(event: "message_end", handler: BridgeMessageEndHandler): unknown;
  registerTool(tool: BridgeTool): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkillManifestEntry(value: unknown): value is SkillManifestEntry {
  if (!isRecord(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.toolName === "string" &&
    typeof v.description === "string" &&
    typeof v.markdownPath === "string"
  );
}

/* ------------------------------------------------------------------ */
/*  Guardrail policy: load, cache, normalize                           */
/* ------------------------------------------------------------------ */

/**
 * Tools whose calls must never be blocked by the guardrails. `yield` is the
 * run's terminal/completion tool, so blocking it strands the whole heartbeat;
 * the rest are control-plane bookkeeping that carries no filesystem or shell
 * reach. This set scopes ONLY the guardrail rules — the cost-budget gate (T3)
 * has its own, wider deny-by-complement set that DOES treat `task` as
 * mutating. `task` is deliberately absent here: a subagent spawn is a real
 * capability and re-enforces policy in its own child session.
 */
const CONTROL_TOOLS: Record<string, true> = {
  yield: true,
  goal: true,
  think: true,
  todo: true,
  hub: true,
};

/* ------------------------------------------------------------------ */
/*  Soft cost budget                                                   */
/* ------------------------------------------------------------------ */

/**
 * Per-session running USD total. Module scope IS the session scope: omp
 * re-imports this extension with a cache-busted specifier on every
 * `session/new`, so each session — a subagent included — starts a fresh zeroed
 * copy and enforces its own cap. Honest ceiling: an agent with N in-process
 * subagents can spend up to (1+N)×cap, and with the default cold child
 * (`warmHandleIdleMs=0`) the cap is per-run; it only accumulates across runs
 * under an operator-configured warm handle. The gate is advisory and coarse
 * (cooperation with the over-cap state is the design, not a hard request-level
 * abort): read-only provider calls keep flowing.
 *
 * Being over cap is DERIVED from this tally plus the cap currently on disk, and
 * deliberately not stored: a latch could only ever be one-way, while policy
 * edits ARE supported on a warm session (the manifest is re-read on mtime). A
 * latched flag therefore kept every mutating tool blocked forever after one
 * expensive message, even once the operator raised or removed the cap.
 */
let runningCost = 0;

/** Is the session over its cap right now? A cap of 0 means no cap. */
function budgetExceeded(capUsd: number): boolean {
  return capUsd > 0 && runningCost > capUsd;
}

/**
 * Tools that stay callable once the cap is reached. The budget gate is
 * DENY-BY-COMPLEMENT: anything not listed here is blocked — `write`, `edit`,
 * `bash`, `task` (spawns cost, and subagents get their own cap so they are
 * no escape hatch), `ast_edit`, `memory_edit`, any `mcp__*`. Control tools
 * never reach this check: the allowlist short-circuit in
 * `evaluateGuardrails` runs first, so an over-budget agent can always
 * `yield` and finish its run.
 */
const BUDGET_READ_ONLY: Record<string, true> = {
  read: true,
  grep: true,
  glob: true,
  lsp: true,
};

/** Trim float-noise off a USD total for the block reason. */
function usd(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/**
 * Tools whose execution target is a path (or a derived list of paths).
 * Non-filesystem targets (`memory://`, `artifact://`, an `xd://` device mount
 * written through `write`) are not scope-checkable — they resolve as
 * cwd-relative strings and pass — so holding them is a `denyTools` job.
 */
const PATH_TOOLS: Record<string, true> = {
  write: true,
  edit: true,
  read: true,
};

/**
 * Tools `argRevisions` may rewrite. omp applies a handler's `input` to the
 * RAW execution args, but the event only shows the NORMALIZED view: for
 * hashline `edit`, `path`/`paths` are gate-only fields derived from the patch,
 * so echoing them back could fabricate parameters. Restricting revisions to
 * tools whose args are plain (a `command` string, a `path` string) keeps the
 * merge faithful; `bash` is included because its revision surface is scalar.
 */
const REVISABLE_TOOLS: Record<string, true> = {
  bash: true,
  write: true,
  read: true,
};

/** Shell control boundaries, mirroring omp's per-segment bash deny matching. */
const BASH_SEGMENT_SPLIT = /(?:\|\||&&|[;\n&|])/;

interface BashDenyRule {
  source: string;
  pattern: RegExp;
}

interface PathScopeRule {
  /** Absolute (cwd-resolved) allow roots; empty means "the run cwd". */
  allow: string[];
  denyOutside: boolean;
}

/**
 * One `approvalRequired` rule. `tool` is an exact tool name or a prefix
 * pattern ending in `*` (`mcp__*`); `reason` and `risk` are advisory text for
 * the board card. A rule can also be written as just the tool name.
 */
interface ApprovalRule {
  tool: string;
  reason?: string;
  risk: string;
  /** Compiled matcher for `tool` (exact or prefix), so matching stays cheap. */
  matches: (toolName: string) => boolean;
}

interface GuardrailRules {
  pathScopes: PathScopeRule | null;
  bashDeny: BashDenyRule[];
  denyTools: Record<string, true>;
  argRevisions: Record<string, Record<string, unknown>>;
  /** Soft per-session USD cap, hoisted from the document root; 0 = budget lane off. */
  budgetCapUsd: number;
  /** Tools held for a human; empty = approval lane off (hoisted from root). */
  approvalRequired: ApprovalRule[];
  /**
   * Folders whose calls are held for a human, from the policy root
   * `restrictedFolders` (the same list the run child gets as omp's
   * `tools.restrictedFolders`). Enforced here because omp's own prompt is
   * answered by this lane's ACP proxy, which auto-allows under `approve-all`.
   */
  restrictedFolders: string[];
  /** Memoized realpath'd roots, valid only for `rootsCwd`. */
  rootsCwd: string | null;
  roots: string[] | null;
}

/**
 * Normalize `approvalRequired`: a list of bare tool names and/or
 * `{ tool, reason?, risk? }` rules. A rule that cannot name a tool is dropped
 * — a rail that never matches is worse than no rail, because the operator
 * believes it exists.
 */
function normalizeApprovalRules(value: unknown): ApprovalRule[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const rules: ApprovalRule[] = [];
  for (const item of items) {
    const raw = typeof item === "string" ? { tool: item } : item;
    if (!isRecord(raw)) continue;
    const tool = typeof raw.tool === "string" ? raw.tool.trim() : "";
    if (tool === "") continue;
    const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : undefined;
    const risk = typeof raw.risk === "string" && raw.risk.trim() ? raw.risk.trim() : "high";
    const matches = tool.endsWith("*")
      ? (name: string): boolean => name.startsWith(tool.slice(0, -1))
      : (name: string): boolean => name === tool;
    rules.push({ tool, reason, risk, matches });
  }
  return rules;
}

/**
 * Module-scoped policy cache. A warm handle keeps this module alive across
 * runs, and editing the policy does NOT rotate the session fingerprint (the
 * manifest path is a stable string), so the only signal that rules changed is
 * the file's mtime: re-stat per call, re-read only when it moved. One entry —
 * a process has exactly one governance manifest.
 */
let policyCache: {
  file: string;
  mtimeMs: number;
  size: number;
  rules: GuardrailRules;
} | null = null;

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** `pathScopes` accepts the documented map or a bare root/root-list shorthand. */
function normalizePathScopes(value: unknown): PathScopeRule | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || Array.isArray(value)) {
    const allow = stringList(value);
    return allow.length > 0 ? { allow, denyOutside: true } : null;
  }
  if (!isRecord(value)) return null;
  const allow = stringList(value.allow);
  const denyOutside = value.denyOutside !== false;
  if (!denyOutside) return { allow, denyOutside: false };
  return { allow, denyOutside: true };
}

function normalizeGuardrails(document: Record<string, unknown>): GuardrailRules {
  // Canonical shape is `{ guardrails: { ... } }`; a hand-written manifest that
  // puts the rule families at top level is read the same way.
  const bag = isRecord(document.guardrails) ? document.guardrails : document;

  const denyTools: Record<string, true> = {};
  for (const name of stringList(bag.denyTools)) denyTools[name] = true;

  const bashDeny: BashDenyRule[] = [];
  for (const source of stringList(bag.bashDeny)) {
    // An incompilable pattern is skipped rather than guessed at: a thrown
    // RegExp would otherwise fail-close every bash call in the run.
    try {
      bashDeny.push({ source, pattern: new RegExp(source) });
    } catch {
      /* skip */
    }
  }

  const argRevisions: Record<string, Record<string, unknown>> = {};
  if (isRecord(bag.argRevisions)) {
    for (const [tool, revision] of Object.entries(bag.argRevisions)) {
      if (isRecord(revision)) argRevisions[tool] = revision;
    }
  }

  // `budgetCapUsd` sits at the document root in both the canonical and the
  // shorthand shape; only a finite positive number arms the budget lane.
  const rawCap =
    typeof document.budgetCapUsd === "string" ? Number(document.budgetCapUsd) : document.budgetCapUsd;
  const budgetCapUsd =
    typeof rawCap === "number" && Number.isFinite(rawCap) && rawCap > 0 ? rawCap : 0;

  // `approvalRequired` is a document-root key in the materialized manifest and
  // may also be written inside the `guardrails` bag by hand.
  const approvalRequired = normalizeApprovalRules(document.approvalRequired ?? bag.approvalRequired);

  // Root-only, like `budgetCapUsd`: the overlay writes it as omp's
  // `tools.restrictedFolders`, and the gate holds calls that touch it.
  const restrictedFolders = stringList(document.restrictedFolders)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    pathScopes: normalizePathScopes(bag.pathScopes),
    bashDeny,
    denyTools,
    argRevisions,
    budgetCapUsd,
    approvalRequired,
    restrictedFolders,
    rootsCwd: null,
    roots: null,
  };
}

/**
 * Current rules for `file`, re-read only when its mtime or size moved. Null
 * when the manifest was never readable. Any failure after a successful prime
 * keeps the last good policy — governance must not silently evaporate because
 * the file briefly disappeared or was saved mid-parse.
 */
function currentGuardrails(file: string): GuardrailRules | null {
  const lastGood = policyCache && policyCache.file === file ? policyCache.rules : null;
  try {
    const stat = statSync(file);
    if (lastGood && policyCache?.mtimeMs === stat.mtimeMs && policyCache.size === stat.size) {
      return lastGood;
    }
    const document: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(document)) return lastGood;
    const rules = normalizeGuardrails(document);
    policyCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, rules };
    return rules;
  } catch {
    return lastGood;
  }
}

/* ------------------------------------------------------------------ */
/*  Guardrail evaluation (pure, synchronous)                           */
/* ------------------------------------------------------------------ */

/**
 * Realpath the nearest existing ancestor and rejoin the rest, so a not-yet
 * created write target still resolves. Symlink caveat: fidelity stops at the
 * deepest existing component, and a path whose own final component is a
 * symlink to outside the scope is judged by its requested name — this is a
 * policy rail against mistakes, not a security boundary.
 */
function realpathAncestor(absolute: string): string {
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      if (missing.length === 0) return real;
      return path.resolve(real, ...missing.reverse());
    } catch {
      /* walk up */
    }
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    missing.push(path.basename(current));
    current = parent;
  }
}

function rootsForScope(scope: PathScopeRule, cwd: string, rules: GuardrailRules): string[] {
  if (rules.rootsCwd === cwd && rules.roots) return rules.roots;
  const roots = (scope.allow.length > 0 ? scope.allow : [cwd]).map((root) =>
    realpathAncestor(path.resolve(cwd, root)),
  );
  rules.rootsCwd = cwd;
  rules.roots = roots;
  return roots;
}

function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
}

/** omp expands `~` for `tools.restrictedFolders`; mirror it so both layers agree. */
function expandHome(entry: string): string {
  if (entry === "~") return homedir();
  if (entry.startsWith("~/")) return path.join(homedir(), entry.slice(2));
  return entry;
}

/**
 * The approval rule a call gets for touching a restricted folder, or null.
 *
 * Mirrors omp's own `restrictedFolderReason`: the folder covers itself and
 * everything below it; a tool that names no path is judged by the directory it
 * runs in (or by its own `cwd` argument). omp raises a prompt for the same
 * condition, but on this lane that prompt is answered by the ACP proxy, so the
 * board ask has to come from here.
 */
function restrictedFolderRule(
  event: BridgeToolCallEvent,
  ctx: BridgeToolCallContext,
  rules: GuardrailRules,
): ApprovalRule | null {
  if (rules.restrictedFolders.length === 0) return null;
  const toolName = typeof event?.toolName === "string" ? event.toolName : "";
  if (toolName === "" || CONTROL_TOOLS[toolName]) return null;
  const input = isRecord(event?.input) ? event.input : {};
  const base = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  const named = inputPaths(input);
  const subjects = named.length > 0
    ? named
    : [typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : base];
  for (const entry of rules.restrictedFolders) {
    const folder = path.resolve(base, expandHome(entry));
    const folderKey = realpathAncestor(folder);
    for (const subject of subjects) {
      if (isWithin(folderKey, realpathAncestor(path.resolve(base, subject)))) {
        return {
          tool: toolName,
          reason: `restricted folder: ${folder}`,
          risk: "high",
          matches: () => true,
        };
      }
    }
  }
  return null;
}

/**
 * Path fields the gate reads: the canonical `path`, the `file_path` alias
 * omp's file tools still accept (its own renderers read
 * `args.file_path || args.path`, so a model can name either), and the derived
 * hashline `paths` list. Missing an alias here would make the rail
 * bypassable by rewording the argument. The gate covers the three built-in
 * file tools; other file-touching tools (`ast_edit`, MCP writes) are held by
 * `denyTools`, and past the cost cap by the budget gate's deny-complement.
 */
function inputPaths(input: Record<string, unknown>): string[] {
  return [...stringList(input.path), ...stringList(input.file_path), ...stringList(input.paths)];
}

function bashSegments(command: string): string[] {
  return command.split(BASH_SEGMENT_SPLIT).filter((segment) => segment.trim().length > 0);
}

function evaluateGuardrails(
  event: BridgeToolCallEvent,
  ctx: BridgeToolCallContext,
  rules: GuardrailRules,
): BridgeToolCallResult | undefined {
  const toolName = typeof event?.toolName === "string" ? event.toolName : "";
  if (toolName === "" || CONTROL_TOOLS[toolName]) return undefined;
  const input = isRecord(event?.input) ? event.input : {};
  const cwd = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  const blocked = (detail: string): BridgeToolCallResult => ({
    block: true,
    reason: `paperclip governance: ${toolName} blocked — ${detail}`,
  });

  // Budget gate — deliberately AFTER the control-tool short-circuit: an
  // over-cap agent must still be able to yield/goal/todo its way out of the
  // run. Deny-by-complement: only `BUDGET_READ_ONLY` passes; `task`, every
  // `mcp__*` and every other non-read tool waits. `rules` is re-read on every
  // call, so raising the cap above the spend or deleting it clears this gate
  // with no new message required, and `budgetExceeded` guarantees the reason
  // below always prints a real cap.
  if (budgetExceeded(rules.budgetCapUsd) && !BUDGET_READ_ONLY[toolName]) {
    return blocked(
      `budget cap reached (${usd(runningCost)} spent > ${usd(rules.budgetCapUsd)} USD this session)`,
    );
  }

  if (rules.denyTools[toolName]) {
    return blocked("the tool is listed in the governance policy's denyTools");
  }

  const scope = rules.pathScopes;
  if (scope && scope.denyOutside && PATH_TOOLS[toolName]) {
    const targets = inputPaths(input);
    if (targets.length > 0) {
      const roots = rootsForScope(scope, cwd, rules);
      for (const target of targets) {
        const resolved = realpathAncestor(path.resolve(cwd, target));
        if (!roots.some((root) => isWithin(root, resolved))) {
          return blocked(
            `"${target}" resolves to ${resolved}, outside the allowed roots [${roots.join(", ")}]`,
          );
        }
      }
    }
  }

  if (toolName === "bash" && rules.bashDeny.length > 0 && typeof input.command === "string") {
    const segments = [input.command, ...bashSegments(input.command)];
    for (const rule of rules.bashDeny) {
      if (segments.some((segment) => rule.pattern.test(segment))) {
        return blocked(`command matched the deny pattern /${rule.source}/`);
      }
    }
  }

  // Last: denies above have already had their chance, so a revision can never
  // smuggle a call past a rule (revisions are operator-authored, not model).
  const revision = rules.argRevisions[toolName];
  if (revision && REVISABLE_TOOLS[toolName]) {
    return { input: { ...input, ...revision } };
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Human approval (board round-trip, verdict resolution)               */
/* ------------------------------------------------------------------ */

/**
 * Self-bound for the approval POST. omp caps a `tool_call` handler at
 * `extensionHandlers.toolCallTimeoutMs` (default 30s) and does NOT cancel the
 * handler promise when it expires — it leaks. So the approval call bounds
 * itself to a third of that: a slow or black-holed control plane must never
 * turn a governed run into a stall.
 */
const APPROVAL_TIMEOUT_MS = 10_000;

/** A failed approval POST is not retried for this long (model retry-loops). */
const APPROVAL_RETRY_MS = 30_000;

/** Bound on the dedup cache: a long session must not grow it without limit. */
const APPROVAL_CACHE_MAX = 256;

type ApprovalAttempt =
  | { state: "pending"; approvalId: string; at: number }
  | { state: "failed"; detail: string; at: number };

/**
 * Per-session approval dedup, keyed on `tool + args hash`: an identical call
 * re-asks the board only after the negative's retry window, and a pending
 * entry holds a burst inside that window with no network at all. Past the
 * window the pending branch does NOT trust the entry — it resolves the
 * board's verdict with ONE bounded `GET /api/approvals/:id` (a run JWT may
 * read approvals; only deciding them is board-gated): approved runs, a
 * refusal clears the entry so a later call may re-request, and still-pending
 * or any failure refreshes the stamp and keeps holding, fail-closed.
 *
 * Same module-scope-per-session reasoning as `runningCost` — but that holds
 * only for a FRESH `session/new`, which cache-busts this extension. Under an
 * operator-configured warm handle (`warmHandleIdleMs > 0`) a `session/load`
 * of a live record neither re-imports this module nor re-fires
 * `session_start`, so a pending entry SURVIVES into the run an approval
 * wakes; assuming a clean slate there would re-hold the granted action
 * forever, and clearing at the session boundary cannot fix it either — that
 * handler never runs on a resumed warm session. The default
 * `warmHandleIdleMs = 0` keeps cold-path behavior unchanged.
 */
const approvalAttempts = new Map<string, ApprovalAttempt>();

/** Deterministic JSON encoding: key-sorted, so equal args hash equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? JSON.stringify(value)
      : JSON.stringify(String(value));
  }
  return "null";
}

/**
 * The run's Paperclip credentials, read FRESH on every call.
 *
 * The supervisor sets `PAPERCLIP_RUN_CONTEXT` to a stable path whose contents
 * it rebinds before each prompt (`run-context/<runId>.json` behind
 * `current.json`); the run JWT deliberately never enters this process's env,
 * because a warm worker's env cannot change between runs.
 *
 * A missing or unparseable record falls back to env: a broken pointer must not
 * silently turn every approval into "credentials unavailable" when the env
 * carries the same values (a bridge loaded outside the supervisor, a test).
 */
function runContextCredentials(): { apiUrl: string; companyId: string; taskId: string; token: string } {
  const file = (process.env.PAPERCLIP_RUN_CONTEXT ?? "").trim();
  if (file !== "") {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isRecord(raw) && isRecord(raw.credentials)) {
        const credentials = raw.credentials;
        const apiUrl = typeof credentials.apiUrl === "string" ? credentials.apiUrl.trim() : "";
        const token = typeof credentials.apiKey === "string" ? credentials.apiKey.trim() : "";
        const companyId = typeof credentials.companyId === "string" ? credentials.companyId.trim() : "";
        const taskId = typeof credentials.taskId === "string" ? credentials.taskId.trim() : "";
        if (apiUrl !== "" && token !== "") return { apiUrl, companyId, taskId, token };
      }
    } catch {
      // Unreadable record: fall through to the env fallback.
    }
  }
  return {
    apiUrl: (process.env.PAPERCLIP_API_URL ?? "").trim(),
    companyId: (process.env.PAPERCLIP_COMPANY_ID ?? "").trim(),
    taskId: (process.env.PAPERCLIP_TASK_ID ?? "").trim(),
    token: (process.env.PAPERCLIP_API_KEY ?? "").trim(),
  };
}

/** Short stable digest of the executed args, for the board card and dedup. */
function argumentsHash(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex").slice(0, 16);
}

/**
 * Record one approval outcome, evicting the oldest when the cache is full so
 * a long warm session cannot grow it without bound.
 */
function rememberAttempt(key: string, attempt: ApprovalAttempt): void {
  if (approvalAttempts.size >= APPROVAL_CACHE_MAX) {
    const oldest = approvalAttempts.keys().next();
    if (!oldest.done) approvalAttempts.delete(oldest.value);
  }
  approvalAttempts.set(key, attempt);
}

/**
 * The normalized API root. `PAPERCLIP_API_URL` may or may not carry the
 * `/api` suffix (the board and the CLI write both forms), so trailing slashes
 * and a trailing `/api` are stripped exactly as `paperclipApiBase` does —
 * otherwise the call lands on `/api/api/companies/...` and 404s.
 */
function paperclipApiRoot(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/api$/, "");
}

/** First string-shaped id in an approvals response, whatever envelope it uses. */
function approvalIdFrom(body: unknown): string | null {
  if (!isRecord(body)) return null;
  for (const candidate of [
    body.id,
    isRecord(body.approval) ? body.approval.id : undefined,
    isRecord(body.data) ? body.data.id : undefined,
  ]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}

/** What one status read can learn; "unknown" means the read could not decide. */
type ApprovalVerdict =
  | "approved"
  | "rejected"
  | "revision_requested"
  | "cancelled"
  | "pending"
  | "unknown";

/**
 * The verdict on an approval read. The installed control plane answers
 * `GET /api/approvals/:id` with the redacted approval row itself — `status`
 * at the top level, one of the five values of `@paperclipai/shared`'s
 * APPROVAL_STATUSES — but accept an `approval`/`data` envelope too, exactly
 * as `approvalIdFrom` does. Anything unrecognized (including a non-string)
 * is "unknown", which the caller fails closed on.
 */
function approvalVerdictFrom(body: unknown): ApprovalVerdict {
  if (!isRecord(body)) return "unknown";
  for (const candidate of [
    body.status,
    isRecord(body.approval) ? body.approval.status : undefined,
    isRecord(body.data) ? body.data.status : undefined,
  ]) {
    if (typeof candidate !== "string") continue;
    const status = candidate.trim().toLowerCase();
    if (
      status === "approved" ||
      status === "rejected" ||
      status === "revision_requested" ||
      status === "cancelled" ||
      status === "pending"
    ) {
      return status;
    }
  }
  return "unknown";
}

/**
 * A control-plane fetch with its own deadline, shared by the approval POST
 * and the verdict GET. omp caps a `tool_call` handler at
 * `extensionHandlers.toolCallTimeoutMs` (default 30s) and does NOT cancel a
 * handler promise that outlives it — it leaks. Race the fetch against our
 * own timer rather than trusting `AbortSignal.timeout` alone: the signal
 * cancels the socket, the timer guarantees this helper returns even if the
 * fetch never settles, so a slow or black-holed control plane can never
 * turn a governed run into a stall.
 */
async function boundedApprovalFetch(
  url: string,
  token: string,
  jsonBody?: string,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no response after ${APPROVAL_TIMEOUT_MS}ms`)),
      APPROVAL_TIMEOUT_MS,
    );
    timer.unref();
  });
  try {
    return await Promise.race([
      fetch(url, {
        method: jsonBody === undefined ? "GET" : "POST",
        headers:
          jsonBody === undefined
            ? { authorization: `Bearer ${token}` }
            : { "content-type": "application/json", authorization: `Bearer ${token}` },
        ...(jsonBody === undefined ? {} : { body: jsonBody }),
        signal: AbortSignal.timeout(APPROVAL_TIMEOUT_MS),
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve one pending approval's verdict with a single bounded status read.
 * NEVER throws: missing env, no fetch, a transport failure, a non-2xx or an
 * unparseable reply all come back "unknown" — so an approved action runs
 * only on a read that PROVES the board said approved.
 */
async function lookupApprovalVerdict(approvalId: string): Promise<ApprovalVerdict> {
  try {
    const { apiUrl: api, token } = runContextCredentials();
    if (!api || !token || typeof fetch !== "function") return "unknown";
    const url = `${paperclipApiRoot(api)}/api/approvals/${encodeURIComponent(approvalId)}`;
    const response = await boundedApprovalFetch(url, token);
    if (!response.ok) return "unknown";
    const raw = await response.text().catch(() => "");
    if (raw === "") return "unknown";
    try {
      return approvalVerdictFrom(JSON.parse(raw));
    } catch {
      return "unknown";
    }
  } catch {
    return "unknown";
  }
}

/**
 * Govern one gated call against the board: hold it; POST a
 * `request_board_approval` when no request is outstanding; and once a
 * pending entry is older than the retry window, RESOLVE it with one bounded
 * status read instead of trusting it. Approved → the entry is cleared and
 * the pre-existing `guard` result is returned (undefined, or the operator's
 * argument revision), so the granted action runs. Rejected /
 * revision_requested / cancelled → the entry is cleared so a later call may
 * request afresh, and this one holds with the outcome named. Anything else
 * → the stamp is refreshed and the call keeps holding: fail-closed, never a
 * throw, never an ungoverned allow.
 *
 * ADVISORY BY DESIGN (Phase B): Paperclip resolves an approval by firing
 * `heartbeat.wakeup(reason:"approval_approved")`, which starts a NEW run —
 * nothing resumes THIS one, and a poll/hold is impossible inside the 30s
 * handler cap. So the block reason is written to tell the model what
 * actually happens. A FRESH `session/new` re-imports this module and starts
 * clean; a warm-handle `session/load` does NOT, which is why an aged pending
 * entry resolves its verdict via the status read rather than assuming a
 * clean slate. `runId` is deliberately absent from the payload: the run
 * child's `PAPERCLIP_RUN_ID` is spawn-time and stale under a warm handle, so
 * an id there would be a lie on the board.
 *
 * Fail-closed: any error — transport, non-2xx (a status-only recovery run's
 * 403 is expected), unparseable reply — still blocks the call, because an
 * ungoverned action must never slip through a failed approval round-trip.
 */
async function holdForApproval(
  toolName: string,
  args: Record<string, unknown>,
  rule: ApprovalRule,
  guard: BridgeToolCallResult | undefined,
): Promise<BridgeToolCallResult | undefined> {
  const held = (detail: string): BridgeToolCallResult => ({
    block: true,
    // The rule's own reason is the model's only clue to WHAT tripped the gate
    // (a restricted folder path, an operator note). It belongs in the refusal,
    // not only on the board card — a bare approval id teaches nothing.
    reason: `paperclip governance: ${toolName} requires approval`
      + `${rule.reason ? ` (${rule.reason})` : ""} — ${detail}`,
  });

  // One shape for every failure: cache it (so the retry window applies), tell
  // the model it failed, and stay blocked.
  const fail = (key: string, detail: string): BridgeToolCallResult => {
    if (key !== "") rememberAttempt(key, { state: "failed", detail, at: Date.now() });
    return held(`approval request failed (${detail}) — will retry on next attempt`);
  };

  let key = "";
  try {
    const hash = argumentsHash(args);
    key = `${toolName}\u0000${hash}`;
    const seen = approvalAttempts.get(key);
    if (seen) {
      const fresh = Date.now() - seen.at < APPROVAL_RETRY_MS;
      if (seen.state === "pending") {
        if (fresh) {
          // Dedup fast path, no network: a burst re-sending the identical
          // call inside the window keeps holding immediately.
          return held(
            `approval ${seen.approvalId} pending (requested earlier this session); re-run once it is approved to perform this action`,
          );
        }
        // Past the window the entry may be STALE: under a warm handle the
        // board's verdict can land while this module still holds the key,
        // and the run an approval wakes resumes right here. Resolve it with
        // one bounded read — never allow on doubt, never throw.
        const verdict = await lookupApprovalVerdict(seen.approvalId);
        if (verdict === "approved") {
          approvalAttempts.delete(key);
          return guard;
        }
        if (
          verdict === "rejected" ||
          verdict === "revision_requested" ||
          verdict === "cancelled"
        ) {
          // Cleared so a later call may request afresh; this one still holds.
          approvalAttempts.delete(key);
          const outcome = verdict === "revision_requested" ? "revision requested" : verdict;
          return held(
            `approval ${seen.approvalId} was ${outcome} by the board; re-run to request this action afresh`,
          );
        }
        // Still pending, or the read failed: refresh the stamp (at most one
        // bounded read per window, not one per model retry) and keep holding.
        rememberAttempt(key, { state: "pending", approvalId: seen.approvalId, at: Date.now() });
        return held(
          `approval ${seen.approvalId} still pending (requested earlier this session); re-run once it is approved to perform this action`,
        );
      }
      if (fresh) {
        return held(`the previous request failed (${seen.detail}) and is not retried yet`);
      }
    }

    const { apiUrl: api, companyId, token, taskId } = runContextCredentials();
    if (!api || !companyId || !token) {
      // This path only exists once a governance manifest has armed the lane,
      // so a missing control-plane env is a governance failure, not an absent
      // policy: hold the call instead of letting it run ungoverned.
      return fail(key, "governance env unavailable: PAPERCLIP_API_URL / PAPERCLIP_COMPANY_ID / PAPERCLIP_API_KEY");
    }
    if (typeof fetch !== "function") return fail(key, "no fetch in this runtime");

    const url = `${paperclipApiRoot(api)}/api/companies/${encodeURIComponent(companyId)}/approvals`;
    const body = {
      type: "request_board_approval",
      payload: {
        tool: toolName,
        argumentsHash: hash,
        risk: rule.risk,
        source: "omp_governance",
        ...(rule.reason ? { reason: rule.reason } : {}),
      },
      // Top-level, not inside `payload`: `issueIds` is what links the card to
      // the task. Absent for a board-triggered run with no issue.
      issueIds: taskId ? [taskId] : undefined,
    };

    const response = await boundedApprovalFetch(url, token, JSON.stringify(body));

    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      // A status-only recovery run answers 403 here; expected, and still a hold.
      const snippet = raw.slice(0, 160).trim();
      return fail(key, `HTTP ${response.status}${snippet === "" ? "" : `: ${snippet}`}`);
    }

    let parsed: unknown = null;
    try {
      parsed = raw === "" ? null : JSON.parse(raw);
    } catch {
      parsed = null;
    }
    // A 2xx means the board took it, id or no id: never re-POST on a parse
    // hiccup, or a chatty model would mint duplicate approvals.
    const approvalId = approvalIdFrom(parsed) ?? "queued";
    rememberAttempt(key, { state: "pending", approvalId, at: Date.now() });
    return held(
      `approval ${approvalId} requested; re-run after it is approved to perform this action (approving wakes a NEW run — this one does not resume)`,
    );
  } catch (err) {
    // Never throw: an exception escaping a tool_call handler is omp's signal
    // for a blanket block with no reason, which teaches the model nothing.
    return fail(key, err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------------------------------------------ */
/*  Lane installation                                                  */
/* ------------------------------------------------------------------ */

/**
 * `pi` instances the governance lane has already armed. A warm handle can see
 * more than one `session_start`, and stacked handlers would re-stat the same
 * policy for nothing.
 */
const armedPi = new WeakSet<object>();

function installGovernanceLane(pi: BridgePi): void {
  const file = process.env.PAPERCLIP_GOVERNANCE_MANIFEST;
  if (!file) return;
  // Prime once so an unreadable or unparseable manifest installs nothing at all
  // (side-channel children never have the env; a broken one must not half-arm).
  const rules = currentGuardrails(file);
  if (!rules || armedPi.has(pi)) return;
  armedPi.add(pi);
  pi.on("tool_call", (event, ctx) => {
    try {
      const current = currentGuardrails(process.env.PAPERCLIP_GOVERNANCE_MANIFEST ?? file);
      if (!current) return undefined;
      const guard = evaluateGuardrails(event, ctx, current);
      // A deny outranks approval: never ask a human to approve what policy
      // already forbids, and never spend a board slot on it.
      if (guard?.block) return guard;
      const toolName = typeof event?.toolName === "string" ? event.toolName : "";
      // The args that will actually run: a guardrail revision may rewrite
      // paths, and a revision that lands in a restricted folder is still a
      // restricted-folder call (omp's own prompt is proxy-answered here).
      const executed = isRecord(guard?.input)
        ? guard.input
        : isRecord(event?.input)
          ? event.input
          : {};
      // The control-tool allowlist outranks approval too — holding `yield`
      // for a human strands the run exactly like denying it would.
      const rule = toolName === "" || CONTROL_TOOLS[toolName]
        ? null
        : (current.approvalRequired.find((candidate) => candidate.matches(toolName))
          ?? restrictedFolderRule({ ...event, input: executed }, ctx, current));
      if (!rule) return guard;
      // The approval round-trip is the lane's only awaited path, and every
      // control-plane call inside it is self-bound. It normally holds; once a
      // pending entry ages out, it resolves the board's verdict instead — so
      // a warm handle cannot loop an already-approved action forever.
      return holdForApproval(toolName, executed, rule, guard);
    } catch {
      // Never throw: omp turns a throwing handler into a blanket block.
      return undefined;
    }
  });

  // The tally only accumulates: whether the session is OVER cap is derived at
  // each gate check from the cap on disk, so a raised or removed cap takes
  // effect on the next tool call instead of waiting for a message that may
  // never come.
  pi.on("message_end", (event) => {
    try {
      const total = event?.message?.usage?.cost?.total ?? 0;
      if (typeof total === "number" && Number.isFinite(total)) runningCost += total;
    } catch {
      // Never throw; a missed message only loosens an already-coarse cap.
    }
  });
}

async function installSkillsLane(pi: BridgePi): Promise<void> {
  const manifestPath = process.env.PAPERCLIP_SKILLS_MANIFEST;
  if (!manifestPath) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;

  for (const value of parsed) {
    if (!isSkillManifestEntry(value)) continue;
    const { name, toolName, description, markdownPath } = value;
    pi.registerTool({
      name: toolName,
      label: name,
      description,
      parameters: { type: "object", properties: {} },
      // "essential" — without it non-builtin tools default to
      // "discoverable" and are stripped from the model's top-level schema.
      loadMode: "essential",
      execute: async () => ({
        content: [
          { type: "text", text: await fs.readFile(markdownPath, "utf8") },
        ],
      }),
    });
  }
}

/**
 * Register the paperclip bridge on `pi`. Each lane reads its own manifest env
 * at `session_start` and no-ops without it, so skills and governance can be
 * armed independently; nothing here ever throws, because the adapter also loads
 * this extension in side-channel omp children that receive neither manifest.
 */
export default function registerPaperclipBridge(pi: BridgePi): void {
  pi.on("session_start", async () => {
    installGovernanceLane(pi);
    await installSkillsLane(pi);
  });
}
