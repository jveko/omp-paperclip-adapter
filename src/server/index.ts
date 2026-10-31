import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { sessionCodec } from "./adapters/acp/session-codec.js";
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
 * The installed `AdapterModel` declares only id/label; the adapter's catalog
 * carries a context window and cost card as well. The registry hands the array
 * to the route verbatim (`registry.ts` refreshAdapterModels → `res.json`), so
 * the extra fields reach the board JSON without a type change on either side;
 * a consumer that does not know them ignores them. This is the one place the
 * skew is recorded.
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

export function createServerAdapter(): ServerAdapterModule {
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
    // declare this (runtime-execution.ts:249-260). The adapter forwards it to
    // the supervisor, which writes it into the run-context file the bridge
    // reads; it never enters a worker's environment. That token is the single
    // source for the session-snapshot and usage work products and for the
    // bridge's approval round-trip; a missing token keeps failing closed with
    // the existing explicit errors. Blast radius (company-scoped API access for
    // the run) is stated in agentConfigurationDoc.
    supportsLocalAgentJwt: RUN_IDENTITY_ENABLED,
    // The supervisor serves Paperclip's connection tools to the agent as omp
    // host tools, so the adapter declares the native delivery channel and reads
    // the run-scoped access object; `invocation_context` would hand it a token
    // nothing in this process can serve.
    runtimeToolDelivery: "native_mcp",
    // Managed AGENTS.md bundle: the supervisor renders instructionsFilePath into
    // the run prompt, and the ephemeral skills file merges the same path, so the
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
