import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "./acp.js";
import { materializeFailoverOverlay } from "./failover-config.js";

// Force the overlay write-failure branch and assert the executor warns via onEvent
// and still runs (regression guard for the spec §4 "warn, don't fail" contract).
const engineMocks = vi.hoisted(() => ({ createAcpxEngineExecutor: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/acpx-engine/execute", () => ({
  createAcpxEngineExecutor: engineMocks.createAcpxEngineExecutor,
}));
vi.mock("./failover-config.js", () => ({
  FAILOVER_CONFIG_FILE: "omp-failover-config.yml",
  materializeFailoverOverlay: vi.fn(),
}));

function ctxWith(onEvent: (e: unknown) => Promise<void>): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null },
    runtime: { sessionId: "old", sessionParams: { acpSessionId: "old", sessionKey: "sk", cwd: process.cwd(), configFingerprint: "f" }, sessionDisplayId: "old", taskKey: "t" },
    config: { command: "omp", fallbackChain: "openrouter/glm" },
    context: {},
    onLog: async () => {},
    onEvent,
  } as unknown as AdapterExecutionContext;
}

describe("failover overlay write-failure degradation", () => {
  beforeEach(() => {
    engineMocks.createAcpxEngineExecutor.mockReset();
    engineMocks.createAcpxEngineExecutor.mockReturnValue(vi.fn(async () => ({ exitCode: 0, sessionParams: { acpSessionId: "s", sessionKey: "sk" } })));
    vi.mocked(materializeFailoverOverlay).mockReset();
  });

  it("warns via onEvent and still runs when the overlay write fails", async () => {
    vi.mocked(materializeFailoverOverlay).mockResolvedValue({ status: "error", error: "EACCES: permission denied" });
    const events: Array<{ level?: string; message?: string }> = [];
    await createOmpAcpExecutor()(ctxWith(async (e) => { events.push(e as { level?: string; message?: string }); }));
    const warn = events.find((e) => e.level === "warn" && /failover overlay write failed/.test(e.message ?? ""));
    expect(warn).toBeTruthy();
    expect(warn?.message).toContain("EACCES");
  });

  it("does not warn when no chain is configured (status none)", async () => {
    vi.mocked(materializeFailoverOverlay).mockResolvedValue({ status: "none" });
    const events: Array<{ level?: string; message?: string }> = [];
    await createOmpAcpExecutor()(ctxWith(async (e) => { events.push(e as { level?: string; message?: string }); }));
    expect(events.find((e) => /failover overlay write failed/.test(e.message ?? ""))).toBeUndefined();
  });
});
