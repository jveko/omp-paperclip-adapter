import { describe, expect, it } from "vitest";
import { sessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";

/**
 * The engine's session codec decides which stored `sessionParams` survive a
 * round trip through Paperclip. Resume is a field comparison
 * (`isCompatibleSession`: configFingerprint, sessionKey, agent, mode, cwd,
 * remoteExecution) and the warm-borrow path additionally compares
 * `mcpFingerprint`, so a codec that dropped or invented any of them would
 * silently cold-start a resumable session — or reuse one it must not.
 *
 * 2026.1023.0 added `mcpFingerprint` and `interruptedCheckpoint` to the codec.
 * These assertions pin that the added fields round-trip and that nothing else
 * about the fingerprint inputs changed. Against the previous pin (2026.824.1)
 * the round-trip cases fail, which is exactly what the bump changed.
 */

/** What the engine writes (acpx-engine `buildSessionParams`) for a local run. */
const engineParams = {
  sessionKey: "paperclip:co-1:agent-1:t:abc123",
  runtimeSessionName: "runtime-session",
  acpxRecordId: "record-1",
  acpSessionId: "backend-session",
  agentSessionId: "agent-session",
  agent: "custom",
  cwd: "/workspace",
  mode: "persistent",
  stateDir: "/state",
  configFingerprint: "fingerprint-1",
  mcpFingerprint: "mcp-1",
};

describe("engine session codec", () => {
  it("round-trips every field the resume comparison reads", () => {
    const stored = sessionCodec.serialize(engineParams);
    expect(stored).toMatchObject({
      sessionKey: engineParams.sessionKey,
      acpSessionId: engineParams.acpSessionId,
      agent: engineParams.agent,
      cwd: engineParams.cwd,
      mode: engineParams.mode,
      configFingerprint: engineParams.configFingerprint,
    });
    expect(stored).not.toHaveProperty("remoteExecution");
    expect(sessionCodec.deserialize(stored)).toEqual(engineParams);
  });

  it("keeps the MCP fingerprint the warm-borrow path compares", () => {
    const back = sessionCodec.deserialize(sessionCodec.serialize(engineParams));
    expect(back?.mcpFingerprint).toBe("mcp-1");
  });

  it("keeps the interrupted-checkpoint marker and drops a false one", () => {
    const interrupted = sessionCodec.deserialize({ ...engineParams, interruptedCheckpoint: true });
    expect(interrupted?.interruptedCheckpoint).toBe(true);
    const clean = sessionCodec.deserialize({ ...engineParams, interruptedCheckpoint: false });
    expect(clean).not.toHaveProperty("interruptedCheckpoint");
  });

  it("does not invent the two new fields for a record written by the previous codec", () => {
    // A session stored before the bump carries neither key; reading it must
    // leave both absent so the resume decision is unchanged by the upgrade.
    const legacy = sessionCodec.deserialize({
      sessionKey: "paperclip:co-1:agent-1:t:abc123",
      acpSessionId: "backend-session",
      agent: "custom",
      cwd: "/workspace",
      mode: "persistent",
      configFingerprint: "fingerprint-1",
    });
    expect(legacy).not.toHaveProperty("mcpFingerprint");
    expect(legacy).not.toHaveProperty("interruptedCheckpoint");
  });

  it("keeps the display id precedence (runtime name, then ACP, then agent session)", () => {
    expect(sessionCodec.getDisplayId?.(engineParams)).toBe("runtime-session");
    expect(sessionCodec.getDisplayId?.({ ...engineParams, runtimeSessionName: "" })).toBe("backend-session");
    expect(sessionCodec.getDisplayId?.({ acpSessionId: null, agentSessionId: "agent-session" })).toBe("agent-session");
  });

  it("rejects a record with no session identity at all", () => {
    expect(sessionCodec.deserialize({ cwd: "/workspace" })).toBeNull();
  });
});
