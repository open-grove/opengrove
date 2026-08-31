import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removeTemporaryTree } from "./temporary-cleanup.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmArgsPrefix =
  process.platform === "win32"
    ? [process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
    : [];
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const outputDir = mkdtempSync(join(tmpdir(), "opengrove-web-package-test-"));
const backendFile = `opengrove-${packageJson.version}.tgz`;
const frontendFile = `opengrove-web-${packageJson.version}.tar.gz`;

try {
  execute(npmCommand, [...npmArgsPrefix, "run", "pack:web:backend", "--", "--output-dir", outputDir]);
  execute(npmCommand, [...npmArgsPrefix, "run", "pack:web:frontend", "--", `--output-dir=${outputDir}`]);

  const outputEntries = readdirSync(outputDir).sort();
  assert.ok(outputEntries.includes(backendFile), `Output directory is missing ${backendFile}`);
  assert.ok(outputEntries.includes(frontendFile), `Output directory is missing ${frontendFile}`);
  const unexpectedEntries = outputEntries.filter(
    (entry) =>
      entry !== backendFile &&
      entry !== frontendFile &&
      !(process.platform === "win32" && entry.startsWith(".web-package-")),
  );
  assert.deepEqual(unexpectedEntries, [], "Output directory contains unexpected package files");
  assert.ok(statSync(join(outputDir, backendFile)).size > 0, "Backend archive must not be empty");
  assert.ok(statSync(join(outputDir, frontendFile)).size > 0, "Frontend archive must not be empty");

  const backendEntries = archiveEntries(join(outputDir, backendFile));
  for (const required of [
    "package/package.json",
    "package/dist/cli.js",
    "package/web-dist/index.html",
    "package/web-dist/version.json",
  ]) {
    assert.ok(backendEntries.has(required), `Backend archive is missing ${required}`);
  }
  const packedPackage = JSON.parse(
    execute("tar", ["-xOzf", join(outputDir, backendFile), "package/package.json"], { capture: true }).stdout.trim(),
  );
  assert.equal(packedPackage.name, "opengrove");
  assert.equal(packedPackage.version, packageJson.version);

  const frontendEntries = archiveEntries(join(outputDir, frontendFile));
  assert.ok(frontendEntries.has("index.html"), "Frontend archive is missing index.html");
  assert.ok(frontendEntries.has("version.json"), "Frontend archive is missing version.json");
  assert.ok(
    [...frontendEntries].some((entry) => entry.startsWith("assets/") && entry !== "assets/"),
    "Frontend archive must contain built assets",
  );
  const webVersion = JSON.parse(
    execute("tar", ["-xOzf", join(outputDir, frontendFile), "./version.json"], { capture: true }).stdout.trim(),
  );
  assert.equal(webVersion.packageVersion, packageJson.version);
  assert.equal(typeof webVersion.buildId, "string");
  assert.ok(webVersion.buildId.length > 0);

  const invalid = execute(npmCommand, [...npmArgsPrefix, "run", "pack:web:backend", "--", "--unknown-option"], {
    allowFailure: true,
    capture: true,
  });
  assert.notEqual(invalid.status, 0, "Unknown package options must fail");
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /Unknown Web package option/u);
} finally {
  removeTemporaryTree(outputDir);
}

console.log("Web artifact packaging commands and archives verified.");

function archiveEntries(path) {
  return new Set(
    execute("tar", ["-tzf", path], { capture: true })
      .stdout.trim()
      .split(/\r?\n/u)
      .map((entry) => entry.replace(/^\.\//u, ""))
      .filter(Boolean),
  );
}

function execute(command, args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
  return result;
}
