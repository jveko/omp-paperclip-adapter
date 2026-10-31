import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type * as CapabilitiesModule from "../capabilities.js";
import { bridgePath, moduleDir } from "../acp.js";
import { buildRunPlan } from "./run-plan.js";
import type { CapabilityId, CapabilitySet } from "../capabilities.js";

/**
 * The run path reads the capability cache (it never probes) and reports the
 * features THIS run depends on that the build lacks. This pins that wiring:
 * a run on a build whose worker cannot answer `get_session_stats` gets one
 * named warning and still plans normally.
 */

const capabilityMocks = vi.hoisted(() => ({ snapshot: { value: null as unknown } }));

vi.mock("../capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CapabilitiesModule>();
  return {
    ...actual,
    loadCapabilities: vi.fn(async () => capabilityMocks.snapshot.value),
    capabilityCacheDir: () => path.join(os.tmpdir(), "omp-capabilities-test"),
  };
});

/** Every probed id present, then the caller knocks out what the build lacks. */
function capabilitySet(lacking: CapabilityId[]): CapabilitySet {
  const ids: CapabilityId[] = [
    "acp.session/list", "acp.session/fork", "acp._session/steering", "acp._omp/extensions",
    "acp.config.mode", "acp.config.model", "acp.config.thinking",
    "settings.session.maxCost", "settings.tools.restrictedFolders", "settings.defaultThinkingLevel",
    "cli.models.refresh", "cli.session.lease", "cli.gc",
    "rpc.session_settled", "rpc.get_session_stats", "rpc.set_host_tools", "rpc.set_subagent_subscription",
  ];
  const observedAt = new Date().toISOString();
  return {
    key: "test-key",
    observedAt,
    version: null,
    mode: "managed",
    acp: { ok: true, configOptionIds: ["mode", "model", "thinking"] },
    capabilities: Object.fromEntries(ids.map((id) => [id, {
      state: lacking.includes(id) ? "no" : "yes",
      confidence: "observed",
      source: "test fixture",
      observedAt,
    }])) as Record<CapabilityId, CapabilitySet["capabilities"][CapabilityId]>,
  };
}

/** A command literally named `omp`, so the run path consults the cache. */
let ompCommand: string;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "omp-run-capabilities-"));
  const dir = path.join(tmpRoot, "bin");
  await mkdir(dir, { recursive: true });
  ompCommand = path.join(dir, "omp");
  await writeFile(ompCommand, "#!/bin/sh\n", { mode: 0o755 });
});
afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});
beforeEach(() => {
  vi.stubEnv("PAPERCLIP_HOME", path.join(tmpRoot, "home"));
});
afterEach(() => vi.unstubAllEnvs());

function ctx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null },
    runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: "t" },
    config,
    context: {},
    onLog: async () => {},
    onEvent: async () => {},
  } as AdapterExecutionContext;
}

describe("run-path capability diagnostics", () => {
  it("names the feature the build cannot serve and still plans the run", async () => {
    capabilityMocks.snapshot.value = capabilitySet(["rpc.get_session_stats"]);
    const events: Array<{ level?: string; message?: string }> = [];
    const planned = await buildRunPlan(
      { ...ctx({ command: ompCommand }), onEvent: async (event) => {
        events.push(event as { level?: string; message?: string });
      } },
      { bridge: bridgePath, moduleDir },
    );
    expect(planned.kind).toBe("ready");
    const usage = events.filter((event) => /get_session_stats/.test(event.message ?? ""));
    expect(usage).toHaveLength(1);
    expect(usage[0].level).toBe("warn");
    expect(usage[0].message).toContain("usage receipt");
  });

  it("stays silent when the build has every surface the run needs", async () => {
    capabilityMocks.snapshot.value = capabilitySet([]);
    const events: Array<{ level?: string; message?: string }> = [];
    await buildRunPlan(
      { ...ctx({ command: ompCommand }), onEvent: async (event) => {
        events.push(event as { level?: string; message?: string });
      } },
      { bridge: bridgePath, moduleDir },
    );
    expect(events.some((event) => /capability|get_session_stats/i.test(event.message ?? ""))).toBe(false);
  });

  it("never refuses or crashes the run when the capability read itself fails", async () => {
    // A capability read is advisory: an unreadable cache or an invalid instance
    // id must not turn into a failed heartbeat.
    capabilityMocks.snapshot.value = null;
    const actual = await import("../capabilities.js");
    const spy = vi.spyOn(actual, "loadCapabilities").mockRejectedValueOnce(new Error("instance root unavailable"));
    const events: Array<{ level?: string; message?: string }> = [];
    const planned = await buildRunPlan(
      { ...ctx({ command: ompCommand }), onEvent: async (event) => {
        events.push(event as { level?: string; message?: string });
      } },
      { bridge: bridgePath, moduleDir },
    );
    expect(planned.kind).toBe("ready");
    expect(spy).toHaveBeenCalled();
    expect(events.some((event) => /capability/i.test(event.message ?? ""))).toBe(false);
  });

  it("reports nothing when the cache is cold (the run never probes)", async () => {
    capabilityMocks.snapshot.value = null;
    const events: Array<{ level?: string; message?: string }> = [];
    const planned = await buildRunPlan(
      { ...ctx({ command: ompCommand }), onEvent: async (event) => {
        events.push(event as { level?: string; message?: string });
      } },
      { bridge: bridgePath, moduleDir },
    );
    expect(planned.kind).toBe("ready");
    expect(events.some((event) => /capability|get_session_stats/i.test(event.message ?? ""))).toBe(false);
  });
});
