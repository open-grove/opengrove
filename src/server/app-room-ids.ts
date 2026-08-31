import type { RoomChannelRoom } from "../rooms/channel-store.js";

export function appScopedRoomComponent(value: string | undefined): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "default";
  // encodeURIComponent is injective once the punctuation it intentionally
  // leaves readable is escaped too. Room ids may be human-readable, but they
  // must never collapse distinct App identities such as `my.app` and `my-app`.
  return encodeURIComponent(normalized).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function defaultAppGroupRoomId(appId: string | undefined): string {
  if (!String(appId || "").trim()) return "";
  return `app-room--${appScopedRoomComponent(appId)}--group--default`;
}

export function findDefaultAppGroupRoom(rooms: readonly RoomChannelRoom[], appId: string): RoomChannelRoom | undefined {
  return rooms.find(
    (room) =>
      room.kind === "group" &&
      room.scope?.kind === "app" &&
      room.scope.appId === appId &&
      room.scope.role === "default",
  );
}
