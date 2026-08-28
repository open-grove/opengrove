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
  const { parseSettingsStorageResponse, settingsStorageCategoryBytes, settingsStorageTotalBytes } = await import(
    pathToFileURL(bundlePath).href
  );
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
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("settings-storage-model ok");
