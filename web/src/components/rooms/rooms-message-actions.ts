import type { AttachmentPayload, KernelOption } from "../../bridge";
import { translate } from "../../i18n";
import { canSendRoomDraft, resolveAutomaticPmTarget, resolveRoomTargets } from "./room-chat-utils";
import { failRoomMessage } from "./room-message-model";
import { postServerRoomMessageWithReplyFallback } from "./rooms-api";
import {
  createId,
  directRoomMember,
  nowIso,
  type MemberStatus,
  type Room,
  type RoomMember,
  type RoomMessage,
} from "./rooms-model";

export function resolveRoomSendTargets(input: {
  text: string;
  room: Room;
  members: RoomMember[];
  automaticPmMembers?: RoomMember[];
  kernelOptions: KernelOption[];
  fallbackTarget?: RoomMember;
}): { requestTargets: RoomMember[]; optimisticTargets: RoomMember[] } {
  const explicitTargets = resolveRoomTargets(input.text, input.members);
  const directTarget =
    input.room.kind === "direct"
      ? (directRoomMember(
          input.room,
          input.members.filter((member) => !member.disabled),
        ) ?? input.members.find((member) => !member.disabled))
      : undefined;
  const requestTargets = explicitTargets.length
    ? explicitTargets
    : directTarget
      ? [directTarget]
      : input.fallbackTarget
        ? [input.fallbackTarget]
        : [];
  // The PM prediction is presentation-only. Keeping requestTargets empty lets
  // the Bridge remain authoritative and preserve pm_auto_route semantics.
  const automaticPmTarget =
    requestTargets.length === 0 && input.room.kind === "group"
      ? resolveAutomaticPmTarget(input.room, input.automaticPmMembers ?? input.members, input.kernelOptions)
      : undefined;
  return {
    requestTargets,
    optimisticTargets: automaticPmTarget ? [automaticPmTarget] : requestTargets,
  };
}

export function sendRoomText(input: {
  rawText: string;
  outgoingAttachments?: AttachmentPayload[];
  activeRoom?: Room;
  roomMembers: RoomMember[];
  kernelOptions: KernelOption[];
  replyingToMessage?: RoomMessage;
  onCompleteOnboardingGuide?(): void;
  onUpdateMemberStatus(memberIds: string[], status: MemberStatus): void;
  onHasOtherRunningMessage(memberId: string, excludedMessageIds: string[]): boolean;
  onUpdateRoom(roomId: string, updater: (room: Room) => Room): void;
  onUpdateRoomMessage(roomId: string, messageId: string, updater: (message: RoomMessage) => RoomMessage): void;
  onUpsertRoomMessages(roomId: string, messages: RoomMessage[]): void;
  onServerEventSeq(seq: number): void;
}): boolean {
  if (!input.activeRoom) return false;
  const outgoingAttachments = input.outgoingAttachments ?? [];
  const text = input.rawText.trim() || (outgoingAttachments.length ? translate("rooms.sentAttachment") : "");
  if (!canSendRoomDraft(text, outgoingAttachments.length)) return false;
  const createdAt = nowIso();
  const { requestTargets, optimisticTargets } = resolveRoomSendTargets({
    text,
    room: input.activeRoom,
    members: input.roomMembers,
    kernelOptions: input.kernelOptions,
  });
  const inReplyToMessageId = input.replyingToMessage?.id;
  const rootMessageId = input.replyingToMessage
    ? (input.replyingToMessage.rootMessageId ?? input.replyingToMessage.id)
    : undefined;
  if (requestTargets.length) {
    input.onCompleteOnboardingGuide?.();
  }
  const userMessage: RoomMessage = {
    id: createId("message"),
    senderId: "user",
    senderName: translate("mountedApp.selfSenderName"),
    senderType: "user",
    text,
    targetIds: optimisticTargets.map((member) => member.id),
    status: "sent",
    createdAt,
    attachments: outgoingAttachments,
    inReplyToMessageId,
    rootMessageId,
  };
  const assistantMessages = optimisticTargets.map((target) => ({
    id: createId("message"),
    senderId: target.id,
    senderName: target.name,
    senderType: "agent" as const,
    text: "",
    targetIds: [target.id],
    status: "running" as const,
    createdAt,
    startedAt: createdAt,
    inReplyToMessageId: userMessage.id,
    rootMessageId: userMessage.rootMessageId ?? userMessage.id,
  }));
  input.onUpdateRoom(input.activeRoom.id, (room) => ({
    ...room,
    messages: [...room.messages, userMessage, ...assistantMessages],
    updatedAt: createdAt,
    unread: 0,
  }));
  input.onUpdateMemberStatus(
    optimisticTargets.map((target) => target.id),
    "running",
  );
  void postServerRoomMessageWithReplyFallback({
    roomId: input.activeRoom.id,
    text,
    targetIds: requestTargets.map((member) => member.id),
    attachments: outgoingAttachments,
    userMessageId: userMessage.id,
    assistantMessageIds: assistantMessages.map((message) => message.id),
    inReplyToMessageId,
  })
    .then((result) => {
      const authoritativeMessageIds = new Set(result.assistantMessages.map((message) => message.id));
      const unmatchedOptimisticMessageIds = new Set(
        assistantMessages.filter((message) => !authoritativeMessageIds.has(message.id)).map((message) => message.id),
      );
      if (unmatchedOptimisticMessageIds.size) {
        input.onUpdateRoom(input.activeRoom!.id, (room) => ({
          ...room,
          messages: room.messages.filter((message) => !unmatchedOptimisticMessageIds.has(message.id)),
        }));
      }
      input.onServerEventSeq(result.currentEventSeq);
      input.onUpsertRoomMessages(input.activeRoom!.id, [result.userMessage, ...result.assistantMessages]);
      const authoritativeAgentSenderIds = new Set(
        result.assistantMessages.filter((message) => message.senderType === "agent").map((message) => message.senderId),
      );
      const supersededMemberIds = optimisticTargets
        .filter((target) => !authoritativeAgentSenderIds.has(target.id))
        .map((target) => target.id);
      const runningMemberIds = result.assistantMessages
        .filter((message) => message.senderType === "agent" && message.status === "running")
        .map((message) => message.senderId);
      const completedMemberIds = result.assistantMessages
        .filter((message) => message.senderType === "agent" && message.status === "done")
        .map((message) => message.senderId);
      const stoppedMessages = result.assistantMessages.filter(
        (message) =>
          message.senderType === "agent" && (message.status === "failed" || message.status === "interrupted"),
      );
      updateIdleMemberStatuses(
        input,
        supersededMemberIds,
        assistantMessages.map((message) => message.id),
      );
      input.onUpdateMemberStatus(runningMemberIds, "running");
      input.onUpdateMemberStatus(completedMemberIds, "done");
      updateIdleMemberStatuses(
        input,
        stoppedMessages.map((message) => message.senderId),
        stoppedMessages.map((message) => message.id),
      );
    })
    .catch((error) => {
      const messageText = error instanceof Error ? error.message : String(error);
      assistantMessages.forEach((assistantMessage) => {
        input.onUpdateRoomMessage(input.activeRoom!.id, assistantMessage.id, (message) =>
          failRoomMessage(message, messageText),
        );
      });
      updateIdleMemberStatuses(
        input,
        optimisticTargets.map((target) => target.id),
        assistantMessages.map((message) => message.id),
      );
    });
  return true;
}

function updateIdleMemberStatuses(
  input: Pick<Parameters<typeof sendRoomText>[0], "onHasOtherRunningMessage" | "onUpdateMemberStatus">,
  memberIds: string[],
  excludedMessageIds: string[],
): void {
  const idleMemberIds = [...new Set(memberIds)].filter(
    (memberId) => !input.onHasOtherRunningMessage(memberId, excludedMessageIds),
  );
  input.onUpdateMemberStatus(idleMemberIds, "idle");
}
