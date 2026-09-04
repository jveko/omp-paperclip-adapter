import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { FAILOVER_CONFIG_FILE, materializeFailoverOverlay } from "./failover-config.js";

describe("materializeFailoverOverlay", () => {
  it("returns none when there is no fallback chain", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      expect(await materializeFailoverOverlay({}, dir)).toEqual({ status: "none" });
      expect(await materializeFailoverOverlay({ fallbackChain: "   \n\n  " }, dir)).toEqual({ status: "none" });
      // v0.8: a live governance policy alone no longer arms this file — the
      // single gate moved to the governance overlay, which the side channels
      // never read.
      expect(await materializeFailoverOverlay({ governancePolicy: "budgetCapUsd: 2" }, dir)).toEqual({
        status: "none",
      });
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

  it("carries ONLY the chain when a live governance policy is also set", async () => {
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
      expect(yaml).toContain("fallbackChains");
      expect(yaml).toContain('"brokerco/main"');
      // This file is folded into the SIDE-CHANNEL env too (ompEnv overlayPath),
      // and omp honors `disabledProviders` when listing models: governance keys
      // living here would filter the very catalog routing is computed from, so
      // the failover overlay must stay free of both.
      expect(yaml).not.toMatch(/^tools:/m);
      expect(yaml).not.toContain("approvalMode");
      expect(yaml).not.toContain("disabledProviders");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing for governance alone (the gate lives in the other overlay)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      for (const governancePolicy of ["budgetCapUsd: 2", "approvedEndpoints: [brokerco]"]) {
        expect(await materializeFailoverOverlay({ governancePolicy }, dir)).toEqual({ status: "none" });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
