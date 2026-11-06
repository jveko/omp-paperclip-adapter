import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { ompAgentDir } from "./session-state.js";
import { prepareSessionScope } from "./session-scope.js";
import { buildWorkerEnv } from "../host/worker.js";
import { ompEnv } from "./omp-env.js";
import { sharedScopeRisk, validateSessionScope } from "./session-directives.js";
import {
  PROFILE_NAME_MAX, agentProfileName, profileAgentDir, profileConfigRoot,
  sanitizeAgentProfileName, validateProfileName,
} from "./omp-profile.js";

let tmpRoot = "";

function expectedAgentDir(): string {
  return path.join(
    resolvePaperclipInstanceRootForAdapter(),
    "companies", "co-1", "acp-engine", "agents", "agent-1", "omp-agent",
  );
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "omp-session-scope-"));
  vi.stubEnv("PAPERCLIP_HOME", tmpRoot);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-session-scope");
  vi.stubEnv("PI_CONFIG_DIR", path.join(tmpRoot, "omp-config"));
  vi.stubEnv("PI_CODING_AGENT_DIR", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("ompAgentDir", () => {
  it("is a per-company, per-agent directory next to the session-intel state", () => {
    expect(ompAgentDir("co-1", "agent-1")).toBe(expectedAgentDir());
    expect(ompAgentDir("co-2", "agent-1")).not.toBe(ompAgentDir("co-1", "agent-1"));
    expect(ompAgentDir("co-1", "agent-2")).not.toBe(ompAgentDir("co-1", "agent-1"));
  });
});

describe("prepareSessionScope", () => {
  it("leaves an explicit shared run untouched and creates nothing", async () => {
    const config = { sessionScope: "shared", credentialMode: "local", env: {} };
    const out = await prepareSessionScope(config, { companyId: "co-1", agentId: "agent-1" });
    if (!out.ok) throw new Error(out.error);
    expect(out.prepared).toEqual({ scope: "shared", agentDir: null, config, warnings: [] });
    await expect(stat(expectedAgentDir())).rejects.toThrow();
  });

  it("takes the isolated fence by default under broker credentials", async () => {
    // Broker credentials are supplied per run, so the fence costs nothing to
    // apply and is the default; no sessionScope key is needed.
    const out = await prepareSessionScope(
      { credentialMode: "broker", env: { OMP_AUTH_BROKER_URL: "http://b" } },
      { companyId: "co-1", agentId: "agent-1" },
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.prepared.scope).toBe("isolated");
    expect(out.prepared.agentDir).toBe(expectedAgentDir());
    expect(out.prepared.config.env).toMatchObject({ PI_CODING_AGENT_DIR: expectedAgentDir() });
    expect((await stat(expectedAgentDir())).isDirectory()).toBe(true);
  });

  it("warns that an explicit shared scope under broker credentials is cross-tenant", async () => {
    const config = { sessionScope: "shared", credentialMode: "broker", env: { OMP_AUTH_BROKER_URL: "http://b" } };
    const out = await prepareSessionScope(config, { companyId: "co-1", agentId: "agent-1" });
    if (!out.ok) throw new Error(out.error);
    expect(out.prepared).toEqual({
      scope: "shared", agentDir: null, config, warnings: [sharedScopeRisk(config)],
    });
    expect(out.prepared.warnings[0]).toContain("cross-tenant");
    await expect(stat(expectedAgentDir())).rejects.toThrow();
  });

  it("creates the per-agent dir and points PI_CODING_AGENT_DIR at it", async () => {
    const config = { sessionScope: "isolated", credentialMode: "broker", env: { OMP_AUTH_BROKER_URL: "http://b" } };
    const out = await prepareSessionScope(config, { companyId: "co-1", agentId: "agent-1" });
    if (!out.ok) throw new Error(out.error);
    expect(out.prepared.scope).toBe("isolated");
    expect(out.prepared.agentDir).toBe(expectedAgentDir());
    expect(out.prepared.config.env).toMatchObject({
      OMP_AUTH_BROKER_URL: "http://b",
      PI_CODING_AGENT_DIR: expectedAgentDir(),
    });
    expect((await stat(expectedAgentDir())).isDirectory()).toBe(true);
    // The caller's config object is never mutated.
    expect(config.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
  });

  it("folds the shared agent dir's config.yml in at the lowest precedence", async () => {
    const legacyConfig = path.join(tmpRoot, "omp-config", "agent", "config.yml");
    await mkdir(path.dirname(legacyConfig), { recursive: true });
    await writeFile(legacyConfig, "providers: {}\n", "utf8");
    const out = await prepareSessionScope(
      { sessionScope: "isolated", credentialMode: "broker", env: { PI_CONFIG_FILES: "/op/x.yml" } },
      { companyId: "co-1", agentId: "agent-1" },
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.prepared.config.env).toMatchObject({
      PI_CONFIG_FILES: [legacyConfig, "/op/x.yml"].join(path.delimiter),
    });
  });

  it("adds no PI_CONFIG_FILES when the shared agent dir has no config file", async () => {
    const out = await prepareSessionScope(
      { sessionScope: "isolated", credentialMode: "broker", env: {} },
      { companyId: "co-1", agentId: "agent-1" },
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.prepared.config.env).not.toHaveProperty("PI_CONFIG_FILES");
  });

  it("overrides an operator-set agent dir and says so", async () => {
    const out = await prepareSessionScope(
      { sessionScope: "isolated", credentialMode: "broker", env: { PI_CODING_AGENT_DIR: "/somewhere/else" } },
      { companyId: "co-1", agentId: "agent-1" },
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.prepared.config.env).toMatchObject({ PI_CODING_AGENT_DIR: expectedAgentDir() });
    expect(out.prepared.warnings).toHaveLength(1);
    expect(out.prepared.warnings[0]).toContain("/somewhere/else");
    expect(out.prepared.warnings[0]).toContain(expectedAgentDir());
  });

  it("fails closed when the per-agent dir cannot be created", async () => {
    // A file where the instance root must be: mkdir can never succeed.
    const blocker = path.join(tmpRoot, "blocker");
    await writeFile(blocker, "", "utf8");
    vi.stubEnv("PAPERCLIP_HOME", blocker);
    const out = await prepareSessionScope(
      { sessionScope: "isolated", credentialMode: "broker", env: {} },
      { companyId: "co-1", agentId: "agent-1" },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("sessionScope is 'isolated'");
      expect(out.error).toContain("could not be created");
    }
    await expect(readdir(blocker)).rejects.toThrow();
  });

  it("returns a typed error instead of throwing on an invalid instance id", async () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "../escape");
    const out = await prepareSessionScope(
      { sessionScope: "isolated", credentialMode: "broker", env: {} },
      { companyId: "co-1", agentId: "agent-1" },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("could not be resolved");
  });

  it("warns instead of silently dropping an unreadable operator config", async () => {
    const legacyConfig = path.join(tmpRoot, "omp-config", "agent", "config.yml");
    await mkdir(path.dirname(legacyConfig), { recursive: true });
    // A self-referential symlink makes stat fail with ELOOP, not ENOENT.
    await symlink(legacyConfig, legacyConfig);
    const out = await prepareSessionScope(
      { sessionScope: "isolated", credentialMode: "broker", env: {} },
      { companyId: "co-1", agentId: "agent-1" },
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.prepared.config.env).not.toHaveProperty("PI_CONFIG_FILES");
    expect(out.prepared.warnings).toHaveLength(1);
    expect(out.prepared.warnings[0]).toContain("could not be read");
  });
});

describe("agent profile names", () => {
  it("sanitizes arbitrary input into a valid, stable profile name", () => {
    const rows = [
      ["uppercase", "MyAgent"],
      ["spaces and slashes", "My Agent/One"],
      ["empty", ""],
      ["overlong", "A".repeat(PROFILE_NAME_MAX * 2)],
    ] as const;
    for (const [label, raw] of rows) {
      const name = sanitizeAgentProfileName(raw);
      expect(name, label).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(name.length, label).toBeLessThanOrEqual(PROFILE_NAME_MAX);
      expect(validateProfileName(name), label).toBe(null);
      expect(sanitizeAgentProfileName(raw), label).toBe(name);
    }
  });

  it("keeps distinct overlong names distinct when truncating", () => {
    // Truncation must not collapse two different agents onto one profile:
    // the hash suffix is what preserves the difference past PROFILE_NAME_MAX.
    const prefix = "a".repeat(PROFILE_NAME_MAX);
    const first = sanitizeAgentProfileName(`${prefix}-one`);
    const second = sanitizeAgentProfileName(`${prefix}-two`);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(PROFILE_NAME_MAX);
    expect(second.length).toBeLessThanOrEqual(PROFILE_NAME_MAX);
    expect(validateProfileName(first)).toBe(null);
    expect(validateProfileName(second)).toBe(null);
  });

  it("derives pc-<instance>-<company>-<agent> from the ids", () => {
    const ids = { instanceId: "inst-1", companyId: "co-1", agentId: "agent.one" };
    expect(agentProfileName(ids)).toBe("pc-inst-1-co-1-agent.one");
    expect(agentProfileName({ ...ids })).toBe(agentProfileName(ids));
    expect(agentProfileName({ ...ids, agentId: "agent.two" }))
      .not.toBe(agentProfileName(ids));
  });

  it("rejects names omp would refuse", () => {
    for (const bad of ["", "default", ".", "..", "-lead", "bad.", "UPPER"]) {
      expect(validateProfileName(bad), bad).not.toBe(null);
    }
    expect(validateProfileName("agent.one")).toBe(null);
    expect(validateProfileName("a".repeat(PROFILE_NAME_MAX))).toBe(null);
    expect(validateProfileName("a".repeat(PROFILE_NAME_MAX + 1))).not.toBe(null);
  });
});

describe("prepareSessionScope (profile)", () => {
  let home = "";

  beforeEach(async () => {
    home = path.join(tmpRoot, "home");
    await mkdir(home, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CONFIG_DIR", "omp-config");
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
  });

  it("uses a named profile and creates its config root", async () => {
    const config = {
      sessionScope: "profile",
      credentialMode: "broker",
      env: { OMP_AUTH_BROKER_URL: "http://b" },
    };
    const out = await prepareSessionScope(config, { companyId: "co-1", agentId: "agent-1" });
    if (!out.ok) throw new Error(out.error);
    const name = agentProfileName({
      instanceId: "test-session-scope", companyId: "co-1", agentId: "agent-1",
    });

    expect(out.prepared.scope).toBe("profile");
    expect(out.prepared.config.env).toMatchObject({
      OMP_PROFILE: name,
      OMP_AUTH_BROKER_URL: "http://b",
    });
    // A named profile resolves its own dir; PI_CODING_AGENT_DIR would override it.
    expect(out.prepared.config.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
    expect(out.prepared.agentDir).toBe(profileAgentDir(name));
    expect(out.prepared.agentDir).toBe(path.join(profileConfigRoot(name), "agent"));
    // The profile root lives under the stubbed HOME, so the host home is not touched.
    expect(profileConfigRoot(name)).toBe(path.join(home, "omp-config", "profiles", name));
    const stats = await stat(profileConfigRoot(name));
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
    expect(out.prepared.warnings).toEqual([]);
    // The caller's config object is never mutated.
    expect(config.env).not.toHaveProperty("OMP_PROFILE");
  });

  it("hands the same profile to the run's worker and side channels", async () => {
    const out = await prepareSessionScope(
      { sessionScope: "profile", credentialMode: "broker", env: {} },
      { companyId: "co-1", agentId: "agent-1" },
    );
    if (!out.ok) throw new Error(out.error);
    const name = agentProfileName({
      instanceId: "test-session-scope", companyId: "co-1", agentId: "agent-1",
    });
    // The run child (the supervisor's worker) and every side channel derive
    // their env from this config; both must resolve the same profile.
    expect(buildWorkerEnv(out.prepared.config)).toMatchObject({ OMP_PROFILE: name });
    expect(ompEnv({ config: out.prepared.config })).toMatchObject({ OMP_PROFILE: name });
  });

  it("refuses when config.env.PI_CODING_AGENT_DIR would override the profile", async () => {
    const out = await prepareSessionScope(
      {
        sessionScope: "profile",
        credentialMode: "broker",
        env: { PI_CODING_AGENT_DIR: "/somewhere/else" },
      },
      { companyId: "co-1", agentId: "agent-1" },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("PI_CODING_AGENT_DIR");
      expect(out.error).toMatch(/ignore/i);
    }
  });

  it("refuses when the process PI_CODING_AGENT_DIR would override the profile", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/from/process/env");
    const out = await prepareSessionScope(
      { sessionScope: "profile", credentialMode: "broker", env: {} },
      { companyId: "co-1", agentId: "agent-1" },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("PI_CODING_AGENT_DIR");
      expect(out.error).toMatch(/ignore/i);
    }
  });

  it("returns a typed error for an invalid instance id instead of throwing", async () => {
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "../escape");
    const out = await prepareSessionScope(
      { sessionScope: "profile", credentialMode: "broker", env: {} },
      { companyId: "co-1", agentId: "agent-1" },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/instance/i);
  });

  it("is refused by validateSessionScope without broker credentials", () => {
    expect(validateSessionScope({ sessionScope: "profile", credentialMode: "broker" })).toBe(null);
    const msg = validateSessionScope({ sessionScope: "profile", credentialMode: "local" });
    expect(msg).toContain("sessionScope is 'profile'");
    expect(msg).toContain("credentialMode");
  });
});
