import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import type { SubagentObservability } from "../host/protocol.js";
import { validThinkingLevel } from "./thinking-levels.js";

export type { SubagentObservability };

export { validThinkingLevel } from "./thinking-levels.js";

export interface SessionIntelConfig {
  browser: boolean;
  /** Ask omp for the host-wide `_omp/*` listing and report counts only. */
  diagnostic: boolean;
  forkSourceId: string;
  forkToken: string;
  forceFreshToken: string;
  maxRuns: number;
  maxAgeHours: number;
  usageReport: boolean;
}

function str(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === "string" ? v.trim() : "";
}

function num(config: Record<string, unknown>, key: string): number {
  const v = config[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function readSessionIntelConfig(config: Record<string, unknown>): SessionIntelConfig {
  return {
    browser: config.sessionBrowser !== false && config.sessionBrowser !== "false",
    diagnostic: config.sessionSnapshotDiagnostic === true || config.sessionSnapshotDiagnostic === "true",
    forkSourceId: str(config, "sessionForkSourceId"),
    forkToken: str(config, "sessionForkToken"),
    forceFreshToken: str(config, "sessionForceFreshToken"),
    maxRuns: num(config, "sessionMaxRuns"),
    maxAgeHours: num(config, "sessionMaxAgeHours"),
    usageReport: config.usageReport !== false && config.usageReport !== "false",
  };
}

/**
 * Where a run's omp state lives.
 *
 * `shared` is the historical behavior: the run resolves the host's single omp
 * agent dir (`~/.omp/agent`), so every employee on the host shares sessions,
 * titles, caches, config and credentials, and omp's global listing can see
 * them all.
 *
 * `isolated` resolves `PI_CODING_AGENT_DIR` to this agent's own dir, which is
 * the only knob that scopes omp's reads — `_omp/sessions/listAll`,
 * `_omp/projects/list`, ACP `session/list` and the load-by-id fallback all
 * resolve through `getSessionsDir()` under the agent dir
 * (acp-agent.ts:1421,1429,2644-2647,2664; session-manager.ts:4525;
 * session-listing.ts:660), while `--session-dir` scopes writes only. That dir
 * also holds `agent.db` (credential store) and `config.yml`, so an isolated run
 * must get credentials out of band: it requires `credentialMode: broker`.
 */
export type SessionScope = "shared" | "isolated";

export function resolveSessionScope(config: Record<string, unknown>): SessionScope {
  return config.sessionScope === "isolated" ? "isolated" : "shared";
}

/**
 * Actionable message when `sessionScope` is invalid or cannot work, else null.
 * Mirrors validateCredentialMode: the caller returns before any transport work, so
 * a misconfigured fence can never silently fall back to the shared agent dir.
 */
export function validateSessionScope(config: Record<string, unknown>): string | null {
  const raw = config.sessionScope;
  if (raw !== undefined && raw !== null && raw !== "" && raw !== "shared" && raw !== "isolated") {
    // A typo would otherwise mean "shared", silently disabling containment.
    return `sessionScope is '${String(raw)}' but expected 'shared' or 'isolated'.`;
  }
  if (raw === "isolated" && config.credentialMode !== "broker") {
    return "sessionScope is 'isolated' but credentialMode is not 'broker': the isolated scope points omp at this agent's own agent dir, which holds no credential store (agent.db) and no operator config, so a local-login run would start with no credentials. Set credentialMode to 'broker' with OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN, or keep sessionScope 'shared'.";
  }
  return null;
}

/**
 * Steering: whether a running turn accepts `steer`/`follow_up` from the board.
 * Off by default because Paperclip has no UI contract for it yet; an unknown
 * value is a config error so a typo never silently enables or disables it.
 */
export type SteeringMode = "off" | "on";

export function resolveSteering(config: Record<string, unknown>): SteeringMode | null {
  const raw = config.steering;
  if (raw === undefined || raw === null || raw === "") return "off";
  if (raw === "on" || raw === "off") return raw;
  return null;
}

export function validateSteering(config: Record<string, unknown>): string | null {
  if (resolveSteering(config) !== null) return null;
  return `steering is '${String(config.steering)}' but expected 'off' or 'on'.`;
}

/**
 * How much subagent lifecycle the run subscribes to.
 *
 * `summary` (the default) streams lifecycle/progress as bounded `omp.subagent`
 * events and records a settlement snapshot; `events` adds each subagent's own
 * event type and a content-free summary; `off` subscribes to nothing and adds
 * no result evidence. An unknown value is a config error, not a silent
 * default: the levels differ in how much transcript-adjacent metadata leaves
 * the worker.
 */
export function resolveSubagentObservability(config: Record<string, unknown>): SubagentObservability | null {
  const raw = config.subagentObservability;
  if (raw === undefined || raw === null || raw === "") return "summary";
  if (raw === "off" || raw === "summary" || raw === "events") return raw;
  return null;
}

export function validateSubagentObservability(config: Record<string, unknown>): string | null {
  if (resolveSubagentObservability(config) !== null) return null;
  return `subagentObservability is '${String(config.subagentObservability)}' but expected 'off', 'summary' or 'events'.`;
}

export type RunDirective =
  | { kind: "fork"; forkSourceId: string; forkToken: string }
  | { kind: "forceFresh"; token: string }
  | { kind: "rotate"; reason: string }
  | { kind: "none" };

interface DirectiveState {
  forkConsumed: string[];
  forceFreshConsumed: string[];
  pendingRotate: { reason: string; at: string } | null;
}

/**
 * Pick the single directive for this run. Precedence: fork > force-fresh >
 * pending compaction rotation. Consumed tokens suppress their directive; a
 * failed fork or a warm-handle win leaves the token unconsumed (see the
 * post-run consumption check), so the next run retries it.
 */
export function resolveRunDirective(
  cfg: Pick<SessionIntelConfig, "forkSourceId" | "forkToken" | "forceFreshToken">,
  state: DirectiveState,
): RunDirective {
  if (cfg.forkToken && cfg.forkSourceId && !state.forkConsumed.includes(cfg.forkToken)) {
    return { kind: "fork", forkSourceId: cfg.forkSourceId, forkToken: cfg.forkToken };
  }
  if (cfg.forceFreshToken && !state.forceFreshConsumed.includes(cfg.forceFreshToken)) {
    return { kind: "forceFresh", token: cfg.forceFreshToken };
  }
  if (state.pendingRotate) return { kind: "rotate", reason: state.pendingRotate.reason };
  return { kind: "none" };
}

/** Config keys an operator could use to switch plan mode on. */
const PLAN_MODE_KEYS = ["plan", "planMode", "planEnabled", "planYolo", "planYoloInto"] as const;

/** `--plan`, `--plan opus`, `--plan-yolo`, `--plan-yolo-into <model>`; not `--planning`. */
const PLAN_FLAG = /(^|\s)--plan(-[a-z-]+)?(\s|=|$)/;

/**
 * Plan mode is a deliberate "no" for this adapter, and this guard makes that
 * enforceable instead of advisory.
 *
 * omp asks the ACP client to approve a plan before it leaves plan mode, but a
 * client without `elicitation/form` support is answered `true` by omp itself
 * (`acp-agent.ts`: `if (!supportsForm) return true`). This adapter declares no
 * form support, so enabling plan mode would delete the approval step — the
 * exact opposite of what plan mode is for. Enabling it is therefore a config
 * error, not a warn: a run that starts in plan mode cannot be rescued later.
 *
 * Returns the actionable message, or null when nothing tries to enable it.
 * Keys omp reads from `config.yml` outside this adapter's surface (`plan.enabled`
 * inside a `PI_CONFIG_FILES` entry) are the operator's own escape hatch and are
 * not inspected here.
 */
export function validatePlanMode(config: Record<string, unknown>): string | null {
  const disabled = (source: string): string =>
    `plan mode is disabled for this adapter (${source}): omp auto-approves the plan whenever the ACP `
    + "client has no elicitation/form support (acp-agent.ts), so enabling it deletes the approval step "
    + 'instead of adding one. This is a deliberate "no" until an elicitation client exists — remove it.';
  for (const key of PLAN_MODE_KEYS) {
    const value = config[key];
    const on = value === true
      || (typeof value === "number" && value !== 0)
      || (typeof value === "string" && value.trim() !== "" && value.trim() !== "false");
    if (on) return disabled(key);
  }
  for (const key of ["mode", "acpMode"] as const) {
    const value = config[key];
    if (typeof value === "string" && value.trim().toLowerCase() === "plan") {
      return disabled(`${key}: plan`);
    }
  }
  const command = [config.command, config.agentCommand, config.acpAgentCommand]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (PLAN_FLAG.test(command)) return disabled("a command flag");
  return null;
}

/** Actionable message when config.thinking holds an out-of-enum value, else null.
 * Mirrors validateCredentialMode: the append itself is fail-open (a bad value
 * just means "use the omp default"), so this only feeds a warn, never an abort. */
export function validateThinkingLevel(config: Record<string, unknown>): string | null {
  const level = config.thinking;
  if (level === undefined || level === "default") return null;
  if (validThinkingLevel(level) !== null) return null;
  return `thinking is '${String(level)}' but expected one of off, auto, minimal, low, medium, high, xhigh, max (default is sentinel for no flag).`;
}

const NEXT_RUN = "Takes effect on the next run (the adapter has no live connection between runs).";

/**
 * Whether the operator now asks for a level the running session cannot hold.
 *
 * omp resolves a resumed session's level from the transcript's
 * `thinking_level_change` entry, ahead of `defaultThinkingLevel`
 * (sdk.ts:2139-2146; agent-session.ts:12811-12835), so a level change on an
 * existing session needs a fresh session to take effect. The record is the
 * level the adapter asked for when the session started. No record (a state
 * written before this field, or a session something else replaced) is adopted
 * rather than rotated on: an upgrade must never reset a running employee. A
 * record whose LEVEL is null is the running session's own unknown level (a fork
 * from a session this adapter never ran) and counts as a change, so one fresh
 * session converts "unknown" into "certainly configured" — leaving it unknown
 * would make every later edit inert, and the fork must not be claimed to run at
 * a level nobody set.
 */
export function thinkingLevelChanged(
  record: { sessionId: string; level: string | null } | null,
  sessionId: string,
  requested: string,
): boolean {
  if (record === null || record.sessionId !== sessionId) return false;
  if (record.level === null) return true;
  return record.level !== requested;
}

export function getSessionConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      { key: "sessionScope", label: "Session data scope", type: "select", default: "shared",
        options: [
          { label: "Shared with every omp agent on this host", value: "shared" },
          { label: "Isolated per employee (requires broker credentials)", value: "isolated" },
        ],
        hint: `shared = the host's one omp agent dir (~/.omp/agent): every employee shares sessions, titles, caches and credentials. isolated = this agent's own omp agent dir under the Paperclip instance, so sessions, titles and caches are private to it; it requires credentialMode 'broker' because the private dir has no credential store. Switching shared→isolated starts an empty dir and the employee's previous session is not resumed (the run warns once; the old transcript stays where it was). ${NEXT_RUN}` },
      { key: "sessionBrowser", label: "Session browser", type: "toggle", default: true,
        hint: `Emit a session-snapshot work product when the session landscape changes. ${NEXT_RUN}` },
      { key: "sessionSnapshotDiagnostic", label: "Host-wide session listing (diagnostic)", type: "toggle", default: false,
        hint: `Also query omp's host-wide _omp/* listing and log how many sessions and projects it sees. Counts only: ids, cwds and titles never leave the host, but the count itself is host-wide information about every omp employee. ${NEXT_RUN}` },
      { key: "sessionForceFreshToken", label: "Force fresh session (token)", type: "text",
        hint: `Set/change to start a brand-new ACP session. ${NEXT_RUN}` },
      { key: "sessionForkSourceId", label: "Fork source session id", type: "text",
        hint: `Persisted omp session id to fork (copy a prefix-full id from a session snapshot card). ${NEXT_RUN}` },
      { key: "sessionForkToken", label: "Fork token", type: "text",
        hint: `Arms the fork; consumed once the run verifiably resumes the fork. ${NEXT_RUN}` },
      { key: "sessionMaxRuns", label: "Rotate session after N runs", type: "number", default: 0,
        hint: `0 disables. Rotate (fresh session) after N runs on the same session. ${NEXT_RUN}` },
      { key: "sessionMaxAgeHours", label: "Rotate session older than (hours)", type: "number", default: 0,
        hint: `0 disables. Rotate when the current session is older than this. ${NEXT_RUN}` },
      { key: "credentialMode", label: "Credential mode", type: "select", default: "local", options: [{ label: "Local", value: "local" }, { label: "Broker", value: "broker" }],
        hint: `Consumption-only: operator runs 'omp auth-broker serve' and binds the token via secret_ref. ${NEXT_RUN}` },
      { key: "thinking", label: "Thinking level", type: "select", default: "default",
        options: [
          { label: "Model default", value: "default" },
          { label: "off", value: "off" },
          { label: "auto", value: "auto" },
          { label: "minimal", value: "minimal" },
          { label: "low", value: "low" },
          { label: "medium", value: "medium" },
          { label: "high", value: "high" },
          { label: "xhigh", value: "xhigh" },
          { label: "max", value: "max" },
        ],
        hint: `Reasoning depth for sessions this agent starts: the run child gets it as omp's own defaultThinkingLevel through a run-scoped settings overlay, so changing the level does not enter the engine fingerprint (adding the first level or clearing it flips PI_CONFIG_FILES present↔absent, which rotates once). omp keeps the level a session started with inside that session's transcript and prefers it on resume, so a resumed session keeps that stored level: editing this restarts the session once so the new level applies (the run says so), and no other run rotates — except one run after a fork whose source this adapter never ran, which restarts once so the forked session's inherited level is known. A model whose catalog declares its own default effort outranks this setting unless the level is "auto". "off" runs the CLI flag because omp's setting has no off value. "Model default" sends nothing. ${NEXT_RUN}` },
      { key: "fallbackChain", label: "Model fallback chain", type: "textarea",
        hint: `One selector per line, injected via PI_CONFIG_FILES. Adding the first selector or clearing the last flips PI_CONFIG_FILES present↔absent, which rotates the agent's session (fingerprint change) on the next run. ${NEXT_RUN}` },
      { key: "fallbackOn", label: "Failover trigger", type: "select", default: "any",
        options: [
          { label: "Any provider error", value: "any" },
          { label: "Usage limits only", value: "usage-limit" },
          { label: "Everything except usage limits", value: "except-usage-limit" },
        ],
        hint: `Which failed requests may walk the fallback chain (omp retry.fallbackOn). "Usage limits only" retries usage-limit failures on other models and handles every other error with omp's normal backoff. An unknown value is a config error, not a file omp discards. ${NEXT_RUN}` },
      { key: "fallbackRevertPolicy", label: "Failover revert policy", type: "select", default: "cooldown-expiry",
        options: [
          { label: "Return to the primary model when its cooldown expires", value: "cooldown-expiry" },
          { label: "Stay on the fallback model", value: "never" },
        ],
        hint: `Whether a run returns to the primary model after a fallback (omp retry.fallbackRevertPolicy). ${NEXT_RUN}` },
      { key: "waitForUsageReset", label: "Wait out usage resets", type: "toggle", default: false,
        hint: `Let a provider-stated usage-limit wait exceed the backoff ceiling when a reset hint supplies authoritative timing (omp retry.waitForUsageReset). Waits are abortable but can also hold subagents. ${NEXT_RUN}` },
      { key: "maxDelayMs", label: "Backoff ceiling (ms)", type: "number",
        hint: `Longest retry backoff in milliseconds (omp retry.maxDelayMs); empty uses omp's 300000, and 0 disables the cap. A negative or non-numeric value is a config error. ${NEXT_RUN}` },
      { key: "usageReport", label: "Emit usage report", type: "toggle", default: true,
        hint: `Emit an omp-usage work product with cost estimates. ${NEXT_RUN}` },
      { key: "skillsAsTools", label: "Expose skills as on-demand tools", type: "toggle", default: false,
        hint: `Register each enabled company skill as a native omp tool that returns its instructions on demand, instead of injecting all skill text into the prompt. Reduces context use. ${NEXT_RUN}` },
      { key: "steering", label: "Steering", type: "select", default: "off",
        options: [
          { label: "Off", value: "off" },
          { label: "On (forward steer/follow_up to the live turn)", value: "on" },
        ],
        hint: `When on, a steering request is forwarded to the running turn through omp RPC steer/follow_up; when off the supervisor refuses it. ${NEXT_RUN}` },
      { key: "subagentObservability", label: "Subagent observability", type: "select", default: "summary",
        options: [
          { label: "Off", value: "off" },
          { label: "Summary (lifecycle, progress, run snapshot)", value: "summary" },
          { label: "Events (summary plus subagent event type)", value: "events" },
        ],
        hint: `summary subscribes to omp's lifecycle/progress and emits bounded omp.subagent events plus a resultJson.subagents snapshot at settle; events also carries each subagent's event type and a content-free summary. Subagent prompts, tool arguments, tokens and transcripts are never carried, and every string is capped. Off subscribes to nothing and adds no result evidence. ${NEXT_RUN}` },
      { key: "governancePolicy", label: "Governance policy (YAML/JSON)", type: "textarea",
        hint: `Rules the run's omp child enforces through the paperclip bridge: guardrails (pathScopes, bashDeny, denyTools, argRevisions), budgetCapUsd, approvedEndpoints, approvalRequired. approvalRequired names tools a human must approve first (a bare tool name or {tool, reason?, risk?}; the name may end in *) — a match posts a board approval and BLOCKS the call: advisory, because approving wakes a NEW run while this one never resumes, and an identical retry in the same session is deduped instead of re-posting. budgetCapUsd is a soft PER-SESSION cap the bridge enforces: each omp session — subagents included — gets its own cap (with N in-process subagents the effective ceiling can be (1+N)×cap), and cost only accumulates across runs while a warm handle is reused (cold children make it per-run by default); past it, mutating tools block and read-only/control tools stay open. The same number is also forwarded to the omp child as its own session cost cap (session.maxCost), which refuses the next model request once the session tree reaches it; an early warning fires at 80% of the cap (the adapter's own heuristic). Adding or clearing the key changes PI_CONFIG_FILES and rotates the session once; changing only the number does not. Empty = off. While set, the run child's own config carries tools.approvalMode: yolo and the bridge is the single gate; a document that cannot be parsed is skipped with a warning rather than run ungoverned. approvedEndpoints is a provider allow-list: the run gets the complement as omp's disabledProviders, so unapproved endpoints are unreachable — while the configured model's provider and any fallbackChain provider are never disabled (a guard that warns rather than strands the run), and routing is skipped with a warning when no catalog is available to compute a safe complement. Adding or clearing the policy rotates the session (fingerprint change), so rule edits land on the next rotation; changing only which endpoints are approved keeps the path stable, so a cold child (the default) picks the new list up next run while a warm handle keeps the old one. restrictedFolders names folders where every call needs a human: the run child gets them as omp's tools.restrictedFolders (a prompt in every approval mode) and the bridge holds the same paths for a board approval, which is the ask a human actually sees under the single gate. yolo is written as a CONFIGURED approval mode, so omp does not ask its own permission proxy for bash/edit/delete/move — the bridge is their only gate; the proxy still answers whatever omp does ask (critical bash, restricted-folder prompts) and auto-allows it under the default approve-all. Because of that, approvalMode 'deny-all' together with pathScopes or argRevisions is rejected at config time. Plan mode is unavailable: plan/planMode/planEnabled/mode: plan/--plan are config errors, since omp auto-approves a plan when the client has no elicitation support. ${NEXT_RUN}` },
    ],
  };
}
/** Actionable message when broker mode is misconfigured, else null. Mirrors omp's
 * fail-closed resolveAuthBrokerConfig (discover.ts:217-222). config.env values are
 * already resolved strings (see plan precondition). */
export function validateCredentialMode(config: Record<string, unknown>): string | null {
  if (config.credentialMode !== "broker") return null;
  const env = (config.env ?? {}) as Record<string, unknown>;
  const url = typeof env.OMP_AUTH_BROKER_URL === "string" && env.OMP_AUTH_BROKER_URL;
  const token = typeof env.OMP_AUTH_BROKER_TOKEN === "string" && env.OMP_AUTH_BROKER_TOKEN;
  if (!url) return "credentialMode is 'broker' but OMP_AUTH_BROKER_URL is not set in the agent env.";
  if (!token) return "credentialMode is 'broker' but OMP_AUTH_BROKER_TOKEN is not set in the agent env (bind it to a company secret via secret_ref).";
  return null;
}


import type { OmpSessionsSnapshot } from "./session-intel.js";

export interface WorkProductPayload {
  type: "artifact";
  provider: string;
  title: string;
  summary: string;
  url?: string;
  metadata: Record<string, unknown>;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

export function buildSessionSnapshotWorkProduct(
  snapshot: OmpSessionsSnapshot,
  context: { currentSessionId: string | null; runId: string; capturedAt: string },
): WorkProductPayload {
  const recent = [...snapshot.sessions]
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, 5);
  const currentLine = context.currentSessionId
    ? `Current session: ${shortId(context.currentSessionId)}`
    : "Current session: none (fresh session on next run)";
  const lines = [
    currentLine,
    ...recent.map((s) => {
      const parsed = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
      const age = Number.isNaN(parsed) ? "unknown time" : new Date(parsed).toISOString();
      return `${shortId(s.sessionId)} — ${s.title ?? "untitled"} — ${s.messageCount ?? "?"} msgs — ${age}`;
    }),
  ];
  const count = snapshot.total === null
    ? `${snapshot.sessions.length}+`
    : String(snapshot.sessions.length);
  return {
    type: "artifact",
    provider: "omp-session",
    // Scope is part of the title: a reader must never mistake this card for a
    // host-wide listing (only the operator diagnostic can look host-wide, and
    // it publishes counts only).
    title: `Session snapshot — ${count} sessions in this workspace, current ${context.currentSessionId ? shortId(context.currentSessionId) : "none"}`,
    summary: lines.join("\n"),
    metadata: {
      projects: snapshot.projects,
      sessions: snapshot.sessions,
      total: snapshot.total,
      truncated: snapshot.truncated,
      currentSessionId: context.currentSessionId,
      capturedAt: context.capturedAt,
      runId: context.runId,
    },
  };
}

/**
 * The landscape the session-snapshot card dedups on: exactly what the card
 * renders, so a change the board would see can never compare equal. Key order
 * is fixed by this projection, never by omp's payload.
 */
export function sessionSnapshotDigestInput(
  snapshot: Pick<OmpSessionsSnapshot, "projects" | "sessions">,
  current: string | null,
): Record<string, unknown> {
  return {
    projects: snapshot.projects,
    ids: snapshot.sessions.map((s) => [s.sessionId, s.updatedAt]),
    current,
  };
}
export function paperclipApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PAPERCLIP_API_URL ?? env.PAPERCLIP_RUNTIME_API_URL;
  if (explicit) return explicit.replace(/\/+$/, "").replace(/\/api$/, "");
  const host = env.PAPERCLIP_LISTEN_HOST === "0.0.0.0" || !env.PAPERCLIP_LISTEN_HOST
    ? "127.0.0.1"
    : env.PAPERCLIP_LISTEN_HOST;
  const port = env.PAPERCLIP_LISTEN_PORT || env.PORT || "3100";
  return `http://${host}:${port}`;
}

const ISSUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The issue a work product can be posted to, or null. Paperclip issues are
 * UUIDs; a run's `taskId` is also set on non-issue wakes (a chat wake carries
 * `chat-1`), and POSTing there is a guaranteed 404 on the run path. Both
 * `issueId` and `taskId` are canonicalized to the issue UUID by the queue when
 * one exists, so shape is the reliable discriminator the adapter can see.
 */
export function resolveWorkProductIssueId(context: Record<string, unknown>): string | null {
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && ISSUE_ID_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

/**
 * POST one work product to the issue's board. One attempt: no retry (the run
 * path must not amplify a failing control plane), and a bounded wait so a
 * hung endpoint cannot hold a finished heartbeat open.
 */
export async function postWorkProduct(
  deps: {
    authToken?: string; issueId: string; apiBase?: string; fetchImpl?: typeof fetch; timeoutMs?: number;
  },
  payload: WorkProductPayload,
): Promise<{ ok: boolean; error?: string }> {
  if (!deps.issueId) return { ok: false, error: "no issue id on this run" };
  if (!deps.authToken) return { ok: false, error: "no run auth token available" };
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${deps.apiBase ?? paperclipApiBase()}/api/issues/${deps.issueId}/work-products`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.authToken}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      return { ok: false, error: `work-product POST failed: HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `work-product POST failed: ${String(err)}` };
  }
}
