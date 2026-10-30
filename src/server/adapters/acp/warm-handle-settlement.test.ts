import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type * as ModelsModule from "../../models.js";
import { decideReuse } from "@paperclipai/adapter-utils/acpx-engine/settlement-sequence";
import { createOmpAcpExecutor } from "../../acp.js";
import { buildOmpAcpConfig } from "./launch.js";

/**
 * The engine's settlement gate is what keeps a run-scoped credential out of a
 * warm handle. This suite drives the REAL engine (no `vi.mock` of
 * `acpx-engine/execute`) through the adapter's own executor, with an injected
 * runtime so no agent process is spawned, and asserts the decision the engine
 * makes:
 *
 *   host-lane candidate + live run-scoped credential ⇒
 *     { kind: "discard", reason: "run-scoped credential still valid" }
 *
 * and that the run therefore never reuses a child — the runtime is created
 * again and `ensureSession` is called again on the next run. `decideReuse` is
 * the engine's own exported decision; the run-time half is the settlement
 * disposition (`acp_runtime` finalized, never transferred) plus the empty warm
 * store.
 */

vi.mock("../../models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ModelsModule>();
  // The catalog is a side-channel spawn (`omp models ls`); this suite runs
  // with no omp binary and asserts nothing about it.
  return { ...actual, listOmpModels: vi.fn(async () => []) };
});

const ISSUE_ID = "0b8f0d5e-9a10-4f6a-8f2b-1c2d3e4f5a6b";

/** The credential marker the engine puts on a host-lane reuse candidate. */
const LIVE_RUN_SCOPED_API_KEY = "paperclip-run-scoped-api-key";

interface RuntimeCalls {
  created: number;
  ensureSession: number;
  closed: number;
}

/**
 * The minimum `AcpRuntime` the engine calls: establish a session, run one turn,
 * apply config options, close. No process, no network.
 */
function fakeRuntime(calls: RuntimeCalls) {
  return {
    ensureSession: async () => {
      calls.ensureSession += 1;
      return {
        backendSessionId: `backend-${calls.ensureSession}`,
        agentSessionId: `agent-${calls.ensureSession}`,
        runtimeSessionName: `runtime-${calls.ensureSession}`,
      };
    },
    startTurn: () => ({
      events: (async function* () {
        yield { type: "done", stopReason: "end_turn" };
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    }),
    setConfigOption: async () => {},
    close: async () => {
      calls.closed += 1;
    },
  };
}

function baseCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null },
    runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: "t" },
    config: { executionMode: "engine", warmHandleIdleMs: 300_000 },
    context: { taskId: ISSUE_ID },
    authToken: "run-jwt-SENTINEL",
    onLog: async () => {},
    onEvent: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

describe("warm-handle settlement under run identity", () => {
  let tmpRoot: string;
  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "omp-warm-settlement-"));
  });
  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_HOME", tmpRoot);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-v014");
  });

  it("a warm engine-mode run discards the handle: run-scoped credential still valid", async () => {
    const calls: RuntimeCalls = { created: 0, ensureSession: 0, closed: 0 };
    const dispositions: Array<{ records: ReadonlyArray<{ id: string; disposition: string }> }> = [];
    // The engine's own warm store, injected so this test can see it empty.
    const warmHandles = new Map();
    const run = createOmpAcpExecutor({
      createRuntime: () => {
        calls.created += 1;
        return fakeRuntime(calls);
      },
      warmHandles,
      onSettlementDisposition: (report) => dispositions.push(report),
    });

    const first = await run(baseCtx());
    expect(first.exitCode).toBe(0);
    // The operator's window reaches the engine (the adapter no longer
    // overwrites it); the settlement gate is what prevents the reuse.
    expect(buildOmpAcpConfig({ warmHandleIdleMs: 300_000 }).warmHandleIdleMs).toBe(300_000);
    expect(buildOmpAcpConfig({ acpWarmHandleIdleMs: "120000" }).warmHandleIdleMs).toBe(120_000);
    expect(buildOmpAcpConfig({}).warmHandleIdleMs).toBe(0);
    // The gate's decision, as the engine computes it for the host-lane
    // candidate it builds: a live run-scoped credential blocks the save.
    expect(decideReuse({
      kind: "host",
      causePermitsSave: true,
      liveRunScopedCredentials: [LIVE_RUN_SCOPED_API_KEY],
    })).toEqual({ kind: "discard", reason: "run-scoped credential still valid" });
    // ...and the run itself shows the discard: the runtime was closed at
    // settlement (finalized, never transferred) and nothing stayed warm.
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0].records).toContainEqual({ id: "acp_runtime", disposition: "finalized" });
    expect(warmHandles.size).toBe(0);
    expect(calls.closed).toBe(1);

    // The next run of the same session builds a NEW child: no borrowed handle.
    const second = await run(baseCtx({
      runtime: {
        sessionId: first.sessionParams?.acpSessionId ?? null,
        sessionParams: first.sessionParams ?? {},
        sessionDisplayId: null,
        taskKey: "t",
      },
    }));
    expect(second.exitCode).toBe(0);
    expect(calls.created).toBe(2);
    expect(calls.ensureSession).toBe(2);
    expect(warmHandles.size).toBe(0);
    expect(JSON.stringify([first, second])).not.toContain("SENTINEL");
  }, 60_000);
});
