import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export interface SessionIntelConfig {
  browser: boolean;
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
    forkSourceId: str(config, "sessionForkSourceId"),
    forkToken: str(config, "sessionForkToken"),
    forceFreshToken: str(config, "sessionForceFreshToken"),
    maxRuns: num(config, "sessionMaxRuns"),
    maxAgeHours: num(config, "sessionMaxAgeHours"),
    usageReport: config.usageReport !== false && config.usageReport !== "false",
  };
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

/** omp's CLI thinking levels (parseCliThinkingLevel). `inherit` is intentionally
 * excluded (omp rejects it) and `default` is a sentinel meaning "emit no flag". */
const THINKING_LEVELS = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function validThinkingLevel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Trim so padded values from the API (" medium ") still match: a padded value
  // that failed matching would silently drop the directive AND raise a
  // misleading warn. validateThinkingLevel delegates here, so both paths are fixed.
  const trimmed = value.trim();
  return (THINKING_LEVELS as readonly string[]).includes(trimmed) ? trimmed : null;
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

export function getSessionConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      { key: "sessionBrowser", label: "Session browser", type: "toggle", default: true,
        hint: `Emit a session-snapshot work product when the session landscape changes. ${NEXT_RUN}` },
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
        hint: `Forwards omp --thinking <level> to the run's omp child. Changing the level rotates the session (starts fresh) so the new level applies — it does NOT change a resumed session, and it is ignored on fork runs. "Model default" sends nothing. ${NEXT_RUN}` },
      { key: "fallbackChain", label: "Model fallback chain", type: "textarea",
        hint: `One selector per line, injected via PI_CONFIG_FILES. Adding the first selector or clearing the last flips PI_CONFIG_FILES present↔absent, which rotates the agent's session (fingerprint change) on the next run. ${NEXT_RUN}` },
      { key: "usageReport", label: "Emit usage report", type: "toggle", default: true,
        hint: `Emit an omp-usage work product with cost estimates. ${NEXT_RUN}` },
      { key: "skillsAsTools", label: "Expose skills as on-demand tools", type: "toggle", default: false,
        hint: `Register each enabled company skill as a native omp tool that returns its instructions on demand, instead of injecting all skill text into the prompt. Reduces context use. ${NEXT_RUN}` },
      { key: "governancePolicy", label: "Governance policy (YAML/JSON)", type: "textarea",
        hint: `Rules the run's omp child enforces through the paperclip bridge: guardrails (pathScopes, bashDeny, denyTools, argRevisions), budgetCapUsd, approvedEndpoints, approvalRequired. budgetCapUsd is a soft PER-SESSION cap: each omp session — subagents included — gets its own cap (with N in-process subagents the effective ceiling can be (1+N)×cap), and cost only accumulates across runs while a warm handle is reused (cold children make it per-run by default); past it, mutating tools block and read-only/control tools stay open. Empty = off. While set, the omp permission proxy auto-approves so the bridge is the single gate; a document that cannot be parsed is skipped with a warning rather than run ungoverned. approvedEndpoints is a provider allow-list: the run gets the complement as omp's disabledProviders, so unapproved endpoints are unreachable — while the configured model's provider and any fallbackChain provider are never disabled (a guard that warns rather than strands the run), and routing is skipped with a warning when no catalog is available to compute a safe complement. Adding or clearing the policy rotates the session (fingerprint change), so rule edits land on the next rotation; changing only which endpoints are approved keeps the path stable, so a cold child (the default) picks the new list up next run while a warm handle keeps the old one. ${NEXT_RUN}` },
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
  return {
    type: "artifact",
    provider: "omp-session",
    title: `Session snapshot — ${snapshot.sessions.length} sessions, current ${context.currentSessionId ? shortId(context.currentSessionId) : "none"}`,
    summary: lines.join("\n"),
    metadata: {
      projects: snapshot.projects,
      sessions: snapshot.sessions,
      total: snapshot.total,
      byCwd: snapshot.byCwd,
      // Omitted, not empty, when omp's ACP mode has no subagent surface, so a
      // card from an older/newer omp is byte-identical to one from before the
      // field existed.
      ...(snapshot.subagents ? { subagents: snapshot.subagents } : {}),
      currentSessionId: context.currentSessionId,
      capturedAt: context.capturedAt,
      runId: context.runId,
    },
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

export async function postWorkProduct(
  deps: { authToken?: string; issueId: string; apiBase?: string; fetchImpl?: typeof fetch },
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
    });
    if (!response.ok) {
      return { ok: false, error: `work-product POST failed: HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `work-product POST failed: ${String(err)}` };
  }
}
