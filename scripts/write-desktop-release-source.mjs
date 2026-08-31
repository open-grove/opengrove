import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDesktopReleaseSourceManifests } from "./desktop-release-targets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const targetIds = [];
let releaseDir = join(projectRoot, "release", "desktop");
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (value === "--target" && process.argv[index + 1]) {
    targetIds.push(process.argv[++index]);
  } else if (value === "--release-dir" && process.argv[index + 1]) {
    releaseDir = resolve(process.argv[++index]);
  } else if (value.startsWith("--release-dir=")) {
    releaseDir = resolve(value.slice("--release-dir=".length));
  } else {
    throw new Error(
      "Usage: node scripts/write-desktop-release-source.mjs --target TARGET [--target TARGET] [--release-dir PATH]",
    );
  }
}
if (targetIds.length === 0) throw new Error("at least one --target is required");

const source = await writeDesktopReleaseSourceManifests({ projectRoot, releaseDir, targetIds });
console.log(
  `write-desktop-release-source: ${targetIds.join(", ")} <- ${source.expectedGitTag}@${source.gitCommit.slice(0, 12)} candidate`,
);
console.log(`release date: ${source.releasedAt}; package ${packageJson.version}`);
