import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  forkOmpSession, queryOmpSessions, type OmpQueryResult, type OmpSessionsSnapshot,
} from "./session-intel.js";

const fakeAcp = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/fake-acp.mjs",
);

/** Narrows the result union instead of asserting a shape onto it. */
function okSnapshot(out: OmpQueryResult): OmpSessionsSnapshot {
  if (!out.ok) throw new Error(`expected a snapshot, got error: ${out.error}`);
  return out.snapshot;
}

describe("queryOmpSessions", () => {
  it("returns a parsed snapshot from initialize-only frames", async () => {
    const out = await queryOmpSessions({ command: process.execPath, args: [fakeAcp] });
    expect(out.ok).toBe(true);
    const snapshot = (out as { snapshot: OmpSessionsSnapshot }).snapshot;
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions[0]).toMatchObject({
      sessionId: "sess-a", cwd: "/w", title: "First", messageCount: 3, size: 120,
    });
    expect(snapshot.total).toBe(2);
    expect(snapshot.projects).toHaveLength(1);
  }, 15_000);

  it("passes cwd to _omp/chats/byCwd", async () => {
    const out = await queryOmpSessions(
      { command: process.execPath, args: [fakeAcp] },
      { cwd: "/workspace" },
    );
    expect(out.ok).toBe(true);
    const snapshot = (out as { snapshot: OmpSessionsSnapshot }).snapshot;
    expect(snapshot.byCwd[0].cwd).toBe("/workspace");
  }, 15_000);

  it("reports extMethod errors without throwing", async () => {
    const out = await queryOmpSessions(
      { command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_MODE: "exterror" } },
    );
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain("ext boom");
  }, 15_000);
});

describe("queryOmpSessions subagent capability", () => {
  // omp 18.1.6 answers an unimplemented `_omp/*` extMethod with a JSON-RPC
  // error ("Unknown ACP ext method"), and the default fixture mode mirrors
  // that. The subagent read is therefore the ordinary state of the world, and
  // it must cost the snapshot nothing beyond one extra frame.
  it("omits subagents without degrading the snapshot when the method is absent", async () => {
    const out = await queryOmpSessions({ command: process.execPath, args: [fakeAcp] });
    expect(out.ok).toBe(true);
    const snapshot = okSnapshot(out);
    expect("subagents" in snapshot).toBe(false);
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.total).toBe(2);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.byCwd).toHaveLength(1);
  }, 15_000);

  it("parses a subagent summary when omp implements _omp/subagents", async () => {
    const out = await queryOmpSessions(
      { command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_MODE: "subagents" } },
    );
    expect(out.ok).toBe(true);
    const snapshot = okSnapshot(out);
    expect(snapshot.subagents).toEqual([
      {
        id: "sub-1", index: 0, agent: "scout", status: "running",
        description: "map the repo", parentToolCallId: "tool-call-1", lastUpdate: 1756368000000,
      },
      {
        id: "sub-2", index: 1, agent: "task", status: "completed",
        description: null, parentToolCallId: "tool-call-2", lastUpdate: 1756368060000,
      },
    ]);
    expect(snapshot.sessions).toHaveLength(2);
  }, 15_000);

  it("keeps an empty subagent list as evidence the run has no subagents", async () => {
    const out = await queryOmpSessions(
      { command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_MODE: "subagentsnone" } },
    );
    expect(out.ok).toBe(true);
    const snapshot = okSnapshot(out);
    expect(snapshot.subagents).toEqual([]);
  }, 15_000);

  it("treats a non-array payload as absent rather than an error", async () => {
    const out = await queryOmpSessions(
      { command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_MODE: "subagentsjunk" } },
    );
    expect(out.ok).toBe(true);
    expect("subagents" in okSnapshot(out)).toBe(false);
  }, 15_000);
});

describe("forkOmpSession", () => {
  it("returns the forked session id", async () => {
    const out = await forkOmpSession(
      { command: process.execPath, args: [fakeAcp] }, "sess-a", "/w",
    );
    expect(out).toMatchObject({ ok: true, sessionId: "fork-1" });
  }, 15_000);

  it("maps omp's persisted-source gate onto a typed error", async () => {
    const out = await forkOmpSession(
      { command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_MODE: "forkerror" } },
      "sess-a", "/w",
    );
    expect(out).toMatchObject({
      ok: false,
      error: "ACP session cannot be forked before it is persisted",
    });
  }, 15_000);
});
