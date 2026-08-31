import { APP_STORAGE_KEYS } from "../../identity";
import type { AccountProfile } from "../account-profile-store";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/581
 * Supports: OpenGrove <=0.6.1 account profiles stored in localStorage before the IndexedDB store shipped.
 * Remove when: OpenGrove 0.7.0 requires direct upgrades from >=0.6.2; older backups move to the standalone importer.
 */
export async function migrateAccountProfilesFromLocalStorageV1(
  database: IDBDatabase,
  storeName: string,
  localUserId: string,
): Promise<void> {
  const raw = localStorage.getItem(APP_STORAGE_KEYS.accountProfiles);
  if (!raw) return;
  let profiles: AccountProfile[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("legacy_account_profiles_invalid");
    }
    profiles = Object.entries(parsed).map(([rawUserId, rawProfile]): AccountProfile => {
      const userId = rawUserId === "anonymous" ? localUserId : rawUserId.trim();
      if (!userId || !rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
        throw new Error("legacy_account_profile_invalid");
      }
      const profile = rawProfile as Record<string, unknown>;
      const username = typeof profile.username === "string" ? profile.username : undefined;
      const avatarUrl = typeof profile.avatarDataUrl === "string" ? profile.avatarDataUrl : undefined;
      return {
        userId,
        ...(username ? { username } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  } catch (error) {
    quarantineLegacyProfiles(raw);
    console.warn("legacy_account_profiles_quarantined", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (profiles.length) {
    await writeProfiles(database, storeName, profiles);
  }
  quarantineLegacyProfiles(raw);
}

function quarantineLegacyProfiles(raw: string): void {
  const backupKey = `${APP_STORAGE_KEYS.accountProfiles}:pre-indexeddb-v1`;
  try {
    localStorage.setItem(backupKey, raw);
    localStorage.removeItem(APP_STORAGE_KEYS.accountProfiles);
    return;
  } catch {
    // A stale backup can consume the space needed by its replacement. Keep the
    // active source until the replacement backup is safely stored.
    try {
      localStorage.removeItem(backupKey);
      localStorage.setItem(backupKey, raw);
      localStorage.removeItem(APP_STORAGE_KEYS.accountProfiles);
    } catch (error) {
      console.warn("legacy_account_profiles_backup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function writeProfiles(database: IDBDatabase, storeName: string, profiles: AccountProfile[]): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite");
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("legacy_account_profile_write_failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("legacy_account_profile_write_aborted"));
    const store = transaction.objectStore(storeName);
    for (const profile of profiles) store.put(profile);
  });
}
