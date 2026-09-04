import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePersistedAgentState } from "../storage/json-state-store.js";
import {
  beginAppVersionActivationJournal,
  commitAppVersionActivationJournal,
  listAppVersionActivationJournals,
  removeAppVersionActivationJournal,
  scanAppVersionActivationJournals,
} from "../server/app-version-activation-journal.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-app-version-journal-"));

try {
  const root = join(tempRoot, "journal");
  const previousAgentState = normalizePersistedAgentState({
    version: 9,
    savedAt: "2026-07-31T00:00:00.000Z",
    knowledge: [],
    memory: [],
    artifacts: [],
    workingState: {},
    approvals: [],
    questions: [],
    events: [],
    routines: [],
    sessions: [],
    runs: [],
    executions: [],
    rooms: {
      rooms: [],
      members: [],
      messages: [],
      events: [],
    },
  });
  const journal = beginAppVersionActivationJournal({
    root,
    kind: "formal",
    localAppId: "local-versioned-app",
    appRoot: join(tempRoot, "apps", "versioned-app"),
    previousMountedApps: [
      {
        id: "local-versioned-app",
        path: join(tempRoot, "apps", "versioned-app"),
        enabled: true,
        title: "Versioned App",
      },
    ],
    previousUninstalledStoreAppIds: ["removed-app"],
    previousAgentState,
    previousVersionState: {
      schemaVersion: 1,
      localAppId: "local-versioned-app",
      activeContent: "formal",
      selectedVersion: {
        packageKey: "team.versioned-app",
        version: "1.0.0",
        archiveSha256: "1".repeat(64),
        releaseCommitSha: "2".repeat(40),
      },
      updatedAt: "2026-07-31T00:00:00.000Z",
    },
    previousSourceRevision: {
      checkpointId: "a".repeat(32),
      commitSha: "64894d71e1654ee49ea256e75930a95875c19cf9",
      indexSha256: "b".repeat(64),
      objectManifestSha256: "c".repeat(64),
    },
  });

  assert.equal(statSync(journal.path).mode & 0o777, 0o600);
  const legacyJournal = JSON.parse(readFileSync(journal.path, "utf8")) as {
    previousAgentState: { version: number };
  };
  legacyJournal.previousAgentState.version = 8;
  writeFileSync(journal.path, `${JSON.stringify(legacyJournal)}\n`, "utf8");
  const migratedJournal = listAppVersionActivationJournals(root)[0];
  assert.equal(migratedJournal?.path, journal.path);
  assert.equal(migratedJournal?.record.previousAgentState.version, 9);
  assert.equal(migratedJournal?.record.localAppId, journal.record.localAppId);
  assert.deepEqual(migratedJournal?.record.previousSourceRevision, journal.record.previousSourceRevision);
  assert.throws(
    () =>
      beginAppVersionActivationJournal({
        root,
        kind: "local-draft",
        localAppId: "other-app",
        appRoot: join(tempRoot, "apps", "other-app"),
        previousMountedApps: [],
        previousUninstalledStoreAppIds: [],
        previousAgentState,
      }),
    /app_version_activation_busy/,
  );

  const committed = commitAppVersionActivationJournal(journal);
  assert.equal(committed.record.phase, "committed");
  assert.equal(listAppVersionActivationJournals(root)[0]?.record.phase, "committed");
  removeAppVersionActivationJournal(committed);
  assert.deepEqual(listAppVersionActivationJournals(root), []);

  const invalidCheckpointJournal = beginAppVersionActivationJournal({
    root,
    kind: "formal",
    localAppId: "local-versioned-app",
    appRoot: join(tempRoot, "apps", "versioned-app"),
    previousMountedApps: [],
    previousUninstalledStoreAppIds: [],
    previousAgentState,
    previousSourceRevision: journal.record.previousSourceRevision,
  });
  const invalidCheckpointRecord = JSON.parse(readFileSync(invalidCheckpointJournal.path, "utf8")) as {
    previousSourceRevision: Record<string, unknown>;
  };
  invalidCheckpointRecord.previousSourceRevision = {
    checkpointId: "not-a-checkpoint-id",
    commitSha: "3".repeat(40),
    indexSha256: "4".repeat(64),
    objectManifestSha256: "5".repeat(64),
  };
  writeFileSync(invalidCheckpointJournal.path, `${JSON.stringify(invalidCheckpointRecord)}\n`, "utf8");
  assert.equal(scanAppVersionActivationJournals(root).failures.length, 1);
  removeAppVersionActivationJournal(invalidCheckpointJournal);

  const legacyFormalJournal = beginAppVersionActivationJournal({
    root,
    kind: "formal",
    localAppId: "local-versioned-app",
    appRoot: join(tempRoot, "apps", "versioned-app"),
    previousMountedApps: [],
    previousUninstalledStoreAppIds: [],
    previousAgentState,
    previousSourceRevision: journal.record.previousSourceRevision,
  });
  const legacyFormalRecord = JSON.parse(readFileSync(legacyFormalJournal.path, "utf8")) as Record<string, unknown>;
  legacyFormalRecord.schemaVersion = 1;
  delete legacyFormalRecord.previousSourceRevision;
  writeFileSync(legacyFormalJournal.path, `${JSON.stringify(legacyFormalRecord)}\n`, "utf8");
  const legacyScan = scanAppVersionActivationJournals(root);
  assert.deepEqual(legacyScan.failures, []);
  assert.equal(legacyScan.journals[0]?.record.legacySourceRevisionUnavailable, true);
  removeAppVersionActivationJournal(legacyFormalJournal);

  const mismatchedIdentityJournal = beginAppVersionActivationJournal({
    root,
    kind: "formal",
    localAppId: "local-versioned-app",
    appRoot: join(tempRoot, "apps", "versioned-app"),
    previousMountedApps: [],
    previousUninstalledStoreAppIds: [],
    previousAgentState,
    previousSourceRevision: journal.record.previousSourceRevision,
  });
  const mismatchedIdentityRecord = JSON.parse(readFileSync(mismatchedIdentityJournal.path, "utf8")) as Record<
    string,
    unknown
  >;
  mismatchedIdentityRecord.localAppId = "other-app";
  writeFileSync(mismatchedIdentityJournal.path, `${JSON.stringify(mismatchedIdentityRecord)}\n`, "utf8");
  assert.equal(
    scanAppVersionActivationJournals(root).failures.length,
    1,
    "the filename-bound App identity must not be replaceable from journal contents",
  );
  removeAppVersionActivationJournal(mismatchedIdentityJournal);

  process.stdout.write("app version activation journal harness passed\n");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
