import { isRecord, type SubagentObservability } from "./protocol.js";
import type { RpcFrame } from "./worker.js";

/**
 * Subagent observability for the managed lane: pure translations between omp's
 * RPC subagent frames and the bounded `omp.subagent` payload the adapter
 * relays, plus the settlement snapshot.
 *
 * omp's frames carry prompt text (`task`, `assignment`, the subagent's own
 * messages and tool arguments). None of those fields is read here: a payload is
 * built field by field from an allowlist, every string is redacted and capped,
 * and the frame count per run is capped too. A subagent's description is model
 * authored, so it can itself contain a credential the model was shown.
 */

/** omp's RPC subscription levels (rpc-types.ts: `RpcSubagentSubscriptionLevel`). */
export type RpcSubagentLevel = "off" | "progress" | "events";

/** The managed lane's own vocabulary; `summary` maps onto omp's `progress`. */
export function rpcSubagentLevel(level: SubagentObservability): RpcSubagentLevel {
  return level === "summary" ? "progress" : level;
}

/** Per-run cap on emitted `omp.subagent` frames; the snapshot still counts all. */
export const SUBAGENT_EVENT_FRAME_CAP = 100;
/** Cap on the settlement snapshot's item list; counts stay whole. */
export const SUBAGENT_ITEM_CAP = 50;
/** Cap on every free-text field (descriptions, summaries). */
export const SUBAGENT_TEXT_CAP = 200;
const SUBAGENT_ID_CAP = 128;
const SUBAGENT_AGENT_CAP = 64;
const SUBAGENT_EVENT_CAP = 120;
const REDACTED = "[redacted]";

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentObservation {
  id: string;
  index: number;
  agent: string;
  status: SubagentStatus;
  description: string | null;
  parentToolCallId: string | null;
  lastUpdate: number;
}

export interface SubagentFrameRead {
  id: string;
  index: number | null;
  agent: string | null;
  status: SubagentStatus | null;
  description: string | null;
  parentToolCallId: string | null;
  /** The subagent's own event type, at subscription level `events` only. */
  event: string | null;
  summary: string | null;
}

export interface SubagentSummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  items: SubagentObservation[];
}

/** Credential shapes a model can echo into a description or an event type. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|rk|pcp|ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA)[-_][A-Za-z0-9_-]{6,}\b/gi,
  /\b[A-Za-z0-9+/=_-]{40,}\b/g,
];

/**
 * Redact credential shapes, collapse control/whitespace runs, then cap. The
 * redaction runs before the cap so a token cut in half cannot leave its prefix.
 */
function boundedText(value: unknown, cap = SUBAGENT_TEXT_CAP): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  let text = collapsed;
  for (const pattern of CREDENTIAL_PATTERNS) text = text.replace(pattern, REDACTED);
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

function boundedIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Map omp's lifecycle/progress statuses onto the snapshot's four counters. */
export function normalizeSubagentStatus(value: unknown): SubagentStatus | null {
  switch (value) {
    case "started":
    case "running":
    case "pending":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "cancelled";
    default:
      return null;
  }
}

function readAgentEvent(value: unknown): { type: string; summary: string } | null {
  if (!isRecord(value)) return null;
  const type = boundedText(value.type, SUBAGENT_EVENT_CAP);
  if (type === null) return null;
  let summary = type;
  if (type.startsWith("tool_")) {
    const tool = boundedText(value.toolName, SUBAGENT_AGENT_CAP);
    if (tool !== null) summary = `${type}: ${tool}`;
    if (value.isError === true) summary = `${summary} (error)`;
  }
  return { type, summary: boundedText(summary, SUBAGENT_EVENT_CAP) ?? type };
}

/**
 * Read one omp subagent frame into the bounded shape the payload uses. Fields
 * that carry prompt text (`task`, `assignment`, `progress.task`, event message
 * bodies and tool arguments) are never read.
 */
export function readSubagentFrame(frame: RpcFrame): SubagentFrameRead | null {
  if (!isRecord(frame.payload)) return null;
  const payload = frame.payload;
  if (frame.type === "subagent_lifecycle") {
    const id = boundedText(payload.id, SUBAGENT_ID_CAP);
    if (id === null) return null;
    return {
      id,
      index: boundedIndex(payload.index),
      agent: boundedText(payload.agent, SUBAGENT_AGENT_CAP),
      status: normalizeSubagentStatus(payload.status),
      description: boundedText(payload.description),
      parentToolCallId: boundedText(payload.parentToolCallId, SUBAGENT_ID_CAP),
      event: null,
      summary: null,
    };
  }
  if (frame.type === "subagent_progress") {
    const progress = isRecord(payload.progress) ? payload.progress : null;
    const id = boundedText(progress?.id, SUBAGENT_ID_CAP);
    if (id === null) return null;
    return {
      id,
      index: boundedIndex(payload.index),
      agent: boundedText(payload.agent, SUBAGENT_AGENT_CAP),
      status: normalizeSubagentStatus(progress?.status),
      description: boundedText(progress?.description),
      parentToolCallId: boundedText(payload.parentToolCallId, SUBAGENT_ID_CAP),
      event: null,
      summary: null,
    };
  }
  if (frame.type === "subagent_event") {
    const id = boundedText(payload.id, SUBAGENT_ID_CAP);
    if (id === null) return null;
    const event = readAgentEvent(payload.event);
    return {
      id,
      index: null,
      agent: null,
      status: null,
      description: null,
      parentToolCallId: null,
      event: event?.type ?? null,
      summary: event?.summary ?? null,
    };
  }
  return null;
}

/** Read one `get_subagents` roster entry; the roster is untrusted shape. */
export function readSubagentSnapshot(value: unknown): SubagentObservation | null {
  if (!isRecord(value)) return null;
  const id = boundedText(value.id, SUBAGENT_ID_CAP);
  if (id === null) return null;
  return {
    id,
    index: boundedIndex(value.index) ?? 0,
    agent: boundedText(value.agent, SUBAGENT_AGENT_CAP) ?? "subagent",
    status: normalizeSubagentStatus(value.status) ?? "running",
    description: boundedText(value.description),
    parentToolCallId: boundedText(value.parentToolCallId, SUBAGENT_ID_CAP),
    lastUpdate: boundedIndex(value.lastUpdate) ?? Date.now(),
  };
}

/**
 * Merge the run's observed lifecycle with the still-running roster at settle.
 * A terminal observation stays terminal: omp removes finished subagents from
 * its roster, so a roster entry that still says "running" is only a refresh.
 * Returns null when the run saw nothing, so no empty field is added.
 */
export function buildSubagentSnapshot(
  observations: Iterable<SubagentObservation>,
  running: Iterable<SubagentObservation>,
): SubagentSummary | null {
  const merged = new Map<string, SubagentObservation>();
  for (const observation of observations) merged.set(observation.id, observation);
  for (const live of running) {
    if (live.status !== "running") continue;
    const existing = merged.get(live.id);
    if (existing !== undefined && existing.status !== "running") continue;
    merged.set(live.id, existing === undefined ? live : { ...existing, ...live });
  }
  const all = [...merged.values()].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  if (all.length === 0) return null;
  const count = (status: SubagentStatus): number => all.filter((item) => item.status === status).length;
  return {
    total: all.length,
    completed: count("completed"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    running: count("running"),
    items: all.slice(0, SUBAGENT_ITEM_CAP),
  };
}
