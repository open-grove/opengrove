import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { appStorePackageSourceIdentity, normalizeAppStorePackageKey } from "../app-store-package-identity.js";
import { restorePersistedAgentState, snapshotPersistedAgentState } from "../storage/json-state-store.js";
import { queueAppReadinessReport } from "./app-readiness.js";
import { compareVersions } from "./app-release.js";
import {
  type AppStoreInstallResult,
  type AppStorePackageRecord,
  appStoreDataRoot,
  commitUpdatedAppStorePackageInstall,
  defaultAppStoreRoot,
  type FreshAppStorePackageInstall,
  finalizeFreshAppStorePackageInstall,
  finalizeUpdatedAppStorePackageInstall,
  installAppStorePackage,
  installedAppStoreAppRefs,
  readAppStorePackageInstallMarker,
  rollbackFreshAppStorePackageInstall,
  rollbackUpdatedAppStorePackageInstall,
  type UpdatedAppStorePackageInstall,
} from "./app-store.js";
import { appStoreAppDirectoryName } from "./app-store-app-id.js";
import {
  type AppStoreRegistryConfig,
  importRegistryAppStorePackageForInstall,
  listRegistryAppStorePackages,
  type RegistryInstallPolicy,
  readRegistryInstallPolicy,
} from "./app-store-registry.js";
import { runBackgroundAppStoreTask } from "./background-app-store-task.js";
import { recreateBridgeApp, saveBridgeSettings } from "./bridge-state.js";
import type { BridgeMountedAppSettings, BridgeState } from "./bridge-types.js";
import { appStorePackageRequiresHostUpdate, readClientReleaseNumber } from "./client-release.js";
import { recordProblem } from "./problem-records.js";
import { isRetiredKnowledgeVaultPackage } from "./retired-apps.js";

export interface DefaultStoreAppsSyncResult {
  status: "completed" | "not_configured" | "deferred" | "failed";
  ok: boolean;
  installed: AppStoreInstallResult[];
  updated: AppStoreInstallResult[];
  skipped: Array<{ appId: string; packageKey: string; reason: string }>;
  errors: Array<{ appId: string; packageKey: string; error: string }>;
  clientReleaseNumber?: number;
  updateCheckRequired: boolean;
  policyKey?: string;
  assignmentSource?: string;
}

export interface DefaultStoreAppsScheduleResult {
  status: "scheduled" | "already_running" | "skipped";
  reason?: string;
}

const inFlightSyncs = new WeakMap<
  BridgeState,
  {
    userId: string;
    promise: Promise<DefaultStoreAppsSyncResult>;
  }
>();
const lastSyncCompletions = new WeakMap<BridgeState, Map<string, number>>();
const lastSyncDeferrals = new WeakMap<BridgeState, Map<string, number>>();
const lastSyncFailures = new WeakMap<BridgeState, Map<string, number>>();
const DEFAULT_STORE_APP_SYNC_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_STORE_APP_SYNC_DEFERRED_RETRY_COOLDOWN_MS = 30 * 1000;
const DEFAULT_STORE_APP_SYNC_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_STORE_APP_SYNC_PROBLEM_DEDUPE_MS = 10 * 60 * 1000;

export function scheduleDefaultStoreAppsInstalledAfterAuth(input: {
  state: BridgeState;
  request: IncomingMessage;
  installPolicyConfig?: AppStoreRegistryConfig;
  packageRegistryConfig?: AppStoreRegistryConfig;
  userId?: string;
  traceId?: string;
}): DefaultStoreAppsScheduleResult {
  if (!input.installPolicyConfig?.registryToken || !input.packageRegistryConfig?.registryToken) {
    return { status: "skipped", reason: "registry_token_required" };
  }
  const userId = input.userId?.trim() || "authenticated-user";
  const existing = inFlightSyncs.get(input.state);
  if (existing) {
    if (existing.userId !== userId) {
      existing.promise.finally(() => scheduleDefaultStoreAppsInstalledAfterAuth(input));
    }
    return { status: "already_running" };
  }
  const now = Date.now();
  const stateCompletions = lastSyncCompletions.get(input.state);
  const lastCompletion = stateCompletions?.get(userId) ?? 0;
  if (now - lastCompletion < DEFAULT_STORE_APP_SYNC_RETRY_COOLDOWN_MS) {
    return { status: "skipped", reason: "retry_cooldown" };
  }
  const lastDeferral = lastSyncDeferrals.get(input.state)?.get(userId) ?? 0;
  if (now - lastDeferral < DEFAULT_STORE_APP_SYNC_DEFERRED_RETRY_COOLDOWN_MS) {
    return { status: "skipped", reason: "deferred_retry_cooldown" };
  }
  const lastFailure = lastSyncFailures.get(input.state)?.get(userId) ?? 0;
  if (now - lastFailure < DEFAULT_STORE_APP_SYNC_RETRY_COOLDOWN_MS) {
    return { status: "skipped", reason: "failed_retry_cooldown" };
  }
  const promise = runBackgroundAppStoreTask(input.state, () => ensureDefaultStoreAppsInstalledAfterAuth(input))
    .then((result) => {
      for (const error of result.errors) {
        console.warn(`[default-store-apps] ${error.packageKey} (${error.appId}): ${error.error}`);
      }
      if (result.status === "completed" || result.status === "not_configured") {
        setLastSyncTime(lastSyncCompletions, input.state, userId);
        lastSyncDeferrals.get(input.state)?.delete(userId);
        lastSyncFailures.get(input.state)?.delete(userId);
      }
      if (result.status === "failed") {
        setLastSyncTime(lastSyncFailures, input.state, userId);
        lastSyncDeferrals.get(input.state)?.delete(userId);
        recordProblem(input.state, {
          traceId: input.traceId,
          category: "bridge",
          phase: "default-app-sync",
          code: "default_app_sync_failed",
          error: new Error(
            result.errors.map((item) => `${item.packageKey}:${item.error}`).join("; ") || "default_app_sync_failed",
          ),
          retryable: true,
          backgroundDedupe: {
            key: `default-app-sync:${userId}:${[...new Set(result.errors.map((item) => item.packageKey))].sort().join(",") || "unknown"}`,
            windowMs: DEFAULT_STORE_APP_SYNC_PROBLEM_DEDUPE_MS,
          },
        });
      } else if (result.status === "deferred") {
        setLastSyncTime(lastSyncDeferrals, input.state, userId);
        lastSyncFailures.get(input.state)?.delete(userId);
        console.warn(`[default-store-apps] optional install policy deferred for ${userId}`);
      }
      return result;
    })
    .catch((error) => {
      setLastSyncTime(lastSyncDeferrals, input.state, userId);
      lastSyncFailures.get(input.state)?.delete(userId);
      console.warn(
        `[default-store-apps] optional install policy deferred for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return emptySyncResult({
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      if (inFlightSyncs.get(input.state)?.promise === promise) {
        inFlightSyncs.delete(input.state);
      }
    });
  inFlightSyncs.set(input.state, { userId, promise });
  return { status: "scheduled" };
}

export async function ensureDefaultStoreAppsInstalledAfterAuth(input: {
  state: BridgeState;
  request: IncomingMessage;
  installPolicyConfig?: AppStoreRegistryConfig;
  packageRegistryConfig?: AppStoreRegistryConfig;
  clientReleaseNumber?: number | null;
  requestTimeoutMs?: number;
  activateBridgeApp?(state: BridgeState, authoritativeEmployeeConfigAppIds: ReadonlySet<string>): void;
  persistBridgeSettings?(state: BridgeState): void;
}): Promise<DefaultStoreAppsSyncResult> {
  const clientReleaseNumber =
    input.clientReleaseNumber === undefined ? readClientReleaseNumber() : input.clientReleaseNumber;
  const updateCheckRequired = Boolean(
    clientReleaseNumber &&
      input.state.settings.defaultAppSync.lastSuccessfulClientReleaseNumber !== clientReleaseNumber,
  );
  const result: DefaultStoreAppsSyncResult = {
    status: "completed",
    ok: true,
    installed: [],
    updated: [],
    skipped: [],
    errors: [],
    ...(clientReleaseNumber ? { clientReleaseNumber } : {}),
    updateCheckRequired,
  };
  if (!input.installPolicyConfig?.registryToken || !input.packageRegistryConfig?.registryToken) {
    return deferSync(result, "registry_token_required");
  }

  let installPolicy: RegistryInstallPolicy;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_STORE_APP_SYNC_REQUEST_TIMEOUT_MS;
  try {
    installPolicy = await readRegistryInstallPolicy(input.installPolicyConfig, input.request, {
      timeoutMs: requestTimeoutMs,
    });
  } catch (error) {
    return deferSync(result, error instanceof Error ? error.message : String(error));
  }
  for (const issue of installPolicy.entryIssues) {
    result.skipped.push({
      appId: issue.packageKey,
      packageKey: issue.packageKey,
      reason: issue.reason,
    });
  }
  if (installPolicy && installPolicy.apps.length === 0 && installPolicy.entryIssues.length > 0) {
    result.updateCheckRequired = false;
    if (installPolicy.policyKey) result.policyKey = installPolicy.policyKey;
    if (installPolicy.assignmentSource) result.assignmentSource = installPolicy.assignmentSource;
    return deferSync(result, "app_store_install_policy_no_valid_entries");
  }
  if (installPolicy.apps.length === 0) {
    result.status = "not_configured";
    result.updateCheckRequired = false;
    if (installPolicy.policyKey) result.policyKey = installPolicy.policyKey;
    if (installPolicy.assignmentSource) result.assignmentSource = installPolicy.assignmentSource;
    return result;
  }

  let catalog: AppStorePackageRecord[];
  try {
    catalog = await listRegistryAppStorePackages(input.packageRegistryConfig, input.request, {
      timeoutMs: requestTimeoutMs,
    });
  } catch (error) {
    return deferSync(result, error instanceof Error ? error.message : String(error));
  }
  if (installPolicy.policyKey) result.policyKey = installPolicy.policyKey;
  if (installPolicy.assignmentSource) result.assignmentSource = installPolicy.assignmentSource;

  const previousSettings = structuredClone(input.state.settings);
  const previousAgentState = snapshotPersistedAgentState(input.state.app, { compactVolatile: false });
  const managedPackageKeys = new Set(input.state.settings.defaultAppSync.managedPackageKeys);
  const freshInstalls: FreshAppStorePackageInstall[] = [];
  const updatedInstalls: UpdatedAppStorePackageInstall[] = [];
  const changedAppIds = new Set<string>();

  for (const policy of installPolicy.apps) {
    const item = catalog.find((candidate) => candidate.packageKey === policy.packageKey);
    if (!item || item.publishKind !== "app") {
      result.skipped.push({
        appId: policy.packageKey,
        packageKey: policy.packageKey,
        reason: "app_store_package_not_found",
      });
      continue;
    }
    const appId = item.appId || policy.packageKey;
    if (isRetiredKnowledgeVaultPackage(item)) {
      managedPackageKeys.delete(policy.packageKey);
      result.skipped.push({ appId, packageKey: policy.packageKey, reason: "app_retired" });
      continue;
    }
    if (defaultAppExplicitlyDisabled(input.state, item)) {
      managedPackageKeys.delete(policy.packageKey);
      result.skipped.push({ appId, packageKey: policy.packageKey, reason: "disabled_by_user" });
      continue;
    }
    const installedState = resolveInstalledDefaultApp(input.state, item, input.packageRegistryConfig.baseUrl);
    if (installedState.reason) {
      if (
        installedState.reason === "manual_mount" ||
        installedState.reason === "relink_required" ||
        installedState.reason === "source_conflict"
      ) {
        managedPackageKeys.delete(policy.packageKey);
      }
      result.skipped.push({ appId, packageKey: policy.packageKey, reason: installedState.reason });
      continue;
    }
    const installedRef = installedState.ref;
    if (installedRef && !managedPackageKeys.has(policy.packageKey)) {
      result.skipped.push({ appId, packageKey: policy.packageKey, reason: "installed_manually" });
      continue;
    }
    if (policy.minimumVersion && compareVersions(item.version, policy.minimumVersion) < 0) {
      result.skipped.push({
        appId,
        packageKey: policy.packageKey,
        reason: "default_app_minimum_version_unavailable",
      });
      continue;
    }
    if (
      appStorePackageRequiresHostUpdate(item.minHostReleaseNumber, clientReleaseNumber) ||
      appStorePackageRequiresHostUpdate(policy.minHostReleaseNumber, clientReleaseNumber)
    ) {
      result.skipped.push({ appId, packageKey: policy.packageKey, reason: "host_update_required" });
      continue;
    }
    const belowMinimum = Boolean(
      installedRef &&
        policy.minimumVersion &&
        installedRef.version &&
        compareVersions(installedRef.version, policy.minimumVersion) < 0,
    );
    if (installedRef && !updateCheckRequired && !belowMinimum) {
      result.skipped.push({ appId, packageKey: policy.packageKey, reason: "already_installed" });
      continue;
    }
    if (installedRef?.version && compareVersions(installedRef.version, item.version) >= 0) {
      result.skipped.push({
        appId,
        packageKey: policy.packageKey,
        reason: installedRef.version === item.version ? "already_current" : "installed_newer",
      });
      continue;
    }

    try {
      const imported = await importRegistryAppStorePackageForInstall(
        input.state,
        input.request,
        policy.packageKey,
        input.packageRegistryConfig,
      );
      if (!imported) throw new Error("app_store_package_not_found");
      if (input.state.app) input.state.store.saveFrom(input.state.app);
      const install = installAppStorePackage({
        packageId: imported.id,
        settings: input.state.settings,
        state: input.state,
        backupEnabled: true,
        storeRoot: appStoreDataRoot(input.state),
        onFreshAppRootCreated: (created) => {
          freshInstalls.push(created);
        },
        onUpdatedAppRootCreated: (created) => {
          updatedInstalls.push(created);
        },
      });
      if (!install) throw new Error("app_store_package_not_found");
      changedAppIds.add(install.appId);
      if (installedRef) {
        result.updated.push(install);
      } else {
        managedPackageKeys.add(policy.packageKey);
        result.installed.push(install);
      }
    } catch (error) {
      syncError(result, appId, policy.packageKey, error instanceof Error ? error.message : String(error));
    }
  }

  const lastSuccessfulClientReleaseNumber =
    result.ok && clientReleaseNumber
      ? clientReleaseNumber
      : previousSettings.defaultAppSync.lastSuccessfulClientReleaseNumber;
  input.state.settings.defaultAppSync = {
    managedPackageKeys: [...managedPackageKeys].sort(),
    ...(lastSuccessfulClientReleaseNumber ? { lastSuccessfulClientReleaseNumber } : {}),
  };
  const defaultAppSyncChanged =
    JSON.stringify(input.state.settings.defaultAppSync) !== JSON.stringify(previousSettings.defaultAppSync);
  const activateBridgeApp =
    input.activateBridgeApp ??
    ((state, appIds) => {
      recreateBridgeApp(state, {
        authoritativeEmployeeConfigAppIds: appIds,
        deferPersistedStateSave: true,
      });
    });
  const persistBridgeSettings = input.persistBridgeSettings ?? saveBridgeSettings;

  if (!changedAppIds.size) {
    if (defaultAppSyncChanged) {
      try {
        persistBridgeSettings(input.state);
      } catch (error) {
        input.state.settings.defaultAppSync = previousSettings.defaultAppSync;
        syncError(result, "*", "*", error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }
  try {
    activateBridgeApp(input.state, changedAppIds);
    input.state.store.saveFrom(input.state.app);
    persistBridgeSettings(input.state);
    for (const install of updatedInstalls) commitUpdatedAppStorePackageInstall(install);
  } catch (error) {
    let activationError: unknown = error;
    for (const install of updatedInstalls.reverse()) {
      try {
        rollbackUpdatedAppStorePackageInstall({ ...install, storeRoot: appStoreDataRoot(input.state) });
      } catch (rollbackError) {
        activationError = new AggregateError([activationError, rollbackError], "default_app_update_rollback_failed");
      }
    }
    for (const install of freshInstalls.reverse()) {
      try {
        rollbackFreshAppStorePackageInstall({ ...install, storeRoot: appStoreDataRoot(input.state) });
      } catch (rollbackError) {
        activationError = new AggregateError([activationError, rollbackError], "default_app_install_rollback_failed");
      }
    }
    input.state.settings = previousSettings;
    try {
      activateBridgeApp(input.state, new Set());
      restorePersistedAgentState(input.state.app, previousAgentState);
      input.state.store.saveFrom(input.state.app);
      persistBridgeSettings(input.state);
    } catch (rollbackError) {
      activationError = new AggregateError([activationError, rollbackError], "default_app_state_rollback_failed");
    }
    result.status = "failed";
    result.ok = false;
    const failed = [...result.installed, ...result.updated];
    result.installed = [];
    result.updated = [];
    for (const install of failed) {
      result.errors.push({
        appId: install.appId,
        packageKey: install.packageId,
        error: activationError instanceof Error ? activationError.message : String(activationError),
      });
    }
    return result;
  }

  for (const install of freshInstalls) {
    try {
      finalizeFreshAppStorePackageInstall(install);
    } catch {
      // The activated App owns the restored workspace; retain stale backup bytes for recovery.
    }
  }
  for (const install of updatedInstalls) {
    try {
      finalizeUpdatedAppStorePackageInstall(install);
    } catch (error) {
      console.warn("default_app_update_cleanup_deferred", {
        packageId: install.packageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const install of [...result.installed, ...result.updated]) {
    queueAppReadinessReport({
      state: input.state,
      appId: install.mountedApp?.id || install.appId,
      notifyPm: true,
    });
  }
  return result;
}

/** The install policy is resolved per authenticated user by WW, not statically by the Host. */
export function defaultStoreAppPackageKeysForState(_state: BridgeState): string[] {
  return [];
}

function resolveInstalledDefaultApp(
  state: BridgeState,
  item: AppStorePackageRecord,
  registryUrl: string,
): {
  ref?: ReturnType<typeof installedAppStoreAppRefs>[number];
  reason?: string;
} {
  const packageKey = normalizeAppStorePackageKey(item.packageKey);
  const expectedIdentity = appStorePackageSourceIdentity({ packageKey, registryUrl });
  const refs = installedAppStoreAppRefs(state.settings);
  const matchingRef = refs.find(
    (ref) =>
      ref.packageKey === packageKey && (!expectedIdentity || appStorePackageSourceIdentity(ref) === expectedIdentity),
  );
  if (matchingRef) {
    if (!matchingRef.appRootExists) return { reason: "repair_required" };
    if (!matchingRef.version) return { reason: "installed_version_unknown" };
    return { ref: matchingRef };
  }
  const collision = state.settings.mountedApps.find((mountedApp) => mountedAppCollidesWithDefault(mountedApp, item));
  if (!collision) return {};
  if (!collision.path || !existsSync(resolve(collision.path))) return { reason: "repair_required" };
  if (mountedDefaultAppNeedsRelink(collision, packageKey ?? "")) return { reason: "relink_required" };
  const marker = readAppStorePackageInstallMarker(collision.path);
  return { reason: marker?.source === "registry" ? "source_conflict" : "manual_mount" };
}

function defaultAppExplicitlyDisabled(state: BridgeState, item: AppStorePackageRecord): boolean {
  return (
    state.settings.uninstalledStoreAppIds.includes(item.appId) ||
    state.settings.mountedApps.some(
      (mountedApp) => mountedApp.enabled === false && mountedAppCollidesWithDefault(mountedApp, item),
    )
  );
}

function mountedAppCollidesWithDefault(mountedApp: BridgeMountedAppSettings, item: AppStorePackageRecord): boolean {
  if (mountedApp.id === item.appId) return true;
  if (!mountedApp.path) return false;
  if (resolve(mountedApp.path) === resolve(defaultAppStoreRoot(), appStoreAppDirectoryName(item.appId))) return true;
  const marker = readAppStorePackageInstallMarker(mountedApp.path);
  const packageKey = normalizeAppStorePackageKey(item.packageKey);
  if (normalizeAppStorePackageKey(marker?.packageKey) === packageKey || marker?.appId === item.appId) return true;
  return installedAppStoreAppRefs({ mountedApps: [mountedApp] }).some(
    (ref) =>
      ref.appId === item.appId ||
      ref.mountedAppId === item.appId ||
      ref.packageKey === packageKey ||
      ref.manifestPackageKey === packageKey,
  );
}

function mountedDefaultAppNeedsRelink(mountedApp: BridgeMountedAppSettings, packageKey: string): boolean {
  return installedAppStoreAppRefs({ mountedApps: [mountedApp] }).some((ref) => {
    const markerPackageKey = normalizeAppStorePackageKey(ref.packageKey);
    return (
      !appStorePackageSourceIdentity(ref) &&
      (!ref.markerSource || ref.markerSource === "registry") &&
      (!markerPackageKey || markerPackageKey === packageKey) &&
      (markerPackageKey === packageKey || normalizeAppStorePackageKey(ref.manifestPackageKey) === packageKey)
    );
  });
}

function syncError(
  result: DefaultStoreAppsSyncResult,
  appId: string,
  packageKey: string,
  error: string,
): DefaultStoreAppsSyncResult {
  result.status = "failed";
  result.ok = false;
  result.errors.push({ appId, packageKey, error });
  return result;
}

function deferSync(result: DefaultStoreAppsSyncResult, error: string): DefaultStoreAppsSyncResult {
  result.status = "deferred";
  result.ok = false;
  result.errors.push({ appId: "*", packageKey: "*", error });
  return result;
}

function emptySyncResult(input: { error: string }): DefaultStoreAppsSyncResult {
  return {
    status: "deferred",
    ok: false,
    installed: [],
    updated: [],
    skipped: [],
    errors: [{ appId: "*", packageKey: "*", error: input.error }],
    updateCheckRequired: false,
  };
}

function setLastSyncTime(cache: WeakMap<BridgeState, Map<string, number>>, state: BridgeState, userId: string): void {
  const timestamps = cache.get(state);
  if (timestamps) {
    timestamps.set(userId, Date.now());
  } else {
    cache.set(state, new Map([[userId, Date.now()]]));
  }
}
