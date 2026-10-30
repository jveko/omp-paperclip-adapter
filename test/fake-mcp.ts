import http from "node:http";

/**
 * A tiny MCP "streamable HTTP" server for tests: `initialize`,
 * `notifications/initialized`, `tools/list` and `tools/call`. Records every
 * call's tool name, arguments and bearer so a test can prove which credentials
 * the supervisor used and that the worker never held them.
 */

export interface FakeMcpCall {
  tool: string;
  arguments: Record<string, unknown>;
  authorization: string | null;
}

export interface FakeMcpServer {
  url: string;
  calls: FakeMcpCall[];
  listCalls: number;
  close: () => Promise<void>;
}

export async function startFakeMcp(options: { sse?: boolean } = {}): Promise<FakeMcpServer> {
  const state = {
    calls: [] as FakeMcpCall[],
    listCalls: 0,
  };
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      let message: Record<string, unknown> = {};
      try {
        message = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        response.writeHead(400).end();
        return;
      }
      const id = message.id;
      const method = typeof message.method === "string" ? message.method : "";
      const reply = (result: unknown, status = 200) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id, result });
        if (options.sse === true) {
          response.writeHead(status, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "mcp-session-id": "sess-test",
          });
          response.end(`event: message\ndata: ${body}\n\n`);
          return;
        }
        response.writeHead(status, { "content-type": "application/json", "mcp-session-id": "sess-test" });
        response.end(body);
      };
      if (method === "initialize") {
        reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
        return;
      }
      if (method === "notifications/initialized") {
        response.writeHead(202, { "mcp-session-id": "sess-test" }).end();
        return;
      }
      if (method === "tools/list") {
        state.listCalls += 1;
        reply({
          tools: [
            {
              name: "connections_search",
              description: "Search connections",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
            {
              name: "connection_request",
              description: "Request a connection",
              inputSchema: { type: "object", properties: { target: { type: "string" } } },
            },
          ],
        });
        return;
      }
      if (method === "tools/call") {
        const params = typeof message.params === "object" && message.params !== null
          ? message.params as Record<string, unknown>
          : {};
        state.calls.push({
          tool: typeof params.name === "string" ? params.name : "",
          arguments: typeof params.arguments === "object" && params.arguments !== null
            ? params.arguments as Record<string, unknown>
            : {},
          authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : null,
        });
        reply({
          content: [{ type: "text", text: `2 connections match ${String((params.arguments as Record<string, unknown> | undefined)?.query ?? "?")}` }],
        });
        return;
      }
      response.writeHead(404).end();
    });
  });
  const listening = Promise.withResolvers<number>();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    listening.resolve(typeof address === "object" && address !== null ? address.port : 0);
  });
  const port = await listening.promise;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls: state.calls,
    get listCalls() {
      return state.listCalls;
    },
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}
