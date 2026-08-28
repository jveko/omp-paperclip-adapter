import { describe, expect, it } from "vitest";
import { createServerAdapter } from "./index.js";

describe("createServerAdapter", () => {
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

  it("declares session management capability with compaction defaults", () => {
    expect(mod.sessionManagement).toEqual({
      supportsSessionResume: true,
      nativeContextManagement: "none",
      defaultSessionCompaction: {
        enabled: true, maxSessionRuns: 200, maxRawInputTokens: 2_000_000, maxSessionAgeHours: 72,
      },
    });
  });
});
