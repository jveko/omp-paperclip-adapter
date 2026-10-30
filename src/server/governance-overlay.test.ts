import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OmpModelInfo } from "./models.js";
import {
  GOVERNANCE_CONFIG_FILE,
  materializeGovernanceOverlay,
  planEndpointRouting,
  providerFacet,
} from "./governance-overlay.js";

function model(id: string): OmpModelInfo {
  return { id, label: id, priced: false };
}

const CATALOG = [model("prov/m"), model("omi/r"), model("axon-compat/q")];

describe("providerFacet", () => {
  it("takes the provider half of a provider/id selector", () => {
    expect(providerFacet("brokerco/main")).toBe("brokerco");
    expect(providerFacet("openai-compat/gpt-4o")).toBe("openai-compat");
  });
  it("returns empty for a bare selector (no provider half to trust)", () => {
    expect(providerFacet("gpt-4o")).toBe("");
    expect(providerFacet("/x")).toBe("");
    expect(providerFacet("")).toBe("");
  });
});

describe("planEndpointRouting", () => {
  const base = {
    models: CATALOG,
    approvedEndpoints: ["prov"],
    configuredModel: "prov/m",
    fallbackChain: [] as string[],
  };

  it("disables the complement of the approved endpoints", () => {
    const plan = planEndpointRouting(base);
    expect(plan.skipped).toBeNull();
    expect(plan.disabled).toEqual(["axon-compat", "omi"]);
    expect(plan.kept).toEqual([]);
  });

  it("never disables the configured model's provider, and reports the guard", () => {
    const plan = planEndpointRouting({ ...base, approvedEndpoints: ["omi"] });
    expect(plan.disabled).toEqual(["axon-compat"]);
    // `prov` serves the run's own model yet is unapproved: guard-kept, reported.
    expect(plan.kept).toEqual(["prov"]);
  });

  it("never disables a provider named by the fallback chain", () => {
    const plan = planEndpointRouting({
      ...base,
      approvedEndpoints: ["prov"],
      fallbackChain: ["omi/r", "unknownco/backup"],
    });
    expect(plan.disabled).toEqual(["axon-compat"]);
    expect(plan.kept).toEqual(["omi"]);
  });

  it("resolves a providerless configured selector through the catalog", () => {
    // `gpt-4o` is how an operator may write the model; the catalog says it is
    // openai-compat's, so that provider must survive the complement.
    const plan = planEndpointRouting({
      models: [model("openai-compat/gpt-4o"), model("omi/r")],
      approvedEndpoints: ["omi"],
      configuredModel: "gpt-4o",
      fallbackChain: [],
    });
    expect(plan.disabled).toEqual([]);
    expect(plan.kept).toEqual(["openai-compat"]);
  });

  it("refuses to route when the configured provider cannot be identified", () => {
    const plan = planEndpointRouting({
      models: [model("openai-compat/gpt-4o")],
      approvedEndpoints: ["openai-compat"],
      configuredModel: "mystery-model",
      fallbackChain: [],
    });
    expect(plan.disabled).toEqual([]);
    expect(plan.skipped).toMatch(/mystery-model/);
  });

  it("refuses to route with no catalog (routing cannot run blind)", () => {
    const plan = planEndpointRouting({ ...base, models: [], configuredModel: null });
    expect(plan.disabled).toEqual([]);
    expect(plan.skipped).toMatch(/no providers/);
  });

  it("refuses to disable every known provider when no approval matches the catalog", () => {
    const plan = planEndpointRouting({ ...base, approvedEndpoints: ["typo-co"] });
    expect(plan.disabled).toEqual([]);
    expect(plan.skipped).toMatch(/none of approvedEndpoints/);
  });

  it("matches approved endpoints case-insensitively (a typo must not disable)", () => {
    const plan = planEndpointRouting({ ...base, approvedEndpoints: ["PROV", " Omi "] });
    expect(plan.disabled).toEqual(["axon-compat"]);
  });

  it("is deterministic: known providers are deduped and sorted", () => {
    const plan = planEndpointRouting({
      models: [model("zeta/a"), model("alpha/b"), model("zeta/c"), model("prov/m")],
      approvedEndpoints: ["prov"],
      configuredModel: "prov/m",
      fallbackChain: [],
    });
    expect(plan.disabled).toEqual(["alpha", "zeta"]);
  });
});

describe("materializeGovernanceOverlay", () => {
  it("writes nothing when governance is off, vacuous, or unparseable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      for (const config of [
        {},
        { governancePolicy: "   " },
        { governancePolicy: "guardrails: {}" },
        { governancePolicy: "whoKnows: 1" },
        { governancePolicy: "{ broken" },
      ]) {
        expect(await materializeGovernanceOverlay(config, dir)).toEqual({ status: "none" });
      }
      await expect(readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // P1-1 (v0.8 final review): the single-gate relaxation used to ride on the
  // policy alone. A policy that could not reach the child (unwritable manifest)
  // or that the child could not load (whitespace in the extension path) still
  // turned off omp's own permission gate, leaving no gate at all. `armed` is
  // now an explicit input: no arming, no relaxation.
  it("carries the single gate for an armed policy with no routing when unapproved", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const res = await materializeGovernanceOverlay(
        { governancePolicy: "guardrails:\n  denyTools:\n    - web_search" },
        dir,
        { armed: true },
      );
      expect(res.status).toBe("ok");
      expect(res.status === "ok" && res.path).toBe(path.join(dir, GOVERNANCE_CONFIG_FILE));
      const yaml = await readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8");
      expect(yaml).toMatch(/^tools:\n {2}approvalMode: yolo$/m);
      expect(yaml).not.toContain("disabledProviders");
      expect(res.status === "ok" && res.disabled).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never relaxes the gate while governance is unarmed, but still routes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const res = await materializeGovernanceOverlay(
        { governancePolicy: "guardrails:\n  denyTools:\n    - web_search\napprovedEndpoints:\n  - prov\n  - omi" },
        dir,
        { models: CATALOG, configuredModel: "prov/m", armed: false },
      );
      expect(res.status).toBe("ok");
      const yaml = await readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8");
      // Routing is enforced by omp itself, so it lands; the gate does not move.
      expect(yaml).toContain('disabledProviders:\n  - "axon-compat"');
      expect(yaml).not.toContain("approvalMode");
      expect(yaml).not.toMatch(/^tools:/m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing when an unarmed policy has no routing to apply", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const res = await materializeGovernanceOverlay(
        { governancePolicy: "guardrails:\n  denyTools:\n    - web_search" },
        dir,
        { armed: false },
      );
      expect(res).toEqual({ status: "none" });
      await expect(readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not relax the gate for a routing-only policy even when armed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const res = await materializeGovernanceOverlay(
        { governancePolicy: "approvedEndpoints:\n  - prov\n  - omi" },
        dir,
        { models: CATALOG, configuredModel: "prov/m", armed: true },
      );
      expect(res.status).toBe("ok");
      const yaml = await readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8");
      expect(yaml).toContain('disabledProviders:\n  - "axon-compat"');
      expect(yaml).not.toContain("approvalMode");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // v0.9: `restrictedFolders` is enforced by omp in the run child, so it lands
  // regardless of arming — unlike `approvalMode`, which only moves when the
  // bridge is armed and has a rule to run.
  it("writes restrictedFolders even for an unarmed policy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const res = await materializeGovernanceOverlay(
        { governancePolicy: "restrictedFolders:\n  - /srv/secrets\n  - ~/keys" },
        dir,
        { armed: false },
        vi.fn(),
      );
      expect(res.status).toBe("ok");
      const yaml = await readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8");
      expect(yaml).toContain("tools:");
      expect(yaml).toMatch(/^ {2}restrictedFolders:$/m);
      expect(yaml).toMatch(/^\s+- "\/srv\/secrets"$/m);
      expect(yaml).toMatch(/^\s+- "~\/keys"$/m);
      expect(yaml).not.toContain("approvalMode");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps restrictedFolders alongside the single-gate relaxation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const res = await materializeGovernanceOverlay(
        {
          governancePolicy:
            "guardrails:\n  denyTools:\n    - web_search\nrestrictedFolders:\n  - /srv/secrets",
        },
        dir,
        { armed: true },
        vi.fn(),
      );
      expect(res.status).toBe("ok");
      const yaml = await readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8");
      expect(yaml).toMatch(/^ {2}approvalMode: yolo$/m);
      expect(yaml).toMatch(/^ {2}restrictedFolders:$/m);
      expect(yaml).toMatch(/^\s+- "\/srv\/secrets"$/m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits no restrictedFolders line when the policy does not set it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const res = await materializeGovernanceOverlay(
        { governancePolicy: "guardrails:\n  denyTools:\n    - web_search" },
        dir,
        { armed: true },
        vi.fn(),
      );
      expect(res.status).toBe("ok");
      const yaml = await readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8");
      expect(yaml).toMatch(/^tools:\n {2}approvalMode: yolo$/m);
      expect(yaml).not.toContain("restrictedFolders");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("relaxes the gate for a restrictedFolders-only policy when the bridge is armed", async () => {
    // The bridge holds restricted-folder calls as approvals, so it is the gate
    // this run relies on; keeping omp's own prompt would only add an ask the
    // ACP proxy answers. Unarmed (previous test) it must not be emitted.
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const res = await materializeGovernanceOverlay(
        { governancePolicy: "restrictedFolders:\n  - /srv/secrets" },
        dir,
        { armed: true },
        vi.fn(),
      );
      expect(res.status).toBe("ok");
      const yaml = await readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8");
      expect(yaml).toMatch(/^ {2}approvalMode: yolo$/m);
      expect(yaml).toMatch(/^ {2}restrictedFolders:$/m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits disabledProviders for the approved-endpoint complement", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const res = await materializeGovernanceOverlay(
        {
          governancePolicy: "approvedEndpoints:\n  - prov\n  - omi",
          fallbackChain: "unknownco/backup",
        },
        dir,
        { models: CATALOG, configuredModel: "prov/m" },
      );
      expect(res.status).toBe("ok");
      const yaml = await readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8");
      expect(yaml).toContain("disabledProviders:\n  - \"axon-compat\"");
      // Approved providers stay out of the list; a chain selector naming a
      // provider the catalog does not know changes nothing.
      expect(yaml).not.toMatch(/- "prov"/);
      expect(yaml).not.toMatch(/- "omi"/);
      expect(res.status === "ok" && res.kept).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("warns instead of emitting disabledProviders when the complement cannot be computed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    const warn = vi.fn();
    try {
      const res = await materializeGovernanceOverlay(
        {
          // A real rail alongside the inert routing lever: the rail is what
          // pays for the gate, the routing failure only costs the providers.
          governancePolicy: "guardrails:\n  denyTools:\n    - web_search\napprovedEndpoints: [brokerco]",
        },
        dir,
        { models: [], configuredModel: null, armed: true },
        warn,
      );
      // Still governed (the gate stays armed) — just unrouted.
      expect(res.status).toBe("ok");
      const yaml = await readFile(path.join(dir, GOVERNANCE_CONFIG_FILE), "utf8");
      expect(yaml).toContain("approvalMode: yolo");
      expect(yaml).not.toContain("disabledProviders");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/routing skipped/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("warns when a guard had to protect an unapproved provider", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    const warn = vi.fn();
    try {
      const res = await materializeGovernanceOverlay(
        { governancePolicy: "approvedEndpoints: [omi]" },
        dir,
        { models: CATALOG, configuredModel: "prov/m" },
        warn,
      );
      expect(res.status === "ok" && res.disabled).toEqual(["axon-compat"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/kept prov\b/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("overwrites the fixed filename in place (no stale provider list)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const first = await materializeGovernanceOverlay(
        { governancePolicy: "approvedEndpoints: [prov]" },
        dir,
        { models: CATALOG, configuredModel: "prov/m" },
      );
      expect(first.status === "ok" && first.disabled).toEqual(["axon-compat", "omi"]);
      const second = await materializeGovernanceOverlay(
        { governancePolicy: "approvedEndpoints: [prov, omi]" },
        dir,
        { models: CATALOG, configuredModel: "prov/m" },
      );
      expect(second).toEqual({
        status: "ok",
        path: first.status === "ok" ? first.path : "",
        disabled: ["axon-compat"],
        kept: [],
        skipped: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns error (never throws) when the write fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gov-ov-"));
    try {
      const blocker = path.join(dir, "blocker");
      await writeFile(blocker, "x", "utf8");
      const res = await materializeGovernanceOverlay(
        { governancePolicy: "budgetCapUsd: 2" },
        blocker,
        { armed: true },
      );
      expect(res.status).toBe("error");
      expect(res.status === "error" && res.error.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
