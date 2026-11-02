import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { HostClient } from "../src/host/client.js";
import { readDiscovery } from "../src/host/socket.js";
import { materializeProfile } from "./profiles.js";

/**
 * The managed lane's fixture: one throwaway `PAPERCLIP_HOME` per test, a
 * per-test instance id (a scenario may pin its own supervisor knobs through the
 * env the spawned host inherits), and the scripted `omp --mode rpc` build the
 * REAL `dist/omp-host.js` binary drives.
 *
 * The suite is sequential (`fileParallelism: false`) and every scenario owns
 * its instance, so a supervisor one scenario started cannot serve the next
 * one's run.
 */

/** The shipped supervisor, built by `test/global-setup.ts`. */
export const hostScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../dist/omp-host.js",
);

export interface ConformanceEnv {
  home: string;
  instanceId: string;
  instanceRoot: string;
  /** `<instance>/omp-host`: discovery, socket and ledger live here. */
  hostRoot: string;
  /** Fake worker dirs `managedWorker` materialized; fixture-owned. */
  workerDirs: string[];
  /** Kill this instance's supervisor, unstub its env and remove its dirs. */
  dispose(): Promise<void>;
}

/** A fake worker's call log and usage baseline, when a scenario needs them. */
export interface WorkerFiles {
  stats?: string;
  log?: string;
}

export async function conformanceEnv(instanceId: string): Promise<ConformanceEnv> {
  // Short paths on purpose: a Unix socket path is capped at 108 bytes, and the
  // supervisor's socket lives under PAPERCLIP_HOME/instances/<id>/omp-host.
  const home = await mkdtemp(path.join(os.tmpdir(), "ompcf-"));
  const instanceRoot = path.join(home, "instances", instanceId);
  const hostRoot = path.join(instanceRoot, "omp-host");
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", instanceId);
  // The spawned host inherits this env and drains by itself after the run.
  vi.stubEnv("OMP_HOST_IDLE_MS", "400");
  vi.stubEnv("OMP_HOST_WORKER_IDLE_MS", "400");
  const workerDirs: string[] = [];
  return {
    home,
    instanceId,
    instanceRoot,
    hostRoot,
    workerDirs,
    async dispose() {
      vi.unstubAllEnvs();
      try {
        await killSupervisor(hostRoot);
      } finally {
        await rm(home, { recursive: true, force: true });
        for (const dir of workerDirs.splice(0)) await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** SIGKILL this instance's supervisor and wait until its pid is gone. */
export async function killSupervisor(hostRoot: string): Promise<void> {
  const discovery = await readDiscovery(hostRoot);
  if (discovery === null) return;
  try {
    process.kill(discovery.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  // A signal is delivered asynchronously: the next connect must not race the
  // dying host into a connection the kill then tears down.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(discovery.pid, 0);
    } catch {
      return;
    }
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 25);
    await tick.promise;
  }
  throw new Error(`the omp supervisor (pid ${discovery.pid}) did not exit after SIGKILL`);
}

/**
 * Start the supervisor the way the adapter does (`serve`, detached, inherited
 * env) and return a connected client. For scenarios that drive the wire
 * protocol directly instead of through the adapter.
 */
export async function startSupervisor(hostRoot: string): Promise<HostClient> {
  const child = spawn(process.execPath, [hostScript, "serve"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // A binary that dies at boot never binds: fail on the exit, not the clock.
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the omp supervisor exited at startup (${child.exitCode ?? child.signalCode})`);
    }
    try {
      return await HostClient.connect({ rootDir: hostRoot, connectTimeoutMs: 1_000 });
    } catch {
      // The host may still be binding its socket.
    }
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 50);
    await tick.promise;
  }
  throw new Error(`the omp supervisor did not start within 10000ms (${hostRoot})`);
}

/**
 * Materialize the managed profile and return an adapter config whose
 * `command` is that build. The worker reads `FAKE_RPC_MODE` from the run env.
 */
export async function managedWorker(
  env: ConformanceEnv,
  rpcMode: string,
  files: WorkerFiles = {},
): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omp-conformance-worker-"));
  env.workerDirs.push(dir);
  const build = await materializeProfile(dir, {
    name: "managed",
    commandName: "omp",
    version: "18.14.0",
    settingsKeys: ["session.maxCost", "tools.restrictedFolders", "defaultThinkingLevel"],
    topVerbs: ["acp", "config", "gc", "models", "session"],
    modelsVerbs: ["ls", "refresh"],
    sessionVerbs: ["lease"],
    rpcMode,
    expectedDiagnostics: [],
  });
  return {
    command: build.script,
    env: {
      FAKE_RPC_MODE: rpcMode,
      ...(files.stats === undefined ? {} : { FAKE_RPC_STATS: files.stats }),
      ...(files.log === undefined ? {} : { FAKE_RPC_LOG: files.log }),
    },
  };
}

export function ctx(
  config: Record<string, unknown>,
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  return {
    runId: `run-${Math.random().toString(16).slice(2)}`,
    agent: { id: "agent-1", companyId: "co-1", name: "A", adapterType: "omp_local", adapterConfig: null },
    runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: "task" },
    config,
    context: {},
    onLog: async () => {},
    onEvent: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}
