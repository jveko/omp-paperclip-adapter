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
  });
});
