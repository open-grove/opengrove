import type {
  AgentEventRecord,
  MessagePart,
  ReasoningPart,
  SkillPart,
  StoredMessage,
  TextPart,
  ToolPart,
} from "../../bridge";
import { readLanguagePreference, resolveLanguage, translate, type TranslationFn } from "../../i18n";
import { cachedDateTimeFormat } from "../../intl-formatters";
import { localeForLanguage } from "../../locale";
import {
  applyStreamEventToMessage,
  closeDanglingMessageActivity,
  finalizeAssistantMessage,
  markAssistantMessageError,
} from "../../messages";
import {
  activityItemStatus,
  buildActivityItems,
  choiceFormFromItem,
  summarizeActivityItems,
} from "../chat/message-activity";
import {
  roomMemberDisplayName,
  type MessageStatus,
  type RoomMember,
  type RoomMessage,
  type RoomReplyPreview,
} from "./rooms-model";

export function cloneMessageParts(parts: MessagePart[] | undefined): MessagePart[] {
  return Array.isArray(parts) ? parts.map((part) => ({ ...part })) : [];
}

export function roomMessageToStored(message: RoomMessage): StoredMessage {
  return {
    id: message.id,
    role: message.senderType === "agent" ? "assistant" : message.senderType,
    text: message.text,
    context: message.attachments?.length ? { text: "", attachments: message.attachments } : null,
    parts: cloneMessageParts(message.parts),
    pending: message.status === "running",
    runId: message.runId || "",
    startedAt: message.startedAt,
    finishedAt: message.finishedAt,
  };
}

export function roomMessageFromStored(
  message: RoomMessage,
  stored: StoredMessage,
  status: MessageStatus = message.status,
): RoomMessage {
  return {
    ...message,
    text: stored.text,
    status,
    runId: stored.runId || message.runId,
    startedAt: stored.startedAt || message.startedAt,
    finishedAt: stored.finishedAt || message.finishedAt,
    parts: stored.parts,
  };
}

export function roomReplyPreview(
  message: RoomMessage | undefined,
  members: RoomMember[],
  t: TranslationFn = translate,
): RoomReplyPreview {
  if (!message) {
    return { text: t("rooms.originalMessageUnavailable") };
  }
  const member = members.find((candidate) => candidate.id === message.senderId);
  return {
    senderName: member ? roomMemberDisplayName(member) : message.senderName,
    text:
      message.text.trim() ||
      (message.attachments?.length ? t("rooms.sentAttachment") : t("rooms.originalMessageUnavailable")),
  };
}

export function isRoomActivityEvent(event: AgentEventRecord | undefined): event is AgentEventRecord {
  return [
    "turn.started",
    "turn.finished",
    "tool.started",
    "tool.finished",
    "approval.requested",
    "approval.resolved",
    "question.requested",
    "question.answered",
    "planning.updated",
    "skill.invoked",
    "skill.loaded",
    "skill.forked",
    "skill.cleared",
    "compaction.started",
    "compaction.finished",
    "assistant.status",
    "reasoning.started",
    "reasoning.completed",
    "runtime.diagnostic",
    "error",
  ].includes(String(event?.type || ""));
}

export function shouldUseRoomActivityEvent(
  event: AgentEventRecord | undefined,
  status: MessageStatus,
  text: string,
): event is AgentEventRecord {
  if (!isRoomActivityEvent(event)) return false;
  return !(event.type === "error" && status !== "running" && text.trim());
}

export function failRoomMessage(message: RoomMessage, errorMessage: string): RoomMessage {
  const stored = roomMessageToStored(message);
  markAssistantMessageError(stored, errorMessage);
  return roomMessageFromStored(message, stored, "failed");
}

export function formatShortTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  return cachedDateTimeFormat(localeForLanguage(resolveLanguage(readLanguagePreference())), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

export function formatRoomMessageTime(iso: string, now = Date.now()): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  const locale = localeForLanguage(resolveLanguage(readLanguagePreference()));
  const age = now - time.getTime();
  if (age <= 24 * 60 * 60 * 1000) {
    return cachedDateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(time);
  }
  const current = new Date(now);
  return cachedDateTimeFormat(locale, {
    ...(time.getFullYear() === current.getFullYear() ? {} : { year: "numeric" as const }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

export function formatRoomDayLabel(iso: string, now = Date.now()): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  const current = new Date(now);
  return cachedDateTimeFormat(localeForLanguage(resolveLanguage(readLanguagePreference())), {
    ...(time.getFullYear() === current.getFullYear() ? {} : { year: "numeric" as const }),
    month: "short",
    day: "numeric",
  }).format(time);
}

export function roomMessageDayKey(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  return [
    String(time.getFullYear()).padStart(4, "0"),
    String(time.getMonth() + 1).padStart(2, "0"),
    String(time.getDate()).padStart(2, "0"),
  ].join("-");
}

export function isDelegationTransportMessage(message: RoomMessage): boolean {
  return (
    message.senderType === "agent" &&
    message.targetIds.length > 0 &&
    (message.deliveryKind === "pm_auto_route" || message.deliveryKind === "agent_delegation")
  );
}

export function findLastVisibleRoomMessage(messages: readonly RoomMessage[]): RoomMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && !isDelegationTransportMessage(message)) return message;
  }
  return undefined;
}

export function formatRoomPreview(message: RoomMessage | undefined, t: TranslationFn = translate): string {
  if (!message) return t("rooms.noMessagesYet");
  if (message.senderType === "system") return message.text;
  const prefix = `${message.senderName}: `;
  const summary = roomActivitySummary(message);
  if (message.status === "running") {
    return `${prefix}${summary || t("rooms.statusRunning")}`;
  }
  if (message.status === "failed") {
    return `${prefix}${t("mountedApp.flowFailed")}`;
  }
  if (message.status === "interrupted") {
    return `${prefix}${t("contacts.runStatusInterrupted")}`;
  }
  if (message.text.trim()) {
    return `${prefix}${message.text.trim()}`;
  }
  if (summary) {
    return `${prefix}${summary}`;
  }
  if (message.attachments?.length) {
    return `${prefix}${t("rooms.previewAttachmentTag")}`;
  }
  return `${prefix}${t("rooms.statusDone")}`;
}

export function roomActivityParts(parts: MessagePart[] | undefined): Array<ToolPart | SkillPart | ReasoningPart> {
  return (parts || []).filter(
    (part): part is ToolPart | SkillPart | ReasoningPart =>
      part.type === "tool" || part.type === "skill" || part.type === "reasoning",
  );
}

export function roomActivitySummary(message: RoomMessage): string {
  const items = buildActivityItems(roomActivityParts(message.parts));
  if (!items.length) return "";
  const active = message.status === "running" || items.some((item) => activityItemStatus(item) === "running");
  return summarizeActivityItems(items, {
    active,
    pendingQuestion: items.some((item) => item.type === "question" && item.part.questionStatus === "pending"),
    pendingApproval: items.some((item) => item.type === "approval" && item.part.approvalStatus === "pending"),
    activeChoiceForm: items.some((item) => Boolean(choiceFormFromItem(item))),
  });
}

export function roomMessageText(message: RoomMessage): string {
  return message.text || "";
}

export function finalizeRoomMessageFromRun(
  message: RoomMessage,
  events: AgentEventRecord[] | undefined,
  status: MessageStatus,
  duration?: string,
  answer?: string,
): RoomMessage {
  const stored = roomMessageToStored(message);
  const activityEvents =
    events?.filter((event) => shouldUseRoomActivityEvent(event, status, answer || message.text)) ?? [];
  if (!roomActivityParts(stored.parts).length && activityEvents.length) {
    for (const event of activityEvents) {
      applyStreamEventToMessage(stored, event);
    }
  }
  finalizeAssistantMessage(stored, { answer, events });
  const textFromParts = (stored.parts || [])
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (!stored.text.trim() && textFromParts.trim()) {
    stored.text = textFromParts;
  }
  stored.parts = (stored.parts || []).filter((part) => part.type !== "text");
  return {
    ...roomMessageFromStored(message, stored, status),
    duration: duration || message.duration,
  };
}

export function interruptRoomMessage(message: RoomMessage): RoomMessage {
  const stored = roomMessageToStored(message);
  closeDanglingMessageActivity(stored, { status: "failed", errorMessage: translate("rooms.runStreamInterrupted") });
  stored.pending = false;
  stored.finishedAt = stored.finishedAt || new Date().toISOString();
  return roomMessageFromStored(message, stored, "interrupted");
}

export function roomMemberNames(members: RoomMember[]): string {
  return members.map(roomMemberDisplayName).join("、");
}
