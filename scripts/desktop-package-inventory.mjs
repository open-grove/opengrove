import { createHash } from "node:crypto";

export const requiredDesktopRuntimePackageFiles = [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md",
  "node_modules/yaml/dist/doc/directives.js",
];

// Keep the immutable v0.6.0 golden artifact contract explicit instead of
// applying package requirements that were introduced after those bytes shipped.
export const historicalDesktopRuntimePackageFiles = [
  "node_modules/@opengrove/agent-protocol/dist/locale-registry.js",
  "node_modules/@opengrove/agent-protocol/package.json",
  "node_modules/yaml/dist/doc/directives.js",
];

export const forbiddenDesktopRuntimePackagePrefixes = [
  "node_modules/@milkdown/crepe/",
  "node_modules/@milkdown/kit/",
  "node_modules/@vidstack/react/",
  "node_modules/react-markdown/",
  "node_modules/remark-gfm/",
];

// Keep absence requirements frozen alongside the required-file contract so a
// future package rule cannot invalidate immutable v0.6.0 release bytes.
export const historicalDesktopRuntimeForbiddenPackagePrefixes = [
  "node_modules/@milkdown/crepe/",
  "node_modules/@milkdown/kit/",
  "node_modules/@vidstack/react/",
  "node_modules/react-markdown/",
  "node_modules/remark-gfm/",
];

export function desktopDistInventory(packagedFiles) {
  const files = packagedFiles
    .map(normalizeArchivePath)
    .filter((path) => path.startsWith("dist/"))
    .sort();
  return {
    fileCount: files.length,
    sha256: createHash("sha256")
      .update(files.length > 0 ? `${files.join("\n")}\n` : "")
      .digest("hex"),
  };
}

export function desktopPackageInventoryProblems({
  sourceFiles,
  packagedFiles,
  resourceFiles,
  appUpdateConfig,
  requiredPackageFiles = [],
  forbiddenPackagePrefixes = [],
}) {
  const packaged = new Set(packagedFiles.map(normalizeArchivePath));
  const resources = new Set(resourceFiles.map(normalizeArchivePath));
  const missing = sourceFiles
    .map(normalizeArchivePath)
    .filter((path) => !packaged.has(path))
    .sort();
  const problems = [];
  const missingRequiredPackageFiles = requiredPackageFiles
    .map(normalizeArchivePath)
    .filter((path) => !packaged.has(path));
  if (missingRequiredPackageFiles.length > 0) {
    problems.push(
      `required third-party desktop runtime missing from app.asar: ${missingRequiredPackageFiles.join(", ")}`,
    );
  }
  const forbiddenPackagedFiles = [...packaged]
    .filter((path) => forbiddenPackagePrefixes.some((prefix) => path.startsWith(normalizeArchivePath(prefix))))
    .sort();
  if (forbiddenPackagedFiles.length > 0) {
    problems.push(`renderer-only dependency leaked into app.asar: ${forbiddenPackagedFiles.join(", ")}`);
  }
  if (missing.length > 0) {
    problems.push(`compiled desktop runtime missing from app.asar: ${missing.join(", ")}`);
  }
  const source = new Set(sourceFiles.map(normalizeArchivePath));
  const unexpected = [...packaged].filter((path) => path.startsWith("dist/") && !source.has(path)).sort();
  if (unexpected.length > 0) {
    problems.push(`compiled desktop runtime has unexpected files in app.asar: ${unexpected.join(", ")}`);
  }
  if (!resources.has("app-update.yml")) {
    problems.push("desktop resources are missing app-update.yml; electron-updater cannot initialize");
  } else if (
    appUpdateConfig &&
    (appUpdateConfig.provider !== "generic" ||
      appUpdateConfig.url !== "https://desktop-updates.invalid/" ||
      appUpdateConfig.updaterCacheDirName !== "opengrove-updater")
  ) {
    problems.push("desktop app-update.yml must use the inert bootstrap URL and the stable updater cache directory");
  }
  return problems;
}

function normalizeArchivePath(value) {
  return value.replaceAll("\\", "/").replace(/^\/+/, "");
}
