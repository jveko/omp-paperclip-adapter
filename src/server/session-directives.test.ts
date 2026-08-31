import { describe, expect, it } from "vitest";
import { getSessionConfigSchema, paperclipApiBase, readSessionIntelConfig, resolveRunDirective, validateCredentialMode } from "./session-directives.js";

describe("readSessionIntelConfig", () => {
  it("defaults browser on and everything else off", () => {
    const cfg = readSessionIntelConfig({});
    expect(cfg).toEqual({
      browser: true, forkSourceId: "", forkToken: "",
      forceFreshToken: "", maxRuns: 0, maxAgeHours: 0,
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
    });
    expect(cfg.browser).toBe(false);
    expect(cfg.forkSourceId).toBe("sess-1");
    expect(cfg.maxRuns).toBe(5);
    expect(cfg.maxAgeHours).toBe(0);
  });
  it("treats the string 'false' as off for sessionBrowser", () => {
    const cfg = readSessionIntelConfig({ sessionBrowser: "false" });
    expect(cfg.browser).toBe(false);
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
      "sessionBrowser", "sessionForceFreshToken", "sessionForkSourceId",
      "sessionForkToken", "sessionMaxRuns", "sessionMaxAgeHours",
      "credentialMode", "fallbackChain", "usageReport",
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
