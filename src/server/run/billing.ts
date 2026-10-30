import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { AcpxEngineBillingIdentity } from "../adapters/acp/engine.js";

/**
 * The billing identity both lanes report. Lives beside the run transports
 * rather than in `acp.ts` so the managed lane does not import the engine lane
 * (and so `acp.ts` stays the public re-export surface).
 */
export function resolveOmpBillingIdentity(
  ctx: Pick<AdapterExecutionContext, "config">,
): AcpxEngineBillingIdentity {
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
