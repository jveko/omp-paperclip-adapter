import { describe, expect, it } from "vitest";
import {
  SUBAGENT_EVENT_FRAME_CAP,
  SUBAGENT_ITEM_CAP,
  SUBAGENT_TEXT_CAP,
  buildSubagentSnapshot,
  readSubagentFrame,
  readSubagentSnapshot,
  rpcSubagentLevel,
  type SubagentObservation,
} from "./subagents.js";
import type { RpcFrame } from "./worker.js";

function lifecycle(payload: Record<string, unknown>): RpcFrame {
  return { type: "subagent_lifecycle", payload };
}

function progress(payload: Record<string, unknown>): RpcFrame {
  return { type: "subagent_progress", payload };
}

function event(payload: Record<string, unknown>): RpcFrame {
  return { type: "subagent_event", payload };
}

function observation(overrides: Partial<SubagentObservation>): SubagentObservation {
  return {
    id: "sa-1", index: 0, agent: "explore", status: "running",
    description: null, parentToolCallId: null, lastUpdate: 1,
    ...overrides,
  };
}

describe("rpcSubagentLevel", () => {
  it("maps the adapter's summary level onto omp's progress subscription", () => {
    expect(rpcSubagentLevel("summary")).toBe("progress");
    expect(rpcSubagentLevel("off")).toBe("off");
    expect(rpcSubagentLevel("events")).toBe("events");
  });
});

describe("readSubagentFrame", () => {
  it("reads a lifecycle frame and normalizes the started status", () => {
    const read = readSubagentFrame(lifecycle({
      id: "sa-1", index: 2, agent: "explore", agentSource: "bundled",
      status: "started", description: "read the config", parentToolCallId: "tc-1",
      sessionFile: "/tmp/transcript.json",
    }));
    expect(read).toEqual({
      id: "sa-1", index: 2, agent: "explore", status: "running",
      description: "read the config", parentToolCallId: "tc-1",
      event: null, summary: null,
    });
  });

  it("maps the terminal lifecycle statuses onto the summary's vocabulary", () => {
    expect(readSubagentFrame(lifecycle({ id: "a", index: 0, agent: "x", status: "completed" }))?.status)
      .toBe("completed");
    expect(readSubagentFrame(lifecycle({ id: "a", index: 0, agent: "x", status: "failed" }))?.status)
      .toBe("failed");
    expect(readSubagentFrame(lifecycle({ id: "a", index: 0, agent: "x", status: "aborted" }))?.status)
      .toBe("cancelled");
  });

  it("reads progress without copying the task, assignment or prompt text", () => {
    const read = readSubagentFrame(progress({
      index: 1, agent: "plan", task: "TASK-SENTINEL", assignment: "ASSIGNMENT-SENTINEL",
      progress: {
        id: "sa-2", index: 1, agent: "plan", status: "running",
        task: "PROMPT-SENTINEL", description: "drafting",
      },
      parentToolCallId: "tc-2",
    }));
    expect(read).toEqual({
      id: "sa-2", index: 1, agent: "plan", status: "running",
      description: "drafting", parentToolCallId: "tc-2",
      event: null, summary: null,
    });
    expect(JSON.stringify(read)).not.toContain("SENTINEL");
  });

  it("reads an event frame as its type and a tool-name summary only", () => {
    const read = readSubagentFrame(event({
      id: "sa-1",
      event: {
        type: "tool_execution_end", toolName: "read", isError: true,
        arguments: { path: "ARG-SENTINEL" }, text: "TRANSCRIPT-SENTINEL",
      },
    }));
    expect(read).toMatchObject({ id: "sa-1", index: null, agent: null, status: null });
    expect(read?.event).toBe("tool_execution_end");
    expect(read?.summary).toBe("tool_execution_end: read (error)");
    expect(JSON.stringify(read)).not.toContain("SENTINEL");
  });

  it("summarizes a message event by its type, never its text", () => {
    const read = readSubagentFrame(event({
      id: "sa-1", event: { type: "message_end", messageId: "m1", text: "TRANSCRIPT-SENTINEL" },
    }));
    expect(read?.event).toBe("message_end");
    expect(read?.summary).toBe("message_end");
    expect(JSON.stringify(read)).not.toContain("SENTINEL");
  });

  it("redacts credential shapes and caps every string", () => {
    const jwt = [
      Buffer.from('{"alg":"HS256"}').toString("base64url"),
      Buffer.from('{"sub":"sa-1"}').toString("base64url"),
      "signature",
    ].join(".");
    const read = readSubagentFrame(lifecycle({
      id: "sa-1", index: 0, agent: "explore", status: "started",
      description: `scan sk-live-ABCDEF1234567890 with Bearer abcdefghijklmnop then ${jwt}`,
    }));
    expect(read?.description).toBe("scan [redacted] with Bearer [redacted] then [redacted]");
    const long = readSubagentFrame(lifecycle({
      id: "sa-1", index: 0, agent: "explore", status: "started", description: "token ".repeat(80),
    }));
    expect(long?.description).toHaveLength(SUBAGENT_TEXT_CAP);
    expect(long?.description?.endsWith("…")).toBe(true);
  });

  it("rejects a frame with no usable id", () => {
    expect(readSubagentFrame(lifecycle({ status: "started" }))).toBeNull();
    expect(readSubagentFrame({ type: "message_end" })).toBeNull();
  });
});

describe("readSubagentSnapshot", () => {
  it("reads a get_subagents entry and keeps the roster fields out of it", () => {
    const read = readSubagentSnapshot({
      id: "sa-3", index: 2, agent: "task", status: "running",
      description: "keep working", parentToolCallId: "tc-3", lastUpdate: 42,
      task: "PROMPT-SENTINEL", assignment: "ASSIGNMENT-SENTINEL", progress: { task: "x" },
    });
    expect(read).toEqual({
      id: "sa-3", index: 2, agent: "task", status: "running",
      description: "keep working", parentToolCallId: "tc-3", lastUpdate: 42,
    });
    expect(JSON.stringify(read)).not.toContain("SENTINEL");
  });

  it("normalizes pending to running and aborted to cancelled", () => {
    expect(readSubagentSnapshot({ id: "a", index: 0, agent: "x", status: "pending" })?.status).toBe("running");
    expect(readSubagentSnapshot({ id: "a", index: 0, agent: "x", status: "aborted" })?.status).toBe("cancelled");
  });

  it("rejects a value without an id", () => {
    expect(readSubagentSnapshot({ index: 0, agent: "x", status: "running" })).toBeNull();
    expect(readSubagentSnapshot(null)).toBeNull();
  });
});

describe("buildSubagentSnapshot", () => {
  it("counts terminal observations and merges the still-running roster", () => {
    const summary = buildSubagentSnapshot(
      [
        observation({ id: "sa-1", index: 0, status: "completed" }),
        observation({ id: "sa-2", index: 1, status: "failed" }),
        observation({ id: "sa-3", index: 2, status: "cancelled" }),
        observation({ id: "sa-4", index: 3, status: "running" }),
      ],
      [observation({ id: "sa-4", index: 3, description: "still working" })],
    );
    expect(summary).toMatchObject({
      total: 4, completed: 1, failed: 1, cancelled: 1, running: 1,
    });
    expect(summary?.items.map((item) => item.id)).toEqual(["sa-1", "sa-2", "sa-3", "sa-4"]);
    expect(summary?.items[3].description).toBe("still working");
  });

  it("keeps a terminal observation terminal when the roster still lists it", () => {
    const summary = buildSubagentSnapshot(
      [observation({ id: "sa-1", status: "completed" })],
      [observation({ id: "sa-1", status: "running" })],
    );
    expect(summary).toMatchObject({ total: 1, completed: 1, running: 0 });
  });

  it("caps the item list while leaving the counts whole", () => {
    const observations = Array.from({ length: 60 }, (_, index) =>
      observation({ id: `sa-${index}`, index }));
    const summary = buildSubagentSnapshot(observations, []);
    expect(summary?.total).toBe(60);
    expect(summary?.running).toBe(60);
    expect(summary?.items).toHaveLength(SUBAGENT_ITEM_CAP);
  });

  it("returns null when the run saw no subagent at all", () => {
    expect(buildSubagentSnapshot([], [])).toBeNull();
  });
});

describe("caps", () => {
  it("bounds the per-run frame count below the 200-subagent fixture", () => {
    expect(SUBAGENT_EVENT_FRAME_CAP).toBeGreaterThan(0);
    expect(SUBAGENT_EVENT_FRAME_CAP).toBeLessThan(200);
  });
});
