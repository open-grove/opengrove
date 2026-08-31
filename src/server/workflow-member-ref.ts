import type { RoomChannelMember, RoomChannelRoom } from "../rooms/channel-store.js";
import { isRunnableRoomAssistantTarget } from "../rooms/channel-store.js";

export interface WorkflowMemberRoomStore {
  listMembers(): RoomChannelMember[];
  listRooms(): RoomChannelRoom[];
}

export interface WorkflowMemberScope {
  appId?: string;
}

export interface ResolveWorkflowMemberRefInput {
  memberId: string;
  appId?: string;
  roomId?: string;
  requireInRoom?: boolean;
  requireRunnable?: boolean;
}

export interface ResolvedWorkflowMemberRef {
  requestedMemberId: string;
  member: RoomChannelMember;
  room?: RoomChannelRoom;
}

export function resolveWorkflowMemberRef(
  rooms: WorkflowMemberRoomStore,
  input: ResolveWorkflowMemberRefInput,
): ResolvedWorkflowMemberRef | undefined {
  const requestedMemberId = input.memberId.trim();
  if (!requestedMemberId) return undefined;
  const member = rooms.listMembers().find((candidate) => candidate.id === requestedMemberId);
  if (!member) return undefined;
  if (input.appId && member.appId !== input.appId) return undefined;
  if (input.requireRunnable && !isRunnableRoomAssistantTarget(member)) return undefined;
  const room = resolveWorkflowMemberRoom(rooms, member.id, input.roomId);
  if (input.requireInRoom && !room) return undefined;
  return {
    requestedMemberId,
    member,
    ...(room ? { room } : {}),
  };
}

export function validateWorkflowMemberRef(
  rooms: WorkflowMemberRoomStore,
  memberId: string,
  scope: WorkflowMemberScope,
): string | undefined {
  const requestedMemberId = memberId.trim();
  const member = rooms.listMembers().find((candidate) => candidate.id === requestedMemberId);
  if (!member) return `member_not_found:${requestedMemberId}`;
  if (!scope.appId && member.appId) return `app_scope_required:${requestedMemberId}`;
  if (scope.appId && member.appId !== scope.appId) return `member_out_of_scope:${requestedMemberId}`;
  if (isRunnableRoomAssistantTarget(member)) return undefined;
  if (member.disabled) return `member_disabled:${requestedMemberId}`;
  return `member_not_runnable:${requestedMemberId}`;
}

export function validateImportWorkflowMemberRef(rooms: WorkflowMemberRoomStore, memberId: string): string | undefined {
  const requestedMemberId = memberId.trim();
  const member = rooms.listMembers().find((candidate) => candidate.id === requestedMemberId);
  if (member && isRunnableRoomAssistantTarget(member)) return undefined;
  return `member_not_runnable:${requestedMemberId}`;
}

function resolveWorkflowMemberRoom(
  rooms: WorkflowMemberRoomStore,
  memberId: string,
  requestedRoomId: string | undefined,
): RoomChannelRoom | undefined {
  const allRooms = rooms.listRooms();
  const roomId = requestedRoomId?.trim();
  if (roomId) {
    const room = allRooms.find((candidate) => candidate.id === roomId);
    return room?.memberIds.includes(memberId) ? room : undefined;
  }
  return allRooms.find((room) => !room.archived && room.memberIds.includes(memberId));
}
