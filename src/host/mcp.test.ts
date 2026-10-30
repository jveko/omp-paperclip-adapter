import { describe, expect, it } from "vitest";
import { startFakeMcp } from "../../test/fake-mcp.js";
import { McpHttpClient } from "./mcp.js";

describe("mcp http client", () => {
  it("initializes, lists tools and calls one with the run's bearer", async () => {
    const server = await startFakeMcp();
    try {
      const client = new McpHttpClient({ endpoint: server.url, bearer: "ct-SENTINEL" });
      await client.initialize();
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["connections_search", "connection_request"]);
      expect(tools[0].inputSchema).toMatchObject({ type: "object" });
      const result = await client.callTool("connections_search", { query: "acme" });
      expect(result).toEqual({ text: "2 connections match acme", isError: false });
      expect(server.calls).toEqual([
        { tool: "connections_search", arguments: { query: "acme" }, authorization: "Bearer ct-SENTINEL" },
      ]);
    } finally {
      await server.close();
    }
  });

  it("reads a response carried by an SSE stream", async () => {
    const server = await startFakeMcp({ sse: true });
    try {
      const client = new McpHttpClient({ endpoint: server.url, bearer: "ct-1" });
      await client.initialize();
      expect((await client.listTools()).length).toBe(2);
      const result = await client.callTool("connection_request", { target: "slack" });
      expect(result.text).toContain("2 connections match");
    } finally {
      await server.close();
    }
  });

  it("surfaces a transport failure instead of hanging", async () => {
    const client = new McpHttpClient({ endpoint: "http://127.0.0.1:1/mcp", bearer: "ct", timeoutMs: 500 });
    await expect(client.initialize()).rejects.toThrow();
  });
});
