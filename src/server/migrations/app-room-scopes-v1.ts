import type { RoomChannelRoom } from "../../rooms/channel-store.js";
import type { PersistedAgentState } from "../../storage/json-state-store.js";

/**
 * Older App Room snapshots encoded App ownership in generated ids and member
 * records instead of storing an explicit Room scope. This migration recovers a
 * single unambiguous scope and archives conflicting Rooms rather than guessing.
 * Supports: OpenGrove <=0.6.3 Room snapshots written before App scope became explicit.
 * Remove when: the standalone legacy importer owns upgrades from OpenGrove <=0.6.3.
 */
export function migrateAppRoomScopesV1(input: PersistedAgentState): {
  state: PersistedAgentState;
  changed: boolean;
  migratedRoomIds: string[];
  quarantinedRoomIds: string[];
} {
  const membersById = new Map(input.rooms.members.map((member) => [member.id, member]));
  const migratedRoomIds: string[] = [];
  const quarantinedRoomIds: string[] = [];
  const rooms = input.rooms.rooms.map((room) => {
    if (room.scope || !isLegacyAppRoomId(room.id)) return room;
    const memberAppIds = new Set(
      room.memberIds.flatMap((memberId) => {
        const appId = membersById.get(memberId)?.appId?.trim();
        return appId ? [appId] : [];
      }),
    );
    if (memberAppIds.size > 1) {
      if (room.archived) return room;
      quarantinedRoomIds.push(room.id);
      return { ...room, archived: true };
    }
    const generatedAppId = room.generatedTitle?.kind === "app-group" ? room.generatedTitle.appId.trim() : "";
    const memberAppId = [...memberAppIds][0] ?? "";
    if (generatedAppId && memberAppId && generatedAppId !== memberAppId) {
      if (room.archived) return room;
      quarantinedRoomIds.push(room.id);
      return { ...room, archived: true };
    }
    const appId = generatedAppId || memberAppId;
    if (!appId) return room;
    migratedRoomIds.push(room.id);
    const scope: NonNullable<RoomChannelRoom["scope"]> = {
      kind: "app",
      appId,
      role: legacyAppRoomRole(room),
    };
    return {
      ...room,
      scope,
    };
  });
  const changed = migratedRoomIds.length > 0 || quarantinedRoomIds.length > 0;
  if (!changed) return { state: input, changed, migratedRoomIds, quarantinedRoomIds };
  return {
    state: {
      ...input,
      rooms: {
        ...input.rooms,
        rooms,
      },
    },
    changed,
    migratedRoomIds,
    quarantinedRoomIds,
  };
}

function isLegacyAppRoomId(roomId: string): boolean {
  return roomId.startsWith("app-room--") && (roomId.includes("--group--") || roomId.includes("--direct--"));
}

function legacyAppRoomRole(room: RoomChannelRoom): "default" | "group" | "direct" {
  if (room.kind === "direct" || room.id.includes("--direct--")) return "direct";
  if (room.id.endsWith("--group--default")) return "default";
  return room.generatedTitle?.kind === "app-group" && room.generatedTitle.sequence === 1 ? "default" : "group";
}
