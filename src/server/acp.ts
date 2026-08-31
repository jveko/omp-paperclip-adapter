import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  readPaperclipSkillMarkdown,
  readPaperclipSkillSyncPreference,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import type {
  AcpxEngineBillingIdentity,
  AcpxEngineExecutorOptions,
} from "@paperclipai/adapter-utils/acpx-engine/execute";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "@paperclipai/adapter-utils/acpx-engine/constants";
import {
  isFreeCost,
  listOmpModels,
  normalizeOmpModelId,
  type OmpModelCost,
} from "./models.js";
import { buildSkillsInstructions, skillsDir, type SkillMarkdownSource } from "./skills.js";
import { readRetryConfig, runWithFreshSessionRetry, withRetryChain } from "./retry.js";
import { materializeFailoverOverlay } from "./failover-config.js";
import { ompEnv } from "./omp-env.js";
import { forkOmpSession, queryOmpSessions } from "./session-intel.js";
import {
  bumpRunCounter, consumeToken, loadState, rotateIfTripped, saveState,
  sessionIntelDir, snapshotDigest,
} from "./session-state.js";
import {
  buildUsageWorkProduct, estimateCostPerHeartbeat, fetchBrokerUsage, usageDigest,
} from "./usage-report.js";
import {
  buildSessionSnapshotWorkProduct, postWorkProduct,
  readSessionIntelConfig, resolveRunDirective, validateCredentialMode,
} from "./session-directives.js";

export const DEFAULT_OMP_COMMAND = "omp";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const packageRootDir = path.resolve(moduleDir, "../..");

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

export function resolveOmpAgentCommand(config: Record<string, unknown>): string {
  const explicit = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  if (explicit) return explicit;
  const command = firstNonEmptyString(config.command) ?? DEFAULT_OMP_COMMAND;
  return `${command} acp`;
}

/**
 * Free/zero-cost preview tiers need long horizons (measured: >20 min for a
 * 45k-token context); priced models get the engine's default (no timeout,
 * sandbox 4h cap applies).
 */
export function deriveDefaultTimeoutSec(cost: OmpModelCost | null | undefined): number {
  if (!cost) return 0;
  return isFreeCost(cost) ? 1800 : 0;
}

/**
 * Build the ACP engine config for a run. `resolveModel` normalizes the raw
 * model ref (the raw value passes through when it returns null).
 * `resolveCost` receives the NORMALIZED model id and returns its cost card
 * (or null); it feeds timeout derivation when none is configured.
 */
export function buildOmpAcpConfig(
  config: Record<string, unknown>,
  resolveModel: (model: string) => string | null = () => null,
  resolveCost: (model: string) => OmpModelCost | null = () => null,
): Record<string, unknown> {
  const rawModel = firstNonEmptyString(config.model);
  const model = rawModel ? (resolveModel(rawModel) ?? rawModel) : undefined;
  const next: Record<string, unknown> = {
    ...config,
    agent: "custom",
    agentCommand: resolveOmpAgentCommand(config),
    mode: firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE,
    permissionMode:
      firstNonEmptyString(config.permissionMode, config.acpPermissionMode) ??
      DEFAULT_ACP_ENGINE_PERMISSION_MODE,
    nonInteractivePermissions:
      firstNonEmptyString(config.nonInteractivePermissions, config.acpNonInteractivePermissions) ??
      DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
    warmHandleIdleMs:
      config.warmHandleIdleMs ?? config.acpWarmHandleIdleMs ?? DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
  };
  if (model) next.model = model;
  // timeoutSec is numeric — firstNonEmptyString would drop it. Coerce once:
  // accept finite numbers AND numeric strings (honoring an explicit 0, which
  // means "no timeout"); anything else falls through to cost-based derivation.
  const rawTimeout = config.timeoutSec ?? config.acpTimeoutSec;
  const timeoutValue =
    typeof rawTimeout === "number"
      ? rawTimeout
      : typeof rawTimeout === "string" && rawTimeout.trim() !== ""
        ? Number(rawTimeout)
        : NaN;
  const timeoutSec = Number.isFinite(timeoutValue) ? timeoutValue : undefined;
  if (timeoutSec === undefined && model) {
    next.timeoutSec = deriveDefaultTimeoutSec(resolveCost(model));
  } else if (timeoutSec !== undefined) {
    next.timeoutSec = timeoutSec;
  }
  const stateDir = firstNonEmptyString(config.stateDir, config.acpStateDir);
  if (stateDir) next.stateDir = stateDir;
  // omp exposes `thinking` via its own ACP session option; the shared engine's
  // effort control-key wiring is unverified for custom agents, so never send it.
  delete next.effort;
  delete next.thinkingEffort;
  // credentialMode is the single switch that decides whether the auth broker is
  // in play: binding broker env without selecting broker mode does NOT silently
  // enable broker for the run child. The run's ACP child (this config.env) must
  // agree with the ompEnv-gated side channels, which forward broker env only in
  // broker mode — so strip it here (on a copy, never mutating ctx.config.env).
  if (config.credentialMode !== "broker") {
    const srcEnv = (config.env ?? {}) as Record<string, unknown>;
    if (typeof srcEnv.OMP_AUTH_BROKER_URL === "string" || typeof srcEnv.OMP_AUTH_BROKER_TOKEN === "string") {
      const env = { ...srcEnv };
      delete env.OMP_AUTH_BROKER_URL;
      delete env.OMP_AUTH_BROKER_TOKEN;
      next.env = env;
    }
  }
  return next;
}

export function parseOmpVersion(output: string): { major: number; minor: number; patch: number } | null {
  const m = output.match(/v?(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function resolveOmpBillingIdentity(ctx: Pick<AdapterExecutionContext, "config">): AcpxEngineBillingIdentity {
  const env = (ctx.config.env ?? {}) as Record<string, unknown>;
  const raw = String(env.OMP_PAPERCLIP_BILLING_TYPE ?? process.env.OMP_PAPERCLIP_BILLING_TYPE ?? "")
    .trim()
    .toLowerCase();
  return {
    provider: "oh-my-pi",
    biller: null,
    billingType: raw === "api" ? "api" : raw === "subscription" ? "subscription" : "api",
  };
}

export interface OmpAcpProbeResult {
  ok: boolean;
  protocolVersion?: number;
  currentModel?: string;
  error?: string;
}

export interface AcpFrameRequest {
  method: string;
  params?: Record<string, unknown>;
}
export interface AcpFrameResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}
export interface AcpDriveResult {
  ok: boolean;
  initializeInfo?: Record<string, unknown>;
  responses: AcpFrameResponse[];
  error?: string;
  /** Received protocolVersion when the initialize handshake failed on a mismatch. */
  protocolVersion?: number;
}

/**
 * Spawn `omp acp`, complete the initialize handshake, then issue `requests`
 * sequentially and collect their responses. Read-only request sets must omit
 * `session/new`: omp's extMethod handlers read persisted state from disk and
 * need no session, while `session/new` always persists a new session record
 * and would pollute session listings. Kills the child on completion, error,
 * or timeout; never throws.
 */
export function driveAcpSession(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  requests: AcpFrameRequest[],
  timeoutMs = 10_000,
): Promise<AcpDriveResult> {
  return new Promise<AcpDriveResult>((resolve) => {
    const child = spawn(omp.command, omp.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: omp.env ? { ...process.env, ...omp.env } : undefined,
    });
    child.stdin.on("error", () => {});
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    const suffix = () => {
      const trimmed = stderrTail.trim();
      return trimmed ? `: ${trimmed}` : "";
    };
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const responses: AcpFrameResponse[] = [];
    let initializeInfo: Record<string, unknown> | undefined;
    // nextId 1 is initialize; requests take 2..n in order.
    let nextIndex = 0;
    const finish = (r: AcpDriveResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(r);
    };
    timer = setTimeout(
      () => finish({ ok: false, responses, error: `ACP drive timed out after ${timeoutMs}ms${suffix()}` }),
      timeoutMs,
    );
    child.on("error", (err) => {
      finish({ ok: false, responses, error: String(err) });
    });
    child.on("close", () => {
      finish({ ok: false, responses, error: `ACP child exited before the drive completed${suffix()}` });
    });
    const sendNext = () => {
      if (nextIndex >= requests.length) {
        finish({ ok: true, initializeInfo, responses });
        return;
      }
      const req = requests[nextIndex];
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: nextIndex + 2, method: req.method, params: req.params ?? {} }) + "\n",
      );
    };
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { return; }
      if (typeof msg !== "object" || msg === null || !("id" in msg)) return;
      const id = Number((msg as { id: unknown }).id);
      const err = (msg as { error?: unknown }).error;
      const result = (msg as { result?: unknown }).result;
      if (id === 1) {
        if (typeof err === "object" && err !== null) {
          const detail = "message" in (err as object) ? String((err as { message: unknown }).message) : JSON.stringify(err);
          finish({ ok: false, responses, error: `ACP initialize error: ${detail}` });
          return;
        }
        if (typeof result !== "object" || result === null || Number((result as { protocolVersion?: unknown }).protocolVersion) !== 1) {
          const received = Number((result as { protocolVersion?: unknown } | null)?.protocolVersion);
          finish({
            ok: false,
            responses,
            protocolVersion: Number.isFinite(received) ? received : undefined,
            error: `unexpected protocolVersion ${Number.isFinite(received) ? received : "missing"}`,
          });
          return;
        }
        initializeInfo = result as Record<string, unknown>;
        sendNext();
        return;
      }
      const expectedId = nextIndex + 2;
      if (id !== expectedId) return;
      if (typeof err === "object" && err !== null) {
        responses.push({
          id,
          error: {
            code: Number((err as { code?: unknown }).code ?? 0),
            message: "message" in (err as object) ? String((err as { message: unknown }).message) : JSON.stringify(err),
          },
        });
      } else if (typeof result === "object" && result !== null) {
        responses.push({ id, result: result as Record<string, unknown> });
      } else {
        responses.push({ id });
      }
      nextIndex += 1;
      sendNext();
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n",
    );
  });
}

export function probeOmpAcpSession(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  timeoutMs = 10_000,
): Promise<OmpAcpProbeResult> {
  return driveAcpSession(omp, [
    { method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } },
  ], timeoutMs).then((drive): OmpAcpProbeResult => {
    if (!drive.ok) return { ok: false, protocolVersion: drive.protocolVersion, error: drive.error };
    const response = drive.responses[0];
    if (response?.error) return { ok: false, error: `ACP error on request id ${response.id}: ${response.error.message}` };
    const options = Array.isArray(response?.result?.configOptions)
      ? (response.result?.configOptions as Array<Record<string, unknown>>)
      : [];
    const model = options.find((o) => o.id === "model") as { currentValue?: unknown } | undefined;
    return {
      ok: true,
      protocolVersion: 1,
      currentModel: typeof model?.currentValue === "string" ? model.currentValue : undefined,
    };
  });
}

/**
 * Materialize the ephemeral skills instructions file for a run.
 *
 * Reads the persisted Paperclip skill preference and merges each desired
 * skill's SKILL.md (resolved from the runtime skill entry's source directory
 * on disk; adapter-local skills fall back to the package-dir scan) with the
 * user's instructions file, if any. Returns null when no skill is desired or
 * none could be loaded — the caller then leaves instructionsFilePath alone.
 */
async function materializeSkillsInstructions(config: Record<string, unknown>): Promise<string | null> {
  const preference = readPaperclipSkillSyncPreference(config);
  if (preference.desiredSkills.length === 0) return null;
  const entries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  // Canonicalize runtime-name/slug references to keys first — an exact-key
  // lookup on the raw preference would silently drop name-based refs even
  // though the snapshot functions report them as configured.
  const desiredKeys = resolvePaperclipDesiredSkillNames(config, entries);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const skills: SkillMarkdownSource[] = [];
  for (const key of desiredKeys) {
    const entry = byKey.get(key);
    if (entry) {
      // entry.source is the skill directory on disk (Paperclip's runtime
      // mount); read its SKILL.md directly.
      const content = await fs
        .readFile(path.join(entry.source, "SKILL.md"), "utf8")
        .catch(() => null);
      if (content) {
        skills.push({ key, markdown: content });
        continue;
      }
    }
    // Adapter-local skills: scan the adapter package's own skills dir.
    const fallback = await readPaperclipSkillMarkdown(moduleDir, key);
    if (fallback) skills.push({ key, markdown: fallback });
  }
  if (skills.length === 0) return null;
  return buildSkillsInstructions(
    skills,
    firstNonEmptyString(config.instructionsFilePath) ?? null,
    skillsDir,
  );
}

type OmpAcpExecutorOptions = Omit<
  AcpxEngineExecutorOptions,
  "adapterType" | "moduleDir" | "packageRootDir"
>;
type OmpAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

export function createOmpAcpExecutor(options: OmpAcpExecutorOptions = {}): OmpAcpExecutor {
  let executor: OmpAcpExecutor | null = null;
  return async (ctx) => {
    // Fail closed: broker credentialMode demands a resolved broker url+token.
    // Return before any engine work so a misconfigured agent never runs a
    // half-configured session.
    const credErr = validateCredentialMode(ctx.config);
    if (credErr) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "omp_config_error", errorMessage: credErr };
    }
    if (!executor) {
      // Lazy by design: the acpx engine (and its transitive CLI deps) must not
      // load until a run actually executes, so probe-only imports stay cheap.
      const { createAcpxEngineExecutor } = await import(
        "@paperclipai/adapter-utils/acpx-engine/execute"
      );
      executor = createAcpxEngineExecutor({
        ...options,
        adapterType: "omp_local",
        moduleDir,
        packageRootDir,
        resolveBillingIdentity: options.resolveBillingIdentity ?? resolveOmpBillingIdentity,
      });
    }
    // Resolvers backed by the cached `omp models ls` list (5-min TTL inside
    // models.ts, keyed by command+env so different agents' credentials never
    // share a catalog). Built on first actual run, inside this memoized
    // closure, so probe-only paths never spawn `omp models`. The fetch is
    // skipped when no model is configured — a broken/missing `omp` would
    // otherwise add up to 20s of uncached failure latency per run.
    const failoverOverlay = await materializeFailoverOverlay(
      ctx.config,
      sessionIntelDir(ctx.agent.companyId, ctx.agent.id),
    );
    const failoverOverlayPath =
      failoverOverlay.status === "ok" ? failoverOverlay.path : null;
    if (failoverOverlay.status === "error") {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: `omp failover overlay write failed: ${failoverOverlay.error}; continuing without PI_CONFIG_FILES`,
      });
    }
    const sideChannelEnv = ompEnv({ config: ctx.config, overlayPath: failoverOverlayPath });
    const ompTokens = resolveOmpAgentCommand(ctx.config).split(/\s+/);
    // The resolved agent command may be multi-token (e.g. `node fake-acp.mjs`
    // or `mise x omp -- acp`). Strip a trailing `acp` so the catalog runs the
    // wrapper with `models ls --json` appended, exactly like the engine's own
    // agentCommand.
    const base = ompTokens[ompTokens.length - 1] === "acp" ? ompTokens.slice(0, -1) : ompTokens;
    const models = firstNonEmptyString(ctx.config.model)
      ? await listOmpModels({
          command: base[0],
          args: [...base.slice(1), "models", "ls", "--json"],
          env: sideChannelEnv,
        })
      : [];
    const resolveModel = (model: string): string | null => normalizeOmpModelId(model, models);
    const resolveCost = (model: string): OmpModelCost | null =>
      models.find((m) => m.id === model)?.cost ?? null;
    const config = buildOmpAcpConfig(ctx.config, resolveModel, resolveCost);
    // Fold the failover overlay into config BEFORE engineConfig is derived: the
    // fork branch rebuilds engineConfig as { ...config, warmHandleIdleMs: 50 },
    // so an overlay added only to engineConfig would be silently dropped by the
    // fork spread — PI_CONFIG_FILES must ride on `config` to survive it.
    if (failoverOverlayPath) {
      const operatorPi =
        typeof (ctx.config.env as Record<string, unknown> | undefined)?.PI_CONFIG_FILES === "string"
          ? (ctx.config.env as Record<string, unknown>).PI_CONFIG_FILES as string
          : "";
      const mergedPi = [operatorPi, failoverOverlayPath].filter(Boolean).join(path.delimiter);
      if (mergedPi) config.env = { ...(config.env ?? {}), PI_CONFIG_FILES: mergedPi };
    }
    // Ephemeral skills: materialize the merged instructions file (skills +
    // user instructions) so the engine injects it into this run. The merged
    // file always carries the user's content when present, so the path is set
    // unconditionally whenever any skill is desired; null leaves any existing
    // instructionsFilePath untouched.
    const instructionsFile = await materializeSkillsInstructions(ctx.config);
    if (instructionsFile) config.instructionsFilePath = instructionsFile;
    // --- v0.4 session runtime: directives, fork resume, rotation, snapshot ---
    const intel = readSessionIntelConfig(ctx.config);
    const intelDir = sessionIntelDir(ctx.agent.companyId, ctx.agent.id);
    const intelState = await loadState(intelDir);
    const directive = resolveRunDirective(intel, intelState);
    const storedParams = (ctx.runtime.sessionParams ?? {}) as Record<string, unknown>;
    const sessionCwd = typeof storedParams.cwd === "string" && storedParams.cwd
      ? storedParams.cwd
      : process.cwd();
    // State writes must never fail a completed run: mirror the loadState
    // degrade + the other warn-and-continue degradation paths.
    const persistState = async (): Promise<void> => {
      try {
        await saveState(intelDir, intelState);
      } catch (err) {
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system", level: "warn",
          message: `omp session intel state save failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    let forkTokenUsed: string | null = null;
    let forkedSessionId: string | null = null;
    let freshTokenUsed: string | null = null;
    let forceFreshOverride = false;
    let engineConfig = config;

    if (directive.kind === "fork") {
      const ompTokens = resolveOmpAgentCommand(ctx.config).split(/\s+/);
      const fork = await forkOmpSession(
        { command: ompTokens[0], args: ompTokens.slice(1), env: sideChannelEnv },
        directive.forkSourceId,
        sessionCwd,
      );
      if (fork.ok) {
        forkTokenUsed = directive.forkToken;
        forkedSessionId = fork.sessionId;
        // warmHandleIdleMs: 50 makes this run's handle warm-savable (execute.js
        // warm-save requires warmIdleMs > 0) and runs cleanupIdleHandles before
        // the resume decision, so no stale handle can shadow the fork override.
        // The engine's DEFAULT for omp is 0 (handles close each turn), so under
        // default settings the cleanup is a no-op and warm-save enablement is
        // the load-bearing effect. Must stay > 0: idleMs <= 0 disables both.
        // Per-run only; non-fork runs keep the operator's configured value.
        engineConfig = { ...config, warmHandleIdleMs: 50 };
      } else {
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system", level: "warn",
          message: `omp fork directive failed: ${fork.error}`,
        });
      }
    } else if (directive.kind === "forceFresh") {
      freshTokenUsed = directive.token;
      forceFreshOverride = true;
    } else if (directive.kind === "rotate") {
      forceFreshOverride = true;
      intelState.pendingRotate = null; // applied this run
    }

    // Fork resume override: identity fields stay untouched (no env bust), so
    // isCompatibleSession passes and the engine resumes the forked id.
    // Force-fresh and rotation use the same override shape but CLEAR
    // sessionParams instead: an empty sessionParams makes isCompatibleSession
    // fail (configFingerprint "" !== the session's fingerprint), so the engine
    // issues session/new this run. This is fingerprint-clean by design — the
    // directive session's env is never touched, so the freshly created
    // session's configFingerprint equals the normal run fingerprint and is
    // RESUMABLE by subsequent markerless runs. An env marker (OMP_PAPERCLIP_FRESH)
    // would poison the fingerprint and abandon the directive run's session —
    // the same latent trap the retry path has (OMP_PAPERCLIP_RETRY), which we
    // are NOT touching.
    const runtimeOverride = forkedSessionId
      ? { ...ctx.runtime, sessionParams: { ...storedParams, acpSessionId: forkedSessionId } }
      : forceFreshOverride
        ? { ...ctx.runtime, sessionParams: {} }
        : null;

    const { result, chain } = await runWithFreshSessionRetry(
      (runCtx) => {
        const merged = { ...ctx, ...runCtx } as typeof ctx;
        if (runtimeOverride) merged.runtime = runtimeOverride;
        return executor!(merged);
      },
      // Fork runs MUST bypass the fresh-session retry loop: retrying would
      // bust the fingerprint via OMP_PAPERCLIP_RETRY, causing the engine to
      // start a blank session (isCompatibleSession fails) instead of resuming
      // the forked session — orphaning it. Disabling retries keeps the fork
      // resume path intact: a single attempt either succeeds normally, or
      // fails terminally with the token still armed (next run re-forks from
      // source). omp's own TurnRecovery still handles transient provider
      // failures within that single attempt.
      directive.kind === "fork" ? { enabled: false, freshRetries: 0 } : readRetryConfig(ctx.config),
      engineConfig,
    );
    const resultParams = (result.sessionParams ?? {}) as Record<string, unknown>;
    const usedSessionId = typeof resultParams.acpSessionId === "string" ? resultParams.acpSessionId : null;
    const nowIso = new Date().toISOString();

    // Post-run bookkeeping: consumption (verified via the round-tripped
    // acpSessionId), rotation counters, then snapshot emission.
    if (forkTokenUsed) {
      if (usedSessionId && usedSessionId === forkedSessionId) {
        intelState.forkConsumed = consumeToken(intelState.forkConsumed, forkTokenUsed);
        // A successfully resumed fork is a fresh session under the same
        // sessionKey: a previously-tripped rotation must not discard it, and
        // the run count starts over.
        intelState.pendingRotate = null;
        intelState.runCounters = {};
      } else {
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system", level: "warn",
          message: "omp fork directive did not take effect; it stays armed for the next run",
        });
      }
    }
    // Consumption semantics kept: force-fresh is consumed only when the
    // round-tripped id differs from the stored one (a fresh session was made).
    const freshSessionCreated = !!usedSessionId && usedSessionId !== storedParams.acpSessionId;
    if (freshTokenUsed && freshSessionCreated) {
      intelState.forceFreshConsumed = consumeToken(intelState.forceFreshConsumed, freshTokenUsed);
    }
    if ((freshTokenUsed || directive.kind === "rotate") && freshSessionCreated) {
      // The fresh session does NOT reset the fingerprint, so it must not reuse
      // the old counter: start the run count over and clear any armed rotation.
      intelState.runCounters = {};
      intelState.pendingRotate = null;
    }
    if (typeof resultParams.sessionKey === "string") {
      bumpRunCounter(intelState, resultParams.sessionKey, nowIso);
      if (rotateIfTripped(intelState, resultParams.sessionKey,
        { maxRuns: intel.maxRuns, maxAgeHours: intel.maxAgeHours }, nowIso)) {
        intelState.lastRotation = {
          reason: intelState.pendingRotate?.reason ?? "manual",
          at: nowIso,
          sessionKey: resultParams.sessionKey,
        };
      }
    }

    const runUsage = result.usage;
    if (runUsage && result.usageBasis !== "session_cumulative"
      && typeof runUsage.inputTokens === "number" && typeof runUsage.outputTokens === "number") {
      intelState.recentRuns = [...intelState.recentRuns, {
        at: nowIso,
        inputTokens: runUsage.inputTokens,
        outputTokens: runUsage.outputTokens,
        cachedInputTokens: typeof runUsage.cachedInputTokens === "number" ? runUsage.cachedInputTokens : 0,
      }].slice(-20);
    }
    await persistState();

    const issueId = typeof ctx.context.taskId === "string" ? ctx.context.taskId : "";
    if (intel.usageReport && issueId) {
      const cfgEnv = (ctx.config.env ?? {}) as Record<string, unknown>;
      const brokerUrl = typeof cfgEnv.OMP_AUTH_BROKER_URL === "string" ? cfgEnv.OMP_AUTH_BROKER_URL : "";
      const brokerTok = typeof cfgEnv.OMP_AUTH_BROKER_TOKEN === "string" ? cfgEnv.OMP_AUTH_BROKER_TOKEN : "";
      const usageRes = ctx.config.credentialMode === "broker" && brokerUrl && brokerTok
        ? await fetchBrokerUsage({ url: brokerUrl, token: brokerTok })
        : { ok: true as const, reports: [] as unknown[] };
      const rawModel = firstNonEmptyString(ctx.config.model);
      const cost = estimateCostPerHeartbeat(intelState.recentRuns, resolveCost(rawModel ? (resolveModel(rawModel) ?? rawModel) : ""));
      const reports = usageRes.ok ? usageRes.reports : [];
      if (!usageRes.ok) {
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system", level: "warn",
          message: `omp broker usage unavailable: ${usageRes.error}; emitting cost-only report`,
        });
      }
      const digest = usageDigest(reports, cost);
      if (digest !== intelState.lastUsageDigest) {
        const posted = await postWorkProduct({ authToken: ctx.authToken, issueId },
          buildUsageWorkProduct({ reports, costPerHeartbeatUsd: cost, runId: ctx.runId, capturedAt: nowIso, brokerMode: ctx.config.credentialMode === "broker" }));
        if (posted.ok) {
          intelState.lastUsageDigest = digest;
          await persistState();
        } else {
          await ctx.onEvent?.({
            eventType: "run.system", stream: "system", level: "warn",
            message: `omp usage report emission failed: ${posted.error}`,
          });
        }
      }
    }
    if (intel.browser && issueId) {
      const ompTokens = resolveOmpAgentCommand(ctx.config).split(/\s+/);
      const query = await queryOmpSessions(
        { command: ompTokens[0], args: ompTokens.slice(1), env: sideChannelEnv },
        { cwd: sessionCwd },
      );
      if (query.ok) {
        const digest = snapshotDigest({
          projects: query.snapshot.projects,
          ids: query.snapshot.sessions.map((s) => [s.sessionId, s.updatedAt]),
          current: usedSessionId,
        });
        if (digest !== intelState.lastSnapshotDigest) {
          const posted = await postWorkProduct(
            { authToken: ctx.authToken, issueId },
            buildSessionSnapshotWorkProduct(query.snapshot, {
              currentSessionId: usedSessionId, runId: ctx.runId, capturedAt: nowIso,
            }),
          );
          if (posted.ok) {
            intelState.lastSnapshotDigest = digest;
            await persistState();
          } else {
            await ctx.onEvent?.({
              eventType: "run.system", stream: "system", level: "warn",
              message: `omp session snapshot emission failed: ${posted.error}`,
            });
          }
        }
      } else {
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system", level: "warn",
          message: `omp session snapshot query failed: ${query.error}`,
        });
      }
    }
    // Surface session-runtime events in resultJson -> heartbeat_runs (the
    // authoritative evidence table; see spec 3.8).
    const sessionRuntime: Record<string, unknown> = {};
    if (forkTokenUsed) {
      sessionRuntime.fork = {
        requested: forkedSessionId,
        applied: usedSessionId === forkedSessionId,
        activeSessionId: usedSessionId,
      };
    }
    if (intelState.lastRotation) sessionRuntime.lastRotation = intelState.lastRotation;
    // MCP servers forwarded to session/new are http-only (AdapterRuntimeMcpAccess has no
    // stdio/command discriminator), so a 0 count means "no http MCP servers", not "no MCP".
    const mcpServerCount = ctx.runtimeMcp?.getServers?.().length ?? 0;
    if (mcpServerCount > 0) sessionRuntime.mcpServerCount = mcpServerCount;
    const resultJson = Object.keys(sessionRuntime).length > 0
      ? { ...(result.resultJson ?? {}), sessionRuntime }
      : result.resultJson;
    return withRetryChain(resultJson ? { ...result, resultJson } : result, chain);
  };
}
