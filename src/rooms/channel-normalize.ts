import type {
  RoomChannelEvent,
  RoomChannelEventType,
  RoomChannelMember,
  RoomChannelMessage,
  RoomChannelRoom,
  RoomChannelSnapshot,
  RoomMemberManifestDefaults,
  RoomMemberVisibility,
  RoomMemberSource,
  RoomMemberStatus,
  RoomMessageStatus,
  RoomMessageDeliveryKind,
} from "./channel-store.js";
import { normalizedRoomMemberAvatarDataUrl } from "./avatar-data-url.js";
import { normalizeModelForKernelDisplay } from "../server/kernel-registry.js";
import { normalizeRequiredKernelCapabilities } from "../kernel/capabilities/requirements.js";

const GROVE_ROOM_ID = "room-open-group";

export function normalizeRoomChannelSnapshot(input: unknown): RoomChannelSnapshot {
  const object =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Partial<RoomChannelSnapshot>) : {};
  const members = Array.isArray(object.members) ? object.members.map(normalizeMember).filter(isDefined) : [];
  const rooms = Array.isArray(object.rooms) ? object.rooms.map(normalizeRoom).filter(isDefined) : [];
  const roomIds = new Set(rooms.map((room) => room.id));
  const messages = Array.isArray(object.messages)
    ? object.messages
        .map(normalizeMessage)
        .filter((message): message is RoomChannelMessage => Boolean(message && roomIds.has(message.roomId)))
    : [];
  const events = Array.isArray(object.events) ? object.events.map(normalizeEvent).filter(isDefined) : [];
  const maxEventSeq = events.reduce((max, event) => Math.max(max, event.eventSeq), 0);
  const requestedEventSeq = typeof object.currentEventSeq === "number" ? object.currentEventSeq : 0;
  return {
    version: 1,
    currentEventSeq: Math.max(requestedEventSeq, maxEventSeq),
    rooms,
    members,
    messages,
    events,
    deletedMemberIds: uniqueIds(Array.isArray(object.deletedMemberIds) ? object.deletedMemberIds : []),
  };
}

function normalizeRoom(input: Partial<RoomChannelRoom>): RoomChannelRoom | undefined {
  const id = readString(input.id);
  if (!id) return undefined;
  const memberIds = uniqueIds(Array.isArray(input.memberIds) ? input.memberIds : []);
  const adminMemberIds = Array.isArray(input.adminMemberIds)
    ? uniqueIds(input.adminMemberIds).filter((memberId) => memberIds.includes(memberId))
    : [];
  return {
    id,
    kind: input.kind === "direct" ? "direct" : "group",
    scope: normalizeRoomScope(input.scope),
    title: readString(input.title) || "room",
    generatedTitle: normalizeGeneratedRoomTitle(input.generatedTitle),
    badge: readString(input.badge),
    memberIds,
    adminMemberIds,
    removedMemberIds: uniqueIds(Array.isArray(input.removedMemberIds) ? input.removedMemberIds : []),
    directMemberId: readOptionalString(input.directMemberId),
    pinned: Boolean(input.pinned),
    archived: Boolean(input.archived),
    updatedAt: readString(input.updatedAt) || nowIso(),
    lastReadEventSeq: readNonNegativeInt(input.lastReadEventSeq),
    unread: Number.isFinite(input.unread) ? Number(input.unread) : 0,
  };
}

export function normalizeMember(input: Partial<RoomChannelMember>): RoomChannelMember {
  const id = readString(input.id) || createId("member");
  const kernel = readString(input.kernel) || id;
  return {
    id,
    employeeDefinitionId: readOptionalString(input.employeeDefinitionId),
    name: readString(input.name) || id,
    displayName: readOptionalString(input.displayName),
    kernel,
    model: normalizeModelForKernelDisplay(kernel, readString(input.model)),
    providerId: readOptionalString(input.providerId),
    role: readString(input.role),
    displayRole: readOptionalString(input.displayRole),
    status: normalizeMemberStatus(input.status),
    color: readString(input.color) || "#64748b",
    lastActive: readString(input.lastActive) || "idle",
    availableSkillIds: readStringArray(input.availableSkillIds),
    defaultSkillIds: readStringArray(input.defaultSkillIds),
    appId: readOptionalString(input.appId),
    workspaceRoot: readOptionalString(input.workspaceRoot),
    storePackageId: readOptionalString(input.storePackageId),
    toolIds: readStringArray(input.toolIds),
    requiredKernelCapabilities: normalizeRequiredKernelCapabilities(input.requiredKernelCapabilities),
    accessMode: normalizeMemberAccessMode(input.accessMode),
    reasoningEffort: normalizeMemberReasoningEffort(input.reasoningEffort),
    contextTokenBudget: normalizeContextTokenBudget(input.contextTokenBudget),
    avatarMode: normalizeMemberAvatarMode(input.avatarMode),
    avatarSeed: readOptionalString(input.avatarSeed),
    avatarDataUrl: normalizedRoomMemberAvatarDataUrl(input.avatarDataUrl),
    source: normalizeMemberSource(input.source),
    sourceLabel: normalizeSourceLabel(input.sourceLabel, input.source),
    visibility: normalizeVisibility(input.visibility),
    publicDescription: readOptionalString(input.publicDescription),
    displayPublicDescription: readOptionalString(input.displayPublicDescription),
    publicSkills: readStringArray(input.publicSkills),
    displayPublicSkills: readStringArray(input.displayPublicSkills),
    inputSpec: readOptionalString(input.inputSpec),
    displayInputSpec: readOptionalString(input.displayInputSpec),
    outputSpec: readOptionalString(input.outputSpec),
    displayOutputSpec: readOptionalString(input.displayOutputSpec),
    userOverrides: readStringArray(input.userOverrides),
    manifestDefaults: normalizeManifestDefaults(input.manifestDefaults),
    disabled: Boolean(input.disabled),
  };
}

function normalizeManifestDefaults(value: unknown): RoomMemberManifestDefaults | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<RoomMemberManifestDefaults>;
  const defaults: RoomMemberManifestDefaults = {
    name: readOptionalString(input.name),
    avatarMode: normalizeMemberAvatarMode(input.avatarMode),
    avatarSeed: readOptionalString(input.avatarSeed),
    avatarDataUrl: normalizedRoomMemberAvatarDataUrl(input.avatarDataUrl),
    role: readOptionalString(input.role),
    kernel: readOptionalString(input.kernel),
    model: readOptionalString(input.model),
    color: readOptionalString(input.color),
    availableSkillIds: readStringArray(input.availableSkillIds),
    defaultSkillIds: readStringArray(input.defaultSkillIds),
    requiredKernelCapabilities: normalizeRequiredKernelCapabilities(input.requiredKernelCapabilities),
    reasoningEffort: normalizeMemberReasoningEffort(input.reasoningEffort),
    contextTokenBudget: normalizeContextTokenBudget(input.contextTokenBudget),
    accessMode: normalizeMemberAccessMode(input.accessMode),
    visibility: normalizeVisibility(input.visibility),
    publicDescription: readOptionalString(input.publicDescription),
    publicSkills: readStringArray(input.publicSkills),
    inputSpec: readOptionalString(input.inputSpec),
    outputSpec: readOptionalString(input.outputSpec),
  };
  return Object.values(defaults).some((field) => field !== undefined) ? defaults : undefined;
}

function normalizeContextTokenBudget(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function normalizeMemberAccessMode(value: unknown): RoomChannelMember["accessMode"] {
  return value === "default" || value === "auto-review" || value === "full-access" ? value : undefined;
}

function normalizeMemberReasoningEffort(value: unknown): RoomChannelMember["reasoningEffort"] {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

function normalizeMemberAvatarMode(value: unknown): RoomChannelMember["avatarMode"] {
  return value === "generated" || value === "initials" || value === "upload" ? value : undefined;
}

function normalizeMessage(input: Partial<RoomChannelMessage>): RoomChannelMessage | undefined {
  const id = readString(input.id);
  const roomId = readString(input.roomId);
  if (!id || !roomId) return undefined;
  const createdAt = readString(input.createdAt) || nowIso();
  return {
    id,
    roomId,
    channelSeq: Number.isFinite(input.channelSeq) ? Number(input.channelSeq) : 0,
    senderId: readString(input.senderId) || "system",
    senderName: readString(input.senderName) || "System",
    senderType: input.senderType === "agent" || input.senderType === "user" ? input.senderType : "system",
    text: stripModelTemplateTokens(readString(input.text)),
    targetIds: uniqueIds(Array.isArray(input.targetIds) ? input.targetIds : []),
    status: normalizeMessageStatus(input.status),
    createdAt,
    updatedAt: readString(input.updatedAt) || createdAt,
    attachments: Array.isArray(input.attachments) ? input.attachments : undefined,
    duration: readOptionalString(input.duration),
    runId: readOptionalString(input.runId),
    parts: Array.isArray(input.parts) ? input.parts : undefined,
    startedAt: readOptionalString(input.startedAt),
    finishedAt: readOptionalString(input.finishedAt),
    audience: normalizeMessageAudience(input),
    deliveryKind: normalizeRoomMessageDeliveryKind(input.deliveryKind),
    inReplyToMessageId: readOptionalString(input.inReplyToMessageId),
    rootMessageId: readOptionalString(input.rootMessageId),
    selectedFile: normalizeRoomSelectedFile(input.selectedFile),
    notificationEventSeq: readPositiveInt(input.notificationEventSeq),
  };
}

function normalizeEvent(input: Partial<RoomChannelEvent>): RoomChannelEvent | undefined {
  const eventSeq = Number(input.eventSeq);
  const type = readString(input.type);
  const roomId = readString(input.roomId);
  if (!Number.isFinite(eventSeq) || eventSeq <= 0 || !isEventType(type)) return undefined;
  const payload =
    input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? { ...(input.payload as Record<string, unknown>) }
      : {};
  return {
    schemaVersion: input.schemaVersion === 2 ? 2 : 1,
    eventSeq,
    type,
    roomId,
    messageId: readOptionalString(input.messageId),
    memberId: readOptionalString(input.memberId),
    createdAt: readString(input.createdAt) || nowIso(),
    payload,
  };
}

function normalizeMessageAudience(input: Partial<RoomChannelMessage>): RoomChannelMessage["audience"] {
  if (input.audience === "internal" || input.audience === "room") return input.audience;
  return undefined;
}

export function cloneRoom(room: RoomChannelRoom): RoomChannelRoom {
  return {
    ...room,
    scope: room.scope ? { ...room.scope } : undefined,
    generatedTitle: room.generatedTitle ? { ...room.generatedTitle } : undefined,
    memberIds: [...room.memberIds],
    adminMemberIds: [...room.adminMemberIds],
    removedMemberIds: room.removedMemberIds ? [...room.removedMemberIds] : undefined,
  };
}

function normalizeRoomScope(value: unknown): RoomChannelRoom["scope"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const appId = readString(input.appId);
  const role = input.role === "default" || input.role === "group" || input.role === "direct" ? input.role : undefined;
  return input.kind === "app" && appId ? { kind: "app", appId, ...(role ? { role } : {}) } : undefined;
}

function normalizeGeneratedRoomTitle(value: unknown): RoomChannelRoom["generatedTitle"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const sequence =
    typeof input.sequence === "number" && Number.isInteger(input.sequence) && input.sequence > 0 ? input.sequence : 0;
  if (input.kind === "numbered-group" && sequence) {
    return { kind: "numbered-group", sequence };
  }
  const appId = readString(input.appId);
  return input.kind === "app-group" && appId && sequence ? { kind: "app-group", appId, sequence } : undefined;
}

export function cloneMember(member: RoomChannelMember): RoomChannelMember {
  return {
    ...member,
    availableSkillIds: member.availableSkillIds ? [...member.availableSkillIds] : undefined,
    defaultSkillIds: member.defaultSkillIds ? [...member.defaultSkillIds] : undefined,
    toolIds: member.toolIds ? [...member.toolIds] : undefined,
    requiredKernelCapabilities: member.requiredKernelCapabilities ? [...member.requiredKernelCapabilities] : undefined,
    publicSkills: member.publicSkills ? [...member.publicSkills] : undefined,
    userOverrides: member.userOverrides ? [...member.userOverrides] : undefined,
    manifestDefaults: member.manifestDefaults
      ? {
          ...member.manifestDefaults,
          publicSkills: member.manifestDefaults.publicSkills ? [...member.manifestDefaults.publicSkills] : undefined,
          availableSkillIds: member.manifestDefaults.availableSkillIds
            ? [...member.manifestDefaults.availableSkillIds]
            : undefined,
          defaultSkillIds: member.manifestDefaults.defaultSkillIds
            ? [...member.manifestDefaults.defaultSkillIds]
            : undefined,
          requiredKernelCapabilities: member.manifestDefaults.requiredKernelCapabilities
            ? [...member.manifestDefaults.requiredKernelCapabilities]
            : undefined,
        }
      : undefined,
  };
}

export function cloneMessage(message: RoomChannelMessage): RoomChannelMessage {
  return {
    ...message,
    targetIds: [...message.targetIds],
    attachments: message.attachments ? [...message.attachments] : undefined,
    parts: message.parts ? [...message.parts] : undefined,
    selectedFile: message.selectedFile ? { ...message.selectedFile } : undefined,
  };
}

export function cloneEvent(event: RoomChannelEvent): RoomChannelEvent {
  return { ...event, payload: { ...event.payload } };
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function nextChannelSeq(messages: RoomChannelMessage[]): number {
  return messages.reduce((max, message) => Math.max(max, message.channelSeq), 0) + 1;
}

export function dedupeMembersById(members: RoomChannelMember[]): RoomChannelMember[] {
  const seen = new Set<string>();
  const output: RoomChannelMember[] = [];
  for (const member of members) {
    if (!member.id || seen.has(member.id)) continue;
    output.push(member);
    seen.add(member.id);
  }
  return output;
}

export function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text || undefined;
}

function readNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = [...new Set(value.map((item) => readString(item)).filter(Boolean))];
  return values.length ? values : undefined;
}

export function normalizeRoomMessageDeliveryKind(value: unknown): RoomMessageDeliveryKind | undefined {
  return value === "user_direct" ||
    value === "user_broadcast" ||
    value === "pm_auto_route" ||
    value === "agent_delegation" ||
    value === "system_routine"
    ? value
    : undefined;
}

export function normalizeRoomSelectedFile(value: unknown): RoomChannelMessage["selectedFile"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const path = readOptionalString((value as { path?: unknown }).path);
  return path ? { path } : undefined;
}

function stripModelTemplateTokens(value: string): string {
  return value.replace(/<\|(?:assistant|user|system|observation|tool|end|endoftext)\|>/g, "").trimEnd();
}

function normalizeMemberStatus(value: unknown): RoomMemberStatus {
  return value === "running" || value === "done" || value === "waiting" || value === "offline" ? value : "idle";
}

function normalizeMemberSource(value: unknown): RoomMemberSource | undefined {
  return value === "human" || value === "local" ? value : undefined;
}

function normalizeSourceLabel(value: unknown, source: unknown): string | undefined {
  const label = readOptionalString(value);
  if (label === "local") return "本机";
  if (label === "human") return "人类";
  if (label) return label;
  const normalizedSource = normalizeMemberSource(source);
  if (normalizedSource === "local") return "本机";
  if (normalizedSource === "human") return "人类";
  return undefined;
}

function normalizeVisibility(value: unknown): RoomMemberVisibility | undefined {
  return value === "public" || value === "private" ? value : undefined;
}

function normalizeMessageStatus(value: unknown): RoomMessageStatus {
  return value === "running" || value === "done" || value === "failed" || value === "interrupted" ? value : "sent";
}

export function isGroveRoomId(roomId: string): boolean {
  return roomId === GROVE_ROOM_ID || roomId.endsWith(`:${GROVE_ROOM_ID}`);
}

// forwarding-boundary: gives the persisted event-name whitelist a type-predicate seam.
function isEventType(value: string): value is RoomChannelEventType {
  return [
    "room.created",
    "room.updated",
    "room.member.added",
    "room.member.updated",
    "room.member.removed",
    "room.message.created",
    "room.message.updated",
    "room.message.deleted",
  ].includes(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
