import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { packApp } from "../app-builder/cli.js";
import { packEmployeeFromState } from "../app-builder/employee-packager.js";
import {
  type EmployeePackManifest,
  type OpenGroveAppManifest,
  validateAppStoreEmployeeDefaults,
  validateEmployeePackManifestText,
} from "../app-builder/manifest.js";
import {
  appStorePackageSourceIdentity,
  appStoreRegistryUrlFromPackageRef,
  normalizeAppStorePackageKey,
  normalizeArchiveSha256,
} from "../app-store-package-identity.js";
import type { JsonObject } from "../core.js";
import { parseJsonLikeConfig } from "../extensions/scanner.js";
import { APP_CONFIG_DIR, readAppEnv } from "../identity.js";
import { isBridgeKernelId, type RoomChannelMember } from "../rooms/channel-store.js";
import {
  defaultOpenGroveDataDir,
  defaultOpenGroveProgramsDir,
  defaultOpenGroveWorkspacesDir,
} from "../storage/default-data-dir.js";
import { moveToTrash } from "../storage/trash.js";
import { appStoreAppDirectoryName, isAppStoreAppDirectoryName, isValidAppStoreAppId } from "./app-store-app-id.js";
import {
  copyAppStoreExtractedTree,
  findAppStoreArchiveRoot,
  unpackAppStoreArchive,
  validateAppStoreExtractedTree,
} from "./app-store-archive.js";
import { readAppStorePackageInstallMarker } from "./app-store-install-marker.js";
import { appStorePackageInstallSafetyError, inspectAppStoreMountedPackageState } from "./app-store-runtime-state.js";
import { employeeManifestDefaultsPatch } from "./bridge-mounted-app-employees.js";
import { clearMountedAppUninstallMarkers } from "./bridge-settings-store.js";
import {
  type BridgeMountedAppSettings,
  type BridgeSettings,
  type BridgeState,
  LEGACY_NATIVE_MODEL_ID,
} from "./bridge-types.js";
import { appStorePackageRequiresHostUpdate } from "./client-release.js";
import { getBridgeKernelOptions } from "./kernel-selection.js";
import { migrateMountedAppManifestV1 } from "./migrations/app-manifest-v1.js";
import {
  legacyAppStoreProgramsRoot,
  storeAppLayoutV2ProgramRoots,
  storeAppLayoutV2ProgramsRootForPath,
  storeAppLayoutV2WorkspaceContainerRootForPath,
} from "./migrations/store-app-layout-v2.js";
import { readMountedAppManifest, resolveMountedAppTarget } from "./mounted-apps.js";
import { PRODUCT_DEFAULT_KERNEL_ID, productDefaultModelForKernel } from "./product-employee-defaults.js";
import { getAllBridgeProviderProfiles } from "./provider-profiles.js";
import { providerRuntimeState } from "./provider-state.js";
import { bridgeDataPath } from "./storage-paths.js";

export type AppStorePublishKind = "app" | "employee";
export { isValidAppStoreAppId } from "./app-store-app-id.js";
export type AppStoreInstallMode = "workspace" | "contacts";
export type AppStoreInstallState =
  | "not_installed"
  | "installed_current"
  | "update_available"
  | "needs_relink"
  | "source_conflict"
  | "legacy_unknown";
export type AppStoreOpenIssue =
  | "app_root_missing"
  | "manifest_missing"
  | "manifest_invalid"
  | "app_id_mismatch"
  | "ui_not_workbench"
  | "mount_conflict"
  | "store_relink_required"
  | "source_conflict"
  | "install_evidence_missing";

export interface AppStorePackageRecord {
  id: string;
  packageId?: string;
  title: string;
  summary: string;
  version: string;
  minHostReleaseNumber?: number;
  category: string;
  icon?: string;
  publishKind: AppStorePublishKind;
  installMode: AppStoreInstallMode;
  packageUrl?: string;
  appId: string;
  workspaceName: string;
  requirements: string[];
  capabilities: string[];
  agents?: AppStoreAgentSummary[];
  employee?: AppStoreAgentSummary;
  dependencies?: AppStoreEmployeeDependencies;
  doctor?: AppStoreEmployeeDoctor;
  backupScopes: string[];
  status: "available" | "preview";
  visibility?: "public" | "restricted";
  publisher: string;
  usageCount: number;
  source: "registry";
  defaultLocale?: string;
  locales?: Record<string, unknown>;
  packageKey?: string;
  packageRef?: string;
  registryUrl?: string;
  uploadedAt?: string;
  archiveName?: string;
  archiveSize?: number;
  archiveSha256?: string;
  releaseCommitSha?: string;
  archiveFile?: string;
  installState?: AppStoreInstallState;
  installed?: boolean;
  installedAppId?: string;
  updateAvailable?: boolean;
  openable?: boolean;
  openableAppId?: string;
  repairable?: boolean;
  openIssue?: AppStoreOpenIssue;
  updateSafe?: boolean;
  hostUpdateRequired?: boolean;
}

export interface AppStoreInstalledAppRef {
  appId: string;
  mountedAppId: string;
  appRootExists: boolean;
  manifestPackageKey?: string;
  markerSource?: string;
  packageKey?: string;
  packageRef?: string;
  registryUrl?: string;
  version?: string;
  archiveSha256?: string;
}

export interface AppStoreAgentSummary {
  id: string;
  name: string;
  avatarMode?: RoomChannelMember["avatarMode"];
  avatarSeed?: string;
  avatarDataUrl?: string;
  role?: string;
  kernel?: string;
  model?: string;
  reasoningEffort?: RoomChannelMember["reasoningEffort"];
  contextTokenBudget?: number;
  skills?: string[];
  toolIds?: string[];
  tools?: AppStoreToolSummary[];
  visibility?: "private" | "public";
  publicDescription?: string;
  publicSkills?: string[];
  inputSpec?: string;
  outputSpec?: string;
}

export interface AppStoreToolSummary {
  id: string;
  title?: string;
  description?: string;
  source?: string;
}

export interface AppStoreSkillSummary {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  source?: string;
  bundled?: boolean;
  path?: string;
  toolIds?: string[];
  allowedTools?: string[];
}

export interface AppStoreEmployeeDependencies {
  kernels?: string[];
  providers?: string[];
  runtimes?: string[];
  skills?: AppStoreSkillSummary[];
  tools?: AppStoreToolSummary[];
  cli?: unknown[];
  mcp?: unknown[];
}

export interface AppStoreEmployeeDoctorItem {
  id: string;
  kind: "kernel" | "skill" | "tool" | "provider" | "runtime" | "cli" | "mcp";
  label: string;
  status: "ok" | "missing" | "installable" | "warning";
  detail?: string;
}

export interface AppStoreEmployeeDoctor {
  ok: boolean;
  items: AppStoreEmployeeDoctorItem[];
  missing: string[];
  warnings: string[];
}

export type AppStoreInstallStatus = "installed" | "already_installed";

export interface AppStoreInstallResult {
  packageId: string;
  appId: string;
  installMode?: AppStoreInstallMode;
  mountedApp?: BridgeMountedAppSettings;
  member?: RoomChannelMember;
  workspaceProvider: "local";
  backupEnabled: boolean;
  status: AppStoreInstallStatus;
  packageChanged?: boolean;
  appRoot?: string;
  doctor?: AppStoreEmployeeDoctor;
  openable?: boolean;
  openableAppId?: string;
  openIssue?: AppStoreOpenIssue;
}

export interface AppStoreRepairResult {
  packageId: string;
  appId: string;
  appRoot: string;
  workspaceRoot: string;
  workspaceContainerRoot: string;
  workspaceContainerCreated: boolean;
  status: "repaired";
  openable: boolean;
  openableAppId?: string;
  openIssue?: AppStoreOpenIssue;
}

export interface AppStoreRelinkResult {
  packageId: string;
  appId: string;
  mountedAppId: string;
  appRoot: string;
  status: "relinked" | "already_linked";
  openable: boolean;
  openableAppId?: string;
  openIssue?: AppStoreOpenIssue;
}

export interface FreshAppStorePackageInstall {
  packageId: string;
  /** Newly activated program generation. */
  appRoot: string;
  workspaceRoot: string;
  workspaceContainerRoot: string;
  workspaceContainerCreated: boolean;
  workspaceBackupRoot?: string;
}

export interface UpdatedAppStorePackageInstall {
  packageId: string;
  /** Newly activated program generation. */
  appRoot: string;
  /** Previously active program root; never the persistent Workspace itself. */
  previousAppRoot: string;
  workspaceRoot: string;
  programsRoot: string;
}

export interface PreparedAppStorePackageInstall {
  readonly packageId: string;
  readonly appId: string;
  readonly appRoot: string;
}

interface PreparedAppStorePackageInstallState {
  item: AppStorePackageRecord;
  storeRoot: string;
  stagingRoot: string;
  stagedAppRoot: string;
  nextWorkspaceRelativePath: string;
  adoptTargetSnapshot?: AppStorePublishTargetSnapshot;
  status: "prepared" | "activating" | "activated" | "disposed" | "recovery-required";
}

const preparedAppStorePackageInstallStates = new WeakMap<
  PreparedAppStorePackageInstall,
  PreparedAppStorePackageInstallState
>();

export interface EmployeeStoreArchive {
  bytes: Buffer;
  fileName: string;
  manifest: EmployeePackManifest;
  archiveSha256: string;
}

export interface AppStoreArchive {
  bytes: Buffer;
  fileName: string;
  archiveSha256: string;
  archiveSize: number;
  packageManifest: Record<string, unknown>;
  manifest: Record<string, unknown>;
}

export interface AppStorePublishTargetSnapshot {
  appRoot: string;
  realAppRoot: string;
  rootDevice: string;
  rootInode: string;
  installMarker?: Record<string, unknown>;
  installMarkerSha256?: string;
}

interface AppStorePublishRecoveryRecord {
  schemaVersion: 1;
  idempotencyKey: string;
  phase: "prepared" | "published";
  intentDigest: string;
  createdAt: string;
  updatedAt: string;
  targetSnapshot: AppStorePublishTargetSnapshot;
  packageManifest: Record<string, unknown>;
  archive: {
    fileName: string;
    archiveSha256: string;
    archiveSize: number;
  };
  metadata: {
    packageKey?: string;
    visibility?: string;
  };
  publishedPackage?: AppStorePackageRecord;
  releaseManifest?: Record<string, unknown>;
  applyReleasedEmployeesToLocal?: boolean;
  employeeOverridePatches?: Array<{
    memberId: string;
    userOverrides: string[];
  }>;
}

export interface PreparedAppStorePublishRecovery {
  idempotencyKey: string;
  phase: "prepared" | "published";
  packageManifest: Record<string, unknown>;
  archive: {
    bytes: Buffer;
    fileName: string;
    archiveSha256: string;
    archiveSize: number;
  };
}

// ===== Catalog reads and App installation =====

export function listAppStorePackages(
  settings?: Pick<BridgeSettings, "mountedApps">,
  options: {
    storeRoot?: string;
    installedEmployeePackageIds?: Iterable<string>;
    state?: BridgeState;
  } = {},
): AppStorePackageRecord[] {
  const installedEmployeePackageIds = new Set(options.installedEmployeePackageIds ?? []);
  const installedAppRefs = installedAppStoreAppRefs(settings);
  return readImportedRegistryPackages(options.storeRoot).map((item) => {
    const normalizedPackageKey = normalizeAppStorePackageKey(item.packageKey);
    const installedAppRef = normalizedPackageKey
      ? installedAppRefs.find((ref) => ref.packageKey === normalizedPackageKey)
      : undefined;
    const installedEmployee = item.publishKind === "employee" && installedEmployeePackageIds.has(item.id);
    const doctor =
      item.publishKind === "employee" && options.state?.app ? doctorEmployeePackage(options.state, item) : item.doctor;
    const archiveSha256 = normalizeArchiveSha256(item.archiveSha256);
    const updateAvailable = Boolean(
      installedAppRef?.archiveSha256 && archiveSha256 && installedAppRef.archiveSha256 !== archiveSha256,
    );
    return {
      ...item,
      ...(doctor ? { doctor } : {}),
      installed: Boolean(installedAppRef) || installedEmployee,
      installedAppId: item.publishKind === "app" ? installedAppRef?.mountedAppId : undefined,
      updateAvailable,
    };
  });
}

export function installedAppStoreAppRefs(settings?: Pick<BridgeSettings, "mountedApps">): AppStoreInstalledAppRef[] {
  const refs: AppStoreInstalledAppRef[] = [];
  for (const mountedApp of settings?.mountedApps ?? []) {
    if (mountedApp.enabled === false) continue;
    const manifest = mountedApp.path ? readMountedAppManifest(mountedApp.path).manifest : undefined;
    const marker = mountedApp.path ? readAppStorePackageInstallMarker(mountedApp.path) : undefined;
    const trustedMarker = stringOrUndefined(marker?.source) === "registry" ? marker : undefined;
    const appId = stringOrUndefined(manifest?.id) || stringOrUndefined(trustedMarker?.appId) || mountedApp.id;
    if (!appId) continue;
    const manifestPackageKey = normalizeAppStorePackageKey(recordValue(manifest?.store).packageKey);
    const markerSource = stringOrUndefined(marker?.source);
    const packageKey = normalizeAppStorePackageKey(trustedMarker?.packageKey);
    const packageRef = stringOrUndefined(trustedMarker?.packageRef);
    const registryUrl = stringOrUndefined(trustedMarker?.registryUrl);
    const version = stringOrUndefined(trustedMarker?.version);
    const archiveSha256 = normalizeArchiveSha256(trustedMarker?.archiveSha256);
    refs.push({
      appId,
      mountedAppId: mountedApp.id || appId,
      appRootExists: Boolean(mountedApp.path && existsSync(resolve(mountedApp.path))),
      ...(manifestPackageKey ? { manifestPackageKey } : {}),
      ...(markerSource ? { markerSource } : {}),
      ...(packageKey ? { packageKey } : {}),
      ...(packageRef ? { packageRef } : {}),
      ...(registryUrl ? { registryUrl } : {}),
      ...(version ? { version } : {}),
      ...(archiveSha256 ? { archiveSha256 } : {}),
    });
  }
  return refs;
}

export function getAppStorePackage(
  packageId: string,
  options: { storeRoot?: string } = {},
): AppStorePackageRecord | undefined {
  return findAppStorePackage(packageId, options.storeRoot);
}

const repairingAppRoots = new Set<string>();

export function repairMissingAppStorePackage(input: {
  packageId: string;
  settings: BridgeSettings;
  storeRoot: string;
}): AppStoreRepairResult | undefined {
  const item = findAppStorePackage(input.packageId, input.storeRoot);
  if (!item) return undefined;
  if (item.publishKind !== "app") throw new Error("app_store_repair_not_available");
  const appRoot = resolveCanonicalAppStoreRoot(item.appId);
  if (repairingAppRoots.has(appRoot)) throw new Error("app_store_repair_in_progress");
  repairingAppRoots.add(appRoot);
  try {
    const runtimeState = inspectAppStoreMountedPackageState(item, input.settings, {
      appStoreRoot: defaultAppStoreRoot(),
      programsRoot: currentAppStoreProgramsRoot(input.storeRoot),
    });
    if (!runtimeState.repairable || runtimeState.openIssue !== "app_root_missing") {
      throw new Error("app_store_repair_not_available");
    }
    const previousMountIndex = findMountedStoreAppIndex(item, input.settings);
    const installed = ensureImportedPackageInstalled(item, input.settings, input.storeRoot, {
      requireMissingRoot: true,
    });
    try {
      if (previousMountIndex < 0) throw new Error("app_store_repair_not_available");
      input.settings.mountedApps[previousMountIndex] = {
        ...input.settings.mountedApps[previousMountIndex]!,
        path: installed.appRoot,
        workspacePath: installed.workspaceRoot,
        enabled: true,
      };
      const repairedRuntimeState = inspectAppStoreMountedPackageState(item, input.settings, {
        appStoreRoot: defaultAppStoreRoot(),
        programsRoot: currentAppStoreProgramsRoot(input.storeRoot),
      });
      return {
        packageId: item.id,
        appId: item.appId,
        appRoot: installed.appRoot,
        workspaceRoot: installed.workspaceRoot,
        workspaceContainerRoot: installed.workspaceContainerRoot,
        workspaceContainerCreated: installed.workspaceContainerCreated,
        status: "repaired",
        openable: repairedRuntimeState.openable === true,
        ...(repairedRuntimeState.openableAppId ? { openableAppId: repairedRuntimeState.openableAppId } : {}),
        ...(repairedRuntimeState.openIssue ? { openIssue: repairedRuntimeState.openIssue } : {}),
      };
    } catch (error) {
      if (installed.createdFresh) rollbackFreshImportedPackageInstall(item, installed, input.storeRoot);
      throw error;
    }
  } finally {
    repairingAppRoots.delete(appRoot);
  }
}

export function relinkAppStorePackage(input: {
  item: AppStorePackageRecord;
  settings: Pick<BridgeSettings, "mountedApps">;
  appStoreRoot?: string;
  programsRoot?: string;
}): AppStoreRelinkResult {
  const item = input.item;
  const packageKey = normalizeAppStorePackageKey(item.packageKey);
  const sourceIdentity = appStorePackageSourceIdentity(item);
  if (item.publishKind !== "app" || !packageKey || !sourceIdentity) {
    throw new Error("app_store_relink_not_available");
  }
  const candidates = input.settings.mountedApps.filter((mountedApp) => {
    if (mountedApp.enabled === false || !mountedApp.path) return false;
    const manifest = readMountedAppManifest(mountedApp.path).manifest;
    return (
      mountedApp.id === item.appId ||
      stringOrUndefined(manifest?.id) === item.appId ||
      normalizeAppStorePackageKey(recordValue(manifest?.store).packageKey) === packageKey
    );
  });
  if (candidates.length !== 1) throw new Error("app_store_relink_not_available");

  const mountedApp = candidates[0]!;
  const appRoot = resolve(mountedApp.path);
  const rootEntry = readPathEntry(appRoot);
  const manifestPath = strictAppManifestPath(appRoot);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink() || !manifestPath) {
    throw new Error("app_store_relink_not_available");
  }
  const manifest = requireAppManifest(appRoot, "app_store_relink_not_available");
  if (
    stringOrUndefined(manifest.id) !== item.appId ||
    normalizeAppStorePackageKey(recordValue(manifest.store).packageKey) !== packageKey
  ) {
    throw new Error("app_store_relink_not_available");
  }

  const markerPath = join(appRoot, ".opengrove-store-package.json");
  const currentMarkerEntry = readPathEntry(markerPath);
  if (currentMarkerEntry && (!currentMarkerEntry.isFile() || currentMarkerEntry.isSymbolicLink())) {
    throw new Error("app_store_source_conflict");
  }
  const currentMarker = readAppStorePackageInstallMarker(appRoot);
  if (appStorePackageSourceIdentity(currentMarker ?? {}) === sourceIdentity) {
    return appStoreRelinkResult(
      item,
      mountedApp,
      appRoot,
      input.settings,
      input.appStoreRoot,
      input.programsRoot,
      "already_linked",
    );
  }
  const markerSource = stringOrUndefined(currentMarker?.source);
  const markerPackageKey = normalizeAppStorePackageKey(currentMarker?.packageKey);
  if (
    appStorePackageSourceIdentity(currentMarker ?? {}) ||
    (markerSource && markerSource !== "registry") ||
    (markerPackageKey && markerPackageKey !== packageKey)
  ) {
    throw new Error("app_store_source_conflict");
  }

  withAppStoreInstallLock(appRoot, () => {
    const lockedRootEntry = readPathEntry(appRoot);
    const lockedManifestPath = strictAppManifestPath(appRoot);
    const lockedManifest = requireAppManifest(appRoot, "app_store_relink_not_available");
    if (
      !lockedRootEntry?.isDirectory() ||
      lockedRootEntry.isSymbolicLink() ||
      !lockedManifestPath ||
      stringOrUndefined(lockedManifest.id) !== item.appId ||
      normalizeAppStorePackageKey(recordValue(lockedManifest.store).packageKey) !== packageKey
    ) {
      throw new Error("app_store_relink_not_available");
    }
    const lockedMarkerEntry = readPathEntry(markerPath);
    if (lockedMarkerEntry && (!lockedMarkerEntry.isFile() || lockedMarkerEntry.isSymbolicLink())) {
      throw new Error("app_store_source_conflict");
    }
    const lockedMarker = readAppStorePackageInstallMarker(appRoot);
    const lockedIdentity = appStorePackageSourceIdentity(lockedMarker ?? {});
    if (lockedIdentity === sourceIdentity) return;
    const lockedSource = stringOrUndefined(lockedMarker?.source);
    const lockedPackageKey = normalizeAppStorePackageKey(lockedMarker?.packageKey);
    if (
      lockedIdentity ||
      (lockedSource && lockedSource !== "registry") ||
      (lockedPackageKey && lockedPackageKey !== packageKey)
    ) {
      throw new Error("app_store_source_conflict");
    }
    writeAppStorePackageInstallMarker({
      appRoot,
      item,
      includeArchiveEvidence: false,
    });
  });
  return appStoreRelinkResult(
    item,
    mountedApp,
    appRoot,
    input.settings,
    input.appStoreRoot,
    input.programsRoot,
    "relinked",
  );
}

function appStoreRelinkResult(
  item: AppStorePackageRecord,
  mountedApp: BridgeMountedAppSettings,
  appRoot: string,
  settings: Pick<BridgeSettings, "mountedApps">,
  appStoreRoot: string | undefined,
  programsRoot: string | undefined,
  status: AppStoreRelinkResult["status"],
): AppStoreRelinkResult {
  const runtimeState = inspectAppStoreMountedPackageState(item, settings, {
    appStoreRoot: appStoreRoot ?? defaultAppStoreRoot(),
    ...(programsRoot ? { programsRoot } : {}),
  });
  return {
    packageId: item.id,
    appId: item.appId,
    mountedAppId: mountedApp.id || item.appId,
    appRoot,
    status,
    openable: runtimeState.openable === true,
    ...(runtimeState.openableAppId ? { openableAppId: runtimeState.openableAppId } : {}),
    ...(runtimeState.openIssue ? { openIssue: runtimeState.openIssue } : {}),
  };
}

export function installAppStorePackage(input: {
  packageId: string;
  settings: BridgeSettings;
  state?: BridgeState;
  backupEnabled?: boolean;
  storeRoot: string;
  onFreshAppRootCreated?(install: FreshAppStorePackageInstall): void;
  onUpdatedAppRootCreated?(install: UpdatedAppStorePackageInstall): void;
}): AppStoreInstallResult | undefined {
  const item = findAppStorePackage(input.packageId, input.storeRoot);
  if (!item) return undefined;
  if (item.publishKind === "employee") {
    if (!input.state) throw new Error("employee_install_state_required");
    return installEmployeeStorePackage({
      item,
      state: input.state,
      backupEnabled: input.backupEnabled,
      storeRoot: input.storeRoot,
    });
  }
  const installSafetyError = appStorePackageInstallSafetyError(item, input.settings, {
    appStoreRoot: defaultAppStoreRoot(),
    programsRoot: currentAppStoreProgramsRoot(input.storeRoot),
  });
  if (installSafetyError) throw new Error(installSafetyError);
  const installed = ensureImportedPackageInstalled(item, input.settings, input.storeRoot);
  try {
    const manifest = requireAppManifest(installed.appRoot, "app_store_package_manifest_invalid");
    const appId = stringOrUndefined(manifest.id) ?? item.appId;
    const title = stringOrUndefined(manifest.title) ?? item.title;
    const mountedApp: BridgeMountedAppSettings = {
      id: appId,
      path: installed.appRoot,
      workspacePath: installed.workspaceRoot,
      title,
      enabled: true,
    };
    const previousIndex = input.settings.mountedApps.findIndex(
      (candidate) => candidate.id === appId || resolve(candidate.path) === installed.appRoot,
    );
    const alreadyInstalled = previousIndex >= 0 && input.settings.mountedApps[previousIndex]?.enabled !== false;
    const mountedApps = input.settings.mountedApps.map((candidate) => ({ ...candidate }));
    if (previousIndex >= 0) {
      mountedApps[previousIndex] = {
        ...mountedApps[previousIndex],
        ...mountedApp,
      };
    } else {
      mountedApps.push(mountedApp);
    }
    input.settings.mountedApps = mountedApps;
    clearMountedAppUninstallMarkers(input.settings, [appId, item.appId]);
    const runtimeState = inspectAppStoreMountedPackageState(item, input.settings, {
      appStoreRoot: defaultAppStoreRoot(),
      programsRoot: currentAppStoreProgramsRoot(input.storeRoot),
    });
    const result: AppStoreInstallResult = {
      packageId: item.id,
      appId,
      installMode: "workspace",
      mountedApp,
      workspaceProvider: "local",
      backupEnabled: input.backupEnabled !== false,
      status: alreadyInstalled ? "already_installed" : "installed",
      packageChanged: installed.packageChanged,
      appRoot: installed.appRoot,
      openable: runtimeState.openable,
      ...(runtimeState.openableAppId ? { openableAppId: runtimeState.openableAppId } : {}),
      ...(runtimeState.openIssue ? { openIssue: runtimeState.openIssue } : {}),
    };
    if (installed.createdFresh) {
      input.onFreshAppRootCreated?.({
        packageId: item.id,
        appRoot: installed.appRoot,
        workspaceRoot: installed.workspaceRoot,
        workspaceContainerRoot: installed.workspaceContainerRoot,
        workspaceContainerCreated: installed.workspaceContainerCreated,
        ...(installed.workspaceBackupRoot ? { workspaceBackupRoot: installed.workspaceBackupRoot } : {}),
      });
    } else if (installed.updateInstall) {
      input.onUpdatedAppRootCreated?.(installed.updateInstall);
    }
    return result;
  } catch (error) {
    if (installed.createdFresh) rollbackFreshImportedPackageInstall(item, installed, input.storeRoot);
    throw error;
  }
}

export function prepareAppStorePackageInstall(input: {
  packageId: string;
  settings: BridgeSettings;
  storeRoot: string;
  adoptTargetSnapshot?: AppStorePublishTargetSnapshot;
}): PreparedAppStorePackageInstall | undefined {
  const item = findAppStorePackage(input.packageId, input.storeRoot);
  if (!item) return undefined;
  if (item.publishKind !== "app") throw new Error("app_version_formal_target_invalid");
  const mountedApp = findMountedStoreApp(item, input.settings);
  const appRoot =
    input.adoptTargetSnapshot?.appRoot ??
    (mountedApp?.path?.trim() ? resolve(mountedApp.path) : resolveCanonicalAppStoreRoot(item.appId));
  if (input.adoptTargetSnapshot) {
    assertAppStorePublishTargetUnchanged(appRoot, item, input.adoptTargetSnapshot);
  } else {
    const installSafetyError = appStorePackageInstallSafetyError(item, input.settings, {
      appStoreRoot: defaultAppStoreRoot(),
      programsRoot: currentAppStoreProgramsRoot(input.storeRoot),
    });
    if (installSafetyError) throw new Error(installSafetyError);
  }
  if (!item.archiveFile) {
    throw new Error(`app_store_package_archive_missing:${item.id}`);
  }
  const archivePath = resolveInside(input.storeRoot, item.archiveFile);
  if (!archivePath || !existsSync(archivePath)) {
    throw new Error(`app_store_package_archive_missing:${item.id}`);
  }
  const archiveEntry = readPathEntry(archivePath);
  const expectedArchiveSha256 = normalizeArchiveSha256(item.archiveSha256);
  if (
    !archiveEntry?.isFile() ||
    archiveEntry.isSymbolicLink() ||
    !expectedArchiveSha256 ||
    archiveEntry.size !== item.archiveSize ||
    sha256Buffer(readFileSync(archivePath)) !== expectedArchiveSha256
  ) {
    throw new Error("app_store_archive_checksum_mismatch");
  }

  if (input.adoptTargetSnapshot) {
    assertAppStorePublishTargetUnchanged(appRoot, item, input.adoptTargetSnapshot);
  } else {
    assertAppStoreUpdateTargetUnchanged(appRoot, item);
  }
  // Keep extraction, the final staged tree, and program generations under one
  // Store-owned volume so the activation rename remains atomic on Windows too.
  const transactionParent = join(input.storeRoot, "staging");
  mkdirSync(transactionParent, { recursive: true });
  const stagingRoot = mkdtempSync(join(transactionParent, `formal-${appStoreInstallKey(appRoot)}-`));
  const unpackRoot = join(stagingRoot, "unpacked");
  const stagedAppRoot = join(stagingRoot, "next-app");
  try {
    mkdirSync(unpackRoot, { recursive: true });
    const unpack = unpackAppStoreArchive(archivePath, unpackRoot);
    if (!unpack.ok) throw new Error(unpack.error);
    validateAppStoreExtractedTree(unpackRoot);
    const sourceRoot = findAppStoreArchiveRoot(unpackRoot, "app");
    if (!sourceRoot) throw new Error("app_store_package_manifest_required");
    const sourceManifest = requireAppManifest(sourceRoot, "app_store_package_manifest_invalid");
    const employeeDefaultIssues = validateAppStoreEmployeeDefaults(recordValue(sourceManifest.store).employeeDefaults);
    if (employeeDefaultIssues.length) {
      throw new Error(`app_store_manifest_invalid:${employeeDefaultIssues.join("|")}`);
    }
    const nextWorkspaceRelativePath = preservableWorkspaceRelativePath(sourceRoot, sourceManifest);
    if (!nextWorkspaceRelativePath) throw new Error("app_store_update_not_safe");

    copyAppStoreExtractedTree(sourceRoot, stagedAppRoot);
    writeFileSync(
      join(stagedAppRoot, ".opengrove-store-package.json"),
      `${JSON.stringify(packageInstallMarker(item), null, 2)}\n`,
      "utf8",
    );
    assertStagedAppTreeReady(stagedAppRoot, item, nextWorkspaceRelativePath);
    const prepared = Object.freeze({
      packageId: item.id,
      appId: item.appId,
      appRoot,
    });
    preparedAppStorePackageInstallStates.set(prepared, {
      item: { ...item },
      storeRoot: input.storeRoot,
      stagingRoot,
      stagedAppRoot,
      nextWorkspaceRelativePath,
      ...(input.adoptTargetSnapshot ? { adoptTargetSnapshot: { ...input.adoptTargetSnapshot } } : {}),
      status: "prepared",
    });
    return prepared;
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function activatePreparedAppStorePackageInstall(input: {
  prepared: PreparedAppStorePackageInstall;
  settings: BridgeSettings;
  backupEnabled?: boolean;
  onUpdatedAppRootCreated?(install: UpdatedAppStorePackageInstall): void;
}): AppStoreInstallResult {
  const preparedState = preparedAppStorePackageInstallStates.get(input.prepared);
  if (!preparedState || preparedState.status !== "prepared") {
    throw new Error("app_store_prepared_install_invalid");
  }
  const item = preparedState.item;
  if (preparedState.adoptTargetSnapshot) {
    assertAppStorePublishTargetUnchanged(input.prepared.appRoot, item, preparedState.adoptTargetSnapshot);
  } else {
    const installSafetyError = appStorePackageInstallSafetyError(item, input.settings, {
      appStoreRoot: defaultAppStoreRoot(),
      programsRoot: currentAppStoreProgramsRoot(preparedState.storeRoot),
    });
    if (installSafetyError) throw new Error(installSafetyError);
  }
  preparedState.status = "activating";
  let updateInstall: UpdatedAppStorePackageInstall | undefined;
  try {
    const previousIndex = input.settings.mountedApps.findIndex(
      (candidate) => candidate.id === item.appId || resolve(candidate.path) === resolve(input.prepared.appRoot),
    );
    const previousMount = previousIndex >= 0 ? input.settings.mountedApps[previousIndex] : undefined;
    const workspaceContainerRoot = resolveCanonicalAppStoreRoot(item.appId);
    const workspaceRoot = resolveStoreWorkspaceRoot({
      previousMount,
      previousAppRoot: input.prepared.appRoot,
      workspaceContainerRoot,
      nextWorkspaceRelativePath: preparedState.nextWorkspaceRelativePath,
    });
    const nextAppRoot = installSideBySideAppProgram({
      sourceRoot: preparedState.stagedAppRoot,
      item,
      storeRoot: preparedState.storeRoot,
      workspaceContainerRoot,
      workspaceRoot,
      nextWorkspaceRelativePath: preparedState.nextWorkspaceRelativePath,
      previousAppRoot: input.prepared.appRoot,
      ...(preparedState.adoptTargetSnapshot ? { adoptTargetSnapshot: preparedState.adoptTargetSnapshot } : {}),
    });
    updateInstall = {
      packageId: item.id,
      appRoot: nextAppRoot,
      previousAppRoot: input.prepared.appRoot,
      workspaceRoot,
      programsRoot: currentAppStoreProgramsRoot(preparedState.storeRoot),
    };
    const manifest = requireAppManifest(nextAppRoot, "app_store_update_not_safe");
    const appId = stringOrUndefined(manifest.id) ?? item.appId;
    const title = stringOrUndefined(manifest.title) ?? item.title;
    const mountedApp: BridgeMountedAppSettings = {
      id: stringOrUndefined(previousMount?.id) || appId,
      path: nextAppRoot,
      workspacePath: workspaceRoot,
      title,
      enabled: true,
    };
    const alreadyInstalled = Boolean(previousMount && previousMount.enabled !== false);
    const mountedApps = input.settings.mountedApps.map((candidate) => ({ ...candidate }));
    if (previousIndex >= 0) mountedApps[previousIndex] = { ...previousMount, ...mountedApp };
    else mountedApps.push(mountedApp);
    input.settings.mountedApps = mountedApps;
    clearMountedAppUninstallMarkers(input.settings, [mountedApp.id, appId, item.appId]);
    const runtimeState = inspectAppStoreMountedPackageState(item, input.settings, {
      appStoreRoot: defaultAppStoreRoot(),
      programsRoot: currentAppStoreProgramsRoot(preparedState.storeRoot),
    });
    const result: AppStoreInstallResult = {
      packageId: item.id,
      appId,
      installMode: "workspace",
      mountedApp,
      workspaceProvider: "local",
      backupEnabled: input.backupEnabled !== false,
      status: alreadyInstalled ? "already_installed" : "installed",
      packageChanged: true,
      appRoot: nextAppRoot,
      openable: runtimeState.openable,
      ...(runtimeState.openableAppId ? { openableAppId: runtimeState.openableAppId } : {}),
      ...(runtimeState.openIssue ? { openIssue: runtimeState.openIssue } : {}),
    };
    preparedState.status = "activated";
    input.onUpdatedAppRootCreated?.(updateInstall);
    return result;
  } catch (error) {
    if (updateInstall) {
      try {
        rollbackUpdatedAppStorePackageInstall({
          ...updateInstall,
          storeRoot: preparedState.storeRoot,
        });
      } catch (rollbackError) {
        preparedState.status = "recovery-required";
        throw new AggregateError([error, rollbackError], "app_store_prepared_install_rollback_failed");
      }
    }
    if (!preparedInstallRecoveryRequired(preparedState)) preparedState.status = "disposed";
    throw error;
  }
}

export function disposePreparedAppStorePackageInstall(prepared: PreparedAppStorePackageInstall): void {
  const state = preparedAppStorePackageInstallStates.get(prepared);
  if (!state) return;
  if (state.status === "activating") throw new Error("app_store_prepared_install_busy");
  if (state.status === "recovery-required") return;
  rmSync(state.stagingRoot, { recursive: true, force: true });
  state.status = "disposed";
  preparedAppStorePackageInstallStates.delete(prepared);
}

function preparedInstallRecoveryRequired(state: PreparedAppStorePackageInstallState): boolean {
  return state.status === "recovery-required";
}

export interface AppStoreUninstallResult {
  appId: string;
  removedMountIds: string[];
  trashedPath?: string;
}

export type AppStoreManagedRootState = "missing" | "verified" | "unverified" | "unsafe";

const PRESERVED_WORKSPACE_ROOT = ".opengrove-uninstalled-workspaces";
const PRESERVED_WORKSPACE_MARKER = ".opengrove-preserved-workspace.json";

// Keep a trusted workspace copy until a same-package reinstall activates successfully.
// The original workspace still travels with the full App root into the user's trash.
interface PreservedAppWorkspace {
  containerRoot: string;
  markerPath: string;
  workspaceRoot: string;
}

function resolveCanonicalAppStoreRoot(appId: string): string {
  if (!isValidAppStoreAppId(appId)) throw new Error("app_store_app_id_invalid");
  const storeRoot = resolve(defaultAppStoreRoot());
  const appRoot = resolve(storeRoot, appStoreAppDirectoryName(appId));
  const relativePath = relative(storeRoot, appRoot);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("app_store_app_id_invalid");
  }
  return appRoot;
}

function preservedWorkspacePaths(appRoot: string): PreservedAppWorkspace {
  const containerRoot = join(dirname(appRoot), PRESERVED_WORKSPACE_ROOT, appStoreInstallKey(appRoot));
  return {
    containerRoot,
    markerPath: join(containerRoot, PRESERVED_WORKSPACE_MARKER),
    workspaceRoot: join(containerRoot, "workspace"),
  };
}

function preserveWorkspaceBeforeTrash(
  appRoot: string,
  marker: Record<string, unknown>,
): PreservedAppWorkspace | undefined {
  const manifest = requireAppManifest(appRoot, "app_store_uninstall_workspace_not_safe");
  if (stringOrUndefined(manifest.id) !== stringOrUndefined(marker.appId)) {
    throw new Error("app_store_uninstall_workspace_not_safe");
  }
  const workspaceRelativePath = preservableWorkspaceRelativePath(appRoot, manifest);
  if (!workspaceRelativePath) throw new Error("app_store_uninstall_workspace_not_safe");
  const workspaceRoot = resolve(appRoot, workspaceRelativePath);
  const workspaceEntry = readPathEntry(workspaceRoot);
  if (!workspaceEntry) return undefined;
  if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) {
    throw new Error("app_store_uninstall_workspace_not_safe");
  }

  const preserved = preservedWorkspacePaths(appRoot);
  const existingContainer = readPathEntry(preserved.containerRoot);
  if (existingContainer) {
    if (!existingContainer.isDirectory() || existingContainer.isSymbolicLink()) {
      throw new Error("app_store_workspace_backup_target_changed");
    }
    const existingMarker = parseJsonLikeConfig(preserved.markerPath, "jsonc") ?? {};
    const existingIdentity = appStorePackageSourceIdentity(existingMarker);
    const currentIdentity = appStorePackageSourceIdentity(marker);
    if (existingIdentity && existingIdentity !== currentIdentity) {
      throw new Error("app_store_workspace_backup_target_changed");
    }
    rmSync(preserved.containerRoot, { recursive: true, force: true });
  }

  mkdirSync(preserved.containerRoot, { recursive: true });
  try {
    cpSync(workspaceRoot, preserved.workspaceRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    writeFileSync(preserved.markerPath, `${JSON.stringify({ ...marker, workspaceRelativePath }, null, 2)}\n`, "utf8");
    return preserved;
  } catch (error) {
    rmSync(preserved.containerRoot, { recursive: true, force: true });
    throw error;
  }
}

function trashAppRootPreservingWorkspace(appRoot: string, marker: Record<string, unknown>): string {
  const preserved = preserveWorkspaceBeforeTrash(appRoot, marker);
  try {
    return moveToTrash(appRoot);
  } catch (error) {
    if (preserved) {
      try {
        rmSync(preserved.containerRoot, { recursive: true, force: true });
      } catch {
        // The original App root remains authoritative when trashing fails; a backup copy is harmless.
      }
    }
    throw error;
  }
}

function readPreservedWorkspaceForInstall(
  workspaceContainerRoot: string,
  item: AppStorePackageRecord,
): PreservedAppWorkspace | undefined {
  const preserved = preservedWorkspacePaths(workspaceContainerRoot);
  const containerEntry = readPathEntry(preserved.containerRoot);
  const markerEntry = readPathEntry(preserved.markerPath);
  const workspaceEntry = readPathEntry(preserved.workspaceRoot);
  if (
    !containerEntry?.isDirectory() ||
    containerEntry.isSymbolicLink() ||
    !markerEntry?.isFile() ||
    markerEntry.isSymbolicLink() ||
    !workspaceEntry?.isDirectory() ||
    workspaceEntry.isSymbolicLink() ||
    !packageMarkerProvenanceMatches(preserved.markerPath, item)
  )
    return undefined;
  return preserved;
}

// 侧边栏"删除"必须是真卸载:除了移除挂载记录,商店托管的目录也要移入废纸篓,
// 否则残留目录会把下一次安装挡在门外。手动挂载的目录归用户所有,只解除挂载。
export function removeMountedAppRecords(
  settings: Pick<BridgeSettings, "mountedApps">,
  appId: string,
): BridgeMountedAppSettings[] {
  const canonicalRoot = resolveCanonicalAppStoreRoot(appId);
  const removed = settings.mountedApps.filter((item) => {
    if (item.id === appId || !item.path?.trim()) return item.id === appId;
    const mountedRoot = resolve(item.path);
    if (mountedRoot === canonicalRoot) return true;
    if (appManifestIdForCleanup(mountedRoot) === appId) return true;
    return stringOrUndefined(readAppStorePackageInstallMarker(mountedRoot)?.appId) === appId;
  });
  if (removed.length) {
    settings.mountedApps = settings.mountedApps.filter((item) => !removed.includes(item));
  }
  return removed;
}

export function trashStoreManagedAppRoot(appId: string): string | undefined {
  const appRoot = resolveCanonicalAppStoreRoot(appId);
  if (inspectStoreManagedAppRoot(appId) !== "verified") return undefined;
  return withAppStoreInstallLock(appRoot, () => {
    if (inspectStoreManagedAppRoot(appId) !== "verified") {
      throw new Error("app_store_cleanup_target_changed");
    }
    const marker = readAppStorePackageInstallMarker(appRoot);
    if (!marker) throw new Error("app_store_cleanup_target_changed");
    return trashAppRootPreservingWorkspace(appRoot, marker);
  });
}

export function trashSeparatedStoreManagedAppInstallation(input: {
  appId: string;
  mountedApp: BridgeMountedAppSettings;
  storeRoot: string;
  allowUnverified?: boolean;
}): string | undefined {
  const programRoot = resolve(input.mountedApp.path);
  const programsRoot = storeAppLayoutV2ProgramsRootForPath({
    storeRoot: input.storeRoot,
    currentProgramsRoot: currentAppStoreProgramsRoot(input.storeRoot),
    appRoot: programRoot,
  });
  if (!programsRoot) throw new Error("app_store_cleanup_not_safe");
  const marker = readAppStorePackageInstallMarker(programRoot);
  const managedState = inspectSeparatedStoreManagedAppInstallation(input);
  if (managedState === "unsafe" || (managedState === "unverified" && input.allowUnverified !== true)) {
    throw new Error("app_store_cleanup_not_safe");
  }

  const workspaceRoot = input.mountedApp.workspacePath?.trim() ? resolve(input.mountedApp.workspacePath) : undefined;
  const workspaceContainerRoot = workspaceRoot
    ? storeAppLayoutV2WorkspaceContainerRootForPath({
        appId: input.appId,
        currentContainerRoot: resolveCanonicalAppStoreRoot(input.appId),
        workspaceRoot,
      })
    : resolveCanonicalAppStoreRoot(input.appId);
  if (workspaceRoot && !workspaceContainerRoot) throw new Error("app_store_cleanup_not_safe");
  let trashedPath: string | undefined;
  if (workspaceRoot && workspaceContainerRoot) {
    const workspaceEntry = readPathEntry(workspaceRoot);
    if (workspaceEntry && (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink())) {
      throw new Error("app_store_cleanup_not_safe");
    }
    if (workspaceEntry)
      preserveSeparatedWorkspaceBeforeTrash(
        workspaceContainerRoot,
        workspaceRoot,
        marker ?? { schemaVersion: 1, source: "registry", appId: input.appId },
      );
    if (readPathEntry(workspaceContainerRoot)) trashedPath = moveToTrash(workspaceContainerRoot);
  }

  try {
    removeProgramGenerationWithCleanupMarker(programRoot, programsRoot);
  } catch {
    // The mount is gone and the program contains no Workspace data. A locked
    // obsolete generation is safe to reclaim on a later maintenance pass.
  }
  return trashedPath;
}

export function inspectSeparatedStoreManagedAppInstallation(input: {
  appId: string;
  mountedApp: BridgeMountedAppSettings;
  storeRoot: string;
}): AppStoreManagedRootState {
  const programRoot = resolve(input.mountedApp.path);
  const programsRoot = storeAppLayoutV2ProgramsRootForPath({
    storeRoot: input.storeRoot,
    currentProgramsRoot: currentAppStoreProgramsRoot(input.storeRoot),
    appRoot: programRoot,
  });
  if (!programsRoot || basename(programRoot) !== "app") return "unsafe";
  if (
    input.mountedApp.workspacePath?.trim() &&
    !storeAppLayoutV2WorkspaceContainerRootForPath({
      appId: input.appId,
      currentContainerRoot: resolveCanonicalAppStoreRoot(input.appId),
      workspaceRoot: resolve(input.mountedApp.workspacePath),
    })
  )
    return "unsafe";
  const entry = readPathEntry(programRoot);
  if (!entry) return "missing";
  if (!entry.isDirectory() || entry.isSymbolicLink()) return "unsafe";
  const marker = readAppStorePackageInstallMarker(programRoot);
  return stringOrUndefined(marker?.source) === "registry" && stringOrUndefined(marker?.appId) === input.appId
    ? "verified"
    : "unverified";
}

function preserveSeparatedWorkspaceBeforeTrash(
  workspaceContainerRoot: string,
  workspaceRoot: string,
  marker: Record<string, unknown>,
): void {
  const preserved = preservedWorkspacePaths(workspaceContainerRoot);
  const workspaceRelativePath = relative(workspaceContainerRoot, workspaceRoot);
  if (!workspaceRelativePath || !pathIsInside(workspaceContainerRoot, workspaceRoot)) {
    throw new Error("app_store_uninstall_workspace_not_safe");
  }
  rmSync(preserved.containerRoot, { recursive: true, force: true });
  mkdirSync(preserved.containerRoot, { recursive: true });
  try {
    cpSync(workspaceRoot, preserved.workspaceRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    writeFileSync(preserved.markerPath, `${JSON.stringify({ ...marker, workspaceRelativePath }, null, 2)}\n`, "utf8");
  } catch (error) {
    rmSync(preserved.containerRoot, { recursive: true, force: true });
    throw error;
  }
}

export function inspectStoreManagedAppRoot(appId: string): AppStoreManagedRootState {
  const appRoot = resolveCanonicalAppStoreRoot(appId);
  const rootEntry = readPathEntry(appRoot);
  if (!rootEntry) return "missing";
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return "unsafe";
  const markerEntry = readPathEntry(join(appRoot, ".opengrove-store-package.json"));
  if (!markerEntry?.isFile() || markerEntry.isSymbolicLink()) return "unverified";
  const marker = readAppStorePackageInstallMarker(appRoot);
  if (!marker || stringOrUndefined(marker.source) !== "registry" || stringOrUndefined(marker.appId) !== appId)
    return "unverified";
  const manifest = readMountedAppManifest(appRoot).manifest;
  if (!manifest || stringOrUndefined(manifest.id) !== appId || !preservableWorkspaceRelativePath(appRoot, manifest))
    return "unverified";
  return "verified";
}

export function trashUnverifiedStoreManagedAppRoot(appId: string): string {
  const appRoot = resolveCanonicalAppStoreRoot(appId);
  if (inspectStoreManagedAppRoot(appId) !== "unverified") {
    throw new Error("app_store_cleanup_not_safe");
  }
  return withAppStoreInstallLock(appRoot, () => {
    if (inspectStoreManagedAppRoot(appId) !== "unverified") {
      throw new Error("app_store_cleanup_target_changed");
    }
    return moveToTrash(appRoot);
  });
}

export function finalizeFreshAppStorePackageInstall(input: FreshAppStorePackageInstall): boolean {
  if (!input.workspaceBackupRoot) return false;
  const expectedBackupRoot = preservedWorkspacePaths(input.workspaceContainerRoot).containerRoot;
  if (resolve(input.workspaceBackupRoot) !== expectedBackupRoot) {
    throw new Error("app_store_workspace_backup_target_changed");
  }
  const entry = readPathEntry(expectedBackupRoot);
  if (!entry) return false;
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("app_store_workspace_backup_target_changed");
  }
  rmSync(expectedBackupRoot, { recursive: true, force: true });
  return true;
}

export function rollbackFreshAppStorePackageInstall(
  input: FreshAppStorePackageInstall & {
    storeRoot?: string;
  },
): boolean {
  const item = findAppStorePackage(input.packageId, input.storeRoot);
  if (!item || item.publishKind !== "app") return false;
  return rollbackFreshImportedPackageInstall(item, input, input.storeRoot);
}

export function finalizeUpdatedAppStorePackageInstall(input: UpdatedAppStorePackageInstall): boolean {
  assertUpdatedInstallPaths(input);
  if (!pathIsInside(input.programsRoot, input.previousAppRoot)) {
    // First migration: the previous program shares the legacy container with the
    // persistent Workspace. Never recursively clean that container.
    console.warn("app_store_legacy_program_retained", {
      appRoot: resolve(input.previousAppRoot),
      workspaceRoot: resolve(input.workspaceRoot),
      reason: "mixed_workspace_container",
    });
    return false;
  }
  removeProgramGenerationWithCleanupMarker(input.previousAppRoot, input.programsRoot);
  return true;
}

export function commitUpdatedAppStorePackageInstall(input: UpdatedAppStorePackageInstall): boolean {
  assertUpdatedInstallPaths(input);
  return true;
}

export function rollbackUpdatedAppStorePackageInstall(
  input: UpdatedAppStorePackageInstall & {
    storeRoot?: string;
  },
): boolean {
  const item = findAppStorePackage(input.packageId, input.storeRoot);
  if (!item || item.publishKind !== "app") return false;
  assertUpdatedInstallPaths(input);
  return withAppStoreInstallLock(resolveCanonicalAppStoreRoot(item.appId), () => {
    assertAppStoreUpdateTargetUnchanged(input.appRoot, item);
    removeProgramGeneration(input.appRoot, input.programsRoot);
    return true;
  });
}

function assertUpdatedInstallPaths(input: UpdatedAppStorePackageInstall): void {
  const appRoot = resolve(input.appRoot);
  if (
    !pathIsInside(input.programsRoot, appRoot) ||
    basename(appRoot) !== "app" ||
    resolve(input.workspaceRoot) === appRoot
  ) {
    throw new Error("app_store_update_backup_target_changed");
  }
}

// ===== Package creation and Registry import =====

export function packEmployeeStoreArchive(input: {
  state: BridgeState;
  memberId: string;
  publisher: string;
  title?: string;
  summary?: string;
  category?: string;
}): EmployeeStoreArchive {
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-employee-publish-"));
  try {
    const archivePath = join(tempRoot, "employee.tgz");
    const packed = packEmployeeFromState({
      state: input.state,
      memberId: input.memberId,
      outputPath: archivePath,
      publisher: input.publisher,
      title: input.title,
      summary: input.summary,
      category: input.category,
    });
    return {
      bytes: readFileSync(archivePath),
      fileName: `${normalizeAppId(packed.manifest.id)}.tgz`,
      manifest: packed.manifest,
      archiveSha256: packed.archiveSha256,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function packAppStoreArchive(input: {
  appRoot: string;
  manifestOverride?: OpenGroveAppManifest;
  allowSetup?: boolean;
  purpose?: "release" | "local-draft";
}): AppStoreArchive {
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-app-publish-"));
  try {
    const archivePath = join(tempRoot, "app.tgz");
    const packed = packApp(input.appRoot, {
      outputPath: archivePath,
      manifestOverride: input.manifestOverride,
      allowSetup: input.allowSetup,
      purpose: input.purpose,
    });
    const packageManifest = packed.packageManifest as unknown as Record<string, unknown>;
    const manifest =
      (input.manifestOverride as unknown as Record<string, unknown>) ??
      requireAppManifest(input.appRoot, "app_store_publish_target_changed");
    const packageId = stringOrUndefined(packageManifest.packageId) || "app";
    const version = stringOrUndefined(packageManifest.version) || "0.1.0";
    const bytes = readFileSync(archivePath);
    return {
      bytes,
      fileName: `${packageId}-${version}.tgz`,
      archiveSha256: packed.archiveSha256,
      archiveSize: packed.archiveSize,
      packageManifest,
      manifest,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function importAppStorePackage(input: {
  state: BridgeState;
  package: unknown;
  archiveBytes?: Buffer;
}): AppStorePackageRecord {
  const storeRoot = appStoreDataRoot(input.state);
  mkdirSync(storeRoot, { recursive: true });
  const normalized = normalizeImportedPackage(input.package);
  if (!normalized) throw new Error("app_store_package_invalid");
  let record: AppStorePackageRecord = {
    ...normalized,
  };
  if (input.archiveBytes) {
    const archiveRoot = join(storeRoot, "archives");
    const archiveDir = resolveInside(archiveRoot, record.id);
    if (!archiveDir || archiveDir === resolve(archiveRoot)) throw new Error("app_store_package_id_invalid");
    mkdirSync(archiveDir, { recursive: true });
    const archiveSha256 = sha256Buffer(input.archiveBytes);
    const archiveName = `${archiveSha256.slice(0, 16)}${archiveExtension(record.archiveName || `${record.id}.tgz`)}`;
    const archivePath = join(archiveDir, archiveName);
    writeFileSync(archivePath, input.archiveBytes);
    record = {
      ...record,
      archiveName: record.archiveName || `${record.id}.tgz`,
      archiveSize: input.archiveBytes.byteLength,
      archiveSha256,
      archiveFile: relativeArchiveFile(storeRoot, archivePath),
      packageUrl: `/api/app-store/packages/${encodeURIComponent(record.id)}/archive`,
    };
  }
  const sourceIdentity = appStorePackageSourceIdentity(record);
  writeImportedRegistryPackages(storeRoot, [
    ...readImportedRegistryPackages(storeRoot).filter(
      (item) => item.id !== record.id && (!sourceIdentity || appStorePackageSourceIdentity(item) !== sourceIdentity),
    ),
    record,
  ]);
  return record;
}

export function captureAppStorePublishTarget(appRootInput: string): AppStorePublishTargetSnapshot {
  const snapshot = captureAppStoreTargetSnapshot(appRootInput);
  const manifest = requireAppManifest(snapshot.appRoot, "app_store_publish_target_changed");
  const appId = stringOrUndefined(manifest.id);
  if (
    !appId ||
    (snapshot.installMarker &&
      (stringOrUndefined(snapshot.installMarker.source) !== "registry" ||
        stringOrUndefined(snapshot.installMarker.appId) !== appId))
  ) {
    throw new Error("app_store_publish_target_changed");
  }
  return snapshot;
}

/** Captures only filesystem identity; it does not assign trust to marker contents. */
export function captureAppStoreTargetSnapshot(appRootInput: string): AppStorePublishTargetSnapshot {
  const appRoot = resolve(appRootInput);
  const rootEntry = readPathEntry(appRoot);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error("app_store_publish_target_changed");
  }
  const manifestPath = strictAppManifestPath(appRoot);
  if (!manifestPath) throw new Error("app_store_publish_target_changed");
  requireAppManifest(appRoot, "app_store_publish_target_changed");
  let realAppRoot: string;
  try {
    realAppRoot = realpathSync.native(appRoot);
  } catch {
    throw new Error("app_store_publish_target_changed");
  }

  const markerPath = join(appRoot, ".opengrove-store-package.json");
  const markerEntry = readPathEntry(markerPath);
  if (!markerEntry) {
    return {
      appRoot,
      realAppRoot,
      rootDevice: String(rootEntry.dev),
      rootInode: String(rootEntry.ino),
    };
  }
  if (!markerEntry.isFile() || markerEntry.isSymbolicLink()) {
    throw new Error("app_store_publish_target_changed");
  }
  try {
    const markerBytes = readFileSync(markerPath);
    const installMarker = recordValue(JSON.parse(markerBytes.toString("utf8")));
    return {
      appRoot,
      realAppRoot,
      rootDevice: String(rootEntry.dev),
      rootInode: String(rootEntry.ino),
      installMarker,
      installMarkerSha256: sha256Buffer(markerBytes),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "app_store_publish_target_changed") throw error;
    throw new Error("app_store_publish_target_changed");
  }
}

/**
 * Returns the stable Store-owned installation container used to serialize
 * program-generation changes. Legacy and manually mounted Apps keep using
 * their App root as the lock identity.
 */
export function appStoreInstallContainerRoot(appRootInput: string, appId: string): string {
  const appRoot = resolve(appRootInput);
  const storeRoot = sideBySideAppStoreRoot(appRoot);
  if (!storeRoot || !isValidAppStoreAppId(appId)) return appRoot;
  // Program generations live below the App Store data root, while the stable
  // installation/Workspace container lives below APP_STORE_APPS_DIR. Production
  // config deliberately separates those roots, so derive the lock identity from
  // the same canonical container used by installation instead of guessing a
  // sibling of the programs directory.
  const containerRoot = resolveCanonicalAppStoreRoot(appId);
  const appProgramsRoot = dirname(dirname(appRoot));
  return basename(appProgramsRoot) === appStoreInstallKey(containerRoot) || basename(appProgramsRoot) === appId
    ? containerRoot
    : appRoot;
}

export function writeAppStorePackageInstallMarker(input: {
  appRoot: string;
  item: AppStorePackageRecord;
  includeArchiveEvidence?: boolean;
}): Record<string, unknown> {
  const markerPath = join(resolve(input.appRoot), ".opengrove-store-package.json");
  let installedAt: string | undefined;
  if (existsSync(markerPath)) {
    try {
      installedAt = stringOrUndefined(recordValue(JSON.parse(readFileSync(markerPath, "utf8"))).installedAt);
    } catch (error) {
      const corruptBackupPath = `${markerPath}.corrupt-${Date.now()}-${randomUUID()}.bak`;
      renameSync(markerPath, corruptBackupPath);
      console.warn("app_store_install_marker_quarantined", {
        markerPath,
        corruptBackupPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const marker = packageInstallMarker(input.item, {
    installedAt,
    includeArchiveEvidence: input.includeArchiveEvidence,
  });
  mkdirSync(dirname(markerPath), { recursive: true });
  const tempMarkerPath = `${markerPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tempMarkerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    renameSync(tempMarkerPath, markerPath);
  } finally {
    rmSync(tempMarkerPath, { force: true });
  }
  return marker;
}

export function writePublishedAppStorePackageMetadata(input: {
  appRoot: string;
  item: AppStorePackageRecord;
  packageManifest: Record<string, unknown>;
  targetSnapshot: AppStorePublishTargetSnapshot;
  releaseManifest?: Record<string, unknown>;
  localManifest?: Record<string, unknown>;
}): { installMarker: Record<string, unknown>; packageManifest: Record<string, unknown> } {
  const appRoot = resolve(input.appRoot);
  const appManifestPath = strictAppManifestPath(appRoot);
  if (!appManifestPath) throw new Error("app_store_publish_target_changed");
  const packageManifestPath = join(appRoot, ".opengrove-package-manifest.json");
  const markerPath = join(appRoot, ".opengrove-store-package.json");

  return withAppStoreInstallLock(appRoot, () => {
    assertAppStorePublishTargetUnchanged(appRoot, input.item, input.targetSnapshot);
    assertPublishedPackageManifestMatchesAppRoot(appRoot, input.item, input.packageManifest, input.releaseManifest);

    const appManifestEntry = readPathEntry(appManifestPath);
    const packageManifestEntry = readPathEntry(packageManifestPath);
    const markerEntry = readPathEntry(markerPath);
    if (
      !appManifestEntry?.isFile() ||
      appManifestEntry.isSymbolicLink() ||
      (packageManifestEntry && (!packageManifestEntry.isFile() || packageManifestEntry.isSymbolicLink())) ||
      (markerEntry && (!markerEntry.isFile() || markerEntry.isSymbolicLink()))
    ) {
      throw new Error("app_store_publish_target_changed");
    }
    const installMarker = packageInstallMarker(input.item, {
      installedAt: stringOrUndefined(input.targetSnapshot.installMarker?.installedAt),
    });
    const transactionRoot = mkdtempSync(join(dirname(appRoot), ".opengrove-publish-metadata-"));
    const nextAppManifestPath = join(transactionRoot, "next-app-manifest.json");
    const nextPackageManifestPath = join(transactionRoot, "next-package-manifest.json");
    const nextMarkerPath = join(transactionRoot, "next-store-package.json");
    const previousAppManifestPath = join(transactionRoot, "previous-app-manifest.json");
    const previousPackageManifestPath = join(transactionRoot, "previous-package-manifest.json");
    const previousMarkerPath = join(transactionRoot, "previous-store-package.json");
    const hadPackageManifest = Boolean(packageManifestEntry);
    const hadMarker = Boolean(markerEntry);
    let appManifestBackedUp = false;
    let packageManifestBackedUp = false;
    let markerBackedUp = false;
    let appManifestInstalled = false;
    let packageManifestInstalled = false;
    let markerInstalled = false;
    let committed = false;
    let preserveRecovery = false;

    try {
      if (input.localManifest) {
        writeFileSync(nextAppManifestPath, `${JSON.stringify(input.localManifest, null, 2)}\n`, "utf8");
      }
      writeFileSync(nextPackageManifestPath, `${JSON.stringify(input.packageManifest, null, 2)}\n`, "utf8");
      writeFileSync(nextMarkerPath, `${JSON.stringify(installMarker, null, 2)}\n`, "utf8");
      if (input.localManifest) {
        renameSync(appManifestPath, previousAppManifestPath);
        appManifestBackedUp = true;
      }
      if (hadPackageManifest) {
        renameSync(packageManifestPath, previousPackageManifestPath);
        packageManifestBackedUp = true;
      }
      if (hadMarker) {
        renameSync(markerPath, previousMarkerPath);
        markerBackedUp = true;
      }
      if (input.localManifest) {
        renameSync(nextAppManifestPath, appManifestPath);
        appManifestInstalled = true;
      }
      renameSync(nextPackageManifestPath, packageManifestPath);
      packageManifestInstalled = true;
      renameSync(nextMarkerPath, markerPath);
      markerInstalled = true;
      committed = true;
    } catch (error) {
      try {
        if (appManifestInstalled) rmSync(appManifestPath, { force: true });
        if (packageManifestInstalled) rmSync(packageManifestPath, { force: true });
        if (markerInstalled) rmSync(markerPath, { force: true });
        if (appManifestBackedUp) renameSync(previousAppManifestPath, appManifestPath);
        if (packageManifestBackedUp) renameSync(previousPackageManifestPath, packageManifestPath);
        if (markerBackedUp) renameSync(previousMarkerPath, markerPath);
      } catch (rollbackError) {
        preserveRecovery = true;
        throw new Error(`app_store_publish_metadata_rollback_failed:${errorText(error)}:${errorText(rollbackError)}`);
      }
      throw error;
    } finally {
      if (committed) {
        rmSync(previousAppManifestPath, { force: true });
        rmSync(previousPackageManifestPath, { force: true });
        rmSync(previousMarkerPath, { force: true });
      }
      if (!preserveRecovery) rmSync(transactionRoot, { recursive: true, force: true });
    }

    return { installMarker, packageManifest: input.packageManifest };
  });
}

// ===== Formal publish recovery =====

export function prepareAppStorePublishRecovery(input: {
  state: BridgeState;
  idempotencyKey: string;
  targetSnapshot: AppStorePublishTargetSnapshot;
  packageManifest: Record<string, unknown>;
  archive: AppStoreArchive;
  packageKey?: string;
  visibility?: string;
  releaseManifest?: Record<string, unknown>;
  applyReleasedEmployeesToLocal?: boolean;
  employeeOverridePatches?: AppStorePublishRecoveryRecord["employeeOverridePatches"];
}): PreparedAppStorePublishRecovery {
  assertAppStorePublishRecoveryKey(input.idempotencyKey);
  const storeRoot = appStoreDataRoot(input.state);
  const paths = appStorePublishRecoveryPaths(storeRoot, input.idempotencyKey);
  const archiveSha256 = sha256Buffer(input.archive.bytes);
  if (archiveSha256 !== input.archive.archiveSha256 || input.archive.archiveSize !== input.archive.bytes.byteLength) {
    throw new Error("app_store_publish_recovery_corrupted");
  }
  const metadata = {
    ...(input.packageKey?.trim() ? { packageKey: input.packageKey.trim() } : {}),
    ...(input.visibility?.trim() ? { visibility: input.visibility.trim() } : {}),
  };
  const intentDigest = appStorePublishIntentDigest({
    targetSnapshot: input.targetSnapshot,
    packageManifest: input.packageManifest,
    metadata,
    ...(input.releaseManifest ? { releaseManifest: input.releaseManifest } : {}),
    ...(input.applyReleasedEmployeesToLocal ? { applyReleasedEmployeesToLocal: true } : {}),
    ...(input.employeeOverridePatches?.length ? { employeeOverridePatches: input.employeeOverridePatches } : {}),
  });
  const existing = readAppStorePublishRecovery(storeRoot, input.idempotencyKey);
  if (existing && existing.intentDigest !== intentDigest) {
    throw new Error("app_store_publish_intent_changed");
  }
  if (existing) {
    const archiveBytes = readRecoveryArchive(paths.archivePath, existing.archive);
    return {
      idempotencyKey: existing.idempotencyKey,
      phase: existing.phase,
      packageManifest: existing.packageManifest,
      archive: { ...existing.archive, bytes: archiveBytes },
    };
  }

  const now = new Date().toISOString();
  const recovery: AppStorePublishRecoveryRecord = {
    schemaVersion: 1,
    idempotencyKey: input.idempotencyKey,
    phase: "prepared",
    intentDigest,
    createdAt: now,
    updatedAt: now,
    targetSnapshot: input.targetSnapshot,
    packageManifest: input.packageManifest,
    archive: {
      fileName: input.archive.fileName,
      archiveSha256,
      archiveSize: input.archive.bytes.byteLength,
    },
    metadata,
    ...(input.releaseManifest ? { releaseManifest: input.releaseManifest } : {}),
    ...(input.applyReleasedEmployeesToLocal ? { applyReleasedEmployeesToLocal: true } : {}),
    ...(input.employeeOverridePatches?.length ? { employeeOverridePatches: input.employeeOverridePatches } : {}),
  };
  mkdirSync(paths.root, { recursive: true });
  atomicWriteFile(paths.archivePath, input.archive.bytes);
  atomicWriteJson(paths.recordPath, recovery);
  return {
    idempotencyKey: recovery.idempotencyKey,
    phase: recovery.phase,
    packageManifest: recovery.packageManifest,
    archive: { ...recovery.archive, bytes: input.archive.bytes },
  };
}

export function markAppStorePublishRecoveryPublished(input: {
  state: BridgeState;
  idempotencyKey: string;
  publishedPackage: AppStorePackageRecord;
}): void {
  const storeRoot = appStoreDataRoot(input.state);
  const recovery = readAppStorePublishRecovery(storeRoot, input.idempotencyKey);
  if (!recovery) throw new Error("app_store_publish_recovery_missing");
  if (
    input.publishedPackage.appId !== stringOrUndefined(recovery.packageManifest.appId) ||
    input.publishedPackage.version !== stringOrUndefined(recovery.packageManifest.version) ||
    normalizeArchiveSha256(input.publishedPackage.archiveSha256) !== recovery.archive.archiveSha256 ||
    input.publishedPackage.archiveSize !== recovery.archive.archiveSize
  ) {
    throw new Error("app_store_package_invalid");
  }
  atomicWriteJson(appStorePublishRecoveryPaths(storeRoot, input.idempotencyKey).recordPath, {
    ...recovery,
    phase: "published",
    updatedAt: new Date().toISOString(),
    publishedPackage: input.publishedPackage,
  } satisfies AppStorePublishRecoveryRecord);
}

export function completeAppStorePublishRecovery(input: {
  state: BridgeState;
  idempotencyKey: string;
  expectedAppRoot?: string;
}): { item: AppStorePackageRecord; archive: PreparedAppStorePublishRecovery["archive"] } {
  const storeRoot = appStoreDataRoot(input.state);
  const recovery = readAppStorePublishRecovery(storeRoot, input.idempotencyKey);
  if (!recovery || recovery.phase !== "published" || !recovery.publishedPackage) {
    throw new Error("app_store_publish_recovery_not_ready");
  }
  const mountedTarget = resolveMountedAppTarget(input.state, recovery.publishedPackage.appId);
  if (
    !mountedTarget ||
    resolve(mountedTarget.appRoot) !== recovery.targetSnapshot.appRoot ||
    (input.expectedAppRoot && resolve(input.expectedAppRoot) !== recovery.targetSnapshot.appRoot)
  ) {
    throw new Error("app_store_publish_target_changed");
  }
  const paths = appStorePublishRecoveryPaths(storeRoot, input.idempotencyKey);
  const archiveBytes = readRecoveryArchive(paths.archivePath, recovery.archive);
  const item = importAppStorePackage({
    state: input.state,
    package: recovery.publishedPackage,
    archiveBytes,
  });
  if (!publishedAppStoreMetadataAlreadyCommitted(recovery, item)) {
    writePublishedAppStorePackageMetadata({
      appRoot: recovery.targetSnapshot.appRoot,
      item,
      packageManifest: recovery.packageManifest,
      targetSnapshot: recovery.targetSnapshot,
      ...(recovery.releaseManifest
        ? {
            releaseManifest: recovery.releaseManifest,
            localManifest: finalizedPublishedReleaseManifest(recovery.releaseManifest, item),
          }
        : {}),
    });
  }
  if (recovery.releaseManifest) {
    syncPublishedEmployeeDefaultsToLocalState({
      state: input.state,
      appId: item.appId,
      releaseManifest: recovery.releaseManifest,
      applyValues: recovery.applyReleasedEmployeesToLocal === true,
      employeeOverridePatches: recovery.employeeOverridePatches,
    });
  }
  rmSync(paths.recordPath, { force: true });
  rmSync(paths.archivePath, { force: true });
  return {
    item,
    archive: { ...recovery.archive, bytes: archiveBytes },
  };
}

function syncPublishedEmployeeDefaultsToLocalState(input: {
  state: BridgeState;
  appId: string;
  releaseManifest: Record<string, unknown>;
  applyValues: boolean;
  employeeOverridePatches?: AppStorePublishRecoveryRecord["employeeOverridePatches"];
}): void {
  const employeeDefaults = recordArray(recordValue(recordValue(input.releaseManifest).store).employeeDefaults);
  const currentMembers = new Map(input.state.app.rooms.listMembers().map((member) => [member.id, member]));
  const overridesByMemberId = new Map(
    input.employeeOverridePatches?.map((patch) => [patch.memberId, patch.userOverrides]) ?? [],
  );
  let changed = false;
  for (const item of employeeDefaults) {
    const memberId = stringOrUndefined(item.memberId);
    const member = memberId ? currentMembers.get(memberId) : undefined;
    if (!member || member.appId !== input.appId) continue;
    const defaults: NonNullable<RoomChannelMember["manifestDefaults"]> = {
      name: stringOrUndefined(item.name),
      avatarMode:
        item.avatarMode === "generated" || item.avatarMode === "initials" || item.avatarMode === "upload"
          ? item.avatarMode
          : undefined,
      avatarSeed: stringOrUndefined(item.avatarSeed),
      avatarDataUrl: stringOrUndefined(item.avatarDataUrl),
      role: typeof item.role === "string" ? item.role.trim() : undefined,
      kernel: stringOrUndefined(item.kernel),
      model: stringOrUndefined(item.model),
      color: stringOrUndefined(item.color),
      availableSkillIds: stringArray(item.availableSkillIds),
      defaultSkillIds: stringArray(item.defaultSkillIds),
      reasoningEffort: normalizeReasoningEffort(item.reasoningEffort),
      contextTokenBudget: positiveInteger(item.contextTokenBudget),
      accessMode: normalizeEmployeeAccessMode(item.accessMode),
      visibility: normalizeVisibility(item.visibility),
      publicDescription: stringOrUndefined(item.publicDescription),
      publicSkills: stringArray(item.publicSkills),
      inputSpec: stringOrUndefined(item.inputSpec),
      outputSpec: stringOrUndefined(item.outputSpec),
    };
    input.state.app.rooms.patchMember(
      member.id,
      input.applyValues
        ? employeeManifestDefaultsPatch(member, defaults)
        : {
            manifestDefaults: { ...defaults },
            ...(overridesByMemberId.has(member.id)
              ? {
                  userOverrides: [
                    ...(overridesByMemberId.get(member.id) ?? []),
                    ...(member.userOverrides?.includes("providerId") ? ["providerId"] : []),
                  ].filter((field, index, fields) => fields.indexOf(field) === index),
                }
              : {}),
          },
    );
    changed = true;
  }
  if (changed) input.state.store.saveFrom(input.state.app);
}

export function recoverPublishedAppStorePublishes(state: BridgeState): {
  recovered: string[];
  failed: Array<{ idempotencyKey: string; error: string }>;
} {
  const storeRoot = appStoreDataRoot(state);
  const root = appStorePublishRecoveryRoot(storeRoot);
  const recovered: string[] = [];
  const failed: Array<{ idempotencyKey: string; error: string }> = [];
  if (!existsSync(root)) return { recovered, failed };
  for (const name of readdirSync(root)) {
    const match = name.match(/^(og-app-publish-[a-f0-9]{64})\.json$/);
    if (!match) continue;
    const idempotencyKey = match[1] || "";
    try {
      const recovery = readAppStorePublishRecovery(storeRoot, idempotencyKey);
      if (recovery?.phase !== "published") continue;
      completeAppStorePublishRecovery({ state, idempotencyKey });
      recovered.push(idempotencyKey);
    } catch (error) {
      failed.push({ idempotencyKey, error: errorText(error) });
    }
  }
  return { recovered, failed };
}

function appStorePublishRecoveryRoot(storeRoot: string): string {
  return join(storeRoot, "publish-recovery");
}

function appStorePublishRecoveryPaths(
  storeRoot: string,
  idempotencyKey: string,
): {
  root: string;
  recordPath: string;
  archivePath: string;
} {
  assertAppStorePublishRecoveryKey(idempotencyKey);
  const root = appStorePublishRecoveryRoot(storeRoot);
  return {
    root,
    recordPath: join(root, `${idempotencyKey}.json`),
    archivePath: join(root, `${idempotencyKey}.tgz`),
  };
}

function assertAppStorePublishRecoveryKey(value: string): void {
  if (!/^og-app-publish-[a-f0-9]{64}$/.test(value)) {
    throw new Error("app_store_publish_idempotency_key_invalid");
  }
}

function appStorePublishIntentDigest(input: {
  targetSnapshot: AppStorePublishTargetSnapshot;
  packageManifest: Record<string, unknown>;
  metadata: AppStorePublishRecoveryRecord["metadata"];
  releaseManifest?: Record<string, unknown>;
  applyReleasedEmployeesToLocal?: boolean;
  employeeOverridePatches?: AppStorePublishRecoveryRecord["employeeOverridePatches"];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        targetSnapshot: input.targetSnapshot,
        packageManifest: input.packageManifest,
        metadata: input.metadata,
        ...(input.releaseManifest ? { releaseManifest: input.releaseManifest } : {}),
        ...(input.applyReleasedEmployeesToLocal ? { applyReleasedEmployeesToLocal: true } : {}),
        ...(input.employeeOverridePatches?.length ? { employeeOverridePatches: input.employeeOverridePatches } : {}),
      }),
    )
    .digest("hex");
}

function readAppStorePublishRecovery(
  storeRoot: string,
  idempotencyKey: string,
): AppStorePublishRecoveryRecord | undefined {
  const path = appStorePublishRecoveryPaths(storeRoot, idempotencyKey).recordPath;
  if (!existsSync(path)) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = recordValue(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error("app_store_publish_recovery_corrupted");
  }
  const target = recordValue(parsed.targetSnapshot);
  const archive = recordValue(parsed.archive);
  const metadata = recordValue(parsed.metadata);
  const phase = parsed.phase === "published" ? "published" : parsed.phase === "prepared" ? "prepared" : undefined;
  const packageManifest = recordValue(parsed.packageManifest);
  const releaseManifest = recordValue(parsed.releaseManifest);
  const employeeOverridePatches = recordArray(parsed.employeeOverridePatches).flatMap((patch) => {
    const memberId = stringOrUndefined(patch.memberId);
    if (!memberId) return [];
    return [{ memberId, userOverrides: stringArray(patch.userOverrides) }];
  });
  const publishedPackage = parsed.publishedPackage ? normalizeImportedPackage(parsed.publishedPackage) : undefined;
  const recovery: AppStorePublishRecoveryRecord = {
    schemaVersion: 1,
    idempotencyKey: stringOrUndefined(parsed.idempotencyKey) || "",
    phase: phase || "prepared",
    intentDigest: stringOrUndefined(parsed.intentDigest) || "",
    createdAt: stringOrUndefined(parsed.createdAt) || "",
    updatedAt: stringOrUndefined(parsed.updatedAt) || "",
    targetSnapshot: {
      appRoot: stringOrUndefined(target.appRoot) || "",
      realAppRoot: stringOrUndefined(target.realAppRoot) || "",
      rootDevice: stringOrUndefined(target.rootDevice) || "",
      rootInode: stringOrUndefined(target.rootInode) || "",
      ...(Object.keys(recordValue(target.installMarker)).length
        ? { installMarker: recordValue(target.installMarker) }
        : {}),
      ...(stringOrUndefined(target.installMarkerSha256)
        ? { installMarkerSha256: stringOrUndefined(target.installMarkerSha256) }
        : {}),
    },
    packageManifest,
    archive: {
      fileName: stringOrUndefined(archive.fileName) || "",
      archiveSha256: stringOrUndefined(archive.archiveSha256) || "",
      archiveSize: numberValue(archive.archiveSize) || 0,
    },
    metadata: {
      ...(stringOrUndefined(metadata.packageKey) ? { packageKey: stringOrUndefined(metadata.packageKey) } : {}),
      ...(stringOrUndefined(metadata.visibility) ? { visibility: stringOrUndefined(metadata.visibility) } : {}),
    },
    ...(Object.keys(releaseManifest).length ? { releaseManifest } : {}),
    ...(parsed.applyReleasedEmployeesToLocal === true ? { applyReleasedEmployeesToLocal: true } : {}),
    ...(employeeOverridePatches.length ? { employeeOverridePatches } : {}),
    ...(publishedPackage ? { publishedPackage } : {}),
  };
  if (
    numberValue(parsed.schemaVersion) !== 1 ||
    recovery.idempotencyKey !== idempotencyKey ||
    !phase ||
    !recovery.intentDigest.match(/^[a-f0-9]{64}$/) ||
    !recovery.targetSnapshot.appRoot ||
    !recovery.targetSnapshot.realAppRoot ||
    !recovery.targetSnapshot.rootDevice ||
    !recovery.targetSnapshot.rootInode ||
    !Object.keys(recovery.packageManifest).length ||
    !recovery.archive.fileName ||
    !recovery.archive.archiveSha256.match(/^[a-f0-9]{64}$/) ||
    !recovery.archive.archiveSize ||
    (phase === "published" && !publishedPackage)
  ) {
    throw new Error("app_store_publish_recovery_corrupted");
  }
  return recovery;
}

function readRecoveryArchive(path: string, archive: AppStorePublishRecoveryRecord["archive"]): Buffer {
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength !== archive.archiveSize || sha256Buffer(bytes) !== archive.archiveSha256) {
      throw new Error("app_store_publish_recovery_corrupted");
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === "app_store_publish_recovery_corrupted") throw error;
    throw new Error("app_store_publish_recovery_corrupted");
  }
}

function publishedAppStoreMetadataAlreadyCommitted(
  recovery: AppStorePublishRecoveryRecord,
  item: AppStorePackageRecord,
): boolean {
  try {
    const marker = recordValue(
      JSON.parse(readFileSync(join(recovery.targetSnapshot.appRoot, ".opengrove-store-package.json"), "utf8")),
    );
    const packageManifest = recordValue(
      JSON.parse(readFileSync(join(recovery.targetSnapshot.appRoot, ".opengrove-package-manifest.json"), "utf8")),
    );
    const localManifest = recovery.releaseManifest
      ? recordValue(parseJsonLikeConfig(strictAppManifestPath(recovery.targetSnapshot.appRoot) || "", "jsonc"))
      : undefined;
    return (
      stringOrUndefined(marker.source) === "registry" &&
      stringOrUndefined(marker.appId) === item.appId &&
      normalizeAppStorePackageKey(marker.packageKey) === normalizeAppStorePackageKey(item.packageKey) &&
      stringOrUndefined(marker.version) === item.version &&
      normalizeArchiveSha256(marker.archiveSha256) === normalizeArchiveSha256(item.archiveSha256) &&
      JSON.stringify(packageManifest) === JSON.stringify(recovery.packageManifest) &&
      (!recovery.releaseManifest ||
        JSON.stringify(localManifest) ===
          JSON.stringify(finalizedPublishedReleaseManifest(recovery.releaseManifest, item)))
    );
  } catch {
    // non-critical-fallback: invalid local publication evidence is treated as not committed.
    return false;
  }
}

function finalizedPublishedReleaseManifest(
  manifest: Record<string, unknown>,
  publishedPackage: AppStorePackageRecord,
): Record<string, unknown> {
  return {
    ...manifest,
    version: publishedPackage.version,
    store: {
      ...recordValue(manifest.store),
      ...(publishedPackage.packageKey ? { packageKey: publishedPackage.packageKey } : {}),
    },
  };
}

function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function atomicWriteFile(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tempPath, bytes);
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function assertAppStorePublishTargetSnapshotUnchanged(
  appRootInput: string,
  snapshot: AppStorePublishTargetSnapshot,
): void {
  const appRoot = resolve(appRootInput);
  const rootEntry = readPathEntry(appRoot);
  let realAppRoot = "";
  try {
    realAppRoot = realpathSync.native(appRoot);
  } catch {
    // non-critical-fallback: The common validation below reports missing or replaced roots uniformly.
  }
  if (
    appRoot !== snapshot.appRoot ||
    !rootEntry?.isDirectory() ||
    rootEntry.isSymbolicLink() ||
    String(rootEntry.dev) !== snapshot.rootDevice ||
    String(rootEntry.ino) !== snapshot.rootInode ||
    realAppRoot !== snapshot.realAppRoot
  ) {
    throw new Error("app_store_publish_target_changed");
  }

  const markerPath = join(appRoot, ".opengrove-store-package.json");
  const markerEntry = readPathEntry(markerPath);
  if (snapshot.installMarkerSha256) {
    let currentMarkerSha256 = "";
    try {
      currentMarkerSha256 =
        markerEntry?.isFile() && !markerEntry.isSymbolicLink() ? sha256Buffer(readFileSync(markerPath)) : "";
    } catch {
      // non-critical-fallback: Validation below reports a marker replaced between lstat and read uniformly.
    }
    if (
      !markerEntry?.isFile() ||
      markerEntry.isSymbolicLink() ||
      currentMarkerSha256 !== snapshot.installMarkerSha256
    ) {
      throw new Error("app_store_publish_target_changed");
    }
  } else if (markerEntry) {
    throw new Error("app_store_publish_target_changed");
  }
}

function sideBySideAppStoreRoot(appRootInput: string): string | undefined {
  const appRoot = resolve(appRootInput);
  if (basename(appRoot) !== "app") return undefined;
  const appProgramsRoot = dirname(dirname(appRoot));
  const programsRoot = dirname(appProgramsRoot);
  return basename(programsRoot) === "programs" &&
    (/^[a-f0-9]{64}$/.test(basename(appProgramsRoot)) || isAppStoreAppDirectoryName(basename(appProgramsRoot)))
    ? dirname(programsRoot)
    : undefined;
}

function assertAppStorePublishTargetUnchanged(
  appRoot: string,
  item: AppStorePackageRecord,
  snapshot: AppStorePublishTargetSnapshot,
): void {
  assertAppStorePublishTargetSnapshotUnchanged(appRoot, snapshot);

  const markerPath = join(appRoot, ".opengrove-store-package.json");
  if (snapshot.installMarkerSha256) {
    if (!packageMarkerProvenanceMatches(markerPath, item)) {
      throw new Error("app_store_publish_target_changed");
    }
  }

  const manifestPath = strictAppManifestPath(appRoot);
  if (!manifestPath) throw new Error("app_store_publish_target_changed");
  const manifest = requireAppManifest(appRoot, "app_store_publish_target_changed");
  if (stringOrUndefined(manifest.id) !== item.appId) {
    throw new Error("app_store_publish_target_changed");
  }
  const manifestPackageKey = normalizeAppStorePackageKey(recordValue(manifest.store).packageKey);
  if (manifestPackageKey && manifestPackageKey !== normalizeAppStorePackageKey(item.packageKey)) {
    throw new Error("app_store_publish_target_changed");
  }
}

function assertPublishedPackageManifestMatchesAppRoot(
  appRoot: string,
  item: AppStorePackageRecord,
  packageManifest: Record<string, unknown>,
  releaseManifest?: Record<string, unknown>,
): void {
  const packageKey = normalizeAppStorePackageKey(packageManifest.packageKey);
  if (
    numberValue(packageManifest.schemaVersion) !== 1 ||
    stringOrUndefined(packageManifest.appId) !== item.appId ||
    stringOrUndefined(packageManifest.version) !== item.version ||
    (packageKey && packageKey !== normalizeAppStorePackageKey(item.packageKey))
  ) {
    throw new Error("app_store_publish_target_changed");
  }

  const files = recordValue(packageManifest.files);
  if (!Object.keys(files).length) throw new Error("app_store_publish_target_changed");
  let realAppRoot: string;
  try {
    realAppRoot = realpathSync.native(appRoot);
  } catch {
    throw new Error("app_store_publish_target_changed");
  }
  const appManifestPath = strictAppManifestPath(appRoot);
  const appManifestRelativePath = appManifestPath ? relative(appRoot, appManifestPath).split(sep).join("/") : "";
  for (const [relativePath, expectedDigestValue] of Object.entries(files)) {
    if (relativePath === ".opengrove-package-manifest.json" || relativePath === ".opengrove-store-package.json") {
      throw new Error("app_store_publish_target_changed");
    }
    const targetPath = resolve(appRoot, relativePath);
    const resolvedRelativePath = relative(appRoot, targetPath);
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      resolvedRelativePath === ".." ||
      resolvedRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(resolvedRelativePath)
    ) {
      throw new Error("app_store_publish_target_changed");
    }
    const expectedDigest = stringOrUndefined(expectedDigestValue)?.toLowerCase();
    if (!expectedDigest?.match(/^sha256:[a-f0-9]{64}$/)) {
      throw new Error("app_store_publish_target_changed");
    }
    if (releaseManifest && relativePath === appManifestRelativePath) {
      const releaseManifestDigest = `sha256:${sha256Buffer(Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8"))}`;
      if (releaseManifestDigest !== expectedDigest) throw new Error("app_store_publish_target_changed");
      continue;
    }
    const targetEntry = readPathEntry(targetPath);
    let realTargetRelativePath = "..";
    try {
      realTargetRelativePath = relative(realAppRoot, realpathSync.native(targetPath));
    } catch {
      // non-critical-fallback: Common validation below reports missing, unreadable, or escaped files uniformly.
    }
    if (
      !targetEntry?.isFile() ||
      targetEntry.isSymbolicLink() ||
      realTargetRelativePath === ".." ||
      realTargetRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(realTargetRelativePath) ||
      `sha256:${sha256Buffer(readFileSync(targetPath))}` !== expectedDigest
    ) {
      throw new Error("app_store_publish_target_changed");
    }
  }
}

export { readAppStorePackageInstallMarker } from "./app-store-install-marker.js";

export function resolveAppStoreArchive(input: {
  packageId: string;
  storeRoot?: string;
}): { path: string; fileName: string; contentType: string } | undefined {
  const item = findAppStorePackage(input.packageId, input.storeRoot);
  if (!item?.archiveFile || !input.storeRoot) return undefined;
  const path = resolveInside(input.storeRoot, item.archiveFile);
  if (!path || !existsSync(path) || !statSync(path).isFile()) return undefined;
  return {
    path,
    fileName: item.archiveName || basename(path),
    contentType: archiveContentType(path),
  };
}

export function appStoreDataRoot(state: BridgeState): string {
  return bridgeDataPath(state, "app-store");
}

/** Current layout root: desktop override, platform default, or an isolated custom-state fallback. */
export function currentAppStoreProgramsRoot(storeRoot: string): string {
  const explicitRoot = readAppEnv("PROGRAMS_DIR")?.trim();
  if (explicitRoot) return resolve(explicitRoot);
  const resolvedStoreRoot = resolve(storeRoot);
  const defaultStoreRoot = resolve(defaultOpenGroveDataDir(), "app-store");
  return resolvedStoreRoot === defaultStoreRoot
    ? resolve(defaultOpenGroveProgramsDir())
    : legacyAppStoreProgramsRoot(resolvedStoreRoot);
}

export function inspectUnreferencedAppStoreArchives(storeRoot: string): {
  candidates: Array<{ path: string; bytes: number }>;
  reclaimableBytes: number;
} {
  const packages = readImportedRegistryPackagesForCleanup(storeRoot);
  if (!packages) return { candidates: [], reclaimableBytes: 0 };
  const archiveRoot = join(resolve(storeRoot), "archives");
  if (!readPathEntry(archiveRoot)?.isDirectory()) return { candidates: [], reclaimableBytes: 0 };
  const referenced = new Set<string>();
  for (const item of packages) {
    if (!item.archiveFile) continue;
    const path = resolveInside(storeRoot, item.archiveFile);
    if (!path || !pathIsInside(archiveRoot, path)) return { candidates: [], reclaimableBytes: 0 };
    referenced.add(resolve(path));
  }
  const candidates: Array<{ path: string; bytes: number }> = [];
  try {
    collectUnreferencedArchiveFiles(archiveRoot, referenced, candidates);
  } catch {
    // non-critical-fallback: an unreadable or concurrently changing archive root is retained in full.
    return { candidates: [], reclaimableBytes: 0 };
  }
  return {
    candidates,
    reclaimableBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
  };
}

export function cleanupUnreferencedAppStoreArchives(storeRoot: string): {
  removed: string[];
  retained: string[];
  reclaimedBytes: number;
} {
  const archiveRoot = join(resolve(storeRoot), "archives");
  const inspection = inspectUnreferencedAppStoreArchives(storeRoot);
  const removed: string[] = [];
  const retained: string[] = [];
  let reclaimedBytes = 0;
  for (const candidate of inspection.candidates) {
    try {
      rmSync(candidate.path, { force: true });
      removed.push(candidate.path);
      reclaimedBytes += candidate.bytes;
      removeEmptyArchiveParents(dirname(candidate.path), archiveRoot);
    } catch {
      // non-critical-fallback: an in-use archive remains available for the next cleanup pass.
      retained.push(candidate.path);
    }
  }
  return { removed, retained, reclaimedBytes };
}

function collectUnreferencedArchiveFiles(
  root: string,
  referenced: ReadonlySet<string>,
  candidates: Array<{ path: string; bytes: number }>,
): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      collectUnreferencedArchiveFiles(path, referenced, candidates);
      continue;
    }
    if (entry.isFile() && !referenced.has(resolve(path))) candidates.push({ path, bytes: statSync(path).size });
  }
}

function removeEmptyArchiveParents(start: string, archiveRoot: string): void {
  let current = resolve(start);
  const boundary = resolve(archiveRoot);
  while (current !== boundary && pathIsInside(boundary, current) && directoryIsEmpty(current)) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

export function cleanupUnreferencedAppStoreProgramGenerations(
  storeRoot: string,
  settings: Pick<BridgeSettings, "mountedApps">,
): { removed: string[]; retained: string[]; reclaimedBytes: number } {
  const inspection = inspectUnreferencedAppStoreProgramGenerations(storeRoot, settings);
  const removed: string[] = [];
  const retained = [...inspection.retained];
  const removableBuckets = new Set<string>();
  let reclaimedBytes = 0;
  for (const candidate of inspection.candidates) {
    try {
      rmSync(candidate.generationRoot, { recursive: true, force: true });
      removed.push(candidate.appRoot);
      removableBuckets.add(dirname(candidate.generationRoot));
      reclaimedBytes += candidate.bytes;
    } catch {
      // non-critical-fallback: a locked obsolete generation remains marked for the next startup pass.
      retained.push(candidate.appRoot);
    }
  }
  for (const appBucketRoot of removableBuckets) {
    if (directoryIsEmpty(appBucketRoot)) {
      try {
        rmdirSync(appBucketRoot);
      } catch {
        // non-critical-fallback: a concurrent installer may have added a generation.
      }
    }
  }
  return { removed, retained, reclaimedBytes };
}

export function inspectUnreferencedAppStoreProgramGenerations(
  storeRoot: string,
  settings: Pick<BridgeSettings, "mountedApps">,
): {
  candidates: Array<{ appRoot: string; generationRoot: string; bytes: number }>;
  retained: string[];
  reclaimableBytes: number;
} {
  const activeProgramRoots = new Set(
    settings.mountedApps.filter((mountedApp) => mountedApp.path?.trim()).map((mountedApp) => resolve(mountedApp.path)),
  );
  const candidates: Array<{ appRoot: string; generationRoot: string; bytes: number }> = [];
  const retained: string[] = [];
  for (const programsRoot of storeAppLayoutV2ProgramRoots({
    storeRoot,
    currentProgramsRoot: currentAppStoreProgramsRoot(storeRoot),
  })) {
    inspectProgramGenerationsInRoot(programsRoot, activeProgramRoots, candidates, retained);
  }
  return {
    candidates,
    retained,
    reclaimableBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
  };
}

function regularFileBytesRecursively(root: string): number {
  const entry = lstatSync(root);
  if (entry.isSymbolicLink()) return 0;
  if (!entry.isDirectory()) return entry.isFile() ? entry.size : 0;
  return readdirSync(root).reduce((total, name) => total + regularFileBytesRecursively(join(root, name)), 0);
}

function inspectProgramGenerationsInRoot(
  programsRoot: string,
  activeProgramRoots: ReadonlySet<string>,
  candidates: Array<{ appRoot: string; generationRoot: string; bytes: number }>,
  retained: string[],
): void {
  try {
    if (!readPathEntry(programsRoot)?.isDirectory()) return;
    for (const appBucket of readdirSync(programsRoot, { withFileTypes: true })) {
      if (
        !appBucket.isDirectory() ||
        appBucket.isSymbolicLink() ||
        (!/^[a-f0-9]{64}$/.test(appBucket.name) && !isAppStoreAppDirectoryName(appBucket.name))
      ) {
        continue;
      }
      const appBucketRoot = join(programsRoot, appBucket.name);
      try {
        for (const generation of readdirSync(appBucketRoot, { withFileTypes: true })) {
          if (!generation.isDirectory() || generation.isSymbolicLink()) continue;
          const generationRoot = join(appBucketRoot, generation.name);
          const appRoot = join(generationRoot, "app");
          if (activeProgramRoots.has(resolve(appRoot))) continue;
          const cleanupMarker = join(generationRoot, ".opengrove-cleanup-pending");
          const cleanupMarkerEntry = readPathEntry(cleanupMarker);
          if (!cleanupMarkerEntry?.isFile() || cleanupMarkerEntry.isSymbolicLink()) continue;
          const appEntry = readPathEntry(appRoot);
          if (!appEntry?.isDirectory() || appEntry.isSymbolicLink()) continue;
          if (!programCleanupMarkerMatches(cleanupMarker, appRoot)) {
            retained.push(appRoot);
            continue;
          }
          try {
            candidates.push({ appRoot, generationRoot, bytes: regularFileBytesRecursively(generationRoot) });
          } catch {
            // non-critical-fallback: an unreadable candidate is not advertised as safe to remove.
            retained.push(appRoot);
          }
        }
      } catch {
        // non-critical-fallback: an inaccessible app bucket is retained for a later cleanup pass.
        retained.push(appBucketRoot);
      }
    }
  } catch {
    // non-critical-fallback: an inaccessible Programs root must not prevent OpenGrove from starting.
    retained.push(programsRoot);
  }
}

export function appStoreArchitectureSummary(): JsonObject {
  return {
    mode: "registry-local-install",
    registryResponsibilities: ["catalog", "package-storage", "publish"],
    localResponsibilities: ["program-generation-install", "workspace-files", "employee-install"],
    programLayout: "side-by-side-generations",
    activation: "mounted-program-pointer",
    workspaceBinding: "host-owned-stable-path",
    workspaceProvider: "local",
  };
}

// ===== Employee package installation =====

function installEmployeeStorePackage(input: {
  item: AppStorePackageRecord;
  state: BridgeState;
  backupEnabled?: boolean;
  storeRoot?: string;
}): AppStoreInstallResult {
  const manifest = readInstalledEmployeeManifest(input.item, input.storeRoot);
  installEmployeePackSkills(input.item, manifest, input.storeRoot, input.state);
  const dependencies = input.item.dependencies ?? appStoreEmployeeDependenciesFromManifest(manifest);
  const employee = input.item.employee ?? appStoreAgentSummaryFromEmployeeManifest(manifest, dependencies);
  const memberId = employeeStoreMemberId(input.item.id, manifest.employee.id);
  const existing = input.state.app.rooms.listMembers().find((member) => member.id === memberId);
  const requestedKernel = stringOrUndefined(manifest.employee.kernel) || employee.kernel;
  const kernel = requestedKernel && isBridgeKernelId(requestedKernel) ? requestedKernel : PRODUCT_DEFAULT_KERNEL_ID;
  const requestedModel = stringOrUndefined(manifest.employee.model);
  const member: RoomChannelMember = {
    ...(existing ?? {}),
    id: memberId,
    name: manifest.employee.name,
    avatarMode: manifest.employee.avatarMode,
    avatarSeed: stringOrUndefined(manifest.employee.avatarSeed),
    avatarDataUrl: stringOrUndefined(manifest.employee.avatarDataUrl),
    kernel,
    model:
      requestedModel && requestedModel !== LEGACY_NATIVE_MODEL_ID
        ? requestedModel
        : productDefaultModelForKernel(kernel),
    reasoningEffort:
      normalizeReasoningEffort(manifest.employee.reasoningEffort) ??
      employee.reasoningEffort ??
      existing?.reasoningEffort,
    contextTokenBudget:
      positiveInteger(manifest.employee.contextTokenBudget) ??
      employee.contextTokenBudget ??
      existing?.contextTokenBudget,
    role:
      stringOrUndefined(manifest.employee.role) ||
      stringOrUndefined(manifest.employee.instructions) ||
      stringOrUndefined(manifest.employee.description) ||
      `${manifest.employee.name} from ${input.item.title}.`,
    status: "idle",
    color: stringOrUndefined(manifest.employee.color) || existing?.color || "#2563eb",
    lastActive: "已添加",
    availableSkillIds: uniqueStringArray([
      ...(stringArray(manifest.employee.availableSkillIds).length
        ? stringArray(manifest.employee.availableSkillIds)
        : stringArray(manifest.employee.skills)),
      ...stringArray(manifest.employee.defaultSkillIds),
    ]),
    defaultSkillIds: stringArray(manifest.employee.defaultSkillIds).length
      ? stringArray(manifest.employee.defaultSkillIds)
      : stringArray(manifest.employee.availableSkillIds).length
        ? []
        : stringArray(manifest.employee.skills),
    appId: input.item.id,
    source: "local",
    sourceLabel: input.item.title,
    disabled: false,
    storePackageId: input.item.id,
    toolIds: employee.toolIds ?? dependencies.tools?.map((tool) => tool.id),
    visibility: normalizeVisibility(manifest.employee.visibility) ?? employee.visibility,
    publicDescription: stringOrUndefined(manifest.employee.publicDescription) ?? employee.publicDescription,
    publicSkills: stringArray(manifest.employee.publicSkills).length
      ? stringArray(manifest.employee.publicSkills)
      : employee.publicSkills,
    inputSpec: stringOrUndefined(manifest.employee.inputSpec) ?? employee.inputSpec,
    outputSpec: stringOrUndefined(manifest.employee.outputSpec) ?? employee.outputSpec,
  };
  input.state.app.rooms.upsertMember(member, { emitEvent: true });
  input.state.store.saveFrom(input.state.app);
  return {
    packageId: input.item.id,
    appId: input.item.appId,
    installMode: "contacts",
    member,
    workspaceProvider: "local",
    backupEnabled: input.backupEnabled !== false,
    status: existing && !existing.disabled ? "already_installed" : "installed",
    doctor: doctorEmployeePackage(input.state, input.item),
  };
}

function readInstalledEmployeeManifest(item: AppStorePackageRecord, storeRoot?: string): EmployeePackManifest {
  const root = ensureImportedEmployeePackageInstalled(item, storeRoot);
  return readEmployeePackManifest(root);
}

function ensureImportedEmployeePackageInstalled(item: AppStorePackageRecord, storeRoot?: string): string {
  if (!storeRoot || !item.archiveFile) throw new Error(`employee_package_archive_missing:${item.id}`);
  const archivePath = resolveInside(storeRoot, item.archiveFile);
  if (!archivePath || !existsSync(archivePath)) throw new Error(`employee_package_archive_missing:${item.id}`);
  const employeeRoot = join(storeRoot, "installed-employees");
  const packageRoot = resolveInside(employeeRoot, item.id);
  if (!packageRoot || packageRoot === resolve(employeeRoot)) throw new Error("app_store_package_id_invalid");
  const markerPath = join(packageRoot, ".opengrove-store-package.json");
  if (existsSync(join(packageRoot, "employee.json")) && packageMarkerMatches(markerPath, item)) {
    return packageRoot;
  }
  const parent = dirname(packageRoot);
  mkdirSync(parent, { recursive: true });
  const tempRoot = mkdtempSync(join(parent, `.employee-install-${item.id}-`));
  try {
    const unpackRoot = join(tempRoot, "unpacked");
    mkdirSync(unpackRoot, { recursive: true });
    const unpack = unpackAppStoreArchive(archivePath, unpackRoot);
    if (!unpack.ok) throw new Error(unpack.error);
    validateAppStoreExtractedTree(unpackRoot);
    const sourceRoot = findAppStoreArchiveRoot(unpackRoot, "employee");
    if (!sourceRoot) throw new Error("employee_pack_manifest_required");
    rmSync(packageRoot, { recursive: true, force: true });
    copyAppStoreExtractedTree(sourceRoot, packageRoot);
    writeFileSync(markerPath, `${JSON.stringify(packageInstallMarker(item), null, 2)}\n`, "utf8");
    return packageRoot;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function installEmployeePackSkills(
  item: AppStorePackageRecord,
  manifest: EmployeePackManifest,
  storeRoot: string | undefined,
  state: BridgeState,
): void {
  if (!storeRoot) return;
  const root = ensureImportedEmployeePackageInstalled(item, storeRoot);
  const skills = appStoreEmployeeDependenciesFromManifest(manifest).skills ?? [];
  for (const skill of skills) {
    if (skill.bundled || !skill.path) continue;
    const source = resolveInside(root, skill.path);
    if (!source || !existsSync(source) || !statSync(source).isDirectory()) continue;
    const skillsRoot = join(homedir(), APP_CONFIG_DIR, "skills");
    const target = resolveInside(skillsRoot, `store-${safeFileName(item.id)}-${safeFileName(skill.name || skill.id)}`);
    if (!target || target === resolve(skillsRoot)) throw new Error("app_store_package_id_invalid");
    copyAppStoreExtractedTree(source, target);
  }
  try {
    state.app.skills.list();
  } catch {
    // Skill installation is best-effort for the current process; a bridge recreation refreshes the catalog.
  }
}

function doctorEmployeePackage(state: BridgeState, item: AppStorePackageRecord): AppStoreEmployeeDoctor {
  const dependencies = item.dependencies ?? {};
  const items: AppStoreEmployeeDoctorItem[] = [];
  const kernelIds = new Set([...(dependencies.kernels ?? []), item.employee?.kernel ?? ""].filter(Boolean));
  const availableKernels = new Set(
    getBridgeKernelOptions(state)
      .filter((kernel) => Boolean(kernel.available || kernel.installed))
      .map((kernel) => stringOrUndefined(kernel.id))
      .filter((id): id is string => Boolean(id)),
  );
  for (const kernel of kernelIds) {
    const available = availableKernels.has(kernel);
    items.push({
      id: kernel,
      kind: "kernel",
      label: kernel,
      status: available ? "ok" : "missing",
      detail: available ? "Kernel available" : "Kernel not detected on this runtime",
    });
  }
  for (const skill of dependencies.skills ?? []) {
    const exists = Boolean(
      state.app.skills.get(skill.id) || (skill.name ? state.app.skills.get(skill.name) : undefined),
    );
    const packed = Boolean(skill.path && !skill.bundled);
    items.push({
      id: skill.id,
      kind: "skill",
      label: skill.title || skill.name || skill.id,
      status: exists ? "ok" : packed ? "installable" : skill.bundled ? "warning" : "missing",
      detail: exists
        ? "Installed"
        : packed
          ? "Will be installed from this employee package"
          : "Referenced skill is not bundled in the package",
    });
  }
  const availableTools = new Set(state.app.tools.specs().map((tool) => tool.id));
  for (const tool of dependencies.tools ?? []) {
    items.push({
      id: tool.id,
      kind: "tool",
      label: tool.title || tool.id,
      status: availableTools.has(tool.id) ? "ok" : "warning",
      detail: availableTools.has(tool.id)
        ? "Tool registered"
        : "Tool is declared by the pack but not currently registered",
    });
  }
  const providers = getAllBridgeProviderProfiles(state.settings.customProviders);
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  for (const provider of dependencies.providers ?? []) {
    const profile = providersById.get(provider);
    const configured = profile ? providerRuntimeState(profile).usable : false;
    items.push({
      id: provider,
      kind: "provider",
      label: provider,
      status: configured ? "ok" : "missing",
      detail: configured ? "Provider credentials are configured" : "Provider credentials are not configured",
    });
  }
  const missing = items.filter((item) => item.status === "missing").map((item) => item.id);
  const warnings = items.filter((item) => item.status === "warning").map((item) => item.id);
  return {
    ok: missing.length === 0,
    items,
    missing,
    warnings,
  };
}

export function installedEmployeePackageIds(state: BridgeState): Set<string> {
  const output = new Set<string>();
  for (const member of state.app.rooms.listMembers()) {
    if (!member.storePackageId || member.disabled) continue;
    if (!employeeStoreMemberVisible(member.id)) continue;
    output.add(member.storePackageId);
  }
  return output;
}

export function employeeStoreMemberId(packageId: string, employeeId: string): string {
  return `member-store-local-${normalizeAppId(packageId)}-${normalizeAppId(employeeId) || "employee"}`;
}

export function employeeStoreMemberVisible(memberId: string): boolean {
  return memberId.startsWith("member-store-local-");
}

function ensureImportedPackageInstalled(
  item: AppStorePackageRecord,
  settings: Pick<BridgeSettings, "mountedApps">,
  storeRoot?: string,
  options: { requireMissingRoot?: boolean } = {},
): {
  appRoot: string;
  workspaceRoot: string;
  workspaceContainerRoot: string;
  workspaceContainerCreated: boolean;
  createdFresh: boolean;
  packageChanged: boolean;
  workspaceBackupRoot?: string;
  updateInstall?: UpdatedAppStorePackageInstall;
} {
  if (!storeRoot || !item.archiveFile) throw new Error(`app_store_package_archive_missing:${item.id}`);
  const archivePath = resolveInside(storeRoot, item.archiveFile);
  if (!archivePath || !existsSync(archivePath)) throw new Error(`app_store_package_archive_missing:${item.id}`);
  const workspaceContainerRoot = resolveCanonicalAppStoreRoot(item.appId);
  const previousMount = findMountedStoreApp(item, settings);
  const previousAppRoot = previousMount?.path?.trim() ? resolve(previousMount.path) : legacyStoreAppRootForUpdate(item);
  const previousAppEntry = previousAppRoot ? readPathEntry(previousAppRoot) : undefined;
  if (options.requireMissingRoot && previousAppEntry) throw new Error("app_store_install_target_changed");
  if (previousAppEntry && (!previousAppEntry.isDirectory() || previousAppEntry.isSymbolicLink())) {
    throw new Error("app_store_install_target_changed");
  }
  if (
    !options.requireMissingRoot &&
    previousAppRoot &&
    previousAppEntry &&
    packageMarkerMatches(join(previousAppRoot, ".opengrove-store-package.json"), item)
  ) {
    return {
      appRoot: previousAppRoot,
      workspaceRoot: mountedStoreWorkspaceRoot(previousMount, previousAppRoot, workspaceContainerRoot),
      workspaceContainerRoot,
      workspaceContainerCreated: false,
      createdFresh: false,
      packageChanged: false,
    };
  }
  mkdirSync(storeRoot, { recursive: true });
  const stagingParent = join(storeRoot, "staging");
  mkdirSync(stagingParent, { recursive: true });
  const tempRoot = mkdtempSync(join(stagingParent, `${appStoreInstallKey(workspaceContainerRoot)}-`));
  try {
    const unpackRoot = join(tempRoot, "unpacked");
    mkdirSync(unpackRoot, { recursive: true });
    const unpack = unpackAppStoreArchive(archivePath, unpackRoot);
    if (!unpack.ok) throw new Error(unpack.error);
    validateAppStoreExtractedTree(unpackRoot);
    const sourceRoot = findAppStoreArchiveRoot(unpackRoot, "app");
    if (!sourceRoot) throw new Error("app_store_package_manifest_required");
    const manifestMigration = migrateMountedAppManifestV1(sourceRoot);
    if (
      manifestMigration.status !== "current" &&
      manifestMigration.status !== "requires-legacy-boundary" &&
      manifestMigration.status !== "migrated"
    ) {
      throw new Error(`app_store_package_manifest_${manifestMigration.status}`);
    }
    const sourceManifest = requireAppManifest(sourceRoot, "app_store_package_manifest_invalid");
    const employeeDefaultIssues = validateAppStoreEmployeeDefaults(recordValue(sourceManifest.store).employeeDefaults);
    if (employeeDefaultIssues.length) {
      throw new Error(`app_store_manifest_invalid:${employeeDefaultIssues.join("|")}`);
    }
    const nextWorkspaceRelativePath = preservableWorkspaceRelativePath(sourceRoot, sourceManifest);
    if (!nextWorkspaceRelativePath) throw new Error("app_store_update_not_safe");
    const workspaceRoot = resolveStoreWorkspaceRoot({
      previousMount,
      previousAppRoot: previousAppEntry ? previousAppRoot : undefined,
      workspaceContainerRoot,
      nextWorkspaceRelativePath,
    });
    const workspaceContainerCreated = !readPathEntry(workspaceContainerRoot);
    const preservedWorkspace = readPreservedWorkspaceForInstall(workspaceContainerRoot, item);
    let restoredPreservedWorkspace = false;
    if (preservedWorkspace && !readPathEntry(workspaceRoot)) {
      mkdirSync(dirname(workspaceRoot), { recursive: true });
      cpSync(preservedWorkspace.workspaceRoot, workspaceRoot, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      restoredPreservedWorkspace = true;
    }
    let appRoot: string;
    try {
      appRoot = installSideBySideAppProgram({
        sourceRoot,
        item,
        storeRoot,
        workspaceContainerRoot,
        workspaceRoot,
        nextWorkspaceRelativePath,
        ...(previousAppEntry && previousAppRoot ? { previousAppRoot } : {}),
      });
    } catch (error) {
      // Until activation succeeds, the preserved backup remains authoritative.
      // Roll back only the Workspace copy restored by this attempt, never the
      // shared container or unrelated data that may already live there.
      if (restoredPreservedWorkspace) {
        rmSync(workspaceRoot, { recursive: true, force: true });
        if (workspaceContainerCreated) {
          removeEmptyParents(workspaceContainerRoot, dirname(workspaceRoot));
        }
      }
      throw error;
    }
    const updateInstall =
      previousAppEntry && previousAppRoot
        ? {
            packageId: item.id,
            appRoot,
            previousAppRoot,
            workspaceRoot,
            programsRoot: currentAppStoreProgramsRoot(storeRoot),
          }
        : undefined;
    return {
      appRoot,
      workspaceRoot,
      workspaceContainerRoot,
      workspaceContainerCreated,
      createdFresh: !previousAppEntry,
      packageChanged: true,
      ...(restoredPreservedWorkspace && preservedWorkspace
        ? { workspaceBackupRoot: preservedWorkspace.containerRoot }
        : {}),
      ...(updateInstall ? { updateInstall } : {}),
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function rollbackFreshImportedPackageInstall(
  item: AppStorePackageRecord,
  install: Pick<
    FreshAppStorePackageInstall,
    "appRoot" | "workspaceRoot" | "workspaceContainerRoot" | "workspaceContainerCreated"
  >,
  storeRoot?: string,
): boolean {
  const programsRoot = storeRoot
    ? currentAppStoreProgramsRoot(storeRoot)
    : dirname(dirname(dirname(resolve(install.appRoot))));
  if (!pathIsInside(programsRoot, install.appRoot)) {
    throw new Error("app_store_install_rollback_target_changed");
  }
  return withAppStoreInstallLock(install.workspaceContainerRoot, () => {
    if (!readPathEntry(install.appRoot)) return false;
    if (!packageMarkerMatches(join(install.appRoot, ".opengrove-store-package.json"), item)) {
      throw new Error("app_store_install_rollback_target_changed");
    }
    removeProgramGeneration(install.appRoot, programsRoot);
    if (
      install.workspaceContainerCreated &&
      resolve(install.workspaceRoot) !== resolve(install.workspaceContainerRoot) &&
      directoryIsEmpty(install.workspaceRoot)
    ) {
      rmSync(install.workspaceRoot, { recursive: true, force: true });
      removeEmptyParents(install.workspaceContainerRoot, dirname(install.workspaceRoot));
    }
    return true;
  });
}

function appStoreInstallLockPath(appRoot: string): string {
  return join(dirname(appRoot), ".opengrove-install-locks", appStoreInstallKey(appRoot));
}

function appStoreInstallKey(appRoot: string): string {
  return createHash("sha256").update(resolve(appRoot)).digest("hex");
}

export function withAppStoreInstallLock<T>(appRoot: string, run: () => T): T {
  const targetLock = appStoreInstallLockPath(appRoot);
  mkdirSync(dirname(targetLock), { recursive: true });
  try {
    mkdirSync(targetLock);
  } catch (error) {
    if (isPathAlreadyExistsError(error)) throw new Error("app_store_install_target_changed");
    throw error;
  }
  try {
    return run();
  } finally {
    try {
      rmdirSync(targetLock);
    } catch {
      // non-critical-fallback: Keep a non-empty or externally replaced lock instead of deleting unknown data.
    }
  }
}

function findAppStorePackage(packageId: string, storeRoot?: string): AppStorePackageRecord | undefined {
  const requested = packageId.trim();
  if (!requested) return undefined;
  const requestedPackageKey = normalizeAppStorePackageKey(requested);
  return readImportedRegistryPackages(storeRoot).find(
    (candidate) =>
      candidate.id === requested ||
      Boolean(requestedPackageKey && candidate.packageKey === requestedPackageKey) ||
      candidate.packageId === requested,
  );
}

export function defaultAppStoreRoot(): string {
  return resolve(
    readAppEnv("WORKSPACES_DIR") ||
      readAppEnv("APP_STORE_APPS_DIR") ||
      readAppEnv("APP_STORE_APPS_ROOT") ||
      defaultOpenGroveWorkspacesDir(),
  );
}

function requireAppManifest(appRoot: string, errorCode: string): JsonObject {
  const result = readMountedAppManifest(appRoot);
  if (!result.manifest) {
    console.warn("app_store_manifest_requirement_failed", {
      appRoot,
      errorCode,
      manifestStatus: result.status,
      issues: result.issues,
    });
    throw new Error(errorCode);
  }
  return result.manifest;
}

function appManifestIdForCleanup(appRoot: string): string | undefined {
  const validated = readMountedAppManifest(appRoot).manifest;
  if (validated) return stringOrUndefined(validated.id);
  const manifestPath = strictAppManifestPath(appRoot);
  return manifestPath ? stringOrUndefined(parseJsonLikeConfig(manifestPath, "jsonc")?.id) : undefined;
}

function readPathEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isPathAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function installSideBySideAppProgram(input: {
  sourceRoot: string;
  item: AppStorePackageRecord;
  storeRoot: string;
  workspaceContainerRoot: string;
  workspaceRoot: string;
  nextWorkspaceRelativePath: string;
  previousAppRoot?: string;
  adoptTargetSnapshot?: AppStorePublishTargetSnapshot;
}): string {
  const programsRoot = currentAppStoreProgramsRoot(input.storeRoot);
  const appProgramsRoot = join(programsRoot, appStoreAppDirectoryName(input.item.appId));
  mkdirSync(appProgramsRoot, { recursive: true });
  const versionPart = normalizeAppId(input.item.version).slice(0, 32) || "version";
  const archivePart = normalizeArchiveSha256(input.item.archiveSha256)?.slice(0, 12) || randomUUID().slice(0, 12);
  const generationRoot = mkdtempSync(join(appProgramsRoot, `${versionPart}-${archivePart}-`));
  const nextAppRoot = join(generationRoot, "app");
  const stagedAppRoot = join(dirname(input.sourceRoot), `staged-program-${randomUUID()}`);
  let activated = false;
  try {
    copyAppStoreExtractedTree(input.sourceRoot, stagedAppRoot);
    writeFileSync(
      join(stagedAppRoot, ".opengrove-store-package.json"),
      `${JSON.stringify(packageInstallMarker(input.item), null, 2)}\n`,
      "utf8",
    );
    assertStagedAppTreeReady(stagedAppRoot, input.item, input.nextWorkspaceRelativePath);
    bindProgramWorkspace(stagedAppRoot, input.nextWorkspaceRelativePath, input.workspaceRoot);
    withAppStoreInstallLock(input.workspaceContainerRoot, () => {
      if (input.previousAppRoot) {
        if (input.adoptTargetSnapshot) {
          assertAppStorePublishTargetUnchanged(input.previousAppRoot, input.item, input.adoptTargetSnapshot);
        } else {
          assertAppStoreUpdateTargetUnchanged(input.previousAppRoot, input.item);
        }
      }
      const workspaceEntry = readPathEntry(input.workspaceRoot);
      if (workspaceEntry && (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink())) {
        throw new Error("app_store_update_not_safe");
      }
      // Preserve the local repository only after the active target and
      // Workspace binding have passed their final serialized validation.
      copyPreviousProgramGit(input.previousAppRoot, stagedAppRoot);
      mkdirSync(input.workspaceRoot, { recursive: true });
      const createdWorkspaceEntry = readPathEntry(input.workspaceRoot);
      if (!createdWorkspaceEntry?.isDirectory() || createdWorkspaceEntry.isSymbolicLink()) {
        throw new Error("app_store_update_not_safe");
      }
      renameSync(stagedAppRoot, nextAppRoot);
      activated = true;
    });
    return nextAppRoot;
  } finally {
    if (!activated) {
      rmSync(stagedAppRoot, { recursive: true, force: true });
      rmSync(generationRoot, { recursive: true, force: true });
    }
  }
}

function copyPreviousProgramGit(previousAppRoot: string | undefined, stagedAppRoot: string): void {
  if (!previousAppRoot) return;
  const previousGitRoot = join(previousAppRoot, ".git");
  const previousGitEntry = readPathEntry(previousGitRoot);
  if (!previousGitEntry) return;
  if (
    (!previousGitEntry.isDirectory() && !previousGitEntry.isFile()) ||
    previousGitEntry.isSymbolicLink() ||
    readPathEntry(join(stagedAppRoot, ".git"))
  ) {
    throw new Error("app_store_update_git_invalid");
  }
  cpSync(previousGitRoot, join(stagedAppRoot, ".git"), {
    recursive: previousGitEntry.isDirectory(),
    errorOnExist: true,
    force: false,
  });
}

function bindProgramWorkspace(appRoot: string, workspaceRelativePath: string, workspaceRoot: string): void {
  const linkedWorkspaceRoot = resolve(appRoot, workspaceRelativePath);
  rmSync(linkedWorkspaceRoot, { recursive: true, force: true });
  mkdirSync(dirname(linkedWorkspaceRoot), { recursive: true });
  symlinkSync(resolve(workspaceRoot), linkedWorkspaceRoot, process.platform === "win32" ? "junction" : "dir");
}

function findMountedStoreApp(
  item: AppStorePackageRecord,
  settings: Pick<BridgeSettings, "mountedApps">,
): BridgeMountedAppSettings | undefined {
  const index = findMountedStoreAppIndex(item, settings);
  return index >= 0 ? settings.mountedApps[index] : undefined;
}

function findMountedStoreAppIndex(item: AppStorePackageRecord, settings: Pick<BridgeSettings, "mountedApps">): number {
  const packageKey = normalizeAppStorePackageKey(item.packageKey);
  return settings.mountedApps.findIndex((mountedApp) => {
    if (mountedApp.id === item.appId) return true;
    const marker = mountedApp.path ? readAppStorePackageInstallMarker(mountedApp.path) : undefined;
    if (stringOrUndefined(marker?.appId) === item.appId) return true;
    if (packageKey && normalizeAppStorePackageKey(marker?.packageKey) === packageKey) return true;
    return appManifestIdForCleanup(mountedApp.path) === item.appId;
  });
}

function legacyStoreAppRootForUpdate(item: AppStorePackageRecord): string | undefined {
  const appRoot = resolveCanonicalAppStoreRoot(item.appId);
  const entry = readPathEntry(appRoot);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) return undefined;
  return packageMarkerProvenanceMatches(join(appRoot, ".opengrove-store-package.json"), item) ? appRoot : undefined;
}

function mountedStoreWorkspaceRoot(
  mountedApp: BridgeMountedAppSettings | undefined,
  appRoot: string,
  workspaceContainerRoot: string,
): string {
  if (mountedApp?.workspacePath?.trim()) return resolve(mountedApp.workspacePath);
  const manifest = readMountedAppManifest(appRoot).manifest;
  const relativePath = manifest ? preservableWorkspaceRelativePath(appRoot, manifest) : undefined;
  return relativePath ? resolve(appRoot, relativePath) : join(workspaceContainerRoot, "workspace");
}

function resolveStoreWorkspaceRoot(input: {
  previousMount?: BridgeMountedAppSettings;
  previousAppRoot?: string;
  workspaceContainerRoot: string;
  nextWorkspaceRelativePath: string;
}): string {
  if (input.previousMount?.workspacePath?.trim()) {
    return resolve(input.previousMount.workspacePath);
  }
  if (input.previousAppRoot) {
    const previousManifest = requireAppManifest(input.previousAppRoot, "app_store_update_not_safe");
    const previousRelativePath = preservableWorkspaceRelativePath(input.previousAppRoot, previousManifest);
    if (!previousRelativePath) throw new Error("app_store_update_not_safe");
    return resolve(input.previousAppRoot, previousRelativePath);
  }
  return resolve(input.workspaceContainerRoot, input.nextWorkspaceRelativePath);
}

function pathIsInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return Boolean(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
  );
}

function removeProgramGeneration(appRoot: string, programsRoot: string): void {
  if (!pathIsInside(programsRoot, appRoot) || basename(appRoot) !== "app") {
    throw new Error("app_store_install_rollback_target_changed");
  }
  rmSync(dirname(appRoot), { recursive: true, force: true });
}

function markProgramGenerationForCleanup(appRoot: string, programsRoot: string): void {
  if (!pathIsInside(programsRoot, appRoot) || basename(appRoot) !== "app") {
    throw new Error("app_store_install_rollback_target_changed");
  }
  writeFileSync(
    join(dirname(appRoot), ".opengrove-cleanup-pending"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "program-generation-cleanup",
      appRoot: resolve(appRoot),
      createdAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
}

function removeProgramGenerationWithCleanupMarker(appRoot: string, programsRoot: string): void {
  markProgramGenerationForCleanup(appRoot, programsRoot);
  try {
    removeProgramGeneration(appRoot, programsRoot);
  } catch (error) {
    if (readPathEntry(dirname(appRoot))?.isDirectory()) {
      try {
        // Recursive removal can delete the marker before encountering a locked
        // child. Restore the cleanup authority for the next maintenance pass.
        markProgramGenerationForCleanup(appRoot, programsRoot);
      } catch (markerError) {
        throw new AggregateError([error, markerError], "app_store_program_cleanup_marker_restore_failed");
      }
    }
    throw error;
  }
}

function programCleanupMarkerMatches(markerPath: string, appRoot: string): boolean {
  try {
    const marker = recordValue(JSON.parse(readFileSync(markerPath, "utf8")));
    const createdAt = stringOrUndefined(marker.createdAt);
    const markedAppRoot = stringOrUndefined(marker.appRoot);
    if (
      marker.schemaVersion !== 1 ||
      marker.kind !== "program-generation-cleanup" ||
      !markedAppRoot ||
      !createdAt ||
      !Number.isFinite(Date.parse(createdAt))
    )
      return false;
    return resolve(realpathSync.native(markedAppRoot)) === resolve(realpathSync.native(appRoot));
  } catch {
    // non-critical-fallback: invalid marker contents never authorize cleanup.
    return false;
  }
}

function directoryIsEmpty(path: string): boolean {
  try {
    return readPathEntry(path)?.isDirectory() === true && readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function removeEmptyParents(stopRoot: string, start: string): void {
  let current = resolve(start);
  const stop = resolve(stopRoot);
  while ((current === stop || pathIsInside(stop, current)) && directoryIsEmpty(current)) {
    try {
      rmdirSync(current);
    } catch {
      // non-critical-fallback: a concurrent writer made the optional parent cleanup unnecessary.
      return;
    }
    if (current === stop) break;
    current = dirname(current);
  }
}

export function preservableWorkspaceRelativePath(appRoot: string, manifest: JsonObject): string | undefined {
  const workspaceSetting =
    stringOrUndefined(recordValue(manifest.ui).workspace) ||
    stringOrUndefined(recordValue(manifest.workspace).path) ||
    "workspace";
  const workspaceRoot = resolveInside(appRoot, workspaceSetting);
  if (!workspaceRoot) return undefined;
  const relativePath = relative(resolve(appRoot), workspaceRoot);
  if (!relativePath || relativePath === "." || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    return undefined;
  }
  if (workspacePathConflictsWithAppFiles(relativePath)) return undefined;
  if (!workspacePathComponentsAreSafe(appRoot, relativePath)) return undefined;
  return relativePath;
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
  const segments = relativePath.split(sep).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    const entry = readPathEntry(current);
    if (!entry) return true;
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
  }
  return true;
}

function assertAppStoreUpdateTargetUnchanged(appRoot: string, item: AppStorePackageRecord): void {
  const rootEntry = readPathEntry(appRoot);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error("app_store_install_target_changed");
  }
  if (!packageMarkerProvenanceMatches(join(appRoot, ".opengrove-store-package.json"), item)) {
    throw new Error("app_store_install_target_changed");
  }
  const manifestPath = strictAppManifestPath(appRoot);
  if (!manifestPath || !readPathEntry(manifestPath)?.isFile()) {
    throw new Error("app_store_install_target_changed");
  }
  const manifest = requireAppManifest(appRoot, "app_store_install_target_changed");
  if (stringOrUndefined(manifest.id) !== item.appId) {
    throw new Error("app_store_install_target_changed");
  }
  const manifestPackageKey = normalizeAppStorePackageKey(recordValue(manifest.store).packageKey);
  if (manifestPackageKey && manifestPackageKey !== normalizeAppStorePackageKey(item.packageKey)) {
    throw new Error("app_store_install_target_changed");
  }
}

function assertStagedAppTreeReady(
  stagedAppRoot: string,
  item: AppStorePackageRecord,
  expectedWorkspaceRelativePath: string,
): void {
  const rootEntry = readPathEntry(stagedAppRoot);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) throw new Error("app_store_update_not_safe");
  const manifestPath = strictAppManifestPath(stagedAppRoot);
  if (!manifestPath || !readPathEntry(manifestPath)?.isFile()) throw new Error("app_store_update_not_safe");
  const manifest = requireAppManifest(stagedAppRoot, "app_store_update_not_safe");
  if (stringOrUndefined(manifest.id) !== item.appId) throw new Error("app_store_update_not_safe");
  const manifestPackageKey = normalizeAppStorePackageKey(recordValue(manifest.store).packageKey);
  if (manifestPackageKey && manifestPackageKey !== normalizeAppStorePackageKey(item.packageKey))
    throw new Error("app_store_update_not_safe");
  const markerPath = join(stagedAppRoot, ".opengrove-store-package.json");
  if (!readPathEntry(markerPath)?.isFile() || !packageMarkerMatches(markerPath, item)) {
    throw new Error("app_store_update_not_safe");
  }
  const workspaceRelativePath = preservableWorkspaceRelativePath(stagedAppRoot, manifest);
  if (workspaceRelativePath !== expectedWorkspaceRelativePath) throw new Error("app_store_update_not_safe");
}

function strictAppManifestPath(appRoot: string): string | undefined {
  for (const fileName of ["opengrove.app.json", "opengrove.app.jsonc"]) {
    const path = join(appRoot, fileName);
    const entry = readPathEntry(path);
    if (!entry) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) return undefined;
    return path;
  }
  return undefined;
}

function readEmployeePackManifest(root: string): EmployeePackManifest {
  const path = join(root, "employee.json");
  if (!existsSync(path)) throw new Error("employee_pack_manifest_required");
  const result = validateEmployeePackManifestText(readFileSync(path, "utf8"));
  if (!result.ok || !result.manifest) {
    throw new Error(`employee_pack_manifest_invalid:${result.issues.join(";")}`);
  }
  return result.manifest;
}

function appStoreAgentSummaryFromEmployeeManifest(
  manifest: EmployeePackManifest,
  dependencies: AppStoreEmployeeDependencies,
): AppStoreAgentSummary {
  const skills = uniqueStringArray([
    ...stringArray(manifest.employee.availableSkillIds),
    ...stringArray(manifest.employee.defaultSkillIds),
    ...stringArray(manifest.employee.skills),
  ]);
  const tools = dependencies.tools ?? [];
  return {
    id: manifest.employee.id,
    name: manifest.employee.name,
    avatarMode: manifest.employee.avatarMode,
    avatarSeed: stringOrUndefined(manifest.employee.avatarSeed),
    avatarDataUrl: stringOrUndefined(manifest.employee.avatarDataUrl),
    role: stringOrUndefined(manifest.employee.role) ?? stringOrUndefined(manifest.employee.description),
    kernel: stringOrUndefined(manifest.employee.kernel),
    model: stringOrUndefined(manifest.employee.model),
    reasoningEffort: normalizeReasoningEffort(manifest.employee.reasoningEffort),
    contextTokenBudget: positiveInteger(manifest.employee.contextTokenBudget),
    skills,
    toolIds: tools.map((tool) => tool.id),
    tools,
    visibility: normalizeVisibility(manifest.employee.visibility),
    publicDescription: stringOrUndefined(manifest.employee.publicDescription),
    publicSkills: stringArray(manifest.employee.publicSkills),
    inputSpec: stringOrUndefined(manifest.employee.inputSpec),
    outputSpec: stringOrUndefined(manifest.employee.outputSpec),
  };
}

function appStoreEmployeeDependenciesFromManifest(manifest: EmployeePackManifest): AppStoreEmployeeDependencies {
  const dependencies = recordValue(manifest.dependencies);
  const tools = recordArray(dependencies.tools)
    .map((tool) => ({
      id: stringOrUndefined(tool.id) || "",
      title: stringOrUndefined(tool.title),
      description: stringOrUndefined(tool.description),
      source: stringOrUndefined(tool.source),
    }))
    .filter((tool) => Boolean(tool.id)) as AppStoreToolSummary[];
  return {
    kernels: stringArray(dependencies.kernels),
    providers: stringArray(dependencies.providers),
    runtimes: stringArray(dependencies.runtimes),
    skills: recordArray(dependencies.skills)
      .map((skill) => ({
        id: stringOrUndefined(skill.id) || "",
        name: stringOrUndefined(skill.name),
        title: stringOrUndefined(skill.title),
        description: stringOrUndefined(skill.description),
        source: stringOrUndefined(skill.source),
        bundled: skill.bundled === true,
        path: stringOrUndefined(skill.path),
        toolIds: stringArray(skill.toolIds),
        allowedTools: stringArray(skill.allowedTools),
      }))
      .filter((skill) => Boolean(skill.id)) as AppStoreSkillSummary[],
    tools,
    cli: Array.isArray(dependencies.cli) ? dependencies.cli : [],
    mcp: Array.isArray(dependencies.mcp) ? dependencies.mcp : [],
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeVisibility(value: unknown): "private" | "public" | undefined {
  return value === "public" || value === "private" ? value : undefined;
}

function normalizeReasoningEffort(value: unknown): RoomChannelMember["reasoningEffort"] {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

function normalizeEmployeeAccessMode(value: unknown): RoomChannelMember["accessMode"] {
  return value === "default" || value === "auto-review" || value === "full-access" ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizeAppStoreInstallMode(value: unknown): AppStoreInstallMode | undefined {
  if (value === "workspace") return "workspace";
  if (value === "contacts") return "contacts";
  return undefined;
}

function normalizeAppStoreAgentSummary(value: unknown): AppStoreAgentSummary | undefined {
  const item = recordValue(value);
  const id = stringOrUndefined(item.id);
  const name = stringOrUndefined(item.name);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    avatarMode:
      item.avatarMode === "generated" || item.avatarMode === "initials" || item.avatarMode === "upload"
        ? item.avatarMode
        : undefined,
    avatarSeed: stringOrUndefined(item.avatarSeed),
    avatarDataUrl: stringOrUndefined(item.avatarDataUrl),
    role: stringOrUndefined(item.role),
    kernel: stringOrUndefined(item.kernel),
    model: stringOrUndefined(item.model),
    reasoningEffort: normalizeReasoningEffort(item.reasoningEffort),
    contextTokenBudget: positiveInteger(item.contextTokenBudget),
    skills: stringArray(item.skills),
    toolIds: stringArray(item.toolIds),
    tools: recordArray(item.tools)
      .map((tool) => ({
        id: stringOrUndefined(tool.id) || "",
        title: stringOrUndefined(tool.title),
        description: stringOrUndefined(tool.description),
        source: stringOrUndefined(tool.source),
      }))
      .filter((tool) => Boolean(tool.id)) as AppStoreToolSummary[],
    visibility: normalizeVisibility(item.visibility),
    publicDescription: stringOrUndefined(item.publicDescription),
    publicSkills: stringArray(item.publicSkills),
    inputSpec: stringOrUndefined(item.inputSpec),
    outputSpec: stringOrUndefined(item.outputSpec),
  };
}

function normalizeEmployeeDependencies(value: unknown): AppStoreEmployeeDependencies | undefined {
  const input = recordValue(value);
  if (!Object.keys(input).length) return undefined;
  return {
    kernels: stringArray(input.kernels),
    providers: stringArray(input.providers),
    runtimes: stringArray(input.runtimes),
    skills: recordArray(input.skills)
      .map((skill) => ({
        id: stringOrUndefined(skill.id) || "",
        name: stringOrUndefined(skill.name),
        title: stringOrUndefined(skill.title),
        description: stringOrUndefined(skill.description),
        source: stringOrUndefined(skill.source),
        bundled: skill.bundled === true,
        path: stringOrUndefined(skill.path),
        toolIds: stringArray(skill.toolIds),
        allowedTools: stringArray(skill.allowedTools),
      }))
      .filter((skill) => Boolean(skill.id)) as AppStoreSkillSummary[],
    tools: recordArray(input.tools)
      .map((tool) => ({
        id: stringOrUndefined(tool.id) || "",
        title: stringOrUndefined(tool.title),
        description: stringOrUndefined(tool.description),
        source: stringOrUndefined(tool.source),
      }))
      .filter((tool) => Boolean(tool.id)) as AppStoreToolSummary[],
    cli: Array.isArray(input.cli) ? input.cli : [],
    mcp: Array.isArray(input.mcp) ? input.mcp : [],
  };
}

function normalizeEmployeeDoctor(value: unknown): AppStoreEmployeeDoctor | undefined {
  const input = recordValue(value);
  const items = recordArray(input.items)
    .map((item) => ({
      id: stringOrUndefined(item.id) || "",
      kind: readDoctorKind(item.kind),
      label: stringOrUndefined(item.label) || stringOrUndefined(item.id) || "dependency",
      status: readDoctorStatus(item.status),
      detail: stringOrUndefined(item.detail),
    }))
    .filter((item) => Boolean(item.id)) as AppStoreEmployeeDoctorItem[];
  if (!items.length && !Array.isArray(input.missing) && !Array.isArray(input.warnings)) return undefined;
  const missing = stringArray(input.missing);
  return {
    ok: input.ok === true || missing.length === 0,
    items,
    missing,
    warnings: stringArray(input.warnings),
  };
}

function readDoctorKind(value: unknown): AppStoreEmployeeDoctorItem["kind"] {
  return value === "kernel" ||
    value === "skill" ||
    value === "tool" ||
    value === "provider" ||
    value === "runtime" ||
    value === "cli" ||
    value === "mcp"
    ? value
    : "runtime";
}

function readDoctorStatus(value: unknown): AppStoreEmployeeDoctorItem["status"] {
  return value === "ok" || value === "missing" || value === "installable" || value === "warning" ? value : "warning";
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map((item) => recordValue(item)).filter((item) => Object.keys(item).length > 0)
    : [];
}

// The local catalog under <data>/app-store/catalog.json is an install cache for
// packages imported from the configured registry; it is not a store shelf of its own.
function readImportedRegistryPackages(storeRoot?: string): AppStorePackageRecord[] {
  if (!storeRoot) return [];
  const path = importedCatalogPath(storeRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown };
    return Array.isArray(parsed.packages)
      ? parsed.packages.map(normalizeImportedPackage).filter((item): item is AppStorePackageRecord => Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function readImportedRegistryPackagesForCleanup(storeRoot: string): AppStorePackageRecord[] | undefined {
  const path = importedCatalogPath(storeRoot);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown };
    if (!Array.isArray(parsed.packages)) return undefined;
    const packages = parsed.packages.map(normalizeImportedPackage);
    return packages.every((item): item is AppStorePackageRecord => Boolean(item)) ? packages : undefined;
  } catch {
    return undefined;
  }
}

function writeImportedRegistryPackages(storeRoot: string, packages: AppStorePackageRecord[]): void {
  mkdirSync(storeRoot, { recursive: true });
  writeFileSync(importedCatalogPath(storeRoot), `${JSON.stringify({ packages }, null, 2)}\n`, "utf8");
}

function importedCatalogPath(storeRoot: string): string {
  return join(storeRoot, "catalog.json");
}

function normalizeImportedPackage(value: unknown): AppStorePackageRecord | undefined {
  const item = recordValue(value);
  if (item.source !== "registry") return undefined;
  const packageKey = normalizeAppStorePackageKey(item.packageKey);
  const packageId = stringOrUndefined(item.packageId);
  const id = stringOrUndefined(item.id) || packageKey || packageId;
  const publishKind = item.publishKind === "employee" ? "employee" : "app";
  const appId = stringOrUndefined(item.appId) || packageId || (publishKind === "employee" ? id : undefined);
  if (!id || !appId || !isValidAppStoreAppId(id) || !isValidAppStoreAppId(appId)) return undefined;
  const dependencies = normalizeEmployeeDependencies(item.dependencies);
  const agents = Array.isArray(item.agents)
    ? item.agents.map(normalizeAppStoreAgentSummary).filter((agent): agent is AppStoreAgentSummary => Boolean(agent))
    : undefined;
  const employee = normalizeAppStoreAgentSummary(item.employee) ?? agents?.[0];
  const minHostReleaseNumber = numberValue(item.minHostReleaseNumber);
  return {
    id,
    packageId,
    title: stringOrUndefined(item.title) || id,
    summary: stringOrUndefined(item.summary) || (publishKind === "employee" ? "OpenGrove Employee" : "OpenGrove App"),
    version: stringOrUndefined(item.version) || "0.1.0",
    ...(Number.isInteger(minHostReleaseNumber) && minHostReleaseNumber > 0 ? { minHostReleaseNumber } : {}),
    category: stringOrUndefined(item.category) || "user-upload",
    icon: stringOrUndefined(item.icon),
    publishKind,
    installMode: normalizeAppStoreInstallMode(item.installMode) ?? "workspace",
    packageUrl: stringOrUndefined(item.packageUrl),
    appId,
    workspaceName: stringOrUndefined(item.workspaceName) || `${appId} Workspace`,
    requirements: stringArray(item.requirements),
    capabilities: stringArray(item.capabilities),
    agents,
    employee,
    dependencies,
    doctor: normalizeEmployeeDoctor(item.doctor),
    backupScopes: stringArray(item.backupScopes),
    status: item.status === "preview" ? "preview" : "available",
    publisher: stringOrUndefined(item.publisher) || "OpenGrove User",
    usageCount: numberValue(item.usageCount),
    source: "registry",
    packageKey,
    packageRef: stringOrUndefined(item.packageRef),
    uploadedAt: stringOrUndefined(item.uploadedAt),
    archiveName: stringOrUndefined(item.archiveName),
    archiveSize: numberValue(item.archiveSize),
    archiveSha256: normalizeArchiveSha256(item.archiveSha256),
    releaseCommitSha: /^[a-f0-9]{40}$/.test(stringOrUndefined(item.releaseCommitSha) ?? "")
      ? stringOrUndefined(item.releaseCommitSha)
      : undefined,
    archiveFile: stringOrUndefined(item.archiveFile),
    ...(appStorePackageRequiresHostUpdate(minHostReleaseNumber) ? { hostUpdateRequired: true } : {}),
  };
}

export function extractAppStoreAppArchive(input: { archivePath: string; targetRoot: string }): void {
  if (readPathEntry(input.targetRoot)) throw new Error("app_store_install_target_changed");
  mkdirSync(dirname(input.targetRoot), { recursive: true });
  const extractionRoot = mkdtempSync(join(dirname(input.targetRoot), ".opengrove-app-archive-"));
  try {
    const unpacked = unpackAppStoreArchive(input.archivePath, extractionRoot);
    if (!unpacked.ok) throw new Error(unpacked.error);
    validateAppStoreExtractedTree(extractionRoot);
    const sourceRoot = findAppStoreArchiveRoot(extractionRoot, "app");
    if (!sourceRoot) throw new Error("app_store_archive_manifest_missing");
    copyAppStoreExtractedTree(sourceRoot, input.targetRoot);
  } catch (error) {
    rmSync(input.targetRoot, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function packageMarkerMatches(path: string, item: AppStorePackageRecord): boolean {
  if (!packageMarkerProvenanceMatches(path, item)) return false;
  try {
    const marker = recordValue(JSON.parse(readFileSync(path, "utf8")));
    const markerSha256 = normalizeArchiveSha256(marker.archiveSha256);
    const itemSha256 = normalizeArchiveSha256(item.archiveSha256);
    return Boolean(markerSha256 && itemSha256 && markerSha256 === itemSha256);
  } catch {
    return false;
  }
}

function packageMarkerProvenanceMatches(path: string, item: AppStorePackageRecord): boolean {
  if (!existsSync(path)) return false;
  try {
    const marker = recordValue(JSON.parse(readFileSync(path, "utf8")));
    if (stringOrUndefined(marker.source) !== "registry" || stringOrUndefined(marker.appId) !== item.appId) return false;
    if (item.packageKey) {
      return appStorePackageSourceIdentity(marker) === appStorePackageSourceIdentity(item);
    }
    return stringOrUndefined(marker.packageId) === (item.packageId ?? item.id);
  } catch {
    return false;
  }
}

function packageInstallMarker(
  item: AppStorePackageRecord,
  options: { installedAt?: string; includeArchiveEvidence?: boolean } = {},
): Record<string, unknown> {
  const packageKey = normalizeAppStorePackageKey(item.packageKey);
  const archiveSha256 = normalizeArchiveSha256(item.archiveSha256);
  const packageRef = item.packageRef || (packageKey ? `#${packageKey}` : "");
  const includeArchiveEvidence = options.includeArchiveEvidence !== false;
  return {
    schemaVersion: 1,
    source: "registry",
    registryUrl: appStoreRegistryUrlFromPackageRef(packageRef) ?? "",
    packageRef,
    packageKey,
    packageId: item.packageId ?? item.id,
    appId: item.appId,
    version: item.version,
    ...(includeArchiveEvidence && archiveSha256 ? { archiveSha256, fingerprint: archiveSha256 } : {}),
    ...(item.releaseCommitSha ? { releaseCommitSha: item.releaseCommitSha } : {}),
    installedAt: options.installedAt || new Date().toISOString(),
  };
}

function relativeArchiveFile(storeRoot: string, archivePath: string): string {
  return archivePath.slice(resolve(storeRoot).length + 1).replace(/\\/g, "/");
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function resolveInside(root: string, relativePath: string): string | undefined {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  return candidate === resolvedRoot ||
    candidate.startsWith(`${resolvedRoot}${/win32/.test(process.platform) ? "\\" : "/"}`)
    ? candidate
    : undefined;
}

function archiveExtension(fileName: string): ".zip" | ".tar" | ".tgz" | ".tar.gz" | string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".tar")) return ".tar";
  if (lower.endsWith(".zip")) return ".zip";
  return extname(lower);
}

function archiveContentType(path: string): string {
  const extension = archiveExtension(path);
  if (extension === ".zip") return "application/zip";
  if (extension === ".tar") return "application/x-tar";
  if (extension === ".tgz" || extension === ".tar.gz") return "application/gzip";
  return "application/octet-stream";
}

function safeFileName(value: string): string {
  return basename(value || "")
    .replace(/[^\w.\-() ]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAppId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function uniqueStringArray(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
