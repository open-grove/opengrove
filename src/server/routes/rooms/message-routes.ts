import { Buffer } from "node:buffer";
import type { CreateRoomMessageOperation } from "#protocol";
import type { PostRoomMessageResult, RoomChannelMember, RoomChannelMessage } from "../../../rooms/channel-store.js";
import { normalizeRoomMessageDeliveryKind, normalizeRoomSelectedFile } from "../../../rooms/channel-normalize.js";
import { readWwRuntimeAuth } from "../../bridge-security.js";
import { findRoomPmMember } from "../../room-delegation.js";
import { cancelRoomAssistantRun, isRunnableRoomAssistantTarget, scheduleRoomAssistantRuns } from "../../room-runs.js";
import { roomTargetSupportsHostTools } from "../../room-runs/execution-state.js";
import { canRoomPmAutoRoute } from "../../../rooms/room-pm.js";
import { record } from "../../http-utils.js";
import {
  readAttachments,
  readJsonObjects,
  readMessageStatus,
  readOptionalPositiveInt,
  readOptionalString,
  readPositiveInt,
  readString,
  readStringArray,
  resolveVisibleRoomTargets,
  updateNonRunnableLocalTarget,
} from "./normalizers.js";
import type { RoomsRouteContext } from "./route-context.js";
import { hostMessage, type HostMessageCode } from "../../../localization/host-messages.js";
import { resolveHostLanguageSettings } from "../../language-preference.js";
import { presentRoomMessage } from "../../room-presentation.js";
import type { HostOperationRouteContext } from "../../router.js";

export async function handleRoomMessageRoutes(context: RoomsRouteContext): Promise<boolean> {
  return (
    (await handleMessageAttachmentContentRoute(context)) ||
    (await handleMessagesListRoute(context)) ||
    (await handleAgentMessageRoute(context)) ||
    (await handleMessageCancelRoute(context)) ||
    (await handleMessageDeleteRoute(context)) ||
    (await handleMessagePatchRoute(context))
  );
}

function handleMessageAttachmentContentRoute(context: RoomsRouteContext): boolean {
  const { request, response, url, state, sendJson } = context;
  const action = url.pathname.match(/^\/rooms\/([^/]+)\/messages\/([^/]+)\/attachments\/(\d+)\/content$/);
  if (!action || request.method !== "GET") return false;
  const roomId = decodeURIComponent(action[1]!);
  const messageId = decodeURIComponent(action[2]!);
  const attachmentIndex = Number(action[3]);
  const attachment = state.app.rooms.getMessage(roomId, messageId)?.attachments?.[attachmentIndex];
  const content = attachment ? roomAttachmentContent(attachment) : undefined;
  if (!attachment || !content) {
    sendJson(response, 404, { ok: false, error: "room_attachment_content_not_found" });
    return true;
  }
  response.writeHead(200, {
    "content-type": content.mimeType,
    "content-length": String(content.body.length),
    "cache-control": "private, max-age=3600",
    "content-security-policy": "sandbox",
    "x-content-type-options": "nosniff",
  });
  response.end(content.body);
  return true;
}

function handleMessagesListRoute(context: RoomsRouteContext): boolean {
  const { request, response, url, state, sendJson } = context;
  const messagesAction = url.pathname.match(/^\/rooms\/([^/]+)\/messages$/);
  if (!messagesAction || request.method !== "GET") return false;
  const encodedRoomId = messagesAction[1]!;
  const messages = state.app.rooms.listVisibleMessages(decodeURIComponent(encodedRoomId), {
    limit: Math.min(readPositiveInt(url.searchParams.get("limit"), 80), 200),
    beforeSeq: readOptionalPositiveInt(url.searchParams.get("beforeSeq")),
    afterSeq: readOptionalPositiveInt(url.searchParams.get("afterSeq")),
  });
  sendJson(response, 200, {
    ok: true,
    messages: messages.map(presentRoomMessage),
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}

async function handleAgentMessageRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = context;
  const agentMessagesAction = url.pathname.match(/^\/rooms\/([^/]+)\/agent-messages$/);
  if (!agentMessagesAction || request.method !== "POST") return false;
  const encodedRoomId = agentMessagesAction[1]!;
  const body = record(await readJsonBody(request));
  const roomId = decodeURIComponent(encodedRoomId);
  const senderId = readString(body.senderId);
  if (!senderId) {
    sendJson(response, 400, { ok: false, error: "sender_id_required" });
    return true;
  }
  const message = state.app.rooms.postAgentMessage({
    roomId,
    senderId,
    senderName: readString(body.senderName) || "Agent",
    text: readString(body.text),
    targetIds: readStringArray(body.targetIds),
    id: readOptionalString(body.id),
    status: "done",
    deliveryKind: normalizeRoomMessageDeliveryKind(body.deliveryKind),
    inReplyToMessageId: readOptionalString(body.inReplyToMessageId),
    rootMessageId: readOptionalString(body.rootMessageId),
    selectedFile: normalizeRoomSelectedFile(body.selectedFile),
  });
  state.store.saveFrom(state.app);
  sendJson(response, 200, {
    ok: true,
    message: presentRoomMessage(message),
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}

export async function handleCreateRoomMessageOperation(
  context: HostOperationRouteContext<CreateRoomMessageOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  const { roomId } = context.input.params;
  const body = context.input.body;
  const text = body.text;
  const selectedFile = normalizeRoomSelectedFile(body.selectedFile);
  const inReplyToMessageId = body.inReplyToMessageId;
  const replyParent = inReplyToMessageId ? state.app.rooms.getMessage(roomId, inReplyToMessageId) : undefined;
  if (inReplyToMessageId && !replyParent) {
    sendJson(response, 404, { ok: false, error: "reply_message_not_found" });
    return true;
  }
  const rootMessageId = replyParent
    ? replyParent.rootMessageId && state.app.rooms.getMessage(roomId, replyParent.rootMessageId)
      ? replyParent.rootMessageId
      : replyParent.id
    : undefined;
  const userDeliveryKind =
    /@all\b/i.test(text) || /@(所有人|全部)/.test(text) ? ("user_broadcast" as const) : ("user_direct" as const);
  const targetIds = resolveVisibleRoomTargets(state, roomId, text, body.targetIds);
  const assistantTargets = targetIds
    .map((id) => state.app.rooms.listMembers().find((member) => member.id === id))
    .filter((member): member is RoomChannelMember => Boolean(member));
  if (targetIds.length === 0) {
    const pm = findRoomPmMember(state, roomId);
    if (pm) {
      if (!canExecutePmAutoRoute(state, roomId, pm)) {
        const result = state.app.rooms.postUserMessage({
          roomId,
          text,
          targetIds: [pm.id],
          attachments: readAttachments(body.attachments),
          assistantTargets: [],
          userMessageId: body.userMessageId,
          deliveryKind: "pm_auto_route",
          inReplyToMessageId,
          rootMessageId,
          selectedFile,
        });
        return respondWithHostFallback(context, roomId, result, "room.pm_auto_route_unavailable");
      }
      const pmAssistantTargets = [pm];
      const result = state.app.rooms.postUserMessage({
        roomId,
        text,
        targetIds: [pm.id],
        attachments: readAttachments(body.attachments),
        assistantTargets: pmAssistantTargets,
        userMessageId: body.userMessageId,
        assistantMessageIds: body.assistantMessageIds ?? [],
        deliveryKind: "pm_auto_route",
        inReplyToMessageId,
        rootMessageId,
        selectedFile,
      });
      state.store.saveFrom(state.app);
      const updatedMessages = await scheduleAndFallbackAssistantMessages(context, result, pmAssistantTargets, roomId);
      if (updatedMessages.size) {
        result.assistantMessages = result.assistantMessages.map(
          (message) => updatedMessages.get(message.id) ?? message,
        );
        result.currentEventSeq = state.app.rooms.snapshot().currentEventSeq;
        state.store.saveFrom(state.app);
      }
      sendJson(response, 200, presentPostRoomMessageResult(result));
      return true;
    }
    const result = state.app.rooms.postUserMessage({
      roomId,
      text,
      targetIds,
      attachments: readAttachments(body.attachments),
      assistantTargets,
      userMessageId: body.userMessageId,
      assistantMessageIds: body.assistantMessageIds ?? [],
      deliveryKind: userDeliveryKind,
      inReplyToMessageId,
      rootMessageId,
      selectedFile,
    });
    return respondWithHostFallback(context, roomId, result, "room.reply_target_required");
  }
  const result = state.app.rooms.postUserMessage({
    roomId,
    text,
    targetIds,
    attachments: readAttachments(body.attachments),
    assistantTargets,
    userMessageId: body.userMessageId,
    assistantMessageIds: body.assistantMessageIds ?? [],
    deliveryKind: userDeliveryKind,
    inReplyToMessageId,
    rootMessageId,
    selectedFile,
  });
  state.store.saveFrom(state.app);
  const updatedMessages = await scheduleAndFallbackAssistantMessages(context, result, assistantTargets, roomId);
  if (updatedMessages.size) {
    result.assistantMessages = result.assistantMessages.map((message) => updatedMessages.get(message.id) ?? message);
    result.currentEventSeq = state.app.rooms.snapshot().currentEventSeq;
    state.store.saveFrom(state.app);
  }
  sendJson(response, 200, presentPostRoomMessageResult(result));
  return true;
}

function respondWithHostFallback(
  context: RoomsRouteContext,
  roomId: string,
  result: PostRoomMessageResult,
  messageCode: HostMessageCode,
): true {
  const { response, sendJson, state } = context;
  result.assistantMessages = [
    state.app.rooms.postSystemMessage({
      roomId,
      text: hostMessage(resolveHostLanguageSettings(state.settings), messageCode),
    }),
  ];
  result.currentEventSeq = state.app.rooms.snapshot().currentEventSeq;
  state.store.saveFrom(state.app);
  sendJson(response, 200, presentPostRoomMessageResult(result));
  return true;
}

function canExecutePmAutoRoute(state: RoomsRouteContext["state"], roomId: string, pm: RoomChannelMember): boolean {
  const room = state.app.rooms.getRoom(roomId);
  return canRoomPmAutoRoute(pm, {
    isRoomAdministrator: room?.adminMemberIds.includes(pm.id) ?? false,
    hostTools: roomTargetSupportsHostTools(pm),
  });
}

async function scheduleAndFallbackAssistantMessages(
  context: RoomsRouteContext,
  result: {
    userMessage: RoomChannelMessage;
    assistantMessages: RoomChannelMessage[];
  },
  assistantTargets: RoomChannelMember[],
  roomId: string,
): Promise<Map<string, RoomChannelMessage>> {
  const { request, state } = context;
  const runnablePairs = result.assistantMessages
    .map((message, index) => ({ message, target: assistantTargets[index] }))
    .filter((pair): pair is { message: RoomChannelMessage; target: RoomChannelMember } =>
      Boolean(pair.target && isRunnableRoomAssistantTarget(pair.target)),
    );
  const wwAuth = context.security
    ? (await readWwRuntimeAuth(request, context.response, context.security))?.auth
    : undefined;
  const scheduledMessages = scheduleRoomAssistantRuns(state, {
    roomId,
    triggerMessageId: result.userMessage.id,
    targets: runnablePairs.map((pair) => pair.target),
    assistantMessages: runnablePairs.map((pair) => pair.message),
    ...(wwAuth ? { wwAuth } : {}),
    traceId: context.traceId,
  });
  const updatedMessages = new Map(scheduledMessages.map((message) => [message.id, message]));
  for (const [index, message] of result.assistantMessages.entries()) {
    const target = assistantTargets[index];
    if (!target || updatedMessages.has(message.id)) continue;
    const fallback = updateNonRunnableLocalTarget(state, roomId, target, message);
    updatedMessages.set(fallback.id, fallback);
  }
  return updatedMessages;
}

async function handleMessageCancelRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson } = context;
  const cancelAction = url.pathname.match(/^\/rooms\/([^/]+)\/messages\/([^/]+)\/cancel$/);
  if (!cancelAction || request.method !== "POST") return false;
  const encodedRoomId = cancelAction[1]!;
  const encodedMessageId = cancelAction[2]!;
  const roomId = decodeURIComponent(encodedRoomId);
  const messageId = decodeURIComponent(encodedMessageId);
  const message = state.app.rooms.listMessages(roomId, { limit: 200 }).find((candidate) => candidate.id === messageId);
  if (!message) {
    sendJson(response, 404, { ok: false, error: "message_not_found" });
    return true;
  }
  if (message.senderType !== "agent") {
    sendJson(response, 409, { ok: false, error: "message_not_cancelable" });
    return true;
  }
  // run 已结束才点：幂等返回成功(连同权威 message,让前端把乐观态对齐回真实终态)，
  // 不要把已完成的 done 改成 interrupted。
  if (message.status === "done" || message.status === "failed" || message.status === "interrupted") {
    sendJson(response, 200, {
      ok: true,
      cancelled: false,
      status: message.status,
      message: presentRoomMessage(message),
      currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
    });
    return true;
  }
  const cancelled = message.runId ? cancelRoomAssistantRun(state, message.runId) : false;
  // 立即写 interrupted 给前端即时反馈；text 不在此写死——executeRoomRun 的 finalize
  // 是权威后写方，会写"保留已吐出内容"的文本。
  const updated = state.app.rooms.updateMessage(roomId, message.id, {
    status: "interrupted",
    finishedAt: new Date().toISOString(),
  });
  state.store.saveFrom(state.app);
  sendJson(response, 200, {
    ok: true,
    cancelled,
    message: presentRoomMessage(updated),
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}

async function handleMessagePatchRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = context;
  const messageAction = url.pathname.match(/^\/rooms\/([^/]+)\/messages\/([^/]+)$/);
  if (!messageAction || request.method !== "PATCH") return false;
  const encodedRoomId = messageAction[1]!;
  const encodedMessageId = messageAction[2]!;
  const body = record(await readJsonBody(request));
  const message = state.app.rooms.updateMessage(
    decodeURIComponent(encodedRoomId),
    decodeURIComponent(encodedMessageId),
    normalizeMessagePatch(body),
  );
  state.store.saveFrom(state.app);
  sendJson(response, 200, {
    ok: true,
    message: presentRoomMessage(message),
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}

function presentPostRoomMessageResult(result: PostRoomMessageResult): Record<string, unknown> {
  return {
    ok: true,
    ...result,
    userMessage: presentRoomMessage(result.userMessage),
    assistantMessages: result.assistantMessages.map(presentRoomMessage),
  };
}

function roomAttachmentContent(
  attachment: NonNullable<RoomChannelMessage["attachments"]>[number],
): { mimeType: string; body: Buffer } | undefined {
  if (attachment.dataUrl) {
    const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(attachment.dataUrl);
    if (!match) return undefined;
    const mimeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(match[1]!) ? match[1]! : "application/octet-stream";
    try {
      return {
        mimeType,
        body: match[2]
          ? Buffer.from(match[3]!.replace(/\s/g, ""), "base64")
          : Buffer.from(decodeURIComponent(match[3]!), "utf8"),
      };
    } catch {
      return undefined;
    }
  }
  if (attachment.text !== undefined) {
    return {
      mimeType: attachment.mimeType || "text/plain; charset=utf-8",
      body: Buffer.from(attachment.text, "utf8"),
    };
  }
  return undefined;
}

async function handleMessageDeleteRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson } = context;
  const messageAction = url.pathname.match(/^\/rooms\/([^/]+)\/messages\/([^/]+)$/);
  if (!messageAction || request.method !== "DELETE") return false;
  const encodedRoomId = messageAction[1]!;
  const encodedMessageId = messageAction[2]!;
  const roomId = decodeURIComponent(encodedRoomId);
  const messageId = decodeURIComponent(encodedMessageId);
  if (!state.app.rooms.getRoom(roomId)) {
    sendJson(response, 404, { ok: false, error: "room_not_found" });
    return true;
  }
  const message = state.app.rooms.getMessage(roomId, messageId);
  if (!message) {
    sendJson(response, 200, {
      ok: true,
      messageId,
      currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
    });
    return true;
  }
  if (message.senderType === "agent" && message.status === "running") {
    sendJson(response, 409, { ok: false, error: "message_running" });
    return true;
  }
  state.app.rooms.deleteMessage(roomId, messageId);
  state.store.saveFrom(state.app);
  sendJson(response, 200, {
    ok: true,
    messageId,
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}

function normalizeMessagePatch(
  body: Record<string, unknown>,
): Partial<Omit<RoomChannelMessage, "id" | "roomId" | "channelSeq" | "createdAt">> {
  const patch: Partial<Omit<RoomChannelMessage, "id" | "roomId" | "channelSeq" | "createdAt">> = {};
  if (Object.prototype.hasOwnProperty.call(body, "text")) patch.text = readOptionalString(body.text);
  if (Object.prototype.hasOwnProperty.call(body, "status")) patch.status = readMessageStatus(body.status);
  if (Object.prototype.hasOwnProperty.call(body, "runId")) patch.runId = readOptionalString(body.runId);
  if (Object.prototype.hasOwnProperty.call(body, "duration")) patch.duration = readOptionalString(body.duration);
  if (Object.prototype.hasOwnProperty.call(body, "startedAt")) patch.startedAt = readOptionalString(body.startedAt);
  if (Object.prototype.hasOwnProperty.call(body, "finishedAt")) patch.finishedAt = readOptionalString(body.finishedAt);
  if (Object.prototype.hasOwnProperty.call(body, "parts")) patch.parts = readJsonObjects(body.parts);
  return patch;
}
