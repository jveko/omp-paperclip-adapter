import { describe, expect, it, vi } from "vitest";
import { forkOmpSession, queryOmpSessions } from "./session-intel.js";

// Separate file from session-intel.test.ts: this one file-level mocks ./acp.js
// so we can assert the side-channel env is forwarded through to driveAcpSession,
// without disturbing the real-fake-acp tests that drive the actual subprocess.
const mocks = vi.hoisted(() => ({
  driveAcpSession: vi.fn(async () => ({
    ok: true,
    responses: [{ id: 2, result: { sessionId: "fork-1" } }],
  })),
}));

vi.mock("./acp.js", () => ({ driveAcpSession: mocks.driveAcpSession }));

describe("side-channel env forwarding", () => {
  it("forkOmpSession forwards env to driveAcpSession", async () => {
    mocks.driveAcpSession.mockClear();
    await forkOmpSession(
      { command: "omp", args: [], env: { OMP_AUTH_BROKER_URL: "http://b" } },
      "s",
      "/w",
    );
    expect(mocks.driveAcpSession).toHaveBeenCalledWith(
      expect.objectContaining({ env: { OMP_AUTH_BROKER_URL: "http://b" } }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("queryOmpSessions forwards env to driveAcpSession", async () => {
    mocks.driveAcpSession.mockClear();
    await queryOmpSessions(
      { command: "omp", args: [], env: { OMP_AUTH_BROKER_URL: "http://b" } },
    );
    expect(mocks.driveAcpSession).toHaveBeenCalledWith(
      expect.objectContaining({ env: { OMP_AUTH_BROKER_URL: "http://b" } }),
      expect.anything(),
      expect.anything(),
    );
  });
});
