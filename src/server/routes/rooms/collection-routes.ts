import type { AppRoomScope, RoomChannelMember, RoomChannelRoom } from "../../../rooms/channel-store.js";
import { isLegacyRoomPmMember, isRoomPmMember, pmAgentMemberId } from "../../../rooms/room-pm.js";
import { record } from "../../http-utils.js";
import { GROVE_GUIDE_MEMBER_ID, syncGroveGuideWelcome } from "../../product-default-employees.js";
import { resolveHostLanguageSettings } from "../../language-preference.js";
import {
  normalizeMember,
  objectRecord,
  readOptionalBoolean,
  readOptionalString,
  readPositiveInt,
  readString,
  readStringArray,
} from "./normalizers.js";
import { presentRoomEvent, presentRoomMessage } from "../../room-presentation.js";
import { readLongPollWaitMs, waitForLongPoll } from "../../long-poll.js";
import type { RoomsRouteContext } from "./route-context.js";
import { appScopedDirectRoomId, createRoomId } from "./route-helpers.js";
import { findDefaultAppGroupRoom } from "../../app-room-ids.js";
import { resolveMountedAppTarget } from "../../mounted-apps.js";
import { roomMutationErrorResponse } from "./room-mutation-errors.js";

export async function handleRoomCollectionRoutes(context: RoomsRouteContext): Promise<boolean> {
  return (
    (await handleRoomsInitRoute(context)) ||
    (await handleRoomsCreateRoute(context)) ||
    (await handleDirectRoomRoute(context)) ||
    (await handleRoomEventsRoute(context)) ||
    (await handleRoomReadRoute(context)) ||
    (await handleRoomPatchRoute(context))
  );
}

async function handleRoomsInitRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson } = context;
  if (request.method !== "GET" || url.pathname !== "/rooms") return false;
  const groveWelcomeChanged = !state.kernelUnavailableReason
    ? syncGroveGuideWelcome(
        state.app.rooms,
        `direct-${GROVE_GUIDE_MEMBER_ID}`,
        resolveHostLanguageSettings(state.settings),
      )
    : false;
  if (groveWelcomeChanged) state.store.saveFrom(state.app);
  const snapshot = state.app.rooms.getInit(
    Math.min(readPositiveInt(url.searchParams.get("limit"), 80), 200),
    Math.min(readPositiveInt(url.searchParams.get("totalLimit"), 500), 1_000),
  );
  sendJson(response, 200, {
    ok: true,
    ...snapshot,
    messages: snapshot.messages.map(presentRoomMessage),
  });
  return true;
}

async function handleRoomsCreateRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = context;
  if (request.method !== "POST" || url.pathname !== "/rooms") return false;
  const body = record(await readJsonBody(request));
  const requestedRoomId = readOptionalString(body.id);
  const generatedTitle = readGeneratedRoomTitle(body.generatedTitle);
  const requestedMemberIds = readStringArray(body.memberIds);
  const requestedAdminMemberIds = Object.prototype.hasOwnProperty.call(body, "adminMemberIds")
    ? readStringArray(body.adminMemberIds)
    : undefined;
  const requestedScope = readRoomScope(body.scope);
  if (Object.prototype.hasOwnProperty.call(body, "scope") && !requestedScope) {
    sendJson(response, 400, { ok: false, error: "room_scope_invalid" });
    return true;
  }
  let scope: AppRoomScope | undefined;
  let authoritativeRoster: { memberIds: string[]; adminMemberIds: string[] } | undefined;
  if (requestedScope) {
    const mountedApp = resolveMountedAppTarget(state, requestedScope.appId);
    if (!mountedApp) {
      sendJson(response, 409, { ok: false, error: "app_not_mounted" });
      return true;
    }
    if (generatedTitle?.kind === "app-group" && generatedTitle.appId !== mountedApp.id) {
      sendJson(response, 400, { ok: false, error: "room_scope_mismatch" });
      return true;
    }
    scope = {
      kind: "app",
      appId: mountedApp.id,
      role:
        requestedScope.role ??
        (generatedTitle?.kind === "app-group" && generatedTitle.sequence === 1 ? "default" : "group"),
    };
    authoritativeRoster = mountedAppGroupRoster(state, mountedApp.id, requestedMemberIds);
    if (!authoritativeRoster) {
      sendJson(response, 409, { ok: false, error: "app_roster_empty" });
      return true;
    }
  }
  const roomId = requestedRoomId || createRoomId();
  let room: RoomChannelRoom;
  try {
    room = state.app.rooms.createRoom({
      id: roomId,
      scope,
      title: readString(body.title),
      memberIds: authoritativeRoster?.memberIds ?? requestedMemberIds,
      adminMemberIds: authoritativeRoster?.adminMemberIds ?? requestedAdminMemberIds,
      badge: readString(body.badge),
      generatedTitle,
    });
  } catch (error) {
    if (sendRoomMutationError(response, sendJson, error)) return true;
    throw error;
  }
  state.store.saveFrom(state.app);
  sendJson(response, 200, {
    ok: true,
    room,
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}

function mountedAppGroupRoster(
  state: RoomsRouteContext["state"],
  appId: string,
  requestedMemberIds: string[],
): { memberIds: string[]; adminMemberIds: string[] } | undefined {
  const members = state.app.rooms.listMembers();
  const membersById = new Map(members.map((member) => [member.id, member]));
  const activeCanonicalPm =
    membersById.get(pmAgentMemberId(appId)) ??
    members.find((member) => member.appId === appId && !member.disabled && isRoomPmMember(member));
  const usableCanonicalPm =
    activeCanonicalPm?.appId === appId && !activeCanonicalPm.disabled && isRoomPmMember(activeCanonicalPm)
      ? activeCanonicalPm
      : undefined;
  const defaultRoom = findDefaultAppGroupRoom(state.app.rooms.listRooms(), appId);
  const sourceMemberIds = defaultRoom
    ? defaultRoom.memberIds
    : members.filter((member) => member.appId === appId && !member.disabled).map((member) => member.id);
  const memberIds: string[] = [];
  for (const memberId of sourceMemberIds) {
    const member = membersById.get(memberId);
    if (!member || member.disabled) continue;
    if (isLegacyRoomPmMember(member)) {
      if (usableCanonicalPm && !memberIds.includes(usableCanonicalPm.id)) memberIds.push(usableCanonicalPm.id);
      continue;
    }
    if (member.appId && member.appId !== appId) continue;
    if (!memberIds.includes(memberId)) memberIds.push(memberId);
  }
  const hasActiveAppMember = memberIds.some((memberId) => membersById.get(memberId)?.appId === appId);
  if (!hasActiveAppMember) return undefined;
  for (const memberId of requestedMemberIds) {
    const member = membersById.get(memberId);
    if (!member || member.disabled || member.source !== "human" || memberIds.includes(memberId)) continue;
    memberIds.push(memberId);
  }
  return {
    memberIds,
    adminMemberIds: defaultRoom
      ? defaultRoom.adminMemberIds.filter((memberId) => memberIds.includes(memberId))
      : usableCanonicalPm && memberIds.includes(usableCanonicalPm.id)
        ? [usableCanonicalPm.id]
        : [],
  };
}

function readRoomScope(value: unknown): AppRoomScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const appId = readOptionalString(input.appId);
  if (input.kind !== "app" || !appId) return undefined;
  const role = input.role === "default" || input.role === "group" ? input.role : undefined;
  return { kind: "app", appId, ...(role ? { role } : {}) };
}

async function handleDirectRoomRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = context;
  if (request.method !== "POST" || url.pathname !== "/rooms/dm") return false;
  const body = record(await readJsonBody(request));
  let memberId = readString(body.memberId);
  const requestedRoomId = readOptionalString(body.roomId);
  const requestedAppId = readOptionalString(body.appId);
  const mountedApp = requestedAppId ? resolveMountedAppTarget(state, requestedAppId) : undefined;
  if (requestedAppId && !mountedApp) {
    sendJson(response, 409, { ok: false, error: "app_not_mounted" });
    return true;
  }
  const appId = mountedApp?.id;
  let openedMember: RoomChannelMember | undefined;
  if (!state.app.rooms.listMembers().some((member) => member.id === memberId)) {
    const sourceMember = resolveDirectRoomMemberSource(state, memberId, body.member);
    if (sourceMember && sourceMember.source !== "human" && !sourceMember.disabled) {
      openedMember = state.app.rooms.upsertMember(sourceMember, { emitEvent: true });
      memberId = openedMember.id;
    }
  }
  const directMember = state.app.rooms.listMembers().find((member) => member.id === memberId);
  if (appId && directMember?.appId && directMember.appId !== appId) {
    sendJson(response, 409, { ok: false, error: "cross_app_member_forbidden" });
    return true;
  }
  const directRoomId = requestedRoomId || (appId ? appScopedDirectRoomId(appId, memberId) : `direct-${memberId}`);
  let room: RoomChannelRoom;
  try {
    room = state.app.rooms.openDirect({
      memberId,
      title: readString(body.title),
      id: appId || requestedRoomId ? directRoomId : undefined,
      scope: appId ? { kind: "app", appId, role: "direct" } : undefined,
    });
  } catch (error) {
    if (sendRoomMutationError(response, sendJson, error)) return true;
    throw error;
  }
  state.store.saveFrom(state.app);
  sendJson(response, 200, {
    ok: true,
    room,
    ...(openedMember ? { member: openedMember } : {}),
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}

async function handleRoomEventsRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson } = context;
  if (request.method !== "GET" || url.pathname !== "/rooms/events") return false;
  const afterEventSeq = readPositiveInt(url.searchParams.get("afterEventSeq"), 0);
  const limit = Math.min(readPositiveInt(url.searchParams.get("limit"), 200), 1_000);
  let result = state.app.rooms.eventsAfter(afterEventSeq, limit);
  const waitMs = readLongPollWaitMs(url);
  if (waitMs > 0 && !result.resetRequired && !result.hasMore && result.events.length === 0) {
    const rooms = state.app.rooms;
    const responseOpen = await waitForLongPoll(response, (signal) =>
      rooms.waitForEventsAfter(result.currentEventSeq, waitMs, signal),
    );
    if (!responseOpen) return true;
    result = state.app.rooms.eventsAfter(afterEventSeq, limit);
  }
  const supportsMessagePatches = readPositiveInt(url.searchParams.get("eventVersion"), 1) >= 2;
  sendJson(response, 200, {
    ok: true,
    ...result,
    longPollSupported: true,
    events: (supportsMessagePatches
      ? result.events
      : result.events.flatMap((event) => {
          if (event.type !== "room.message.updated" || !event.messageId || !event.payload.messagePatch) return [event];
          const message = state.app.rooms.getMessage(event.roomId, event.messageId);
          return message
            ? [{ ...event, schemaVersion: 1 as const, payload: { message } }]
            : // A later delete superseded this patch. Legacy clients cannot parse
              // v2 patches, so advance their cursor and let the delete event win.
              [];
        })
    ).map(presentRoomEvent),
  });
  return true;
}

async function handleRoomPatchRoute(context: RoomsRouteContext): Promise<boolean> {
  // Room administrator changes cross an authorization boundary. This local
  // route is intentionally available only behind the authenticated Host
  // bridge; untrusted Apps and agents do not receive its session credential.
  const { request, response, url, state, sendJson, readJsonBody } = context;
  const roomAction = url.pathname.match(/^\/rooms\/([^/]+)$/);
  if (!roomAction || request.method !== "PATCH") return false;
  const [, encodedRoomId] = roomAction;
  const body = record(await readJsonBody(request));
  const roomId = decodeURIComponent(encodedRoomId!);
  const archived = readOptionalBoolean(body.archived);
  if (
    archived === true &&
    state.app.rooms
      .listMessages(roomId, { limit: 0 })
      .some((message) => message.senderType === "agent" && message.status === "running")
  ) {
    sendJson(response, 409, { ok: false, error: "room_has_active_runs" });
    return true;
  }
  let room: RoomChannelRoom;
  try {
    room = state.app.rooms.patchRoom(roomId, {
      title: readOptionalString(body.title),
      generatedTitle: Object.prototype.hasOwnProperty.call(body, "generatedTitle")
        ? (readGeneratedRoomTitle(body.generatedTitle) ?? null)
        : Object.prototype.hasOwnProperty.call(body, "title")
          ? null
          : undefined,
      pinned: readOptionalBoolean(body.pinned),
      archived,
      badge: readOptionalString(body.badge),
      adminMemberIds: Object.prototype.hasOwnProperty.call(body, "adminMemberIds")
        ? readStringArray(body.adminMemberIds)
        : undefined,
    });
  } catch (error) {
    if (sendRoomMutationError(response, sendJson, error)) return true;
    throw error;
  }
  state.store.saveFrom(state.app);
  sendJson(response, 200, {
    ok: true,
    room,
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}

async function handleRoomReadRoute(context: RoomsRouteContext): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = context;
  const action = url.pathname.match(/^\/rooms\/([^/]+)\/read$/);
  if (!action || request.method !== "POST") return false;
  const roomId = decodeURIComponent(action[1]!);
  const body = record(await readJsonBody(request));
  const observedEventSeq = body.observedEventSeq;
  let room: RoomChannelRoom;
  try {
    room = state.app.rooms.markRoomRead(roomId, typeof observedEventSeq === "number" ? observedEventSeq : Number.NaN);
  } catch (error) {
    if (sendRoomMutationError(response, sendJson, error)) return true;
    throw error;
  }
  state.store.saveFrom(state.app);
  sendJson(response, 200, {
    ok: true,
    room,
    currentEventSeq: state.app.rooms.snapshot().currentEventSeq,
  });
  return true;
}

function readGeneratedRoomTitle(value: unknown): RoomChannelRoom["generatedTitle"] {
  const input = record(value);
  const sequence =
    typeof input.sequence === "number" && Number.isInteger(input.sequence) && input.sequence > 0 ? input.sequence : 0;
  if (input.kind === "numbered-group" && sequence) {
    return { kind: "numbered-group", sequence };
  }
  const appId = readString(input.appId);
  return input.kind === "app-group" && appId && sequence ? { kind: "app-group", appId, sequence } : undefined;
}

function sendRoomMutationError(
  response: RoomsRouteContext["response"],
  sendJson: RoomsRouteContext["sendJson"],
  error: unknown,
): boolean {
  const result = roomMutationErrorResponse(error);
  if (!result) return false;
  sendJson(response, result.status, { ok: false, error: result.error });
  return true;
}

function resolveDirectRoomMemberSource(
  state: RoomsRouteContext["state"],
  memberId: string,
  value: unknown,
): RoomChannelMember | undefined {
  const existing = state.app.rooms.listMembers().find((member) => member.id === memberId);
  if (existing) return existing;
  const raw = objectRecord(value);
  if (!raw) return undefined;
  try {
    return normalizeMember({
      ...raw,
      id: readString(raw.id) || memberId,
    });
  } catch {
    return undefined;
  }
}
