import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appStorePackageSourceIdentity, normalizeAppStorePackageKey } from "../app-store-package-identity.js";
import { parseJsonLikeConfig } from "../extensions/scanner.js";
import type { AppStorePackageRecord } from "./app-store.js";
import type { BridgeMountedAppSettings, BridgeSettings } from "./bridge-types.js";
import { normalizeCompatibleAppUi } from "../app-builder/compat/legacy-app-ui.compat.js";
import { isOpenableAppUi } from "../app-builder/ui-runtime.js";

export interface AppStoreRuntimeStateOptions {
  /** Stable legacy container used for persistent Workspaces. */
  appStoreRoot: string;
  /** Host-owned root containing immutable/replaceable App program generations. */
  programsRoot?: string;
}

type AppStoreRuntimeFields = Pick<
  AppStorePackageRecord,
  "openable" | "openableAppId" | "repairable" | "openIssue" | "updateSafe"
>;

export interface AppStoreMountedPackageState extends AppStoreRuntimeFields {
  installed: boolean;
}

export function mountedAppWorkspaceBindingIssue(
  mountedApp: BridgeMountedAppSettings,
  options: AppStoreRuntimeStateOptions,
): "app_workspace_binding_invalid" | undefined {
  const candidate = inspectMountedAppCandidate(mountedApp);
  if (!candidate.appRoot || !candidate.manifest) return undefined;
  if (!workspacePathIsPreservable(candidate)) return "app_workspace_binding_invalid";

  const programsRoot = options.programsRoot ? resolve(options.programsRoot) : undefined;
  if (!programsRoot || !pathIsInside(programsRoot, candidate.appRoot)) return undefined;
  if (!pathResolvesInside(programsRoot, candidate.appRoot)) return "app_workspace_binding_invalid";
  const workspacePath = mountedApp.workspacePath?.trim();
  if (!workspacePath || !candidate.manifestId) return "app_workspace_binding_invalid";
  const workspaceRoot = resolve(workspacePath);
  const workspaceEntry = readPathEntry(workspaceRoot);
  if (!workspaceEntry?.isDirectory() || workspaceEntry.isSymbolicLink()) {
    return "app_workspace_binding_invalid";
  }
  const appStoreRoot = resolve(options.appStoreRoot);
  const workspaceContainerRoot = resolve(appStoreRoot, candidate.manifestId);
  return pathIsInside(appStoreRoot, workspaceContainerRoot) &&
    pathIsInside(workspaceContainerRoot, workspaceRoot) &&
    pathResolvesInside(appStoreRoot, workspaceContainerRoot) &&
    pathResolvesInside(workspaceContainerRoot, workspaceRoot)
    ? undefined
    : "app_workspace_binding_invalid";
}

interface MountedAppCandidate {
  mountedApp: BridgeMountedAppSettings;
  appRoot: string;
  rootExists: boolean;
  rootIsSymbolicLink: boolean;
  manifestPath?: string;
  manifest?: Record<string, unknown>;
  manifestId?: string;
  packageKey?: string;
  storeMarker?: Record<string, unknown>;
  manifestIsRegularFile: boolean;
  storeMarkerIsRegularFile: boolean;
}

export function annotateAppStoreRuntimeState(
  packages: AppStorePackageRecord[],
  settings: Pick<BridgeSettings, "mountedApps"> | undefined,
  options: AppStoreRuntimeStateOptions,
): AppStorePackageRecord[] {
  return packages.map((item) => {
    if (item.installState === "source_conflict") {
      return {
        ...item,
        installed: false,
        openable: false,
        repairable: false,
        updateSafe: false,
        openIssue: "source_conflict",
      };
    }
    if (item.publishKind !== "app") {
      return { ...item, openable: false, repairable: false, updateSafe: false };
    }
    const mountedState = inspectAppStoreMountedPackageState(item, settings, options);
    if (mountedState.installed) {
      return {
        ...item,
        installed: true,
        ...runtimeFields(mountedState),
        ...(item.installState === "legacy_unknown" && !mountedState.openIssue
          ? { openIssue: "install_evidence_missing" as const }
          : {}),
      };
    }
    if (item.installed) {
      return {
        ...item,
        openable: false,
        repairable: false,
        updateSafe: false,
        openIssue: "mount_conflict",
      };
    }
    return { ...item, openable: false, repairable: false, updateSafe: false };
  });
}

export function inspectAppStorePackageRuntimeState(
  item: AppStorePackageRecord,
  settings: Pick<BridgeSettings, "mountedApps"> | undefined,
  options: AppStoreRuntimeStateOptions,
): AppStoreRuntimeFields {
  if (item.publishKind !== "app" || !item.installed) {
    return { openable: false, repairable: false, updateSafe: false };
  }

  const mountedState = inspectAppStoreMountedPackageState(item, settings, options);
  if (!mountedState.installed) {
    return { openable: false, repairable: false, updateSafe: false, openIssue: "mount_conflict" };
  }
  return runtimeFields(mountedState);
}

export function inspectAppStoreMountedPackageState(
  item: AppStorePackageRecord,
  settings: Pick<BridgeSettings, "mountedApps"> | undefined,
  options: AppStoreRuntimeStateOptions,
): AppStoreMountedPackageState {
  if (item.publishKind !== "app") {
    return { installed: false, openable: false, repairable: false, updateSafe: false };
  }

  const candidates = collectMountedAppCandidates(item, settings, options);
  if (candidates.length === 0) {
    return { installed: false, openable: false, repairable: false, updateSafe: false };
  }
  if (candidates.length !== 1) {
    return {
      installed: true,
      openable: false,
      repairable: false,
      updateSafe: false,
      openIssue: "mount_conflict",
    };
  }

  const candidate = candidates[0]!;
  const canonicalRoot = resolve(options.appStoreRoot, item.appId);
  const legacyCanonicalMount =
    candidate.appRoot === canonicalRoot &&
    !candidate.rootIsSymbolicLink &&
    (candidate.rootExists || candidate.mountedApp.id === item.appId);
  const generationMount = Boolean(
    options.programsRoot &&
      pathIsInside(resolve(options.programsRoot), candidate.appRoot) &&
      !candidate.rootIsSymbolicLink &&
      (candidate.rootExists || candidate.mountedApp.id === item.appId),
  );
  const managedCanonicalMount =
    (legacyCanonicalMount || generationMount) &&
    candidate.manifestIsRegularFile &&
    candidate.storeMarkerIsRegularFile &&
    storeMarkerMatchesPackage(candidate.storeMarker, item) &&
    (!candidate.packageKey || candidate.packageKey === normalizeAppStorePackageKey(item.packageKey)) &&
    workspacePathIsPreservable(candidate);
  if (!candidate.rootExists) {
    return {
      installed: true,
      openable: false,
      repairable: legacyCanonicalMount || generationMount,
      updateSafe: false,
      openIssue: "app_root_missing",
    };
  }
  if (!candidate.manifestPath) {
    return {
      installed: true,
      openable: false,
      repairable: false,
      updateSafe: false,
      openIssue: "manifest_missing",
    };
  }
  if (!candidate.manifest || !candidate.manifestId) {
    return {
      installed: true,
      openable: false,
      repairable: false,
      updateSafe: false,
      openIssue: "manifest_invalid",
    };
  }
  if (candidate.manifestId !== item.appId) {
    return {
      installed: true,
      openable: false,
      repairable: false,
      updateSafe: false,
      openIssue: "app_id_mismatch",
    };
  }
  const normalizedUi = normalizeCompatibleAppUi(candidate.manifest);
  if (!isOpenableAppUi(normalizedUi)) {
    return {
      installed: true,
      openable: false,
      repairable: false,
      updateSafe: managedCanonicalMount,
      openIssue: "ui_not_workbench",
    };
  }
  return {
    installed: true,
    openable: true,
    openableAppId: candidate.manifestId,
    repairable: false,
    updateSafe: managedCanonicalMount,
  };
}

export function appStorePackageInstallSafetyError(
  item: AppStorePackageRecord,
  settings: Pick<BridgeSettings, "mountedApps">,
  options: AppStoreRuntimeStateOptions,
):
  | "app_store_repair_required"
  | "app_store_relink_required"
  | "app_store_source_conflict"
  | "app_store_update_not_safe"
  | undefined {
  if ((item.publishKind ?? "app") !== "app") return undefined;
  const mountedState = inspectAppStoreMountedPackageState(item, settings, options);
  if (!mountedState.installed) {
    if (!readPathEntry(resolve(options.appStoreRoot, item.appId))) return undefined;
    // 取消挂载不会清理磁盘目录:同一个包留下的残留允许重装认领(覆盖安装并保留 workspace),
    // 只有异包或可疑形态的残留才拒绝。
    return appStorePackageCanAdoptLeftoverRoot(item, options) ? undefined : "app_store_update_not_safe";
  }
  if (mountedState.repairable && mountedState.openIssue === "app_root_missing") {
    return "app_store_repair_required";
  }
  if (appStorePackageNeedsRelink(item, settings, options)) return "app_store_relink_required";
  if (appStorePackageSourceConflict(item, settings, options)) return "app_store_source_conflict";
  if (mountedState.updateSafe !== true) return "app_store_update_not_safe";
  return undefined;
}

export function appStorePackageNeedsRelink(
  item: AppStorePackageRecord,
  settings: Pick<BridgeSettings, "mountedApps">,
  options: AppStoreRuntimeStateOptions,
): boolean {
  const packageKey = normalizeAppStorePackageKey(item.packageKey);
  if (!packageKey || !appStorePackageSourceIdentity(item)) return false;
  const candidates = collectMountedAppCandidates(item, settings, options);
  if (candidates.length !== 1) return false;
  const candidate = candidates[0]!;
  const markerSource = stringValue(candidate.storeMarker?.source);
  const markerPackageKey = normalizeAppStorePackageKey(candidate.storeMarker?.packageKey);
  return (
    candidate.rootExists &&
    candidate.manifestId === item.appId &&
    candidate.packageKey === packageKey &&
    !appStorePackageSourceIdentity(candidate.storeMarker ?? {}) &&
    (!markerSource || markerSource === "registry") &&
    (!markerPackageKey || markerPackageKey === packageKey)
  );
}

function appStorePackageCanAdoptLeftoverRoot(
  item: AppStorePackageRecord,
  options: AppStoreRuntimeStateOptions,
): boolean {
  const candidate = inspectMountedAppCandidate({
    id: item.appId,
    path: resolve(options.appStoreRoot, item.appId),
    enabled: true,
  });
  if (!candidate.rootExists || candidate.rootIsSymbolicLink) return false;
  // In the side-by-side layout the canonical root may legitimately contain
  // only persistent Workspace data. Installing a new program generation does
  // not overwrite or move anything in that container.
  if (!candidate.manifestPath && !candidate.storeMarker) return true;
  return (
    candidate.manifestIsRegularFile &&
    candidate.manifestId === item.appId &&
    candidate.storeMarkerIsRegularFile &&
    storeMarkerMatchesPackage(candidate.storeMarker, item) &&
    (!candidate.packageKey || candidate.packageKey === normalizeAppStorePackageKey(item.packageKey)) &&
    workspacePathIsPreservable(candidate)
  );
}

function appStorePackageSourceConflict(
  item: AppStorePackageRecord,
  settings: Pick<BridgeSettings, "mountedApps">,
  options: AppStoreRuntimeStateOptions,
): boolean {
  if (!item.packageKey) return false;
  const candidates = collectMountedAppCandidates(item, settings, options);
  if (candidates.length !== 1) return false;
  const candidate = candidates[0]!;
  return (
    candidate.rootExists &&
    candidate.manifestId === item.appId &&
    !storeMarkerMatchesPackage(candidate.storeMarker, item)
  );
}

function collectMountedAppCandidates(
  item: AppStorePackageRecord,
  settings: Pick<BridgeSettings, "mountedApps"> | undefined,
  options: AppStoreRuntimeStateOptions,
): MountedAppCandidate[] {
  const candidates: MountedAppCandidate[] = [];
  const canonicalRoot = resolve(options.appStoreRoot, item.appId);
  for (const mountedApp of settings?.mountedApps ?? []) {
    if (mountedApp.enabled === false) continue;
    const candidate = inspectMountedAppCandidate(mountedApp);
    if (
      mountedApp.id === item.appId ||
      candidate.appRoot === canonicalRoot ||
      candidate.manifestId === item.appId ||
      Boolean(item.packageKey && candidate.packageKey === normalizeAppStorePackageKey(item.packageKey)) ||
      stringValue(candidate.storeMarker?.appId) === item.appId ||
      Boolean(
        item.packageKey &&
          normalizeAppStorePackageKey(candidate.storeMarker?.packageKey) ===
            normalizeAppStorePackageKey(item.packageKey),
      )
    ) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function inspectMountedAppCandidate(mountedApp: BridgeMountedAppSettings): MountedAppCandidate {
  const appRoot = mountedApp.path?.trim() ? resolve(mountedApp.path) : "";
  const rootEntry = appRoot ? readPathEntry(appRoot) : undefined;
  const manifestPath = rootEntry
    ? ["opengrove.app.json", "opengrove.app.jsonc"]
        .map((fileName) => join(appRoot, fileName))
        .find((path) => existsSync(path))
    : undefined;
  const manifest = manifestPath ? parseJsonLikeConfig(manifestPath, "jsonc") : undefined;
  const storeMarkerPath = rootEntry ? join(appRoot, ".opengrove-store-package.json") : undefined;
  const storeMarker =
    storeMarkerPath && existsSync(storeMarkerPath) ? parseJsonLikeConfig(storeMarkerPath, "jsonc") : undefined;
  const manifestId = stringValue(manifest?.id);
  const packageKey = normalizeAppStorePackageKey(recordValue(manifest?.store).packageKey);
  return {
    mountedApp,
    appRoot,
    rootExists: Boolean(rootEntry),
    rootIsSymbolicLink: rootEntry?.isSymbolicLink() === true,
    manifestIsRegularFile: Boolean(manifestPath && pathIsRegularFile(manifestPath)),
    storeMarkerIsRegularFile: Boolean(storeMarkerPath && pathIsRegularFile(storeMarkerPath)),
    ...(manifestPath ? { manifestPath } : {}),
    ...(manifest ? { manifest } : {}),
    ...(manifestId ? { manifestId } : {}),
    ...(packageKey ? { packageKey } : {}),
    ...(storeMarker ? { storeMarker } : {}),
  };
}

function storeMarkerMatchesPackage(marker: Record<string, unknown> | undefined, item: AppStorePackageRecord): boolean {
  if (stringValue(marker?.source) !== "registry" || stringValue(marker?.appId) !== item.appId) return false;
  if (item.packageKey) {
    return appStorePackageSourceIdentity(marker ?? {}) === appStorePackageSourceIdentity(item);
  }
  return stringValue(marker?.packageId) === (item.packageId ?? item.id);
}

function workspacePathIsPreservable(candidate: MountedAppCandidate): boolean {
  if (!candidate.manifest || !candidate.appRoot) return false;
  const explicitWorkspacePath = candidate.mountedApp.workspacePath?.trim();
  if (explicitWorkspacePath) {
    const workspaceRoot = resolve(explicitWorkspacePath);
    const workspaceEntry = readPathEntry(workspaceRoot);
    const workspaceSetting =
      stringValue(recordValue(candidate.manifest.ui).workspace) ||
      stringValue(recordValue(candidate.manifest.workspace).path) ||
      "workspace";
    const linkedWorkspaceRoot = resolve(candidate.appRoot, workspaceSetting);
    const relativePath = relative(candidate.appRoot, linkedWorkspaceRoot);
    const linkEntry = readPathEntry(linkedWorkspaceRoot);
    let linkTargetsWorkspace = false;
    if (linkEntry) {
      try {
        linkTargetsWorkspace =
          resolve(realpathSync.native(linkedWorkspaceRoot)) === resolve(realpathSync.native(workspaceRoot));
      } catch {
        // non-critical-fallback: an unresolved binding is classified as unsafe instead of trusted.
        linkTargetsWorkspace = false;
      }
    }
    return (
      dirname(workspaceRoot) !== workspaceRoot &&
      workspaceRoot !== candidate.appRoot &&
      !pathIsInside(candidate.appRoot, workspaceRoot) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath) &&
      !workspacePathConflictsWithAppFiles(relativePath) &&
      (!workspaceEntry || (workspaceEntry.isDirectory() && !workspaceEntry.isSymbolicLink())) &&
      linkTargetsWorkspace
    );
  }
  const workspaceSetting =
    stringValue(recordValue(candidate.manifest.ui).workspace) ||
    stringValue(recordValue(candidate.manifest.workspace).path) ||
    "workspace";
  const workspaceRoot = resolve(candidate.appRoot, workspaceSetting);
  const relativePath = relative(candidate.appRoot, workspaceRoot);
  return Boolean(
    relativePath &&
      relativePath !== "." &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath) &&
      !workspacePathConflictsWithAppFiles(relativePath) &&
      workspacePathComponentsAreSafe(candidate.appRoot, relativePath),
  );
}

function pathIsInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return Boolean(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
  );
}

function pathResolvesInside(parent: string, child: string): boolean {
  try {
    return pathIsInside(resolve(realpathSync.native(parent)), resolve(realpathSync.native(child)));
  } catch {
    return false;
  }
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

function workspacePathComponentsAreSafe(appRoot: string, relativePath: string): boolean {
  let current = resolve(appRoot);
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
    } catch (error) {
      return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
    }
  }
  return true;
}

function pathIsRegularFile(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function readPathEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function runtimeFields(state: AppStoreMountedPackageState): AppStoreRuntimeFields {
  const { installed: _installed, ...fields } = state;
  return fields;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
