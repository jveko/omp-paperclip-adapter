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
import { bridgePath, parseOmpVersion, resolveOmpAgentCommand, TESTED_OMP_MINORS } from "./acp.js";
import { capabilityCacheDir, capabilityChecks, loadCapabilities } from "./capabilities.js";
import { buildWorkerArgv } from "../host/worker.js";
import { ompEnv } from "./omp-env.js";
import { listOmpModels, type OmpModelInfo } from "./models.js";
import { providerQualifiedSelectors, validateProviderQualifiedSelectors } from "./failover-config.js";
import { resolveExecutionMode, resolveSessionScope, validateSessionScope } from "./session-directives.js";

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
 * Check provider-qualified model selectors (`model`, `fallbackChain`) against
 * the catalog. omp 18.14 resolves anything containing `/` exactly: a near match
 * fails for `model` and is skipped for a chain leg, which would silently narrow
 * the chain. An unreadable catalog proves nothing, so it warns instead of
 * failing — the run path then passes the selectors through as before.
 * Returns null when there is nothing to check or everything resolves.
 */
export function evaluateModelSelectorCheck(
  config: Record<string, unknown>,
  models: OmpModelInfo[],
): AdapterEnvironmentCheck | null {
  const selectors = providerQualifiedSelectors(config);
  if (selectors.length === 0) return null;
  if (models.length === 0) {
    return {
      level: "warn",
      code: "omp_model_catalog_unavailable",
      message: `the omp model catalog could not be read (or lists no models), so provider-qualified selectors (${selectors.map(({ selector }) => selector).join(", ")}) cannot be verified; omp 18.14 fails a near-match model and skips such a fallback leg`,
    };
  }
  const invalid = validateProviderQualifiedSelectors(config, models);
  return invalid ? { level: "error", code: "omp_config_error", message: invalid } : null;
}

/**
 * Report the build's version against the tested lines — as a claim, not a gate.
 *
 * The capability probes are the gate now: a build can be outside the tested
 * minors and still expose every surface this adapter reads, and a tested minor
 * can lose one. So a minor outside the tested set is a warning naming the
 * tested lines and pointing at the capability checks; only a MAJOR mismatch is
 * an error, because the ACP lane itself is not covered by the capability set
 * (a new major may remove the protocol). A command not literally named `omp`
 * reports its own version, so enforcement there would be a false negative.
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
  const testedRange = TESTED_OMP_MINORS.map((m) => `${m.major}.${m.minor}.x`).join(" or ");
  if (path.basename(command) !== "omp") {
    return {
      level: "warn",
      code: "omp_version_unverified",
      message: `probed '${command}' -> ${shown}; version enforcement is skipped because only a command named 'omp' reports omp's own version (wrapper commands report their own)`,
      detail: `The adapter is tested against omp ${testedRange}; the capability checks below are the gate.`,
    };
  }
  const testedMajors: number[] = [...new Set(TESTED_OMP_MINORS.map((m) => m.major))];
  if (!testedMajors.includes(version.major)) {
    const direction = version.major > Math.max(...testedMajors) ? "newer" : "older";
    return {
      level: "error",
      code: "omp_version_unsupported",
      message: `omp ${shown} is a ${direction} major than the tested ${testedRange}: a major change can move or remove the ACP lane itself, which no capability probe covers`,
      detail: `Install omp ${testedRange}, or upgrade this adapter and its peerDependencies range.`,
    };
  }
  const tested = TESTED_OMP_MINORS.some(
    (m) => m.major === version.major && m.minor === version.minor,
  );
  if (!tested) {
    return {
      level: "warn",
      code: "omp_version_untested_minor",
      message: `omp ${shown} is outside the tested lines ${testedRange}; the capability checks below are what this adapter validates, so a missing surface appears as its own warning rather than as this one`,
      detail: `Tested: ${TESTED_OMP_MINORS.map((m) => `${m.major}.${m.minor}.x`).join(", ")}.`,
    };
  }
  return {
    level: "info",
    code: "omp_version",
    message: `probed '${command}' -> ${shown} (a tested minor)`,
  };
}

/**
 * Report the capability surfaces this build exposes. The per-capability
 * degradation text lives in `capabilities.ts` (one table, one owner), so this
 * only summarises what WAS found; the absent surfaces come back as their own
 * named warnings from `capabilityChecks`.
 */
export function evaluateCapabilitySummaryCheck(
  capabilities: Record<string, { state: string }>,
): AdapterEnvironmentCheck {
  const present = Object.entries(capabilities)
    .filter(([, capability]) => capability.state === "yes")
    .map(([id]) => id);
  return {
    level: "info",
    code: "omp_capabilities",
    message: `${present.length}/${Object.keys(capabilities).length} probed surfaces present: ${present.join(", ") || "none"}`,
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
  const parsedVersion = parseOmpVersion(versionOut);
  checks.push(evaluateOmpVersionCheck(parsedVersion, versionOut, bin));

  // 4. What this build actually supports (one cached, bounded probe pass).
  // The ACP handshake is part of it, so this replaces the separate probe and
  // its one-per-test throwaway session is now paid once per (command, env).
  const mode = resolveExecutionMode(config) ?? "engine";
  const capabilities = await loadCapabilities({
    acp: { command: bin, args: acpArgs, env: spawnEnv },
    mode,
    ...(mode === "managed" ? { worker: buildWorkerArgv(config, bridgePath) } : {}),
    version: parsedVersion === null
      ? null
      : `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}`,
    cacheDir: capabilityCacheDir(),
  });
  if (capabilities.acp.ok) {
    checks.push({
      level: "info",
      code: "acp_handshake_ok",
      message: capabilities.acp.configOptionIds.length > 0
        ? `ACP initialize+session/new OK (config options: ${capabilities.acp.configOptionIds.join(", ")})`
        : "ACP initialize+session/new OK (no config options advertised)",
      detail: capabilities.acp.currentModel ? `active model: ${capabilities.acp.currentModel}` : undefined,
    });
    checks.push(evaluateCapabilitySummaryCheck(capabilities.capabilities));
  } else {
    // The handshake is the one hard capability: without it no run can start.
    checks.push({
      level: "error",
      code: "acp_handshake_failed",
      message: "ACP handshake failed",
      detail: capabilities.acp.error,
    });
  }
  checks.push(...capabilityChecks(capabilities));

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
  // 8. provider-qualified model selectors (omp 18.14 resolves them exactly)
  if (providerQualifiedSelectors(config).length > 0) {
    const catalog = await listOmpModels({
      command: base[0],
      args: [...base.slice(1), "models", "ls", "--json"],
      env: spawnEnv,
    });
    const selectorCheck = evaluateModelSelectorCheck(config, catalog);
    if (selectorCheck) checks.push(selectorCheck);
  }
  // 9. OTLP export diagnostic (agent env overrides host env)
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
