import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ContentBlobStore, type ContentBlobMetadata } from "./content-blob-store.js";
import { defaultOpenGroveStatePath } from "./default-data-dir.js";
import {
  normalizePersistedAgentState,
  restorePersistedAgentState,
  snapshotPersistedAgentState,
  type AgentFileCleanupResult,
  type AgentDiagnosticArchive,
  type AgentDiagnosticArchiveScope,
  type AgentStateStore,
  type AgentStorageCategoryStats,
  type AgentStorageCleanupResult,
  type AgentStorageStats,
  type PersistableAgentStatePorts,
  type PersistedAgentState,
  type PersistedStateLoadOptions,
} from "./json-state-store.js";
import { migrateLegacyJsonToSqliteV1 } from "./migrations/sqlite-json-v1.js";
import { acquireStateFileLock, type StateFileLock } from "./state-file-lock.js";
import { canonicalizeStatePath } from "./state-identity.js";

const SCHEMA_VERSION = 1;
const HOT_AGENT_EVENT_LIMIT = 5_000;
const HOT_EXECUTION_LIMIT = 5_000;
const HOT_ROOM_EVENT_LIMIT = 5_000;

type CollectionName =
  | "knowledge"
  | "knowledge_evidence"
  | "knowledge_revisions"
  | "knowledge_deliveries"
  | "knowledge_feedback"
  | "memory"
  | "artifacts"
  | "working_state"
  | "approvals"
  | "questions"
  | "agent_events"
  | "routines"
  | "sessions"
  | "runs"
  | "executions"
  | "room_rooms"
  | "room_members"
  | "room_messages"
  | "room_events"
  | "room_deleted_member_ids";

interface CollectionSpec {
  name: CollectionName;
  values(state: PersistedAgentState): unknown[];
  key(value: unknown, index: number): string;
  appendOnly?: boolean;
}

interface StateRecordRow {
  record_key: string;
  position: number;
  source_stamp: string;
  scope_run_id: string | null;
  scope_room_id: string | null;
}

interface MetaRow {
  value: string;
}

interface ArchiveRecordIdentity {
  recordKey: string;
  position: number;
}

export interface SqliteStateStoreOptions {
  blobThresholdBytes?: number;
}

export type SqliteStateStore = AgentStateStore & { readonly kind: "sqlite" };

const COLLECTIONS: CollectionSpec[] = [
  spec("knowledge", (state) => state.knowledge),
  spec("knowledge_evidence", (state) => state.knowledgeEvidence),
  spec("knowledge_revisions", (state) => state.knowledgeRevisions),
  spec("knowledge_deliveries", (state) => state.knowledgeDeliveries),
  spec("knowledge_feedback", (state) => state.knowledgeFeedback),
  spec("memory", (state) => state.memory),
  spec("artifacts", (state) => state.artifacts),
  spec(
    "working_state",
    (state) => [state.workingState],
    () => "current",
  ),
  spec("approvals", (state) => state.approvals),
  spec("questions", (state) => state.questions),
  spec(
    "agent_events",
    (state) => state.events,
    (_value, index) => String(index),
    true,
  ),
  spec("routines", (state) => state.routines),
  spec("sessions", (state) => state.sessions),
  spec("runs", (state) => state.runs),
  spec("executions", (state) => state.executions, idKey, true),
  spec("room_rooms", (state) => state.rooms.rooms),
  spec("room_members", (state) => state.rooms.members),
  spec("room_messages", (state) => state.rooms.messages),
  spec("room_events", (state) => state.rooms.events, eventSequenceKey, true),
  spec("room_deleted_member_ids", (state) => state.rooms.deletedMemberIds ?? [], stringValueKey),
];

export function createSqliteStateStore(
  requestedPath = defaultOpenGroveStatePath(),
  options: SqliteStateStoreOptions = {},
): SqliteStateStore {
  const paths = resolveStatePaths(requestedPath);
  const databasePath = canonicalizeStatePath(paths.databasePath);
  const legacyPath = canonicalizeStatePath(paths.legacyPath);
  const databaseLock = acquireStateFileLock(databasePath);
  let legacyLock: StateFileLock | undefined;
  let database: DatabaseSync | undefined;
  try {
    // Keep the legacy JSON lock held too. This prevents an older OpenGrove bridge
    // from starting against the pre-migration path during a rolling desktop update.
    if (legacyPath !== databasePath) legacyLock = acquireStateFileLock(legacyPath);
    database = new DatabaseSync(databasePath);
    initializeSchema(database);
    const agentEventArchive = new AgentEventArchiveIndex(database);
    const blobs = new ContentBlobStore(join(dirname(databasePath), "state-blobs"), {
      thresholdBytes: options.blobThresholdBytes,
    });
    migrateLegacyJsonToSqliteV1({
      database,
      databasePath,
      legacyPath,
      readMeta: (key) => readMeta(database!, key),
      loadState: () => loadState(database!, blobs, agentEventArchive),
      persistState: (state, metadata, persistOptions) => {
        persistState(database!, blobs, state, agentEventArchive, metadata, persistOptions);
      },
    });

    let closed = false;
    return {
      path: databasePath,
      kind: "sqlite",
      loadInto(app, loadOptions) {
        configureHotStateRetention(app);
        const state = loadState(database!, blobs, agentEventArchive, loadOptions);
        if (!state) return undefined;
        restorePersistedAgentState(app, state);
        return state;
      },
      restoreSnapshotInto(app, state, loadOptions) {
        configureHotStateRetention(app);
        const normalized = normalizePersistedAgentState(state, loadOptions);
        restorePersistedAgentState(app, normalized);
        return normalized;
      },
      saveFrom(app) {
        // SQLite is the durable archive. In-memory consumers may keep a bounded
        // delivery window, but persistence must not drop token, tool, execution,
        // or Room event history.
        const state = snapshotPersistedAgentState(app, { compactVolatile: false });
        persistState(database!, blobs, state, agentEventArchive);
        return state;
      },
      saveSnapshot(state) {
        persistState(database!, blobs, state, agentEventArchive);
        return state;
      },
      storageStats() {
        return readStorageStats(database!, blobs, databasePath, legacyPath);
      },
      cleanupOrphanedBlobs() {
        return cleanupOrphanedBlobs(database!, blobs);
      },
      deleteRoomEvents(eventSeqs) {
        return deleteRoomEvents(database!, eventSeqs);
      },
      clearRoomEventArchive() {
        return clearRoomEventArchive(database!);
      },
      clearRuntimeEventArchive() {
        return clearRuntimeEventArchive(database!);
      },
      clearMigrationBackups() {
        return clearMigrationBackups(databasePath, legacyPath);
      },
      readDiagnosticArchive(scope) {
        return readDiagnosticArchive(database!, blobs, scope);
      },
      async flush() {
        database!.exec("PRAGMA wal_checkpoint(PASSIVE)");
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          try {
            database!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } finally {
            database!.close();
          }
        } finally {
          legacyLock?.release();
          databaseLock.release();
        }
      },
    };
  } catch (error) {
    try {
      database?.close();
    } finally {
      legacyLock?.release();
      databaseLock.release();
    }
    throw error;
  }
}

function configureHotStateRetention(app: PersistableAgentStatePorts): void {
  app.events.setRetentionLimit?.(HOT_AGENT_EVENT_LIMIT);
  app.executions.setRetentionLimit?.(HOT_EXECUTION_LIMIT);
}

function initializeSchema(database: DatabaseSync): void {
  const userVersion = Number(
    (database.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0,
  );
  if (userVersion > SCHEMA_VERSION) {
    throw new Error(`state_schema_too_new: expected <=${SCHEMA_VERSION}, got ${userVersion}`);
  }
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  if (userVersion === 0) migrateSchemaFrom0To1(database);
  ensureDiagnosticScopeColumns(database);
}

function migrateSchemaFrom0To1(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS state_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS state_records (
      collection TEXT NOT NULL,
      record_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL,
      source_stamp TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection, record_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS state_records_order
      ON state_records (collection, position, record_key);
    CREATE TABLE IF NOT EXISTS state_blobs (
      hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      stored_size INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS state_blob_refs (
      collection TEXT NOT NULL,
      record_key TEXT NOT NULL,
      hash TEXT NOT NULL REFERENCES state_blobs(hash),
      PRIMARY KEY (collection, record_key, hash),
      FOREIGN KEY (collection, record_key)
        REFERENCES state_records(collection, record_key) ON DELETE CASCADE
    ) STRICT;
    PRAGMA user_version = 1;
    COMMIT;
  `);
}

function ensureDiagnosticScopeColumns(database: DatabaseSync): void {
  const columns = stateRecordColumnNames(database);
  const indexes = stateRecordIndexNames(database);
  if (
    columns.has("scope_run_id") &&
    columns.has("scope_room_id") &&
    indexes.has("state_records_run_scope") &&
    indexes.has("state_records_room_scope")
  )
    return;

  database.exec("BEGIN IMMEDIATE");
  try {
    const lockedColumns = stateRecordColumnNames(database);
    if (!lockedColumns.has("scope_run_id")) database.exec("ALTER TABLE state_records ADD COLUMN scope_run_id TEXT");
    if (!lockedColumns.has("scope_room_id")) database.exec("ALTER TABLE state_records ADD COLUMN scope_room_id TEXT");
    database.exec(`
      CREATE INDEX IF NOT EXISTS state_records_run_scope
        ON state_records (collection, scope_run_id, position, record_key)
        WHERE scope_run_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS state_records_room_scope
        ON state_records (collection, scope_room_id, position, record_key)
        WHERE scope_room_id IS NOT NULL;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function stateRecordColumnNames(database: DatabaseSync): Set<string> {
  return new Set(
    (database.prepare("PRAGMA table_info(state_records)").all() as unknown as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
}

function stateRecordIndexNames(database: DatabaseSync): Set<string> {
  return new Set(
    (database.prepare("PRAGMA index_list(state_records)").all() as unknown as Array<{ name: string }>).map(
      (index) => index.name,
    ),
  );
}

function persistState(
  database: DatabaseSync,
  blobs: ContentBlobStore,
  state: PersistedAgentState,
  agentEventArchive: AgentEventArchiveIndex,
  extraMeta: Record<string, string> = {},
  options: { replaceExisting?: boolean } = {},
): void {
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    if (options.replaceExisting) database.exec("DELETE FROM state_records");
    for (const collection of COLLECTIONS) {
      syncCollection(database, blobs, collection, state, now, agentEventArchive);
    }
    setMeta(database, "schema_version", String(SCHEMA_VERSION));
    setMeta(database, "state_version", String(state.version));
    setMeta(database, "saved_at", state.savedAt);
    setMeta(database, "room_current_event_seq", String(state.rooms.currentEventSeq));
    for (const [key, value] of Object.entries(extraMeta)) setMeta(database, key, value);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function syncCollection(
  database: DatabaseSync,
  blobs: ContentBlobStore,
  collection: CollectionSpec,
  state: PersistedAgentState,
  now: string,
  agentEventArchive: AgentEventArchiveIndex,
): void {
  const values = collection.values(state);
  const identities =
    collection.name === "agent_events"
      ? agentEventArchive.identitiesFor(values)
      : values.map(
          (value, index): ArchiveRecordIdentity => ({
            recordKey: collection.key(value, index),
            position:
              collection.name === "room_events"
                ? numericEventSequence(value, index)
                : collection.name === "executions"
                  ? executionArchivePosition(value, index)
                  : index,
          }),
        );
  const existingRows = collection.appendOnly
    ? readExistingAppendOnlyRows(
        database,
        collection.name,
        identities.map((identity) => identity.recordKey),
      )
    : (database
        .prepare(
          "SELECT record_key, position, source_stamp, scope_run_id, scope_room_id FROM state_records WHERE collection = ?",
        )
        .all(collection.name) as unknown as StateRecordRow[]);
  const existing = new Map(existingRows.map((row) => [row.record_key, row]));
  const retained = new Set<string>();
  const upsertRecord = database.prepare(`
    INSERT INTO state_records (
      collection, record_key, position, payload, source_stamp, updated_at, scope_run_id, scope_room_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(collection, record_key) DO UPDATE SET
      position = excluded.position,
      payload = excluded.payload,
      source_stamp = excluded.source_stamp,
      updated_at = excluded.updated_at,
      scope_run_id = excluded.scope_run_id,
      scope_room_id = excluded.scope_room_id
  `);
  const updateRecordScope = database.prepare(`
    UPDATE state_records SET scope_run_id = ?, scope_room_id = ?
    WHERE collection = ? AND record_key = ?
  `);
  const deleteBlobRefs = database.prepare("DELETE FROM state_blob_refs WHERE collection = ? AND record_key = ?");

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const { recordKey, position } = identities[index]!;
    retained.add(recordKey);
    const previous = existing.get(recordKey);
    const sourceStamp = recordSourceStamp(collection.name, value, recordKey);
    const scope = diagnosticRecordScope(collection.name, value);
    if (sourceStamp && previous?.source_stamp === sourceStamp && previous.position === position) {
      if (previous.scope_run_id !== scope.runId || previous.scope_room_id !== scope.roomId) {
        updateRecordScope.run(scope.runId, scope.roomId, collection.name, recordKey);
      }
      continue;
    }
    const encoded = blobs.encode(value);
    upsertRecord.run(
      collection.name,
      recordKey,
      position,
      encoded.payload,
      sourceStamp,
      now,
      scope.runId,
      scope.roomId,
    );
    deleteBlobRefs.run(collection.name, recordKey);
    for (const blob of encoded.blobs) upsertBlobReference(database, collection.name, recordKey, blob, now);
  }

  if (!collection.appendOnly) {
    const remove = database.prepare("DELETE FROM state_records WHERE collection = ? AND record_key = ?");
    for (const row of existingRows) {
      if (!retained.has(row.record_key)) remove.run(collection.name, row.record_key);
    }
  }
}

function readExistingAppendOnlyRows(
  database: DatabaseSync,
  collection: CollectionName,
  keys: string[],
): StateRecordRow[] {
  const rows: StateRecordRow[] = [];
  const chunkSize = 400;
  for (let offset = 0; offset < keys.length; offset += chunkSize) {
    const chunk = keys.slice(offset, offset + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(
      ...(database
        .prepare(`
      SELECT record_key, position, source_stamp, scope_run_id, scope_room_id FROM state_records
      WHERE collection = ? AND record_key IN (${placeholders})
    `)
        .all(collection, ...chunk) as unknown as StateRecordRow[]),
    );
  }
  return rows;
}

function upsertBlobReference(
  database: DatabaseSync,
  collection: CollectionName,
  recordKey: string,
  blob: ContentBlobMetadata,
  now: string,
): void {
  database
    .prepare(`
    INSERT INTO state_blobs (hash, kind, byte_size, stored_size, relative_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO NOTHING
  `)
    .run(blob.hash, blob.kind, blob.byteSize, blob.storedSize, blob.relativePath, now);
  database
    .prepare(`
    INSERT INTO state_blob_refs (collection, record_key, hash)
    VALUES (?, ?, ?)
    ON CONFLICT(collection, record_key, hash) DO NOTHING
  `)
    .run(collection, recordKey, blob.hash);
}

function loadState(
  database: DatabaseSync,
  blobs: ContentBlobStore,
  agentEventArchive: AgentEventArchiveIndex,
  loadOptions: PersistedStateLoadOptions = {},
): PersistedAgentState | undefined {
  if (!readMeta(database, "state_version")) return undefined;
  const state = normalizePersistedAgentState(
    {
      savedAt: readMeta(database, "saved_at"),
      knowledge: readCollection(database, blobs, "knowledge"),
      knowledgeEvidence: readCollection(database, blobs, "knowledge_evidence"),
      knowledgeRevisions: readCollection(database, blobs, "knowledge_revisions"),
      knowledgeDeliveries: readCollection(database, blobs, "knowledge_deliveries"),
      knowledgeFeedback: readCollection(database, blobs, "knowledge_feedback"),
      memory: readCollection(database, blobs, "memory"),
      artifacts: readCollection(database, blobs, "artifacts"),
      workingState: readCollection(database, blobs, "working_state")[0],
      approvals: readCollection(database, blobs, "approvals"),
      questions: readCollection(database, blobs, "questions"),
      events: readAgentEventTail(database, blobs, agentEventArchive),
      routines: readCollection(database, blobs, "routines"),
      sessions: readCollection(database, blobs, "sessions"),
      runs: readCollection(database, blobs, "runs"),
      executions: readExecutionTail(database, blobs),
      rooms: {
        version: 1,
        currentEventSeq: Number(readMeta(database, "room_current_event_seq") ?? "0"),
        rooms: readCollection(database, blobs, "room_rooms"),
        members: readCollection(database, blobs, "room_members"),
        messages: readCollection(database, blobs, "room_messages"),
        events: readRoomEventTail(database, blobs),
        deletedMemberIds: readCollection(database, blobs, "room_deleted_member_ids"),
      },
    },
    loadOptions,
  );
  return state;
}

function readCollection(database: DatabaseSync, blobs: ContentBlobStore, collection: CollectionName): unknown[] {
  const rows = database
    .prepare(`
    SELECT payload FROM state_records
    WHERE collection = ?
    ORDER BY position ASC, record_key ASC
  `)
    .all(collection) as unknown as Array<{ payload: string }>;
  return rows.map((row) => blobs.decode(row.payload));
}

function readRoomEventTail(database: DatabaseSync, blobs: ContentBlobStore): unknown[] {
  const rows = database
    .prepare(`
    SELECT payload FROM (
      SELECT record_key, position, payload FROM state_records
      WHERE collection = 'room_events'
      ORDER BY position DESC, record_key DESC
      LIMIT ?
    ) ORDER BY position ASC, record_key ASC
  `)
    .all(HOT_ROOM_EVENT_LIMIT) as unknown as Array<{ payload: string }>;
  return rows.map((row) => blobs.decode(row.payload));
}

function readAgentEventTail(
  database: DatabaseSync,
  blobs: ContentBlobStore,
  agentEventArchive: AgentEventArchiveIndex,
): unknown[] {
  const rows = database
    .prepare(`
    SELECT record_key, position, payload FROM (
      SELECT record_key, position, payload FROM state_records
      WHERE collection = 'agent_events'
      ORDER BY position DESC, record_key DESC
      LIMIT ?
    ) ORDER BY position ASC, record_key ASC
  `)
    .all(HOT_AGENT_EVENT_LIMIT) as unknown as Array<{ record_key: string; position: number; payload: string }>;
  return rows.map((row) => {
    const value = blobs.decode(row.payload);
    agentEventArchive.register(value, { recordKey: row.record_key, position: Number(row.position) });
    return value;
  });
}

function readExecutionTail(database: DatabaseSync, blobs: ContentBlobStore): unknown[] {
  const rows = database
    .prepare(`
    SELECT payload FROM (
      SELECT record_key, position, payload FROM state_records
      WHERE collection = 'executions'
      ORDER BY position ASC, record_key ASC
      LIMIT ?
    ) ORDER BY position DESC, record_key DESC
  `)
    .all(HOT_EXECUTION_LIMIT) as unknown as Array<{ payload: string }>;
  return rows.map((row) => blobs.decode(row.payload));
}

function readDiagnosticArchive(
  database: DatabaseSync,
  blobs: ContentBlobStore,
  scope: AgentDiagnosticArchiveScope,
): AgentDiagnosticArchive {
  const runIds = new Set(scope.runIds);
  const events = readDiagnosticCollection(
    database,
    blobs,
    "agent_events",
    {
      field: "runId",
      values: runIds,
    },
    (value) => isRecord(value) && typeof value.runId === "string" && runIds.has(value.runId),
  );
  const executions = readDiagnosticCollection(
    database,
    blobs,
    "executions",
    {
      field: "runId",
      values: runIds,
    },
    (value) => isRecord(value) && typeof value.runId === "string" && runIds.has(value.runId),
  );
  const roomEvents = readDiagnosticCollection(
    database,
    blobs,
    "room_events",
    {
      field: "roomId",
      values: new Set([scope.roomId]),
    },
    (value) => isRecord(value) && value.roomId === scope.roomId,
  );
  return {
    source: "sqlite",
    events: events.values as AgentDiagnosticArchive["events"],
    executions: executions.values as AgentDiagnosticArchive["executions"],
    roomEvents: roomEvents.values as AgentDiagnosticArchive["roomEvents"],
    missingRecords: [...events.missingRecords, ...executions.missingRecords, ...roomEvents.missingRecords],
  };
}

function readDiagnosticCollection(
  database: DatabaseSync,
  blobs: ContentBlobStore,
  collection: "agent_events" | "executions" | "room_events",
  shallowScope: { field: "runId" | "roomId"; values: ReadonlySet<string> },
  include: (value: unknown) => boolean,
): {
  values: unknown[];
  missingRecords: AgentDiagnosticArchive["missingRecords"];
} {
  const scopeColumn = shallowScope.field === "runId" ? "scope_run_id" : "scope_room_id";
  const scopeValues = [...shallowScope.values];
  if (!scopeValues.length) return { values: [], missingRecords: [] };
  const placeholders = scopeValues.map(() => "?").join(", ");
  const rows = database
    .prepare(`
    SELECT record_key, payload, ${scopeColumn} AS scope_value FROM state_records
    WHERE collection = ? AND (${scopeColumn} IS NULL OR ${scopeColumn} IN (${placeholders}))
    ORDER BY position ASC, record_key ASC
  `)
    .iterate(collection, ...scopeValues) as Iterable<{
    record_key: string;
    payload: string;
    scope_value: string | null;
  }>;
  const updateLegacyScope = database.prepare(`
    UPDATE state_records SET ${scopeColumn} = ?
    WHERE collection = ? AND record_key = ? AND ${scopeColumn} IS NULL
  `);
  const values: unknown[] = [];
  const missingRecords: AgentDiagnosticArchive["missingRecords"] = [];
  const legacyScopeBackfills: Array<{ recordKey: string; scopeValue: string }> = [];
  for (const row of rows) {
    let legacyScopeKnown = row.scope_value !== null;
    if (row.scope_value === null) {
      const encodedScope = encodedPayloadScope(row.payload, shallowScope.field);
      if (encodedScope !== undefined) {
        legacyScopeKnown = true;
        legacyScopeBackfills.push({ recordKey: row.record_key, scopeValue: encodedScope });
        if (!shallowScope.values.has(encodedScope)) continue;
      }
    }
    try {
      const value = blobs.decode(row.payload);
      if (!legacyScopeKnown) {
        legacyScopeBackfills.push({
          recordKey: row.record_key,
          scopeValue: diagnosticScopeValue(value, shallowScope.field),
        });
      }
      if (include(value)) values.push(value);
    } catch (error) {
      missingRecords.push({
        collection,
        recordKey: row.record_key,
        reason: storageErrorCode(error),
      });
    }
  }
  if (legacyScopeBackfills.length) {
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const backfill of legacyScopeBackfills) {
        updateLegacyScope.run(backfill.scopeValue, collection, backfill.recordKey);
      }
      database.exec("COMMIT");
    } catch {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Scope backfill is only a future-read optimization. It must never make
        // the current diagnostic export fail after evidence was read successfully.
      }
    }
  }
  return { values, missingRecords };
}

function encodedPayloadScope(payload: string, field: "runId" | "roomId"): string | undefined {
  try {
    const encoded = JSON.parse(payload) as unknown;
    if (!isRecord(encoded)) return undefined;
    const value = encoded[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function diagnosticRecordScope(
  collection: CollectionName,
  value: unknown,
): { runId: string | null; roomId: string | null } {
  return {
    runId: collection === "agent_events" || collection === "executions" ? diagnosticScopeValue(value, "runId") : null,
    roomId: collection === "room_events" ? diagnosticScopeValue(value, "roomId") : null,
  };
}

function diagnosticScopeValue(value: unknown, field: "runId" | "roomId"): string {
  if (!isRecord(value)) return "";
  const scope = value[field];
  return typeof scope === "string" ? scope : "";
}

function storageErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "decode_failed";
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && code) return code;
  const message = (error as Error).message;
  if (message.startsWith("state_blob_integrity_error")) return "state_blob_integrity_error";
  if (message.startsWith("invalid_state_blob_hash")) return "invalid_state_blob_hash";
  return "decode_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function setMeta(database: DatabaseSync, key: string, value: string): void {
  database
    .prepare(`
    INSERT INTO state_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)
    .run(key, value);
}

function readMeta(database: DatabaseSync, key: string): string | undefined {
  return (database.prepare("SELECT value FROM state_meta WHERE key = ?").get(key) as MetaRow | undefined)?.value;
}

// ===== Storage stats and maintenance =====

function readStorageStats(
  database: DatabaseSync,
  blobs: ContentBlobStore,
  databasePath: string,
  legacyPath: string,
): AgentStorageStats {
  const recordRows = database
    .prepare(`
    SELECT collection, COUNT(*) AS records, COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS payload_bytes
    FROM state_records GROUP BY collection ORDER BY collection
  `)
    .all() as unknown as Array<{ collection: string; records: number; payload_bytes: number }>;
  const blobRows = database
    .prepare(`
    SELECT collection, COALESCE(SUM(stored_size), 0) AS blob_bytes FROM (
      SELECT DISTINCT refs.collection AS collection, blobs.hash AS hash, blobs.stored_size AS stored_size
      FROM state_blob_refs refs
      JOIN state_blobs blobs ON blobs.hash = refs.hash
    ) GROUP BY collection
  `)
    .all() as unknown as Array<{ collection: string; blob_bytes: number }>;
  const blobBytesByCollection = new Map(blobRows.map((row) => [row.collection, Number(row.blob_bytes)]));
  const categories: AgentStorageCategoryStats[] = recordRows.map((row) => ({
    collection: row.collection,
    records: Number(row.records),
    payloadBytes: Number(row.payload_bytes),
    referencedBlobBytes: blobBytesByCollection.get(row.collection) ?? 0,
  }));
  const referencedHashes = new Set(
    (database.prepare("SELECT DISTINCT hash FROM state_blob_refs").all() as unknown as Array<{ hash: string }>).map(
      (row) => row.hash,
    ),
  );
  let blobBytes = 0;
  let orphanBlobBytes = 0;
  for (const hash of blobs.listHashes()) {
    const size = blobs.sizeOnDisk(hash);
    blobBytes += size;
    if (!referencedHashes.has(hash)) orphanBlobBytes += size;
  }
  return {
    kind: "sqlite",
    databaseBytes: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].reduce(
      (total, path) => total + (existsSync(path) ? statSync(path).size : 0),
      0,
    ),
    blobBytes,
    orphanBlobBytes,
    migrationBackupBytes: migrationBackupPaths(databasePath, legacyPath).reduce(
      (total, path) => total + pathSize(path),
      0,
    ),
    categories,
  };
}

function cleanupOrphanedBlobs(database: DatabaseSync, blobs: ContentBlobStore): AgentStorageCleanupResult {
  const referencedHashes = new Set(
    (database.prepare("SELECT DISTINCT hash FROM state_blob_refs").all() as unknown as Array<{ hash: string }>).map(
      (row) => row.hash,
    ),
  );
  let removedBlobs = 0;
  let reclaimedBytes = 0;
  for (const hash of blobs.listHashes()) {
    if (referencedHashes.has(hash)) continue;
    reclaimedBytes += blobs.sizeOnDisk(hash);
    if (blobs.delete(hash)) removedBlobs += 1;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM state_blobs WHERE hash NOT IN (SELECT DISTINCT hash FROM state_blob_refs)");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { removedBlobs, reclaimedBytes };
}

function clearRoomEventArchive(database: DatabaseSync): number {
  return clearArchiveCollection(database, "room_events");
}

function deleteRoomEvents(database: DatabaseSync, eventSeqs: readonly number[]): number {
  const keys = [...new Set(eventSeqs.filter((eventSeq) => Number.isSafeInteger(eventSeq) && eventSeq > 0).map(String))];
  if (!keys.length) return 0;
  let removed = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    const chunkSize = 400;
    for (let offset = 0; offset < keys.length; offset += chunkSize) {
      const chunk = keys.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = database
        .prepare(`
        DELETE FROM state_records
        WHERE collection = 'room_events' AND record_key IN (${placeholders})
      `)
        .run(...chunk);
      removed += Number(result.changes);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return removed;
}

function clearRuntimeEventArchive(database: DatabaseSync): number {
  const before = (
    database
      .prepare(`
    SELECT COUNT(*) AS count FROM state_records
    WHERE collection IN ('agent_events', 'executions')
  `)
      .get() as { count: number }
  ).count;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM state_records WHERE collection IN ('agent_events', 'executions')");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return Number(before);
}

function clearArchiveCollection(database: DatabaseSync, collection: "agent_events" | "room_events"): number {
  const before = (
    database.prepare("SELECT COUNT(*) AS count FROM state_records WHERE collection = ?").get(collection) as {
      count: number;
    }
  ).count;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM state_records WHERE collection = ?").run(collection);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return Number(before);
}

class AgentEventArchiveIndex {
  private readonly knownRecordKeys = new Set<string>();
  private previousSnapshot: Array<{ stamp: string; identity: ArchiveRecordIdentity }>;
  private nextPosition: number;

  constructor(database: DatabaseSync) {
    const row = database
      .prepare(`
      SELECT COALESCE(MAX(position), -1) AS max_position
      FROM state_records WHERE collection = 'agent_events'
    `)
      .get() as { max_position: number };
    this.nextPosition = Number(row.max_position) + 1;
    const tail = database
      .prepare(`
      SELECT record_key, position, source_stamp
      FROM (
        SELECT record_key, position, source_stamp FROM state_records
        WHERE collection = 'agent_events'
        ORDER BY position DESC, record_key DESC
        LIMIT ?
      ) ORDER BY position ASC, record_key ASC
    `)
      .all(HOT_AGENT_EVENT_LIMIT) as unknown as Array<StateRecordRow>;
    this.previousSnapshot = tail.map((row) => {
      this.knownRecordKeys.add(row.record_key);
      return {
        stamp: row.source_stamp,
        identity: { recordKey: row.record_key, position: Number(row.position) },
      };
    });
  }

  identitiesFor(values: unknown[]): ArchiveRecordIdentity[] {
    const stamps = values.map((value) => recordSourceStamp("agent_events", value, ""));
    const previousStamps = this.previousSnapshot.map((item) => item.stamp);
    const overlap = tailPrefixOverlap(previousStamps, stamps);
    const previousStart = this.previousSnapshot.length - overlap;
    const identities = stamps.map((_stamp, index) => {
      const restored = index < overlap ? this.previousSnapshot[previousStart + index]?.identity : undefined;
      const identity = restored ?? this.allocate();
      return identity;
    });
    this.previousSnapshot = stamps.map((stamp, index) => ({ stamp, identity: identities[index]! }));
    this.knownRecordKeys.clear();
    for (const identity of identities) this.knownRecordKeys.add(identity.recordKey);
    return identities;
  }

  register(value: unknown, identity: ArchiveRecordIdentity): void {
    if (!this.knownRecordKeys.has(identity.recordKey)) {
      this.knownRecordKeys.add(identity.recordKey);
      this.previousSnapshot.push({
        stamp: recordSourceStamp("agent_events", value, identity.recordKey),
        identity,
      });
    }
    this.nextPosition = Math.max(this.nextPosition, identity.position + 1);
  }

  private allocate(): ArchiveRecordIdentity {
    const position = this.nextPosition;
    this.nextPosition += 1;
    return { recordKey: `event:${position}`, position };
  }
}

function tailPrefixOverlap(previous: string[], current: string[]): number {
  if (previous.length === 0 || current.length === 0) return 0;
  const separator = "\0";
  const combined = [...current, separator, ...previous];
  const prefix = new Array<number>(combined.length).fill(0);
  for (let index = 1; index < combined.length; index += 1) {
    let candidate = prefix[index - 1] ?? 0;
    while (candidate > 0 && combined[index] !== combined[candidate]) {
      candidate = prefix[candidate - 1] ?? 0;
    }
    if (combined[index] === combined[candidate]) candidate += 1;
    prefix[index] = candidate;
  }
  return Math.min(current.length, prefix.at(-1) ?? 0);
}

function clearMigrationBackups(databasePath: string, legacyPath: string): AgentFileCleanupResult {
  const backups = migrationBackupPaths(databasePath, legacyPath);
  let reclaimedBytes = 0;
  for (const path of backups) {
    reclaimedBytes += pathSize(path);
    rmSync(path, { recursive: true, force: false });
  }
  return { removedFiles: backups.length, reclaimedBytes };
}

function migrationBackupPaths(databasePath: string, legacyPath: string): string[] {
  const extension = extname(legacyPath) || ".json";
  const stem = basename(legacyPath, extname(legacyPath));
  const prefix = `${stem}.before-sqlite-migration`;
  const recoveryPrefix = `${stem}.before-legacy-recovery`;
  if (!existsSync(dirname(legacyPath))) return [];
  const entries = readdirSync(dirname(legacyPath));
  const sqliteMigrationBackups = entries
    .filter(
      (entry) =>
        entry === `${prefix}${extension}` ||
        (entry.startsWith(`${prefix}-`) &&
          entry.endsWith(extension) &&
          /^\d+$/.test(entry.slice(prefix.length + 1, -extension.length))),
    )
    .map((entry) => join(dirname(legacyPath), entry));
  const recoveryBackups = entries
    .filter(
      (entry) =>
        entry === recoveryPrefix ||
        (entry.startsWith(`${recoveryPrefix}-`) && /^\d+$/.test(entry.slice(recoveryPrefix.length + 1))),
    )
    .map((entry) => join(dirname(legacyPath), entry));
  const persistedStateMigrationSteps = [
    "unscoped-migration",
    "app-pm-purge",
    "room-administrators-v1",
    "kernel-native-resume-v1",
    "routine-app-command-id-v1",
  ];
  const candidates = new Set([
    ...sqliteMigrationBackups,
    ...recoveryBackups,
    ...persistedStateMigrationSteps.flatMap((step) => [
      `${databasePath}.before-${step}.json`,
      `${legacyPath}.before-${step}.json`,
    ]),
  ]);
  return [...candidates].filter((path) => existsSync(path));
}

function pathSize(path: string): number {
  const stats = lstatSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path).reduce((total, entry) => total + pathSize(join(path, entry)), 0);
}

function resolveStatePaths(requestedPath: string): { databasePath: string; legacyPath: string } {
  const resolved = resolve(requestedPath);
  if (extname(resolved).toLowerCase() === ".json") {
    return {
      databasePath: join(dirname(resolved), `${basename(resolved, extname(resolved))}.sqlite`),
      legacyPath: resolved,
    };
  }
  return {
    databasePath: resolved,
    legacyPath: join(dirname(resolved), `${basename(resolved, extname(resolved))}.json`),
  };
}

function spec(
  name: CollectionName,
  values: CollectionSpec["values"],
  key: CollectionSpec["key"] = idKey,
  appendOnly = false,
): CollectionSpec {
  return { name, values, key, appendOnly };
}

function idKey(value: unknown, index: number): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id;
  }
  return String(index);
}

function eventSequenceKey(value: unknown, index: number): string {
  return String(numericEventSequence(value, index));
}

function numericEventSequence(value: unknown, index: number): number {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const eventSeq = (value as Record<string, unknown>).eventSeq;
    if (typeof eventSeq === "number" && Number.isSafeInteger(eventSeq) && eventSeq > 0) return eventSeq;
  }
  return index + 1;
}

function executionArchivePosition(value: unknown, index: number): number {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    const match = typeof id === "string" ? /^exec_(\d+)$/.exec(id) : undefined;
    const sequence = match?.[1] ? Number(match[1]) : Number.NaN;
    // Existing v1 databases stored executions newest-first at positions 0..N.
    // Negative sequence positions preserve that ordering while making each new
    // execution's archive position stable across later hot-window snapshots.
    if (Number.isSafeInteger(sequence) && sequence > 0) return -sequence;
  }
  return index;
}

function stringValueKey(value: unknown, index: number): string {
  return typeof value === "string" && value ? value : String(index);
}

function recordSourceStamp(_collection: CollectionName, value: unknown, _recordKey: string): string {
  const serialized = JSON.stringify(value);
  return `sha256:${createHash("sha256")
    .update(serialized ?? "undefined")
    .digest("hex")}`;
}
