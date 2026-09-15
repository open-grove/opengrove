import assert from "node:assert/strict";
import { createCiCheckPlan } from "./ci-check-plan.mjs";

const docs = createCiCheckPlan("pull_request", ["docs/development/BUILDING.md"]);
assert.deepEqual(
  docs.checks.map((check) => check.id),
  ["docs"],
);
assert.deepEqual(docs.platforms, []);
assert.deepEqual(docs.packages, []);

for (const event of ["push", "workflow_dispatch"]) {
  const main = createCiCheckPlan(event, []);
  assert.ok(main.checks.some((check) => check.id === "harness-state-storage"));
  assert.ok(main.checks.some((check) => check.id === "harness-release-contracts"));
  assert.deepEqual(
    main.platforms.map((check) => check.platform),
    ["win32", "darwin"],
  );
  assert.deepEqual(
    main.packages.map((check) => check.target),
    ["windows-x64", "mac-arm64"],
  );
  assert.equal(new Set(main.checks.map((check) => check.command)).size, main.checks.length);
}

for (const path of [
  "scripts/generate-host-client.mjs",
  "desktop/main.ts",
  "web/src/app.tsx",
  "src/server/workspace-store.ts",
  "package-lock.json",
  ".gitattributes",
]) {
  const plan = createCiCheckPlan("pull_request", [path]);
  assert.equal(plan.packages.length, 2, `${path} must check actual desktop packages`);
}
for (const event of ["pull_request", "merge_group"]) {
  const plan = createCiCheckPlan(event, ["src/server/workspace-store.ts"]);
  assert.equal(plan.platforms.length, 2, "storage must exercise native filesystem semantics");
  assert.ok(plan.checks.some((check) => check.id === "integration"));
  assert.ok(!plan.checks.some((check) => check.id.startsWith("harness-")));
}
assert.throws(() => createCiCheckPlan("unknown", []), /Unsupported CI event/);
console.log("CI check planning ok");
