import type { JsonObject, Routine } from "../../core.js";
import type { KnowledgeDocument } from "../../knowledge/types.js";
import type {
  RoomChannelMember,
  RoomChannelMessage,
  RoomChannelRoom,
  RoomChannelSnapshot,
} from "../../rooms/channel-store.js";
import type { PersistedAgentState } from "../../storage/json-state-store.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/581
 * Supports: OpenGrove <=0.6.1 local state with scoped IDs or retired cloud/remote members.
 * Remove when: OpenGrove 0.7.0 requires direct upgrades from >=0.6.2; older backups move to the standalone importer.
 */

type LegacyRoomChannelRoom = Omit<RoomChannelRoom, "adminMemberIds"> & {
  adminMemberIds?: string[];
};

// Scoped member ids are currently emitted by shortHash(), which is sha256 hex
// sliced to 12 characters. Keeping the persisted decoder pinned to that shape
// avoids silently mis-parsing a future hash format that contains "-".
const SCOPED_HASH_PATTERN = "[0-9a-f]{12}";
const LOCAL_SCOPED_MEMBER_ID_RE = new RegExp(`^member-user-${SCOPED_HASH_PATTERN}-(.+)$`);
const LOCAL_SCOPED_MEMBER_FRAGMENT_RE = new RegExp(`member-user-${SCOPED_HASH_PATTERN}-[A-Za-z0-9._-]+`, "g");
const MEMBER_REF_KEYS = new Set([
  "memberId",
  "senderId",
  "directMemberId",
  "targetMemberId",
  "localMemberId",
  "requestedMemberId",
]);
const ROOM_REF_KEYS = new Set(["roomId"]);
const MEMBER_REF_ARRAY_KEYS = new Set(["memberIds", "adminMemberIds", "targetIds"]);
const REMOVED_STACK_MEMBER_ID_PREFIXES = ["member-cloud-app-", "member-cloud-run-"];

export interface LocalUnscopedMigrationResult {
  changed: boolean;
  roomsChanged: number;
  membersChanged: number;
  messagesChanged: number;
  routinesChanged: number;
  knowledgeChanged: number;
  pmPurgeChanged: boolean;
  purgedPmMembers: RoomChannelMember[];
  removedRoomEventSeqs: number[];
}

export interface LocalUnscopedMigrationOptions {
  /** @deprecated App lifecycle policy is handled after mounted-App seed sync. */
  uninstalledAppIds?: Iterable<string>;
  /** @deprecated App lifecycle policy is handled after mounted-App seed sync. */
  mountedAppIds?: Iterable<string>;
}

export function migrateLocalStateToUnscoped(
  input: PersistedAgentState,
  _options: LocalUnscopedMigrationOptions = {},
): {
  state: PersistedAgentState;
  result: LocalUnscopedMigrationResult;
} {
  const result: LocalUnscopedMigrationResult = {
    changed: false,
    roomsChanged: 0,
    membersChanged: 0,
    messagesChanged: 0,
    routinesChanged: 0,
    knowledgeChanged: 0,
    pmPurgeChanged: false,
    purgedPmMembers: [],
    removedRoomEventSeqs: [],
  };
  // This compatibility pass only converts legacy storage formats. Mounted-App
  // installation state is not complete at this point in startup, so deciding
  // whether an App employee should exist here would turn a format migration
  // into a stale product-policy decision. Runtime seed sync owns activation.
  const rooms = migrateRooms(input.rooms, result);
  const routines = input.routines.map((routine) => migrateRoutine(routine, result));
  const knowledge = input.knowledge.map((document) => migrateKnowledgeDocument(document, result));
  return {
    state: {
      ...input,
      rooms,
      knowledgeEvidence: migrateReferenceArray(input.knowledgeEvidence, result),
      knowledgeRevisions: migrateReferenceArray(input.knowledgeRevisions, result),
      knowledgeDeliveries: migrateReferenceArray(input.knowledgeDeliveries, result),
      knowledgeFeedback: migrateReferenceArray(input.knowledgeFeedback, result),
      workingState: migrateReferenceValue(input.workingState, result),
      approvals: migrateReferenceArray(input.approvals, result),
      questions: migrateReferenceArray(input.questions, result),
      events: migrateReferenceArray(input.events, result),
      routines,
      knowledge,
      sessions: migrateReferenceArray(input.sessions, result),
      runs: migrateReferenceArray(input.runs, result),
      executions: migrateReferenceArray(input.executions, result),
    },
    result,
  };
}

export function unscopedRoomId(value: string): string {
  let output = value.trim();
  const cloudMatch = output.match(/^cloud-user:[^:]+:(.+)$/);
  if (cloudMatch?.[1]) output = cloudMatch[1];
  return replaceScopedMemberFragments(output);
}

export function unscopedMemberId(value: string): string {
  const normalized = value.trim();
  return normalized.match(LOCAL_SCOPED_MEMBER_ID_RE)?.[1] ?? normalized;
}

function migrateRooms(input: RoomChannelSnapshot, result: LocalUnscopedMigrationResult): RoomChannelSnapshot {
  const membersById = new Map<string, RoomChannelMember>();
  const removedStackMemberIds = new Set<string>();
  for (const member of input.members) {
    const mapped = migrateMember(member);
    if (isRemovedStackMember(member)) {
      removedStackMemberIds.add(mapped.id);
    }
    if (JSON.stringify(mapped) !== JSON.stringify(member)) {
      result.changed = true;
      result.membersChanged += 1;
    }
    const existing = membersById.get(mapped.id);
    membersById.set(mapped.id, existing ? mergeMember(existing, mapped, member.id === mapped.id) : mapped);
  }

  const roomsById = new Map<string, LegacyRoomChannelRoom>();
  for (const persistedRoom of input.rooms) {
    const room = persistedRoom as LegacyRoomChannelRoom;
    const mapped = migrateRoom(room);
    if (JSON.stringify(mapped) !== JSON.stringify(room)) {
      result.changed = true;
      result.roomsChanged += 1;
    }
    const existing = roomsById.get(mapped.id);
    roomsById.set(mapped.id, existing ? mergeRoom(existing, mapped) : mapped);
  }

  const messageByKey = new Map<string, RoomChannelMessage>();
  for (const message of input.messages) {
    const mapped = migrateMessage(message);
    if (JSON.stringify(mapped) !== JSON.stringify(message)) {
      result.changed = true;
      result.messagesChanged += 1;
    }
    const key = `${mapped.roomId}\u0000${mapped.id}`;
    const existing = messageByKey.get(key);
    messageByKey.set(key, existing && existing.updatedAt > mapped.updatedAt ? existing : mapped);
  }

  const events = input.events.map((event) => {
    const mapped = migrateReferenceFields({
      ...event,
      roomId: unscopedRoomId(event.roomId),
      memberId: event.memberId ? unscopedMemberId(event.memberId) : event.memberId,
    }) as typeof event;
    if (JSON.stringify(mapped) !== JSON.stringify(event)) {
      result.changed = true;
    }
    return mapped;
  });
  const deletedMemberIds = [
    ...new Set([
      ...(input.deletedMemberIds ?? []).map(unscopedMemberId),
      ...[...removedStackMemberIds].filter((memberId) => membersById.get(memberId)?.disabled),
    ]),
  ];
  if (JSON.stringify(deletedMemberIds) !== JSON.stringify(input.deletedMemberIds ?? [])) {
    result.changed = true;
  }

  return {
    version: 1,
    currentEventSeq: input.currentEventSeq,
    // Preserve field absence for the next ordered migration step,
    // room-administrators-v1, to distinguish old data from an explicit empty list.
    rooms: [...roomsById.values()] as RoomChannelRoom[],
    members: [...membersById.values()],
    messages: [...messageByKey.values()],
    events,
    deletedMemberIds,
  };
}

function migrateMember(member: RoomChannelMember): RoomChannelMember {
  const id = unscopedMemberId(member.id);
  if (isRemovedStackMember(member)) {
    return {
      ...member,
      id,
      status: "offline",
      lastActive: "已移除",
      disabled: true,
    };
  }
  return {
    ...member,
    id,
  };
}

function isRemovedStackMember(member: RoomChannelMember): boolean {
  const legacy = member as unknown as {
    source?: unknown;
    remote?: { provider?: unknown };
    cloudTargetDeviceId?: unknown;
    cloudAgentId?: unknown;
  };
  return (
    legacy.source === "remote" ||
    legacy.remote?.provider === "matrix" ||
    legacy.remote?.provider === "cloud" ||
    REMOVED_STACK_MEMBER_ID_PREFIXES.some((prefix) => member.id.startsWith(prefix)) ||
    typeof legacy.cloudTargetDeviceId === "string" ||
    typeof legacy.cloudAgentId === "string"
  );
}

function migrateRoom(room: LegacyRoomChannelRoom): LegacyRoomChannelRoom {
  const id = unscopedRoomId(room.id);
  const memberIds = [...new Set(room.memberIds.map(unscopedMemberId))];
  const adminMemberIds = [
    ...new Set((Array.isArray(room.adminMemberIds) ? room.adminMemberIds : []).map(unscopedMemberId)),
  ].filter((memberId) => memberIds.includes(memberId));
  const removedMemberIds = [...new Set((room.removedMemberIds ?? []).map(unscopedMemberId))];
  const directMemberId = room.directMemberId ? unscopedMemberId(room.directMemberId) : undefined;
  const hadAdminMemberIds = Object.prototype.hasOwnProperty.call(room, "adminMemberIds");
  const mapped = {
    ...room,
    id,
    memberIds,
    removedMemberIds,
    ...(directMemberId ? { directMemberId } : { directMemberId: undefined }),
  };
  // Field absence is consumed by the next ordered migration step. An explicit
  // empty list remains an intentional administrator-free choice.
  return hadAdminMemberIds ? { ...mapped, adminMemberIds } : withoutAdminMemberIds(mapped);
}

function migrateMessage(message: RoomChannelMessage): RoomChannelMessage {
  return migrateReferenceFields({
    ...message,
    roomId: unscopedRoomId(message.roomId),
    senderId: unscopedMemberId(message.senderId),
    targetIds: [...new Set(message.targetIds.map(unscopedMemberId))],
  }) as RoomChannelMessage;
}

function migrateRoutine(routine: Routine, result: LocalUnscopedMigrationResult): Routine {
  const mapped: Routine = {
    ...routine,
    steps: routine.steps.map((step) => {
      const output = { ...step };
      if (step.memberId) output.memberId = unscopedMemberId(step.memberId);
      if (step.roomId) output.roomId = unscopedRoomId(step.roomId);
      if (step.input !== undefined) output.input = migrateReferenceFields(step.input) as typeof step.input;
      return output;
    }),
  };
  if (JSON.stringify(mapped) !== JSON.stringify(routine)) {
    result.changed = true;
    result.routinesChanged += 1;
  }
  return mapped;
}

function migrateKnowledgeDocument(
  document: KnowledgeDocument,
  result: LocalUnscopedMigrationResult,
): KnowledgeDocument {
  const mapped: KnowledgeDocument = {
    ...document,
    metadata: migrateReferenceFields(document.metadata) as KnowledgeDocument["metadata"],
  };
  if (JSON.stringify(mapped) !== JSON.stringify(document)) {
    result.changed = true;
    result.knowledgeChanged += 1;
  }
  return mapped;
}

function migrateReferenceArray<T>(items: T[], result: LocalUnscopedMigrationResult): T[] {
  return items.map((item) => migrateReferenceValue(item, result));
}

function migrateReferenceValue<T>(value: T, result: LocalUnscopedMigrationResult): T {
  const mapped = migrateReferenceFields(value) as T;
  if (JSON.stringify(mapped) !== JSON.stringify(value)) {
    result.changed = true;
  }
  return mapped;
}

function migrateReferenceFields(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    if (MEMBER_REF_ARRAY_KEYS.has(key)) {
      return [...new Set(value.map((item) => (typeof item === "string" ? unscopedMemberId(item) : item)))];
    }
    return value.map((item) => migrateReferenceFields(item));
  }
  if (!value || typeof value !== "object") return value;
  const output: JsonObject = {};
  for (const [key, raw] of Object.entries(value as JsonObject)) {
    if (typeof raw === "string") {
      output[key] = migrateReferenceStringField(key, raw);
    } else {
      output[key] = migrateReferenceFields(raw, key) as JsonObject[keyof JsonObject];
    }
  }
  return output;
}

function withoutAdminMemberIds(room: LegacyRoomChannelRoom): LegacyRoomChannelRoom {
  const { adminMemberIds: _adminMemberIds, ...withoutAdmins } = room;
  return withoutAdmins;
}

function migrateReferenceStringField(key: string, value: string): string {
  if (ROOM_REF_KEYS.has(key)) return unscopedRoomId(value);
  if (MEMBER_REF_KEYS.has(key)) return unscopedMemberId(value);
  return value;
}

function replaceScopedMemberFragments(value: string): string {
  return value.replace(LOCAL_SCOPED_MEMBER_FRAGMENT_RE, (match) => unscopedMemberId(match));
}

function mergeMember(left: RoomChannelMember, right: RoomChannelMember, rightWasSource: boolean): RoomChannelMember {
  if (left.disabled && !right.disabled) return right;
  if (rightWasSource && !right.disabled)
    return { ...right, status: left.status === "running" ? left.status : right.status };
  return left;
}

function mergeRoom(left: LegacyRoomChannelRoom, right: LegacyRoomChannelRoom): LegacyRoomChannelRoom {
  const rightNewer = Date.parse(right.updatedAt) >= Date.parse(left.updatedAt);
  const removedMemberIds = [...new Set([...(left.removedMemberIds ?? []), ...(right.removedMemberIds ?? [])])];
  const removedMemberIdSet = new Set(removedMemberIds);
  const memberIds = [...new Set([...left.memberIds, ...right.memberIds])].filter(
    (memberId) => !removedMemberIdSet.has(memberId),
  );
  const hasAdminMemberIds =
    Object.prototype.hasOwnProperty.call(left, "adminMemberIds") ||
    Object.prototype.hasOwnProperty.call(right, "adminMemberIds");
  const adminMemberIds = [
    ...new Set([
      ...(Array.isArray(left.adminMemberIds) ? left.adminMemberIds : []),
      ...(Array.isArray(right.adminMemberIds) ? right.adminMemberIds : []),
    ]),
  ].filter((memberId) => memberIds.includes(memberId));
  const merged = {
    ...left,
    title: rightNewer ? right.title : left.title,
    badge: rightNewer ? right.badge : left.badge,
    memberIds,
    removedMemberIds,
    directMemberId: left.directMemberId ?? right.directMemberId,
    pinned: Boolean(left.pinned || right.pinned),
    archived: Boolean(left.archived && right.archived),
    updatedAt: rightNewer ? right.updatedAt : left.updatedAt,
  };
  return hasAdminMemberIds ? { ...merged, adminMemberIds } : merged;
}
