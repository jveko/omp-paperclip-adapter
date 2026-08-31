import { execFile } from "node:child_process";
import type * as NodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { testEnvironment } from "./test.js";
import type * as AcpModule from "./acp.js";

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

const acpMocks = vi.hoisted(() => ({
  probeOmpAcpSession: vi.fn(async () => ({
    ok: true, protocolVersion: 1, currentModel: "glm-5.2",
  })),
}));

// Capture the ACP handshake probe so we can assert its env (the execFile mock
// only covers the version probe). Real parseOmpVersion/resolveOmpAgentCommand
// stay intact; only probeOmpAcpSession is intercepted.
vi.mock("./acp.js", async (importOriginal) => {
  const actual = await importOriginal<AcpModule>();
  return { ...actual, probeOmpAcpSession: acpMocks.probeOmpAcpSession };
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

  it("forwards broker env into the ACP handshake probe", async () => {
    acpMocks.probeOmpAcpSession.mockClear();
    await testEnvironment(envTestCtx({
      credentialMode: "broker",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
    }));
    expect(acpMocks.probeOmpAcpSession).toHaveBeenCalled();
    const probe = acpMocks.probeOmpAcpSession.mock.calls[0][0] as { env?: Record<string, string> };
    expect(probe.env?.OMP_AUTH_BROKER_URL).toBe("http://b:8765");
    expect(probe.env?.OMP_AUTH_BROKER_TOKEN).toBe("tok");
  });
});

describe("testEnvironment multi-token command probes", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, "omp/18.0.5"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("runs --version and auth-broker status through the full resolved command", async () => {
    // A trailing `acp` is stripped so non-ACP subcommands are appended to the
    // wrapper invocation rather than argv[0]-only.
    execFileMock
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.0.5"))
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, '{"ok":true,"url":"http://b:8765","version":"18"}'));
    await testEnvironment(envTestCtx({
      credentialMode: "broker",
      agentCommand: "mise x omp -- acp",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
    }));
    const calls = execFileMock.mock.calls;
    expect(calls[0][0]).toBe("mise");
    expect(calls[0][1]).toEqual(["x", "omp", "--", "--version"]);
    expect(calls[1][0]).toBe("mise");
    expect(calls[1][1]).toEqual(["x", "omp", "--", "auth-broker", "status", "--json"]);
  });
});

describe("testEnvironment broker-status parsing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a reachable broker check (info) when status returns ok", async () => {
    execFileMock
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.0.5"))
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, '{"url":"http://b:8765","ok":true,"version":"18"}'));
    const res = await testEnvironment(envTestCtx({
      credentialMode: "broker",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
    }));
    const check = res.checks.find((c) => c.code === "omp_broker_reachable");
    expect(check).toBeTruthy();
    expect(check!.level).toBe("info");
    expect(check!.detail).toContain("http://b:8765");
  });

  it("reports an unreachable broker check (warn) when not configured", async () => {
    execFileMock
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.0.5"))
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, '{"ok":false,"reason":"not_configured"}'));
    const res = await testEnvironment(envTestCtx({
      credentialMode: "broker",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
    }));
    const check = res.checks.find((c) => c.code === "omp_broker_unreachable");
    expect(check).toBeTruthy();
    expect(check!.level).toBe("warn");
  });

  it("keeps the broker error in detail (not 'no output') when status reports connection refused", async () => {
    execFileMock
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.0.5"))
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, '{"ok":false,"url":"http://b:8765","error":"connection refused"}'));
    const res = await testEnvironment(envTestCtx({
      credentialMode: "broker",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
    }));
    const check = res.checks.find((c) => c.code === "omp_broker_unreachable");
    expect(check).toBeTruthy();
    expect(check!.level).toBe("warn");
    expect(check!.detail).toContain("connection refused");
    expect(check!.detail).not.toContain("no output");
  });
});

describe("testEnvironment OTLP diagnostic", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits an OTLP export diagnostic check", async () => {
    execFileMock.mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.0.5"));
    const res = await testEnvironment(envTestCtx({}));
    expect(res.checks.some((c) => c.code === "omp_otlp_export_off" || c.code === "omp_otlp_export_armed")).toBe(true);
  });
});