import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { forkOmpSession, queryOmpSessions, type OmpSessionsSnapshot } from "./session-intel.js";

const fakeAcp = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/fake-acp.mjs",
);

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
