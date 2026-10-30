import { promises as fs } from "node:fs";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  readPaperclipSkillMarkdown,
  readPaperclipSkillSyncPreference,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import {
  exactOmpModelId, listOmpModels, normalizeOmpModelId, type OmpModelCost, type OmpModelInfo,
} from "../models.js";
import { buildSkillsInstructions, skillsDir, type SkillMarkdownSource } from "../skills.js";
import { readRetryConfig, type RetryConfig } from "../retry.js";
import {
  materializeFailoverOverlay, providerQualifiedSelectors, validateProviderQualifiedSelectors,
  validateRetryFallbackConfig,
} from "../failover-config.js";
import { ompEnv } from "../omp-env.js";
import { prepareSessionScope } from "../session-scope.js";
import { findOmpSessionCwd, forkOmpSession } from "../session-intel.js";
import { materializeSkillManifest } from "../skill-manifest.js";
import {
  governancePolicyActive, materializeGovernanceManifest, parseGovernancePolicy,
  validateGovernanceGate,
} from "../governance-manifest.js";
import { materializeGovernanceOverlay } from "../governance-overlay.js";
import { materializeBudgetOverlay } from "../budget-overlay.js";
import { materializeThinkingOverlay, requestedThinkingLevel } from "../thinking-overlay.js";
import { mergePiConfigFiles, type OverlayEntry } from "./overlays.js";
import { loadState, saveState, sessionIntelDir, type SessionIntelState } from "../session-state.js";
import { buildOmpAcpConfig, bridgeArtifactError, configuredWarmHandleIdleMs, firstNonEmptyString, isGovernanceArmed, resolveBridgeRunMode, resolveOmpAgentCommand, resolveSessionCwd } from "../adapters/acp/launch.js";
import {
  capabilityCacheDir, capabilityDiagnostics, loadCapabilities, type CapabilityFeature,
} from "../capabilities.js";
import { buildWorkerArgv } from "../../host/worker.js";
import {
  readSessionIntelConfig, resolveExecutionMode, resolveRunDirective, thinkingLevelChanged,
  validateCredentialMode, validateExecutionMode, validatePlanMode, validateSessionScope,
  validateSteering, validateSubagentObservability, validateThinkingLevel,
  type RunDirective, type SessionIntelConfig, type SessionScope,
} from "../session-directives.js";

/**
 * The run plan: every decision a run takes BEFORE the engine is touched —
 * config gates, session scope, overlays, the model catalog, the manifests, the
 * run-child argv/env, the session directive — sequenced in one place, with no
 * transport in sight.
 *
 * Each step below emits its own diagnostics in the order the run has always
 * emitted them, so splitting the sequence changes structure, never behaviour.
 * A refusal returns before any engine work; `executePlan` only ever sees a
 * ready plan.
 */

export interface RunRefusal {
  errorCode: string;
  errorMessage: string;
}

export interface RunPlanDeps {
  /** The extension artifact the run child is told to load (`--extension`). */
  bridge: string;
  /** `dist/server`: where the adapter resolves bundled skill content from. */
  moduleDir: string;
  /**
   * The managed lane's session index: the cwd a session this supervisor ran
   * recorded. Null means "ask the ACP probe lane", which is the fallback for a
   * source the host never ran (and for engine mode, which passes no function).
   */
  hostSessionCwd?: (sessionId: string) => Promise<string | null>;
}

export interface RunPlan {
  ctx: AdapterExecutionContext;
  /** The config handed to the engine (a fork run re-pins its warm handle here). */
  engineConfig: Record<string, unknown>;
  /** Runtime override applied to each engine attempt (fork resume / fresh). */
  runtimeOverride: AdapterExecutionContext["runtime"] | null;
  /** Fresh-session retry policy for the engine call. */
  retry: RetryConfig;
  /** Run-child overlays that landed, in PI_CONFIG_FILES precedence order. */
  overlays: OverlayEntry[];
  directive: RunDirective;
  intel: SessionIntelConfig;
  intelState: SessionIntelState;
  storedParams: Record<string, unknown>;
  sessionCwd: string;
  sessionScope: SessionScope;
  requestedThinking: string;
  rawModel: string | undefined;
  models: OmpModelInfo[];
  resolveModel: (model: string) => string | null;
  resolveCost: (model: string) => OmpModelCost | null;
  sideChannelEnv: Record<string, string>;
  bridge: string;
  runtimeMcpServerCount: number;
  forkTokenUsed: string | null;
  forkedSessionId: string | null;
  freshTokenUsed: string | null;
  persistState: () => Promise<void>;
}

export type RunPlanResult =
  | { kind: "refused"; refusal: RunRefusal }
  | { kind: "ready"; plan: RunPlan };


/**
 * Endpoint of the run-scoped connection-tools MCP server Paperclip offered this
 * run, or null when it offered none. A server that never sets `runtimeTools`
 * reads as null. Only the endpoint is read; the bearer token in the same object
 * must never enter a log, an event or a work product.
 */
function connectionToolsEndpoint(ctx: AdapterExecutionContext): string | null {
  const endpoint = ctx.runtimeTools?.mcpEndpoint;
  return typeof endpoint === "string" && endpoint.trim() !== "" ? endpoint.trim() : null;
}

/**
 * The fail-closed config gates, in the order the run has always applied them.
 * Each returns a `omp_config_error` refusal; the thinking-level warning is the
 * one diagnostic that does NOT abort (the append is fail-open).
 */
async function gateRunConfig(ctx: AdapterExecutionContext): Promise<RunRefusal | null> {
  // Lane selection comes first: the two lanes differ in credential placement and
  // settlement semantics, so a typo must be a config error, never a fallback.
  const modeErr = validateExecutionMode(ctx.config);
  if (modeErr) return { errorCode: "omp_config_error", errorMessage: modeErr };
  const steeringErr = validateSteering(ctx.config);
  if (steeringErr) return { errorCode: "omp_config_error", errorMessage: steeringErr };
  // A typo here would pick a different amount of subagent metadata on the
  // managed lane, so it is a config error like the lane and steering keys.
  const subagentErr = validateSubagentObservability(ctx.config);
  if (subagentErr) return { errorCode: "omp_config_error", errorMessage: subagentErr };
  // Fail closed: broker credentialMode demands a resolved broker url+token.
  // Return before any engine work so a misconfigured agent never runs a
  // half-configured session.
  const credErr = validateCredentialMode(ctx.config);
  if (credErr) return { errorCode: "omp_config_error", errorMessage: credErr };
  // v0.6 thinking validation: a bad value emits a warn but does NOT abort
  // (the append itself is fail-open — omp uses its default level).
  const thinkMsg = validateThinkingLevel(ctx.config);
  if (thinkMsg) {
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "warn",
      message: thinkMsg,
    });
  }
  // Session scope (item 18) is a containment control, so it fails closed
  // BEFORE any engine work: `isolated` points omp at this agent's own agent
  // dir, which holds no credential store (agent.db) and no operator config,
  // so only broker credentials can authenticate a fenced run.
  const scopeErr = validateSessionScope(ctx.config);
  if (scopeErr) return { errorCode: "omp_config_error", errorMessage: scopeErr };
  // Plan mode is a config error, not a warn: this adapter declares no
  // elicitation/form capability, so omp would auto-approve the plan and the
  // approval step plan mode exists for would be gone (see validatePlanMode).
  const planErr = validatePlanMode(ctx.config);
  if (planErr) return { errorCode: "omp_config_error", errorMessage: planErr };
  // deny-all is answered by the engine's permission proxy, which the bridge
  // cannot override; pairing it with scoped/rewritten tool rules describes a
  // run that cannot happen. Fail at config time (see validateGovernanceGate).
  const gateErr = validateGovernanceGate(ctx.config);
  if (gateErr) return { errorCode: "omp_config_error", errorMessage: gateErr };
  // Retry knobs are an enum omp validates by DISCARDING: an unknown
  // `fallbackOn` reads back as `any` with only a startup warning nobody on
  // this lane sees. Refuse the run instead of writing a file that does nothing.
  const retryKnobErr = validateRetryFallbackConfig(ctx.config);
  if (retryKnobErr) return { errorCode: "omp_config_error", errorMessage: retryKnobErr };
  return null;
}

function ompBaseCommand(
  config: Record<string, unknown>,
  bridge: string,
): { command: string; args: string[] } {
  const tokens = resolveOmpAgentCommand(config, bridge).split(/\s+/);
  // The resolved agent command may carry trailing flags (`--extension <path>`,
  // the `off` thinking flag, or an operator's own). Locate `acp` by index so
  // trailing tokens are never confused with the base command.
  const acpIdx = tokens.indexOf("acp");
  const base = acpIdx >= 0 ? tokens.slice(0, acpIdx) : tokens;
  return { command: base[0], args: base.slice(1) };
}

/**
 * The ACP-lane command with its `acp` sub-command and trailing flags — the
 * shape the capability probe's ACP group drives (`<command> <args...>`).
 */
function ompAcpCommand(
  config: Record<string, unknown>,
  bridge: string,
): { command: string; args: string[] } {
  const tokens = resolveOmpAgentCommand(config, bridge).split(/\s+/);
  return { command: tokens[0], args: tokens.slice(1) };
}

/** The capabilities THIS run leans on, given its lane and its config. */
function runCapabilityFeatures(
  ctx: AdapterExecutionContext,
  input: { mode: "engine" | "managed"; intel: SessionIntelConfig; directive: RunDirective },
): CapabilityFeature[] {
  if (input.mode === "managed") {
    // The supervisor always reads stats and always resets the subagent
    // subscription; host tools only when Paperclip offered them.
    return ctx.runtimeTools !== undefined
      ? ["managedUsage", "managedSubagents", "managedHostTools"]
      : ["managedUsage", "managedSubagents"];
  }
  const features: CapabilityFeature[] = [];
  const policy = parseGovernancePolicy(ctx.config.governancePolicy);
  if (input.intel.browser) features.push("sessionSnapshot");
  if (input.directive.kind === "fork") features.push("sessionFork");
  if (requestedThinkingLevel(ctx.config) !== "") features.push("thinkingLevel");
  if (policy.kind === "ok" && policy.policy.budgetCapUsd !== undefined) features.push("budgetHardCap");
  if (policy.kind === "ok" && (policy.policy.restrictedFolders?.length ?? 0) > 0) features.push("folderFence");
  if (governancePolicyActive(ctx.config)) features.push("governanceExtensions");
  return features;
}

/**
 * Read the build's capability set for the features this run depends on and
 * report the ones it lacks, naming the feature and what happens instead.
 *
 * The run path READS the cache and never probes: a heartbeat must not gain a
 * probe process (the capability contract's cost rule), and the probe itself is
 * owned by `testEnvironment`, which runs when the agent is validated. A cold
 * cache therefore reports nothing here — the environment test is where the
 * surfaces are discovered, and its result is what the runs read.
 *
 * Only a command literally named `omp` is consulted: a wrapper prints its own
 * help/settings, so its surface probe would describe the wrapper. Nothing here
 * can refuse a run.
 */
async function planCapabilities(
  ctx: AdapterExecutionContext,
  input: {
    /**
     * The agent config as the environment test sees it: before the session
     * scope folds in `PI_CODING_AGENT_DIR` and before the manifests add
     * `--extension` / `PAPERCLIP_*_MANIFEST` / `PI_CONFIG_FILES`. The probe
     * cache key is built from this exact command and env, so a run and the
     * environment test must derive them the same way or the run reads a key
     * nobody wrote.
     */
    probeConfig: Record<string, unknown>;
    mode: "engine" | "managed";
    bridge: string;
    intel: SessionIntelConfig;
    directive: RunDirective;
  },
): Promise<void> {
  const acp = ompAcpCommand(input.probeConfig, input.bridge);
  if (path.basename(acp.command) !== "omp") return;
  const features = runCapabilityFeatures(ctx, input);
  if (features.length === 0) return;
  const env = ompEnv({ config: input.probeConfig });
  const capabilities = await loadCapabilities({
    acp: { ...acp, env },
    mode: input.mode,
    ...(input.mode === "managed"
      ? { worker: { ...buildWorkerArgv(input.probeConfig, input.bridge), env } }
      : {}),
    cacheDir: capabilityCacheDir(),
    cacheOnly: true,
  });
  if (capabilities === null) return;
  for (const diagnostic of capabilityDiagnostics(capabilities, features)) {
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: diagnostic.level, message: diagnostic.message,
    });
  }
}

/**
 * Resolve the model catalog the run shapes itself from. Resolvers are backed by
 * the cached `omp models ls` list (5-min TTL inside models.ts, keyed by
 * command+env so different agents' credentials never share a catalog). The
 * fetch is skipped when no model is configured AND no chain leg is
 * provider-qualified — a broken/missing `omp` would otherwise add up to 20s of
 * uncached failure latency per run.
 */
async function planModelCatalog(
  ctx: AdapterExecutionContext,
  input: { bridge: string; sideChannelEnv: Record<string, string> },
): Promise<
  | { refusal: RunRefusal; models?: undefined; resolveModel?: undefined; resolveCost?: undefined }
  | {
      refusal: null;
      models: OmpModelInfo[];
      resolveModel: (model: string) => string | null;
      resolveCost: (model: string) => OmpModelCost | null;
    }
> {
  const base = ompBaseCommand(ctx.config, input.bridge);
  const providerSelectors = providerQualifiedSelectors(ctx.config);
  const models = firstNonEmptyString(ctx.config.model) || providerSelectors.length > 0
    ? await listOmpModels({
        command: base.command,
        args: [...base.args, "models", "ls", "--json"],
        env: input.sideChannelEnv,
      })
    : [];
  // omp 18.14 resolves a provider-qualified selector (anything with `/`)
  // exactly: a near match fails for `model` and is skipped for a chain leg,
  // so passing one through would run a narrower chain than configured. Bare
  // selectors keep omp's fuzzy matching. An unreadable catalog cannot prove
  // anything, so it degrades to the old pass-through with a warning.
  if (providerSelectors.length > 0) {
    if (models.length === 0) {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: `omp model catalog unavailable (unreadable or empty): provider-qualified selectors (${providerSelectors.map(({ selector }) => selector).join(", ")}) pass through unresolved; omp 18.14 fails a near-match model and skips such a fallback leg`,
      });
    } else {
      const selectorErr = validateProviderQualifiedSelectors(ctx.config, models);
      if (selectorErr) return { refusal: { errorCode: "omp_config_error", errorMessage: selectorErr } };
    }
  }
  // Bare selectors keep fuzzy resolution; a provider-qualified id omp accepts
  // only in raw or non-canonical case form is rewritten to the composed
  // `provider/id`, because ACP's `set_config_option` is byte-exact.
  const resolveModel = (model: string): string | null =>
    normalizeOmpModelId(model, models) ?? exactOmpModelId(model, models);
  const resolveCost = (model: string): OmpModelCost | null =>
    models.find((m) => m.id === model)?.cost ?? null;
  return { refusal: null, models, resolveModel, resolveCost };
}

/**
 * Materialize the two manifests that ride `config.env` into the run child.
 *
 * Lazy-skill bridge: when skillsAsTools is on, materialize the skills manifest
 * and hand its path to the run child via PAPERCLIP_SKILLS_MANIFEST so the
 * bundled bridge extension (dist/paperclip-bridge.js) registers each desired
 * skill as an on-demand native tool. The env MUST be set before
 * buildOmpAcpConfig runs so resolveOmpAgentCommand sees it and appends
 * --extension <bridgePath> (which, like --thinking, rotates the session
 * fingerprint). A whitespace-bearing bridge path would break the adapter's
 * naive /\s+/ token split, so warn and fall back to prose injection instead.
 *
 * Governance substrate (v0.8): when the operator sets governancePolicy AND that
 * policy carries a rule the bridge can enforce, materialize it into the agent's
 * state dir and hand the path to the run child via
 * PAPERCLIP_GOVERNANCE_MANIFEST. That env arms the --extension append, and the
 * armed bridge — through the governance overlay folded below — is what may take
 * the run's single permission gate. An unparseable document warns and the run
 * proceeds ungoverned rather than dying on a policy typo.
 */
async function planSkillsAndGovernance(
  ctx: AdapterExecutionContext,
  input: { intelDir: string; bridge: string; moduleDir: string },
): Promise<{ refusal: RunRefusal | null; bridgeActive: boolean; governanceArmed: boolean }> {
  const skillsAsToolsOn = ctx.config.skillsAsTools === true || ctx.config.skillsAsTools === "true";
  let bridgeActive = false;
  if (skillsAsToolsOn) {
    const bridgeMode = resolveBridgeRunMode(input.bridge);
    if (bridgeMode.kind === "whitespace") {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: bridgeMode.warn,
      });
    } else {
      const manifest = await materializeSkillManifest(ctx.config, input.intelDir, input.moduleDir);
      if (manifest) {
        // Do not clobber existing env keys — fold the manifest var in.
        ctx.config.env = { ...(ctx.config.env ?? {}), PAPERCLIP_SKILLS_MANIFEST: manifest };
        bridgeActive = true;
      }
    }
  }
  const governanceManifest = await materializeGovernanceManifest(
    ctx.config,
    input.intelDir,
    (message) => ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "warn", message,
    }),
  );
  if (governanceManifest) {
    // Fold, never clobber: the skills manifest env may already be set.
    ctx.config.env = {
      ...(ctx.config.env ?? {}),
      PAPERCLIP_GOVERNANCE_MANIFEST: governanceManifest,
    };
    // The policy reached the child, so the run is about to drop omp's own
    // gate in favor of the bridge. If the extension artifact is not even
    // readable, that trade leaves NO gate: fail the run instead of running
    // it ungoverned with `approvalMode: yolo`. This is the whole load
    // verification the parent can perform (see bridgeArtifactError).
    const artifactError = await bridgeArtifactError(input.bridge);
    if (artifactError) {
      return { refusal: { errorCode: "omp_governance_unavailable", errorMessage: artifactError }, bridgeActive, governanceArmed: false };
    }
  }
  // Governance is ARMED only when the policy really reached a bridge that will
  // really load: a manifest path AND a whitespace-free extension path (the
  // adapter's naive /\s+/ command tokenizer cannot carry the flag otherwise).
  // Anything less and the single gate must NOT move: `approvalMode: yolo`
  // switches off omp's own permission gate, so emitting it unarmed leaves the
  // run with no gate at all and no guardrail, budget or approval rule in force.
  const governanceArmed = isGovernanceArmed(governanceManifest, input.bridge);
  if (!governanceArmed && governancePolicyActive(ctx.config)) {
    // Governance has no prose-injection fallback: without the extension loaded
    // the policy is decoration, so say which half failed and what it cost.
    const why = governanceManifest === null
      ? "the governance manifest could not be written"
      : "the bridge extension path contains whitespace, so --extension was not appended";
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "warn",
      message: `omp governance policy enforces nothing: ${why}; governance is not armed, so omp's own approval gate stays in force`,
    });
  }
  return { refusal: null, bridgeActive, governanceArmed };
}

/**
 * Materialize the two run-child-only routing overlays, in precedence order:
 * governance routing, then the budget thresholds.
 *
 * Endpoint routing (v0.8 T4): approvedEndpoints becomes omp's declarative
 * disabledProviders, computed as the catalog complement minus every provider
 * this run must keep. It rides in its OWN overlay file, folded only into the
 * RUN child's PI_CONFIG_FILES: `disabledProviders` filters `omp models ls`,
 * and the side channels read the failover overlay — if routing keys lived
 * there, our own filter would shrink the catalog the complement is computed
 * from and the disabled set would oscillate between runs. Cold children
 * (default warmHandleIdleMs 0) re-read the file every run, so changing
 * approvedEndpoints takes effect on the next run.
 *
 * Spend that can stop: the operator's soft per-session budget becomes omp's own
 * session cost cap. The bridge cap only refuses tool calls, so a turn that never
 * reaches it (or a subagent with its own copy) can spend past it; omp's CostGate
 * refuses the next model request for the whole session tree. Its own overlay
 * file keeps the path stable across cap changes, so editing the number does not
 * rotate the session.
 */
async function planRoutingOverlays(
  ctx: AdapterExecutionContext,
  input: {
    intelDir: string;
    models: readonly OmpModelInfo[];
    resolveModel: (model: string) => string | null;
    rawModel: string | undefined;
    armed: boolean;
    overlays: OverlayEntry[];
  },
): Promise<void> {
  const governanceOverlay = await materializeGovernanceOverlay(
    ctx.config,
    input.intelDir,
    {
      models: input.models,
      configuredModel: input.rawModel ? (input.resolveModel(input.rawModel) ?? input.rawModel) : null,
      // The gate relaxation rides the armed bridge and nothing else: an
      // unarmed run keeps omp's own approval behavior and only routes.
      armed: input.armed,
    },
    (message) => ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "warn", message,
    }),
  );
  if (governanceOverlay.status === "ok") {
    input.overlays.push({ kind: "governance", path: governanceOverlay.path });
  }
  if (governanceOverlay.status === "error") {
    // Ungoverned routing, not a failed run: the gate key is lost with the
    // file, so say which halves of governance did not land.
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "warn",
      message: `omp governance overlay write failed: ${governanceOverlay.error}; continuing without the single gate or endpoint routing`,
    });
  } else if (governanceOverlay.status === "ok" && governanceOverlay.disabled.length > 0) {
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "info",
      message: `omp governance routing disabled ${governanceOverlay.disabled.length} provider(s) for this run: ${governanceOverlay.disabled.join(", ")}`,
    });
  }
  const parsedGovernance = parseGovernancePolicy(ctx.config.governancePolicy);
  const budgetOverlay = await materializeBudgetOverlay(
    parsedGovernance.kind === "ok" ? parsedGovernance.policy.budgetCapUsd : undefined,
    input.intelDir,
  );
  if (budgetOverlay.status === "ok") {
    input.overlays.push({ kind: "budget", path: budgetOverlay.path });
  }
  if (budgetOverlay.status === "error") {
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "warn",
      message: `omp budget overlay write failed: ${budgetOverlay.error}; the run continues without omp's hard cost cap (the bridge's soft cap still applies)`,
    });
  }
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
async function materializeSkillsInstructions(
  config: Record<string, unknown>,
  moduleDir: string,
): Promise<string | null> {
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

/**
 * Derive the run-child config: engine keys (ACP launch), the thinking overlay,
 * the merged PI_CONFIG_FILES, and the instructions file.
 *
 * Every overlay this run owns is folded into `config` BEFORE engineConfig is
 * derived: the fork branch rebuilds engineConfig as
 * { ...config, warmHandleIdleMs: 50 }, so an overlay added only to engineConfig
 * would be silently dropped by the fork spread — PI_CONFIG_FILES must ride on
 * `config` to survive it. The order is the precedence order: operator file,
 * then the failover chain, then governance routing, then the budget thresholds,
 * then the thinking level.
 */
async function assembleRunChildConfig(
  ctx: AdapterExecutionContext,
  input: {
    bridge: string;
    moduleDir: string;
    overlays: OverlayEntry[];
    bridgeActive: boolean;
    resolveModel: (model: string) => string | null;
    resolveCost: (model: string) => OmpModelCost | null;
    intelDir: string;
  },
): Promise<Record<string, unknown>> {
  const config = buildOmpAcpConfig(ctx.config, input.resolveModel, input.resolveCost, input.bridge);
  // The thinking level rides its own overlay (fixed path, so an edit never
  // rotates the session). Run-child only: no side channel reads a level.
  const thinkingOverlay = await materializeThinkingOverlay(ctx.config, input.intelDir);
  if (thinkingOverlay.status === "ok") {
    input.overlays.push({ kind: "thinking", path: thinkingOverlay.path });
  }
  if (thinkingOverlay.status === "error") {
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "warn",
      message: `omp thinking overlay write failed: ${thinkingOverlay.error}; the run continues at whatever level omp resolves on its own`,
    });
  }
  const operatorPi =
    typeof (ctx.config.env as Record<string, unknown> | undefined)?.PI_CONFIG_FILES === "string"
      ? (ctx.config.env as Record<string, unknown>).PI_CONFIG_FILES as string
      : "";
  const mergedPi = mergePiConfigFiles(operatorPi, input.overlays);
  if (mergedPi) config.env = { ...(config.env ?? {}), PI_CONFIG_FILES: mergedPi };
  // Ephemeral skills: when the bridge is active, skill content is delivered
  // on demand via the registered native tools, so prose injection is skipped
  // (bridge and prose are mutually exclusive). Otherwise materialize the
  // merged instructions file (skills + user instructions) so the engine
  // injects it into this run. The merged file always carries the user's
  // content when present, so the path is set unconditionally whenever any
  // skill is desired; null leaves any existing instructionsFilePath
  // untouched.
  const instructionsFile = input.bridgeActive
    ? null
    : await materializeSkillsInstructions(ctx.config, input.moduleDir);
  if (instructionsFile) config.instructionsFilePath = instructionsFile;
  return config;
}

/**
 * Load and advance the session-intel state: the directive this run must follow,
 * the thinking-level rotation it may arm, and the once-only scope-flip warning.
 */
async function planSessionState(
  ctx: AdapterExecutionContext,
  input: { sessionScope: SessionScope; scopeAgentDir: string | null; intelDir: string },
): Promise<{
  intel: SessionIntelConfig;
  intelState: SessionIntelState;
  storedParams: Record<string, unknown>;
  requestedThinking: string;
  /** The pending rotation was armed by this run's thinking-level change. */
  thinkingRotateArmed: boolean;
  directive: RunDirective;
  sessionCwd: string;
  persistState: () => Promise<void>;
}> {
  // --- v0.4 session runtime: directives, fork resume, rotation, snapshot ---
  const intel = readSessionIntelConfig(ctx.config);
  const intelState = await loadState(input.intelDir);
  const storedParams = (ctx.runtime.sessionParams ?? {}) as Record<string, unknown>;
  const storedSessionId = typeof storedParams.acpSessionId === "string" ? storedParams.acpSessionId : "";
  // omp keeps the level a session started with inside its transcript and
  // prefers it on resume (sdk.ts:2139-2146, agent-session.ts:12811-12835), so
  // a new level can only reach an existing session by starting a new one.
  // Arm the same rotation the thresholds use instead of leaving the edit
  // silently inert.
  const requestedThinking = requestedThinkingLevel(ctx.config);
  let thinkingRotateArmed = false;
  if (intelState.pendingRotate === null
    && thinkingLevelChanged(intelState.lastThinking, storedSessionId, requestedThinking)) {
    const recorded = intelState.lastThinking?.level ?? null;
    const from = recorded === null ? "an unknown inherited level" : recorded === "" ? "omp default" : recorded;
    intelState.pendingRotate = {
      reason: `thinking level changed from '${from}' to '${requestedThinking === "" ? "omp default" : requestedThinking}'`,
      at: new Date().toISOString(),
    };
    thinkingRotateArmed = true;
  }
  const directive = resolveRunDirective(intel, intelState);
  const sessionCwd = resolveSessionCwd(ctx, storedParams);
  // A scope flip is the one moment a resumable session is left behind: the
  // previous transcript sits in the other agent dir and this run's fingerprint
  // differs, so the engine starts fresh. Say so ONCE (the state records the
  // scope of every run) instead of cold-starting silently. A state written
  // before this release reads as null and is treated as the historical
  // default, so an upgrade alone never warns.
  const previousScope = intelState.lastScope ?? "shared";
  if (previousScope !== input.sessionScope) {
    const previousSessionId = typeof storedParams.acpSessionId === "string"
      ? storedParams.acpSessionId
      : "";
    if (previousSessionId) {
      const where = input.sessionScope === "isolated"
        ? `this agent's own omp agent dir (${input.scopeAgentDir})`
        : "the host-wide omp agent dir";
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: `omp sessionScope switched to '${input.sessionScope}': the previous session (${previousSessionId.slice(0, 12)}) stays where it was and will not be resumed, so this run starts a fresh session in ${where}`,
      });
    }
  }
  intelState.lastScope = input.sessionScope;
  // State writes must never fail a completed run: mirror the loadState
  // degrade + the other warn-and-continue degradation paths.
  const persistState = async (): Promise<void> => {
    try {
      await saveState(input.intelDir, intelState);
    } catch (err) {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: `omp session intel state save failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
  return { intel, intelState, storedParams, requestedThinking, thinkingRotateArmed, directive, sessionCwd, persistState };
}

/**
 * Apply the directive: fork (side channel), force-fresh, or rotation. Returns
 * the engine config, the runtime override each attempt carries, and the retry
 * policy for this run.
 */
async function applySessionDirective(
  ctx: AdapterExecutionContext,
  input: {
    directive: RunDirective;
    thinkingRotateArmed: boolean;
    config: Record<string, unknown>;
    bridge: string;
    sideChannelEnv: Record<string, string>;
    sessionCwd: string;
    storedParams: Record<string, unknown>;
    intelState: SessionIntelState;
    hostSessionCwd?: (sessionId: string) => Promise<string | null>;
  },
): Promise<{
  engineConfig: Record<string, unknown>;
  runtimeOverride: AdapterExecutionContext["runtime"] | null;
  retry: RetryConfig;
  forkTokenUsed: string | null;
  forkedSessionId: string | null;
  freshTokenUsed: string | null;
}> {
  const { directive, intelState } = input;
  let forkTokenUsed: string | null = null;
  let forkedSessionId: string | null = null;
  let freshTokenUsed: string | null = null;
  let forceFreshOverride = false;
  let engineConfig = input.config;

  if (directive.kind === "fork") {
    const ompTokens = resolveOmpAgentCommand(ctx.config, input.bridge).split(/\s+/);
    const sideChannel = { command: ompTokens[0], args: ompTokens.slice(1), env: input.sideChannelEnv };
    // omp opens the fork at the CLIENT-SUPPLIED cwd and then switches to the
    // source session, which refuses the switch when its recorded cwd differs
    // (`agent-session.ts` SESSION_CWD_CHANGE_REJECTED → -32603). So the frame
    // must carry the SOURCE's cwd, not this run's.
    //
    // The managed lane answers this from the supervisor's session index first:
    // a source the host ran needs no probe process at all. Only a source the
    // host never ran falls back to the bounded, unfiltered `session/list` (the
    // source may live under another workspace).
    const hostCwd = input.hostSessionCwd === undefined
      ? null
      : await input.hostSessionCwd(directive.forkSourceId).catch(() => null);
    let forkCwd = hostCwd ?? input.sessionCwd;
    if (hostCwd === null) {
      const source = await findOmpSessionCwd(sideChannel, directive.forkSourceId);
      forkCwd = source.ok ? source.cwd : input.sessionCwd;
      if (!source.ok) {
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system", level: "warn",
          message: `omp fork source session ${directive.forkSourceId} could not be located (${source.error}); `
            + `forking with this run's cwd (${input.sessionCwd}) — omp rejects the fork if the source recorded a different one`,
        });
      }
    }
    const fork = await forkOmpSession(sideChannel, directive.forkSourceId, forkCwd);
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
      engineConfig = { ...input.config, warmHandleIdleMs: 50 };
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
    if (input.thinkingRotateArmed) {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "info",
        message: `omp ${directive.reason}: a resumed session keeps the level it stored, so this run starts a fresh session to apply the new one`,
      });
    }
  }

  // The engine's settlement gate, not this adapter, is what keeps a warm
  // handle from being reused under run identity (see RUN_IDENTITY_ENABLED):
  // the operator's value is passed through, and a save that still carries this
  // run's credential is discarded at settlement. Say so once, so an operator
  // who expects a warm child knows why they still get a cold one. A fork run is
  // exempt: its engineConfig carries the per-run 50 ms pin, not this value.
  const requestedWarmIdleMs = configuredWarmHandleIdleMs(ctx.config);
  if (requestedWarmIdleMs > 0 && directive.kind !== "fork") {
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "info",
      message: `omp warm-handle idle window ${requestedWarmIdleMs}ms is honoured, but this run carries a run-scoped credential, so the engine's settlement gate discards the handle instead of reusing it (close-and-relaunch); remove warmHandleIdleMs to stop this note`,
    });
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
    ? { ...ctx.runtime, sessionParams: { ...input.storedParams, acpSessionId: forkedSessionId } }
    : forceFreshOverride
      ? { ...ctx.runtime, sessionParams: {} }
      : null;

  return {
    engineConfig,
    runtimeOverride,
    // Fork runs MUST bypass the fresh-session retry loop: retrying would
    // bust the fingerprint via OMP_PAPERCLIP_RETRY, causing the engine to
    // start a blank session (isCompatibleSession fails) instead of resuming
    // the forked session — orphaning it. Disabling retries keeps the fork
    // resume path intact: a single attempt either succeeds normally, or
    // fails terminally with the token still armed (next run re-forks from
    // source). omp's own TurnRecovery still handles transient provider
    // failures within that single attempt.
    retry: directive.kind === "fork" ? { enabled: false, freshRetries: 0 } : readRetryConfig(ctx.config),
    forkTokenUsed,
    forkedSessionId,
    freshTokenUsed,
  };
}


/**
 * Build the plan for one run. Pure with respect to the transport: it touches
 * config, the filesystem (overlays/manifests/state) and the side channels, but
 * never the engine — a refusal returns before any of that is constructed.
 */
export async function buildRunPlan(
  ctx: AdapterExecutionContext,
  deps: RunPlanDeps,
): Promise<RunPlanResult> {
  const gate = await gateRunConfig(ctx);
  if (gate) return { kind: "refused", refusal: gate };

  const preparedScope = await prepareSessionScope(ctx.config, {
    companyId: ctx.agent.companyId, agentId: ctx.agent.id,
  });
  if (!preparedScope.ok) {
    return { kind: "refused", refusal: { errorCode: "omp_config_error", errorMessage: preparedScope.error } };
  }
  const sessionScope = preparedScope.prepared.scope;
  // The agent config as it arrived, before the scope fence and the manifests
  // change the command or the env. The capability probe is keyed by exactly
  // that command+env (the same ones `testEnvironment` derives), so this is the
  // snapshot the run's cache read must use. Copied, not referenced: the
  // manifests fold their env into `ctx.config` (which may be this same object).
  const probeConfig = { ...ctx.config };
  // The fenced config carries PI_CODING_AGENT_DIR (and the folded operator
  // config.yml) into the run child AND every side channel below; ompEnv
  // forwards the value it finds here.
  if (preparedScope.prepared.config !== ctx.config) ctx.config = preparedScope.prepared.config;
  for (const warning of preparedScope.prepared.warnings) {
    await ctx.onEvent?.({ eventType: "run.system", stream: "system", level: "warn", message: warning });
  }
  const executionMode = resolveExecutionMode(ctx.config) ?? "engine";
  // Run-scoped control tools (v0.9). The adapter declares
  // `runtimeToolDelivery: "native_mcp"`, so Paperclip must hand the
  // connections server over as an ACP MCP server. Read the channel it
  // actually used: when the tools arrive as invocation-context data instead
  // (a Paperclip build that ignores the flag), nothing in this process can
  // serve them and they would disappear silently — the pre-v0.9 failure.
  // Resolved once per run so the count reported at the end is the same list
  // the engine received.
  //
  // Managed mode is the exception by design: no MCP server is forwarded into
  // the worker. The run's `runtimeTools` travel to the supervisor as
  // `connectionTools`, which becomes two omp host tools — so the "no MCP
  // server delivered" warning is the managed lane's normal case, not a fault.
  const runtimeMcpServers = executionMode === "managed" ? [] : ctx.runtimeMcp?.getServers?.() ?? [];
  const connectionEndpoint = executionMode === "managed" ? null : connectionToolsEndpoint(ctx);
  if (connectionEndpoint && !runtimeMcpServers.some((server) => server.url === connectionEndpoint)) {
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "warn",
      message: `omp connection tools are unavailable this run: Paperclip delivered no MCP server for the declared native_mcp channel (${runtimeMcpServers.length} runtime MCP server(s)), so connections_search/connection_request never reach the agent`,
    });
  }
  const intelDir = sessionIntelDir(ctx.agent.companyId, ctx.agent.id);
  // Every run-child overlay this run lands, in PI_CONFIG_FILES precedence
  // order. One writer (run/overlays.ts) owns the fixed filenames; this list
  // is the only place the paths are merged.
  const overlays: OverlayEntry[] = [];
  const failoverOverlay = await materializeFailoverOverlay(ctx.config, intelDir);
  if (failoverOverlay.status === "ok") overlays.push({ kind: "failover", path: failoverOverlay.path });
  if (failoverOverlay.status === "error") {
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "warn",
      message: `omp failover overlay write failed: ${failoverOverlay.error}; continuing without PI_CONFIG_FILES`,
    });
  }
  const sideChannelEnv = ompEnv({
    config: ctx.config,
    overlayPath: failoverOverlay.status === "ok" ? failoverOverlay.path : null,
  });
  const catalog = await planModelCatalog(ctx, { bridge: deps.bridge, sideChannelEnv });
  if (catalog.refusal) return { kind: "refused", refusal: catalog.refusal };
  const manifests = await planSkillsAndGovernance(ctx, {
    intelDir, bridge: deps.bridge, moduleDir: deps.moduleDir,
  });
  if (manifests.refusal) return { kind: "refused", refusal: manifests.refusal };
  const rawModel = firstNonEmptyString(ctx.config.model);
  await planRoutingOverlays(ctx, {
    intelDir,
    models: catalog.models,
    resolveModel: catalog.resolveModel,
    rawModel,
    armed: manifests.governanceArmed,
    overlays,
  });
  const config = await assembleRunChildConfig(ctx, {
    bridge: deps.bridge,
    moduleDir: deps.moduleDir,
    overlays,
    bridgeActive: manifests.bridgeActive,
    resolveModel: catalog.resolveModel,
    resolveCost: catalog.resolveCost,
    intelDir,
  });
  const session = await planSessionState(ctx, {
    sessionScope,
    scopeAgentDir: preparedScope.prepared.agentDir,
    intelDir,
  });
  await planCapabilities(ctx, {
    probeConfig,
    mode: executionMode,
    bridge: deps.bridge,
    intel: session.intel,
    directive: session.directive,
  });
  const applied = await applySessionDirective(ctx, {
    directive: session.directive,
    thinkingRotateArmed: session.thinkingRotateArmed,
    config,
    bridge: deps.bridge,
    sideChannelEnv,
    sessionCwd: session.sessionCwd,
    storedParams: session.storedParams,
    intelState: session.intelState,
    ...(deps.hostSessionCwd !== undefined ? { hostSessionCwd: deps.hostSessionCwd } : {}),
  });
  return {
    kind: "ready",
    plan: {
      ctx,
      engineConfig: applied.engineConfig,
      runtimeOverride: applied.runtimeOverride,
      // The fresh-session retry replays a transport call; the managed lane's
      // idempotent run.begin is per runId, so a second attempt would be answered
      // from the first attempt's state. The host itself falls back to a fresh
      // session when a resume cannot be opened.
      retry: executionMode === "managed" ? { enabled: false, freshRetries: 0 } : applied.retry,
      overlays,
      directive: session.directive,
      intel: session.intel,
      intelState: session.intelState,
      storedParams: session.storedParams,
      sessionCwd: session.sessionCwd,
      sessionScope,
      requestedThinking: session.requestedThinking,
      rawModel,
      models: catalog.models,
      resolveModel: catalog.resolveModel,
      resolveCost: catalog.resolveCost,
      sideChannelEnv,
      bridge: deps.bridge,
      runtimeMcpServerCount: runtimeMcpServers.length,
      forkTokenUsed: applied.forkTokenUsed,
      forkedSessionId: applied.forkedSessionId,
      freshTokenUsed: applied.freshTokenUsed,
      persistState: session.persistState,
    },
  };
}
