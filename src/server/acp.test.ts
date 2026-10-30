import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi,
} from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  buildOmpAcpConfig,
  bridgePath,
  createOmpAcpExecutor,
  deriveDefaultTimeoutSec,
  driveAcpSession,
  parseOmpVersion,
  probeOmpAcpSession,
  resolveBridgeRunMode,
  resolveOmpAgentCommand,
  resolveOmpBillingIdentity,
  resolveSessionCwd,
  shouldAppendBridgeExtension, isGovernanceArmed,
} from "./acp.js";
import { runWithFreshSessionRetry, withRetryChain } from "./retry.js";
import * as sessionState from "./session-state.js";
import { loadState, ompAgentDir, saveState, sessionIntelDir } from "./session-state.js";
import { FAILOVER_CONFIG_FILE } from "./failover-config.js";
import { GOVERNANCE_MANIFEST_FILE } from "./governance-manifest.js";
import { GOVERNANCE_CONFIG_FILE } from "./governance-overlay.js";
import { BUDGET_CONFIG_FILE } from "./budget-overlay.js";
import { THINKING_CONFIG_FILE } from "./thinking-overlay.js";
const engineMocks = vi.hoisted(() => ({
  createAcpxEngineExecutor: vi.fn(),
}));

const modelsMocks = vi.hoisted(() => ({
  defaultModels: [
    { id: "prov/m", label: "M", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  ],
  listOmpModels: vi.fn(),
}));
modelsMocks.listOmpModels.mockImplementation(async () => modelsMocks.defaultModels);


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

/** Paperclip issue ids are UUIDs; a run's taskId is only postable when it is one. */
const ISSUE_ID = "0b8f0d5e-9a10-4f6a-8f2b-1c2d3e4f5a6b";

function baseCtx(
  // `runtimeTools` is absent from the installed adapter-utils declaration (it
  // ships at contract HEAD), so the fixture surface declares it explicitly.
  overrides: Partial<AdapterExecutionContext> & { runtimeTools?: Record<string, unknown> } = {},
): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null },
    runtime: {
      sessionId: "old",
      sessionParams: { acpSessionId: "old", sessionKey: "sk", cwd: process.cwd(), configFingerprint: "f" },
      sessionDisplayId: "old", taskKey: "t",
    },
    config: {},
    context: { taskId: ISSUE_ID },
    onLog: async () => {},
    onEvent: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

interface AcpFrame {
  method: string;
  params: Record<string, unknown>;
}

/**
 * Parse the fake responder's `${method}\t${params}` frame log. Params are the
 * contract for side-channel requests (which cwd a fork targets); the response
 * body cannot show that.
 */
async function readAcpFrames(file: string): Promise<AcpFrame[]> {
  let raw = "";
  try { raw = await readFile(file, "utf8"); } catch { return []; }
  return raw.split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return {
      method: tab < 0 ? line : line.slice(0, tab),
      params: tab < 0 ? {} : JSON.parse(line.slice(tab + 1)) as Record<string, unknown>,
    };
  });
}

/** Run-scoped control-tool access as Paperclip hands it to an adapter. */
function runtimeToolsAccess(mcpEndpoint: string, bearerToken: string): Record<string, unknown> {
  return {
    version: 1,
    guidance: "Connection tools:",
    mcpEndpoint,
    rest: {
      connectionsSearch: "http://paperclip.test/runtime-tools/connections/search",
      connectionRequest: "http://paperclip.test/runtime-tools/connections/request",
    },
    bearerToken,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tools: ["connections_search", "connection_request"],
  };
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
    // The routing tests swap in a bigger catalog; restore the default one so no
    // test's mockImplementation leaks into the next.
    modelsMocks.listOmpModels.mockImplementation(async () => modelsMocks.defaultModels);
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

  it("forks at the source session's own cwd, not this run's workspace", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-fork-cwd-"));
    try {
      const frameFile = path.join(dir, "frames.log");
      vi.stubEnv("FAKE_ACP_FRAME_LOG", frameFile);
      const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } });
      const run = createOmpAcpExecutor();
      await run(baseCtx({
        config: { command: `${process.execPath} ${fakeAcp}`, sessionForkSourceId: "sess-a", sessionForkToken: "t1" },
        // The run executes in another workspace; the source session's fork must
        // still target the workspace that session belongs to.
        context: { taskId: ISSUE_ID, paperclipWorkspace: { cwd: "/run-cwd", source: "workspace" } },
      }));
      expect(executorFn).toHaveBeenCalledOnce();
      const fork = (await readAcpFrames(frameFile)).find((frame) => frame.method === "session/fork");
      expect(fork).toBeTruthy();
      expect(fork!.params.cwd).toBe("/workspace");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("pins warm-handle reuse to 0 under run identity and reports the dropped opt-in", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const events: Array<{ level?: string; message?: string }> = [];
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, warmHandleIdleMs: 300_000 },
      authToken: "run-jwt-SENTINEL",
      onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
    }));
    // A reused child keeps the spawning run's PAPERCLIP_API_KEY (the engine sets
    // it only at spawn), so a warm hit would authenticate this run's work as an
    // earlier run. The adapter pins the knob off regardless of operator input.
    expect(executorFn.mock.calls[0][0].config.warmHandleIdleMs).toBe(0);
    const warnings = events.filter((e) => e.level === "warn" && /warm-handle/i.test(e.message ?? ""));
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");

    // Default config (never opted in) is already 0: no warning noise per heartbeat.
    const quiet: Array<{ level?: string; message?: string }> = [];
    const run2 = createOmpAcpExecutor();
    await run2(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}` },
      authToken: "run-jwt-SENTINEL",
      onEvent: async (ev: unknown) => { quiet.push(ev as { level?: string; message?: string }); },
    }));
    expect(quiet.some((e) => /warm-handle/i.test(e.message ?? ""))).toBe(false);
    expect(JSON.stringify(quiet)).not.toContain("SENTINEL");
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

  it("rides the thinking level in the run's settings overlay, not the fingerprint", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}`, thinking: "high" } }));
    const merged = executorFn.mock.calls[0][0];
    const overlay = path.join(sessionIntelDir("co-1", "agent-1"), THINKING_CONFIG_FILE);
    expect(merged.config.env?.PI_CONFIG_FILES).toBe(overlay);
    // The level really reaches omp: its settings key carries it.
    expect(await readFile(overlay, "utf8")).toBe("defaultThinkingLevel: high\n");
    // ...and never the command line, which the engine hashes into the session key.
    expect(merged.config.agentCommand).not.toContain("--thinking");
  });

  it("sends off as a CLI flag and writes no thinking overlay", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}`, thinking: "off" } }));
    const merged = executorFn.mock.calls[0][0];
    // omp has no `off` for defaultThinkingLevel (the value is discarded and the
    // run reads `high`), so this one level stays on the flag.
    expect(merged.config.agentCommand.endsWith("--thinking off")).toBe(true);
    expect(merged.config.env?.PI_CONFIG_FILES).toBeUndefined();
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

  it("governancePolicy set: folds manifest env, single-gate overlay, and --extension", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        governancePolicy: 'guardrails:\n  bashDeny:\n    - "rm -rf"\nbudgetCapUsd: 2',
      },
    }));
    const merged = executorFn.mock.calls[0][0];
    const intel = sessionIntelDir("co-1", "agent-1");
    expect(merged.config.env?.PAPERCLIP_GOVERNANCE_MANIFEST)
      .toBe(path.join(intel, GOVERNANCE_MANIFEST_FILE));
    expect(JSON.parse(await readFile(merged.config.env.PAPERCLIP_GOVERNANCE_MANIFEST, "utf8")))
      .toEqual({ guardrails: { bashDeny: ["rm -rf"] }, budgetCapUsd: 2 });
    // Governance alone arms the bridge even with skillsAsTools off — once.
    expect(merged.config.agentCommand).toContain(`--extension ${bridgePath}`);
    expect(merged.config.agentCommand.match(/--extension/g)).toHaveLength(1);
    // The single-gate key rides in the governance overlay (run-child only) and
    // the budget thresholds in their own; both are joined in precedence order.
    expect(merged.config.env?.PI_CONFIG_FILES).toBe([
      path.join(intel, GOVERNANCE_CONFIG_FILE),
      path.join(intel, BUDGET_CONFIG_FILE),
    ].join(path.delimiter));
    expect(await readFile(path.join(intel, GOVERNANCE_CONFIG_FILE), "utf8"))
      .toContain("approvalMode: yolo");
  });

  it("approvedEndpoints routes the run child: guard-kept providers stay, the rest disables", async () => {
    modelsMocks.listOmpModels.mockImplementation(async () => [
      { id: "prov/m", label: "M", priced: false },
      { id: "omi/r", label: "R", priced: false },
      { id: "chainco/b", label: "B", priced: false },
      { id: "axon-compat/q", label: "Q", priced: false },
    ]);
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const events: { level?: string; message?: string }[] = [];
    await createOmpAcpExecutor()(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        model: "prov/m",
        governancePolicy: "approvedEndpoints:\n  - omi",
        fallbackChain: "chainco/backup",
        env: { PI_CONFIG_FILES: "/op/x.yml" },
      },
      onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
    }));
    const merged = executorFn.mock.calls[0][0];
    const intel = sessionIntelDir("co-1", "agent-1");
    // Three overlays, precedence order: operator file, failover chain, routing.
    expect(merged.config.env?.PI_CONFIG_FILES).toBe([
      "/op/x.yml",
      path.join(intel, FAILOVER_CONFIG_FILE),
      path.join(intel, GOVERNANCE_CONFIG_FILE),
    ].join(path.delimiter));
    const overlay = await readFile(path.join(intel, GOVERNANCE_CONFIG_FILE), "utf8");
    expect(overlay).toContain("disabledProviders:\n  - \"axon-compat\"");
    // Approved (omi), configured-model (prov) and chained (chainco) providers
    // all stay reachable; only the unapproved remainder is cut off.
    expect(overlay).not.toMatch(/- "omi"/);
    expect(overlay).not.toMatch(/- "prov"/);
    expect(overlay).not.toMatch(/- "chainco"/);
    // The guard is not silent: the board learns which providers it protected...
    expect(events.some((e) => e.level === "warn" && /kept chainco, prov/.test(e.message ?? ""))).toBe(true);
    // ...and what actually got disabled.
    expect(events.some((e) => /disabled 1 provider\(s\).*axon-compat/.test(e.message ?? ""))).toBe(true);
  });

  it("routes nothing without a catalog: gate stays armed, routing warns", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const events: { level?: string; message?: string }[] = [];
    await createOmpAcpExecutor()(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        // A real rail carries the gate; the routing lever fails for want of a
        // catalog and degrades alone.
        governancePolicy: "guardrails:\n  denyTools:\n    - web_search\napprovedEndpoints: [omi]",
      },
      onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
    }));
    const intel = sessionIntelDir("co-1", "agent-1");
    const merged = executorFn.mock.calls[0][0];
    expect(merged.config.env?.PI_CONFIG_FILES).toBe(path.join(intel, GOVERNANCE_CONFIG_FILE));
    const overlay = await readFile(path.join(intel, GOVERNANCE_CONFIG_FILE), "utf8");
    expect(overlay).not.toContain("disabledProviders");
    expect(overlay).toContain("approvalMode: yolo");
    expect(events.some((e) => e.level === "warn" && /routing skipped/.test(e.message ?? ""))).toBe(true);
  });

  it("without governancePolicy the run keeps its v0.7 shape (no manifest, no yolo)", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, fallbackChain: "brokerco/main" },
    }));
    const merged = executorFn.mock.calls[0][0];
    const intel = sessionIntelDir("co-1", "agent-1");
    expect(merged.config.env?.PAPERCLIP_GOVERNANCE_MANIFEST).toBeUndefined();
    expect(merged.config.agentCommand).not.toContain("--extension");
    const overlay = await readFile(path.join(intel, FAILOVER_CONFIG_FILE), "utf8");
    expect(overlay).toContain("fallbackChains");
    expect(overlay).not.toContain("approvalMode");
  });

  it("governance folds in alongside the skills manifest instead of clobbering it", async () => {
    skillManifestMocks.materializeSkillManifest.mockResolvedValue("/tmp/skills-manifest.json");
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        skillsAsTools: true,
        governancePolicy: "budgetCapUsd: 1",
      },
    }));
    const merged = executorFn.mock.calls[0][0];
    expect(merged.config.env?.PAPERCLIP_SKILLS_MANIFEST).toBe("/tmp/skills-manifest.json");
    expect(merged.config.env?.PAPERCLIP_GOVERNANCE_MANIFEST).toContain(GOVERNANCE_MANIFEST_FILE);
    expect(merged.config.agentCommand.match(/--extension/g)).toHaveLength(1);
  });

  it("forwards budgetCapUsd as omp's session cost cap in its own run-child overlay", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        governancePolicy: "budgetCapUsd: 2",
      },
    }));
    const intel = sessionIntelDir("co-1", "agent-1");
    const merged = executorFn.mock.calls[0][0];
    // budgetCapUsd also arms the bridge (it is an enforceable rule), so the
    // single-gate overlay and the budget overlay both ride the run child.
    expect(merged.config.env?.PI_CONFIG_FILES).toBe([
      path.join(intel, GOVERNANCE_CONFIG_FILE),
      path.join(intel, BUDGET_CONFIG_FILE),
    ].join(path.delimiter));
    expect(await readFile(path.join(intel, BUDGET_CONFIG_FILE), "utf8"))
      .toBe("session:\n  maxCost: 2\n  warnCost: 1.6\n");
  });

  it("keeps the overlay path stable when only the cap changes (no session rotation)", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}`, governancePolicy: "budgetCapUsd: 2" } }));
    await run(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}`, governancePolicy: "budgetCapUsd: 3" } }));
    const first = executorFn.mock.calls[0][0].config.env?.PI_CONFIG_FILES;
    const second = executorFn.mock.calls[1][0].config.env?.PI_CONFIG_FILES;
    expect(second).toBe(first);
    expect(await readFile(path.join(sessionIntelDir("co-1", "agent-1"), BUDGET_CONFIG_FILE), "utf8"))
      .toBe("session:\n  maxCost: 3\n  warnCost: 2.4\n");
  });

  it("writes no budget overlay without a usable cap", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, governancePolicy: "approvedEndpoints:\n  - prov" },
    }));
    const merged = executorFn.mock.calls[0][0];
    expect(merged.config.env?.PI_CONFIG_FILES).toBeUndefined();
  });

  it("malformed governancePolicy warns and runs ungoverned instead of crashing", async () => {
    const events: { level?: string; message?: string }[] = [];
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        governancePolicy: "guardrails: [unclosed",
      },
      onEvent: async (ev: unknown) => {
        events.push(ev as { level?: string; message?: string });
      },
    }));
    const merged = executorFn.mock.calls[0][0];
    // Ungoverned, not half-governed: no manifest env, no bridge, no yolo overlay.
    expect(merged.config.env?.PAPERCLIP_GOVERNANCE_MANIFEST).toBeUndefined();
    expect(merged.config.env?.PI_CONFIG_FILES).toBeUndefined();
    expect(merged.config.agentCommand).not.toContain("--extension");
    expect(events.some((e) => e.level === "warn" && /governance/i.test(e.message ?? ""))).toBe(true);
    expect(executorFn).toHaveBeenCalledOnce();
  });

  // P1-1 (v0.8 final review): `tools.approvalMode: yolo` used to be folded
  // whenever a policy PARSED, even when it never reached the run child. omp's
  // own permission gate then sat disabled with no bridge handler installed —
  // every guardrail, budget and approval rule silently absent.
  it("unarmed governance still routes but never relaxes the approval gate", async () => {
    modelsMocks.listOmpModels.mockImplementation(async () => [
      { id: "prov/m", label: "M", priced: false },
      { id: "omi/r", label: "R", priced: false },
      { id: "axon-compat/q", label: "Q", priced: false },
    ]);
    const intel = sessionIntelDir("co-1", "agent-1");
    // A DIRECTORY where governance.json must be written: the manifest write
    // fails (EISDIR) while the routing overlay in the same dir still lands.
    await mkdir(path.join(intel, GOVERNANCE_MANIFEST_FILE), { recursive: true });
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const events: { level?: string; message?: string }[] = [];
    await createOmpAcpExecutor()(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        model: "prov/m",
        governancePolicy: "guardrails:\n  denyTools:\n    - web_search\napprovedEndpoints:\n  - prov\n  - omi",
      },
      onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
    }));
    const merged = executorFn.mock.calls[0][0];
    // Bridge not armed: no manifest env, therefore no --extension append.
    expect(merged.config.env?.PAPERCLIP_GOVERNANCE_MANIFEST).toBeUndefined();
    expect(merged.config.agentCommand).not.toContain("--extension");
    const overlay = await readFile(path.join(intel, GOVERNANCE_CONFIG_FILE), "utf8");
    // Routing is omp's own config lever, so it survives; the gate does not move.
    expect(overlay).toContain('disabledProviders:\n  - "axon-compat"');
    expect(overlay).not.toContain("approvalMode");
    expect(overlay).not.toMatch(/^tools:/m);
    expect(events.some((e) => e.level === "warn" && /not armed/i.test(e.message ?? ""))).toBe(true);
  });

  it("unarmed governance with no routing folds no overlay at all", async () => {
    const intel = sessionIntelDir("co-1", "agent-1");
    await mkdir(path.join(intel, GOVERNANCE_MANIFEST_FILE), { recursive: true });
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        governancePolicy: "guardrails:\n  denyTools:\n    - web_search",
      },
    }));
    const merged = executorFn.mock.calls[0][0];
    expect(merged.config.env?.PI_CONFIG_FILES).toBeUndefined();
  });

  it("fails closed when an active governance policy has no bridge extension", async () => {
    const badBridge = "/nonexistent/paperclip-bridge.js";
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const res = await createOmpAcpExecutor({ bridgePath: badBridge })(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        governancePolicy: "guardrails:\n  denyTools:\n    - web_search",
      },
    }));
    // A policy that cannot reach a bridge enforces nothing: running anyway
    // would report a governed run with no guardrail, budget or approval rule.
    expect(res).toMatchObject({ exitCode: 1, errorCode: "omp_governance_unavailable" });
    expect(res.errorMessage).toContain(badBridge);
    expect(engineMocks.createAcpxEngineExecutor).not.toHaveBeenCalled();
  }, 15_000);

  it("runs under governance when the configured bridge extension exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-bridge-"));
    try {
      const bridge = path.join(dir, "paperclip-bridge.js");
      await writeFile(bridge, "// test bridge\n");
      const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
      const res = await createOmpAcpExecutor({ bridgePath: bridge })(baseCtx({
        config: {
          command: `${process.execPath} ${fakeAcp}`,
          governancePolicy: "guardrails:\n  denyTools:\n    - web_search",
        },
      }));
      expect(res.exitCode).toBe(0);
      expect(executorFn).toHaveBeenCalledOnce();
      const merged = executorFn.mock.calls[0][0];
      expect(merged.config.agentCommand).toContain(bridge);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("a policy whose guardrails normalize to nothing never arms the bridge", async () => {
    const events: { level?: string; message?: string }[] = [];
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        governancePolicy: '{"guardrails":{"denyToolz":"rm -rf","denyTools":[]}}',
      },
      onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
    }));
    const merged = executorFn.mock.calls[0][0];
    const intel = sessionIntelDir("co-1", "agent-1");
    expect(merged.config.env?.PAPERCLIP_GOVERNANCE_MANIFEST).toBeUndefined();
    expect(merged.config.env?.PI_CONFIG_FILES).toBeUndefined();
    expect(merged.config.agentCommand).not.toContain("--extension");
    await expect(readFile(path.join(intel, GOVERNANCE_CONFIG_FILE), "utf8")).rejects.toThrow();
    const warn = events.find((e) => e.level === "warn" && /no enforceable rule/i.test(e.message ?? ""));
    expect(warn).toBeTruthy();
    expect(warn!.message).toContain("denyToolz");
  });

  it("an approvedEndpoints-only policy routes without ever arming the gate", async () => {
    modelsMocks.listOmpModels.mockImplementation(async () => [
      { id: "prov/m", label: "M", priced: false },
      { id: "omi/r", label: "R", priced: false },
      { id: "axon-compat/q", label: "Q", priced: false },
    ]);
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        model: "prov/m",
        governancePolicy: "approvedEndpoints:\n  - omi",
      },
    }));
    const merged = executorFn.mock.calls[0][0];
    const intel = sessionIntelDir("co-1", "agent-1");
    // Routing lands (omp enforces it natively)...
    expect(merged.config.env?.PI_CONFIG_FILES).toBe(path.join(intel, GOVERNANCE_CONFIG_FILE));
    const overlay = await readFile(path.join(intel, GOVERNANCE_CONFIG_FILE), "utf8");
    expect(overlay).toContain('disabledProviders:\n  - "axon-compat"');
    // ...and the bridge is never armed, so the gate is never relaxed.
    expect(overlay).not.toContain("approvalMode");
    expect(merged.config.env?.PAPERCLIP_GOVERNANCE_MANIFEST).toBeUndefined();
    expect(merged.config.agentCommand).not.toContain("--extension");
  });

  it("fails the run before the engine when a retry knob is outside its enum", async () => {
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "x", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    const res = await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, fallbackOn: "sometimes" },
    }));
    expect(res.errorCode).toBe("omp_config_error");
    expect(res.errorMessage).toContain("fallbackOn");
    // omp discards an unknown enum and reads the default, so a warn would be a
    // knob that silently does nothing: refuse before any engine work instead.
    expect(engineMocks.createAcpxEngineExecutor.mock.calls.length).toBe(0);
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

  it("rotates once when the operator's thinking level differs from the running session's", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "brand-new", sessionKey: "sk" } });
    const dir = sessionIntelDir("co-1", "agent-1");
    const seeded = await loadState(dir);
    seeded.lastThinking = { sessionId: "old", level: "low" };
    await saveState(dir, seeded);
    const events: Array<{ level?: string; message?: string }> = [];
    await createOmpAcpExecutor()(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, thinking: "high" },
      onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
    }));
    // A resumed session keeps the level it stored, so the new level needs a new
    // session: sessionParams is cleared exactly like the other rotate paths.
    expect(executorFn.mock.calls[0][0].runtime.sessionParams).toEqual({});
    const notice = events.find((e) => e.level === "info" && /thinking level changed/.test(e.message ?? ""));
    expect(notice?.message).toContain("low");
    expect(notice?.message).toContain("high");
    // The fresh session becomes the recorded one, at the requested level.
    expect((await loadState(dir)).lastThinking).toEqual({ sessionId: "brand-new", level: "high" });
  });

  it("keeps the session when the operator's level matches the one it started with", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const dir = sessionIntelDir("co-1", "agent-1");
    const seeded = await loadState(dir);
    seeded.lastThinking = { sessionId: "old", level: "high" };
    await saveState(dir, seeded);
    const events: Array<{ level?: string; message?: string }> = [];
    await createOmpAcpExecutor()(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, thinking: "high" },
      onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
    }));
    expect(executorFn.mock.calls[0][0].runtime.sessionParams).toMatchObject({ acpSessionId: "old" });
    expect(events.some((e) => /thinking level changed/.test(e.message ?? ""))).toBe(false);
    expect((await loadState(dir)).lastThinking).toEqual({ sessionId: "old", level: "high" });
  });

  it("adopts the level on the first run after upgrade instead of resetting the session", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const dir = sessionIntelDir("co-1", "agent-1");
    await createOmpAcpExecutor()(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, thinking: "max" },
    }));
    // No record yet: the pre-v0.10 flag rotated on any level edit, so the
    // running session already matches the config — adopting it resets nothing.
    expect(executorFn.mock.calls[0][0].runtime.sessionParams).toMatchObject({ acpSessionId: "old" });
    expect((await loadState(dir)).lastThinking).toEqual({ sessionId: "old", level: "max" });
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

  it("warns when connection tools arrive outside the declared native_mcp channel", async () => {
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const events: Array<{ level?: string; message?: string }> = [];
    const run = createOmpAcpExecutor();
    const res = await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}` },
      // invocation_context delivery: the tools exist as data, no MCP server
      // carries them, and the adapter has no way to serve them itself.
      runtimeTools: runtimeToolsAccess("http://paperclip.test/mcp/runtime-tools", "run-tools-bearer-SENTINEL"),
      runtimeMcp: { getServers: () => [] },
      onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
    }));
    const warnings = events.filter(
      (e) => e.level === "warn" && /connection tools/i.test(e.message ?? ""),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("native_mcp");
    // The run-scoped bearer is a credential: it must never reach events or
    // the heartbeat evidence blob.
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
    expect(JSON.stringify(res.resultJson ?? {})).not.toContain("SENTINEL");
  });

  it("stays quiet when the connections server is delivered over ACP", async () => {
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    const events: Array<{ level?: string; message?: string }> = [];
    const run = createOmpAcpExecutor();
    const res = await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}` },
      runtimeTools: runtimeToolsAccess("http://paperclip.test/mcp/runtime-tools", "run-tools-bearer-SENTINEL"),
      runtimeMcp: {
        getServers: () => [{
          name: "Paperclip connections",
          url: "http://paperclip.test/mcp/runtime-tools",
          token: "mcp-token-SENTINEL",
          connectionId: "paperclip-runtime-tools",
        }],
      },
      onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
    }));
    expect(events.some((e) => /connection tools/i.test(e.message ?? ""))).toBe(false);
    const sessionRuntime = res.resultJson?.sessionRuntime;
    expect(
      sessionRuntime && typeof sessionRuntime === "object" && "mcpServerCount" in sessionRuntime
        ? sessionRuntime.mcpServerCount
        : undefined,
    ).toBe(1);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
    expect(JSON.stringify(res.resultJson ?? {})).not.toContain("SENTINEL");
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
      ctx.context.taskId = ISSUE_ID;
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
      ctx.context.taskId = ISSUE_ID;
      vi.stubEnv("PAPERCLIP_API_URL", `http://127.0.0.1:${port}`);
      // fake-acp fails session/list -> queryOmpSessions fails.
      vi.stubEnv("FAKE_ACP_MODE", "listerror");
      await run(ctx);
      // Degradation contract: a failed snapshot query never fails the run.
      expect(executorFn).toHaveBeenCalledOnce();
      const queryWarn = events.find((e) => e.message.includes("snapshot query failed"));
      expect(queryWarn).toBeTruthy();
      expect(queryWarn!.message).toContain("session/list boom");
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
      ctx.context.taskId = ISSUE_ID;
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
      ctx.context.taskId = ISSUE_ID;
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
      ctx.context.taskId = ISSUE_ID;
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
      ctx.context.taskId = ISSUE_ID;
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
      ctx.context.taskId = ISSUE_ID;
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

  it("posts nothing from a non-issue wake instead of 404ing on the run path", async () => {
    const posts: string[] = [];
    const server = http.createServer((req, res) => {
      posts.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null && "port" in addr ? addr.port : 0;
    try {
      const events: Array<{ level?: string; message?: string }> = [];
      const ctx = baseCtx({
        authToken: "jwt",
        config: { command: `${process.execPath} ${fakeAcp}`, usageReport: true, sessionBrowser: true },
        onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
      });
      // A chat wake: taskId is not an issue id, so no board endpoint exists.
      ctx.context.taskId = "chat-1";
      vi.stubEnv("PAPERCLIP_API_URL", `http://127.0.0.1:${port}`);
      fakeEngine({
        exitCode: 0, usage: { inputTokens: 1000, outputTokens: 100 }, usageBasis: "per_run",
        sessionParams: { acpSessionId: "s", sessionKey: "sk" },
      });
      await createOmpAcpExecutor()(ctx);
      expect(posts).toEqual([]);
      expect(events.some((e) => /emission failed/.test(e.message ?? ""))).toBe(false);
    } finally {
      server.close();
      server.closeAllConnections();
      vi.unstubAllEnvs();
    }
  });

  it("catalog probe strips trailing flags from agentCommand (thinking:off → base 'omp')", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "s", sessionKey: "sk" } });
    const run = createOmpAcpExecutor();
    modelsMocks.listOmpModels.mockClear();
    await run(baseCtx({ config: { command: "omp", model: "prov/m", thinking: "off" } }));
    expect(modelsMocks.listOmpModels).toHaveBeenCalled();
    const calls = modelsMocks.listOmpModels.mock.calls;
    const call = calls[calls.length - 1][0];
    expect(call.command).toBe("omp");
    expect(call.args).not.toContain("acp");
    expect(call.args).not.toContain("--thinking");
    expect(call.args).not.toContain("off");
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

  it("reports a run on a model omp cannot price as unpriced, never as free", async () => {
    modelsMocks.listOmpModels.mockImplementation(async () => [
      { id: "prov/m", label: "M", pricingStatus: "unknown" },
    ]);
    fakeEngine({
      exitCode: 0, model: "prov/m", costUsd: 0,
      usage: { inputTokens: 10, outputTokens: 5 }, usageBasis: "per_run",
      sessionParams: { acpSessionId: "s", sessionKey: "sk" },
    });
    const out = await createOmpAcpExecutor()(baseCtx({ config: { command: "omp", model: "prov/m" } }));
    expect(out).toMatchObject({
      costStatus: "unpriced",
      pricingProvenance: { source: "unknown", evidence: "omp models pricingStatus=unknown" },
    });
    expect((out as { usageByModel?: unknown }).usageByModel).toBeUndefined();
  });

  it("carries a declared-free model as a zero estimate with a per-model receipt", async () => {
    modelsMocks.listOmpModels.mockImplementation(async () => [
      { id: "prov/m", label: "M", pricingStatus: "free" },
    ]);
    fakeEngine({
      exitCode: 0, model: "prov/m", costUsd: null,
      usage: { inputTokens: 10, outputTokens: 5 }, usageBasis: "per_run",
      sessionParams: { acpSessionId: "s", sessionKey: "sk" },
    });
    const out = await createOmpAcpExecutor()(baseCtx({ config: { command: "omp", model: "prov/m" } }));
    expect(out).toMatchObject({
      costUsd: 0, costStatus: "estimated",
      pricingProvenance: { source: "rate_card", evidence: "omp models pricingStatus=free" },
      usageByModel: [{ model: "prov/m", costUsd: 0 }],
    });
  });

  it("refuses to name a billed model when a fallback chain could have switched", async () => {
    fakeEngine({
      exitCode: 0, model: "prov/m", costUsd: 0.5,
      usage: { inputTokens: 10, outputTokens: 5 }, usageBasis: "per_run",
      sessionParams: { acpSessionId: "s", sessionKey: "sk" },
    });
    const events: Array<{ level?: string; message?: string }> = [];
    const out = await createOmpAcpExecutor()(baseCtx({
      config: { command: "omp", model: "prov/m", fallbackChain: "prov/backup" },
      onEvent: async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); },
    }));
    expect((out as { usageByModel?: unknown }).usageByModel).toBeUndefined();
    expect(events.some((e) => /cannot be attributed/.test(e.message ?? ""))).toBe(true);
  });

});
describe("resolveOmpAgentCommand", () => {
  it("defaults to 'omp acp'", () => {
    expect(resolveOmpAgentCommand({})).toBe("omp acp");
  });
  it("derives from command override", () => {
    expect(resolveOmpAgentCommand({ command: "/usr/local/bin/omp" })).toBe("/usr/local/bin/omp acp");
  });
  it("appends --thinking to an explicit agentCommand for off (never silently drops the directive)", () => {
    expect(resolveOmpAgentCommand({ agentCommand: "mise x omp -- acp", thinking: "off" })).toBe(
      "mise x omp -- acp --thinking off",
    );
  });
  it("appends --thinking only for off, the one level the settings key cannot express", () => {
    expect(resolveOmpAgentCommand({ thinking: "off" })).toBe("omp acp --thinking off");
    // Every other level rides the run's settings overlay: a flag here would be
    // part of the engine fingerprint and rotate the session on every edit.
    expect(resolveOmpAgentCommand({ thinking: "medium" })).toBe("omp acp");
    expect(resolveOmpAgentCommand({ thinking: "max" })).toBe("omp acp");
  });
  it("skips --thinking for default sentinel, unset, or invalid", () => {
    expect(resolveOmpAgentCommand({ thinking: "default" })).toBe("omp acp");
    expect(resolveOmpAgentCommand({})).toBe("omp acp");
    expect(resolveOmpAgentCommand({ thinking: "bogus" })).toBe("omp acp");
  });
  it("does not double-append --thinking when the explicit agentCommand already carries it", () => {
    expect(resolveOmpAgentCommand({
      agentCommand: "omp acp --thinking low",
      thinking: "off",
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
      thinking: "off",
    })).toBe("omp acp --thinking");
  });

  it("appends --extension <bridgePath> when env has PAPERCLIP_SKILLS_MANIFEST", () => {
    expect(resolveOmpAgentCommand({
      env: { PAPERCLIP_SKILLS_MANIFEST: "/tmp/manifest.json" },
    })).toBe("omp acp --extension " + path.join(path.dirname(fileURLToPath(import.meta.url)), "../../dist/paperclip-bridge.js"));
  });

  it("does not append --extension when env lacks any manifest env", () => {
    expect(resolveOmpAgentCommand({})).toBe("omp acp");
  });

  it("does not append --extension when the manifest envs are empty strings", () => {
    expect(resolveOmpAgentCommand({
      env: { PAPERCLIP_SKILLS_MANIFEST: "", PAPERCLIP_GOVERNANCE_MANIFEST: "" },
    })).toBe("omp acp");
  });

  it("appends --extension when only PAPERCLIP_GOVERNANCE_MANIFEST is set", () => {
    expect(resolveOmpAgentCommand({
      env: { PAPERCLIP_GOVERNANCE_MANIFEST: "/tmp/governance.json" },
    })).toBe("omp acp --extension " + path.join(path.dirname(fileURLToPath(import.meta.url)), "../../dist/paperclip-bridge.js"));
  });
});

describe("shouldAppendBridgeExtension", () => {
  it("returns true when manifest env is set and bridgePath is whitespace-free", () => {
    expect(shouldAppendBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "/tmp/m.json" } },
      "/opt/omp/dist/paperclip-bridge.js",
    )).toBe(true);
  });

  it("returns false when manifest env is missing", () => {
    expect(shouldAppendBridgeExtension({}, "/opt/omp/dist/paperclip-bridge.js")).toBe(false);
  });

  it("returns false when manifest env is empty string", () => {
    expect(shouldAppendBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "" } },
      "/opt/omp/dist/paperclip-bridge.js",
    )).toBe(false);
  });

  it("returns false when bridgePath contains whitespace", () => {
    expect(shouldAppendBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "/tmp/m.json" } },
      "/opt/omp dist/paperclip-bridge.js",
    )).toBe(false);
  });

  it("returns true when only the governance manifest env is set", () => {
    expect(shouldAppendBridgeExtension(
      { env: { PAPERCLIP_GOVERNANCE_MANIFEST: "/tmp/g.json" } },
      "/opt/omp/dist/paperclip-bridge.js",
    )).toBe(true);
  });

  it("returns false when the governance manifest env is empty", () => {
    expect(shouldAppendBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "", PAPERCLIP_GOVERNANCE_MANIFEST: "" } },
      "/opt/omp/dist/paperclip-bridge.js",
    )).toBe(false);
  });
});

describe("resolveBridgeRunMode", () => {
  // The module const bridgePath can never carry whitespace in a real install,
  // so the prose-fallback branch of the run wiring is guarded behind this
  // helper (it takes bridgePath). A whitespace result warns AND leaves the
  // bridge inactive, so prose injection runs and resolveOmpAgentCommand
  // appends no --extension (shouldAppendBridgeExtension returns false).
  it("returns whitespace (prose-fallback) mode with a warn when bridgePath has whitespace", () => {
    const mode = resolveBridgeRunMode("/opt/omp dist/paperclip-bridge.js");
    expect(mode).toEqual({
      kind: "whitespace",
      warn: "omp skills-as-tools bridge path contains whitespace; falling back to prompt-injected skill instructions",
    });
    // No --extension when the bridge is off (the run wiring warns and falls
    // back to prose injection instead).
    expect(shouldAppendBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "/tmp/m.json" } },
      "/opt/omp dist/paperclip-bridge.js",
    )).toBe(false);
  });

  it("returns ok (bridge active) for a whitespace-free bridgePath", () => {
    expect(resolveBridgeRunMode("/opt/omp/dist/paperclip-bridge.js")).toEqual({ kind: "ok" });
    expect(shouldAppendBridgeExtension(
      { env: { PAPERCLIP_SKILLS_MANIFEST: "/tmp/m.json" } },
      "/opt/omp/dist/paperclip-bridge.js",
    )).toBe(true);
  });

  it("keeps the approval gate armed only while the manifest and extension both land", () => {
    // P1-1: the two ways governance can fail to engage, and the one way it does.
    expect(isGovernanceArmed("/state/governance.json", "/opt/omp/dist/paperclip-bridge.js")).toBe(true);
    // Unwritable state dir: no manifest, so no handler, so the gate stays put.
    expect(isGovernanceArmed(null, "/opt/omp/dist/paperclip-bridge.js")).toBe(false);
    // Whitespace install: the manifest exists but --extension is never appended.
    expect(isGovernanceArmed("/state/governance.json", "/opt/omp dist/paperclip-bridge.js")).toBe(false);
    expect(isGovernanceArmed(null, "/opt/omp dist/paperclip-bridge.js")).toBe(false);
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
  it("keeps the thinking level out of agentCommand (the run fingerprint input)", () => {
    // The level rides the run's settings overlay instead; a flag here would make
    // every level edit a fresh-session trigger (the v0.9 behaviour).
    expect(buildOmpAcpConfig({ thinking: "medium" }).agentCommand).toBe("omp acp");
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

describe("session scope fence", () => {
  let tmpRoot: string;
  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "omp-acp-scope-"));
  });
  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    engineMocks.createAcpxEngineExecutor.mockReset();
    serverUtilsMocks.readPaperclipSkillSyncPreference.mockReturnValue({
      explicit: false, desiredSkills: [], desiredSkillEntries: [],
    });
    serverUtilsMocks.readPaperclipRuntimeSkillEntries.mockResolvedValue([]);
    serverUtilsMocks.resolvePaperclipDesiredSkillNames.mockReturnValue([]);
    serverUtilsMocks.readPaperclipSkillMarkdown.mockResolvedValue(null);
    modelsMocks.listOmpModels.mockImplementation(async () => modelsMocks.defaultModels);
    await rm(path.join(tmpRoot, "instances"), { recursive: true, force: true });
    await mkdir(path.join(tmpRoot, "instances"), { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", tmpRoot);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-scope");
    vi.stubEnv("PI_CONFIG_DIR", path.join(tmpRoot, "omp-config"));
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  const brokerEnv = { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" };

  function scopedCtx(overrides: Partial<AdapterExecutionContext> = {}) {
    return baseCtx({
      config: {
        command: `${process.execPath} ${fakeAcp}`,
        sessionScope: "isolated",
        credentialMode: "broker",
        env: { ...brokerEnv },
      },
      ...overrides,
    });
  }

  it("fails closed before any engine work when isolated runs without broker credentials", async () => {
    const executorFn = fakeEngine({ exitCode: 0 });
    const run = createOmpAcpExecutor();
    const result = await run(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, sessionScope: "isolated" },
    }));
    expect(result.errorCode).toBe("omp_config_error");
    expect(result.errorMessage).toContain("credentialMode");
    expect(executorFn).not.toHaveBeenCalled();
  });

  it("points the run child at the per-agent dir", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(scopedCtx());
    const merged = executorFn.mock.calls[0][0] as { config: { env?: Record<string, string> } };
    expect(merged.config.env?.PI_CODING_AGENT_DIR).toBe(ompAgentDir("co-1", "agent-1"));
    // Broker env still rides along: the fenced dir holds no credential store.
    expect(merged.config.env?.OMP_AUTH_BROKER_URL).toBe("http://b:8765");
  });

  it("leaves a shared run on the host agent dir", async () => {
    const executorFn = fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}` } }));
    const merged = executorFn.mock.calls[0][0] as { config: { env?: Record<string, string> } };
    expect(merged.config.env?.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it("warns once when the scope flips away from the previous run's session", async () => {
    const events: Array<{ level?: string; message?: string }> = [];
    const onEvent = async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); };
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}` }, onEvent,
    }));
    expect(events.some((e) => e.message?.includes("sessionScope"))).toBe(false);

    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "new", sessionKey: "sk-new" } });
    const result = await createOmpAcpExecutor()(scopedCtx({ onEvent }));
    // Guard the assertion below: an early omp_config_error return would also
    // produce zero warnings, and would make "warns once" untestable.
    expect(result.errorCode).toBeUndefined();
    const flips = events.filter((e) => e.message?.includes("sessionScope switched"));
    expect(flips).toHaveLength(1);
    expect(flips[0].level).toBe("warn");
    // The previous session is on record, but only its short id may be logged.
    expect(flips[0].message).not.toContain("sessionKey");
    const state = await loadState(sessionIntelDir("co-1", "agent-1"));
    expect(state.lastScope).toBe("isolated");
  });

  it("does not warn again on the next isolated run", async () => {
    const events: Array<{ level?: string; message?: string }> = [];
    const onEvent = async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); };
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}` } }));
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "new", sessionKey: "sk-new" } });
    await createOmpAcpExecutor()(scopedCtx({ onEvent }));
    const first = events.filter((e) => e.message?.includes("sessionScope switched")).length;
    expect(first).toBe(1);
    events.length = 0;
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "new", sessionKey: "sk-new" } });
    await createOmpAcpExecutor()(scopedCtx({ onEvent }));
    expect(events.filter((e) => e.message?.includes("sessionScope switched"))).toHaveLength(0);
  });

  it("reports the host-wide listing as counts only when the diagnostic is on", async () => {
    const events: Array<{ level?: string; message?: string }> = [];
    const onEvent = async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); };
    const browserConfig = { sessionBrowser: "true" } as Record<string, unknown>;
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}`, sessionSnapshotDiagnostic: true, ...browserConfig },
      onEvent,
    }));
    const diagnostic = events.filter((e) => e.message?.includes("host-wide listing"));
    expect(diagnostic).toHaveLength(1);
    expect(diagnostic[0].message).toContain("2 sessions");
    expect(diagnostic[0].message).toContain("1 project");
    expect(diagnostic[0].message).not.toContain("sess-a");
  });

  it("emits no host-wide diagnostic by default", async () => {
    const events: Array<{ level?: string; message?: string }> = [];
    const onEvent = async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); };
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}` }, onEvent,
    }));
    expect(events.some((e) => e.message?.includes("host-wide listing"))).toBe(false);
  });

  it("warns once when the scope flips back to shared", async () => {
    const events: Array<{ level?: string; message?: string }> = [];
    const onEvent = async (ev: unknown) => { events.push(ev as { level?: string; message?: string }); };
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } });
    await createOmpAcpExecutor()(baseCtx({ config: { command: `${process.execPath} ${fakeAcp}` } }));
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "new", sessionKey: "sk-new" } });
    await createOmpAcpExecutor()(scopedCtx({ onEvent }));
    events.length = 0;
    fakeEngine({ exitCode: 0, sessionParams: { acpSessionId: "newer", sessionKey: "sk-newer" } });
    const result = await createOmpAcpExecutor()(baseCtx({
      config: { command: `${process.execPath} ${fakeAcp}` }, onEvent,
    }));
    expect(result.errorCode).toBeUndefined();
    const flips = events.filter((e) => e.message?.includes("sessionScope switched to 'shared'"));
    expect(flips).toHaveLength(1);
    expect(flips[0].message).toContain("the host-wide omp agent dir");
  });
});

describe("probeOmpAcpSession session/list capability", () => {
  it("reports the capability the snapshot read depends on", async () => {
    const probe = await probeOmpAcpSession({ command: process.execPath, args: [fakeAcp] });
    expect(probe.ok).toBe(true);
    expect(probe.supportsSessionList).toBe(true);
  }, 15_000);
  it("reports absence on a build that does not advertise it", async () => {
    const probe = await probeOmpAcpSession(
      { command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_MODE: "nolist" } },
    );
    expect(probe.ok).toBe(true);
    expect(probe.supportsSessionList).toBe(false);
  }, 15_000);


});
