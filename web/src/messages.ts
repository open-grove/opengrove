import type { JsonValue, MessagePart, NotePart, ReasoningPart, SkillPart, StoredMessage, ToolPart } from "./bridge";
import { createClientId } from "./bridge";
import { toolStatusFromResult } from "./format";
import { translate } from "./i18n";
import { dictionaries } from "./i18n-dictionaries";

// "模型调用出错" 会写入持久化消息文本，并被 store.ts 与 room-message-stream.tsx 按文本匹配；
// 前缀从两份字典派生，保证语言切换或历史消息（中英混存）都能命中。
const MODEL_CALL_ERROR_PREFIXES = Object.values(dictionaries).map((dictionary) =>
  dictionary["system.modelCallError"].replace("{message}", ""),
);
const MODEL_CALL_ERROR_PLAIN_TEXTS = Object.values(dictionaries).map(
  (dictionary) => dictionary["system.modelCallErrorPlain"],
);

export function formatModelCallError(message: string): string {
  const normalized = String(message || "").trim();
  return normalized
    ? translate("system.modelCallError", { message: normalized })
    : translate("system.modelCallErrorPlain");
}

export function isModelCallErrorText(text: string): boolean {
  const normalized = String(text || "").trim();
  return (
    MODEL_CALL_ERROR_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    MODEL_CALL_ERROR_PLAIN_TEXTS.includes(normalized)
  );
}

export function stripModelCallErrorPrefix(text: string): string | null {
  for (const prefix of MODEL_CALL_ERROR_PREFIXES) {
    if (text.startsWith(prefix)) {
      return text.slice(prefix.length);
    }
  }
  return null;
}

export function hasRenderableMessageParts(message: StoredMessage): boolean {
  return Array.isArray(message.parts) && message.parts.some((part) => isRenderableMessagePart(part));
}

export function isRenderableMessagePart(part: MessagePart | null | undefined): part is MessagePart {
  if (!part || isQuietToolPart(part)) {
    return false;
  }
  if (part.type === "text") {
    return Boolean(part.text);
  }
  if (part.type === "note") {
    return Boolean(displayNoteText(part));
  }
  return true;
}

export function isQuietToolPart(part: MessagePart): boolean {
  return part.type === "tool" && isQuietToolEvent(part.toolId);
}

export function normalizeMessagePartsForDisplay(parts: MessagePart[] | undefined): MessagePart[] {
  const normalized: MessagePart[] = [];
  for (const part of parts || []) {
    if (isQuietToolPart(part)) {
      continue;
    }
    if (part.type === "note") {
      const text = displayNoteText(part);
      if (!text) {
        continue;
      }
      normalized.push(text === part.text ? part : { ...part, text });
      continue;
    }
    if (part.type === "reasoning" && (part as { kind?: string }).kind === "raw") {
      normalized.push({ ...part, kind: "native" });
      continue;
    }
    normalized.push(part);
  }
  return normalized;
}

export function displayNoteText(part: Pick<NotePart, "text" | "tone">): string {
  const text = cleanDiagnosticText(part.text || "");
  if (!text) {
    return "";
  }
  if (part.tone === "diagnostic") {
    // Runtime diagnostics are operational telemetry, not conversational content.
    // They remain available in the event stream / Ops view, but must never surface
    // as user-facing rows such as "诊断 · codex reasoning summary part".
    return "";
  }
  return text;
}

export function collectMessageText(message: StoredMessage): string {
  const textFromParts = (message.parts || [])
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part?.type === "text")
    .map((part) => part.text)
    .join("");
  return textFromParts || message.text || "";
}

export function appendTextPart(message: StoredMessage, text: string): void {
  if (!text) {
    return;
  }
  const lastPart = message.parts[message.parts.length - 1];
  if (lastPart?.type === "text") {
    lastPart.text = `${lastPart.text || ""}${text}`;
    return;
  }
  message.parts.push({
    id: createClientId("part"),
    type: "text",
    text,
  });
}

export function appendNotePart(message: StoredMessage, text: string, tone = "muted", data?: JsonValue): void {
  if (!text) {
    return;
  }
  message.parts.push({
    id: createClientId("part"),
    type: "note",
    text,
    tone,
    ...(data === undefined ? {} : { data }),
  });
}

function appendDiagnosticNotePart(message: StoredMessage, text: string, tone = "diagnostic", data?: JsonValue): void {
  const normalized = text.trim();
  if (!normalized) return;
  const recent = (message.parts || []).slice(-4);
  if (recent.some((part) => part.type === "note" && part.tone === tone && part.text.trim() === normalized)) {
    return;
  }
  appendNotePart(message, normalized, tone, data);
}

function findLatestPart<T extends MessagePart>(
  message: StoredMessage,
  predicate: (part: MessagePart) => part is T,
): T | null {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part && predicate(part)) {
      return part;
    }
  }
  return null;
}

export function appendSkillEventPart(message: StoredMessage, event: any, status: string): void {
  const existing = findLatestPart<SkillPart>(
    message,
    (part): part is SkillPart => part.type === "skill" && part.skillId === event.skillId,
  );
  const next =
    existing ||
    ({
      id: createClientId("part"),
      type: "skill",
      skillId: event.skillId || event.skill?.id || "",
      skillName: event.skill?.name || "",
      title: event.skill?.title || event.skillId || "",
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
    } satisfies SkillPart);

  next.skillId = event.skillId || event.skill?.id || next.skillId;
  next.skillName = event.skill?.name || next.skillName;
  next.title = event.skill?.title || next.title || event.skillId || "";
  next.status = status || next.status;
  next.contentPreview = event.contentPreview || next.contentPreview || event.invocation?.contentPreview || "";
  next.allowedTools = Array.isArray(event.allowedTools)
    ? event.allowedTools.slice()
    : Array.isArray(event.invocation?.allowedTools)
      ? event.invocation.allowedTools.slice()
      : next.allowedTools || [];
  next.model = event.model || event.invocation?.model || next.model || "";
  next.effort = event.effort || event.invocation?.effort || next.effort || "";
  next.forkSessionId = event.forkSessionId || next.forkSessionId || "";
  next.result = event.result || next.result || "";
  next.description = event.skill?.description || next.description || "";
  next.whenToUse = event.skill?.whenToUse || next.whenToUse || "";
  next.source = event.skill?.source || next.source || "";
  next.trust = event.skill?.trust || next.trust || "";
  next.context = event.context || event.skill?.context || next.context || "";
  next.packId = event.skill?.packId || next.packId || "";

  if (!existing) {
    message.parts.push(next);
  }
}

export function appendToolEventPart(
  message: StoredMessage,
  part: Partial<ToolPart> & Pick<ToolPart, "phase" | "toolId" | "title" | "status">,
): void {
  message.parts.push({
    id: createClientId("part"),
    type: "tool",
    phase: part.phase || "result",
    toolId: part.toolId || "tool",
    ...(part.callId ? { callId: part.callId } : {}),
    title: part.title || part.toolId || "Tool",
    input: part.input,
    status: part.status || "running",
    result: part.result,
    error: part.error || "",
    approvalId: part.approvalId || "",
    approvalStatus: part.approvalStatus || "",
    approvalReason: part.approvalReason || "",
    approvalInput: part.approvalInput,
    questionId: part.questionId || "",
    questionStatus: part.questionStatus || "",
    questionPrompt: part.questionPrompt || "",
    questionInput: part.questionInput,
  });
}

function applyReasoningEventPart(
  message: StoredMessage,
  reasoning: Record<string, unknown>,
  status: "running" | "complete",
): void {
  const reasoningId = stringValue(reasoning.id);
  if (!reasoningId) return;
  const existing = findLatestPart<ReasoningPart>(
    message,
    (part): part is ReasoningPart => part.type === "reasoning" && part.reasoningId === reasoningId,
  );
  const next =
    existing ??
    ({
      id: createClientId("part"),
      type: "reasoning",
      reasoningId,
      kernelId: "",
      kind: "native",
      text: "",
      status: "running",
      redacted: false,
    } satisfies ReasoningPart);
  next.kernelId = stringValue(reasoning.kernelId) || next.kernelId;
  next.kind = reasoning.kind === "summary" ? "summary" : "native";
  next.text = typeof reasoning.text === "string" ? reasoning.text : next.text;
  next.status = status;
  next.redacted = reasoning.redacted === true;
  next.elapsedMs = typeof reasoning.elapsedMs === "number" ? reasoning.elapsedMs : next.elapsedMs;
  if (!existing) message.parts.push(next);
}

export function closeDanglingMessageActivity(
  message: StoredMessage,
  options: { status?: "complete" | "failed"; errorMessage?: string } = {},
): StoredMessage {
  const status = options.status || "complete";
  const errorMessage = String(options.errorMessage || "").trim();
  for (const part of message.parts || []) {
    if (part.type === "tool") {
      closeDanglingToolPart(part, status, errorMessage);
    } else if (part.type === "skill") {
      closeDanglingSkillPart(part, status, errorMessage);
    } else if (part.type === "reasoning" && part.status === "running") {
      part.status = status === "failed" ? "failed" : "complete";
    }
  }
  return message;
}

function closeDanglingToolPart(part: ToolPart, status: "complete" | "failed", errorMessage: string): void {
  if (part.phase === "approval" || part.phase === "question") {
    return;
  }
  if (part.status !== "running") {
    return;
  }
  part.status = status === "failed" ? "failed" : "complete";
  if (status === "failed" && errorMessage && !part.error && !isCodexNativeProcessTool(part.toolId)) {
    part.error = errorMessage;
  }
}

function closeDanglingSkillPart(part: SkillPart, status: "complete" | "failed", errorMessage: string): void {
  if (!["invoked", "started", "running"].includes(part.status)) {
    return;
  }
  part.status = status === "failed" ? "failed" : "finished";
  if (status === "failed" && errorMessage && !part.result) {
    part.result = errorMessage;
  }
}

export function markAssistantMessageError(message: StoredMessage, errorMessage: string): StoredMessage {
  message.pending = false;
  closeDanglingMessageActivity(message, { status: "failed", errorMessage });
  appendNotePart(message, formatModelCallError(errorMessage), "error");
  if (!hasRenderableMessageParts(message)) {
    message.text = formatModelCallError(errorMessage);
  }
  return message;
}

export function finalizeAssistantMessage(
  message: StoredMessage,
  data: { answer?: string; events?: any[] },
): StoredMessage {
  message.pending = false;
  const timing = messageTimingFromEvents(data?.events);
  const eventError = renderEventError(data?.events);
  message.startedAt = message.startedAt || timing.startedAt;
  message.finishedAt = message.finishedAt || timing.finishedAt;
  const finalResponseText = finalModelResponseTextFromEvents(data?.events);
  const answer = finalResponseText || (typeof data?.answer === "string" ? data.answer : "");
  const existingText = collectMessageText(message);
  if (existingText && shouldReplaceStreamedText(existingText, answer, Boolean(finalResponseText))) {
    replaceTextPartsWithFinalAnswer(message, answer);
  } else if (!existingText && answer) {
    appendTextPart(message, answer);
  }
  if (!hasRenderableMessageParts(message) && !String(message.text || "").trim()) {
    appendNotePart(message, eventError || translate("system.noTextReturned"), "muted");
  }
  closeDanglingMessageActivity(message, {
    status: eventError ? "failed" : "complete",
    errorMessage: eventError,
  });
  message.text = collectMessageText(message);
  return message;
}

function shouldReplaceStreamedText(existingText: string, finalText: string, authoritativeFinal = false): boolean {
  const existing = String(existingText || "").trim();
  const final = String(finalText || "").trim();
  if (!existing || !final || existing === final) {
    return false;
  }
  if (authoritativeFinal) {
    return true;
  }
  if (final.length < existing.length) {
    return false;
  }
  if (final.startsWith(existing)) {
    return true;
  }
  return countRenderableImageMarkdown(final) > countRenderableImageMarkdown(existing);
}

function finalModelResponseTextFromEvents(events: any[] | undefined): string {
  if (!Array.isArray(events)) {
    return "";
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const text =
      event?.type === "assistant.final" ? event.text : event?.type === "model.response" ? event?.response?.text : "";
    if (typeof text === "string" && text.trim()) {
      return text;
    }
  }
  return "";
}

function replaceTextPartsWithFinalAnswer(message: StoredMessage, answer: string): void {
  message.parts = (message.parts || []).filter((part) => part.type !== "text");
  appendTextPart(message, answer);
}

function countRenderableImageMarkdown(text: string): number {
  return [
    ...String(text || "").matchAll(
      /!\[[^\]]*]\((?:\/generated\/|data:image\/|https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/)[^)]+\)/g,
    ),
  ].length;
}

export function renderEventError(events: any[] | undefined): string {
  if (!Array.isArray(events)) {
    return "";
  }
  const error = events.find((event) => event?.type === "error" && event.message);
  return error ? formatModelCallError(String(error.message)) : "";
}

export function applyStreamEventToMessage(
  message: StoredMessage,
  event: any,
): { approvalRequest?: any; questionRequest?: any } {
  message.pending = true;
  message.parts = Array.isArray(message.parts) ? message.parts : [];
  if (event?.runId) {
    message.runId = event.runId;
  }

  switch (event?.type) {
    case "turn.started":
      message.startedAt = event.at || message.startedAt || new Date().toISOString();
      break;
    case "assistant.delta":
      appendTextPart(message, event.text || "");
      break;
    case "assistant.final": {
      const answer = typeof event.text === "string" ? event.text : "";
      const existingText = collectMessageText(message);
      if (existingText && shouldReplaceStreamedText(existingText, answer, true)) {
        replaceTextPartsWithFinalAnswer(message, answer);
      } else if (!existingText && answer) {
        appendTextPart(message, answer);
      }
      break;
    }
    case "skill.invoked":
      appendSkillEventPart(message, event, "invoked");
      break;
    case "skill.loaded":
      appendSkillEventPart(message, event, "loaded");
      break;
    case "skill.forked":
      appendSkillEventPart(message, event, event.status || "finished");
      break;
    case "skill.cleared":
      appendNotePart(message, event.reason || translate("system.skillTurnEnded"), "muted");
      break;
    case "compaction.started":
      appendNotePart(message, translate("system.compactionStarted"), "compaction-started");
      break;
    case "compaction.finished": {
      const startedPart = findLatestPart<NotePart>(
        message,
        (part): part is NotePart => part.type === "note" && part.tone === "compaction-started",
      );
      if (startedPart) {
        startedPart.text = translate("system.compactionFinished");
        startedPart.tone = "compaction-finished";
      } else {
        appendNotePart(message, translate("system.compactionFinished"), "compaction-finished");
      }
      break;
    }
    case "assistant.status":
      appendDiagnosticNotePart(message, event.text || translate("system.statusUpdate"), "status", event.data);
      break;
    case "reasoning.started":
      applyReasoningEventPart(message, recordValue(event.reasoning), "running");
      break;
    case "reasoning.completed":
      applyReasoningEventPart(message, recordValue(event.reasoning), "complete");
      break;
    case "runtime.diagnostic":
      if (event.name === "turn.guided") {
        const data = recordValue(event.data);
        appendDiagnosticNotePart(
          message,
          turnGuidanceLabel(data),
          data.guided === true ? "guidance" : "warn",
          event.data,
        );
        break;
      }
      appendDiagnosticNotePart(message, runtimeDiagnosticLabel(event), "diagnostic");
      break;
    case "tool.started":
      if (isQuietToolEvent(event.toolId)) {
        break;
      }
      appendToolEventPart(message, {
        phase: "call",
        toolId: event.toolId,
        callId: event.callId,
        title: event.toolId || "Tool call",
        input: event.input,
        status: "running",
      });
      break;
    case "tool.progress": {
      if (isQuietToolEvent(event.toolId)) break;
      const runningTool = findLatestPart<ToolPart>(
        message,
        (part): part is ToolPart =>
          part.type === "tool" &&
          part.status === "running" &&
          (event.callId ? part.callId === event.callId : part.toolId === event.toolId),
      );
      if (runningTool) {
        runningTool.result = event.update;
      } else {
        appendToolEventPart(message, {
          phase: "progress",
          toolId: event.toolId,
          callId: event.callId,
          title: event.toolId || "Tool progress",
          result: event.update,
          status: "running",
        });
      }
      break;
    }
    case "tool.finished":
      if (isQuietToolEvent(event.toolId)) {
        break;
      }
      appendToolEventPart(message, {
        phase: "result",
        toolId: event.toolId,
        callId: event.callId,
        title: event.toolId || "Tool result",
        result: event.result?.value,
        error: event.result?.error || "",
        status: toolStatusFromResult(event.result),
      });
      break;
    case "approval.requested": {
      const request = event.request || {};
      appendToolEventPart(message, {
        phase: "approval",
        toolId: request.toolId || request.kind || request.title || "approval",
        title: request.title || request.toolId || "Approval",
        input: request.input,
        status: "requires-action",
        approvalId: request.id || "",
        approvalStatus: request.status || "pending",
        approvalReason: request.reason || "",
        approvalInput: request.input,
      });
      message.text = collectMessageText(message);
      return { approvalRequest: request };
    }
    case "approval.resolved":
      updateApprovalMessagePart(message, event.request, { fromStream: true });
      break;
    case "question.requested": {
      const question = event.question || {};
      appendToolEventPart(message, {
        phase: "question",
        toolId: "question",
        title: question.title || "Question",
        input: question.input,
        status: "requires-action",
        questionId: question.id || "",
        questionStatus: question.status || "pending",
        questionPrompt: question.prompt || "",
        questionInput: question.input,
      });
      message.text = collectMessageText(message);
      return { questionRequest: question };
    }
    case "question.answered":
      updateQuestionMessagePart(message, event.question, { fromStream: true });
      break;
    case "planning.updated":
      updatePlanningMessagePart(message, event.plan);
      break;
    case "error":
      closeDanglingMessageActivity(message, {
        status: "failed",
        errorMessage: event.message || translate("system.modelCallErrorPlain"),
      });
      appendNotePart(message, event.message || translate("system.modelCallErrorPlain"), "error");
      message.pending = false;
      message.finishedAt = message.finishedAt || new Date().toISOString();
      break;
    case "turn.finished":
      closeDanglingMessageActivity(message);
      message.pending = false;
      message.finishedAt = event.at || message.finishedAt || new Date().toISOString();
      break;
    default:
      break;
  }

  message.text = collectMessageText(message);
  return {};
}

function runtimeDiagnosticLabel(event: any): string {
  const name = String(event?.name || "").trim();
  if (isLowSignalRuntimeDiagnosticName(name)) {
    return "";
  }
  return humanizeDiagnosticName(name);
}

function turnGuidanceLabel(data: Record<string, unknown>): string {
  const instruction = stringValue(data.instructionPreview);
  if (data.guided === true) {
    return instruction ? translate("system.guidedWith", { instruction }) : translate("system.guided");
  }
  const error = stringValue(data.error);
  return error ? translate("system.guideNotDeliveredWith", { error }) : translate("system.guideNotDelivered");
}

function isLowSignalRuntimeDiagnosticName(name: string): boolean {
  return (
    /^cloud_connector(?:[._]|$)/i.test(name) ||
    /^claude\.sdk\.hook_(?:started|progress|response)$/i.test(name) ||
    /\.configured$/i.test(name) ||
    /\.session$/i.test(name) ||
    /\.init$/i.test(name) ||
    /\.result$/i.test(name) ||
    /\.auth_status$/i.test(name) ||
    /\.goal\.cleared$/i.test(name) ||
    /\.app_server\.request$/i.test(name)
  );
}

function humanizeDiagnosticName(name: string): string {
  const normalized = name.replace(/[._-]+/g, " ").trim();
  if (!normalized) return translate("system.diagnosticUpdate");
  return translate("system.diagnosticWith", { name: normalized });
}

function cleanDiagnosticText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function messageTimingFromEvents(events: any[] | undefined): { startedAt?: string; finishedAt?: string } {
  if (!Array.isArray(events)) {
    return {};
  }
  const started = events.find((event) => event?.type === "turn.started" && event.at);
  const finished = [...events].reverse().find((event) => event?.type === "turn.finished" && event.at);
  return {
    startedAt: typeof started?.at === "string" ? started.at : undefined,
    finishedAt: typeof finished?.at === "string" ? finished.at : undefined,
  };
}

function isQuietToolEvent(toolId: unknown): boolean {
  return toolId === "room.ledger.read" || toolId === "claude.tool" || toolId === "claude.AskUserQuestion";
}

function isCodexNativeProcessTool(toolId: unknown): boolean {
  return typeof toolId === "string" && toolId.startsWith("codex.");
}

export function updateApprovalMessagePart(
  message: StoredMessage,
  request: any,
  options: { fromStream?: boolean } = {},
): boolean {
  if (!request?.id) {
    return false;
  }
  const responseError = typeof request.response?.error === "string" ? request.response.error : "";
  for (const part of message.parts || []) {
    if (part?.type !== "tool" || part.phase !== "approval" || part.approvalId !== request.id) {
      continue;
    }
    part.approvalStatus = request.status || part.approvalStatus || "";
    if (request.reason) {
      part.approvalReason = request.reason;
    }
    if (request.status === "approved" && part.status === "requires-action") {
      part.status = options.fromStream ? "approved" : part.status;
    }
    if (request.status === "rejected") {
      part.status = "rejected";
      if (responseError) {
        part.error = responseError;
      }
    }
    message.pending = false;
    return true;
  }
  return false;
}

export function updateQuestionMessagePart(
  message: StoredMessage,
  question: any,
  options: { fromStream?: boolean } = {},
): boolean {
  if (!question?.id) {
    return false;
  }
  for (const part of message.parts || []) {
    if (part?.type !== "tool" || part.phase !== "question" || part.questionId !== question.id) {
      continue;
    }
    part.questionStatus = question.status || part.questionStatus || "";
    if (question.prompt) {
      part.questionPrompt = question.prompt;
    }
    if (Object.prototype.hasOwnProperty.call(question, "response")) {
      part.result = question.response;
    }
    if (question.status === "answered" && part.status === "requires-action") {
      part.status = options.fromStream ? "answered" : part.status;
    }
    if (question.status === "declined") {
      part.status = "declined";
    }
    return true;
  }
  return false;
}

export function updatePlanningMessagePart(message: StoredMessage, plan: any): boolean {
  if (!plan?.id) {
    return false;
  }
  const existing = findLatestPart<ToolPart>(
    message,
    (part): part is ToolPart =>
      part.type === "tool" &&
      part.phase === "planning" &&
      part.toolId === "planning.plan" &&
      Boolean(part.input) &&
      typeof part.input === "object" &&
      !Array.isArray(part.input) &&
      (part.input as Record<string, unknown>).id === plan.id,
  );
  if (existing) {
    existing.title = plan.title || existing.title || "Plan";
    existing.input = plan;
    existing.result = plan;
    existing.status = plan.status === "completed" ? "complete" : "running";
    message.pending = true;
    return true;
  }
  appendToolEventPart(message, {
    phase: "planning",
    toolId: "planning.plan",
    title: plan.title || "Plan",
    input: plan,
    result: plan,
    status: plan.status === "completed" ? "complete" : "running",
  });
  message.pending = true;
  return true;
}

export function applyApprovalResultToMessages(
  messages: StoredMessage[],
  approvalId: string,
  result: any,
  action: string,
): boolean {
  const request = result?.approval;
  if (!request?.id) {
    return false;
  }

  let updated = false;
  for (const message of messages) {
    updated = updateApprovalMessagePart(message, request) || updated;
    for (const part of message.parts || []) {
      if (part?.type !== "tool" || part.phase !== "approval" || part.approvalId !== approvalId) {
        continue;
      }
      updated = true;
      if (action === "approve" && request.status === "approved") {
        part.status = "approved";
      }
      if (action !== "approve") {
        part.status = "rejected";
      }

      const toolValue = result?.toolResult?.value;
      if (toolValue !== undefined || result?.toolResult?.error) {
        appendToolEventPart(message, {
          phase: "result",
          toolId: part.toolId,
          title: part.title,
          result: toolValue,
          error: result?.toolResult?.error || "",
          status: toolStatusFromResult(result.toolResult),
        });
      }

      if (result?.alreadyResolved) {
        appendNotePart(message, translate("system.actionAlreadyHandled"), "muted");
      } else if (toolValue?.needsReobserve) {
        appendNotePart(message, translate("system.reobserveNeeded"), "warn");
      } else if (toolValue?.status === "staged") {
        appendNotePart(message, translate("system.actionStaged"), "muted");
      } else if (isApprovalTimeoutError(part.error)) {
        appendNotePart(message, translate("system.approvalTimeout"), "warn");
      } else if (action !== "approve") {
        appendNotePart(message, translate("system.actionDeclined"), "muted");
      }
      message.pending = false;
      message.text = collectMessageText(message);
    }
  }

  return updated;
}

function isApprovalTimeoutError(error: unknown): boolean {
  return typeof error === "string" && /approval request timed out/i.test(error);
}

export function applyQuestionResultToMessages(
  messages: StoredMessage[],
  questionId: string,
  result: any,
  action: string,
): boolean {
  const question = result?.question;
  if (!question?.id) {
    return false;
  }

  let updated = false;
  for (const message of messages) {
    updated = updateQuestionMessagePart(message, question) || updated;
    for (const part of message.parts || []) {
      if (part?.type !== "tool" || part.phase !== "question" || part.questionId !== questionId) {
        continue;
      }
      updated = true;
      if (action === "answer" && question.status === "answered") {
        part.status = "answered";
      }
      if (action !== "answer") {
        part.status = "declined";
      }
      message.text = collectMessageText(message);
    }
  }

  return updated;
}
