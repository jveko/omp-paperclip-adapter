import net from "node:net";
import { encodeFrame, isHostFrame, parseFrame, type HostFrame, type HostReply } from "./protocol.js";
import { hostRootDir, readDiscovery } from "./socket.js";

/**
 * The adapter's (and the CLI's) side of the socket: connect to the discovery
 * record's socket, then speak frames. Reads only; run semantics live in
 * `server.ts` and the adapter's transport.
 */

export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostUnavailableError";
  }
}

export interface HostClientOptions {
  rootDir?: string;
  connectTimeoutMs?: number;
}

export class HostClient {
  readonly socketPath: string;
  private readonly socket: net.Socket;
  private readonly listeners = new Set<(frame: HostReply) => void>();
  private readonly frames: HostReply[] = [];
  private buffer = "";
  private closed = false;

  private constructor(socket: net.Socket, socketPath: string) {
    this.socket = socket;
    this.socketPath = socketPath;
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
    });
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const frame = parseFrame(line);
        if (frame !== null && !isHostFrame(frame)) {
          const reply = frame;
          this.frames.push(reply);
          if (this.frames.length > 1_000) this.frames.splice(0, this.frames.length - 1_000);
          for (const listener of this.listeners) listener(reply);
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  /** Connect to a running supervisor, or throw `HostUnavailableError`. */
  static async connect(options: HostClientOptions = {}): Promise<HostClient> {
    const rootDir = options.rootDir ?? hostRootDir();
    const discovery = await readDiscovery(rootDir);
    if (discovery === null) {
      throw new HostUnavailableError(`no omp-host is running for ${rootDir}`);
    }
    const client = await new Promise<HostClient>((resolve, reject) => {
      const socket = net.createConnection(discovery.socket);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new HostUnavailableError(`omp-host did not accept a connection on ${discovery.socket}`));
      }, options.connectTimeoutMs ?? 2_000);
      socket.once("connect", () => {
        clearTimeout(timeout);
        resolve(new HostClient(socket, discovery.socket));
      });
      socket.once("error", (err) => {
        clearTimeout(timeout);
        reject(new HostUnavailableError(`cannot reach omp-host on ${discovery.socket}: ${err.message}`));
      });
    });
    return client;
  }

  get alive(): boolean {
    return !this.closed;
  }

  send(frame: HostFrame): void {
    if (this.closed) throw new HostUnavailableError("the omp-host connection is closed");
    this.socket.write(encodeFrame(frame));
  }

  onFrame(listener: (frame: HostReply) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolve with the next (or already seen) matching reply. */
  waitFor(predicate: (frame: HostReply) => boolean, timeoutMs = 30_000): Promise<HostReply> {
    const seen = this.frames.find(predicate);
    if (seen !== undefined) return Promise.resolve(seen);
    if (this.closed) return Promise.reject(new HostUnavailableError("the omp-host connection is closed"));
    const result = Promise.withResolvers<HostReply>();
    const off = this.onFrame((frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      off();
      result.resolve(frame);
    });
    const timer = setTimeout(() => {
      off();
      result.reject(new HostUnavailableError(`omp-host did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    void new Promise<void>((resolve) => this.socket.once("close", resolve)).then(() => {
      clearTimeout(timer);
      off();
      result.reject(new HostUnavailableError("the omp-host connection closed before the reply"));
    });
    return result.promise;
  }

  close(): void {
    if (this.closed) return;
    this.socket.destroy();
  }
}
