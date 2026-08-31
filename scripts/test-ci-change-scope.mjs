import assert from "node:assert/strict";
import { classifyCiChanges } from "./ci-change-scope.mjs";

const noCodeScopes = {
  docsOnly: false,
  base: false,
  server: false,
  web: false,
  desktop: false,
  kernel: false,
  release: false,
  unit: false,
  integration: false,
  webPackaging: false,
  browserUi: false,
  realAgent: false,
  windowsMediaCleanup: false,
  windowsAppStore: false,
};

const everyCodeScope = {
  docsOnly: false,
  base: true,
  server: true,
  web: true,
  desktop: true,
  kernel: true,
  release: true,
  unit: true,
  integration: true,
  webPackaging: true,
  browserUi: true,
  realAgent: true,
  windowsMediaCleanup: true,
  windowsAppStore: true,
};

assert.deepEqual(
  classifyCiChanges("pull_request", ["docs/product/overview.md", "README.MD"]),
  { ...noCodeScopes, docsOnly: true },
  "a documentation-only PR should run only documentation checks",
);

assert.deepEqual(
  classifyCiChanges("pull_request", ["web/src/app.tsx"]),
  {
    ...noCodeScopes,
    base: true,
    web: true,
    webPackaging: true,
    browserUi: true,
  },
  "Web changes should stay inside the Web validation boundary",
);

assert.deepEqual(
  classifyCiChanges("pull_request", ["src/server/router.ts"]),
  {
    ...noCodeScopes,
    base: true,
    server: true,
    unit: true,
    integration: true,
  },
  "Host Server changes should run Server, unit, and integration validation",
);

assert.deepEqual(
  classifyCiChanges("pull_request", ["desktop/main.ts"]),
  {
    ...noCodeScopes,
    base: true,
    desktop: true,
  },
  "Desktop shell changes should not start unrelated Web or Kernel jobs",
);

assert.deepEqual(
  classifyCiChanges("pull_request", ["src/runtime/codex-app-server.ts"]),
  {
    ...noCodeScopes,
    base: true,
    server: true,
    kernel: true,
    unit: true,
    integration: true,
    realAgent: true,
  },
  "Kernel runtime changes should add capability, integration, and live-provider coverage",
);

for (const path of [
  "src/server/kernel-login.ts",
  "src/tests/kernel-capability-source-harness.ts",
  "src/tests/runtime-environment-harness.ts",
]) {
  assert.deepEqual(
    classifyCiChanges("pull_request", [path]),
    {
      ...noCodeScopes,
      base: true,
      server: true,
      kernel: true,
      unit: true,
      integration: true,
      realAgent: true,
    },
    `${path} should use the same Kernel and Real Agent scope before and after merge`,
  );
}

assert.deepEqual(
  classifyCiChanges("pull_request", [".github/workflows/desktop-release.yml"]),
  {
    ...noCodeScopes,
    base: true,
    desktop: true,
    release: true,
  },
  "release workflow changes should run release and Desktop contracts only",
);

assert.deepEqual(
  classifyCiChanges("pull_request", ["docs/releases/v0.7.0.md"]),
  {
    ...noCodeScopes,
    base: true,
    desktop: true,
    release: true,
  },
  "release notes are release inputs rather than documentation-only changes",
);

assert.deepEqual(
  classifyCiChanges("pull_request", ["packages/agent-protocol/src/bridge-contract.ts"]),
  {
    ...noCodeScopes,
    base: true,
    server: true,
    web: true,
    desktop: true,
    kernel: true,
    unit: true,
    integration: true,
    webPackaging: true,
    browserUi: true,
    realAgent: true,
  },
  "shared protocol changes should cross every product boundary that consumes the protocol",
);

for (const path of ["package.json", "package-lock.json", "tsconfig.json", ".github/workflows/ci.yml"]) {
  assert.deepEqual(
    classifyCiChanges("pull_request", [path]),
    everyCodeScope,
    `${path} can affect every validation boundary and must use the conservative scope`,
  );
}

assert.deepEqual(
  classifyCiChanges("merge_group", ["web/src/app.tsx"]),
  {
    ...noCodeScopes,
    base: true,
    web: true,
    webPackaging: true,
    browserUi: true,
  },
  "merge queue validation should classify the candidate merge like a pull request",
);

assert.deepEqual(
  classifyCiChanges("pull_request", ["future-subsystem/entry.ts"]),
  everyCodeScope,
  "an unknown code path must fail open to full validation rather than silently losing coverage",
);

assert.deepEqual(
  classifyCiChanges("pull_request", []),
  everyCodeScope,
  "an unavailable diff must conservatively run every validation boundary",
);

for (const path of [
  "src/server/raw-file-response.ts",
  "src/server/workspace-store.ts",
  "src/tests/raw-file-range-harness.ts",
  "scripts/build-server.mjs",
]) {
  assert.equal(
    classifyCiChanges("pull_request", [path]).windowsMediaCleanup,
    true,
    `${path} affects the Windows file-handle regression`,
  );
}

for (const path of [
  "src/app-builder/cli.ts",
  "src/app-builder/portable-path.ts",
  "src/environment/command-path.ts",
  "src/server/app-store.ts",
  "src/server/app-program-activation-recovery.ts",
  "src/server/app-release-local-build.ts",
  "src/server/app-version-manager.ts",
  "src/server/migrations/store-workspace-binding-v1.ts",
  "src/server/routes/app-store.ts",
  "src/tests/app-program-activation-recovery-harness.ts",
  "src/tests/app-release-local-build.test.ts",
  "src/tests/app-store-harness.ts",
]) {
  assert.equal(
    classifyCiChanges("pull_request", [path]).windowsAppStore,
    true,
    `${path} affects the Windows Store App lifecycle regression`,
  );
}

assert.equal(
  classifyCiChanges("pull_request", ["src/server/router.ts"]).windowsAppStore,
  false,
  "an unrelated Server change should not start the Windows Store App runner",
);

console.log("CI change scope harness ok");
