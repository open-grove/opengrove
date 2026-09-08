export type StoredFileDraft = { baseRevision: string; draft: string };
export type FileDraftRecovery = { draft?: StoredFileDraft; quarantined: boolean };
const DATABASE = "opengrove-file-drafts";
const STORE = "drafts";
const QUARANTINE = "quarantined-drafts";
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 2);
      let blocked = false;
      request.onupgradeneeded = () => {
        for (const name of [STORE, QUARANTINE]) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => {
        if (blocked) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error("file_draft_database_blocked"));
      };
    }).catch((error: unknown) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}

export async function readFileDraft(key: string): Promise<FileDraftRecovery> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    // Inspect and quarantine atomically: another writer must not replace the
    // record between validation and removal. Retain damaged text for recovery.
    const transaction = db.transaction([STORE, QUARANTINE], "readwrite", { durability: "strict" });
    const result: FileDraftRecovery = { quarantined: false };
    transaction.oncomplete = () => {
      if (result.quarantined) console.warn("[file-draft] invalid backup quarantined");
      resolve(result);
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("file_draft_recovery_aborted"));
    const store = transaction.objectStore(STORE);
    const request = store.get(key);
    request.onsuccess = () => {
      try {
        const value: unknown = request.result;
        if (value === undefined) return;
        if (isStoredFileDraft(value)) {
          result.draft = { baseRevision: value.baseRevision, draft: value.draft };
        } else {
          transaction.objectStore(QUARANTINE).put({ value, quarantinedAt: Date.now() }, key);
          store.delete(key);
          result.quarantined = true;
        }
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
  });
}

function isStoredFileDraft(value: unknown): value is StoredFileDraft {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "baseRevision" in value &&
    typeof value.baseRevision === "string" &&
    value.baseRevision.length > 0 &&
    "draft" in value &&
    typeof value.draft === "string"
  );
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
