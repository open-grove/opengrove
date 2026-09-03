import type { AgentAttachmentContext, JsonObject } from "../core.js";
import type { KernelCapabilityId } from "../kernel/capabilities/types.js";
import type { RoomMemberSource, RoomMessageDeliveryKind, RoomMessageSenderType } from "./channel-types.js";
import {
  cloneEvent,
  cloneMember,
  cloneMessage,
  cloneRoom,
  createId,
  dedupeMembersById,
  nextChannelSeq,
  normalizeMember,
  normalizeRoomChannelSnapshot,
  nowIso,
  objectRecord,
  uniqueIds,
} from "./channel-normalize.js";
import { isRoomPmMember, OPENGROVE_PM_MEMBER_ID, pmAgentMemberId } from "./room-pm.js";

export { normalizeRoomChannelSnapshot } from "./channel-normalize.js";
export type {
  RoomMemberSource,
  RoomMessageDeliveryKind,
  RoomMessageSenderType,
} from "./channel-types.js";

export type RoomMemberStatus = "idle" | "running" | "done" | "waiting" | "offline";
export type RoomMessageStatus = "sent" | "running" | "done" | "failed" | "interrupted";
export type RoomMessageAudience = "room" | "internal";
export type RoomKind = "group" | "direct";
export type RoomMemberVisibility = "private" | "public";
export type RoomMemberAccessMode = "default" | "auto-review" | "full-access";
export type RoomMemberReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type RoomMemberAvatarMode = "generated" | "initials" | "upload";

export interface AppRoomScope {
  kind: "app";
  /** Exact mounted-App identity. Room ids and presentation metadata are never authoritative for this value. */
  appId: string;
  role?: "default" | "group" | "direct";
}

export interface RoomChannelMember {
  id: string;
  /** Stable logical Employee identity shared by scoped App bindings. */
  employeeDefinitionId?: string;
  name: string;
  /** Locale-dependent label for UI only. Runtime routing and prompts use name. */
  displayName?: string;
  kernel: string;
  model: string;
  /** Provider the user chose specifically for this Employee. Empty means follow the user's model default. */
  providerId?: string;
  role: string;
  /** Locale-dependent role text for UI only. Runtime prompts always use role. */
  displayRole?: string;
  status: RoomMemberStatus;
  color: string;
  lastActive: string;
  /** Skills this employee may discover/use. Undefined preserves the legacy "all catalog skills" behavior. */
  availableSkillIds?: string[];
  /** Skills the host must load and inject on every normal employee turn. */
  defaultSkillIds?: string[];
  appId?: string;
  workspaceRoot?: string;
  storePackageId?: string;
  toolIds?: string[];
  /** Certified Kernel capabilities this employee requires for correct execution. */
  requiredKernelCapabilities?: KernelCapabilityId[];
  accessMode?: RoomMemberAccessMode;
  reasoningEffort?: RoomMemberReasoningEffort;
  /** Per-employee conversation context budget. Missing values use the product default. */
  contextTokenBudget?: number;
  avatarMode?: RoomMemberAvatarMode;
  avatarSeed?: string;
  avatarDataUrl?: string;
  source?: RoomMemberSource;
  sourceLabel?: string;
  visibility?: RoomMemberVisibility;
  publicDescription?: string;
  /** Locale-dependent public summary for UI only. */
  displayPublicDescription?: string;
  publicSkills?: string[];
  displayPublicSkills?: string[];
  inputSpec?: string;
  displayInputSpec?: string;
  outputSpec?: string;
  displayOutputSpec?: string;
  // Field names the user explicitly edited in the UI. Ordinary mounted-app seed
  // sync preserves them; an actual App update clears App-owned overrides at its
  // activation boundary while retaining the user-owned Provider route.
  userOverrides?: string[];
  // Snapshot of the mounted-app manifest defaults for this employee, refreshed on
  // each seed sync so the UI can flag "(默认)" and offer "restore default".
  manifestDefaults?: RoomMemberManifestDefaults;
  disabled?: boolean;
}

export interface RoomMemberManifestDefaults {
  name?: string;
  avatarMode?: RoomMemberAvatarMode;
  avatarSeed?: string;
  avatarDataUrl?: string;
  role?: string;
  kernel?: string;
  model?: string;
  color?: string;
  availableSkillIds?: string[];
  defaultSkillIds?: string[];
  requiredKernelCapabilities?: KernelCapabilityId[];
  reasoningEffort?: RoomMemberReasoningEffort;
  contextTokenBudget?: number;
  accessMode?: RoomMemberAccessMode;
  visibility?: RoomMemberVisibility;
  publicDescription?: string;
  publicSkills?: string[];
  inputSpec?: string;
  outputSpec?: string;
}

export interface RoomChannelRoom {
  id: string;
  kind: RoomKind;
  /** Server-owned business scope. Missing only on general or not-yet-migrated legacy Rooms. */
  scope?: AppRoomScope;
  title: string;
  generatedTitle?:
    | {
        kind: "app-group";
        appId: string;
        sequence: number;
      }
    | {
        kind: "numbered-group";
        sequence: number;
      };
  badge: string;
  memberIds: string[];
  /** Room members allowed to delegate work to other employees in this room. */
  adminMemberIds: string[];
  /** Member ids explicitly removed from this room; seed sync must not re-add them. */
  removedMemberIds?: string[];
  directMemberId?: string;
  pinned?: boolean;
  archived?: boolean;
  updatedAt: string;
  /** Global Room event sequence through which the local principal has read this Room. */
  lastReadEventSeq?: number;
  unread: number;
}

export interface RoomChannelMessage {
  id: string;
  roomId: string;
  channelSeq: number;
  senderId: string;
  senderName: string;
  senderType: RoomMessageSenderType;
  text: string;
  targetIds: string[];
  status: RoomMessageStatus;
  createdAt: string;
  updatedAt: string;
  attachments?: AgentAttachmentContext[];
  duration?: string;
  runId?: string;
  parts?: JsonObject[];
  startedAt?: string;
  finishedAt?: string;
  audience?: RoomMessageAudience;
  deliveryKind?: RoomMessageDeliveryKind;
  inReplyToMessageId?: string;
  rootMessageId?: string;
  selectedFile?: {
    path: string;
  };
  /** First event at which this message became visible enough to notify the local principal. */
  notificationEventSeq?: number;
}

export type RoomChannelEventType =
  | "room.created"
  | "room.updated"
  | "room.member.added"
  | "room.member.updated"
  | "room.member.removed"
  | "room.message.created"
  | "room.message.updated"
  | "room.message.deleted";

export interface RoomChannelEvent {
  /** Version 2 stores message updates as patches instead of full message copies. */
  schemaVersion?: 1 | 2;
  eventSeq: number;
  type: RoomChannelEventType;
  roomId: string;
  messageId?: string;
  memberId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface RoomChannelSnapshot {
  version: 1;
  currentEventSeq: number;
  rooms: RoomChannelRoom[];
  members: RoomChannelMember[];
  messages: RoomChannelMessage[];
  events: RoomChannelEvent[];
  deletedMemberIds?: string[];
}

export interface RoomChannelInit {
  rooms: RoomChannelRoom[];
  members: RoomChannelMember[];
  messages: RoomChannelMessage[];
  currentEventSeq: number;
  deletedMemberIds: string[];
  messagesTruncated?: boolean;
}

export interface PostRoomMessageResult {
  room: RoomChannelRoom;
  userMessage: RoomChannelMessage;
  assistantMessages: RoomChannelMessage[];
  currentEventSeq: number;
}

export interface SystemRoomMemberRuntime {
  kernel?: string;
  model?: string;
}

export const GROVE_GUIDE_MEMBER_ID = "grove-guide";
export const GROVE_GUIDE_SKILL_NAME = "grove-guide";
export const APP_CREATOR_MEMBER_ID = "app-creator";

const EVENT_RETENTION_LIMIT = 5_000;
const RECENT_MESSAGE_LIMIT = 80;
const GROVE_ROOM_ID = "room-open-group";
// app-creator was a legacy ghost member. Grove is now a real product Employee
// and must survive restore like every other member.
const BUILTIN_SYSTEM_MEMBER_IDS = new Set([APP_CREATOR_MEMBER_ID]);
export const GROVE_GUIDE_TEXT =
  "本地版会优先使用这台机器上的内核。请先在设置的“内核与知识”里确认 Codex、Claude Agent 等本机内核可用；准备好后可以创建员工、安装本地 App，或直接在这里发任务。";

// ===== 可运行员工判定(下沉到 rooms 层:它本就是 member 属性) =====
// server 层(bridge-types / room-runs/scheduler)从这里 re-export,保持现有 import 不变。
// app 层(create-opengrove 的 workflow.create 成员校验)也能直接用,避免 app→server 反向依赖。
export const BRIDGE_KERNEL_IDS = ["codex", "claude-code", "hermes", "pi", "openclaw", "opencode", "kimi"] as const;

export function isBridgeKernelId(value: string | undefined): value is (typeof BRIDGE_KERNEL_IDS)[number] {
  return Boolean(value && (BRIDGE_KERNEL_IDS as readonly string[]).includes(value));
}

// 一个成员可被编排为 routine/room 执行目标 ⟺ 未禁用、本地来源、内核在 bridge 白名单。
export function isRunnableRoomAssistantTarget(target: RoomChannelMember): boolean {
  return !target.disabled && (target.source ?? "local") === "local" && isBridgeKernelId(target.kernel);
}

export function isGroveGuideMember(member: Pick<RoomChannelMember, "id" | "name"> | undefined): boolean {
  return Boolean(member && (member.id === GROVE_GUIDE_MEMBER_ID || member.name === "Grove"));
}

export function isAppCreatorMember(member: Pick<RoomChannelMember, "id" | "name"> | undefined): boolean {
  return Boolean(member && (member.id === APP_CREATOR_MEMBER_ID || member.name === "App Creator"));
}

export function isBuiltinSystemMemberId(memberId: string): boolean {
  return BUILTIN_SYSTEM_MEMBER_IDS.has(memberId);
}

export class RoomChannelStore {
  private rooms = new Map<string, RoomChannelRoom>();
  private members = new Map<string, RoomChannelMember>();
  private messagesByRoom = new Map<string, RoomChannelMessage[]>();
  private events: RoomChannelEvent[] = [];
  private readonly eventWaiters = new Set<() => void>();
  private deletedMemberIds = new Set<string>();
  private currentEventSeq = 0;
  private restoredWithChanges = false;

  restore(snapshot: RoomChannelSnapshot | undefined): void {
    this.releaseEventWaiters();
    this.rooms.clear();
    this.members.clear();
    this.messagesByRoom.clear();
    this.events = [];
    this.deletedMemberIds.clear();
    this.currentEventSeq = 0;
    this.restoredWithChanges = false;

    const normalized = normalizeRoomChannelSnapshot(snapshot);
    this.currentEventSeq = normalized.currentEventSeq;
    for (const member of normalized.members) {
      this.members.set(member.id, member);
      if (member.disabled) {
        this.deletedMemberIds.add(member.id);
      }
    }
    for (const memberId of normalized.deletedMemberIds ?? []) {
      this.deletedMemberIds.add(memberId);
    }
    for (const room of normalized.rooms) {
      this.rooms.set(room.id, room);
      this.messagesByRoom.set(room.id, []);
    }
    for (const message of normalized.messages) {
      const bucket = this.messagesByRoom.get(message.roomId) ?? [];
      bucket.push(message);
      this.messagesByRoom.set(message.roomId, bucket);
    }
    for (const [roomId, bucket] of this.messagesByRoom) {
      bucket.sort((left, right) => left.channelSeq - right.channelSeq);
      this.messagesByRoom.set(roomId, bucket);
    }
    this.events = normalized.events.slice(-EVENT_RETENTION_LIMIT).sort((left, right) => left.eventSeq - right.eventSeq);
    const builtinStateChanged = this.removeBuiltinSystemMembers();
    const unreadStateChanged = this.repairRestoredUnreadState();
    this.restoredWithChanges = unreadStateChanged || builtinStateChanged;
  }

  snapshot(): RoomChannelSnapshot {
    return {
      version: 1,
      currentEventSeq: this.currentEventSeq,
      rooms: this.listRooms(),
      members: this.listMembers(),
      messages: [...this.messagesByRoom.values()].flatMap((messages) => messages.map((message) => ({ ...message }))),
      events: this.events.map((event) => ({ ...event, payload: { ...event.payload } })),
      deletedMemberIds: this.listDeletedMemberIds(),
    };
  }

  ensureOpenGroup(seedMembers: RoomChannelMember[], _systemRuntime: SystemRoomMemberRuntime = {}): boolean {
    let changed = this.restoredWithChanges;
    this.restoredWithChanges = false;
    const seed = dedupeMembersById(seedMembers.filter((member) => !isBuiltinSystemMemberId(member.id)));
    for (const member of seed) {
      const normalized = normalizeMember(member);
      const existing = this.members.get(normalized.id);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(normalized)) {
        changed = true;
      }
      this.upsertMember(normalized, { emitEvent: true });
    }
    return this.removeBuiltinSystemMembers() || changed;
  }

  ensureGroupRoom(input: {
    id: string;
    title: string;
    badge: string;
    scope?: AppRoomScope;
    generatedTitle?: RoomChannelRoom["generatedTitle"];
    memberIds: string[];
    adminMemberIds?: string[];
    preserveExistingMembers?: boolean;
    preserveExistingAdmins?: boolean;
  }): boolean {
    const roomId = input.id.trim();
    if (!roomId) return false;
    const existing = this.rooms.get(roomId);
    if (existing && JSON.stringify(existing.scope) !== JSON.stringify(input.scope)) {
      throw new Error("room_scope_conflict");
    }
    const scope = input.scope ?? existing?.scope;
    const activeMemberIds = this.requireActiveGroupMemberReferences(input.memberIds);
    const defaultedMemberIds = this.withDefaultGroupPm(activeMemberIds, scope);
    this.assertAppRoomMembersAllowed(scope, defaultedMemberIds);
    const requestedMemberIds = defaultedMemberIds;
    const requestedAdminIds = requestedAdminMemberIds(input.adminMemberIds, requestedMemberIds, this.members);
    if (!requestedMemberIds.length) return false;
    if (!existing) {
      const createdAt = nowIso();
      const room: RoomChannelRoom = {
        id: roomId,
        kind: "group",
        scope,
        title: input.title.trim() || "new group",
        generatedTitle: input.generatedTitle,
        badge: input.badge.trim() || "Group",
        memberIds: requestedMemberIds,
        adminMemberIds: requestedAdminIds,
        pinned: false,
        archived: false,
        lastReadEventSeq: this.currentEventSeq,
        unread: 0,
        updatedAt: createdAt,
      };
      this.rooms.set(roomId, room);
      this.messagesByRoom.set(roomId, []);
      this.emit("room.created", roomId, { room });
      return true;
    }
    if (existing.kind !== "group") return false;
    const title = input.title.trim() || existing.title;
    const badge = input.badge.trim() || existing.badge;
    const memberIds = input.preserveExistingMembers
      ? uniqueIds([
          ...existing.memberIds.filter((memberId) => this.isActiveGroupMemberReference(memberId)),
          ...requestedMemberIds.filter((memberId) => !(existing.removedMemberIds ?? []).includes(memberId)),
        ])
      : requestedMemberIds;
    const preserveAdmins = input.preserveExistingAdmins || input.adminMemberIds === undefined;
    const candidateAdminMemberIds = preserveAdmins
      ? existing.adminMemberIds.filter((memberId) => memberIds.includes(memberId))
      : requestedAdminMemberIds(input.adminMemberIds, memberIds, this.members);
    this.assertAppRoomMembersAllowed(scope, memberIds);
    const adminMemberIds = candidateAdminMemberIds;
    const sameMembers =
      existing.memberIds.length === memberIds.length &&
      existing.memberIds.every((memberId, index) => memberId === memberIds[index]);
    const sameAdmins =
      existing.adminMemberIds.length === adminMemberIds.length &&
      existing.adminMemberIds.every((memberId, index) => memberId === adminMemberIds[index]);
    const generatedTitle = input.generatedTitle ?? existing.generatedTitle;
    if (
      sameMembers &&
      sameAdmins &&
      JSON.stringify(existing.scope) === JSON.stringify(scope) &&
      existing.title === title &&
      existing.badge === badge &&
      JSON.stringify(existing.generatedTitle) === JSON.stringify(generatedTitle)
    )
      return false;
    const updated: RoomChannelRoom = {
      ...existing,
      scope,
      title,
      generatedTitle,
      badge,
      memberIds,
      adminMemberIds,
      directMemberId: undefined,
      updatedAt: nowIso(),
    };
    this.rooms.set(roomId, updated);
    this.emit("room.updated", roomId, { room: updated });
    return true;
  }

  ensureGroveRoomDefaults(_roomId: string = GROVE_ROOM_ID): boolean {
    return this.removeBuiltinSystemMembers();
  }

  removeBuiltinSystemMembers(): boolean {
    let changed = false;
    for (const memberId of BUILTIN_SYSTEM_MEMBER_IDS) {
      if (this.members.delete(memberId)) {
        this.deletedMemberIds.add(memberId);
        changed = true;
      }
    }

    const removedRoomIds = new Set<string>();
    for (const [roomId, room] of this.rooms) {
      const isBuiltinDirectRoom =
        isBuiltinSystemMemberId(room.directMemberId ?? "") ||
        room.id === GROVE_ROOM_ID ||
        room.id === `direct-${APP_CREATOR_MEMBER_ID}`;
      if (isBuiltinDirectRoom) {
        this.rooms.delete(roomId);
        this.messagesByRoom.delete(roomId);
        removedRoomIds.add(roomId);
        changed = true;
        continue;
      }
      const nextMemberIds = room.memberIds.filter((memberId) => !isBuiltinSystemMemberId(memberId));
      if (nextMemberIds.length !== room.memberIds.length) {
        this.rooms.set(roomId, {
          ...room,
          memberIds: nextMemberIds,
          updatedAt: nowIso(),
        });
        changed = true;
      }
    }

    const removedMessageIds = new Set<string>();
    for (const [roomId, messages] of this.messagesByRoom) {
      const nextMessages: RoomChannelMessage[] = [];
      let messagesChanged = false;
      for (const message of messages) {
        if (isBuiltinSystemMemberId(message.senderId)) {
          removedMessageIds.add(message.id);
          messagesChanged = true;
          continue;
        }
        const nextTargetIds = message.targetIds.filter((memberId) => !isBuiltinSystemMemberId(memberId));
        if (nextTargetIds.length !== message.targetIds.length) {
          nextMessages.push({ ...message, targetIds: nextTargetIds, updatedAt: nowIso() });
          messagesChanged = true;
        } else {
          nextMessages.push(message);
        }
      }
      if (messagesChanged) {
        this.messagesByRoom.set(roomId, nextMessages);
        changed = true;
      }
    }

    const nextEvents: RoomChannelEvent[] = [];
    let eventsChanged = false;
    for (const event of this.events) {
      const payloadRoom = objectRecord(event.payload.room);
      const payloadMessage = objectRecord(event.payload.message);
      const payloadMember = objectRecord(event.payload.member);
      const payloadRoomDirectMemberId =
        typeof payloadRoom?.directMemberId === "string" ? payloadRoom.directMemberId : "";
      const payloadMessageSenderId = typeof payloadMessage?.senderId === "string" ? payloadMessage.senderId : "";
      const payloadMemberId = typeof payloadMember?.id === "string" ? payloadMember.id : "";
      const referencesBuiltin =
        removedRoomIds.has(event.roomId) ||
        Boolean(event.memberId && isBuiltinSystemMemberId(event.memberId)) ||
        Boolean(event.messageId && removedMessageIds.has(event.messageId)) ||
        isBuiltinSystemMemberId(payloadRoomDirectMemberId) ||
        isBuiltinSystemMemberId(payloadMessageSenderId) ||
        isBuiltinSystemMemberId(payloadMemberId);
      if (referencesBuiltin) {
        eventsChanged = true;
        continue;
      }
      const payloadRoomMemberIds = Array.isArray(payloadRoom?.memberIds) ? payloadRoom.memberIds : undefined;
      const payloadMessageTargetIds = Array.isArray(payloadMessage?.targetIds) ? payloadMessage.targetIds : undefined;
      let nextPayload = event.payload;
      if (
        payloadRoom &&
        payloadRoomMemberIds?.some((memberId) => typeof memberId === "string" && isBuiltinSystemMemberId(memberId))
      ) {
        nextPayload = {
          ...nextPayload,
          room: {
            ...payloadRoom,
            memberIds: payloadRoomMemberIds.filter(
              (memberId) => typeof memberId !== "string" || !isBuiltinSystemMemberId(memberId),
            ),
          },
        };
        eventsChanged = true;
      }
      if (
        payloadMessage &&
        payloadMessageTargetIds?.some((memberId) => typeof memberId === "string" && isBuiltinSystemMemberId(memberId))
      ) {
        nextPayload = {
          ...nextPayload,
          message: {
            ...payloadMessage,
            targetIds: payloadMessageTargetIds.filter(
              (memberId) => typeof memberId !== "string" || !isBuiltinSystemMemberId(memberId),
            ),
          },
        };
        eventsChanged = true;
      }
      nextEvents.push(nextPayload === event.payload ? event : { ...event, payload: nextPayload });
    }
    if (eventsChanged) {
      this.events = nextEvents;
      changed = true;
    }

    for (const [roomId, messages] of this.messagesByRoom) {
      if (this.rooms.has(roomId)) continue;
      this.messagesByRoom.delete(roomId);
      for (const message of messages) removedMessageIds.add(message.id);
      changed = true;
    }
    return changed;
  }

  getInit(limit = RECENT_MESSAGE_LIMIT, totalLimit = 500): RoomChannelInit {
    const rooms = this.listRooms();
    const messages: RoomChannelMessage[] = [];
    let messagesTruncated = false;
    for (const [roomIndex, room] of rooms.entries()) {
      const roomMessages = this.listVisibleMessages(room.id, { limit });
      const remaining = Math.max(0, totalLimit - messages.length);
      if (remaining === 0) {
        messagesTruncated = roomMessages.length > 0 || roomIndex < rooms.length - 1;
        break;
      }
      messages.push(...roomMessages.slice(-remaining));
      if (roomMessages.length > remaining) messagesTruncated = true;
      if (messages.length >= totalLimit) {
        messagesTruncated = messagesTruncated || roomIndex < rooms.length - 1;
        break;
      }
    }
    return {
      rooms,
      members: this.listMembers(),
      messages,
      currentEventSeq: this.currentEventSeq,
      deletedMemberIds: this.listDeletedMemberIds(),
      messagesTruncated,
    };
  }

  listRooms(): RoomChannelRoom[] {
    return [...this.rooms.values()]
      .map(cloneRoom)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  listMembers(): RoomChannelMember[] {
    return [...this.members.values()].map(cloneMember);
  }

  listDeletedMemberIds(): string[] {
    return [...this.deletedMemberIds.values()];
  }

  isMemberReferenced(memberId: string): boolean {
    return [...this.rooms.values()].some((room) => room.memberIds.includes(memberId));
  }

  getRoom(roomId: string): RoomChannelRoom | undefined {
    const room = this.rooms.get(roomId);
    return room ? cloneRoom(room) : undefined;
  }

  listMessages(
    roomId: string,
    options: {
      limit?: number;
      beforeSeq?: number;
      afterSeq?: number;
      audience?: "all" | "room";
    } = {},
  ): RoomChannelMessage[] {
    let messages = [...(this.messagesByRoom.get(roomId) ?? [])];
    if (options.audience === "room") {
      messages = messages.filter((message) => message.audience !== "internal");
    }
    if (typeof options.beforeSeq === "number") {
      messages = messages.filter((message) => message.channelSeq < options.beforeSeq!);
    }
    if (typeof options.afterSeq === "number") {
      messages = messages.filter((message) => message.channelSeq > options.afterSeq!);
    }
    const limit = Math.max(0, Math.min(options.limit ?? RECENT_MESSAGE_LIMIT, 500));
    if (limit > 0) {
      messages = messages.slice(-limit);
    }
    return messages.map(cloneMessage);
  }

  listVisibleMessages(
    roomId: string,
    options: { limit?: number; beforeSeq?: number; afterSeq?: number } = {},
  ): RoomChannelMessage[] {
    return this.listMessages(roomId, { ...options, audience: "room" });
  }

  getMessage(roomId: string, messageId: string): RoomChannelMessage | undefined {
    const message = (this.messagesByRoom.get(roomId) ?? []).find((candidate) => candidate.id === messageId);
    return message ? cloneMessage(message) : undefined;
  }

  eventsAfter(
    afterEventSeq: number,
    limit = 200,
  ): {
    events: RoomChannelEvent[];
    currentEventSeq: number;
    oldestAvailableEventSeq: number;
    hasMore: boolean;
    resetRequired: boolean;
  } {
    const normalizedLimit = Math.max(1, Math.min(limit, 1_000));
    const oldestAvailableEventSeq = this.events[0]?.eventSeq ?? this.currentEventSeq + 1;
    const resetRequired = afterEventSeq > this.currentEventSeq || afterEventSeq + 1 < oldestAvailableEventSeq;
    if (resetRequired) {
      return {
        events: [],
        currentEventSeq: this.currentEventSeq,
        oldestAvailableEventSeq,
        hasMore: false,
        resetRequired: true,
      };
    }
    const matches = this.events.filter((event) => event.eventSeq > afterEventSeq);
    const page = matches.slice(0, normalizedLimit);
    return {
      events: page.filter(isClientVisibleRoomEvent).map(cloneEvent),
      currentEventSeq: page[page.length - 1]?.eventSeq ?? this.currentEventSeq,
      oldestAvailableEventSeq,
      hasMore: matches.length > normalizedLimit,
      resetRequired: false,
    };
  }

  waitForEventsAfter(afterEventSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.currentEventSeq !== afterEventSeq) return Promise.resolve();
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (!this.eventWaiters.delete(finish)) return;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.eventWaiters.add(finish);
      timeout = setTimeout(finish, Math.max(0, timeoutMs));
      timeout.unref?.();
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }

  releaseEventWaiters(): void {
    for (const finish of [...this.eventWaiters]) finish();
  }

  createRoom(input: {
    id?: string;
    title?: string;
    scope?: AppRoomScope;
    memberIds?: string[];
    adminMemberIds?: string[];
    badge?: string;
    generatedTitle?: RoomChannelRoom["generatedTitle"];
  }): RoomChannelRoom {
    if (input.id) {
      const existingById = this.rooms.get(input.id.trim());
      if (existingById) {
        if (JSON.stringify(existingById.scope) !== JSON.stringify(input.scope)) throw new Error("room_scope_conflict");
        return cloneRoom(existingById);
      }
    }
    const createdAt = nowIso();
    const roomId = input.id?.trim() || createId("room");
    const activeMemberIds = this.requireActiveGroupMemberReferences(input.memberIds ?? []);
    const defaultedMemberIds = this.withDefaultGroupPm(activeMemberIds, input.scope);
    this.assertAppRoomMembersAllowed(input.scope, defaultedMemberIds);
    const room: RoomChannelRoom = {
      id: roomId,
      kind: "group",
      scope: input.scope,
      title: input.title?.trim() || "new group",
      generatedTitle: input.generatedTitle,
      badge: input.badge?.trim() || "Group",
      memberIds: defaultedMemberIds,
      adminMemberIds: requestedAdminMemberIds(input.adminMemberIds, defaultedMemberIds, this.members),
      pinned: false,
      archived: false,
      lastReadEventSeq: this.currentEventSeq,
      unread: 0,
      updatedAt: createdAt,
    };
    this.rooms.set(room.id, room);
    this.messagesByRoom.set(room.id, []);
    this.emit("room.created", room.id, { room });
    return cloneRoom(room);
  }

  openDirect(input: { memberId: string; title?: string; id?: string; scope?: AppRoomScope }): RoomChannelRoom {
    const memberId = input.memberId.trim();
    if (!memberId) throw new Error("member_id_required");
    if (input.id) {
      const existingById = this.rooms.get(input.id);
      if (existingById) {
        if (JSON.stringify(existingById.scope) !== JSON.stringify(input.scope)) throw new Error("room_scope_conflict");
        return cloneRoom(existingById);
      }
    }
    const existing = [...this.rooms.values()].find(
      (room) => room.kind === "direct" && room.directMemberId === memberId,
    );
    if (existing && !input.id) return cloneRoom(existing);
    const member = this.members.get(memberId);
    if (!member) throw new Error("member_not_found");
    const createdAt = nowIso();
    const room: RoomChannelRoom = {
      id: input.id?.trim() || `direct-${memberId}`,
      kind: "direct",
      scope: input.scope,
      title: input.title?.trim() || member.name,
      badge: "DM",
      memberIds: [memberId],
      adminMemberIds: [],
      directMemberId: memberId,
      pinned: false,
      archived: false,
      lastReadEventSeq: this.currentEventSeq,
      unread: 0,
      updatedAt: createdAt,
    };
    this.rooms.set(room.id, room);
    this.messagesByRoom.set(room.id, []);
    this.emit("room.created", room.id, { room });
    return cloneRoom(room);
  }

  patchRoom(
    roomId: string,
    patch: {
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      badge?: string;
      memberIds?: string[];
      adminMemberIds?: string[];
      removedMemberIds?: string[];
      generatedTitle?: RoomChannelRoom["generatedTitle"] | null;
    },
  ): RoomChannelRoom {
    const room = this.requireRoom(roomId);
    const memberIds =
      patch.memberIds === undefined ? room.memberIds : this.requireActiveGroupMemberReferences(patch.memberIds);
    const adminMemberIds =
      patch.adminMemberIds === undefined
        ? room.adminMemberIds.filter((memberId) => memberIds.includes(memberId))
        : this.requireRoomAdministratorReferences(patch.adminMemberIds, memberIds);
    this.assertAppRoomMembersAllowed(room.scope, memberIds);
    const updated: RoomChannelRoom = {
      ...room,
      title: patch.title === undefined ? room.title : patch.title.trim() || room.title,
      generatedTitle: patch.generatedTitle === undefined ? room.generatedTitle : (patch.generatedTitle ?? undefined),
      pinned: patch.pinned === undefined ? room.pinned : patch.pinned,
      archived: patch.archived === undefined ? room.archived : patch.archived,
      badge: patch.badge === undefined ? room.badge : patch.badge.trim(),
      memberIds,
      adminMemberIds,
      removedMemberIds:
        patch.removedMemberIds === undefined ? room.removedMemberIds : uniqueIds(patch.removedMemberIds),
      updatedAt: nowIso(),
    };
    if (JSON.stringify(updated) === JSON.stringify({ ...room, updatedAt: updated.updatedAt })) {
      return cloneRoom(room);
    }
    this.rooms.set(roomId, updated);
    this.emit("room.updated", roomId, { room: updated });
    return cloneRoom(updated);
  }

  markRoomRead(roomId: string, observedEventSeq: number): RoomChannelRoom {
    const room = this.requireRoom(roomId);
    if (!Number.isSafeInteger(observedEventSeq) || observedEventSeq < 0) {
      throw new Error("room_read_cursor_invalid");
    }
    if (observedEventSeq > this.currentEventSeq) {
      throw new Error("room_read_cursor_ahead");
    }
    const lastReadEventSeq = Math.max(room.lastReadEventSeq ?? 0, observedEventSeq);
    const unread = this.countUnreadMessages(roomId, lastReadEventSeq);
    if (room.lastReadEventSeq === lastReadEventSeq && room.unread === unread) return cloneRoom(room);
    const updated: RoomChannelRoom = {
      ...room,
      lastReadEventSeq,
      unread,
    };
    this.rooms.set(roomId, updated);
    this.emit("room.updated", roomId, { room: updated });
    return cloneRoom(updated);
  }

  upsertMember(member: RoomChannelMember, options: { emitEvent?: boolean } = {}): RoomChannelMember {
    const normalized = normalizeMember(member);
    const existed = this.members.has(normalized.id);
    this.members.set(normalized.id, normalized);
    if (normalized.disabled) {
      this.deletedMemberIds.add(normalized.id);
    } else {
      this.deletedMemberIds.delete(normalized.id);
    }
    if (options.emitEvent) {
      this.emit(
        existed ? "room.member.updated" : "room.member.added",
        "",
        { member: normalized },
        { memberId: normalized.id },
      );
    }
    return cloneMember(normalized);
  }

  patchMember(memberId: string, patch: Partial<Omit<RoomChannelMember, "id">>): RoomChannelMember {
    const existing = this.members.get(memberId);
    if (!existing) throw new Error("member_not_found");
    const updated = normalizeMember({ ...existing, ...patch, id: memberId });
    this.members.set(memberId, updated);
    if (updated.disabled) {
      this.deletedMemberIds.add(memberId);
    } else {
      this.deletedMemberIds.delete(memberId);
    }
    this.emit("room.member.updated", "", { member: updated }, { memberId });
    return cloneMember(updated);
  }

  addMember(roomId: string, member: RoomChannelMember): RoomChannelMember {
    const normalized = normalizeMember(member);
    const room = this.requireRoom(roomId);
    this.assertAppRoomMemberAllowed(room.scope, normalized);
    this.upsertMember(normalized);
    if (!room.memberIds.includes(normalized.id)) {
      const updated = {
        ...room,
        memberIds: [...room.memberIds, normalized.id],
        removedMemberIds: (room.removedMemberIds ?? []).filter((memberId) => memberId !== normalized.id),
        updatedAt: nowIso(),
      };
      this.rooms.set(roomId, updated);
    } else if ((room.removedMemberIds ?? []).includes(normalized.id)) {
      this.rooms.set(roomId, {
        ...room,
        removedMemberIds: (room.removedMemberIds ?? []).filter((memberId) => memberId !== normalized.id),
        updatedAt: nowIso(),
      });
    }
    this.emit("room.member.added", roomId, { member: normalized }, { memberId: normalized.id });
    return normalized;
  }

  removeMember(roomId: string, memberId: string): RoomChannelRoom {
    const room = this.requireRoom(roomId);
    const wasMember = room.memberIds.includes(memberId);
    const updated = {
      ...room,
      memberIds: room.memberIds.filter((id) => id !== memberId),
      adminMemberIds: room.adminMemberIds.filter((id) => id !== memberId),
      removedMemberIds: wasMember ? uniqueIds([...(room.removedMemberIds ?? []), memberId]) : room.removedMemberIds,
      updatedAt: nowIso(),
    };
    this.rooms.set(roomId, updated);
    this.emit("room.member.removed", roomId, { memberId }, { memberId });
    return cloneRoom(updated);
  }

  postUserMessage(input: {
    roomId: string;
    text: string;
    targetIds?: string[];
    attachments?: AgentAttachmentContext[];
    assistantTargets?: RoomChannelMember[];
    userMessageId?: string;
    assistantMessageIds?: string[];
    deliveryKind?: RoomMessageDeliveryKind;
    inReplyToMessageId?: string;
    rootMessageId?: string;
    selectedFile?: RoomChannelMessage["selectedFile"];
  }): PostRoomMessageResult {
    const room = this.requireRoom(input.roomId);
    const targetIds = uniqueIds(input.targetIds ?? []);
    const userMessage = this.createMessage({
      roomId: room.id,
      senderId: "user",
      senderName: "You",
      senderType: "user",
      text: input.text,
      targetIds,
      status: "sent",
      attachments: input.attachments,
      id: input.userMessageId,
      deliveryKind: input.deliveryKind,
      inReplyToMessageId: input.inReplyToMessageId,
      rootMessageId: input.rootMessageId,
      selectedFile: input.selectedFile,
    });
    const assistantMessages = (input.assistantTargets ?? [])
      .filter((target) => target.id && targetIds.includes(target.id))
      .map((target, index) =>
        this.createMessage({
          roomId: room.id,
          senderId: target.id,
          senderName: target.name,
          senderType: "agent",
          text: "",
          targetIds: [],
          status: "running",
          startedAt: nowIso(),
          id: input.assistantMessageIds?.[index],
          inReplyToMessageId: userMessage.id,
          rootMessageId: userMessage.rootMessageId ?? userMessage.id,
        }),
      );
    const updatedRoom = this.touchRoom(room.id);
    return {
      room: updatedRoom,
      userMessage,
      assistantMessages,
      currentEventSeq: this.currentEventSeq,
    };
  }

  postSystemTargetedMessage(input: {
    roomId: string;
    text: string;
    targetIds?: string[];
    assistantTargets?: RoomChannelMember[];
    senderName?: string;
    messageId?: string;
    assistantMessageIds?: string[];
    createdAt?: string;
    audience?: RoomMessageAudience;
    deliveryKind?: RoomMessageDeliveryKind;
    inReplyToMessageId?: string;
    rootMessageId?: string;
    selectedFile?: RoomChannelMessage["selectedFile"];
  }): PostRoomMessageResult {
    const room = this.requireRoom(input.roomId);
    const targetIds = uniqueIds(input.targetIds ?? []);
    const systemMessage = this.createMessage({
      roomId: room.id,
      senderId: "system",
      senderName: input.senderName?.trim() || "System",
      senderType: "system",
      text: input.text,
      targetIds,
      status: "done",
      id: input.messageId,
      createdAt: input.createdAt,
      audience: input.audience,
      deliveryKind: input.deliveryKind,
      inReplyToMessageId: input.inReplyToMessageId,
      rootMessageId: input.rootMessageId,
      selectedFile: input.selectedFile,
    });
    const assistantMessages = (input.assistantTargets ?? [])
      .filter((target) => target.id && targetIds.includes(target.id))
      .map((target, index) =>
        this.createMessage({
          roomId: room.id,
          senderId: target.id,
          senderName: target.name,
          senderType: "agent",
          text: "",
          targetIds: [],
          status: "running",
          startedAt: input.createdAt ?? nowIso(),
          id: input.assistantMessageIds?.[index],
          createdAt: input.createdAt,
          inReplyToMessageId: systemMessage.id,
          rootMessageId: systemMessage.rootMessageId ?? systemMessage.id,
        }),
      );
    const updatedRoom = this.touchRoom(room.id);
    return {
      room: updatedRoom,
      userMessage: systemMessage,
      assistantMessages,
      currentEventSeq: this.currentEventSeq,
    };
  }

  createAssistantPlaceholder(input: {
    roomId: string;
    target: RoomChannelMember;
    id?: string;
    runId?: string;
    createdAt?: string;
    inReplyToMessageId?: string;
    rootMessageId?: string;
  }): RoomChannelMessage {
    return this.createMessage({
      roomId: input.roomId,
      senderId: input.target.id,
      senderName: input.target.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "running",
      id: input.id,
      runId: input.runId,
      startedAt: input.createdAt ?? nowIso(),
      createdAt: input.createdAt,
      inReplyToMessageId: input.inReplyToMessageId,
      rootMessageId: input.rootMessageId,
    });
  }

  postSystemMessage(input: {
    roomId: string;
    text: string;
    id?: string;
    createdAt?: string;
    deliveryKind?: RoomMessageDeliveryKind;
    inReplyToMessageId?: string;
    rootMessageId?: string;
    selectedFile?: RoomChannelMessage["selectedFile"];
  }): RoomChannelMessage {
    return this.createMessage({
      roomId: input.roomId,
      senderId: "system",
      senderName: "System",
      senderType: "system",
      text: input.text,
      targetIds: [],
      status: "done",
      id: input.id,
      createdAt: input.createdAt,
      deliveryKind: input.deliveryKind,
      inReplyToMessageId: input.inReplyToMessageId,
      rootMessageId: input.rootMessageId,
      selectedFile: input.selectedFile,
    });
  }

  postAgentMessage(input: {
    roomId: string;
    senderId: string;
    senderName: string;
    text: string;
    id?: string;
    createdAt?: string;
    status?: RoomMessageStatus;
    targetIds?: string[];
    deliveryKind?: RoomMessageDeliveryKind;
    inReplyToMessageId?: string;
    rootMessageId?: string;
    selectedFile?: RoomChannelMessage["selectedFile"];
  }): RoomChannelMessage {
    return this.createMessage({
      roomId: input.roomId,
      senderId: input.senderId,
      senderName: input.senderName,
      senderType: "agent",
      text: input.text,
      targetIds: input.targetIds ?? [],
      status: input.status ?? "done",
      id: input.id,
      createdAt: input.createdAt,
      deliveryKind: input.deliveryKind,
      inReplyToMessageId: input.inReplyToMessageId,
      rootMessageId: input.rootMessageId,
      selectedFile: input.selectedFile,
    });
  }

  postExternalUserMessage(input: {
    roomId: string;
    senderId: string;
    senderName: string;
    text: string;
    targetIds?: string[];
    attachments?: AgentAttachmentContext[];
    id?: string;
    createdAt?: string;
    deliveryKind?: RoomMessageDeliveryKind;
    inReplyToMessageId?: string;
    rootMessageId?: string;
    selectedFile?: RoomChannelMessage["selectedFile"];
  }): RoomChannelMessage {
    return this.createMessage({
      roomId: input.roomId,
      senderId: input.senderId,
      senderName: input.senderName,
      senderType: "user",
      text: input.text,
      targetIds: input.targetIds ?? [],
      status: "sent",
      attachments: input.attachments,
      id: input.id,
      createdAt: input.createdAt,
      deliveryKind: input.deliveryKind,
      inReplyToMessageId: input.inReplyToMessageId,
      rootMessageId: input.rootMessageId,
      selectedFile: input.selectedFile,
    });
  }

  updateMessage(
    roomId: string,
    messageId: string,
    patch: Partial<Omit<RoomChannelMessage, "id" | "roomId" | "channelSeq" | "createdAt">>,
  ): RoomChannelMessage {
    const bucket = this.messagesByRoom.get(roomId);
    if (!bucket) throw new Error("room_not_found");
    const index = bucket.findIndex((message) => message.id === messageId);
    if (index < 0) throw new Error("message_not_found");
    const existing = bucket[index]!;
    const candidate: RoomChannelMessage = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    const updated: RoomChannelMessage = {
      ...candidate,
      notificationEventSeq:
        existing.notificationEventSeq ??
        (isUnreadNotificationMessage(candidate) ? this.currentEventSeq + 1 : undefined),
    };
    bucket[index] = updated;
    this.touchRoom(roomId);
    this.emitMessageUpdated(existing, updated);
    this.refreshRoomUnread(roomId);
    return cloneMessage(updated);
  }

  deleteMessage(roomId: string, messageId: string): RoomChannelMessage {
    const bucket = this.messagesByRoom.get(roomId);
    if (!bucket) throw new Error("room_not_found");
    const index = bucket.findIndex((message) => message.id === messageId);
    if (index < 0) throw new Error("message_not_found");
    const [removed] = bucket.splice(index, 1);
    this.messagesByRoom.set(roomId, bucket);
    this.touchRoom(roomId);
    this.emit("room.message.deleted", roomId, { messageId, audience: removed!.audience }, { messageId });
    this.refreshRoomUnread(roomId);
    return cloneMessage(removed!);
  }

  upsertProjectedMessage(input: RoomChannelMessage): { message: RoomChannelMessage; changed: boolean } {
    const room = this.requireRoom(input.roomId);
    const bucket = this.messagesByRoom.get(room.id) ?? [];
    const existingIndex = bucket.findIndex((message) => message.id === input.id);
    const projectedCandidate: RoomChannelMessage = {
      ...input,
      channelSeq: Number.isFinite(input.channelSeq) && input.channelSeq > 0 ? input.channelSeq : nextChannelSeq(bucket),
      targetIds: uniqueIds(input.targetIds ?? []),
      updatedAt: input.updatedAt || input.createdAt || nowIso(),
    };
    const existing = existingIndex >= 0 ? bucket[existingIndex] : undefined;
    const projected: RoomChannelMessage = {
      ...projectedCandidate,
      notificationEventSeq:
        existing?.notificationEventSeq ??
        (isUnreadNotificationMessage(projectedCandidate) ? this.currentEventSeq + 1 : undefined),
    };
    if (existingIndex >= 0) {
      const previous = existing!;
      if (sameProjectedMessage(previous, projected)) {
        return { message: cloneMessage(previous), changed: false };
      }
      bucket[existingIndex] = projected;
      this.messagesByRoom.set(
        room.id,
        bucket.sort((left, right) => left.channelSeq - right.channelSeq),
      );
      this.touchRoom(room.id);
      this.emitMessageUpdated(previous, projected);
      this.refreshRoomUnread(room.id);
      return { message: cloneMessage(projected), changed: true };
    }
    bucket.push(projected);
    this.messagesByRoom.set(
      room.id,
      bucket.sort((left, right) => left.channelSeq - right.channelSeq),
    );
    this.touchRoom(room.id);
    this.emit("room.message.created", room.id, { message: projected }, { messageId: projected.id });
    this.refreshRoomUnread(room.id);
    return { message: cloneMessage(projected), changed: true };
  }

  private createMessage(
    input: Omit<RoomChannelMessage, "id" | "channelSeq" | "createdAt" | "updatedAt"> & {
      id?: string;
      createdAt?: string;
    },
  ): RoomChannelMessage {
    const room = this.requireRoom(input.roomId);
    const bucket = this.messagesByRoom.get(room.id) ?? [];
    const createdAt = input.createdAt ?? nowIso();
    const candidate: RoomChannelMessage = {
      ...input,
      id: input.id ?? createId("msg"),
      channelSeq: nextChannelSeq(bucket),
      createdAt,
      updatedAt: createdAt,
      targetIds: uniqueIds(input.targetIds ?? []),
    };
    const message: RoomChannelMessage = {
      ...candidate,
      notificationEventSeq: isUnreadNotificationMessage(candidate) ? this.currentEventSeq + 1 : undefined,
    };
    bucket.push(message);
    this.messagesByRoom.set(room.id, bucket);
    this.emit("room.message.created", room.id, { message }, { messageId: message.id });
    this.refreshRoomUnread(room.id);
    return cloneMessage(message);
  }

  private repairRestoredUnreadState(): boolean {
    let changed = false;
    for (const [roomId, room] of this.rooms) {
      // Existing releases never produced real unread state. Treat their history
      // as read at migration time instead of surfacing every old message.
      if (room.lastReadEventSeq === undefined) {
        this.rooms.set(roomId, { ...room, lastReadEventSeq: this.currentEventSeq, unread: 0 });
        changed = true;
        continue;
      }
      const unread = this.countUnreadMessages(roomId, room.lastReadEventSeq);
      if (unread === room.unread) continue;
      this.rooms.set(roomId, { ...room, unread });
      changed = true;
    }
    return changed;
  }

  private refreshRoomUnread(roomId: string): RoomChannelRoom {
    const room = this.requireRoom(roomId);
    const lastReadEventSeq = room.lastReadEventSeq ?? this.currentEventSeq;
    const unread = this.countUnreadMessages(roomId, lastReadEventSeq);
    if (unread === room.unread && room.lastReadEventSeq !== undefined) return cloneRoom(room);
    const updated: RoomChannelRoom = { ...room, lastReadEventSeq, unread };
    this.rooms.set(roomId, updated);
    this.emit("room.updated", roomId, { room: updated });
    return cloneRoom(updated);
  }

  private countUnreadMessages(roomId: string, lastReadEventSeq: number): number {
    return (this.messagesByRoom.get(roomId) ?? []).reduce(
      (count, message) =>
        message.notificationEventSeq !== undefined && message.notificationEventSeq > lastReadEventSeq
          ? count + 1
          : count,
      0,
    );
  }

  private touchRoom(roomId: string): RoomChannelRoom {
    const room = this.requireRoom(roomId);
    const updated = { ...room, updatedAt: nowIso() };
    this.rooms.set(roomId, updated);
    return cloneRoom(updated);
  }

  private requireRoom(roomId: string): RoomChannelRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("room_not_found");
    return room;
  }

  private isActiveGroupMemberReference(memberId: string): boolean {
    if (isBuiltinSystemMemberId(memberId)) return false;
    const member = this.members.get(memberId);
    return Boolean(member && !member.disabled);
  }

  private emit(
    type: RoomChannelEventType,
    roomId: string,
    payload: Record<string, unknown>,
    refs: { messageId?: string; memberId?: string } = {},
    schemaVersion: 1 | 2 = 1,
  ): RoomChannelEvent {
    const event: RoomChannelEvent = {
      schemaVersion,
      eventSeq: this.currentEventSeq + 1,
      type,
      roomId,
      messageId: refs.messageId,
      memberId: refs.memberId,
      createdAt: nowIso(),
      payload,
    };
    this.currentEventSeq = event.eventSeq;
    this.events.push(event);
    if (this.events.length > EVENT_RETENTION_LIMIT) {
      this.events = this.events.slice(-EVENT_RETENTION_LIMIT);
    }
    if (isClientVisibleRoomEvent(event)) {
      for (const finish of [...this.eventWaiters]) finish();
    }
    return event;
  }

  private emitMessageUpdated(previous: RoomChannelMessage, updated: RoomChannelMessage): RoomChannelEvent {
    return this.emit(
      "room.message.updated",
      updated.roomId,
      {
        audience: updated.audience,
        messagePatch: createRoomMessagePatch(previous, updated),
      },
      { messageId: updated.id },
      2,
    );
  }

  private requireActiveGroupMemberReferences(memberIds: string[]): string[] {
    const normalized = uniqueIds(memberIds);
    const invalidMemberId = normalized.find((memberId) => !this.isActiveGroupMemberReference(memberId));
    if (invalidMemberId) throw new Error(`room_member_reference_invalid:${invalidMemberId}`);
    return normalized;
  }

  private requireRoomAdministratorReferences(adminMemberIds: string[], memberIds: string[]): string[] {
    const normalized = uniqueIds(adminMemberIds);
    const memberIdSet = new Set(memberIds);
    const invalidMemberId = normalized.find((memberId) => !memberIdSet.has(memberId));
    if (invalidMemberId) throw new Error(`room_administrator_not_member:${invalidMemberId}`);
    return normalized;
  }

  private activeAppPm(scope: AppRoomScope | undefined): RoomChannelMember | undefined {
    if (!scope) return undefined;
    const active = [...this.members.values()].filter(
      (member) => member.appId === scope.appId && !member.disabled && isRoomPmMember(member),
    );
    return active.find((member) => member.id === pmAgentMemberId(scope.appId)) ?? active[0];
  }

  private assertAppRoomMemberAllowed(scope: AppRoomScope | undefined, member: RoomChannelMember): void {
    if (!scope) return;
    if (isRoomPmMember(member)) {
      const activePm = this.activeAppPm(scope);
      if (member.appId !== scope.appId || (activePm && member.id !== activePm.id)) {
        throw new Error("app_room_pm_scope_mismatch");
      }
    }
    if (member.appId && member.appId !== scope.appId) throw new Error("cross_app_member_forbidden");
  }

  private assertAppRoomMembersAllowed(scope: AppRoomScope | undefined, memberIds: string[]): void {
    if (!scope) return;
    for (const memberId of memberIds) {
      const member = this.members.get(memberId);
      if (member) this.assertAppRoomMemberAllowed(scope, member);
    }
  }

  private withDefaultGroupPm(memberIds: string[], scope?: AppRoomScope): string[] {
    if (
      memberIds.some((memberId) => {
        const member = this.members.get(memberId);
        return member ? isRoomPmMember(member) : false;
      })
    ) {
      return memberIds;
    }
    // App Rooms own a stable App-scoped PM projection. A missing projection is
    // repaired after mounted-App seed sync; inserting the global PM here would
    // create a second identity that survives uninstall/reinstall cycles.
    if (scope) return memberIds;
    const globalPm = this.members.get(OPENGROVE_PM_MEMBER_ID);
    if (!globalPm || globalPm.disabled || !isRoomPmMember(globalPm)) return memberIds;
    return [...memberIds, globalPm.id];
  }
}

function requestedAdminMemberIds(
  requested: string[] | undefined,
  memberIds: string[],
  membersById: ReadonlyMap<string, RoomChannelMember>,
): string[] {
  const memberIdSet = new Set(memberIds);
  if (requested !== undefined) {
    return uniqueIds(requested).filter((memberId) => memberIdSet.has(memberId));
  }
  return memberIds.filter((memberId) => {
    const member = membersById.get(memberId);
    return member ? isRoomPmMember(member) : false;
  });
}

function createRoomMessagePatch(
  previous: RoomChannelMessage,
  updated: RoomChannelMessage,
): { set: Record<string, unknown>; unset?: string[] } {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const immutable = new Set(["id", "roomId", "channelSeq", "createdAt"]);
  const keys = new Set([...Object.keys(previous), ...Object.keys(updated)]);
  for (const key of keys) {
    if (immutable.has(key)) continue;
    const before = (previous as unknown as Record<string, unknown>)[key];
    const after = (updated as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (after === undefined) unset.push(key);
    else set[key] = after;
  }
  return { set, ...(unset.length ? { unset } : {}) };
}

function isClientVisibleRoomEvent(event: RoomChannelEvent): boolean {
  return event.payload.audience !== "internal" && objectRecord(event.payload.message)?.audience !== "internal";
}

function sameProjectedMessage(left: RoomChannelMessage, right: RoomChannelMessage): boolean {
  return (
    left.channelSeq === right.channelSeq &&
    left.senderId === right.senderId &&
    left.senderName === right.senderName &&
    left.senderType === right.senderType &&
    left.text === right.text &&
    left.status === right.status &&
    left.runId === right.runId &&
    left.createdAt === right.createdAt &&
    left.startedAt === right.startedAt &&
    left.finishedAt === right.finishedAt &&
    left.duration === right.duration &&
    left.audience === right.audience &&
    left.deliveryKind === right.deliveryKind &&
    left.inReplyToMessageId === right.inReplyToMessageId &&
    left.rootMessageId === right.rootMessageId &&
    JSON.stringify(left.targetIds ?? []) === JSON.stringify(right.targetIds ?? []) &&
    JSON.stringify(left.selectedFile ?? {}) === JSON.stringify(right.selectedFile ?? {})
  );
}

function isUnreadNotificationMessage(message: RoomChannelMessage): boolean {
  if (message.audience === "internal" || message.senderId === "user") return false;
  return Boolean(
    message.text.trim() ||
      message.attachments?.length ||
      message.parts?.length ||
      message.selectedFile ||
      message.status === "failed" ||
      message.status === "interrupted",
  );
}
