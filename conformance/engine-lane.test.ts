import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { sessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";
import { createOmpAcpExecutor } from "../src/server/acp.js";
import { execute as executeRun } from "../src/server/execute.js";
import { sessionIntelDir } from "../src/server/session-state.js";
import { capabilityChecks, clearCapabilityCache, loadCapabilities } from "../src/server/capabilities.js";
import { parseOmpVersion } from "../src/server/adapters/acp/launch.js";
import { checkGolden, normalizeGolden, runReplacements } from "./golden.js";
import { PROFILES, materializeProfile, type ConformanceProfile } from "./profiles.js";

/**
 * The engine-lane golden run: the REAL acpx engine spawns a scripted omp build
 * (one process per profile), drives a full ACP turn, and the adapter's own
 * executor books the result. No Paperclip instance, no network, no engine mock.
 *
 * Asserted per profile:
 * - the frames the adapter must never send (no `effort` config key),
 * - the usage/cost fields the result carries (estimated from the catalogue card,
 *   a per-model receipt, and no claim for an unpriced model),
 * - session reuse through the engine codec (cold `session/new`, then a resume
 *   with the stored session id),
 * - the capability diagnostics the build's missing surfaces produce.
 */


let root: string;
const runs: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "omp-conformance-"));
  process.env.PAPERCLIP_HOME = root;
  process.env.PAPERCLIP_INSTANCE_ID = "conformance";
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.PAPERCLIP_HOME;
  delete process.env.PAPERCLIP_INSTANCE_ID;
});

function ctx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null },
    runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: "task" },
    config: {},
    // No Paperclip instance: no work-product issue, no run token, so the run
    // never attempts a network post. The harness is about execution, not the
    // board's ingestion (covered by the unit suite with a fake MCP/HTTP server).
    context: {},
    onLog: async () => {},
    onEvent: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

interface ProfileRun {
  result: AdapterExecutionResult;
  frames: Array<{ method: string; params: Record<string, unknown> }>;
  events: BoardEvent[];
}

interface BoardEvent {
  eventType: string;
  level?: string;
  message?: string;
}

/**
 * One cold run plus one warm run of the same build. The warm run reuses the
 * cold run's `sessionParams`, which is exactly what the supervisor persists
 * between heartbeats.
 */
async function runProfile(profile: ConformanceProfile): Promise<{
  cold: ProfileRun;
  warm: ProfileRun;
  diagnostics: string[];
}> {
  const dir = path.join(root, profile.name);
  const build = await materializeProfile(path.join(dir, "bin"), profile);
  const frameLog = path.join(dir, "frames.log");
  await mkdir(dir, { recursive: true });

  // The fixture's frame log rides the agent env, which is exactly the env the
  // engine hands the spawned build (the harness must not depend on the test
  // process's own environment reaching the child).
  const config = { command: build.script, model: "prov/model-a", env: { FAKE_ACP_FRAME_LOG: frameLog } };
  const run = createOmpAcpExecutor();
  const coldEvents: BoardEvent[] = [];
  const cold = await run(ctx({
    config,
    onEvent: async (event) => { coldEvents.push(event); },
  }));
  const coldFrames = await readFrameLog(frameLog);

  const warmEvents: BoardEvent[] = [];
  const warm = await run(ctx({
    config,
    runtime: {
      sessionId: typeof cold.sessionParams?.acpSessionId === "string" ? cold.sessionParams.acpSessionId : null,
      sessionParams: cold.sessionParams ?? {},
      sessionDisplayId: null,
      taskKey: "task",
    },
    onEvent: async (event) => { warmEvents.push(event); },
  }));
  const warmFrames = (await readFrameLog(frameLog)).slice(coldFrames.length);

  // The capability probe is cached per (command, env); this profile's own build
  // is a distinct command, so each profile gets its own probe.
  clearCapabilityCache();
  const capabilities = await loadCapabilities({
    acp: { command: build.script, args: ["acp"] },
    mode: "engine",
    cacheDir: path.join(dir, "capabilities"),
  });
  const diagnostics = capabilityChecks(capabilities).map((check) => check.code ?? "");

  return {
    cold: { result: cold, frames: coldFrames, events: coldEvents },
    warm: { result: warm, frames: warmFrames, events: warmEvents },
    diagnostics,
  };
}

async function readFrameLog(file: string): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  let raw = "";
  try { raw = await readFile(file, "utf8"); } catch { return []; }
  return raw.split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return {
      method: tab < 0 ? line : line.slice(0, tab),
      params: tab < 0 ? {} : JSON.parse(line.slice(tab + 1)) as Record<string, unknown>,
    };
  });
}

/**
 * The ACP methods each run issued, in order. `_omp/*` reads belong to the
 * side-channel suite, and a config option is recorded by key so a renamed or
 * spurious key (`effort`) shows up as a golden diff.
 */
function frameMethods(frames: ProfileRun["frames"]): string[] {
  return frames
    .filter((frame) => !frame.method.startsWith("_omp/"))
    .map((frame) => frame.method === "session/set_config_option"
      ? `session/set_config_option:${String(frame.params.configId ?? frame.params.key ?? "?")}`
      : frame.method);
}

/** The facts a golden records for one profile, across its cold and warm runs. */
function profileFacts(input: {
  profile: string;
  cold: ProfileRun;
  warm: ProfileRun;
  diagnostics: string[];
}): Record<string, unknown> {
  const stored = sessionCodec.deserialize(input.cold.result.sessionParams) ?? {};
  return {
    profile: input.profile,
    coldFrames: frameMethods(input.cold.frames),
    warmFrames: frameMethods(input.warm.frames),
    usage: input.cold.result.usage ?? null,
    usageBasis: input.cold.result.usageBasis ?? null,
    usageComplete: input.cold.result.usageComplete ?? null,
    cost: {
      usd: input.cold.result.costUsd ?? null,
      status: input.cold.result.costStatus ?? null,
      source: input.cold.result.pricingProvenance?.source ?? null,
    },
    usageByModel: input.cold.result.usageByModel ?? [],
    sessionKeys: Object.keys(stored).sort(),
    capabilities: input.diagnostics,
    events: boardEvents([...input.cold.events, ...input.warm.events]),
  };
}

describe("engine-lane conformance", () => {
  it.each(["18.13", "18.14"] as const)(
    "profile %s: a full turn, reuse and cost truth",
    async (name) => {
      const profile = PROFILES[name];
      const { cold, warm, diagnostics } = await runProfile(profile);

      expect(cold.result.exitCode).toBe(0);
      expect(warm.result.exitCode).toBe(0);

      // Frames: one `session/new` on the cold run, a resume on the warm one.
      expect(frameMethods(cold.frames).filter((method) => method === "session/new")).toHaveLength(1);
      expect(frameMethods(warm.frames)).not.toContain("session/new");
      expect(frameMethods(warm.frames).some((method) => method === "session/load" || method === "session/resume"))
        .toBe(true);
      // The adapter strips the engine's `effort` keys; omp accepts only
      // mode|model|thinking, and an unknown key fails a run on a real build.
      expect(cold.frames.some((frame) => JSON.stringify(frame.params).includes("\"effort\""))).toBe(false);

      // Usage and cost: the catalogue card prices the model, so the result
      // carries an estimate, a rate-card provenance and one receipt.
      expect(cold.result.usage).toEqual({ inputTokens: 1050, outputTokens: 200, cachedInputTokens: 300 });
      expect(cold.result.usageBasis).toBe("per_run");
      expect(cold.result.usageComplete).toBe(true);
      expect(cold.result.costUsd).toBe(0.25);
      expect(cold.result.costStatus).toBe("estimated");
      expect(cold.result.pricingProvenance).toMatchObject({ source: "rate_card" });
      expect(cold.result.usageByModel).toEqual([{
        model: "prov/model-a",
        usage: { inputTokens: 1050, outputTokens: 200, cachedInputTokens: 300 },
        costUsd: 0.25,
      }]);

      // Session reuse: the codec round-trips the engine's own evidence.
      const stored = sessionCodec.deserialize(cold.result.sessionParams);
      expect(stored).toMatchObject({
        sessionKey: expect.stringContaining("paperclip:co-1:agent-1:task"),
        acpSessionId: "s1",
        configFingerprint: expect.any(String),
        mcpFingerprint: expect.any(String),
      });
      expect(warm.result.sessionParams?.acpSessionId).toBe("s1");

      // The build has every surface, so the only notes are the CLI ones this
      // profile's own help omits — none for a 18.13/18.14 profile.
      expect(diagnostics).toEqual(profile.expectedDiagnostics);
      expect(capabilityChecks(await loadCapabilities({
        acp: { command: path.join(root, profile.name, "bin", profile.commandName), args: ["acp"] },
        mode: "engine",
        cacheDir: path.join(root, profile.name, "capabilities"),
      })).some((check) => check.level === "error")).toBe(false);

      runs.push(profileFacts({ profile: name, cold, warm, diagnostics }));
    },
    60_000,
  );

  it("drift profile: the run completes, the surfaces degrade by name, no cost claim", async () => {
    const profile = PROFILES.drift;
    const { cold, warm, diagnostics } = await runProfile(profile);
    expect(cold.result.exitCode).toBe(0);
    expect(warm.result.exitCode).toBe(0);
    // A build without `thinking` still runs: the level rides the overlay only.
    expect(cold.result.usage).toBeDefined();
    // `usage_update.cost` is gone on this build, so no estimate is claimed.
    expect(cold.result.costUsd).toBeNull();
    for (const code of profile.expectedDiagnostics) {
      expect(diagnostics).toContain(code);
    }
    expect(capabilityChecks(await loadCapabilities({
      acp: { command: path.join(root, "drift", "bin", "omp"), args: ["acp"] },
      mode: "engine",
      cacheDir: path.join(root, "drift", "capabilities"),
    })).some((check) => check.level === "error")).toBe(false);
    runs.push(profileFacts({ profile: profile.name, cold, warm, diagnostics }));
  }, 60_000);

  it("wrapper profile: a command not named omp is unverified, never failed", async () => {
    const profile = PROFILES.wrapper;
    const { cold } = await runProfile(profile);
    expect(cold.result.exitCode).toBe(0);
    // The wrapper's own help is not omp's, so no surface claim is made about it.
    const version = parseOmpVersion(`${profile.commandName}/${profile.version}`);
    expect(version).toEqual({ major: 18, minor: 15, patch: 0 });
    runs.push(profileFacts({ profile: profile.name, cold, warm: { ...cold, frames: [], events: [] }, diagnostics: [] }));
  }, 60_000);

  it("holds one writer per session: a concurrent run is refused, the next is accepted", async () => {
    const profile = PROFILES["18.14"];
    const dir = path.join(root, "lease");
    const build = await materializeProfile(path.join(dir, "bin"), profile);
    const config = { command: build.script, model: "prov/model-a" };
    const leaseCtx = ctx({ config });

    // Both calls are in flight together: the second must lose the file lease,
    // not queue behind the first (a queued heartbeat reports late, which is
    // the failure the lease exists to avoid). Wait for the first claim to land
    // first — otherwise the two claims race and either could win, which tests
    // the primitive rather than the refusal.
    const first = executeRun(leaseCtx);
    const leases = path.join(sessionIntelDir("co-1", "agent-1"), "leases");
    await vi.waitFor(async () => {
      const held = await readdir(leases).catch(() => [] as string[]);
      expect(held.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    }, { timeout: 5_000, interval: 10 });
    const second = await executeRun({ ...leaseCtx, runId: "run-2" });
    expect(second.errorCode).toBe("omp_session_lease_held");
    expect(await first).toMatchObject({ exitCode: 0 });

    // The lease is released after the run, so the next heartbeat is accepted.
    const third = await executeRun({ ...leaseCtx, runId: "run-3" });
    expect(third).toMatchObject({ exitCode: 0 });

    runs.push(normalizeGolden({
      lane: "lease",
      contended: second.errorCode,
      afterRelease: third.exitCode,
    }, runReplacements()));
  }, 90_000);

  it("matches the recorded golden", async () => {
    await checkGolden("engine-lane", normalizeGolden(runs, runReplacements()));
  });
});

/**
 * The board-facing slice of the event stream: what the adapter emits itself
 * (`run.system`, `acpx.*`, `omp.subagent`). The engine's phase/startup timings
 * are per-run measurements and stay out of the golden.
 */
function boardEvents(events: ReadonlyArray<BoardEvent>): string[] {
  return events
    .filter((event) => event.eventType === "run.system"
      || event.eventType.startsWith("acpx.")
      || event.eventType === "omp.subagent")
    .map((event) => {
      const message = event.message === undefined ? "" : ` "${event.message.slice(0, 90)}"`;
      return `${event.eventType}:${event.level ?? "info"}${message}`;
    });
}
