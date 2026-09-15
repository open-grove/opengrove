/** Supports: OpenGrove <=0.7.0 and the unreleased v1 approval migration.
 * Issue: https://github.com/open-grove/opengrove/issues/100
 * Remove when: direct upgrades from 0.7.0 are no longer supported.
 */
export function migrateStoredAccessModeV2(storage: Pick<Storage, "getItem" | "setItem">, key: string): void {
  const marker = `${key}.nativePresetsVersion`;
  if (storage.getItem(marker) === "2") return;
  storage.setItem(key, "full-access");
  storage.setItem(marker, "2");
}
