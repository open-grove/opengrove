import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessGroups, harnessInventory, harnessOwners, integrationSuites } from "./ci-harness-inventory.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));

assert.equal(
  packageJson.scripts["check:static"],
  "npm run check:ci",
  "the legacy check:static name should remain a compatibility alias",
);
assert.equal(
  packageJson.scripts["check:ci"],
  "npm run check:static:base && npm run check:static:server && npm run check:web && npm run check:desktop && npm run check:static:release",
  "the CI aggregate must retain every static and contract ownership group",
);
assert.match(
  packageJson.scripts["check:static:base"],
  /npm run check:repository-hygiene/u,
  "the base repository gate must reject task review residue and personal home paths",
);
assert.equal(
  packageJson.scripts["typecheck:desktop"],
  "npm run build:protocol && tsc -p tsconfig.desktop.json --noEmit",
  "the independently scheduled desktop group must materialize protocol declarations itself",
);
assert.equal(
  packageJson.scripts.prepare,
  "npm run build:workspace-packages",
  "dependency installation must materialize the workspace packages consumed by independently scheduled jobs",
);
assert.equal(
  packageJson.scripts["build:workspace-packages"],
  "npm run build:protocol && npm --workspace @opengrove/client run build",
  "workspace package preparation must cover the protocol, Agent protocol, and generated Host client",
);
assert.equal(
  packageJson.scripts["check:web"],
  "npm run check:web:static && npm run test:contract:web",
  "the Web ownership group should include static analysis and behavior contracts",
);
assert.equal(
  packageJson.scripts["check:static:web"],
  "npm run check:web",
  "the old Web group name should remain a compatibility alias",
);
assert.equal(
  packageJson.scripts["check:desktop"],
  "npm run check:desktop:static && npm run test:contract:desktop",
  "the Desktop ownership group should include static analysis and behavior contracts",
);
assert.equal(
  packageJson.scripts["check:static:desktop"],
  "npm run check:desktop",
  "the old Desktop group name should remain a compatibility alias",
);

const expectedFullGroupSizes = {
  "state-storage": 8,
  "rooms-routines": 23,
  "apps-knowledge": 15,
  "app-lifecycle": 18,
  "kernels-providers": 23,
  "web-desktop": 16,
  "release-contracts": 1,
};
const groupSetupCommands = {
  "state-storage": "npm run build:server && ",
  "rooms-routines": "npm run build:server && ",
  "apps-knowledge": "npm run build:server && ",
  "app-lifecycle": "npm run build:server && ",
  "kernels-providers": "npm run build:server && ",
  "web-desktop": "npm run build:server && ",
  "release-contracts": "",
};

const groupedLabels = [];
for (const [groupName, expectedSize] of Object.entries(expectedFullGroupSizes)) {
  assert.equal(
    harnessGroups[groupName].length,
    expectedSize,
    `${groupName} should keep its reviewed harness inventory`,
  );
  assert.equal(
    packageJson.scripts[`test:harness:${groupName}`],
    `${groupSetupCommands[groupName]}node scripts/run-built-harnesses.mjs ${groupName}`,
    `${groupName} should have a directly runnable package script`,
  );
  groupedLabels.push(...harnessGroups[groupName].map((task) => task.id));
}

assert.equal(harnessInventory.length, 104, "the canonical deterministic harness inventory must not shrink silently");
assert.equal(
  harnessGroups.full,
  harnessInventory,
  "the full group should be the canonical inventory, not a second list",
);
assert.equal(new Set(harnessInventory.map((task) => task.id)).size, 104, "every harness id must be unique");
assert.equal(harnessGroups.integration.length, 34, "the affected-integration subset must not shrink silently");
assert.equal(
  new Set(harnessGroups.integration.map((task) => task.id)).size,
  34,
  "the integration subset must not execute a canonical harness twice",
);
assert.equal(new Set(groupedLabels).size, groupedLabels.length, "a full harness must have exactly one owner group");
assert.deepEqual(
  new Set(groupedLabels),
  new Set(harnessGroups.full.map((task) => task.id)),
  "the named groups must cover the complete deterministic harness",
);
assert.deepEqual(
  Object.keys(expectedFullGroupSizes),
  harnessOwners,
  "the test and inventory should agree on the complete owner vocabulary",
);
assert.deepEqual(
  new Set(harnessGroups.integration),
  new Set(integrationSuites.flatMap((suite) => harnessGroups[suite])),
  "integration should be derived from the named subsets without another task list",
);

assert.deepEqual(
  harnessGroups["state-storage"]
    .filter((task) => task.id === "state-file-lock" || task.id === "sqlite-state-store")
    .map((task) => task.id),
  ["state-file-lock", "sqlite-state-store"],
  "the concurrency and SQLite regressions belong to the main state-storage group",
);
assert.deepEqual(
  harnessGroups["release-contracts"].map((task) => task.id),
  ["desktop-release-pipeline"],
  "release workflow contracts must stay isolated from ordinary product tests",
);

for (const task of harnessGroups.full) {
  assert.deepEqual(
    Object.keys(task).filter((field) => !["id", "path", "owner", "suite", "isolation"].includes(field)),
    [],
    `${task.id} should use only the reviewed, non-redundant inventory fields`,
  );
  const sourcePath = task.path.startsWith("dist/tests/")
    ? task.path.replace(/^dist\/tests\//u, "src/tests/").replace(/\.js$/u, ".ts")
    : task.path;
  assert.equal(existsSync(resolve(projectRoot, sourcePath)), true, `${task.id} should reference a tracked test source`);
}

console.log("CI suite ownership harness ok");
