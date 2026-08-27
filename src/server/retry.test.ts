import { describe, expect, it } from "vitest";
import { readRetryConfig, isTerminalRetryable, forceFreshSession, withRetryChain, runWithFreshSessionRetry } from "./retry.js";

describe("readRetryConfig", () => {
  it("returns defaults when no retry config is present", () => {
    expect(readRetryConfig({})).toEqual({ enabled: true, freshRetries: 2 });
  });
  it("reads retryEnabled / retryFreshRetries from config", () => {
    expect(readRetryConfig({ retryEnabled: false, retryFreshRetries: 5 })).toEqual({ enabled: false, freshRetries: 5 });
  });
  it("coerces numeric strings for retryFreshRetries", () => {
    expect(readRetryConfig({ retryFreshRetries: "3" })).toEqual({ enabled: true, freshRetries: 3 });
  });
  it("clamps retryFreshRetries to a non-negative integer", () => {
    expect(readRetryConfig({ retryFreshRetries: -1 }).freshRetries).toBe(0);
    expect(readRetryConfig({ retryFreshRetries: 1.7 }).freshRetries).toBe(1);
  });
});

describe("isTerminalRetryable", () => {
  it("does not retry a successful result (no errorCode)", () => {
    expect(isTerminalRetryable({})).toBe(false);
  });
  it("retries a turn-phase failure that survived native recovery", () => {
    expect(
      isTerminalRetryable({ errorCode: "acpx_turn_failed", errorMeta: { phase: "turn", retryable: true } }),
    ).toBe(true);
  });
  it("does not retry an auth error", () => {
    expect(isTerminalRetryable({ errorCode: "acpx_auth_required" })).toBe(false);
  });
  it("hard exclusions win even when the engine flags retryable", () => {
    expect(isTerminalRetryable({ errorCode: "acpx_auth_required", errorMeta: { retryable: true } })).toBe(false);
  });
  it("does not retry session config / backend-missing errors", () => {
    expect(isTerminalRetryable({ errorCode: "acpx_session_config_failed" })).toBe(false);
    expect(isTerminalRetryable({ errorCode: "acpx_backend_missing" })).toBe(false);
  });
  it("does not retry session-init failures (config/init-level, not turn-phase)", () => {
    expect(isTerminalRetryable({ errorCode: "acpx_session_init_failed" })).toBe(false);
  });
  it("retries protocol / runtime errors (recoverable with a clean context)", () => {
    expect(isTerminalRetryable({ errorCode: "acpx_protocol_error" })).toBe(true);
    expect(isTerminalRetryable({ errorCode: "acpx_runtime_error" })).toBe(true);
  });
  it("retries when the engine explicitly marks retryable=true", () => {
    expect(
      isTerminalRetryable({ errorCode: "acpx_protocol_error", errorMeta: { retryable: true } }),
    ).toBe(true);
  });
  it("retries an unknown code when the engine explicitly marks retryable=true", () => {
    expect(
      isTerminalRetryable({ errorCode: "acpx_unknown_failure", errorMeta: { retryable: true } }),
    ).toBe(true);
  });
  it("does not retry when the engine explicitly marks retryable=false", () => {
    expect(
      isTerminalRetryable({ errorCode: "acpx_runtime_error", errorMeta: { retryable: false } }),
    ).toBe(false);
  });
});

describe("forceFreshSession", () => {
  it("adds a retry-marker env var that busts the session fingerprint", () => {
    const fresh = forceFreshSession({}, 0);
    const env = fresh.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.OMP_PAPERCLIP_RETRY).toBe("0");
  });
  it("preserves existing env while adding the marker", () => {
    const fresh = forceFreshSession({ env: { EXISTING: "keep" } }, 1);
    const env = fresh.env as Record<string, string>;
    expect(env.EXISTING).toBe("keep");
    expect(env.OMP_PAPERCLIP_RETRY).toBe("1");
  });
  it("uses a unique marker per attempt", () => {
    expect((forceFreshSession({}, 2).env as Record<string, string>).OMP_PAPERCLIP_RETRY).toBe("2");
  });
});

describe("withRetryChain", () => {
  it("adds retryChain to resultJson when present", () => {
    const result = withRetryChain(
      { resultJson: { phase: "turn" } },
      [
        { attempt: 0, model: "m1", errorCode: "acpx_turn_failed", fresh: false },
        { attempt: 1, model: "m1", errorCode: null, fresh: true },
      ],
    );
    expect(result.resultJson).toEqual({
      phase: "turn",
      retryChain: [
        { attempt: 0, model: "m1", errorCode: "acpx_turn_failed", fresh: false },
        { attempt: 1, model: "m1", errorCode: null, fresh: true },
      ],
    });
  });
  it("creates resultJson when it was null", () => {
    const result = withRetryChain({ resultJson: null }, [
      { attempt: 0, model: "m1", errorCode: null, fresh: false },
    ]);
    expect(result.resultJson).toEqual({
      retryChain: [{ attempt: 0, model: "m1", errorCode: null, fresh: false }],
    });
  });
  it("returns the result unchanged when retryChain is empty", () => {
    const result = withRetryChain({ resultJson: { a: 1 } }, []);
    expect(result.resultJson).toEqual({ a: 1 });
  });
});

describe("runWithFreshSessionRetry", () => {
  type FakeResult = { errorCode?: string | null; errorMeta?: Record<string, unknown>; model?: string | null; resultJson?: Record<string, unknown> | null };

  it("returns the first result unchanged when it is not retryable", async () => {
    const executor = async () => ({ errorCode: null, model: "m1" } as FakeResult);
    const { result, chain } = await runWithFreshSessionRetry(executor, { enabled: true, freshRetries: 2 }, {});
    expect(result).toEqual({ errorCode: null, model: "m1" });
    expect(chain).toEqual([]);
  });

  it("re-invokes on a terminal failure until success, forcing a fresh session each time", async () => {
    const configs: Array<Record<string, unknown>> = [];
    let calls = 0;
    const executor = async (ctx: { config: Record<string, unknown> }) => {
      configs.push(ctx.config);
      calls += 1;
      if (calls === 1) return { errorCode: "acpx_turn_failed", errorMeta: { phase: "turn", retryable: true } } as FakeResult;
      return { errorCode: null, model: "m2" } as FakeResult;
    };
    const { result, chain } = await runWithFreshSessionRetry(executor, { enabled: true, freshRetries: 2 }, { env: {} });
    expect(result).toEqual({ errorCode: null, model: "m2" });
    expect(chain).toHaveLength(2);
    expect(chain[0]).toEqual({ attempt: 0, model: null, errorCode: "acpx_turn_failed", fresh: false });
    expect(chain[1]).toEqual({ attempt: 1, model: "m2", errorCode: null, fresh: true });
    // First call runs with the ORIGINAL config (no marker); the retry adds the marker.
    expect((configs[0].env as Record<string, string>).OMP_PAPERCLIP_RETRY).toBeUndefined();
    expect((configs[1].env as Record<string, string>).OMP_PAPERCLIP_RETRY).toBe("1");
  });

  it("stops retrying once freshRetries is exhausted and returns the last failure", async () => {
    let calls = 0;
    const executor = async () => {
      calls += 1;
      return { errorCode: "acpx_turn_failed", errorMeta: { retryable: true } } as FakeResult;
    };
    const { result, chain } = await runWithFreshSessionRetry(executor, { enabled: true, freshRetries: 2 }, {});
    expect(calls).toBe(3); // initial + 2 fresh retries
    expect(result.errorCode).toBe("acpx_turn_failed");
    expect(chain).toHaveLength(3);
    expect(chain.every((c) => c.errorCode === "acpx_turn_failed")).toBe(true);
  });

  it("does not retry at all when disabled", async () => {
    let calls = 0;
    const executor = async () => {
      calls += 1;
      return { errorCode: "acpx_turn_failed", errorMeta: { retryable: true } } as FakeResult;
    };
    const { result, chain } = await runWithFreshSessionRetry(executor, { enabled: false, freshRetries: 2 }, {});
    expect(calls).toBe(1);
    expect(chain).toHaveLength(0);
    expect(result.errorCode).toBe("acpx_turn_failed");
  });

  it("does not retry a non-retryable error even with retries available", async () => {
    let calls = 0;
    const executor = async () => {
      calls += 1;
      return { errorCode: "acpx_auth_required" } as FakeResult;
    };
    const { result } = await runWithFreshSessionRetry(executor, { enabled: true, freshRetries: 5 }, {});
    expect(calls).toBe(1);
    expect(result.errorCode).toBe("acpx_auth_required");
  });
});