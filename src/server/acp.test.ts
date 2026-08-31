import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi,
} from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  buildOmpAcpConfig,
  createOmpAcpExecutor,
  deriveDefaultTimeoutSec,
  driveAcpSession,
  parseOmpVersion,
  probeOmpAcpSession,
  resolveOmpAgentCommand,
  resolveOmpBillingIdentity,
} from "./acp.js";
import { runWithFreshSessionRetry, withRetryChain } from "./retry.js";
import * as sessionState from "./session-state.js";
import { loadState, saveState, sessionIntelDir } from "./session-state.js";

const engineMocks = vi.hoisted(() => ({
  createAcpxEngineExecutor: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/acpx-engine/execute", () => ({
  createAcpxEngineExecutor: engineMocks.createAcpxEngineExecutor,
}));

function fakeEngine(result: Record<string, unknown>) {
  const executor = vi.fn(async (ctx: AdapterExecutionContext) => result);
  engineMocks.createAcpxEngineExecutor.mockReturnValue(executor);
  return executor;
}

function baseCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null },
    runtime: {
      sessionId: "old",
      sessionParams: { acpSessionId: "old", sessionKey: "sk", cwd: process.cwd(), configFingerprint: "f" },
      sessionDisplayId: "old", taskKey: "t",
    },
    config: {},
    context: { taskId: "issue-1" },
    onLog: async () => {},
    onEvent: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

describe("createOmpAcpExecutor session runtime wiring", () => {
  let tmpRoot: string;
  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "omp-acp-test-"));
  });
  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    engineMocks.createAcpxEngineExecutor.mockReset();
    // Each test starts from a pristine state dir: the shared tmpRoot would
    // otherwise leak fork/force-fresh consumption and snapshot digests across
    // tests (the fixture asserts on those state transitions).
    await rm(path.join(tmpRoot, "instances"), { recursive: true, force: true });
    vi.stubEnv("PAPERCLIP_HOME", tmpRoot);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-v04");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("fork run: overrides acpSessionId, injects warmHandleIdleMs 50, keeps env clean", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, sessionForkSourceId: "sess-a", sessionForkToken: "t1" },
    }));
    const merged = executorFn.mock.calls[0][0];
    expect(merged.runtime.sessionParams).toMatchObject({ acpSessionId: "fork-1" });
    expect(merged.config.warmHandleIdleMs).toBe(50);
    expect(merged.config.env?.OMP_PAPERCLIP_FRESH).toBeUndefined();
    expect(merged.config.env?.OMP_PAPERCLIP_RETRY).toBeUndefined();
  });

  it("fork still applies with broker env threaded to the side channel", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({ config: {
      command: `${process.execPath} ${fakeAcp}`,
      sessionForkSourceId: "sess-a", sessionForkToken: "t-broker",
      credentialMode: "broker", env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
    } }));
    expect(executorFn.mock.calls[0][0].runtime.sessionParams).toMatchObject({ acpSessionId: "fork-1" });
  });

  it("marks the fork token consumed only when the fork id round-trips", async () => {
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, sessionForkSourceId: "sess-a", sessionForkToken: "t1" },
    }));
    const state = await loadState(sessionIntelDir("co-1", "agent-1"));
    expect(state.forkConsumed).not.toContain("t1"); // warm handle won -> stays armed

    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } });
    // NOTE: a fresh executor per run — createOmpAcpExecutor memoizes the engine
    // executor in its closure, so reusing `run` would ignore the new fake result.
    const run2 = createOmpAcpExecutor();
    await run2(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, sessionForkSourceId: "sess-a", sessionForkToken: "t1" },
    }));
    const state2 = await loadState(sessionIntelDir("co-1", "agent-1"));
    expect(state2.forkConsumed).toContain("t1");
  });

  it("fork run with terminal failure: single attempt, no retry env bust, token consumed", async () => {
    const executorFn = fakeEngine({
      exitCode: 1, errorCode: "acpx_turn_failed",
      sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" },
    });
    const events: Array<{ message: string }> = [];
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, sessionForkSourceId: "sess-a", sessionForkToken: "t1" },
      onEvent: async (ev: { message: string }) => { events.push(ev); },
    }));
    // A terminal failure on a fork run must NOT trigger the fresh-session
    // retry loop (which would bust the fingerprint and orphan the fork).
    expect(executorFn).toHaveBeenCalledOnce();
    const merged = executorFn.mock.calls[0][0];
    expect(merged.config.env?.OMP_PAPERCLIP_RETRY).toBeUndefined();
    // Fork WAS resumed (sessionParams round-trips the forked id) regardless
    // of the turn outcome, so the token is consumed.
    const state = await loadState(sessionIntelDir("co-1", "agent-1"));
    expect(state.forkConsumed).toContain("t1");
    // No misleading "did not take effect" warning when the fork was resumed.
    expect(events.some((e) => e.message.includes("did not take effect"))).toBe(false);
  });

  it("fork failure: engine still invoked, warn event emitted, run does not throw", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "s1", sessionKey: "sk" } });
    const events: Array<{ level?: string; message: string }> = [];
    vi.stubEnv("FAKE_ACP_MODE", "forkerror");
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, sessionForkSourceId: "sess-a", sessionForkToken: "t1" },
      onEvent: async (ev: { level?: string; message: string }) => { events.push(ev); },
    }));
    // Degradation contract: a failed fork never fails the run.
    expect(executorFn).toHaveBeenCalledOnce();
    const forkWarn = events.find((e) => e.message.includes("omp fork directive failed"));
    expect(forkWarn).toBeTruthy();
    expect(forkWarn!.level).toBe("warn");
    expect(forkWarn!.message).toContain("cannot be forked");
  });

  it("force-fresh clears sessionParams (fingerprint-clean) exactly once", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "brand-new", sessionKey: "sk2" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}`, sessionForceFreshToken: "ff1" } }));
    // First run: runtimeOverride forces fresh — sessionParams empty (no
    // matching acpSessionId), and the env is untouched (no OMP_PAPERCLIP_FRESH).
    const merged1 = executorFn.mock.calls[0][0];
    expect(merged1.runtime.sessionParams).toEqual({});
    expect(merged1.config.env?.OMP_PAPERCLIP_FRESH).toBeUndefined();
    expect(merged1.config.env?.OMP_PAPERCLIP_RETRY).toBeUndefined();
    // The round-tripped id differs from the stored one -> token consumed.
    const state = await loadState(sessionIntelDir("co-1", "agent-1"));
    expect(state.forceFreshConsumed).toContain("ff1");
    // Second run: token consumed -> normal resume, no override.
    await run(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}`, sessionForceFreshToken: "ff1" } }));
    const merged2 = executorFn.mock.calls[1][0];
    expect(merged2.runtime.sessionParams).toMatchObject({ acpSessionId: "old" });
    expect(merged2.config.env?.OMP_PAPERCLIP_FRESH).toBeUndefined();
  });

  it("force-fresh consumption resets runCounters and clears a pending rotation", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "brand-new", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    // Seed a long-lived session's run history plus a tripped rotation.
    const dir = sessionIntelDir("co-1", "agent-1");
    const seeded = await loadState(dir);
    seeded.runCounters = { sk: { count: 42, firstRunAt: "2026-01-01T00:00:00.000Z" } };
    seeded.pendingRotate = { reason: "maxRuns", at: "2026-01-02T00:00:00.000Z" };
    await saveState(dir, seeded);
    await run(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}`, sessionForceFreshToken: "ff1" } }));
    const state = await loadState(dir);
    expect(state.forceFreshConsumed).toContain("ff1");
    // The fresh session starts a new run count (reset then bumped to 1, not 43).
    expect(state.runCounters.sk.count).toBe(1);
    expect(state.runCounters.sk.firstRunAt).not.toBe("2026-01-01T00:00:00.000Z");
    expect(state.pendingRotate).toBeNull();
  });

  it("successful fork supersedes a pending rotation and restarts the run count", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    const dir = sessionIntelDir("co-1", "agent-1");
    const seeded = await loadState(dir);
    seeded.runCounters = { sk: { count: 17, firstRunAt: "2026-01-01T00:00:00.000Z" } };
    seeded.pendingRotate = { reason: "maxRuns", at: "2026-01-02T00:00:00.000Z" };
    await saveState(dir, seeded);
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, sessionForkSourceId: "sess-a", sessionForkToken: "t1" },
    }));
    const state = await loadState(dir);
    expect(state.forkConsumed).toContain("t1");
    // Fork is a fresh session under the same sessionKey: the tripped rotation
    // must not discard it, and the run count starts over.
    expect(state.pendingRotate).toBeNull();
    expect(state.runCounters.sk.count).toBe(1);
  });

  it("compaction: pendingRotate from state forces fresh via sessionParams (fingerprint-clean)", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "brand-new", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    // Seed: a completed run that tripped the threshold leaves pendingRotate.
    const dir = sessionIntelDir("co-1", "agent-1");
    const seeded = await loadState(dir);
    seeded.pendingRotate = { reason: "maxRuns", at: new Date().toISOString() };
    await saveState(dir, seeded);
    await run(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}` } }));
    // runtimeOverride forces fresh (sessionParams empty); env untouched.
    const merged = executorFn.mock.calls[0][0];
    expect(merged.runtime.sessionParams).toEqual({});
    expect(merged.config.env?.OMP_PAPERCLIP_FRESH).toBeUndefined();
    expect(merged.config.env?.OMP_PAPERCLIP_RETRY).toBeUndefined();
    const state = await loadState(dir);
    expect(state.pendingRotate).toBeNull();
  });

  it("saveState failure: warn emitted, run still returns the engine result", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "brand-new", sessionKey: "sk" } });
    const events: Array<{ level?: string; message: string }> = [];
    const run = createOmpAcpExecutor();
    const saveSpy = vi.spyOn(sessionState, "saveState").mockRejectedValue(new Error("simulated disk full"));
    try {
      const result = await run(baseCtx({
        config: { command: `${process.execPath} ${fakeAcp}` },
        onEvent: async (ev: { level?: string; message: string }) => { events.push(ev); },
      }));
      // Degradation contract: a state-write error never fails a completed run.
      expect(executorFn).toHaveBeenCalledOnce();
      expect(result.exitCode).toBe(0);
      expect(result.sessionParams?.acpSessionId).toBe("brand-new");
      const warn = events.find((e) => e.message.includes("omp session intel state save failed"));
      expect(warn).toBeTruthy();
      expect(warn!.level).toBe("warn");
      expect(warn!.message).toContain("simulated disk full");
    } finally {
      saveSpy.mockRestore();
    }
  });

  it("emits a snapshot work product on landscape change and suppresses duplicates", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        posts.push({ url: req.url ?? "", body: JSON.parse(body) });
        res.end(JSON.stringify({ id: "wp" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null && "port" in addr ? addr.port : 0;
    try {
      fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "sess-b", sessionKey: "sk" } });
      const run = createOmpAcpExecutor();
      const ctx = baseCtx({
        authToken: "jwt",
        config: { command: `${process.execPath} ${fakeAcp}` },
      });
      // first run: emits
      ctx.context.taskId = "issue-1";
      vi.stubEnv("PAPERCLIP_API_URL", `http://127.0.0.1:${port}`);
      await run(ctx);
      expect(posts).toHaveLength(1);
      expect(posts[0].body).toMatchObject({ provider: "omp-session" });
      // second run: identical landscape -> suppressed
      await run(ctx);
      expect(posts).toHaveLength(1);
    } finally {
      server.close();
      server.closeAllConnections();
      vi.unstubAllEnvs();
    }
  });

  it("snapshot query failure: run succeeds, warn emitted, no work product POST", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        posts.push({ url: req.url ?? "", body: JSON.parse(body) });
        res.end(JSON.stringify({ id: "wp" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null && "port" in addr ? addr.port : 0;
    try {
      const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "sess-b", sessionKey: "sk" } });
      const events: Array<{ message: string }> = [];
      const run = createOmpAcpExecutor();
      const ctx = baseCtx({
        authToken: "jwt",
        config: { command: `${process.execPath} ${fakeAcp}` },
        onEvent: async (ev: { message: string }) => { events.push(ev); },
      });
      ctx.context.taskId = "issue-1";
      vi.stubEnv("PAPERCLIP_API_URL", `http://127.0.0.1:${port}`);
      // fake-acp answers _omp/* with JSON-RPC errors -> queryOmpSessions fails.
      vi.stubEnv("FAKE_ACP_MODE", "exterror");
      await run(ctx);
      // Degradation contract: a failed snapshot query never fails the run.
      expect(executorFn).toHaveBeenCalledOnce();
      const queryWarn = events.find((e) => e.message.includes("snapshot query failed"));
      expect(queryWarn).toBeTruthy();
      expect(queryWarn!.message).toContain("ext boom");
      expect(posts).toHaveLength(0);
    } finally {
      server.close();
      server.closeAllConnections();
      vi.unstubAllEnvs();
    }
  });

  it("snapshot POST failure: warn emitted, digest not updated, retried on next run", async () => {
    let postCount = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        postCount += 1;
        if (postCount === 1) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        } else {
          res.end(JSON.stringify({ id: "wp" }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null && "port" in addr ? addr.port : 0;
    try {
      const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "sess-b", sessionKey: "sk" } });
      const events: Array<{ message: string }> = [];
      const run = createOmpAcpExecutor();
      const ctx = baseCtx({
        authToken: "jwt",
        config: { command: `${process.execPath} ${fakeAcp}` },
        onEvent: async (ev: { message: string }) => { events.push(ev); },
      });
      ctx.context.taskId = "issue-1";
      vi.stubEnv("PAPERCLIP_API_URL", `http://127.0.0.1:${port}`);
      // First run: POST fails with HTTP 500.
      await run(ctx);
      expect(executorFn).toHaveBeenCalledOnce();
      const emitWarn = events.find((e) => e.message.includes("snapshot emission failed"));
      expect(emitWarn).toBeTruthy();
      expect(emitWarn!.message).toContain("HTTP 500");
      // Digest is NOT recorded, so the next healthy run retries emission.
      const state = await loadState(sessionIntelDir("co-1", "agent-1"));
      expect(state.lastSnapshotDigest).toBeFalsy();
      // Second run: POST succeeds -> warn gone, digest recorded.
      events.length = 0;
      await run(ctx);
      expect(executorFn).toHaveBeenCalledTimes(2);
      expect(events.some((e) => e.message.includes("snapshot emission failed"))).toBe(false);
      const state2 = await loadState(sessionIntelDir("co-1", "agent-1"));
      expect(state2.lastSnapshotDigest).toBeTruthy();
    } finally {
      server.close();
      server.closeAllConnections();
      vi.unstubAllEnvs();
    }
  });
});

describe("resolveOmpAgentCommand", () => {
  it("defaults to 'omp acp'", () => {
    expect(resolveOmpAgentCommand({})).toBe("omp acp");
  });
  it("derives from command override", () => {
    expect(resolveOmpAgentCommand({ command: "/usr/local/bin/omp" })).toBe("/usr/local/bin/omp acp");
  });
  it("explicit agentCommand wins", () => {
    expect(resolveOmpAgentCommand({ command: "omp", agentCommand: "mise x omp -- acp" })).toBe(
      "mise x omp -- acp",
    );
  });
});

describe("buildOmpAcpConfig", () => {
  it("sets agent custom and derived agentCommand, passes engine knobs through", () => {
    const out = buildOmpAcpConfig({ model: "openrouter/glm-5.2", mode: "oneshot" });
    expect(out.agent).toBe("custom");
    expect(out.agentCommand).toBe("omp acp");
    expect(out.mode).toBe("oneshot");
    expect(out.permissionMode).toBe("approve-all");
    expect(out.nonInteractivePermissions).toBe("deny");
    expect(out.model).toBe("openrouter/glm-5.2");
  });
  it("strips effort/thinkingEffort (unverified ACP control wiring)", () => {
    const out = buildOmpAcpConfig({ effort: "high", thinkingEffort: "high" });
    expect(out.effort).toBeUndefined();
    expect(out.thinkingEffort).toBeUndefined();
  });
  it("keeps stateDir only when set", () => {
    expect(buildOmpAcpConfig({}).stateDir).toBeUndefined();
    expect(buildOmpAcpConfig({ stateDir: "/tmp/s" }).stateDir).toBe("/tmp/s");
  });
  it("normalizes the model through resolveModel", () => {
    const out = buildOmpAcpConfig(
      { model: "glm-5.2" },
      (m) => (m === "glm-5.2" ? "zai/glm-5.2" : null),
      () => null,
    );
    expect(out.model).toBe("zai/glm-5.2");
  });
  it("keeps the raw model when resolveModel returns null", () => {
    expect(buildOmpAcpConfig({ model: "glm-5.2" }, () => null).model).toBe("glm-5.2");
  });
  it("honors an explicit timeoutSec, including 0 and numeric strings", () => {
    // resolveCost returns a FREE cost (would derive 1800) so an explicit 0
    // can only come from the explicit-timeout branch, not derivation.
    const free = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(buildOmpAcpConfig({ model: "m", timeoutSec: 0 }, () => "m", free).timeoutSec).toBe(0);
    expect(buildOmpAcpConfig({ model: "m", timeoutSec: 60 }, () => "m", free).timeoutSec).toBe(60);
    expect(buildOmpAcpConfig({ model: "m", timeoutSec: "300" }, () => "m", free).timeoutSec).toBe(300);
  });
  it("prefers timeoutSec over acpTimeoutSec", () => {
    expect(buildOmpAcpConfig({ model: "m", timeoutSec: 60, acpTimeoutSec: 123 }).timeoutSec).toBe(60);
  });
  it("falls back to acpTimeoutSec when timeoutSec is absent", () => {
    expect(buildOmpAcpConfig({ model: "m", acpTimeoutSec: 123 }).timeoutSec).toBe(123);
  });
  it("derives timeoutSec from the resolved model cost when both are absent", () => {
    const free = buildOmpAcpConfig(
      { model: "m" },
      () => "m",
      () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    );
    expect(free.timeoutSec).toBe(1800);
    const priced = buildOmpAcpConfig(
      { model: "m" },
      () => "m",
      () => ({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
    );
    expect(priced.timeoutSec).toBe(0);
  });
  it("adds no timeoutSec when no model is set", () => {
    expect(buildOmpAcpConfig({}).timeoutSec).toBeUndefined();
  });
});

describe("deriveDefaultTimeoutSec", () => {
  it("returns 1800 for a free/zero-cost model", () => {
    expect(deriveDefaultTimeoutSec({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(1800);
  });

  it("returns 0 for a priced model", () => {
    expect(deriveDefaultTimeoutSec({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })).toBe(0);
  });

  it("returns 0 when cost is absent/unavailable", () => {
    expect(deriveDefaultTimeoutSec(null)).toBe(0);
    expect(deriveDefaultTimeoutSec(undefined)).toBe(0);
  });
});

describe("parseOmpVersion", () => {
  it("parses 'omp/18.0.5'", () => {
    expect(parseOmpVersion("omp/18.0.5")).toEqual({ major: 18, minor: 0, patch: 5 });
  });
  it("parses bare 'v1.2.3'", () => {
    expect(parseOmpVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  it("returns null on garbage", () => {
    expect(parseOmpVersion("not a version")).toBeNull();
  });
});

describe("resolveOmpBillingIdentity", () => {
  it("defaults to api/oh-my-pi", () => {
    const id = resolveOmpBillingIdentity({ config: {} } as never);
    expect(id).toEqual({ provider: "oh-my-pi", biller: null, billingType: "api" });
  });
  it("honors env override", () => {
    const id = resolveOmpBillingIdentity({
      config: { env: { OMP_PAPERCLIP_BILLING_TYPE: "subscription" } },
    } as never);
    expect(id.billingType).toBe("subscription");
  });
  it("falls back to api on unknown value", () => {
    const id = resolveOmpBillingIdentity({
      config: { env: { OMP_PAPERCLIP_BILLING_TYPE: "bogus" } },
    } as never);
    expect(id.billingType).toBe("api");
  });
  it("falls back to api on Object.prototype keys like 'toString'", () => {
    const id = resolveOmpBillingIdentity({
      config: { env: { OMP_PAPERCLIP_BILLING_TYPE: "toString" } },
    } as never);
    expect(id.billingType).toBe("api");
  });
});

const fakeAcp = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/fake-acp.mjs",
);

describe("probeOmpAcpSession", () => {
  it("handshakes with a scripted responder and reads the active model", async () => {
    const out = await probeOmpAcpSession({ command: process.execPath, args: [fakeAcp] });
    expect(out.ok).toBe(true);
    expect(out.protocolVersion).toBe(1);
    expect(out.currentModel).toBe("prov/model-a");
  }, 15_000);
  it("fails cleanly against a non-ACP binary", async () => {
    const out = await probeOmpAcpSession({ command: "false", args: [] });
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  }, 15_000);
  it("times out when the child never handshakes", async () => {
    // Exercises the probe's own wall-clock timeout against the platform clock;
    // deterministic time control cannot drive the child-process handshake.
    const out = await probeOmpAcpSession(
      { command: process.execPath, args: ["-e", "setInterval(() => {}, 1 << 30)"] },
      150,
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/timed out/);
  }, 15_000);
  it("reports a JSON-RPC error response", async () => {
    const out = await probeOmpAcpSession({
      command: process.execPath,
      args: [fakeAcp],
      env: { FAKE_ACP_MODE: "error" },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("boom");
  }, 15_000);
  it("rejects an unexpected protocolVersion", async () => {
    const out = await probeOmpAcpSession({
      command: process.execPath,
      args: [fakeAcp],
      env: { FAKE_ACP_MODE: "badversion" },
    });
    expect(out.ok).toBe(false);
    expect(out.protocolVersion).toBe(99);
  }, 15_000);
});

describe("driveAcpSession", () => {
  it("runs initialize plus sequential requests and returns their results", async () => {
    const out = await driveAcpSession(
      { command: process.execPath, args: [fakeAcp] },
      [
        { method: "_omp/sessions/listAll", params: {} },
        { method: "_omp/projects/list", params: {} },
      ],
    );
    expect(out.ok).toBe(true);
    expect(out.responses).toHaveLength(2);
    expect(out.responses[0].result).toMatchObject({ total: 2 });
    expect(out.responses[1].result).toMatchObject({ totalSessions: 2 });
  }, 15_000);

  it("maps a JSON-RPC error response onto the request that caused it", async () => {
    const out = await driveAcpSession(
      { command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_MODE: "exterror" } },
      [{ method: "_omp/sessions/listAll", params: {} }],
    );
    // The drive completes with ok:true after collecting all responses; the
    // JSON-RPC error is mapped onto the request's slot in `responses`.
    expect(out.ok).toBe(true);
    expect(out.responses[0].error?.message).toBe("ext boom");
  }, 15_000);

  it("never sends session/new for read-only request sets", async () => {
    const out = await driveAcpSession(
      { command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_MODE: "record" } },
      [{ method: "_omp/sessions/listAll", params: {} }],
    );
    // record mode echoes the seen frames in the listAll response (it is written
    // after the request is logged; the initialize response predates the requests).
    const seen = (out.responses[0]?.result as { seen?: string[] } | undefined)?.seen;
    expect(seen).toEqual(["initialize", "_omp/sessions/listAll"]);
  }, 15_000);

  it("times out a hung responder", async () => {
    const out = await driveAcpSession(
      { command: process.execPath, args: ["-e", "setInterval(() => {}, 1 << 30)"] },
      [{ method: "_omp/sessions/listAll", params: {} }],
      200,
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("timed out");
  }, 15_000);

  it("maps a session/new JSON-RPC error onto a failed probe (regression lock)", async () => {
    const out = await probeOmpAcpSession(
      { command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_MODE: "newerror" } },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("id 2");
    expect(out.error).toContain("no session");
  }, 15_000);
});
describe("omp-local executor retry composition", () => {
  it("attaches retryChain only when a retry actually occurred", async () => {
    const failOnce = async (): Promise<AdapterExecutionResult> => ({
      exitCode: 0, signal: null, timedOut: false,
      errorCode: "acpx_turn_failed", errorMeta: { retryable: true },
    });
    const ok = async (): Promise<AdapterExecutionResult> => ({
      exitCode: 0, signal: null, timedOut: false, errorCode: null,
    });
    const retried = await runWithFreshSessionRetry(failOnce, { enabled: true, freshRetries: 1 }, {});
    const normal = await runWithFreshSessionRetry(ok, { enabled: true, freshRetries: 1 }, {});
    expect(withRetryChain(retried.result, retried.chain).resultJson?.retryChain).toHaveLength(2);
    // Normal runs carry no retryChain noise.
    expect(withRetryChain(normal.result, normal.chain).resultJson).toBeUndefined();
  });
});
