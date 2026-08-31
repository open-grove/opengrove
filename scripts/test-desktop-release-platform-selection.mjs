import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import {
  desktopReleasePlatformIds,
  desktopReleasePlatformOutputs,
  selectDesktopReleasePlatforms,
} from "./desktop-release-platform-selection.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { load: loadYaml } = require("js-yaml");

const all = selectDesktopReleasePlatforms("all");
assert.deepEqual(all.selected, desktopReleasePlatformIds);
assert.equal(all.runMac, true);
assert.equal(all.runWindows, true);
assert.equal(all.fullCandidate, true);
assert.deepEqual(
  all.macMatrix.map(({ target }) => target),
  ["mac-arm64", "mac-x64"],
);

const oneMac = selectDesktopReleasePlatforms("mac-x64");
assert.deepEqual(oneMac.selected, ["mac-x64"]);
assert.equal(oneMac.runMac, true);
assert.equal(oneMac.runWindows, false);
assert.equal(oneMac.fullCandidate, false);
assert.equal(oneMac.macMatrix[0].runner, "macos-15-intel");

const subset = selectDesktopReleasePlatforms(" windows , mac-arm64 ");
assert.deepEqual(subset.selected, ["mac-arm64", "windows-x64"]);
assert.equal(subset.runWindows, true);
assert.equal(subset.fullCandidate, false);
assert.deepEqual(JSON.parse(desktopReleasePlatformOutputs(subset).mac_matrix), subset.macMatrix);

for (const value of ["", "linux-x64", "mac-arm64,", "all,windows-x64", "windows,windows-x64"]) {
  assert.throws(() => selectDesktopReleasePlatforms(value));
}

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-platform-selection-"));
try {
  const outputPath = join(tempRoot, "github-output");
  const cli = spawnSync(
    process.execPath,
    [
      join(projectRoot, "scripts/desktop-release-platform-selection.mjs"),
      "--platforms",
      "mac-arm64,windows-x64",
      "--github-output",
      outputPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const output = readFileSync(outputPath, "utf8");
  assert.match(output, /^platforms=mac-arm64,windows-x64$/m);
  assert.match(output, /^run_mac=true$/m);
  assert.match(output, /^run_windows=true$/m);
  assert.match(output, /^full_candidate=false$/m);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const workflowPath = join(projectRoot, ".github/workflows/desktop-release.yml");
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = loadYaml(workflowSource);
const jobs = workflow.jobs;
assert.equal(workflow.on.workflow_dispatch.inputs.platforms.default, "all");
assert.match(
  jobs["resolve-candidate"].steps.find((step) => step.id === "platforms").run,
  /desktop-release-platform-selection\.mjs/,
);
assert.match(jobs["mac-release"].if, /run_mac/);
assert.match(jobs["mac-release"].strategy.matrix.include, /fromJSON.*mac_matrix/);
assert.match(jobs["windows-release"].if, /run_windows/);
assert.match(jobs["release-gates"].if, /full_candidate/);
assert.ok(jobs["partial-platform-summary"]);

const cacheStep = jobs["mac-release"].steps.find((step) => step.uses === "actions/cache@v4");
assert.ok(cacheStep, "macOS release jobs must cache Electron downloads");
assert.match(cacheStep.with.path, /Library\/Caches\/electron(?:\n|$)/);
assert.match(cacheStep.with.path, /Library\/Caches\/electron-builder/);
assert.match(cacheStep.with.key, /matrix\.arch/);
assert.match(cacheStep.with.key, /hashFiles/);

for (const documentationPath of ["docs/development/RELEASE_PROCESS.md", "docs/development/RELEASE_PROCESS.zh-CN.md"]) {
  const documentation = readFileSync(join(projectRoot, documentationPath), "utf8");
  assert.match(documentation, /gh run rerun <run-id> --failed/);
  assert.match(documentation, /platforms=all/);
  assert.match(documentation, /platforms=windows-x64/);
}

console.log("desktop-release-platform-selection ok");
