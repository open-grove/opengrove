import type { AgentTurnRequest, ApprovalRequest, JsonValue, QuestionRequest, UsageStats } from "../../core.js";
import { asObject, readNumber, readString, toJsonValue } from "./json.js";

export function createHermesGatewayApproval(
  payload: Record<string, unknown>,
  runId: string,
  request: AgentTurnRequest,
): ApprovalRequest {
  const command = readString(payload, "command") ?? readString(payload, "preview");
  const name = readString(payload, "name") ?? readString(payload, "tool") ?? readString(payload, "tool_name");
  const kind = command ? "command" : "tool";
  const title =
    readString(payload, "title") ??
    readString(payload, "prompt") ??
    (command ? `Hermes command: ${command}` : undefined) ??
    (name ? `Hermes tool: ${name}` : "Hermes permission request");
  return request.context.approvals.request({
    kind,
    title,
    reason: `Hermes Gateway requested permission for ${title}.`,
    toolId: hermesToolId(name ?? command ?? "approval"),
    input: toJsonValue(payload),
    resume: {
      type: "kernel.native",
      kernelId: "hermes",
      runId,
      continuation: "same-loop",
    },
  });
}

export function createHermesGatewayQuestion(
  payload: Record<string, unknown>,
  eventType: string,
  runId: string,
  request: AgentTurnRequest,
): QuestionRequest {
  const prompt =
    readString(payload, "question") ??
    readString(payload, "prompt") ??
    (eventType === "sudo.request" ? "Hermes needs a sudo password." : undefined) ??
    (eventType === "secret.request" ? "Hermes needs a secret value." : "Hermes needs more information.");
  return request.context.questions.request({
    title: gatewayQuestionTitle(eventType),
    prompt,
    input: toJsonValue(payload),
    source: { type: "kernel.native", kernelId: "hermes" },
    resume: {
      type: "kernel.native",
      kernelId: "hermes",
      runId,
      continuation: "same-loop",
    },
  });
}

export function gatewayQuestionResponseMethod(eventType: string): string {
  if (eventType === "sudo.request") return "sudo.respond";
  if (eventType === "secret.request") return "secret.respond";
  return "clarify.respond";
}

export function gatewayQuestionResponseKey(eventType: string): "answer" | "password" | "value" {
  if (eventType === "sudo.request") return "password";
  if (eventType === "secret.request") return "value";
  return "answer";
}

export function extractQuestionAnswer(response: JsonValue | undefined): string {
  if (typeof response === "string") return response;
  const object = asObject(response);
  const direct = readString(object, "answer") ?? readString(object, "value") ?? readString(object, "text");
  if (direct) return direct;
  const answers = asObject(object.answers);
  for (const value of Object.values(answers)) {
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim());
      if (typeof first === "string") return first;
    }
  }
  return "";
}

export function readHermesGatewayUsage(usage: Record<string, unknown>): UsageStats | undefined {
  const inputTokens = readNumber(usage, "input") ?? readNumber(usage, "input_tokens") ?? readNumber(usage, "prompt");
  const outputTokens =
    readNumber(usage, "output") ?? readNumber(usage, "output_tokens") ?? readNumber(usage, "completion");
  const totalTokens = readNumber(usage, "total") ?? readNumber(usage, "total_tokens");
  const costUsd = readNumber(usage, "cost_usd");
  const stats: UsageStats = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return Object.keys(stats).length ? stats : undefined;
}

export function hermesToolId(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return `hermes.${normalized || "tool"}`;
}

export function resolveHermesToolCallId(
  toolCalls: ReadonlyMap<string, { toolId: string }>,
  toolId: string,
  nativeCallId?: string,
): { callId?: string; ambiguous: boolean } {
  if (nativeCallId) return { callId: nativeCallId, ambiguous: false };
  const matches = Array.from(toolCalls.entries())
    .filter(([, current]) => current.toolId === toolId)
    .map(([callId]) => callId);
  if (matches.length === 1) return { callId: matches[0], ambiguous: false };
  if (matches.length > 1) return { callId: matches[0], ambiguous: true };
  return { ambiguous: false };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gatewayQuestionTitle(eventType: string): string {
  if (eventType === "sudo.request") return "Hermes sudo request";
  if (eventType === "secret.request") return "Hermes secret request";
  return "Hermes question";
}
