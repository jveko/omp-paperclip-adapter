import { describe, expect, it, vi } from "vitest";
import { forkOmpSession, queryOmpSessions } from "./session-intel.js";

// Separate file from session-intel.test.ts: this one file-level mocks the ACP
// client so we can assert the side-channel env is forwarded through to
// driveAcpSession, without disturbing the real-fake-acp tests that drive the
// actual subprocess.
const mocks = vi.hoisted(() => ({
  driveAcpSession: vi.fn(async () => ({
    ok: true,
    responses: [{ id: 2, result: { sessions: [] } }],
  })),
}));

vi.mock("./adapters/acp/client.js", () => ({ driveAcpSession: mocks.driveAcpSession }));

describe("side-channel env forwarding", () => {
  it("forkOmpSession forwards env to driveAcpSession", async () => {
    mocks.driveAcpSession.mockClear();
    await forkOmpSession(
      { command: "omp", args: [], env: { OMP_AUTH_BROKER_URL: "http://b" } },
      "s",
      "/w",
    );
    // The side channel's env is the contract; the request list and the
    // paging callback are the caller's business.
    expect(mocks.driveAcpSession).toHaveBeenCalled();
    expect(mocks.driveAcpSession.mock.calls[0][0]).toMatchObject({
      env: { OMP_AUTH_BROKER_URL: "http://b" },
    });
  });

  it("queryOmpSessions forwards env to driveAcpSession", async () => {
    mocks.driveAcpSession.mockClear();
    await queryOmpSessions(
      { command: "omp", args: [], env: { OMP_AUTH_BROKER_URL: "http://b" } },
      { cwd: "/w" },
    );
    // The side channel's env is the contract; the request list and the
    // paging callback are the caller's business.
    expect(mocks.driveAcpSession).toHaveBeenCalled();
    expect(mocks.driveAcpSession.mock.calls[0][0]).toMatchObject({
      env: { OMP_AUTH_BROKER_URL: "http://b" },
    });
  });
});
