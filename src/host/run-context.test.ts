import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RUN_CONTEXT_FILE, clearRunContext, reapRunContexts, runContextDir, runContextPointer, writeRunContext,
} from "./run-context.js";

const WORKER = "abc123";

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

  it("writes a 0600 record behind an atomically replaced per-worker pointer", async () => {
    const pointer = await writeRunContext(root, WORKER, "run-1", credentials, manifests);
    expect(pointer).toBe(runContextPointer(root, WORKER));
    expect((await stat(path.join(runContextDir(root, WORKER), "run-1.json"))).mode & 0o777).toBe(0o600);
    expect(await readlink(pointer)).toBe("run-1.json");
    expect(JSON.parse(await readFile(pointer, "utf8"))).toMatchObject({ runId: "run-1", credentials });
    expect((await stat(runContextDir(root, WORKER))).mode & 0o777).toBe(0o700);
  });

  it("keeps two workers' pointers independent", async () => {
    const a = await writeRunContext(root, "worker-a", "run-a", credentials, manifests);
    const b = await writeRunContext(root, "worker-b", "run-b", { ...credentials, apiKey: "jwt-b" }, manifests);
    expect(await readlink(a)).toBe("run-a.json");
    expect(await readlink(b)).toBe("run-b.json");
    await clearRunContext(root, "worker-a", "run-a");
    await expect(stat(a)).rejects.toThrow();
    expect(JSON.parse(await readFile(b, "utf8"))).toMatchObject({ runId: "run-b" });
  });

  it("does not let an older settle remove a newer run's pointer", async () => {
    await writeRunContext(root, WORKER, "run-1", credentials, manifests);
    await writeRunContext(root, WORKER, "run-2", { ...credentials, apiKey: "jwt-2" }, manifests);
    await clearRunContext(root, WORKER, "run-1");
    expect(await readlink(runContextPointer(root, WORKER))).toBe("run-2.json");
    expect(JSON.parse(await readFile(runContextPointer(root, WORKER), "utf8"))).toMatchObject({ runId: "run-2" });
    await clearRunContext(root, WORKER, "run-2");
    await expect(stat(runContextPointer(root, WORKER))).rejects.toThrow();
  });

  it("reaps terminal leftovers and keeps a live run's context", async () => {
    await writeRunContext(root, "worker-live", "run-live", credentials, manifests);
    await writeRunContext(root, "worker-dead", "run-dead", { ...credentials, apiKey: "jwt-DEAD" }, manifests);
    const removed = await reapRunContexts(root, (runId) => runId === "run-dead");
    expect(removed).toBe(2);
    await expect(stat(path.join(runContextDir(root, "worker-dead"), "run-dead.json"))).rejects.toThrow();
    expect(await readlink(path.join(runContextDir(root, "worker-live"), RUN_CONTEXT_FILE))).toBe("run-live.json");
  });

  it("rejects a worker id that could escape the run-context root", async () => {
    await expect(writeRunContext(root, "../escape", "run-1", credentials, manifests)).rejects.toThrow(/worker id/);
    await expect(writeRunContext(root, "..", "run-1", credentials, manifests)).rejects.toThrow(/worker id/);
  });
});
