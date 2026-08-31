import {
  createSdkMcpServer,
  tool as sdkTool,
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type McpServerConfig,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { type AgentEvent, type AgentTurnRequest, type ApprovalKind, type JsonObject, type JsonValue } from "../core.js";
import type { AsyncEventQueue } from "./codex/async-event-queue.js";
import { asJsonValue, isJsonObject, readString, truncateText } from "./codex/json.js";
import { createHostToolBridge } from "./host-tool-bridge.js";

export const CLAUDE_OPENGROVE_MCP_SERVER = "opengrove";
export const CLAUDE_NATIVE_APPROVAL_TIMEOUT_MS = 120_000;

type ZodSchema = z.ZodType<unknown>;
type ZodShape = Record<string, ZodSchema>;

export interface ClaudeSdkHostBridge {
  mcpServers: Record<string, McpServerConfig>;
  canUseTool: CanUseTool;
  onElicitation(request: ElicitationRequest, options: { signal: AbortSignal }): Promise<ElicitationResult>;
  isOpenGroveMcpToolName(toolName: string): boolean;
  fingerprint: string;
  exposedToolIds: string[];
}

export function createClaudeSdkHostBridge(
  request: AgentTurnRequest,
  runId: string,
  queue: AsyncEventQueue<AgentEvent>,
): ClaudeSdkHostBridge {
  const hostTools = createHostToolBridge(request, runId, queue, "claude-code");
  const sdkToolNames = new Set<string>();
  let hostToolCallSequence = 0;
  const sdkTools = hostTools.descriptors.map((descriptor) => {
    sdkToolNames.add(descriptor.name);
    return sdkTool(
      descriptor.name,
      descriptor.description,
      jsonSchemaToZodShape(descriptor.inputSchema),
      async (args) => hostTools.call(descriptor.name, args, `${runId}:host-tool:${++hostToolCallSequence}`),
      { annotations: descriptor.annotations },
    );
  });
  const mcpServers: Record<string, McpServerConfig> = {
    [CLAUDE_OPENGROVE_MCP_SERVER]: createSdkMcpServer({
      name: CLAUDE_OPENGROVE_MCP_SERVER,
      version: "0.0.0",
      tools: sdkTools,
    }),
  };

  const bridge: ClaudeSdkHostBridge = {
    mcpServers,
    canUseTool: async (toolName, input, options) => {
      if (bridge.isOpenGroveMcpToolName(toolName)) {
        return { behavior: "allow", toolUseID: options.toolUseID };
      }
      return handleClaudeNativeToolPermission(toolName, input, {
        request,
        runId,
        queue,
        signal: options.signal,
        title: options.title,
        displayName: options.displayName,
        description: options.description,
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
        suggestions: options.suggestions,
        toolUseID: options.toolUseID,
        agentID: options.agentID,
      });
    },
    onElicitation: (elicitation, options) =>
      handleClaudeElicitation(elicitation, {
        request,
        runId,
        queue,
        signal: options.signal,
      }),
    isOpenGroveMcpToolName(toolName) {
      const normalized = String(toolName || "");
      return (
        sdkToolNames.has(normalized) ||
        normalized.startsWith(`mcp__${CLAUDE_OPENGROVE_MCP_SERVER}__`) ||
        normalized.startsWith(`${CLAUDE_OPENGROVE_MCP_SERVER}__`)
      );
    },
    fingerprint: hostTools.fingerprint,
    exposedToolIds: hostTools.exposedToolIds,
  };
  return bridge;
}

async function handleClaudeNativeToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  context: {
    request: AgentTurnRequest;
    runId: string;
    queue: AsyncEventQueue<AgentEvent>;
    signal: AbortSignal;
    title?: string;
    displayName?: string;
    description?: string;
    decisionReason?: string;
    blockedPath?: string;
    suggestions?: unknown;
    toolUseID: string;
    agentID?: string;
  },
): Promise<PermissionResult> {
  const isQuestion = toolName === "AskUserQuestion";
  const inputValue = asJsonValue(input);
  if (isQuestion) {
    const question = context.request.context.questions.request({
      title: context.title || context.displayName || "Claude asks for input",
      prompt: context.decisionReason || context.description || "Claude Agent requested user input.",
      input: {
        toolName,
        toolUseID: context.toolUseID,
        input: inputValue,
        displayName: context.displayName ?? "",
        description: context.description ?? "",
        blockedPath: context.blockedPath ?? "",
        agentID: context.agentID ?? "",
        suggestions: asJsonValue(context.suggestions),
      },
      resume: {
        type: "kernel.native",
        kernelId: "claude-code",
        runId: context.runId,
        continuation: "same-loop",
      },
      source: { type: "kernel.native", kernelId: "claude-code" },
    });
    context.queue.push({ type: "question.requested", runId: context.runId, question });
    const decided = await waitForQuestionDecision(context.request, question.id, context.signal);
    context.queue.push({ type: "question.answered", runId: context.runId, question: decided });
    if (decided.status !== "answered") {
      const noAnswerReason = isJsonObject(decided.response) ? readString(decided.response, "reason") : undefined;
      return {
        behavior: "deny",
        message:
          noAnswerReason === "timeout"
            ? "No answer was received before the OpenGrove timeout. Continue with the safest reasonable default and do not immediately ask the same question again."
            : "The question was declined through OpenGrove. Continue with the safest reasonable default and do not immediately ask the same question again.",
        toolUseID: context.toolUseID,
        decisionClassification: "user_reject",
      };
    }
    return {
      behavior: "allow",
      toolUseID: context.toolUseID,
      updatedInput: {
        ...input,
        answers: normalizeAskUserQuestionAnswers(decided.response, input),
      },
      decisionClassification: "user_temporary",
    };
  }

  const approval = context.request.context.approvals.request({
    kind: approvalKindForClaudeTool(toolName),
    title: context.title || context.displayName || `Claude wants to use ${toolName}`,
    reason: context.decisionReason || context.description || `Claude Agent requested ${toolName}.`,
    toolId: `claude.${toolName}`,
    input: {
      toolName,
      toolUseID: context.toolUseID,
      input: inputValue,
      displayName: context.displayName ?? "",
      description: context.description ?? "",
      blockedPath: context.blockedPath ?? "",
      agentID: context.agentID ?? "",
      suggestions: asJsonValue(context.suggestions),
    },
    resume: {
      type: "kernel.native",
      kernelId: "claude-code",
      runId: context.runId,
      continuation: "same-loop",
    },
  });
  context.queue.push({ type: "approval.requested", runId: context.runId, request: approval });

  const decided = await waitForInlineDecision(context.request, approval.id, context.signal);
  context.queue.push({ type: "approval.resolved", runId: context.runId, request: decided });
  if (decided.status !== "approved") {
    return {
      behavior: "deny",
      message: "Rejected by user through OpenGrove.",
      toolUseID: context.toolUseID,
      decisionClassification: "user_reject",
    };
  }

  const updatedInput = readUpdatedInput(decided.response);
  return {
    behavior: "allow",
    toolUseID: context.toolUseID,
    ...(updatedInput ? { updatedInput } : {}),
    decisionClassification: "user_temporary",
  };
}

async function handleClaudeElicitation(
  elicitation: ElicitationRequest,
  context: {
    request: AgentTurnRequest;
    runId: string;
    queue: AsyncEventQueue<AgentEvent>;
    signal: AbortSignal;
  },
): Promise<ElicitationResult> {
  const question = context.request.context.questions.request({
    title: elicitation.title || elicitation.displayName || "Claude asks for input",
    prompt: elicitation.message || elicitation.description || "Claude Agent requested user input.",
    input: asJsonValue({
      serverName: elicitation.serverName,
      message: elicitation.message,
      mode: elicitation.mode,
      url: elicitation.url,
      elicitationId: elicitation.elicitationId,
      requestedSchema: elicitation.requestedSchema,
      displayName: elicitation.displayName,
      description: elicitation.description,
    }),
    resume: {
      type: "kernel.native",
      kernelId: "claude-code",
      runId: context.runId,
      continuation: "same-loop",
    },
    source: { type: "kernel.native", kernelId: "claude-code" },
  });
  context.queue.push({ type: "question.requested", runId: context.runId, question });
  const decided = await waitForQuestionDecision(context.request, question.id, context.signal);
  context.queue.push({ type: "question.answered", runId: context.runId, question: decided });

  if (decided.status !== "answered") {
    return { action: "decline" };
  }
  return {
    action: "accept",
    content: normalizeElicitationContent(decided.response),
  };
}

async function waitForInlineDecision(request: AgentTurnRequest, approvalId: string, signal?: AbortSignal) {
  try {
    return await request.context.approvals.waitForDecision(approvalId, {
      timeoutMs: CLAUDE_NATIVE_APPROVAL_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    const current = request.context.approvals.get(approvalId);
    if (current?.status === "pending") {
      return request.context.approvals.decide(approvalId, "rejected", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (current) {
      return current;
    }
    throw error;
  }
}

async function waitForQuestionDecision(request: AgentTurnRequest, questionId: string, signal?: AbortSignal) {
  try {
    return await request.context.questions.waitForDecision(questionId, {
      timeoutMs: CLAUDE_NATIVE_APPROVAL_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    const current = request.context.questions.get(questionId);
    if (current?.status === "pending") {
      return request.context.questions.decide(questionId, "declined", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (current) {
      return current;
    }
    throw error;
  }
}

function jsonSchemaToZodShape(schema: JsonObject): ZodShape {
  const rootType = schema.type;
  if (rootType !== "object" && !isJsonObject(schema.properties)) {
    return { value: jsonSchemaToZod(schema) };
  }

  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
  );
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const shape: ZodShape = {};
  for (const [key, value] of Object.entries(properties)) {
    const childSchema = isJsonObject(value) ? value : {};
    const child = jsonSchemaToZod(childSchema);
    shape[key] = required.has(key) ? child : child.optional();
  }
  return shape;
}

function jsonSchemaToZod(schema: JsonObject): ZodSchema {
  let parsed: ZodSchema;
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter((item): item is string => typeof item === "string")
    : [];
  if (enumValues.length > 0) {
    parsed = z.enum(enumValues as [string, ...string[]]);
  } else if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    parsed = unionSchema([
      ...((schema.anyOf as JsonValue[] | undefined) ?? []),
      ...((schema.oneOf as JsonValue[] | undefined) ?? []),
    ]);
  } else {
    const type = schema.type;
    if (type === "string") {
      parsed = z.string();
    } else if (type === "number") {
      parsed = z.number();
    } else if (type === "integer") {
      parsed = z.number().int();
    } else if (type === "boolean") {
      parsed = z.boolean();
    } else if (type === "array") {
      parsed = z.array(isJsonObject(schema.items) ? jsonSchemaToZod(schema.items) : z.unknown());
    } else if (type === "object" || isJsonObject(schema.properties)) {
      parsed = z
        .object(jsonSchemaToZodShape(schema))
        .catchall(schema.additionalProperties === false ? z.never() : z.unknown());
    } else if (type === "null") {
      parsed = z.null();
    } else {
      parsed = z.unknown();
    }
  }

  const description = readString(schema, "description");
  return description ? parsed.describe(description) : parsed;
}

function unionSchema(values: JsonValue[]): ZodSchema {
  const schemas = values.filter(isJsonObject).map(jsonSchemaToZod);
  if (schemas.length === 0) {
    return z.unknown();
  }
  if (schemas.length === 1) {
    return schemas[0]!;
  }
  return z.union(schemas as [ZodSchema, ZodSchema, ...ZodSchema[]]);
}

function approvalKindForClaudeTool(toolName: string): ApprovalKind {
  if (toolName === "Bash") return "command";
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) return "file_change";
  if (["WebFetch", "WebSearch"].includes(toolName)) return "browser_action";
  return "permission_scope";
}

function normalizeAskUserQuestionAnswers(
  response: JsonValue | undefined,
  input: Record<string, unknown>,
): Record<string, string> {
  const object = isJsonObject(response) ? response : undefined;
  if (isJsonObject(object?.answers)) {
    return canonicalAskUserQuestionAnswers(stringRecord(object.answers), input);
  }
  const text =
    typeof response === "string"
      ? response.trim()
      : (readString(object ?? {}, "text") ?? readString(object ?? {}, "answer") ?? "");
  const firstKey = readFirstQuestionKey(input);
  return text ? { [firstKey]: text } : {};
}

function canonicalAskUserQuestionAnswers(
  answers: Record<string, string>,
  input: Record<string, unknown>,
): Record<string, string> {
  const questions = readQuestionItems(input);
  if (!questions.length) {
    return answers;
  }
  const aliases = new Map<string, string>();
  questions.forEach((question, index) => {
    const canonical = readQuestionAnswerKey(question, index);
    for (const alias of [
      readRecordString(question, "id"),
      readRecordString(question, "name"),
      readRecordString(question, "header"),
      readRecordString(question, "question"),
      readRecordString(question, "title"),
      readRecordString(question, "label"),
      readRecordString(question, "prompt"),
      readRecordString(question, "message"),
      readRecordString(question, "text"),
      `question_${index + 1}`,
    ]) {
      if (alias) {
        aliases.set(alias, canonical);
      }
    }
  });

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (!value.trim()) continue;
    const canonical =
      aliases.get(key) ?? (key === "answer" && questions.length === 1 ? readQuestionAnswerKey(questions[0]!, 0) : key);
    output[canonical] = value.trim();
  }
  return output;
}

function normalizeElicitationContent(
  response: JsonValue | undefined,
): Record<string, string | number | boolean | string[]> {
  const object = isJsonObject(response) ? response : undefined;
  if (isJsonObject(object?.content)) {
    return scalarRecord(object.content);
  }
  if (isJsonObject(object?.answers)) {
    return stringRecord(object.answers);
  }
  const text =
    typeof response === "string"
      ? response.trim()
      : (readString(object ?? {}, "text") ?? readString(object ?? {}, "answer") ?? "");
  return text ? { answer: text, text } : {};
}

function readUpdatedInput(response: JsonValue | undefined): Record<string, unknown> | undefined {
  const object = isJsonObject(response) ? response : undefined;
  return isJsonObject(object?.updatedInput) ? object.updatedInput : undefined;
}

function stringRecord(input: JsonObject): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      output[key] = value;
    } else if (Array.isArray(value)) {
      output[key] = value.filter((item): item is string => typeof item === "string").join(", ");
    } else if (isJsonObject(value)) {
      output[key] =
        readString(value, "text") ?? readString(value, "answer") ?? truncateText(JSON.stringify(value), 500);
    }
  }
  return output;
}

function scalarRecord(input: JsonObject): Record<string, string | number | boolean | string[]> {
  const output: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    } else if (Array.isArray(value)) {
      output[key] = value.filter((item): item is string => typeof item === "string");
    } else if (isJsonObject(value)) {
      output[key] =
        readString(value, "text") ?? readString(value, "answer") ?? truncateText(JSON.stringify(value), 500);
    }
  }
  return output;
}

function readFirstQuestionKey(input: Record<string, unknown>): string {
  const first = readQuestionItems(input)[0];
  return first ? readQuestionAnswerKey(first, 0) : "answer";
}

function readQuestionItems(input: Record<string, unknown>): Record<string, unknown>[] {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
}

function readQuestionAnswerKey(question: Record<string, unknown>, index: number): string {
  return (
    readRecordString(question, "question") ??
    readRecordString(question, "header") ??
    readRecordString(question, "id") ??
    readRecordString(question, "name") ??
    `question_${index + 1}`
  );
}

function readRecordString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
