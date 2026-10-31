import type { AdapterBillingType, AdapterExecutionContext } from "@paperclipai/adapter-utils";

/** The billing identity the run result reports. */
export interface OmpBillingIdentity {
  provider?: string | null;
  biller?: string | null;
  billingType?: AdapterBillingType | null;
}

/**
 * The billing identity the run reports. Lives beside the transport rather than
 * in `acp.ts`, which stays the public re-export surface.
 */
export function resolveOmpBillingIdentity(
  ctx: Pick<AdapterExecutionContext, "config">,
): OmpBillingIdentity {
  const env = (ctx.config.env ?? {}) as Record<string, unknown>;
  const raw = String(env.OMP_PAPERCLIP_BILLING_TYPE ?? process.env.OMP_PAPERCLIP_BILLING_TYPE ?? "")
    .trim()
    .toLowerCase();
  return {
    provider: "oh-my-pi",
    biller: null,
    billingType: raw === "api" ? "api" : raw === "subscription" ? "subscription" : "api",
  };
}
