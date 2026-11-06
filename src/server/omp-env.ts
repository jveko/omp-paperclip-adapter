import path from "node:path";
/**
 * Assemble the environment every omp process must carry so the run's ACP child
 * and the side-channel spawns (model catalog, active-model probe, fork, session
 * reads, usage) resolve credentials, settings, and telemetry identically.
 *
 * `ctx.config.env` values are already resolved to strings by the server before
 * execute() runs (secret_ref bindings included), so only string values are
 * forwarded here. Never throws.
 */
export function ompEnv(
  input: { config: Record<string, unknown>; overlayPath?: string | null },
): Record<string, string> {
  const src = (input.config.env ?? {}) as Record<string, unknown>;
  const env: Record<string, string> = {};
  const str = (k: string): string | undefined =>
    typeof src[k] === "string" && (src[k] as string).length > 0 ? (src[k] as string) : undefined;

  if (input.config.credentialMode === "broker") {
    const url = str("OMP_AUTH_BROKER_URL");
    const token = str("OMP_AUTH_BROKER_TOKEN");
    if (url) env.OMP_AUTH_BROKER_URL = url;
    if (token) env.OMP_AUTH_BROKER_TOKEN = token;
  }
  // The agent dir decides which sessions, titles, config.yml and credential
  // store omp resolves (dirs.ts:952-1000). A side channel that resolved a
  // different dir than the run child would list, fork or fetch the wrong
  // tenant's state, so forward it whenever the run carries one — the session
  // fence sets it, and an operator-set value must ride along unchanged.
  const agentDir = str("PI_CODING_AGENT_DIR");
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  // A named profile (`sessionScope: "profile"`) resolves its own config root;
  // a side channel without it would read a different store than the run child.
  const profile = str("OMP_PROFILE");
  if (profile) env.OMP_PROFILE = profile;
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith("OTEL_EXPORTER_OTLP_") && typeof v === "string") env[k] = v;
  }
  const parts = [str("PI_CONFIG_FILES"), input.overlayPath].filter(Boolean);
  if (parts.length) env.PI_CONFIG_FILES = parts.join(path.delimiter);
  return env;
}
