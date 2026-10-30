import type { UsageSummary } from "@paperclipai/adapter-utils";
import type { OmpPricingStatus } from "./models.js";

/**
 * The installed adapter-utils result type predates the accounting fields, so
 * the adapter declares the subset it emits here (see the skew note in
 * ./index.ts). Paperclip's run-completion whitelist-copies these names into the
 * run's usage receipt; an unknown name would be dropped, and `usageByModel`
 * whose sums do not match the run totals is discarded by the ledger.
 */
export interface RunCostFields {
  /** Billed cost when omp's pricing status itself fixes the amount at zero. */
  costUsd?: number;
  costStatus?: "reported" | "estimated" | "unpriced";
  pricingProvenance?: {
    source: "rate_card" | "operator" | "unknown";
    evidence?: string;
  };
  usageByModel?: Array<{ model: string; usage: UsageSummary; costUsd: number }>;
}

export interface RunCostAttribution {
  fields: RunCostFields;
  /** Operator-facing notes for the run's event stream; never carry tokens or ids. */
  warnings: string[];
}

/**
 * Turn omp's pricing status plus the settled usage into Paperclip's accounting
 * fields. `unknown` must never look free: a zero cost with an absent rate card
 * is unpriced, while a declared-free or subscription-included card is a real
 * zero. A run whose model the catalog did not price is left alone so the
 * server's own default applies — the adapter only speaks about models it
 * inspected.
 *
 * `usageByModel` is one receipt for the whole run, so it is emitted only when
 * one model can be named: a configured fallback chain means omp may have
 * switched models mid-run, and omp reports no served-model signal over ACP.
 */
export function attributeRunCost(input: {
  pricingStatus: OmpPricingStatus | null;
  costUsd?: number | null;
  usage?: UsageSummary | null;
  /** `session_cumulative` totals cannot back a run-scoped receipt. */
  usageBasis?: "per_run" | "session_cumulative" | null;
  model?: string | null;
  failoverConfigured: boolean;
}): RunCostAttribution {
  const fields: RunCostFields = {};
  const warnings: string[] = [];
  const { pricingStatus } = input;
  let costUsd = input.costUsd ?? null;

  if (pricingStatus === "unknown") {
    fields.costStatus = "unpriced";
    fields.pricingProvenance = { source: "unknown", evidence: "omp models pricingStatus=unknown" };
  } else if (pricingStatus === "included") {
    // Covered by a subscription: the billed amount is zero, and the operator's
    // billingType is the authority on how that subscription is paid for.
    costUsd ??= 0;
    fields.costUsd = costUsd;
    fields.costStatus = "reported";
    fields.pricingProvenance = { source: "operator", evidence: "omp models pricingStatus=included" };
  } else if (pricingStatus === "free") {
    // Declared zero card. omp suppresses a zero `cost` in usage_update, so the
    // absence of a cost is the expected shape here, not a pricing gap.
    costUsd ??= 0;
    fields.costUsd = costUsd;
    fields.costStatus = "estimated";
    fields.pricingProvenance = { source: "rate_card", evidence: "omp models pricingStatus=free" };
  } else if (pricingStatus === "fixed" || pricingStatus === "variable") {
    if (costUsd != null) {
      fields.costStatus = "estimated";
      fields.pricingProvenance = {
        source: "rate_card",
        evidence: `omp models pricingStatus=${pricingStatus}`,
      };
    }
  }

  const model = typeof input.model === "string" && input.model.length > 0 ? input.model : null;
  if (input.usage != null && costUsd != null && model !== null
    && fields.costStatus !== "unpriced" && !input.failoverConfigured
    && input.usageBasis !== "session_cumulative") {
    fields.usageByModel = [{ model, usage: input.usage, costUsd }];
  } else if (input.failoverConfigured && input.usage != null && costUsd != null) {
    warnings.push(
      "omp reported one aggregate usage for this run; a model fallback chain is configured, so the served model cannot be attributed and no per-model receipt was emitted",
    );
  }
  return { fields, warnings };
}
