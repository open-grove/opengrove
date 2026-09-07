import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog } from "../core/events.js";
import { ExecutionStore } from "../core/stores/execution-store.js";
import type { AgentEvent, ExecutionRecord } from "../core/types.js";
import type { RoomChannelEvent, RoomChannelSnapshot } from "../rooms/channel-store.js";
import { normalizeRoomChannelSnapshot } from "../rooms/channel-store.js";
import { ContentBlobStore } from "../storage/content-blob-store.js";
import { defaultOpenGroveStatePath } from "../storage/default-data-dir.js";
import {
  normalizePersistedAgentState,
  type PersistableAgentStatePorts,
  type PersistedAgentState,
} from "../storage/json-state-store.js";
import { createSqliteStateStore } from "../storage/sqlite-state-store.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-sqlite-state-"));
try {
  verifyConfiguredStatePath(root);
  verifyMigrationAndBlobArchive(root);
  verifyFailedMigrationKeepsJson(root);
  verifyNewerDowngradeWriteIsRecovered(root);
  verifyFreshDatabaseDefersToRealLegacyHistory(root);
  verifyUnprovenRicherLegacyHistoryWinsOverFreshState(root);
  verifyCurrentSqliteWinsOverStaleJson(root);
  verifyNewerLegacySnapshotWinsWhenBothContainHistory(root);
  verifyInvalidLegacyJsonDoesNotBlockCurrentState(root);
  verifySameTimestampContentChangePersists(root);
  verifyAgentEventHotWindow(root);
  verifyRestoredAgentEventsKeepArchiveIdentity(root);
  verifyRestoredSnapshotNormalizesRuntimeState(root);
  verifyDiagnosticArchiveSkipsUnrelatedBlobsAndReportsMissingEvidence(root);
  console.log("sqlite-state-store-harness ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function verifyRestoredSnapshotNormalizesRuntimeState(rootDir: string): void {
  const databasePath = join(rootDir, "snapshot-runtime-normalization", "local-state.sqlite");
  const fixture = createStatePorts();
  const store = createSqliteStateStore(databasePath);
  const snapshot = normalizePersistedAgentState({});
  snapshot.questions = [
    {
      id: "question-without-live-host",
      status: "pending",
      updatedAt: "2026-08-13T00:00:00.000Z",
    } as PersistedAgentState["questions"][number],
  ];

  const restored = store.restoreSnapshotInto?.(fixture.ports, snapshot);
  assert.ok(restored);
  assert.deepEqual(
    {
      status: fixture.state().questions[0]?.status,
      response: fixture.state().questions[0]?.response,
    },
    {
      status: "canceled",
      response: { system: true, reasonCode: "producer_lost" },
    },
    "restoring an activation snapshot must apply the same honest system-cancellation policy as a cold load",
  );
  void store.close?.();
}

function verifyConfiguredStatePath(rootDir: string): void {
  const configuredPath = join(rootDir, "configured", "state.sqlite");
  const previous = process.env.OPENGROVE_STATE_PATH;
  process.env.OPENGROVE_STATE_PATH = configuredPath;
  try {
    assert.equal(defaultOpenGroveStatePath(), configuredPath);
  } finally {
    if (previous === undefined) delete process.env.OPENGROVE_STATE_PATH;
    else process.env.OPENGROVE_STATE_PATH = previous;
  }
}

function verifyMigrationAndBlobArchive(rootDir: string): void {
  const dataDir = join(rootDir, "migration");
  const legacyPath = join(dataDir, "local-state.json");
  const databasePath = join(dataDir, "local-state.sqlite");
  const largeText = `large-result:${"长文内容".repeat(12_000)}`;
  const roomId = "room-sqlite-test";
  const messageId = "message-sqlite-test";
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    legacyPath,
    `${JSON.stringify(
      normalizePersistedAgentState({
        savedAt: "2026-07-18T00:00:00.000Z",
        rooms: {
          version: 1,
          currentEventSeq: 0,
          rooms: [
            {
              id: roomId,
              kind: "group",
              title: "SQLite",
              badge: "Test",
              memberIds: [],
              removedMemberIds: ["member-room-excluded"],
              pinned: false,
              archived: false,
              unread: 0,
              updatedAt: "2026-07-18T00:00:00.000Z",
            },
          ],
          members: [],
          messages: [
            {
              id: messageId,
              roomId,
              channelSeq: 1,
              senderId: "agent",
              senderName: "Agent",
              senderType: "agent",
              text: largeText,
              targetIds: [],
              status: "done",
              createdAt: "2026-07-18T00:00:00.000Z",
              updatedAt: "2026-07-18T00:00:00.000Z",
            },
          ],
          events: [],
          deletedMemberIds: [],
        },
      }),
    )}\n`,
    "utf8",
  );

  const fixture = createStatePorts();
  const store = createSqliteStateStore(databasePath, { blobThresholdBytes: 1_024 });
  const migrated = store.loadInto(fixture.ports);
  assert.ok(migrated);
  assert.equal(migrated.rooms.messages[0]?.text, largeText);
  assert.equal(existsSync(databasePath), true);
  assert.equal(existsSync(legacyPath), false, "legacy JSON must move only after the SQLite commit");
  assert.equal(existsSync(join(dataDir, "local-state.before-sqlite-migration.json")), true);
  writeFileSync(`${databasePath}.before-unscoped-migration.json`, "sqlite migration backup", "utf8");
  writeFileSync(`${legacyPath}.before-unscoped-migration.json`, "legacy migration backup", "utf8");
  writeFileSync(`${databasePath}.before-app-pm-purge.json`, "app PM purge backup", "utf8");
  writeFileSync(`${databasePath}.before-app-room-scopes-v1.json`, "app room scope backup", "utf8");
  writeFileSync(`${databasePath}.before-app-member-identities-v1.json`, "app member identity backup", "utf8");
  writeFileSync(`${databasePath}.before-native-employee-model-v1.json`, "native employee backup", "utf8");
  const initialStats = store.storageStats?.();
  assert.equal(initialStats?.kind, "sqlite");
  assert.ok((initialStats?.blobBytes ?? 0) > 0, "large message text should be stored in a compressed Blob");
  assert.ok((initialStats?.migrationBackupBytes ?? 0) > 0, "migration backup size should be visible in storage stats");

  const firstEvent = roomEvent(1, roomId, messageId, "first");
  fixture.setRooms({ ...fixture.state().rooms, currentEventSeq: 1, events: [firstEvent] });
  store.saveFrom(fixture.ports);
  const secondEvent = roomEvent(2, roomId, messageId, "second");
  // Simulate a bounded in-memory delivery window: event 1 is absent from the
  // next snapshot, but the SQLite archive must retain it.
  fixture.setRooms({ ...fixture.state().rooms, currentEventSeq: 2, events: [secondEvent] });
  store.saveFrom(fixture.ports);

  const database = new DatabaseSync(databasePath);
  const archivedEvents = database
    .prepare("SELECT COUNT(*) AS count FROM state_records WHERE collection = 'room_events'")
    .get() as { count: number };
  database.close();
  assert.equal(archivedEvents.count, 2, "Room event persistence must be append-only across hot-window snapshots");
  assert.equal(store.deleteRoomEvents?.([firstEvent.eventSeq]), 1);

  const orphanStore = new ContentBlobStore(join(dataDir, "state-blobs"), { thresholdBytes: 1_024 });
  const markerLikeUserData = {
    $opengroveBlob: {
      version: 1,
      hash: "a".repeat(64),
      kind: "text",
      encoding: "gzip",
      byteSize: 1,
      storedSize: 1,
    },
  };
  assert.deepEqual(
    orphanStore.decode(orphanStore.encode(markerLikeUserData).payload),
    markerLikeUserData,
    "user data that resembles an internal Blob marker must round-trip literally",
  );
  orphanStore.encode(`orphan:${"x".repeat(8_000)}`);
  assert.ok((store.storageStats?.().orphanBlobBytes ?? 0) > 0);
  const cleanup = store.cleanupOrphanedBlobs?.();
  assert.equal(cleanup?.removedBlobs, 1);
  assert.ok((cleanup?.reclaimedBytes ?? 0) > 0);
  void store.close?.();

  const restartedFixture = createStatePorts();
  const restarted = createSqliteStateStore(databasePath);
  const restored = restarted.loadInto(restartedFixture.ports);
  assert.equal(restored?.rooms.messages[0]?.text, largeText);
  assert.deepEqual(restored?.rooms.rooms[0]?.removedMemberIds, ["member-room-excluded"]);
  assert.deepEqual(
    restored?.rooms.events.map((event) => event.eventSeq),
    [2],
  );
  const backupCleanup = restarted.clearMigrationBackups?.();
  assert.equal(backupCleanup?.removedFiles, 7);
  assert.ok((backupCleanup?.reclaimedBytes ?? 0) > 0);
  assert.equal(existsSync(join(dataDir, "local-state.before-sqlite-migration.json")), false);
  assert.equal(existsSync(`${databasePath}.before-unscoped-migration.json`), false);
  assert.equal(existsSync(`${legacyPath}.before-unscoped-migration.json`), false);
  assert.equal(existsSync(`${databasePath}.before-app-pm-purge.json`), false);
  assert.equal(existsSync(`${databasePath}.before-app-room-scopes-v1.json`), false);
  assert.equal(existsSync(`${databasePath}.before-app-member-identities-v1.json`), false);
  assert.equal(existsSync(`${databasePath}.before-native-employee-model-v1.json`), false);
  assert.equal(restarted.storageStats?.().migrationBackupBytes, 0);
  void restarted.close?.();
}

function verifyFailedMigrationKeepsJson(rootDir: string): void {
  const dataDir = join(rootDir, "invalid");
  const legacyPath = join(dataDir, "local-state.json");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(legacyPath, "{not valid JSON", "utf8");
  assert.throws(() => createSqliteStateStore(databasePath), /JSON/);
  assert.equal(existsSync(legacyPath), true, "a failed migration must leave the source JSON untouched");
}

function verifyNewerDowngradeWriteIsRecovered(rootDir: string): void {
  const dataDir = join(rootDir, "downgrade-conflict");
  const legacyPath = join(dataDir, "local-state.json");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(legacyPath, JSON.stringify(normalizePersistedAgentState({ savedAt: "2026-07-18T00:00:00.000Z" })));
  const migrated = createSqliteStateStore(databasePath);
  void migrated.close?.();

  writeFileSync(
    legacyPath,
    JSON.stringify(
      normalizePersistedAgentState({
        savedAt: "2026-07-18T01:00:00.000Z",
        memory: [memoryRecord("written-by-old-version", "must not be discarded")],
      }),
    ),
  );
  const recoveredFixture = createStatePorts();
  const recovered = createSqliteStateStore(databasePath);
  const state = recovered.loadInto(recoveredFixture.ports);
  assert.equal(state?.memory[0]?.id, "written-by-old-version");
  assert.equal(existsSync(legacyPath), false, "a recovered legacy snapshot must no longer block startup");
  assert.equal(existsSync(join(dataDir, "local-state.before-sqlite-migration-2.json")), true);
  void recovered.close?.();
}

function verifyFreshDatabaseDefersToRealLegacyHistory(rootDir: string): void {
  const dataDir = join(rootDir, "fresh-downgrade-conflict");
  const legacyPath = join(dataDir, "local-state.json");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  const fresh = createSqliteStateStore(databasePath);
  fresh.saveFrom(createStatePorts().ports);
  void fresh.close?.();

  writeFileSync(
    legacyPath,
    JSON.stringify(
      normalizePersistedAgentState({
        savedAt: "2026-07-18T02:00:00.000Z",
        memory: [memoryRecord("written-after-downgrade", "must be surfaced")],
      }),
    ),
  );
  const recoveredFixture = createStatePorts();
  const recovered = createSqliteStateStore(databasePath);
  const state = recovered.loadInto(recoveredFixture.ports);
  assert.equal(state?.memory[0]?.id, "written-after-downgrade");
  assert.equal(existsSync(legacyPath), false);
  assert.equal(existsSync(join(dataDir, "local-state.before-legacy-recovery")), true);
  assert.ok((recovered.storageStats?.().migrationBackupBytes ?? 0) > 0);
  const cleanup = recovered.clearMigrationBackups?.();
  assert.ok((cleanup?.removedFiles ?? 0) >= 2);
  assert.equal(existsSync(join(dataDir, "local-state.before-legacy-recovery")), false);
  void recovered.close?.();
}

function verifyCurrentSqliteWinsOverStaleJson(rootDir: string): void {
  const dataDir = join(rootDir, "sqlite-wins");
  const legacyPath = join(dataDir, "local-state.json");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  const fixture = createStatePorts();
  fixture.setMemory([memoryRecord("current-sqlite-history", "current")]);
  const current = createSqliteStateStore(databasePath);
  current.saveFrom(fixture.ports);
  void current.close?.();

  writeFileSync(
    legacyPath,
    JSON.stringify(
      normalizePersistedAgentState({
        savedAt: "2000-01-01T00:00:00.000Z",
        memory: [memoryRecord("stale-json-history", "stale")],
      }),
    ),
  );
  const reopenedFixture = createStatePorts();
  const reopened = createSqliteStateStore(databasePath);
  const state = reopened.loadInto(reopenedFixture.ports);
  assert.deepEqual(
    state?.memory.map((item) => item.id),
    ["current-sqlite-history"],
  );
  assert.equal(existsSync(legacyPath), false);
  assert.equal(existsSync(join(dataDir, "local-state.before-sqlite-migration.json")), true);
  assert.equal(existsSync(join(dataDir, "local-state.before-legacy-recovery")), false);
  void reopened.close?.();
}

function verifyUnprovenRicherLegacyHistoryWinsOverFreshState(rootDir: string): void {
  const dataDir = join(rootDir, "richer-unproven-json-wins");
  const legacyPath = join(dataDir, "local-state.json");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  const fixture = createStatePorts();
  fixture.setMemory([memoryRecord("fresh-default-like-state", "fresh")]);
  const current = createSqliteStateStore(databasePath);
  current.saveFrom(fixture.ports);
  void current.close?.();

  writeFileSync(
    legacyPath,
    JSON.stringify(
      normalizePersistedAgentState({
        savedAt: "2000-01-01T00:00:00.000Z",
        memory: [memoryRecord("legacy-history-1", "one"), memoryRecord("legacy-history-2", "two")],
      }),
    ),
  );
  const reopenedFixture = createStatePorts();
  const reopened = createSqliteStateStore(databasePath);
  const state = reopened.loadInto(reopenedFixture.ports);
  assert.deepEqual(
    state?.memory.map((item) => item.id),
    ["legacy-history-1", "legacy-history-2"],
  );
  assert.equal(existsSync(join(dataDir, "local-state.before-legacy-recovery")), true);
  void reopened.close?.();
}

function verifyNewerLegacySnapshotWinsWhenBothContainHistory(rootDir: string): void {
  const dataDir = join(rootDir, "newer-json-wins");
  const legacyPath = join(dataDir, "local-state.json");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  const fixture = createStatePorts();
  fixture.setMemory([memoryRecord("older-sqlite-history", "older")]);
  const current = createSqliteStateStore(databasePath);
  current.saveFrom(fixture.ports);
  void current.close?.();

  writeFileSync(
    legacyPath,
    JSON.stringify(
      normalizePersistedAgentState({
        savedAt: "2099-01-01T00:00:00.000Z",
        memory: [memoryRecord("newer-json-history", "newer")],
      }),
    ),
  );
  const reopenedFixture = createStatePorts();
  const reopened = createSqliteStateStore(databasePath);
  const state = reopened.loadInto(reopenedFixture.ports);
  assert.deepEqual(
    state?.memory.map((item) => item.id),
    ["newer-json-history"],
  );
  assert.equal(existsSync(join(dataDir, "local-state.before-legacy-recovery")), true);
  void reopened.close?.();
}

function verifyInvalidLegacyJsonDoesNotBlockCurrentState(rootDir: string): void {
  const dataDir = join(rootDir, "invalid-json-beside-current");
  const legacyPath = join(dataDir, "local-state.json");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  const fixture = createStatePorts();
  fixture.setMemory([memoryRecord("safe-sqlite-history", "safe")]);
  const current = createSqliteStateStore(databasePath);
  current.saveFrom(fixture.ports);
  void current.close?.();

  writeFileSync(legacyPath, "{not valid JSON", "utf8");
  const reopenedFixture = createStatePorts();
  const reopened = createSqliteStateStore(databasePath);
  const state = reopened.loadInto(reopenedFixture.ports);
  assert.deepEqual(
    state?.memory.map((item) => item.id),
    ["safe-sqlite-history"],
  );
  assert.equal(existsSync(legacyPath), false);
  assert.equal(existsSync(join(dataDir, "local-state.before-sqlite-migration.json")), true);
  void reopened.close?.();
}

function verifySameTimestampContentChangePersists(rootDir: string): void {
  const dataDir = join(rootDir, "same-timestamp-update");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  const fixture = createStatePorts();
  const updatedAt = "2026-07-18T03:00:00.000Z";
  const baseRooms = fixture.state().rooms;
  fixture.setRooms({
    ...baseRooms,
    rooms: [
      {
        id: "same-time-room",
        kind: "group",
        title: "before",
        badge: "Test",
        memberIds: [],
        adminMemberIds: [],
        pinned: false,
        archived: false,
        unread: 0,
        updatedAt,
      },
    ],
  });
  const store = createSqliteStateStore(databasePath);
  store.saveFrom(fixture.ports);
  fixture.setRooms({
    ...fixture.state().rooms,
    rooms: [{ ...fixture.state().rooms.rooms[0]!, title: "after", updatedAt }],
  });
  store.saveFrom(fixture.ports);
  void store.close?.();

  const restartedFixture = createStatePorts();
  const restarted = createSqliteStateStore(databasePath);
  restarted.loadInto(restartedFixture.ports);
  assert.equal(restartedFixture.state().rooms.rooms[0]?.title, "after");
  void restarted.close?.();
}

function verifyAgentEventHotWindow(rootDir: string): void {
  const dataDir = join(rootDir, "agent-event-hot-window");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  const fixture = createStatePorts();
  fixture.setEvents(Array.from({ length: 5_007 }, (_, index) => agentEvent(index)));
  fixture.setExecutions(Array.from({ length: 5_007 }, (_, index) => execution(index)));
  const store = createSqliteStateStore(databasePath);
  store.saveFrom(fixture.ports);
  void store.close?.();

  assert.equal(countRecords(databasePath, "agent_events"), 5_007);
  assert.equal(countRecords(databasePath, "executions"), 5_007);
  simulateLegacyExecutionPositions(databasePath, 5_007);
  const restartedFixture = createStatePorts();
  const restarted = createSqliteStateStore(databasePath);
  const restored = restarted.loadInto(restartedFixture.ports);
  assert.equal(restored?.events.length, 5_000, "only the hot agent-event tail should be restored into memory");
  assert.equal(restored?.events[0]?.runId, "run-7");
  assert.equal(restored?.events.at(-1)?.runId, "run-5006");
  assert.equal(restored?.executions.length, 5_000, "only the hot execution tail should be restored into memory");
  assert.equal(restored?.executions[0]?.id, "exec_8");
  assert.equal(restored?.executions.at(-1)?.id, "exec_5007");

  restartedFixture.setEvents([...restartedFixture.state().events, agentEvent(5_007)]);
  restartedFixture.setExecutions([...restartedFixture.state().executions, execution(5_007)]);
  restarted.saveFrom(restartedFixture.ports);
  void restarted.close?.();
  assert.equal(
    countRecords(databasePath, "agent_events"),
    5_008,
    "saving a sliding hot window must append without deleting the cold archive",
  );
  assert.equal(countRecords(databasePath, "executions"), 5_008);

  const finalFixture = createStatePorts();
  const finalStore = createSqliteStateStore(databasePath);
  const finalState = finalStore.loadInto(finalFixture.ports);
  assert.equal(finalState?.events.length, 5_000);
  assert.equal(finalState?.events[0]?.runId, "run-8");
  assert.equal(finalState?.events.at(-1)?.runId, "run-5007");
  assert.equal(finalState?.executions.length, 5_000);
  assert.equal(finalState?.executions[0]?.id, "exec_9");
  assert.equal(finalState?.executions.at(-1)?.id, "exec_5008");
  assert.equal(finalStore.clearRuntimeEventArchive?.(), 10_016);
  finalFixture.setEvents([]);
  finalFixture.setExecutions([]);
  finalStore.saveFrom(finalFixture.ports);
  void finalStore.close?.();
  assert.equal(countRecords(databasePath, "agent_events"), 0);
  assert.equal(countRecords(databasePath, "executions"), 0);

  const memoryLog = new EventLog();
  memoryLog.setRetentionLimit(3);
  memoryLog.restore(Array.from({ length: 5 }, (_, index) => agentEvent(index)));
  memoryLog.append(agentEvent(5));
  assert.deepEqual(
    memoryLog.list().map((event) => event.runId),
    ["run-3", "run-4", "run-5"],
  );

  const memoryExecutions = new ExecutionStore();
  memoryExecutions.setRetentionLimit(3);
  memoryExecutions.restore(Array.from({ length: 5 }, (_, index) => execution(index)));
  memoryExecutions.appendFromEvent(agentEvent(5), { recordedAt: execution(5).at });
  assert.deepEqual(
    memoryExecutions.list().map((record) => record.id),
    ["exec_6", "exec_5", "exec_4"],
  );
}

function verifyRestoredAgentEventsKeepArchiveIdentity(rootDir: string): void {
  const dataDir = join(rootDir, "agent-event-identity");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  const originalFixture = createStatePorts();
  originalFixture.setEvents(Array.from({ length: 5_001 }, (_, index) => agentEvent(index)));
  const originalStore = createSqliteStateStore(databasePath);
  originalStore.saveFrom(originalFixture.ports);
  void originalStore.close?.();
  assert.equal(countRecords(databasePath, "agent_events"), 5_001);

  const restoredFixture = createStatePorts();
  const restoredStore = createSqliteStateStore(databasePath);
  const restored = restoredStore.loadInto(restoredFixture.ports);
  assert.equal(restored?.events.length, 5_000);
  restoredFixture.setEvents(restoredFixture.state().events.map((event) => ({ ...event })));
  restoredStore.saveFrom(restoredFixture.ports);
  assert.equal(
    countRecords(databasePath, "agent_events"),
    5_001,
    "cloned events from the restored hot window must reuse their durable archive identities",
  );

  const shifted = restoredFixture
    .state()
    .events.slice(1)
    .map((event) => ({ ...event }));
  shifted.push({ ...restoredFixture.state().events[0]! });
  restoredFixture.setEvents(shifted);
  restoredStore.saveFrom(restoredFixture.ports);
  void restoredStore.close?.();
  assert.equal(
    countRecords(databasePath, "agent_events"),
    5_002,
    "a new event identical to one that left the hot window must still receive a new archive identity",
  );
}

function verifyDiagnosticArchiveSkipsUnrelatedBlobsAndReportsMissingEvidence(rootDir: string): void {
  const dataDir = join(rootDir, "diagnostic-blob-scope");
  const databasePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  const fixture = createStatePorts();
  fixture.setEvents([
    diagnosticModelRequest("run-diagnostic-target", "target prompt ".repeat(2_000)),
    diagnosticModelRequest("run-diagnostic-unrelated", "unrelated prompt ".repeat(2_000)),
    diagnosticWholeBlobEvent("run-diagnostic-whole-blob"),
  ]);
  const store = createSqliteStateStore(databasePath, { blobThresholdBytes: 1_024 });
  store.saveFrom(fixture.ports);

  const database = new DatabaseSync(databasePath);
  const blobPaths = database
    .prepare(`
    SELECT refs.record_key, blobs.relative_path
    FROM state_blob_refs AS refs
    JOIN state_blobs AS blobs ON blobs.hash = refs.hash
    WHERE refs.collection = 'agent_events'
    ORDER BY refs.record_key, blobs.relative_path
  `)
    .all() as unknown as Array<{ record_key: string; relative_path: string }>;
  const wholeBlobRow = database
    .prepare(`
    SELECT payload, scope_run_id FROM state_records
    WHERE collection = 'agent_events' AND record_key = 'event:2'
  `)
    .get() as { payload: string; scope_run_id: string };
  database.close();
  const unrelatedBlob = blobPaths.find((row) => row.record_key === "event:1");
  const unrelatedWholeBlob = blobPaths.find((row) => row.record_key === "event:2");
  const targetBlob = blobPaths.find((row) => row.record_key === "event:0");
  assert.ok(unrelatedBlob && unrelatedWholeBlob && targetBlob);
  assert.ok(
    JSON.parse(wholeBlobRow.payload).$opengroveBlob,
    "the regression fixture must store the entire event as one Blob",
  );
  assert.equal(wholeBlobRow.scope_run_id, "run-diagnostic-whole-blob");
  rmSync(join(dataDir, "state-blobs", unrelatedBlob.relative_path));
  rmSync(join(dataDir, "state-blobs", unrelatedWholeBlob.relative_path));

  const scoped = store.readDiagnosticArchive?.({
    runIds: ["run-diagnostic-target"],
    roomId: "room-diagnostic-target",
  });
  assert.equal(scoped?.events.length, 1);
  assert.deepEqual(scoped?.missingRecords, [], "an unrelated missing Blob must not be decoded during a scoped export");

  rmSync(join(dataDir, "state-blobs", targetBlob.relative_path));
  const incomplete = store.readDiagnosticArchive?.({
    runIds: ["run-diagnostic-target"],
    roomId: "room-diagnostic-target",
  });
  assert.equal(incomplete?.events.length, 0);
  assert.deepEqual(incomplete?.missingRecords, [
    {
      collection: "agent_events",
      recordKey: "event:0",
      reason: "ENOENT",
    },
  ]);
  void store.close?.();
}

function diagnosticWholeBlobEvent(runId: string): AgentEvent {
  return {
    type: "assistant.status",
    runId,
    ...Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`diagnosticField${index}`, `small-value-${index}-${"x".repeat(32)}`]),
    ),
  } as unknown as AgentEvent;
}

function diagnosticModelRequest(runId: string, systemPrompt: string): AgentEvent {
  return {
    type: "model.requested",
    runId,
    request: {
      systemPrompt,
      userInput: "diagnose",
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
    },
  };
}

function countRecords(databasePath: string, collection: string): number {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM state_records WHERE collection = ?")
      .get(collection) as { count: number };
    return Number(row.count);
  } finally {
    database.close();
  }
}

function simulateLegacyExecutionPositions(databasePath: string, total: number): void {
  const database = new DatabaseSync(databasePath);
  try {
    const rows = database
      .prepare("SELECT record_key FROM state_records WHERE collection = 'executions'")
      .all() as unknown as Array<{ record_key: string }>;
    const update = database.prepare(
      "UPDATE state_records SET position = ? WHERE collection = 'executions' AND record_key = ?",
    );
    database.exec("BEGIN IMMEDIATE");
    for (const row of rows) {
      const sequence = Number(/^exec_(\d+)$/.exec(row.record_key)?.[1]);
      update.run(total - sequence, row.record_key);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function agentEvent(index: number): AgentEvent {
  return { type: "assistant.delta", runId: `run-${index}`, text: `token-${index}` };
}

function execution(index: number): ExecutionRecord {
  return {
    id: `exec_${index + 1}`,
    runId: `run-${index}`,
    sessionId: "session-hot-window",
    kind: "model",
    eventType: "assistant.delta",
    title: "Assistant delta",
    at: new Date(Date.UTC(2026, 6, 18) + index).toISOString(),
  };
}

function roomEvent(eventSeq: number, roomId: string, messageId: string, text: string): RoomChannelEvent {
  return {
    schemaVersion: 2,
    eventSeq,
    type: "room.message.updated",
    roomId,
    messageId,
    createdAt: `2026-07-18T00:00:0${eventSeq}.000Z`,
    payload: { messagePatch: { set: { text } } },
  };
}

function createStatePorts(): {
  ports: PersistableAgentStatePorts;
  state(): PersistedAgentState;
  setMemory(memory: PersistedAgentState["memory"]): void;
  setEvents(events: AgentEvent[]): void;
  setExecutions(executions: ExecutionRecord[]): void;
  setRooms(snapshot: RoomChannelSnapshot): void;
} {
  let state = normalizePersistedAgentState({});
  const update = (patch: Partial<PersistedAgentState>) => {
    state = { ...state, ...patch };
  };
  const ports: PersistableAgentStatePorts = {
    knowledge: {
      restore: (knowledge) => update({ knowledge }),
      restoreLedgers: (ledgers) =>
        update({
          knowledgeEvidence: ledgers.evidence ?? [],
          knowledgeRevisions: ledgers.revisions ?? [],
          knowledgeDeliveries: ledgers.deliveries ?? [],
          knowledgeFeedback: ledgers.feedback ?? [],
        }),
      snapshot: () => state.knowledge,
      listEvidence: () => state.knowledgeEvidence,
      listRevisions: () => state.knowledgeRevisions,
      listDeliveries: () => state.knowledgeDeliveries,
      listFeedback: () => state.knowledgeFeedback,
    },
    memory: { restore: (memory) => update({ memory }), list: () => state.memory },
    artifacts: { restore: (artifacts) => update({ artifacts }), list: () => state.artifacts },
    workingState: { restore: (workingState) => update({ workingState }), get: () => state.workingState },
    approvals: { restore: (approvals) => update({ approvals }), list: () => state.approvals },
    questions: { restore: (questions) => update({ questions }), list: () => state.questions },
    events: { restore: (events) => update({ events }), list: () => state.events },
    routines: { restore: (routines) => update({ routines }), list: () => state.routines },
    sessions: {
      restore: (snapshot) => update({ sessions: snapshot.sessions ?? [], runs: snapshot.runs ?? [] }),
      list: () => state.sessions,
      listRuns: () => state.runs,
    },
    executions: { restore: (executions) => update({ executions }), list: () => state.executions },
    rooms: {
      restore: (rooms) => update({ rooms: normalizeRoomChannelSnapshot(rooms) }),
      snapshot: () => state.rooms,
    },
  };
  return {
    ports,
    state: () => state,
    setMemory: (memory) => update({ memory }),
    setEvents: (events) => update({ events }),
    setExecutions: (executions) => update({ executions }),
    setRooms: (rooms) => update({ rooms }),
  };
}

function memoryRecord(id: string, text: string): PersistedAgentState["memory"][number] {
  return {
    id,
    scope: "workspace",
    kind: "test.history",
    text,
    confidence: "asserted",
    source: { kind: "user" },
    tags: [],
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}
