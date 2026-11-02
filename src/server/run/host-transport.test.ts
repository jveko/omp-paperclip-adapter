import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import type { RunEventFrame } from "../../host/protocol.js";
import { relayEvent } from "./host-transport.js";

const TOOL_CALL_PAYLOAD = {
  phase: "tool_call",
  toolName: "bash",
  toolCallId: "call_1",
};

function frame(kind: string, payload: Record<string, unknown>): RunEventFrame {
  return {
    type: "run.event",
    runId: "run-1",
    seq: 1,
    at: "2026-11-01T00:00:00.000Z",
    kind: kind as RunEventFrame["kind"],
    payload,
  };
}

function sinks(): {
  ctx: AdapterExecutionContext;
  events: AdapterRuntimeEvent[];
  logs: Array<{ stream: string; chunk: string }>;
  usages: Array<Record<string, unknown>>;
} {
  const events: AdapterRuntimeEvent[] = [];
  const logs: Array<{ stream: string; chunk: string }> = [];
  const usages: Array<Record<string, unknown>> = [];
  const ctx = {
    onEvent: async (event: AdapterRuntimeEvent) => { events.push(event); },
    onLog: async (stream: "stdout" | "stderr", chunk: string) => { logs.push({ stream, chunk }); },
    onUsage: async (receipt: Record<string, unknown>) => { usages.push(receipt); },
  } as unknown as AdapterExecutionContext;
  return { ctx, events, logs, usages };
}

describe("relayEvent tool calls", () => {
  it("maps the host's tool event onto the adapter's omp.tool_call event", () => {
    const { ctx, events } = sinks();
    relayEvent(ctx, frame("omp.tool_call", TOOL_CALL_PAYLOAD));
    expect(events).toEqual([{
      eventType: "omp.tool_call",
      stream: "stdout",
      message: "bash",
      payload: TOOL_CALL_PAYLOAD,
    }]);
  });

  it("still accepts the retired acpx.tool_call spelling on the wire", () => {
    const { ctx, events } = sinks();
    relayEvent(ctx, frame("acpx.tool_call", TOOL_CALL_PAYLOAD));
    expect(events).toEqual([{
      eventType: "omp.tool_call",
      stream: "stdout",
      message: "bash",
      payload: TOOL_CALL_PAYLOAD,
    }]);
  });

  it("keeps the payload identical when the tool name is absent", () => {
    const { ctx, events } = sinks();
    const payload = { phase: "tool_result", toolCallId: null };
    relayEvent(ctx, frame("omp.tool_call", payload));
    expect(events).toEqual([{
      eventType: "omp.tool_call",
      stream: "stdout",
      payload,
    }]);
  });
});
