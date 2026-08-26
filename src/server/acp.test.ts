import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildOmpAcpConfig,
  parseOmpVersion,
  probeOmpAcpSession,
  resolveOmpAgentCommand,
  resolveOmpBillingIdentity,
} from "./acp.js";

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
