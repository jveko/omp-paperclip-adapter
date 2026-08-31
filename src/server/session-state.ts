import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

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
}

const MAX_TOKENS = 64;

export function sessionIntelDir(companyId: string, agentId: string): string {
  return path.join(
    resolvePaperclipInstanceRootForAdapter(),
    "companies", companyId, "acp-engine", "agents", agentId, "omp-session-intel",
  );
}

function emptyState(): SessionIntelState {
  return {
    forkConsumed: [], forceFreshConsumed: [], runCounters: {},
    pendingRotate: null, lastSnapshotDigest: null, lastRotation: null,
    recentRuns: [], lastUsageDigest: null,
  };
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
