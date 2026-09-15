import { isBridgeKernelId, type RoomChannelStore } from "../../rooms/channel-store.js";
import { normalizeEmployeeAccessMode } from "../employee-access-mode.js";

export const NATIVE_APPROVAL_PRESETS_VERSION = 3;

/**
 * Issue: https://github.com/open-grove/opengrove/issues/100
 * Supports: <=0.7.0 and unreleased approval migrations v1/v2. Preserve compatible
 * saved choices; only fill missing modes or repair unsupported kernel combinations.
 * PM defaults are applied by product seed sync, which respects user overrides.
 * Remove when: direct upgrades from 0.7.0 move to a standalone importer.
 */
export function migrateNativeApprovalPresetsV3(
  rooms: RoomChannelStore,
  beforeApply?: () => void,
  claudeConfigHome?: string,
): boolean {
  const patches = rooms.listMembers().flatMap((member) => {
    if (member.source === "remote" || !isBridgeKernelId(member.kernel)) return [];
    const accessMode = normalizeEmployeeAccessMode(member.kernel, member.accessMode, member.model, claudeConfigHome);
    if (accessMode === member.accessMode) return [];
    return [
      {
        ...member,
        accessMode,
        // Repairing an explicit unsupported choice must survive later seed synchronization.
        userOverrides:
          member.accessMode === undefined
            ? member.userOverrides
            : [...new Set([...(member.userOverrides ?? []), "accessMode"])],
      },
    ];
  });
  if (!patches.length) return false;
  beforeApply?.();
  for (const member of patches) rooms.upsertMember(member, { emitEvent: true });
  console.info("native_approval_presets_migrated", { version: 3, employeeCount: patches.length });
  return true;
}
