import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "../src/server/acp.js";
import { readLedgerRecords, type LedgerRecord } from "../src/host/ledger.js";
import type { RunBeginFrame } from "../src/host/protocol.js";
import { startFakeMcp } from "../test/fake-mcp.js";
import {
  conformanceEnv, ctx, killSupervisor, managedWorker, startSupervisor, type ConformanceEnv,
} from "./managed-harness.js";

/**
 * The supervisor's invariants, on the shipped binary: the adapter (or the wire
 * client) spawns the REAL `dist/omp-host.js`, which drives a scripted
 * `omp --mode rpc` worker. No Paperclip instance, no network.
 *
 * Each scenario asserts what the caller can observe — the settled result and
 * the run ledger — never a log line:
 * - one run per session key, refused `omp_session_lease_held`, one `prompting`;
 * - `maxWorkers` refusal with `omp_host_capacity`, the incumbent still settles;
 * - a killed worker is reconciled once (`lost`/`worker_exit`), never re-settled,
 *   and the next run spawns a fresh worker;
 * - a caller that stops heartbeating is aborted, then killed, one `adapter_gone`;
 * - a worker without `set_host_tools`/`get_session_stats` degrades with a named
 *   diagnostic instead of failing or hanging.
 */

let env: ConformanceEnv;

beforeEach(async () => {
  env = await conformanceEnv("cf");
});

afterEach(async () => {
  await env.dispose();
});

function recordsFor(records: LedgerRecord[], runId: string): LedgerRecord[] {
  return records.filter((record) => record.runId === runId);
}

describe("supervisor invariants", () => {
  it("refuses an overlapping run on one session key: omp_session_lease_held, one prompting record", async () => {
    const config = await managedWorker(env, "hang");
    const run = createOmpAcpExecutor();
    const abort = new AbortController();
    const first = run(ctx(config, { runId: "run-lease-first", signal: abort.signal }));

    await vi.waitFor(async () => {
      const records = await readLedgerRecords(env.hostRoot);
      expect(records.filter((record) => record.state === "prompting")).toHaveLength(1);
    }, { timeout: 5_000, interval: 25 });

    // Same agent, same task key: the supervisor's per-sessionKey lease is held.
    const refused = await run(ctx(config, { runId: "run-lease-second" }));
    expect(refused).toMatchObject({ exitCode: 1, errorCode: "omp_session_lease_held" });
    expect(refused.errorMessage).toContain("holds this session's lease");

    abort.abort();
    const settled = await first;
    expect(settled.exitCode).toBe(1);
    expect(settled.resultJson).toMatchObject({ status: "aborted", transport: "host-rpc" });

    const records = await readLedgerRecords(env.hostRoot);
    expect(records.filter((record) => record.state === "prompting")).toHaveLength(1);
    expect(records.filter((record) => record.state === "refused").map((record) => record.cause))
      .toEqual(["lease_held"]);
    expect(recordsFor(records, "run-lease-first").filter((record) => record.state === "settled"))
      .toHaveLength(1);
    expect(recordsFor(records, "run-lease-second").map((record) => record.state))
      .toEqual(["refused"]);
  }, 30_000);

  it("refuses a second concurrent run when maxWorkers is 1: omp_host_capacity, the first still settles", async () => {
    vi.stubEnv("OMP_HOST_MAX_WORKERS", "1");
    const config = await managedWorker(env, "hang");
    const run = createOmpAcpExecutor();
    const abort = new AbortController();
    const first = run(ctx(config, { runId: "run-capacity-first", signal: abort.signal }));

    await vi.waitFor(async () => {
      const records = await readLedgerRecords(env.hostRoot);
      expect(records.filter((record) => record.state === "prompting")).toHaveLength(1);
    }, { timeout: 5_000, interval: 25 });

    // A different agent needs its own worker, and the single slot has none idle.
    const refused = await run(ctx(config, {
      runId: "run-capacity-second",
      agent: { id: "agent-2", companyId: "co-1", name: "B", adapterType: "omp_local", adapterConfig: null },
    }));
    expect(refused).toMatchObject({ exitCode: 1, errorCode: "omp_host_capacity" });
    expect(refused.errorMessage).toContain("max 1");

    abort.abort();
    const settled = await first;
    expect(settled.exitCode).toBe(1);

    // The settle frame is broadcast before the supervisor journals its final
    // `closed` record, so poll for the terminal state instead of racing it.
    const records = await vi.waitFor(async () => {
      const records = await readLedgerRecords(env.hostRoot);
      expect(recordsFor(records, "run-capacity-first").map((record) => record.state))
        .toEqual(["leased", "worker_ready", "session_open", "prompting", "settled", "closed"]);
      return records;
    }, { timeout: 5_000, interval: 25 });
    const refusedRecords = recordsFor(records, "run-capacity-second");
    // The refused run held the lease first, then lost the worker slot.
    expect(refusedRecords.map((record) => record.state)).toEqual(["leased", "refused"]);
    expect(refusedRecords[1].cause).toBe("capacity");
  }, 30_000);

  it("reconciles a killed worker: one lost/worker_exit, no duplicate settle, the next run spawns fresh", async () => {
    const config = await managedWorker(env, "hang");
    const run = createOmpAcpExecutor();
    const spawned = Promise.withResolvers<number>();
    const killed = run(ctx(config, {
      runId: "run-reconcile-first",
      onSpawn: async (meta) => { spawned.resolve(meta.pid); },
    }));

    const workerPid = await spawned.promise;
    process.kill(workerPid, "SIGKILL");

    const result = await killed;
    expect(result).toMatchObject({ exitCode: 1, errorCode: "omp_host_worker_exit" });
    expect(result.resultJson).toMatchObject({
      hostRuntime: { settledBy: "worker_exit", cause: "worker_exit" },
    });

    // The settle frame precedes the supervisor's final `closed` record; wait
    // for it so the SIGKILL below cannot land mid-journal.
    const beforeRestart = await vi.waitFor(async () => {
      const records = recordsFor(await readLedgerRecords(env.hostRoot), "run-reconcile-first");
      expect(records.filter((record) => record.state === "closed")).toHaveLength(1);
      return records;
    }, { timeout: 5_000, interval: 25 });
    expect(beforeRestart.filter((record) => record.state === "lost").map((record) => record.cause))
      .toEqual(["worker_exit"]);
    expect(beforeRestart.filter((record) => record.state === "settled")).toHaveLength(0);

    // Restarting the supervisor reconciles the ledger: the run is already
    // terminal, so it is not settled (or lost) a second time.
    await killSupervisor(env.hostRoot);
    // A fresh worker build that settles: `hang` would never finish the run.
    const freshConfig = await managedWorker(env, "");
    const next = await run(ctx(freshConfig, { runId: "run-reconcile-second" }));
    expect(next).toMatchObject({ exitCode: 0 });
    expect(next.resultJson?.workerPid).not.toBe(workerPid);
    expect(next.resultJson).toMatchObject({ hostRuntime: { reusedWorker: false } });

    const records = await readLedgerRecords(env.hostRoot);
    const afterRestart = recordsFor(records, "run-reconcile-first");
    // Compaction keeps one record per run: the closed record with the cause.
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0]).toMatchObject({ state: "closed", cause: "worker_exit" });
    expect(recordsFor(records, "run-reconcile-second").filter((record) => record.state === "settled"))
      .toHaveLength(1);
  }, 30_000);

  it("reclaims a run whose caller stops heartbeating: abort, then kill, one adapter_gone cause", async () => {
    const logFile = path.join(env.home, "lease-ttl.log");
    const config = await managedWorker(env, "deaf", { log: logFile });
    // This scenario spawns the host itself (not through the adapter's connect
    // loop), so it must not idle out between listen and the first connect on a
    // slow machine. The test's own bound is the 300 ms lease TTL below.
    vi.stubEnv("OMP_HOST_IDLE_MS", "30000");
    const client = await startSupervisor(env.hostRoot);
    try {
      client.send({ id: "hello-ttl", type: "hello", v: 1, instanceId: "conformance", adapterVersion: "0.18.0" });
      await client.waitFor((frame) => frame.type === "hello_ok", 5_000);
      const begin: RunBeginFrame = {
        id: "begin-ttl",
        type: "run.begin",
        runId: "run-ttl",
        agent: { id: "agent-ttl", companyId: "co-1" },
        sessionKey: "paperclip:co-1:agent-ttl:task",
        cwd: env.home,
        session: { ompSessionId: null },
        cell: { argvHash: "conformance", bridgeHash: "conformance", agentDir: null, profile: null, model: null, thinking: null, approval: null },
        worker: {
          command: config.command as string,
          args: ["--mode", "rpc"],
          env: config.env as Record<string, string>,
        },
        prompt: "conformance lease probe",
        credentials: {
          apiUrl: "http://127.0.0.1:1", apiKey: "conformance-not-a-secret",
          companyId: "co-1", taskId: null, issueId: null,
        },
        manifests: { skills: null, governance: null, budget: null, failover: null, thinking: null },
        // Never heartbeated: the first window aborts, the second kills.
        limits: { timeoutMs: null, runLeaseTtlMs: 300 },
      };
      client.send(begin);
      const accepted = await client.waitFor(
        (frame) => frame.type === "run.accepted" && frame.runId === "run-ttl",
        5_000,
      );
      expect(accepted.type).toBe("run.accepted");
      if (accepted.type !== "run.accepted") throw new Error("unreachable");
      // The accepted frame carries what the run's own worker answered for the
      // managed frames it was asked: the two it served are `yes`; host tools
      // were never requested, so the row stays `unknown` rather than `no`.
      const capabilities = accepted.workerCapabilities;
      expect(Object.keys(capabilities ?? {}).sort())
        .toEqual(["get_session_stats", "set_host_tools", "set_subagent_subscription"]);
      for (const state of Object.values(capabilities ?? {})) {
        expect(["yes", "no", "unknown"]).toContain(state);
      }
      expect(capabilities?.get_session_stats).toBe("yes");
      expect(capabilities?.set_subagent_subscription).toBe("yes");
      expect(capabilities?.set_host_tools).toBe("unknown");
      const workerPid = accepted.worker.pid;

      const settled = await client.waitFor(
        (frame) => frame.type === "run.settled" && frame.runId === "run-ttl",
        10_000,
      );
      expect(settled.type).toBe("run.settled");
      if (settled.type !== "run.settled") throw new Error("unreachable");
      expect(settled.result.exitCode).toBe(1);
      expect(settled.result.resultJson).toMatchObject({
        hostRuntime: { settledBy: "lease", cause: "adapter_gone" },
      });

      await vi.waitFor(() => {
        expect(() => process.kill(workerPid, 0)).toThrow();
      }, { timeout: 5_000, interval: 25 });

      const records = await readLedgerRecords(env.hostRoot);
      expect(records.filter((record) => record.state === "lost").map((record) => record.cause))
        .toEqual(["adapter_gone"]);
      // The first missed window aborted the prompt before the second killed it.
      const frames = (await readFile(logFile, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string });
      expect(frames.filter((frame) => frame.type === "abort")).toHaveLength(1);
    } finally {
      client.close();
    }
  }, 30_000);

  it("degrades on a capability-less worker: named diagnostics, the run still settles", async () => {
    const logFile = path.join(env.home, "norpc.log");
    const config = await managedWorker(env, "norpc", { log: logFile });
    const mcp = await startFakeMcp();
    try {
      const events: AdapterRuntimeEvent[] = [];
      const result = await createOmpAcpExecutor()(ctx(config, {
        runId: "run-norpc",
        // Connection tools force the supervisor's set_host_tools call; the fake
        // MCP endpoint only answers tools/list, so the failure is the worker's.
        runtimeTools: {
          version: 1,
          guidance: "Connection tools",
          mcpEndpoint: mcp.url,
          rest: { connectionsSearch: `${mcp.url}/search`, connectionRequest: `${mcp.url}/request` },
          bearerToken: "ct-conformance",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          tools: ["connections_search", "connection_request"],
        },
        onEvent: async (event: AdapterRuntimeEvent) => { events.push(event); },
      } as never));
      expect(result.exitCode).toBe(0);
      // No stats at settle means no usage claim, not zero usage.
      expect(result.usage).toBeUndefined();

      const warnings = events
        .filter((event) => event.level === "warn")
        .map((event) => event.message ?? "");
      expect(warnings.some((message) =>
        message.includes("omp connection tools are unavailable this run")
        && message.includes("Unknown command: set_host_tools"))).toBe(true);
      expect(warnings.some((message) => message.includes("this run's usage is unknown"))).toBe(true);
      expect(warnings.some((message) => message.includes("subagent observability is unavailable"))).toBe(true);
      // The accepted frame's observations name the managed surfaces the
      // worker refused, independent of the supervisor's per-request warnings.
      expect(warnings.some((message) =>
        message.includes("get_session_stats") && message.includes("usage receipt"))).toBe(true);
      expect(events.some((event) => event.level === "warn"
        && event.payload?.code === "omp_rpc_subagent_subscription_missing"
        && (event.message ?? "").includes("subagent subscription"))).toBe(true);

      // The settle frame precedes the supervisor's final `closed` record.
      const ledger = await vi.waitFor(async () => {
        const ledger = await readLedgerRecords(env.hostRoot);
        expect(recordsFor(ledger, "run-norpc").map((record) => record.state))
          .toEqual(["leased", "worker_ready", "session_open", "prompting", "settled", "closed"]);
        return ledger;
      }, { timeout: 5_000, interval: 25 });
      const settled = recordsFor(ledger, "run-norpc").find((record) => record.state === "settled");
      // A run with no usage evidence journals none.
      expect(settled?.usage).toBeUndefined();
      expect(mcp.calls).toHaveLength(0);
    } finally {
      await mcp.close();
    }
  }, 30_000);
});
