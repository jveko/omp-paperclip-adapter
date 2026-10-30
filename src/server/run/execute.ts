import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { attributeRunCost, type RunCostFields } from "../cost-truth.js";
import { runWithFreshSessionRetry, withRetryChain, type RetryChainEntry } from "../retry.js";
import {
  bumpRunCounter, consumeToken, rotateIfTripped, snapshotDigest,
} from "../session-state.js";
import {
  buildSessionSnapshotWorkProduct, postWorkProduct, resolveWorkProductIssueId,
  sessionSnapshotDigestInput,
} from "../session-directives.js";
import {
  buildUsageWorkProduct, estimateCostPerHeartbeat, fetchBrokerUsage, usageDigest,
} from "../usage-report.js";
import { queryOmpSessions } from "../session-intel.js";
import { parseFallbackChain } from "../failover-config.js";
import { firstNonEmptyString, resolveOmpAgentCommand } from "../adapters/acp/launch.js";
import type { RunPlan } from "./run-plan.js";

/**
 * Execution, and only execution: the one place a run calls a transport, and
 * the one place its outcome is booked (session consumption, rotation counters,
 * usage/snapshot work products, cost attribution).
 *
 * The transport is a function, not a protocol: whatever starts the child is
 * handed the merged context and the plan's engine config. A second transport
 * plugs in here without touching the plan.
 */

/** Starts a run child. The ACP lane supplies the acpx engine. */
export type RunTransport = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

export async function executePlan(
  plan: RunPlan,
  transport: RunTransport,
): Promise<AdapterExecutionResult> {
  const { result, chain } = await runWithFreshSessionRetry(
    (runCtx) => {
      const merged = { ...plan.ctx, ...runCtx } as typeof plan.ctx;
      if (plan.runtimeOverride) merged.runtime = plan.runtimeOverride;
      return transport(merged);
    },
    plan.retry,
    plan.engineConfig,
  );
  const resultParams = (result.sessionParams ?? {}) as Record<string, unknown>;
  const usedSessionId = typeof resultParams.acpSessionId === "string" ? resultParams.acpSessionId : null;
  const nowIso = new Date().toISOString();
  await recordRunOutcome(plan, { result, resultParams, usedSessionId, nowIso });
  // A real issue id only: a non-issue wake (a chat wake carries
  // `taskId: "chat-1"`) would 404 every work-product POST while the run
  // reports success, so those runs post nothing at all.
  const issueId = resolveWorkProductIssueId(plan.ctx.context ?? {});
  if (plan.intel.usageReport && issueId) {
    await emitUsageReport(plan, { issueId, nowIso });
  }
  if (plan.intel.browser && issueId) {
    await emitSessionSnapshot(plan, { issueId, usedSessionId, nowIso });
  }
  return composeResult(plan, { result, chain, usedSessionId });
}

/**
 * Post-run bookkeeping: consumption (verified via the round-tripped
 * acpSessionId), rotation counters, then the usage append and one state write.
 */
async function recordRunOutcome(
  plan: RunPlan,
  input: {
    result: AdapterExecutionResult;
    resultParams: Record<string, unknown>;
    usedSessionId: string | null;
    nowIso: string;
  },
): Promise<void> {
  const { intelState, directive } = plan;
  const { usedSessionId, nowIso } = input;
  if (plan.forkTokenUsed) {
    if (usedSessionId && usedSessionId === plan.forkedSessionId) {
      intelState.forkConsumed = consumeToken(intelState.forkConsumed, plan.forkTokenUsed);
      // A successfully resumed fork is a fresh session under the same
      // sessionKey: a previously-tripped rotation must not discard it, and
      // the run count starts over.
      intelState.pendingRotate = null;
      intelState.runCounters = {};
    } else {
      await plan.ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: "omp fork directive did not take effect; it stays armed for the next run",
      });
    }
  }
  // Consumption semantics kept: force-fresh is consumed only when the
  // round-tripped id differs from the stored one (a fresh session was made).
  const freshSessionCreated = !!usedSessionId && usedSessionId !== plan.storedParams.acpSessionId;
  if (plan.freshTokenUsed && freshSessionCreated) {
    intelState.forceFreshConsumed = consumeToken(intelState.forceFreshConsumed, plan.freshTokenUsed);
  }
  if ((plan.freshTokenUsed || directive.kind === "rotate") && freshSessionCreated) {
    // The fresh session does NOT reset the fingerprint, so it must not reuse
    // the old counter: start the run count over and clear any armed rotation.
    intelState.runCounters = {};
    intelState.pendingRotate = null;
  }
  // Record the level this session was started with. Adopted whenever the
  // session id changed under us (a rotation, a fork, or an engine-side fresh
  // start). A fork is the exception: it rewrites the source transcript
  // wholesale, so the new session keeps the SOURCE's stored level and the run
  // child's overlay never reaches the fork side channel. Claiming the
  // requested level there would make every later run compare equal and the
  // operator's edit would never apply; carry the source's level when the
  // adapter ran that source, and leave it unknown when it did not.
  if (usedSessionId && intelState.lastThinking?.sessionId !== usedSessionId) {
    const level = directive.kind === "fork" && plan.forkedSessionId === usedSessionId
      ? (intelState.lastThinking?.sessionId === directive.forkSourceId ? intelState.lastThinking.level : null)
      : plan.requestedThinking;
    intelState.lastThinking = { sessionId: usedSessionId, level };
  }
  if (typeof input.resultParams.sessionKey === "string") {
    bumpRunCounter(intelState, input.resultParams.sessionKey, nowIso);
    if (rotateIfTripped(intelState, input.resultParams.sessionKey,
      { maxRuns: plan.intel.maxRuns, maxAgeHours: plan.intel.maxAgeHours }, nowIso)) {
      intelState.lastRotation = {
        reason: intelState.pendingRotate?.reason ?? "manual",
        at: nowIso,
        sessionKey: input.resultParams.sessionKey,
      };
    }
  }

  const runUsage = input.result.usage;
  if (runUsage && input.result.usageBasis !== "session_cumulative"
    && typeof runUsage.inputTokens === "number" && typeof runUsage.outputTokens === "number") {
    intelState.recentRuns = [...intelState.recentRuns, {
      at: nowIso,
      inputTokens: runUsage.inputTokens,
      outputTokens: runUsage.outputTokens,
      cachedInputTokens: typeof runUsage.cachedInputTokens === "number" ? runUsage.cachedInputTokens : 0,
    }].slice(-20);
  }
  await plan.persistState();
}

/** Broker usage (or cost-only in local mode), deduped by digest. */
async function emitUsageReport(
  plan: RunPlan,
  input: { issueId: string; nowIso: string },
): Promise<void> {
  const ctx = plan.ctx;
  const cfgEnv = (ctx.config.env ?? {}) as Record<string, unknown>;
  const brokerUrl = typeof cfgEnv.OMP_AUTH_BROKER_URL === "string" ? cfgEnv.OMP_AUTH_BROKER_URL : "";
  const brokerTok = typeof cfgEnv.OMP_AUTH_BROKER_TOKEN === "string" ? cfgEnv.OMP_AUTH_BROKER_TOKEN : "";
  const usageRes = ctx.config.credentialMode === "broker" && brokerUrl && brokerTok
    ? await fetchBrokerUsage({ url: brokerUrl, token: brokerTok })
    : { ok: true as const, reports: [] as unknown[] };
  const rawModel = firstNonEmptyString(ctx.config.model);
  const cost = estimateCostPerHeartbeat(
    plan.intelState.recentRuns,
    plan.resolveCost(rawModel ? (plan.resolveModel(rawModel) ?? rawModel) : ""),
  );
  const reports = usageRes.ok ? usageRes.reports : [];
  if (!usageRes.ok) {
    await ctx.onEvent?.({
      eventType: "run.system", stream: "system", level: "warn",
      message: `omp broker usage unavailable: ${usageRes.error}; emitting cost-only report`,
    });
  }
  const digest = usageDigest(reports, cost);
  if (digest !== plan.intelState.lastUsageDigest) {
    const posted = await postWorkProduct({ authToken: ctx.authToken, issueId: input.issueId },
      buildUsageWorkProduct({ reports, costPerHeartbeatUsd: cost, runId: ctx.runId, capturedAt: input.nowIso, brokerMode: ctx.config.credentialMode === "broker" }));
    if (posted.ok) {
      plan.intelState.lastUsageDigest = digest;
      await plan.persistState();
    } else {
      await ctx.onEvent?.({
        eventType: "run.system", stream: "system", level: "warn",
        message: `omp usage report emission failed: ${posted.error}`,
      });
    }
  }
}

/** The run's own session landscape (counts-only host diagnostic included). */
async function emitSessionSnapshot(
  plan: RunPlan,
  input: { issueId: string; usedSessionId: string | null; nowIso: string },
): Promise<void> {
  const ctx = plan.ctx;
  const ompTokens = resolveOmpAgentCommand(ctx.config, plan.bridge).split(/\s+/);
  const query = await queryOmpSessions(
    { command: ompTokens[0], args: ompTokens.slice(1), env: plan.sideChannelEnv },
    { cwd: plan.sessionCwd, diagnostic: plan.intel.diagnostic },
  );
  const sessionScope = plan.sessionScope;
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
      sessionSnapshotDigestInput(query.snapshot, input.usedSessionId),
    );
    if (digest !== plan.intelState.lastSnapshotDigest) {
      const posted = await postWorkProduct(
        { authToken: ctx.authToken, issueId: input.issueId },
        buildSessionSnapshotWorkProduct(query.snapshot, {
          currentSessionId: input.usedSessionId, runId: ctx.runId, capturedAt: input.nowIso,
        }),
      );
      if (posted.ok) {
        plan.intelState.lastSnapshotDigest = digest;
        await plan.persistState();
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

/**
 * Fold the run's evidence into the result: session-runtime cards, the retry
 * chain, and cost attribution.
 */
async function composeResult(
  plan: RunPlan,
  input: { result: AdapterExecutionResult; chain: RetryChainEntry[]; usedSessionId: string | null },
): Promise<AdapterExecutionResult> {
  const { result, chain } = input;
  // Surface session-runtime events in resultJson -> heartbeat_runs (the
  // authoritative evidence table; see spec 3.8).
  const sessionRuntime: Record<string, unknown> = {};
  if (plan.forkTokenUsed) {
    sessionRuntime.fork = {
      requested: plan.forkedSessionId,
      applied: input.usedSessionId === plan.forkedSessionId,
      activeSessionId: input.usedSessionId,
    };
  }
  if (plan.intelState.lastRotation) sessionRuntime.lastRotation = plan.intelState.lastRotation;
  // MCP servers forwarded to session/new are http-only (AdapterRuntimeMcpAccess has no
  // stdio/command discriminator), so a 0 count means "no http MCP servers", not "no MCP".
  // Uses the list resolved at run start, so the evidence matches what the
  // engine received rather than a second read of the accessor.
  if (plan.runtimeMcpServerCount > 0) sessionRuntime.mcpServerCount = plan.runtimeMcpServerCount;
  const resultJson = Object.keys(sessionRuntime).length > 0
    ? { ...(result.resultJson ?? {}), sessionRuntime }
    : result.resultJson;
  // Cost truth: omp's catalog status decides whether the reported amount is
  // an estimate, a declared zero, or unpriced. `result.model` is the model
  // the engine asked for; the configured (normalized) value is the same in
  // practice and the fallback keeps a receipt when the engine omits it.
  const attributedModel = result.model ?? (plan.rawModel ? (plan.resolveModel(plan.rawModel) ?? plan.rawModel) : null);
  const attribution = attributeRunCost({
    pricingStatus: plan.models.find((m) => m.id === attributedModel)?.pricingStatus ?? null,
    costUsd: result.costUsd,
    usage: result.usage,
    usageBasis: result.usageBasis,
    model: attributedModel,
    failoverConfigured: parseFallbackChain(plan.ctx.config).length > 0,
  });
  for (const warning of attribution.warnings) {
    await plan.ctx.onEvent?.({ eventType: "run.system", stream: "system", level: "info", message: warning });
  }
  // `costUsd` is the one field the result already declares (nullable there),
  // so only the added accounting fields ride the intersection.
  const final: AdapterExecutionResult & Omit<RunCostFields, "costUsd"> = {
    ...withRetryChain(resultJson ? { ...result, resultJson } : result, chain),
    ...attribution.fields,
  };
  return final;
}
