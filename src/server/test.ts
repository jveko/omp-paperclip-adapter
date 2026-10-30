import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { parseOmpVersion, probeOmpAcpSession, resolveOmpAgentCommand, TESTED_OMP_MINOR, type OmpAcpProbeResult } from "./acp.js";
import { ompEnv } from "./omp-env.js";
import { resolveSessionScope, validateSessionScope } from "./session-directives.js";

function run(command: string, args: string[], timeoutMs: number, env?: Record<string, string>): Promise<string> {
  return new Promise<string>((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env: env ? { ...process.env, ...env } : undefined },
      (_err, stdout) => resolve(String(stdout ?? "")));
  });
}
/** Copy only the OTEL_EXPORTER_OTLP_* string vars from a source env dict. */
function pickOtel(src: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!src) return out;
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith("OTEL_EXPORTER_OTLP_") && typeof v === "string") out[k] = v;
  }
  return out;
}
/**
 * Report the session scope this agent would run under. `shared` is not an
 * error — it is the historical default — but it must be visible as a warning,
 * because it means every omp employee on this host shares one agent dir
 * (sessions, titles, caches, credentials). `isolated` reuses the run path's
 * validator, so the test screen and the heartbeat fail on the same configs for
 * the same reason.
 */
export function evaluateSessionScopeCheck(
  config: Record<string, unknown>,
): AdapterEnvironmentCheck {
  const invalid = validateSessionScope(config);
  if (invalid) return { level: "error", code: "omp_config_error", message: invalid };
  if (resolveSessionScope(config) === "isolated") {
    return {
      level: "info",
      code: "omp_sessions_isolated",
      message: "sessionScope=isolated: sessions, titles and caches live in this agent's own omp agent dir (`companies/<company>/acp-engine/agents/<agent>/omp-agent`)",
      detail: "The run creates that dir on first use and resolves PI_CODING_AGENT_DIR to it; credentials come from the auth broker only.",
    };
  }
  return {
    level: "warn",
    code: "omp_sessions_shared",
    message: "sessionScope=shared: this employee uses the host-wide omp agent dir, so sessions, titles, caches and config are shared with every other omp agent on this host",
    detail: "Set sessionScope=isolated (with credentialMode=broker) to give this agent its own omp sessions and caches.",
  };
}

/**
 * Enforce the tested omp MINOR, not just "a version parsed".
 *
 * The adapter compensates for engine behavior that moves between minors, so an
 * untested minor is a heartbeat failure waiting to happen; the environment test
 * is where it must surface, with a readable message, instead. Only a command
 * literally named `omp` is enforced: the docs already note that wrapper
 * commands report their own version, and failing a wrapper would be a false
 * negative. A build that reports nothing parseable stays a warning, unchanged.
 */
export function evaluateOmpVersionCheck(
  version: { major: number; minor: number; patch: number } | null,
  output: string,
  command: string,
): AdapterEnvironmentCheck {
  if (!version) {
    return {
      level: "warn",
      code: "omp_version_unparsed",
      message: "could not parse --version output",
      detail: output.slice(0, 200),
    };
  }
  const shown = `${version.major}.${version.minor}.${version.patch}`;
  if (path.basename(command) !== "omp") {
    return {
      level: "warn",
      code: "omp_version_unverified",
      message: `probed '${command}' -> ${shown}; version enforcement is skipped because only a command named 'omp' reports omp's own version (wrapper commands report their own)`,
      detail: `The adapter is tested against omp ${TESTED_OMP_MINOR.major}.${TESTED_OMP_MINOR.minor}.x.`,
    };
  }
  if (version.major !== TESTED_OMP_MINOR.major || version.minor !== TESTED_OMP_MINOR.minor) {
    return {
      level: "error",
      code: "omp_version_unsupported",
      message: `omp ${shown} is outside the tested range ${TESTED_OMP_MINOR.major}.${TESTED_OMP_MINOR.minor}.x: this adapter compensates for that minor's engine behavior, so a different minor is untested (a renamed config key or surface fails a heartbeat instead of this check)`,
      detail: `Install omp ${TESTED_OMP_MINOR.major}.${TESTED_OMP_MINOR.minor}.x, or upgrade this adapter and its peerDependencies range.`,
    };
  }
  return {
    level: "info",
    code: "omp_version",
    message: `probed '${command}' -> ${shown} (the tested minor)`,
  };
}

/**
 * Pin the ACP config-option id contract: omp's `session/set_config_option`
 * accepts exactly `mode`, `model` and `thinking`, and this adapter reads the
 * `model` option to report the active model. A build that renames those ids
 * fails here with a readable message instead of leaving model selection inert.
 */
export function evaluateConfigOptionCheck(
  probe: Pick<OmpAcpProbeResult, "configOptionIds">,
): AdapterEnvironmentCheck {
  const ids = probe.configOptionIds ?? [];
  if (ids.includes("model")) {
    return {
      level: "info",
      code: "omp_config_options",
      message: `ACP config options: ${ids.join(", ") || "none"}`,
    };
  }
  return {
    level: "warn",
    code: "omp_config_option_model_missing",
    message: "the ACP handshake advertised no `model` config option, so the adapter cannot report the active model and model selection may be inert",
    detail: `Advertised: ${ids.join(", ") || "none"}. omp accepts only mode|model|thinking; a renamed id is an upgrade cliff.`,
  };
}

/**
 * Report whether this omp build can serve the session snapshot. The snapshot
 * read uses ACP `session/list` with no host-wide fallback (by design — see
 * queryOmpSessions), so a build without that surface produces no card at all
 * and the environment test is the only place that can say why.
 */
export function evaluateSessionListCheck(supportsSessionList: boolean): AdapterEnvironmentCheck {
  return supportsSessionList
    ? {
        level: "info",
        code: "omp_session_list_supported",
        message: "ACP session/list available: the session snapshot stays scoped to this agent's workspace",
      }
    : {
        level: "warn",
        code: "omp_session_list_unsupported",
        message: "this omp build does not advertise ACP session/list; the session snapshot work product will be skipped rather than widened to a host-wide listing",
        detail: "Upgrade omp, or accept no session browser for this agent.",
      };
}

export function evaluateOtlpCheck(env: Record<string, unknown>): AdapterEnvironmentCheck {
  const signals = ["", "TRACES_", "LOGS_", "METRICS_"] as const;
  const endpoints = signals
    .map((s) => env[`OTEL_EXPORTER_OTLP_${s}ENDPOINT`])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (endpoints.length === 0) {
    return { level: "info", code: "omp_otlp_export_off", message: "OTLP export not configured (set OTEL_EXPORTER_OTLP_ENDPOINT or a signal-specific ..._ENDPOINT in agent env; agent env overrides host env)" };
  }
  const genericProtocol =
    typeof env.OTEL_EXPORTER_OTLP_PROTOCOL === "string" && env.OTEL_EXPORTER_OTLP_PROTOCOL
      ? (env.OTEL_EXPORTER_OTLP_PROTOCOL as string)
      : "http/protobuf";
  const effective = (sig: string): string => {
    const proto = env[`OTEL_EXPORTER_OTLP_${sig}PROTOCOL`];
    return typeof proto === "string" && proto ? proto : genericProtocol;
  };
  const unsupported = signals
    .filter((s) => effective(s) !== "http/protobuf")
    .map((s) => (s ? s.slice(0, -1).toLowerCase() : "default"));
  if (unsupported.length > 0) {
    return {
      level: "warn", code: "omp_otlp_protocol_unsupported",
      message: `OTLP endpoint set but protocol(s) unsupported for: ${unsupported.join(", ")}`,
      detail: "omp emits only http/protobuf; other values silently disable that signal (telemetry-export-otlp.ts:8-12).",
    };
  }
  return { level: "info", code: "omp_otlp_export_armed", message: `OTLP export armed → ${endpoints.join(", ")}`, detail: "omp emits traces/metrics/logs; Paperclip has no built-in sink — point at an external collector." };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = ctx.config ?? {};
  const checks: AdapterEnvironmentCheck[] = [];
  const agentCommand = resolveOmpAgentCommand(config);
  const tokens = agentCommand.split(/\s+/);
  const bin = tokens[0];
  const acpArgs = tokens.slice(1);
  // Non-ACP subcommands (--version, auth-broker status) run through the full
  // resolved command. `acp` is located by index so trailing flags (e.g.
  // `--thinking medium`) never leak into the probe argv.
  const acpIdx = tokens.indexOf("acp");
  const base = acpIdx >= 0 ? tokens.slice(0, acpIdx) : tokens;

  // 1. cwd absolute + accessible
  try {
    const cwd = resolveAdapterExecutionTargetCwd(
      ctx.executionTarget ?? null,
      typeof config.cwd === "string" ? config.cwd : "",
      process.cwd(),
    );
    if (!path.isAbsolute(cwd)) throw new Error(`cwd must be absolute: ${cwd}`);
    await fs.access(cwd).catch(() => {
      throw new Error(`cwd does not exist or is not accessible: ${cwd}`);
    });
    checks.push({ level: "info", code: "omp_cwd_ok", message: `cwd ok: ${cwd}` });
  } catch (err) {
    checks.push({
      level: "error",
      code: "omp_cwd_invalid",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. binary resolvable
  try {
    await ensureAdapterExecutionTargetCommandResolvable(
      bin,
      ctx.executionTarget ?? null,
      process.cwd(),
      process.env,
    );
    checks.push({ level: "info", code: "omp_command_resolvable", message: `command executable: ${bin}` });
  } catch (err) {
    checks.push({
      level: "error",
      code: "omp_command_unresolvable",
      message: err instanceof Error ? err.message : String(err),
      detail: bin,
    });
  }

  const spawnEnv = ompEnv({ config });
  const versionOut = await run(base[0], [...base.slice(1), "--version"], 10_000, spawnEnv);
  checks.push(evaluateOmpVersionCheck(parseOmpVersion(versionOut), versionOut, bin));

  // 4. ACP handshake + active model detection
  const probe = await probeOmpAcpSession({ command: bin, args: acpArgs, env: spawnEnv });
  if (probe.ok) {
    checks.push({
      level: "info",
      code: "acp_handshake_ok",
      message: "ACP initialize+session/new OK",
      detail: probe.currentModel ? `active model: ${probe.currentModel}` : undefined,
    });
    // Only a completed handshake can report the advertised capabilities.
    checks.push(evaluateSessionListCheck(probe.supportsSessionList === true));
    checks.push(evaluateConfigOptionCheck(probe));
  } else {
    checks.push({
      level: "error",
      code: "acp_handshake_failed",
      message: "ACP handshake failed",
      detail: probe.error,
    });
  }

  // 5. billing env validation
  const env =
    config.env && typeof config.env === "object"
      ? (config.env as Record<string, unknown>)
      : {};
  const rawBilling = String(
    env.OMP_PAPERCLIP_BILLING_TYPE ?? process.env.OMP_PAPERCLIP_BILLING_TYPE ?? "",
  );
  if (rawBilling && !["api", "subscription"].includes(rawBilling.trim().toLowerCase())) {
    checks.push({
      level: "warn",
      code: "omp_billing_unknown",
      message: `OMP_PAPERCLIP_BILLING_TYPE='${rawBilling}' unknown; falling back to api`,
    });
  }
  // 6. broker health (credentialMode=broker)
  if (config.credentialMode === "broker") {
    const stdout = await run(base[0], [...base.slice(1), "auth-broker", "status", "--json"], 10_000, spawnEnv);
    let reachable = false;
    try { const j = JSON.parse(stdout); reachable = j.ok !== false && (typeof j.url === "string" || j.reason !== "not_configured"); } catch { /* keep false */ }
    checks.push(reachable
      ? { level: "info", code: "omp_broker_reachable", message: "auth-broker reachable", detail: stdout.slice(0, 200) }
      : { level: "warn", code: "omp_broker_unreachable", message: "credentialMode=broker but `omp auth-broker status` did not report a reachable broker", detail: stdout.slice(0, 200) || "no output" });
  }
  // 7. session scope (item 18 containment control)
  checks.push(evaluateSessionScopeCheck(config));
  // 8. OTLP export diagnostic (agent env overrides host env)
  checks.push(evaluateOtlpCheck({ ...pickOtel(process.env), ...pickOtel(env) }));

  return {
    adapterType: ctx.adapterType,
    status: checks.some((c) => c.level === "error")
      ? "fail"
      : checks.some((c) => c.level === "warn")
        ? "warn"
        : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
