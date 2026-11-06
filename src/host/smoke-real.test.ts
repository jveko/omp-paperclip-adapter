import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type {
  AdapterExecutionResult, AdapterRuntimeEvent, TranscriptEntry,
} from "@paperclipai/adapter-utils";
import { HostClient } from "./client.js";
import { parseStdoutLine } from "../ui-parser.js";
import { readLedgerRecords, type LedgerRecord } from "./ledger.js";
import type {
  HostReply, RunAcceptedFrame, RunBeginFrame, RunSettledFrame,
} from "./protocol.js";
import { readDiscovery } from "./socket.js";
import { buildWorkerArgv } from "./worker.js";

/**
 * The real-`omp` smoke (`npm run smoke:real`, v0.19).
 *
 * Every other test in this lane speaks to a scripted fake that answers our
 * frames. This one starts the shipped supervisor binary and lets it drive a
 * real `omp --mode rpc` process through two managed turns, so the frame
 * vocabulary, the session open, the settle facts and the ledger are proven
 * against omp itself rather than against our own understanding of it.
 *
 * It costs real tokens and needs an authenticated omp, so it is skipped unless
 * `OMP_SMOKE_REAL=1`. `OMP_SMOKE_COMMAND` overrides the binary (default `omp`).
 *
 * What it deliberately does NOT do: install the Paperclip bridge. `manifests`
 * is all-null, so OMP_PAPERCLIP_MANIFEST_* is absent from the worker's env and
 * `resolveOmpAgentCommand` appends no `--extension`: nothing in the run needs
 * a Paperclip instance. The bridge half is LIVE-CHECK.md.
 */

const ENABLED = process.env.OMP_SMOKE_REAL === "1";
const OMP_COMMAND = process.env.OMP_SMOKE_COMMAND ?? "omp";

/** The whole scenario's budget; every wait is clamped to what is left of it. */
const HARD_DEADLINE_MS = 150_000;
const PREFLIGHT_MS = 10_000;
const CONNECT_MS = 10_000;
const ACCEPT_MS = 60_000;
const SETTLE_MS = 90_000;
const LEDGER_MS = 10_000;
const SHUTDOWN_MS = 10_000;

const HEARTBEAT_MS = 10_000;
const RUN_TIMEOUT_MS = 120_000;
const RUN_LEASE_TTL_MS = 60_000;
/** The previous run's session lease is released just after its `closed` record. */
const LEASE_RETRIES = 20;
const LEASE_RETRY_MS = 100;

const COMPANY_ID = "smoke-co";
const AGENT_ID = "smoke-agent";
const SESSION_KEY = `paperclip:${COMPANY_ID}:${AGENT_ID}:smoke`;
const PROMPT_1 = "Run the shell command `echo pong`, then reply with the single word: pong";
const PROMPT_2 = "reply with the single word: ping";

/** `OMP_SMOKE_SCOPE=profile` also proves the named-profile fence end to end. */
const SMOKE_SCOPE = process.env.OMP_SMOKE_SCOPE ?? "";
const profileName = SMOKE_SCOPE === "profile" ? `pc-smoke-${Date.now()}` : null;
const profileDir = profileName === null ? null : path.join(os.homedir(), ".omp", "profiles", profileName);

const hostScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../dist/omp-host.js",
);

interface Supervisor {
  rootDir: string;
  child: ChildProcess;
}

interface Turn {
  accepted: RunAcceptedFrame;
  settled: RunSettledFrame;
  /** Every event frame this connection saw, for the "explicitly unpriced" check. */
  events: HostReply[];
}

let tempHome: string | null = null;
let supervisor: Supervisor | null = null;
/** Set by the `it` before it rethrows: a failed run keeps its evidence on disk. */
let failed = false;

/**
 * The supervisor is a separate process with no event stream for its journal, so
 * waits here are real: a bounded poll against the platform clock, not fake time.
 */
async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

function remaining(budgetMs: number, deadlineAt: number): number {
  const left = deadlineAt - Date.now();
  if (left <= 0) throw new Error(`the smoke exceeded its ${HARD_DEADLINE_MS}ms budget`);
  return Math.max(250, Math.min(budgetMs, left));
}

/** `sh -lc` exactly as the supervisor launches the worker, so PATH matches. */
function runShell(command: string, timeoutMs: number): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("sh", ["-lc", `exec ${command}`], { encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) => {
    if (error === null) {
      resolve(stdout);
      return;
    }
    const detail = `${stderr}`.trim().split("\n").slice(-3).join(" | ");
    reject(new Error(
      `cannot run '${command}' through a login shell: ${detail === "" ? error.message : detail}. `
      + "The smoke needs a working, authenticated omp; set OMP_SMOKE_COMMAND to its absolute path.",
    ));
  });
  return promise;
}

async function startSupervisor(rootDir: string, home: string): Promise<void> {
  const child = spawn(process.execPath, [hostScript, "serve"], {
    detached: true,
    // The host's stderr is its only account of a boot failure; keep a tail for
    // the startup error. stdout is unused by `serve`.
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PAPERCLIP_HOME: home,
      PAPERCLIP_INSTANCE_ID: "smoke",
      // Long enough that the host and its warm worker cannot idle out between
      // the two turns; the smoke stops the host explicitly at the end.
      OMP_HOST_IDLE_MS: "600000",
      OMP_HOST_WORKER_IDLE_MS: "600000",
    },
  });
  // Recorded before the connect loop: a host that binds late (or not at all) is
  // still ours to stop, and `afterAll` must have the handle either way.
  supervisor = { rootDir, child };
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
  });
  const deadline = Date.now() + CONNECT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `the omp supervisor exited at startup (${child.exitCode ?? child.signalCode})`
        + `${stderrTail.trim() === "" ? "" : `: ${stderrTail.trim().split("\n").slice(-3).join(" | ")}`}`,
      );
    }
    try {
      const client = await HostClient.connect({ rootDir, connectTimeoutMs: 500 });
      client.close();
      return;
    } catch {
      await sleep(50);
    }
  }
  throw new Error(`the omp supervisor did not bind a socket within ${CONNECT_MS}ms (${rootDir})`);
}

async function pidGone(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function stopSupervisor(started: Supervisor): Promise<void> {
  const discovery = await readDiscovery(started.rootDir).catch(() => null);
  if (discovery !== null && !(await pidGone(discovery.pid))) {
    try {
      const control = await HostClient.connect({ rootDir: started.rootDir, connectTimeoutMs: 1_000 });
      control.send({ id: `shutdown-${Date.now()}`, type: "shutdown", reason: "smoke" });
      control.close();
    } catch {
      // Fall through to the signal: the host may already be draining.
    }
    const deadline = Date.now() + SHUTDOWN_MS;
    while (!(await pidGone(discovery.pid)) && Date.now() < deadline) await sleep(25);
    if (!(await pidGone(discovery.pid))) {
      try {
        process.kill(discovery.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  const deadline = Date.now() + 2_000;
  while (!started.child.killed && started.child.exitCode === null && Date.now() < deadline) {
    await sleep(25);
  }
}

function beginFrame(runId: string, options: {
  cwd: string;
  prompt: string;
  sessionId: string | null;
  argv: { command: string; args: string[] };
}): RunBeginFrame {
  const argvHash = createHash("sha256")
    .update([options.argv.command, ...options.argv.args].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return {
    id: `begin-${runId}`,
    type: "run.begin",
    runId,
    agent: { id: AGENT_ID, companyId: COMPANY_ID },
    sessionKey: SESSION_KEY,
    cwd: options.cwd,
    session: { ompSessionId: options.sessionId },
    cell: {
      argvHash,
      // The bridge is not installed in this smoke; its hash names that fact.
      bridgeHash: createHash("sha256").update("no-bridge").digest("hex").slice(0, 16),
      agentDir: null,
      model: null,
      thinking: null,
      approval: null,
    },
    worker: { command: options.argv.command, args: options.argv.args, env: {} },
    prompt: options.prompt,
    // Shape-valid placeholders: no bridge reads them, and they are never logged.
    credentials: {
      apiUrl: "http://127.0.0.1:9/smoke-unused",
      apiKey: "smoke-unused",
      companyId: COMPANY_ID,
      taskId: null,
      issueId: null,
    },
    manifests: { skills: null, governance: null, budget: null, failover: null, thinking: null },
    limits: { timeoutMs: RUN_TIMEOUT_MS, runLeaseTtlMs: RUN_LEASE_TTL_MS },
    subagentObservability: "summary",
  };
}

/** A settle that arrives before an accept is the begin's refusal; name it at once. */
function refusedMessage(runId: string, result: AdapterExecutionResult): string {
  return `${runId}: the supervisor never accepted the run — exitCode ${String(result.exitCode)}`
    + `${result.errorCode === undefined ? "" : ` (${result.errorCode})`}`
    + `${result.errorMessage === undefined ? "" : `: ${result.errorMessage}`}`
    + `; summary: ${result.summary ?? "(none)"}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const rejector = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    rejector.reject(new Error(`${label} within ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await Promise.race([promise, rejector.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A begin the supervisor refused before accepting. Distinct from a failed turn:
 * the run never started, and `refused` is terminal in the ledger, so a retry
 * must carry a new runId.
 */
class RefusedRunError extends Error {
  constructor(message: string, readonly errorCode: string) {
    super(message);
    this.name = "RefusedRunError";
  }
}

async function runTurn(client: HostClient, begin: RunBeginFrame, deadlineAt: number): Promise<Turn> {
  const events: HostReply[] = [];
  const accepted = Promise.withResolvers<RunAcceptedFrame>();
  const settled = Promise.withResolvers<RunSettledFrame>();
  let heartbeats = 0;
  const off = client.onFrame((frame) => {
    events.push(frame);
    if (frame.type === "run.accepted" && frame.runId === begin.runId) accepted.resolve(frame);
    if (frame.type === "run.settled" && frame.runId === begin.runId) settled.resolve(frame);
  });
  // Tighter than the adapter's own heartbeat cadence (its TTL / 3), so the 60s
  // run lease never lapses while the worker is still thinking.
  const timer = setInterval(() => {
    heartbeats += 1;
    try {
      client.send({ id: `hb-${begin.runId}-${heartbeats}`, type: "run.heartbeat", runId: begin.runId });
    } catch {
      // The connection is going away; the settle wait reports that.
    }
  }, HEARTBEAT_MS);
  const journalHint =
    ` (the supervisor's journal is at `
    + `${path.join(path.dirname(begin.cwd), "instances", "smoke", "omp-host", "ledger.jsonl")})`;
  function fail(message: string): never {
    throw new Error(message + journalHint);
  }
  try {
    client.send(begin);
    const first = await withTimeout(
      Promise.race([
        accepted.promise.then((frame) => ({ kind: "accepted" as const, frame })),
        settled.promise.then((frame) => ({ kind: "settled" as const, frame })),
      ]),
      remaining(ACCEPT_MS, deadlineAt),
      `${begin.runId}: the supervisor answered neither accept nor settle`,
    ).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
    if (first.kind === "settled") {
      throw new RefusedRunError(
        refusedMessage(begin.runId, first.frame.result) + journalHint,
        first.frame.result.errorCode ?? "",
      );
    }
    const acceptedFrame = first.frame;
    const settledFrame = await withTimeout(
      settled.promise,
      remaining(SETTLE_MS, deadlineAt),
      `${begin.runId}: accepted by pid ${acceptedFrame.worker.pid} but never settled`,
    ).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
    return { accepted: acceptedFrame, settled: settledFrame, events };
  } finally {
    clearInterval(timer);
    off();
  }
}

/**
 * Begin a run, retrying the one transient refusal: a second run can start in
 * the window between the supervisor journaling the previous run's `closed`
 * record and releasing its session lease (settle releases after it journals),
 * and `omp_session_lease_held` then names a lease that is about to disappear.
 * Every attempt needs a fresh runId, because `refused` is a terminal ledger
 * state.
 */
async function runTurnRetryingLease(
  client: HostClient,
  deadlineAt: number,
  label: string,
  beginFor: (runId: string) => RunBeginFrame,
): Promise<{ runId: string; turn: Turn }> {
  for (let attempt = 1; ; attempt += 1) {
    const runId = `${label}-${attempt}`;
    try {
      return { runId, turn: await runTurn(client, beginFor(runId), deadlineAt) };
    } catch (err) {
      const transient = err instanceof RefusedRunError && err.errorCode === "omp_session_lease_held";
      if (!transient || attempt >= LEASE_RETRIES) throw err;
      await sleep(LEASE_RETRY_MS);
    }
  }
}

/** A non-zero settle is a failure of the environment, not of the assertion; name it. */
function expectCompleted(turn: Turn, label: string): AdapterExecutionResult {
  const result = turn.settled.result;
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} settled with exitCode ${String(result.exitCode)}`
      + `${result.errorCode === undefined ? "" : ` (${result.errorCode})`}`
      + `${result.errorMessage === undefined ? "" : `: ${result.errorMessage}`}`
      + `; summary: ${result.summary ?? "(none)"}`,
    );
  }
  return result;
}

async function waitForRunState(
  rootDir: string,
  runId: string,
  state: "settled" | "closed",
  timeoutMs: number,
): Promise<LedgerRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = await readLedgerRecords(rootDir);
    if (records.some((record) => record.runId === runId && record.state === state)) return records;
    if (Date.now() > deadline) {
      const seen = records.filter((record) => record.runId === runId).map((record) => record.state);
      throw new Error(
        `the ledger never reached '${state}' for ${runId} within ${timeoutMs}ms (saw: ${seen.join(", ") || "nothing"})`,
      );
    }
    await sleep(50);
  }
}

function unpricedWarning(turn: Turn): string | null {
  for (const frame of turn.events) {
    if (frame.type !== "run.event" || frame.kind !== "run.system") continue;
    const message = frame.payload.message;
    if (typeof message === "string" && message.includes("usage is unknown")) return message;
  }
  return null;
}

/**
 * Render a turn's relayed events the way the adapter hands them to the board:
 * one `AdapterRuntimeEvent` JSON line per `run.event` frame, parsed with the
 * shipped `parseStdoutLine`. The `message` field mirrors the adapter relay's
 * choice per kind, so the parser sees exactly the shape production sends.
 */
function renderTranscript(turn: Turn): { lines: string[]; entries: TranscriptEntry[] } {
  const lines: string[] = [];
  const entries: TranscriptEntry[] = [];
  for (const frame of turn.events) {
    if (frame.type !== "run.event") continue;
    const payload = frame.payload;
    const message = typeof payload.text === "string"
      ? payload.text
      : typeof payload.message === "string"
        ? payload.message
        : typeof payload.toolName === "string"
          ? payload.toolName
          : undefined;
    const line = JSON.stringify({
      eventType: frame.kind,
      ...(message === undefined ? {} : { message }),
      payload,
    } satisfies AdapterRuntimeEvent);
    lines.push(line);
    entries.push(...parseStdoutLine(line, frame.at));
  }
  return { lines, entries };
}

/**
 * The scenario. Split from the `it` so a failure can be recorded before the
 * test unwinds: a failed run keeps its temp root, because the journal and the
 * worker's stderr are the evidence the operator needs.
 */
async function scenario(deadlineAt: number): Promise<void> {
  tempHome = await mkdtemp(path.join(os.tmpdir(), "omp-smoke-"));
  const home = tempHome;
  const work = path.join(home, "work");
  const rootDir = path.join(home, "instances", "smoke", "omp-host");
  await mkdir(work, { recursive: true, mode: 0o700 });

  const version = (await runShell(`${OMP_COMMAND} --version`, PREFLIGHT_MS)).trim().split("\n")[0] ?? "";
  await startSupervisor(rootDir, home);
  const argv = buildWorkerArgv({ command: OMP_COMMAND }, path.join(home, "no-bridge.js"));

  const run1Id = `smoke-${Date.now()}-1`;
  const first = await HostClient.connect({ rootDir, connectTimeoutMs: remaining(CONNECT_MS, deadlineAt) });
  let turn1: Turn;
  let turn2: Turn;
  let records: LedgerRecord[];
  try {
    turn1 = await runTurn(first, beginFrame(run1Id, {
      cwd: work, prompt: PROMPT_1, sessionId: null, argv,
    }), deadlineAt);
  } finally {
    first.close();
  }

  const result1 = expectCompleted(turn1, run1Id);
  // The accepted frame names the real worker process the supervisor spawned.
  expect(turn1.accepted.worker.pid, "run.accepted must name a live worker pid").toBeGreaterThan(0);
  // The worker answered its own capability frames after the session opened, so
  // no run has to warn about a surface it cannot see.
  // This run offers no connection tools, so the worker is never asked for
  // `set_host_tools`; unknown is the honest answer there, and it is an info
  // note, not a warning. The two frames the run does use must be present.
  const workerCapabilities = turn1.accepted.workerCapabilities;
  expect(workerCapabilities?.get_session_stats, "the live worker answers get_session_stats").toBe("yes");
  expect(workerCapabilities?.set_subagent_subscription, "the live worker answers set_subagent_subscription").toBe("yes");
  expect(workerCapabilities?.set_host_tools, "an unused frame is never reported as missing").not.toBe("no");
  expect(turn1.accepted.reusedWorker, "the first run cannot reuse a worker").toBe(false);
  expect(turn1.accepted.sessionOpening, "the first run opens a new session").toBe("new");
  // The reported path is the worker's stable pointer, not the run file: the
  // bridge re-reads it per call, and it is removed at settle.
  expect(turn1.accepted.runContextPath).toContain(`${path.sep}run-context${path.sep}`);
  expect(turn1.accepted.runContextPath.endsWith("current.json")).toBe(true);

  const resultJson1 = (result1.resultJson ?? {}) as Record<string, unknown>;
  expect(resultJson1.sessionSettled, "settlement is sessionSettled-driven, not timer-driven").toBe(true);
  expect(resultJson1.agentInvoked, "the model was invoked").toBe(true);
  expect(resultJson1.transport).toBe("host-rpc");
  const runtime1 = (resultJson1.hostRuntime ?? {}) as Record<string, unknown>;
  expect(runtime1.settledBy, "the turn settled on its own outcome").toBe("outcome");
  expect(runtime1.workerPid).toBe(turn1.accepted.worker.pid);
  // The provider bills cache hits as (cheap) input; omp reports them in
  // `cacheRead`, which the supervisor carries as `cachedInputTokens`. A prompt
  // that is entirely a cache hit still spent prompt tokens, so count both.
  const promptTokens = (result1.usage?.inputTokens ?? 0) + (result1.usage?.cachedInputTokens ?? 0);
  expect(promptTokens, "the run reports non-zero prompt tokens").toBeGreaterThan(0);
  expect(result1.usage?.outputTokens, "the run reports non-zero output tokens").toBeGreaterThan(0);
  expect(result1.summary?.toLowerCase(), "the model answered the prompt").toContain("pong");

  // The board's view of turn 1, reconstructed from the relayed frames. The
  // prompt forces a bash call, so the transcript must prove both halves of a
  // real turn (tool activity + the model's reply) and must never render a
  // lifecycle-only turn as a line.
  const transcript = renderTranscript(turn1);
  expect(
    transcript.entries.some((entry) => entry.kind === "assistant" && entry.text.toLowerCase().includes("pong")),
    "the transcript shows the model's pong reply",
  ).toBe(true);
  expect(
    transcript.entries.some((entry) => entry.kind === "tool_call"),
    "the transcript shows the required bash tool call",
  ).toBe(true);
  for (const line of transcript.lines) {
    expect(line, "a lifecycle-only turn never reaches the board").not.toContain('"event":');
  }
  console.log(`  transcript   ${transcript.entries
    .map((entry) => entry.kind === "assistant"
      ? `assistant "${entry.text.replace(/\s+/g, " ").slice(0, 60)}"`
      : entry.kind === "tool_call"
        ? `tool_call ${entry.name}`
        : null)
    .filter((row): row is string => row !== null)
    .join(" | ")}`);

  if (profileDir !== null) {
    await access(profileDir);
    console.log(`  profile      ${profileDir}`);
  }

  const cost1 = result1.costUsd;
  const unpriced1 = unpricedWarning(turn1);
  expect(
    typeof cost1 === "number" || unpriced1 !== null,
    "the run either prices itself or says the usage is unknown",
  ).toBe(true);

  // The settle record is the board's evidence; `agentInvoked` must be a fact.
  records = await waitForRunState(rootDir, run1Id, "settled", remaining(LEDGER_MS, deadlineAt));
  const settled1 = records.filter((record) => record.runId === run1Id && record.state === "settled");
  expect(settled1, "exactly one settled ledger record per run").toHaveLength(1);
  expect(settled1[0]?.detail?.agentInvoked, "the settled record says the model ran").toBe(true);
  expect(settled1[0]?.detail?.sessionSettled).toBe(true);
  expect(runtime1.ledgerSeq, "hostRuntime.ledgerSeq names the settle record").toBe(settled1[0]?.seq);
  const sessionFile = settled1[0]?.sessionFile;
  expect(typeof sessionFile, "the settled record names the omp session file").toBe("string");
  await access(sessionFile as string);
  const sessionId = result1.sessionId ?? "";
  expect(sessionId, "the run reports its omp session id").not.toBe("");

  // The lease and the closed record must land before a second run on the key.
  records = await waitForRunState(rootDir, run1Id, "closed", remaining(LEDGER_MS, deadlineAt));

  const second = await HostClient.connect({ rootDir, connectTimeoutMs: remaining(CONNECT_MS, deadlineAt) });
  let run2Id: string;
  try {
    const secondRun = await runTurnRetryingLease(second, deadlineAt, `smoke-${Date.now()}-2`, (runId) =>
      beginFrame(runId, { cwd: work, prompt: PROMPT_2, sessionId, argv }));
    turn2 = secondRun.turn;
    run2Id = secondRun.runId;
  } finally {
    second.close();
  }
  const result2 = expectCompleted(turn2, run2Id);

  // An unprobed surface is an info note (and only once per worker epoch); no
  // run may warn "could not be probed" about a worker that answered.
  for (const turn of [turn1, turn2]) {
    for (const frame of turn.events) {
      if (frame.type !== "run.event" || frame.kind !== "run.system") continue;
      expect(String(frame.payload.message ?? ""), "no unknown-probe warning").not.toContain("could not be probed");
    }
  }

  expect(turn2.accepted.reusedWorker, "the second run reuses the warm worker").toBe(true);
  expect(turn2.accepted.worker.pid, "a reused worker keeps its pid").toBe(turn1.accepted.worker.pid);
  expect(turn2.accepted.sessionOpening, "the second run opens the stored session, not a new one").toBe("open");
  expect(turn2.accepted.ompSessionId).toBe(sessionId);
  expect(result2.sessionId, "the second turn ran in the same omp session").toBe(sessionId);
  expect(result2.summary?.toLowerCase(), "the second turn answered its own prompt").toContain("ping");
  const runtime2 = ((result2.resultJson ?? {}) as Record<string, unknown>).hostRuntime as Record<string, unknown>;
  expect(runtime2.reusedWorker, "the settled runtime evidence names the reuse").toBe(true);

  records = await waitForRunState(rootDir, run2Id, "settled", remaining(LEDGER_MS, deadlineAt));
  const settled2 = records.filter((record) => record.runId === run2Id && record.state === "settled");
  expect(settled2, "the second run has its own settled record").toHaveLength(1);
  expect(settled2[0]?.detail?.agentInvoked).toBe(true);
  expect(settled2[0]?.sessionFile, "the second run kept the same session file").toBe(sessionFile);

  const cost2 = result2.costUsd;
  const price = (value: number | null | undefined): string =>
    value === null || value === undefined ? "unpriced (usage unknown)" : `$${value.toFixed(6)}`;
  console.log([
    "",
    `real omp smoke — ${version} via '${OMP_COMMAND}'`,
    `  supervisor   pid ${supervisor?.child.pid ?? "?"} root ${rootDir}`,
    `  run 1        pid ${turn1.accepted.worker.pid} new session ${sessionId}`,
    `               in ${result1.usage?.inputTokens ?? 0} tok (${result1.usage?.cachedInputTokens ?? 0} cached) · out ${result1.usage?.outputTokens ?? 0} tok · ${price(cost1)} · basis ${result1.usageBasis ?? "?"}`,
    `  run 2        pid ${turn2.accepted.worker.pid} reused · opening 'open' · same session`,
    `               in ${result2.usage?.inputTokens ?? 0} tok (${result2.usage?.cachedInputTokens ?? 0} cached) · out ${result2.usage?.outputTokens ?? 0} tok · ${price(cost2)} · basis ${result2.usageBasis ?? "?"}`,
    `  ledger       settled seq ${settled1[0]?.seq}/${settled2[0]?.seq} · agentInvoked true · sessionSettled true`,
    `  session      ${sessionFile ?? "(none)"}`,
    "",
  ].join("\n"));
}

describe.skipIf(!ENABLED)("real omp smoke", () => {
  it("runs two turns on a real omp worker and reuses it", { timeout: HARD_DEADLINE_MS + 60_000 }, async () => {
    try {
      await scenario(Date.now() + HARD_DEADLINE_MS);
    } catch (err) {
      failed = true;
      throw err;
    }
  });

  // The worst teardown (a host that ignores shutdown until the SIGKILL fallback)
  // is ~13s, past vitest's 10s default hook timeout.
  afterAll(async () => {
    if (supervisor !== null) await stopSupervisor(supervisor);
    if (tempHome === null) return;
    if (failed) {
      console.log(`\nleft ${tempHome} in place for inspection (ledger, run-context, discovery)\n`);
      return;
    }
    await rm(tempHome, { recursive: true, force: true });
  }, 30_000);
});
