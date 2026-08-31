import type { AgentAttachmentContext, JsonObject } from "../../../core.js";
import { DEFAULT_BRIDGE_MODEL_ID, LEGACY_NATIVE_MODEL_ID, type BridgeState } from "../../bridge-types.js";
import { record } from "../../http-utils.js";
import { normalizeModelForKernelDisplay } from "../../kernel-registry.js";
import type { RoomChannelMember, RoomMessageStatus } from "../../../rooms/channel-store.js";
import { isBridgeKernelId } from "../../../rooms/channel-store.js";
import { normalizedRoomMemberAvatarDataUrl } from "../../../rooms/avatar-data-url.js";
import { resolveHostLanguageSettings } from "../../language-preference.js";
import { hostMessage } from "../../../localization/host-messages.js";
import { productDefaultModelForKernel } from "../../product-employee-defaults.js";

export function normalizeMember(input: Record<string, unknown>): RoomChannelMember {
  const id = readString(input.id);
  if (!id) throw new Error("member_id_required");
  const kernel = readString(input.kernel) || id;
  return {
    id,
    employeeDefinitionId: readOptionalString(input.employeeDefinitionId),
    name: readString(input.name) || id,
    kernel,
    model: normalizeWritableEmployeeModel(kernel, readString(input.model)),
    providerId: readOptionalString(input.providerId),
    role: readString(input.role),
    status: readMemberStatus(input.status),
    color: readString(input.color) || "#64748b",
    lastActive: readString(input.lastActive) || "now",
    availableSkillIds: readStringArray(input.availableSkillIds),
    defaultSkillIds: readStringArray(input.defaultSkillIds),
    appId: readOptionalString(input.appId),
    workspaceRoot: readOptionalString(input.workspaceRoot),
    storePackageId: readOptionalString(input.storePackageId),
    toolIds: readStringArray(input.toolIds),
    accessMode: readMemberAccessMode(input.accessMode),
    reasoningEffort: readMemberReasoningEffort(input.reasoningEffort),
    contextTokenBudget: readOptionalContextTokenBudget(input.contextTokenBudget),
    avatarMode: readMemberAvatarMode(input.avatarMode),
    avatarSeed: readMemberAvatarSeed(input.avatarSeed),
    avatarDataUrl: readMemberAvatarDataUrl(input.avatarDataUrl),
    source: readMemberSource(input.source) ?? "local",
    sourceLabel: readOptionalString(input.sourceLabel),
    visibility: readMemberVisibility(input.visibility),
    publicDescription: readOptionalString(input.publicDescription),
    publicSkills: readStringArray(input.publicSkills),
    inputSpec: readOptionalString(input.inputSpec),
    outputSpec: readOptionalString(input.outputSpec),
    // userOverrides/manifestDefaults are server-owned: userOverrides is computed by
    // the PATCH route from the edited fields, manifestDefaults only by seed sync.
    // Never trusted from the client request body here.
    disabled: input.disabled === true,
  };
}

export function normalizeMemberPatch(
  input: Record<string, unknown>,
  currentKernel?: string,
): Partial<Omit<RoomChannelMember, "id">> {
  const patch: Partial<Omit<RoomChannelMember, "id">> = {};
  if (Object.prototype.hasOwnProperty.call(input, "name")) patch.name = readString(input.name);
  if (Object.prototype.hasOwnProperty.call(input, "kernel")) patch.kernel = readString(input.kernel);
  if (Object.prototype.hasOwnProperty.call(input, "model")) {
    const model = readString(input.model);
    patch.model = model
      ? normalizeWritableEmployeeModel(readString(input.kernel) || currentKernel || "", model)
      : undefined;
  }
  if (Object.prototype.hasOwnProperty.call(input, "providerId"))
    patch.providerId = readOptionalString(input.providerId);
  if (Object.prototype.hasOwnProperty.call(input, "role")) patch.role = readString(input.role);
  if (Object.prototype.hasOwnProperty.call(input, "status")) patch.status = readMemberStatus(input.status);
  if (Object.prototype.hasOwnProperty.call(input, "color")) patch.color = readString(input.color);
  if (Object.prototype.hasOwnProperty.call(input, "lastActive")) patch.lastActive = readString(input.lastActive);
  if (Object.prototype.hasOwnProperty.call(input, "availableSkillIds"))
    patch.availableSkillIds = readStringArray(input.availableSkillIds);
  if (Object.prototype.hasOwnProperty.call(input, "defaultSkillIds"))
    patch.defaultSkillIds = readStringArray(input.defaultSkillIds);
  if (Object.prototype.hasOwnProperty.call(input, "appId")) patch.appId = readOptionalString(input.appId);
  if (Object.prototype.hasOwnProperty.call(input, "workspaceRoot"))
    patch.workspaceRoot = readOptionalString(input.workspaceRoot);
  if (Object.prototype.hasOwnProperty.call(input, "storePackageId"))
    patch.storePackageId = readOptionalString(input.storePackageId);
  if (Object.prototype.hasOwnProperty.call(input, "toolIds")) patch.toolIds = readStringArray(input.toolIds);
  if (Object.prototype.hasOwnProperty.call(input, "accessMode"))
    patch.accessMode = readMemberAccessMode(input.accessMode);
  if (Object.prototype.hasOwnProperty.call(input, "reasoningEffort"))
    patch.reasoningEffort = readMemberReasoningEffort(input.reasoningEffort);
  if (Object.prototype.hasOwnProperty.call(input, "contextTokenBudget"))
    patch.contextTokenBudget = readOptionalContextTokenBudget(input.contextTokenBudget);
  if (Object.prototype.hasOwnProperty.call(input, "avatarMode"))
    patch.avatarMode = readMemberAvatarMode(input.avatarMode);
  if (Object.prototype.hasOwnProperty.call(input, "avatarSeed"))
    patch.avatarSeed = readMemberAvatarSeed(input.avatarSeed);
  if (Object.prototype.hasOwnProperty.call(input, "avatarDataUrl"))
    patch.avatarDataUrl = readMemberAvatarDataUrl(input.avatarDataUrl);
  if (Object.prototype.hasOwnProperty.call(input, "source")) patch.source = readMemberSource(input.source);
  if (Object.prototype.hasOwnProperty.call(input, "sourceLabel"))
    patch.sourceLabel = readOptionalString(input.sourceLabel);
  if (Object.prototype.hasOwnProperty.call(input, "visibility"))
    patch.visibility = readMemberVisibility(input.visibility);
  if (Object.prototype.hasOwnProperty.call(input, "publicDescription"))
    patch.publicDescription = readOptionalString(input.publicDescription);
  if (Object.prototype.hasOwnProperty.call(input, "publicSkills"))
    patch.publicSkills = readStringArray(input.publicSkills);
  if (Object.prototype.hasOwnProperty.call(input, "inputSpec")) patch.inputSpec = readOptionalString(input.inputSpec);
  if (Object.prototype.hasOwnProperty.call(input, "outputSpec"))
    patch.outputSpec = readOptionalString(input.outputSpec);
  // userOverrides/manifestDefaults are server-owned and intentionally NOT read from
  // the client patch body; the PATCH route sets userOverrides from the edited fields.
  if (Object.prototype.hasOwnProperty.call(input, "disabled")) patch.disabled = input.disabled === true;
  return patch;
}

function normalizeWritableEmployeeModel(kernel: string, model: string): string {
  if ((!model || model === LEGACY_NATIVE_MODEL_ID) && isBridgeKernelId(kernel)) {
    return productDefaultModelForKernel(kernel);
  }
  if (!model || model === LEGACY_NATIVE_MODEL_ID) return DEFAULT_BRIDGE_MODEL_ID;
  return normalizeModelForKernelDisplay(kernel, model);
}

export function updateNonRunnableLocalTarget(
  state: BridgeState,
  roomId: string,
  target: RoomChannelMember,
  assistantMessage: { id: string },
) {
  const language = resolveHostLanguageSettings(state.settings);
  const displayName = target.displayName || target.name;
  if (target.disabled) {
    return state.app.rooms.updateMessage(roomId, assistantMessage.id, {
      text: hostMessage(language, "room.member_removed", { name: displayName }),
      status: "done",
      finishedAt: new Date().toISOString(),
    });
  }
  if (target.source === "human") {
    return state.app.rooms.updateMessage(roomId, assistantMessage.id, {
      text: hostMessage(language, "room.human_member_no_reply", { name: displayName }),
      status: "done",
      finishedAt: new Date().toISOString(),
    });
  }

  return state.app.rooms.updateMessage(roomId, assistantMessage.id, {
    text: hostMessage(language, "room.member_not_runnable", { name: displayName }),
    status: "done",
    finishedAt: new Date().toISOString(),
  });
}

export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map((item) => readString(item)).filter(Boolean))] : [];
}

export function readMemberVisibility(value: unknown): "private" | "public" | undefined {
  return value === "public" || value === "private" ? value : undefined;
}

export function readMemberAccessMode(value: unknown): RoomChannelMember["accessMode"] {
  return value === "default" || value === "auto-review" || value === "full-access" ? value : undefined;
}

export function readMemberReasoningEffort(value: unknown): RoomChannelMember["reasoningEffort"] {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

export function readMemberAvatarMode(value: unknown): RoomChannelMember["avatarMode"] {
  return value === "generated" || value === "initials" || value === "upload" ? value : undefined;
}

export function readMemberAvatarSeed(value: unknown): string | undefined {
  const seed = readOptionalString(value);
  if (seed && seed.length > 512) {
    throw new Error("room_member_avatar_seed_invalid");
  }
  return seed;
}

export function readMemberAvatarDataUrl(value: unknown): string | undefined {
  const dataUrl = readOptionalString(value);
  if (!dataUrl) return undefined;
  const normalized = normalizedRoomMemberAvatarDataUrl(dataUrl);
  if (!normalized) {
    throw new Error("room_member_avatar_data_url_invalid");
  }
  return normalized;
}

export function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function readPositiveInt(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

export function readOptionalPositiveInt(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function readOptionalContextTokenBudget(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function readMemberStatus(value: unknown): RoomChannelMember["status"] {
  return value === "running" || value === "done" || value === "waiting" || value === "offline" ? value : "idle";
}

function readMemberSource(value: unknown): RoomChannelMember["source"] {
  return value === "human" || value === "local" ? value : undefined;
}

export function readMessageStatus(value: unknown): RoomMessageStatus | undefined {
  return value === "sent" || value === "running" || value === "done" || value === "failed" || value === "interrupted"
    ? value
    : undefined;
}

export function readAttachments(value: unknown): AgentAttachmentContext[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: AgentAttachmentContext[] = [];
  for (const item of value) {
    const input = record(item);
    const kind = input.kind === "image" || input.kind === "text" || input.kind === "file" ? input.kind : undefined;
    const name = readString(input.name);
    if (!kind || !name) continue;
    const size = Number(input.size);
    attachments.push({
      id: readOptionalString(input.id),
      name,
      kind,
      mimeType: readOptionalString(input.mimeType),
      size: Number.isFinite(size) && size >= 0 ? size : undefined,
      text: readOptionalString(input.text),
      dataUrl: readOptionalString(input.dataUrl),
      localPath: readOptionalString(input.localPath),
    });
  }
  return attachments.length ? attachments : undefined;
}

export function readJsonObjects(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isJsonObject);
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resolveVisibleRoomTargets(
  state: BridgeState,
  roomId: string,
  text: string,
  requestedTargetIds: string[],
): string[] {
  const room = state.app.rooms.getRoom(roomId);
  if (!room) return [];
  if (room.kind === "direct") {
    const directMemberId = room.directMemberId ?? room.memberIds[0];
    const member = directMemberId
      ? state.app.rooms.listMembers().find((item) => item.id === directMemberId)
      : undefined;
    return member && !member.disabled && member.status !== "offline" ? [member.id] : [];
  }

  const members = state.app.rooms
    .listMembers()
    .filter((member) => room.memberIds.includes(member.id) && !member.disabled && member.status !== "offline");
  const normalized = text.toLowerCase();
  const requested = new Set(requestedTargetIds);
  if (requested.size > 0) {
    return members.filter((member) => requested.has(member.id)).map((member) => member.id);
  }
  if (/@all\b/i.test(text) || /@(所有人|全部)/.test(text)) {
    return members.map((member) => member.id);
  }
  const mentioned = members
    .filter((member) => {
      const aliases = [member.displayName, member.name, member.id]
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => `@${value.toLowerCase()}`);
      return aliases.some((alias) => mentionTokenExists(normalized, alias));
    })
    .map((member) => member.id);
  if (mentioned.length) return mentioned;
  return [];
}

function mentionTokenExists(text: string, alias: string): boolean {
  const index = text.indexOf(alias);
  if (index < 0) return false;
  const next = text[index + alias.length] ?? "";
  return !next || /[\s,，。.!！?？:：;；]/.test(next);
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
