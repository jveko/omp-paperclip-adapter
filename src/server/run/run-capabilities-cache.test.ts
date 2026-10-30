import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { bridgePath, moduleDir } from "../acp.js";
import { clearCapabilityCache } from "../capabilities.js";
import { testEnvironment } from "../test.js";
import { buildRunPlan } from "./run-plan.js";

/**
 * The run path reads the capability cache the environment test writes. That
 * only works if both derive the SAME probe input — command, args and env — and
 * the run must derive it from the agent config as it arrived, not from the
 * config the run path itself mutates (session-scope fence, manifest env,
 * `--extension`, `PI_CONFIG_FILES`). This test pins that parity end to end:
 * an environment test populates the cache, then a governance-configured run
 * reads it and names the surface the build lacks.
 */

const fakeAcp = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-acp.mjs",
);

let root: string;
let ompCommand: string;

const POLICY = [
  "approvedEndpoints: [prov]",
  "restrictedFolders:",
  "  - /srv/data",
  "",
].join("\n");

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "omp-run-cache-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  ompCommand = path.join(bin, "omp");
  // A build with the settings/verbs the adapter reads EXCEPT the folder fence,
  // so a governance-configured run has a named surface to report.
  await writeFile(ompCommand, [
    "#!/bin/sh",
    `if [ "$1" = "acp" ]; then exec "${process.execPath}" "${fakeAcp}" "$@"; fi`,
    `case "$*" in`,
    `  "--version") printf '%s\\n' 'omp/18.14.0' ;;`,
    `  "config list --json") printf '%s\\n' '{"session.maxCost":{},"defaultThinkingLevel":{}}' ;;`,
    `  "models ls --json") printf '%s\\n' '{"models":[]}' ;;`,
    `  "--help") printf '%s\\n' 'omp v18.14.0\\n\\nCOMMANDS\\n  models    models\\n  session   sessions\\n  gc        gc\\n' ;;`,
    `  "models --help") printf '%s\\n' 'omp v18.14.0\\n\\nCOMMANDS\\n  refresh   refresh\\n' ;;`,
    `  "session --help") printf '%s\\n' 'omp v18.14.0\\n\\nCOMMANDS\\n  lease     lease\\n' ;;`,
    `esac`,
    "",
  ].join("\n"), { mode: 0o755 });
  vi.stubEnv("PAPERCLIP_HOME", root);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "runcache");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  clearCapabilityCache();
  await rm(root, { recursive: true, force: true });
});

function runCtx(onEvent: (event: { message?: string }) => void): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null },
    runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: "t" },
    config: { command: ompCommand, governancePolicy: POLICY },
    context: {},
    onLog: async () => {},
    onEvent: async (event) => { onEvent(event as { message?: string }); },
  } as AdapterExecutionContext;
}

describe("run-path capability cache parity", () => {
  it("reads the set the environment test probed, and names the missing fence", async () => {
    clearCapabilityCache();
    await rm(path.join(root, "instances"), { recursive: true, force: true });

    // 1. A cold cache: the run cannot report anything (it never probes).
    const cold: Array<{ message?: string }> = [];
    const plannedCold = await buildRunPlan(runCtx((event) => cold.push(event)), { bridge: bridgePath, moduleDir });
    expect(plannedCold.kind).toBe("ready");
    expect(cold.some((event) => /folder fence/i.test(event.message ?? ""))).toBe(false);

    // 2. The environment test probes and persists under its own input.
    const envTest = await testEnvironment({
      companyId: "co-1",
      adapterType: "omp_local",
      config: { command: ompCommand, governancePolicy: POLICY },
      executionTarget: null,
    } as AdapterEnvironmentTestContext);
    const fence = envTest.checks.find((check) => check.code === "omp_settings_restricted_folders_missing");
    expect(fence?.level).toBe("warn");

    // 3. The run reads that entry — same key despite the manifests, the
    // `--extension` append and the failover overlay the run path adds later.
    const warm: Array<{ message?: string }> = [];
    const planned = await buildRunPlan(runCtx((event) => warm.push(event)), { bridge: bridgePath, moduleDir });
    expect(planned.kind).toBe("ready");
    const reported = warm.filter((event) => /folder fence/i.test(event.message ?? ""));
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain("tools.restrictedFolders");
  }, 60_000);
});
