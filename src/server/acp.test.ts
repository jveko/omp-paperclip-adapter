import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildOmpAcpConfig,
  deriveDefaultTimeoutSec,
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
