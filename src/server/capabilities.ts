import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { probeOmpAcpSession, type OmpAcpProbeResult } from "./adapters/acp/client.js";

/**
 * What this omp build can actually do — probed once per (command, env, mode),
 * cached, and read by every consumer instead of comparing a version number.
 *
 * A capability is a record, not a boolean: `state` says whether the surface is
 * there, `confidence` says how it was learned (a protocol advertisement, a
 * behavioural probe, or an optimistic assumption), and `source` names the
 * evidence. Nothing here reads a credential; the settings probe keeps the key
 * set and never the values.
 *
 * Three probe groups, one process each:
 * - ACP: one handshake answers the advertised capability block, the config
 *   option ids, and two behavioural questions (`_session/steering`,
 *   `_omp/extensions`) whose error shapes identify an absent method.
 * - surface: `omp config list --json` (the settings key map) and `omp --help`
 *   (the CLI verbs), plus the sub-verb help for `models` and `session`.
 * - worker: managed mode only, on the `--mode rpc` connection the supervisor
 *   uses — requestable frames only. `session_settled` is a notification with
 *   no request surface, so it stays `unknown` until a managed turn reports it.
 *
 * Every probe is bounded and degrades: an absent surface is a `warn`/`info`
 * check naming the feature that will not work, never an error. Refusing to run
 * is reserved for the ACP handshake itself (tier 1 in the compatibility
 * contract), which the environment test already reports.
 */

export type CapabilityState = "yes" | "no" | "unknown";
export type CapabilityConfidence = "advertised" | "observed" | "assumed";

export interface Capability {
  state: CapabilityState;
  confidence: CapabilityConfidence;
  /** Where this was learned, e.g. `initialize.agentCapabilities.sessionCapabilities.fork`. */
  source: string;
  observedAt: string;
  detail?: string;
}

export type CapabilityId =
  | "acp.session/list"
  | "acp.session/fork"
  | "acp._session/steering"
  | "acp._omp/extensions"
  | "acp.config.mode"
  | "acp.config.model"
  | "acp.config.thinking"
  | "settings.session.maxCost"
  | "settings.tools.restrictedFolders"
  | "settings.defaultThinkingLevel"
  | "cli.models.refresh"
  | "cli.session.lease"
  | "cli.gc"
  | "rpc.session_settled"
  | "rpc.get_session_stats"
  | "rpc.set_host_tools"
  | "rpc.set_subagent_subscription";

/** The settings keys the adapter's overlays write, in probe order. */
const PROBED_SETTINGS_KEYS = [
  "session.maxCost",
  "tools.restrictedFolders",
  "defaultThinkingLevel",
] as const;

/** The worker frames the managed lane consumes. */
const PROBED_RPC_FRAMES = [
  "get_session_stats",
  "set_host_tools",
  "set_subagent_subscription",
] as const;
type ProbedRpcFrame = (typeof PROBED_RPC_FRAMES)[number];

export interface CapabilitySet {
  /** Cache key: command + args + env hash + lane. */
  key: string;
  observedAt: string;
  version: string | null;
  mode: "engine" | "managed";
  /**
   * Whether the settings/CLI group was probed at all. It is skipped for a
   * command not named `omp`, whose help/settings are its own; those rows must
   * then read as "not applicable", never as "missing".
   */
  surfaceProbed: boolean;
  capabilities: Record<CapabilityId, Capability>;
  /** The handshake's own report, so the environment test need not re-probe. */
  acp: {
    ok: boolean;
    protocolVersion?: number;
    currentModel?: string;
    configOptionIds: string[];
    error?: string;
  };
}

export interface CapabilityCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CapabilityProbeInput {
  /**
   * The ACP-lane command this adapter spawns for a run, `acp` sub-command
   * included (`<base> acp [flags]`). The ACP group drives it verbatim; the
   * surface group strips everything from `acp` onward, because `--version`,
   * `config list` and `--help` are base-command probes.
   */
  acp: CapabilityCommand;
  /** Managed mode adds the worker-frame group; engine mode never probes it. */
  mode: "engine" | "managed";
  /** The supervisor's worker spawn spec (managed only). */
  worker?: CapabilityCommand;
  /** The build's version string, when the caller already probed it. */
  version?: string | null;
  /** Persisted cache directory; omit for a process-local cache only. */
  cacheDir?: string | null;
  /**
   * Read the cache and never spawn. The run path uses this: a heartbeat must
   * not gain a probe process, so it only reports what `testEnvironment` has
   * already learned.
   */
  cacheOnly?: boolean;
  /** Test seam for the clock. */
  now?: () => number;
}

const PROCESS_TTL_MS = 5 * 60_000;
const PERSISTED_TTL_MS = 24 * 60 * 60_000;
const ACP_PROBE_TIMEOUT_MS = 20_000;
const SURFACE_PROBE_TIMEOUT_MS = 20_000;
const RPC_PROBE_TIMEOUT_MS = 15_000;
const CACHE_FILE = "capabilities.json";
const MAX_PERSISTED_ENTRIES = 8;

interface CachedCapabilities {
  at: number;
  value: Promise<CapabilitySet>;
}

/** Process cache: one probe per key even under concurrent callers. */
const cache = new Map<string, CachedCapabilities>();

/**
 * The persisted cache directory. Build capabilities are not agent state — the
 * key hashes the command, its args and the env — so one instance-wide file is
 * enough and lets the environment test and the first run share one probe.
 */
export function capabilityCacheDir(): string {
  return path.join(resolvePaperclipInstanceRootForAdapter(), "acp-engine", "capabilities");
}

/** Test seam: drop the process cache (the persisted file is per cacheDir). */
export function clearCapabilityCache(): void {
  cache.clear();
  clearCapabilityDiagnostics();
}

/**
 * Capability-set keys whose unknown row has already been reported. A probe that
 * cannot complete proves nothing about the build, so its note is emitted once
 * instead of being repeated on every run (which trains operators to ignore it).
 */
const emittedUnknown = new Map<string, Set<CapabilityId>>();

/**
 * Per worker epoch, the last state each managed surface was observed in. A
 * worker that first answered `Unknown command` and later serves the frame is
 * the one case that needs a correcting note; everything else is either a fact
 * about the build or a transient "could not look".
 */
const workerEpochs = new Map<string, Map<CapabilityId, { state: CapabilityState; withdrawn: boolean }>>();

/** Cap on retained diagnostic state; older epochs are evicted oldest-first. */
const DIAGNOSTIC_STATE_CAP = 256;

/** Test seam: forget which unknown rows and withdrawals were reported. */
export function clearCapabilityDiagnostics(): void {
  emittedUnknown.clear();
  workerEpochs.clear();
}

/** Keep the process-lifetime bookkeeping bounded on a long-lived host. */
function boundDiagnosticState(state: Map<string, unknown>): void {
  while (state.size > DIAGNOSTIC_STATE_CAP) {
    const oldest = state.keys().next().value;
    if (oldest === undefined) return;
    state.delete(oldest);
  }
}

export function capabilityCacheKey(input: CapabilityProbeInput): string {
  const env = Object.entries(input.acp.env ?? {})
    .filter(([, value]) => typeof value === "string")
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(JSON.stringify({
      command: input.acp.command,
      args: input.acp.args ?? [],
      env,
      mode: input.mode,
      worker: input.worker === undefined
        ? null
        : { command: input.worker.command, args: input.worker.args ?? [] },
    }))
    .digest("hex")
    .slice(0, 32);
}

function emptyCapability(source: string, state: CapabilityState, confidence: CapabilityConfidence, detail?: string, at?: string): Capability {
  return {
    state,
    confidence,
    source,
    observedAt: at ?? new Date().toISOString(),
    ...(detail !== undefined ? { detail } : {}),
  };
}

function stateOf(value: boolean | undefined, source: string, at: string, detail?: string): Capability {
  if (value === undefined) return emptyCapability(source, "unknown", "assumed", detail, at);
  return emptyCapability(source, value ? "yes" : "no", "observed", detail, at);
}

/** Bounded `execFile` probe: resolves stdout, never throws, never rejects. */
function runProbe(
  command: CapabilityCommand,
  extraArgs: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; stdout: string }>();
  try {
    execFile(
      command.command,
      [...(command.args ?? []), ...extraArgs],
      {
        timeout: timeoutMs,
        ...(command.env !== undefined ? { env: { ...process.env, ...command.env } } : {}),
      },
      (err, stdout) => resolve({ ok: err === null, stdout: String(stdout ?? "") }),
    );
  } catch {
    resolve({ ok: false, stdout: "" });
  }
  return promise;
}

/**
 * The verbs a help screen offers. omp renders a root `COMMANDS` block
 * (`omp --help`) where each row is two spaces, the verb, then its description;
 * a sub-command screen renders no such block and instead lists its verbs on the
 * `ACTION` line (`omp models --help`: `ACTION  ls (default) | find | refresh`).
 * Both layouts are read here.
 */
function parseHelpVerbs(stdout: string): Set<string> | null {
  const lines = stdout.split("\n");
  const verbs = new Set<string>();
  const start = lines.findIndex((line) => line.trim() === "COMMANDS");
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "") break;
      const match = /^\s{2}([a-z][\w-]*)\s{2,}\S/.exec(line);
      if (match) verbs.add(match[1]);
    }
  }
  if (verbs.size === 0) {
    for (const verb of parseActionVerbs(stdout)) verbs.add(verb);
  }
  return verbs.size > 0 ? verbs : null;
}

/** The `ACTION` line's values (`ls (default) | find | refresh`). */
function parseActionVerbs(stdout: string): Set<string> {
  const verbs = new Set<string>();
  for (const line of stdout.split("\n")) {
    const action = /^\s*ACTION\s{2,}(.+)$/i.exec(line);
    if (action === null) continue;
    for (const token of action[1].split(/[|,]/)) {
      const word = /^\s*<?([a-z][\w-]*)>?\s*(?:\([^)]*\))?\s*$/i.exec(token);
      if (word) verbs.add(word[1].toLowerCase());
    }
  }
  return verbs;
}

/** Sub-verbs from `<bin> <verb> --help`, in either help layout. */
function parseSubVerbs(stdout: string): Set<string> {
  const verbs = parseHelpVerbs(stdout) ?? new Set<string>();
  for (const verb of parseActionVerbs(stdout)) verbs.add(verb);
  return verbs;
}

/**
 * The settings key map from `config list --json`. Only the key set leaves this
 * function: values (credentials, provider URLs) are never read into a record.
 */
async function probeSettingsKeys(
  command: CapabilityCommand,
  at: string,
): Promise<Set<string> | { error: string }> {
  const { ok, stdout } = await runProbe(command, ["config", "list", "--json"], SURFACE_PROBE_TIMEOUT_MS);
  if (!ok) return { error: "`config list --json` did not succeed" };
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "`config list --json` did not return a key map" };
    }
    return new Set(Object.keys(parsed as Record<string, unknown>));
  } catch {
    return { error: "`config list --json` returned unparsable JSON" };
  }
}

/** The CLI verb sets: top-level verbs, plus the sub-verbs of `models`/`session`. */
async function probeCliVerbs(command: CapabilityCommand): Promise<{
  top: Set<string> | null;
  models: Set<string> | null;
  session: Set<string> | null;
}> {
  const help = await runProbe(command, ["--help"], SURFACE_PROBE_TIMEOUT_MS);
  const top = help.ok ? parseHelpVerbs(help.stdout) : null;
  const sub = async (verb: string): Promise<Set<string> | null> => {
    if (top === null || !top.has(verb)) return null;
    const out = await runProbe(command, [verb, "--help"], SURFACE_PROBE_TIMEOUT_MS);
    if (!out.ok) return null;
    const verbs = parseSubVerbs(out.stdout);
    return verbs.size > 0 ? verbs : null;
  };
  const models = await sub("models");
  const session = await sub("session");
  return { top, models, session };
}

interface ProbeChild {
  process: ChildProcess;
  write: (frame: Record<string, unknown>) => void;
}

/** Spawn the worker with the supervisor's exact spec, or null when it fails. */
function spawnProbe(worker: CapabilityCommand): ProbeChild | null {
  try {
    const child = spawn(worker.command, worker.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(worker.env !== undefined ? { env: { ...process.env, ...worker.env } } : {}),
    });
    child.stdin?.on("error", () => {});
    return {
      process: child,
      write: (frame) => {
        try { child.stdin?.write(`${JSON.stringify(frame)}\n`); } catch { /* probe only */ }
      },
    };
  } catch {
    return null;
  }
}

/**
 * The managed worker's requestable frames, over the same `--mode rpc` spawn the
 * supervisor uses. A frame answers `success` (present), `Unknown command: x`
 * (absent), or any other refusal — which still proves the command exists.
 *
 * The frames are asked only after a session is open: an omp worker without a
 * session is not the state a run probes from, and the session is opened in a
 * throwaway directory so the build probe never leaves a session in the
 * operator's (or an agent's) store.
 */
function probeRpcFrames(
  worker: CapabilityCommand,
  timeoutMs = RPC_PROBE_TIMEOUT_MS,
): Promise<Record<ProbedRpcFrame, CapabilityState>> {
  const results: Record<ProbedRpcFrame, CapabilityState> = {
    get_session_stats: "unknown", set_host_tools: "unknown", set_subagent_subscription: "unknown",
  };
  const child = spawnProbe(worker);
  if (child === null) return Promise.resolve(results);
  let sessionDir: string | null = null;
  let opening = false;
  const { promise, resolve } = Promise.withResolvers<Record<ProbedRpcFrame, CapabilityState>>();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.process.kill("SIGKILL");
    if (sessionDir !== null) void fs.rm(sessionDir, { recursive: true, force: true });
    resolve(results);
  };
  const timer = setTimeout(finish, timeoutMs);
  let framesSent = false;
  const askFrames = () => {
    if (framesSent) return;
    framesSent = true;
    child.write({ id: "probe-stats", type: "get_session_stats" });
    child.write({ id: "probe-tools", type: "set_host_tools", tools: [] });
    child.write({ id: "probe-subagents", type: "set_subagent_subscription", level: "off" });
  };
  // Frames are newline-delimited and can straddle a chunk boundary, so keep
  // the unterminated tail for the next chunk instead of dropping it.
  let pending = "";
  child.process.stdout?.on("data", (chunk: Buffer) => {
    const lines = (pending + chunk.toString()).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { continue; }
      if (typeof frame !== "object" || frame === null) continue;
      const record = frame as Record<string, unknown>;
      if (record.type === "ready") {
        if (opening || sessionDir !== null) continue;
        opening = true;
        void fs.mkdtemp(path.join(os.tmpdir(), "omp-cap-probe-")).then(
          (dir) => {
            if (settled) {
              void fs.rm(dir, { recursive: true, force: true });
              return;
            }
            sessionDir = dir;
            child.write({ id: "probe-session", type: "open_session", sessionDir: dir });
          },
          () => askFrames(),
        );
        continue;
      }
      if (record.type === "response" && record.command === "open_session") {
        askFrames();
        continue;
      }
      if (record.type !== "response" || typeof record.command !== "string") continue;
      const command = record.command;
      if (command !== "get_session_stats" && command !== "set_host_tools" && command !== "set_subagent_subscription") continue;
      const error = typeof record.error === "string" ? record.error : "";
      results[command] = record.success === true || !/Unknown command/i.test(error) ? "yes" : "no";
    }
    if (Object.values(results).every((state) => state !== "unknown")) finish();
  });
  child.process.on("close", finish);
  child.process.on("error", finish);
  return promise;
}

/** The base command: everything before the `acp` sub-command. */
function surfaceCommand(acp: CapabilityCommand): CapabilityCommand {
  const args = acp.args ?? [];
  const acpIdx = args.indexOf("acp");
  return {
    command: acp.command,
    ...(acpIdx >= 0 ? { args: args.slice(0, acpIdx) } : (args.length > 0 ? { args } : {})),
    ...(acp.env !== undefined ? { env: acp.env } : {}),
  };
}

function capabilityForConfigId(ids: string[], id: string, source: string, at: string): Capability {
  return stateOf(ids.includes(id), ids.length > 0 ? source : "initialize (no configOptions advertised)", at, ids.join(", "));
}

async function probeAcp(command: CapabilityCommand, at: string): Promise<CapabilitySet["acp"] & { capabilities: Record<string, Capability> }> {
  const probe: OmpAcpProbeResult = await probeOmpAcpSession(
    { command: command.command, args: command.args ?? [], ...(command.env !== undefined ? { env: command.env } : {}) },
    ACP_PROBE_TIMEOUT_MS,
  );
  const ids = probe.configOptionIds ?? [];
  const handshakeSource = "initialize.agentCapabilities.sessionCapabilities";
  // Without a completed handshake there is no config-option set to judge: an
  // empty list there is missing evidence, not a build without the ids.
  const configCapability = (id: string): Capability => probe.ok
    ? capabilityForConfigId(ids, id, "session/new configOptions", at)
    : stateOf(undefined, "session/new configOptions", at);
  return {
    ok: probe.ok,
    ...(probe.protocolVersion !== undefined ? { protocolVersion: probe.protocolVersion } : {}),
    ...(probe.currentModel !== undefined ? { currentModel: probe.currentModel } : {}),
    configOptionIds: ids,
    ...(probe.error !== undefined ? { error: probe.error } : {}),
    capabilities: {
      "acp.session/list": stateOf(probe.supportsSessionList, `${handshakeSource}.list`, at),
      "acp.session/fork": stateOf(probe.supportsSessionFork, `${handshakeSource}.fork`, at),
      "acp._session/steering": stateOf(probe.supportsSteering, "_meta.steering.supported / _session/steering probe", at),
      "acp._omp/extensions": stateOf(probe.supportsExtensions, "_omp/extensions probe", at),
      "acp.config.mode": configCapability("mode"),
      "acp.config.model": configCapability("model"),
      "acp.config.thinking": configCapability("thinking"),
    },
  };
}

/**
 * Probe the build once. Callers should use `loadCapabilities`, which caches.
 * Throws never: a probe that fails degrades to `unknown`. The groups run in
 * parallel — each has its own bound, so the worst case is the slowest group,
 * not their sum.
 */
export async function probeCapabilities(input: CapabilityProbeInput): Promise<CapabilitySet> {
  const at = new Date(input.now?.() ?? Date.now()).toISOString();
  const surface = surfaceCommand(input.acp);
  // The surface probes only make sense for a command that reports omp's own
  // surfaces; a wrapper prints its own help and its own settings map.
  const namedOmp = path.basename(surface.command) === "omp";
  const [acp, settings, cli] = await Promise.all([
    probeAcp(input.acp, at),
    namedOmp
      ? probeSettingsKeys(surface, at)
      : Promise.resolve({ error: "the command is not named `omp`, so its settings map is not omp's" }),
    namedOmp
      ? probeCliVerbs(surface)
      : Promise.resolve({ top: null, models: null, session: null }),
  ]);
  const capabilities: Record<string, Capability> = { ...acp.capabilities };
  for (const key of PROBED_SETTINGS_KEYS) {
    capabilities[`settings.${key}`] = settings instanceof Set
      ? stateOf(settings.has(key), "config list --json", at)
      : emptyCapability("config list --json", "unknown", "assumed", settings.error);
  }
  const verb = (set: Set<string> | null, id: string, what: string): Capability =>
    set === null
      ? emptyCapability("--help", "unknown", "assumed", `${what} help could not be read`)
      : stateOf(set.has(id), `${what} --help`, at);
  capabilities["cli.models.refresh"] = verb(cli.models, "refresh", "models");
  capabilities["cli.session.lease"] = verb(cli.session, "lease", "session");
  capabilities["cli.gc"] = verb(cli.top, "gc", "top-level");

  // Managed-only group: the worker connection the supervisor speaks. It must
  // never run for an engine-mode install, which has no worker and would then
  // be warned every run about frames it never uses.
  const workerProbe = input.mode === "managed" && input.worker !== undefined && namedOmp;
  const rpc: Record<ProbedRpcFrame, CapabilityState> = workerProbe
    ? await probeRpcFrames(input.worker as CapabilityCommand)
    : { get_session_stats: "unknown", set_host_tools: "unknown", set_subagent_subscription: "unknown" };
  const rpcSource = workerProbe ? "worker --mode rpc" : "not probed: no managed worker";
  for (const frame of PROBED_RPC_FRAMES) {
    capabilities[`rpc.${frame}`] = rpc[frame] === "unknown"
      ? emptyCapability(rpcSource, "unknown", "assumed")
      : emptyCapability(rpcSource, rpc[frame], "observed", undefined, at);
  }
  capabilities["rpc.session_settled"] = emptyCapability(
    "no request surface: observed on the first managed turn", "unknown", "assumed", undefined, at,
  );

  return {
    key: capabilityCacheKey(input),
    observedAt: at,
    version: input.version ?? null,
    mode: input.mode,
    surfaceProbed: namedOmp,
    capabilities: capabilities as Record<CapabilityId, Capability>,
    acp: {
      ok: acp.ok,
      ...(acp.protocolVersion !== undefined ? { protocolVersion: acp.protocolVersion } : {}),
      ...(acp.currentModel !== undefined ? { currentModel: acp.currentModel } : {}),
      configOptionIds: acp.configOptionIds,
      ...(acp.error !== undefined ? { error: acp.error } : {}),
    },
  };
}

interface PersistedCache {
  entries: Record<string, { at: number; set: CapabilitySet }>;
}

/**
 * A persisted entry is only reusable when it still has the shape this build
 * expects: the file outlives an adapter upgrade, and an entry written by a
 * version with different capability ids must be ignored (re-probed), not read
 * as if the ids were known.
 */
function isCapabilitySet(value: unknown): value is CapabilitySet {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string") return false;
  if (record.mode !== "engine" && record.mode !== "managed") return false;
  if (typeof record.surfaceProbed !== "boolean") return false;
  const capabilities = record.capabilities;
  if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) return false;
  for (const id of Object.keys(DEGRADATION)) {
    const entry = (capabilities as Record<string, unknown>)[id];
    if (entry === undefined) continue;
    if (typeof entry !== "object" || entry === null) return false;
    const state = (entry as { state?: unknown }).state;
    if (state !== "yes" && state !== "no" && state !== "unknown") return false;
  }
  const acp = record.acp;
  return typeof acp === "object" && acp !== null && typeof (acp as { ok?: unknown }).ok === "boolean";
}

async function readPersisted(cacheDir: string, key: string, now: number): Promise<CapabilitySet | null> {
  try {
    const raw = await fs.readFile(path.join(cacheDir, CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw) as PersistedCache;
    const entry = parsed.entries?.[key];
    if (!entry || typeof entry.at !== "number" || now - entry.at > PERSISTED_TTL_MS) return null;
    return isCapabilitySet(entry.set) ? entry.set : null;
  } catch {
    return null;
  }
}

async function writePersisted(cacheDir: string, set: CapabilitySet, now: number): Promise<void> {
  const file = path.join(cacheDir, CACHE_FILE);
  let entries: PersistedCache["entries"] = {};
  try {
    entries = (JSON.parse(await fs.readFile(file, "utf8")) as PersistedCache).entries ?? {};
  } catch { /* first write */ }
  entries[set.key] = { at: now, set };
  const trimmed = Object.fromEntries(
    Object.entries(entries).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_PERSISTED_ENTRIES),
  );
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ entries: trimmed }, null, 2), "utf8");
  } catch { /* a cache miss is not a run failure */ }
}

/**
 * A cached set is reusable only when the caller's known version agrees with the
 * one the probe recorded: an upgrade can change every surface while the
 * command and env stay identical, so the version is the invalidation trigger
 * (a caller that never learned the version accepts any cached entry).
 */
function matchesVersion(set: CapabilitySet, version: string | null | undefined): boolean {
  return version === null || version === undefined || set.version === null || set.version === version;
}

/**
 * The capability set for this build: process cache, then the persisted cache,
 * then a probe. Concurrent callers share one probe (single-flight). With
 * `cacheOnly` a cold cache returns null instead of spawning anything.
 */
export function loadCapabilities(input: CapabilityProbeInput & { cacheOnly: true }): Promise<CapabilitySet | null>;
export function loadCapabilities(input: CapabilityProbeInput): Promise<CapabilitySet>;
export async function loadCapabilities(input: CapabilityProbeInput): Promise<CapabilitySet | null> {
  const key = capabilityCacheKey(input);
  const now = input.now?.() ?? Date.now();
  const cached = cache.get(key);
  if (cached !== undefined && now - cached.at < PROCESS_TTL_MS) {
    const set = await cached.value;
    if (matchesVersion(set, input.version)) return set;
    cache.delete(key);
  }
  if (input.cacheOnly === true) {
    if (!input.cacheDir) return null;
    const persisted = await readPersisted(input.cacheDir, key, now);
    if (persisted === null || !matchesVersion(persisted, input.version)) return null;
    // Adopt it into the process cache so later runs skip the file read.
    cache.set(key, { at: now, value: Promise.resolve(persisted) });
    return persisted;
  }
  const value = (async (): Promise<CapabilitySet> => {
    if (input.cacheDir) {
      const persisted = await readPersisted(input.cacheDir, key, now);
      if (persisted !== null && matchesVersion(persisted, input.version)) return persisted;
    }
    const set = await probeCapabilities(input);
    if (input.cacheDir) await writePersisted(input.cacheDir, set, now);
    return set;
  })();
  cache.set(key, { at: now, value });
  return value;
}

/**
 * One check per capability the build lacks (or that could not be verified),
 * naming the feature that will not work and what happens instead. Only `no` and
 * `unknown` produce a check; a present surface is reported by the caller's own
 * summary check.
 */
const DEGRADATION: Record<CapabilityId, {
  absent: { level: "warn" | "info"; code: string; message: string };
  unknown: { level: "warn" | "info"; code: string; message: string };
}> = {
  "acp.session/list": {
    absent: {
      level: "warn",
      code: "omp_session_list_unsupported",
      message: "this omp build does not advertise ACP session/list; the session snapshot work product will be skipped rather than widened to a host-wide listing",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "the ACP handshake could not report session/list, so the session snapshot work product cannot be promised",
    },
  },
  "acp.session/fork": {
    absent: {
      level: "warn",
      code: "omp_capability_missing_session_fork",
      message: "this omp build advertises no ACP session/fork; a sessionForkSourceId run fails to fork and continues on a fresh session",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "the ACP handshake could not report session/fork, so a fork directive cannot be promised",
    },
  },
  "acp._session/steering": {
    absent: {
      level: "info",
      code: "omp_capability_missing_steering",
      message: "this omp build has no `_session/steering` method; ACP-lane mid-turn steering is unavailable on it (the managed lane's steer/follow-up frames are unaffected)",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "the `_session/steering` method could not be confirmed; ACP-lane mid-turn steering cannot be promised",
    },
  },
  "acp._omp/extensions": {
    absent: {
      level: "warn",
      code: "omp_capability_missing_extensions",
      message: "this omp build cannot list loaded extensions; governance stays 'armed but unverified' (the extension file is still checked and the run fails closed if it is unreadable)",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "the extension inventory could not be probed; governance stays 'armed but unverified'",
    },
  },
  "acp.config.mode": {
    absent: {
      level: "warn",
      code: "omp_config_option_mode_missing",
      message: "the ACP handshake advertised no `mode` config option, so omp's own mode selection is inert for this agent",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "the config-option id set could not be read, so model/mode/thinking selection cannot be verified",
    },
  },
  "acp.config.model": {
    absent: {
      level: "warn",
      code: "omp_config_option_model_missing",
      message: "the ACP handshake advertised no `model` config option, so the adapter cannot report the active model and model selection may be inert",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "the config-option id set could not be read, so model selection cannot be verified",
    },
  },
  "acp.config.thinking": {
    absent: {
      level: "warn",
      code: "omp_config_option_thinking_missing",
      message: "the ACP handshake advertised no `thinking` config option; the thinking level reaches omp only through its settings overlay, not as a live session option",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "the config-option id set could not be read, so the thinking level's delivery cannot be verified",
    },
  },
  "settings.session.maxCost": {
    absent: {
      level: "warn",
      code: "omp_settings_max_cost_missing",
      message: "`session.maxCost` is not a setting on this omp build; the governance budget hard stop is absent and only the bridge's soft per-call cap applies",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "the omp settings key map could not be read, so the budget hard stop cannot be verified",
    },
  },
  "settings.tools.restrictedFolders": {
    absent: {
      level: "warn",
      code: "omp_settings_restricted_folders_missing",
      message: "`tools.restrictedFolders` is not a setting on this omp build; a folder fence in the governance policy cannot be enforced",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "the omp settings key map could not be read, so the folder fence cannot be verified",
    },
  },
  "settings.defaultThinkingLevel": {
    absent: {
      level: "warn",
      code: "omp_settings_default_thinking_missing",
      message: "`defaultThinkingLevel` is not a setting on this omp build; the thinking-level overlay is inert and the session keeps whatever level omp resolves",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "the omp settings key map could not be read, so the thinking overlay cannot be verified",
    },
  },
  "cli.models.refresh": {
    absent: {
      level: "warn",
      code: "omp_cli_models_refresh_missing",
      message: "this omp build has no `models refresh` verb; model discovery degrades to the cached catalog",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "`models refresh` could not be probed; model discovery falls back to the cached catalog",
    },
  },
  "cli.session.lease": {
    absent: {
      level: "info",
      code: "omp_cli_session_lease_missing",
      message: "this omp build has no `session lease` verb; the supervisor's per-session lease remains the only one-run-per-session guard (unchanged)",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "`session lease` could not be probed; the supervisor's lease is unaffected",
    },
  },
  "cli.gc": {
    absent: {
      level: "info",
      code: "omp_cli_gc_missing",
      message: "this omp build has no `gc` verb; operator cleanup of omp state has no supported command on it",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "`gc` could not be probed; operator cleanup is unaffected by this adapter",
    },
  },
  "rpc.session_settled": {
    absent: {
      level: "info",
      code: "omp_rpc_session_settled_missing",
      message: "the managed worker never reported `session_settled`; settlement is inferred from `prompt_result.sessionSettled`",
    },
    unknown: {
      level: "info",
      code: "omp_rpc_session_settled_unprobed",
      message: "`session_settled` has no request surface; the supervisor treats `prompt_result.sessionSettled` as the settlement signal",
    },
  },
  "rpc.get_session_stats": {
    absent: {
      level: "warn",
      code: "omp_rpc_session_stats_missing",
      message: "the managed worker cannot answer `get_session_stats`; a managed run reports no usage receipt",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "`get_session_stats` could not be probed on the worker; the managed run's usage receipt cannot be promised",
    },
  },
  "rpc.set_host_tools": {
    absent: {
      level: "warn",
      code: "omp_rpc_host_tools_missing",
      message: "the managed worker cannot receive host tools; Paperclip's connection tools never reach the agent on this build",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "`set_host_tools` could not be probed on the worker; connection-tool delivery cannot be promised",
    },
  },
  "rpc.set_subagent_subscription": {
    absent: {
      level: "warn",
      code: "omp_rpc_subagent_subscription_missing",
      message: "the managed worker has no subagent subscription; subagentObservability stays off and the run reports no subagent events",
    },
    unknown: {
      level: "info",
      code: "omp_capability_unknown",
      message: "`set_subagent_subscription` could not be probed on the worker; subagent observability cannot be promised",
    },
  },
};

/** Checks for every surface this build lacks or that could not be verified. */
export function capabilityChecks(set: CapabilitySet): AdapterEnvironmentCheck[] {
  const checks: AdapterEnvironmentCheck[] = [];
  for (const [id, capability] of Object.entries(set.capabilities) as Array<[CapabilityId, Capability]>) {
    // A row this adapter no longer knows (a cache written by another version)
    // is ignored rather than indexed into the table.
    if (!Object.hasOwn(DEGRADATION, id)) continue;
    // The worker-frame group is a managed-lane surface. An engine-only install
    // never probes it, so reporting "unknown" here would warn every engine
    // deployment about capabilities it does not use.
    if (id.startsWith("rpc.") && set.mode !== "managed") continue;
    // A wrapper's settings/help are its own: "not applicable", not "missing".
    if (!set.surfaceProbed && (id.startsWith("settings.") || id.startsWith("cli."))) continue;
    // A failed handshake already says why nothing ACP-shaped could be read;
    // reporting each surface as unknown on top of that is seven echoes of one
    // error.
    if (!set.acp.ok && id.startsWith("acp.")) continue;
    if (capability.state === "yes") continue;
    const row = capability.state === "no" ? DEGRADATION[id].absent : DEGRADATION[id].unknown;
    checks.push({
      level: row.level,
      code: row.code,
      message: row.message,
      detail: `capability ${id}: ${capability.state} (${capability.confidence}; ${capability.source})`
        + (capability.detail ? ` — ${capability.detail}` : ""),
    });
  }
  return checks;
}

/**
 * The capabilities a run actually leans on, named per this run's config. The
 * ACP-lane steering method is deliberately absent: this adapter's `steering`
 * config drives the managed lane's RPC steer/follow-up frames, so an absent
 * ACP steering method changes nothing for a run (the environment test still
 * reports it).
 */
export type CapabilityFeature =
  | "sessionSnapshot"
  | "sessionFork"
  | "governanceExtensions"
  | "thinkingLevel"
  | "budgetHardCap"
  | "folderFence"
  | "managedUsage"
  | "managedHostTools"
  | "managedSubagents";

const FEATURE_CAPABILITY: Record<CapabilityFeature, CapabilityId> = {
  sessionSnapshot: "acp.session/list",
  sessionFork: "acp.session/fork",
  governanceExtensions: "acp._omp/extensions",
  thinkingLevel: "acp.config.thinking",
  budgetHardCap: "settings.session.maxCost",
  folderFence: "settings.tools.restrictedFolders",
  managedUsage: "rpc.get_session_stats",
  managedHostTools: "rpc.set_host_tools",
  managedSubagents: "rpc.set_subagent_subscription",
};

export interface CapabilityDiagnostic {
  level: "warn" | "info";
  code: string;
  message: string;
}

/**
 * The named diagnostics for THIS run: only the features it depends on, so a
 * default heartbeat on a healthy build logs nothing. An absent capability names
 * the feature and what happens instead; it never refuses the run.
 *
 * A `unknown` row is not evidence of a missing surface, so it is an `info` note
 * emitted once per capability set (the build did not answer, not "the feature
 * is gone"); an absent row keeps warning on every call.
 */
export function capabilityDiagnostics(
  set: CapabilitySet,
  features: readonly CapabilityFeature[],
): CapabilityDiagnostic[] {
  const diagnostics: CapabilityDiagnostic[] = [];
  for (const feature of new Set(features)) {
    const id = FEATURE_CAPABILITY[feature];
    const capability = set.capabilities[id];
    if (capability === undefined) continue;
    // A wrapper's settings are not omp's, so a fence/budget claim cannot be
    // made either way; the environment test reports the version as unverified.
    if (!set.surfaceProbed && (feature === "budgetHardCap" || feature === "folderFence")) continue;
    if (capability.state === "yes") continue;
    const row = capability.state === "no" ? DEGRADATION[id].absent : DEGRADATION[id].unknown;
    if (capability.state === "unknown") {
      if (!emittedUnknown.has(set.key)) boundDiagnosticState(emittedUnknown);
      const seen = emittedUnknown.get(set.key) ?? new Set<CapabilityId>();
      emittedUnknown.set(set.key, seen);
      if (seen.has(id)) continue;
      seen.add(id);
    }
    diagnostics.push({ level: row.level, code: row.code, message: row.message });
  }
  return diagnostics;
}

/** The live worker's answer for each managed surface. */
export interface WorkerCapabilityObservations {
  get_session_stats: CapabilityState;
  set_host_tools: CapabilityState;
  set_subagent_subscription: CapabilityState;
}

const FEATURE_LABEL: Partial<Record<CapabilityFeature, string>> = {
  managedUsage: "the managed usage receipt",
  managedHostTools: "connection-tool delivery",
  managedSubagents: "subagent observability",
};

const WORKER_FRAME_CAPABILITY: Record<ProbedRpcFrame, CapabilityId> = {
  get_session_stats: "rpc.get_session_stats",
  set_host_tools: "rpc.set_host_tools",
  set_subagent_subscription: "rpc.set_subagent_subscription",
};

const CAPABILITY_WORKER_FRAME = new Map<CapabilityId, ProbedRpcFrame>(
  Object.entries(WORKER_FRAME_CAPABILITY).map(([frame, id]) => [id, frame as ProbedRpcFrame]),
);

/**
 * Diagnostics for the managed surfaces observed on THIS worker, in its own
 * epoch (one worker process: argv + bridge + pid).
 *
 * - `unknown` (the frame did not answer in time) is an `info` note, once per
 *   epoch: a probe that cannot complete proves nothing.
 * - `no` (`Unknown command`) is a `warn`, repeated because the surface really
 *   is absent on this worker.
 * - A surface that warned and later answers `yes` gets one `info` withdrawal
 *   for that epoch, and no further warning is produced for it.
 */
export function workerCapabilityDiagnostics(
  observations: WorkerCapabilityObservations,
  features: readonly CapabilityFeature[],
  epoch: string,
): CapabilityDiagnostic[] {
  if (!workerEpochs.has(epoch)) boundDiagnosticState(workerEpochs);
  const observed = workerEpochs.get(epoch) ?? new Map<CapabilityId, { state: CapabilityState; withdrawn: boolean }>();
  workerEpochs.set(epoch, observed);
  const diagnostics: CapabilityDiagnostic[] = [];
  for (const feature of new Set(features)) {
    const id = FEATURE_CAPABILITY[feature];
    const frame = CAPABILITY_WORKER_FRAME.get(id);
    if (frame === undefined) continue;
    const state = observations[frame];
    const previous = observed.get(id);
    if (state === "yes") {
      if (previous?.state === "no" && !previous.withdrawn) {
        diagnostics.push({
          level: "info",
          code: "omp_capability_observed",
          message: `\`${frame}\` answered on this worker; the earlier warning that ${FEATURE_LABEL[feature] ?? feature} was unavailable is withdrawn for this worker`,
        });
      }
      observed.set(id, { state: "yes", withdrawn: true });
      continue;
    }
    if (state === "unknown") {
      // The note is emitted once per epoch. A surface that was absent and is
      // now unprobed is not re-noted: the absence warning already stands.
      if (previous === undefined) {
        diagnostics.push({
          level: DEGRADATION[id].unknown.level,
          code: DEGRADATION[id].unknown.code,
          message: DEGRADATION[id].unknown.message,
        });
      }
      observed.set(id, { state: "unknown", withdrawn: previous?.withdrawn ?? false });
      continue;
    }
    diagnostics.push({
      level: DEGRADATION[id].absent.level,
      code: DEGRADATION[id].absent.code,
      message: DEGRADATION[id].absent.message,
    });
    observed.set(id, { state: "no", withdrawn: false });
  }
  return diagnostics;
}
