import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  getSessionConfigSchema, paperclipApiBase, readSessionIntelConfig, resolveRunDirective,
  resolveSessionScope, sessionSnapshotDigestInput, validateCredentialMode, validateSessionScope,
  validThinkingLevel, validateThinkingLevel,
} from "./session-directives.js";
import { snapshotDigest } from "./session-state.js";

describe("readSessionIntelConfig", () => {
  it("defaults browser on, usage report on, everything else off", () => {
    const cfg = readSessionIntelConfig({});
    expect(cfg).toEqual({
      browser: true, diagnostic: false, forkSourceId: "", forkToken: "",
      forceFreshToken: "", maxRuns: 0, maxAgeHours: 0, usageReport: true,
    });
  });
  it("reads typed values and tolerates garbage", () => {
    const cfg = readSessionIntelConfig({
      sessionBrowser: false,
      sessionForkSourceId: "sess-1",
      sessionForkToken: "tok-1",
      sessionForceFreshToken: "ff-1",
      sessionMaxRuns: "5",
      sessionMaxAgeHours: "bogus",
      usageReport: false,
    });
    expect(cfg.browser).toBe(false);
    expect(cfg.forkSourceId).toBe("sess-1");
    expect(cfg.maxRuns).toBe(5);
    expect(cfg.maxAgeHours).toBe(0);
    expect(cfg.usageReport).toBe(false);
  });
  it("treats the string 'false' as off for sessionBrowser", () => {
    const cfg = readSessionIntelConfig({ sessionBrowser: "false" });
    expect(cfg.browser).toBe(false);
  });
  it("treats 'false' as off for usageReport", () => {
    expect(readSessionIntelConfig({ usageReport: "false" }).usageReport).toBe(false);
  });
});

describe("resolveRunDirective", () => {
  const state = () => ({ forkConsumed: [], forceFreshConsumed: [], pendingRotate: null });
  it("prefers an unconsumed fork", () => {
    const d = resolveRunDirective(
      { forkSourceId: "sess-1", forkToken: "t1", forceFreshToken: "f1" },
      state(),
    );
    expect(d).toMatchObject({ kind: "fork", forkSourceId: "sess-1", forkToken: "t1" });
  });
  it("skips a consumed fork token and falls through to force-fresh", () => {
    const d = resolveRunDirective(
      { forkSourceId: "sess-1", forkToken: "t1", forceFreshToken: "f1" },
      { forkConsumed: ["t1"], forceFreshConsumed: [], pendingRotate: null },
    );
    expect(d).toMatchObject({ kind: "forceFresh", token: "f1" });
  });
  it("skips a consumed force-fresh token and falls through to pending rotation", () => {
    const d = resolveRunDirective(
      { forkSourceId: "", forkToken: "", forceFreshToken: "f1" },
      { forkConsumed: [], forceFreshConsumed: ["f1"], pendingRotate: { reason: "maxRuns", at: "x" } },
    );
    expect(d).toMatchObject({ kind: "rotate", reason: "maxRuns" });
  });
  it("returns none when nothing is armed", () => {
    expect(resolveRunDirective(
      { forkSourceId: "", forkToken: "", forceFreshToken: "" }, state(),
    )).toMatchObject({ kind: "none" });
  });
});

describe("getSessionConfigSchema", () => {
  it("exposes the session fields in order with next-run hints", () => {
    const schema = getSessionConfigSchema();
    const keys = schema.fields.map((f) => f.key);
    expect(keys).toEqual([
      "sessionScope", "sessionBrowser", "sessionSnapshotDiagnostic",
      "sessionForceFreshToken", "sessionForkSourceId",
      "sessionForkToken", "sessionMaxRuns", "sessionMaxAgeHours",
      "credentialMode", "thinking", "fallbackChain", "usageReport",
      "skillsAsTools", "governancePolicy",
    ]);
    for (const field of schema.fields) expect(field.hint).toContain("next run");
  });
  it("exposes the v0.5 fields with correct types/defaults", () => {
    const byKey = Object.fromEntries(getSessionConfigSchema().fields.map((f) => [f.key, f]));
    expect(byKey.credentialMode.type).toBe("select");
    expect(byKey.credentialMode.default).toBe("local");
    expect(byKey.fallbackChain.type).toBe("textarea");
    expect(byKey.usageReport.type).toBe("toggle");
    expect(byKey.usageReport.default).toBe(true);
  });
  it("exposes the thinking field as a 9-option select defaulting to 'default'", () => {
    const byKey = Object.fromEntries(getSessionConfigSchema().fields.map((f) => [f.key, f]));
    const t = byKey.thinking;
    expect(t.type).toBe("select");
    expect(t.default).toBe("default");
    expect(t.options.map((o: { value: string }) => o.value)).toEqual([
      "default", "off", "auto", "minimal", "low", "medium", "high", "xhigh", "max",
    ]);
  });
  it("exposes the v0.8 governance policy as a textarea (empty = off)", () => {
    const byKey = Object.fromEntries(getSessionConfigSchema().fields.map((f) => [f.key, f]));
    const g = byKey.governancePolicy;
    expect(g.type).toBe("textarea");
    expect(g.default).toBeUndefined();
    expect(g.hint).toMatch(/guardrails/i);
    expect(g.hint).toMatch(/budgetCapUsd/);
    expect(g.hint).toMatch(/approvedEndpoints/);
    expect(g.hint).toMatch(/approvalRequired/);
    // T4 routing must be documented as a guarded complement, not a silent cut:
    // the lever is disabledProviders, and the model/chain providers survive it.
    expect(g.hint).toMatch(/disabledProviders/);
    expect(g.hint).toMatch(/never disabled/);
    expect(g.hint).toMatch(/warm handle/);
  });
});

describe("validThinkingLevel", () => {
  it("accepts the omp CLI thinking levels", () => {
    expect(validThinkingLevel("medium")).toBe("medium");
    expect(validThinkingLevel("off")).toBe("off");
    expect(validThinkingLevel("auto")).toBe("auto");
    expect(validThinkingLevel("minimal")).toBe("minimal");
    expect(validThinkingLevel("low")).toBe("low");
    expect(validThinkingLevel("high")).toBe("high");
    expect(validThinkingLevel("xhigh")).toBe("xhigh");
    expect(validThinkingLevel("max")).toBe("max");
  });
  it("trims padded values from the API", () => {
    expect(validThinkingLevel(" medium ")).toBe("medium");
    expect(validThinkingLevel("  high  ")).toBe("high");
    expect(validThinkingLevel("  ")).toBeNull();
  });
});

describe("validateThinkingLevel", () => {
  it("returns null for a set, valid thinking level", () => {
    expect(validateThinkingLevel({ thinking: "low" })).toBeNull();
  });
  it("returns null when thinking is unset or the default sentinel", () => {
    expect(validateThinkingLevel({})).toBeNull();
    expect(validateThinkingLevel({ thinking: "default" })).toBeNull();
  });
  it("returns an actionable message for an out-of-enum value", () => {
    const msg = validateThinkingLevel({ thinking: "bogus" });
    expect(msg).toMatch(/bogus/);
    expect(msg).toMatch(/off, auto, minimal, low, medium, high, xhigh, max/);
  });
});

describe("validateCredentialMode", () => {
  it("passes for local mode", () => {
    expect(validateCredentialMode({ credentialMode: "local" })).toBeNull();
  });
  it("passes for broker mode with resolved string env", () => {
    expect(validateCredentialMode({
      credentialMode: "broker",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" },
    })).toBeNull();
  });
  it("returns an actionable error when broker mode lacks url or token", () => {
    expect(validateCredentialMode({
      credentialMode: "broker",
      env: { OMP_AUTH_BROKER_URL: "http://b:8765" },
    })).toMatch(/OMP_AUTH_BROKER_TOKEN/);
    expect(validateCredentialMode({
      credentialMode: "broker",
      env: {},
    })).toMatch(/OMP_AUTH_BROKER_URL/);
  });
});

describe("paperclipApiBase", () => {
  it("defaults to 127.0.0.1:3100 when PAPERCLIP_LISTEN_PORT is empty", () => {
    expect(paperclipApiBase({ PAPERCLIP_LISTEN_PORT: "" })).toBe("http://127.0.0.1:3100");
  });
  it("uses an explicit listen port and strips an api url suffix", () => {
    expect(paperclipApiBase({ PAPERCLIP_LISTEN_PORT: "4100" })).toBe("http://127.0.0.1:4100");
    expect(paperclipApiBase({ PAPERCLIP_API_URL: "https://x.example/api/" })).toBe("https://x.example");
  });
});
import http from "node:http";
import { buildSessionSnapshotWorkProduct, postWorkProduct } from "./session-directives.js";

describe("buildSessionSnapshotWorkProduct", () => {
  it("shapes an artifact card with provider omp-session and snapshot metadata", () => {
    const wp = buildSessionSnapshotWorkProduct(
      {
        projects: [{ cwd: "/w", sessionCount: 2, lastActivityAt: "2026-08-28T01:00:00Z", lastTitle: "Second" }],
        sessions: [
          { sessionId: "sess-b", cwd: "/w", title: "Second", updatedAt: "2026-08-28T01:00:00Z", messageCount: 1, size: 40 },
          { sessionId: "sess-a", cwd: "/w", title: "First", updatedAt: "2026-08-28T00:00:00Z", messageCount: 3, size: 120 },
        ],
        total: 2, byCwd: [],
      },
      { currentSessionId: "sess-b", runId: "run-1", capturedAt: "2026-08-28T02:00:00Z" },
    );
    expect(wp.type).toBe("artifact");
    expect(wp.provider).toBe("omp-session");
    expect(wp.title).toContain("2 sessions");
    expect(wp.title).toContain("sess-b");
    expect(wp.summary).toContain("sess-a");
    expect(wp.metadata).toMatchObject({ currentSessionId: "sess-b", runId: "run-1" });
  });
  it("carries subagents into metadata only when the snapshot has them", () => {
    const base = {
      projects: [], sessions: [], total: 0, byCwd: [],
    };
    const context = { currentSessionId: null, runId: "run-1", capturedAt: "2026-08-28T02:00:00Z" };
    const withSubagents = buildSessionSnapshotWorkProduct(
      {
        ...base,
        subagents: [{
          id: "sub-1", index: 0, agent: "scout", status: "running",
          description: "map the repo", parentToolCallId: "tool-call-1", lastUpdate: 1,
        }],
      },
      context,
    );
    expect(withSubagents.metadata).toMatchObject({ subagents: [{ id: "sub-1", agent: "scout" }] });
    const without = buildSessionSnapshotWorkProduct(base, context);
    expect("subagents" in without.metadata).toBe(false);
  });
  it("does not throw on an unparseable updatedAt and reports unknown time", () => {
    const wp = buildSessionSnapshotWorkProduct(
      {
        projects: [],
        sessions: [{ sessionId: "sess-1", cwd: "/w", title: "Bad", updatedAt: "never", messageCount: 1, size: 1 }],
        total: 1, byCwd: [],
      },
      { currentSessionId: null, runId: "run-1", capturedAt: "2026-08-28T02:00:00Z" },
    );
    expect(wp.summary).toContain("unknown time");
  });
  it("truncates ids longer than 12 characters and leaves 12-character ids intact", () => {
    const wp = buildSessionSnapshotWorkProduct(
      {
        projects: [],
        sessions: [{ sessionId: "1234567890123", cwd: "/w", title: "T", updatedAt: "2026-08-28T01:00:00Z", messageCount: 1, size: 1 }],
        total: 1, byCwd: [],
      },
      { currentSessionId: "123456789012", runId: "run-1", capturedAt: "2026-08-28T02:00:00Z" },
    );
    expect(wp.summary).toContain("Current session: 123456789012");
    expect(wp.summary).toContain("123456789012…");
    expect(wp.summary).not.toContain("1234567890123");
  });
});

describe("postWorkProduct", () => {
  it("POSTs to the issue work-products route with the run bearer token", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/api/issues/issue-1/work-products");
        expect(req.headers.authorization).toBe("Bearer run-jwt");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "wp-1" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const out = await postWorkProduct(
        { authToken: "run-jwt", issueId: "issue-1", apiBase: `http://127.0.0.1:${port}` },
        { type: "artifact", provider: "omp-session", title: "t", summary: "s", metadata: {} },
      );
      expect(out.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it("returns a typed error instead of throwing when the API is down", async () => {
    const out = await postWorkProduct(
      { authToken: "run-jwt", issueId: "issue-1", apiBase: "http://127.0.0.1:9" },
      { type: "artifact", provider: "omp-session", title: "t", summary: "s", metadata: {} },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });
  it("returns early without fetching when issueId is missing", async () => {
    const out = await postWorkProduct(
      { authToken: "run-jwt" },
      { type: "artifact", provider: "omp-session", title: "t", summary: "s", metadata: {} },
    );
    expect(out).toEqual({ ok: false, error: "no issue id on this run" });
  });
  it("returns early without fetching when no auth token is available", async () => {
    const out = await postWorkProduct(
      { issueId: "issue-1" },
      { type: "artifact", provider: "omp-session", title: "t", summary: "s", metadata: {} },
    );
    expect(out).toEqual({ ok: false, error: "no run auth token available" });
  });
});

describe("sessionSnapshotDigestInput", () => {
  // P2-4 (v0.8 final review): the emission key hashed projects, session ids and
  // the current session only. Once omp answers `_omp/subagents`, a subagent tree
  // or status change with an otherwise untouched landscape compared equal, so
  // the updated card was never posted and the board kept stale subagents.
  const projects = [{ cwd: "/w", sessionCount: 1, lastActivityAt: "u1", lastTitle: "T" }];
  const sessions = [{
    sessionId: "s1", cwd: "/w", title: "T", updatedAt: "u1", messageCount: 1, size: 1,
  }];
  const subagent = {
    id: "sub-1", index: 0, agent: "scout", status: "running",
    description: "map the repo", parentToolCallId: "call-1", lastUpdate: 1,
  };

  it("hashes a snapshot with no subagents exactly as before the field existed", () => {
    const legacy = {
      projects,
      ids: sessions.map((s) => [s.sessionId, s.updatedAt]),
      current: "s1",
    };
    expect(snapshotDigest(sessionSnapshotDigestInput({ projects, sessions }, "s1")))
      .toBe(createHash("sha256").update(JSON.stringify(legacy)).digest("hex").slice(0, 16));
  });

  it("re-emits when only the subagent tree changes", () => {
    const running = sessionSnapshotDigestInput({ projects, sessions, subagents: [subagent] }, "s1");
    const done = sessionSnapshotDigestInput(
      { projects, sessions, subagents: [{ ...subagent, status: "completed" }] },
      "s1",
    );
    expect(snapshotDigest(running)).not.toBe(snapshotDigest(done));
  });

  it("treats an answered-but-empty tree as a change from no answer, then dedups", () => {
    const unanswered = sessionSnapshotDigestInput({ projects, sessions }, "s1");
    const empty = sessionSnapshotDigestInput({ projects, sessions, subagents: [] }, "s1");
    expect(snapshotDigest(unanswered)).not.toBe(snapshotDigest(empty));
    expect(snapshotDigest(empty)).toBe(snapshotDigest({ ...empty }));
  });

  it("is insensitive to the payload's key order", () => {
    const a = sessionSnapshotDigestInput({ projects, sessions, subagents: [subagent] }, "s1");
    const b = sessionSnapshotDigestInput({
      projects,
      sessions,
      subagents: [{
        lastUpdate: 1, parentToolCallId: "call-1", description: "map the repo",
        status: "running", agent: "scout", index: 0, id: "sub-1",
      }],
    }, "s1");
    expect(snapshotDigest(a)).toBe(snapshotDigest(b));
  });
});

describe("sessionScope", () => {
  it("defaults to shared and reports isolated when set", () => {
    expect(resolveSessionScope({})).toBe("shared");
    expect(resolveSessionScope({ sessionScope: "" })).toBe("shared");
    expect(resolveSessionScope({ sessionScope: "isolated" })).toBe("isolated");
  });
  it("reports an unknown value instead of silently downgrading to shared", () => {
    // A typo must not quietly disable a containment control.
    expect(resolveSessionScope({ sessionScope: "Isolated" })).toBe("shared");
    expect(validateSessionScope({ sessionScope: "Isolated" }))
      .toContain("expected 'shared' or 'isolated'");
  });
  it("fails isolated without broker credentials, naming both knobs and the reason", () => {
    const msg = validateSessionScope({ sessionScope: "isolated" });
    expect(msg).toContain("sessionScope is 'isolated'");
    expect(msg).toContain("credentialMode");
    expect(msg).toContain("agent.db");
  });
  it("accepts isolated with broker credentials and shared with anything", () => {
    expect(validateSessionScope({ sessionScope: "isolated", credentialMode: "broker" })).toBe(null);
    expect(validateSessionScope({ sessionScope: "shared", credentialMode: "local" })).toBe(null);
    expect(validateSessionScope({})).toBe(null);
  });
  it("exposes both knobs on the config schema with shared as the default", () => {
    const fields = getSessionConfigSchema().fields;
    expect(fields.find((f) => f.key === "sessionScope")).toMatchObject({
      type: "select", default: "shared",
    });
    expect(fields.find((f) => f.key === "sessionSnapshotDiagnostic")).toMatchObject({
      type: "toggle", default: false,
    });
  });
});
