import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  getSessionConfigSchema, paperclipApiBase, readSessionIntelConfig, resolveRunDirective,
  resolveSessionScope, sessionSnapshotDigestInput, thinkingLevelChanged, validateCredentialMode,
  validateSessionScope, validThinkingLevel, validatePlanMode, validateThinkingLevel,
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
      "credentialMode", "thinking", "fallbackChain",
      "fallbackOn", "fallbackRevertPolicy", "waitForUsageReset", "maxDelayMs",
      "usageReport", "skillsAsTools", "steering", "executionMode", "governancePolicy",
    ]);
    for (const field of schema.fields) expect(field.hint).toContain("next run");
  });
  it("exposes steering as an off-by-default managed-lane toggle", () => {
    const byKey = Object.fromEntries(getSessionConfigSchema().fields.map((f) => [f.key, f]));
    expect(byKey.steering.type).toBe("select");
    expect(byKey.steering.default).toBe("off");
    expect(byKey.steering.options.map((o: { value: string }) => o.value)).toEqual(["off", "on"]);
  });
  it("exposes executionMode as an engine-defaulted lane selector", () => {
    const byKey = Object.fromEntries(getSessionConfigSchema().fields.map((f) => [f.key, f]));
    expect(byKey.executionMode.type).toBe("select");
    expect(byKey.executionMode.default).toBe("engine");
    expect(byKey.executionMode.options.map((o: { value: string }) => o.value)).toEqual(["engine", "managed"]);
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
  it("exposes the quota-aware retry knobs omp validates by discarding", () => {
    const byKey = Object.fromEntries(getSessionConfigSchema().fields.map((f) => [f.key, f]));
    expect(byKey.fallbackOn.type).toBe("select");
    expect(byKey.fallbackOn.default).toBe("any");
    expect(byKey.fallbackOn.options.map((o: { value: string }) => o.value))
      .toEqual(["any", "usage-limit", "except-usage-limit"]);
    expect(byKey.fallbackRevertPolicy.type).toBe("select");
    expect(byKey.fallbackRevertPolicy.default).toBe("cooldown-expiry");
    expect(byKey.fallbackRevertPolicy.options.map((o: { value: string }) => o.value))
      .toEqual(["cooldown-expiry", "never"]);
    expect(byKey.waitForUsageReset.type).toBe("toggle");
    expect(byKey.waitForUsageReset.default).toBe(false);
    expect(byKey.maxDelayMs.type).toBe("number");
    expect(byKey.maxDelayMs.default).toBeUndefined();
  });
  it("documents the thinking level as a settings overlay that rotates once when edited", () => {
    const byKey = Object.fromEntries(getSessionConfigSchema().fields.map((f) => [f.key, f]));
    const hint = byKey.thinking.hint;
    // The mechanism is the omp setting, not the fingerprint-rotating flag.
    expect(hint).toMatch(/defaultThinkingLevel/);
    expect(hint).not.toMatch(/^Forwards omp --thinking/);
    // A resumed session keeps its stored level, so an edit restarts it once.
    expect(hint).toMatch(/resumed session keeps/i);
    expect(hint).toMatch(/rotates/i);
    // `off` is the one level the setting cannot express.
    expect(hint).toMatch(/"off" runs the CLI flag/);
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

describe("thinkingLevelChanged", () => {
  const record = { sessionId: "sess-a", level: "low" };
  it("flags a level the running session cannot hold", () => {
    expect(thinkingLevelChanged(record, "sess-a", "high")).toBe(true);
    // Unsetting the level is a change too: the session keeps its stored level.
    expect(thinkingLevelChanged(record, "sess-a", "")).toBe(true);
  });
  it("re-establishes a level the running session cannot name", () => {
    // A fork from a session this adapter never ran leaves the level unknown.
    // Keeping it unknown would make every later edit inert, so the next run
    // spends one fresh session to make the level certain again.
    expect(thinkingLevelChanged({ sessionId: "sess-a", level: null }, "sess-a", "high")).toBe(true);
  });
  it("stays quiet when the level matches, or when the session's level is unknown", () => {
    expect(thinkingLevelChanged(record, "sess-a", "low")).toBe(false);
    // No record: a state written before the record existed, or a fork whose
    // source carried its own level. Adopt instead of rotating, so an upgrade
    // never resets a running employee.
    expect(thinkingLevelChanged(null, "sess-a", "high")).toBe(false);
    expect(thinkingLevelChanged(record, "sess-b", "high")).toBe(false);
    // A record whose level could not be known for ANOTHER session is adopted.
    expect(thinkingLevelChanged({ sessionId: "sess-b", level: null }, "sess-a", "high")).toBe(false);
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

describe("validatePlanMode", () => {
  it.each([
    { name: "plan flag", config: { plan: true } },
    { name: "planMode flag", config: { planMode: true } },
    { name: "string planEnabled", config: { planEnabled: "true" } },
    { name: "mode", config: { mode: "plan" } },
    { name: "acpMode", config: { acpMode: "plan" } },
    { name: "agentCommand --plan", config: { agentCommand: "omp acp --plan" } },
    { name: "agentCommand --plan-yolo-into", config: { agentCommand: "omp acp --plan-yolo-into gpt-5" } },
  ])("returns a plan warning for $name", ({ config }) => {
    expect(validatePlanMode(config)).toMatch(/plan/i);
  });

  it.each([
    { name: "an empty config", config: {} },
    { name: "persistent mode", config: { mode: "persistent" } },
    { name: "an agentCommand without --plan", config: { agentCommand: "omp acp --thinking high" } },
  ])("returns null for $name", ({ config }) => {
    expect(validatePlanMode(config)).toBeNull();
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
import { buildSessionSnapshotWorkProduct, postWorkProduct, resolveWorkProductIssueId } from "./session-directives.js";

describe("buildSessionSnapshotWorkProduct", () => {
  it("shapes an artifact card with provider omp-session and snapshot metadata", () => {
    const wp = buildSessionSnapshotWorkProduct(
      {
        projects: [{ cwd: "/w", sessionCount: 2, lastActivityAt: "2026-08-28T01:00:00Z", lastTitle: "Second" }],
        sessions: [
          { sessionId: "sess-b", cwd: "/w", title: "Second", updatedAt: "2026-08-28T01:00:00Z", messageCount: 1, size: 40 },
          { sessionId: "sess-a", cwd: "/w", title: "First", updatedAt: "2026-08-28T00:00:00Z", messageCount: 3, size: 120 },
        ],
        total: 2, truncated: false,
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
        total: 1, truncated: false,
      },
      { currentSessionId: null, runId: "run-1", capturedAt: "2026-08-28T02:00:00Z" },
    );
    expect(wp.summary).toContain("unknown time");
  });
  it("renders a paged listing as a lower bound, not a complete count", () => {
    const wp = buildSessionSnapshotWorkProduct(
      {
        projects: [],
        sessions: [{ sessionId: "sess-1", cwd: "/w", title: "T", updatedAt: "2026-08-28T01:00:00Z", messageCount: 1, size: 1 }],
        total: null, truncated: true,
      },
      { currentSessionId: null, runId: "run-1", capturedAt: "2026-08-28T02:00:00Z" },
    );
    expect(wp.title).toContain("1+ sessions");
    expect(wp.metadata).toMatchObject({ total: null, truncated: true });
  });
  it("truncates ids longer than 12 characters and leaves 12-character ids intact", () => {
    const wp = buildSessionSnapshotWorkProduct(
      {
        projects: [],
        sessions: [{ sessionId: "1234567890123", cwd: "/w", title: "T", updatedAt: "2026-08-28T01:00:00Z", messageCount: 1, size: 1 }],
        total: 1, truncated: false,
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

  it("gives up on a hung endpoint instead of blocking the run path forever", async () => {
    let aborted = false;
    const out = await postWorkProduct(
      {
        authToken: "run-jwt",
        issueId: "0b8f0d5e-9a10-4f6a-8f2b-1c2d3e4f5a6b",
        apiBase: "http://127.0.0.1:9",
        timeoutMs: 20,
        fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        }),
      },
      { type: "artifact", provider: "omp-session", title: "t", summary: "s", metadata: {} },
    );
    expect(aborted).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("work-product POST failed");
  });
});

describe("resolveWorkProductIssueId", () => {
  const issue = "0b8f0d5e-9a10-4f6a-8f2b-1c2d3e4f5a6b";

  it("accepts a UUID issue id and prefers it over taskId", () => {
    expect(resolveWorkProductIssueId({ issueId: issue, taskId: "chat-1" })).toBe(issue);
  });

  it("accepts a UUID taskId when the run has no issueId", () => {
    expect(resolveWorkProductIssueId({ taskId: issue })).toBe(issue);
  });

  it("rejects a non-issue wake id so the run makes no doomed POST", () => {
    expect(resolveWorkProductIssueId({ taskId: "chat-1" })).toBeNull();
  });

  it("rejects an empty or non-string id", () => {
    expect(resolveWorkProductIssueId({})).toBeNull();
    expect(resolveWorkProductIssueId({ issueId: 42 })).toBeNull();
    expect(resolveWorkProductIssueId({ issueId: "" })).toBeNull();
  });
});

describe("sessionSnapshotDigestInput", () => {
  const projects = [{ cwd: "/w", sessionCount: 1, lastActivityAt: "u1", lastTitle: "T" }];
  const sessions = [{
    sessionId: "s1", cwd: "/w", title: "T", updatedAt: "u1", messageCount: 1, size: 1,
  }];

  // The persisted `lastSnapshotDigest` values are the contract: a state file
  // written by an earlier release must still compare equal after the dead
  // subagent field was removed, so the projection stays exactly these keys.
  it("hashes a snapshot exactly as the pre-subagent projection did", () => {
    const legacy = {
      projects,
      ids: sessions.map((s) => [s.sessionId, s.updatedAt]),
      current: "s1",
    };
    expect(snapshotDigest(sessionSnapshotDigestInput({ projects, sessions }, "s1")))
      .toBe(createHash("sha256").update(JSON.stringify(legacy)).digest("hex").slice(0, 16));
  });

  it("re-emits when the session landscape changes", () => {
    const before = sessionSnapshotDigestInput({ projects, sessions }, "s1");
    const after = sessionSnapshotDigestInput(
      { projects, sessions: [{ ...sessions[0], updatedAt: "u2" }] },
      "s1",
    );
    expect(snapshotDigest(before)).not.toBe(snapshotDigest(after));
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
