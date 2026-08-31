#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryHygieneFailures } from "./repository-hygiene-core.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const trackedFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: projectRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const failures = repositoryHygieneFailures(
  trackedFiles
    .filter((file) => existsSync(resolve(projectRoot, file)))
    .map((file) => ({ path: file, contents: readTrackedText(file) })),
);

if (failures.length > 0) {
  console.error("Repository hygiene check failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log("repository hygiene check ok");

function readTrackedText(file) {
  const contents = readFileSync(resolve(projectRoot, file));
  return contents.includes(0) ? undefined : contents.toString("utf8");
}
