import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { FAILOVER_CONFIG_FILE, materializeFailoverOverlay } from "./failover-config.js";

describe("materializeFailoverOverlay", () => {
  it("returns none when there is no fallback chain and no governance policy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      expect(await materializeFailoverOverlay({}, dir)).toEqual({ status: "none" });
      expect(await materializeFailoverOverlay({ fallbackChain: "   \n\n  " }, dir)).toEqual({ status: "none" });
      expect(await materializeFailoverOverlay({ governancePolicy: "   " }, dir)).toEqual({ status: "none" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the deterministic fixed filename with the overlay YAML", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      const res = await materializeFailoverOverlay(
        { fallbackChain: "brokerco/main\nbrokerco/fast" },
        dir,
      );
      expect(res.status).toBe("ok");
      const file = res.status === "ok" ? res.path : "";
      expect(file).toBe(path.join(dir, FAILOVER_CONFIG_FILE));
      const yaml = await readFile(file, "utf8");
      expect(yaml).toContain("fallbackChains");
      expect(yaml).toContain('"brokerco/main"');
      expect(yaml).toContain('"brokerco/fast"');
      // Deterministic fixed filename even when the dir already exists.
      const again = await materializeFailoverOverlay(
        { fallbackChain: "other/model" },
        dir,
      );
      expect(again).toEqual({ status: "ok", path: path.join(dir, FAILOVER_CONFIG_FILE) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns error (no throw) when the write fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      // A dir argument whose leaf is an existing regular file: recursive mkdir
      // fails fast (EEXIST), exercising the guarded-write path. (A procfs path
      // like /proc/... would HANG recursive mkdir, so we avoid it.)
      const blocker = path.join(dir, "blocker");
      await writeFile(blocker, "x", "utf8");
      const res = await materializeFailoverOverlay({ fallbackChain: "brokerco/main" }, blocker);
      expect(res.status).toBe("error");
      expect(res.status === "error" && res.error.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("folds the governance single-gate key into the SAME overlay as the chain", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      const res = await materializeFailoverOverlay(
        {
          fallbackChain: "brokerco/main",
          governancePolicy: "guardrails:\n  denyTools:\n    - web_search",
        },
        dir,
      );
      expect(res.status).toBe("ok");
      const yaml = await readFile(res.status === "ok" ? res.path : "", "utf8");
      // One overlay file carries both concerns, because PI_CONFIG_FILES gets a
      // single path appended (later sections must not clobber the chain).
      expect(yaml).toContain("fallbackChains");
      expect(yaml).toContain('"brokerco/main"');
      expect(yaml).toMatch(/^tools:\n {2}approvalMode: yolo$/m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the overlay for governance alone (no fallback chain)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      const res = await materializeFailoverOverlay({ governancePolicy: "budgetCapUsd: 2" }, dir);
      expect(res).toEqual({ status: "ok", path: path.join(dir, FAILOVER_CONFIG_FILE) });
      const yaml = await readFile(path.join(dir, FAILOVER_CONFIG_FILE), "utf8");
      expect(yaml).toContain("approvalMode: yolo");
      expect(yaml).not.toContain("retry:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never auto-approves for a vacuous or malformed policy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      // Nothing enforceable (or unparseable) must not flip the run to yolo.
      for (const governancePolicy of ["guardrails: {}", "{ broken", "whoKnows: 1"]) {
        expect(await materializeFailoverOverlay({ governancePolicy }, dir)).toEqual({ status: "none" });
      }
      const withChain = await materializeFailoverOverlay(
        { fallbackChain: "brokerco/main", governancePolicy: "guardrails: {}" },
        dir,
      );
      expect(withChain.status).toBe("ok");
      const yaml = await readFile(withChain.status === "ok" ? withChain.path : "", "utf8");
      expect(yaml).toContain("fallbackChains");
      expect(yaml).not.toContain("approvalMode");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
