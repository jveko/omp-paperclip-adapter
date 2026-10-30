import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFallbackChain } from "./failover-config.js";
import { parseGovernancePolicy } from "./governance-manifest.js";
import type { OmpModelInfo } from "./models.js";

/**
 * Endpoint routing overlay (v0.8 T4).
 *
 * `governancePolicy.approvedEndpoints` is an allow-list of provider ids; the
 * run's omp child gets the COMPLIMENT as omp's declarative `disabledProviders`
 * settings key, which is the only lever that actually removes a built-in
 * provider from availability (`modelRegistry.unregisterProvider` restores static
 * models, so re-registering approved ones is handled by `providers:` in the
 * operator overlay instead).
 *
 * WHY A SEPARATE FILE AND NOT THE FAILOVER OVERLAY
 * `disabledProviders` in ANY `PI_CONFIG_FILES` file filters `omp models ls`.
 * The failover overlay is read by the side channels too (the adapter's own
 * catalog probe runs under `ompEnv({ overlayPath: failover })`), so routing keys
 * living there would shrink the very `knownProviders` set the complement is
 * computed from — re-enable on the next run, oscillating forever, plus a
 * chicken-and-egg (computing the complement needs a catalog read that would
 * already be filtered by the file). This file is therefore folded ONLY into the
 * run child's `PI_CONFIG_FILES`; `omp-env.ts` must never be handed its path.
 */

/** Fixed overlay filename (overwritten in place per run, like the failover one). */
export const GOVERNANCE_CONFIG_FILE = "omp-governance-config.yml";

/** `provider/id` -> `provider`; "" when the selector carries no provider half. */
export function providerFacet(selector: string): string {
  const slash = selector.indexOf("/");
  return slash > 0 ? selector.slice(0, slash) : "";
}

/** The model id half of `provider/id` (the whole string when providerless). */
function modelHalf(id: string): string {
  const facet = providerFacet(id);
  return facet ? id.slice(facet.length + 1) : id;
}

/** Provider ids the catalog reports, deduped and sorted (deterministic YAML). */
function catalogProviders(models: readonly OmpModelInfo[]): string[] {
  const set = new Set<string>();
  for (const m of models) {
    const facet = providerFacet(m.id);
    if (facet) set.add(facet);
  }
  return [...set].sort();
}

/**
 * Which provider(s) a selector could resolve to. Mirrors omp's fuzzy model
 * matching (exact id, then bare-id prefix) rather than inventing a fourth rule:
 * an operator may write `gpt-4o` where the catalog says `openai-compat/gpt-4o`,
 * and that provider must survive the complement.
 */
function providersForSelector(models: readonly OmpModelInfo[], selector: string): string[] {
  const facet = providerFacet(selector);
  if (facet) return [facet];
  const bare = selector.trim();
  if (!bare) return [];
  const exact = new Set<string>();
  const prefix = new Set<string>();
  for (const m of models) {
    const provider = providerFacet(m.id);
    if (!provider) continue;
    const model = modelHalf(m.id);
    if (model === bare) exact.add(provider);
    else if (model.startsWith(bare)) prefix.add(provider);
  }
  return [...(exact.size > 0 ? exact : prefix)];
}

export interface RoutingPlanInput {
  /** The cached `omp models ls` catalog the complement is computed from. */
  models: readonly OmpModelInfo[];
  /** `governancePolicy.approvedEndpoints` (already normalized, non-empty). */
  approvedEndpoints: readonly string[];
  /** The model this run actually uses, post-resolution (`provider/id` form). */
  configuredModel: string | null;
  /** Raw `config.fallbackChain` selectors, which must stay reachable. */
  fallbackChain: readonly string[];
}

export interface RoutingPlan {
  /** Providers to hand omp as `disabledProviders` (empty = route nothing). */
  disabled: string[];
  /** Unapproved providers the guards refused to disable (operator feedback). */
  kept: string[];
  /** Why routing was not applied at all; null when the plan is usable. */
  skipped: string | null;
}

/**
 * Compute `disabled = knownProviders − approvedEndpoints − mustKeep`.
 *
 * `mustKeep` is the configured model's provider plus every provider the
 * fallback chain can resolve to: routing that strands the run's own model (or
 * its only failover target) is a self-inflicted outage, not a policy win.
 * Anything that makes the complement uncertain refuses to emit a list at all —
 * an empty plan just means "no routing this run", never a partial disable.
 */
export function planEndpointRouting(input: RoutingPlanInput): RoutingPlan {
  const empty = (skipped: string): RoutingPlan => ({ disabled: [], kept: [], skipped });

  const known = catalogProviders(input.models);
  if (known.length === 0) {
    return empty(
      "the model catalog reported no providers (no model configured, or `omp models ls` returned nothing)",
    );
  }
  const approved = new Set(
    input.approvedEndpoints.map((endpoint) => endpoint.trim().toLowerCase()).filter(Boolean),
  );
  // An allow-list we cannot read is not permission to disable everything.
  if (approved.size === 0) return empty("approvedEndpoints listed no usable endpoint");
  if (!known.some((provider) => approved.has(provider.toLowerCase()))) {
    return empty(
      `none of approvedEndpoints [${[...approved].join(", ")}] is a known provider (${known.join(", ")})`,
    );
  }

  const mustKeep = new Set<string>();
  const configured = input.configuredModel?.trim() ?? "";
  if (!configured) {
    return empty("no model is configured, so the provider that must survive routing is unknown");
  }
  const configuredProviders = providersForSelector(input.models, configured);
  if (configuredProviders.length === 0) {
    return empty(
      `the configured model "${configured}" matches no provider in the catalog`,
    );
  }
  for (const provider of configuredProviders) mustKeep.add(provider);
  for (const selector of input.fallbackChain) {
    const bare = selector.trim();
    if (!bare) continue;
    // Keep the resolved provider AND the literal selector: a chain entry may
    // itself name a provider the catalog happens not to list any model for.
    mustKeep.add(bare);
    for (const provider of providersForSelector(input.models, bare)) mustKeep.add(provider);
  }

  const disabled = known.filter(
    (provider) => !approved.has(provider.toLowerCase()) && !mustKeep.has(provider),
  );
  const kept = known.filter(
    (provider) => mustKeep.has(provider) && !approved.has(provider.toLowerCase()),
  );
  return { disabled, kept, skipped: null };
}

export type GovernanceOverlayResult =
  | { status: "none" }
  | { status: "ok"; path: string; disabled: string[]; kept: string[]; skipped: string | null }
  | { status: "error"; error: string };

/**
 * Materialize the run-child-only governance overlay: the single-gate key
 * (`tools.approvalMode: yolo`) plus, when routing can be computed safely,
 * `disabledProviders`. Returns "none" when nothing may be emitted — no live
 * policy, an unparseable or vacuous document, or a policy with no rule the
 * bridge can enforce — and "error" (never a throw) when the write fails,
 * mirroring the failover overlay's degrade.
 *
 * `armed` is the gate on the relaxation, and it is deliberately an INPUT rather
 * than something this function can infer: only the run flow knows whether the
 * governance manifest actually reached the child and whether `--extension` will
 * really be appended. Folding `approvalMode: yolo` without that would disable
 * omp's own permission gate while no handler exists to replace it — every
 * guardrail, budget and approval rule silently absent. `models` /
 * `configuredModel` still come from the run's cached catalog read; this function
 * does not spawn `omp models ls` itself, because that read must not happen under
 * this file.
 */
export async function materializeGovernanceOverlay(
  config: Record<string, unknown>,
  dir: string,
  context: {
    models?: readonly OmpModelInfo[];
    configuredModel?: string | null;
    /** True only when the bridge will enforce this run. Absent = not armed. */
    armed?: boolean;
  } = {},
  warn?: (message: string) => void | Promise<void>,
): Promise<GovernanceOverlayResult> {
  const parsed = parseGovernancePolicy(config.governancePolicy);
  if (parsed.kind !== "ok") return { status: "none" };
  const models = context.models ?? [];
  const approved = parsed.policy.approvedEndpoints;
  const plan: RoutingPlan = approved && approved.length > 0
    ? planEndpointRouting({
        models,
        approvedEndpoints: approved,
        configuredModel: context.configuredModel ?? null,
        fallbackChain: parseFallbackChain(config),
      })
    : { disabled: [], kept: [], skipped: null };
  if (plan.skipped) {
    await warn?.(
      `omp governance routing skipped: ${plan.skipped}; no providers disabled (approvedEndpoints is inert this run)`,
    );
  } else if (plan.kept.length > 0) {
    await warn?.(
      `omp governance routing kept ${plan.kept.join(", ")} enabled: it serves the configured model or the fallback chain, though approvedEndpoints omits it`,
    );
  }
  const lines: string[] = [];
  // Single-gate recipe: omp resolves auto-approval from the MERGED settings
  // view, so this key makes the ACP permission proxy always-allow and leaves
  // the bridge's tool_call gate as the run's only deterministic deny point.
  // That trade is only sound while the bridge is armed AND has a rule to run:
  // endpoint routing is enforced by omp itself, so it never pays for itself.
  const relaxGate = context.armed === true && parsed.enforceable;
  const tools: string[] = [];
  if (relaxGate) tools.push("  approvalMode: yolo");
  // `tools.restrictedFolders` is omp's own fence: it raises an approval prompt
  // in every approval mode, yolo included. It is written whenever configured —
  // it is enforced by omp, not by the bridge, so it needs neither `armed` nor an
  // enforceable rule. On this lane that prompt is answered by the ACP proxy
  // (approve-all auto-allows), which is why the bridge holds the same folders
  // as an approval rule; this key is the layer that still works for omp's own
  // non-ACP paths and for a run that is not armed.
  const restrictedFolders = parsed.policy.restrictedFolders ?? [];
  if (restrictedFolders.length > 0) {
    tools.push("  restrictedFolders:", ...restrictedFolders.map((p) => `    - ${JSON.stringify(p)}`));
  }
  if (tools.length > 0) lines.push("tools:", ...tools);
  if (plan.disabled.length > 0) {
    lines.push("disabledProviders:", ...plan.disabled.map((p) => `  - ${JSON.stringify(p)}`));
  }
  // Nothing to say, so nothing to read: an unarmed overlay with no routing must
  // not become a PI_CONFIG_FILES entry that could still influence the run.
  if (lines.length === 0) return { status: "none" };
  const file = path.join(dir, GOVERNANCE_CONFIG_FILE);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
  return { status: "ok", path: file, disabled: plan.disabled, kept: plan.kept, skipped: plan.skipped };
}
