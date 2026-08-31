import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { validateEmployeePackManifestText } from "../../app-builder/manifest.js";
import { appStorePublishIdempotencyKey } from "../../app-store-publish-idempotency.js";
import { safeDiagnosticErrorCode, safeDiagnosticIdentifier } from "../../diagnostics/redaction.js";
import { restorePersistedAgentState, snapshotPersistedAgentState } from "../../storage/json-state-store.js";
import { queueAppReadinessReport } from "../app-readiness.js";
import {
  type AppStorePackageRecord,
  appStoreArchitectureSummary,
  appStoreDataRoot,
  commitUpdatedAppStorePackageInstall,
  currentAppStoreProgramsRoot,
  defaultAppStoreRoot,
  type FreshAppStorePackageInstall,
  finalizeFreshAppStorePackageInstall,
  finalizeUpdatedAppStorePackageInstall,
  getAppStorePackage,
  inspectSeparatedStoreManagedAppInstallation,
  inspectStoreManagedAppRoot,
  installAppStorePackage,
  installedAppStoreAppRefs,
  installedEmployeePackageIds,
  isValidAppStoreAppId,
  listAppStorePackages,
  packEmployeeStoreArchive,
  readAppStorePackageInstallMarker,
  recoverPublishedAppStorePublishes,
  relinkAppStorePackage,
  removeMountedAppRecords,
  repairMissingAppStorePackage,
  resolveAppStoreArchive,
  rollbackFreshAppStorePackageInstall,
  rollbackUpdatedAppStorePackageInstall,
  trashSeparatedStoreManagedAppInstallation,
  trashStoreManagedAppRoot,
  trashUnverifiedStoreManagedAppRoot,
  type UpdatedAppStorePackageInstall,
} from "../app-store.js";
import { appStoreAppDirectoryName } from "../app-store-app-id.js";
import { presentAppStoreCatalogPackages } from "../app-store-presentation.js";
import {
  appStoreRegistryErrorStatus,
  importRegistryAppStorePackageForInstall,
  listRegistryAppStorePackages,
  mergeAppStoreCatalogPackages,
  publishRegistryAppStorePackage,
  registryPublishErrorStatus,
  resolveAppStoreRegistryConfig,
} from "../app-store-registry.js";
import {
  annotateAppStoreRuntimeState,
  appStorePackageInstallSafetyError,
  inspectAppStoreMountedPackageState,
} from "../app-store-runtime-state.js";
import {
  type MountedAppVersionState,
  MountedAppVersionStateStore,
  selectedFormalVersionFromMarker,
} from "../app-version-state.js";
import { type BridgeSecurity, bridgeSessionUserHasRole, readAuthSession } from "../bridge-security.js";
import {
  getBridgeSettingsSnapshot,
  normalizeBridgeSettingsPatch,
  type RecreateBridgeAppOptions,
  recreateBridgeApp,
  saveBridgeSettings,
} from "../bridge-state.js";
import type { BridgeState } from "../bridge-types.js";
import { appStorePackageRequiresHostUpdate } from "../client-release.js";
import { resolveHostLanguageSettings } from "../language-preference.js";
import { LocalAppDraftStore } from "../local-app-drafts.js";
import { resolveMountedAppTarget } from "../mounted-apps.js";
import { recordProblem } from "../problem-records.js";
import { pipeResponseStream } from "../response-stream.js";
import { isRetiredKnowledgeVaultIdentity, isRetiredKnowledgeVaultPackage } from "../retired-apps.js";

type SendJson = (response: ServerResponse, status: number, data: unknown) => void;
type ReadJsonBody = (request: IncomingMessage) => Promise<unknown>;
type AppStorePackageVisibility = "public" | "restricted";
const MAX_PRIVATE_REGISTRY_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_METADATA_BYTES = 1024 * 1024 * 1024;
const PACKAGE_MANIFEST_FILE = ".opengrove-package-manifest.json";

export async function handleAppStoreRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  state: BridgeState;
  traceId?: string;
  security?: BridgeSecurity;
  sendJson: SendJson;
  readJsonBody: ReadJsonBody;
  activateBridgeApp?(state: BridgeState, options?: RecreateBridgeAppOptions): void;
  persistBridgeSettings?(state: BridgeState): void;
}): Promise<boolean> {
  const { request, response, url, state, traceId, security, sendJson, readJsonBody } = options;
  const activateBridgeApp = options.activateBridgeApp ?? recreateBridgeApp;
  const persistBridgeSettings = options.persistBridgeSettings ?? saveBridgeSettings;

  if (request.method === "GET" && url.pathname === "/app-store") {
    const publishRecovery = recoverPublishedAppStorePublishes(state);
    const installedSettings = state.settings;
    const config = await resolveAppStoreRegistryConfig(state, request, response, security);
    let registryCatalogError: string | undefined;
    let packages: AppStorePackageRecord[] = [];
    if (!config) {
      registryCatalogError = "registry_not_configured";
    } else {
      const installedEmployeeIds = state.app ? installedEmployeePackageIds(state) : new Set<string>();
      const installedAppRefs = installedAppStoreAppRefs(installedSettings);
      const importedPackages = listAppStorePackages(installedSettings, {
        storeRoot: appStoreDataRoot(state),
        installedEmployeePackageIds: installedEmployeeIds,
        state,
      });
      try {
        const registryPackages = await listRegistryAppStorePackages(config, request);
        packages = mergeAppStoreCatalogPackages(
          importedPackages,
          registryPackages,
          installedEmployeeIds,
          installedAppRefs,
        );
        packages = annotateAppStoreRuntimeState(packages, installedSettings, appStoreRuntimeOptions(state));
        packages = presentAppStoreCatalogPackages(
          packages,
          resolveHostLanguageSettings(state.settings),
          (appId) => resolveMountedAppTarget(state, appId)?.manifest,
        );
        packages = packages.filter((item) => !isRetiredKnowledgeVaultPackage(item));
      } catch (error) {
        registryCatalogError = error instanceof Error ? error.message : String(error);
      }
    }
    sendJson(response, 200, {
      ok: true,
      profile: state.profile,
      architecture: appStoreArchitectureSummary(),
      registryConfigured: Boolean(config),
      packages,
      registryCatalogError,
      publishRecovery: {
        recovered: publishRecovery.recovered.length,
        failed: publishRecovery.failed.length,
      },
    });
    return true;
  }

  const archiveMatch = url.pathname.match(/^\/app-store\/packages\/([^/]+)\/archive$/);
  if (request.method === "GET" && archiveMatch) {
    const packageId = decodeURIComponent(archiveMatch[1] || "");
    const item = getAppStorePackage(packageId, { storeRoot: appStoreDataRoot(state) });
    if (isRetiredKnowledgeVaultIdentity(packageId) || (item && isRetiredKnowledgeVaultPackage(item))) {
      sendJson(response, 410, { ok: false, error: "app_store_package_retired" });
      return true;
    }
    const archive = resolveAppStoreArchive({
      packageId,
      storeRoot: appStoreDataRoot(state),
    });
    if (!archive) {
      sendJson(response, 404, { ok: false, error: "app_store_archive_not_found" });
      return true;
    }
    response.writeHead(200, {
      "content-type": archive.contentType,
      "content-length": String(statSync(archive.path).size),
      "content-disposition": `attachment; filename="${archive.fileName.replace(/"/g, "")}"`,
    });
    pipeResponseStream(createReadStream(archive.path), response);
    return true;
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/app-store/publish-mounted-app" || url.pathname === "/app-store/publish-mounted-app/prepare")
  ) {
    sendJson(response, 410, {
      ok: false,
      error: "app_store_mounted_publish_gone",
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/app-store/publish-registry") {
    if (!(await requireAdminPublisher(request, response, security, sendJson))) return true;
    const config = await resolveAppStoreRegistryConfig(state, request, response, security);
    if (!config?.registryToken) {
      sendJson(response, 409, { ok: false, error: config ? "registry_token_required" : "registry_not_configured" });
      return true;
    }
    try {
      const visibilityOverride = packageVisibilityValue(url.searchParams.get("visibility"));
      if (url.searchParams.has("visibility") && !visibilityOverride) {
        sendJson(response, 400, { ok: false, error: "invalid_package_visibility" });
        return true;
      }
      const bytes = await readRequestBuffer(request, MAX_PRIVATE_REGISTRY_UPLOAD_BYTES);
      if (!bytes.length) {
        sendJson(response, 400, { ok: false, error: "archive_required" });
        return true;
      }
      const packageMetadata = readArchivePackageMetadata(bytes);
      if (isRetiredKnowledgeVaultPackage(packageMetadata)) {
        sendJson(response, 410, { ok: false, error: "app_store_package_retired" });
        return true;
      }
      if (packageMetadata.publishKind !== "employee") {
        sendJson(response, 410, {
          ok: false,
          error: "app_store_archive_publish_kind_not_supported",
        });
        return true;
      }
      const visibility = visibilityOverride ?? packageMetadata.visibility;
      const publishedPackage = await publishRegistryAppStorePackage(config, bytes, {
        fileName: url.searchParams.get("fileName") ?? request.headers["x-opengrove-file-name"]?.toString() ?? "",
        packageKey: packageMetadata.packageKey,
        visibility,
        idempotencyKey: appStorePublishIdempotencyKey({
          registryUrl: config.baseUrl,
          appId: packageMetadata.appId || packageMetadata.packageId || createHash("sha256").update(bytes).digest("hex"),
          packageId: packageMetadata.packageId,
          packageKey: packageMetadata.packageKey,
          version: packageMetadata.version || createHash("sha256").update(bytes).digest("hex"),
          visibility,
          publishKind: packageMetadata.publishKind,
        }),
      });
      sendJson(response, 200, {
        ok: true,
        package: publishedPackage,
      });
    } catch (error) {
      sendJson(response, registryPublishErrorStatus(error), {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/app-store/publish-employee") {
    if (!(await requireAdminPublisher(request, response, security, sendJson))) return true;
    const config = await resolveAppStoreRegistryConfig(state, request, response, security);
    if (!config?.registryToken) {
      sendJson(response, 409, { ok: false, error: config ? "registry_token_required" : "registry_not_configured" });
      return true;
    }
    try {
      const body = record(await readJsonBody(request));
      const session = security ? await readAuthSession(request, response, security) : undefined;
      const archive = packEmployeeStoreArchive({
        state,
        memberId: stringValue(body.memberId),
        publisher: session?.user.email || session?.user.displayName || stringValue(body.publisher) || "OpenGrove User",
        title: stringValue(body.title) || undefined,
        summary: stringValue(body.summary) || undefined,
        category: stringValue(body.category) || undefined,
      });
      const publishedPackage = await publishRegistryAppStorePackage(config, archive.bytes, {
        fileName: archive.fileName,
        packageKey: stringValue(body.packageKey),
        idempotencyKey: appStorePublishIdempotencyKey({
          registryUrl: config.baseUrl,
          appId: archive.manifest.id,
          packageId: archive.manifest.id,
          packageKey: stringValue(body.packageKey),
          version: archive.manifest.version || "0.1.0",
          publishKind: "employee",
        }),
      });
      sendJson(response, 200, {
        ok: true,
        package: publishedPackage,
      });
    } catch (error) {
      sendJson(response, registryPublishErrorStatus(error), {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/app-store/relink") {
    const body = record(await readJsonBody(request));
    const packageId = stringValue(body.packageId);
    if (!packageId) {
      sendJson(response, 400, { ok: false, error: "app_store_package_id_required" });
      return true;
    }
    if (isRetiredKnowledgeVaultIdentity(packageId)) {
      sendJson(response, 410, { ok: false, error: "app_store_package_retired" });
      return true;
    }
    try {
      const config = await resolveAppStoreRegistryConfig(state, request, response, security);
      if (!config) {
        sendJson(response, 409, { ok: false, error: "registry_not_configured" });
        return true;
      }
      const registryPackages = await listRegistryAppStorePackages(config, request);
      const item = registryPackages.find(
        (candidate) =>
          candidate.id === packageId || candidate.packageKey === packageId || candidate.packageId === packageId,
      );
      if (!item) {
        sendJson(response, 404, { ok: false, error: "app_store_package_not_found" });
        return true;
      }
      if (isRetiredKnowledgeVaultPackage(item)) {
        sendJson(response, 410, { ok: false, error: "app_store_package_retired" });
        return true;
      }
      const relink = relinkAppStorePackage({
        item,
        settings: state.settings,
        appStoreRoot: defaultAppStoreRoot(),
        programsRoot: currentAppStoreProgramsRoot(appStoreDataRoot(state)),
      });
      sendJson(response, 200, { ok: true, relink });
    } catch (error) {
      const status = appStoreRelinkErrorStatus(error);
      if (status === 409) {
        sendJson(response, status, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        sendAppInstallFailure({
          response,
          sendJson,
          state,
          traceId,
          status: appStoreRegistryErrorStatus(error),
          phase: "relink",
          error,
          packageId,
          retryable: true,
        });
      }
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/app-store/install") {
    const body = record(await readJsonBody(request));
    const packageId = stringValue(body.packageId);
    if (!packageId) {
      sendJson(response, 400, { ok: false, error: "app_store_package_id_required" });
      return true;
    }
    if (isRetiredKnowledgeVaultIdentity(packageId)) {
      sendJson(response, 410, { ok: false, error: "app_store_package_retired" });
      return true;
    }
    let item = getAppStorePackage(packageId, { storeRoot: appStoreDataRoot(state) });
    const hadImportedItem = Boolean(item);
    if (item && isRetiredKnowledgeVaultPackage(item)) {
      sendJson(response, 410, { ok: false, error: "app_store_package_retired" });
      return true;
    }
    if (item && appStorePackageRequiresHostUpdate(item.minHostReleaseNumber)) {
      sendJson(response, 409, { ok: false, error: "app_store_host_update_required" });
      return true;
    }
    const localSafetyError = item
      ? appStorePackageInstallSafetyError(item, state.settings, appStoreRuntimeOptions(state))
      : undefined;
    if (localSafetyError && !deferInstallSafetyForUnverifiedCleanup(item!, localSafetyError, state)) {
      sendJson(response, 409, { ok: false, error: localSafetyError });
      return true;
    }
    let registryPackageId = item ? item.packageKey || item.id : packageId;
    try {
      const config = await resolveAppStoreRegistryConfig(state, request, response, security);
      if (!item && config) {
        const registryPackages = await listRegistryAppStorePackages(config, request);
        item = registryPackages.find(
          (candidate) =>
            candidate.id === packageId || candidate.packageKey === packageId || candidate.packageId === packageId,
        );
        if (!item) {
          sendJson(response, 404, { ok: false, error: "app_store_package_not_found" });
          return true;
        }
        if (isRetiredKnowledgeVaultPackage(item)) {
          sendJson(response, 410, { ok: false, error: "app_store_package_retired" });
          return true;
        }
        if (appStorePackageRequiresHostUpdate(item.minHostReleaseNumber)) {
          sendJson(response, 409, { ok: false, error: "app_store_host_update_required" });
          return true;
        }
        const registrySafetyError = appStorePackageInstallSafetyError(
          item,
          state.settings,
          appStoreRuntimeOptions(state),
        );
        if (registrySafetyError && !deferInstallSafetyForUnverifiedCleanup(item, registrySafetyError, state)) {
          sendJson(response, 409, { ok: false, error: registrySafetyError });
          return true;
        }
        registryPackageId = item.packageKey || item.id;
      }
      item = await importRegistryAppStorePackageForInstall(state, request, registryPackageId, config);
    } catch (error) {
      const hostUpdateRequired = error instanceof Error && error.message === "app_store_host_update_required";
      if (!hadImportedItem || hostUpdateRequired) {
        sendAppInstallFailure({
          response,
          sendJson,
          state,
          traceId,
          status: appStoreRegistryErrorStatus(error),
          phase: "download",
          error,
          packageId,
          retryable: !hostUpdateRequired,
        });
        return true;
      }
      // Keep already-imported registry packages installable while offline; fresh catalog reads will retry.
    }
    let importedSafetyError = item
      ? appStorePackageInstallSafetyError(item, state.settings, appStoreRuntimeOptions(state))
      : undefined;
    if (importedSafetyError) {
      const cleanupState = item ? installResidualCleanupState(item, importedSafetyError, state) : undefined;
      if (cleanupState === "unsafe") {
        sendJson(response, 409, { ok: false, error: "app_store_cleanup_not_safe" });
        return true;
      }
      if (cleanupState === "unverified") {
        if (body.cleanupUnverifiedRoot !== true) {
          sendJson(response, 409, { ok: false, error: "app_store_cleanup_confirmation_required" });
          return true;
        }
        try {
          trashUnverifiedStoreManagedAppRoot(item!.appId);
        } catch (error) {
          sendAppInstallFailure({
            response,
            sendJson,
            state,
            traceId,
            status: 500,
            phase: "cleanup-residual",
            error,
            packageId,
          });
          return true;
        }
        importedSafetyError = appStorePackageInstallSafetyError(item!, state.settings, appStoreRuntimeOptions(state));
      }
    }
    if (importedSafetyError) {
      sendJson(response, 409, { ok: false, error: importedSafetyError });
      return true;
    }
    const previousSettings = normalizeBridgeSettingsPatch(state.settings, state.settings);
    const previousAgentState = snapshotPersistedAgentState(state.app, { compactVolatile: false });
    let install;
    let freshInstall: FreshAppStorePackageInstall | undefined;
    let updatedInstall: UpdatedAppStorePackageInstall | undefined;
    let previousFormalVersionState:
      | {
          localAppId: string;
          state: MountedAppVersionState | undefined;
          store: MountedAppVersionStateStore;
        }
      | undefined;
    try {
      state.store.saveFrom(state.app);
      install = installAppStorePackage({
        packageId,
        settings: state.settings,
        state,
        backupEnabled: body.backupEnabled !== false,
        storeRoot: appStoreDataRoot(state),
        onFreshAppRootCreated: (created) => {
          freshInstall = created;
        },
        onUpdatedAppRootCreated: (created) => {
          updatedInstall = created;
        },
      });
    } catch (error) {
      sendAppInstallFailure({
        response,
        sendJson,
        state,
        traceId,
        status: appStoreInstallErrorStatus(error),
        phase: appInstallFailurePhase(error),
        error,
        packageId,
      });
      return true;
    }
    if (!install) {
      sendAppInstallFailure({
        response,
        sendJson,
        state,
        traceId,
        status: 404,
        phase: "resolve-package",
        error: "app_store_package_not_found",
        packageId,
      });
      return true;
    }
    try {
      activateBridgeApp(state, {
        ...(install.packageChanged && install.appId ? { authoritativeEmployeeConfigAppId: install.appId } : {}),
        deferPersistedStateSave: true,
      });
      if (item?.publishKind === "app" && install.packageChanged) {
        const activeTarget = resolveMountedAppTarget(state, install.mountedApp?.id || install.appId);
        const selectedVersion = activeTarget
          ? selectedFormalVersionFromMarker(readAppStorePackageInstallMarker(activeTarget.appRoot))
          : undefined;
        if (!activeTarget || !selectedVersion) {
          throw new Error("app_version_formal_target_invalid");
        }
        const versionStore = new MountedAppVersionStateStore(join(appStoreDataRoot(state), "version-state"));
        previousFormalVersionState = {
          localAppId: activeTarget.localAppId,
          state: versionStore.read(activeTarget.localAppId),
          store: versionStore,
        };
        versionStore.write({
          localAppId: activeTarget.localAppId,
          activeContent: "formal",
          selectedVersion,
        });
      }
      state.store.saveFrom(state.app);
      persistBridgeSettings(state);
      if (updatedInstall) commitUpdatedAppStorePackageInstall(updatedInstall);
      if (item?.publishKind !== "employee" && install.status !== "already_installed") {
        queueAppReadinessReport({
          state,
          appId: install.mountedApp?.id || install.appId,
          notifyPm: true,
        });
      }
    } catch (error) {
      let activationError = rollbackInstallProgramAfterActivationFailure(state, freshInstall, updatedInstall, error);
      state.settings = previousSettings;
      try {
        if (previousFormalVersionState) {
          previousFormalVersionState.store.restore(
            previousFormalVersionState.localAppId,
            previousFormalVersionState.state,
          );
        }
        activateBridgeApp(state, { deferPersistedStateSave: true });
        restorePersistedAgentState(state.app, previousAgentState);
        state.store.saveFrom(state.app);
        persistBridgeSettings(state);
      } catch (rollbackError) {
        activationError = new AggregateError(
          [activationError, rollbackError],
          "app_store_install_state_rollback_failed",
        );
      }
      sendAppInstallFailure({
        response,
        sendJson,
        state,
        traceId,
        status: 500,
        phase: "activate",
        error: activationError,
        packageId,
        extra: { install },
      });
      return true;
    }
    if (freshInstall) {
      try {
        finalizeFreshAppStorePackageInstall(freshInstall);
      } catch {
        // The activated App owns the restored workspace; a stale backup is safer than failing the install.
      }
    }
    if (updatedInstall) {
      try {
        finalizeUpdatedAppStorePackageInstall(updatedInstall);
      } catch (error) {
        console.warn("app_store_update_cleanup_deferred", {
          appId: install.mountedApp?.id || install.appId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    sendJson(response, 200, {
      ok: true,
      install,
      settings: getBridgeSettingsSnapshot(state),
      message: install.status === "already_installed" ? "already_installed" : "installed",
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/app-store/uninstall") {
    const body = record(await readJsonBody(request));
    const appId = stringValue(body.appId);
    if (!appId) {
      sendJson(response, 400, { ok: false, error: "app_store_app_id_required" });
      return true;
    }
    if (!isValidAppStoreAppId(appId)) {
      sendJson(response, 400, { ok: false, error: "app_store_app_id_invalid" });
      return true;
    }
    const draftLocalAppId = resolveMountedAppTarget(state, appId)?.localAppId ?? appId;
    const previewSettings = { mountedApps: [...state.settings.mountedApps] };
    const previewRemovedMounts = removeMountedAppRecords(previewSettings, appId);
    if (!previewRemovedMounts.length) {
      sendJson(response, 404, { ok: false, error: "app_store_app_not_mounted" });
      return true;
    }
    const removedDefaultManagedPackageKeys = new Set(
      installedAppStoreAppRefs({
        mountedApps: previewRemovedMounts.map((item) => ({ ...item, enabled: true })),
      }).flatMap((item) => (item.packageKey ? [item.packageKey] : [])),
    );
    const localDraftStore = new LocalAppDraftStore(join(appStoreDataRoot(state), "local-drafts"));
    const localDraftExisted = localDraftStore.has(draftLocalAppId);
    const canonicalRoot = resolve(defaultAppStoreRoot(), appStoreAppDirectoryName(appId));
    const canonicalMounted = previewRemovedMounts.some(
      (item) => Boolean(item.path?.trim()) && resolve(item.path!) === canonicalRoot,
    );
    const separatedCandidate = previewRemovedMounts
      .map((mountedApp) => ({
        mountedApp,
        state: inspectSeparatedStoreManagedAppInstallation({
          appId,
          mountedApp,
          storeRoot: appStoreDataRoot(state),
        }),
      }))
      .find((candidate) => candidate.state !== "unsafe");
    const managedRootState = inspectStoreManagedAppRoot(appId);
    if (canonicalMounted && managedRootState === "unsafe") {
      sendJson(response, 409, { ok: false, error: "app_store_cleanup_not_safe" });
      return true;
    }
    if (canonicalMounted && managedRootState === "unverified" && body.allowUnverifiedTrash !== true) {
      sendJson(response, 409, { ok: false, error: "app_store_cleanup_confirmation_required" });
      return true;
    }
    if (separatedCandidate?.state === "unverified" && body.allowUnverifiedTrash !== true) {
      sendJson(response, 409, { ok: false, error: "app_store_cleanup_confirmation_required" });
      return true;
    }
    const previousSettings = normalizeBridgeSettingsPatch(state.settings, state.settings);
    const removedMounts = removeMountedAppRecords(state.settings, appId);
    state.settings.uninstalledStoreAppIds = [...new Set([...state.settings.uninstalledStoreAppIds, appId])];
    state.settings.defaultAppSync.managedPackageKeys = state.settings.defaultAppSync.managedPackageKeys.filter(
      (packageKey) => !removedDefaultManagedPackageKeys.has(packageKey),
    );
    try {
      activateBridgeApp(state);
      saveBridgeSettings(state);
    } catch (error) {
      state.settings = previousSettings;
      try {
        activateBridgeApp(state);
      } catch {
        // Preserve the original uninstall error; recovery can fail only if the prior runtime was already broken.
      }
      sendJson(response, 500, {
        ok: false,
        error: "app_store_uninstall_failed",
      });
      return true;
    }
    // 挂载记录已解除后再清理磁盘；清理失败必须恢复挂载，不能向用户假报成功。
    let trashedPath: string | undefined;
    try {
      if (separatedCandidate) {
        trashedPath = trashSeparatedStoreManagedAppInstallation({
          appId,
          mountedApp: separatedCandidate.mountedApp,
          storeRoot: appStoreDataRoot(state),
          allowUnverified: body.allowUnverifiedTrash === true,
        });
      } else if (managedRootState === "verified") {
        trashedPath = trashStoreManagedAppRoot(appId);
        if (!trashedPath) throw new Error("app_store_cleanup_target_changed");
      } else if (canonicalMounted && managedRootState === "unverified") {
        trashedPath = trashUnverifiedStoreManagedAppRoot(appId);
      }
    } catch (error) {
      state.settings = previousSettings;
      try {
        activateBridgeApp(state);
        saveBridgeSettings(state);
      } catch {
        // Preserve the cleanup failure. The previous settings remain the recovery source.
      }
      sendJson(response, 500, {
        ok: false,
        error: "app_store_uninstall_failed",
      });
      return true;
    }
    let localDraftDisposition: "none" | "retained" | "deleted" = localDraftExisted ? "retained" : "none";
    let localDraftDeleteError: string | undefined;
    if (body.deleteLocalDraft === true && localDraftExisted) {
      try {
        localDraftStore.delete(draftLocalAppId);
        localDraftDisposition = "deleted";
      } catch (error) {
        localDraftDeleteError = error instanceof Error ? error.message : String(error);
      }
    }
    sendJson(response, 200, {
      ok: true,
      uninstall: {
        appId,
        removedMountIds: removedMounts.map((item) => item.id),
        ...(trashedPath ? { trashedPath } : {}),
        localDraftDisposition,
        ...(localDraftDeleteError ? { localDraftDeleteError } : {}),
      },
      settings: getBridgeSettingsSnapshot(state),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/app-store/repair") {
    const body = record(await readJsonBody(request));
    const packageId = stringValue(body.packageId);
    if (!packageId) {
      sendJson(response, 400, { ok: false, error: "app_store_package_id_required" });
      return true;
    }
    if (isRetiredKnowledgeVaultIdentity(packageId)) {
      sendJson(response, 410, { ok: false, error: "app_store_package_retired" });
      return true;
    }
    let item = getAppStorePackage(packageId, { storeRoot: appStoreDataRoot(state) });
    if (item && isRetiredKnowledgeVaultPackage(item)) {
      sendJson(response, 410, { ok: false, error: "app_store_package_retired" });
      return true;
    }
    let config;
    try {
      config = await resolveAppStoreRegistryConfig(state, request, response, security);
      if (!item && config) {
        const registryPackages = await listRegistryAppStorePackages(config, request);
        item = registryPackages.find(
          (candidate) =>
            candidate.id === packageId || candidate.packageKey === packageId || candidate.packageId === packageId,
        );
      }
    } catch (error) {
      if (!item) {
        const status = appStoreRegistryErrorStatus(error);
        if (status >= 500) {
          sendAppInstallFailure({
            response,
            sendJson,
            state,
            traceId,
            status,
            phase: "repair-download",
            error,
            packageId,
            retryable: true,
          });
        } else {
          sendJson(response, status, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return true;
      }
    }
    if (!item) {
      sendJson(response, 404, { ok: false, error: "app_store_package_not_found" });
      return true;
    }
    if (isRetiredKnowledgeVaultPackage(item)) {
      sendJson(response, 410, { ok: false, error: "app_store_package_retired" });
      return true;
    }

    const preflight = inspectAppStoreMountedPackageState(item, state.settings, appStoreRuntimeOptions(state));
    if (!preflight.repairable || preflight.openIssue !== "app_root_missing") {
      sendJson(response, 409, { ok: false, error: "app_store_repair_not_available" });
      return true;
    }

    try {
      await importRegistryAppStorePackageForInstall(state, request, item.packageKey || item.id, config);
    } catch (error) {
      const cached = getAppStorePackage(packageId, { storeRoot: appStoreDataRoot(state) });
      if (!cached) {
        const status = appStoreRegistryErrorStatus(error);
        if (status >= 500) {
          sendAppInstallFailure({
            response,
            sendJson,
            state,
            traceId,
            status,
            phase: "repair-download",
            error,
            packageId,
            retryable: true,
          });
        } else {
          sendJson(response, status, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return true;
      }
    }

    let repair;
    const previousRepairSettings = normalizeBridgeSettingsPatch(state.settings, state.settings);
    const previousRepairAgentState = snapshotPersistedAgentState(state.app, { compactVolatile: false });
    try {
      state.store.saveFrom(state.app);
      repair = repairMissingAppStorePackage({
        packageId,
        settings: state.settings,
        storeRoot: appStoreDataRoot(state),
      });
      if (!repair) {
        sendJson(response, 404, { ok: false, error: "app_store_package_not_found" });
        return true;
      }
    } catch (error) {
      const status = appStoreRepairErrorStatus(error);
      if (status === 409) {
        sendJson(response, status, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        sendAppInstallFailure({
          response,
          sendJson,
          state,
          traceId,
          status,
          phase: "repair",
          error,
          packageId,
        });
      }
      return true;
    }
    try {
      activateBridgeApp(state, {
        deferPersistedStateSave: true,
        agentStateSnapshot: previousRepairAgentState,
      });
      state.store.saveFrom(state.app);
      persistBridgeSettings(state);
      queueAppReadinessReport({ state, appId: repair.appId, notifyPm: true });
    } catch (error) {
      let activationError = rollbackInstallProgramAfterActivationFailure(state, repair, undefined, error);
      state.settings = previousRepairSettings;
      try {
        activateBridgeApp(state, {
          deferPersistedStateSave: true,
          agentStateSnapshot: previousRepairAgentState,
        });
        restorePersistedAgentState(state.app, previousRepairAgentState);
        state.store.saveFrom(state.app);
        persistBridgeSettings(state);
      } catch (rollbackError) {
        activationError = new AggregateError(
          [activationError, rollbackError],
          "app_store_repair_state_rollback_failed",
        );
      }
      sendAppInstallFailure({
        response,
        sendJson,
        state,
        traceId,
        status: 500,
        phase: "repair-activate",
        error: activationError,
        packageId,
        extra: { repair },
      });
      return true;
    }
    sendJson(response, 200, { ok: true, repair });
    return true;
  }

  return false;
}

function rollbackInstallProgramAfterActivationFailure(
  state: BridgeState,
  freshInstall: FreshAppStorePackageInstall | undefined,
  updatedInstall: UpdatedAppStorePackageInstall | undefined,
  activationError: unknown,
): unknown {
  try {
    if (freshInstall) {
      rollbackFreshAppStorePackageInstall({
        ...freshInstall,
        storeRoot: appStoreDataRoot(state),
      });
    }
    if (updatedInstall) {
      rollbackUpdatedAppStorePackageInstall({
        ...updatedInstall,
        storeRoot: appStoreDataRoot(state),
      });
    }
    return activationError;
  } catch (rollbackError) {
    return new AggregateError([activationError, rollbackError], "app_store_install_rollback_failed");
  }
}

function appStoreRuntimeOptions(state: BridgeState) {
  return {
    appStoreRoot: defaultAppStoreRoot(),
    programsRoot: currentAppStoreProgramsRoot(appStoreDataRoot(state)),
  };
}

function appStoreRepairErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return new Set([
    "app_store_repair_not_available",
    "app_store_repair_in_progress",
    "app_store_install_target_changed",
  ]).has(message)
    ? 409
    : 500;
}

function appStoreRelinkErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return new Set(["app_store_relink_not_available", "app_store_source_conflict"]).has(message)
    ? 409
    : appStoreRegistryErrorStatus(error);
}

function deferInstallSafetyForUnverifiedCleanup(
  item: AppStorePackageRecord,
  error: string,
  state: BridgeState,
): boolean {
  return installResidualCleanupState(item, error, state) !== undefined;
}

function installResidualCleanupState(
  item: AppStorePackageRecord,
  error: string,
  state: BridgeState,
): "unverified" | "unsafe" | undefined {
  if (error !== "app_store_update_not_safe" || item.publishKind !== "app") return undefined;
  const mountedState = inspectAppStoreMountedPackageState(item, state.settings, appStoreRuntimeOptions(state));
  if (mountedState.installed) return undefined;
  const rootState = inspectStoreManagedAppRoot(item.appId);
  return rootState === "unverified" || rootState === "unsafe" ? rootState : undefined;
}

function appStoreInstallErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return new Set([
    "app_store_repair_required",
    "app_store_relink_required",
    "app_store_source_conflict",
    "app_store_update_not_safe",
    "app_store_host_update_required",
    "app_store_install_target_changed",
    "app_store_cleanup_not_safe",
    "app_store_cleanup_confirmation_required",
    "app_store_cleanup_target_changed",
  ]).has(message)
    ? 409
    : 500;
}

function sendAppInstallFailure(input: {
  response: ServerResponse;
  sendJson: SendJson;
  state: BridgeState;
  traceId?: string;
  status: number;
  phase: string;
  error: unknown;
  packageId: string;
  retryable?: boolean;
  extra?: Record<string, unknown>;
}): void {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const inferredCode = safeDiagnosticErrorCode(message);
  const phase = (safeDiagnosticIdentifier(input.phase, 40) ?? "unknown").replaceAll("-", "_");
  const problem = recordProblem(input.state, {
    traceId: input.traceId,
    category: "app-install",
    phase: input.phase,
    code: inferredCode === "unknown_error" ? `app_install_${phase}_failed` : inferredCode,
    error: input.error,
    retryable: input.retryable,
    context: { packageId: input.packageId },
  });
  input.sendJson(input.response, input.status, {
    ok: false,
    error: message,
    incidentId: problem.incidentId,
    traceId: problem.traceId,
    ...input.extra,
  });
}

function appInstallFailurePhase(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/archive|tar|unpack|symlink|entry_type|file_count|too_large/.test(message)) return "unpack";
  if (/manifest|package_invalid|not_valid/.test(message)) return "validate";
  return "install";
}

async function requireAdminPublisher(
  request: IncomingMessage,
  response: ServerResponse,
  security: BridgeSecurity | undefined,
  sendJson: SendJson,
): Promise<boolean> {
  const session = security ? await readAuthSession(request, response, security) : undefined;
  if (bridgeSessionUserHasRole(session?.user, "admin")) return true;
  sendJson(response, 403, { ok: false, error: "admin_required" });
  return false;
}

function readArchivePackageMetadata(bytes: Buffer): {
  appId?: string;
  packageId?: string;
  packageKey?: string;
  publishKind?: string;
  version?: string;
  visibility?: AppStorePackageVisibility;
} {
  try {
    const manifest = readTarPackageManifest(bytes);
    const declaredPublishKind = stringValue(manifest.publishKind) || undefined;
    const validatedEmployeeManifest =
      !declaredPublishKind || declaredPublishKind === "employee"
        ? readStrictEmployeeArchiveManifest(bytes, manifest)
        : undefined;
    const publishKind =
      declaredPublishKind === "employee"
        ? validatedEmployeeManifest
          ? "employee"
          : undefined
        : (declaredPublishKind ?? (validatedEmployeeManifest ? "employee" : undefined));
    return {
      appId: stringValue(manifest.appId) || validatedEmployeeManifest?.id || undefined,
      packageId: stringValue(manifest.packageId) || validatedEmployeeManifest?.id || undefined,
      packageKey: stringValue(manifest.packageKey) || undefined,
      publishKind,
      version: stringValue(manifest.version) || validatedEmployeeManifest?.version || undefined,
      visibility: packageVisibility({ store: record(manifest.store) }),
    };
  } catch {
    return {};
  }
}

function readStrictEmployeeArchiveManifest(bytes: Buffer, packageManifest: Record<string, unknown>) {
  if (packageManifest.schemaVersion !== 1) return undefined;
  const tarBytes = looksLikeGzip(bytes) ? gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_METADATA_BYTES }) : bytes;
  const packageManifestEntries: Array<{ name: string; bytes: Buffer }> = [];
  const employeeManifestEntries: Array<{ name: string; bytes: Buffer }> = [];
  let containsAppManifest = false;
  let offset = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = normalizeArchiveEntryName(readTarString(header, 0, 100), readTarString(header, 345, 155));
    const size = readTarOctal(header, 124, 12);
    const regularFile = header[156] === 0 || header[156] === 0x30;
    const bodyOffset = offset + 512;
    const nextOffset = bodyOffset + Math.ceil(size / 512) * 512;
    if (regularFile && bodyOffset + size <= tarBytes.length) {
      const entryBytes = tarBytes.subarray(bodyOffset, bodyOffset + size);
      if (name === PACKAGE_MANIFEST_FILE || name.endsWith(`/${PACKAGE_MANIFEST_FILE}`)) {
        packageManifestEntries.push({ name, bytes: entryBytes });
      } else if (name === "employee.json" || name.endsWith("/employee.json")) {
        employeeManifestEntries.push({ name, bytes: entryBytes });
      } else if (
        name === "opengrove.app.json" ||
        name.endsWith("/opengrove.app.json") ||
        name === "opengrove.app.jsonc" ||
        name.endsWith("/opengrove.app.jsonc")
      ) {
        containsAppManifest = true;
      }
    }
    offset = nextOffset;
  }
  if (containsAppManifest || packageManifestEntries.length !== 1 || employeeManifestEntries.length !== 1) {
    return undefined;
  }
  const packageEntry = packageManifestEntries[0]!;
  const employeeEntry = employeeManifestEntries[0]!;
  const packageRoot = packageEntry.name.slice(0, -PACKAGE_MANIFEST_FILE.length).replace(/\/$/, "");
  const employeeRoot = employeeEntry.name.slice(0, -"employee.json".length).replace(/\/$/, "");
  if (packageRoot !== employeeRoot) return undefined;
  const validated = validateEmployeePackManifestText(employeeEntry.bytes.toString("utf8"));
  if (!validated.ok || !validated.manifest) return undefined;
  const employeeManifest = validated.manifest;
  const packageId = stringValue(packageManifest.packageId);
  const appId = stringValue(packageManifest.appId);
  const packageVersion = stringValue(packageManifest.version);
  const employeeVersion = employeeManifest.version || "0.1.0";
  if (
    !packageId ||
    packageId !== employeeManifest.id ||
    appId !== employeeManifest.id ||
    packageVersion !== employeeVersion
  ) {
    return undefined;
  }
  const employeeDigest = record(packageManifest.files)["employee.json"];
  if (employeeDigest !== `sha256:${createHash("sha256").update(employeeEntry.bytes).digest("hex")}`) {
    return undefined;
  }
  return employeeManifest;
}

function readTarPackageManifest(bytes: Buffer): Record<string, unknown> {
  return readTarJsonEntry(bytes, PACKAGE_MANIFEST_FILE);
}

function readTarJsonEntry(bytes: Buffer, targetName: string): Record<string, unknown> {
  const tarBytes = looksLikeGzip(bytes) ? gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_METADATA_BYTES }) : bytes;
  let offset = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = normalizeArchiveEntryName(readTarString(header, 0, 100), readTarString(header, 345, 155));
    const size = readTarOctal(header, 124, 12);
    const regularFile = header[156] === 0 || header[156] === 0x30;
    const bodyOffset = offset + 512;
    const nextOffset = bodyOffset + Math.ceil(size / 512) * 512;
    if (
      regularFile &&
      (name === targetName || name.endsWith(`/${targetName}`)) &&
      size <= 4 * 1024 * 1024 &&
      bodyOffset + size <= tarBytes.length
    ) {
      return record(JSON.parse(tarBytes.subarray(bodyOffset, bodyOffset + size).toString("utf8")));
    }
    offset = nextOffset;
  }
  return {};
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  const raw = buffer.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw
    .subarray(0, end >= 0 ? end : raw.length)
    .toString("utf8")
    .trim();
}

function readTarOctal(buffer: Buffer, start: number, length: number): number {
  const text = readTarString(buffer, start, length).replace(/\0/g, "").trim();
  const parsed = Number.parseInt(text || "0", 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeArchiveEntryName(name: string, prefix: string): string {
  const joined = `${prefix ? `${prefix}/` : ""}${name}`.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = joined.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) return "";
  return parts.join("/");
}

function looksLikeGzip(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function packageVisibility(manifest: Record<string, unknown>): AppStorePackageVisibility | undefined {
  return packageVisibilityValue(record(manifest.store).visibility || manifest.visibility);
}

function packageVisibilityValue(input: unknown): AppStorePackageVisibility | undefined {
  const value = stringValue(input).toLowerCase();
  return value === "public" || value === "restricted" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

async function readRequestBuffer(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("app_store_upload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
