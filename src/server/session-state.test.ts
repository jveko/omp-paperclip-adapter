import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bumpRunCounter, loadState, rotateIfTripped, saveState, snapshotDigest, consumeToken,
  type SessionIntelState,
} from "./session-state.js";

const emptyState = (): SessionIntelState => ({
  forkConsumed: [], forceFreshConsumed: [], runCounters: {},
  pendingRotate: null, lastSnapshotDigest: null, lastRotation: null,
});

describe("session state", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    // no cleanup needed for tmp dirs in this test scope
  });

  it("round-trips through save/load atomically", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-intel-"));
    dirs.push(dir);
    const state = emptyState();
    state.forkConsumed = ["t1"];
    await saveState(dir, state);
    const loaded = await loadState(dir);
    expect(loaded.forkConsumed).toEqual(["t1"]);
  });

  it("resets to defaults on corrupt file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-intel-"));
    dirs.push(dir);
    await saveState(dir, emptyState());
    await writeFile(path.join(dir, "state.json"), "{not json", "utf8");
    const loaded = await loadState(dir);
    expect(loaded).toEqual(emptyState());
  });

  it("resets each field to its default when state.json parses but is wrong-typed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-intel-"));
    dirs.push(dir);
    await writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({
        forkConsumed: 42,
        forceFreshConsumed: "nope",
        runCounters: { sk: "3" },
        pendingRotate: "x",
        lastSnapshotDigest: 7,
        lastRotation: { reason: 1 },
      }),
      "utf8",
    );
    const loaded = await loadState(dir);
    expect(loaded.forkConsumed).toEqual([]);
    expect(loaded.forceFreshConsumed).toEqual([]);
    expect(loaded.runCounters).toEqual({});
    expect(loaded.pendingRotate).toBeNull();
    expect(loaded.lastSnapshotDigest).toBeNull();
    expect(loaded.lastRotation).toBeNull();
  });

  it("consumeToken appends and bounds the list at 64", () => {
    let list: string[] = Array.from({ length: 64 }, (_, i) => `t${i}`);
    list = consumeToken(list, "new");
    expect(list).toHaveLength(64);
    expect(list[63]).toBe("new");
    expect(list[0]).toBe("t1");
  });

  it("bumpRunCounter counts per sessionKey and prunes others", () => {
    const state = emptyState();
    state.runCounters["sk-old"] = { count: 9, firstRunAt: "2026-08-01T00:00:00Z" };
    bumpRunCounter(state, "sk-new", "2026-08-28T00:00:00Z");
    bumpRunCounter(state, "sk-new", "2026-08-28T00:01:00Z");
    expect(state.runCounters["sk-new"]).toEqual({ count: 2, firstRunAt: "2026-08-28T00:00:00Z" });
    expect(state.runCounters["sk-old"]).toBeUndefined();
  });

  it("rotateIfTripped fires on maxRuns and records pendingRotate", () => {
    const state = emptyState();
    state.runCounters["sk"] = { count: 3, firstRunAt: "2026-08-28T00:00:00Z" };
    const out = rotateIfTripped(state, "sk", { maxRuns: 3, maxAgeHours: 0 }, "2026-08-28T05:00:00Z");
    expect(out).toBe(true);
    expect(state.pendingRotate).toMatchObject({ reason: "maxRuns" });
    expect(state.pendingRotate?.at).toBe("2026-08-28T05:00:00Z");
  });

  it("rotateIfTripped fires on age", () => {
    const state = emptyState();
    state.runCounters["sk"] = { count: 1, firstRunAt: "2026-08-27T00:00:00Z" };
    const out = rotateIfTripped(state, "sk", { maxRuns: 0, maxAgeHours: 12 }, "2026-08-28T00:00:00Z");
    expect(out).toBe(true);
    expect(state.pendingRotate).toMatchObject({ reason: "maxAgeHours" });
  });

  it("rotateIfTripped is inert when thresholds are 0", () => {
    const state = emptyState();
    state.runCounters["sk"] = { count: 99, firstRunAt: "2026-01-01T00:00:00Z" };
    expect(rotateIfTripped(state, "sk", { maxRuns: 0, maxAgeHours: 0 }, "2026-08-28T00:00:00Z")).toBe(false);
  });

  it("snapshotDigest changes only when the landscape changes", () => {
    const a = { sessions: [{ sessionId: "s1", updatedAt: "u1" }], total: 1 };
    const same = { sessions: [{ sessionId: "s1", updatedAt: "u1" }], total: 1 };
    const changed = { sessions: [{ sessionId: "s1", updatedAt: "u2" }], total: 1 };
    expect(snapshotDigest(a)).toBe(snapshotDigest(same));
    expect(snapshotDigest(a)).not.toBe(snapshotDigest(changed));
  });
});