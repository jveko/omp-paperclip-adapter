import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "./acp.js";

// Regression guards for env threading into the fork and session-query side
// channels. The fork and query call sites in createOmpAcpExecutor must forward
// the resolved side-channel env (OMP_AUTH_BROKER_URL for broker credential
// mode). Fork and session-intel are mocked so we can inspect the omp args each
// receives without spawning real subprocesses.
const mocks = vi.hoisted(() => ({
  forkOmpSession: vi.fn(async () => ({ ok: true, sessionId: "fork-1" })),
  queryOmpSessions: vi.fn(async () => ({
    ok: true,
    snapshot: { projects: [], sessions: [], total: 0, byCwd: [] },
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
    ctx.context.taskId = "issue-1";
    await run(ctx);
    expect(mocks.queryOmpSessions).toHaveBeenCalledTimes(1);
    const ompArg = mocks.queryOmpSessions.mock.calls[0][0] as { env?: Record<string, string> };
    expect(ompArg.env?.OMP_AUTH_BROKER_URL).toBe("http://b:8765");
    expect(ompArg.env?.OMP_AUTH_BROKER_TOKEN).toBe("tok");
  });
});
