import type { IncomingMessage, ServerResponse } from "node:http";
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
import { record } from "../http-utils.js";
import type { MountedAppTarget } from "../mounted-apps.js";
import { resolveReleaseControlConfig } from "../release-control-config.js";

interface AppReleaseRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  state: BridgeState;
  security?: BridgeSecurity;
  sendJson(response: ServerResponse, status: number, data: unknown): void;
  readJsonBody(request: IncomingMessage): Promise<unknown>;
}

export async function handleMountedAppReleaseRoute(
  context: AppReleaseRouteContext,
  target: MountedAppTarget,
  routePath: string,
): Promise<void> {
  if (routePath === "prepare") {
    if (context.request.method !== "GET") {
      context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (!(await isAdmin(context))) return;
    const config = await resolveReleaseControlConfig(
      context.state,
      context.request,
      context.response,
      context.security,
    );
    if (!config) {
      context.sendJson(context.response, 409, {
        ok: false,
        error: "release_control_not_configured",
      });
      return;
    }
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
    return;
  }
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
  if (!routePath && context.request.method === "GET") {
    if (!(await isAdmin(context))) return;
    const config = await resolveReleaseControlConfig(
      context.state,
      context.request,
      context.response,
      context.security,
    );
    if (!config) {
      context.sendJson(context.response, 409, {
        ok: false,
        error: "release_control_not_configured",
      });
      return;
    }
    try {
      const progress = createReleaseCoordinator(context, target, config).readProgress();
      if (!progress) {
        throw new AppReleaseCoordinatorError("app_store_publish_journal_missing", 404);
      }
      context.sendJson(context.response, 200, { ok: true, progress });
    } catch (error) {
      sendReleaseError(context, error);
    }
    return;
  }
  if (routePath === "status") {
    if (context.request.method !== "GET") {
      context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (!(await isAdmin(context))) return;
    const config = await resolveReleaseControlConfig(
      context.state,
      context.request,
      context.response,
      context.security,
    );
    if (!config) {
      context.sendJson(context.response, 409, {
        ok: false,
        error: "release_control_not_configured",
      });
      return;
    }
    try {
      const progress = await createReleaseCoordinator(context, target, config).refreshRemoteProgress();
      context.sendJson(context.response, 200, { ok: true, progress });
    } catch (error) {
      sendReleaseError(context, error);
    }
    return;
  }
  if (
    (!routePath && context.request.method !== "POST") ||
    ((routePath === "reconcile" || routePath === "keep-local" || routePath === "abandon") &&
      context.request.method !== "POST")
  ) {
    context.sendJson(context.response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (routePath && routePath !== "reconcile" && routePath !== "keep-local" && routePath !== "abandon") {
    context.sendJson(context.response, 404, { ok: false, error: "app_release_route_not_found" });
    return;
  }
  if (!(await isAdmin(context))) return;
  if (routePath === "keep-local") {
    try {
      const progress = resolveAppReleaseKeepLocalChanges({
        state: context.state,
        target,
      });
      context.sendJson(context.response, 200, { ok: true, progress });
    } catch (error) {
      sendReleaseError(context, error);
    }
    return;
  }
  const config = await resolveReleaseControlConfig(context.state, context.request, context.response, context.security);
  if (!config) {
    context.sendJson(context.response, 409, {
      ok: false,
      error: "release_control_not_configured",
    });
    return;
  }
  const coordinator = createReleaseCoordinator(context, target, config);
  const localBuildAbort = new AbortController();
  const abortLocalBuild = () => localBuildAbort.abort();
  if (!routePath) {
    context.response.once("close", abortLocalBuild);
  }
  try {
    const body = record(await context.readJsonBody(context.request));
    const progress =
      routePath === "reconcile"
        ? await coordinator.resume({ retryFailedBuild: body.retryFailedBuild === true })
        : routePath === "abandon"
          ? await coordinator.endBlockedRelease()
          : await coordinator.start({
              release: body.release,
              applyToCurrentApp: body.applyToCurrentApp === true,
              signal: localBuildAbort.signal,
            });
    context.sendJson(context.response, progress.state === "published" ? 200 : 202, { ok: true, progress });
  } catch (error) {
    sendReleaseError(context, error, coordinator);
  } finally {
    context.response.off("close", abortLocalBuild);
  }
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
