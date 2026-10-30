import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
} from "@paperclipai/adapter-utils/acpx-engine/constants";
import { isFreeCost, type OmpModelCost } from "../../models.js";
import { validThinkingLevel } from "../../thinking-levels.js";

/**
 * ACP launch vocabulary: the command line an omp child is started with, the
 * extension artifact that rides it, and the engine config derived from the run
 * plan. Pure decisions only — nothing here spawns, writes or reads run state.
 *
 * `acp.ts` re-exports this module's public names unchanged, so it stays the
 * package's public surface while `run/` can depend on the launch rules without
 * importing the composition root back.
 */

export const DEFAULT_OMP_COMMAND = "omp";

/** `dist/server` — the directory the adapter resolves its bundled artifacts from. */
const launchDir = path.dirname(fileURLToPath(import.meta.url));
export const moduleDir = path.resolve(launchDir, "../..");
export const packageRootDir = path.resolve(launchDir, "../../../..");
export const bridgePath = path.join(packageRootDir, "dist", "paperclip-bridge.js");

export function firstNonEmptyString(...values: unknown[]): string | undefined {
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
 * This adapter declares `supportsLocalAgentJwt: true` (../index.ts), so every
 * run carries a run-scoped Paperclip token, injected as `PAPERCLIP_API_KEY`.
 *
 * A reused child keeps the token of the run that spawned it (the engine writes
 * it into the environment only at spawn), so reusing a handle under run
 * identity would authenticate this run's work products and approval requests
 * as an EARLIER run — an audit-attribution error, not a slowdown.
 *
 * The engine no longer needs this adapter to prevent that. From 2026.1023.0 the
 * settlement sequence makes the reuse decision itself: the host-lane candidate
 * carries `liveRunScopedCredentials: ["paperclip-run-scoped-api-key"]` and
 * `decideReuse` answers `{ kind: "discard", reason: "run-scoped credential
 * still valid" }` (`acpx-engine/settlement-sequence.js`), so a clean turn
 * close-and-relaunches rather than transferring the warm handle. The sandbox
 * lane saves only its staged files, which carry no credential.
 *
 * `buildOmpAcpConfig` therefore passes the operator's `warmHandleIdleMs`
 * through instead of overwriting it: the setting is honoured by the engine, and
 * the gate — not this adapter — is what keeps a credential-carrying handle from
 * being reused. `adapters/acp/warm-handle-settlement.test.ts` asserts the
 * discard against the real engine. The fork branch still re-pins 50 ms for its
 * own single run, which is what makes that run's handle savable at all.
 */
export const RUN_IDENTITY_ENABLED = true;

/**
 * The operator's warm-handle idle window. `warmHandleIdleMs` is the engine's
 * own key; `acpWarmHandleIdleMs` is this adapter's alias. Anything that is not
 * a positive finite number means "close each turn", which is also the engine's
 * default.
 */
export function configuredWarmHandleIdleMs(config: Record<string, unknown>): number {
  const raw = config.warmHandleIdleMs ?? config.acpWarmHandleIdleMs;
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" && raw.trim() !== ""
      ? Number(raw)
      : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
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
    // Passed through, not pinned: the engine's settlement gate discards a
    // handle that still carries this run's credential (see
    // RUN_IDENTITY_ENABLED above). Normalized so the alias and string forms
    // reach the engine as one number.
    warmHandleIdleMs: configuredWarmHandleIdleMs(config),
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
 * The omp minors this adapter is tested against, as a contiguous range:
 * 18.13.x (verified against the live 18.13.1 install) and 18.14.x
 * (source-audited against the 18.14.0 release, which changed
 * provider-qualified selector resolution — see resolveProviderQualifiedSelector).
 *
 * This is a claim, not the gate. `testEnvironment` reports a minor outside the
 * set as a WARNING that names these lines, and the capability probe (`../..
 * capabilities.ts`) is what decides whether a run's surfaces exist; only a
 * different major is an error. `package.json`'s peerDependencies declares the
 * same range, and the upgrade-contract test keeps the two from drifting.
 */
export const TESTED_OMP_MINORS = [
  { major: 18, minor: 13 },
  { major: 18, minor: 14 },
] as const;
