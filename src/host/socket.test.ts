import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDiscovery,
  ensureHostDir,
  hostDiscoveryPath,
  hostRootDir,
  isDiscoveryStale,
  readDiscovery,
  readProcessStartIdentity,
  socketPathFor,
  writeDiscovery,
  type HostDiscovery,
} from "./socket.js";

describe("host socket placement", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "omp-host-socket-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-host");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("keeps the host dir under the instance root with 0700", async () => {
    await ensureHostDir();
    expect(hostRootDir()).toBe(path.join(home, "instances", "test-host", "omp-host"));
    expect((await stat(hostRootDir())).mode & 0o777).toBe(0o700);
  });

  it("names the socket after the token and writes discovery 0600 atomically", async () => {
    await ensureHostDir();
    const discovery: HostDiscovery = {
      v: 1,
      socket: socketPathFor("abc123"),
      token: "abc123",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      startIdentity: await readProcessStartIdentity(process.pid),
      epoch: "host-1",
      version: "0.12.0",
    };
    await writeDiscovery(discovery);
    expect((await stat(hostDiscoveryPath())).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(hostDiscoveryPath(), "utf8"))).toMatchObject({ token: "abc123" });
    expect(socketPathFor("abc123").endsWith("host-abc123.sock")).toBe(true);
    expect(await readDiscovery()).toEqual(discovery);
    await clearDiscovery();
    expect(await readDiscovery()).toBeNull();
  });

  it("reads an identity per pid and treats a dead pid as stale", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid as number;
    try {
      const first = await readProcessStartIdentity(pid);
      const second = await readProcessStartIdentity(pid);
      expect(first).not.toBeNull();
      expect(first).toBe(second);
      const discovery: HostDiscovery = {
        v: 1, socket: socketPathFor("t"), token: "t", pid, startedAt: "x",
        startIdentity: first, epoch: "e", version: "v",
      };
      expect(isDiscoveryStale(discovery, null)).toBe(false);
      // A reused pid (identity mismatch) is stale even while the new process lives.
      expect(isDiscoveryStale(discovery, "linux:not-the-same")).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
    const closed = Promise.withResolvers<void>();
    child.once("close", () => closed.resolve());
    await closed.promise;
    expect(await readProcessStartIdentity(pid)).toBeNull();
  });

  it("treats a corrupt discovery file as absent", async () => {
    await ensureHostDir();
    await writeFile(hostDiscoveryPath(), "{not json", "utf8");
    expect(await readDiscovery()).toBeNull();
  });
});
