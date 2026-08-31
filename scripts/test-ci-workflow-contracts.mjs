import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prWorkflow = readFileSync(resolve(projectRoot, ".github/workflows/ci.yml"), "utf8");
const mainWorkflow = readFileSync(resolve(projectRoot, ".github/workflows/main-ci.yml"), "utf8");
const nightlyWorkflow = readFileSync(resolve(projectRoot, ".github/workflows/nightly.yml"), "utf8");
const realAgentWorkflow = readFileSync(resolve(projectRoot, ".github/workflows/real-agent-smoke.yml"), "utf8");
const releaseProcess = readFileSync(resolve(projectRoot, "docs/development/RELEASE_PROCESS.md"), "utf8");
const releaseProcessZh = readFileSync(resolve(projectRoot, "docs/development/RELEASE_PROCESS.zh-CN.md"), "utf8");

assert.match(prWorkflow, /^name: CI$/mu);
assert.match(
  prWorkflow,
  /^  pull_request:\n  merge_group:$/mu,
  "PR CI should validate pull requests and merge queue groups",
);
assert.doesNotMatch(prWorkflow, /^  push:/mu, "pushes to main belong to the separate Main CI workflow");

for (const output of [
  "docs_only",
  "base",
  "server",
  "web",
  "desktop",
  "kernel",
  "release",
  "unit",
  "integration",
  "web_packaging",
  "browser_ui",
  "real_agent",
  "windows_media_cleanup",
  "windows_app_store",
]) {
  assert.match(prWorkflow, new RegExp(`^      ${output}:`, "mu"), `PR CI should expose the ${output} scope`);
}

const expectedDependencies = [
  "scope",
  "docs",
  "base",
  "server",
  "web",
  "desktop",
  "release-contracts",
  "unit",
  "integration",
  "kernel",
  "web-packaging",
  "browser-ui",
  "desktop-protocol",
  "media-streaming-windows",
  "app-store-windows",
  "real-agent",
];
const requiredSection = prWorkflow.slice(prWorkflow.indexOf("  required:\n"));
const dependencyBlock = /\n    needs:\n((?:      - [^\n]+\n)+)/u.exec(requiredSection)?.[1];
assert.ok(dependencyBlock, "PR required should declare its dependency list");
assert.deepEqual(
  dependencyBlock
    .trim()
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/u, "")),
  expectedDependencies,
  "PR required should own every conditional PR result",
);
assert.match(requiredSection, /^    name: PR required$/mu);
assert.match(requiredSection, /^    if: always\(\)$/mu);
assert.match(requiredSection, /^          CI_JOB_EXPECTATIONS: \|$/mu);
for (const [job, output] of [
  ["docs", "docs_only"],
  ["base", "base"],
  ["server", "server"],
  ["web", "web"],
  ["desktop", "desktop"],
  ["release-contracts", "release"],
  ["unit", "unit"],
  ["integration", "integration"],
  ["kernel", "kernel"],
  ["web-packaging", "web_packaging"],
  ["browser-ui", "browser_ui"],
  ["media-streaming-windows", "windows_media_cleanup"],
  ["app-store-windows", "windows_app_store"],
  ["real-agent", "real_agent"],
]) {
  assert.match(
    requiredSection,
    new RegExp(`${job}=\\$\\{\\{ needs\\.scope\\.outputs\\.${output}`, "u"),
    `PR required should bind ${job} to the ${output} scope output`,
  );
}
assert.match(requiredSection, /run: node scripts\/check-ci-results\.mjs/u);
assert.match(prWorkflow, /^  real-agent:\n    name: Real Agent contracts$/mu);
assert.match(prWorkflow, /^    uses: \.\/\.github\/workflows\/real-agent-smoke\.yml$/mu);
assert.match(prWorkflow, /^    secrets: inherit$/mu);

assert.match(mainWorkflow, /^name: Main CI$/mu);
assert.match(mainWorkflow, /^  push:\n    branches:\n      - main$/mu);
assert.match(mainWorkflow, /^  workflow_dispatch:$/mu);
assert.match(mainWorkflow, /^  cancel-in-progress: true$/mu, "a newer main tip should supersede obsolete Main CI work");
for (const command of [
  "check:static:base",
  "check:static:server",
  "check:web",
  "check:desktop",
  "check:static:release",
]) {
  assert.match(mainWorkflow, new RegExp(`command: ${command}`, "u"), `Main CI should schedule ${command}`);
}
assert.match(mainWorkflow, /npm run \$\{\{ matrix\.command \}\}/u);
for (const groupName of [
  "state-storage",
  "rooms-routines",
  "apps-knowledge",
  "app-lifecycle",
  "kernels-providers",
  "web-desktop",
  "release-contracts",
]) {
  assert.match(
    mainWorkflow,
    new RegExp(`group: ${groupName}`, "u"),
    `Main CI should run the ${groupName} harness group`,
  );
}
assert.match(mainWorkflow, /^    name: Main CI result$/mu);
assert.match(mainWorkflow, /CI_JOB_RESULTS: \$\{\{ toJSON\(needs\) \}\}/u);

assert.match(nightlyWorkflow, /^name: Nightly$/mu);
assert.match(nightlyWorkflow, /cron: "0 2,14 \* \* \*"/u, "Nightly should run twice daily");
assert.match(nightlyWorkflow, /^  workflow_dispatch:$/mu);
assert.match(nightlyWorkflow, /^  real-agent:\n    name: Real Agent matrix$/mu);
assert.match(nightlyWorkflow, /uses: \.\/\.github\/workflows\/real-agent-smoke\.yml/u);
assert.match(nightlyWorkflow, /platform: \[macos-latest, windows-latest\]/u);
assert.doesNotMatch(
  nightlyWorkflow,
  /platform: \[ubuntu-latest, macos-latest, windows-latest\]/u,
  "Nightly should not repeat the integration subset after the Linux full harness already ran it",
);
assert.doesNotMatch(
  nightlyWorkflow,
  /runner\.os == 'Linux'|Install Chromium and Linux dependencies/u,
  "the macOS/Windows matrix should not retain unreachable Linux setup",
);
assert.match(nightlyWorkflow, /^    name: Nightly result$/mu);

assert.match(realAgentWorkflow, /^  workflow_call:$/mu);
assert.doesNotMatch(
  realAgentWorkflow,
  /^  pull_request:/mu,
  "Real Agent PR runs should be owned by CI so PR required can wait for them without duplicate probes",
);
assert.match(realAgentWorkflow, /^  push:\n    branches:\n      - main\n    paths:$/mu);
assert.doesNotMatch(
  realAgentWorkflow,
  /^  schedule:/mu,
  "Nightly should be the only owner of the scheduled live matrix",
);
for (const path of [
  "src/kernel/**",
  "src/runtime/**",
  "src/server/kernel-*.ts",
  "src/tests/*kernel*",
  "src/tests/*runtime*",
  "packages/agent-protocol/**",
  "docker/agents/**",
]) {
  assert.match(realAgentWorkflow, new RegExp(`- "${path.replaceAll("*", "\\*")}"`, "u"));
}
assert.match(realAgentWorkflow, /github\.event_name == 'push' && github\.ref/u);
assert.match(realAgentWorkflow, /cancel-in-progress: .*github\.event_name == 'push'/u);

for (const [name, document] of [
  ["English", releaseProcess],
  ["Chinese", releaseProcessZh],
]) {
  assert.match(document, /Main CI/u, `${name} release docs should require exact-SHA Main CI evidence`);
  assert.match(document, /Nightly/u, `${name} release docs should explain recent ancestor Nightly evidence`);
  assert.match(document, /<current-main-commit>/u, `${name} release docs should dispatch the current main tip`);
}

console.log("CI workflow contract harness ok");
