import os from "node:os";
import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { resolveSessionScope, sharedScopeRisk, type SessionScope } from "./session-directives.js";
import { ompAgentDir } from "./session-state.js";
import {
  adapterInstanceId, agentProfileName, profileAgentDir, profileConfigRoot,
} from "./omp-profile.js";

export interface PreparedSessionScope {
  scope: SessionScope;
  /** The run's omp agent dir (isolated or profile), or null for a shared run. */
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

/** `code` from a Node fs error, without asserting the error's shape. */
function fsErrorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

/**
 * The operator's omp config file in the shared agent dir, if there is one.
 * Absent is normal (a fresh install); unreadable is NOT absent — the fenced run
 * would silently lose providers and model roles, so the caller must warn.
 */
async function findConfigFile(
  agentDir: string,
): Promise<{ path: string | null; error?: string }> {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(agentDir, name);
    try {
      if ((await stat(candidate)).isFile()) return { path: candidate };
    } catch (err) {
      const code = fsErrorCode(err);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { path: null, error: `${candidate} could not be inspected (${code ?? String(err)})` };
    }
  }
  return { path: null };
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
  const scope = resolveSessionScope(config);
  if (scope === "shared") {
    // Shared is the default outside broker mode; under broker mode it is an
    // explicit opt-out of the fence, and the run must name what it accepts.
    const risk = sharedScopeRisk(config);
    return {
      ok: true,
      prepared: { scope: "shared", agentDir: null, config, warnings: risk === null ? [] : [risk] },
    };
  }
  if (scope === "profile") {
    // A named profile is omp's own fence: every store it reads resolves under
    // $HOME/<PI_CONFIG_DIR>/profiles/<name>. Outside the instance root by
    // design (PI_CONFIG_DIR is a name joined under the home, not a path).
    const env = { ...((config.env ?? {}) as Record<string, unknown>) };
    const configuredAgentDir = str(env.PI_CODING_AGENT_DIR) || str(process.env.PI_CODING_AGENT_DIR);
    if (configuredAgentDir) {
      return {
        ok: false,
        error: `sessionScope is 'profile' but PI_CODING_AGENT_DIR is set (${configuredAgentDir}); named omp profiles ignore PI_CODING_AGENT_DIR, so the setting would be silently dropped. Unset PI_CODING_AGENT_DIR or use sessionScope 'isolated'.`,
      };
    }
    let instanceId: string;
    try {
      instanceId = adapterInstanceId();
    } catch (err) {
      return {
        ok: false,
        error: `sessionScope is 'profile' but this agent's omp profile could not be resolved from the instance id: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const name = agentProfileName({ instanceId, companyId: ids.companyId, agentId: ids.agentId });
    const root = profileConfigRoot(name);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
    } catch (err) {
      return {
        ok: false,
        error: `sessionScope is 'profile' but the omp profile could not be created (${root}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    env.OMP_PROFILE = name;
    return {
      ok: true,
      prepared: {
        scope: "profile",
        agentDir: profileAgentDir(name),
        config: { ...config, env },
        warnings: [],
      },
    };
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
  const legacyConfig = await findConfigFile(legacyAgentDir(configuredAgentDir));
  if (legacyConfig.error) {
    warnings.push(
      `sessionScope is 'isolated': the shared agent dir's omp config could not be read (${legacyConfig.error}), so this run starts without it — providers and model roles defined there will not apply`,
    );
  }
  if (legacyConfig.path) {
    const existing = str(env.PI_CONFIG_FILES);
    env.PI_CONFIG_FILES = [legacyConfig.path, existing].filter(Boolean).join(path.delimiter);
  }
  env.PI_CODING_AGENT_DIR = agentDir;
  return { ok: true, prepared: { scope: "isolated", agentDir, config: { ...config, env }, warnings } };
}
