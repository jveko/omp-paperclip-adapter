import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capabilityCacheKey, capabilityChecks, capabilityDiagnostics, clearCapabilityCache,
  loadCapabilities, probeCapabilities,
} from "./capabilities.js";

/**
 * The capability layer is the gate that replaced the single-minor assertion:
 * it must say what the build cannot do, name the feature that will not work,
 * and never crash or refuse a run because a surface is missing.
 *
 * Every case drives a scripted build — the same `fake-acp.mjs` the side-channel
 * tests use (its `no*` modes remove one advertised/probed surface) and the same
 * `fake-rpc.mjs` worker the managed lane uses (`norpc` answers the requestable
 * frames with the real unknown-command error).
 */

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures");
const fakeAcp = path.join(fixtures, "fake-acp.mjs");
const fakeRpc = path.join(fixtures, "fake-rpc.mjs");

const tmpDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  clearCapabilityCache();
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** The ACP command shape `testEnvironment` and the run plan pass. */
function acpCommand(script = fakeAcp): { command: string; args: string[] } {
  return { command: process.execPath, args: [script, "acp"] };
}

/**
 * A build that is literally named `omp`: it answers the ACP group with the
 * scripted responder and the surface group with a chosen settings map/verb
 * list, so the surface probes are exercised without a real omp.
 */
async function fakeOmpBuild(options: {
  settingsKeys: string[];
  topVerbs?: string[];
  modelsVerbs?: string[];
  sessionVerbs?: string[];
  acpScript?: string;
}): Promise<string> {
  const dir = await tmpDir("omp-fake-build-");
  const script = path.join(dir, "omp");
  const help = (verbs: string[]): string =>
    `omp v18.14.0\n\nCOMMANDS\n${verbs.map((verb) => `  ${verb.padEnd(10)}description`).join("\n")}\n`;
  const settings: Record<string, { type: string }> = Object.fromEntries(
    options.settingsKeys.map((key) => [key, { type: "number" }]),
  );
  await writeFile(script, [
    "#!/bin/sh",
    `if [ "$1" = "acp" ]; then exec "${process.execPath}" "${options.acpScript ?? fakeAcp}" "$@"; fi`,
    `case "$*" in`,
    `  "config list --json") printf '%s\\n' '${JSON.stringify(settings)}' ;;`,
    `  "--help") printf '%s\\n' '${help(options.topVerbs ?? ["models", "session", "gc"])}' ;;`,
    `  "models --help") printf '%s\\n' '${help(options.modelsVerbs ?? ["ls", "refresh"])}' ;;`,
    `  "session --help") printf '%s\\n' '${help(options.sessionVerbs ?? ["lease"])}' ;;`,
    `esac`,
    "",
  ].join("\n"), { mode: 0o755 });
  return script;
}

describe("probeCapabilities — ACP surfaces", () => {
  it("reports every advertised surface on a fully capable build", async () => {
    const set = await probeCapabilities({ acp: acpCommand(), mode: "engine" });
    expect(set.acp.ok).toBe(true);
    expect(set.capabilities["acp.session/list"].state).toBe("yes");
    expect(set.capabilities["acp.session/fork"].state).toBe("yes");
    expect(set.capabilities["acp._session/steering"].state).toBe("yes");
    expect(set.capabilities["acp._omp/extensions"].state).toBe("yes");
    expect(set.capabilities["acp.config.thinking"].state).toBe("yes");
    // A command not named `omp` never answers the surface probes.
    expect(set.capabilities["settings.session.maxCost"].state).toBe("unknown");
  });

  it("degrades a build that lacks session/fork to a warn naming the fork directive", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "nofork");
    const set = await probeCapabilities({ acp: acpCommand(), mode: "engine" });
    expect(set.capabilities["acp.session/fork"].state).toBe("no");
    const diagnostics = capabilityDiagnostics(set, ["sessionFork"]);
    expect(diagnostics).toEqual([{
      level: "warn",
      code: "omp_capability_missing_session_fork",
      message: expect.stringContaining("sessionForkSourceId"),
    }]);
    // The absence is a warning, never an error, and the run is not refused.
    expect(capabilityChecks(set).some((check) => check.level === "error")).toBe(false);
  });

  it("degrades a build without session/list using the snapshot diagnostic", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "nolist");
    const set = await probeCapabilities({ acp: acpCommand(), mode: "engine" });
    expect(set.capabilities["acp.session/list"].state).toBe("no");
    const check = capabilityChecks(set).find((c) => c.code === "omp_session_list_unsupported");
    expect(check?.level).toBe("warn");
    expect(check?.message).toContain("session snapshot");
  });

  it("degrades a build without _omp/extensions and without steering as notes only", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "noextensions");
    const noExtensions = await probeCapabilities({ acp: acpCommand(), mode: "engine" });
    expect(noExtensions.capabilities["acp._omp/extensions"].state).toBe("no");
    expect(noExtensions.capabilities["acp._session/steering"].state).toBe("yes");
    expect(capabilityChecks(noExtensions).find((c) => c.code === "omp_capability_missing_extensions")?.level)
      .toBe("warn");

    clearCapabilityCache();
    vi.stubEnv("FAKE_ACP_MODE", "nosteering");
    const noSteering = await probeCapabilities({ acp: acpCommand(), mode: "engine" });
    expect(noSteering.capabilities["acp._session/steering"].state).toBe("no");
    // The managed lane's steer/follow-up frames are unaffected, so this is a note.
    expect(capabilityChecks(noSteering).find((c) => c.code === "omp_capability_missing_steering")?.level)
      .toBe("info");
  }, 30_000);
});

describe("probeCapabilities — omp-named surface probes", () => {
  it("reads the settings key map and the CLI verb lists", async () => {
    const script = await fakeOmpBuild({
      settingsKeys: ["session.maxCost", "defaultThinkingLevel"],
      sessionVerbs: ["list"],
    });
    const set = await probeCapabilities({ acp: { command: script, args: ["acp"] }, mode: "engine" });
    expect(set.capabilities["settings.session.maxCost"].state).toBe("yes");
    expect(set.capabilities["settings.defaultThinkingLevel"].state).toBe("yes");
    expect(set.capabilities["settings.tools.restrictedFolders"].state).toBe("no");
    expect(set.capabilities["cli.models.refresh"].state).toBe("yes");
    expect(set.capabilities["cli.session.lease"].state).toBe("no");
    expect(set.capabilities["cli.gc"].state).toBe("yes");
    // Absence names the feature and the fallback, and never errors.
    const fence = capabilityChecks(set).find((c) => c.code === "omp_settings_restricted_folders_missing");
    expect(fence?.level).toBe("warn");
    expect(fence?.message).toContain("folder fence");
    expect(capabilityChecks(set).find((c) => c.code === "omp_cli_session_lease_missing")?.level).toBe("info");
  }, 30_000);

  it("reports the folder fence as a named warn only for a run that configures one", async () => {
    const script = await fakeOmpBuild({ settingsKeys: ["session.maxCost", "defaultThinkingLevel"] });
    const set = await probeCapabilities({ acp: { command: script, args: ["acp"] }, mode: "engine" });
    expect(capabilityDiagnostics(set, ["budgetHardCap"])).toEqual([]);
    expect(capabilityDiagnostics(set, ["folderFence"])).toEqual([{
      level: "warn",
      code: "omp_settings_restricted_folders_missing",
      message: expect.stringContaining("folder fence"),
    }]);
  }, 30_000);
});

describe("probeCapabilities — managed worker frames", () => {
  it("probes the requestable frames on the worker connection in managed mode", async () => {
    const script = await fakeOmpBuild({ settingsKeys: [] });
    const set = await probeCapabilities({
      acp: { command: script, args: ["acp"] },
      mode: "managed",
      worker: { command: process.execPath, args: [fakeRpc] },
    });
    expect(set.capabilities["rpc.get_session_stats"].state).toBe("yes");
    expect(set.capabilities["rpc.set_host_tools"].state).toBe("yes");
    expect(set.capabilities["rpc.set_subagent_subscription"].state).toBe("yes");
    // A notification has no request surface; it stays an explicit unknown.
    expect(set.capabilities["rpc.session_settled"].state).toBe("unknown");
    expect(set.capabilities["rpc.session_settled"].source).toContain("no request surface");
  }, 30_000);

  it("warns, naming the feature, when the worker answers the frames as unknown commands", async () => {
    vi.stubEnv("FAKE_RPC_MODE", "norpc");
    const script = await fakeOmpBuild({ settingsKeys: [] });
    const set = await probeCapabilities({
      acp: { command: script, args: ["acp"] },
      mode: "managed",
      worker: { command: process.execPath, args: [fakeRpc] },
    });
    expect(set.capabilities["rpc.get_session_stats"].state).toBe("no");
    expect(set.capabilities["rpc.set_host_tools"].state).toBe("no");
    const checks = capabilityChecks(set);
    expect(checks.find((c) => c.code === "omp_rpc_session_stats_missing")?.level).toBe("warn");
    expect(checks.find((c) => c.code === "omp_rpc_host_tools_missing")?.message).toContain("connection tools");
    expect(checks.some((c) => c.level === "error")).toBe(false);
  }, 30_000);

  it("never probes the worker group for an engine-mode build", async () => {
    const script = await fakeOmpBuild({ settingsKeys: [] });
    const set = await probeCapabilities({ acp: { command: script, args: ["acp"] }, mode: "engine" });
    expect(set.capabilities["rpc.get_session_stats"].state).toBe("unknown");
    expect(set.capabilities["rpc.get_session_stats"].source).toBe("not probed: no managed worker");
    // ...and an engine deployment is never warned about frames it cannot use.
    expect(capabilityChecks(set).some((c) => c.code.startsWith("omp_rpc"))).toBe(false);
  }, 30_000);
});

describe("capability cache", () => {
  it("single-flights concurrent probes for one (command, env) key", async () => {
    const dir = await tmpDir("omp-cap-cache-");
    const frameLog = path.join(dir, "frames.log");
    vi.stubEnv("FAKE_ACP_FRAME_LOG", frameLog);
    const input = { acp: acpCommand(), mode: "engine" as const, cacheDir: dir };
    const [first, second] = await Promise.all([loadCapabilities(input), loadCapabilities(input)]);
    expect(first).toBe(second);
    const frames = (await readFile(frameLog, "utf8")).split("\n").filter(Boolean);
    expect(frames.filter((line) => line.startsWith("initialize"))).toHaveLength(1);
  }, 30_000);

  it("reads the persisted cache without spawning a probe", async () => {
    const dir = await tmpDir("omp-cap-persist-");
    const input = { acp: acpCommand(), mode: "engine" as const, cacheDir: dir };
    const probed = await loadCapabilities(input);
    clearCapabilityCache();
    const frameLog = path.join(dir, "frames2.log");
    vi.stubEnv("FAKE_ACP_FRAME_LOG", frameLog);
    const cached = await loadCapabilities({ ...input, cacheOnly: true });
    expect(cached?.key).toBe(probed.key);
    await expect(readFile(frameLog, "utf8")).rejects.toThrow();
  }, 30_000);

  it("returns null for a cold cache-only read instead of probing", async () => {
    const dir = await tmpDir("omp-cap-cold-");
    const cached = await loadCapabilities({ acp: acpCommand(), mode: "engine", cacheDir: dir, cacheOnly: true });
    expect(cached).toBeNull();
  });

  it("re-probes when the caller reports a different build version", async () => {
    const dir = await tmpDir("omp-cap-version-");
    const input = { acp: acpCommand(), mode: "engine" as const, cacheDir: dir };
    const first = await loadCapabilities({ ...input, version: "18.13.1" });
    expect(first.version).toBe("18.13.1");
    const second = await loadCapabilities({ ...input, version: "18.15.0" });
    expect(second.version).toBe("18.15.0");
    // ...and an unchanged version is served from cache (same object).
    const third = await loadCapabilities({ ...input, version: "18.15.0" });
    expect(third).toBe(second);
  }, 30_000);

  it("keys the cache by command, args and env so two agents never share a build result", () => {
    const base = { acp: { command: "omp", args: ["acp"], env: { A: "1" } }, mode: "engine" as const };
    expect(capabilityCacheKey(base)).toBe(capabilityCacheKey({ ...base }));
    expect(capabilityCacheKey(base)).not.toBe(
      capabilityCacheKey({ ...base, acp: { ...base.acp, env: { A: "2" } } }),
    );
    expect(capabilityCacheKey(base)).not.toBe(
      capabilityCacheKey({ ...base, acp: { ...base.acp, args: ["acp", "--thinking", "off"] } }),
    );
  });
});
