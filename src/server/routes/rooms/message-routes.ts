import { Buffer } from "node:buffer";
import type {
  CreateRoomMessageOperation,
  ListRoomMessagesOperation,
  RecordRoomMessageOperation,
  CancelRoomMessageOperation,
  UpdateRoomMessageOperation,
  DeleteRoomMessageOperation,
} from "#protocol";
import type { PostRoomMessageResult, RoomChannelMember, RoomChannelMessage } from "../../../rooms/channel-store.js";
import { readWwRuntimeAuth } from "../../bridge-security.js";
import { stopRemoteRoomRun } from "../../remote-agents/cancellation.js";
import {
  authorizeNetworkAccount,
  networkProblem,
  requireNetworkConnection,
  type NetworkRunAuthorization,
} from "../../remote-agents/session.js";
import { findRoomPmMember } from "../../room-delegation.js";
import {
  cancelRoomAssistantRun,
  isRunnableRoomAssistantTarget,
  scheduleRoomAssistantRuns,
  resumeRemoteRoomRuns,
} from "../../room-runs.js";
import { roomTargetSupportsHostTools } from "../../room-runs/execution-state.js";
import { canRoomPmAutoRoute } from "../../../rooms/room-pm.js";
import {
  readAttachments,
  readJsonObjects,
  readOptionalString,
  resolveVisibleRoomTargets,
  updateNonRunnableLocalTarget,
} from "./normalizers.js";
import type { RoomsRouteContext } from "./route-context.js";
import { hostMessage, type HostMessageCode } from "../../../localization/host-messages.js";
import { resolveHostLanguageSettings } from "../../language-preference.js";
import { presentRoomMessage } from "../../room-presentation.js";
import type { HostOperationRouteContext } from "../../router.js";

export function handleMessageAttachmentContentRoute(context: RoomsRouteContext): boolean {
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

export function handleListRoomMessagesOperation(context: HostOperationRouteContext<ListRoomMessagesOperation>): true {
  const { response, state, sendJson } = context;
  const messages = state.app.rooms.listVisibleMessages(context.input.params.roomId, context.input.query);
  sendJson(response, 200, {
    ok: true,
    messages: messages.map(presentRoomMessage),
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}

export async function handleRecordRoomMessageOperation(
  context: HostOperationRouteContext<RecordRoomMessageOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  const body = context.input.body;
  const message = state.app.rooms.postAgentMessage({
    ...body,
    roomId: context.input.params.roomId,
    senderName: body.senderName || "Agent",
    status: "done",
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
  const selectedFile = body.selectedFile;
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
  const remoteFailures = new Map<string, string>();
  let networkAuthorization: NetworkRunAuthorization | undefined;
  const remoteTargets = assistantTargets.filter((member) => member.source === "remote");
  if (remoteTargets.length && state.app.rooms.getRoom(roomId)?.kind !== "direct") {
    // Group acceptance cannot wait for a Router exchange. Each remote executor connects independently.
    try {
      networkAuthorization = await authorizeNetworkAccount(context);
    } catch (error) {
      const problem = networkProblem(error);
      console.warn("remote_send_authorization_failed", problem.error);
      for (const target of remoteTargets) remoteFailures.set(target.id, problem.error);
    }
  } else {
    for (const target of remoteTargets) {
      try {
        networkAuthorization = (await requireNetworkConnection(context, target.remoteAgent)).authorization;
      } catch (error) {
        const problem = networkProblem(error);
        sendJson(response, problem.status, { ok: false, error: problem.error });
        return true;
      }
    }
  }
  // A retried remote send must reuse its local ledger entry as well as its network request.
  const existingUserMessage = body.userMessageId ? state.app.rooms.getMessage(roomId, body.userMessageId) : undefined;
  if (existingUserMessage && assistantTargets.some((member) => member.source === "remote")) {
    if (
      existingUserMessage.senderType !== "user" ||
      existingUserMessage.text !== text ||
      JSON.stringify(existingUserMessage.targetIds) !== JSON.stringify(targetIds)
    ) {
      sendJson(response, 409, { ok: false, error: "message_id_conflict" });
      return true;
    }
    if (networkAuthorization) await resumeRemoteRoomRuns(state, networkAuthorization, roomId);
    sendJson(
      response,
      200,
      presentPostRoomMessageResult({
        room: state.app.rooms.getRoom(roomId)!,
        userMessage: existingUserMessage,
        assistantMessages: state.app.rooms
          .listMessages(roomId, { limit: 0 })
          .filter((message) => message.senderType === "agent" && message.inReplyToMessageId === existingUserMessage.id),
        currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
      }),
    );
    return true;
  }
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
        assistantMessageIds: body.assistantMessageIds,
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
      assistantMessageIds: body.assistantMessageIds,
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
    assistantMessageIds: body.assistantMessageIds,
    deliveryKind: userDeliveryKind,
    inReplyToMessageId,
    rootMessageId,
    selectedFile,
  });
  state.store.saveFrom(state.app);
  const updatedMessages = await scheduleAndFallbackAssistantMessages(
    context,
    result,
    assistantTargets,
    roomId,
    remoteFailures,
    networkAuthorization,
  );
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
  remoteFailures = new Map<string, string>(),
  networkAuthorization?: NetworkRunAuthorization,
): Promise<Map<string, RoomChannelMessage>> {
  const { request, state } = context;
  const runnablePairs = result.assistantMessages
    .map((message, index) => ({ message, target: assistantTargets[index] }))
    .filter((pair): pair is { message: RoomChannelMessage; target: RoomChannelMember } =>
      Boolean(pair.target && !remoteFailures.has(pair.target.id) && isRunnableRoomAssistantTarget(pair.target)),
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
    networkAuthorization,
    traceId: context.traceId,
  });
  const updatedMessages = new Map(scheduledMessages.map((message) => [message.id, message]));
  for (const [index, message] of result.assistantMessages.entries()) {
    const target = assistantTargets[index];
    if (!target || updatedMessages.has(message.id)) continue;
    const failure = remoteFailures.get(target.id);
    const fallback = failure
      ? state.app.rooms.updateMessage(roomId, message.id, {
          status: "failed",
          remoteTask: {
            messageId: message.id,
            triggerMessageId: result.userMessage.id,
            // Authorization failed before scheduling; later login must not grant this message permission retroactively.
            pending: false,
            statusText: hostMessage(resolveHostLanguageSettings(state.settings), "remote.authorization_required"),
          },
        })!
      : updateNonRunnableLocalTarget(state, roomId, target, message);
    updatedMessages.set(fallback.id, fallback);
  }
  return updatedMessages;
}

export async function handleCancelRoomMessageOperation(
  context: HostOperationRouteContext<CancelRoomMessageOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  const { roomId, messageId } = context.input.params;
  const message = state.app.rooms.listMessages(roomId, { limit: 200 }).find((candidate) => candidate.id === messageId);
  if (!message) {
    sendJson(response, 404, { ok: false, error: "message_not_found" });
    return true;
  }
  if (message.senderType !== "agent") {
    sendJson(response, 409, { ok: false, error: "message_not_cancelable" });
    return true;
  }
  const target = state.app.rooms.listMembers().find((member) => member.id === message.senderId);
  if (message.remoteTask?.pending || (message.status === "running" && target?.source === "remote")) {
    await stopRemoteRoomRun(context, message);
    sendJson(response, 200, {
      ok: true,
      cancelled: true,
      message: presentRoomMessage(state.app.rooms.getMessage(roomId, message.id)!),
      currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
    });
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

export async function handleUpdateRoomMessageOperation(
  context: HostOperationRouteContext<UpdateRoomMessageOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  const message = state.app.rooms.updateMessage(
    context.input.params.roomId,
    context.input.params.messageId,
    normalizeMessagePatch(context.input.body),
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

export async function handleDeleteRoomMessageOperation(
  context: HostOperationRouteContext<DeleteRoomMessageOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  const { roomId, messageId } = context.input.params;
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
  body: HostOperationRouteContext<UpdateRoomMessageOperation>["input"]["body"],
): Partial<Omit<RoomChannelMessage, "id" | "roomId" | "channelSeq" | "createdAt">> {
  const patch: Partial<Omit<RoomChannelMessage, "id" | "roomId" | "channelSeq" | "createdAt">> = {};
  if (Object.prototype.hasOwnProperty.call(body, "text")) patch.text = body.text;
  if (Object.prototype.hasOwnProperty.call(body, "status")) patch.status = body.status;
  if (Object.prototype.hasOwnProperty.call(body, "runId")) patch.runId = readOptionalString(body.runId);
  if (Object.prototype.hasOwnProperty.call(body, "duration")) patch.duration = readOptionalString(body.duration);
  if (Object.prototype.hasOwnProperty.call(body, "startedAt")) patch.startedAt = readOptionalString(body.startedAt);
  if (Object.prototype.hasOwnProperty.call(body, "finishedAt")) patch.finishedAt = readOptionalString(body.finishedAt);
  if (Object.prototype.hasOwnProperty.call(body, "parts")) patch.parts = readJsonObjects(body.parts);
  return patch;
}
