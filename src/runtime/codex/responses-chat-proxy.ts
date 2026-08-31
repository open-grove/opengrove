import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { JsonObject, JsonValue } from "../../core.js";
import type { CodexModelProviderRuntimeConfig } from "./types.js";

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 37412;
const PROXY_ROUTE_PREFIX = "/opengrove/codex-responses-chat";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

type ChatProxyRegistration = {
  routeId: string;
  upstreamBaseUrl: string;
  apiKey: string;
  providerConfig: CodexModelProviderRuntimeConfig;
};

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
};

type ChatToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type ChatCompletionResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ChatToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

const registrations = new Map<string, ChatProxyRegistration>();
let serverStarted = false;
let serverStartError: string | undefined;

export function withCodexResponsesChatProxy(
  providerConfig: CodexModelProviderRuntimeConfig,
  input: {
    upstreamBaseUrl?: string;
    apiKey?: string;
  },
): CodexModelProviderRuntimeConfig {
  const upstreamBaseUrl = input.upstreamBaseUrl?.trim() || providerConfig.baseUrl;
  const apiKey = input.apiKey?.trim();
  if (!apiKey) return providerConfig;

  ensureProxyServer();
  const routeId = proxyRouteId(providerConfig.providerKey, upstreamBaseUrl, apiKey);
  registrations.set(routeId, {
    routeId,
    upstreamBaseUrl,
    apiKey,
    providerConfig,
  });

  return {
    ...providerConfig,
    baseUrl: `http://${PROXY_HOST}:${PROXY_PORT}${PROXY_ROUTE_PREFIX}/${routeId}`,
    wireApi: "responses",
  };
}

export function codexResponsesChatProxyStatus(): JsonObject {
  return {
    host: PROXY_HOST,
    port: PROXY_PORT,
    routePrefix: PROXY_ROUTE_PREFIX,
    started: serverStarted,
    error: serverStartError ?? null,
    registrations: registrations.size,
  };
}

function ensureProxyServer(): void {
  if (serverStarted) return;
  serverStarted = true;
  const server = createServer((req, res) => {
    void handleProxyRequest(req, res).catch((error) => {
      writeJson(res, 500, {
        error: {
          type: "opengrove_proxy_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });
  server.on("error", (error) => {
    serverStartError = error instanceof Error ? error.message : String(error);
  });
  server.listen(PROXY_PORT, PROXY_HOST);
  server.unref();
}

async function handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: { type: "method_not_allowed", message: "Only POST is supported." } });
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || `${PROXY_HOST}:${PROXY_PORT}`}`);
  const routeId = routeIdFromPath(url.pathname);
  const registration = routeId ? registrations.get(routeId) : undefined;
  if (!registration) {
    writeJson(res, 404, { error: { type: "not_found", message: "Unknown OpenGrove Codex proxy route." } });
    return;
  }

  const body = await readJsonBody(req);
  const chatRequest = responsesRequestToChatCompletions(body, registration.providerConfig);
  const upstreamResponse = await fetch(`${trimSlash(registration.upstreamBaseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${registration.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(chatRequest),
  });

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text();
    writeJson(res, upstreamResponse.status, {
      error: {
        type: "upstream_error",
        message: safeUpstreamError(text, upstreamResponse.statusText),
        status: upstreamResponse.status,
      },
    });
    return;
  }

  const chatJson = (await upstreamResponse.json()) as ChatCompletionResponse;
  const responseJson = chatCompletionToResponse(body, chatJson, registration.providerConfig);
  if (booleanValue((body as JsonObject).stream)) {
    writeResponsesStream(res, responseJson);
    return;
  }
  writeJson(res, 200, responseJson);
}

function responsesRequestToChatCompletions(
  body: JsonValue,
  providerConfig: CodexModelProviderRuntimeConfig,
): JsonObject {
  const source = objectValue(body);
  const messages = responsesInputToChatMessages(source.instructions, source.input);
  const chatRequest: JsonObject = {
    model: stringValue(source.model) || providerConfig.name,
    messages: messages as unknown as JsonValue,
    stream: false,
  };
  const maxTokens = numberValue(source.max_output_tokens ?? source.max_tokens);
  if (maxTokens !== undefined) chatRequest.max_tokens = maxTokens;
  const temperature = numberValue(source.temperature);
  if (temperature !== undefined) chatRequest.temperature = temperature;
  const topP = numberValue(source.top_p);
  if (topP !== undefined) chatRequest.top_p = topP;
  const tools = responsesToolsToChatTools(arrayValue(source.tools));
  if (tools.length) chatRequest.tools = tools as unknown as JsonValue;
  const toolChoice = chatToolChoice(source.tool_choice);
  if (toolChoice !== undefined) chatRequest.tool_choice = toolChoice as JsonValue;
  return chatRequest;
}

function responsesInputToChatMessages(instructions: unknown, input: unknown): ChatMessage[] {
  const messages: ChatMessage[] = [];
  appendInstructionMessages(messages, instructions);

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  for (const item of arrayValue(input)) {
    const object = objectValue(item);
    const type = stringValue(object.type);
    if (type === "function_call") {
      const name = stringValue(object.name);
      const callId =
        stringValue(object.call_id) || stringValue(object.id) || `call_${shortHash(JSON.stringify(object))}`;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name: name || "tool",
              arguments: stringValue(object.arguments) || "{}",
            },
          },
        ],
      });
      continue;
    }
    if (type === "function_call_output") {
      const callId = stringValue(object.call_id) || stringValue(object.id);
      messages.push({
        role: "tool",
        tool_call_id: callId || `call_${shortHash(JSON.stringify(object))}`,
        content: responseContentToText(object.output),
      });
      continue;
    }
    const role = chatRole(object.role);
    if (role) {
      messages.push({
        role,
        content: responseContentToText(object.content),
      });
    }
  }

  if (!messages.length) {
    messages.push({ role: "user", content: "" });
  }
  return messages;
}

function appendInstructionMessages(messages: ChatMessage[], instructions: unknown): void {
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions.trim() });
    return;
  }
  for (const item of arrayValue(instructions)) {
    const object = objectValue(item);
    const role = chatRole(object.role) || "system";
    messages.push({ role, content: responseContentToText(object.content) });
  }
}

function responsesToolsToChatTools(tools: JsonValue[]): JsonObject[] {
  const output: JsonObject[] = [];
  for (const toolValue of tools) {
    const tool = objectValue(toolValue);
    if (tool.type !== "function") continue;
    const name = stringValue(tool.name);
    if (!name) continue;
    output.push({
      type: "function",
      function: {
        name,
        description: stringValue(tool.description) || "",
        parameters: objectValue(tool.parameters),
        strict: booleanOrNull(tool.strict),
      },
    });
  }
  return output;
}

function chatToolChoice(input: unknown): JsonValue | undefined {
  if (input === "auto" || input === "none" || input === "required") return input;
  const object = objectValue(input);
  if (object.type === "function") {
    const name = stringValue(object.name);
    return name ? { type: "function", function: { name } } : undefined;
  }
  return undefined;
}

function chatCompletionToResponse(
  requestBody: JsonValue,
  chat: ChatCompletionResponse,
  providerConfig: CodexModelProviderRuntimeConfig,
): JsonObject {
  const request = objectValue(requestBody);
  const model = chat.model || stringValue(request.model) || providerConfig.name;
  const id = `resp_${shortHash(`${chat.id || randomUUID()}:${Date.now()}`)}`;
  const messageId = `msg_${shortHash(id)}`;
  const toolCalls = chat.choices?.[0]?.message?.tool_calls ?? [];
  const text = cleanAssistantText(chat.choices?.[0]?.message?.content ?? "");
  const output: JsonObject[] = toolCalls.length
    ? toolCalls.map((toolCall, index) => ({
        id: `fc_${shortHash(`${id}:${toolCall.id || index}`)}`,
        type: "function_call",
        call_id: toolCall.id || `call_${shortHash(`${id}:${index}`)}`,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments || "{}",
        status: "completed",
      }))
    : [
        {
          id: messageId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text,
              annotations: [],
              logprobs: [],
            },
          ],
        },
      ];

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: request.instructions === undefined ? null : (request.instructions as JsonValue),
    metadata: objectOrNull(request.metadata),
    model,
    output: output as unknown as JsonValue,
    output_text: text,
    parallel_tool_calls: booleanValue(request.parallel_tool_calls),
    temperature: numberOrNull(request.temperature),
    tool_choice: request.tool_choice === undefined ? "auto" : (request.tool_choice as JsonValue),
    tools: arrayValue(request.tools) as unknown as JsonValue,
    top_p: numberOrNull(request.top_p),
    usage: {
      input_tokens: chat.usage?.prompt_tokens ?? 0,
      output_tokens: chat.usage?.completion_tokens ?? 0,
      total_tokens: chat.usage?.total_tokens ?? 0,
    },
  };
}

function writeResponsesStream(res: ServerResponse, response: JsonObject): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  let sequence = 1;
  const output = arrayValue(response.output);
  sendSse(res, {
    type: "response.created",
    sequence_number: sequence++,
    response: { ...response, status: "in_progress", output: [] },
  });

  output.forEach((item, outputIndex) => {
    const outputItem = objectValue(item);
    sendSse(res, {
      type: "response.output_item.added",
      sequence_number: sequence++,
      output_index: outputIndex,
      item: { ...outputItem, status: "in_progress" },
    });
    if (outputItem.type === "function_call") {
      const itemId = stringValue(outputItem.id);
      const args = stringValue(outputItem.arguments) || "{}";
      if (args) {
        sendSse(res, {
          type: "response.function_call_arguments.delta",
          sequence_number: sequence++,
          output_index: outputIndex,
          item_id: itemId,
          delta: args,
        });
      }
      sendSse(res, {
        type: "response.function_call_arguments.done",
        sequence_number: sequence++,
        output_index: outputIndex,
        item_id: itemId,
        name: stringValue(outputItem.name),
        arguments: args,
      });
      sendSse(res, {
        type: "response.output_item.done",
        sequence_number: sequence++,
        output_index: outputIndex,
        item: outputItem,
      });
      return;
    }

    const content = arrayValue(outputItem.content);
    const firstContent = objectValue(content[0]);
    const text = stringValue(firstContent.text);
    const itemId = stringValue(outputItem.id);
    sendSse(res, {
      type: "response.content_part.added",
      sequence_number: sequence++,
      output_index: outputIndex,
      content_index: 0,
      item_id: itemId,
      part: {
        type: "output_text",
        text: "",
        annotations: [],
        logprobs: [],
      },
    });
    if (text) {
      sendSse(res, {
        type: "response.output_text.delta",
        sequence_number: sequence++,
        output_index: outputIndex,
        content_index: 0,
        item_id: itemId,
        delta: text,
        logprobs: [],
      });
    }
    sendSse(res, {
      type: "response.output_text.done",
      sequence_number: sequence++,
      output_index: outputIndex,
      content_index: 0,
      item_id: itemId,
      text,
      logprobs: [],
    });
    sendSse(res, {
      type: "response.content_part.done",
      sequence_number: sequence++,
      output_index: outputIndex,
      content_index: 0,
      item_id: itemId,
      part: firstContent,
    });
    sendSse(res, {
      type: "response.output_item.done",
      sequence_number: sequence++,
      output_index: outputIndex,
      item: outputItem,
    });
  });

  sendSse(res, {
    type: "response.completed",
    sequence_number: sequence++,
    response,
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function sendSse(res: ServerResponse, event: JsonObject): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function routeIdFromPath(pathname: string): string | undefined {
  const prefix = `${PROXY_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const suffix = pathname.slice(prefix.length);
  const [routeId, endpoint] = suffix.split("/");
  return endpoint === "responses" ? routeId : undefined;
}

function readJsonBody(req: IncomingMessage): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue);
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });
  });
}

function responseContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (typeof content === "number" || typeof content === "boolean") return String(content);
    return content == null ? "" : JSON.stringify(content);
  }
  const parts: string[] = [];
  for (const part of content) {
    const object = objectValue(part);
    const text = stringValue(object.text);
    if (text) {
      parts.push(text);
      continue;
    }
    if (object.type === "output_text" || object.type === "input_text") {
      parts.push(stringValue(object.text));
    }
  }
  return parts.join("\n");
}

function cleanAssistantText(text: string): string {
  return text.replace(/(?:<\|assistant\|>|<\/tool_call>)+\s*$/g, "").trimEnd();
}

function chatRole(input: unknown): ChatMessage["role"] | undefined {
  return input === "system" || input === "user" || input === "assistant" || input === "tool"
    ? input
    : input === "developer"
      ? "system"
      : undefined;
}

function writeJson(res: ServerResponse, status: number, body: JsonValue): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
}

function proxyRouteId(providerKey: string, upstreamBaseUrl: string, apiKey: string): string {
  return `${providerKey}_${shortHash(`${upstreamBaseUrl}:${apiKey}`)}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeUpstreamError(text: string, statusText: string): string {
  const trimmed = text.trim();
  if (!trimmed) return statusText || "Upstream provider request failed.";
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}...` : trimmed;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function objectOrNull(value: unknown): JsonValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function arrayValue(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return numberValue(value) ?? null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
