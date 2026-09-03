import { promises as fs, readFileSync, realpathSync, statSync } from "node:fs";
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
 *   guardrail armed by `PAPERCLIP_GOVERNANCE_MANIFEST` (governance.json). The
 *   gate evaluates path scopes, bash deny patterns, denied tool names and
 *   argument revisions, and is deliberately independent of the skills lane: a
 *   governance-only agent (skillsAsTools off) must still be enforced.
 *
 * omp's `#beforeToolCall` awaits this handler before the tool runs and before
 * any approval proxy, and fail-closes (blocks the call) if a handler throws or
 * outlives `extensionHandlers.toolCallTimeoutMs` — so the handler stays
 * synchronous, allocation-light and throw-free: the only I/O is a `stat` of the
 * manifest plus, when its mtime moved, one small read.
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

type BridgeToolCallHandler = (
  event: BridgeToolCallEvent,
  ctx: BridgeToolCallContext,
) => BridgeToolCallResult | undefined;

/** Structural subset of omp's ExtensionAPI. */
interface BridgePi {
  on(event: "session_start", handler: () => void | Promise<void>): unknown;
  on(event: "tool_call", handler: BridgeToolCallHandler): unknown;
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

interface GuardrailRules {
  pathScopes: PathScopeRule | null;
  bashDeny: BashDenyRule[];
  denyTools: Record<string, true>;
  argRevisions: Record<string, Record<string, unknown>>;
  /** Memoized realpath'd roots, valid only for `rootsCwd`. */
  rootsCwd: string | null;
  roots: string[] | null;
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

  return {
    pathScopes: normalizePathScopes(bag.pathScopes),
    bashDeny,
    denyTools,
    argRevisions,
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

/**
 * Path fields the gate reads: the canonical `path`, the `file_path` alias
 * omp's file tools still accept (its own renderers read
 * `args.file_path || args.path`, so a model can name either), and the derived
 * hashline `paths` list. Missing an alias here would make the rail
 * bypassable by rewording the argument. The gate covers the three built-in
 * file tools; other file-touching tools (`ast_edit`, MCP writes) are held by
 * `denyTools`, which is also where the T3 budget gate widens the net.
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
      return evaluateGuardrails(event, ctx, current);
    } catch {
      // Never throw: omp turns a throwing handler into a blanket block.
      return undefined;
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
