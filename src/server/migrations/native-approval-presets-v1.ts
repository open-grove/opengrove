import type { RoomChannelStore } from "../../rooms/channel-store.js";

export const NATIVE_APPROVAL_PRESETS_VERSION = 1;

/**
 * Issue: https://github.com/open-grove/opengrove/issues/100
 * Supports: upgrades from <=0.7.0, where auto-review did not activate native reviewers.
 * Remove when: direct upgrades from 0.7.0 move to a standalone importer. Persist an accessMode override
 * so App seed synchronization cannot silently re-enable the new authorization behavior.
 */
export function migrateNativeApprovalPresetsV1(rooms: RoomChannelStore, beforeApply?: () => void): boolean {
  const members = rooms.listMembers().filter((member) => member.accessMode === "auto-review");
  if (!members.length) return false;
  beforeApply?.();
  for (const member of members) {
    rooms.upsertMember(
      {
        ...member,
        accessMode: "default",
        userOverrides: [...new Set([...(member.userOverrides ?? []), "accessMode"])],
      },
      { emitEvent: true },
    );
  }
  console.info("native_approval_presets_migrated", { resetEmployeeCount: members.length });
  return true;
}
