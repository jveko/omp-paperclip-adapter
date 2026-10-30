import { execFile } from "node:child_process";
import type * as NodeChildProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { evaluateConfigOptionCheck, evaluateOmpVersionCheck, testEnvironment } from "./test.js";
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
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, "omp/18.13.1"));
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
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, "omp/18.13.1"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("runs --version and auth-broker status through the full resolved command", async () => {
    // A trailing `acp` is stripped so non-ACP subcommands are appended to the
    // wrapper invocation rather than argv[0]-only.
    execFileMock
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.13.1"))
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
  it("strips trailing --thinking flags from BOTH probes for a thinking-configured agent", async () => {
    // With thinking set, resolveOmpAgentCommand yields `omp acp --thinking medium`.
    // The base split (indexOf "acp") must still yield `omp` so the version probe
    // is `omp --version` and the broker probe is `omp auth-broker status --json`,
    // not a mangled `omp acp --thinking medium --version` that starts an ACP
    // server and times out.
    execFileMock
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.13.1"))
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, '{"ok":true,"url":"http://b:8765","version":"18"}'));
    await testEnvironment(envTestCtx({
      credentialMode: "broker",
      command: "omp",
      thinking: "medium",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
    }));
    const calls = execFileMock.mock.calls;
    expect(calls[0][0]).toBe("omp");
    expect(calls[0][1]).toEqual(["--version"]);
    expect(calls[1][0]).toBe("omp");
    expect(calls[1][1]).toEqual(["auth-broker", "status", "--json"]);
  });
});

describe("testEnvironment broker-status parsing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a reachable broker check (info) when status returns ok", async () => {
    execFileMock
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.13.1"))
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
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.13.1"))
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
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.13.1"))
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
    execFileMock.mockImplementationOnce((_c, _a, _o, cb) => cb(null, "omp/18.13.1"));
    const res = await testEnvironment(envTestCtx({}));
    expect(res.checks.some((c) => c.code === "omp_otlp_export_off" || c.code === "omp_otlp_export_armed")).toBe(true);
  });
});

describe("evaluateOmpVersionCheck", () => {
  it("accepts a build inside the tested 18.13 line", () => {
    const check = evaluateOmpVersionCheck({ major: 18, minor: 13, patch: 1 }, "omp/18.13.1", "/usr/bin/omp");
    expect(check.level).toBe("info");
    expect(check.code).toBe("omp_version");
  });

  it("rejects a newer minor on a directly executed omp and names the supported range", () => {
    const check = evaluateOmpVersionCheck({ major: 18, minor: 14, patch: 0 }, "omp/18.14.0", "/usr/bin/omp");
    expect(check.level).toBe("error");
    expect(check.code).toBe("omp_version_unsupported");
    expect(check.message).toContain("18.14.0");
    expect(check.message).toContain("18.13");
  });

  it.each([
    {
      name: "a major bump",
      version: { major: 19, minor: 0, patch: 0 },
      output: "omp/19.0.0",
    },
    {
      name: "an older minor",
      version: { major: 18, minor: 12, patch: 9 },
      output: "omp/18.12.9",
    },
  ])("rejects $name on a directly executed omp", ({ version, output }) => {
    const check = evaluateOmpVersionCheck(version, output, "omp");
    expect(check.level).toBe("error");
    expect(check.code).toBe("omp_version_unsupported");
  });

  it.each(["/usr/bin/node", "mise"])(
    "does not fail a wrapper command (%s) whose reported version is outside the range",
    (command) => {
      const check = evaluateOmpVersionCheck({ major: 18, minor: 14, patch: 0 }, "omp/18.14.0", command);
      expect(check.level).toBe("warn");
      expect(check.code).toBe("omp_version_unverified");
    },
  );

  it("warns when the version output cannot be parsed", () => {
    const check = evaluateOmpVersionCheck(null, "not a version", "/usr/bin/omp");
    expect(check.level).toBe("warn");
    expect(check.code).toBe("omp_version_unparsed");
    expect(check.detail).toContain("not a version");
  });
});

describe("evaluateConfigOptionCheck", () => {
  it("reports the configured-option surface when the build advertises all three ids", () => {
    const check = evaluateConfigOptionCheck({ configOptionIds: ["mode", "model", "thinking"] });
    expect(check.level).toBe("info");
    expect(check.code).toBe("omp_config_options");
    expect(check.message).toContain("model");
  });

  it("warns when the build drops the model id from its advertised config options", () => {
    const check = evaluateConfigOptionCheck({ configOptionIds: ["mode", "thinking"] });
    expect(check.level).toBe("warn");
    expect(check.code).toBe("omp_config_option_model_missing");
    expect(check.detail).toContain("mode");
    expect(check.detail).toContain("thinking");
    expect(check.detail).toContain("mode|model|thinking");
  });

  it("warns when the probe advertises no config option ids at all", () => {
    const check = evaluateConfigOptionCheck({});
    expect(check.level).toBe("warn");
    expect(check.code).toBe("omp_config_option_model_missing");
  });
});

describe("testEnvironment omp version gate", () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "omp-test-env-"));
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
  beforeEach(() => execFileMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("fails the environment test when a directly executed omp is outside the tested range", async () => {
    // ensureAdapterExecutionTargetCommandResolvable runs for real, so the
    // command must be a real executable file; only --version is stubbed.
    const ompPath = path.join(tmpDir, "omp");
    await writeFile(ompPath, "#!/bin/sh\n", { mode: 0o755 });
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, "omp/18.14.0"));

    const res = await testEnvironment(envTestCtx({ command: ompPath }));

    expect(res.checks.some((c) => c.code === "omp_command_resolvable")).toBe(true);
    const check = res.checks.find((c) => c.code === "omp_version_unsupported");
    expect(check).toBeTruthy();
    expect(check!.level).toBe("error");
    expect(res.status).toBe("fail");
  });
});