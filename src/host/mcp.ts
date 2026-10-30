/**
 * The minimal MCP client the supervisor needs for the run's connection tools.
 *
 * Paperclip hands a run one MCP endpoint and a run-scoped bearer; the supervisor
 * is the MCP client (`tools/list`, `tools/call`), so the bearer lives in this
 * process and never in the omp worker. Transport: MCP "streamable HTTP" — one
 * POST per JSON-RPC message with `Accept: application/json, text/event-stream`,
 * a `Mcp-Session-Id` header after `initialize`, and a response body that is
 * either plain JSON or an SSE stream carrying the matching response event.
 *
 * No dependency: `fetch`, `AbortSignal.timeout` and `JSON.parse` are enough for
 * the three methods used here.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  /** Text parts joined; the omp host-tool result carries these as content. */
  text: string;
  isError: boolean;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

const PROTOCOL_VERSION = "2024-11-05";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The response object carried by an SSE body, matched on the request id. */
function responseFromSse(body: string, id: number): JsonRpcResponse | null {
  const events: string[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data !== "") events.push(data);
  }
  for (const event of events) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event);
    } catch {
      continue;
    }
    if (isRecord(parsed) && parsed.id === id && ("result" in parsed || "error" in parsed)) {
      return parsed;
    }
  }
  return null;
}

export class McpHttpClient {
  private readonly endpoint: string;
  private readonly bearer: string;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private nextId = 0;

  constructor(input: { endpoint: string; bearer: string; timeoutMs?: number }) {
    this.endpoint = input.endpoint;
    this.bearer = input.bearer;
    this.timeoutMs = input.timeoutMs ?? 10_000;
  }

  private async post(message: Record<string, unknown>): Promise<{ response: Response; body: string }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.bearer}`,
    };
    if (this.sessionId !== null) headers["mcp-session-id"] = this.sessionId;
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const session = response.headers.get("mcp-session-id");
    if (session !== null && session !== "") this.sessionId = session;
    return { response, body: await response.text().catch(() => "") };
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.nextId += 1;
    const id = this.nextId;
    const { response, body } = await this.post({ jsonrpc: "2.0", id, method, params });
    if (!response.ok) {
      throw new Error(`MCP ${method} HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    let parsed: JsonRpcResponse | null;
    if (contentType.includes("text/event-stream")) {
      parsed = responseFromSse(body, id);
    } else {
      const value: unknown = body === "" ? null : JSON.parse(body);
      parsed = isRecord(value) ? value : null;
    }
    if (parsed === null) throw new Error(`MCP ${method} returned no response`);
    if (parsed.error !== undefined) {
      const message = isRecord(parsed.error) && typeof parsed.error.message === "string"
        ? parsed.error.message
        : JSON.stringify(parsed.error);
      throw new Error(`MCP ${method} failed: ${message}`);
    }
    return parsed.result;
  }

  /** `initialize` + the `notifications/initialized` notification. */
  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "omp-host", version: "0.12.0" },
    });
    const { response, body } = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    if (!response.ok) {
      throw new Error(`MCP notifications/initialized HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request("tools/list", {});
    if (!isRecord(result) || !Array.isArray(result.tools)) return [];
    const tools: McpToolDefinition[] = [];
    for (const entry of result.tools) {
      if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") continue;
      tools.push({
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : entry.name,
        inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : { type: "object", properties: {} },
      });
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    if (!isRecord(result)) return { text: "", isError: false };
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .filter((value) => value !== "")
      .join("\n");
    return { text, isError: result.isError === true };
  }
}
