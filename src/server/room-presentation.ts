import type { AgentAttachmentContext, JsonObject } from "../core.js";
import type { RoomChannelEvent, RoomChannelMessage } from "../rooms/channel-store.js";
import { compactBrowserJsonValue } from "./event-presentation.js";

const MAX_INLINE_ATTACHMENT_CHARACTERS = 16 * 1024;
const MAX_MESSAGE_PARTS = 100;

export function presentRoomMessage(message: RoomChannelMessage): Record<string, unknown> {
  return {
    ...message,
    attachments: message.attachments?.map((attachment, index) =>
      presentRoomAttachment(message.roomId, message.id, attachment, index),
    ),
    parts: presentRoomParts(message.parts),
  };
}

export function presentRoomEvent(event: RoomChannelEvent): RoomChannelEvent {
  const payload = { ...event.payload };
  const message = record(payload.message);
  if (message) {
    payload.message = presentRoomMessage(message as unknown as RoomChannelMessage);
  }
  const patch = record(payload.messagePatch);
  const set = record(patch?.set);
  if (patch && set && event.messageId) {
    payload.messagePatch = {
      ...patch,
      set: {
        ...set,
        ...(Array.isArray(set.attachments)
          ? {
              attachments: set.attachments.map((attachment, index) =>
                presentRoomAttachment(event.roomId, event.messageId!, attachment as AgentAttachmentContext, index),
              ),
            }
          : {}),
        ...(Array.isArray(set.parts) ? { parts: presentRoomParts(set.parts as JsonObject[]) } : {}),
      },
    };
  }
  return { ...event, payload };
}

function presentRoomAttachment(
  roomId: string,
  messageId: string,
  attachment: AgentAttachmentContext,
  index: number,
): Record<string, unknown> {
  const inlineDataUrl =
    attachment.dataUrl && attachment.dataUrl.length <= MAX_INLINE_ATTACHMENT_CHARACTERS
      ? attachment.dataUrl
      : undefined;
  const inlineText =
    attachment.text && attachment.text.length <= MAX_INLINE_ATTACHMENT_CHARACTERS ? attachment.text : undefined;
  const contentUrl =
    attachment.dataUrl || attachment.text
      ? `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/attachments/${index}/content`
      : undefined;
  return {
    id: attachment.id,
    name: attachment.name,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    size: attachment.size,
    text: inlineText,
    dataUrl: inlineDataUrl,
    ...(attachment.kind === "image" && contentUrl ? { thumbnailUrl: contentUrl } : {}),
  };
}

function presentRoomParts(parts: JsonObject[] | undefined): JsonObject[] | undefined {
  return parts?.slice(0, MAX_MESSAGE_PARTS).map((part) => compactBrowserJsonValue(part, 8_000) as JsonObject);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
