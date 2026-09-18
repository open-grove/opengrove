import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  affectedHarnesses,
  harnessGroups,
  harnessInventory,
  harnessOwners,
  harnessTasksForPlatform,
  integrationSuites,
} from "./ci-harness-inventory.mjs";

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
assert.match(
  packageJson.scripts["check:static:release"],
  /npm run check:release-notes/u,
  "ordinary CI must validate release copy and run its format, context, and rendering regressions",
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
  "state-storage": 11,
  "rooms-routines": 23,
  "apps-knowledge": 21,
  "app-lifecycle": 24,
  "kernels-providers": 36,
  "web-desktop": 21,
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

assert.equal(harnessInventory.length, 139, "the canonical harness inventory must not shrink silently");
assert.deepEqual(
  harnessGroups.full,
  harnessInventory.filter((task) => !task.network),
  "the full group should be the canonical inventory, not a second list",
);
assert.equal(
  new Set(harnessInventory.map((task) => task.id)).size,
  harnessInventory.length,
  "every harness id must be unique",
);
assert.equal(harnessGroups.integration.length, 46, "the affected-integration subset must not shrink silently");
assert.ok(
  harnessGroups.integration.some((task) => task.id === "ww-provider-provisioning"),
  "PR integration checks must cover model/provider edits during account provisioning",
);
assert.equal(
  new Set(harnessGroups.integration.map((task) => task.id)).size,
  46,
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
  new Set(integrationSuites.flatMap((suite) => harnessGroups[suite]).filter((task) => !task.network)),
  "integration should be derived from the named subsets without another task list",
);

assert.deepEqual(
  harnessGroups["state-storage"]
    .filter((task) =>
      ["state-file-lock", "sqlite-state-store", "storage-overview", "storage-maintenance-gate"].includes(task.id),
    )
    .map((task) => task.id),
  ["state-file-lock", "sqlite-state-store", "storage-overview", "storage-maintenance-gate"],
  "the storage accounting and maintenance regressions belong to the main state-storage group",
);
assert.deepEqual(
  harnessGroups["release-contracts"].map((task) => task.id),
  ["desktop-release-pipeline"],
  "release workflow contracts must stay isolated from ordinary product tests",
);

const windowsTasks = harnessTasksForPlatform(harnessGroups.integration, "win32");
assert.equal(windowsTasks.length, 43);
assert.ok(windowsTasks.some((task) => task.id === "app-release-windows-build-boundary"));
assert.deepEqual(
  harnessGroups.integration.filter((task) => !windowsTasks.includes(task)).map((task) => task.id),
  ["app-release-coordinator", "app-release-registry-migration", "app-release-apply"],
);
for (const platform of ["darwin", "linux"]) {
  const selected = harnessTasksForPlatform(harnessGroups.integration, platform);
  assert.equal(selected.length, 45);
  assert.deepEqual(
    harnessGroups.integration.filter((task) => !selected.includes(task)).map((task) => task.id),
    ["app-release-windows-build-boundary"],
  );
}

for (const task of harnessGroups.full) {
  assert.deepEqual(
    Object.keys(task).filter(
      (field) =>
        !["id", "path", "owner", "suite", "isolation", "platforms", "network", "timeoutMs", "build", "inputs"].includes(
          field,
        ),
    ),
    [],
    `${task.id} should use only the reviewed, non-redundant inventory fields`,
  );
  const sourcePath = task.path.startsWith("dist/tests/")
    ? task.path.replace(/^dist\/tests\//u, "src/tests/").replace(/\.js$/u, ".ts")
    : task.path;
  assert.equal(existsSync(resolve(projectRoot, sourcePath)), true, `${task.id} should reference a tracked test source`);
  for (const input of task.inputs ?? [])
    assert.ok(existsSync(resolve(projectRoot, input)), `${task.id} declares a missing input: ${input}`);
  // Catch newly added literal Web dependencies even when the harness belongs
  // to a backend shard. Shared/transitive Web inputs have separate planner cases.
  for (const [, input] of readFileSync(resolve(projectRoot, sourcePath), "utf8").matchAll(
    /["'](web\/src(?:\/[^"'\s]+)?)["']/gu,
  ))
    assert.ok(
      affectedHarnesses([input], false).some((selected) => selected.id === task.id),
      `${task.id} reads ${input}, which must select that harness independently of its owner`,
    );
}

assert.deepEqual(
  harnessGroups.network.map((task) => task.id),
  ["native-openclaw-context", "packed-runtime"],
);
assert.deepEqual(harnessGroups.network.find((task) => task.id === "native-openclaw-context")?.args, [
  "2026.9.2",
  "--context",
]);
assert.ok(!harnessGroups.full.some((task) => task.network));
console.log("CI suite ownership harness ok");

assert.ok(
  !harnessInventory.some((task) => task.id === "desktop-dev-processes"),
  "desktop process checks belong to the desktop contract owner",
);
assert.ok(packageJson.scripts["check:desktop-dev-runtime"].includes("scripts/test-desktop-dev-processes.mjs"));

for (const file of readdirSync(resolve(projectRoot, "src/tests")).filter((file) => file.endsWith("-harness.ts"))) {
  const path = `dist/tests/${file.replace(/\.ts$/u, ".js")}`;
  assert.ok(
    harnessInventory.some((task) => task.path === path),
    `${file} has no CI owner`,
  );
}
const executionKeys = harnessGroups.full.map((task) => `${task.path}:${task.isolation ?? "default"}`);
assert.equal(new Set(executionKeys).size, executionKeys.length, "same-environment harnesses must have one owner");
