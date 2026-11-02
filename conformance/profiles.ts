import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fixture matrix, as data.
 *
 * Each profile is one scripted omp build: a small executable that execs the
 * ACP responder for `omp acp`, answers the surface probes (`--version`,
 * `config list --json`, `<verb> --help`) and returns a model catalogue. The
 * engine lane drives it through the real engine; the managed lane drives the
 * same build's RPC worker (`fake-rpc.mjs`) through the real supervisor.
 *
 * Profiles:
 * - `18.13` / `18.14` — the tested lines, fully capable (the baseline).
 * - `drift` — a plausible next release: `session/list`/`session/fork`
 *   unadvertised, no `_session/steering`, `_omp/extensions` gone, the
 *   `thinking` config id renamed, `usage_update.cost` dropped. Every fallback
 *   path is exercised without waiting for a release.
 * - `wrapper` — a command not named `omp` reporting its own version, which
 *   must stay "unverified", never failed.
 */

export interface ConformanceProfile {
  name: string;
  /** The binary name the build installs as (`omp` unless it is a wrapper). */
  commandName: string;
  version: string;
  /** `FAKE_ACP_MODE` for the ACP responder. */
  acpMode?: string;
  /** `FAKE_RPC_MODE` for the managed worker. */
  rpcMode?: string;
  settingsKeys: string[];
  topVerbs: string[];
  modelsVerbs: string[];
  sessionVerbs: string[];
  /** Diagnoses this profile must produce, by capability check code. */
  expectedDiagnostics: string[];
}

const SETTINGS_KEYS = ["session.maxCost", "tools.restrictedFolders", "defaultThinkingLevel"];
const TOP_VERBS = ["acp", "config", "gc", "models", "session"];
const MODELS_VERBS = ["ls", "find", "refresh"];
const SESSION_VERBS = ["lease", "pack"];

export const PROFILES: Record<string, ConformanceProfile> = {
  "18.13": {
    name: "18.13",
    commandName: "omp",
    version: "18.13.1",
    settingsKeys: SETTINGS_KEYS,
    topVerbs: TOP_VERBS,
    modelsVerbs: MODELS_VERBS,
    sessionVerbs: SESSION_VERBS,
    expectedDiagnostics: [],
  },
  "18.14": {
    name: "18.14",
    commandName: "omp",
    version: "18.14.0",
    settingsKeys: SETTINGS_KEYS,
    topVerbs: TOP_VERBS,
    modelsVerbs: MODELS_VERBS,
    sessionVerbs: SESSION_VERBS,
    expectedDiagnostics: [],
  },
  drift: {
    name: "drift",
    commandName: "omp",
    version: "18.15.0",
    acpMode: "drift",
    settingsKeys: ["session.maxCost", "defaultThinkingLevel"],
    topVerbs: TOP_VERBS,
    modelsVerbs: MODELS_VERBS,
    // `session lease` is already absent from the installed 18.14.0; the drift
    // profile keeps it absent to model a build that never grew it.
    sessionVerbs: ["pack"],
    expectedDiagnostics: [
      "omp_session_list_unsupported",
      "omp_capability_missing_session_fork",
      "omp_capability_missing_steering",
      "omp_capability_missing_extensions",
      "omp_config_option_thinking_missing",
      "omp_settings_restricted_folders_missing",
      "omp_cli_session_lease_missing",
    ],
  },
  wrapper: {
    name: "wrapper",
    commandName: "omp-wrapper",
    version: "18.15.0",
    settingsKeys: SETTINGS_KEYS,
    topVerbs: TOP_VERBS,
    modelsVerbs: MODELS_VERBS,
    sessionVerbs: SESSION_VERBS,
    expectedDiagnostics: [],
  },
};

/** The priced catalogue every profile reports (`omp models ls --json`). */
export const MODEL_CATALOG = {
  models: [
    {
      provider: "prov",
      id: "model-a",
      name: "Model A",
      contextWindow: 200_000,
      pricingStatus: "fixed",
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    {
      provider: "prov",
      id: "model-free",
      name: "Model Free",
      contextWindow: 200_000,
      pricingStatus: "free",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
};

const fakeAcp = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures/fake-acp.mjs",
);
export const fakeRpc = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures/fake-rpc.mjs",
);

/**
 * Materialize one profile as an executable. The script is a pure dispatcher:
 * `acp …` execs the ACP responder (so the agent process is real), every other
 * argv answers a surface probe.
 */
export async function materializeProfile(root: string, profile: ConformanceProfile): Promise<{
  script: string;
  agentCommand: string;
}> {
  await mkdir(root, { recursive: true });
  const script = path.join(root, profile.commandName);
  const help = (verbs: string[]): string =>
    `${profile.commandName} v${profile.version}\n\nCOMMANDS\n`
    + verbs.map((verb) => `  ${verb.padEnd(10)}${verb} command`).join("\n")
    + "\n";
  const settings = Object.fromEntries(profile.settingsKeys.map((key) => [key, { type: "number" }]));
  await writeFile(script, [
    "#!/bin/sh",
    `if [ "$1" = "acp" ]; then`,
    `  FAKE_ACP_MODE="${profile.acpMode ?? ""}" exec "${process.execPath}" "${fakeAcp}" "$@"`,
    "fi",
    // The managed lane spawns `<command> --mode rpc`; that is the scripted RPC
    // worker, which reads FAKE_RPC_MODE from the run env.
    `if [ "$1" = "--mode" ] && [ "$2" = "rpc" ]; then`,
    `  exec "${process.execPath}" "${fakeRpc}"`,
    "fi",
    `case "$*" in`,
    `  "--version") printf '%s\\n' '${profile.commandName}/${profile.version}' ;;`,
    `  "config list --json") printf '%s\\n' '${JSON.stringify(settings)}' ;;`,
    `  "models ls --json") printf '%s\\n' '${JSON.stringify(MODEL_CATALOG)}' ;;`,
    `  "models refresh") exit 0 ;;`,
    `  "--help") printf '%s\\n' '${help(profile.topVerbs)}' ;;`,
    `  "models --help") printf '%s\\n' '${help(profile.modelsVerbs)}' ;;`,
    `  "session --help") printf '%s\\n' '${help(profile.sessionVerbs)}' ;;`,
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  return { script, agentCommand: `${script} acp` };
}
