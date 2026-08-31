import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseJsonLikeConfig } from "../../extensions/scanner.js";
import type { BridgeMountedAppSettings } from "../bridge-types.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/790
 * Supports: OpenGrove 0.6.4 settings written by early side-by-side Store installs without workspacePath.
 * Remove when: OpenGrove 0.7.0 requires direct upgrades from a release that always persisted workspacePath.
 */
export function migrateStoreWorkspaceBindingsV1(input: {
  mountedApps: BridgeMountedAppSettings[];
  storeRoot: string;
}): {
  mountedApps: BridgeMountedAppSettings[];
  changed: boolean;
  recoveredAppIds: string[];
  failures: Array<{ appId: string; appRoot: string; reason: "binding_unrecoverable" }>;
} {
  const programsRoot = join(resolve(input.storeRoot), "programs");
  const recoveredAppIds: string[] = [];
  const failures: Array<{ appId: string; appRoot: string; reason: "binding_unrecoverable" }> = [];
  const mountedApps = input.mountedApps.map((mountedApp) => {
    if (mountedApp.workspacePath?.trim()) return mountedApp;
    const workspacePath = recoverStoreWorkspaceBinding(mountedApp, programsRoot);
    if (!workspacePath) {
      if (looksLikeStoreProgramAppRoot(mountedApp.path, programsRoot)) {
        failures.push({
          appId: mountedApp.id,
          appRoot: resolve(mountedApp.path),
          reason: "binding_unrecoverable",
        });
      }
      return mountedApp;
    }
    recoveredAppIds.push(mountedApp.id);
    return { ...mountedApp, workspacePath };
  });
  return {
    mountedApps,
    changed: recoveredAppIds.length > 0,
    recoveredAppIds,
    failures,
  };
}

function looksLikeStoreProgramAppRoot(appRoot: string, programsRoot: string): boolean {
  if (storeProgramPathMatches(resolve(appRoot), resolve(programsRoot))) return true;
  try {
    return storeProgramPathMatches(resolve(realpathSync.native(appRoot)), resolve(realpathSync.native(programsRoot)));
  } catch {
    return false;
  }
}

function storeProgramPathMatches(appRoot: string, programsRoot: string): boolean {
  const generationRoot = dirname(appRoot);
  const appBucketRoot = dirname(generationRoot);
  return (
    basename(appRoot) === "app" &&
    dirname(appBucketRoot) === programsRoot &&
    /^[a-f0-9]{64}$/.test(basename(appBucketRoot))
  );
}

function recoverStoreWorkspaceBinding(mountedApp: BridgeMountedAppSettings, programsRoot: string): string | undefined {
  const configuredAppRoot = resolve(mountedApp.path);
  if (!ordinaryDirectory(programsRoot) || !ordinaryDirectory(configuredAppRoot)) return undefined;
  let appRoot: string;
  try {
    programsRoot = resolve(realpathSync.native(programsRoot));
    appRoot = resolve(realpathSync.native(configuredAppRoot));
  } catch {
    // non-critical-fallback: only existing, canonically attributable Store paths may be migrated.
    return undefined;
  }
  const generationRoot = dirname(appRoot);
  const appBucketRoot = dirname(generationRoot);
  if (
    basename(appRoot) !== "app" ||
    dirname(appBucketRoot) !== programsRoot ||
    !/^[a-f0-9]{64}$/.test(basename(appBucketRoot)) ||
    !ordinaryDirectory(appBucketRoot) ||
    !ordinaryDirectory(generationRoot)
  )
    return undefined;

  const manifestPath = ["opengrove.app.json", "opengrove.app.jsonc"]
    .map((fileName) => join(appRoot, fileName))
    .find(ordinaryFile);
  if (!manifestPath) return undefined;
  const manifest = parseJsonLikeConfig(manifestPath, "jsonc");
  const appId = stringValue(manifest?.id);
  if (!manifest || !appId) return undefined;

  const markerPath = join(appRoot, ".opengrove-store-package.json");
  if (!ordinaryFile(markerPath)) return undefined;
  const marker = parseJsonLikeConfig(markerPath, "jsonc");
  if (stringValue(marker?.source) !== "registry" || stringValue(marker?.appId) !== appId) {
    return undefined;
  }

  const workspaceSetting =
    stringValue(recordValue(manifest.ui).workspace) || stringValue(recordValue(manifest.workspace).path) || "workspace";
  const linkedWorkspaceRoot = resolve(appRoot, workspaceSetting);
  const relativePath = relative(appRoot, linkedWorkspaceRoot);
  if (
    !relativePath ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath) ||
    workspacePathConflictsWithAppFiles(relativePath) ||
    !safeWorkspaceLinkParents(appRoot, relativePath)
  )
    return undefined;

  const linkEntry = pathEntry(linkedWorkspaceRoot);
  if (!linkEntry?.isSymbolicLink()) return undefined;
  try {
    const workspaceRoot = resolve(realpathSync.native(linkedWorkspaceRoot));
    if (
      dirname(workspaceRoot) === workspaceRoot ||
      workspaceRoot === appRoot ||
      pathIsInside(appRoot, workspaceRoot) ||
      !ordinaryDirectory(workspaceRoot)
    )
      return undefined;
    return workspaceRoot;
  } catch {
    // non-critical-fallback: an unresolved link is not authoritative enough to migrate.
    return undefined;
  }
}

function safeWorkspaceLinkParents(appRoot: string, relativePath: string): boolean {
  const segments = relativePath.split(sep).filter(Boolean);
  let current = appRoot;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (!ordinaryDirectory(current)) return false;
  }
  return true;
}

function workspacePathConflictsWithAppFiles(relativePath: string): boolean {
  const normalized = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
  return ["opengrove.app.json", "opengrove.app.jsonc", ".opengrove-store-package.json"].some((fileName) => {
    const reserved = process.platform === "win32" ? fileName.toLowerCase() : fileName;
    return (
      normalized === reserved ||
      normalized.startsWith(`${reserved}${sep}`) ||
      reserved.startsWith(`${normalized}${sep}`)
    );
  });
}

function pathIsInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return Boolean(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
  );
}

function ordinaryDirectory(path: string): boolean {
  const entry = pathEntry(path);
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
}

function ordinaryFile(path: string): boolean {
  const entry = pathEntry(path);
  return Boolean(entry?.isFile() && !entry.isSymbolicLink());
}

function pathEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
