import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerAdapter } from "./index.js";

const modelsMocks = vi.hoisted(() => ({
  refreshOmpModelCatalog: vi.fn(),
  detectOmpConfiguredModel: vi.fn(),
}));

vi.mock("./models.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    refreshOmpModelCatalog: modelsMocks.refreshOmpModelCatalog,
    detectOmpConfiguredModel: modelsMocks.detectOmpConfiguredModel,
  };
});

/**
 * A fresh adapter: detection caches per module instance, so each case starts
 * clean. The dynamic import is the point — `vi.resetModules()` cannot replace a
 * statically bound import, and the cache must not leak between cases.
 */
async function freshAdapter() {
  vi.resetModules();
  const { createServerAdapter: fresh } = await import("./index.js");
  return fresh();
}

describe("createServerAdapter", () => {
  beforeEach(() => {
    modelsMocks.refreshOmpModelCatalog.mockReset();
    modelsMocks.detectOmpConfiguredModel.mockReset();
  });
  const mod = createServerAdapter();
  it("exposes the ServerAdapterModule contract surface", () => {
    expect(mod.type).toBe("omp_local");
    expect(typeof mod.execute).toBe("function");
    expect(typeof mod.testEnvironment).toBe("function");
    expect(typeof mod.refreshModels).toBe("function");
    expect(typeof mod.detectModel).toBe("function");
    expect(mod.sessionCodec).toBeTruthy();
    // label deliberately NOT on the module: ServerAdapterModule has no label
    // member (types.ts:420+; adapters.ts:202 "type serves as label").
    expect((mod as Record<string, unknown>).label).toBeUndefined();
    expect(typeof mod.agentConfigurationDoc).toBe("string");
    expect(mod.agentConfigurationDoc!.length).toBeGreaterThan(50);
    expect(mod.acp).toBeDefined();
    expect(mod.acp?.agentId).toBe("omp");
    expect(mod.acp?.skillsMode).toBe("ephemeral");
    expect(mod.acp?.prerequisites?.nodeRange).toBe(">=24.11.0");
  });
  it("exposes the session governance config schema", async () => {
    const schema = await mod.getConfigSchema!();
    expect(schema.fields.map((f) => f.key)).toContain("sessionForkToken");
  });

  it("declares the run identity and control-plane capabilities", () => {
    // Without these Paperclip mints no run token (so PAPERCLIP_API_KEY never
    // reaches the child, killing work products and the approval round-trip),
    // delivers connection tools through a channel the adapter cannot serve, and
    // never resolves a managed instructions bundle.
    expect(mod.supportsLocalAgentJwt).toBe(true);
    // Ahead of the installed adapter-utils declaration (see the type comment in
    // ./index.ts); the server reads the member untyped.
    expect(mod.runtimeToolDelivery).toBe("native_mcp");
    expect(mod.supportsInstructionsBundle).toBe(true);
    // The engine renders this key into the run prompt (execute.js:1685-1701),
    // and the ephemeral skills file merges the same path.
    expect(mod.instructionsPathKey).toBe("instructionsFilePath");
  });

  it("declares session management capability with compaction defaults", () => {
    expect(mod.sessionManagement).toEqual({
      supportsSessionResume: true,
      nativeContextManagement: "none",
      defaultSessionCompaction: {
        enabled: true, maxSessionRuns: 200, maxRawInputTokens: 2_000_000, maxSessionAgeHours: 72,
      },
    });
  });

  it("returns rate cards and context windows from a refresh so the board can price models", async () => {
    modelsMocks.refreshOmpModelCatalog.mockResolvedValue([{
      id: "prov/m", label: "M", contextWindow: 200_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      pricingStatus: "fixed",
    }]);
    const refreshed = await mod.refreshModels!();
    expect(refreshed).toEqual([{
      id: "prov/m", label: "M", contextWindow: 200_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    }]);
  });

  it("detects the configured model in the same provider/id shape the catalog uses", async () => {
    modelsMocks.detectOmpConfiguredModel.mockResolvedValue({
      model: "prov/m", provider: "prov", source: "config:modelRoles.default",
    });
    const detected = await (await freshAdapter()).detectModel!();
    expect(detected).toEqual({
      model: "prov/m", provider: "prov", source: "config:modelRoles.default",
    });
  });

  it("caches detection so repeated board polls do not re-probe", async () => {
    modelsMocks.detectOmpConfiguredModel.mockResolvedValue({
      model: "prov/m", provider: "prov", source: "config:modelRoles.default",
    });
    const adapter = await freshAdapter();
    await adapter.detectModel!();
    await adapter.detectModel!();
    expect(modelsMocks.detectOmpConfiguredModel).toHaveBeenCalledTimes(1);
  });

  it("returns null detection unchanged", async () => {
    modelsMocks.detectOmpConfiguredModel.mockResolvedValue(null);
    expect(await (await freshAdapter()).detectModel!()).toBeNull();
  });
});
