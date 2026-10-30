import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  FAILOVER_CONFIG_FILE, materializeFailoverOverlay, providerQualifiedSelectors,
  validateProviderQualifiedSelectors, validateRetryFallbackConfig,
} from "./failover-config.js";
import type { OmpModelInfo } from "./models.js";

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

describe("quota-aware retry knobs", () => {
  it("writes every configured knob under retry, next to the chat chain", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      const res = await materializeFailoverOverlay({
        fallbackChain: "brokerco/main",
        fallbackOn: "usage-limit",
        fallbackRevertPolicy: "never",
        waitForUsageReset: true,
        maxDelayMs: 60000,
      }, dir);
      expect(res.status).toBe("ok");
      const yaml = await readFile(res.status === "ok" ? res.path : "", "utf8");
      // One `retry:` block: omp merges a second one over the first, so the
      // chain and the knobs must not be written as two.
      expect(yaml.match(/^retry:$/gm)).toHaveLength(1);
      expect(yaml).toContain("  fallbackOn: usage-limit");
      expect(yaml).toContain("  fallbackRevertPolicy: never");
      expect(yaml).toContain("  waitForUsageReset: true");
      expect(yaml).toContain("  maxDelayMs: 60000");
      // The chat-session chain survives alongside them.
      expect(yaml).toContain('      - "brokerco/main"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the knobs on their own, without inventing a chain", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      const res = await materializeFailoverOverlay({ waitForUsageReset: "true" }, dir);
      expect(res.status).toBe("ok");
      const yaml = await readFile(res.status === "ok" ? res.path : "", "utf8");
      expect(yaml).toContain("  waitForUsageReset: true");
      expect(yaml).not.toContain("fallbackChains");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits knobs the operator did not set", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      const res = await materializeFailoverOverlay({ fallbackChain: "brokerco/main" }, dir);
      expect(res.status).toBe("ok");
      const yaml = await readFile(res.status === "ok" ? res.path : "", "utf8");
      expect(yaml).not.toContain("fallbackOn");
      expect(yaml).not.toContain("fallbackRevertPolicy");
      expect(yaml).not.toContain("waitForUsageReset");
      expect(yaml).not.toContain("maxDelayMs");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write a value omp would silently discard", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fov-"));
    try {
      const res = await materializeFailoverOverlay({ fallbackChain: "brokerco/main", fallbackOn: "sometimes" }, dir);
      expect(res.status).toBe("error");
      expect(res.status === "error" && res.error).toContain("fallbackOn");
      // Nothing was written: a file omp would drop is worse than no file.
      await expect(readFile(path.join(dir, FAILOVER_CONFIG_FILE), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("validateRetryFallbackConfig", () => {
  it("accepts unset knobs and the documented enum values", () => {
    expect(validateRetryFallbackConfig({})).toBeNull();
    for (const fallbackOn of ["any", "usage-limit", "except-usage-limit"]) {
      expect(validateRetryFallbackConfig({ fallbackOn })).toBeNull();
    }
    for (const fallbackRevertPolicy of ["cooldown-expiry", "never"]) {
      expect(validateRetryFallbackConfig({ fallbackRevertPolicy })).toBeNull();
    }
    // Typed config may arrive as strings from the board.
    expect(validateRetryFallbackConfig({ waitForUsageReset: "false", maxDelayMs: "300000" })).toBeNull();
  });

  it("names the key and the allowed values for an unknown enum", () => {
    const on = validateRetryFallbackConfig({ fallbackOn: "sometimes" });
    expect(on).toContain("fallbackOn");
    expect(on).toContain("usage-limit");
    const revert = validateRetryFallbackConfig({ fallbackRevertPolicy: "eventually" });
    expect(revert).toContain("fallbackRevertPolicy");
    expect(revert).toContain("cooldown-expiry");
  });

  it("rejects a non-boolean wait and a negative or non-numeric delay", () => {
    expect(validateRetryFallbackConfig({ waitForUsageReset: "yes" })).toContain("waitForUsageReset");
    expect(validateRetryFallbackConfig({ maxDelayMs: -1 })).toContain("maxDelayMs");
    expect(validateRetryFallbackConfig({ maxDelayMs: "soon" })).toContain("maxDelayMs");
  });
});

describe("provider-qualified selectors", () => {
  const models: OmpModelInfo[] = [
    { id: "zai/glm-5.2", label: "GLM 5.2" },
    { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  ];

  it("collects the primary model and every slash-containing chain leg", () => {
    const config = {
      model: "zai/glm-5.2",
      fallbackChain: "anthropic/claude-sonnet-4-5\nopus\n\nzai/glm-5.2:high",
    };
    expect(providerQualifiedSelectors(config)).toEqual([
      { field: "model", selector: "zai/glm-5.2" },
      { field: "fallbackChain", selector: "anthropic/claude-sonnet-4-5" },
      { field: "fallbackChain", selector: "zai/glm-5.2:high" },
    ]);
  });

  it("ignores bare selectors, which keep omp's fuzzy matching", () => {
    expect(providerQualifiedSelectors({ model: "opus", fallbackChain: "sonnet" })).toEqual([]);
  });

  it("names only the selectors that are not exact catalog ids", () => {
    const error = validateProviderQualifiedSelectors({
      model: "anthropic/claude-sonnet-4",
      fallbackChain: "zai/glm-5.2:high",
    }, models);
    expect(error).toContain("model 'anthropic/claude-sonnet-4'");
    expect(error).not.toContain("glm-5.2");
  });

  it("names the value and omp 18.14's exact-id requirement", () => {
    const error = validateProviderQualifiedSelectors(
      { fallbackChain: "anthropic/claude-sonnet-4" },
      models,
    );
    expect(error).toContain("anthropic/claude-sonnet-4");
    expect(error).toContain("18.14");
    expect(error).toContain("exact");
  });

  it("accepts a config whose provider-qualified selectors all resolve", () => {
    expect(validateProviderQualifiedSelectors(
      { model: "zai/glm-5.2", fallbackChain: "anthropic/claude-sonnet-4-5" },
      models,
    )).toBeNull();
  });
});
