import type { KernelOption } from "../../bridge";
import { isRoomPmMember, roomMemberDisplayName, type Room, type RoomMember, type RoomMessage } from "./rooms-model";

export type MentionMenuState = {
  open: boolean;
  query: string;
  start: number;
  end: number;
  activeIndex: number;
};

export function roomMentionToken(
  target:
    | {
        kind: "all";
      }
    | {
        kind: "member";
        member: Pick<RoomMember, "name" | "displayName" | "userOverrides">;
      },
): string {
  return target.kind === "all" ? "@all" : `@${roomMemberDisplayName(target.member)}`;
}

export function findMentionContext(
  value: string,
  cursor: number,
): Pick<MentionMenuState, "query" | "start" | "end"> | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/@([^\s@]*)$/);
  if (!match) return null;
  const query = match[1] ?? "";
  const mentionStart = beforeCursor.length - query.length - 1;
  if (!isMentionBoundary(beforeCursor[mentionStart - 1] ?? "")) return null;
  return {
    query,
    start: mentionStart,
    end: cursor,
  };
}

function isMentionBoundary(previous: string): boolean {
  return !previous || !/[a-z0-9._-]/i.test(previous);
}

export function resolveRoomTargets(text: string, members: RoomMember[]): RoomMember[] {
  const normalized = text.toLowerCase();
  if (/@all\b/i.test(text) || /@全部|@所有人/.test(text)) {
    return members.filter((member) => !member.disabled && member.status !== "offline");
  }
  return members.filter((member) => {
    if (member.disabled) return false;
    const aliases = [roomMemberDisplayName(member), member.name, member.displayName, member.id]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => `@${value.toLowerCase()}`);
    return aliases.some((alias) => mentionTokenExists(normalized, alias));
  });
}

function mentionTokenExists(text: string, alias: string): boolean {
  const index = text.indexOf(alias);
  if (index < 0) return false;
  const next = text[index + alias.length] ?? "";
  return !next || /[\s,，。.!！?？:：;；]/.test(next);
}

export function canSendRoomDraft(rawText: string, attachmentCount: number): boolean {
  if (attachmentCount > 0) return true;
  const text = rawText.trim();
  if (!text) return false;
  return !/^@\S*$/.test(text);
}

export function resolveAutomaticPmTarget(
  room: Room,
  members: RoomMember[],
  kernelOptions: KernelOption[],
): RoomMember | undefined {
  if (room.kind !== "group") return undefined;
  const roomMemberIds = new Set(room.memberIds);
  const hostToolKernelIds = new Set<string>(
    kernelOptions.filter((option) => option.hostTools === true).map((option) => option.id),
  );
  const roomMembers = members.filter((member) => roomMemberIds.has(member.id));
  const pmMembers = roomMembers.filter(
    (member) =>
      !member.disabled &&
      (member.source ?? "local") === "local" &&
      isRoomPmMember(member) &&
      room.adminMemberIds.includes(member.id) &&
      hostToolKernelIds.has(member.kernel),
  );
  const appIds = new Set(
    roomMembers.map((member) => member.appId?.trim()).filter((appId): appId is string => Boolean(appId)),
  );
  if (appIds.size === 1) {
    const [appId] = [...appIds];
    const scopedPm = pmMembers.find((member) => member.appId === appId);
    if (scopedPm) return scopedPm;
  }
  return pmMembers.find((member) => !member.appId);
}

export function agentAuthorMention(message: RoomMessage, members: RoomMember[]): string {
  if (message.senderType !== "agent") return "";
  const member = members.find((candidate) => candidate.id === message.senderId);
  return `@${member ? roomMemberDisplayName(member) : message.senderName}`.trim();
}

export function draftWithAuthorMention(draft: string, mentionText: string): { value: string; cursor: number } {
  const mention = mentionText.trim();
  if (!mention) return { value: draft, cursor: draft.length };
  const current = draft.trimStart();
  if (current === mention || current.startsWith(`${mention} `)) {
    return { value: draft, cursor: draft.length };
  }
  const value = current ? `${mention} ${current}` : `${mention} `;
  return { value, cursor: value.length };
}
