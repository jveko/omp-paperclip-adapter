import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "./acp.js";

// Regression guard for env threading into the model-catalog side channel:
// the catalog call site in createOmpAcpExecutor must forward the resolved
// side-channel env (OMP_AUTH_BROKER_URL for broker credential mode). The
// mutation test that deletes `env:` at that call site leaves the rest of the
// suite green, so this file asserts it directly. Uses the same engine-mock
// pattern as acp.test.ts; listOmpModels is spied so we can inspect the options.
const mocks = vi.hoisted(() => ({
  listOmpModels: vi.fn(async () => [{ id: "prov/m", label: "M", priced: false }]),
  normalizeOmpModelId: vi.fn((model: string) => model),
  isFreeCost: vi.fn(() => false),
  createAcpxEngineExecutor: vi.fn(),
}));

vi.mock("./models.js", () => ({
  isFreeCost: mocks.isFreeCost,
  listOmpModels: mocks.listOmpModels,
  normalizeOmpModelId: mocks.normalizeOmpModelId,
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

describe("catalog call site env threading", () => {
  let tmpRoot: string;
  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "omp-catalog-env-"));
  });
  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    mocks.createAcpxEngineExecutor.mockReset();
    mocks.listOmpModels.mockClear();
    vi.stubEnv("PAPERCLIP_HOME", tmpRoot);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-catalog-env");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("forwards broker env into the listOmpModels options", async () => {
    const executor = vi.fn(async () => ({ exitCode: 0, sessionParams: { acpSessionId: "old", sessionKey: "sk" } }));
    mocks.createAcpxEngineExecutor.mockReturnValue(executor);
    const run = createOmpAcpExecutor();
    await run(baseCtx({
      config: {
        model: "prov/m",
        credentialMode: "broker",
        env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
      },
    }));
    expect(mocks.listOmpModels).toHaveBeenCalledTimes(1);
    const opts = mocks.listOmpModels.mock.calls[0][0] as { env?: Record<string, string> };
    expect(opts.env?.OMP_AUTH_BROKER_URL).toBe("http://b:8765");
    expect(opts.env?.OMP_AUTH_BROKER_TOKEN).toBe("tok");
  });
});
