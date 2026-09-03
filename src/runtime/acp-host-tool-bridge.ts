import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentHostToolScope } from "../core.js";
import type { HostToolBridge, HostToolDescriptor } from "./host-tool-bridge.js";

const MCP_SERVER_MODULE_PATH = fileURLToPath(new URL("./acp-host-tool-mcp-server.js", import.meta.url));
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface AcpHostToolSessionBinding {
  fingerprint: string;
  mcpServer: {
    type: "stdio";
    name: "opengrove";
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
  };
  activate(bridge: HostToolBridge): void;
  deactivate(bridge: HostToolBridge): void;
}

export interface AcpHostToolBridgeProvider {
  prepare(input: { scope: AgentHostToolScope; bridge: HostToolBridge }): Promise<AcpHostToolSessionBinding>;
  close(): void;
}

export class AcpHostToolBridgeUnavailableError extends Error {
  readonly code: string;

  constructor(cause: unknown) {
    const code = readErrorCode(cause) ?? "UNKNOWN";
    super(
      "OpenGrove Host Tools could not start a local connection. Restart OpenGrove and allow " +
        `127.0.0.1 connections in firewall or endpoint security settings. (${code})`,
      { cause },
    );
    this.name = "AcpHostToolBridgeUnavailableError";
    this.code = code;
  }
}

interface StoredBinding {
  token: string;
  fingerprint: string;
  tools: HostToolDescriptor[];
  activeBridge?: HostToolBridge;
}

export class AcpHostToolBridgeServer implements AcpHostToolBridgeProvider {
  private server?: HttpServer;
  private endpoint = "";
  private readonly bindingsByFingerprint = new Map<string, StoredBinding>();
  private readonly bindingsByToken = new Map<string, StoredBinding>();

  async prepare(input: { scope: AgentHostToolScope; bridge: HostToolBridge }): Promise<AcpHostToolSessionBinding> {
    try {
      await this.ensureListening();
    } catch (error) {
      throw error instanceof AcpHostToolBridgeUnavailableError ? error : new AcpHostToolBridgeUnavailableError(error);
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          sessionId: input.scope.sessionId,
          employeeId: input.scope.employeeId ?? "",
          roomId: input.scope.roomId ?? "",
          tools: input.bridge.fingerprint,
        }),
      )
      .digest("hex");
    let stored = this.bindingsByFingerprint.get(fingerprint);
    if (!stored) {
      const created: StoredBinding = {
        token: `acphost_${randomBytes(32).toString("base64url")}`,
        fingerprint,
        tools: input.bridge.descriptors.map((descriptor) => ({
          name: descriptor.name,
          description: descriptor.description,
          inputSchema: descriptor.inputSchema,
          annotations: descriptor.annotations,
          liveness: descriptor.liveness,
        })),
      };
      this.bindingsByFingerprint.set(fingerprint, created);
      this.bindingsByToken.set(created.token, created);
      stored = created;
    }
    const binding: StoredBinding = stored;
    return {
      fingerprint,
      mcpServer: {
        type: "stdio",
        name: "opengrove",
        command: process.execPath,
        args: [MCP_SERVER_MODULE_PATH],
        env: [
          ...(process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === "1"
            ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }]
            : []),
          { name: "OPENGROVE_ACP_HOST_TOOL_ENDPOINT", value: this.endpoint },
          { name: "OPENGROVE_ACP_HOST_TOOL_TOKEN", value: binding.token },
        ],
      },
      activate(bridge) {
        if (binding.activeBridge && binding.activeBridge !== bridge) {
          throw new Error("acp_host_tool_session_already_active");
        }
        binding.activeBridge = bridge;
      },
      deactivate(bridge) {
        if (binding.activeBridge === bridge) {
          binding.activeBridge = undefined;
        }
      },
    };
  }

  close(): void {
    this.bindingsByFingerprint.clear();
    this.bindingsByToken.clear();
    this.server?.close();
    this.server = undefined;
    this.endpoint = "";
  }

  private async ensureListening(): Promise<void> {
    if (this.server?.listening && this.endpoint) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        sendJson(response, 500, { error: "acp_host_tool_bridge_failed" });
      });
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("acp_host_tool_bridge_address_unavailable");
    }
    server.unref();
    this.server = server;
    this.endpoint = `http://127.0.0.1:${address.port}`;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const binding = this.bindingForRequest(request);
    if (!binding) {
      sendJson(response, 403, { error: "acp_host_tool_capability_invalid" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/tools") {
      sendJson(response, 200, { tools: binding.tools });
      return;
    }
    if (request.method === "POST" && url.pathname === "/call") {
      if (!binding.activeBridge) {
        sendJson(response, 409, { error: "acp_host_tool_run_not_active" });
        return;
      }
      const body = await readJsonBody(request).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
      if ("error" in body) {
        sendJson(response, 400, body);
        return;
      }
      const name = typeof body.name === "string" ? body.name : "";
      const callId =
        typeof body.callId === "string" && body.callId.trim()
          ? body.callId
          : `acp-host-tool-${randomBytes(12).toString("base64url")}`;
      const result: CallToolResult = await binding.activeBridge.call(name, body.arguments ?? {}, callId);
      sendJson(response, 200, result);
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  private bindingForRequest(request: IncomingMessage): StoredBinding | undefined {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    const token = /^Bearer\s+(.+)$/iu.exec(authorization ?? "")?.[1]?.trim();
    return token ? this.bindingsByToken.get(token) : undefined;
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request_body_invalid");
  }
  return value as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
