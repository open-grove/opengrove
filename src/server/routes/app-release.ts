import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AbandonAppReleaseOperation,
  GetAppReleaseProgressOperation,
  GetAppReleaseStatusOperation,
  KeepLocalAppReleaseOperation,
  PrepareAppReleaseOperation,
  PublishAppReleaseOperation,
  ReconcileAppReleaseOperation,
} from "#protocol";
import { AppBuildContractScaffoldError, ensureAppBuildContract } from "../../app-builder/build-contract-scaffold.js";
import {
  AppReleaseCoordinator,
  AppReleaseCoordinatorError,
  createAppReleaseClient,
  formalVersionPackageRecord,
  resolveAppReleaseKeepLocalChanges,
  type AppReleaseRegistryAccess,
} from "../app-release-coordinator.js";
import { ReleaseControlClientError } from "../app-release-client.js";
import { validateAppReleaseBuildContract } from "../app-release-build-contract.js";
import { AppReleaseValidationError, prepareMountedAppRelease } from "../app-release.js";
import {
  appStoreRegistryErrorStatus,
  AppStoreRegistryError,
  importRegistryAppStoreVersionForInstall,
  listRegistryAppStoreVersions,
} from "../app-store-registry.js";
import { bridgeSessionUserHasRole, readAuthSession, type BridgeSecurity } from "../bridge-security.js";
import type { BridgeState } from "../bridge-types.js";
import { resolveMountedAppTarget, type MountedAppTarget } from "../mounted-apps.js";
import { resolveReleaseControlConfig } from "../release-control-config.js";
import type { HostOperationRouteContext } from "../router.js";

interface AppReleaseRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  state: BridgeState;
  security?: BridgeSecurity;
  sendJson(response: ServerResponse, status: number, data: unknown): void;
  readJsonBody(request: IncomingMessage): Promise<unknown>;
}

export async function handlePrepareAppReleaseOperation(
  context: HostOperationRouteContext<PrepareAppReleaseOperation>,
): Promise<void> {
  const target = operationTarget(context, context.input.params.appId);
  if (!target) return;
  await sendPreparedAppRelease(context, target);
}

export async function handlePublishAppReleaseOperation(
  context: HostOperationRouteContext<PublishAppReleaseOperation>,
): Promise<void> {
  const target = operationTarget(context, context.input.params.appId);
  if (!target) return;
  await publishMountedAppRelease(context, target, context.input.body);
}

export async function handleGetAppReleaseStatusOperation(
  context: HostOperationRouteContext<GetAppReleaseStatusOperation>,
): Promise<void> {
  const target = operationTarget(context, context.input.params.appId);
  if (!target) return;
  await refreshMountedAppReleaseProgress(context, target);
}

export async function handleGetAppReleaseProgressOperation(
  context: HostOperationRouteContext<GetAppReleaseProgressOperation>,
): Promise<void> {
  const target = operationTarget(context, context.input.params.appId);
  if (!target) return;
  await sendMountedAppReleaseProgress(context, target);
}

export async function handleReconcileAppReleaseOperation(
  context: HostOperationRouteContext<ReconcileAppReleaseOperation>,
): Promise<void> {
  const target = operationTarget(context, context.input.params.appId);
  if (!target) return;
  await reconcileMountedAppRelease(context, target, context.input.body.retryFailedBuild);
}

export async function handleAbandonAppReleaseOperation(
  context: HostOperationRouteContext<AbandonAppReleaseOperation>,
): Promise<void> {
  const target = operationTarget(context, context.input.params.appId);
  if (!target) return;
  await abandonMountedAppRelease(context, target);
}

export async function handleKeepLocalAppReleaseOperation(
  context: HostOperationRouteContext<KeepLocalAppReleaseOperation>,
): Promise<void> {
  const target = operationTarget(context, context.input.params.appId);
  if (!target) return;
  await keepLocalMountedAppRelease(context, target);
}

function operationTarget(context: AppReleaseRouteContext, appId: string): MountedAppTarget | undefined {
  const target = resolveMountedAppTarget(context.state, appId);
  if (target) return target;
  context.sendJson(context.response, 404, { ok: false, error: "app_not_found" });
  return undefined;
}

export async function handleMountedAppReleaseRoute(
  context: AppReleaseRouteContext,
  target: MountedAppTarget,
  routePath: string,
): Promise<void> {
  if (routePath === "build-contract") {
    if (context.request.method !== "POST") {
      context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (!(await isAdmin(context))) return;
    const current = validateAppReleaseBuildContract(target.appRoot);
    if (current.detail !== "build_contract_missing") {
      context.sendJson(context.response, 409, {
        ok: false,
        error: current.ok
          ? "app_release_build_contract_already_present"
          : "app_release_build_contract_repair_not_available",
      });
      return;
    }
    try {
      ensureAppBuildContract(target.appRoot);
      const repaired = validateAppReleaseBuildContract(target.appRoot);
      if (!repaired.ok) {
        throw new AppBuildContractScaffoldError("app_release_build_contract_repair_failed");
      }
      context.sendJson(context.response, 200, { ok: true });
    } catch (error) {
      const errorCode =
        error instanceof AppBuildContractScaffoldError ? error.code : "app_release_build_contract_repair_failed";
      console.warn("app_release_build_contract_repair_failed", {
        error: errorCode,
        appId: target.id,
      });
      context.sendJson(context.response, 409, {
        ok: false,
        error: errorCode,
      });
    }
    return;
  }
  if (["", "prepare", "status", "reconcile", "keep-local", "abandon"].includes(routePath)) {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  context.sendJson(context.response, 404, { ok: false, error: "app_release_route_not_found" });
}

async function sendPreparedAppRelease(context: AppReleaseRouteContext, target: MountedAppTarget): Promise<void> {
  const config = await resolveAuthorizedReleaseControlConfig(context);
  if (!config) return;
  try {
    const baseline = prepareMountedAppRelease({
      state: context.state,
      appId: target.id,
      registryPackages: [],
      includePackageSafetyCheck: false,
    });
    const packageKey = baseline.identity.packageKey ?? `opengrove.${target.id.toLowerCase()}`;
    const versions = await listReleaseVersions(config, packageKey);
    const release = prepareMountedAppRelease({
      state: context.state,
      appId: target.id,
      registryPackages: versions.map(formalVersionPackageRecord),
    });
    context.sendJson(context.response, 200, { ok: true, release });
  } catch (error) {
    sendReleaseError(context, error);
  }
}

async function sendMountedAppReleaseProgress(context: AppReleaseRouteContext, target: MountedAppTarget): Promise<void> {
  const config = await resolveAuthorizedReleaseControlConfig(context);
  if (!config) return;
  try {
    const progress = createReleaseCoordinator(context, target, config).readProgress();
    if (!progress) throw new AppReleaseCoordinatorError("app_store_publish_journal_missing", 404);
    context.sendJson(context.response, 200, { ok: true, progress });
  } catch (error) {
    sendReleaseError(context, error);
  }
}

async function refreshMountedAppReleaseProgress(
  context: AppReleaseRouteContext,
  target: MountedAppTarget,
): Promise<void> {
  const config = await resolveAuthorizedReleaseControlConfig(context);
  if (!config) return;
  try {
    const progress = await createReleaseCoordinator(context, target, config).refreshRemoteProgress();
    context.sendJson(context.response, 200, { ok: true, progress });
  } catch (error) {
    sendReleaseError(context, error);
  }
}

async function keepLocalMountedAppRelease(context: AppReleaseRouteContext, target: MountedAppTarget): Promise<void> {
  if (!(await isAdmin(context))) return;
  try {
    const progress = resolveAppReleaseKeepLocalChanges({ state: context.state, target });
    context.sendJson(context.response, 200, { ok: true, progress });
  } catch (error) {
    sendReleaseError(context, error);
  }
}

async function publishMountedAppRelease(
  context: AppReleaseRouteContext,
  target: MountedAppTarget,
  body: HostOperationRouteContext<PublishAppReleaseOperation>["input"]["body"],
): Promise<void> {
  const config = await resolveAuthorizedReleaseControlConfig(context);
  if (!config) return;
  const coordinator = createReleaseCoordinator(context, target, config);
  const localBuildAbort = new AbortController();
  const abortLocalBuild = () => localBuildAbort.abort();
  context.response.once("close", abortLocalBuild);
  try {
    const progress = await coordinator.start({
      release: releaseSubmissionFromPatch(context.state, target, body),
      applyToCurrentApp: body.applyToCurrentApp,
      signal: localBuildAbort.signal,
    });
    context.sendJson(context.response, progress.state === "published" ? 200 : 202, { ok: true, progress });
  } catch (error) {
    sendReleaseError(context, error, coordinator);
  } finally {
    context.response.off("close", abortLocalBuild);
  }
}

async function reconcileMountedAppRelease(
  context: AppReleaseRouteContext,
  target: MountedAppTarget,
  retryFailedBuild: boolean,
): Promise<void> {
  const config = await resolveAuthorizedReleaseControlConfig(context);
  if (!config) return;
  const coordinator = createReleaseCoordinator(context, target, config);
  try {
    const progress = await coordinator.resume({ retryFailedBuild });
    context.sendJson(context.response, progress.state === "published" ? 200 : 202, { ok: true, progress });
  } catch (error) {
    sendReleaseError(context, error, coordinator);
  }
}

async function abandonMountedAppRelease(context: AppReleaseRouteContext, target: MountedAppTarget): Promise<void> {
  const config = await resolveAuthorizedReleaseControlConfig(context);
  if (!config) return;
  const coordinator = createReleaseCoordinator(context, target, config);
  try {
    const progress = await coordinator.endBlockedRelease();
    context.sendJson(context.response, progress.state === "published" ? 200 : 202, { ok: true, progress });
  } catch (error) {
    sendReleaseError(context, error, coordinator);
  }
}

async function resolveAuthorizedReleaseControlConfig(context: AppReleaseRouteContext) {
  if (!(await isAdmin(context))) return undefined;
  const config = await resolveReleaseControlConfig(context.state, context.request, context.response, context.security);
  if (config) return config;
  context.sendJson(context.response, 409, { ok: false, error: "release_control_not_configured" });
  return undefined;
}

function releaseSubmissionFromPatch(
  state: BridgeState,
  target: MountedAppTarget,
  patch: HostOperationRouteContext<PublishAppReleaseOperation>["input"]["body"],
) {
  const baseline = prepareMountedAppRelease({
    state,
    appId: target.id,
    registryPackages: [],
    includePackageSafetyCheck: false,
  });
  return {
    app: patch.app ?? baseline.app,
    version: patch.version,
    releaseNotes: patch.releaseNotes ?? "",
    visibility: patch.visibility ?? baseline.visibility,
    employees: patch.employees ?? baseline.employees,
  };
}

function createReleaseCoordinator(
  context: AppReleaseRouteContext,
  target: MountedAppTarget,
  config: { baseUrl: string; accessToken: string },
): AppReleaseCoordinator {
  const registry: AppReleaseRegistryAccess = {
    listVersions: (packageKey) => listReleaseVersions(config, packageKey),
    importVersion: (formalVersion, catalogPackage) =>
      importRegistryAppStoreVersionForInstall(context.state, formalVersion, catalogPackage, {
        baseUrl: config.baseUrl,
        registryToken: config.accessToken,
      }),
  };
  return new AppReleaseCoordinator({
    state: context.state,
    target,
    registry,
    client: createAppReleaseClient(config),
  });
}

async function isAdmin(context: AppReleaseRouteContext): Promise<boolean> {
  const session = context.security
    ? await readAuthSession(context.request, context.response, context.security)
    : undefined;
  if (bridgeSessionUserHasRole(session?.user, "admin")) return true;
  context.sendJson(context.response, 403, { ok: false, error: "admin_required" });
  return false;
}

function sendReleaseError(context: AppReleaseRouteContext, error: unknown, coordinator?: AppReleaseCoordinator): void {
  const progress = error instanceof AppReleaseCoordinatorError ? error.progress : readProgressForError(coordinator);
  const status =
    error instanceof AppReleaseCoordinatorError
      ? error.status
      : error instanceof AppReleaseValidationError
        ? error.status
        : error instanceof ReleaseControlClientError
          ? error.status
          : appStoreRegistryErrorStatus(error);
  const errorCode = releaseDiagnosticErrorCode(error);
  const requestId =
    error instanceof ReleaseControlClientError
      ? error.requestId
      : error instanceof AppReleaseCoordinatorError
        ? error.progress?.requestId
        : undefined;
  console.warn("app_release_request_failed", {
    error: errorCode,
    status,
    ...(requestId ? { requestId } : {}),
    ...(error instanceof ReleaseControlClientError && error.candidateStage
      ? { candidateStage: error.candidateStage }
      : {}),
    ...(progress
      ? {
          localAppId: progress.localAppId,
          packageKey: progress.packageKey,
          version: progress.version,
          phase: progress.phase,
          ...(progress.remoteIntentId ? { remoteIntentId: progress.remoteIntentId } : {}),
          ...(progress.remoteStatus ? { remoteStatus: progress.remoteStatus } : {}),
        }
      : {}),
  });
  context.sendJson(context.response, status, {
    ok: false,
    error: errorCode,
    ...(requestId ? { requestId } : {}),
    ...(error instanceof ReleaseControlClientError && error.candidateStage
      ? { candidateStage: error.candidateStage }
      : {}),
    ...(progress ? { progress } : {}),
    ...(error instanceof AppReleaseCoordinatorError && error.detail !== undefined ? { detail: error.detail } : {}),
  });
}

function releaseDiagnosticErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (error instanceof ReleaseControlClientError) return value;
  if (error instanceof AppReleaseCoordinatorError || error instanceof AppReleaseValidationError) {
    return /^[a-z][a-z0-9_]{0,159}$/.test(value) ? value : "app_release_unknown_error";
  }
  if (error instanceof AppStoreRegistryError) {
    return REGISTRY_RELEASE_ERROR_CODES.has(value) || /^registry_request_failed:[1-5][0-9]{2}$/.test(value)
      ? value
      : "app_store_registry_request_failed";
  }
  return "app_release_unknown_error";
}

const REGISTRY_RELEASE_ERROR_CODES = new Set([
  "registry_token_required",
  "registry_response_invalid",
  "app_store_package_not_found",
  "app_store_package_id_invalid",
  "app_store_version_contract_invalid",
  "app_store_host_update_required",
  "app_store_archive_unavailable",
  "app_store_archive_size_invalid",
  "app_store_archive_size_mismatch",
  "app_store_archive_checksum_invalid",
  "app_store_archive_checksum_mismatch",
  "app_store_archive_body_missing",
  "app_store_archive_transfer_timeout",
  "app_store_version_identity_mismatch",
  "app_store_version_artifact_unavailable",
]);

async function listReleaseVersions(config: { baseUrl: string; accessToken: string }, packageKey: string) {
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

function readProgressForError(
  coordinator: AppReleaseCoordinator | undefined,
): ReturnType<AppReleaseCoordinator["readProgress"]> {
  try {
    return coordinator?.readProgress();
  } catch (error) {
    console.warn("app_release_progress_read_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
