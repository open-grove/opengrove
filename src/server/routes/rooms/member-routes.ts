import { employeeAccessModeIssue, normalizeEmployeeAccessMode } from "../../employee-access-mode.js";
import { kernelConfigHomeForRegistry } from "../../kernel-registry.js";
import type {
  UpsertEmployeeOperation,
  UpdateEmployeeOperation,
  RestoreEmployeeDefaultsOperation,
  AddRoomMemberOperation,
  JoinRoomMemberOperation,
  RemoveRoomMemberOperation,
} from "#protocol";
import type { HostOperationRouteContext } from "../../router.js";
import { isBridgeKernelId, type RoomChannelMember, type RoomChannelStore } from "../../../rooms/channel-store.js";
import { employeeManifestDefaultsPatch, mountedAppDefaultEmployees } from "../../bridge-mounted-app-employees.js";
import { isProductDefaultEmployeeId } from "../../product-default-employees.js";
import { productDefaultModelForKernel, productEmployeeRuntimeDefault } from "../../product-employee-defaults.js";
import { normalizeMember, normalizeMemberPatch } from "./normalizers.js";
import type { RoomsRouteContext } from "./route-context.js";
import { roomMutationErrorResponse } from "./room-mutation-errors.js";

// User-facing employee fields that, when edited by the user, must survive seed
// sync. A role override protects only the public lead; App instructions keep
// following the mounted App on upgrades.
const USER_OVERRIDABLE_FIELDS = [
  "name",
  "avatarMode",
  "avatarSeed",
  "avatarDataUrl",
  "role",
  "kernel",
  "model",
  "providerId",
  "availableSkillIds",
  "defaultSkillIds",
  "reasoningEffort",
  "contextTokenBudget",
  "accessMode",
  "color",
  "visibility",
  "publicDescription",
  "publicSkills",
  "inputSpec",
  "outputSpec",
] as const;
const SHARED_EMPLOYEE_DEFINITION_RUNTIME_FIELDS = new Set([
  "avatarMode",
  "avatarSeed",
  "avatarDataUrl",
  "kernel",
  "model",
  "providerId",
  "reasoningEffort",
  "contextTokenBudget",
  "accessMode",
]);

// userOverrides/manifestDefaults are server-owned and never read from a client body.
// A POST (upsert/add, e.g. restoring an employee) must not drop the metadata the
// server already holds for that member, so re-attach it from the stored member.
function withPreservedServerOwnedMeta(state: RoomsRouteContext["state"], member: RoomChannelMember): RoomChannelMember {
  const existing = state.app.rooms.listMembers().find((candidate) => candidate.id === member.id);
  if (!existing) return member;
  if (existing.source === "remote") return { ...existing, name: member.name, disabled: member.disabled };
  return { ...member, userOverrides: existing.userOverrides, manifestDefaults: existing.manifestDefaults };
}

export async function handleAddRoomMemberOperation(
  context: HostOperationRouteContext<AddRoomMemberOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  const normalizedMember = withPreservedServerOwnedMeta(
    state,
    normalizeMember(context.input.body, kernelConfigHomeForRegistry(state.settings, "claude-code")),
  );
  if (
    employeeAccessModeIssue(
      normalizedMember.kernel,
      context.input.body.accessMode ?? normalizedMember.accessMode,
      normalizedMember.model,
      kernelConfigHomeForRegistry(state.settings, "claude-code"),
      state.app.rooms.listMembers().find((member) => member.id === normalizedMember.id),
    )
  ) {
    sendJson(response, 409, { ok: false, error: "runtime_access_mode_unavailable" });
    return true;
  }
  let member: RoomChannelMember;
  try {
    member = state.app.rooms.addMember(context.input.params.roomId, normalizedMember);
  } catch (error) {
    const result = roomMutationErrorResponse(error);
    if (!result) throw error;
    sendJson(response, result.status, { ok: false, error: result.error });
    return true;
  }
  state.store.saveFrom(state.app);
  sendJson(response, 200, { ok: true, member, currentEventSeq: state.app.rooms.snapshot().currentEventSeq });
  return true;
}

export async function handleJoinRoomMemberOperation(
  context: HostOperationRouteContext<JoinRoomMemberOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  let member: RoomChannelMember;
  try {
    member = state.app.rooms.joinMember(context.input.params.roomId, context.input.params.memberId);
  } catch (error) {
    if (error instanceof Error && ["room_member_not_found", "room_not_found"].includes(error.message)) {
      sendJson(response, 404, { ok: false, error: error.message });
      return true;
    }
    const result = roomMutationErrorResponse(error);
    if (!result) throw error;
    sendJson(response, result.status, { ok: false, error: result.error });
    return true;
  }
  state.store.saveFrom(state.app);
  sendJson(response, 200, { ok: true, member, currentEventSeq: state.app.rooms.snapshot().currentEventSeq });
  return true;
}

export async function handleUpsertEmployeeOperation(
  context: HostOperationRouteContext<UpsertEmployeeOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  const normalizedMember = normalizeMember(
    context.input.body,
    kernelConfigHomeForRegistry(state.settings, "claude-code"),
  );
  if (
    employeeAccessModeIssue(
      normalizedMember.kernel,
      context.input.body.accessMode ?? normalizedMember.accessMode,
      normalizedMember.model,
      kernelConfigHomeForRegistry(state.settings, "claude-code"),
      state.app.rooms.listMembers().find((member) => member.id === normalizedMember.id),
    )
  ) {
    sendJson(response, 409, { ok: false, error: "runtime_access_mode_unavailable" });
    return true;
  }
  const member = state.app.rooms.upsertMember(withPreservedServerOwnedMeta(state, normalizedMember), {
    emitEvent: true,
  });
  state.store.saveFrom(state.app);
  sendJson(response, 200, { ok: true, member, currentEventSeq: state.app.rooms.snapshot().currentEventSeq });
  return true;
}

export async function handleRestoreEmployeeDefaultsOperation(
  context: HostOperationRouteContext<RestoreEmployeeDefaultsOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  const { memberId } = context.input.params;
  const existing = state.app.rooms.listMembers().find((candidate) => candidate.id === memberId);
  if (!existing) {
    sendJson(response, 404, { ok: false, error: "room_member_not_found" });
    return true;
  }
  if (!existing.appId || !existing.manifestDefaults) {
    sendJson(response, 409, { ok: false, error: "app_employee_defaults_unavailable" });
    return true;
  }
  const member = state.app.rooms.patchMember(
    memberId,
    employeeManifestDefaultsPatch(
      existing,
      existing.manifestDefaults,
      kernelConfigHomeForRegistry(state.settings, "claude-code"),
    ),
  );
  state.store.saveFrom(state.app);
  sendJson(response, 200, { ok: true, member, currentEventSeq: state.app.rooms.snapshot().currentEventSeq });
  return true;
}

export async function handleUpdateEmployeeOperation(
  context: HostOperationRouteContext<UpdateEmployeeOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  const { memberId } = context.input.params;
  const patchInput = context.input.body;
  const existing = state.app.rooms.listMembers().find((candidate) => candidate.id === memberId);
  const patch = normalizeMemberPatch(patchInput, existing?.kernel);
  if (existing?.source === "remote") {
    const member = state.app.rooms.patchMember(memberId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    });
    state.store.saveFrom(state.app);
    sendJson(response, 200, { ok: true, member, currentEventSeq: state.app.rooms.snapshot().currentEventSeq });
    return true;
  }
  const touched = USER_OVERRIDABLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(patchInput, field));
  if (existing && touched.includes("model") && isClearedModelValue(patchInput.model)) {
    patch.model = defaultModelForEmployee(state, existing, patch.kernel ?? existing.kernel);
  }
  if (touched.includes("kernel") || touched.includes("accessMode")) {
    patch.accessMode = normalizeEmployeeAccessMode(
      patch.kernel ?? existing?.kernel ?? "",
      touched.includes("accessMode")
        ? patchInput.accessMode === null
          ? existing?.manifestDefaults?.accessMode
          : patchInput.accessMode
        : existing?.accessMode,
      patch.model ?? existing?.model,
      kernelConfigHomeForRegistry(state.settings, "claude-code"),
    );
    if (
      existing?.accessMode !== undefined &&
      patch.accessMode !== existing.accessMode &&
      !touched.includes("accessMode")
    )
      touched.push("accessMode");
  }
  if (
    touched.some((field) => ["kernel", "model", "accessMode", "providerId"].includes(field)) &&
    employeeAccessModeIssue(
      patch.kernel ?? existing?.kernel ?? "",
      patchInput.accessMode ?? patch.accessMode ?? existing?.accessMode,
      patch.model ?? existing?.model ?? "",
      kernelConfigHomeForRegistry(state.settings, "claude-code"),
      existing,
    )
  ) {
    sendJson(response, 409, { ok: false, error: "runtime_access_mode_unavailable" });
    return true;
  }
  // For seed-managed employees, non-null fields become user overrides. Clearing
  // reasoning or model means "follow App/Kernel defaults", so remove that marker
  // and immediately restore the effective default value instead.
  if (existing && (memberId.startsWith("member-app-") || isProductDefaultEmployeeId(memberId))) {
    if (touched.length) {
      const nextOverrides = new Set(existing.userOverrides ?? []);
      for (const field of touched) {
        if (
          (field === "reasoningEffort" && patchInput.reasoningEffort === null) ||
          (field === "accessMode" && patchInput.accessMode === null) ||
          (field === "model" && isClearedModelValue(patchInput.model))
        ) {
          nextOverrides.delete(field);
        } else {
          nextOverrides.add(field);
        }
      }
      patch.userOverrides = nextOverrides.size ? [...nextOverrides] : undefined;
    }
  }
  const member = state.app.rooms.patchMember(memberId, patch);
  if (touched.some((field) => SHARED_EMPLOYEE_DEFINITION_RUNTIME_FIELDS.has(field))) {
    propagateEmployeeDefinitionRuntime(state.app.rooms, member);
  }
  state.store.saveFrom(state.app);
  sendJson(response, 200, { ok: true, member, currentEventSeq: state.app.rooms.snapshot().currentEventSeq });
  return true;
}

function isClearedModelValue(value: unknown): boolean {
  return value === null || (typeof value === "string" && !value.trim());
}

function defaultModelForEmployee(state: RoomsRouteContext["state"], member: RoomChannelMember, kernel: string): string {
  const mountedDefault = member.appId
    ? mountedAppDefaultEmployees(state.settings).find((candidate) => candidate.id === member.id)
    : undefined;
  const declaredKernel = mountedDefault?.kernel ?? member.manifestDefaults?.kernel;
  const declaredModel = mountedDefault?.model ?? member.manifestDefaults?.model;
  if (declaredKernel === kernel && declaredModel?.trim()) return declaredModel;

  const productDefault = productEmployeeRuntimeDefault(member.employeeDefinitionId ?? member.id);
  if (productDefault?.kernel === kernel) return productDefault.model;
  if (isBridgeKernelId(kernel)) return productDefaultModelForKernel(kernel);
  return declaredModel?.trim() || member.model;
}

function propagateEmployeeDefinitionRuntime(rooms: RoomChannelStore, definition: RoomChannelMember): void {
  if (!definition.employeeDefinitionId || definition.appId) return;
  for (const binding of rooms.listMembers()) {
    if (!binding.appId || binding.employeeDefinitionId !== definition.employeeDefinitionId) continue;
    rooms.patchMember(binding.id, {
      avatarMode: definition.avatarMode,
      avatarSeed: definition.avatarSeed,
      // The unscoped logical employee owns the potentially large upload payload.
      // Scoped App bindings inherit it on the client by employeeDefinitionId.
      avatarDataUrl: undefined,
      kernel: definition.kernel,
      model: definition.model,
      providerId: definition.providerId,
      reasoningEffort: definition.reasoningEffort,
      contextTokenBudget: definition.contextTokenBudget,
      accessMode: definition.accessMode,
    });
  }
}

export async function handleRemoveRoomMemberOperation(
  context: HostOperationRouteContext<RemoveRoomMemberOperation>,
): Promise<true> {
  const { response, state, sendJson } = context;
  const { roomId, memberId } = context.input.params;
  const room = state.app.rooms.removeMember(roomId, memberId);
  state.store.saveFrom(state.app);
  sendJson(response, 200, {
    ok: true,
    room,
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}
