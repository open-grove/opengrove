import { isBridgeKernelId, type RoomChannelStore } from "../../rooms/channel-store.js";
import { normalizeEmployeeAccessMode } from "../employee-access-mode.js";

export const NATIVE_APPROVAL_PRESETS_VERSION = 4;

/**
 * Issue: https://github.com/open-grove/opengrove/issues/100
 * Supports: <=0.7.0 and unreleased approval migrations v1-v3. The product's one-time
 * update raises Ask to Auto for supported local Employees, including explicit Ask
 * choices, while retaining Full. System changes never create user override markers.
 * Unchanged App declarations retain saved permissions; App updates can reapply defaults.
 * Remove when: direct upgrades from 0.7.0 move to a standalone importer.
 */
export function migrateNativeApprovalPresetsV4(rooms: RoomChannelStore, beforeApply?: () => void): boolean {
  const patches = rooms.listMembers().flatMap((member) => {
    if (member.source === "remote" || !isBridgeKernelId(member.kernel)) return [];
    const defaultMode = normalizeEmployeeAccessMode(member.kernel, undefined);
    const supportsAuto = defaultMode === "auto-review";
    const normalized =
      member.accessMode === undefined ? defaultMode : normalizeEmployeeAccessMode(member.kernel, member.accessMode);
    const accessMode = supportsAuto && normalized === "default" ? "auto-review" : normalized;
    if (accessMode === member.accessMode) return [];
    return [
      {
        ...member,
        accessMode,
      },
    ];
  });
  if (!patches.length) return false;
  beforeApply?.();
  for (const member of patches) rooms.upsertMember(member, { emitEvent: true });
  console.info("native_approval_presets_migrated", { version: 4, employeeCount: patches.length });
  return true;
}
