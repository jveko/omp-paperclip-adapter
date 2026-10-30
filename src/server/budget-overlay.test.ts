import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUDGET_CONFIG_FILE, materializeBudgetOverlay } from "./budget-overlay.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "omp-budget-overlay-"));
}

describe("materializeBudgetOverlay", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir();
  });

  it("writes omp's session cost cap plus the adapter's 80% early warning", async () => {
    const out = await materializeBudgetOverlay(10, dir);
    expect(out).toEqual({ status: "ok", path: path.join(dir, BUDGET_CONFIG_FILE) });
    expect(await readFile(path.join(dir, BUDGET_CONFIG_FILE), "utf8")).toBe(
      "session:\n  maxCost: 10\n  warnCost: 8\n",
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("rounds the warning threshold to cents", async () => {
    await materializeBudgetOverlay(1.55, dir);
    expect(await readFile(path.join(dir, BUDGET_CONFIG_FILE), "utf8"))
      .toBe("session:\n  maxCost: 1.55\n  warnCost: 1.24\n");
    await rm(dir, { recursive: true, force: true });
  });

  it("omits a warning threshold that would round to the cap or to zero", async () => {
    await materializeBudgetOverlay(0.01, dir);
    expect(await readFile(path.join(dir, BUDGET_CONFIG_FILE), "utf8"))
      .toBe("session:\n  maxCost: 0.01\n");
    await rm(dir, { recursive: true, force: true });
  });

  it("writes nothing when no cap is configured", async () => {
    expect(await materializeBudgetOverlay(undefined, dir)).toEqual({ status: "none" });
    await expect(readFile(path.join(dir, BUDGET_CONFIG_FILE), "utf8")).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores a non-positive or non-finite cap", async () => {
    expect(await materializeBudgetOverlay(0, dir)).toEqual({ status: "none" });
    expect(await materializeBudgetOverlay(-5, dir)).toEqual({ status: "none" });
    expect(await materializeBudgetOverlay(Number.NaN, dir)).toEqual({ status: "none" });
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a sub-cent cap in plain decimal, which omp's YAML reader parses as a number", async () => {
    await materializeBudgetOverlay(0.0000001, dir);
    const text = await readFile(path.join(dir, BUDGET_CONFIG_FILE), "utf8");
    expect(text).toBe("session:\n  maxCost: 0.0000001\n");
    expect(text).not.toMatch(/e-/i);
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a write failure instead of throwing", async () => {
    const blocker = path.join(dir, BUDGET_CONFIG_FILE);
    await writeFile(blocker, "x", "utf8");
    const out = await materializeBudgetOverlay(5, blocker);
    expect(out.status).toBe("error");
    await rm(dir, { recursive: true, force: true });
  });
});
