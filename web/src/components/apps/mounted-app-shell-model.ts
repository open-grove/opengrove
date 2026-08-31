import type { Room } from "../rooms/rooms-model";
import type { MountedAppSurface } from "./mounted-app-model";

export function defaultMountedAppCrewOpen(surface: MountedAppSurface): boolean {
  return surface === "setup" || surface === "file-workbench";
}

export function mountedAppCrewStorageKey(appId: string): string {
  return `opengrove:mounted-app:crew-open:${appId}`;
}

export function countMountedAppPendingActionParts(
  rooms: readonly Room[],
  includeRoom: (room: Room) => boolean,
  pendingQuestionIds?: ReadonlySet<string>,
  pendingApprovalIds?: ReadonlySet<string>,
): number {
  const questionIds = new Set<string>();
  const approvalIds = new Set<string>();
  for (const room of rooms) {
    if (!includeRoom(room)) continue;
    for (const message of room.messages) {
      for (const part of message.parts ?? []) {
        if (part.type !== "tool") continue;
        if (
          part.phase === "question" &&
          part.questionId &&
          (pendingQuestionIds ? pendingQuestionIds.has(part.questionId) : part.questionStatus === "pending")
        ) {
          questionIds.add(part.questionId);
        }
        if (
          part.phase === "approval" &&
          part.approvalId &&
          (pendingApprovalIds ? pendingApprovalIds.has(part.approvalId) : part.approvalStatus === "pending")
        ) {
          approvalIds.add(part.approvalId);
        }
      }
    }
  }
  return questionIds.size + approvalIds.size;
}
