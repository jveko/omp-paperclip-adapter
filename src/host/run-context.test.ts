import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RUN_CONTEXT_FILE, clearRunContext, reapRunContexts, runContextDir, runContextPointer, writeRunContext,
} from "./run-context.js";

const credentials = {
  apiUrl: "http://127.0.0.1:3100",
  apiKey: "jwt-SENTINEL-1",
  companyId: "co-1",
  taskId: null,
  issueId: null,
};
const manifests = { skills: null, governance: null, budget: null, failover: null, thinking: null };

describe("run context", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "omp-run-context-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a 0600 record behind an atomically replaced pointer", async () => {
    const pointer = await writeRunContext(root, "run-1", credentials, manifests);
    expect(pointer).toBe(runContextPointer(root));
    expect((await stat(path.join(runContextDir(root), "run-1.json"))).mode & 0o777).toBe(0o600);
    expect(await readlink(pointer)).toBe("run-1.json");
    expect(JSON.parse(await readFile(pointer, "utf8"))).toMatchObject({ runId: "run-1", credentials });
    expect((await stat(runContextDir(root))).mode & 0o777).toBe(0o700);
  });

  it("does not let an older settle remove a newer run's pointer", async () => {
    await writeRunContext(root, "run-1", credentials, manifests);
    await writeRunContext(root, "run-2", { ...credentials, apiKey: "jwt-2" }, manifests);
    await clearRunContext(root, "run-1");
    expect(await readlink(runContextPointer(root))).toBe("run-2.json");
    expect(JSON.parse(await readFile(runContextPointer(root), "utf8"))).toMatchObject({ runId: "run-2" });
    await clearRunContext(root, "run-2");
    await expect(stat(runContextPointer(root))).rejects.toThrow();
  });

  it("reaps terminal leftovers and keeps a live run's context", async () => {
    await writeRunContext(root, "run-live", credentials, manifests);
    await writeRunContext(root, "run-dead", { ...credentials, apiKey: "jwt-DEAD" }, manifests);
    // Point the stable path back at the live run, as a concurrent host would.
    await writeRunContext(root, "run-live", credentials, manifests);
    const removed = await reapRunContexts(root, (runId) => runId === "run-dead");
    expect(removed).toBe(1);
    await expect(stat(path.join(runContextDir(root), "run-dead.json"))).rejects.toThrow();
    expect(await readlink(path.join(runContextDir(root), RUN_CONTEXT_FILE))).toBe("run-live.json");
  });
});
