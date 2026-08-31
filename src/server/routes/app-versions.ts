import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { normalizeAppStorePackageKey } from "../../app-store-package-identity.js";
import type { BridgeState } from "../bridge-types.js";
import { formalVersionPackageRecord } from "../app-release-coordinator.js";
import {
  appStoreDataRoot,
  captureAppStorePublishTarget,
  disposePreparedAppStorePackageInstall,
  prepareAppStorePackageInstall,
  readAppStorePackageInstallMarker,
  type PreparedAppStorePackageInstall,
} from "../app-store.js";
import {
  appStoreRegistryErrorStatus,
  AppStoreRegistryError,
  importRegistryAppStoreVersionForInstall,
  listRegistryAppStoreVersions,
  type AppStoreFormalVersion,
} from "../app-store-registry.js";
import {
  activateImportedFormalAppVersion,
  activatePreparedLocalAppDraft,
  activeMountedAppRuns,
  forceStopMountedAppRuns,
  inspectMountedAppVersionStatus,
} from "../app-version-manager.js";
import { MountedAppVersionStateStore, selectedFormalVersionFromMarker } from "../app-version-state.js";
import type { BridgeSecurity } from "../bridge-security.js";
import { isAppRevisionUnavailableError } from "../app-revision-store.js";
import { LocalAppDraftStore } from "../local-app-drafts.js";
import type { LocalAppDraftSummary } from "../local-app-drafts.js";
import { resolveMountedAppTarget, type MountedAppTarget } from "../mounted-apps.js";
import { resolveReleaseControlConfig } from "../release-control-config.js";
import { appRevisionStore, mountedAppRevisionTarget } from "../mounted-app-draft-service.js";

interface AppVersionRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  state: BridgeState;
  security?: BridgeSecurity;
  sendJson(response: ServerResponse, status: number, data: unknown): void;
  readJsonBody(request: IncomingMessage): Promise<unknown>;
}

interface FormalSwitchTarget {
  kind: "formal";
  version: string;
  archiveSha256: string;
}

interface LocalDraftSwitchTarget {
  kind: "local-draft";
}

type AppVersionSwitchTarget = FormalSwitchTarget | LocalDraftSwitchTarget;

export async function handleMountedAppVersionsRoute(
  context: AppVersionRouteContext,
  target: MountedAppTarget,
  routePath: string,
): Promise<void> {
  const localAppId = mountedAppLocalIdentity(target);
  const dataRoot = appStoreDataRoot(context.state);
  const draftStore = new LocalAppDraftStore(join(dataRoot, "local-drafts"));
  const versionStore = new MountedAppVersionStateStore(join(dataRoot, "version-state"));

  if (!routePath && context.request.method === "GET") {
    const localDraft = draftStore.read(localAppId);
    const versionState = versionStore.read(localAppId);
    const packageKey = mountedAppPackageKey(target, localDraft, versionState);
    let versions: AppStoreFormalVersion[] = [];
    let registryError: string | undefined;
    if (packageKey) {
      try {
        const config = await resolveReleaseControlConfig(
          context.state,
          context.request,
          context.response,
          context.security,
        );
        if (!config) throw new Error("release_control_not_configured");
        versions = sortFormalVersions(await listReleaseControlVersions(config, packageKey));
      } catch (error) {
        registryError = errorText(error);
      }
    }
    try {
      const status = await withAppRevisionStatus(
        context.state,
        target,
        inspectMountedAppVersionStatus({
          state: context.state,
          target,
          localDraft,
          versionState,
          versions,
        }),
      );
      context.sendJson(context.response, 200, {
        ok: true,
        localAppId,
        packageKey,
        status,
        ...(registryError ? { registryError } : {}),
      });
    } catch (error) {
      context.sendJson(context.response, 500, { ok: false, error: errorText(error) });
    }
    return;
  }

  if (routePath !== "switch") {
    context.sendJson(context.response, 404, { ok: false, error: "app_version_route_not_found" });
    return;
  }
  if (context.request.method !== "POST") {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  try {
    const body = record(await context.readJsonBody(context.request));
    const switchTarget = normalizeSwitchTarget(body.target);
    if (!switchTarget) {
      context.sendJson(context.response, 400, { ok: false, error: "app_version_target_invalid" });
      return;
    }
    if (switchTarget.kind === "local-draft") {
      await handleLocalDraftSwitch({
        context,
        target,
        body,
        localAppId,
        draftStore,
        versionStore,
      });
      return;
    }
    const packageKey = mountedAppPackageKey(target, draftStore.read(localAppId), versionStore.read(localAppId));
    if (!packageKey) {
      context.sendJson(context.response, 409, { ok: false, error: "app_version_formal_identity_missing" });
      return;
    }
    const config = await resolveReleaseControlConfig(
      context.state,
      context.request,
      context.response,
      context.security,
    );
    if (!config) {
      context.sendJson(context.response, 409, { ok: false, error: "release_control_not_configured" });
      return;
    }
    const versions = await listReleaseControlVersions(config, packageKey);
    const formalVersion = versions.find(
      (version) => version.version === switchTarget.version && version.archiveSha256 === switchTarget.archiveSha256,
    );
    if (!formalVersion) {
      context.sendJson(context.response, 404, { ok: false, error: "app_version_not_found" });
      return;
    }
    if (formalVersion.availability !== "available") {
      context.sendJson(context.response, 409, {
        ok: false,
        error:
          formalVersion.availability === "host_incompatible"
            ? "app_store_host_update_required"
            : "app_store_version_artifact_unavailable",
      });
      return;
    }
    const catalogPackage = formalVersionPackageRecord(formalVersion);

    const initialStatus = inspectMountedAppVersionStatus({
      state: context.state,
      target,
      localDraft: draftStore.read(localAppId),
      versionState: versionStore.read(localAppId),
      versions: sortFormalVersions(versions),
    });
    if (initialStatus.hasUnsavedChanges && body.discardUnsavedChanges !== true) {
      context.sendJson(context.response, 409, {
        ok: false,
        error: "app_version_unsaved_changes",
        status: initialStatus,
      });
      return;
    }
    const initialRuns = activeMountedAppRuns(context.state, target.id);
    if (initialRuns.length && body.forceStop !== true) {
      context.sendJson(context.response, 409, {
        ok: false,
        error: "app_version_active_runs",
        runs: initialRuns,
      });
      return;
    }

    const imported = await importRegistryAppStoreVersionForInstall(context.state, formalVersion, catalogPackage, {
      baseUrl: config.baseUrl,
      registryToken: config.accessToken,
    });
    const adoptTargetSnapshot = captureAppStorePublishTarget(target.appRoot);
    let prepared: PreparedAppStorePackageInstall | undefined;
    try {
      prepared = prepareAppStorePackageInstall({
        packageId: imported.id,
        settings: context.state.settings,
        storeRoot: dataRoot,
        adoptTargetSnapshot,
      });
      if (!prepared) throw new Error("app_store_package_not_found");
      const currentTarget = resolveCurrentTarget(context.state, target);
      const currentStatus = inspectMountedAppVersionStatus({
        state: context.state,
        target: currentTarget,
        localDraft: draftStore.read(localAppId),
        versionState: versionStore.read(localAppId),
        versions: sortFormalVersions(versions),
      });
      if (currentStatus.hasUnsavedChanges && body.discardUnsavedChanges !== true) {
        context.sendJson(context.response, 409, {
          ok: false,
          error: "app_version_unsaved_changes",
          status: currentStatus,
        });
        return;
      }
      if (body.forceStop === true) {
        const stopped = await forceStopMountedAppRuns(context.state, target.id);
        if (!stopped.stopped) {
          context.sendJson(context.response, 409, {
            ok: false,
            error: "app_version_run_stop_unconfirmed",
            runs: stopped.runs,
          });
          return;
        }
      } else {
        const runs = activeMountedAppRuns(context.state, target.id);
        if (runs.length) {
          context.sendJson(context.response, 409, {
            ok: false,
            error: "app_version_active_runs",
            runs,
          });
          return;
        }
      }
      const stoppedTarget = resolveCurrentTarget(context.state, target);
      const stoppedStatus = inspectMountedAppVersionStatus({
        state: context.state,
        target: stoppedTarget,
        localDraft: draftStore.read(localAppId),
        versionState: versionStore.read(localAppId),
        versions: sortFormalVersions(versions),
      });
      if (stoppedStatus.hasUnsavedChanges && body.discardUnsavedChanges !== true) {
        context.sendJson(context.response, 409, {
          ok: false,
          error: "app_version_unsaved_changes",
          status: stoppedStatus,
        });
        return;
      }

      const activated = await activateImportedFormalAppVersion({
        state: context.state,
        localAppId,
        prepared,
        selectedVersion: {
          packageKey: formalVersion.packageKey,
          version: formalVersion.version,
          archiveSha256: formalVersion.archiveSha256,
          ...(formalVersion.releaseCommitSha ? { releaseCommitSha: formalVersion.releaseCommitSha } : {}),
        },
        versionStore,
      });
      const activatedTarget = resolveCurrentTarget(context.state, target);
      context.sendJson(context.response, 200, {
        ok: true,
        install: activated.install,
        status: inspectMountedAppVersionStatus({
          state: context.state,
          target: activatedTarget,
          localDraft: draftStore.read(localAppId),
          versionState: activated.versionState,
          versions: sortFormalVersions(versions),
        }),
      });
    } finally {
      if (prepared) {
        try {
          disposePreparedAppStorePackageInstall(prepared);
        } catch {
          // A stale staging directory is safer than masking a completed activation or its rollback result.
        }
      }
    }
  } catch (error) {
    context.sendJson(context.response, appStoreRegistryErrorStatus(error), {
      ok: false,
      error: errorText(error),
    });
  }
}

async function withAppRevisionStatus(
  state: BridgeState,
  target: MountedAppTarget,
  status: ReturnType<typeof inspectMountedAppVersionStatus>,
): Promise<ReturnType<typeof inspectMountedAppVersionStatus>> {
  try {
    const revision = await appRevisionStore(state).inspect(mountedAppRevisionTarget(target));
    return {
      ...status,
      sourceSavePoint: {
        commitSha: revision.commitSha,
        savedAt: revision.savedAt,
      },
      sourceChangedFileCount: revision.changedFiles.length,
    };
  } catch (error) {
    if (isAppRevisionUnavailableError(error)) return status;
    console.warn("[opengrove-app-revision] source status inspection failed", {
      localAppId: target.localAppId,
      error: errorText(error),
    });
    throw error;
  }
}

async function listReleaseControlVersions(
  config: { baseUrl: string; accessToken: string },
  packageKey: string,
): Promise<AppStoreFormalVersion[]> {
  try {
    return await listRegistryAppStoreVersions(
      { baseUrl: config.baseUrl, registryToken: config.accessToken },
      packageKey,
    );
  } catch (error) {
    if (error instanceof AppStoreRegistryError && error.status === 404) return [];
    throw error;
  }
}

async function handleLocalDraftSwitch(input: {
  context: AppVersionRouteContext;
  target: MountedAppTarget;
  body: Record<string, unknown>;
  localAppId: string;
  draftStore: LocalAppDraftStore;
  versionStore: MountedAppVersionStateStore;
}): Promise<void> {
  const initialStatus = inspectMountedAppVersionStatus({
    state: input.context.state,
    target: input.target,
    localDraft: input.draftStore.read(input.localAppId),
    versionState: input.versionStore.read(input.localAppId),
    versions: [],
  });
  if (initialStatus.hasUnsavedChanges && input.body.discardUnsavedChanges !== true) {
    input.context.sendJson(input.context.response, 409, {
      ok: false,
      error: "app_version_unsaved_changes",
      status: initialStatus,
    });
    return;
  }
  const initialRuns = activeMountedAppRuns(input.context.state, input.target.id);
  if (initialRuns.length && input.body.forceStop !== true) {
    input.context.sendJson(input.context.response, 409, {
      ok: false,
      error: "app_version_active_runs",
      runs: initialRuns,
    });
    return;
  }

  const prepared = input.draftStore.prepareOpen({
    localAppId: input.localAppId,
    appRoot: input.target.appRoot,
  });
  try {
    const currentTarget = resolveCurrentTarget(input.context.state, input.target);
    const currentStatus = inspectMountedAppVersionStatus({
      state: input.context.state,
      target: currentTarget,
      localDraft: input.draftStore.read(input.localAppId),
      versionState: input.versionStore.read(input.localAppId),
      versions: [],
    });
    if (currentStatus.hasUnsavedChanges && input.body.discardUnsavedChanges !== true) {
      input.context.sendJson(input.context.response, 409, {
        ok: false,
        error: "app_version_unsaved_changes",
        status: currentStatus,
      });
      return;
    }
    if (input.body.forceStop === true) {
      const stopped = await forceStopMountedAppRuns(input.context.state, input.target.id);
      if (!stopped.stopped) {
        input.context.sendJson(input.context.response, 409, {
          ok: false,
          error: "app_version_run_stop_unconfirmed",
          runs: stopped.runs,
        });
        return;
      }
    } else {
      const runs = activeMountedAppRuns(input.context.state, input.target.id);
      if (runs.length) {
        input.context.sendJson(input.context.response, 409, {
          ok: false,
          error: "app_version_active_runs",
          runs,
        });
        return;
      }
    }
    const stoppedTarget = resolveCurrentTarget(input.context.state, input.target);
    const stoppedStatus = inspectMountedAppVersionStatus({
      state: input.context.state,
      target: stoppedTarget,
      localDraft: input.draftStore.read(input.localAppId),
      versionState: input.versionStore.read(input.localAppId),
      versions: [],
    });
    if (stoppedStatus.hasUnsavedChanges && input.body.discardUnsavedChanges !== true) {
      input.context.sendJson(input.context.response, 409, {
        ok: false,
        error: "app_version_unsaved_changes",
        status: stoppedStatus,
      });
      return;
    }
    const currentVersionState = input.versionStore.read(input.localAppId);
    const selectedVersion =
      currentVersionState?.selectedVersion ??
      selectedFormalVersionFromMarker(readAppStorePackageInstallMarker(stoppedTarget.appRoot));
    const activated = activatePreparedLocalAppDraft({
      state: input.context.state,
      localAppId: input.localAppId,
      draftStore: input.draftStore,
      prepared,
      selectedVersion,
      versionStore: input.versionStore,
    });
    const activatedTarget = resolveCurrentTarget(input.context.state, input.target);
    input.context.sendJson(input.context.response, 200, {
      ok: true,
      draft: activated.draft,
      status: inspectMountedAppVersionStatus({
        state: input.context.state,
        target: activatedTarget,
        localDraft: input.draftStore.read(input.localAppId),
        versionState: activated.versionState,
        versions: [],
      }),
    });
  } finally {
    try {
      input.draftStore.cancelPreparedOpen(prepared);
    } catch {
      // A retained recovery transaction is safer than masking activation or rollback state.
    }
  }
}

function mountedAppLocalIdentity(target: MountedAppTarget): string {
  return target.localAppId;
}

function mountedAppPackageKey(
  target: MountedAppTarget,
  localDraft?: LocalAppDraftSummary,
  versionState?: ReturnType<MountedAppVersionStateStore["read"]>,
): string {
  const marker = readAppStorePackageInstallMarker(target.appRoot);
  return (
    normalizeAppStorePackageKey(localDraft?.publishBase?.packageKey) ||
    normalizeAppStorePackageKey(versionState?.selectedVersion?.packageKey) ||
    normalizeAppStorePackageKey(marker?.packageKey) ||
    normalizeAppStorePackageKey(record(target.manifest.store).packageKey) ||
    ""
  );
}

function normalizeSwitchTarget(value: unknown): AppVersionSwitchTarget | undefined {
  const target = record(value);
  if (target.kind === "local-draft") return { kind: "local-draft" };
  if (target.kind !== "formal") return undefined;
  const version = stringValue(target.version);
  const archiveSha256 = stringValue(target.archiveSha256).toLowerCase();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  if (!/^[a-f0-9]{64}$/.test(archiveSha256)) return undefined;
  return {
    kind: "formal",
    version,
    archiveSha256,
  };
}

function resolveCurrentTarget(state: BridgeState, previous: MountedAppTarget): MountedAppTarget {
  const resolved =
    resolveMountedAppTarget(state, mountedAppLocalIdentity(previous)) ?? resolveMountedAppTarget(state, previous.id);
  if (!resolved) throw new Error("app_version_activation_target_missing");
  return resolved;
}

function sortFormalVersions(versions: AppStoreFormalVersion[]): AppStoreFormalVersion[] {
  return [...versions].sort((left, right) => compareSemver(right.version, left.version));
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
