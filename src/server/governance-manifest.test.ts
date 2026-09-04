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

  it("keeps approvalRequired rules that can name a tool, in either writing", () => {
    const res = parseGovernancePolicy({
      approvalRequired: [" bash ", { tool: "mcp__*", reason: "external side effects" }, { risk: "high" }],
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // The junk rule (no `tool`) is dropped: a rail that can never match is
    // worse than no rail, because the operator believes it is enforcing.
    expect(res.policy.approvalRequired).toEqual([
      "bash",
      { tool: "mcp__*", reason: "external side effects" },
    ]);
  });

  it("is off when approvalRequired holds nothing usable", () => {
    // A document whose only content was unusable rules must not fold
    // tools.approvalMode:yolo (auto-approve) for a policy that enforces none.
    expect(parseGovernancePolicy('{"approvalRequired":[{"reason":"oops"},42,"  "]}')).toEqual({
      kind: "off",
      vacuous: ["approvalRequired: no usable tool rule"],
    });
    expect(parseGovernancePolicy("approvalRequired: []")).toEqual({
      kind: "off",
      vacuous: ["approvalRequired: no usable tool rule"],
    });
  });

  it("drops a non-string reason/risk instead of stringifying it", () => {
    const res = parseGovernancePolicy({
      approvalRequired: [{ tool: "bash", reason: 7, risk: null }],
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.policy.approvalRequired).toEqual([{ tool: "bash" }]);
  });

  // P1-2 (v0.8 final review): a non-empty `guardrails` object used to be the
  // whole test for "live". That arms auto-approval on an inert policy — the
  // bridge normalizes `{denyTools: []}` or a typo'd key to zero rules, so the
  // run ends up with omp's own permission gate off and nothing enforcing.
  it("is off when guardrails normalizes to nothing enforceable", () => {
    const inert = [
      '{"guardrails":{"denyTools":[]}}',
      '{"guardrails":{"denyToolz":"rm -rf"}}',
      '{"guardrails":{"budgetCapUsd":5}}',
      '{"guardrails":{"bashDeny":["("]}}',
      '{"guardrails":{"bashDeny":["","  "]}}',
      '{"guardrails":{"pathScopes":{"allow":["w"],"denyOutside":false}}}',
      '{"guardrails":{"argRevisions":{}}}',
      '{"guardrails":{"argRevisions":{"bash":{}}}}',
      '{"guardrails":{"denyTools":[null,7]}}',
    ];
    for (const doc of inert) {
      expect(parseGovernancePolicy(doc), doc).toEqual({
        kind: "off",
        vacuous: expect.any(Array),
      });
    }
  });

  it("names the guardrails keys that carried no rule", () => {
    const res = parseGovernancePolicy(
      '{"guardrails":{"denyTools":[],"denyToolz":"x","budgetCapUsd":5}}',
    );
    expect(res.kind).toBe("off");
    if (res.kind !== "off") return;
    expect(res.vacuous).toEqual([
      "denyTools: no usable tool name",
      "denyToolz: not a guardrail key",
      "budgetCapUsd: only read at the policy root, not inside guardrails",
    ]);
  });

  it("is live when at least one guardrail family has something to enforce", () => {
    const armed = [
      { guardrails: { denyTools: ["web_search"] } },
      { guardrails: { bashDeny: ["(rm|sudo)"] } },
      { guardrails: { pathScopes: { allow: ["worktree"] } } },
      { guardrails: { pathScopes: {} } },
      { guardrails: { argRevisions: { bash: { command: "make" } } } },
    ];
    for (const doc of armed) {
      const res = parseGovernancePolicy(doc);
      expect(res.kind, JSON.stringify(doc)).toBe("ok");
      if (res.kind !== "ok") continue;
      expect(res.vacuous).toBeUndefined();
    }
  });

  it("flags an inert key inside an otherwise live guardrails bag", () => {
    const res = parseGovernancePolicy(
      '{"guardrails":{"denyTools":["web_search"],"denyToolz":"x"}}',
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.vacuous).toEqual(["denyToolz: not a guardrail key"]);
  });

  it("counts an approval rule written inside the guardrails bag as a rule", () => {
    // The bridge reads `document.approvalRequired ?? bag.approvalRequired`, so
    // this really does hold a tool — disarming on it would be a false negative.
    const res = parseGovernancePolicy('{"guardrails":{"approvalRequired":["bash"]}}');
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.enforceable).toBe(true);
    expect(res.vacuous).toBeUndefined();
  });

  it("does not count an unusable approval rule inside the bag", () => {
    expect(parseGovernancePolicy('{"guardrails":{"approvalRequired":[{"risk":"high"}]}}'))
      .toEqual({ kind: "off", vacuous: ["approvalRequired: no usable tool rule"] });
  });
});

describe("materializeGovernanceManifest rule audit", () => {
  it("warns and writes nothing when the guardrails bag carried no rule", async () => {
    await withDir(async (dir) => {
      const warn = vi.fn();
      const res = await materializeGovernanceManifest(
        { governancePolicy: '{"guardrails":{"denyToolz":"rm -rf"}}' },
        dir,
        warn,
      );
      expect(res).toBeNull();
      expect(await exists(path.join(dir, GOVERNANCE_MANIFEST_FILE))).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      const message = String(warn.mock.calls[0][0]);
      expect(message).toMatch(/no enforceable rule/i);
      expect(message).toMatch(/denyToolz/);
    });
  });

  it("warns about an inert key while still writing a live policy", async () => {
    await withDir(async (dir) => {
      const warn = vi.fn();
      const file = await materializeGovernanceManifest(
        { governancePolicy: '{"guardrails":{"denyTools":["web_search"],"denyToolz":1}}' },
        dir,
        warn,
      );
      expect(file).toBe(path.join(dir, GOVERNANCE_MANIFEST_FILE));
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(warn).toHaveBeenCalledOnce();
      expect(message).toMatch(/ignored key/i);
      expect(message).toMatch(/denyToolz/);
    });
  });

  it("does not arm the bridge for a routing-only policy", async () => {
    // approvedEndpoints is consumed by the overlay in THIS process; the bridge
    // never reads it. Writing a manifest for it would install a handler with
    // zero rules behind a relaxed approval gate.
    await withDir(async (dir) => {
      const warn = vi.fn();
      const file = await materializeGovernanceManifest(
        { governancePolicy: "approvedEndpoints: [brokerco]" },
        dir,
        warn,
      );
      expect(file).toBeNull();
      expect(await exists(path.join(dir, GOVERNANCE_MANIFEST_FILE))).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe("governancePolicyActive", () => {
  it("mirrors the parse verdict so the overlay folds only real policy", () => {
    expect(governancePolicyActive({})).toBe(false);
    expect(governancePolicyActive({ governancePolicy: "guardrails: {}" })).toBe(false);
    expect(governancePolicyActive({ governancePolicy: "{ broken" })).toBe(false);
    expect(governancePolicyActive({ governancePolicy: "budgetCapUsd: 2" })).toBe(true);
    // Routing is enforced in this process, not by the bridge: it never arms.
    expect(governancePolicyActive({ governancePolicy: "approvedEndpoints: [omi]" })).toBe(false);
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
