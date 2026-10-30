import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import type { SessionScope } from "./session-directives.js";

export interface RunCounter { count: number; firstRunAt: string }
export interface RunUsage { at: string; inputTokens: number; outputTokens: number; cachedInputTokens: number }
export interface SessionIntelState {
  forkConsumed: string[];
  forceFreshConsumed: string[];
  runCounters: Record<string, RunCounter>;
  pendingRotate: { reason: string; at: string } | null;
  lastSnapshotDigest: string | null;
  lastRotation: { reason: string; at: string; sessionKey: string } | null;
  recentRuns: RunUsage[];
  lastUsageDigest: string | null;
  /**
   * The session scope the previous run executed under. Null on a state written
   * before the scope existed (or never written). A `shared` -> `isolated` flip
   * is the moment the employee's resumable session is left behind, so it is the
   * once-only trigger for the cold-start warning.
   */
  lastScope: SessionScope | null;
  /**
   * The thinking level the adapter asked for when the CURRENT session was
   * created, with that session's id. omp stores the level inside the transcript
   * (`thinking_level_change`) and prefers it on resume, so this is the only way
   * to notice that the operator now asks for a different one.
   */
  lastThinking: { sessionId: string; level: string } | null;
}

const MAX_TOKENS = 64;

export function sessionIntelDir(companyId: string, agentId: string): string {
  return path.join(
    resolvePaperclipInstanceRootForAdapter(),
    "companies", companyId, "acp-engine", "agents", agentId, "omp-session-intel",
  );
}

/**
 * The omp agent dir a `sessionScope: "isolated"` run resolves
 * `PI_CODING_AGENT_DIR` to. Per company AND per agent, so two employees on one
 * host can never see each other's sessions, titles, caches or config.yml. omp
 * creates its own subdirectories (sessions/, agent.db, ...) inside it.
 */
export function ompAgentDir(companyId: string, agentId: string): string {
  return path.join(
    resolvePaperclipInstanceRootForAdapter(),
    "companies", companyId, "acp-engine", "agents", agentId, "omp-agent",
  );
}

function emptyState(): SessionIntelState {
  return {
    forkConsumed: [], forceFreshConsumed: [], runCounters: {},
    pendingRotate: null, lastSnapshotDigest: null, lastRotation: null,
    recentRuns: [], lastUsageDigest: null, lastScope: null, lastThinking: null,
  };
}

function isScope(value: unknown): value is SessionScope {
  return value === "shared" || value === "isolated";
}

export async function loadState(dir: string): Promise<SessionIntelState> {
  try {
    const raw = await readFile(path.join(dir, "state.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionIntelState>;
    const base = emptyState();
    return {
      forkConsumed: Array.isArray(parsed.forkConsumed) ? parsed.forkConsumed : base.forkConsumed,
      forceFreshConsumed: Array.isArray(parsed.forceFreshConsumed) ? parsed.forceFreshConsumed : base.forceFreshConsumed,
      runCounters: isRunCounters(parsed.runCounters) ? parsed.runCounters : base.runCounters,
      pendingRotate: isRotateInfo(parsed.pendingRotate) ? parsed.pendingRotate : base.pendingRotate,
      lastSnapshotDigest: typeof parsed.lastSnapshotDigest === "string" ? parsed.lastSnapshotDigest : base.lastSnapshotDigest,
      lastRotation: isLastRotation(parsed.lastRotation) ? parsed.lastRotation : base.lastRotation,
      recentRuns: Array.isArray(parsed.recentRuns) ? parsed.recentRuns.filter(isRunUsage).slice(-20) : base.recentRuns,
      lastUsageDigest: typeof parsed.lastUsageDigest === "string" ? parsed.lastUsageDigest : base.lastUsageDigest,
      lastScope: isScope(parsed.lastScope) ? parsed.lastScope : base.lastScope,
      lastThinking: isThinkingRecord(parsed.lastThinking) ? parsed.lastThinking : base.lastThinking,
    };
  } catch {
    return emptyState();
  }
}

function isRunCounters(value: unknown): value is Record<string, RunCounter> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === "object" && entry !== null
      && "count" in entry
      && typeof entry.count === "number"
      && Number.isFinite(entry.count)
      && "firstRunAt" in entry
      && typeof entry.firstRunAt === "string",
  );
}

function isThinkingRecord(value: unknown): value is { sessionId: string; level: string } {
  return typeof value === "object" && value !== null
    && "sessionId" in value
    && typeof value.sessionId === "string"
    && "level" in value
    && typeof value.level === "string";
}

function isRotateInfo(value: unknown): value is { reason: string; at: string } {
  return typeof value === "object" && value !== null
    && "reason" in value
    && typeof value.reason === "string"
    && "at" in value
    && typeof value.at === "string";
}

function isLastRotation(value: unknown): value is { reason: string; at: string; sessionKey: string } {
  return typeof value === "object" && value !== null
    && "reason" in value
    && typeof value.reason === "string"
    && "at" in value
    && typeof value.at === "string"
    && "sessionKey" in value
    && typeof value.sessionKey === "string";
}

function isRunUsage(value: unknown): value is RunUsage {
  return typeof value === "object" && value !== null
    && "at" in value
    && typeof value.at === "string"
    && "inputTokens" in value
    && typeof value.inputTokens === "number"
    && "outputTokens" in value
    && typeof value.outputTokens === "number";
}

export async function saveState(dir: string, state: SessionIntelState): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "state.json");
  const tmp = path.join(dir, `.state-${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, target);
}

export function consumeToken(list: string[], token: string): string[] {
  const next = [...list, token];
  return next.length > MAX_TOKENS ? next.slice(next.length - MAX_TOKENS) : next;
}

export function bumpRunCounter(state: SessionIntelState, sessionKey: string, nowIso: string): void {
  state.runCounters = { [sessionKey]: state.runCounters[sessionKey] ?? { count: 0, firstRunAt: nowIso } };
  state.runCounters[sessionKey].count += 1;
}

export interface RotationThresholds { maxRuns: number; maxAgeHours: number }

export function rotateIfTripped(
  state: SessionIntelState,
  sessionKey: string,
  thresholds: RotationThresholds,
  nowIso: string,
): boolean {
  const counter = state.runCounters[sessionKey];
  if (!counter) return false;
  const runsTripped = thresholds.maxRuns > 0 && counter.count >= thresholds.maxRuns;
  const ageMs = Date.parse(nowIso) - Date.parse(counter.firstRunAt);
  const ageTripped = thresholds.maxAgeHours > 0
    && Number.isFinite(ageMs)
    && ageMs >= thresholds.maxAgeHours * 3_600_000;
  if (!runsTripped && !ageTripped) return false;
  state.pendingRotate = { reason: runsTripped ? "maxRuns" : "maxAgeHours", at: nowIso };
  return true;
}

export function snapshotDigest(snapshot: unknown): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
}
