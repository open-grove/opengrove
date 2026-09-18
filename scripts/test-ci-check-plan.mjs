import assert from "node:assert/strict";
import { createCiCheckPlan } from "./ci-check-plan.mjs";

const docs = createCiCheckPlan("pull_request", ["docs/development/BUILDING.md"]);
assert.deepEqual(
  docs.checks.map((check) => check.id),
  ["docs"],
);
assert.deepEqual(docs.platforms, []);
assert.deepEqual(docs.packages, []);
assert.equal(docs.checks[0].preparation, "node", "documentation must not install or build the application");
assert.equal(
  createCiCheckPlan("pull_request", ["src/server/workspace-store.ts"]).checks.find((check) => check.id === "server")
    .preparation,
  "server",
  "server security checks resolve the packaged #protocol runtime and need built server inputs",
);
const skill = createCiCheckPlan("pull_request", ["src/skills/bundled/opengrove-developer-mode-guard/SKILL.md"]);
assert.ok(
  skill.checks.some((check) => check.id === "integration"),
  "runtime Markdown must select product tests",
);
for (const [path, task] of [
  ["src/runtime/hermes-runtime.ts", "hermes-runtime"],
  ["src/runtime/claude-agent-sdk-runtime.ts", "claude-agent-sdk-runtime"],
  ["src/runtime/claude-agent-sdk-runtime.ts", "native-claude-context"],
  ["src/runtime/openclaw-gateway-runtime.ts", "openclaw-gateway-runtime"],
]) {
  const plan = createCiCheckPlan("pull_request", [path]);
  const tasks = plan.checks.flatMap((check) => check.tasks ?? []);
  assert.ok(tasks.includes(task), `${path} must run its dedicated harness before merge`);
  assert.equal(new Set(tasks).size, tasks.length, "the Linux execution plan must not duplicate harnesses");
}

for (const event of ["pull_request", "merge_group", "push"]) {
  for (const path of [
    "src/runtime/openclaw-gateway-runtime.ts",
    "src/core/turn-context.ts",
    "scripts/lib/openclaw-context-fixture.mjs",
  ]) {
    const check = createCiCheckPlan(event, [path]).checks.find((check) => check.id === "native-context");
    assert.deepEqual(check?.tasks, ["native-openclaw-context"], `${event}: ${path} must run the real Gateway probe`);
    assert.equal(check.preparation, "server", "the native fixture imports built Host modules");
  }
}

const crossOwnerWebCases = [
  ["web/src/components/apps/mounted-app-chat-panel.tsx", "web-mounted-app-group-deletion"],
  ["web/src/components/network/app-store-publish-page.tsx", "web-app-store-publish-page"],
  ["web/src/components/network/app-store-publish-page.tsx", "web-app-release-recovery"],
  ["web/src/components/network/app-version-management-page.tsx", "web-app-version-management"],
  ["web/src/runtime/account-profile-store.ts", "web-account-profile-storage"],
  ["web/src/runtime/kernel-capability-ui-policy.ts", "kernel-capability-ui-policy"],
  ["web/src/messages.ts", "agent-output-resolver"],
];
for (const event of ["pull_request", "merge_group"]) {
  for (const [path, task] of crossOwnerWebCases) {
    const plan = createCiCheckPlan(event, [path]);
    const tasks = plan.checks.flatMap((check) => check.tasks ?? []);
    assert.ok(tasks.includes(task), `${event}: ${path} must select ${task} across owner boundaries`);
    assert.ok(!tasks.includes("state-file-lock"), "Web inputs must not select the entire storage owner");
    assert.ok(!tasks.includes("app-release-coordinator"), "Web inputs must not select the entire lifecycle owner");
    assert.ok(!tasks.includes("hermes-runtime"), "Web inputs must not select the entire kernel owner");
  }
  for (const path of [
    "web/src/components/ui/confirm-dialog.tsx",
    "web/src/styles.css",
    "web/src/i18n.ts",
    "web/src/components/rooms/rooms-shared-state.ts",
  ]) {
    const tasks = createCiCheckPlan(event, [path]).checks.flatMap((check) => check.tasks ?? []);
    for (const [, task] of crossOwnerWebCases)
      assert.ok(tasks.includes(task), `${event}: shared Web input ${path} must retain ${task}`);
  }
  const mixed = createCiCheckPlan(event, [
    ...crossOwnerWebCases.map(([path]) => path),
    "scripts/test-web-mounted-app-group-deletion.mjs",
    "src/server/app-store.ts",
  ]).checks.flatMap((check) => check.tasks ?? []);
  assert.equal(new Set(mixed).size, mixed.length, "owner, baseline and input matches must execute each task once");
}

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
