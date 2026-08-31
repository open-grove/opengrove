import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseJsonLikeConfig } from "../../extensions/scanner.js";
import { readAppEnv } from "../../identity.js";
import { defaultOpenGroveAppsDir } from "../../storage/default-data-dir.js";
import { appStoreAppDirectoryName, isValidAppStoreAppId } from "../app-store-app-id.js";
import { readAppStorePackageInstallMarker } from "../app-store-install-marker.js";
import type { BridgeMountedAppSettings } from "../bridge-types.js";

/**
 * Supports: OpenGrove <=0.6.4 and pre-release 0.6.5 Store App layouts.
 * Target: OpenGrove 0.6.5 Store App layout v2; metadata is defined in store-app-layout-v2-metadata.ts.
 * Remove when: OpenGrove 0.8.0 requires direct upgrades from >=0.6.5.
 */

export { STORE_APP_LAYOUT_V2 } from "./store-app-layout-v2-metadata.js";

export function legacyAppStoreProgramsRoot(storeRoot: string): string {
  return join(resolve(storeRoot), "programs");
}

export function legacyAppStoreRoot(): string {
  return resolve(readAppEnv("LEGACY_APPS_DIR") || defaultOpenGroveAppsDir());
}

export function storeAppLayoutV2ProgramRoots(input: { storeRoot: string; currentProgramsRoot: string }): string[] {
  return [
    ...new Set([input.currentProgramsRoot, legacyAppStoreProgramsRoot(input.storeRoot)].map((root) => resolve(root))),
  ];
}

export function storeAppLayoutV2ProgramsRootForPath(input: {
  storeRoot: string;
  currentProgramsRoot: string;
  appRoot: string;
}): string | undefined {
  return storeAppLayoutV2ProgramRoots(input).find((programsRoot) => pathIsInside(programsRoot, input.appRoot));
}

export function storeAppLayoutV2WorkspaceContainerRootForPath(input: {
  appId: string;
  currentContainerRoot: string;
  workspaceRoot: string;
}): string | undefined {
  const candidates = [input.currentContainerRoot, join(legacyAppStoreRoot(), input.appId)];
  return [...new Set(candidates.map((root) => resolve(root)))].find(
    (containerRoot) =>
      resolve(input.workspaceRoot) === containerRoot || pathIsInside(containerRoot, resolve(input.workspaceRoot)),
  );
}

export interface StoreAppLayoutMigrationFailure {
  appId: string;
  appRoot: string;
  reason: string;
}

export interface StoreAppLayoutMigrationResult {
  mountedApps: BridgeMountedAppSettings[];
  changed: boolean;
  migratedAppIds: string[];
  failures: StoreAppLayoutMigrationFailure[];
}

export interface StoreAppLayoutRoots {
  legacyProgramsRoot: string;
  legacyWorkspacesRoot: string;
  programsRoot: string;
  workspacesRoot: string;
}

interface LegacyStoreInstallation {
  appId: string;
  programRoot: string;
  generationName: string;
  workspaceRoot: string;
  workspaceRelativePath: string;
}

interface TreeEntry {
  path: string;
  type: "directory" | "file" | "symlink";
  digest?: string;
  link?: string;
}

export function migrateStoreAppLayoutsV2(input: {
  mountedApps: BridgeMountedAppSettings[];
  roots: StoreAppLayoutRoots;
  rename?: typeof renameSync;
  onMigrationStart?(appId: string): void;
}): StoreAppLayoutMigrationResult {
  const roots = normalizedRoots(input.roots);
  if (!rootsAreSeparated(roots)) {
    return {
      mountedApps: input.mountedApps,
      changed: false,
      migratedAppIds: [],
      failures: input.mountedApps
        .filter((mountedApp) => mountUsesLegacyRoots(mountedApp, roots))
        .map((mountedApp) => ({
          appId: mountedApp.id,
          appRoot: resolve(mountedApp.path),
          reason: "store_app_layout_roots_not_separated",
        })),
    };
  }
  const rename = input.rename ?? renameSync;
  const migratedAppIds: string[] = [];
  const failures: StoreAppLayoutMigrationFailure[] = [];
  const mountedApps = input.mountedApps.map((mountedApp) => {
    try {
      const legacy = inspectLegacyStoreInstallation(mountedApp, roots);
      if (!legacy) return mountedApp;
      input.onMigrationStart?.(mountedApp.id);
      const migrated = migrateLegacyStoreInstallation(legacy, roots, rename);
      migratedAppIds.push(mountedApp.id);
      return {
        ...mountedApp,
        path: migrated.programRoot,
        workspacePath: migrated.workspaceRoot,
      };
    } catch (error) {
      failures.push({
        appId: mountedApp.id,
        appRoot: resolve(mountedApp.path),
        reason: errorMessage(error, "store_app_layout_migration_failed"),
      });
      return mountedApp;
    }
  });
  return {
    mountedApps,
    changed: migratedAppIds.length > 0,
    migratedAppIds,
    failures,
  };
}

function migrateLegacyStoreInstallation(
  legacy: LegacyStoreInstallation,
  roots: StoreAppLayoutRoots,
  rename: typeof renameSync,
): { programRoot: string; workspaceRoot: string } {
  const workspaceContainerRoot = join(roots.workspacesRoot, appStoreAppDirectoryName(legacy.appId));
  const workspaceRoot = join(workspaceContainerRoot, legacy.workspaceRelativePath);
  prepareWorkspaceTarget(legacy.workspaceRoot, workspaceContainerRoot, workspaceRoot, roots.workspacesRoot, rename);

  const appProgramsRoot = join(roots.programsRoot, appStoreAppDirectoryName(legacy.appId));
  const generationRoot = join(appProgramsRoot, legacy.generationName);
  const programRoot = join(generationRoot, "app");
  prepareProgramTarget({
    sourceRoot: legacy.programRoot,
    targetGenerationRoot: generationRoot,
    targetProgramRoot: programRoot,
    workspaceRelativePath: legacy.workspaceRelativePath,
    workspaceRoot,
    appProgramsRoot,
    rename,
  });
  return { programRoot, workspaceRoot };
}

function prepareWorkspaceTarget(
  sourceWorkspaceRoot: string,
  targetContainerRoot: string,
  targetWorkspaceRoot: string,
  workspacesRoot: string,
  rename: typeof renameSync,
): void {
  if (pathEntry(targetContainerRoot)) {
    assertTreesMatch(sourceWorkspaceRoot, targetWorkspaceRoot);
    return;
  }
  mkdirSync(workspacesRoot, { recursive: true });
  const stagingContainerRoot = join(workspacesRoot, `.migrating-${basename(targetContainerRoot)}-${randomUUID()}`);
  const stagingWorkspaceRoot = join(stagingContainerRoot, relative(targetContainerRoot, targetWorkspaceRoot));
  try {
    const sourceSnapshot = snapshotTree(sourceWorkspaceRoot);
    mkdirSync(dirname(stagingWorkspaceRoot), { recursive: true });
    cpSync(sourceWorkspaceRoot, stagingWorkspaceRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    assertSnapshotsMatch(sourceSnapshot, snapshotTree(stagingWorkspaceRoot));
    rename(stagingContainerRoot, targetContainerRoot);
    if (!ordinaryDirectory(targetWorkspaceRoot)) throw new Error("store_app_layout_workspace_target_missing");
  } finally {
    rmSync(stagingContainerRoot, { recursive: true, force: true });
  }
}

function prepareProgramTarget(input: {
  sourceRoot: string;
  targetGenerationRoot: string;
  targetProgramRoot: string;
  workspaceRelativePath: string;
  workspaceRoot: string;
  appProgramsRoot: string;
  rename: typeof renameSync;
}): void {
  if (pathEntry(input.targetGenerationRoot)) {
    assertProgramTargetReady(input);
    return;
  }
  mkdirSync(input.appProgramsRoot, { recursive: true });
  const stagingGenerationRoot = join(
    input.appProgramsRoot,
    `.migrating-${basename(input.targetGenerationRoot)}-${randomUUID()}`,
  );
  const stagingProgramRoot = join(stagingGenerationRoot, "app");
  try {
    const sourceSnapshot = snapshotTree(input.sourceRoot, input.workspaceRelativePath);
    cpSync(input.sourceRoot, stagingProgramRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      filter(source) {
        const relativePath = relative(input.sourceRoot, source);
        return !pathMatchesOrContains(relativePath, input.workspaceRelativePath);
      },
    });
    assertSnapshotsMatch(sourceSnapshot, snapshotTree(input.sourceRoot, input.workspaceRelativePath));
    assertSnapshotsMatch(sourceSnapshot, snapshotTree(stagingProgramRoot, input.workspaceRelativePath));
    bindWorkspace(stagingProgramRoot, input.workspaceRelativePath, input.workspaceRoot);
    assertWorkspaceBinding(stagingProgramRoot, input.workspaceRelativePath, input.workspaceRoot);
    input.rename(stagingGenerationRoot, input.targetGenerationRoot);
    if (!ordinaryDirectory(input.targetProgramRoot)) throw new Error("store_app_layout_program_target_missing");
    assertWorkspaceBinding(input.targetProgramRoot, input.workspaceRelativePath, input.workspaceRoot);
  } finally {
    rmSync(stagingGenerationRoot, { recursive: true, force: true });
  }
}

function assertProgramTargetReady(input: {
  sourceRoot: string;
  targetProgramRoot: string;
  workspaceRelativePath: string;
  workspaceRoot: string;
}): void {
  assertSnapshotsMatch(
    snapshotTree(input.sourceRoot, input.workspaceRelativePath),
    snapshotTree(input.targetProgramRoot, input.workspaceRelativePath),
  );
  assertWorkspaceBinding(input.targetProgramRoot, input.workspaceRelativePath, input.workspaceRoot);
}

function bindWorkspace(programRoot: string, workspaceRelativePath: string, workspaceRoot: string): void {
  const linkRoot = resolve(programRoot, workspaceRelativePath);
  mkdirSync(dirname(linkRoot), { recursive: true });
  symlinkSync(resolve(workspaceRoot), linkRoot, process.platform === "win32" ? "junction" : "dir");
}

function assertWorkspaceBinding(programRoot: string, workspaceRelativePath: string, workspaceRoot: string): void {
  const linkRoot = resolve(programRoot, workspaceRelativePath);
  const entry = pathEntry(linkRoot);
  if (
    !entry?.isSymbolicLink() ||
    resolve(realpathSync.native(linkRoot)) !== resolve(realpathSync.native(workspaceRoot))
  ) {
    throw new Error("store_app_layout_workspace_binding_invalid");
  }
}

function inspectLegacyStoreInstallation(
  mountedApp: BridgeMountedAppSettings,
  roots: StoreAppLayoutRoots,
): LegacyStoreInstallation | undefined {
  if (!mountedApp.path?.trim() || !mountedApp.workspacePath?.trim() || !isValidAppStoreAppId(mountedApp.id))
    return undefined;
  const programRoot = resolve(mountedApp.path);
  const generationRoot = dirname(programRoot);
  const bucketRoot = dirname(generationRoot);
  if (
    basename(programRoot) !== "app" ||
    !pathsReferToSameLocation(dirname(bucketRoot), roots.legacyProgramsRoot) ||
    !/^[a-f0-9]{64}$/.test(basename(bucketRoot)) ||
    !ordinaryDirectory(programRoot)
  )
    return undefined;

  const marker = readAppStorePackageInstallMarker(programRoot);
  if (stringValue(marker?.source) !== "registry" || stringValue(marker?.appId) !== mountedApp.id) return undefined;
  const manifestPath = [join(programRoot, "opengrove.app.json"), join(programRoot, "opengrove.app.jsonc")].find(
    ordinaryFile,
  );
  if (!manifestPath) return undefined;
  const manifest = parseJsonLikeConfig(manifestPath, "jsonc");
  if (stringValue(manifest?.id) !== mountedApp.id) return undefined;
  const workspaceRelativePath =
    stringValue(recordValue(manifest?.ui).workspace) ||
    stringValue(recordValue(manifest?.workspace).path) ||
    "workspace";
  if (!safeRelativePath(workspaceRelativePath)) return undefined;

  const workspaceContainerRoot = join(roots.legacyWorkspacesRoot, mountedApp.id);
  const workspaceRoot = resolve(mountedApp.workspacePath);
  if (
    !ordinaryDirectory(workspaceContainerRoot) ||
    !ordinaryDirectory(workspaceRoot) ||
    !pathIsInside(workspaceContainerRoot, workspaceRoot) ||
    normalizeRelativePath(relative(workspaceContainerRoot, workspaceRoot)) !==
      normalizeRelativePath(workspaceRelativePath)
  )
    return undefined;
  try {
    assertWorkspaceBinding(programRoot, workspaceRelativePath, workspaceRoot);
  } catch {
    return undefined;
  }
  return {
    appId: mountedApp.id,
    programRoot,
    generationName: basename(generationRoot),
    workspaceRoot,
    workspaceRelativePath,
  };
}

export function retireLegacyStoreAppLayoutsV2(input: {
  mountedApps: BridgeMountedAppSettings[];
  roots: StoreAppLayoutRoots;
  rename?: typeof renameSync;
}): { renamed: string[]; retained: Array<{ path: string; reason: string }> } {
  const roots = normalizedRoots(input.roots);
  if (!rootsAreSeparated(roots)) {
    const hasLegacyMount = input.mountedApps.some((mountedApp) => mountUsesLegacyRoots(mountedApp, roots));
    return {
      renamed: [],
      retained: hasLegacyMount
        ? [{ path: roots.legacyProgramsRoot, reason: "store_app_layout_roots_not_separated" }]
        : [],
    };
  }
  const rename = input.rename ?? renameSync;
  const renamed: string[] = [];
  const retained: Array<{ path: string; reason: string }> = [];
  const activeProgramRoots = input.mountedApps.map((mountedApp) => resolve(mountedApp.path));
  const activeWorkspaceRoots = input.mountedApps.flatMap((mountedApp) =>
    mountedApp.workspacePath?.trim() ? [resolve(mountedApp.workspacePath)] : [],
  );
  const processedAppIds = new Set<string>();
  for (const mountedApp of input.mountedApps) {
    if (processedAppIds.has(mountedApp.id)) continue;
    processedAppIds.add(mountedApp.id);
    try {
      if (!currentLayoutMount(mountedApp, roots)) continue;
      const legacyWorkspaceContainer = join(roots.legacyWorkspacesRoot, mountedApp.id);
      const legacyGenerations = legacyProgramGenerations(roots.legacyProgramsRoot, mountedApp.id);
      let workspaceRetirementBlocked = false;
      if (
        legacyGenerations.some((generationRoot) =>
          generationBindsWorkspace(generationRoot, mountedApp.id, legacyWorkspaceContainer),
        ) &&
        ordinaryDirectory(legacyWorkspaceContainer) &&
        !activeWorkspaceRoots.some(
          (workspaceRoot) =>
            pathsReferToSameLocation(workspaceRoot, legacyWorkspaceContainer) ||
            pathIsInsideLocation(legacyWorkspaceContainer, workspaceRoot),
        )
      ) {
        retirePath(legacyWorkspaceContainer, rename, renamed, retained);
        workspaceRetirementBlocked = ordinaryDirectory(legacyWorkspaceContainer);
      }
      // Keep at least one verified legacy program binding as attribution evidence
      // when Windows defers the Workspace rename. The next startup can retry both.
      if (workspaceRetirementBlocked) continue;
      for (const generationRoot of legacyGenerations) {
        const legacyProgramRoot = join(generationRoot, "app");
        if (!activeProgramRoots.some((activeRoot) => pathsReferToSameLocation(activeRoot, legacyProgramRoot))) {
          retirePath(generationRoot, rename, renamed, retained);
        }
      }
    } catch (error) {
      retained.push({
        path: join(roots.legacyWorkspacesRoot, mountedApp.id),
        reason: errorMessage(error, "store_app_layout_legacy_retirement_failed"),
      });
    }
  }
  return { renamed, retained };
}

export function validateStoreAppLayoutWorkspaceCopiesV2(input: {
  appIds: string[];
  previousMountedApps: BridgeMountedAppSettings[];
  mountedApps: BridgeMountedAppSettings[];
  roots: StoreAppLayoutRoots;
}): StoreAppLayoutMigrationFailure[] {
  const roots = normalizedRoots(input.roots);
  const failures: StoreAppLayoutMigrationFailure[] = [];
  for (const appId of new Set(input.appIds)) {
    const previousMount = input.previousMountedApps.find((mountedApp) => mountedApp.id === appId);
    const currentMount = input.mountedApps.find((mountedApp) => mountedApp.id === appId);
    try {
      const legacy = previousMount ? inspectLegacyStoreInstallation(previousMount, roots) : undefined;
      if (!legacy || !currentMount || !currentLayoutMount(currentMount, roots) || !currentMount.workspacePath?.trim()) {
        throw new Error("store_app_layout_validation_paths_changed");
      }
      assertTreesMatch(legacy.workspaceRoot, resolve(currentMount.workspacePath));
    } catch (error) {
      failures.push({
        appId,
        appRoot: resolve(previousMount?.path ?? currentMount?.path ?? roots.legacyProgramsRoot),
        reason: errorMessage(error, "store_app_layout_final_validation_failed"),
      });
    }
  }
  return failures;
}

function generationBindsWorkspace(generationRoot: string, appId: string, workspaceContainerRoot: string): boolean {
  const programRoot = join(generationRoot, "app");
  const manifestPath = [join(programRoot, "opengrove.app.json"), join(programRoot, "opengrove.app.jsonc")].find(
    ordinaryFile,
  );
  if (!manifestPath) return false;
  const manifest = parseJsonLikeConfig(manifestPath, "jsonc");
  if (stringValue(manifest?.id) !== appId) return false;
  const workspaceRelativePath =
    stringValue(recordValue(manifest?.ui).workspace) ||
    stringValue(recordValue(manifest?.workspace).path) ||
    "workspace";
  if (!safeRelativePath(workspaceRelativePath)) return false;
  const workspaceLink = resolve(programRoot, workspaceRelativePath);
  if (!pathEntry(workspaceLink)?.isSymbolicLink()) return false;
  try {
    const target = resolve(realpathSync.native(workspaceLink));
    const canonicalContainer = resolve(realpathSync.native(workspaceContainerRoot));
    return target === canonicalContainer || pathIsInside(canonicalContainer, target);
  } catch {
    return false;
  }
}

function currentLayoutMount(mountedApp: BridgeMountedAppSettings, roots: StoreAppLayoutRoots): boolean {
  if (!mountedApp.workspacePath?.trim()) return false;
  const bucketName = appStoreAppDirectoryName(mountedApp.id);
  const expectedProgramsRoot = join(roots.programsRoot, bucketName);
  const expectedWorkspaceRoot = join(roots.workspacesRoot, bucketName);
  const marker = readAppStorePackageInstallMarker(mountedApp.path);
  return (
    stringValue(marker?.source) === "registry" &&
    stringValue(marker?.appId) === mountedApp.id &&
    ordinaryDirectory(mountedApp.path) &&
    ordinaryDirectory(mountedApp.workspacePath) &&
    pathIsInside(expectedProgramsRoot, resolve(mountedApp.path)) &&
    pathIsInside(expectedWorkspaceRoot, resolve(mountedApp.workspacePath))
  );
}

function legacyProgramGenerations(legacyProgramsRoot: string, appId: string): string[] {
  if (!ordinaryDirectory(legacyProgramsRoot)) return [];
  const results: string[] = [];
  for (const bucket of readdirSync(legacyProgramsRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(bucket.name)) continue;
    const bucketRoot = join(legacyProgramsRoot, bucket.name);
    for (const generation of readdirSync(bucketRoot, { withFileTypes: true })) {
      if (!generation.isDirectory() || generation.isSymbolicLink()) continue;
      const generationRoot = join(bucketRoot, generation.name);
      const marker = readAppStorePackageInstallMarker(join(generationRoot, "app"));
      if (stringValue(marker?.source) === "registry" && stringValue(marker?.appId) === appId) {
        results.push(generationRoot);
      }
    }
  }
  return results;
}

function retirePath(
  source: string,
  rename: typeof renameSync,
  renamed: string[],
  retained: Array<{ path: string; reason: string }>,
): void {
  const target = `${source}.legacy-v2`;
  if (existsSync(target)) {
    retained.push({ path: source, reason: "store_app_layout_legacy_target_exists" });
    return;
  }
  try {
    rename(source, target);
    renamed.push(target);
  } catch (error) {
    retained.push({
      path: source,
      reason: error instanceof Error ? error.message : "store_app_layout_legacy_rename_failed",
    });
  }
}

function assertTreesMatch(sourceRoot: string, targetRoot: string): void {
  assertSnapshotsMatch(snapshotTree(sourceRoot), snapshotTree(targetRoot));
}

function assertSnapshotsMatch(source: TreeEntry[], target: TreeEntry[]): void {
  if (JSON.stringify(source) !== JSON.stringify(target)) {
    throw new Error("store_app_layout_copy_validation_failed");
  }
}

function snapshotTree(root: string, excludedRelativePath?: string): TreeEntry[] {
  if (!pathEntry(root)) throw new Error("store_app_layout_source_missing");
  const entries: TreeEntry[] = [];
  const visit = (current: string): void => {
    const relativePath = relative(root, current);
    if (excludedRelativePath && pathMatchesOrContains(relativePath, excludedRelativePath)) return;
    const entry = lstatSync(current);
    const normalizedPath = relativePath.split(sep).join("/") || ".";
    if (entry.isSymbolicLink()) {
      const link = readlinkSync(current);
      if (isAbsolute(link)) throw new Error("store_app_layout_absolute_symlink_unsupported");
      const linkedTarget = resolve(dirname(current), link);
      if (linkedTarget !== resolve(root) && !pathIsInside(root, linkedTarget)) {
        throw new Error("store_app_layout_external_relative_symlink_unsupported");
      }
      entries.push({ path: normalizedPath, type: "symlink", link });
      return;
    }
    if (entry.isFile()) {
      entries.push({
        path: normalizedPath,
        type: "file",
        digest: createHash("sha256").update(readFileSync(current)).digest("hex"),
      });
      return;
    }
    if (!entry.isDirectory()) throw new Error("store_app_layout_entry_type_invalid");
    entries.push({ path: normalizedPath, type: "directory" });
    for (const child of readdirSync(current).sort()) visit(join(current, child));
  };
  visit(root);
  return entries;
}

function pathMatchesOrContains(relativePath: string, excludedRelativePath: string): boolean {
  if (!relativePath) return false;
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedExcluded = normalizeRelativePath(excludedRelativePath);
  return normalizedPath === normalizedExcluded || normalizedPath.startsWith(`${normalizedExcluded}/`);
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function safeRelativePath(value: string): boolean {
  const resolved = resolve("/workspace-root", value);
  const relativePath = relative("/workspace-root", resolved);
  return Boolean(
    relativePath &&
      relativePath !== "." &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath),
  );
}

function normalizedRoots(roots: StoreAppLayoutRoots): StoreAppLayoutRoots {
  return {
    legacyProgramsRoot: resolve(roots.legacyProgramsRoot),
    legacyWorkspacesRoot: resolve(roots.legacyWorkspacesRoot),
    programsRoot: resolve(roots.programsRoot),
    workspacesRoot: resolve(roots.workspacesRoot),
  };
}

function rootsAreSeparated(roots: StoreAppLayoutRoots): boolean {
  return (
    !pathsReferToSameLocation(roots.legacyProgramsRoot, roots.programsRoot) &&
    !pathsReferToSameLocation(roots.legacyWorkspacesRoot, roots.workspacesRoot)
  );
}

function mountUsesLegacyRoots(mountedApp: BridgeMountedAppSettings, roots: StoreAppLayoutRoots): boolean {
  return Boolean(
    mountedApp.path?.trim() &&
      pathIsInside(roots.legacyProgramsRoot, resolve(mountedApp.path)) &&
      mountedApp.workspacePath?.trim() &&
      pathIsInside(roots.legacyWorkspacesRoot, resolve(mountedApp.workspacePath)),
  );
}

function pathIsInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return Boolean(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
  );
}

function pathsReferToSameLocation(left: string, right: string): boolean {
  let resolvedLeft = resolve(left);
  let resolvedRight = resolve(right);
  try {
    resolvedLeft = resolve(realpathSync.native(resolvedLeft));
    resolvedRight = resolve(realpathSync.native(resolvedRight));
  } catch {
    // non-critical-fallback: lexical comparison still handles paths that do not exist yet.
  }
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function pathIsInsideLocation(parent: string, child: string): boolean {
  let resolvedParent = resolve(parent);
  let resolvedChild = resolve(child);
  try {
    resolvedParent = resolve(realpathSync.native(resolvedParent));
    resolvedChild = resolve(realpathSync.native(resolvedChild));
  } catch {
    // non-critical-fallback: lexical containment still handles paths that do not exist yet.
  }
  return pathIsInside(resolvedParent, resolvedChild);
}

function ordinaryDirectory(path: string): boolean {
  const entry = pathEntry(path);
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
}

function ordinaryFile(path: string): boolean {
  const entry = pathEntry(path);
  return Boolean(entry?.isFile() && !entry.isSymbolicLink());
}

/**
 * Rethrows every filesystem failure except ENOENT. Callers must stay inside
 * a migration fail-open boundary so filesystem errors cannot block startup.
 */
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
