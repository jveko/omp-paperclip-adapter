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
import { parseOmpVersion, probeOmpAcpSession, resolveOmpAgentCommand } from "./acp.js";
import { ompEnv } from "./omp-env.js";

function run(command: string, args: string[], timeoutMs: number, env?: Record<string, string>): Promise<string> {
  return new Promise<string>((resolve) => {
    execFile(command, args, { timeout: timeoutMs, env: env ? { ...process.env, ...env } : undefined },
      (_err, stdout) => resolve(String(stdout ?? "")));
  });
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
  // resolved command with a trailing `acp` stripped, so a multi-token wrapper
  // (e.g. `mise x omp -- acp`) probes as `mise x omp -- --version`.
  const base = tokens[tokens.length - 1] === "acp" ? tokens.slice(0, -1) : tokens;

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
  const version = parseOmpVersion(versionOut);
  if (version) {
    checks.push({
      level: "info",
      code: "omp_version",
      message: `probed '${bin}' -> ${version.major}.${version.minor}.${version.patch} (wrapper commands report their own version)`,
    });
  } else {
    checks.push({
      level: "warn",
      code: "omp_version_unparsed",
      message: "could not parse --version output",
      detail: versionOut.slice(0, 200),
    });
  }

  // 4. ACP handshake + active model detection
  const probe = await probeOmpAcpSession({ command: bin, args: acpArgs, env: spawnEnv });
  if (probe.ok) {
    checks.push({
      level: "info",
      code: "acp_handshake_ok",
      message: "ACP initialize+session/new OK",
      detail: probe.currentModel ? `active model: ${probe.currentModel}` : undefined,
    });
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
