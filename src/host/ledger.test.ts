import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LedgerInvariantError,
  RunLedger,
  findForbiddenLedgerKey,
  readLedgerRecords,
  type LedgerInput,
} from "./ledger.js";

function input(overrides: Partial<LedgerInput> = {}): LedgerInput {
  return {
    epoch: "host-1",
    runId: "run-1",
    companyId: "co-1",
    agentId: "agent-1",
    sessionKey: "sk-1",
    cwd: "/repo",
    state: "leased",
    ...overrides,
  };
}

describe("run ledger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "omp-ledger-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends JSONL with a monotonic seq and reads the last record per run", async () => {
    const ledger = await RunLedger.open(dir);
    await ledger.append(input({ state: "leased" }));
    await ledger.append(input({ state: "worker_ready" }));
    await ledger.append(input({ runId: "run-2", sessionKey: "sk-2", state: "leased" }));
    await ledger.append(input({ state: "prompting" }));
    await ledger.close();

    const records = await readLedgerRecords(dir);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(records.every((r) => r.at.length > 0)).toBe(true);
    const reopened = await RunLedger.open(dir);
    const snapshot = reopened.snapshot();
    expect(snapshot.get("run-1")?.state).toBe("prompting");
    expect(snapshot.get("run-2")?.state).toBe("leased");
    expect((await reopened.append(input({ state: "settled", cause: "clean", detail: { agentInvoked: true } }))).seq).toBe(5);
    await reopened.close();
  });

  it("compacts to the last record per run on open", async () => {
    const ledger = await RunLedger.open(dir);
    for (const state of ["leased", "worker_ready", "session_open", "prompting"] as const) {
      await ledger.append(input({ state }));
    }
    await ledger.append(input({ runId: "run-9", state: "leased" }));
    await ledger.close();
    expect((await readLedgerRecords(dir)).length).toBe(5);

    const compacted = await RunLedger.open(dir);
    await compacted.close();
    const after = await readLedgerRecords(dir);
    expect(after.map((r) => [r.runId, r.state])).toEqual([["run-1", "prompting"], ["run-9", "leased"]]);
    // Sequence continues from the compacted high-water mark, not from the file length.
    const again = await RunLedger.open(dir);
    expect((await again.append(input({ state: "settled", cause: "clean", detail: { agentInvoked: false } }))).seq).toBe(6);
    await again.close();
  });

  it("recovers a truncated tail line instead of failing to open", async () => {
    const ledger = await RunLedger.open(dir);
    await ledger.append(input({ state: "leased" }));
    await ledger.close();
    await writeFile(path.join(dir, "ledger.jsonl"), `${await readFile(path.join(dir, "ledger.jsonl"), "utf8")}{"v":1,"seq":9`, "utf8");
    const reopened = await RunLedger.open(dir);
    expect(reopened.snapshot().get("run-1")?.state).toBe("leased");
    await reopened.close();
  });

  it("refuses a second open prompting for one sessionKey", async () => {
    const ledger = await RunLedger.open(dir);
    await ledger.append(input({ state: "prompting" }));
    await expect(ledger.append(input({ runId: "run-2", state: "prompting" }))).rejects.toBeInstanceOf(LedgerInvariantError);
    // A different session is fine, and so is an explicit close of the first.
    await ledger.append(input({ runId: "run-2", sessionKey: "sk-2", state: "prompting" }));
    await ledger.append(input({ state: "lost", cause: "worker_exit" }));
    await ledger.append(input({ runId: "run-3", state: "prompting" }));
    await ledger.close();
  });

  it("requires a stop reason or cause and agentInvoked on a settled record", async () => {
    const ledger = await RunLedger.open(dir);
    await expect(ledger.append(input({ state: "settled" })))
      .rejects.toThrow(/stop reason/i);
    await expect(ledger.append(input({ state: "settled", cause: "clean" })))
      .rejects.toThrow(/agentInvoked/);
    await expect(ledger.append(input({ state: "settled", cause: "clean", detail: { agentInvoked: true } }))).resolves.toBeTruthy();
    await expect(ledger.append(input({ state: "settled", detail: { stopReason: "end_turn", agentInvoked: true } }))).resolves.toBeTruthy();
    await ledger.close();
  });

  it("refuses credentials, prompt text and tool arguments before writing", async () => {
    const ledger = await RunLedger.open(dir);
    await expect(ledger.append(input({ detail: { apiKey: "jwt-SENTINEL" } })))
      .rejects.toBeInstanceOf(LedgerInvariantError);
    await expect(ledger.append(input({ detail: { prompt: "do the thing" } })))
      .rejects.toBeInstanceOf(LedgerInvariantError);
    await expect(ledger.append(input({ usage: { arguments: {} } as never })))
      .rejects.toBeInstanceOf(LedgerInvariantError);
    const raw = await readFile(path.join(dir, "ledger.jsonl"), "utf8").catch(() => "");
    expect(raw).not.toContain("SENTINEL");
    expect(await readLedgerRecords(dir)).toEqual([]);
    await ledger.close();
  });

  it("assigns unique seqs to concurrent appends", async () => {
    const ledger = await RunLedger.open(dir);
    const records = await Promise.all([
      ledger.append(input({ runId: "run-a", sessionKey: "sk-a", state: "leased" })),
      ledger.append(input({ runId: "run-b", sessionKey: "sk-b", state: "leased" })),
      ledger.append(input({ runId: "run-c", sessionKey: "sk-c", state: "leased" })),
    ]);
    expect(new Set(records.map((record) => record.seq)).size).toBe(3);
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3]);
    await ledger.close();
  });

  it("refuses to append into a ledger another host replaced", async () => {
    const ledger = await RunLedger.open(dir);
    await ledger.append(input({ state: "leased" }));
    await ledger.append(input({ state: "worker_ready" }));
    // A second host compacts the two lines into one and renames a new inode
    // over the path this handle holds.
    const second = await RunLedger.open(dir);
    await second.append(input({ runId: "run-9", sessionKey: "sk-9", state: "leased" }));
    await second.close();
    await expect(ledger.append(input({ state: "worker_ready" }))).rejects.toThrow(/replaced/);
    await ledger.close();
  });

  it("detects forbidden keys at any depth", () => {
    expect(findForbiddenLedgerKey({ detail: { nested: [{ bearerToken: "x" }] } })).toBe("bearerToken");
    expect(findForbiddenLedgerKey({ detail: { stopReason: "end_turn" } })).toBeNull();
    expect(findForbiddenLedgerKey({ detail: { accessToken: "x" } })).toBe("accessToken");
    expect(findForbiddenLedgerKey({ usage: { routedModels: { "anthropic/claude": 2 } } })).toBeNull();
  });
});
