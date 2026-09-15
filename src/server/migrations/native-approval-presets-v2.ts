import { isBridgeKernelId, type RoomChannelStore } from "../../rooms/channel-store.js";
import { resolveRuntimeAccessModeSelection } from "../../runtime-access.js";

export const NATIVE_APPROVAL_PRESETS_VERSION = 2;

/**
 * Issue: https://github.com/open-grove/opengrove/issues/100
 * Supports: <=0.7.0 and the unreleased v1 approval migration. Product policy now starts
 * all local Employees at full access once, including prior explicit ask selections.
 * OpenClaw remains Gateway-managed; remote Employees retain their owner's permissions.
 * Remove when: direct upgrades from 0.7.0 move to a standalone importer. Overrides prevent seed sync
 * from undoing the migration; the persisted version preserves subsequent user choices.
 */
export function migrateNativeApprovalPresetsV2(rooms: RoomChannelStore, beforeApply?: () => void): boolean {
  const members = rooms
    .listMembers()
    .filter(
      (member) =>
        member.source !== "remote" &&
        isBridgeKernelId(member.kernel) &&
        (member.accessMode !== resolveRuntimeAccessModeSelection(member.kernel, "full-access") ||
          !member.userOverrides?.includes("accessMode")),
    );
  if (!members.length) return false;
  beforeApply?.();
  for (const member of members) {
    rooms.upsertMember(
      {
        ...member,
        accessMode: resolveRuntimeAccessModeSelection(member.kernel, "full-access"),
        userOverrides: [...new Set([...(member.userOverrides ?? []), "accessMode"])],
      },
      { emitEvent: true },
    );
  }
  console.info("native_approval_presets_migrated", { version: 2, employeeCount: members.length });
  return true;
}
