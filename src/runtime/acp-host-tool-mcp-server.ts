import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const endpoint = process.env.OPENGROVE_ACP_HOST_TOOL_ENDPOINT?.trim().replace(/\/+$/, "");
const token = process.env.OPENGROVE_ACP_HOST_TOOL_TOKEN?.trim();
if (!endpoint || !token) {
  throw new Error("OpenGrove ACP Host Tool MCP bridge configuration is missing.");
}

const server = new Server({ name: "opengrove", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return await bridgeRequest<{ tools: Tool[] }>("/tools", { method: "GET" });
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return await bridgeRequest<CallToolResult>("/call", {
    method: "POST",
    body: JSON.stringify({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
      callId: `acp-mcp-${randomUUID()}`,
    }),
  });
});

await server.connect(new StdioServerTransport());

async function bridgeRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    signal: AbortSignal.timeout(900_000),
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const payload = (await response.json().catch(() => undefined)) as T | { error?: unknown } | undefined;
  if (!response.ok || !payload) {
    const error =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `http_${response.status}`;
    throw new Error(`OpenGrove Host Tool bridge failed: ${error}`);
  }
  return payload as T;
}
