import { record } from "../../http-utils.js";
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
  return { ...member, userOverrides: existing.userOverrides, manifestDefaults: existing.manifestDefaults };
}

export async function handleRoomMemberRoutes(context: RoomsRouteContext): Promise<boolean> {
  return (
    (await handleRoomMemberAddRoute(context)) ||
    (await handleMemberUpsertRoute(context)) ||
    (await handleMemberRestoreAppDefaultsRoute(context)) ||
    (await handleMemberPatchRoute(context)) ||
    (await handleRoomMemberDeleteRoute(context))
  );
}

async function handleRoomMemberAddRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = context;
  const membersAction = url.pathname.match(/^\/rooms\/([^/]+)\/members$/);
  if (!membersAction || request.method !== "POST") return false;
  const [, encodedRoomId] = membersAction;
  const normalizedMember = withPreservedServerOwnedMeta(state, normalizeMember(record(await readJsonBody(request))));
  let member: RoomChannelMember;
  try {
    member = state.app.rooms.addMember(decodeURIComponent(encodedRoomId!), normalizedMember);
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

async function handleMemberUpsertRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = context;
  if (request.method !== "POST" || url.pathname !== "/rooms/members") return false;
  const body = record(await readJsonBody(request));
  const normalizedMember = normalizeMember(body);
  const member = state.app.rooms.upsertMember(withPreservedServerOwnedMeta(state, normalizedMember), {
    emitEvent: true,
  });
  state.store.saveFrom(state.app);
  sendJson(response, 200, { ok: true, member, currentEventSeq: state.app.rooms.snapshot().currentEventSeq });
  return true;
}

async function handleMemberRestoreAppDefaultsRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson } = context;
  const action = url.pathname.match(/^\/rooms\/members\/([^/]+)\/restore-app-defaults$/);
  if (!action || request.method !== "POST") return false;
  const memberId = decodeURIComponent(action[1]!);
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
    employeeManifestDefaultsPatch(existing, existing.manifestDefaults),
  );
  state.store.saveFrom(state.app);
  sendJson(response, 200, { ok: true, member, currentEventSeq: state.app.rooms.snapshot().currentEventSeq });
  return true;
}

async function handleMemberPatchRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = context;
  const globalMemberAction = url.pathname.match(/^\/rooms\/members\/([^/]+)$/);
  if (!globalMemberAction || request.method !== "PATCH") return false;
  const memberId = decodeURIComponent(globalMemberAction[1]!);
  const rawBody = record(await readJsonBody(request));
  const existing = state.app.rooms.listMembers().find((candidate) => candidate.id === memberId);
  const patch = normalizeMemberPatch(rawBody, existing?.kernel);
  const touched = USER_OVERRIDABLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(rawBody, field));
  // For seed-managed employees, non-null fields become user overrides. Clearing
  // reasoning or model means "follow App/Kernel defaults", so remove that marker
  // and immediately restore the effective default value instead.
  if (existing && (memberId.startsWith("member-app-") || isProductDefaultEmployeeId(memberId))) {
    if (touched.length) {
      const nextOverrides = new Set(existing.userOverrides ?? []);
      for (const field of touched) {
        if (
          (field === "reasoningEffort" && rawBody.reasoningEffort === null) ||
          (field === "model" && isClearedModelValue(rawBody.model))
        ) {
          nextOverrides.delete(field);
        } else {
          nextOverrides.add(field);
        }
      }
      patch.userOverrides = nextOverrides.size ? [...nextOverrides] : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(rawBody, "model") && isClearedModelValue(rawBody.model)) {
      patch.model = defaultModelForEmployee(state, existing, patch.kernel ?? existing.kernel);
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

async function handleRoomMemberDeleteRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson } = context;
  const memberAction = url.pathname.match(/^\/rooms\/([^/]+)\/members\/([^/]+)$/);
  if (!memberAction || request.method !== "DELETE") return false;
  const [, encodedRoomId, encodedMemberId] = memberAction;
  const roomId = decodeURIComponent(encodedRoomId!);
  const memberId = decodeURIComponent(encodedMemberId!);
  const room = state.app.rooms.removeMember(roomId, memberId);
  state.store.saveFrom(state.app);
  sendJson(response, 200, {
    ok: true,
    room,
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}
