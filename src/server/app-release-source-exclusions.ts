const APP_RELEASE_SOURCE_EXCLUDED_DIRECTORY_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "cache",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".claude",
  ".codex",
  ".gemini",
  ".kimi",
  ".opencode",
  ".aws",
  ".azure",
]);

const APP_RELEASE_SOURCE_EXCLUDED_FILES = new Set([
  ".ds_store",
  ".env",
  ".opengrove-package-manifest.json",
  ".opengrove-store-package.json",
]);

// A candidate source snapshot intentionally has its own policy. Runtime
// packExclude entries must never remove build inputs such as web/, build.mjs,
// or package-lock.json from the trusted builder's checkout.
export function appReleaseSourcePathExcluded(path: string, workspacePath: string): boolean {
  const normalized = path.toLowerCase();
  const workspace = workspacePath.toLowerCase();
  if (normalized === workspace || normalized.startsWith(`${workspace}/`)) return true;
  const segments = normalized.split("/");
  if (segments.some((segment) => APP_RELEASE_SOURCE_EXCLUDED_DIRECTORY_SEGMENTS.has(segment))) {
    return true;
  }
  const fileName = segments.at(-1) ?? "";
  return (
    APP_RELEASE_SOURCE_EXCLUDED_FILES.has(fileName) ||
    fileName.startsWith(".opengrove-store-package.json.") ||
    fileName.startsWith(".env.") ||
    /^(?:auth|credentials?|cookies?|sessions?|tokens?)(?:\.(?:json|ya?ml|toml|ini|db|sqlite3?))?$/i.test(fileName)
  );
}
