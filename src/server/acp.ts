import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
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
  listOmpModels,
  normalizeOmpModelId,
  type OmpModelCost,
} from "./models.js";

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
  return cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0
    ? 1800
    : 0;
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

export function probeOmpAcpSession(omp: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}, timeoutMs = 10_000): Promise<OmpAcpProbeResult> {
  return new Promise<OmpAcpProbeResult>((resolve) => {
    const child = spawn(omp.command, omp.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: omp.env ? { ...process.env, ...omp.env } : undefined,
    });
    // A child that exits immediately (e.g. a non-ACP binary) makes this write
    // fail with EPIPE; the close handler below already reports the failure.
    child.stdin.on("error", () => {});
    // Bounded tail of the agent's stderr, folded into failure diagnostics.
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
    const finish = (r: OmpAcpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(r);
    };
    timer = setTimeout(
      () => finish({ ok: false, error: `ACP handshake timed out after ${timeoutMs}ms${suffix()}` }),
      timeoutMs,
    );
    child.on("error", (err) => { finish({ ok: false, error: String(err) }); });
    child.on("close", () => { finish({ ok: false, error: `exited before handshake${suffix()}` }); });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { return; }
      if (typeof msg !== "object" || msg === null || !("id" in msg)) return;
      const { id } = msg;
      const err = "error" in msg ? msg.error : undefined;
      if ((id === 1 || id === 2) && typeof err === "object" && err !== null) {
        const detail =
          "message" in err && typeof err.message === "string" ? err.message : JSON.stringify(err);
        finish({ ok: false, error: `ACP error on request id ${id}: ${String(detail)}` });
        return;
      }
      const result = "result" in msg ? msg.result : undefined;
      if (typeof result !== "object" || result === null) return;
      if (id === 1 && "protocolVersion" in result) {
        const pv = Number(result.protocolVersion);
        if (pv !== 1) {
          finish({ ok: false, protocolVersion: pv, error: `unexpected protocolVersion ${pv}` });
          return;
        }
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new",
          params: { cwd: process.cwd(), mcpServers: [] } }) + "\n");
        return;
      }
      if (id === 2 && "configOptions" in result) {
        let model: { currentValue?: unknown } | undefined;
        for (const o of Array.isArray(result.configOptions) ? result.configOptions : []) {
          if (typeof o === "object" && o !== null && "id" in o && o.id === "model") {
            model = o;
            break;
          }
        }
        finish({
          ok: true,
          protocolVersion: 1,
          currentModel: typeof model?.currentValue === "string" ? model.currentValue : undefined,
        });
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n");
  });
}

type OmpAcpExecutorOptions = Omit<
  AcpxEngineExecutorOptions,
  "adapterType" | "moduleDir" | "packageRootDir"
>;
type OmpAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

export function createOmpAcpExecutor(options: OmpAcpExecutorOptions = {}): OmpAcpExecutor {
  let executor: OmpAcpExecutor | null = null;
  return async (ctx) => {
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
    // models.ts). Built on first actual run, inside this memoized closure, so
    // probe-only paths never spawn `omp models`. The fetch is skipped when no
    // model is configured — a broken/missing `omp` would otherwise add up to
    // 20s of uncached failure latency per run.
    const models = firstNonEmptyString(ctx.config.model) ? await listOmpModels() : [];
    const resolveModel = (model: string): string | null => normalizeOmpModelId(model, models);
    const resolveCost = (model: string): OmpModelCost | null =>
      models.find((m) => m.id === model)?.cost ?? null;
    return executor({
      ...ctx,
      config: buildOmpAcpConfig(ctx.config, resolveModel, resolveCost),
    });
  };
}
