import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  forkOmpSession, queryOmpSessions, type OmpQueryResult, type OmpSessionsSnapshot,
} from "./session-intel.js";

const fakeAcp = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/fake-acp.mjs",
);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Narrows the result union instead of asserting a shape onto it. */
function okSnapshot(out: OmpQueryResult): OmpSessionsSnapshot {
  if (!out.ok) throw new Error(`expected a snapshot, got error: ${out.error}`);
  return out.snapshot;
}

/**
 * Run a query against the scripted responder and return both the result and
 * the exact frame sequence the client issued. The fixture appends each method
 * to FAKE_ACP_SEEN_FILE, which is how a test proves a cross-tenant frame was
 * NOT sent (a response body cannot testify to that).
 */
async function queryWithSeen(
  opts: { cwd: string; diagnostic?: boolean },
  mode = "",
): Promise<{ out: OmpQueryResult; seen: string[] }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "omp-session-intel-"));
  tmpDirs.push(dir);
  const seenFile = path.join(dir, "seen.txt");
  const out = await queryOmpSessions(
    { command: process.execPath, args: [fakeAcp], env: { FAKE_ACP_MODE: mode, FAKE_ACP_SEEN_FILE: seenFile } },
    opts,
  );
  let seen: string[] = [];
  try {
    seen = readFileSync(seenFile, "utf8").split("\n").filter(Boolean);
  } catch { /* child never started */ }
  return { out, seen };
}

describe("queryOmpSessions", () => {
  it("reads the run's own cwd over ACP session/list", async () => {
    const { out, seen } = await queryWithSeen({ cwd: "/workspace" });
    const snapshot = okSnapshot(out);
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions[0]).toMatchObject({
      sessionId: "sess-a", cwd: "/workspace", title: "First", messageCount: 3, size: 120,
    });
    expect(snapshot.total).toBe(2);
    expect(snapshot.truncated).toBe(false);
    // One cwd bucket: one project, newest first.
    expect(snapshot.projects).toEqual([
      { cwd: "/workspace", sessionCount: 2, lastActivityAt: "2026-08-28T01:00:00Z", lastTitle: "Second" },
    ]);
    // session/list plus the run-scoped subagent probe; no host-wide frame.
    expect(seen).toEqual(["initialize", "session/list", "_omp/subagents"]);
    expect(seen.some((m) => m === "_omp/sessions/listAll" || m === "_omp/projects/list")).toBe(false);
  }, 15_000);

  it("reports a paged listing as truncated instead of a complete total", async () => {
    const { out } = await queryWithSeen({ cwd: "/w" }, "page2");
    const snapshot = okSnapshot(out);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.total).toBe(null);
  }, 15_000);

  it("maps a session/list failure onto a typed error and issues no _omp/* fallback", async () => {
    const { out, seen } = await queryWithSeen({ cwd: "/w" }, "listerror");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("session/list boom");
    expect(seen).not.toContain("_omp/sessions/listAll");
  }, 15_000);

  it("reports a host-wide listing as counts only under the diagnostic switch", async () => {
    const { out, seen } = await queryWithSeen({ cwd: "/workspace", diagnostic: true });
    const snapshot = okSnapshot(out);
    // The diagnostic never widens the snapshot.
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions[0].cwd).toBe("/workspace");
    expect(out.ok && out.hostDiagnostic).toEqual({ sessionCount: 2, projectCount: 1 });
    // No ids, cwds or titles leave the diagnostic.
    expect(JSON.stringify(out.ok ? out.hostDiagnostic : null)).not.toContain("sess-");
    expect(seen).toContain("_omp/sessions/listAll");
    expect(seen).toContain("_omp/projects/list");
  }, 15_000);

  it("degrades a failed diagnostic to an error string without losing the snapshot", async () => {
    const { out } = await queryWithSeen({ cwd: "/w", diagnostic: true }, "exterror");
    const snapshot = okSnapshot(out);
    expect(snapshot.sessions).toHaveLength(2);
    if (!out.ok) throw new Error("expected a snapshot");
    expect(out.hostDiagnostic?.error).toContain("ext boom");
  }, 15_000);

  it("parses a subagent summary when omp implements _omp/subagents", async () => {
    const { out } = await queryWithSeen({ cwd: "/w", diagnostic: true }, "subagents");
    expect(okSnapshot(out).subagents).toEqual([
      {
        id: "sub-1", index: 0, agent: "scout", status: "running",
        description: "map the repo", parentToolCallId: "tool-call-1", lastUpdate: 1756368000000,
      },
      {
        id: "sub-2", index: 1, agent: "task", status: "completed",
        description: null, parentToolCallId: "tool-call-2", lastUpdate: 1756368060000,
      },
    ]);
  }, 15_000);

  it("keeps an empty subagent list as evidence the run has no subagents", async () => {
    const { out } = await queryWithSeen({ cwd: "/w", diagnostic: true }, "subagentsnone");
    expect(okSnapshot(out).subagents).toEqual([]);
  }, 15_000);

  it("treats a non-array subagent payload as absent rather than an error", async () => {
    const { out } = await queryWithSeen({ cwd: "/w", diagnostic: true }, "subagentsjunk");
    expect("subagents" in okSnapshot(out)).toBe(false);
  }, 15_000);

  it("still reports the run's own subagent tree without the diagnostic switch", async () => {
    // The subagent probe describes THIS run's session, not the host, so the
    // containment switch does not gate it.
    const { out } = await queryWithSeen({ cwd: "/w" }, "subagents");
    expect(okSnapshot(out).subagents?.[0]).toMatchObject({ id: "sub-1", agent: "scout" });
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
