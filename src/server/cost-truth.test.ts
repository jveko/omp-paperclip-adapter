import { describe, expect, it } from "vitest";
import type { UsageSummary } from "@paperclipai/adapter-utils";
import { attributeRunCost } from "./cost-truth.js";

const usage: UsageSummary = { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 200 };

function attribute(overrides: Partial<Parameters<typeof attributeRunCost>[0]> = {}) {
  return attributeRunCost({
    pricingStatus: "fixed",
    costUsd: 0.25,
    usage,
    model: "prov/m",
    failoverConfigured: false,
    ...overrides,
  });
}

describe("attributeRunCost pricing status", () => {
  it("reports a fixed rate card as an estimate sourced from the card", () => {
    expect(attribute()).toEqual({
      fields: {
        costStatus: "estimated",
        pricingProvenance: { source: "rate_card", evidence: "omp models pricingStatus=fixed" },
        usageByModel: [{ model: "prov/m", usage, costUsd: 0.25 }],
      },
      warnings: [],
    });
  });

  it("treats a variable card as an estimate too", () => {
    expect(attribute({ pricingStatus: "variable" }).fields.costStatus).toBe("estimated");
  });

  it("reports a declared-free card as a zero estimate rather than an unpriced run", () => {
    const out = attribute({ pricingStatus: "free", costUsd: null });
    expect(out.fields).toMatchObject({
      costStatus: "estimated",
      costUsd: 0,
      pricingProvenance: { source: "rate_card", evidence: "omp models pricingStatus=free" },
    });
    expect(out.fields.usageByModel).toEqual([{ model: "prov/m", usage, costUsd: 0 }]);
  });

  it("reports a subscription-included model as an operator-declared zero and leaves billingType alone", () => {
    expect(attribute({ pricingStatus: "included", costUsd: null }).fields).toMatchObject({
      costStatus: "reported",
      costUsd: 0,
      pricingProvenance: { source: "operator", evidence: "omp models pricingStatus=included" },
    });
  });

  it("marks an unknown card unpriced even when a zero cost was reported", () => {
    expect(attribute({ pricingStatus: "unknown", costUsd: 0 }).fields).toMatchObject({
      costStatus: "unpriced",
      pricingProvenance: { source: "unknown", evidence: "omp models pricingStatus=unknown" },
    });
  });

  it("emits no pricing claim for a model the catalog did not price", () => {
    const out = attribute({ pricingStatus: null });
    expect(out.fields).toEqual({ usageByModel: [{ model: "prov/m", usage, costUsd: 0.25 }] });
  });

  it("emits no estimate when a fixed card arrived without a cost to price", () => {
    expect(attribute({ costUsd: null }).fields).toEqual({});
  });
});

describe("attributeRunCost usageByModel", () => {
  it("omits the per-model receipt when a fallback chain could have switched models", () => {
    const out = attribute({ failoverConfigured: true });
    expect(out.fields.usageByModel).toBeUndefined();
    expect(out.warnings).toEqual([expect.stringContaining("cannot be attributed")]);
  });

  it("stays silent when there is nothing to attribute", () => {
    expect(attribute({ failoverConfigured: true, costUsd: null }).warnings).toEqual([]);
  });

  it("omits the receipt for an unpriced run", () => {
    expect(attribute({ pricingStatus: "unknown" }).fields.usageByModel).toBeUndefined();
  });

  it("omits the receipt when the usage totals are session-cumulative, not run-scoped", () => {
    expect(attribute({ usageBasis: "session_cumulative" }).fields.usageByModel).toBeUndefined();
  });

  it("keeps the receipt for a per-run usage basis", () => {
    expect(attribute({ usageBasis: "per_run" }).fields.usageByModel).toHaveLength(1);
  });

  it("omits the receipt when the run's usage is unknown", () => {
    expect(attribute({ usage: undefined }).fields.usageByModel).toBeUndefined();
  });
});
