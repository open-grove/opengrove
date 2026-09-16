import { isBridgeKernelId, type RoomChannelStore } from "../../rooms/channel-store.js";
import { normalizeEmployeeAccessMode } from "../employee-access-mode.js";

export const NATIVE_APPROVAL_PRESETS_VERSION = 4;

/**
 * Issue: https://github.com/open-grove/opengrove/issues/100
 * Supports: <=0.7.0 and unreleased approval migrations v1-v3. The product's one-time
 * update raises Ask to Auto for supported local Employees, including explicit Ask
 * choices, while retaining Full. Persisted overrides keep App seeds from undoing
 * the migration. The settings version gates this update; later Ask choices survive.
 * Remove when: direct upgrades from 0.7.0 move to a standalone importer.
 */
export function migrateNativeApprovalPresetsV4(
  rooms: RoomChannelStore,
  beforeApply?: () => void,
  claudeConfigHome?: string,
): boolean {
  const patches = rooms.listMembers().flatMap((member) => {
    if (member.source === "remote" || !isBridgeKernelId(member.kernel)) return [];
    const defaultMode = normalizeEmployeeAccessMode(member.kernel, undefined, member.model, claudeConfigHome);
    const supportsAuto = defaultMode === "auto-review";
    const normalized =
      member.accessMode === undefined
        ? defaultMode
        : normalizeEmployeeAccessMode(member.kernel, member.accessMode, member.model, claudeConfigHome);
    const accessMode = supportsAuto && normalized === "default" ? "auto-review" : normalized;
    const preserveSelection = supportsAuto || (member.accessMode !== undefined && accessMode !== member.accessMode);
    const userOverrides = preserveSelection
      ? [...new Set([...(member.userOverrides ?? []), "accessMode"])]
      : member.userOverrides;
    if (accessMode === member.accessMode && JSON.stringify(userOverrides) === JSON.stringify(member.userOverrides))
      return [];
    return [
      {
        ...member,
        accessMode,
        userOverrides,
      },
    ];
  });
  if (!patches.length) return false;
  beforeApply?.();
  for (const member of patches) rooms.upsertMember(member, { emitEvent: true });
  console.info("native_approval_presets_migrated", { version: 4, employeeCount: patches.length });
  return true;
}
