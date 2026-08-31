import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { JsonObject } from "../core.js";
import type { BridgeState } from "./bridge-types.js";
import { safeResolveInside, type WorkspaceScope } from "./workspace-store.js";
import { mountedAppUiMigrationRequired } from "../app-builder/compat/legacy-app-ui.compat.js";
import { resolveAppManifestPresentation } from "../app-builder/manifest-localization.js";
import { resolveHostLanguageSettings } from "./language-preference.js";
import { validateAppManifestFile } from "../app-builder/manifest.js";
import { readAppStorePackageInstallMarker } from "./app-store-install-marker.js";

export interface MountedAppTarget {
  /** Stable identity of this mounted App installation; it does not follow editable manifest fields. */
  localAppId: string;
  /** Business App identity declared by the current manifest. */
  id: string;
  title: string;
  appRoot: string;
  workspaceRoot: string;
  workspace: WorkspaceScope;
  manifest: JsonObject;
}

export interface MountedAppManifestReadResult {
  status: "valid" | "missing" | "invalid" | "unreadable";
  manifest?: JsonObject;
  manifestPath?: string;
  issues: string[];
}

export function resolveMountedAppTarget(state: BridgeState, appId: string): MountedAppTarget | undefined {
  for (const mountedApp of state.settings.mountedApps ?? []) {
    if (mountedApp.enabled === false || !mountedApp.path?.trim()) continue;
    const appRoot = resolvePathLike(mountedApp.path);
    if (!existsSync(appRoot)) continue;
    const manifestRead = readMountedAppManifest(appRoot);
    if (mountedAppManifestIssue(appRoot, manifestRead)) continue;
    const manifest = manifestRead.manifest!;
    const manifestId = stringValue(manifest.id) || stringValue(manifest.name);
    const id = manifestId || mountedApp.id || basename(appRoot);
    const localAppId = stringValue(mountedApp.id) || id;
    if (appId !== id && appId !== `app:${id}` && appId !== localAppId && appId !== `app:${localAppId}`) continue;
    const workspaceRoot = resolveMountedAppWorkspaceRoot(appRoot, manifest, mountedApp.workspacePath);
    const presentation = resolveAppManifestPresentation(manifest, resolveHostLanguageSettings(state.settings));
    return {
      localAppId,
      id,
      title: presentation.title || mountedApp.title || id,
      appRoot,
      workspaceRoot,
      workspace: {
        kind: "local",
        appId: id,
        root: workspaceRoot,
      },
      manifest,
    };
  }
  return undefined;
}

/** Pure read: compatibility migration is only allowed at startup/import boundaries. */
export function readMountedAppManifest(appRoot: string): MountedAppManifestReadResult {
  const result = validateAppManifestFile(resolvePathLike(appRoot));
  if (result.manifest) {
    return {
      status: "valid",
      manifest: result.manifest as JsonObject,
      manifestPath: result.manifestPath,
      issues: result.issues,
    };
  }
  const missing = !result.manifestPath;
  const unreadable = result.issues.some((issue) => issue.startsWith("manifest unreadable:"));
  return {
    status: missing ? "missing" : unreadable ? "unreadable" : "invalid",
    manifestPath: result.manifestPath,
    issues: result.issues,
  };
}

export function mountedAppManifestIssue(appRoot: string, result = readMountedAppManifest(appRoot)): string | undefined {
  if (result.status !== "valid" || !result.manifest) {
    return `app_manifest_${result.status}`;
  }
  if (mountedAppUiMigrationRequired(result.manifest)) {
    return "app_manifest_migration_required";
  }
  return undefined;
}

export function mountedAppRuntimeFingerprint(target: MountedAppTarget): string {
  return createMountedAppFingerprint(target, collectMountedAppRuntimeFiles(target), {
    version: "opengrove-mounted-app-runtime-v1",
    includeRoot: true,
    cache: mountedAppFingerprintCache,
  });
}

export function mountedAppSessionCompatibilityVersion(target: MountedAppTarget): string {
  const manifestVersion = stringValue(target.manifest.version);
  if (manifestVersion) return manifestVersion;
  const installMarker = readAppStorePackageInstallMarker(target.appRoot);
  return stringValue(installMarker?.source) === "registry" && stringValue(installMarker?.appId) === target.id
    ? stringValue(installMarker?.version) || "unversioned"
    : "unversioned";
}

function createMountedAppFingerprint(
  target: MountedAppTarget,
  relativePaths: string[],
  options: {
    version: string;
    includeRoot: boolean;
    cache: Map<string, { metadataFingerprint: string; fingerprint: string }>;
  },
): string {
  const files = relativePaths.flatMap((relativePath) => {
    try {
      const stat = statSync(join(target.appRoot, relativePath));
      return [
        {
          relativePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        },
      ];
    } catch {
      return [];
    }
  });
  const metadataHash = createHash("sha256");
  metadataHash.update(`version:${options.version}\n`);
  metadataHash.update(`id:${target.id}\n`);
  if (options.includeRoot) metadataHash.update(`root:${target.appRoot}\n`);
  metadataHash.update(`manifest:${JSON.stringify(target.manifest)}\n`);
  for (const file of files) {
    metadataHash.update(`${file.relativePath}\0${file.size}\0${file.mtimeMs}\0${file.ctimeMs}\n`);
  }
  const metadataFingerprint = metadataHash.digest("hex");
  const cacheKey = `${options.version}:${resolve(target.appRoot)}`;
  const cached = options.cache.get(cacheKey);
  if (cached?.metadataFingerprint === metadataFingerprint) {
    return cached.fingerprint;
  }

  const hash = createHash("sha256");
  hash.update(`${options.version}\n`);
  hash.update(`id:${target.id}\n`);
  if (options.includeRoot) hash.update(`root:${target.appRoot}\n`);
  hash.update(`manifest:${JSON.stringify(target.manifest)}\n`);
  for (const file of files) {
    try {
      hash.update(`file:${file.relativePath}\n`);
      hash.update(`size:${file.size}\n`);
      if (file.size <= MAX_RUNTIME_FINGERPRINT_FILE_BYTES) {
        hash.update(readFileSync(join(target.appRoot, file.relativePath)));
      } else {
        hash.update(`mtime:${Math.floor(file.mtimeMs)}\n`);
      }
      hash.update("\n");
    } catch {
      // non-critical-fallback: Omit a runtime file that disappears during save; the next scan produces a new fingerprint.
      continue;
    }
  }
  const fingerprint = hash.digest("hex").slice(0, 16);
  options.cache.set(cacheKey, { metadataFingerprint, fingerprint });
  if (options.cache.size > MAX_RUNTIME_FINGERPRINT_CACHE_ENTRIES) {
    const oldestKey = options.cache.keys().next().value;
    if (oldestKey) options.cache.delete(oldestKey);
  }
  return fingerprint;
}

export function resolveMountedAppWorkspaceRoot(appRoot: string, manifest: JsonObject, workspacePath?: string): string {
  if (workspacePath?.trim()) return resolvePathLike(workspacePath);
  const workspaceSetting =
    stringValue(recordValue(manifest.ui).workspace) || stringValue(recordValue(manifest.workspace).path) || "workspace";
  return safeResolveInside(appRoot, workspaceSetting) ?? join(appRoot, "workspace");
}

export function resolvePathLike(path: string): string {
  if (path === "~") return resolve(homedir());
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

const RUNTIME_FINGERPRINT_ROOT_FILES = [
  "opengrove.app.json",
  "opengrove.app.jsonc",
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  "claude.md",
] as const;

const RUNTIME_FINGERPRINT_ROOT_DIRS = ["skills", "bin", "commands", "hooks", "mcp"] as const;

const RUNTIME_FINGERPRINT_ALWAYS_SKIPPED_DIRS = new Set([
  ".git",
  ".cache",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tmp",
  ".venv",
  "__pycache__",
  "node_modules",
  "workspace",
]);

const RUNTIME_FINGERPRINT_OUTPUT_DIRS = new Set([
  "batch-runs",
  "batch_runs",
  "cache",
  "caches",
  "logs",
  "run-logs",
  "runs",
  "tmp",
  "venv",
]);

const RUNTIME_FINGERPRINT_SKIPPED_FILES = new Set([".DS_Store"]);

const RUNTIME_FINGERPRINT_SKIPPED_FILE_SUFFIXES = [".log", ".pyc", ".pyo", ".swp", ".swo", ".tmp"] as const;

const MAX_RUNTIME_FINGERPRINT_FILES = 2_000;
const MAX_RUNTIME_FINGERPRINT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_FINGERPRINT_CACHE_ENTRIES = 128;

const mountedAppFingerprintCache = new Map<
  string,
  {
    metadataFingerprint: string;
    fingerprint: string;
  }
>();

function collectMountedAppRuntimeFiles(target: MountedAppTarget): string[] {
  const output: string[] = [];
  const workspaceRoot = resolve(target.workspaceRoot);
  const ui = recordValue(target.manifest.ui);
  const viewEntry = stringValue(recordValue(ui.view).entry) || stringValue(ui.entry);
  if (viewEntry) {
    addRuntimeFingerprintFile(join(target.appRoot, viewEntry), target.appRoot, workspaceRoot, output);
  }
  const tabs = Array.isArray(ui.tabs) ? ui.tabs : [];
  for (const value of tabs) {
    const tab = recordValue(value);
    if (tab.component !== "view") continue;
    const tabViewEntry = stringValue(recordValue(tab.view).entry);
    if (tabViewEntry) {
      addRuntimeFingerprintFile(join(target.appRoot, tabViewEntry), target.appRoot, workspaceRoot, output);
    }
  }
  for (const filename of RUNTIME_FINGERPRINT_ROOT_FILES) {
    addRuntimeFingerprintFile(join(target.appRoot, filename), target.appRoot, workspaceRoot, output);
  }
  for (const dirname of RUNTIME_FINGERPRINT_ROOT_DIRS) {
    collectRuntimeFingerprintFiles(join(target.appRoot, dirname), target.appRoot, workspaceRoot, output);
  }
  return Array.from(new Set(output)).sort();
}

function collectRuntimeFingerprintFiles(path: string, appRoot: string, workspaceRoot: string, output: string[]): void {
  if (output.length >= MAX_RUNTIME_FINGERPRINT_FILES || isWithinPath(resolve(path), workspaceRoot)) {
    return;
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  if (stat.isFile()) {
    addRuntimeFingerprintFile(path, appRoot, workspaceRoot, output);
    return;
  }
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (output.length >= MAX_RUNTIME_FINGERPRINT_FILES) return;
    if (shouldSkipRuntimeFingerprintEntry(entry.name, entry.isDirectory())) continue;
    collectRuntimeFingerprintFiles(join(path, entry.name), appRoot, workspaceRoot, output);
  }
}

function shouldSkipRuntimeFingerprintEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    return RUNTIME_FINGERPRINT_ALWAYS_SKIPPED_DIRS.has(name) || RUNTIME_FINGERPRINT_OUTPUT_DIRS.has(name);
  }
  return (
    RUNTIME_FINGERPRINT_SKIPPED_FILES.has(name) ||
    RUNTIME_FINGERPRINT_SKIPPED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

function addRuntimeFingerprintFile(path: string, appRoot: string, workspaceRoot: string, output: string[]): void {
  const resolved = resolve(path);
  if (isWithinPath(resolved, workspaceRoot)) return;
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  const relativePath = relative(appRoot, resolved);
  if (!relativePath || relativePath.startsWith("..") || relativePath.startsWith("/")) return;
  output.push(relativePath.replaceAll("\\", "/"));
}

function isWithinPath(path: string, parent: string): boolean {
  const relativePath = relative(parent, path);
  return (
    relativePath === "" || Boolean(relativePath && !relativePath.startsWith("..") && !relativePath.startsWith("/"))
  );
}
