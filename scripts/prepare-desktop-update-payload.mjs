import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopReleaseTargets } from "./desktop-release-targets.mjs";

const require = createRequire(import.meta.url);
const { dump } = require("js-yaml");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const releaseDir = resolve(args.releaseDir ?? join(projectRoot, "release", "desktop"));
const outputDir = resolve(args.outputDir ?? join(releaseDir, "updater"));

if (!existsSync(releaseDir)) fail(`release directory does not exist: ${releaseDir}`);
if (!args.releasedAt || !Number.isFinite(Date.parse(args.releasedAt))) {
  fail("--released-at must be the validated release source timestamp");
}
if (containsPath(outputDir, releaseDir)) {
  fail(`output directory must not contain the release directory: ${outputDir}`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const targets = desktopReleaseTargets(packageJson.version).filter((target) =>
  existsSync(join(releaseDir, target.updaterFile)),
);
if (targets.length === 0) {
  console.warn("prepare-desktop-update-payload: no updater artifacts are present; publishing manual installers only.");
}

for (const target of targets) {
  const source = join(releaseDir, target.updaterFile);
  const targetDir = join(outputDir, target.id);
  mkdirSync(targetDir, { recursive: true });

  const blockmapSource = join(releaseDir, target.updaterBlockmap);
  if (!existsSync(blockmapSource)) {
    console.warn(`prepare-desktop-update-payload: optional blockmap missing for ${target.updaterFile}`);
  }

  const sha512 = await hashFile(source, "sha512", "base64");
  const feed = {
    version: packageJson.version,
    files: [{ url: target.updaterFile, sha512, size: statSync(source).size }],
    path: target.updaterFile,
    sha512,
    releaseDate: args.releasedAt,
  };
  writeFileSync(join(targetDir, target.updaterFeed), dump(feed, { lineWidth: 120, noRefs: true }));
  console.log(
    `prepare-desktop-update-payload: ${target.id}: ${target.updaterFeed} references canonical ${target.updaterFile}`,
  );
}

function hashFile(path, algorithm, encoding) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest(encoding)));
  });
}

function containsPath(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--release-dir") result.releaseDir = readRequired(values, ++index, value);
    else if (value.startsWith("--release-dir=")) result.releaseDir = value.slice("--release-dir=".length);
    else if (value === "--output-dir") result.outputDir = readRequired(values, ++index, value);
    else if (value.startsWith("--output-dir=")) result.outputDir = value.slice("--output-dir=".length);
    else if (value === "--released-at") result.releasedAt = readRequired(values, ++index, value);
    else if (value.startsWith("--released-at=")) result.releasedAt = value.slice("--released-at=".length);
    else if (value === "--help" || value === "-h") {
      console.log(
        "Usage: node scripts/prepare-desktop-update-payload.mjs --released-at ISO [--release-dir DIR] [--output-dir DIR]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown prepare-desktop-update-payload option: ${value}`);
    }
  }
  return result;
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function fail(message) {
  console.error(`prepare-desktop-update-payload: ${message}`);
  process.exit(1);
}
