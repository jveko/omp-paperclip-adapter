import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  THINKING_CONFIG_FILE, materializeThinkingOverlay, requestedThinkingLevel, settingsThinkingLevel,
} from "./thinking-overlay.js";

describe("requestedThinkingLevel", () => {
  it("canonicalizes the configured level and keeps off as a real request", () => {
    expect(requestedThinkingLevel({ thinking: " high " })).toBe("high");
    expect(requestedThinkingLevel({ thinking: "off" })).toBe("off");
  });

  it("reads an unset, default or invalid value as no request", () => {
    expect(requestedThinkingLevel({})).toBe("");
    expect(requestedThinkingLevel({ thinking: "default" })).toBe("");
    expect(requestedThinkingLevel({ thinking: "HIGHER" })).toBe("");
  });
});

describe("settingsThinkingLevel", () => {
  it("drops off, which omp's defaultThinkingLevel has no value for", () => {
    expect(settingsThinkingLevel({ thinking: "off" })).toBe(null);
    expect(settingsThinkingLevel({ thinking: "default" })).toBe(null);
  });

  it("passes through every level the setting accepts, auto included", () => {
    expect(settingsThinkingLevel({ thinking: "auto" })).toBe("auto");
    expect(settingsThinkingLevel({ thinking: "max" })).toBe("max");
  });
});

describe("materializeThinkingOverlay", () => {
  it("writes defaultThinkingLevel to the fixed filename", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thk-"));
    try {
      const res = await materializeThinkingOverlay({ thinking: "xhigh" }, dir);
      expect(res).toEqual({ status: "ok", path: path.join(dir, THINKING_CONFIG_FILE) });
      expect((await readFile(res.status === "ok" ? res.path : "", "utf8")).trim())
        .toBe("defaultThinkingLevel: xhigh");
      // Rewriting a different level keeps the same path: the engine hashes env,
      // not file content, so a level edit must not rotate the session.
      const again = await materializeThinkingOverlay({ thinking: "low" }, dir);
      expect(again).toEqual({ status: "ok", path: path.join(dir, THINKING_CONFIG_FILE) });
      expect((await readFile(again.status === "ok" ? again.path : "", "utf8")).trim())
        .toBe("defaultThinkingLevel: low");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing when no level can be expressed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thk-"));
    try {
      expect(await materializeThinkingOverlay({}, dir)).toEqual({ status: "none" });
      expect(await materializeThinkingOverlay({ thinking: "default" }, dir)).toEqual({ status: "none" });
      // `off` is a CLI flag: omp discards an `off` defaultThinkingLevel and reads `high`.
      expect(await materializeThinkingOverlay({ thinking: "off" }, dir)).toEqual({ status: "none" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns error instead of throwing when the write fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "thk-"));
    try {
      const blocker = path.join(dir, "blocker");
      await writeFile(blocker, "x", "utf8");
      const res = await materializeThinkingOverlay({ thinking: "low" }, blocker);
      expect(res.status).toBe("error");
      expect(res.status === "error" && res.error.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
