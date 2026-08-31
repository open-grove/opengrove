import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { artifactFileName, parsePackArguments, replaceFile, validateFrontendArtifact } from "./pack-web-artifact.mjs";
import { removeTemporaryTree } from "./temporary-cleanup.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

assert.equal(artifactFileName("backend", "1.2.3"), "opengrove-1.2.3.tgz");
assert.equal(artifactFileName("frontend", "1.2.3"), "opengrove-web-1.2.3.tar.gz");
assert.deepEqual(parsePackArguments(["backend"], projectRoot), {
  target: "backend",
  outputDir: resolve(projectRoot, "release/web"),
});
assert.deepEqual(parsePackArguments(["frontend", "--output-dir", "artifacts"], projectRoot), {
  target: "frontend",
  outputDir: resolve(projectRoot, "artifacts"),
});
assert.deepEqual(parsePackArguments(["frontend", "--output-dir=../artifacts"], projectRoot), {
  target: "frontend",
  outputDir: resolve(projectRoot, "../artifacts"),
});
assert.throws(
  () => parsePackArguments(["frontend", "--output-dir"], projectRoot),
  /--output-dir requires a directory/u,
);
assert.throws(() => parsePackArguments(["frontend", "--unknown-option"], projectRoot), /Unknown Web package option/u);
for (const generatedDir of ["dist", "web-dist", "desktop-dist"]) {
  assert.throws(
    () => parsePackArguments(["frontend", "--output-dir", generatedDir], projectRoot),
    new RegExp(`must not be inside ${generatedDir}/`, "u"),
  );
  assert.throws(
    () => parsePackArguments(["frontend", "--output-dir", `${generatedDir}/packages`], projectRoot),
    new RegExp(`must not be inside ${generatedDir}/`, "u"),
  );
}

await verifyExistingArtifactReplacement();
await verifyFailedReplacementRestoresExistingArtifact();
await verifyFailedRestorePreservesBackup();
await verifyFrontendArtifactValidation();

console.log("Web artifact argument and replacement contracts verified.");

async function verifyExistingArtifactReplacement() {
  const root = await mkdtemp(join(tmpdir(), "opengrove-web-replace-success-"));
  try {
    const source = join(root, "new.tgz");
    const destination = join(root, "artifact.tgz");
    await Promise.all([writeFile(source, "new artifact", "utf8"), writeFile(destination, "old artifact", "utf8")]);
    await replaceFile(source, destination, { move: failInitialReplacement() });
    assert.equal(await readFile(destination, "utf8"), "new artifact");
    await assert.rejects(() => readFile(source, "utf8"), { code: "ENOENT" });
  } finally {
    removeTemporaryTree(root);
  }
}

async function verifyFailedReplacementRestoresExistingArtifact() {
  const root = await mkdtemp(join(tmpdir(), "opengrove-web-replace-rollback-"));
  try {
    const source = join(root, "new.tgz");
    const destination = join(root, "artifact.tgz");
    await Promise.all([writeFile(source, "new artifact", "utf8"), writeFile(destination, "old artifact", "utf8")]);
    await assert.rejects(() => replaceFile(source, destination, { move: failNewArtifactMove() }), { code: "EPERM" });
    assert.equal(await readFile(destination, "utf8"), "old artifact");
    assert.equal(await readFile(source, "utf8"), "new artifact");
  } finally {
    removeTemporaryTree(root);
  }
}

async function verifyFailedRestorePreservesBackup() {
  const root = await mkdtemp(join(tmpdir(), "opengrove-web-replace-preserve-"));
  try {
    const source = join(root, "new.tgz");
    const destination = join(root, "artifact.tgz");
    await Promise.all([writeFile(source, "new artifact", "utf8"), writeFile(destination, "old artifact", "utf8")]);
    let reportedBackupPath = "";
    await assert.rejects(
      () => replaceFile(source, destination, { move: failNewArtifactMoveAndRestore() }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        const match = error.message.match(/previous artifact remains at (.+)$/u);
        assert.ok(match, "Replacement error must report the preserved backup path");
        reportedBackupPath = match[1];
        return true;
      },
    );
    assert.equal(await readFile(reportedBackupPath, "utf8"), "old artifact");
    assert.equal(await readFile(source, "utf8"), "new artifact");
  } finally {
    removeTemporaryTree(root);
  }
}

async function verifyFrontendArtifactValidation() {
  const root = await mkdtemp(join(tmpdir(), "opengrove-web-artifact-validation-"));
  try {
    const validRoot = join(root, "valid");
    const invalidRoot = join(root, "invalid");
    await Promise.all([mkdir(join(validRoot, "assets"), { recursive: true }), mkdir(invalidRoot, { recursive: true })]);
    const metadata = `${JSON.stringify({ buildId: "test-build", packageVersion: "1.2.3" })}\n`;
    await Promise.all([
      writeFile(join(validRoot, "index.html"), "<!doctype html>", "utf8"),
      writeFile(join(validRoot, "version.json"), metadata, "utf8"),
      writeFile(join(validRoot, "assets", "index.js"), "export {};", "utf8"),
      writeFile(join(invalidRoot, "index.html"), "<!doctype html>", "utf8"),
      writeFile(join(invalidRoot, "version.json"), metadata, "utf8"),
    ]);

    const validArchive = join(root, "valid.tar.gz");
    const invalidArchive = join(root, "invalid.tar.gz");
    createTarArchive(validRoot, validArchive);
    createTarArchive(invalidRoot, invalidArchive);
    await validateFrontendArtifact(validArchive, "1.2.3");
    await assert.rejects(() => validateFrontendArtifact(invalidArchive, "1.2.3"), /must contain built assets/u);
  } finally {
    removeTemporaryTree(root);
  }
}

function failInitialReplacement() {
  let moveCount = 0;
  return async (source, destination) => {
    moveCount += 1;
    if (moveCount === 1) throw fileError("EEXIST");
    await rename(source, destination);
  };
}

function failNewArtifactMove() {
  let moveCount = 0;
  return async (source, destination) => {
    moveCount += 1;
    if (moveCount === 1) throw fileError("EEXIST");
    if (moveCount === 3) throw fileError("EPERM");
    await rename(source, destination);
  };
}

function failNewArtifactMoveAndRestore() {
  let moveCount = 0;
  return async (source, destination) => {
    moveCount += 1;
    if (moveCount === 1) throw fileError("EEXIST");
    if (moveCount === 3) throw fileError("EPERM");
    if (moveCount === 4) throw fileError("EBUSY");
    await rename(source, destination);
  };
}

function fileError(code) {
  return Object.assign(new Error(code), { code });
}

function createTarArchive(contentsRoot, archivePath) {
  const result = spawnSync("tar", ["-C", contentsRoot, "-czf", archivePath, "."], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `tar failed with exit code ${result.status ?? "unknown"}`);
}
