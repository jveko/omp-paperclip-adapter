import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

/**
 * `execute.ts` builds its executor once at module load, so the mocked factory
 * hands back a stable function that delegates to whatever implementation the
 * current test installs.
 */
const acpMock = vi.hoisted(() => {
  const state: { impl: ((ctx: unknown) => Promise<unknown>) | null } = { impl: null };
  const executorImpl = (ctx: unknown): Promise<unknown> => {
    if (!state.impl) throw new Error("acp executor impl not configured");
    return state.impl(ctx);
  };
  return { state, executorImpl };
});

vi.mock("./acp.js", () => ({ createOmpAcpExecutor: () => acpMock.executorImpl }));

const OK_RESULT: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false };

function ctxForSession(sessionKey: string): AdapterExecutionContext {
  return {
    runId: `run-${sessionKey}`,
    agent: {
      id: "agent-lease",
      companyId: "company-lease",
      name: "Lease Agent",
      adapterType: "omp_local",
      adapterConfig: null,
    },
    runtime: {
      sessionId: null,
      sessionParams: { sessionKey },
      sessionDisplayId: null,
      taskKey: "task-lease",
    },
    config: {},
    context: {},
    onLog: async () => {},
    onEvent: async () => {},
  } as AdapterExecutionContext;
}

describe("execute session lease", () => {
  let home: string;

  beforeEach(async () => {
    acpMock.state.impl = null;
    home = await mkdtemp(path.join(os.tmpdir(), "omp-execute-lease-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-lease");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("refuses a second run of the same session while the first holds the lease", async () => {
    const gate = Promise.withResolvers<AdapterExecutionResult>();
    const started = Promise.withResolvers<void>();
    const secondReachedExecutor = Promise.withResolvers<"executor-reached">();

    let calls = 0;
    const executor = vi.fn(async () => {
      calls += 1;
      if (calls > 1) secondReachedExecutor.resolve("executor-reached");
      else started.resolve();
      return gate.promise;
    });
    acpMock.state.impl = executor;

    const first = execute(ctxForSession("session-shared"));
    await started.promise;

    const second = execute(ctxForSession("session-shared"));
    const outcome = await Promise.race([
      second.then((result) => ({ kind: "result" as const, result })),
      secondReachedExecutor.promise.then(() => ({ kind: "executor" as const })),
    ]);

    try {
      expect(outcome.kind).toBe("result");
      if (outcome.kind !== "result") {
        throw new Error("the second run reached the executor while the first held the session lease");
      }
      expect(outcome.result.exitCode).toBe(1);
      expect(outcome.result.errorCode).toBe("omp_session_lease_held");
      expect(outcome.result.errorMessage ?? "").toMatch(/session/i);
      expect(executor).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve(OK_RESULT);
    }

    const firstResult = await first;
    expect(firstResult.exitCode).toBe(0);
  });

  it("releases the lease after a run settles so the next run can start", async () => {
    const executor = vi.fn(async () => OK_RESULT);
    acpMock.state.impl = executor;

    const first = await execute(ctxForSession("session-serial"));
    expect(first.exitCode).toBe(0);

    const second = await execute(ctxForSession("session-serial"));
    expect(second.exitCode).toBe(0);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("releases the lease when the executor throws", async () => {
    const executor = vi.fn()
      .mockRejectedValueOnce(new Error("engine exploded"))
      .mockResolvedValueOnce(OK_RESULT);
    acpMock.state.impl = executor;

    await expect(execute(ctxForSession("session-throws"))).rejects.toThrow(/engine exploded/);

    const next = await execute(ctxForSession("session-throws"));
    expect(next.exitCode).toBe(0);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("lets concurrent runs with different session keys both reach the executor", async () => {
    const executor = vi.fn(async () => OK_RESULT);
    acpMock.state.impl = executor;

    const [first, second] = await Promise.all([
      execute(ctxForSession("session-a")),
      execute(ctxForSession("session-b")),
    ]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(executor).toHaveBeenCalledTimes(2);
  });
});
