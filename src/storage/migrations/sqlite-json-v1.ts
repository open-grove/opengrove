import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { normalizePersistedAgentState, type PersistedAgentState } from "../json-state-store.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/581
 * Supports: OpenGrove <=0.6.1 local-state.json written before SQLite became the canonical state store.
 * Remove when: OpenGrove 0.7.0 requires direct upgrades from >=0.6.2; older backups move to the standalone importer.
 */
export function migrateLegacyJsonToSqliteV1(input: {
  database: DatabaseSync;
  databasePath: string;
  legacyPath: string;
  readMeta(key: string): string | undefined;
  loadState(): PersistedAgentState | undefined;
  persistState(
    state: PersistedAgentState,
    metadata: Record<string, string>,
    options?: { replaceExisting?: boolean },
  ): void;
}): void {
  const migratedFrom = input.readMeta("legacy_json_migrated_from");
  if (!existsSync(input.legacyPath)) return;
  const source = readFileSync(input.legacyPath);
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const expectedHash = input.readMeta("legacy_json_source_sha256");
  if (migratedFrom === input.legacyPath && expectedHash === sourceHash) {
    archiveLegacyJson(input.legacyPath);
    return;
  }
  if (input.readMeta("state_version")) {
    recoverConflictingLegacyJson(input, source, sourceHash, migratedFrom === input.legacyPath);
    return;
  }
  const state = normalizePersistedAgentState(JSON.parse(source.toString("utf8")));
  input.persistState(state, {
    legacy_json_migrated_from: input.legacyPath,
    legacy_json_source_sha256: sourceHash,
  });
  // The source moves only after the SQLite transaction is durable, preserving rollback on any earlier failure.
  renameSync(input.legacyPath, availableBackupPath(input.legacyPath));
}

function recoverConflictingLegacyJson(
  input: Parameters<typeof migrateLegacyJsonToSqliteV1>[0],
  source: Buffer,
  sourceHash: string,
  migrationWasRecorded: boolean,
): void {
  let legacyState: PersistedAgentState;
  let legacySavedAt: string | undefined;
  try {
    const parsed = JSON.parse(source.toString("utf8"));
    const parsedObject =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    legacySavedAt = typeof parsedObject?.savedAt === "string" ? parsedObject.savedAt : undefined;
    legacyState = normalizePersistedAgentState(parsed);
  } catch (error) {
    console.warn(
      "OpenGrove archived an unreadable legacy state file and kept the current SQLite history:",
      error instanceof Error ? error.message : String(error),
    );
    archiveLegacyJson(input.legacyPath);
    return;
  }
  const currentState = input.loadState();
  if (
    !currentState ||
    !preferLegacyState(
      currentState,
      legacyState,
      input.databasePath,
      input.legacyPath,
      migrationWasRecorded,
      input.readMeta("saved_at"),
      legacySavedAt,
    )
  ) {
    console.warn("OpenGrove archived an older legacy state file and continued with the current SQLite history.");
    archiveLegacyJson(input.legacyPath);
    return;
  }

  try {
    const recoveryPath = backupCurrentSqliteState(input.database, input.databasePath);
    const recoveredState: PersistedAgentState = {
      ...legacyState,
      rooms: {
        ...legacyState.rooms,
        currentEventSeq: Math.max(currentState.rooms.currentEventSeq, legacyState.rooms.currentEventSeq),
      },
    };
    input.persistState(
      recoveredState,
      {
        legacy_json_migrated_from: input.legacyPath,
        legacy_json_source_sha256: sourceHash,
        legacy_json_recovered_at: new Date().toISOString(),
        legacy_json_recovery_backup: recoveryPath,
      },
      { replaceExisting: true },
    );
    console.warn("OpenGrove automatically recovered newer legacy history after backing up the current SQLite state.");
  } catch (error) {
    console.warn(
      "OpenGrove could not safely import the legacy history, so it kept the current SQLite state and archived the legacy file:",
      error instanceof Error ? error.message : String(error),
    );
  }
  archiveLegacyJson(input.legacyPath);
}

function preferLegacyState(
  current: PersistedAgentState,
  legacy: PersistedAgentState,
  databasePath: string,
  legacyPath: string,
  migrationWasRecorded: boolean,
  currentSavedAt: string | undefined,
  legacySavedAt: string | undefined,
): boolean {
  const currentActivity = stateActivityScore(current);
  const legacyActivity = stateActivityScore(legacy);
  if (currentActivity === 0 && legacyActivity > 0) return true;
  if (legacyActivity === 0 && currentActivity > 0) return false;
  if (!migrationWasRecorded && currentActivity !== legacyActivity) return legacyActivity > currentActivity;
  const currentSavedTime = Date.parse(currentSavedAt ?? "");
  const legacySavedTime = Date.parse(legacySavedAt ?? "");
  if (Number.isFinite(currentSavedTime) && Number.isFinite(legacySavedTime) && currentSavedTime !== legacySavedTime) {
    return legacySavedTime > currentSavedTime;
  }
  return statSync(legacyPath).mtimeMs > statSync(databasePath).mtimeMs;
}

function stateActivityScore(state: PersistedAgentState): number {
  const durableAssets =
    state.knowledge.length +
    state.memory.length +
    state.artifacts.length +
    state.sessions.length +
    state.runs.length +
    state.executions.length;
  return (
    durableAssets * 4 +
    state.knowledgeEvidence.length +
    state.knowledgeRevisions.length +
    state.knowledgeDeliveries.length +
    state.knowledgeFeedback.length +
    state.approvals.length +
    state.questions.length +
    state.events.length +
    state.rooms.messages.length +
    state.rooms.events.length
  );
}

function backupCurrentSqliteState(database: DatabaseSync, databasePath: string): string {
  database.exec("PRAGMA wal_checkpoint(FULL)");
  const recoveryPath = availableRecoveryPath(databasePath);
  const stagingPath = `${recoveryPath}.partial-${process.pid}`;
  mkdirSync(stagingPath, { recursive: false });
  try {
    for (const sourcePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (existsSync(sourcePath)) copyFileSync(sourcePath, join(stagingPath, basename(sourcePath)));
    }
    const blobPath = join(dirname(databasePath), "state-blobs");
    if (existsSync(blobPath)) cpSync(blobPath, join(stagingPath, "state-blobs"), { recursive: true });
    writeFileSync(
      join(stagingPath, "recovery.json"),
      `${JSON.stringify(
        {
          version: 1,
          createdAt: new Date().toISOString(),
          reason: "newer-legacy-json-recovered",
          databaseFile: basename(databasePath),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    renameSync(stagingPath, recoveryPath);
    return recoveryPath;
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

function archiveLegacyJson(legacyPath: string): void {
  try {
    renameSync(legacyPath, availableBackupPath(legacyPath));
  } catch (error) {
    console.warn(
      "OpenGrove could not archive the legacy state file, but continued with the recovered history:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function availableRecoveryPath(databasePath: string): string {
  const stem = basename(databasePath, extname(databasePath));
  const base = join(dirname(databasePath), `${stem}.before-legacy-recovery`);
  if (!existsSync(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("state_recovery_backup_path_exhausted");
}

function availableBackupPath(legacyPath: string): string {
  const extension = extname(legacyPath);
  const stem = basename(legacyPath, extension);
  const base = join(dirname(legacyPath), `${stem}.before-sqlite-migration${extension || ".json"}`);
  if (!existsSync(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = join(dirname(base), `${basename(base, extname(base))}-${suffix}${extname(base)}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("state_migration_backup_path_exhausted");
}
