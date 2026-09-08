import { readLegacyFileDraft, removeLegacyFileDraft } from "./migrations/file-draft-local-storage-v1";

export type StoredFileDraft = { baseRevision: string; draft: string };
const DATABASE = "opengrove-file-drafts";
const STORE = "drafts";
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("file_draft_database_blocked"));
    }).catch((error: unknown) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}

export async function readFileDraft(key: string): Promise<StoredFileDraft | undefined> {
  const db = await openDatabase();
  const value = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (value !== undefined) {
    if (
      !value ||
      typeof value !== "object" ||
      !("baseRevision" in value) ||
      typeof value.baseRevision !== "string" ||
      !("draft" in value) ||
      typeof value.draft !== "string"
    )
      throw new Error("invalid_file_draft");
    removeLegacyFileDraft(key);
    return { baseRevision: value.baseRevision, draft: value.draft };
  }
  const legacy = readLegacyFileDraft(key);
  if (legacy) {
    await writeFileDraft(key, legacy);
    removeLegacyFileDraft(key);
  }
  return legacy;
}

export async function writeFileDraft(key: string, value?: StoredFileDraft): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    // Commit the revision and text together; request success alone is not durability.
    const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("file_draft_backup_aborted"));
    const store = transaction.objectStore(STORE);
    if (value) store.put(value, key);
    else store.delete(key);
  });
}
