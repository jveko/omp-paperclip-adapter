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
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith("OTEL_EXPORTER_OTLP_") && typeof v === "string") env[k] = v;
  }
  if (input.overlayPath) env.PI_CONFIG_FILES = input.overlayPath;
  return env;
}
