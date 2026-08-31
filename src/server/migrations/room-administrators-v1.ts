import type { RoomChannelRoom } from "../../rooms/channel-store.js";
import { isLegacyRoomPmMember } from "../../rooms/room-pm.js";
import type { PersistedAgentState } from "../../storage/json-state-store.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/581
 * Supports: OpenGrove <=0.6.1 Room snapshots created before adminMemberIds was required.
 * Remove when: OpenGrove 0.7.0 requires direct upgrades from >=0.6.2; older backups move to the standalone importer.
 */
export function migrateRoomAdministratorsV1(input: PersistedAgentState): {
  state: PersistedAgentState;
  changed: boolean;
  migratedRoomIds: string[];
} {
  const membersById = new Map(input.rooms.members.map((member) => [member.id, member]));
  const migratedRoomIds: string[] = [];
  const rooms = input.rooms.rooms.map((room) => {
    if (Object.prototype.hasOwnProperty.call(room, "adminMemberIds")) return room;
    migratedRoomIds.push(room.id);
    return migrateRoom(room, membersById);
  });
  if (!migratedRoomIds.length) {
    return { state: input, changed: false, migratedRoomIds };
  }
  return {
    state: {
      ...input,
      rooms: {
        ...input.rooms,
        rooms,
      },
    },
    changed: true,
    migratedRoomIds,
  };
}

function migrateRoom(
  room: RoomChannelRoom,
  membersById: ReadonlyMap<string, PersistedAgentState["rooms"]["members"][number]>,
): RoomChannelRoom {
  if (room.kind === "direct") return { ...room, adminMemberIds: [] };

  const pmMemberIds = room.memberIds.filter((memberId) => {
    const member = membersById.get(memberId);
    return member ? isLegacyRoomPmMember(member) : false;
  });
  if (pmMemberIds.length) return { ...room, adminMemberIds: pmMemberIds };
  // Format migration must not inject a product employee. At this startup
  // stage mounted Apps have not finished seeding, so a missing App PM cannot
  // be distinguished from a genuinely administrator-free legacy Room. The
  // post-seed consistency pass repairs mounted-App Rooms with complete data.
  return { ...room, adminMemberIds: [] };
}
