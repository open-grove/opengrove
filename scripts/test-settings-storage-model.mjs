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
  const { settingsStorageTotalBytes } = await import(pathToFileURL(bundlePath).href);
  assert.equal(
    settingsStorageTotalBytes({
      kind: "sqlite",
      databaseBytes: 100,
      blobBytes: 300,
      orphanBlobBytes: 80,
      migrationBackupBytes: 20,
      categories: [],
    }),
    420,
    "orphan blobs are already included in blobBytes and must not be counted twice",
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("settings-storage-model ok");
