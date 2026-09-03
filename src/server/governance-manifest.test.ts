import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  GOVERNANCE_MANIFEST_FILE,
  governancePolicyActive,
  materializeGovernanceManifest,
  parseGovernancePolicy,
} from "./governance-manifest.js";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gov-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const exists = async (file: string): Promise<boolean> =>
  stat(file).then(() => true, () => false);

describe("parseGovernancePolicy", () => {
  it("is off for absent, blank, and comment-only policies", () => {
    expect(parseGovernancePolicy(undefined)).toEqual({ kind: "off" });
    expect(parseGovernancePolicy("")).toEqual({ kind: "off" });
    expect(parseGovernancePolicy("  \n\n# nothing here\n ")).toEqual({ kind: "off" });
    expect(parseGovernancePolicy("{}")).toEqual({ kind: "off" });
  });

  it("is off for a policy that parses but carries no enforceable rule", () => {
    // These are the vacuous forms: materializing them would fold
    // tools.approvalMode:yolo (auto-approve) for nothing, so they stay off.
    expect(parseGovernancePolicy("guardrails: {}")).toEqual({ kind: "off" });
    expect(parseGovernancePolicy('{"guardrails":{}, "budgetCapUsd":0}')).toEqual({ kind: "off" });
    expect(parseGovernancePolicy("approvedEndpoints:\n  - ''\n")).toEqual({ kind: "off" });
    expect(parseGovernancePolicy("someUnrecognizedKey: value")).toEqual({ kind: "off" });
  });

  it("reports an error (never throws) for unparseable input", () => {
    expect(parseGovernancePolicy("{ not json").kind).toBe("error");
    expect(parseGovernancePolicy("guardrails\n  bashDeny: x").kind).toBe("error");
    expect(parseGovernancePolicy("budgetCapUsd: 5\n  guardrails: {}").kind).toBe("error");
    expect(parseGovernancePolicy("[1,2]").kind).toBe("error");
  });

  it("reads a JSON policy and normalizes the known fields", () => {
    const res = parseGovernancePolicy(JSON.stringify({
      guardrails: { bashDeny: ["rm -rf"], denyTools: ["web_search"] },
      budgetCapUsd: "5.5",
      approvedEndpoints: "brokerco",
      approvalRequired: "bash",
    }));
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.policy.guardrails).toEqual({ bashDeny: ["rm -rf"], denyTools: ["web_search"] });
    expect(res.policy.budgetCapUsd).toBe(5.5);
    expect(res.policy.approvedEndpoints).toEqual(["brokerco"]);
    expect(res.policy.approvalRequired).toEqual(["bash"]);
  });

  it("reads a YAML-ish policy incl. both list indentions", () => {
    const res = parseGovernancePolicy([
      "guardrails:",
      "  bashDeny:",
      '    - "(rm|sudo)"',
      "  denyTools:",
      "  - web_search",
      "  pathScopes:",
      "    root: worktree",
      "budgetCapUsd: 5",
      "approvedEndpoints:",
      "  - brokerco",
      "  - omi",
      "approvalRequired:",
      "  - tool: bash",
      "    risk: high",
    ].join("\n"));
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.policy).toEqual({
      guardrails: {
        bashDeny: ["(rm|sudo)"],
        denyTools: ["web_search"],
        pathScopes: { root: "worktree" },
      },
      budgetCapUsd: 5,
      approvedEndpoints: ["brokerco", "omi"],
      approvalRequired: [{ tool: "bash", risk: "high" }],
    });
  });

  it("accepts an already-parsed object and passes unknown fields through", () => {
    const res = parseGovernancePolicy({ guardrails: { denyTools: ["bash"] }, futureKnob: true });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.policy).toEqual({ guardrails: { denyTools: ["bash"] }, futureKnob: true });
  });

  it("drops malformed known fields instead of guessing", () => {
    const res = parseGovernancePolicy(
      '{"guardrails":"nope","budgetCapUsd":"abc","approvedEndpoints":[1,2,"  ","x"],"allowDebug":true}',
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.policy.guardrails).toBeUndefined();
    expect(res.policy.budgetCapUsd).toBeUndefined();
    expect(res.policy.approvedEndpoints).toEqual(["x"]);
    expect(res.policy.allowDebug).toBe(true);
  });
});

describe("governancePolicyActive", () => {
  it("mirrors the parse verdict so the overlay folds only real policy", () => {
    expect(governancePolicyActive({})).toBe(false);
    expect(governancePolicyActive({ governancePolicy: "guardrails: {}" })).toBe(false);
    expect(governancePolicyActive({ governancePolicy: "{ broken" })).toBe(false);
    expect(governancePolicyActive({ governancePolicy: "budgetCapUsd: 2" })).toBe(true);
  });
});

describe("materializeGovernanceManifest", () => {
  it("returns null and writes nothing when no policy is configured", async () => {
    await withDir(async (dir) => {
      const warn = vi.fn();
      expect(await materializeGovernanceManifest({}, dir, warn)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      expect(await exists(path.join(dir, GOVERNANCE_MANIFEST_FILE))).toBe(false);
    });
  });

  it("warns and returns null (never throws) for a malformed policy", async () => {
    await withDir(async (dir) => {
      const warn = vi.fn();
      const res = await materializeGovernanceManifest(
        { governancePolicy: "guardrails:\n  bashDeny: [unclosed" },
        dir,
        warn,
      );
      expect(res).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toMatch(/governance/i);
      expect(await exists(path.join(dir, GOVERNANCE_MANIFEST_FILE))).toBe(false);
    });
  });

  it("writes governance.json and returns its path for a valid policy", async () => {
    await withDir(async (dir) => {
      const warn = vi.fn();
      const file = await materializeGovernanceManifest(
        { governancePolicy: 'guardrails:\n  bashDeny:\n    - "rm -rf"\nbudgetCapUsd: 5' },
        dir,
        warn,
      );
      expect(file).toBe(path.join(dir, GOVERNANCE_MANIFEST_FILE));
      expect(warn).not.toHaveBeenCalled();
      const written = JSON.parse(await readFile(file!, "utf8"));
      expect(written).toEqual({ guardrails: { bashDeny: ["rm -rf"] }, budgetCapUsd: 5 });
    });
  });

  it("creates the directory before writing (fresh nested state dir)", async () => {
    await withDir(async (root) => {
      const dir = path.join(root, "missing", "deeper");
      expect(await exists(dir)).toBe(false);
      const file = await materializeGovernanceManifest(
        { governancePolicy: '{"denyTools":["bash"],"budgetCapUsd":3}' },
        dir,
      );
      expect(file).toBe(path.join(dir, GOVERNANCE_MANIFEST_FILE));
      // Unknown keys ride through verbatim once a known key makes the policy live.
      expect(JSON.parse(await readFile(file!, "utf8")))
        .toEqual({ denyTools: ["bash"], budgetCapUsd: 3 });
    });
  });

  it("re-materializes in place so policy edits land on the next write", async () => {
    await withDir(async (dir) => {
      await materializeGovernanceManifest({ governancePolicy: "budgetCapUsd: 1" }, dir);
      const file = await materializeGovernanceManifest({ governancePolicy: "budgetCapUsd: 9" }, dir);
      expect(JSON.parse(await readFile(file!, "utf8")).budgetCapUsd).toBe(9);
    });
  });

  it("warns and returns null (never throws) when the write fails", async () => {
    await withDir(async (dir) => {
      const blocker = path.join(dir, "blocker");
      await writeFile(blocker, "x", "utf8");
      const warn = vi.fn();
      const res = await materializeGovernanceManifest(
        { governancePolicy: "budgetCapUsd: 1" },
        blocker,
        warn,
      );
      expect(res).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    });
  });
});
