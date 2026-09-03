import type {
  AgentEvent,
  AgentTurnRequest,
  ApprovalRequest,
  JsonObject,
  JsonValue,
  QuestionRequest,
} from "../../core.js";
import type { AsyncEventQueue } from "./async-event-queue.js";
import { isJsonObject, readBoolean, readNumber, readString, truncateText } from "./json.js";

// Codex marks non-blocking questions as eligible for automatic empty answers.
// Its native TUI currently grants a two-minute answer window; OpenGrove keeps
// the request answerable for the same period instead of immediately declining.
const CODEX_NON_BLOCKING_QUESTION_GRACE_MS = 120_000;

export async function handleCodexApprovalRequest(
  serverRequest: { id?: number | string; method: string; params?: JsonValue },
  context: {
    threadId: string;
    turnId: string;
    runId: string;
    request: AgentTurnRequest;
    queue: AsyncEventQueue<AgentEvent>;
  },
): Promise<JsonValue | undefined> {
  const requestParams = isJsonObject(serverRequest.params) ? serverRequest.params : undefined;
  if (!matchesCurrentCodexTurn(requestParams, context.threadId, context.turnId)) {
    return undefined;
  }
  const approval = context.request.context.approvals.request({
    kind: codexApprovalKindForMethod(serverRequest.method),
    title: codexApprovalTitle(serverRequest.method),
    reason: codexApprovalReason(serverRequest.method, requestParams),
    input: buildCodexNativeRequestInput(serverRequest.method, requestParams),
    resume: {
      type: "kernel.native",
      kernelId: "codex",
      runId: context.runId,
      continuation: "same-loop",
    },
    nativeRequestId:
      serverRequest.id === undefined ? readString(requestParams ?? {}, "requestId") : String(serverRequest.id),
  });
  context.queue.push({ type: "approval.requested", runId: context.runId, request: approval });

  try {
    const decided = await context.request.context.approvals.waitForDecision(approval.id, {
      signal: context.request.signal,
    });
    context.queue.push({ type: "approval.resolved", runId: context.runId, request: decided });
    return buildCodexApprovalResponse(serverRequest.method, requestParams, decided);
  } catch (error) {
    const current = context.request.context.approvals.get(approval.id);
    const canceled =
      current?.status === "pending"
        ? context.request.context.approvals.decide(approval.id, "canceled", {
            system: true,
            reasonCode: context.request.signal?.aborted ? "run_canceled" : "native_request_failed",
          })
        : current;
    if (canceled) {
      context.queue.push({ type: "approval.resolved", runId: context.runId, request: canceled });
    }
    context.queue.push({
      type: "error",
      runId: context.runId,
      message: error instanceof Error ? error.message : String(error),
    });
    return buildCodexApprovalResponse(serverRequest.method, requestParams, canceled ?? false);
  }
}

export async function handleCodexUserInputRequest(
  serverRequest: { id?: number | string; method: string; params?: JsonValue },
  context: {
    runId: string;
    request: AgentTurnRequest;
    queue: AsyncEventQueue<AgentEvent>;
  },
): Promise<JsonValue> {
  const requestParams = isJsonObject(serverRequest.params) ? serverRequest.params : undefined;
  const waiting = codexQuestionWaitingSemantics(serverRequest, requestParams);
  const question = context.request.context.questions.request({
    title: "Codex 用户输入请求",
    prompt: codexUserInputReason(requestParams),
    input: buildCodexNativeRequestInput(serverRequest.method, requestParams),
    resume: {
      type: "kernel.native",
      kernelId: "codex",
      runId: context.runId,
      continuation: "same-loop",
    },
    source: { type: "kernel.native", kernelId: "codex" },
    ...waiting,
  });
  context.queue.push({ type: "question.requested", runId: context.runId, question });
  const decided = await waitForCodexQuestionDecision(context, question);
  if (decided) {
    context.queue.push({ type: "question.answered", runId: context.runId, question: decided });
  }
  return buildCodexUserInputResponse(requestParams, decided);
}

export async function handleCodexElicitationRequest(
  serverRequest: { id?: number | string; method: string; params?: JsonValue },
  context: {
    runId: string;
    request: AgentTurnRequest;
    queue: AsyncEventQueue<AgentEvent>;
  },
): Promise<JsonValue> {
  const requestParams = isJsonObject(serverRequest.params) ? serverRequest.params : undefined;
  const waiting = codexQuestionWaitingSemantics(serverRequest, requestParams);
  const question = context.request.context.questions.request({
    title: "Codex MCP 提问请求",
    prompt: codexUserInputReason(requestParams),
    input: buildCodexNativeRequestInput(serverRequest.method, requestParams),
    resume: {
      type: "kernel.native",
      kernelId: "codex",
      runId: context.runId,
      continuation: "same-loop",
    },
    source: { type: "kernel.native", kernelId: "codex" },
    ...waiting,
  });
  context.queue.push({ type: "question.requested", runId: context.runId, question });
  const decided = await waitForCodexQuestionDecision(context, question);
  if (decided) {
    context.queue.push({ type: "question.answered", runId: context.runId, question: decided });
  }
  return decided.status === "answered"
    ? { action: "accept", content: normalizeUserInputContent(decided.response, requestParams) }
    : { action: "decline" };
}

export function defaultCodexApprovalResponse(method: string): JsonValue {
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method === "item/fileChange/requestApproval" || method === "item/commandExecution/requestApproval") {
    return { decision: "decline" };
  }
  return { decision: "decline" };
}

export function isCodexApprovalRequest(method: string): boolean {
  return method.includes("requestApproval") || method.includes("Approval");
}

function buildCodexUserInputResponse(requestParams: JsonObject | undefined, decided: QuestionRequest): JsonObject {
  if (decided.status !== "answered") {
    return { answers: {} };
  }
  return {
    answers: normalizeUserInputAnswers(decided.response, requestParams),
  };
}

function normalizeUserInputAnswers(value: JsonValue | undefined, requestParams: JsonObject | undefined): JsonObject {
  const object = isJsonObject(value) ? value : undefined;
  const answers = isJsonObject(object?.answers) ? object.answers : undefined;
  if (answers) {
    return normalizeCodexUserInputAnswerMap(answers);
  }

  const text =
    typeof value === "string"
      ? value.trim()
      : (readString(object ?? {}, "text") ?? readString(object ?? {}, "answer") ?? "");
  if (!text) {
    return {};
  }

  const firstQuestionId = readFirstQuestionId(requestParams);
  return firstQuestionId ? { [firstQuestionId]: { answers: [text] } } : { answer: { answers: [text] } };
}

function normalizeCodexUserInputAnswerMap(value: JsonObject): JsonObject {
  const normalized: JsonObject = {};
  for (const [key, answer] of Object.entries(value)) {
    const strings = normalizeAnswerStrings(answer);
    normalized[key] = { answers: strings };
  }
  return normalized;
}

function normalizeAnswerStrings(value: JsonValue | undefined): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (isJsonObject(value)) {
    const answers = value.answers;
    if (Array.isArray(answers)) {
      return answers
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    const text = readString(value, "text") ?? readString(value, "answer") ?? "";
    return text ? [text] : [];
  }
  return [];
}

function normalizeUserInputContent(value: JsonValue | undefined, requestParams: JsonObject | undefined): JsonObject {
  const object = isJsonObject(value) ? value : undefined;
  if (isJsonObject(object?.content)) {
    return object.content;
  }
  if (isJsonObject(object?.answers)) {
    return normalizeFlatUserInputContent(object.answers);
  }
  const text =
    typeof value === "string"
      ? value.trim()
      : (readString(object ?? {}, "text") ?? readString(object ?? {}, "answer") ?? "");
  const firstQuestionId = readFirstQuestionId(requestParams);
  return firstQuestionId ? { [firstQuestionId]: text } : { answer: text, text };
}

function normalizeFlatUserInputContent(value: JsonObject): JsonObject {
  const normalized: JsonObject = {};
  for (const [key, answer] of Object.entries(value)) {
    normalized[key] = normalizeAnswerStrings(answer)[0] ?? "";
  }
  return normalized;
}

function readFirstQuestionId(requestParams: JsonObject | undefined): string | undefined {
  const questions = Array.isArray(requestParams?.questions)
    ? requestParams?.questions
    : Array.isArray(requestParams?.fields)
      ? requestParams?.fields
      : undefined;
  const first = questions?.find((item) => isJsonObject(item)) as JsonObject | undefined;
  return readString(first ?? {}, "id") ?? readString(first ?? {}, "name");
}

async function waitForCodexQuestionDecision(
  context: {
    runId: string;
    request: AgentTurnRequest;
    queue: AsyncEventQueue<AgentEvent>;
  },
  question: QuestionRequest,
): Promise<QuestionRequest> {
  const timeoutMs =
    question.isBlocking === false
      ? (question.autoResolutionMs ?? CODEX_NON_BLOCKING_QUESTION_GRACE_MS)
      : question.autoResolutionMs;
  try {
    return await context.request.context.questions.waitForDecision(question.id, {
      timeoutMs,
      signal: context.request.signal,
    });
  } catch (error) {
    const current = context.request.context.questions.get(question.id);
    const message = error instanceof Error ? error.message : String(error);
    const canceled =
      current?.status === "pending"
        ? context.request.context.questions.decide(question.id, "canceled", {
            system: true,
            reasonCode: message.includes("aborted") ? "run_canceled" : "native_auto_resolved",
          })
        : current;
    return canceled ?? question;
  }
}

function codexQuestionWaitingSemantics(
  serverRequest: { id?: number | string },
  requestParams: JsonObject | undefined,
): Pick<QuestionRequest, "nativeRequestId" | "isBlocking" | "autoResolutionMs" | "deadlineAt"> {
  const autoResolutionMs = readNumber(requestParams, "autoResolutionMs");
  const isBlocking = readBoolean(requestParams, "isBlocking");
  const effectiveAutoResolutionMs =
    autoResolutionMs !== undefined && autoResolutionMs > 0
      ? autoResolutionMs
      : isBlocking === false
        ? CODEX_NON_BLOCKING_QUESTION_GRACE_MS
        : undefined;
  return {
    nativeRequestId: serverRequest.id === undefined ? readString(requestParams, "requestId") : String(serverRequest.id),
    isBlocking,
    ...(autoResolutionMs !== undefined && autoResolutionMs > 0
      ? {
          autoResolutionMs,
        }
      : {}),
    ...(effectiveAutoResolutionMs !== undefined
      ? { deadlineAt: new Date(Date.now() + effectiveAutoResolutionMs).toISOString() }
      : {}),
  };
}

export function matchesCurrentCodexTurn(
  requestParams: JsonObject | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!requestParams) return false;
  const requestThreadId = readString(requestParams, "threadId") ?? readString(requestParams, "conversationId");
  const requestTurnId = readString(requestParams, "turnId");
  if (!requestThreadId || requestThreadId !== threadId) return false;
  if (requestTurnId && (!turnId || requestTurnId !== turnId)) return false;
  return true;
}

function codexApprovalKindForMethod(method: string): ApprovalRequest["kind"] {
  if (method.includes("commandExecution") || method.includes("execCommand")) {
    return "command";
  }
  if (method.includes("fileChange") || method.includes("Patch")) {
    return "file_change";
  }
  if (method.includes("permissions")) {
    return "permission_scope";
  }
  return "permission_scope";
}

function codexApprovalTitle(method: string): string {
  const kind = codexApprovalKindForMethod(method);
  if (kind === "command") {
    return "Codex 命令执行确认";
  }
  if (kind === "file_change") {
    return "Codex 文件修改确认";
  }
  return "Codex 权限确认";
}

function codexApprovalReason(method: string, requestParams: JsonObject | undefined): string {
  const reason = readString(requestParams, "reason");
  const command = readCommand(requestParams);
  if (reason) {
    return reason;
  }
  if (command) {
    return `Codex 请求执行命令：${truncateText(command, 220)}`;
  }
  if (method.includes("fileChange")) {
    const itemId = readString(requestParams, "itemId") ?? readString(requestParams, "targetItemId");
    return itemId ? `Codex 请求应用文件修改：${itemId}` : "Codex 请求应用文件修改。";
  }
  if (method.includes("permissions")) {
    return "Codex 请求提升本轮权限。";
  }
  return "Codex 请求用户批准后继续。";
}

function codexUserInputReason(requestParams: JsonObject | undefined): string {
  const title = readString(requestParams, "title");
  const instructions = readString(requestParams, "instructions") ?? readString(requestParams, "message");
  return [title, instructions].filter(Boolean).join("\n") || "Codex 请求你回答一个结构化问题。";
}

function buildCodexNativeRequestInput(method: string, requestParams: JsonObject | undefined): JsonObject {
  return {
    method,
    ...(requestParams ? { params: requestParams } : {}),
  };
}

function buildCodexApprovalResponse(
  method: string,
  requestParams: JsonObject | undefined,
  decision: ApprovalRequest | boolean,
): JsonValue {
  const approved = typeof decision === "boolean" ? decision : decision.status === "approved";
  const canceled = typeof decision !== "boolean" && decision.status === "canceled";
  const response =
    typeof decision === "boolean" ? undefined : isJsonObject(decision.response) ? decision.response : undefined;
  if (method === "item/permissions/requestApproval") {
    return approved
      ? {
          permissions: requestedCodexPermissions(requestParams),
          scope: readString(response, "scope") === "session" ? "session" : "turn",
        }
      : { permissions: {}, scope: "turn" };
  }
  if (method === "item/commandExecution/requestApproval") {
    return { decision: commandApprovalDecision(requestParams, approved, canceled, response) };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: fileChangeApprovalDecision(approved, canceled, response) };
  }
  return { decision: approved ? "accept" : "decline" };
}

function commandApprovalDecision(
  requestParams: JsonObject | undefined,
  approved: boolean,
  canceled: boolean,
  response: JsonObject | undefined,
): JsonValue {
  if (!approved) {
    return hasAvailableDecision(requestParams, "cancel") && (canceled || readBoolean(response, "cancel"))
      ? "cancel"
      : "decline";
  }
  const requested = response?.decision;
  if (isAvailableDecision(requestParams, requested)) {
    return requested as JsonValue;
  }
  if (readString(response, "scope") === "session" && hasAvailableDecision(requestParams, "acceptForSession")) {
    return "acceptForSession";
  }
  return hasAvailableDecision(requestParams, "accept") ? "accept" : "decline";
}

function fileChangeApprovalDecision(approved: boolean, canceled: boolean, response: JsonObject | undefined): JsonValue {
  if (!approved) {
    return canceled || readBoolean(response, "cancel") ? "cancel" : "decline";
  }
  return readString(response, "scope") === "session" ? "acceptForSession" : "accept";
}

function hasAvailableDecision(requestParams: JsonObject | undefined, decision: string): boolean {
  const available = requestParams?.availableDecisions;
  if (!Array.isArray(available) || available.length === 0) {
    return true;
  }
  return available.some(
    (item) => item === decision || (isJsonObject(item) && Object.prototype.hasOwnProperty.call(item, decision)),
  );
}

function isAvailableDecision(requestParams: JsonObject | undefined, decision: JsonValue | undefined): boolean {
  if (typeof decision === "string") {
    return hasAvailableDecision(requestParams, decision);
  }
  if (isJsonObject(decision)) {
    const [key] = Object.keys(decision);
    return Boolean(key && hasAvailableDecision(requestParams, key));
  }
  return false;
}

function requestedCodexPermissions(requestParams: JsonObject | undefined): JsonObject {
  const permissions = isJsonObject(requestParams?.permissions) ? requestParams.permissions : {};
  const granted: JsonObject = {};
  if (isJsonObject(permissions.network)) {
    granted.network = permissions.network;
  }
  if (isJsonObject(permissions.fileSystem)) {
    granted.fileSystem = permissions.fileSystem;
  }
  return granted;
}

function readCommand(record: JsonObject | undefined): string | undefined {
  const command = record?.command;
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return command.join(" ");
  }
  return undefined;
}
