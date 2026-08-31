import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAsarPackageVersion } from "./asar-package-version.mjs";
import { desktopAsarLookupPath, normalizeDesktopAsarPath } from "./desktop-asar-path.mjs";
import { desktopDistInventory } from "./desktop-package-inventory.mjs";
import { verifyDesktopGateBaseline } from "./verify-desktop-gate-baseline.mjs";

const require = createRequire(import.meta.url);
const { createPackage, listPackage, statFile, uncache } = require("@electron/asar");
const root = mkdtempSync(join(tmpdir(), "opengrove-desktop-gate-harness-"));

try {
  await testPinnedAssetVerification();
  await testRealAsarCorruptions();
  console.log("desktop-gate-harness ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function testPinnedAssetVerification() {
  const bytes = Buffer.from("known-good-desktop-installer-fixture");
  const asset = "OpenGrove-9.8.7-mac-arm64.dmg";
  const installerPath = join(root, asset);
  const manifestPath = join(root, "baseline.json");
  const manifest = {
    schemaVersion: 1,
    product: "OpenGrove",
    tag: "v9.8.7",
    gitCommit: "a".repeat(40),
    version: "9.8.7",
    distInventory: { fileCount: 2, sha256: "b".repeat(64) },
    targets: {
      "mac-arm64": {
        asset,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
  writeFileSync(installerPath, bytes);
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const verified = await verifyDesktopGateBaseline({ manifestPath, targetId: "mac-arm64", installerPath });
  assert.equal(verified.version, "9.8.7");
  assert.equal(verified.distFileCount, 2);

  writeFileSync(installerPath, Buffer.concat([bytes, Buffer.from("tampered")]));
  await assert.rejects(verifyDesktopGateBaseline({ manifestPath, targetId: "mac-arm64", installerPath }), /asset size/);
  writeFileSync(installerPath, bytes);
  const wrongHashManifest = {
    ...manifest,
    targets: { "mac-arm64": { ...manifest.targets["mac-arm64"], sha256: "c".repeat(64) } },
  };
  writeFileSync(manifestPath, `${JSON.stringify(wrongHashManifest)}\n`);
  await assert.rejects(verifyDesktopGateBaseline({ manifestPath, targetId: "mac-arm64", installerPath }), /SHA-256/);
}

async function testRealAsarCorruptions() {
  const archive = join(root, "replaceable-app.asar");
  const goodSource = join(root, "good-source");
  writeAsarSource(goodSource, "0.5.18", ["dist/main.js", "dist/server/desktop-bridge-entry.js"]);
  await createPackage(goodSource, archive);
  assert.equal(readAsarPackageVersion(archive), "0.5.18");
  const goodInventory = readDistInventory(archive);
  assert.equal(goodInventory.fileCount, 2);

  const missingFileSource = join(root, "missing-file-source");
  writeAsarSource(missingFileSource, "0.5.18", ["dist/main.js"]);
  await createPackage(missingFileSource, archive);
  const missingFileInventory = readDistInventory(archive);
  assert.notDeepEqual(
    missingFileInventory,
    goodInventory,
    "removing one runtime file must change the real ASAR inventory",
  );
  assert.equal(missingFileInventory.fileCount, 1);

  const wrongVersionSource = join(root, "wrong-version-source");
  writeAsarSource(wrongVersionSource, "0.5.19-broken", ["dist/main.js", "dist/server/desktop-bridge-entry.js"]);
  await createPackage(wrongVersionSource, archive);
  assert.equal(
    readAsarPackageVersion(archive),
    "0.5.19-broken",
    "the gate must invalidate @electron/asar's path cache after an in-place replacement",
  );
}

function writeAsarSource(rootPath, version, files) {
  mkdirSync(rootPath, { recursive: true });
  writeFileSync(join(rootPath, "package.json"), `${JSON.stringify({ name: "fixture", version })}\n`);
  for (const file of files) {
    const path = join(rootPath, ...file.split("/"));
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, `export const fixture = ${JSON.stringify(file)};\n`);
  }
}

function readDistInventory(archive) {
  uncache(archive);
  const files = listPackage(archive)
    .filter((path) => !statFile(archive, desktopAsarLookupPath(path)).files)
    .map(normalizeDesktopAsarPath);
  return desktopDistInventory(files);
}
