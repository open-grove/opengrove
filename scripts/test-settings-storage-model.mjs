import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-settings-storage-model-"));
const bundlePath = join(tempDir, "settings-storage-model.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "web/src/components/sidebar/settings-storage-model.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
  });
  const {
    parseSettingsStorageCleanupResponse,
    parseSettingsStorageHistoryResponse,
    parseSettingsStorageBackupPreviewResponse,
    parseSettingsStorageMaintenanceEndResponse,
    parseSettingsStorageMaintenanceStartResponse,
    parseSettingsStorageResponse,
    settingsStorageCategoryBytes,
    settingsStorageTotalBytes,
  } = await import(pathToFileURL(bundlePath).href);
  const overview = {
    totalBytes: 900,
    scannedAt: "2026-08-13T00:00:00.000Z",
    categories: [
      { id: "works-and-files", bytes: 300 },
      { id: "apps-and-runtime", bytes: 200 },
      { id: "rebuildable", bytes: 150 },
      { id: "backups", bytes: 100 },
      { id: "conversations-and-system", bytes: 150 },
    ],
    cleanupCandidates: { rebuildableBytes: 150 },
    backups: [{ kind: "migration", bytes: 100, createdAt: "2026-08-12T00:00:00.000Z" }],
  };
  const parsed = parseSettingsStorageResponse({
    ok: true,
    stats: {
      kind: "sqlite",
      databaseBytes: 100,
      blobBytes: 300,
      orphanBlobBytes: 80,
      migrationBackupBytes: 20,
      categories: [],
    },
    overview,
    cleanupEstimates: {
      unreferencedFilesBytes: 80,
      rebuildableBytes: 150,
      safeCleanupBytes: 230,
      migrationBackupBytes: 20,
    },
  });
  assert.equal(settingsStorageTotalBytes(parsed.overview), 900);
  assert.equal(settingsStorageCategoryBytes(overview, "rebuildable"), 150);
  assert.throws(
    () => parseSettingsStorageResponse({ ok: true, stats: parsed.stats, cleanupEstimates: parsed.cleanupEstimates }),
    /storage_overview_invalid/,
    "the network boundary rejects incomplete storage responses instead of trusting a generic type",
  );
  assert.deepEqual(parseSettingsStorageCleanupResponse({ ok: true, cleanup: { reclaimedBytes: 42 } }), {
    reclaimedBytes: 42,
  });
  assert.deepEqual(parseSettingsStorageHistoryResponse({ ok: true, scope: "migration-backups" }), {
    reclaimedBytes: 0,
    retainedFiles: 0,
  });
  const appBackup = {
    kind: "app-layout",
    id: "backup",
    appId: "app",
    bytes: 10,
    createdAt: "2026-08-12T00:00:00.000Z",
    state: "verified",
    appStatus: "active",
    workspacePath: "/workspaces/app",
  };
  const preview = { token: "confirmed", bytes: 10, backups: [appBackup], protectedBackups: [] };
  assert.deepEqual(parseSettingsStorageBackupPreviewResponse({ ok: true, preview }), preview);
  const uninstalled = { ...appBackup, appStatus: "uninstalled", workspacePath: undefined };
  assert.equal(
    parseSettingsStorageBackupPreviewResponse({ ok: true, preview: { ...preview, backups: [uninstalled] } }).backups[0]
      .appStatus,
    "uninstalled",
  );
  for (const appStatus of ["active", "disabled", "unknown", undefined]) {
    assert.throws(
      () =>
        parseSettingsStorageBackupPreviewResponse({
          ok: true,
          preview: {
            ...preview,
            backups: [{ ...uninstalled, appStatus }],
          },
        }),
      /storage_overview_backup_invalid/,
    );
  }
  assert.throws(
    () =>
      parseSettingsStorageBackupPreviewResponse({
        ok: true,
        preview: {
          ...preview,
          backups: [{ ...appBackup, state: "unverified", reason: "missing_receipt" }],
        },
      }),
    /storage_backup_preview_invalid/,
  );
  assert.throws(
    () =>
      parseSettingsStorageBackupPreviewResponse({
        ok: true,
        preview: {
          ...preview,
          protectedBackups: [{ ...appBackup, state: "protected", reason: "unknown" }],
        },
      }),
    /storage_overview_backup_invalid/,
  );
  assert.deepEqual(
    parseSettingsStorageHistoryResponse({ ok: true, cleanup: { reclaimedBytes: 10, retainedFiles: 1 } }),
    { reclaimedBytes: 10, retainedFiles: 1 },
  );
  assert.deepEqual(parseSettingsStorageMaintenanceStartResponse({ ok: true, leaseId: "lease-1" }), {
    leaseId: "lease-1",
  });
  assert.equal(parseSettingsStorageMaintenanceEndResponse({ ok: true }), undefined);
  assert.throws(
    () => parseSettingsStorageMaintenanceStartResponse({ ok: true, leaseId: 1 }),
    /settings_storage_maintenance_start_invalid/,
  );
  assert.throws(
    () => parseSettingsStorageCleanupResponse({ ok: true, cleanup: { reclaimedBytes: "42" } }),
    /settings_storage_cleanup_bytes_invalid/,
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("settings-storage-model ok");
