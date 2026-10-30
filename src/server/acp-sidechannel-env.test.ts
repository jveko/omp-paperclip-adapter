import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "./acp.js";
import { FAILOVER_CONFIG_FILE } from "./failover-config.js";
import { GOVERNANCE_CONFIG_FILE } from "./governance-overlay.js";
import { ompAgentDir, sessionIntelDir } from "./session-state.js";

// Regression guards for env threading into the fork and session-query side
// channels. The fork and query call sites in createOmpAcpExecutor must forward
// the resolved side-channel env (OMP_AUTH_BROKER_URL for broker credential
// mode, and PI_CONFIG_FILES when a failover fallbackChain is set). Fork and
// session-intel are mocked so we can inspect the omp args each receives without
// spawning real subprocesses.
const mocks = vi.hoisted(() => ({
  forkOmpSession: vi.fn(async () => ({ ok: true, sessionId: "fork-1" })),
  queryOmpSessions: vi.fn(async () => ({
    ok: true,
    snapshot: { projects: [], sessions: [], total: 0, truncated: false },
  })),
  createAcpxEngineExecutor: vi.fn(),
}));

vi.mock("./session-intel.js", () => ({
  forkOmpSession: mocks.forkOmpSession,
  queryOmpSessions: mocks.queryOmpSessions,
}));

vi.mock("@paperclipai/adapter-utils/acpx-engine/execute", () => ({
  createAcpxEngineExecutor: mocks.createAcpxEngineExecutor,
}));

/** Paperclip issue ids are UUIDs; only those runs may post work products. */
const ISSUE_ID = "0b8f0d5e-9a10-4f6a-8f2b-1c2d3e4f5a6b";

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
    context: { taskId: "" },
    onLog: async () => {},
    onEvent: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

const BROKER_ENV = {
  credentialMode: "broker",
  env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
};

describe("side-channel env threading", () => {
  let tmpRoot: string;
  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "omp-sidechannel-env-"));
  });
  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    mocks.createAcpxEngineExecutor.mockReset();
    mocks.forkOmpSession.mockClear();
    mocks.queryOmpSessions.mockClear();
    vi.stubEnv("PAPERCLIP_HOME", tmpRoot);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-sidechannel-env");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("forwards broker env into the fork side channel", async () => {
    const executor = vi.fn(async () => ({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } }));
    mocks.createAcpxEngineExecutor.mockReturnValue(executor);
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: "omp", sessionForkSourceId: "sess-a", sessionForkToken: "t1", ...BROKER_ENV },
    }));
    expect(mocks.forkOmpSession).toHaveBeenCalledTimes(1);
    const ompArg = mocks.forkOmpSession.mock.calls[0][0] as { env?: Record<string, string> };
    expect(ompArg.env?.OMP_AUTH_BROKER_URL).toBe("http://b:8765");
    expect(ompArg.env?.OMP_AUTH_BROKER_TOKEN).toBe("tok");
  });

  it("forwards broker env into the session-query side channel", async () => {
    const executor = vi.fn(async () => ({ exitCode: 0, sessionParams: { acpSessionId: "s1", sessionKey: "sk" } }));
    mocks.createAcpxEngineExecutor.mockReturnValue(executor);
    const run = createOmpAcpExecutor();
    const ctx = baseCtx({
      config: { command: "omp", sessionBrowser: true, ...BROKER_ENV },
    });
    ctx.context.taskId = ISSUE_ID;
    await run(ctx);
    expect(mocks.queryOmpSessions).toHaveBeenCalledTimes(1);
    const ompArg = mocks.queryOmpSessions.mock.calls[0][0] as { env?: Record<string, string> };
    expect(ompArg.env?.OMP_AUTH_BROKER_URL).toBe("http://b:8765");
    expect(ompArg.env?.OMP_AUTH_BROKER_TOKEN).toBe("tok");
  });

  it("forwards the failover overlay (PI_CONFIG_FILES) into the fork side channel when fallbackChain is set", async () => {
    const executor = vi.fn(async () => ({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } }));
    mocks.createAcpxEngineExecutor.mockReturnValue(executor);
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: { command: "omp", sessionForkSourceId: "sess-a", sessionForkToken: "t-overlay", fallbackChain: "brokerco/main\nbrokerco/fast" },
    }));
    expect(mocks.forkOmpSession).toHaveBeenCalledTimes(1);
    const ompArg = mocks.forkOmpSession.mock.calls[0][0] as { env?: Record<string, string> };
    expect(ompArg.env?.PI_CONFIG_FILES).toBeTruthy();
  });

  it("keeps the governance routing overlay out of the fork side channel while the run child gets it", async () => {
    // Same invariant as the catalog probe, on the other side channel: ompEnv's
    // overlayPath is the failover file ONLY. Routing keys reaching a side
    // channel would filter the model list the next run's complement is built
    // from. The run child still receives both overlays.
    const executor = vi.fn(async () => ({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } }));
    mocks.createAcpxEngineExecutor.mockReturnValue(executor);
    await createOmpAcpExecutor()(baseCtx({
      config: {
        command: "omp",
        sessionForkSourceId: "sess-a", sessionForkToken: "t-gov",
        fallbackChain: "brokerco/main",
        // A bridge rail carries the gate; the routing lever is this test's point.
        governancePolicy: "guardrails:\n  denyTools:\n    - web_search\napprovedEndpoints: [brokerco]",
      },
    }));
    expect(mocks.forkOmpSession).toHaveBeenCalledTimes(1);
    const forkArg = mocks.forkOmpSession.mock.calls[0][0] as { env?: Record<string, string> };
    const forkPi = forkArg.env?.PI_CONFIG_FILES ?? "";
    expect(forkPi).toContain(FAILOVER_CONFIG_FILE);
    expect(forkPi).not.toContain(GOVERNANCE_CONFIG_FILE);
    for (const file of forkPi.split(path.delimiter)) {
      const yaml = await readFile(file, "utf8");
      expect(yaml).not.toContain("disabledProviders");
      expect(yaml).not.toContain("approvalMode");
    }
    const merged = executor.mock.calls[0][0] as { config?: { env?: Record<string, string> } };
    expect(merged.config?.env?.PI_CONFIG_FILES).toBe([
      path.join(sessionIntelDir("co-1", "agent-1"), FAILOVER_CONFIG_FILE),
      path.join(sessionIntelDir("co-1", "agent-1"), GOVERNANCE_CONFIG_FILE),
    ].join(path.delimiter));
  });

  it("points both side channels at the fenced agent dir under sessionScope isolated", async () => {
    const executor = vi.fn(async () => ({ exitCode: 0, sessionParams: { acpSessionId: "fork-1", sessionKey: "sk" } }));
    mocks.createAcpxEngineExecutor.mockReturnValue(executor);
    const ctx = baseCtx({
      config: {
        command: "omp", sessionForkSourceId: "sess-a", sessionForkToken: "t-fence",
        sessionBrowser: true, sessionScope: "isolated",
        credentialMode: "broker",
        env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
      },
    });
    ctx.context.taskId = ISSUE_ID;
    await createOmpAcpExecutor()(ctx);
    const expected = ompAgentDir("co-1", "agent-1");
    const forkArg = mocks.forkOmpSession.mock.calls[0][0] as { env?: Record<string, string> };
    const queryArg = mocks.queryOmpSessions.mock.calls[0][0] as { env?: Record<string, string> };
    expect(forkArg.env?.PI_CODING_AGENT_DIR).toBe(expected);
    expect(queryArg.env?.PI_CODING_AGENT_DIR).toBe(expected);
    // The run child carries the same value, so all three resolve one dir.
    const merged = executor.mock.calls[0][0] as { config?: { env?: Record<string, string> } };
    expect(merged.config?.env?.PI_CODING_AGENT_DIR).toBe(expected);
  });
});
