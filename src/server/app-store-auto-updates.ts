import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { appStorePackageSourceIdentity } from "../app-store-package-identity.js";
import {
  appStoreDataRoot,
  captureAppStorePublishTarget,
  disposePreparedAppStorePackageInstall,
  installedAppStoreAppRefs,
  prepareAppStorePackageInstall,
  type AppStorePackageRecord,
  type PreparedAppStorePackageInstall,
} from "./app-store.js";
import {
  importRegistryAppStorePackageForInstall,
  listRegistryAppStorePackages,
  type AppStoreRegistryConfig,
} from "./app-store-registry.js";
import {
  activateImportedFormalAppVersion,
  activeMountedAppRuns,
  inspectMountedAppVersionStatus,
} from "./app-version-manager.js";
import { MountedAppVersionStateStore } from "./app-version-state.js";
import { runBackgroundAppStoreTask } from "./background-app-store-task.js";
import type { BridgeState } from "./bridge-types.js";
import { saveBridgeSettings } from "./bridge-state.js";
import { compareVersions } from "./app-release.js";
import { queueAppReadinessReport } from "./app-readiness.js";
import { appStorePackageRequiresHostUpdate } from "./client-release.js";
import { LocalAppDraftStore } from "./local-app-drafts.js";
import { resolveMountedAppTarget, type MountedAppTarget } from "./mounted-apps.js";
import { recordProblem } from "./problem-records.js";
import { isRetiredKnowledgeVaultPackage } from "./retired-apps.js";

// Scheduling is request-driven: authenticated startup/session requests perform
// the first check, then the open Web client supplies the six-hour heartbeat.
// The Bridge intentionally does not run an autonomous headless update timer.
export const APP_STORE_AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
const AUTO_UPDATE_FAILURE_COOLDOWN_MS = 5 * 60_000;
const AUTO_UPDATE_REQUEST_TIMEOUT_MS = 15_000;

export interface InstalledAppStoreUpdateResult {
  status: "completed" | "deferred" | "failed";
  ok: boolean;
  updated: Array<{ appId: string; packageKey: string; fromVersion: string; toVersion: string }>;
  skipped: Array<{ appId: string; packageKey: string; reason: string }>;
  errors: Array<{ appId: string; packageKey: string; error: string }>;
}

export interface InstalledAppStoreUpdateScheduleResult {
  status: "scheduled" | "already_running" | "skipped";
  reason?: string;
}

const inFlightUpdates = new WeakMap<BridgeState, Promise<InstalledAppStoreUpdateResult>>();
const lastFailures = new WeakMap<BridgeState, number>();
const completedChecksThisProcess = new WeakSet<BridgeState>();

export function scheduleInstalledAppStoreUpdatesAfterAuth(input: {
  state: BridgeState;
  request: IncomingMessage;
  packageRegistryConfig?: AppStoreRegistryConfig;
  userId?: string;
  traceId?: string;
  now?: number;
}): InstalledAppStoreUpdateScheduleResult {
  if (input.state.settings.appUpdates.automatic === false) {
    return { status: "skipped", reason: "automatic_updates_disabled" };
  }
  if (!input.packageRegistryConfig?.registryToken) {
    return { status: "skipped", reason: "registry_token_required" };
  }
  if (inFlightUpdates.has(input.state)) return { status: "already_running" };

  const now = input.now ?? Date.now();
  const lastSuccessfulCheck = Date.parse(input.state.settings.appUpdates.lastSuccessfulCheckAt ?? "");
  if (
    completedChecksThisProcess.has(input.state) &&
    Number.isFinite(lastSuccessfulCheck) &&
    now - lastSuccessfulCheck < APP_STORE_AUTO_UPDATE_INTERVAL_MS
  ) {
    return { status: "skipped", reason: "check_interval" };
  }
  const lastFailure = lastFailures.get(input.state) ?? 0;
  if (now - lastFailure < AUTO_UPDATE_FAILURE_COOLDOWN_MS) {
    return { status: "skipped", reason: "failed_retry_cooldown" };
  }

  const promise = runBackgroundAppStoreTask(input.state, () =>
    ensureInstalledAppStoreAppsCurrent({
      state: input.state,
      request: input.request,
      packageRegistryConfig: input.packageRegistryConfig!,
      now,
    }),
  )
    .then((result) => {
      if (!result.ok) {
        lastFailures.set(input.state, Date.now());
      } else {
        lastFailures.delete(input.state);
      }
      if (result.status === "failed") {
        recordProblem(input.state, {
          traceId: input.traceId,
          category: "bridge",
          phase: "app-auto-update",
          code: "app_auto_update_failed",
          error: new Error(result.errors.map((item) => `${item.packageKey}:${item.error}`).join("; ")),
          retryable: true,
          backgroundDedupe: {
            key: `app-auto-update:${input.userId?.trim() || "authenticated-user"}`,
            windowMs: 10 * 60_000,
          },
        });
      }
      return result;
    })
    .catch((error) => {
      lastFailures.set(input.state, Date.now());
      const message = error instanceof Error ? error.message : String(error);
      recordProblem(input.state, {
        traceId: input.traceId,
        category: "bridge",
        phase: "app-auto-update",
        code: "app_auto_update_failed",
        error,
        retryable: true,
        backgroundDedupe: {
          key: `app-auto-update:${input.userId?.trim() || "authenticated-user"}`,
          windowMs: 10 * 60_000,
        },
      });
      return emptyFailedResult(message);
    })
    .finally(() => {
      if (inFlightUpdates.get(input.state) === promise) inFlightUpdates.delete(input.state);
    });
  inFlightUpdates.set(input.state, promise);
  return { status: "scheduled" };
}

export async function ensureInstalledAppStoreAppsCurrent(input: {
  state: BridgeState;
  request: IncomingMessage;
  packageRegistryConfig: AppStoreRegistryConfig;
  now?: number;
  requestTimeoutMs?: number;
  persistBridgeSettings?(state: BridgeState): void;
}): Promise<InstalledAppStoreUpdateResult> {
  const result: InstalledAppStoreUpdateResult = {
    status: "completed",
    ok: true,
    updated: [],
    skipped: [],
    errors: [],
  };
  if (input.state.settings.appUpdates.automatic === false) return result;
  if (!input.packageRegistryConfig.registryToken) {
    return deferredResult(result, "registry_token_required");
  }

  let catalog: AppStorePackageRecord[];
  try {
    catalog = await listRegistryAppStorePackages(input.packageRegistryConfig, input.request, {
      timeoutMs: input.requestTimeoutMs ?? AUTO_UPDATE_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    return deferredResult(result, errorText(error));
  }

  const dataRoot = appStoreDataRoot(input.state);
  const draftStore = new LocalAppDraftStore(join(dataRoot, "local-drafts"));
  const versionStore = new MountedAppVersionStateStore(join(dataRoot, "version-state"));
  const refs = installedAppStoreAppRefs(input.state.settings);

  for (const ref of refs) {
    const packageKey = ref.packageKey ?? "";
    const appId = ref.appId || ref.mountedAppId;
    if (ref.markerSource !== "registry" || !packageKey) {
      result.skipped.push({ appId, packageKey, reason: "not_registry_installed" });
      continue;
    }
    const item = catalog.find((candidate) => candidate.publishKind === "app" && candidate.packageKey === packageKey);
    if (!item) {
      result.skipped.push({ appId, packageKey, reason: "app_store_package_not_found" });
      continue;
    }
    if (isRetiredKnowledgeVaultPackage(item)) {
      result.skipped.push({ appId, packageKey, reason: "app_retired" });
      continue;
    }
    if (appStorePackageSourceIdentity(ref) !== appStorePackageSourceIdentity(item)) {
      result.skipped.push({ appId, packageKey, reason: "source_conflict" });
      continue;
    }
    if (!ref.appRootExists || !ref.version) {
      result.skipped.push({
        appId,
        packageKey,
        reason: ref.appRootExists ? "installed_version_unknown" : "repair_required",
      });
      continue;
    }
    if (appStorePackageRequiresHostUpdate(item.minHostReleaseNumber)) {
      result.skipped.push({ appId, packageKey, reason: "host_update_required" });
      continue;
    }
    if (compareVersions(ref.version, item.version) >= 0) {
      result.skipped.push({
        appId,
        packageKey,
        reason: ref.version === item.version ? "already_current" : "installed_newer",
      });
      continue;
    }

    const target = resolveMountedAppTarget(input.state, ref.mountedAppId);
    let safetyIssue: string | undefined;
    try {
      safetyIssue = target ? automaticUpdateSafetyIssue(input.state, target, draftStore, versionStore) : "app_missing";
    } catch (error) {
      result.status = "failed";
      result.ok = false;
      result.errors.push({ appId, packageKey, error: errorText(error) });
      continue;
    }
    if (safetyIssue) {
      result.skipped.push({ appId, packageKey, reason: safetyIssue });
      continue;
    }

    let prepared: PreparedAppStorePackageInstall | undefined;
    try {
      const targetSnapshot = captureAppStorePublishTarget(target!.appRoot);
      const imported = await importRegistryAppStorePackageForInstall(
        input.state,
        input.request,
        packageKey,
        input.packageRegistryConfig,
      );
      if (!imported) throw new Error("app_store_package_not_found");
      const archiveSha256 = imported.archiveSha256;
      if (!archiveSha256) throw new Error("app_store_archive_checksum_invalid");
      prepared = prepareAppStorePackageInstall({
        packageId: imported.id,
        settings: input.state.settings,
        storeRoot: dataRoot,
        adoptTargetSnapshot: targetSnapshot,
      });
      if (!prepared) throw new Error("app_store_package_not_found");
      const currentTarget = resolveMountedAppTarget(input.state, ref.mountedAppId);
      const currentSafetyIssue = currentTarget
        ? automaticUpdateSafetyIssue(input.state, currentTarget, draftStore, versionStore)
        : "app_missing";
      if (currentSafetyIssue) {
        result.skipped.push({ appId, packageKey, reason: currentSafetyIssue });
        continue;
      }
      const activation = activateImportedFormalAppVersion({
        state: input.state,
        localAppId: currentTarget!.localAppId,
        prepared,
        selectedVersion: {
          packageKey,
          version: imported.version,
          archiveSha256,
          ...(imported.releaseCommitSha ? { releaseCommitSha: imported.releaseCommitSha } : {}),
        },
        versionStore,
        ...(input.persistBridgeSettings ? { persistBridgeSettings: input.persistBridgeSettings } : {}),
      });
      result.updated.push({
        appId: activation.install.appId,
        packageKey,
        fromVersion: ref.version,
        toVersion: imported.version,
      });
      queueAppReadinessReport({
        state: input.state,
        appId: activation.install.mountedApp?.id || activation.install.appId,
        notifyPm: true,
      });
    } catch (error) {
      result.status = "failed";
      result.ok = false;
      result.errors.push({ appId, packageKey, error: errorText(error) });
    } finally {
      if (prepared) {
        try {
          disposePreparedAppStorePackageInstall(prepared);
        } catch {
          // A stale staging directory is safer than masking the completed update or its rollback result.
        }
      }
    }
  }

  if (result.ok) {
    const previous = input.state.settings.appUpdates;
    input.state.settings.appUpdates = {
      ...previous,
      lastSuccessfulCheckAt: new Date(input.now ?? Date.now()).toISOString(),
    };
    try {
      (input.persistBridgeSettings ?? saveBridgeSettings)(input.state);
      completedChecksThisProcess.add(input.state);
    } catch (error) {
      input.state.settings.appUpdates = previous;
      result.status = "failed";
      result.ok = false;
      result.errors.push({ appId: "*", packageKey: "*", error: errorText(error) });
    }
  }
  return result;
}

function automaticUpdateSafetyIssue(
  state: BridgeState,
  target: MountedAppTarget,
  draftStore: LocalAppDraftStore,
  versionStore: MountedAppVersionStateStore,
): string | undefined {
  if (state.settings.appUpdates.automatic === false) return "automatic_updates_disabled";
  const localDraft = draftStore.read(target.localAppId);
  const versionState = versionStore.read(target.localAppId);
  const status = inspectMountedAppVersionStatus({ state, target, localDraft, versionState, versions: [] });
  if (status.activeContent === "local-draft") return "local_draft_active";
  if (status.hasUnsavedChanges) return "unsaved_changes";
  if (activeMountedAppRuns(state, target.id).length) return "active_runs";
  return undefined;
}

function deferredResult(result: InstalledAppStoreUpdateResult, error: string): InstalledAppStoreUpdateResult {
  result.status = "deferred";
  result.ok = false;
  result.errors.push({ appId: "*", packageKey: "*", error });
  return result;
}

function emptyFailedResult(error: string): InstalledAppStoreUpdateResult {
  return {
    status: "failed",
    ok: false,
    updated: [],
    skipped: [],
    errors: [{ appId: "*", packageKey: "*", error }],
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
