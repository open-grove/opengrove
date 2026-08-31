import { fileURLToPath } from "node:url";

const CODE_SCOPE_KEYS = [
  "base",
  "server",
  "web",
  "desktop",
  "kernel",
  "release",
  "unit",
  "integration",
  "webPackaging",
  "browserUi",
  "realAgent",
];

const CONSERVATIVE_PATHS = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/main-ci.yml",
  ".github/workflows/nightly.yml",
  "package.json",
  "package-lock.json",
  "scripts/ci-change-scope.mjs",
  "scripts/test-ci-change-scope.mjs",
  "scripts/run-built-harnesses.mjs",
  "tsconfig.json",
]);

const WINDOWS_MEDIA_CLEANUP_PATHS = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/main-ci.yml",
  ".github/workflows/nightly.yml",
  "package.json",
  "package-lock.json",
  "scripts/build-server.mjs",
  "scripts/ci-change-scope.mjs",
  "scripts/test-ci-change-scope.mjs",
  "src/server/raw-file-response.ts",
  "src/server/workspace-store.ts",
  "src/tests/raw-file-range-harness.ts",
  "tsconfig.json",
]);

const WINDOWS_APP_STORE_PATHS = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/main-ci.yml",
  ".github/workflows/nightly.yml",
  "package.json",
  "package-lock.json",
  "scripts/build-server.mjs",
  "scripts/ci-change-scope.mjs",
  "scripts/test-ci-change-scope.mjs",
  "src/app-builder/cli.ts",
  "src/app-builder/portable-path.ts",
  "src/environment/command-path.ts",
  "src/server/bridge-settings-store.ts",
  "src/server/bridge-state.ts",
  "src/server/bridge-types.ts",
  "src/server/mounted-apps.ts",
  "tsconfig.json",
]);

const WINDOWS_APP_STORE_PATH_PREFIXES = [
  "src/server/app-release-",
  "src/server/app-program-activation-",
  "src/server/app-store",
  "src/server/app-version-",
  "src/server/local-app-draft",
  "src/server/migrations/store-",
  "src/server/routes/app-store",
  "src/tests/app-program-activation-",
  "src/tests/app-release-",
  "src/tests/app-store-",
  "src/tests/app-version-",
];

const SHARED_PROTOCOL_PATHS = ["packages/agent-protocol/"];
const KERNEL_PATHS = ["src/kernel/", "src/runtime/", "docker/agents/"];
const WEB_PATHS = ["web/", "tests/playwright/"];
const DESKTOP_PATHS = ["desktop/", "build/"];
const RELEASE_WORKFLOW_PREFIXES = [".github/workflows/desktop-release", ".github/workflows/desktop-gate-replay"];

export function classifyCiChanges(eventName, changedPaths) {
  const isChangeRequest = eventName === "pull_request" || eventName === "merge_group";
  const docsOnly =
    isChangeRequest && changedPaths.length > 0 && changedPaths.every((path) => isDocumentationOnlyPath(path));

  if (docsOnly) return { ...emptyScope(), docsOnly: true };
  if (changedPaths.length === 0 || !isChangeRequest) return everyScope();

  const result = emptyScope();
  for (const path of changedPaths) classifyPath(path, result);
  result.docsOnly = false;
  return result;
}

function classifyPath(path, result) {
  if (isDocumentationOnlyPath(path)) return;

  result.base = true;

  if (CONSERVATIVE_PATHS.has(path)) {
    enableEveryCodeScope(result);
  } else if (startsWithAny(path, SHARED_PROTOCOL_PATHS)) {
    enableScopes(result, [
      "server",
      "web",
      "desktop",
      "kernel",
      "unit",
      "integration",
      "webPackaging",
      "browserUi",
      "realAgent",
    ]);
  } else if (isReleasePath(path)) {
    enableScopes(result, ["desktop", "release"]);
  } else if (isKernelPath(path)) {
    enableScopes(result, ["server", "kernel", "unit", "integration", "realAgent"]);
  } else if (isWebPath(path)) {
    enableScopes(result, ["web", "webPackaging", "browserUi"]);
  } else if (isDesktopPath(path)) {
    enableScopes(result, ["desktop"]);
  } else if (path.startsWith("src/")) {
    enableScopes(result, ["server", "unit", "integration"]);
  } else if (path.startsWith("extension/")) {
    enableScopes(result, ["web", "webPackaging"]);
  } else if (path.startsWith("examples/")) {
    enableScopes(result, ["server", "web", "unit", "integration", "webPackaging"]);
  } else if (path.startsWith("assets/")) {
    enableScopes(result, ["web", "desktop", "webPackaging", "browserUi"]);
  } else if (path.startsWith(".github/") || path.startsWith("docs/")) {
    // Repository policy and non-Markdown documentation assets need the base
    // checks, but do not imply a product build by themselves.
  } else {
    enableEveryCodeScope(result);
  }

  if (WINDOWS_MEDIA_CLEANUP_PATHS.has(path)) result.windowsMediaCleanup = true;
  if (WINDOWS_APP_STORE_PATHS.has(path) || WINDOWS_APP_STORE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    result.windowsAppStore = true;
  }
}

function isDocumentationOnlyPath(path) {
  return !path.startsWith("docs/releases/") && path !== "CHANGELOG.md" && /\.(?:md|mdx|markdown)$/iu.test(path);
}

function isReleasePath(path) {
  return (
    startsWithAny(path, RELEASE_WORKFLOW_PREFIXES) ||
    path.startsWith("docs/releases/") ||
    path === "CHANGELOG.md" ||
    path === "electron-builder.release.cjs" ||
    path === "electron-builder.yml" ||
    /^scripts\/.*(?:release|notari[sz]ation|installer|updater).*\.(?:mjs|sh)$/u.test(path)
  );
}

function isKernelPath(path) {
  return (
    startsWithAny(path, KERNEL_PATHS) ||
    (path.startsWith("src/server/kernel-") && path.endsWith(".ts")) ||
    /^src\/tests\/[^/]*(?:kernel|runtime)[^/]*$/u.test(path) ||
    path === ".github/workflows/real-agent-smoke.yml" ||
    path === ".github/workflows/build-agent-images.yml" ||
    /^scripts\/.*(?:kernel|real-runtime|agent-image).*\.(?:mjs|sh)$/u.test(path)
  );
}

function isWebPath(path) {
  return (
    startsWithAny(path, WEB_PATHS) ||
    path === "playwright.config.ts" ||
    path === "vite.config.ts" ||
    /^scripts\/.*(?:web|css|design-token|surface-ladder|spacing-token|visual-regression).*\.mjs$/u.test(path)
  );
}

function isDesktopPath(path) {
  return (
    startsWithAny(path, DESKTOP_PATHS) || path === "tsconfig.desktop.json" || /^scripts\/.*desktop.*\.mjs$/u.test(path)
  );
}

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function enableScopes(result, keys) {
  for (const key of keys) result[key] = true;
}

function enableEveryCodeScope(result) {
  enableScopes(result, CODE_SCOPE_KEYS);
  result.windowsMediaCleanup = true;
  result.windowsAppStore = true;
}

function emptyScope() {
  return {
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
}

function everyScope() {
  const result = emptyScope();
  enableEveryCodeScope(result);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [eventName = "", ...changedPaths] = process.argv.slice(2);
  const result = classifyCiChanges(eventName, changedPaths);
  for (const [key, value] of Object.entries(result)) {
    const outputName = key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
    console.log(`${outputName}=${value}`);
  }
}
