import { bridgeHeaders, fetchJson, postJson } from "../../bridge";
import { openGroveClient } from "../../opengrove-client";
import {
  normalizeClientConnectorHelpText,
  normalizeClientConnectorMessageParts,
} from "./rooms-legacy-message-normalization";
import {
  dedupeRoomMembers,
  isRoomPmMember,
  remapRoomMemberReferences,
  type Room,
  type RoomMember,
  type RoomMessage,
} from "./rooms-model";

const LOCAL_PENDING_RUNNING_MESSAGE_TTL_MS = 10 * 60 * 1000;

export type ServerRoomMessage = RoomMessage & {
  roomId: string;
  channelSeq: number;
  updatedAt?: string;
};

export type RoomsInitResponse = {
  ok: true;
  rooms: Array<Omit<Room, "messages">>;
  members: RoomMember[];
  messages: ServerRoomMessage[];
  currentEventSeq: number;
  deletedMemberIds?: string[];
  messagesTruncated?: boolean;
};

export type RoomMessagesResponse = {
  ok: true;
  messages: ServerRoomMessage[];
  currentEventSeq: number;
};

export type RoomEvent = {
  schemaVersion?: 1 | 2;
  eventSeq: number;
  type:
    | "room.created"
    | "room.updated"
    | "room.member.added"
    | "room.member.updated"
    | "room.member.removed"
    | "room.message.created"
    | "room.message.updated"
    | "room.message.deleted";
  roomId: string;
  messageId?: string;
  memberId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type RoomsEventsResponse = {
  ok: true;
  events: RoomEvent[];
  currentEventSeq: number;
  oldestAvailableEventSeq: number;
  hasMore: boolean;
  resetRequired: boolean;
  /** Present on Bridge versions that understand waitMs. */
  longPollSupported?: boolean;
};

export type PostRoomMessageResponse = {
  ok: true;
  room: Omit<Room, "messages">;
  userMessage: ServerRoomMessage;
  assistantMessages: ServerRoomMessage[];
  currentEventSeq: number;
};

export type OpenDirectRoomResponse = {
  ok: true;
  room: Omit<Room, "messages">;
  member?: RoomMember;
  currentEventSeq: number;
};

export type CreateRoomResponse = {
  ok: true;
  room: Omit<Room, "messages">;
  currentEventSeq: number;
};

export type MarkRoomReadResponse = {
  ok: true;
  room: Omit<Room, "messages">;
  currentEventSeq: number;
};

export type UpsertRoomMemberResponse = {
  ok: true;
  member: RoomMember;
  currentEventSeq: number;
};

export async function fetchRoomsInit(limit = 80): Promise<RoomsInitResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  const snapshot = await fetchJson<RoomsInitResponse>(`/rooms?${params.toString()}`, { headers: bridgeHeaders(false) });
  return normalizeRoomsInitResponse(snapshot);
}

export async function fetchRoomMessages(roomId: string, limit = 80): Promise<RoomMessage[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const response = await fetchJson<RoomMessagesResponse>(
    `/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`,
    { headers: bridgeHeaders(false) },
  );
  return response.messages.map(normalizeServerRoomMessage).sort(sortRoomMessages);
}

export function isRoomsSessionRequiredError(error: unknown): boolean {
  return error instanceof Error && error.message === "session_required";
}

export async function fetchRoomEvents(
  afterEventSeq: number,
  limit = 200,
  options: { signal?: AbortSignal; waitMs?: number } = {},
): Promise<RoomsEventsResponse> {
  const params = new URLSearchParams();
  params.set("afterEventSeq", String(afterEventSeq));
  params.set("limit", String(limit));
  params.set("eventVersion", "2");
  if (options.waitMs && options.waitMs > 0) params.set("waitMs", String(options.waitMs));
  const response = await fetchJson<RoomsEventsResponse>(`/rooms/events?${params.toString()}`, {
    headers: bridgeHeaders(false),
    signal: options.signal,
  });
  return {
    ...response,
    events: response.events.map((event) => {
      const message = readMessage(event.payload.message);
      return message
        ? { ...event, payload: { ...event.payload, message: normalizeServerRoomMessage(message) } }
        : event;
    }),
  };
}

export type PostServerRoomMessageInput = {
  roomId: string;
  text: string;
  targetIds: string[];
  attachments: unknown[];
  selectedFile?: { path: string };
  userMessageId?: string;
  assistantMessageIds?: string[];
  inReplyToMessageId?: string;
};

export async function postServerRoomMessage(input: PostServerRoomMessageInput): Promise<PostRoomMessageResponse> {
  const response = await openGroveClient.rooms.messages.create(input);
  return readPostRoomMessageResponse(response);
}

export async function postServerRoomMessageWithReplyFallback(
  input: PostServerRoomMessageInput,
): Promise<PostRoomMessageResponse> {
  try {
    return await postServerRoomMessage(input);
  } catch (error) {
    if (!input.inReplyToMessageId || !(error instanceof Error) || error.message !== "reply_message_not_found") {
      throw error;
    }
    const result = await postServerRoomMessage({
      ...input,
      inReplyToMessageId: undefined,
    });
    return {
      ...result,
      userMessage: {
        ...result.userMessage,
        inReplyToMessageId: undefined,
        rootMessageId: undefined,
      },
    };
  }
}

export type CancelRoomRunResponse = {
  ok: boolean;
  cancelled: boolean;
  status?: RoomMessage["status"];
  message?: ServerRoomMessage;
  currentEventSeq?: number;
};

export async function cancelServerRoomRun(roomId: string, messageId: string): Promise<CancelRoomRunResponse> {
  const response = await postJson<CancelRoomRunResponse>(
    `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/cancel`,
    {},
  );
  return {
    ...response,
    message: response.message ? normalizeServerRoomMessage(response.message) : undefined,
  };
}

export type DeleteRoomMessageResponse = {
  ok: boolean;
  messageId: string;
  currentEventSeq?: number;
};

export async function deleteServerRoomMessage(roomId: string, messageId: string): Promise<DeleteRoomMessageResponse> {
  return await fetchJson<DeleteRoomMessageResponse>(
    `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "DELETE",
      headers: bridgeHeaders(false),
    },
  );
}

export async function postServerRoomAgentMessage(input: {
  roomId: string;
  text: string;
  senderId?: string;
  senderName?: string;
  id?: string;
}): Promise<{ ok: true; message: ServerRoomMessage; currentEventSeq: number }> {
  const response = await postJson<{ ok: true; message: ServerRoomMessage; currentEventSeq: number }>(
    `/rooms/${encodeURIComponent(input.roomId)}/agent-messages`,
    {
      text: input.text,
      senderId: input.senderId,
      senderName: input.senderName,
      id: input.id,
    },
  );
  return { ...response, message: normalizeServerRoomMessage(response.message) };
}

export async function createServerRoom(room: Room): Promise<CreateRoomResponse> {
  return await postJson<CreateRoomResponse>("/rooms", {
    id: room.id,
    scope: room.scope,
    title: room.title,
    generatedTitle: room.generatedTitle,
    memberIds: room.memberIds,
    badge: room.badge,
  });
}

export async function openServerDirectRoom(
  memberId: string,
  title?: string,
  input: {
    roomId?: string;
    member?: RoomMember;
    appId?: string;
    appTitle?: string;
  } = {},
): Promise<OpenDirectRoomResponse> {
  const response = await postJson<OpenDirectRoomResponse>("/rooms/dm", {
    memberId,
    roomId: input.roomId,
    title,
    member: input.member,
    appId: input.appId,
    appTitle: input.appTitle,
  });
  return {
    ...response,
    member: readMember(response.member) ?? undefined,
  };
}

export async function patchServerRoom(
  roomId: string,
  patch: Partial<Pick<Room, "title" | "pinned" | "badge" | "adminMemberIds">> & { archived?: boolean },
): Promise<void> {
  await fetchJson(`/rooms/${encodeURIComponent(roomId)}`, {
    method: "PATCH",
    headers: bridgeHeaders(),
    body: JSON.stringify(patch),
  });
}

export async function markServerRoomRead(roomId: string, observedEventSeq: number): Promise<MarkRoomReadResponse> {
  return await postJson<MarkRoomReadResponse>(`/rooms/${encodeURIComponent(roomId)}/read`, { observedEventSeq });
}

export async function upsertServerRoomMember(member: RoomMember): Promise<UpsertRoomMemberResponse> {
  const response = await postJson<UpsertRoomMemberResponse>("/rooms/members", member);
  return {
    ...response,
    member: readMember(response.member) ?? response.member,
  };
}

export async function patchServerRoomMember(
  memberId: string,
  patch: Partial<RoomMember>,
  options: { clearUndefined?: boolean } = {},
): Promise<UpsertRoomMemberResponse> {
  const patchEntries = Object.entries(patch) as Array<[keyof RoomMember, RoomMember[keyof RoomMember] | undefined]>;
  const wirePatch = Object.fromEntries(
    patchEntries
      .filter(([, value]) => options.clearUndefined || value !== undefined)
      .map(([key, value]) => [key, value === undefined ? null : value]),
  );
  const response = await fetchJson<UpsertRoomMemberResponse>(`/rooms/members/${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    headers: bridgeHeaders(),
    body: JSON.stringify(wirePatch),
  });
  return {
    ...response,
    member: readMember(response.member) ?? response.member,
  };
}

export async function restoreServerRoomMemberAppDefaults(memberId: string): Promise<UpsertRoomMemberResponse> {
  const response = await postJson<UpsertRoomMemberResponse>(
    `/rooms/members/${encodeURIComponent(memberId)}/restore-app-defaults`,
    {},
  );
  return {
    ...response,
    member: readMember(response.member) ?? response.member,
  };
}

export async function addServerRoomMember(roomId: string, member: RoomMember): Promise<UpsertRoomMemberResponse> {
  const response = await postJson<UpsertRoomMemberResponse>(`/rooms/${encodeURIComponent(roomId)}/members`, member);
  return {
    ...response,
    member: readMember(response.member) ?? response.member,
  };
}

export async function bindMountedAppBuilder(appId: string, roomId: string): Promise<UpsertRoomMemberResponse> {
  const response = await postJson<UpsertRoomMemberResponse>(
    `/apps/${encodeURIComponent(appId)}/employees/app-builder`,
    { roomId },
  );
  return {
    ...response,
    member: readMember(response.member) ?? response.member,
  };
}

export async function removeServerRoomMember(roomId: string, memberId: string): Promise<void> {
  await fetchJson(`/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}`, {
    method: "DELETE",
    headers: bridgeHeaders(false),
  });
}

export async function patchServerRoomMessage(
  roomId: string,
  messageId: string,
  patch: Partial<RoomMessage>,
): Promise<void> {
  await fetchJson(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    headers: bridgeHeaders(),
    body: JSON.stringify(patch),
  });
}

export function roomsFromServerSnapshot(snapshot: RoomsInitResponse): Room[] {
  const messagesByRoom = new Map<string, RoomMessage[]>();
  for (const message of snapshot.messages) {
    const messages = messagesByRoom.get(message.roomId) ?? [];
    messages.push(normalizeServerRoomMessage(message));
    messagesByRoom.set(message.roomId, messages);
  }
  return snapshot.rooms
    .map((room) => ({
      ...normalizeRoomAdministrators(room, snapshot.members),
      messages: (messagesByRoom.get(room.id) ?? []).sort(sortRoomMessages),
    }))
    .filter((room) => !room.archived);
}

export function mergeRoomsFromServerSnapshot(
  currentRooms: Room[],
  currentMembers: RoomMember[],
  currentDeletedMemberIds: string[],
  snapshot: RoomsInitResponse,
): { rooms: Room[]; members: RoomMember[]; deletedMemberIds: string[] } {
  const serverState = replaceRoomsFromServerSnapshot(snapshot);
  const mergedRooms = mergeRoomLists(
    currentRooms.map((room) => normalizeRoomAdministrators(room, currentMembers)),
    serverState.rooms,
  );
  const deduped = dedupeRoomMembers(mergeMemberLists(currentMembers, serverState.members));
  const rooms = remapRoomsMemberReferences(mergedRooms, deduped.memberIdAliases, deduped.members);
  const members = deduped.members;
  const deletedMemberIds = uniqueIds([
    ...currentDeletedMemberIds.map((memberId) => deduped.memberIdAliases.get(memberId) ?? memberId),
    ...serverState.deletedMemberIds,
  ]).filter((memberId) => !deduped.memberIdAliases.has(memberId));
  return { rooms, members, deletedMemberIds };
}

export function replaceRoomsFromServerSnapshot(snapshot: RoomsInitResponse): {
  rooms: Room[];
  members: RoomMember[];
  deletedMemberIds: string[];
} {
  const normalizedSnapshot = normalizeRoomsInitResponse(snapshot);
  const serverRooms = roomsFromServerSnapshot(normalizedSnapshot);
  const deduped = dedupeRoomMembers(normalizedSnapshot.members);
  const rooms = remapRoomsMemberReferences(serverRooms, deduped.memberIdAliases, deduped.members);
  const members = deduped.members;
  const deletedMemberIds = uniqueIds([
    ...(normalizedSnapshot.deletedMemberIds ?? []),
    ...members.filter((member) => member.disabled).map((member) => member.id),
  ]).filter((memberId) => !deduped.memberIdAliases.has(memberId));
  return { rooms, members, deletedMemberIds };
}

export function applyRoomEvents(
  rooms: Room[],
  members: RoomMember[],
  events: RoomEvent[],
): { rooms: Room[]; members: RoomMember[]; requiresResync: boolean } {
  let nextRooms = rooms.map((room) => normalizeRoomAdministrators(room, members));
  let nextMembers = members;
  let requiresResync = false;
  for (const event of events) {
    const member = readMember(event.payload.member);
    const room = readRoom(event.payload.room, member ? upsertMember(nextMembers, member) : nextMembers);
    const message = readMessage(event.payload.message);
    if (event.type === "room.created" && room) {
      nextRooms = room.archived ? nextRooms : upsertRoom(nextRooms, { ...room, messages: [] });
    } else if (event.type === "room.updated" && room) {
      nextRooms = room.archived
        ? nextRooms.filter((item) => item.id !== room.id)
        : nextRooms.map((item) =>
            item.id === room.id ? mergeRoomRecord(item, { ...room, messages: item.messages }) : item,
          );
    } else if ((event.type === "room.member.added" || event.type === "room.member.updated") && member) {
      nextMembers = upsertMember(nextMembers, member);
      if (event.roomId) {
        nextRooms = nextRooms.map((item) =>
          item.id === event.roomId && !item.memberIds.includes(member.id)
            ? { ...item, memberIds: [...item.memberIds, member.id] }
            : item,
        );
      }
    } else if (event.type === "room.member.removed" && event.memberId) {
      nextRooms = nextRooms.map((item) =>
        item.id === event.roomId
          ? {
              ...item,
              memberIds: item.memberIds.filter((id) => id !== event.memberId),
              adminMemberIds: item.adminMemberIds.filter((id) => id !== event.memberId),
            }
          : item,
      );
    } else if (event.type === "room.message.created" && message) {
      nextRooms = upsertRoomMessage(nextRooms, message.roomId, message);
      nextMembers = applyMessageMemberStatus(nextMembers, message);
    } else if (event.type === "room.message.updated" && message) {
      nextRooms = upsertRoomMessage(nextRooms, message.roomId, message);
      nextMembers = applyMessageMemberStatus(nextMembers, message);
    } else if (event.type === "room.message.updated") {
      const patched = applyRoomMessagePatch(nextRooms, event);
      if (!patched) {
        requiresResync = true;
      } else {
        nextRooms = upsertRoomMessage(nextRooms, patched.roomId, patched);
        nextMembers = applyMessageMemberStatus(nextMembers, patched);
      }
    } else if (event.type === "room.message.deleted" && event.messageId) {
      nextRooms = deleteRoomMessage(nextRooms, event.roomId, event.messageId, event.createdAt);
    }
  }
  const deduped = dedupeRoomMembers(nextMembers);
  return {
    rooms: remapRoomsMemberReferences(nextRooms, deduped.memberIdAliases, deduped.members),
    members: deduped.members,
    requiresResync,
  };
}

function applyRoomMessagePatch(rooms: Room[], event: RoomEvent): ServerRoomMessage | undefined {
  if (!event.messageId) return undefined;
  const patch = readMessagePatch(event.payload.messagePatch);
  if (!patch) return undefined;
  const room = rooms.find((candidate) => candidate.id === event.roomId);
  const existing = room?.messages.find((message) => message.id === event.messageId);
  if (!existing) return undefined;
  const updated = {
    ...(existing as ServerRoomMessage),
    roomId: event.roomId,
    ...patch.set,
  } as unknown as Record<string, unknown>;
  for (const key of patch.unset) {
    if (!ROOM_MESSAGE_IMMUTABLE_FIELDS.has(key)) delete updated[key];
  }
  updated.id = existing.id;
  updated.roomId = event.roomId;
  return normalizeServerRoomMessage(updated as unknown as ServerRoomMessage);
}

const ROOM_MESSAGE_IMMUTABLE_FIELDS = new Set(["id", "roomId", "channelSeq", "createdAt"]);

function readMessagePatch(value: unknown): { set: Record<string, unknown>; unset: string[] } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const set = candidate.set;
  if (!set || typeof set !== "object" || Array.isArray(set)) return undefined;
  const safeSet = Object.fromEntries(
    Object.entries(set as Record<string, unknown>).filter(([key]) => !ROOM_MESSAGE_IMMUTABLE_FIELDS.has(key)),
  );
  const unset = Array.isArray(candidate.unset)
    ? candidate.unset.filter((key): key is string => typeof key === "string")
    : [];
  return { set: safeSet, unset };
}

function upsertRoom(rooms: Room[], room: Room): Room[] {
  const index = rooms.findIndex((item) => item.id === room.id);
  if (index < 0) return [room, ...rooms];
  return rooms.map((item) =>
    item.id === room.id ? mergeRoomRecord(item, { ...room, messages: item.messages }) : item,
  );
}

function upsertMember(members: RoomMember[], member: RoomMember): RoomMember[] {
  return members.some((item) => item.id === member.id)
    ? members.map((item) => (item.id === member.id ? { ...item, ...member } : item))
    : [...members, member];
}

function mergeRoomLists(currentRooms: Room[], incomingRooms: Room[]): Room[] {
  const byId = new Map(currentRooms.map((room) => [room.id, room]));
  for (const incoming of incomingRooms) {
    const current = byId.get(incoming.id);
    byId.set(incoming.id, current ? mergeRoomRecord(current, incoming) : incoming);
  }
  return [...byId.values()]
    .filter((room) => !room.archived)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function mergeRoomRecord(current: Room, incoming: Room): Room {
  const messages = pruneStaleLocalRunningMessages(
    mergeMessageLists(current.messages, incoming.messages),
    incoming.messages,
  );
  const incomingMemberIds = uniqueIds(incoming.memberIds);
  // App Rooms use their persisted scope as the authoritative roster boundary,
  // so an explicit empty roster is a complete and valid state. Keep the older
  // empty-as-partial compatibility behavior only for unscoped legacy Rooms.
  const hasCompleteMemberSnapshot = incomingMemberIds.length > 0 || incoming.scope?.kind === "app";
  const memberIds = hasCompleteMemberSnapshot ? incomingMemberIds : current.memberIds;
  const memberIdSet = new Set(memberIds);
  const adminMemberIds = (
    hasCompleteMemberSnapshot ? uniqueIds(incoming.adminMemberIds) : current.adminMemberIds
  ).filter((memberId) => memberIdSet.has(memberId));
  return {
    ...current,
    ...incoming,
    memberIds,
    adminMemberIds,
    messages,
  };
}

function pruneStaleLocalRunningMessages(messages: RoomMessage[], serverMessages: RoomMessage[]): RoomMessage[] {
  const serverMessageIds = new Set(serverMessages.map((message) => message.id));
  const serverRunIds = new Set(
    serverMessages.map((message) => message.runId).filter((value): value is string => Boolean(value)),
  );
  const now = Date.now();
  return messages.filter((message) => {
    if (serverMessageIds.has(message.id)) return true;
    if (message.runId && serverRunIds.has(message.runId)) return false;
    if (message.senderType !== "agent" || message.status !== "running") return true;
    if (message.runId) return true;
    const createdAt = Date.parse(message.createdAt);
    if (Number.isNaN(createdAt)) return false;
    return now - createdAt < LOCAL_PENDING_RUNNING_MESSAGE_TTL_MS;
  });
}

function mergeMemberLists(currentMembers: RoomMember[], incomingMembers: RoomMember[]): RoomMember[] {
  const byId = new Map(currentMembers.map((member) => [member.id, member]));
  for (const incoming of incomingMembers) {
    const current = byId.get(incoming.id);
    byId.set(incoming.id, current ? { ...current, ...incoming } : incoming);
  }
  return [...byId.values()];
}

function remapRoomsMemberReferences(
  rooms: Room[],
  memberIdAliases: Map<string, string>,
  members: RoomMember[],
): Room[] {
  const knownMemberIds = members.length
    ? new Set(members.filter((member) => !member.disabled).map((member) => member.id))
    : undefined;
  if (!memberIdAliases.size && !knownMemberIds) return rooms;
  return rooms.map((room) => remapRoomMemberReferences(room, memberIdAliases, knownMemberIds));
}

function mergeMessageLists(currentMessages: RoomMessage[], incomingMessages: RoomMessage[]): RoomMessage[] {
  const byId = new Map(currentMessages.map((message) => [message.id, normalizeDisplayedRoomMessage(message)]));
  const byRunId = messageRunIdIndex(byId.values());
  for (const incoming of incomingMessages) {
    const normalizedIncoming = normalizeDisplayedRoomMessage(incoming);
    const currentId = byId.has(incoming.id) ? incoming.id : messageRunMergeId(byRunId, normalizedIncoming);
    const current = currentId ? byId.get(currentId) : undefined;
    if (currentId && currentId !== incoming.id) {
      byId.delete(currentId);
    }
    byId.set(incoming.id, current ? mergeRoomMessageRecord(current, normalizedIncoming) : normalizedIncoming);
    if (normalizedIncoming.runId) {
      byRunId.set(normalizedIncoming.runId, incoming.id);
    }
  }
  return [...byId.values()].sort(sortRoomMessages);
}

export function mergeRoomMessageRecord<T extends RoomMessage>(current: T, incoming: T): T {
  const merged = normalizeRoomMessage({ ...current, ...incoming });
  if (!isTerminalMessageStatus(incoming.status)) return merged;
  return normalizeRoomMessage({
    ...merged,
    status: incoming.status,
    text: incoming.text,
    duration: incoming.duration,
    finishedAt: incoming.finishedAt || merged.finishedAt,
    parts: incoming.parts ?? [],
  });
}

function upsertRoomMessage(rooms: Room[], roomId: string, message: ServerRoomMessage): Room[] {
  const normalizedMessage = normalizeServerRoomMessage(message);
  return rooms.map((room) => {
    if (room.id !== roomId) return room;
    let existingMessage: RoomMessage | undefined;
    const messages = room.messages.filter((item) => {
      if (item.id === normalizedMessage.id || isSameRoomRunMessage(item, normalizedMessage)) {
        existingMessage = item;
        return false;
      }
      return true;
    });
    messages.push(existingMessage ? mergeRoomMessageRecord(existingMessage, normalizedMessage) : normalizedMessage);
    return {
      ...room,
      updatedAt: normalizedMessage.updatedAt || normalizedMessage.createdAt || room.updatedAt,
      messages: messages.sort(sortRoomMessages),
    };
  });
}

function deleteRoomMessage(rooms: Room[], roomId: string, messageId: string, updatedAt?: string): Room[] {
  return rooms.map((room) =>
    room.id === roomId
      ? {
          ...room,
          updatedAt: updatedAt || room.updatedAt,
          messages: room.messages.filter((message) => message.id !== messageId),
        }
      : room,
  );
}

function isTerminalMessageStatus(status: RoomMessage["status"]): boolean {
  return status === "done" || status === "failed" || status === "interrupted";
}

function messageRunIdIndex(messages: Iterable<RoomMessage>): Map<string, string> {
  const byRunId = new Map<string, string>();
  for (const message of messages) {
    if (message.senderType === "agent" && message.runId) {
      byRunId.set(message.runId, message.id);
    }
  }
  return byRunId;
}

function messageRunMergeId(byRunId: Map<string, string>, message: RoomMessage): string | undefined {
  return message.senderType === "agent" && message.runId ? byRunId.get(message.runId) : undefined;
}

function isSameRoomRunMessage(left: RoomMessage, right: RoomMessage): boolean {
  return Boolean(
    left.senderType === "agent" &&
      right.senderType === "agent" &&
      left.runId &&
      right.runId &&
      left.runId === right.runId,
  );
}

function applyMessageMemberStatus(members: RoomMember[], message: ServerRoomMessage): RoomMember[] {
  if (message.senderType !== "agent") return members;
  const status =
    message.status === "running"
      ? "running"
      : message.status === "done"
        ? "done"
        : message.status === "failed" || message.status === "interrupted"
          ? "idle"
          : undefined;
  if (!status) return members;
  return members.map((member) =>
    member.id === message.senderId ? { ...member, status, lastActive: "just now" } : member,
  );
}

export function sortRoomMessages(left: RoomMessage, right: RoomMessage): number {
  const leftSeq =
    typeof (left as ServerRoomMessage).channelSeq === "number" ? (left as ServerRoomMessage).channelSeq : undefined;
  const rightSeq =
    typeof (right as ServerRoomMessage).channelSeq === "number" ? (right as ServerRoomMessage).channelSeq : undefined;
  if (leftSeq !== undefined && rightSeq !== undefined && leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    roomSenderOrder(left) - roomSenderOrder(right) ||
    left.id.localeCompare(right.id)
  );
}

function roomSenderOrder(message: RoomMessage): number {
  if (message.senderType === "system") return 0;
  if (message.senderType === "user") return 1;
  return 2;
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function readRoom(value: unknown, members: RoomMember[] = []): Omit<Room, "messages"> | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  return normalizeRoomAdministrators(value as Omit<Room, "messages">, members);
}

function normalizeRoomAdministrators<T extends Omit<Room, "messages"> | Room>(room: T, members: RoomMember[]): T {
  const candidate = room as T & { adminMemberIds?: unknown };
  const memberIds = Array.isArray(room.memberIds) ? uniqueIds(room.memberIds) : [];
  const memberIdSet = new Set(memberIds);
  const admins = Array.isArray(candidate.adminMemberIds)
    ? uniqueIds(candidate.adminMemberIds.filter((value): value is string => typeof value === "string"))
    : memberIds.filter((memberId) => {
        const member = members.find((candidateMember) => candidateMember.id === memberId);
        return member ? isRoomPmMember(member) : false;
      });
  const adminMemberIds = admins.filter((memberId) => memberIdSet.has(memberId));
  if (stringIdsMatch(room.memberIds, memberIds) && stringIdsMatch(candidate.adminMemberIds, adminMemberIds)) {
    return room;
  }
  return {
    ...room,
    memberIds,
    adminMemberIds,
  };
}

function stringIdsMatch(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
  );
}

function readMember(value: unknown): RoomMember | null {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string"
    ? (value as RoomMember)
    : null;
}

function readMessage(value: unknown): ServerRoomMessage | null {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string"
    ? normalizeServerRoomMessage(value as ServerRoomMessage)
    : null;
}

function readPostRoomMessageResponse(value: unknown): PostRoomMessageResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("room_message_response_invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.ok !== true) {
    const error = typeof candidate.error === "string" ? candidate.error.trim() : "";
    throw new Error(error || "room_message_request_failed");
  }
  const room = readRoom(candidate.room);
  const userMessage = readMessage(candidate.userMessage);
  if (
    !room ||
    !userMessage ||
    !Array.isArray(candidate.assistantMessages) ||
    typeof candidate.currentEventSeq !== "number" ||
    !Number.isSafeInteger(candidate.currentEventSeq)
  ) {
    throw new Error("room_message_response_invalid");
  }
  const assistantMessages: ServerRoomMessage[] = [];
  for (const value of candidate.assistantMessages) {
    const message = readMessage(value);
    if (!message) throw new Error("room_message_response_invalid");
    assistantMessages.push(message);
  }
  return {
    ok: true,
    room,
    userMessage,
    assistantMessages,
    currentEventSeq: candidate.currentEventSeq,
  };
}

function normalizeRoomsInitResponse(snapshot: RoomsInitResponse): RoomsInitResponse {
  const messages = snapshot.messages.map(normalizeServerRoomMessage);
  const runningSenderIds = new Set(
    messages
      .filter((message) => message.senderType === "agent" && message.status === "running")
      .map((message) => message.senderId),
  );
  return {
    ...snapshot,
    members: snapshot.members.map((member) =>
      member.status === "running" && !runningSenderIds.has(member.id) ? { ...member, status: "idle" } : member,
    ),
    messages,
  };
}

function normalizeServerRoomMessage(message: ServerRoomMessage): ServerRoomMessage {
  return normalizeDisplayedRoomMessage(message) as ServerRoomMessage;
}

function normalizeDisplayedRoomMessage<T extends RoomMessage>(message: T): T {
  return normalizeRoomMessage(message);
}

export function normalizeRoomMessage<T extends RoomMessage>(message: T): T {
  if (message.senderType !== "agent") return message;
  const text = normalizeClientConnectorHelpText(message.text);
  const parts = normalizeClientConnectorMessageParts(message.parts);
  if (text === message.text && parts === message.parts) return message;
  return { ...message, text, ...(parts === message.parts ? {} : { parts }) };
}
