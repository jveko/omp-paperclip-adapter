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
} from "@paperclipai/adapter-utils/acpx-engine/constants";
import {
  isFreeCost,
  listOmpModels,
  normalizeOmpModelId,
  type OmpModelCost,
} from "./models.js";
import { attributeRunCost, type RunCostFields } from "./cost-truth.js";
import { buildSkillsInstructions, skillsDir, type SkillMarkdownSource } from "./skills.js";
import { readRetryConfig, runWithFreshSessionRetry, withRetryChain } from "./retry.js";
import { materializeFailoverOverlay, parseFallbackChain, validateRetryFallbackConfig } from "./failover-config.js";
import { ompEnv } from "./omp-env.js";
import { prepareSessionScope } from "./session-scope.js";
import { forkOmpSession, findOmpSessionCwd, queryOmpSessions } from "./session-intel.js";
import { materializeSkillManifest } from "./skill-manifest.js";
import { governancePolicyActive, materializeGovernanceManifest, parseGovernancePolicy, validateGovernanceGate } from "./governance-manifest.js";
import { materializeGovernanceOverlay } from "./governance-overlay.js";
import { materializeBudgetOverlay } from "./budget-overlay.js";
import { materializeThinkingOverlay, requestedThinkingLevel } from "./thinking-overlay.js";
import {
  bumpRunCounter, consumeToken, loadState, rotateIfTripped, saveState,
  sessionIntelDir, snapshotDigest,
} from "./session-state.js";
import {
  buildUsageWorkProduct, estimateCostPerHeartbeat, fetchBrokerUsage, usageDigest,
} from "./usage-report.js";
import {
  buildSessionSnapshotWorkProduct, postWorkProduct, readSessionIntelConfig,
  resolveRunDirective, resolveWorkProductIssueId, sessionSnapshotDigestInput, thinkingLevelChanged,
  validateCredentialMode,
  validatePlanMode, validateSessionScope, validThinkingLevel, validateThinkingLevel,
} from "./session-directives.js";

export const DEFAULT_OMP_COMMAND = "omp";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const packageRootDir = path.resolve(moduleDir, "../..");
export const bridgePath = path.join(packageRootDir, "dist", "paperclip-bridge.js");

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * Decide whether the paperclip bridge extension should ride the omp agent
 * command. True when the run flow materialized EITHER manifest into config.env
 * — the skills manifest (v0.7 lazy skill registration) or the governance
 * manifest (v0.8 policy engine) — AND the resolved dist/paperclip-bridge.js
 * absolute path is whitespace-free: the adapter's side channels split
 * agentCommand with a naive /\s+/ tokenizer, so a whitespace-bearing path must
 * fall back to prose injection instead. Exported as a test seam so the
 * whitespace guard is directly testable (the real install's path never has
 * whitespace).
 */
export function shouldAppendBridgeExtension(
  config: Record<string, unknown>,
  bridgePath: string,
): boolean {
  const env = (config.env ?? {}) as Record<string, unknown>;
  const skills = env.PAPERCLIP_SKILLS_MANIFEST;
  const governance = env.PAPERCLIP_GOVERNANCE_MANIFEST;
  return ((typeof skills === "string" && skills.length > 0)
    || (typeof governance === "string" && governance.length > 0))
    && !/\s/.test(bridgePath);
}

export type BridgeRunMode = { kind: "ok" } | { kind: "whitespace"; warn: string };

/**
 * Decide how the run flow delivers skills content when skillsAsTools is on.
 * The lazy-skill bridge requires a whitespace-free bridgePath (the adapter's
 * side channels split agentCommand with a naive /\s+/ tokenizer), so a
 * whitespace-bearing path must fall back to prose injection. Exported as a
 * test seam: it takes bridgePath so the whitespace branch is testable without
 * a real whitespace-bearing install path (the module const bridgePath never
 * has whitespace in an installed adapter).
 */
export function resolveBridgeRunMode(bridgePath: string): BridgeRunMode {
  if (/\s/.test(bridgePath)) {
    return {
      kind: "whitespace",
      warn: "omp skills-as-tools bridge path contains whitespace; falling back to prompt-injected skill instructions",
    };
  }
  return { kind: "ok" };
}

/**
 * Is governance ARMED for this run — i.e. will the bridge extension actually
 * load in the run child AND actually hold a policy file?
 *
 * This is the single gate's precondition and the only legitimate reason to fold
 * `tools.approvalMode: yolo` into the run overlay: that key switches OFF omp's
 * own permission proxy, so emitting it while the manifest never landed (an
 * unwritable state dir) or the extension never loaded (a whitespace-bearing
 * install path the adapter's /\s+/ command tokenizer cannot carry) leaves the
 * run with NO gate at all — every guardrail, budget and approval rule silently
 * absent. Exported as a test seam: the real install's bridgePath can never carry
 * whitespace, so the branch is otherwise unobservable in-process.
 */
export function isGovernanceArmed(manifestPath: string | null, bridgePath: string): boolean {
  return manifestPath !== null && resolveBridgeRunMode(bridgePath).kind === "ok";
}

/**
 * Why the governance bridge artifact cannot enforce this run, or null.
 *
 * This is the one part of "the extension loaded" the parent process can
 * assert: the file the child will be told to load (`--extension <file>`) exists
 * and can be opened. Whether omp's module loader then accepts it, and whether
 * the extension's `session_start` handler arms, is inside the child and is not
 * observable here — nothing in the ACP stream, the bridge, or the engine
 * reports a load result (the bridge registers handlers and never speaks).
 *
 * A miss here is fail-closed by design: the governance manifest was written,
 * so the run would otherwise take `tools.approvalMode: yolo` and hand the
 * single gate to an extension that cannot be there — every guardrail, budget
 * and approval rule silently absent.
 */
export async function bridgeArtifactError(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(file, "r");
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return `the governance bridge extension cannot be loaded: ${file} is missing or unreadable (${code}). `
      + "The policy was materialized, so this run would take tools.approvalMode: yolo with no extension "
      + "to replace omp's permission gate — no guardrail, budget or approval rule in force. Build the "
      + "adapter (npm run build) or repair the install so dist/paperclip-bridge.js exists, or clear "
      + "governancePolicy.";
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function resolveOmpAgentCommand(
  config: Record<string, unknown>,
  bridge: string = bridgePath,
): string {
  const explicit = firstNonEmptyString(config.agentCommand, config.acpAgentCommand);
  const command = firstNonEmptyString(config.command) ?? DEFAULT_OMP_COMMAND;
  const base = explicit ?? `${command} acp`;
  // Paperclip bridge: append --extension <bridgePath> when the run flow
  // materialized a manifest env (pure function of config — the env presence IS
  // the bridge-active signal). Side channels that reuse the command but lack
  // the manifest env simply don't get the flag, so the bridge no-ops there.
  const extension = shouldAppendBridgeExtension(config, bridge)
    ? ` --extension ${bridge}`
    : "";
  // Every thinking level except `off` rides the run's settings overlay
  // (thinking-overlay.ts) as omp's `defaultThinkingLevel`. The flag is part of
  // agentCommand, which the engine hashes into the session key, so a level
  // there rotated the session on every edit. `off` is the exception: omp's
  // setting has no `off` value (it discards one and reads `high`), and the CLI
  // flag's `off` is the only way to ask for no thinking. Applies to the
  // explicit agentCommand too (skipped only when it already carries
  // --thinking, including a dangling flag with no value).
  const level = validThinkingLevel(config.thinking) === "off" ? "off" : null;
  if (level && !/--thinking(\s|=|$)/.test(base)) return `${base}${extension} --thinking ${level}`;
  return `${base}${extension}`;
}

/**
 * Resolve the cwd that session side channels (fork / query) must use, mirroring
 * the engine's precedence (execute.js:838-842). Side channels must query the
 * run's ACTUAL cwd: storedParams.cwd is the PREVIOUS run's persisted cwd and
 * goes stale on a workspace move (e.g. adopting git_worktree), whereas the
 * current run's authoritative cwd is resolved by the engine from
 * ctx.context.paperclipWorkspace + ctx.config.cwd.
 */

export function resolveSessionCwd(
  ctx: Pick<AdapterExecutionContext, "config" | "context">,
  storedParams: Record<string, unknown>,
): string {
  const ws = (ctx.context?.paperclipWorkspace ?? {}) as { cwd?: string; source?: string };
  const configuredCwd = firstNonEmptyString(ctx.config.cwd) ?? "";
  // engine: agent_home + a configured cwd overrides the workspace cwd
  const effectiveWsCwd = ws.source === "agent_home" && configuredCwd ? "" : (ws.cwd ?? "");
  return effectiveWsCwd || configuredCwd
    || (typeof storedParams.cwd === "string" && storedParams.cwd)
    || process.cwd();
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
 * This adapter declares `supportsLocalAgentJwt: true` (./index.ts), so every
 * run carries a run-scoped Paperclip token, injected as `PAPERCLIP_API_KEY`.
 *
 * That makes engine warm-handle reuse unsafe. The engine writes the token into
 * the child environment only when it SPAWNS the child (pinned acpx-engine
 * `execute.js:1014-1015`), a warm hit reuses the running process without
 * re-spawning it (`execute.js:2608-2612, 2739`; `sessionOptions.env` is passed
 * only when a session has to be established, `2696,2726`), and the pinned
 * engine drops a warm handle for neither a run token nor run-scoped MCP servers
 * (contract HEAD does: `execute.ts:4448-4453`). A reused child would therefore
 * authenticate this run's work products and approval requests as an EARLIER
 * run — an audit-attribution error, not a slowdown. So `buildOmpAcpConfig`
 * pins `warmHandleIdleMs` to 0 for every run, and the executor reports a
 * dropped operator opt-in. The one exception is the fork run's own 50 ms pin,
 * which exists so the fork's resume can save and immediately close its handle.
 */
export const RUN_IDENTITY_ENABLED = true;

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
  bridge: string = bridgePath,
): Record<string, unknown> {
  const rawModel = firstNonEmptyString(config.model);
  const model = rawModel ? (resolveModel(rawModel) ?? rawModel) : undefined;
  const next: Record<string, unknown> = {
    ...config,
    agent: "custom",
    agentCommand: resolveOmpAgentCommand(config, bridge),
    mode: firstNonEmptyString(config.mode, config.acpMode) ?? DEFAULT_ACP_ENGINE_MODE,
    permissionMode:
      firstNonEmptyString(config.permissionMode, config.acpPermissionMode) ??
      DEFAULT_ACP_ENGINE_PERMISSION_MODE,
    nonInteractivePermissions:
      firstNonEmptyString(config.nonInteractivePermissions, config.acpNonInteractivePermissions) ??
      DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
    // Run identity pins warm reuse off for every run; the operator's value is
    // dropped, never merged (see RUN_IDENTITY_ENABLED). The fork branch below
    // re-pins 50 for its own single run, which is exempt by design.
    warmHandleIdleMs: 0,
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
  // The engine reads all four of these keys (execute.js:613-618) and forwards any
  // value as `key: "effort"`, which omp rejects — strip every one of them.
  delete next.effort;
  delete next.thinkingEffort;
  delete next.reasoningEffort;
  delete next.modelReasoningEffort;
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

/**
 * The omp minor this adapter is tested against (18.13.x, verified against
 * 18.13.1). The adapter compensates for that minor's engine behavior — the
 * session-key fingerprint, the permission-proxy coercion, `usage_update`'s
 * breakdown, `session/set_config_option`'s id set — so a different minor is
 * untested rather than "probably fine". `testEnvironment` enforces this and
 * `package.json`'s peerDependencies pins the same range; the upgrade-contract
 * test keeps the two from drifting.
 */
export const TESTED_OMP_MINOR = { major: 18, minor: 13 } as const;

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
  /** The build advertises ACP `session/list`, the read the snapshot depends on. */
  supportsSessionList?: boolean;
  /** Ids the handshake advertised; omp accepts only mode|model|thinking. */
  configOptionIds?: string[];
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

/**
 * Whether the agent's initialize result advertises ACP `session/list`. The
 * snapshot read has no host-wide fallback by design (see `queryOmpSessions`),
 * so an omp build without it silently produces no session-snapshot card — the
 * environment test is the only place that can say so up front. Unknown shape
 * counts as absent.
 */
function advertisesSessionList(initializeInfo: Record<string, unknown> | undefined): boolean {
  if (!initializeInfo || !("agentCapabilities" in initializeInfo)) return false;
  const capabilities = initializeInfo.agentCapabilities;
  if (typeof capabilities !== "object" || capabilities === null) return false;
  if (!("sessionCapabilities" in capabilities)) return false;
  const sessionCapabilities = capabilities.sessionCapabilities;
  if (typeof sessionCapabilities !== "object" || sessionCapabilities === null) return false;
  return "list" in sessionCapabilities && sessionCapabilities.list !== null;
}

export function probeOmpAcpSession(
  omp: { command: string; args?: string[]; env?: Record<string, string> },
  timeoutMs = 10_000,
): Promise<OmpAcpProbeResult> {
  return driveAcpSession(omp, [
    { method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } },
  ], timeoutMs).then((drive): OmpAcpProbeResult => {
    const supportsSessionList = advertisesSessionList(drive.initializeInfo);
    if (!drive.ok) {
      return { ok: false, protocolVersion: drive.protocolVersion, supportsSessionList, error: drive.error };
    }
    const response = drive.responses[0];
    if (response?.error) {
      return { ok: false, supportsSessionList, error: `ACP error on request id ${response.id}: ${response.error.message}` };
    }
    const options = Array.isArray(response?.result?.configOptions)
      ? (response.result?.configOptions as Array<Record<string, unknown>>)
      : [];
    const model = options.find((o) => o.id === "model") as { currentValue?: unknown } | undefined;
    return {
      ok: true,
      protocolVersion: 1,
      currentModel: typeof model?.currentValue === "string" ? model.currentValue : undefined,
      supportsSessionList,
      configOptionIds: options
        .map((option) => (typeof option.id === "string" ? option.id : ""))
        .filter((id) => id.length > 0),
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
> & {
  /**
   * The extension artifact the run child is told to load. Defaults to the
   * package's `dist/paperclip-bridge.js`; a test seam for the fail-closed
   * availability check (and for an install that relocates `dist`).
   */
  bridgePath?: string;
};
type OmpAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

/**
 * Endpoint of the run-scoped connection-tools MCP server Paperclip offered this
 * run, or null when it offered none.
 *
 * `runtimeTools` ships at Paperclip contract HEAD (adapter-utils types.ts:273,
 * passed to `adapter.execute()` at runtime-execution.ts:832) but is absent from
 * the pinned 2026.824.1 declaration that `tsc` compiles against, so the member
 * is narrowed from the boundary value rather than asserted on the context. A
 * server that never sets it simply reads as null. Only the endpoint is read;
 * the bearer token in the same object must never enter a log, an event or a
 * work product.
 */
function connectionToolsEndpoint(ctx: AdapterExecutionContext): string | null {
  if (!("runtimeTools" in ctx)) return null;
  const tools: unknown = ctx.runtimeTools;
  if (typeof tools !== "object" || tools === null || !("mcpEndpoint" in tools)) return null;
  const endpoint = tools.mcpEndpoint;
  return typeof endpoint === "string" && endpoint.trim() !== "" ? endpoint.trim() : null;
}

export function createOmpAcpExecutor(options: OmpAcpExecutorOptions = {}): OmpAcpExecutor {
  const { bridgePath: bridgeOverride, ...engineOptions } = options;
  const bridge = bridgeOverride ?? bridgePath;
  let executor: OmpAcpExecutor | null = null;
  return async (ctx) => {
    // Fail closed: broker credentialMode demands a resolved broker url+token.
    // Return before any engine work so a misconfigured agent never runs a
    // half-configured session.
    const credErr = validateCredentialMode(ctx.config);
    if (credErr) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "omp_config_error", errorMessage: credErr };
    }
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
    if (scopeErr) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "omp_config_error", errorMessage: scopeErr };
    }
    // Plan mode is a config error, not a warn: this adapter declares no
    // elicitation/form capability, so omp would auto-approve the plan and the
    // approval step plan mode exists for would be gone (see validatePlanMode).
    const planErr = validatePlanMode(ctx.config);
    if (planErr) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "omp_config_error", errorMessage: planErr };
    }
    // deny-all is answered by the engine's permission proxy, which the bridge
    // cannot override; pairing it with scoped/rewritten tool rules describes a
    // run that cannot happen. Fail at config time (see validateGovernanceGate).
    const gateErr = validateGovernanceGate(ctx.config);
    if (gateErr) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "omp_config_error", errorMessage: gateErr };
    }
    // Retry knobs are an enum omp validates by DISCARDING: an unknown
    // `fallbackOn` reads back as `any` with only a startup warning nobody on
    // this lane sees. Refuse the run instead of writing a file that does nothing.
    const retryKnobErr = validateRetryFallbackConfig(ctx.config);
    if (retryKnobErr) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "omp_config_error", errorMessage: retryKnobErr };
    }
    const preparedScope = await prepareSessionScope(ctx.config, {
      companyId: ctx.agent.companyId, agentId: ctx.agent.id,
    });
    if (!preparedScope.ok) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "omp_config_error", errorMessage: preparedScope.error };
    }
    const sessionScope = preparedScope.prepared.scope;
    // The fenced config carries PI_CODING_AGENT_DIR (and the folded operator
    // config.yml) into the run child AND every side channel below; ompEnv
    // forwards the value it finds here.
    if (preparedScope.prepared.config !== ctx.config) ctx.config = preparedScope.prepared.config;
    for (const warning of preparedScope.prepared.warnings) {
      await ctx.onEvent?.({ eventType: "run.system", stream: "system", level: "warn", message: warning });
    }
    // Run-scoped control tools (v0.9). The adapter declares
    // `runtimeToolDelivery: "native_mcp"`, so Paperclip must hand the
    // connections server over as an ACP MCP server. Read the channel it
    // actually used: when the tools arrive as invocation-context data instead
    // (a Paperclip build that ignores the flag), nothing in this process can
    // serve them and they would disappear silently — the pre-v0.9 failure.
    // Resolved once per run so the count reported at the end is the same list
    // the engine received.
    const runtimeMcpServers = ctx.runtimeMcp?.getServers?.() ?? [];
    const connectionEndpoint = connectionToolsEndpoint(ctx);
    if (connectionEndpoint && !runtimeMcpServers.some((server) => server.url === connectionEndpoint)) {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: `omp connection tools are unavailable this run: Paperclip delivered no MCP server for the declared native_mcp channel (${runtimeMcpServers.length} runtime MCP server(s)), so connections_search/connection_request never reach the agent`,
      });
    }
    const intelDir = sessionIntelDir(ctx.agent.companyId, ctx.agent.id);
    // Resolvers backed by the cached `omp models ls` list (5-min TTL inside
    // models.ts, keyed by command+env so different agents' credentials never
    // share a catalog). Built on first actual run, inside this memoized
    // closure, so probe-only paths never spawn `omp models`. The fetch is
    // skipped when no model is configured — a broken/missing `omp` would
    // otherwise add up to 20s of uncached failure latency per run.
    const failoverOverlay = await materializeFailoverOverlay(ctx.config, intelDir);
    const failoverOverlayPath =
      failoverOverlay.status === "ok" ? failoverOverlay.path : null;
    if (failoverOverlay.status === "error") {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: `omp failover overlay write failed: ${failoverOverlay.error}; continuing without PI_CONFIG_FILES`,
      });
    }
    const sideChannelEnv = ompEnv({ config: ctx.config, overlayPath: failoverOverlayPath });
    const ompTokens = resolveOmpAgentCommand(ctx.config, bridge).split(/\s+/);
    // The resolved agent command may carry trailing flags (e.g. `--thinking
    // medium`). Locate `acp` by index so trailing tokens are never confused
    // with the base command.
    const acpIdx = ompTokens.indexOf("acp");
    const base = acpIdx >= 0 ? ompTokens.slice(0, acpIdx) : ompTokens;
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
    // Lazy-skill bridge: when skillsAsTools is on, materialize the skills
    // manifest and hand its path to the run child via
    // PAPERCLIP_SKILLS_MANIFEST so the bundled bridge extension
    // (dist/paperclip-bridge.js) registers each desired skill as an on-demand
    // native tool. The env MUST be set before buildOmpAcpConfig runs below so
    // resolveOmpAgentCommand sees it and appends --extension <bridgePath>
    // (which, like --thinking, rotates the session fingerprint). A
    // whitespace-bearing bridge path would break the adapter's naive /\s+/
    // token split, so warn and fall back to prose injection instead.
    const skillsAsToolsOn = ctx.config.skillsAsTools === true || ctx.config.skillsAsTools === "true";
    let bridgeActive = false;
    if (skillsAsToolsOn) {
      const bridgeMode = resolveBridgeRunMode(bridge);
      if (bridgeMode.kind === "whitespace") {
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system", level: "warn",
          message: bridgeMode.warn,
        });
      } else {
        const manifest = await materializeSkillManifest(ctx.config, intelDir, moduleDir);
        if (manifest) {
          // Do not clobber existing env keys — fold the manifest var in.
          ctx.config.env = { ...(ctx.config.env ?? {}), PAPERCLIP_SKILLS_MANIFEST: manifest };
          bridgeActive = true;
        }
      }
    }
    // Governance substrate (v0.8): when the operator sets governancePolicy AND
    // that policy carries a rule the bridge can enforce, materialize it into the
    // agent's state dir and hand the path to the run child via
    // PAPERCLIP_GOVERNANCE_MANIFEST. That env arms the --extension append, and
    // the armed bridge — through the governance overlay folded below — is what
    // may take the run's single permission gate. An unparseable document warns
    // and the run proceeds ungoverned rather than dying on a policy typo.
    const governanceManifest = await materializeGovernanceManifest(
      ctx.config,
      intelDir,
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
      const artifactError = await bridgeArtifactError(bridge);
      if (artifactError) {
        return {
          exitCode: 1, signal: null, timedOut: false,
          errorCode: "omp_governance_unavailable", errorMessage: artifactError,
        };
      }
    }
    // Governance is ARMED only when the policy really reached a bridge that will
    // really load: a manifest path AND a whitespace-free extension path (the
    // adapter's naive /\s+/ command tokenizer cannot carry the flag otherwise).
    // Anything less and the single gate must NOT move: `approvalMode: yolo`
    // switches off omp's own permission gate, so emitting it unarmed leaves the
    // run with no gate at all and no guardrail, budget or approval rule in force.
    const governanceArmed = isGovernanceArmed(governanceManifest, bridge);
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
    // Endpoint routing (v0.8 T4): approvedEndpoints becomes omp's declarative
    // disabledProviders, computed as the catalog complement minus every provider
    // this run must keep. It rides in its OWN overlay file, folded only into the
    // RUN child's PI_CONFIG_FILES: `disabledProviders` filters `omp models ls`,
    // and the side channels above read the failover overlay — if routing keys
    // lived there, our own filter would shrink the catalog the complement is
    // computed from and the disabled set would oscillate between runs. Cold
    // children (default warmHandleIdleMs 0) re-read the file every run, so
    // changing approvedEndpoints takes effect on the next run.
    const rawModel = firstNonEmptyString(ctx.config.model);
    const governanceOverlay = await materializeGovernanceOverlay(
      ctx.config,
      intelDir,
      {
        models,
        configuredModel: rawModel ? (resolveModel(rawModel) ?? rawModel) : null,
        // The gate relaxation rides the armed bridge and nothing else: an
        // unarmed run keeps omp's own approval behavior and only routes.
        armed: governanceArmed,
      },
      (message) => ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn", message,
      }),
    );
    const governanceOverlayPath =
      governanceOverlay.status === "ok" ? governanceOverlay.path : null;
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
    // Spend that can stop: forward the operator's soft per-session budget as
    // omp's own session cost cap. The bridge cap only refuses tool calls, so a
    // turn that never reaches it (or a subagent with its own copy) can spend
    // past it; omp's CostGate refuses the next model request for the whole
    // session tree. Its own overlay file keeps the path stable across cap
    // changes, so editing the number does not rotate the session.
    const parsedGovernance = parseGovernancePolicy(ctx.config.governancePolicy);
    const budgetOverlay = await materializeBudgetOverlay(
      parsedGovernance.kind === "ok" ? parsedGovernance.policy.budgetCapUsd : undefined,
      intelDir,
    );
    const budgetOverlayPath = budgetOverlay.status === "ok" ? budgetOverlay.path : null;
    if (budgetOverlay.status === "error") {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: `omp budget overlay write failed: ${budgetOverlay.error}; the run continues without omp's hard cost cap (the bridge's soft cap still applies)`,
      });
    }
    const config = buildOmpAcpConfig(ctx.config, resolveModel, resolveCost, bridge);
    // The thinking level rides its own overlay (fixed path, so an edit never
    // rotates the session). Run-child only: no side channel reads a level.
    const thinkingOverlay = await materializeThinkingOverlay(ctx.config, intelDir);
    const thinkingOverlayPath = thinkingOverlay.status === "ok" ? thinkingOverlay.path : null;
    if (thinkingOverlay.status === "error") {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: `omp thinking overlay write failed: ${thinkingOverlay.error}; the run continues at whatever level omp resolves on its own`,
      });
    }
    // Fold every overlay this run owns into config BEFORE engineConfig is
    // derived: the fork branch rebuilds engineConfig as
    // { ...config, warmHandleIdleMs: 50 }, so an overlay added only to
    // engineConfig would be silently dropped by the fork spread — PI_CONFIG_FILES
    // must ride on `config` to survive it. The order is the precedence order:
    // operator file, then the failover chain, then governance routing, then the
    // budget thresholds, then the thinking level.
    const operatorPi =
      typeof (ctx.config.env as Record<string, unknown> | undefined)?.PI_CONFIG_FILES === "string"
        ? (ctx.config.env as Record<string, unknown>).PI_CONFIG_FILES as string
        : "";
    const mergedPi = [operatorPi, failoverOverlayPath, governanceOverlayPath, budgetOverlayPath, thinkingOverlayPath]
      .filter(Boolean)
      .join(path.delimiter);
    if (mergedPi) config.env = { ...(config.env ?? {}), PI_CONFIG_FILES: mergedPi };
    // Ephemeral skills: when the bridge is active, skill content is delivered
    // on demand via the registered native tools, so prose injection is skipped
    // (bridge and prose are mutually exclusive). Otherwise materialize the
    // merged instructions file (skills + user instructions) so the engine
    // injects it into this run. The merged file always carries the user's
    // content when present, so the path is set unconditionally whenever any
    // skill is desired; null leaves any existing instructionsFilePath
    // untouched.
    const instructionsFile = bridgeActive ? null : await materializeSkillsInstructions(ctx.config);
    if (instructionsFile) config.instructionsFilePath = instructionsFile;
    // --- v0.4 session runtime: directives, fork resume, rotation, snapshot ---
    const intel = readSessionIntelConfig(ctx.config);
    const intelState = await loadState(intelDir);
    const storedParams = (ctx.runtime.sessionParams ?? {}) as Record<string, unknown>;
    const storedSessionId = typeof storedParams.acpSessionId === "string" ? storedParams.acpSessionId : "";
    // omp keeps the level a session started with inside its transcript and
    // prefers it on resume (sdk.ts:2139-2146, agent-session.ts:12811-12835), so
    // a new level can only reach an existing session by starting a new one.
    // Arm the same rotation the thresholds use instead of leaving the edit
    // silently inert.
    const requestedThinking = requestedThinkingLevel(ctx.config);
    let thinkingRotateArmed = false;
    if (thinkingLevelChanged(intelState.lastThinking, storedSessionId, requestedThinking)) {
      const from = intelState.lastThinking?.level ?? "";
      intelState.pendingRotate = {
        reason: `thinking level changed from '${from === "" ? "omp default" : from}' to '${requestedThinking === "" ? "omp default" : requestedThinking}'`,
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
    if (previousScope !== sessionScope) {
      const previousSessionId = typeof storedParams.acpSessionId === "string"
        ? storedParams.acpSessionId
        : "";
      if (previousSessionId) {
        const where = sessionScope === "isolated"
          ? `this agent's own omp agent dir (${preparedScope.prepared.agentDir})`
          : "the host-wide omp agent dir";
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system", level: "warn",
          message: `omp sessionScope switched to '${sessionScope}': the previous session (${previousSessionId.slice(0, 12)}) stays where it was and will not be resumed, so this run starts a fresh session in ${where}`,
        });
      }
    }
    intelState.lastScope = sessionScope;
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
      const ompTokens = resolveOmpAgentCommand(ctx.config, bridge).split(/\s+/);
      const sideChannel = { command: ompTokens[0], args: ompTokens.slice(1), env: sideChannelEnv };
      // omp opens the fork at the CLIENT-SUPPLIED cwd and then switches to the
      // source session, which refuses the switch when its recorded cwd differs
      // (`agent-session.ts` SESSION_CWD_CHANGE_REJECTED → -32603). So the frame
      // must carry the SOURCE's cwd, not this run's. The lookup is a bounded,
      // unfiltered `session/list` (the source may live under another workspace)
      // and never leaves this function: only the cwd of the id the operator
      // already named is read.
      const source = await findOmpSessionCwd(sideChannel, directive.forkSourceId);
      const forkCwd = source.ok ? source.cwd : sessionCwd;
      if (!source.ok) {
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system", level: "warn",
          message: `omp fork source session ${directive.forkSourceId} could not be located (${source.error}); `
            + `forking with this run's cwd (${sessionCwd}) — omp rejects the fork if the source recorded a different one`,
        });
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
      if (thinkingRotateArmed) {
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system", level: "info",
          message: `omp ${directive.reason}: a resumed session keeps the level it stored, so this run starts a fresh session to apply the new one`,
        });
      }
    }

    // The warm pin in buildOmpAcpConfig is silent in the engine, so report a
    // dropped operator opt-in once per run — a dead knob must never look live.
    // A fork run is exempt: its engineConfig carries the per-run 50 ms pin.
    const requestedWarmIdleMs = Number(
      ctx.config.warmHandleIdleMs ?? ctx.config.acpWarmHandleIdleMs ?? 0,
    );
    if (Number(engineConfig.warmHandleIdleMs ?? 0) === 0
      && Number.isFinite(requestedWarmIdleMs) && requestedWarmIdleMs > 0) {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: `omp warm-handle reuse pinned to 0 for this run: run identity is enabled and the engine keeps the spawning run's PAPERCLIP_API_KEY in a reused child, so a warm hit would authenticate this run's work as an earlier run; remove warmHandleIdleMs to stop this warning`,
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
      ? { ...ctx.runtime, sessionParams: { ...storedParams, acpSessionId: forkedSessionId } }
      : forceFreshOverride
        ? { ...ctx.runtime, sessionParams: {} }
        : null;

    // Lazy by design: the acpx engine (and its transitive CLI deps) must not
    // load until a run actually executes, so probe-only imports stay cheap.
    // Created only now, after every fail-closed gate (config, governance
    // artifact, scope): a refused run must not even construct the engine.
    if (!executor) {
      const { createAcpxEngineExecutor } = await import(
        "@paperclipai/adapter-utils/acpx-engine/execute"
      );
      executor = createAcpxEngineExecutor({
        ...engineOptions,
        adapterType: "omp_local",
        moduleDir,
        packageRootDir,
        resolveBillingIdentity: options.resolveBillingIdentity ?? resolveOmpBillingIdentity,
      });
    }
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
    // Record the level this session was started with. Adopted whenever the
    // session id changed under us (a rotation, a fork, or an engine-side fresh
    // start): whatever created it requested the level in force right now.
    if (usedSessionId && intelState.lastThinking?.sessionId !== usedSessionId) {
      intelState.lastThinking = { sessionId: usedSessionId, level: requestedThinking };
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

    // A real issue id only: a non-issue wake (a chat wake carries
    // `taskId: "chat-1"`) would 404 every work-product POST while the run
    // reports success, so those runs post nothing at all.
    const issueId = resolveWorkProductIssueId(ctx.context ?? {});
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
      const ompTokens = resolveOmpAgentCommand(ctx.config, bridge).split(/\s+/);
      const query = await queryOmpSessions(
        { command: ompTokens[0], args: ompTokens.slice(1), env: sideChannelEnv },
        { cwd: sessionCwd, diagnostic: intel.diagnostic },
      );
      if (query.ok && query.hostDiagnostic) {
        const host = query.hostDiagnostic;
        await ctx.onEvent?.({
          eventType: "run.system", stream: "system",
          level: host.error ? "warn" : "info",
          // Counts only: ids, cwds and titles never leave the host, so the
          // diagnostic cannot become a cross-tenant browser.
          message: host.error
            ? `omp host-wide listing diagnostic failed: ${host.error}`
            : `omp host-wide listing (diagnostic, sessionScope '${sessionScope}'): ${host.sessionCount ?? "?"} sessions across ${host.projectCount ?? "?"} projects visible to ${sessionScope === "isolated" ? "this agent's own omp agent dir" : "every omp agent on this host"} — ids, cwds and titles withheld`,
        });
      }
      if (query.ok) {
        const digest = snapshotDigest(
          sessionSnapshotDigestInput(query.snapshot, usedSessionId),
        );
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
    // Uses the list resolved at run start, so the evidence matches what the
    // engine received rather than a second read of the accessor.
    if (runtimeMcpServers.length > 0) sessionRuntime.mcpServerCount = runtimeMcpServers.length;
    const resultJson = Object.keys(sessionRuntime).length > 0
      ? { ...(result.resultJson ?? {}), sessionRuntime }
      : result.resultJson;
    // Cost truth: omp's catalog status decides whether the reported amount is
    // an estimate, a declared zero, or unpriced. `result.model` is the model
    // the engine asked for; the configured (normalized) value is the same in
    // practice and the fallback keeps a receipt when the engine omits it.
    const attributedModel = result.model ?? (rawModel ? (resolveModel(rawModel) ?? rawModel) : null);
    const attribution = attributeRunCost({
      pricingStatus: models.find((m) => m.id === attributedModel)?.pricingStatus ?? null,
      costUsd: result.costUsd,
      usage: result.usage,
      usageBasis: result.usageBasis,
      model: attributedModel,
      failoverConfigured: parseFallbackChain(ctx.config).length > 0,
    });
    for (const warning of attribution.warnings) {
      await ctx.onEvent?.({ eventType: "run.system", stream: "system", level: "info", message: warning });
    }
    // `costUsd` is the one field the result already declares (nullable there),
    // so only the added accounting fields ride the intersection.
    const final: AdapterExecutionResult & Omit<RunCostFields, "costUsd"> = {
      ...withRetryChain(resultJson ? { ...result, resultJson } : result, chain),
      ...attribution.fields,
    };
    return final;
  };
}
