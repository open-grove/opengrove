/** Supports: OpenGrove 0.7.0 stored auto-review before it selected a native reviewer.
 * Issue: https://github.com/open-grove/opengrove/issues/100
 * Remove when: direct upgrades from 0.7.0 are no longer supported.
 */
export function migrateStoredAccessModeV1(storage: Pick<Storage, "getItem" | "setItem">, key: string): void {
  const marker = `${key}.nativePresetsVersion`;
  if (storage.getItem(marker) === "1") return;
  if (storage.getItem(key) === "auto-review") storage.setItem(key, "default");
  storage.setItem(marker, "1");
}
