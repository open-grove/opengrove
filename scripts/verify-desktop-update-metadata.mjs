import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { verifyDesktopUpdateMetadata } from "./desktop-update-metadata.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const updaterDir = resolve(args.updaterDir ?? join(projectRoot, "release", "desktop", "updater"));
const releaseDir = resolve(args.releaseDir ?? dirname(updaterDir));
const releasedAt = args.releasedAt ?? releaseSourceTimestamp(releaseDir);

const evidence = await verifyDesktopUpdateMetadata({
  releaseDir,
  updaterDir,
  version: packageJson.version,
  releasedAt,
  requireAll: args.requireAll,
});
if (evidence.targets.length === 1) evidence.target = evidence.targets[0].target;
if (args.evidenceOut) {
  const path = resolve(args.evidenceOut);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(
  `verify-desktop-update-metadata: ${evidence.targets.map((target) => target.target).join(", ")} passed independent SHA512 verification.`,
);

function releaseSourceTimestamp(path) {
  const values = [];
  for (const target of ["mac-arm64", "mac-x64", "windows-x64"]) {
    const sourcePath = join(releaseDir, "release-source", `${target}.json`);
    if (existsSync(sourcePath)) values.push(JSON.parse(readFileSync(sourcePath, "utf8")).releasedAt);
  }
  if (values.length === 0) return undefined;
  if (values.some((value) => value !== values[0] || !Number.isFinite(Date.parse(value ?? "")))) {
    throw new Error("release source manifests do not share one valid release timestamp");
  }
  return values[0];
}

function parseArgs(values) {
  const result = { requireAll: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--release-dir") result.releaseDir = readRequired(values, ++index, value);
    else if (value.startsWith("--release-dir=")) result.releaseDir = value.slice("--release-dir=".length);
    else if (value === "--updater-dir") result.updaterDir = readRequired(values, ++index, value);
    else if (value.startsWith("--updater-dir=")) result.updaterDir = value.slice("--updater-dir=".length);
    else if (value === "--released-at") result.releasedAt = readRequired(values, ++index, value);
    else if (value.startsWith("--released-at=")) result.releasedAt = value.slice("--released-at=".length);
    else if (value === "--evidence-out") result.evidenceOut = readRequired(values, ++index, value);
    else if (value.startsWith("--evidence-out=")) result.evidenceOut = value.slice("--evidence-out=".length);
    else if (value === "--require-all") result.requireAll = true;
    else throw new Error(`Unknown verify-desktop-update-metadata option: ${value}`);
  }
  return result;
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
