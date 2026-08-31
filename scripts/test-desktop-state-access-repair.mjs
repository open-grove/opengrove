import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const testRoot = mkdtempSync(join(tmpdir(), "opengrove-desktop-state-access-"));
const bundlePath = join(testRoot, "state-access-repair.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop", "state-access-repair.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: bundlePath,
  });
  const { repairDesktopStateAccess } = await import(pathToFileURL(bundlePath).href);

  const userDataDir = join(testRoot, "OpenGrove");
  const dataDir = join(userDataDir, "data");
  const blobRoot = join(dataDir, "state-blobs");
  const blobLevelOne = join(blobRoot, "aa");
  const blobLevelTwo = join(blobLevelOne, "bb");
  const externalFile = join(testRoot, "outside-opengrove.txt");
  const externalDirectory = join(testRoot, "outside-opengrove");
  const externalSentinel = join(externalDirectory, "sentinel.txt");
  const blobFile = join(blobLevelTwo, "aabb.gz");
  const stateFiles = [
    join(dataDir, "local-state.sqlite"),
    join(dataDir, "local-state.sqlite-wal"),
    join(dataDir, "local-state.sqlite-shm"),
    join(dataDir, "local-state.sqlite.lock"),
    join(dataDir, "local-state.json"),
    join(dataDir, "local-state.json.lock"),
    join(dataDir, "bridge-settings.json"),
  ];

  mkdirSync(blobLevelTwo, { recursive: true });
  for (const path of stateFiles) writeFileSync(path, "test\n", "utf8");
  writeFileSync(blobFile, "blob\n", "utf8");

  if (process.platform === "win32") {
    mkdirSync(externalDirectory);
    writeFileSync(externalSentinel, "external\n", "utf8");
    symlinkSync(externalDirectory, join(blobRoot, "external-link"), "junction");
    symlinkSync(externalDirectory, join(dataDir, "local-state.sqlite-journal"), "junction");
  } else {
    writeFileSync(externalFile, "external\n", "utf8");
    symlinkSync(externalFile, join(blobRoot, "external-link"));
    symlinkSync(externalFile, join(dataDir, "local-state.sqlite-journal"));
    for (const path of [...stateFiles, blobFile]) chmodSync(path, 0o000);
    for (const path of [blobLevelTwo, blobLevelOne, blobRoot, dataDir]) chmodSync(path, 0o000);
    chmodSync(externalFile, 0o640);
  }

  repairDesktopStateAccess(userDataDir);

  const missingUserDataDir = join(testRoot, "MissingOpenGrove");
  repairDesktopStateAccess(missingUserDataDir);

  if (process.platform === "win32") {
    assert.equal(
      existsSync(externalSentinel),
      true,
      "permission repair must not follow junctions outside OpenGrove data",
    );
  } else {
    assert.equal(mode(dataDir), 0o700);
    assert.equal(mode(blobRoot), 0o700);
    assert.equal(mode(blobLevelOne), 0o700);
    assert.equal(mode(blobLevelTwo), 0o700);
    for (const path of [...stateFiles, blobFile]) assert.equal(mode(path), 0o600, path);
    assert.equal(mode(externalFile), 0o640, "permission repair must not follow symlinks outside OpenGrove data");
    assert.equal(
      mode(join(missingUserDataDir, "data")),
      0o700,
      "permission repair must create a missing product data directory before retrying startup",
    );
  }

  process.stdout.write("desktop state access repair: ok\n");
} finally {
  for (const path of [
    join(testRoot, "OpenGrove", "data"),
    join(testRoot, "OpenGrove", "data", "state-blobs"),
    join(testRoot, "OpenGrove", "data", "state-blobs", "aa"),
    join(testRoot, "OpenGrove", "data", "state-blobs", "aa", "bb"),
  ]) {
    try {
      chmodSync(path, 0o700);
    } catch {
      // Test cleanup only; some paths may not have been created before a failure.
    }
  }
  rmSync(testRoot, { recursive: true, force: true });
}

function mode(path) {
  return lstatSync(path).mode & 0o777;
}
