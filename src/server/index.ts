import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { sessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";
import { execute } from "./execute.js";
import { detectOmpConfiguredModel, refreshOmpModelCatalog, type OmpModelCost } from "./models.js";
import { listOmpSkillsSnapshot, syncOmpSkills } from "./skills.js";
import { RUN_IDENTITY_ENABLED } from "./acp.js";
import { testEnvironment } from "./test.js";
import { agentConfigurationDoc, type } from "../index.js";
import { getSessionConfigSchema } from "./session-directives.js";

// NOTE: ServerAdapterModule hooks take no per-agent config; discovery uses the
// default omp on PATH, not any agent's `command` override (documented in doc).
interface DetectedOmpModel {
  model: string;
  provider: string;
  source: string;
}

/**
 * The installed adapter-utils `AdapterModel` declares only id/label; contract
 * HEAD's model consumers read the rate card and context window, and the
 * registry hands this array to the board verbatim. Re-declaring the extras here
 * is the one place the dependency skew is recorded (same pattern as
 * `runtimeToolDelivery` below).
 */
interface OmpAdapterModel {
  id: string;
  label: string;
  contextWindow?: number;
  cost?: OmpModelCost;
}

let detectCache: { at: number; value: Promise<DetectedOmpModel | null> } | null = null;
const DETECT_TTL_MS = 60_000;

async function refreshModels(): Promise<OmpAdapterModel[]> {
  const models = await refreshOmpModelCatalog();
  return models.map((m) => ({
    id: m.id,
    label: m.label,
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    ...(m.cost !== undefined ? { cost: m.cost } : {}),
  }));
}

async function detectModel(): Promise<DetectedOmpModel | null> {
  const cached = detectCache;
  if (cached && Date.now() - cached.at < DETECT_TTL_MS) return cached.value;
  // Single-flight: overlapping callers share one in-flight read.
  const value = detectOmpConfiguredModel();
  detectCache = { at: Date.now(), value };
  return value;
}

/**
 * Delivery channel for Paperclip's run-scoped control tools.
 *
 * Paperclip contract HEAD declares `runtimeToolDelivery` on
 * `ServerAdapterModule` (adapter-utils types.ts:519) and the heartbeat path
 * reads it untyped (`adapter.runtimeToolDelivery ?? "invocation_context"`,
 * runtime-execution.ts:777-778), but the pinned 2026.824.1 declaration does not
 * carry the member. Re-declaring it here keeps the value checked without
 * bumping the dependency; this type is the one place the skew is recorded.
 */
export type OmpRuntimeToolDelivery = "native_mcp" | "environment" | "invocation_context";
export type OmpServerAdapterModule =
  ServerAdapterModule & { runtimeToolDelivery?: OmpRuntimeToolDelivery };

export function createServerAdapter(): OmpServerAdapterModule {
  return {
    type,
    models: [],
    refreshModels,
    detectModel,
    sessionCodec,
    // Governance surface for the board's per-agent config form; every field is
    // a next-run directive (the adapter owns no live connection).
    getConfigSchema: () => getSessionConfigSchema(),
    // Run identity: Paperclip mints the per-run JWT only for adapters that
    // declare this (runtime-execution.ts:249-260), and the engine turns the
    // token into PAPERCLIP_API_KEY in the run child (pinned acpx-engine
    // execute.js:1014-1015). That key is the single source for the session-snapshot
    // and usage work products and for the bridge's approval round-trip; a
    // missing token keeps failing closed with the existing explicit errors.
    // Blast radius (company-scoped API access for the run) is stated in
    // agentConfigurationDoc. The same constant pins engine warm-handle reuse
    // off, because a reused child would keep an earlier run's token.
    supportsLocalAgentJwt: RUN_IDENTITY_ENABLED,
    // omp consumes ACP `mcpServers` on session/new|load|resume|fork, so the
    // Paperclip connections/project servers must be delivered there.
    // `invocation_context` would hand this adapter a token it cannot serve.
    runtimeToolDelivery: "native_mcp",
    // Managed AGENTS.md bundle: the engine renders instructionsFilePath into the
    // run prompt, and the ephemeral skills file merges the same path, so the
    // bundle composes with skills-as-tools instead of replacing it.
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    // Static capability declaration consumed by the Paperclip control plane.
    // Without it omp_local resolves to a compaction-DISABLED default. Threshold
    // enforcement server-side is not relied upon — the adapter rotates via its
    // own sessionMaxRuns/sessionMaxAgeHours config.
    sessionManagement: {
      supportsSessionResume: true,
      nativeContextManagement: "none",
      defaultSessionCompaction: {
        enabled: true,
        maxSessionRuns: 200,
        maxRawInputTokens: 2_000_000,
        maxSessionAgeHours: 72,
      },
    },
    execute,
    testEnvironment,
    agentConfigurationDoc,
    listSkills: (ctx) => listOmpSkillsSnapshot(ctx),
    syncSkills: (ctx, desiredSkills) => syncOmpSkills(ctx, desiredSkills),
    // ACP capability descriptor: skills are delivered via instructions-file
    // injection (ephemeral), nodeRange mirrors engines.node in package.json.
    acp: {
      agentId: "omp",
      skillsMode: "ephemeral",
      prerequisites: { nodeRange: ">=24.11.0" },
    },
  };
}
