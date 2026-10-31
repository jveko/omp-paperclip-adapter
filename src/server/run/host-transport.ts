import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AdapterExecutionContext, AdapterExecutionResult, AdapterRuntimeEvent,
} from "@paperclipai/adapter-utils";
import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import { HostClient, HostUnavailableError } from "../../host/client.js";
import type {
  Credentials, HostReply, Manifests, RunAcceptedFrame, RunBeginFrame, RunEventFrame,
} from "../../host/protocol.js";
import { buildWorkerArgv, buildWorkerEnv } from "../../host/worker.js";
import { resolveSteering, resolveSubagentObservability } from "../session-directives.js";
import { sessionLeaseKey } from "../session-lease.js";
import { firstNonEmptyString, packageRootDir } from "../adapters/acp/launch.js";
import { resolveOmpBillingIdentity } from "./billing.js";
import { buildManagedPrompt } from "./prompt.js";
import type { RunPlan } from "./run-plan.js";

/**
 * The managed lane's transport: the adapter as a thin translator over the
 * instance supervisor's Unix socket.
 *
 * It sends the run plan's resolved facts (worker argv/env, prompt, credentials,
 * manifests, limits), relays `run.event` frames onto the adapter's own sinks,
 * and returns the supervisor's settle result. It is the only way a run starts a
 * child: there is no second prompt path to fall back to.
 */

export interface HostTransportOptions {
  /** `dist/paperclip-bridge.js`, already resolved by the composition root. */
  bridge: string;
  rootDir?: string;
  /** `dist/omp-host.js`; defaults to the package's shipped artifact. */
  hostScript?: string;
  cancelGraceMs?: number;
  connectTimeoutMs?: number;
}

const RUN_LEASE_TTL_MS = 90_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

interface BridgeHash {
  key: string;
  value: string;
}

let bridgeHashCache: BridgeHash | null = null;

/** sha256 of the extension artifact, cached by path+mtime+size. */
async function bridgeHash(file: string): Promise<string> {
  try {
    const info = await fs.stat(file);
    const key = `${file}:${info.mtimeMs}:${info.size}`;
    if (bridgeHashCache !== null && bridgeHashCache.key === key) return bridgeHashCache.value;
    const value = createHash("sha256").update(await fs.readFile(file)).digest("hex").slice(0, 16);
    bridgeHashCache = { key, value };
    return value;
  } catch {
    return "missing";
  }
}

function configuredTimeoutMs(config: Record<string, unknown>): number | null {
  const raw = config.timeoutSec ?? config.acpTimeoutSec;
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" && raw.trim() !== ""
      ? Number(raw)
      : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

/**
 * `ctx.signal` is declared optional; the runtime value can still be anything at
 * a plugin boundary, so keep the instanceof gate.
 */
function abortSignalOf(ctx: AdapterExecutionContext): AbortSignal | null {
  const signal: unknown = ctx.signal;
  return signal instanceof AbortSignal ? signal : null;
}

/**
 * The run's usage checkpoint sink. The receipt crosses a JSON boundary (the
 * supervisor serialises it), so it is forwarded as the wire record it is and
 * validated by the server, not re-typed here.
 */
function usageSink(ctx: AdapterExecutionContext): ((receipt: Record<string, unknown>) => Promise<void>) | null {
  const candidate = ctx.onUsage;
  return typeof candidate === "function"
    ? (candidate as unknown as (receipt: Record<string, unknown>) => Promise<void>)
    : null;
}

function spawnEnvLines(env: Record<string, string>): Record<string, string> {
  // Only stable values: the run-scoped Paperclip ids (RUN_ID/TASK_ID/wake) are
  // spawn-time facts that would go stale in a warm worker, so they stay out.
  const lines: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "PAPERCLIP_RUN_ID" || key === "PAPERCLIP_TASK_ID" || key.startsWith("PAPERCLIP_WAKE_")) continue;
    lines[key] = value;
  }
  return lines;
}

function issueIdOf(ctx: AdapterExecutionContext): string | null {
  const context = ctx.context ?? {};
  const candidate = firstNonEmptyString(context.issueId) ?? firstNonEmptyString(context.taskId);
  return candidate ?? null;
}

function manifestsOf(plan: RunPlan): Manifests {
  const env = (plan.runChildConfig.env ?? {}) as Record<string, unknown>;
  const overlay = (kind: string): string | null =>
    plan.overlays.find((entry) => entry.kind === kind)?.path ?? null;
  const manifest = (key: string): string | null =>
    typeof env[key] === "string" && (env[key] as string) !== "" ? (env[key] as string) : null;
  return {
    skills: manifest("PAPERCLIP_SKILLS_MANIFEST"),
    governance: manifest("PAPERCLIP_GOVERNANCE_MANIFEST"),
    budget: overlay("budget"),
    failover: overlay("failover"),
    thinking: overlay("thinking"),
  };
}

/**
 * The run's connection-tools access. The bearer is forwarded to the supervisor
 * only — never to the worker, a log, an event or the ledger.
 */
function connectionToolsOf(ctx: AdapterExecutionContext): {
  endpoint: string;
  bearerToken: string;
  expiresAt: string | null;
  tools: string[];
} | null {
  const access = ctx.runtimeTools;
  if (typeof access !== "object" || access === null) return null;
  const endpoint = typeof access.mcpEndpoint === "string" ? access.mcpEndpoint.trim() : "";
  const bearerToken = typeof access.bearerToken === "string" ? access.bearerToken.trim() : "";
  if (endpoint === "" || bearerToken === "") return null;
  return {
    endpoint,
    bearerToken,
    expiresAt: typeof access.expiresAt === "string" ? access.expiresAt : null,
    tools: Array.isArray(access.tools)
      ? (access.tools as unknown[]).filter((name): name is string => typeof name === "string")
      : [],
  };
}

function credentialsOf(ctx: AdapterExecutionContext, env: Record<string, string>): Credentials {
  const apiUrl = env.PAPERCLIP_API_URL
    ?? firstNonEmptyString(process.env.PAPERCLIP_API_URL)
    ?? buildPaperclipEnv(ctx.agent).PAPERCLIP_API_URL;
  return {
    apiUrl,
    apiKey: ctx.authToken ?? "",
    companyId: ctx.agent.companyId,
    taskId: firstNonEmptyString(ctx.context?.taskId) ?? null,
    issueId: issueIdOf(ctx),
  };
}

function relayEvent(ctx: AdapterExecutionContext, frame: RunEventFrame): void {
  const payload = frame.payload;
  switch (frame.kind) {
    case "omp.log": {
      const stream = payload.stream === "stdout" ? "stdout" : "stderr";
      void ctx.onLog(stream, typeof payload.chunk === "string" ? payload.chunk : "");
      return;
    }
    case "omp.usage": {
      const sink = usageSink(ctx);
      if (sink !== null) void sink(payload);
      return;
    }
    case "run.system": {
      const event: AdapterRuntimeEvent = {
        eventType: "run.system",
        stream: "system",
        level: payload.level === "warn" || payload.level === "error" ? payload.level : "info",
        ...(typeof payload.message === "string" ? { message: payload.message } : {}),
        payload,
      };
      void ctx.onEvent?.(event);
      return;
    }
    case "acpx.tool_call": {
      const event: AdapterRuntimeEvent = {
        eventType: "acpx.tool_call",
        stream: "stdout",
        ...(typeof payload.toolName === "string" ? { message: payload.toolName } : {}),
        payload,
      };
      void ctx.onEvent?.(event);
      return;
    }
    case "omp.turn": {
      const event: AdapterRuntimeEvent = {
        eventType: "omp.turn",
        stream: "stdout",
        ...(typeof payload.text === "string" ? { message: payload.text } : {}),
        payload,
      };
      void ctx.onEvent?.(event);
      return;
    }
    case "omp.subagent": {
      // Bounded and content-free at the source (host/subagents.ts): the payload
      // carries ids, an agent name, a status and an optional redacted
      // description/summary — never prompt text, tool arguments or transcripts.
      const event: AdapterRuntimeEvent = {
        eventType: "omp.subagent",
        stream: "system",
        ...(typeof payload.agent === "string" && typeof payload.status === "string"
          ? { message: `${payload.agent} ${payload.status}` }
          : {}),
        payload,
      };
      void ctx.onEvent?.(event);
      return;
    }
  }
}

async function ensureHost(options: {
  rootDir?: string;
  hostScript: string;
  connectTimeoutMs: number;
}): Promise<HostClient> {
  try {
    return await HostClient.connect({ rootDir: options.rootDir, connectTimeoutMs: 2_000 });
  } catch (err) {
    if (!(err instanceof HostUnavailableError)) throw err;
  }
  const child = spawn(process.execPath, [options.hostScript, "serve"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + options.connectTimeoutMs;
  while (Date.now() < deadline) {
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 50);
    await tick.promise;
    try {
      return await HostClient.connect({ rootDir: options.rootDir, connectTimeoutMs: 1_000 });
    } catch {
      // The host may still be binding its socket, or another spawn won the lock.
    }
  }
  throw new HostUnavailableError(
    `the omp supervisor did not start within ${options.connectTimeoutMs}ms (${options.hostScript})`,
  );
}

/**
 * Deliver a steering message to a live managed run (used by the board/plugin
 * seam; the supervisor refuses when the run's `steering` is off). Never throws:
 * an unreachable host, an unknown run or a disabled flag all return `{ok:false}`.
 */
export async function steerManagedRun(input: {
  runId: string;
  message: string;
  kind?: "steer" | "follow_up";
  rootDir?: string;
}): Promise<{ ok: boolean; error?: string }> {
  let client: HostClient;
  try {
    client = await HostClient.connect({ rootDir: input.rootDir });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    client.send({
      id: `steer-${input.runId}-${Date.now()}`,
      type: "run.steer",
      runId: input.runId,
      message: input.message,
      kind: input.kind ?? "steer",
    });
    const reply = await client.waitFor(
      (frame) => frame.type === "run.steer.result" && frame.runId === input.runId,
      // Above the supervisor's own 30 s RPC request timeout: timing out first
      // would report a failure while the steer still lands.
      35_000,
    );
    if (reply.type !== "run.steer.result") return { ok: false, error: "unexpected supervisor reply" };
    return reply.ok ? { ok: true } : { ok: false, error: reply.error ?? "steering refused" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/**
 * Ask the supervisor which cwd it recorded for a session it ran. Null when the
 * host is not running or never ran that session (the caller falls back to the
 * ACP probe lane). Connect-only: the fork decision happens before a run starts,
 * so this must not spawn a supervisor.
 */
export async function lookupHostSessionCwd(
  sessionId: string,
  rootDir?: string,
): Promise<string | null> {
  let client: HostClient;
  try {
    client = await HostClient.connect({ rootDir, connectTimeoutMs: 1_000 });
  } catch {
    return null;
  }
  try {
    const id = `session-cwd-${Date.now()}`;
    client.send({ id, type: "probe", kind: "sessions", payload: { sessionId } });
    const reply = await client.waitFor(
      (frame) => frame.type === "probe.result" && frame.id === id,
      2_000,
    );
    if (reply.type !== "probe.result") return null;
    const payload = reply.payload;
    return payload.ok === true && typeof payload.cwd === "string" ? payload.cwd : null;
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export type ManagedRun = (
  ctx: AdapterExecutionContext,
  plan: RunPlan,
) => Promise<AdapterExecutionResult>;

/**
 * Build the managed transport. `executePlan` calls a `RunTransport` with one
 * argument, so the composition root binds the plan it just built:
 * `(merged) => managed(merged, plan)`.
 */
export function createHostTransport(options: HostTransportOptions): ManagedRun {
  const hostScript = options.hostScript ?? path.join(packageRootDir, "dist", "omp-host.js");
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return async (ctx: AdapterExecutionContext, plan: RunPlan): Promise<AdapterExecutionResult> => {
    const workerArgv = buildWorkerArgv(plan.runChildConfig, options.bridge);
    const env = {
      ...spawnEnvLines(buildPaperclipEnv(ctx.agent)),
      ...buildWorkerEnv(plan.runChildConfig),
    };
    const sessionKey = sessionLeaseKey(ctx.agent, ctx.runtime);
    const stored = (ctx.runtime.sessionParams ?? {}) as Record<string, unknown>;
    const storedSessionId = typeof stored.acpSessionId === "string" && stored.acpSessionId !== ""
      ? stored.acpSessionId
      : null;
    const rotate = plan.directive.kind === "forceFresh" || plan.directive.kind === "rotate";
    const resumedSession = !rotate && (plan.forkedSessionId !== null || storedSessionId !== null);
    const prompt = await buildManagedPrompt({
      ctx,
      instructionsFilePath: firstNonEmptyString(plan.runChildConfig.instructionsFilePath) ?? null,
      resumedSession,
      env,
      onLog: (stream, chunk) => ctx.onLog(stream, chunk),
    });
    const begin: RunBeginFrame = {
      id: `begin-${ctx.runId}`,
      type: "run.begin",
      runId: ctx.runId,
      agent: { id: ctx.agent.id, companyId: ctx.agent.companyId },
      sessionKey,
      cwd: plan.sessionCwd,
      session: {
        ompSessionId: rotate ? null : (plan.forkedSessionId ?? storedSessionId),
        forked: plan.forkedSessionId !== null,
      },
      cell: {
        argvHash: createHash("sha256").update([workerArgv.command, ...workerArgv.args].join("\u0000")).digest("hex").slice(0, 16),
        bridgeHash: await bridgeHash(options.bridge),
        agentDir: firstNonEmptyString(env.PI_CODING_AGENT_DIR) ?? null,
        model: firstNonEmptyString(plan.runChildConfig.model) ?? null,
        thinking: plan.requestedThinking === "" ? null : plan.requestedThinking,
        approval: firstNonEmptyString(ctx.config.approvalMode, ctx.config.permissionMode) ?? null,
      },
      worker: { command: workerArgv.command, args: workerArgv.args, env },
      prompt: prompt.prompt,
      credentials: credentialsOf(ctx, env),
      connectionTools: connectionToolsOf(ctx),
      manifests: manifestsOf(plan),
      limits: { timeoutMs: configuredTimeoutMs(ctx.config), runLeaseTtlMs: RUN_LEASE_TTL_MS },
      steering: resolveSteering(ctx.config) === "on",
      // The config gate already refused an unknown value; an unset key means
      // the managed lane's default (`summary`), applied by the supervisor.
      subagentObservability: resolveSubagentObservability(ctx.config) ?? "summary",
    };

    let client: HostClient;
    try {
      client = await ensureHost({ rootDir: options.rootDir, hostScript, connectTimeoutMs });
    } catch (err) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "omp_host_unavailable",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    const settled = Promise.withResolvers<AdapterExecutionResult>();
    const closed = Promise.withResolvers<AdapterExecutionResult>();
    const cancelRequested = { value: false };
    let spawnReported = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const finish = (result: AdapterExecutionResult) => settled.resolve(result);

    // EOF before `run.settled` means the supervisor died (or was killed): the
    // adapter reports it and never silently re-runs the prompt elsewhere.
    const stopWatchingClose = client.onClose(() => {
      closed.resolve({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "omp_host_unavailable",
        errorMessage: "the omp supervisor connection closed before the run settled",
      });
    });

    const unsubscribe = client.onFrame((frame: HostReply) => {
      if (frame.type === "run.event" && frame.runId === ctx.runId) {
        relayEvent(ctx, frame);
        return;
      }
      if (frame.type === "run.accepted" && frame.runId === ctx.runId) {
        reportSpawn(frame);
        return;
      }
      if (frame.type === "run.settled" && frame.runId === ctx.runId) {
        finish({ ...frame.result, ...resolveOmpBillingIdentity(ctx) });
        return;
      }
      if (frame.type === "error") {
        finish({
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "omp_host_protocol_error",
          errorMessage: `${frame.code}: ${frame.message}`,
        });
      }
    });

    function reportSpawn(frame: RunAcceptedFrame): void {
      if (spawnReported) return;
      spawnReported = true;
      void ctx.onSpawn?.({
        pid: frame.worker.pid,
        processGroupId: frame.worker.pgid,
        startedAt: frame.worker.startedAt,
      });
    }

    const cancel = () => {
      if (cancelRequested.value) return;
      cancelRequested.value = true;
      try {
        client.send({ id: `cancel-${ctx.runId}`, type: "run.cancel", runId: ctx.runId, reason: "operator" });
      } catch {
        finish({
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "omp_host_unavailable",
          errorMessage: "the omp supervisor connection closed before the cancel was sent",
        });
        return;
      }
      // Paperclip requires the adapter to settle before returning. The host
      // journals `cancel_unconfirmed` when its own abort does not settle in
      // time; this bound is the adapter's half of that contract.
      const grace = setTimeout(() => finish({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "omp_run_cancelled",
        errorMessage: `the run was cancelled and the omp supervisor did not confirm within ${cancelGraceMs}ms`,
      }), cancelGraceMs);
      grace.unref();
    };

    try {
      client.send({ id: `hello-${ctx.runId}`, type: "hello", v: 1, instanceId: "adapter", adapterVersion: "0.12.0" });
      await client.waitFor((frame) => frame.type === "hello_ok", 5_000).catch(() => {
        // An older/newer host that cannot say hello is still worth a begin; a
        // protocol mismatch will surface as a settled error instead.
      });
      heartbeat = setInterval(() => {
        if (cancelRequested.value) return;
        try {
          client.send({ id: `hb-${ctx.runId}`, type: "run.heartbeat", runId: ctx.runId });
        } catch {
          // The close handler below reports the transport failure.
        }
      }, Math.max(250, Math.floor(RUN_LEASE_TTL_MS / 3)));
      heartbeat.unref();
      client.send(begin);
      // Send the begin first: a cancel that names an unknown run is dropped by
      // the supervisor, so an already-aborted signal must arrive second.
      const signal = abortSignalOf(ctx);
      const onAbort = () => cancel();
      if (signal?.aborted === true) cancel();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const result = await Promise.race([settled.promise, closed.promise]);
      signal?.removeEventListener("abort", onAbort);
      return result;
    } catch (err) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "omp_host_unavailable",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearInterval(heartbeat);
      stopWatchingClose();
      unsubscribe();
      client.close();
    }
  };
}
