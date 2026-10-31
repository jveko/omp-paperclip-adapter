import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { bridgePath, moduleDir, packageRootDir } from "./adapters/acp/launch.js";
import { buildRunPlan } from "./run/run-plan.js";
import { executePlan } from "./run/execute.js";
import { createHostTransport, lookupHostSessionCwd, type ManagedRun } from "./run/host-transport.js";

/**
 * The adapter's public surface and composition root.
 *
 * The pieces of a run live beside their concern: `adapters/acp/launch.ts` (the
 * command line, the extension artifact, the run-child config),
 * `adapters/acp/client.ts` (the initialize-only reads), `ports/side-channel.ts`
 * + its ACP implementation (the read lane), `run/overlays.ts` (one fixed-name
 * settings writer), `run/run-plan.ts` (every pre-transport decision) and
 * `run/execute.ts` (the transport call and the run's evidence). This file
 * re-exports those names unchanged — existing imports and the
 * `vi.mock("./acp.js")` seams keep resolving — and composes the plan with the
 * instance supervisor's transport.
 *
 * The ACP surface stays a probe lane only (`session/list`, `_omp/*`,
 * `session/fork`, model discovery, the environment probe); no run executes
 * over it.
 */

export {
  DEFAULT_OMP_COMMAND, packageRootDir, bridgePath, shouldAppendBridgeExtension,
  resolveBridgeRunMode, isGovernanceArmed, bridgeArtifactError, resolveOmpAgentCommand,
  resolveSessionCwd, buildRunChildConfig, deriveDefaultTimeoutSec, RUN_IDENTITY_ENABLED,
  parseOmpVersion, TESTED_OMP_MINORS,
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

/** Starts a run child. */
export type OmpAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

export interface OmpAcpExecutorOptions {
  /**
   * The extension artifact the run child is told to load. Defaults to the
   * package's `dist/paperclip-bridge.js`; a test seam for the fail-closed
   * availability check (and for an install that relocates `dist`).
   */
  bridgePath?: string;
  /** `dist/omp-host.js`, resolved by the caller in tests; shipped path by default. */
  hostScript?: string;
}

/**
 * Compose the run: build the plan, refuse if it refused, then execute it
 * through the instance supervisor.
 *
 * The supervisor transport is created lazily on the first run that reaches
 * execution — after every fail-closed gate (config, governance artifact, scope)
 * — so a refused run never connects to the host.
 */
export function createOmpAcpExecutor(options: OmpAcpExecutorOptions = {}): OmpAcpExecutor {
  const bridge = options.bridgePath ?? bridgePath;
  let hostTransport: ManagedRun | null = null;
  return async (ctx) => {
    const planned = await buildRunPlan(ctx, {
      bridge,
      moduleDir,
      hostSessionCwd: (sessionId: string) => lookupHostSessionCwd(sessionId),
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
    hostTransport ??= createHostTransport({
      bridge,
      ...(options.hostScript !== undefined ? { hostScript: options.hostScript } : {}),
    });
    const transport = hostTransport;
    const plan = planned.plan;
    return executePlan(plan, (merged) => transport(merged, plan));
  };
}
