import type { AttachmentPayload, KernelOption, MessagePart, ModelId, ReasoningEffort } from "../../bridge";
import { DEFAULT_MODEL_ID } from "../../bridge";
import { translate, type TranslationFn } from "../../i18n";
import type {
  RoomMemberSource,
  RoomMessageDeliveryKind,
  RoomMessageSenderType,
} from "../../../../src/rooms/channel-types";
import { isRoomPmMember, OPENGROVE_PM_MEMBER_ID } from "../../../../src/rooms/room-pm";

export type {
  RoomMemberSource,
  RoomMessageDeliveryKind,
  RoomMessageSenderType,
} from "../../../../src/rooms/channel-types";

export type MemberStatus = "idle" | "running" | "done" | "waiting" | "offline";
export type MessageStatus = "sent" | "running" | "done" | "failed" | "interrupted";
export type RoomMemberVisibility = "private" | "public";
export type RoomMemberAccessMode = "default" | "auto-review" | "full-access";
export type RoomMemberAvatarMode = "generated" | "initials" | "upload";

export const APP_BUILDER_EMPLOYEE_DEFINITION_ID = "app-builder";
export const PM_EMPLOYEE_DEFINITION_ID = OPENGROVE_PM_MEMBER_ID;
export { isRoomPmMember };
export type RoomMember = {
  id: string;
  employeeDefinitionId?: string;
  name: string;
  displayName?: string;
  kernel: string;
  model: string;
  providerId?: string;
  role: string;
  displayRole?: string;
  status: MemberStatus;
  color: string;
  lastActive: string;
  availableSkillIds?: string[];
  defaultSkillIds?: string[];
  appId?: string;
  workspaceRoot?: string;
  storePackageId?: string;
  toolIds?: string[];
  accessMode?: RoomMemberAccessMode;
  reasoningEffort?: ReasoningEffort;
  contextTokenBudget?: number;
  avatarMode?: RoomMemberAvatarMode;
  avatarSeed?: string;
  avatarDataUrl?: string;
  source?: RoomMemberSource;
  sourceLabel?: string;
  visibility?: RoomMemberVisibility;
  publicDescription?: string;
  displayPublicDescription?: string;
  publicSkills?: string[];
  displayPublicSkills?: string[];
  inputSpec?: string;
  displayInputSpec?: string;
  outputSpec?: string;
  displayOutputSpec?: string;
  userOverrides?: string[];
  manifestDefaults?: RoomMemberManifestDefaults;
  disabled?: boolean;
};

export type RoomMemberManifestDefaults = {
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
  reasoningEffort?: ReasoningEffort;
  contextTokenBudget?: number;
  accessMode?: RoomMemberAccessMode;
  visibility?: RoomMemberVisibility;
  publicDescription?: string;
  publicSkills?: string[];
  inputSpec?: string;
  outputSpec?: string;
};

export type RoomMessage = {
  id: string;
  senderId: string;
  senderName: string;
  senderType: RoomMessageSenderType;
  text: string;
  targetIds: string[];
  status: MessageStatus;
  createdAt: string;
  attachments?: AttachmentPayload[];
  duration?: string;
  runId?: string;
  parts?: MessagePart[];
  startedAt?: string;
  finishedAt?: string;
  deliveryKind?: RoomMessageDeliveryKind;
  inReplyToMessageId?: string;
  rootMessageId?: string;
  selectedFile?: {
    path: string;
  };
};

export type RoomReplyPreview = {
  senderName?: string;
  text: string;
};

export type AppRoomScope = {
  kind: "app";
  appId: string;
  role?: "default" | "group" | "direct";
};

export type Room = {
  id: string;
  kind: "group" | "direct";
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
  adminMemberIds: string[];
  directMemberId?: string;
  pinned?: boolean;
  archived?: boolean;
  messages: RoomMessage[];
  updatedAt: string;
  unread: number;
};

export type RoomsState = {
  rooms: Room[];
  members: RoomMember[];
  activeRoomId: string;
  deletedMemberIds?: string[];
};

export const GROVE_GUIDE_MEMBER_ID = "grove-guide";

// 员工级权限档位：OpenGrove 语义档位，由各 kernel 适配器翻译成原生权限模式。
// 通讯录面板与 App 工作区共用同一份定义，避免组件间互相 import。
export const MEMBER_ACCESS_PRESETS: Array<{
  id: RoomMemberAccessMode;
  label: string;
  description: string;
  danger?: boolean;
}> = [
  {
    id: "default",
    get label() {
      return translate("composer.defaultAccess");
    },
    get description() {
      return translate("rooms.accessDefaultDescription");
    },
  },
  {
    id: "auto-review",
    get label() {
      return translate("composer.autoReview");
    },
    get description() {
      return translate("composer.autoReviewDescription");
    },
  },
  {
    id: "full-access",
    get label() {
      return translate("rooms.accessFullLabel");
    },
    get description() {
      return translate("rooms.accessFullDescription");
    },
    danger: true,
  },
];

export const MEMBER_PRESETS: RoomMember[] = [
  {
    id: defaultMemberIdForKernel("codex"),
    name: "Codex",
    kernel: "codex",
    model: "codex-default",
    role: "",
    status: "idle",
    color: "#2563eb",
    get lastActive() {
      return translate("ops.justNow");
    },
  },
  {
    id: defaultMemberIdForKernel("claude-code"),
    name: "Claude Agent",
    kernel: "claude-code",
    model: "claude-code-default",
    role: "",
    status: "idle",
    color: "#f59e0b",
    get lastActive() {
      return translate("ops.minutesAgo", { minutes: 5 });
    },
  },
  {
    id: defaultMemberIdForKernel("aide"),
    name: "Aide",
    kernel: "browser",
    model: "ui-review",
    role: "",
    status: "idle",
    color: "#ef4444",
    get lastActive() {
      return translate("ops.minutesAgo", { minutes: 20 });
    },
  },
];

export const KERNEL_COLORS: Record<string, string> = {
  codex: "#2563eb",
  "claude-code": "#f59e0b",
  hermes: "#7c3aed",
  pi: "#0f766e",
  openclaw: "#ef4444",
  opencode: "#111827",
  kimi: "#00a5ff",
};

const EMPLOYEE_PROFILE_FIELDS = [
  "name",
  "avatarMode",
  "avatarSeed",
  "avatarDataUrl",
  "kernel",
  "model",
  "providerId",
  "reasoningEffort",
  "contextTokenBudget",
  "accessMode",
  "role",
  "visibility",
  "publicDescription",
  "publicSkills",
  "inputSpec",
  "outputSpec",
  "availableSkillIds",
  "defaultSkillIds",
  "toolIds",
] as const satisfies ReadonlyArray<keyof RoomMember>;

export function employeeProfilePatch(previous: RoomMember, next: RoomMember): Partial<RoomMember> {
  const patch: Partial<RoomMember> = {};
  for (const field of EMPLOYEE_PROFILE_FIELDS) {
    if (JSON.stringify(previous[field]) === JSON.stringify(next[field])) continue;
    (patch as Record<string, unknown>)[field] = next[field];
  }
  return patch;
}

export const ROOM_OWNER_MEMBER: RoomMember = {
  id: "room-owner",
  get name() {
    return translate("mountedApp.selfSenderName");
  },
  kernel: "user",
  get model() {
    return translate("rooms.sourceLocal");
  },
  get role() {
    return translate("rooms.ownerRole");
  },
  status: "idle",
  color: "#64748b",
  get lastActive() {
    return translate("common.current");
  },
  source: "human",
  get sourceLabel() {
    return translate("rooms.sourceHuman");
  },
};

const KERNEL_MEMBER_FALLBACKS: Record<string, Partial<RoomMember>> = Object.fromEntries(
  MEMBER_PRESETS.map((member) => [member.kernel, member]),
);

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

export function resolveVisibleRoomFocus(
  activeRoomId: string,
  requestedRoomId: string | undefined,
  visibleRoomIds: readonly string[],
): string | null {
  const requested = requestedRoomId?.trim() ?? "";
  if (requested && requested !== activeRoomId && visibleRoomIds.includes(requested)) {
    return requested;
  }
  if (requested && !visibleRoomIds.includes(requested)) {
    return null;
  }
  if (!activeRoomId || !visibleRoomIds.includes(activeRoomId)) {
    return visibleRoomIds[0] ?? null;
  }
  return null;
}

export function roomMemberSourceLabel(
  member: Pick<RoomMember, "source" | "sourceLabel">,
  t: TranslationFn = translate,
): string {
  const label = member.sourceLabel?.trim();
  // sourceLabel 会被持久化，历史值可能是 local/human/本机/人类/Local/Human，统一归一到当前语言。
  const normalized = label?.toLowerCase();
  if (normalized === "local" || label === "本机") return t("rooms.sourceLocal");
  if (normalized === "human" || label === "人类") return t("rooms.sourceHuman");
  if (label) return label;
  return (member.source || "local") === "human" ? t("rooms.sourceHuman") : t("rooms.sourceLocal");
}

export function roomMemberDisplayName(member: Pick<RoomMember, "name" | "displayName" | "userOverrides">): string {
  if (member.userOverrides?.includes("name")) return member.name;
  return member.displayName?.trim() || member.name;
}

export function roomMemberDisplayPublicDescription(
  member: Pick<RoomMember, "publicDescription" | "displayPublicDescription" | "userOverrides">,
): string | undefined {
  if (member.userOverrides?.includes("publicDescription")) return member.publicDescription;
  return member.displayPublicDescription?.trim() || member.publicDescription;
}

export function roomMemberSourceDetail(
  member: Pick<RoomMember, "source" | "kernel" | "model">,
  t: TranslationFn = translate,
): string {
  if (member.source === "human") {
    return t("rooms.sourceHumanMember");
  }
  return `${member.kernel} / ${memberModelLabel(member)}`;
}

export function defaultMemberIdForKernel(kernelId: string): string {
  return `employee_${hashStableId(kernelId.trim() || "kernel")}`;
}

export function directRoomMember(
  room: Pick<Room, "kind" | "directMemberId" | "memberIds" | "messages" | "title">,
  members: readonly RoomMember[],
): RoomMember | undefined {
  if (room.kind !== "direct") return undefined;
  if (room.directMemberId) {
    const directMember = members.find((member) => member.id === room.directMemberId);
    if (directMember) return directMember;
  }
  for (const memberId of room.memberIds) {
    const member = members.find((candidate) => candidate.id === memberId);
    if (member) return member;
  }
  for (let index = room.messages.length - 1; index >= 0; index -= 1) {
    const message = room.messages[index];
    if (message?.senderType !== "agent") continue;
    const member = members.find((candidate) => candidate.id === message.senderId);
    if (member) return member;
  }

  const normalizedTitle = normalizeDedupeText(room.title);
  if (!normalizedTitle) return undefined;
  return members.find(
    (member) =>
      normalizeDedupeText(member.name) === normalizedTitle ||
      normalizeDedupeText(roomMemberDisplayName(member)) === normalizedTitle,
  );
}

export function roomMemberUsesKernelAvatar(
  member: Pick<
    RoomMember,
    | "id"
    | "employeeDefinitionId"
    | "name"
    | "kernel"
    | "appId"
    | "storePackageId"
    | "source"
    | "avatarMode"
    | "avatarSeed"
    | "avatarDataUrl"
    | "userOverrides"
  >,
): boolean {
  if (member.source === "human" || member.employeeDefinitionId || member.appId || member.storePackageId) return false;
  const avatarWasCustomized = member.userOverrides?.some(
    (field) => field === "avatarMode" || field === "avatarSeed" || field === "avatarDataUrl",
  );
  if (avatarWasCustomized || member.avatarSeed?.trim() || member.avatarDataUrl?.trim()) return false;
  if (member.avatarMode === "initials" || member.avatarMode === "upload") return false;
  return (
    member.id === defaultMemberIdForKernel(member.kernel) || member.id === legacyDefaultMemberIdForKernel(member.kernel)
  );
}

export function dedupeRoomMembers(members: RoomMember[]): {
  members: RoomMember[];
  memberIdAliases: Map<string, string>;
} {
  const byKey = new Map<string, RoomMember>();
  const memberIdAliases = new Map<string, string>();
  for (const member of members) {
    const key = roomMemberDedupeKey(member);
    if (!key) {
      byKey.set(`id:${member.id}`, member);
      continue;
    }
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, member);
      continue;
    }
    const winner = preferRoomMember(current, member);
    const loser = winner.id === current.id ? member : current;
    byKey.set(key, mergeDuplicateRoomMembers(winner, loser));
    if (loser.id !== winner.id) {
      memberIdAliases.set(loser.id, winner.id);
      for (const [aliasId, targetId] of memberIdAliases) {
        if (targetId === loser.id) {
          memberIdAliases.set(aliasId, winner.id);
        }
      }
    }
  }
  return { members: [...byKey.values()], memberIdAliases };
}

/**
 * 全局员工定义是逻辑员工头像的权威来源。App/会话绑定可以拥有独立运行状态，
 * 但不应因此在通讯录、聊天或标题栏显示另一张自定义头像。
 */
export function harmonizeRoomMemberAvatars(members: RoomMember[]): RoomMember[] {
  const definitionAvatars = new Map<string, Pick<RoomMember, "avatarMode" | "avatarSeed" | "avatarDataUrl">>();
  for (const member of members) {
    const definitionId = member.employeeDefinitionId?.trim();
    if (!definitionId || member.appId) continue;
    definitionAvatars.set(definitionId, {
      avatarMode: member.avatarMode,
      avatarSeed: member.avatarSeed,
      avatarDataUrl: member.avatarDataUrl,
    });
  }
  if (!definitionAvatars.size) return members;

  let changed = false;
  const harmonized = members.map((member) => {
    const definitionId = member.employeeDefinitionId?.trim();
    if (!definitionId || !member.appId || !definitionAvatars.has(definitionId)) return member;
    const avatar = definitionAvatars.get(definitionId);
    if (!avatar) return member;
    if (
      avatar.avatarMode === member.avatarMode &&
      avatar.avatarSeed === member.avatarSeed &&
      avatar.avatarDataUrl === member.avatarDataUrl
    )
      return member;
    changed = true;
    return { ...member, ...avatar };
  });
  return changed ? harmonized : members;
}

export function projectRoomMemberIdentity(
  rooms: Room[],
  previousMemberId: string,
  member: Pick<RoomMember, "id" | "name">,
): Room[] {
  const matchingMemberIds = new Set([previousMemberId, member.id]);
  return rooms.map((room) => {
    const title = room.directMemberId && matchingMemberIds.has(room.directMemberId) ? member.name : room.title;
    let messagesChanged = false;
    const messages = room.messages.map((message) => {
      if (!matchingMemberIds.has(message.senderId) || message.senderName === member.name) return message;
      messagesChanged = true;
      return { ...message, senderName: member.name };
    });
    if (title === room.title && !messagesChanged) return room;
    return { ...room, title, messages };
  });
}

export function remapRoomMemberReferences(
  room: Room,
  memberIdAliases: Map<string, string>,
  knownMemberIds?: ReadonlySet<string>,
): Room {
  if (!memberIdAliases.size && !knownMemberIds) return room;
  const mapMemberId = (memberId: string): string => memberIdAliases.get(memberId) ?? memberId;
  const keepMemberId = (memberId: string): boolean => !knownMemberIds || knownMemberIds.has(memberId);
  const directMemberId = room.directMemberId ? mapMemberId(room.directMemberId) : room.directMemberId;
  const nextDirectMemberId = directMemberId && keepMemberId(directMemberId) ? directMemberId : undefined;
  const memberIds = uniqueIds(room.memberIds.map(mapMemberId)).filter(keepMemberId);
  const adminMemberIds = uniqueIds(room.adminMemberIds.map(mapMemberId)).filter(keepMemberId);
  let messagesChanged = false;
  const messages = room.messages.map((message) => {
    const senderId = mapMemberId(message.senderId);
    const targetIds = uniqueIds(message.targetIds.map(mapMemberId)).filter(keepMemberId);
    if (senderId === message.senderId && stringArraysMatch(message.targetIds, targetIds)) return message;
    messagesChanged = true;
    return { ...message, senderId, targetIds };
  });
  if (
    stringArraysMatch(room.memberIds, memberIds) &&
    stringArraysMatch(room.adminMemberIds, adminMemberIds) &&
    room.directMemberId === nextDirectMemberId &&
    !messagesChanged
  ) {
    return room;
  }
  return {
    ...room,
    memberIds,
    adminMemberIds,
    directMemberId: nextDirectMemberId,
    messages,
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function directRoomId(memberId: string): string {
  return `direct-${memberId}`;
}

export function appScopedRoomComponent(value: string | undefined): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "default";
  return encodeURIComponent(normalized).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function appScopedRoomPrefix(appId: string | undefined): string {
  return `app-room--${appScopedRoomComponent(appId)}--`;
}

export function appScopedDirectRoomId(appId: string | undefined, memberId: string): string {
  return `${appScopedRoomPrefix(appId)}direct--${appScopedRoomComponent(memberId)}`;
}

export function appScopedGroupRoomId(appId: string | undefined, sourceRoomId: string): string {
  return `${appScopedRoomPrefix(appId)}group--${appScopedRoomComponent(sourceRoomId)}`;
}

type RoomIdentity = Pick<Room, "scope"> | undefined;

export function isAppScopedRoomId(room: RoomIdentity): boolean {
  return room?.scope?.kind === "app";
}

export function visibleRoomUnreadCount(rooms: readonly Room[]): number {
  return rooms.reduce((total, room) => (isAppScopedRoomId(room) ? total : total + room.unread), 0);
}

export function appScopedGroupUnreadCount(rooms: readonly Room[], appId: string | undefined): number {
  return rooms.reduce(
    (total, room) => (room.kind === "group" && isAppScopedRoomForApp(room, appId) ? total + room.unread : total),
    0,
  );
}

export function isAppScopedRoomForApp(room: RoomIdentity, appId: string | undefined): boolean {
  return room?.scope?.kind === "app" && room.scope.appId === appId;
}

export function statusLabel(status: MemberStatus, t: TranslationFn = translate): string {
  return {
    idle: t("rooms.statusIdle"),
    running: t("rooms.statusRunning"),
    done: t("rooms.statusDone"),
    waiting: t("rooms.statusWaiting"),
    offline: t("rooms.statusOffline"),
  }[status];
}

export function memberModelLabel(member: Pick<RoomMember, "kernel" | "model">, t: TranslationFn = translate): string {
  const model = normalizeRoomMemberModelForKernel(member.kernel, member.model);
  if (member.kernel === "claude-code" && model === "claude-code-default") {
    return t("rooms.modelFollowKernelConfig", { kernel: "Claude Agent" });
  }
  if (member.kernel === "pi" && model === "pi-default") {
    return t("rooms.modelFollowKernelConfig", { kernel: "Pi" });
  }
  return model;
}

export function selectableKernelOptions(
  kernelOptions: KernelOption[],
  activeKernel: string | undefined,
  selectedKernel?: string,
): KernelOption[] {
  return kernelOptions
    .filter(
      (kernel) => isEmployeeKernelSelectable(kernel) || kernel.id === activeKernel || kernel.id === selectedKernel,
    )
    .sort((left, right) => kernelSortScore(right, activeKernel) - kernelSortScore(left, activeKernel));
}

export function isEmployeeKernelSelectable(kernel: KernelOption | undefined): boolean {
  if (kernel?.available === true) return true;
  const routeCanBeRepairedInEmployeeSettings =
    kernel?.unavailableCode === "provider_selection_required" ||
    kernel?.unavailableCode === "kernel_provider_unavailable" ||
    kernel?.unavailableCode === "ww_provider_key_missing" ||
    kernel?.unavailableCode === "provider_key_missing" ||
    kernel?.unavailableCode === "provider_disabled" ||
    kernel?.unavailableCode === "provider_unsupported" ||
    kernel?.unavailableCode === "provider_not_found";
  return Boolean(
    routeCanBeRepairedInEmployeeSettings &&
      (kernel?.installed === true || kernel?.executableProbe?.status === "available"),
  );
}

export function roomMemberFromKernel(
  kernel: KernelOption,
  activeKernel: string | undefined,
  activeModel: ModelId,
): RoomMember {
  const fallback = KERNEL_MEMBER_FALLBACKS[kernel.id] ?? {};
  const source: RoomMemberSource = "local";
  return {
    id: fallback.id || defaultMemberIdForKernel(kernel.id),
    name: kernel.label || fallback.name || kernel.id,
    kernel: kernel.id,
    model: normalizeRoomMemberModelForKernel(
      kernel.id,
      kernel.id === activeKernel ? activeModel : fallback.model || "",
    ),
    role: fallback.role || "",
    status: kernel.id === activeKernel ? "idle" : "waiting",
    color: fallback.color || KERNEL_COLORS[kernel.id] || "#64748b",
    lastActive: kernel.id === activeKernel ? translate("ops.justNow") : translate("rooms.statusWaiting"),
    source,
    sourceLabel: roomMemberSourceLabel({ source }),
  };
}

function hashStableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function legacyDefaultMemberIdForKernel(kernelId: string): string {
  const value = kernelId.trim() || "kernel";
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `member_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function normalizeRoomMemberModelForKernel(kernel: string, model: string): string {
  const value = model.trim();
  if (kernel === "claude-code" && (!value || value === "native")) {
    return DEFAULT_MODEL_ID;
  }
  if (
    kernel === "claude-code" &&
    (value === "Claude Agent" ||
      value === "Claude Code" ||
      value === "AWS Bedrock (API Key)" ||
      value.endsWith("(Claude Code)"))
  ) {
    return "claude-code-default";
  }
  if (kernel === "pi" && (!value || value === "Pi")) {
    return "pi-default";
  }
  if (!value || value === "native") return kernel ? `${kernel}-default` : DEFAULT_MODEL_ID;
  return value;
}

function roomMemberDedupeKey(member: RoomMember): string {
  if (member.source === "human") return "";
  if ((member.appId || member.storePackageId) && !isUserCreatedDedupeCandidate(member)) return "";
  const normalizedName = normalizeDedupeText(member.name);
  const normalizedKernel = normalizeDedupeText(member.kernel);
  const normalizedRole = normalizeDedupeText(roomMemberDedupeRole(member.role));
  if (!normalizedName || !normalizedKernel) return "";
  const normalizedModel = normalizeDedupeText(normalizeRoomMemberModelForKernel(member.kernel, member.model));
  const normalizedProvider = normalizeDedupeText(member.providerId);
  const normalizedReasoningEffort = normalizeDedupeText(member.reasoningEffort);
  const skills = normalizeDedupeList(member.defaultSkillIds);
  const tools = normalizeDedupeList(member.toolIds);
  return [
    normalizedName,
    normalizedKernel,
    normalizedModel,
    normalizedProvider,
    normalizedReasoningEffort,
    normalizedRole,
    skills,
    tools,
  ].join("\u0000");
}

function preferRoomMember(left: RoomMember, right: RoomMember): RoomMember {
  const leftScore = roomMemberDedupeScore(left);
  const rightScore = roomMemberDedupeScore(right);
  if (leftScore !== rightScore) return leftScore > rightScore ? left : right;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

function roomMemberDedupeScore(member: RoomMember): number {
  return (
    (member.disabled ? -100 : 0) +
    // Earlier local releases persisted user-created employees with this id family.
    (member.id.startsWith("member-user-") ? 30 : 0) +
    (member.id.startsWith("employee_") ? 10 : 0) +
    (!member.appId && !member.storePackageId ? 5 : 0) +
    (member.workspaceRoot ? 2 : 0) +
    (member.avatarDataUrl || member.avatarMode ? 1 : 0)
  );
}

function mergeDuplicateRoomMembers(winner: RoomMember, loser: RoomMember): RoomMember {
  const winnerIsUserCreated = isUserCreatedDedupeCandidate(winner);
  return {
    ...loser,
    ...winner,
    role: winner.role || loser.role,
    model: winner.model || loser.model,
    providerId: winner.providerId || loser.providerId,
    reasoningEffort: winner.reasoningEffort || loser.reasoningEffort,
    contextTokenBudget: winner.contextTokenBudget ?? loser.contextTokenBudget,
    color: winner.color || loser.color,
    lastActive: winner.lastActive || loser.lastActive,
    availableSkillIds: winner.availableSkillIds ?? loser.availableSkillIds,
    defaultSkillIds: winner.defaultSkillIds?.length ? winner.defaultSkillIds : loser.defaultSkillIds,
    toolIds: winner.toolIds?.length ? winner.toolIds : loser.toolIds,
    avatarMode: winner.avatarMode || loser.avatarMode,
    avatarSeed: winner.avatarSeed || loser.avatarSeed,
    avatarDataUrl: winner.avatarDataUrl || loser.avatarDataUrl,
    workspaceRoot: winner.workspaceRoot || loser.workspaceRoot,
    appId: winnerIsUserCreated ? winner.appId : winner.appId || loser.appId,
    storePackageId: winnerIsUserCreated ? winner.storePackageId : winner.storePackageId || loser.storePackageId,
    visibility: winner.visibility || loser.visibility,
    publicDescription: winner.publicDescription || loser.publicDescription,
    publicSkills: winner.publicSkills?.length ? winner.publicSkills : loser.publicSkills,
    inputSpec: winner.inputSpec || loser.inputSpec,
    outputSpec: winner.outputSpec || loser.outputSpec,
  };
}

function normalizeDedupeText(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function roomMemberDedupeRole(role: string | undefined): string {
  return String(role ?? "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^When used from the .+ OpenGrove App, answer with that App's current context and workspace in mind\.$/.test(
          line.trim(),
        ),
    )
    .join("\n");
}

function isUserCreatedDedupeCandidate(member: Pick<RoomMember, "id">): boolean {
  return member.id.startsWith("employee_") || member.id.startsWith("member-user-");
}

function normalizeDedupeList(values: string[] | undefined): string {
  return uniqueIds((values ?? []).map(normalizeDedupeText))
    .sort()
    .join(",");
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function stringArraysMatch(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function kernelSortScore(kernel: KernelOption, activeKernel: string | undefined): number {
  return (kernel.id === activeKernel ? 10 : 0) + (kernel.available ? 4 : 0);
}
