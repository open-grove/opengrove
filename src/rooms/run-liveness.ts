import type { JsonObject } from "../core.js";
import type { RoomChannelMember, RoomChannelMessage } from "./channel-store.js";

export interface InterruptRoomRunOptions {
  fallbackText: string;
  reason: "host_restarted" | "run_inactive";
  timestamp?: string;
}

export function interruptRoomRunMessage(
  message: RoomChannelMessage,
  options: InterruptRoomRunOptions,
): RoomChannelMessage {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const text = message.text.trim() || options.fallbackText;
  return {
    ...message,
    text,
    status: "interrupted",
    updatedAt: timestamp,
    finishedAt: message.finishedAt ?? timestamp,
    parts: Array.isArray(message.parts)
      ? closeInterruptedRoomRunParts(message.parts, text, options.reason)
      : message.parts,
  };
}

export function resetInactiveRoomMember(
  member: RoomChannelMember,
  options: {
    idleText: string;
    transientLastActiveTexts: readonly string[];
  },
): RoomChannelMember {
  if (member.status !== "running" && member.status !== "waiting") return member;
  return {
    ...member,
    status: "idle",
    lastActive: options.transientLastActiveTexts.includes(member.lastActive) ? options.idleText : member.lastActive,
  };
}

export function closeInterruptedRoomRunParts(
  parts: JsonObject[],
  errorMessage: string,
  reason: InterruptRoomRunOptions["reason"],
): JsonObject[] {
  return parts.map((part) => {
    const status = typeof part.status === "string" ? part.status : "";
    if (
      part.type === "tool" &&
      part.phase === "question" &&
      (part.questionStatus === "pending" || status === "requires-action")
    ) {
      return {
        ...part,
        status: "canceled",
        questionStatus: "declined",
        result: { reason },
      };
    }
    if (
      part.type === "tool" &&
      part.phase === "approval" &&
      (part.approvalStatus === "pending" || status === "requires-action")
    ) {
      return {
        ...part,
        status: "canceled",
        approvalStatus: "rejected",
        result: { reason },
      };
    }
    if (part.type === "tool" && status === "running") {
      return {
        ...part,
        status: "failed",
        error: typeof part.error === "string" && part.error ? part.error : errorMessage,
      };
    }
    if (part.type === "skill" && ["invoked", "started", "running"].includes(status)) {
      return {
        ...part,
        status: "failed",
        result: typeof part.result === "string" && part.result ? part.result : errorMessage,
      };
    }
    return part;
  });
}
