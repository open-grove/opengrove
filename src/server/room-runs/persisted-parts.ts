import { type AgentEvent, type JsonObject, type JsonValue } from "../../core.js";
import { hostMessage } from "../../localization/host-messages.js";
import { DEFAULT_LOCALE, type SupportedLocale } from "../../localization/locale-registry.js";

export interface PersistedRoomRunPartsOptions {
  // "interrupted": 用户主动停止。取消类 error(如 claude_code_aborted) 不渲染成红色错误 note,
  // 悬挂的工具/技能标 canceled 而非 failed,与外层"已中断"状态保持一致。
  mode?: "default" | "interrupted";
  language?: SupportedLocale;
}

export function persistedRoomRunParts(
  events: AgentEvent[],
  fallbackRunId: string,
  errorMessage = "",
  options: PersistedRoomRunPartsOptions = {},
): JsonObject[] {
  const interrupted = options.mode === "interrupted";
  const language = options.language ?? DEFAULT_LOCALE;
  const parts: JsonObject[] = [];
  const skillIndexes = new Map<string, number>();
  let sequence = 0;

  for (const event of events) {
    switch (event.type) {
      case "skill.invoked":
        upsertPersistedSkillPart(parts, skillIndexes, event, "invoked", fallbackRunId, sequence++);
        break;
      case "skill.loaded":
        upsertPersistedSkillPart(parts, skillIndexes, event, "loaded", fallbackRunId, sequence++);
        break;
      case "skill.forked":
        upsertPersistedSkillPart(parts, skillIndexes, event, event.status || "finished", fallbackRunId, sequence++);
        break;
      case "tool.started":
        if (isQuietRoomToolEvent(event.toolId)) break;
        parts.push(
          withOptionalJsonFields(
            {
              id: persistedPartId(event.runId || fallbackRunId, "tool", sequence++),
              type: "tool",
              phase: "call",
              toolId: event.toolId || "tool",
              title: event.toolId || "Tool call",
              status: "running",
              error: "",
              approvalId: "",
              approvalStatus: "",
              approvalReason: "",
              questionId: "",
              questionStatus: "",
              questionPrompt: "",
            },
            {
              callId: event.callId,
              input: event.input,
            },
          ),
        );
        break;
      case "tool.progress": {
        if (isQuietRoomToolEvent(event.toolId)) break;
        const existing = findLatestPersistedToolPart(parts, event.toolId, event.callId);
        if (existing) {
          existing.result = event.update;
        } else {
          parts.push(
            withOptionalJsonFields(
              {
                id: persistedPartId(event.runId || fallbackRunId, "tool", sequence++),
                type: "tool",
                phase: "progress",
                toolId: event.toolId || "tool",
                title: event.toolId || "Tool progress",
                status: "running",
                error: "",
                approvalId: "",
                approvalStatus: "",
                approvalReason: "",
                questionId: "",
                questionStatus: "",
                questionPrompt: "",
              },
              {
                callId: event.callId,
                result: event.update,
              },
            ),
          );
        }
        break;
      }
      case "tool.finished":
        if (isQuietRoomToolEvent(event.toolId)) break;
        parts.push(
          withOptionalJsonFields(
            {
              id: persistedPartId(event.runId || fallbackRunId, "tool", sequence++),
              type: "tool",
              phase: "result",
              toolId: event.toolId || "tool",
              title: event.toolId || "Tool result",
              status: toolStatusFromResult(event.result),
              error: event.result.error || "",
              approvalId: "",
              approvalStatus: "",
              approvalReason: "",
              questionId: "",
              questionStatus: "",
              questionPrompt: "",
            },
            {
              callId: event.callId,
              result: event.result.value,
            },
          ),
        );
        break;
      case "approval.requested":
        pushApprovalPart(parts, event, fallbackRunId, sequence++);
        break;
      case "approval.resolved":
        updatePersistedApprovalPart(parts, event.request);
        break;
      case "question.requested":
        pushQuestionPart(parts, event, fallbackRunId, sequence++);
        break;
      case "question.answered":
        updatePersistedQuestionPart(parts, event.question);
        break;
      case "planning.updated":
        upsertPersistedPlanningPart(parts, event.plan, fallbackRunId, sequence++);
        break;
      case "skill.cleared":
        if (event.reason) {
          parts.push(createPersistedNotePart(event.runId || fallbackRunId, sequence++, event.reason, "muted"));
        }
        break;
      case "compaction.started":
        parts.push(
          createPersistedNotePart(
            event.runId || fallbackRunId,
            sequence++,
            hostMessage(language, "room.compaction_started"),
            "compaction-started",
          ),
        );
        break;
      case "compaction.finished":
        parts.push(
          createPersistedNotePart(
            event.runId || fallbackRunId,
            sequence++,
            hostMessage(language, "room.compaction_finished"),
            "compaction-finished",
          ),
        );
        break;
      case "assistant.status":
        parts.push(createPersistedNotePart(event.runId || fallbackRunId, sequence++, event.text, "status", event.data));
        break;
      case "reasoning.started":
        parts.push({
          id: persistedPartId(event.runId || fallbackRunId, "reasoning", sequence++),
          type: "reasoning",
          reasoningId: event.reasoning.id,
          kernelId: event.reasoning.kernelId,
          kind: event.reasoning.kind,
          text: "",
          status: "running",
          redacted: false,
        });
        break;
      case "reasoning.completed": {
        const existing = findLatestPersistedReasoningPart(parts, event.reasoning.id);
        const completed = existing ?? {
          id: persistedPartId(event.runId || fallbackRunId, "reasoning", sequence++),
          type: "reasoning",
          reasoningId: event.reasoning.id,
        };
        completed.kernelId = event.reasoning.kernelId;
        completed.kind = event.reasoning.kind;
        completed.text = event.reasoning.text;
        completed.status = "complete";
        completed.redacted = event.reasoning.redacted ?? false;
        if (event.reasoning.elapsedMs !== undefined) completed.elapsedMs = event.reasoning.elapsedMs;
        if (!existing) parts.push(completed);
        break;
      }
      case "runtime.diagnostic": {
        const text = persistedRuntimeDiagnosticText(event.name);
        if (text) {
          parts.push(createPersistedNotePart(event.runId || fallbackRunId, sequence++, text, "diagnostic", event.data));
        }
        break;
      }
      case "error": {
        const rawMessage = event.message || errorMessage;
        // 取消场景:把"被打断"的取消类 error 视为中断,不渲染成红色错误 note,悬挂的工具/技能
        // 标 canceled。只有非取消类的真实错误才照常持久化。
        if (interrupted && isCancellationErrorMessage(rawMessage)) {
          closeDanglingPersistedParts(parts, "canceled", "");
          break;
        }
        closeDanglingPersistedParts(parts, "failed", rawMessage);
        const text = rawMessage.trim();
        if (text) {
          parts.push(createPersistedNotePart(event.runId || fallbackRunId, sequence++, text, "error"));
        }
        break;
      }
      case "turn.finished":
        closeDanglingPersistedParts(parts, "complete", "");
        break;
      default:
        break;
    }
  }

  closeDanglingPersistedParts(
    parts,
    interrupted ? "canceled" : errorMessage ? "failed" : "complete",
    interrupted ? "" : errorMessage,
  );
  return parts;
}

export function collectRunDetails(
  events: AgentEvent[],
  fallbackRunId: string,
  errorMessage = "",
  options: PersistedRoomRunPartsOptions = {},
): JsonObject[] {
  return persistedRoomRunParts(events, fallbackRunId, errorMessage, options);
}

function pushApprovalPart(
  parts: JsonObject[],
  event: Extract<AgentEvent, { type: "approval.requested" }>,
  fallbackRunId: string,
  sequence: number,
): void {
  const request = event.request;
  parts.push(
    withOptionalJsonFields(
      {
        id: persistedPartId(event.runId || fallbackRunId, "approval", sequence),
        type: "tool",
        phase: "approval",
        toolId: request.toolId || request.kind || request.title || "approval",
        title: request.title || request.toolId || "Approval",
        status: "requires-action",
        error: "",
        approvalId: request.id || "",
        approvalStatus: request.status || "pending",
        approvalReason: request.reason || "",
        questionId: "",
        questionStatus: "",
        questionPrompt: "",
      },
      {
        input: request.input,
        approvalInput: request.input,
      },
    ),
  );
}

function pushQuestionPart(
  parts: JsonObject[],
  event: Extract<AgentEvent, { type: "question.requested" }>,
  fallbackRunId: string,
  sequence: number,
): void {
  const question = event.question;
  parts.push(
    withOptionalJsonFields(
      {
        id: persistedPartId(event.runId || fallbackRunId, "question", sequence),
        type: "tool",
        phase: "question",
        toolId: "question",
        title: question.title || "Question",
        status: "requires-action",
        error: "",
        approvalId: "",
        approvalStatus: "",
        approvalReason: "",
        questionId: question.id || "",
        questionStatus: question.status || "pending",
        questionPrompt: question.prompt || "",
      },
      {
        input: question.input,
        questionInput: question.input,
      },
    ),
  );
}

function upsertPersistedSkillPart(
  parts: JsonObject[],
  indexes: Map<string, number>,
  event: Extract<AgentEvent, { type: "skill.invoked" | "skill.loaded" | "skill.forked" }>,
  status: string,
  fallbackRunId: string,
  sequence: number,
): void {
  const skill = event.type === "skill.invoked" ? event.skill : undefined;
  const skillId = "skillId" in event ? event.skillId : skill?.id || "";
  const key = skillId || skill?.name || `skill-${sequence}`;
  const existingIndex = indexes.get(key);
  const part =
    existingIndex === undefined
      ? ({
          id: persistedPartId(event.runId || fallbackRunId, "skill", sequence),
          type: "skill",
          skillId: "",
          skillName: "",
          title: "",
          status: "invoked",
          contentPreview: "",
          allowedTools: [],
          model: "",
          effort: "",
          forkSessionId: "",
          result: "",
          description: "",
          whenToUse: "",
          source: "",
          trust: "",
          context: "",
          packId: "",
        } satisfies JsonObject)
      : parts[existingIndex]!;

  part.skillId = skillId || stringValue(part.skillId);
  part.skillName = skill?.name || stringValue(part.skillName);
  part.title = skill?.title || stringValue(part.title) || skillId || "";
  part.status = status || stringValue(part.status);
  if (event.type === "skill.loaded") {
    part.contentPreview = event.contentPreview || stringValue(part.contentPreview);
    part.allowedTools = event.allowedTools.slice();
    part.model = event.model || stringValue(part.model);
    part.effort = event.effort || stringValue(part.effort);
    part.context = event.context || stringValue(part.context);
  }
  if (event.type === "skill.forked") {
    part.forkSessionId = event.forkSessionId || stringValue(part.forkSessionId);
    part.result = event.result || stringValue(part.result);
  }
  if (event.type === "skill.invoked") {
    part.contentPreview = event.invocation.contentPreview || stringValue(part.contentPreview);
    part.allowedTools = event.invocation.allowedTools.slice();
    part.model = event.invocation.model || stringValue(part.model);
    part.effort = event.invocation.effort || stringValue(part.effort);
  }
  if (skill) {
    part.description = skill.description || stringValue(part.description);
    part.whenToUse = skill.whenToUse || stringValue(part.whenToUse);
    part.source = skill.source || stringValue(part.source);
    part.trust = skill.trust || stringValue(part.trust);
    part.context = skill.context || stringValue(part.context);
    part.packId = skill.packId || stringValue(part.packId);
  }

  if (existingIndex === undefined) {
    indexes.set(key, parts.length);
    parts.push(part);
  }
}

function updatePersistedApprovalPart(
  parts: JsonObject[],
  request: { id?: string; status?: string; reason?: string; response?: JsonValue },
): void {
  if (!request.id) return;
  const response =
    request.response && typeof request.response === "object" && !Array.isArray(request.response)
      ? (request.response as JsonObject)
      : undefined;
  const responseError = stringValue(response?.error);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type !== "tool" || part.phase !== "approval" || part.approvalId !== request.id) continue;
    part.approvalStatus = request.status || stringValue(part.approvalStatus);
    part.approvalReason = request.reason || stringValue(part.approvalReason);
    if (request.status === "approved" && part.status === "requires-action") part.status = "approved";
    if (request.status === "rejected") {
      part.status = "rejected";
      if (responseError) part.error = responseError;
    }
    return;
  }
}

function updatePersistedQuestionPart(
  parts: JsonObject[],
  question: { id?: string; status?: string; prompt?: string; response?: JsonValue },
): void {
  if (!question.id) return;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type !== "tool" || part.phase !== "question" || part.questionId !== question.id) continue;
    part.questionStatus = question.status || stringValue(part.questionStatus);
    part.questionPrompt = question.prompt || stringValue(part.questionPrompt);
    if (question.response !== undefined) part.result = question.response;
    if (question.status === "answered" && part.status === "requires-action") part.status = "answered";
    if (question.status === "declined") part.status = "declined";
    return;
  }
}

function upsertPersistedPlanningPart(
  parts: JsonObject[],
  plan: { id?: string; title?: string; text?: string; status?: string },
  fallbackRunId: string,
  sequence: number,
): void {
  if (!plan.id) return;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    const input =
      part?.input && typeof part.input === "object" && !Array.isArray(part.input)
        ? (part.input as JsonObject)
        : undefined;
    if (part?.type !== "tool" || part.phase !== "planning" || input?.id !== plan.id) continue;
    part.title = plan.title || stringValue(part.title);
    part.status = plan.status === "completed" ? "complete" : "running";
    part.input = { ...input, ...plan };
    part.result = part.input;
    return;
  }
  const planValue = {
    id: plan.id,
    title: plan.title ?? "Plan",
    text: plan.text ?? "",
    status: plan.status ?? "updated",
  };
  parts.push({
    id: persistedPartId(fallbackRunId, "planning", sequence),
    type: "tool",
    phase: "planning",
    toolId: "planning.plan",
    title: plan.title || "Plan",
    input: planValue,
    status: plan.status === "completed" ? "complete" : "running",
    result: planValue,
    error: "",
    approvalId: "",
    approvalStatus: "",
    approvalReason: "",
    questionId: "",
    questionStatus: "",
    questionPrompt: "",
  });
}

function createPersistedNotePart(
  runId: string,
  sequence: number,
  text: string,
  tone: string,
  data?: JsonObject,
): JsonObject {
  return withOptionalJsonFields(
    {
      id: persistedPartId(runId, "note", sequence),
      type: "note",
      text,
      tone,
    },
    { data },
  );
}

function persistedRuntimeDiagnosticText(name: string): string {
  const normalizedName = stringValue(name);
  if (isLowSignalRuntimeDiagnosticName(normalizedName)) {
    return "";
  }
  return normalizedName;
}

function isLowSignalRuntimeDiagnosticName(name: string): boolean {
  return (
    /^cloud_connector(?:[._]|$)/i.test(name) ||
    /^claude\.sdk\.hook_(?:started|progress|response)$/i.test(name) ||
    /\.configured$/i.test(name) ||
    /\.session$/i.test(name) ||
    /\.init$/i.test(name) ||
    /\.result$/i.test(name) ||
    /\.auth_status$/i.test(name)
  );
}

// 各 runtime 在被 abort 时发出的取消类 error.message,例如 claude_code_aborted /
// pi_aborted / <kernel>_aborted / deepseek_runtime_stream_aborted /
// openclaw_gateway_aborted / run_cancelled / turn/start aborted,以及通用的 AbortError。
// 这些代表"用户主动停止"而非真实失败,interrupted 模式下不应渲染成红色错误。
function isCancellationErrorMessage(errorMessage: string): boolean {
  const normalized = errorMessage.trim();
  if (!normalized) return false;
  return (
    /(_aborted|_cancelled|_canceled)$/i.test(normalized) ||
    /^run_cancelled$/i.test(normalized) ||
    /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)* aborted(?:[:\s].*)?$/i.test(normalized) ||
    /\bAbortError\b/i.test(normalized)
  );
}

function closeDanglingPersistedParts(
  parts: JsonObject[],
  status: "complete" | "failed" | "canceled",
  errorMessage: string,
): void {
  const toolStatus = status === "failed" ? "failed" : status === "canceled" ? "canceled" : "complete";
  const skillStatus = status === "failed" ? "failed" : status === "canceled" ? "canceled" : "finished";
  for (const part of parts) {
    if (part.type === "tool") {
      if (part.phase !== "approval" && part.phase !== "question" && part.status === "running") {
        part.status = toolStatus;
        if (status === "failed" && errorMessage && !part.error) part.error = errorMessage;
      }
      continue;
    }
    if (part.type === "skill" && ["invoked", "started", "running"].includes(stringValue(part.status))) {
      part.status = skillStatus;
      if (status === "failed" && errorMessage && !part.result) part.result = errorMessage;
      continue;
    }
    if (part.type === "reasoning" && part.status === "running") {
      part.status = toolStatus;
    }
  }
}

function withOptionalJsonFields(base: JsonObject, optional: Record<string, JsonValue | undefined>): JsonObject {
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) base[key] = value;
  }
  return base;
}

function findLatestPersistedToolPart(parts: JsonObject[], toolId: string, callId?: string): JsonObject | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part.type === "tool" && part.status === "running" && (callId ? part.callId === callId : part.toolId === toolId))
      return part;
  }
  return undefined;
}

function findLatestPersistedReasoningPart(parts: JsonObject[], reasoningId: string): JsonObject | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part.type === "reasoning" && part.reasoningId === reasoningId) return part;
  }
  return undefined;
}

function toolStatusFromResult(result: Extract<AgentEvent, { type: "tool.finished" }>["result"]): string {
  const value = result.value;
  if (isJsonObject(value) && (value.needsReobserve || value.status === "blocked")) return "blocked";
  if (isJsonObject(value) && value.status === "staged") return "complete";
  return result.ok ? "complete" : "incomplete";
}

function isQuietRoomToolEvent(toolId: unknown): boolean {
  return toolId === "room.ledger.read" || toolId === "claude.tool" || toolId === "claude.AskUserQuestion";
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function persistedPartId(runId: string, kind: string, sequence: number): string {
  return `part-${runId || "room"}-${kind}-${sequence}`;
}
