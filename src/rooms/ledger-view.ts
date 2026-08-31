import { Buffer } from "node:buffer";
import type { JsonObject } from "../core.js";
import type { RoomChannelMember, RoomChannelMessage, RoomChannelRoom, RoomChannelStore } from "./channel-store.js";

export interface RoomLedgerReadInput {
  query?: unknown;
  limit?: unknown;
  beforeSeq?: unknown;
  afterSeq?: unknown;
  includeMembers?: unknown;
}

export const ROOM_LEDGER_ATTACHMENT_INLINE_MAX_BYTES = 16 * 1024;

export function buildRoomLedgerReadValue(
  rooms: RoomChannelStore,
  room: RoomChannelRoom,
  input: RoomLedgerReadInput,
): JsonObject {
  const query = readString(input.query).toLowerCase();
  const limit = readNumber(input.limit, 50, 1, 200);
  const beforeSeq = readOptionalNumber(input.beforeSeq);
  const afterSeq = readOptionalNumber(input.afterSeq);
  const messages = rooms
    .listVisibleMessages(room.id, { limit: query ? 500 : limit, beforeSeq, afterSeq })
    .filter((message) => !query || roomLedgerMessageMatchesQuery(message, query))
    .slice(-limit)
    .map(serializeRoomLedgerMessage);

  return {
    sourceRoomId: room.id,
    messages,
    ...(input.includeMembers === true ? { members: roomLedgerMemberStatuses(rooms, room.memberIds) } : {}),
  };
}

export function normalizeRoomLedgerReadValue(value: unknown, includeMembers: boolean): JsonObject {
  const payload = readRecord(value);
  const messages = Array.isArray(payload?.messages)
    ? payload.messages.map(normalizeRoomLedgerMessage).filter((message): message is JsonObject => Boolean(message))
    : [];

  return {
    ...(typeof payload?.sourceRoomId === "string" ? { sourceRoomId: payload.sourceRoomId } : {}),
    messages,
    ...(includeMembers && Array.isArray(payload?.members)
      ? {
          members: payload.members
            .map(normalizeRoomLedgerMemberStatus)
            .filter((member): member is JsonObject => Boolean(member)),
        }
      : {}),
  };
}

function roomLedgerMemberStatuses(rooms: RoomChannelStore, memberIds: string[]): JsonObject[] {
  const memberById = new Map(rooms.listMembers().map((member) => [member.id, member]));
  return memberIds
    .map((memberId) => memberById.get(memberId))
    .filter((member): member is RoomChannelMember => Boolean(member))
    .map((member) => ({
      id: member.id,
      name: member.name,
      status: member.status,
      lastActive: member.lastActive,
      disabled: member.disabled === true,
    }));
}

export function serializeRoomLedgerMessage(message: RoomChannelMessage): JsonObject {
  return {
    id: message.id,
    roomId: message.roomId,
    channelSeq: message.channelSeq,
    senderId: message.senderId,
    senderName: message.senderName,
    senderType: message.senderType,
    text: message.text,
    targetIds: message.targetIds,
    status: message.status,
    createdAt: message.createdAt,
    ...(message.attachments?.length
      ? { attachments: message.attachments.map((attachment) => serializeAttachment(attachment)) }
      : {}),
    ...(message.deliveryKind ? { deliveryKind: message.deliveryKind } : {}),
    ...(message.inReplyToMessageId ? { inReplyToMessageId: message.inReplyToMessageId } : {}),
    ...(message.rootMessageId ? { rootMessageId: message.rootMessageId } : {}),
    ...(message.selectedFile ? { selectedFile: { path: message.selectedFile.path } } : {}),
  };
}

function normalizeRoomLedgerMessage(value: unknown): JsonObject | undefined {
  const message = readRecord(value);
  if (!message || (typeof message.id !== "string" && typeof message.text !== "string")) {
    return undefined;
  }

  const output: JsonObject = {};
  for (const key of [
    "id",
    "roomId",
    "senderId",
    "senderName",
    "senderType",
    "text",
    "status",
    "createdAt",
    "deliveryKind",
    "inReplyToMessageId",
    "rootMessageId",
  ]) {
    const field = message[key];
    if (typeof field === "string") output[key] = field;
  }
  if (typeof message.channelSeq === "number" && Number.isFinite(message.channelSeq)) {
    output.channelSeq = message.channelSeq;
  }
  if (Array.isArray(message.targetIds)) {
    output.targetIds = message.targetIds.filter((targetId): targetId is string => typeof targetId === "string");
  }
  if (Array.isArray(message.attachments)) {
    output.attachments = message.attachments
      .map(normalizeAttachment)
      .filter((attachment): attachment is JsonObject => Boolean(attachment));
  }
  const selectedFile = readRecord(message.selectedFile);
  if (typeof selectedFile?.path === "string") {
    output.selectedFile = { path: selectedFile.path };
  }
  return output;
}

function normalizeRoomLedgerMemberStatus(value: unknown): JsonObject | undefined {
  const member = readRecord(value);
  if (!member || typeof member.id !== "string" || typeof member.name !== "string") {
    return undefined;
  }
  return {
    id: member.id,
    name: member.name,
    ...(typeof member.status === "string" ? { status: member.status } : {}),
    ...(typeof member.lastActive === "string" ? { lastActive: member.lastActive } : {}),
    disabled: member.disabled === true,
  };
}

function serializeAttachment(attachment: NonNullable<RoomChannelMessage["attachments"]>[number]): JsonObject {
  const text = boundedInlineAttachmentValue(attachment.text);
  const dataUrl = boundedInlineAttachmentValue(attachment.dataUrl);
  return {
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.id ? { id: attachment.id } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
    ...(text ? { text } : {}),
    ...(dataUrl ? { dataUrl } : {}),
  };
}

function normalizeAttachment(value: unknown): JsonObject | undefined {
  const attachment = readRecord(value);
  if (!attachment || typeof attachment.name !== "string" || typeof attachment.kind !== "string") {
    return undefined;
  }
  const output: JsonObject = {
    name: attachment.name,
    kind: attachment.kind,
  };
  for (const key of ["id", "mimeType"]) {
    const field = attachment[key];
    if (typeof field === "string") output[key] = field;
  }
  const text = boundedInlineAttachmentValue(attachment.text);
  if (text) output.text = text;
  const dataUrl = boundedInlineAttachmentValue(attachment.dataUrl);
  if (dataUrl) output.dataUrl = dataUrl;
  if (typeof attachment.size === "number" && Number.isFinite(attachment.size)) {
    output.size = attachment.size;
  }
  return output;
}

function boundedInlineAttachmentValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return Buffer.byteLength(value, "utf8") <= ROOM_LEDGER_ATTACHMENT_INLINE_MAX_BYTES ? value : undefined;
}

function roomLedgerMessageMatchesQuery(message: RoomChannelMessage, query: string): boolean {
  if (message.text.toLowerCase().includes(query) || message.senderName.toLowerCase().includes(query)) {
    return true;
  }
  return (message.attachments ?? []).some((attachment) => {
    const searchable = [
      attachment.name,
      attachment.kind,
      attachment.mimeType ?? "",
      attachment.kind === "image" ? "图片 image" : "",
      attachment.kind === "text" ? "文本 text" : "",
      attachment.kind === "file" ? "文件 file attachment" : "",
    ]
      .join(" ")
      .toLowerCase();
    return searchable.includes(query);
  });
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
