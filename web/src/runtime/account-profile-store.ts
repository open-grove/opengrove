import type { ClientBootstrap } from "@opengrove/agent-protocol";
import { translate } from "../i18n";
import { migrateAccountProfilesFromLocalStorageV1 } from "./migrations/account-profile-local-storage-v1";

export interface AccountProfile {
  userId: string;
  username?: string;
  avatarUrl?: string;
  updatedAt: string;
}

const DATABASE_NAME = "opengrove-user-profiles";
const STORE_NAME = "profiles";
const DATABASE_VERSION = 1;
export const LOCAL_ACCOUNT_PROFILE_USER_ID = "local-user";

let databasePromise: Promise<IDBDatabase> | undefined;
let profileMigrationPromise: Promise<void> | undefined;

export function resolveAccountProfileUserId(
  userId: string | undefined,
  preset: ClientBootstrap["environment"]["preset"],
): string | undefined {
  const authenticatedUserId = userId?.trim();
  if (authenticatedUserId) return authenticatedUserId;
  return preset === "local-single" ? LOCAL_ACCOUNT_PROFILE_USER_ID : undefined;
}

export async function readAccountProfile(userId: string): Promise<AccountProfile | undefined> {
  const key = requireUserId(userId);
  const database = await openDatabase();
  await ensureAccountProfileMigration(database);
  return normalizeStoredProfile(
    await requestResult<unknown>(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(key)),
  );
}

export async function writeAccountProfile(
  userId: string,
  profile: Pick<AccountProfile, "username" | "avatarUrl">,
): Promise<AccountProfile> {
  const key = requireUserId(userId);
  const value: AccountProfile = {
    userId: key,
    ...(profile.username ? { username: profile.username } : {}),
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
    updatedAt: new Date().toISOString(),
  };
  const database = await openDatabase();
  await ensureAccountProfileMigration(database);
  await transactionComplete(database.transaction(STORE_NAME, "readwrite"), (store) => store.put(value));
  return value;
}

function requireUserId(userId: string): string {
  const key = userId.trim();
  if (!key || key === "anonymous") throw new Error(translate("runtime.accountMissingUserId"));
  return key;
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "userId" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
        profileMigrationPromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error ?? new Error(translate("runtime.profileDbOpenFailed")));
    };
  });
  return databasePromise;
}

function ensureAccountProfileMigration(database: IDBDatabase): Promise<void> {
  if (!profileMigrationPromise) {
    profileMigrationPromise = migrateAccountProfilesFromLocalStorageV1(
      database,
      STORE_NAME,
      LOCAL_ACCOUNT_PROFILE_USER_ID,
    ).catch((error: unknown) => {
      profileMigrationPromise = undefined;
      throw error;
    });
  }
  return profileMigrationPromise;
}

function normalizeStoredProfile(value: unknown): AccountProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const profile = value as Partial<AccountProfile>;
  const userId = typeof profile.userId === "string" ? profile.userId.trim() : "";
  const updatedAt = typeof profile.updatedAt === "string" ? profile.updatedAt : "";
  if (!userId || !updatedAt) return undefined;
  const username = typeof profile.username === "string" ? profile.username : undefined;
  const avatarUrl = typeof profile.avatarUrl === "string" ? profile.avatarUrl : undefined;
  return {
    userId,
    ...(username ? { username } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    updatedAt,
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(translate("runtime.profileReadFailed")));
  });
}

function transactionComplete(transaction: IDBTransaction, mutate: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(translate("runtime.profileWriteFailed")));
    transaction.onabort = () => reject(transaction.error ?? new Error(translate("runtime.profileWriteAborted")));
    mutate(transaction.objectStore(STORE_NAME));
  });
}
