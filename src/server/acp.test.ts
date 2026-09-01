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
  resolveBridgeRunMode,
  resolveOmpAgentCommand,
  resolveOmpBillingIdentity,
  resolveSessionCwd,
  shouldAppendSkillBridgeExtension,
} from "./acp.js";
import { runWithFreshSessionRetry, withRetryChain } from "./retry.js";
import * as sessionState from "./session-state.js";
import { loadState, saveState, sessionIntelDir } from "./session-state.js";
import { FAILOVER_CONFIG_FILE } from "./failover-config.js";
const engineMocks = vi.hoisted(() => ({
  createAcpxEngineExecutor: vi.fn(),
}));

const modelsMocks = vi.hoisted(() => ({
  listOmpModels: vi.fn(async () => [
    { id: "prov/m", label: "M", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  ]),
}));


const skillManifestMocks = vi.hoisted(() => ({
  materializeSkillManifest: vi.fn(),
}));

vi.mock("./skill-manifest.js", () => ({
  materializeSkillManifest: skillManifestMocks.materializeSkillManifest,
}));

const serverUtilsMocks = vi.hoisted(() => ({
  readPaperclipSkillSyncPreference: vi.fn(),
  readPaperclipRuntimeSkillEntries: vi.fn(),
  resolvePaperclipDesiredSkillNames: vi.fn(),
  readPaperclipSkillMarkdown: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readPaperclipSkillSyncPreference: serverUtilsMocks.readPaperclipSkillSyncPreference,
    readPaperclipRuntimeSkillEntries: serverUtilsMocks.readPaperclipRuntimeSkillEntries,
    resolvePaperclipDesiredSkillNames: serverUtilsMocks.resolvePaperclipDesiredSkillNames,
    readPaperclipSkillMarkdown: serverUtilsMocks.readPaperclipSkillMarkdown,
  };
});

vi.mock("./models.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, listOmpModels: modelsMocks.listOmpModels };
});

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
    serverUtilsMocks.readPaperclipSkillSyncPreference.mockReset();
    serverUtilsMocks.readPaperclipRuntimeSkillEntries.mockReset();
    serverUtilsMocks.resolvePaperclipDesiredSkillNames.mockReset();
    serverUtilsMocks.readPaperclipSkillMarkdown.mockReset();
    serverUtilsMocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: false, desiredSkills: [], desiredSkillEntries: [],
    });
    serverUtilsMocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([]);
    serverUtilsMocks.resolvePaperclipDesiredSkillNames.mockReturnValue([]);
    serverUtilsMocks.readPaperclipSkillMarkdown.mockResolvedValue(null);
    skillManifestMocks.materializeSkillManifest.mockReset();
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
  it("fork run with fallbackChain still carries PI_CONFIG_FILES (overlay folded into config before engineConfig)", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, sessionForkSourceId: "sess-a", sessionForkToken: "t1", fallbackChain: "brokerco/main\nbrokerco/fast" },
    }));
    const merged = executorFn.mock.calls[0][0];
    expect(merged.config.warmHandleIdleMs).toBe(50); // fork override applied
    // The fork branch rebuilds engineConfig as { ...config, warmHandleIdleMs: 50 };
    // PI_CONFIG_FILES must ride on config (not be added to engineConfig after),
    // so it survives the fork spread.
    expect(merged.config.env?.PI_CONFIG_FILES).toBe(
      path.join(sessionIntelDir("co-1", "agent-1"), FAILOVER_CONFIG_FILE),
    );
  });

  it("pins the operator PI_CONFIG_FILES ahead of the overlay (fold, not overwrite)", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        sessionForkSourceId: "sess-a", sessionForkToken: "t1",
        fallbackChain: "brokerco/main\nbrokerco/fast",
        env: { PI_CONFIG_FILES: "/op/x.yml" },
      },
    }));
    const merged = executorFn.mock.calls[0][0];
    // The operator value rides ahead of the overlay path (fold via
    // path.delimiter), not overwritten by it.
    expect(merged.config.env?.PI_CONFIG_FILES).toBe(
      "/op/x.yml" + path.delimiter + path.join(sessionIntelDir("co-1", "agent-1"), FAILOVER_CONFIG_FILE),
    );
  });

  it("fails the run early when broker mode lacks env", async () => {
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "x", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    const res = await run(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}`, credentialMode: "broker", env: {} } }));
    expect(res.errorCode).toBe("omp_config_error");
    expect(res.errorMessage).toMatch(/OMP_AUTH_BROKER_URL/);
    expect(engineMocks.createAcpxEngineExecutor.mock.calls.length).toBe(0); // engine never invoked
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

  it("reports the runtime MCP server count in sessionRuntime on the run path", async () => {
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    const res = await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}` },
      runtimeMcp: {
        getServers: () => [
          { name: "mcp-1", url: "http://mcp:1", token: "t1", connectionId: "c1" },
        ],
      },
    }));
    // The MCP count rides on the run path (ctx.runtimeMcp is only real on
    // AdapterExecutionContext, never on the environment-test context).
    const sessionRuntime = res.resultJson?.sessionRuntime;
    expect(
      sessionRuntime && typeof sessionRuntime === "object" && "mcpServerCount" in sessionRuntime
        ? sessionRuntime.mcpServerCount
        : undefined,
    ).toBe(1);
  });

  it("omits mcpServerCount from sessionRuntime when no MCP servers are present", async () => {
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    const res = await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}` },
      runtimeMcp: { getServers: () => [] },
    }));
    // No fork/rotation/MCP servers -> sessionRuntime stays empty and is not
    // attached to resultJson at all.
    const sessionRuntime = res.resultJson?.sessionRuntime;
    expect(
      sessionRuntime && typeof sessionRuntime === "object" && "mcpServerCount" in sessionRuntime
        ? sessionRuntime.mcpServerCount
        : undefined,
    ).toBeUndefined();
    expect(res.resultJson?.sessionRuntime).toBeUndefined();
  });

  it("records lastRotation into sessionRuntime when compaction trips", async () => {
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    const res = await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, sessionMaxRuns: 1 },
    }));
    // The run's counter trips maxRuns=1, recording a rotation that must reach
    // resultJson -> heartbeat_runs (v0.4 spec §3.8 evidence).
    const sessionRuntime = res.resultJson?.sessionRuntime;
    expect(
      sessionRuntime && typeof sessionRuntime === "object" && "lastRotation" in sessionRuntime
        ? (sessionRuntime.lastRotation as { reason?: string }).reason
        : undefined,
    ).toBe("maxRuns");
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
        config: { command: `${process.execPath} ${fakeAcp}`, usageReport: false },
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
        config: { command: `${process.execPath} ${fakeAcp}`, usageReport: false },
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
        config: { command: `${process.execPath} ${fakeAcp}`, usageReport: false },
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

  it("emits an omp-usage report once and suppresses an identical second run", async () => {
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
      // local mode (no broker): reports=[], cost from result.usage (via recentRuns mean);
      // two runs with identical usage -> the digest bucket is unchanged -> one post.
      fakeEngine({ exitCode: 0, usage: { inputTokens: 1000, outputTokens: 100 }, usageBasis: "per_run", sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
      const run = createOmpAcpExecutor();
      const ctx = baseCtx({
        authToken: "jwt",
        config: { command: `${process.execPath} ${fakeAcp}`, usageReport: true, sessionBrowser: false },
      });
      ctx.context.taskId = "issue-1";
      vi.stubEnv("PAPERCLIP_API_URL", `http://127.0.0.1:${port}`);
      await run(ctx);
      const usagePosts = () => posts.filter((p) => (p.body as { provider?: string } | null)?.provider === "omp-usage");
      expect(usagePosts()).toHaveLength(1);
      // second run: identical usage -> digest unchanged -> suppressed
      await run(ctx);
      expect(usagePosts()).toHaveLength(1);
    } finally {
      server.close();
      server.closeAllConnections();
      vi.unstubAllEnvs();
    }
  });

  it("local mode does not call the broker", async () => {
    const urls: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        urls.push(req.url ?? "");
        res.end(JSON.stringify({ id: "wp" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null && "port" in addr ? addr.port : 0;
    try {
      fakeEngine({ exitCode: 0, usage: { inputTokens: 1000, outputTokens: 100 }, usageBasis: "per_run", sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
      const run = createOmpAcpExecutor();
      const ctx = baseCtx({
        authToken: "jwt",
        config: { command: `${process.execPath} ${fakeAcp}`, credentialMode: "local",
          usageReport: true, sessionBrowser: false,
          env: { OMP_AUTH_BROKER_URL: `http://127.0.0.1:${port}`, OMP_AUTH_BROKER_TOKEN: "tok" } },
      });
      ctx.context.taskId = "issue-1";
      vi.stubEnv("PAPERCLIP_API_URL", `http://127.0.0.1:${port}`);
      await run(ctx);
      // fetchBrokerUsage is only invoked in broker mode: even with broker env
      // set, local mode must NOT call /v1/usage.
      expect(urls.some((u) => u.includes("/v1/usage"))).toBe(false);
      // cost-only report still emitted to the work-products route.
      expect(urls.some((u) => u.includes("work-products"))).toBe(true);
    } finally {
      server.close();
      server.closeAllConnections();
      vi.unstubAllEnvs();
    }
  });

  it("usage POST failure: warn emitted, digest not updated, retried next run", async () => {
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
      const executorFn = fakeEngine({ exitCode: 0, usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 }, usageBasis: "per_run", sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
      const events: Array<{ message: string }> = [];
      const run = createOmpAcpExecutor();
      const ctx = baseCtx({
        authToken: "jwt",
        config: { command: `${process.execPath} ${fakeAcp}`, model: "prov/m", credentialMode: "local", usageReport: true, sessionBrowser: false },
        onEvent: async (ev: { message: string }) => { events.push(ev); },
      });
      ctx.context.taskId = "issue-1";
      vi.stubEnv("PAPERCLIP_API_URL", `http://127.0.0.1:${port}`);
      await run(ctx);
      expect(executorFn).toHaveBeenCalledOnce();
      const emitWarn = events.find((e) => e.message.includes("usage report emission failed"));
      expect(emitWarn).toBeTruthy();
      expect(emitWarn!.message).toContain("HTTP 500");
      const state = await loadState(sessionIntelDir("co-1", "agent-1"));
      expect(state.lastUsageDigest).toBeFalsy();
      events.length = 0;
      await run(ctx);
      expect(executorFn).toHaveBeenCalledTimes(2);
      expect(events.some((e) => e.message.includes("usage report emission failed"))).toBe(false);
      const state2 = await loadState(sessionIntelDir("co-1", "agent-1"));
      expect(state2.lastUsageDigest).toBeTruthy();
    } finally {
      server.close();
      server.closeAllConnections();
      vi.unstubAllEnvs();
    }
  });

  it("cost path: emits $/heartbeat est card, re-emits on digest change, skips session_cumulative append", async () => {
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
      const usagePosts = () => posts.filter((p) => (p.body as { provider?: string } | null)?.provider === "omp-usage");
      const ctx = baseCtx({
        authToken: "jwt",
        config: { command: `${process.execPath} ${fakeAcp}`, model: "prov/m", credentialMode: "local", usageReport: true, sessionBrowser: false },
      });
      ctx.context.taskId = "issue-1";
      vi.stubEnv("PAPERCLIP_API_URL", `http://127.0.0.1:${port}`);
      // run 1: emits a cost card ($ + /heartbeat est.)
      fakeEngine({ exitCode: 0, usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500 }, usageBasis: "per_run", sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
      await createOmpAcpExecutor()(ctx);
      expect(usagePosts()).toHaveLength(1);
      const summary = (usagePosts()[0].body as { summary?: string }).summary ?? "";
      expect(summary).toContain("$");
      expect(summary).toContain("/heartbeat est.");
      // run 2: identical usage -> digest unchanged -> suppressed
      fakeEngine({ exitCode: 0, usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500 }, usageBasis: "per_run", sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
      await createOmpAcpExecutor()(ctx);
      expect(usagePosts()).toHaveLength(1);
      // run 3: DIFFERENT usage -> digest changes -> second card
      fakeEngine({ exitCode: 0, usage: { inputTokens: 9000, outputTokens: 900, cachedInputTokens: 500 }, usageBasis: "per_run", sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
      await createOmpAcpExecutor()(ctx);
      expect(usagePosts()).toHaveLength(2);
      // session_cumulative run: does NOT append to recentRuns
      const before = (await loadState(sessionIntelDir("co-1", "agent-1"))).recentRuns.length;
      fakeEngine({ exitCode: 0, usage: { inputTokens: 99999, outputTokens: 9999, cachedInputTokens: 9999 }, usageBasis: "session_cumulative", sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
      await createOmpAcpExecutor()(ctx);
      const after = (await loadState(sessionIntelDir("co-1", "agent-1"))).recentRuns.length;
      expect(after).toBe(before);
    } finally {
      server.close();
      server.closeAllConnections();
      vi.unstubAllEnvs();
    }
  });

  it("catalog probe strips trailing flags from agentCommand (thinking:medium → base 'omp')", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    modelsMocks.listOmpModels.mockClear();
    await run(baseCtx({ config: { command: "omp", model: "prov/m", thinking: "medium" } }));
    expect(modelsMocks.listOmpModels).toHaveBeenCalled();
    const calls = modelsMocks.listOmpModels.mock.calls;
    const call = calls[calls.length - 1][0];
    expect(call.command).toBe("omp");
    expect(call.args).not.toContain("acp");
    expect(call.args).not.toContain("--thinking");
    expect(call.args).not.toContain("medium");
  });

  it("warns (not aborts) for an invalid thinking level", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
    const events: Array<{ eventType?: string; level?: string; message?: string }> = [];
    const ctx = baseCtx({
      config: { command: "omp", thinking: "bogus" },
      onEvent: async (ev: unknown) => { events.push(ev as { eventType?: string; level?: string; message?: string }); },
    });
    const run = createOmpAcpExecutor();
    await run(ctx);
    // warn emitted with the fail-open message...
    const warn = events.find((e) => e.level === "warn" && /thinking is 'bogus'/.test(e.message ?? ""));
    expect(warn).toBeTruthy();
    // ...and the run still executes (does NOT abort on a bad thinking level).
    expect(executorFn).toHaveBeenCalledOnce();
  });

});
describe("resolveOmpAgentCommand", () => {
  it("defaults to 'omp acp'", () => {
    expect(resolveOmpAgentCommand({})).toBe("omp acp");
  });
  it("derives from command override", () => {
    expect(resolveOmpAgentCommand({ command: "/usr/local/bin/omp" })).toBe("/usr/local/bin/omp acp");
  });
  it("appends --thinking to an explicit agentCommand (never silently drops the directive)", () => {
    expect(resolveOmpAgentCommand({ agentCommand: "mise x omp -- acp", thinking: "medium" })).toBe(
      "mise x omp -- acp --thinking medium",
    );
  });
  it("appends --thinking for a valid level", () => {
    expect(resolveOmpAgentCommand({ thinking: "medium" })).toBe("omp acp --thinking medium");
  });
  it("skips --thinking for default sentinel, unset, or invalid", () => {
    expect(resolveOmpAgentCommand({ thinking: "default" })).toBe("omp acp");
    expect(resolveOmpAgentCommand({})).toBe("omp acp");
    expect(resolveOmpAgentCommand({ thinking: "bogus" })).toBe("omp acp");
  });
  it("does not double-append --thinking when the explicit agentCommand already carries it", () => {
    expect(resolveOmpAgentCommand({
      agentCommand: "omp acp --thinking low",
      thinking: "high",
    })).toBe("omp acp --thinking low");
  });
  it("skillsAsTools:true with desired skill sets manifest env, appends --extension, skips prose", async () => {
    skillManifestMocks.materializeSkillManifest.mockResolvedValue("/tmp/skills-manifest.json");
    serverUtilsMocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: true, desiredSkills: ["echo"], desiredSkillEntries: [],
    });
    serverUtilsMocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([
      { key: "paperclipai/echo", runtimeName: "echo", source: "/tmp/echo" },
    ]);
    serverUtilsMocks.resolvePaperclipDesiredSkillNames.mockReturnValue(["paperclipai/echo"]);
    serverUtilsMocks.readPaperclipSkillMarkdown.mockResolvedValue("# Echo skill");
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, skillsAsTools: true },
    }));
    const merged = executorFn.mock.calls[0][0];
    // Manifest env is set
    expect(merged.config.env?.PAPERCLIP_SKILLS_MANIFEST).toBe("/tmp/skills-manifest.json");
    // agentCommand includes --extension
    expect(merged.config.agentCommand).toContain("--extension");
    // Prose instructions are NOT set (bridge active)
    expect(merged.config.instructionsFilePath).toBeUndefined();
  });

  it("skillsAsTools:false does not set manifest env, no --extension, prose runs", async () => {
    serverUtilsMocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: true, desiredSkills: ["echo"], desiredSkillEntries: [],
    });
    serverUtilsMocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([
      { key: "paperclipai/echo", runtimeName: "echo", source: "/tmp/echo" },
    ]);
    serverUtilsMocks.resolvePaperclipDesiredSkillNames.mockReturnValue(["paperclipai/echo"]);
    serverUtilsMocks.readPaperclipSkillMarkdown.mockResolvedValue("# Echo skill");
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, skillsAsTools: false },
    }));
    const merged = executorFn.mock.calls[0][0];
    // Manifest env NOT set
    expect(merged.config.env?.PAPERCLIP_SKILLS_MANIFEST).toBeUndefined();
    // No --extension in agentCommand
    expect(merged.config.agentCommand).not.toContain("--extension");
  });
  it("treats the string 'false' as off (bridge stays inactive, prose runs)", async () => {
    serverUtilsMocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: true, desiredSkills: ["echo"], desiredSkillEntries: [],
    });
    serverUtilsMocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([
      { key: "paperclipai/echo", runtimeName: "echo", source: "/tmp/echo" },
    ]);
    serverUtilsMocks.resolvePaperclipDesiredSkillNames.mockReturnValue(["paperclipai/echo"]);
    serverUtilsMocks.readPaperclipSkillMarkdown.mockResolvedValue("# Echo skill");
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, skillsAsTools: "false" },
    }));
    const merged = executorFn.mock.calls[0][0];
    // Toggle arrives as a string; "false" must NOT arm the bridge.
    expect(merged.config.env?.PAPERCLIP_SKILLS_MANIFEST).toBeUndefined();
    expect(merged.config.agentCommand).not.toContain("--extension");
    // Prose injection still runs (desired skill materializes an instructions file).
    expect(merged.config.instructionsFilePath).toBeTruthy();
  });

  it("does not double-append --thinking when the dangling flag (without a value) is present", () => {
    expect(resolveOmpAgentCommand({
      agentCommand: "omp acp --thinking",
      thinking: "high",
    })).toBe("omp acp --thinking");
  });

  it("appends --extension <bridgePath> when env has PAPERCLIP_SKILLS_MANIFEST", () => {
    expect(resolveOmpAgentCommand({
      env: { PAPERCLIP_SKILLS_MANIFEST: "/tmp/manifest.json" },
    })).toBe("omp acp --extension " + path.join(path.dirname(fileURLToPath(import.meta.url)), "../../dist/skill-bridge.js"));
  });

  it("does not append --extension when env lacks PAPERCLIP_SKILLS_MANIFEST", () => {
    expect(resolveOmpAgentCommand({})).toBe("omp acp");
  });

  it("does not append --extension when PAPERCLIP_SKILLS_MANIFEST is empty string", () => {
    expect(resolveOmpAgentCommand({
      env: { PAPERCLIP_SKILLS_MANIFEST: "" },
    })).toBe("omp acp");
  });
});

describe("shouldAppendSkillBridgeExtension", () => {
  it("returns true when manifest env is set and bridgePath is whitespace-free", () => {
    expect(shouldAppendSkillBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "/tmp/m.json" } },
      "/opt/omp/dist/skill-bridge.js",
    )).toBe(true);
  });

  it("returns false when manifest env is missing", () => {
    expect(shouldAppendSkillBridgeExtension({}, "/opt/omp/dist/skill-bridge.js")).toBe(false);
  });

  it("returns false when manifest env is empty string", () => {
    expect(shouldAppendSkillBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "" } },
      "/opt/omp/dist/skill-bridge.js",
    )).toBe(false);
  });

  it("returns false when bridgePath contains whitespace", () => {
    expect(shouldAppendSkillBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "/tmp/m.json" } },
      "/opt/omp dist/skill-bridge.js",
    )).toBe(false);
  });
});

describe("resolveBridgeRunMode", () => {
  // The module const bridgePath can never carry whitespace in a real install,
  // so the prose-fallback branch of the run wiring is guarded behind this
  // helper (it takes bridgePath). A whitespace result warns AND leaves the
  // bridge inactive, so prose injection runs and resolveOmpAgentCommand
  // appends no --extension (shouldAppendSkillBridgeExtension returns false).
  it("returns whitespace (prose-fallback) mode with a warn when bridgePath has whitespace", () => {
    const mode = resolveBridgeRunMode("/opt/omp dist/skill-bridge.js");
    expect(mode).toEqual({
      kind: "whitespace",
      warn: "omp skills-as-tools bridge path contains whitespace; falling back to prompt-injected skill instructions",
    });
    // No --extension when the bridge is off (the run wiring warns and falls
    // back to prose injection instead).
    expect(shouldAppendSkillBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "/tmp/m.json" } },
      "/opt/omp dist/skill-bridge.js",
    )).toBe(false);
  });

  it("returns ok (bridge active) for a whitespace-free bridgePath", () => {
    expect(resolveBridgeRunMode("/opt/omp/dist/skill-bridge.js")).toEqual({ kind: "ok" });
    expect(shouldAppendSkillBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "/tmp/m.json" } },
      "/opt/omp/dist/skill-bridge.js",
    )).toBe(true);
  });
});
describe("resolveSessionCwd", () => {
  const currentCwd = process.cwd();

  it("current paperclipWorkspace.cwd wins over stale storedParams.cwd", () => {
    const ctx = {
      config: {},
      context: { paperclipWorkspace: { cwd: "/workspace/current", source: "git_worktree" } },
    };
    expect(resolveSessionCwd(ctx, { cwd: "/workspace/stale" })).toBe("/workspace/current");
  });

  it("agent_home source + config.cwd → config.cwd (not workspace cwd)", () => {
    const ctx = {
      config: { cwd: "/config/cwd" },
      context: { paperclipWorkspace: { cwd: "/workspace/agent_home", source: "agent_home" } },
    };
    expect(resolveSessionCwd(ctx, {})).toBe("/config/cwd");
  });

  it("no workspace cwd, no config.cwd → storedParams.cwd", () => {
    const ctx = {
      config: {},
      context: { paperclipWorkspace: { cwd: "", source: "default" } },
    };
    expect(resolveSessionCwd(ctx, { cwd: "/stored/cwd" })).toBe("/stored/cwd");
  });

  it("none of the above → process.cwd()", () => {
    const ctx = { config: {}, context: {} };
    expect(resolveSessionCwd(ctx, {})).toBe(currentCwd);
  });

  it("git_worktree leaf: paperclipWorkspace.cwd is used", () => {
    const ctx = {
      config: {},
      context: { paperclipWorkspace: { cwd: "/worktree/leaf", source: "git_worktree" } },
    };
    expect(resolveSessionCwd(ctx, { cwd: "/stale/stored" })).toBe("/worktree/leaf");
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
  it("strips reasoningEffort/modelReasoningEffort (the engine's other effort keys)", () => {
    const out = buildOmpAcpConfig({
      reasoningEffort: "high", modelReasoningEffort: "high",
    });
    expect(out.reasoningEffort).toBeUndefined();
    expect(out.modelReasoningEffort).toBeUndefined();
  });
  it("rides the --thinking flag on agentCommand (the run fingerprint input)", () => {
    expect(buildOmpAcpConfig({ thinking: "medium" }).agentCommand).toBe("omp acp --thinking medium");
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
  it("strips OMP_AUTH_BROKER_* from output env when credentialMode is not broker (authoritative switch)", () => {
    const input = {
      credentialMode: "local",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok", KEEP: "x" },
    };
    const out = buildOmpAcpConfig(input);
    const env = out.env as Record<string, unknown>;
    expect(env.OMP_AUTH_BROKER_URL).toBeUndefined();
    expect(env.OMP_AUTH_BROKER_TOKEN).toBeUndefined();
    expect(env.KEEP).toBe("x");
    // ctx.config.env is never mutated: the strip happens on a copy.
    expect((input.env as Record<string, unknown>).OMP_AUTH_BROKER_URL).toBe("http://b:8765");
  });
  it("preserves OMP_AUTH_BROKER_* in broker mode", () => {
    const out = buildOmpAcpConfig({
      credentialMode: "broker",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
    });
    expect((out.env as Record<string, unknown>).OMP_AUTH_BROKER_URL).toBe("http://b:8765");
    expect((out.env as Record<string, unknown>).OMP_AUTH_BROKER_TOKEN).toBe("tok");
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
