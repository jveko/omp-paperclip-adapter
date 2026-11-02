import { spawn } from "node:child_process";
import { chmod, chown, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "./client.js";
import {
  HostSocketSecurityError,
  acquireHostLock,
  checkSocketSecurity,
  clearDiscovery,
  ensureHostDir,
  ensureHostDirIn,
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

  it("treats a zombie process as gone", async () => {
    // `sleep 30` replaces the shell (keeping its pid) and never reaps its
    // background `sleep 0.1`; that child stays a zombie in /proc until the
    // parent dies. Without the state check, stop() polls it for its full 10 s.
    const parent = spawn("/bin/sh", ["-c", "sleep 0.1 & echo $!; exec sleep 30"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = Promise.withResolvers<string>();
    let output = "";
    parent.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline >= 0) line.resolve(output.slice(0, newline).trim());
    });
    try {
      const pid = Number(await line.promise);
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(async () => {
        expect(await readProcessStartIdentity(pid)).toBeNull();
      }, { timeout: 5_000, interval: 25 });
      // The entry still exists and says 'Z': this is the zombie case, not a
      // vanished pid (which the old null-on-unreadable path already handled).
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      expect(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0]).toBe("Z");
    } finally {
      parent.kill("SIGKILL");
    }
  });

  it("treats a corrupt discovery file as absent", async () => {
    await ensureHostDir();
    await writeFile(hostDiscoveryPath(), "{not json", "utf8");
    expect(await readDiscovery()).toBeNull();
  });
});

describe("host lock", () => {
  it("refuses a second lock for the same instance and reclaims a stale one", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "omp-host-lock-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test-lock");
    try {
      const lock = await acquireHostLock();
      await expect(acquireHostLock()).rejects.toThrow(/another omp-host/);
      await lock.release();
      const again = await acquireHostLock();
      await again.release();
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("host socket security", () => {
  let dir: string;
  let socket: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "omp-host-sec-"));
    await chmod(dir, 0o700);
    socket = path.join(dir, "host-abc123.sock");
    // A plain file stands in for the socket: the check is a stat, not a dial.
    await writeFile(socket, "");
    await chmod(socket, 0o600);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts a 0600 socket in a 0700 directory", async () => {
    expect(process.getuid?.() ?? -1).toBeGreaterThanOrEqual(0);
    expect(await checkSocketSecurity(socket, dir)).toEqual({
      mode: 0o600,
      dirMode: 0o700,
      uid: process.getuid?.() ?? 0,
    });
  });

  it("refuses a socket wider than 0600 by name", async () => {
    await chmod(socket, 0o644);
    const failure = checkSocketSecurity(socket, dir);
    await expect(failure).rejects.toBeInstanceOf(HostSocketSecurityError);
    await expect(failure).rejects.toThrow(/mode 0644 is wider than 0600/);
    // The named error carries the evidence an operator needs.
    await expect(failure).rejects.toMatchObject({ name: "HostSocketSecurityError", mode: 0o644 });
  });

  it("refuses a directory wider than 0700", async () => {
    await chmod(dir, 0o755);
    await expect(checkSocketSecurity(socket, dir)).rejects.toThrow(/mode 0755 is wider than 0700/);
  });

  // chown to a foreign uid needs root; without it the kernel refuses the call.
  const asRoot = process.getuid?.() === 0;
  it.skipIf(!asRoot)("refuses a socket owned by another uid", async () => {
    await chown(socket, 65534, 65534);
    await expect(checkSocketSecurity(socket, dir)).rejects.toBeInstanceOf(HostSocketSecurityError);
    await expect(checkSocketSecurity(socket, dir)).rejects.toThrow(/owned by uid 65534/);
  });

  it("refuses a widened socket through HostClient.connect", async () => {
    // A full instance root: the connect path reads discovery, then the socket.
    const root = path.join(dir, "omp-host");
    await ensureHostDirIn(root);
    const real = path.join(root, "host-abc123.sock");
    await writeFile(real, "");
    await chmod(real, 0o644);
    await writeDiscovery({
      v: 1,
      socket: real,
      token: "abc123",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      startIdentity: await readProcessStartIdentity(process.pid),
      epoch: "host-sec",
      version: "0.15.0",
    }, root);
    await expect(HostClient.connect({ rootDir: root })).rejects.toBeInstanceOf(HostSocketSecurityError);
    await expect(HostClient.connect({ rootDir: root })).rejects.toThrow(/wider than 0600/);
  });
});
