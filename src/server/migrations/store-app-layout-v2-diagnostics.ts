import { lstatSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isValidAppStoreAppId } from "../app-store-app-id.js";
import type { BridgeMountedAppSettings } from "../bridge-types.js";
import type { StoreAppLayoutRoots } from "./store-app-layout-v2.js";
import { STORE_APP_LAYOUT_V2, STORE_APP_LAYOUT_V2_LOG_EVENTS } from "./store-app-layout-v2-metadata.js";

/**
 * Supports: OpenGrove <=0.6.4 and pre-release 0.6.5 Store App layouts.
 * Target: OpenGrove 0.6.5 Store App layout v2 diagnostics.
 * Remove when: OpenGrove 0.8.0 requires direct upgrades from >=0.6.5.
 */

type StoreAppLayoutPathKind = "missing" | "directory" | "file" | "symlink" | "other" | "inaccessible";
type StoreAppLayoutLocation = "current" | "legacy" | "outside" | "unset";

interface StoreAppLayoutPathState {
  path: string;
  kind: StoreAppLayoutPathKind;
  errorCode?: string;
}

interface StoreAppLayoutInspectionError {
  path: string;
  operation: "lstat" | "readdir";
  code: string;
}

interface StoreAppLayoutArtifact {
  path: string;
  root: keyof StoreAppLayoutRoots;
  kind: "staging" | "retired";
}

const MAX_MOUNTS = 500;
const MAX_ARTIFACTS = 500;

export function inspectStoreAppLayoutV2Diagnostics(input: {
  roots: StoreAppLayoutRoots;
  mountedApps?: BridgeMountedAppSettings[];
}): Record<string, unknown> {
  const roots = normalizedRoots(input.roots);
  const inspectionErrors: StoreAppLayoutInspectionError[] = [];
  const artifacts: StoreAppLayoutArtifact[] = [];
  let artifactsTruncated = false;
  const rootDepths: Array<[keyof StoreAppLayoutRoots, number]> = [
    ["programsRoot", 2],
    ["workspacesRoot", 1],
    ["legacyProgramsRoot", 2],
    ["legacyWorkspacesRoot", 1],
  ];
  for (const [rootName, maxDepth] of rootDepths) {
    if (artifacts.length >= MAX_ARTIFACTS) {
      artifactsTruncated = true;
      break;
    }
    collectMigrationArtifacts({
      root: roots[rootName],
      rootName,
      maxDepth,
      artifacts,
      inspectionErrors,
    });
  }

  const mountedApps = (input.mountedApps ?? []).slice(0, MAX_MOUNTS).map((mountedApp) => {
    const programPath = mountedApp.path?.trim() ? resolve(mountedApp.path) : undefined;
    const workspacePath = mountedApp.workspacePath?.trim() ? resolve(mountedApp.workspacePath) : undefined;
    return {
      appId: mountedApp.id,
      enabled: mountedApp.enabled !== false,
      program: diagnosticProgramPath(programPath, mountedApp.id, roots, inspectionErrors),
      workspace: diagnosticMountPath(workspacePath, roots.workspacesRoot, roots.legacyWorkspacesRoot, inspectionErrors),
    };
  });

  return {
    migration: STORE_APP_LAYOUT_V2,
    activationPointer: "bridge-settings.json",
    rootsSeparated:
      !pathsEqual(roots.programsRoot, roots.legacyProgramsRoot) &&
      !pathsEqual(roots.workspacesRoot, roots.legacyWorkspacesRoot),
    roots: {
      programs: inspectPath(roots.programsRoot, inspectionErrors),
      workspaces: inspectPath(roots.workspacesRoot, inspectionErrors),
      legacyPrograms: inspectPath(roots.legacyProgramsRoot, inspectionErrors),
      legacyWorkspaces: inspectPath(roots.legacyWorkspacesRoot, inspectionErrors),
    },
    mountedApps,
    mountedAppsAvailable: input.mountedApps !== undefined,
    mountedAppsTruncated: (input.mountedApps?.length ?? 0) > MAX_MOUNTS,
    migrationArtifacts: artifacts,
    migrationArtifactsTruncated: artifactsTruncated || artifacts.length >= MAX_ARTIFACTS,
    inspectionErrors,
    logEvents: Object.values(STORE_APP_LAYOUT_V2_LOG_EVENTS),
  };
}

function diagnosticProgramPath(
  path: string | undefined,
  appId: string,
  roots: StoreAppLayoutRoots,
  errors: StoreAppLayoutInspectionError[],
): { location: StoreAppLayoutLocation; state?: StoreAppLayoutPathState } {
  if (path && isValidAppStoreAppId(appId) && pathsEqual(path, join(roots.legacyWorkspacesRoot, appId))) {
    return { location: "legacy", state: inspectPath(path, errors) };
  }
  return diagnosticMountPath(path, roots.programsRoot, roots.legacyProgramsRoot, errors);
}

function diagnosticMountPath(
  path: string | undefined,
  currentRoot: string,
  legacyRoot: string,
  errors: StoreAppLayoutInspectionError[],
): { location: StoreAppLayoutLocation; state?: StoreAppLayoutPathState } {
  if (!path) return { location: "unset" };
  const location = pathEqualsOrInside(currentRoot, path)
    ? "current"
    : pathEqualsOrInside(legacyRoot, path)
      ? "legacy"
      : "outside";
  return { location, state: inspectPath(path, errors) };
}

function collectMigrationArtifacts(input: {
  root: string;
  rootName: keyof StoreAppLayoutRoots;
  maxDepth: number;
  artifacts: StoreAppLayoutArtifact[];
  inspectionErrors: StoreAppLayoutInspectionError[];
}): void {
  const visit = (directory: string, depth: number): void => {
    if (input.artifacts.length >= MAX_ARTIFACTS || depth >= input.maxDepth) return;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (fsErrorCode(error) !== "enoent") {
        input.inspectionErrors.push({
          path: directory,
          operation: "readdir",
          code: fsErrorCode(error),
        });
      }
      return;
    }
    for (const entry of entries) {
      if (input.artifacts.length >= MAX_ARTIFACTS) return;
      const path = join(directory, entry.name);
      if (entry.name.startsWith(".migrating-")) {
        input.artifacts.push({ path, root: input.rootName, kind: "staging" });
      } else if (entry.name.endsWith(".legacy-v2")) {
        input.artifacts.push({ path, root: input.rootName, kind: "retired" });
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path, depth + 1);
    }
  };
  visit(input.root, 0);
}

function inspectPath(path: string, errors: StoreAppLayoutInspectionError[]): StoreAppLayoutPathState {
  try {
    const entry = lstatSync(path);
    const kind: StoreAppLayoutPathKind = entry.isSymbolicLink()
      ? "symlink"
      : entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other";
    return { path, kind };
  } catch (error) {
    const errorCode = fsErrorCode(error);
    if (errorCode === "enoent") return { path, kind: "missing" };
    errors.push({ path, operation: "lstat", code: errorCode });
    return { path, kind: "inaccessible", errorCode };
  }
}

function normalizedRoots(roots: StoreAppLayoutRoots): StoreAppLayoutRoots {
  return {
    programsRoot: resolve(roots.programsRoot),
    workspacesRoot: resolve(roots.workspacesRoot),
    legacyProgramsRoot: resolve(roots.legacyProgramsRoot),
    legacyWorkspacesRoot: resolve(roots.legacyWorkspacesRoot),
  };
}

function pathEqualsOrInside(parent: string, child: string): boolean {
  if (pathsEqual(parent, child)) return true;
  const relativePath = relative(resolve(parent), resolve(child));
  return Boolean(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
  );
}

function pathsEqual(left: string, right: string): boolean {
  let normalizedLeft = resolve(left);
  let normalizedRight = resolve(right);
  try {
    normalizedLeft = resolve(realpathSync.native(normalizedLeft));
    normalizedRight = resolve(realpathSync.native(normalizedRight));
  } catch {
    // non-critical-fallback: lexical equality still diagnoses roots that do not exist yet.
  }
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function fsErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code.toLowerCase() : "unknown";
}
