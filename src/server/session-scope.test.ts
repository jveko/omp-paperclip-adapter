import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { ompAgentDir } from "./session-state.js";
import { prepareSessionScope } from "./session-scope.js";

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
  it("leaves a shared run untouched and creates nothing", async () => {
    const config = { credentialMode: "broker", env: { OMP_AUTH_BROKER_URL: "http://b" } };
    const out = await prepareSessionScope(config, { companyId: "co-1", agentId: "agent-1" });
    if (!out.ok) throw new Error(out.error);
    expect(out.prepared).toEqual({ scope: "shared", agentDir: null, config, warnings: [] });
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
});
