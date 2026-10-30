import { bridgePath, moduleDir, packageRootDir } from "./adapters/acp/launch.js";
import { buildRunPlan } from "./run/run-plan.js";
import { executePlan, type RunTransport } from "./run/execute.js";
import { createHostTransport, lookupHostSessionCwd } from "./run/host-transport.js";
import { resolveExecutionMode } from "./session-directives.js";

/**
 * The ACP lane's public surface and composition root.
 *
 * The pieces of a run live beside their concern: `adapters/acp/launch.ts` (the
 * command line, the extension artifact, the engine config), `adapters/acp/
 * client.ts` (the initialize-only reads), `ports/side-channel.ts` + its ACP
 * implementation (the read lane), `run/overlays.ts` (one fixed-name settings
 * writer), `run/run-plan.ts` (every pre-engine decision) and `run/execute.ts`
 * (the engine call and the run's evidence). This file re-exports those names
 * unchanged — existing imports and the `vi.mock("./acp.js")` seams keep
 * resolving — and composes the plan with the engine.
 */

export {
  DEFAULT_OMP_COMMAND, packageRootDir, bridgePath, shouldAppendBridgeExtension,
  resolveBridgeRunMode, isGovernanceArmed, bridgeArtifactError, resolveOmpAgentCommand,
  resolveSessionCwd, deriveDefaultTimeoutSec, configuredWarmHandleIdleMs, RUN_IDENTITY_ENABLED,
  buildOmpAcpConfig, parseOmpVersion, TESTED_OMP_MINORS,
} from "./adapters/acp/launch.js";
export type { BridgeRunMode } from "./adapters/acp/launch.js";

// The ACP side-channel client lives in adapters/acp/client.ts. Re-exported here
// unchanged: `acp.ts` stays the package's public surface, so existing imports
// (and the environment probe's `vi.mock("./acp.js")` seam) keep resolving.
export { driveAcpSession, probeOmpAcpSession } from "./adapters/acp/client.js";
export type {
  AcpDriveResult, AcpFrameRequest, AcpFrameResponse, OmpAcpProbeResult,
} from "./adapters/acp/client.js";

import { resolveOmpBillingIdentity } from "./run/billing.js";
export { resolveOmpBillingIdentity };
import { loadAcpxEngineExecutor, type AcpxEngineExecutorOptions, type OmpAcpExecutor } from "./adapters/acp/engine.js";

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
  /** `dist/omp-host.js`, resolved by the caller in tests; shipped path by default. */
  hostScript?: string;
};

/**
 * Compose the ACP lane: build the run plan, refuse if it refused, then execute
 * it against the acpx engine.
 *
 * The engine is created lazily on the first run that reaches execution — after
 * every fail-closed gate (config, governance artifact, scope) — so a refused
 * run never constructs it and probe-only imports stay cheap.
 */
export function createOmpAcpExecutor(options: OmpAcpExecutorOptions = {}): OmpAcpExecutor {
  const { bridgePath: bridgeOverride, hostScript, ...engineOptions } = options;
  const bridge = bridgeOverride ?? bridgePath;
  let executor: OmpAcpExecutor | null = null;
  // The managed lane is created lazily too, and its module graph deliberately
  // excludes the ACP engine: a managed run must not load it at all.
  let managed: ReturnType<typeof createHostTransport> | null = null;
  const ensureEngine = async (): Promise<OmpAcpExecutor> => {
    if (executor) return executor;
    executor = await loadAcpxEngineExecutor({
      ...engineOptions,
      resolveBillingIdentity: options.resolveBillingIdentity ?? resolveOmpBillingIdentity,
    });
    return executor;
  };
  return async (ctx) => {
    const planned = await buildRunPlan(ctx, {
      bridge,
      moduleDir,
      ...(resolveExecutionMode(ctx.config) === "managed"
        ? { hostSessionCwd: (sessionId: string) => lookupHostSessionCwd(sessionId) }
        : {}),
    });
    if (planned.kind === "refused") {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: planned.refusal.errorCode,
        errorMessage: planned.refusal.errorMessage,
      };
    }
    if (resolveExecutionMode(planned.plan.ctx.config) === "managed") {
      managed ??= createHostTransport({ bridge, ...(hostScript !== undefined ? { hostScript } : {}) });
      const hostTransport = managed;
      const plan = planned.plan;
      const transport: RunTransport = (merged) => hostTransport(merged, plan);
      return executePlan(plan, transport);
    }
    const engine = await ensureEngine();
    const transport: RunTransport = (merged) => engine(merged);
    return executePlan(planned.plan, transport);
  };
}
