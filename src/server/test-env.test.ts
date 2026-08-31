import { execFile } from "node:child_process";
import type * as NodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { testEnvironment } from "./test.js";

// Regression guard for env threading into the environment-test version probe.
// testEnvironment's execFile probe must carry the side-channel env
// (OMP_AUTH_BROKER_URL for broker credential mode) so the spawned omp resolves
// credentials identically to a real run. node:child_process is mocked with a
// partial (execFile spied, spawn left real) so the version probe is captured
// hermetically while the ACP handshake probe still works. The handshake env
// itself is separately guarded by session-intel.env.test.ts's driveAcpSession
// assertion.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, execFile: vi.fn() };
});

const execFileMock = vi.mocked(execFile);

function envTestCtx(overrides: Record<string, unknown> = {}): AdapterEnvironmentTestContext {
  return {
    adapterType: "omp_local",
    config: { command: process.execPath, ...overrides },
    executionTarget: null,
  } as unknown as AdapterEnvironmentTestContext;
}

describe("testEnvironment version-probe env threading", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    // Resolve the version probe so testEnvironment completes without a real omp.
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, "omp/18.0.5"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("forwards broker env into the execFile version probe", async () => {
    await testEnvironment(envTestCtx({
      credentialMode: "broker",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
    }));
    expect(execFileMock).toHaveBeenCalled();
    const opts = execFileMock.mock.calls[0][2] as { env?: Record<string, string> };
    expect(opts.env?.OMP_AUTH_BROKER_URL).toBe("http://b:8765");
    expect(opts.env?.OMP_AUTH_BROKER_TOKEN).toBe("tok");
  });
});
