import os from "node:os";
import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { resolveSessionScope, type SessionScope } from "./session-directives.js";
import { ompAgentDir } from "./session-state.js";

export interface PreparedSessionScope {
  scope: SessionScope;
  /** The per-agent omp agent dir, or null for a shared run. */
  agentDir: string | null;
  /** The config the run must use. For `shared` it is the input object. */
  config: Record<string, unknown>;
  /** Operator-visible facts the run should log; never fatal. */
  warnings: string[];
}

export type PrepareSessionScopeResult =
  | { ok: true; prepared: PreparedSessionScope }
  | { ok: false; error: string };

/** The config file names omp looks for in an agent dir (dirs.ts:32). */
const CONFIG_FILE_NAMES = ["config.yml", "config.yaml"] as const;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The agent dir this run would use WITHOUT the fence: an explicitly configured
 * `PI_CODING_AGENT_DIR`, else omp's default for the process's config root
 * (`<PI_CONFIG_DIR|~/.omp>/agent`, dirs.ts:329-339). This is where existing
 * installs keep the operator's `config.yml`, which a fenced run must keep
 * applying or it would lose providers, model roles and broker routing.
 */
function legacyAgentDir(operatorAgentDir: string): string {
  if (operatorAgentDir) return operatorAgentDir;
  const fromEnv = str(process.env.PI_CODING_AGENT_DIR);
  if (fromEnv) return fromEnv;
  const configRoot = str(process.env.PI_CONFIG_DIR) || path.join(os.homedir(), ".omp");
  return path.join(configRoot, "agent");
}

async function firstExistingConfigFile(agentDir: string): Promise<string | null> {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(agentDir, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* absent: try the next name */
    }
  }
  return null;
}

/**
 * Resolve the session scope for a run and, when it is `isolated`, produce the
 * config that carries `PI_CODING_AGENT_DIR` into the run child AND the side
 * channels (ompEnv forwards it).
 *
 * Never throws. Returns a typed failure when the fence was requested but its
 * directory cannot be created — a run that silently fell back to the shared
 * agent dir would defeat the containment control it was asked to apply.
 *
 * Credentials are never touched: the fenced dir starts empty, which is why
 * `validateSessionScope` (called before this) requires broker mode.
 */
export async function prepareSessionScope(
  config: Record<string, unknown>,
  ids: { companyId: string; agentId: string },
): Promise<PrepareSessionScopeResult> {
  if (resolveSessionScope(config) !== "isolated") {
    return { ok: true, prepared: { scope: "shared", agentDir: null, config, warnings: [] } };
  }
  const warnings: string[] = [];
  let agentDir: string;
  try {
    // resolvePaperclipInstanceRootForAdapter throws on an invalid
    // PAPERCLIP_INSTANCE_ID; the fence must degrade to a typed error, never an
    // uncaught throw out of the run path.
    agentDir = ompAgentDir(ids.companyId, ids.agentId);
  } catch (err) {
    return {
      ok: false,
      error: `sessionScope is 'isolated' but this agent's omp agent dir could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const env = { ...((config.env ?? {}) as Record<string, unknown>) };
  const configuredAgentDir = str(env.PI_CODING_AGENT_DIR) || str(process.env.PI_CODING_AGENT_DIR);
  if (configuredAgentDir && path.resolve(configuredAgentDir) !== path.resolve(agentDir)) {
    warnings.push(
      `sessionScope is 'isolated': replacing the configured PI_CODING_AGENT_DIR (${configuredAgentDir}) with this agent's own omp agent dir (${agentDir})`,
    );
  }
  try {
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      error: `sessionScope is 'isolated' but this agent's omp agent dir could not be created (${agentDir}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Keep the operator's config: the fenced dir has none, and losing it would
  // drop providers, model roles and auth-broker routing. Lowest precedence, so
  // the operator's own PI_CONFIG_FILES, the failover chain and the governance
  // overlay all still win.
  const legacyConfig = await firstExistingConfigFile(legacyAgentDir(configuredAgentDir));
  if (legacyConfig) {
    const existing = str(env.PI_CONFIG_FILES);
    env.PI_CONFIG_FILES = [legacyConfig, existing].filter(Boolean).join(path.delimiter);
  }
  env.PI_CODING_AGENT_DIR = agentDir;
  return { ok: true, prepared: { scope: "isolated", agentDir, config: { ...config, env }, warnings } };
}
