import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clearCommandVersionCache, resolveCommandInvocation } from "../../kernel/discovery.js";
import { applyKernelProxyEnv, resolveKernelProxySettings } from "../../runtime/kernel-proxy.js";
import { defaultOpenGroveWorkspacesDir } from "../../storage/default-data-dir.js";
import { readAppEnv } from "../../identity.js";
import { beginBridgeRunMaintenance, endBridgeRunMaintenance } from "../active-runs.js";
import {
  appStoreDataRoot,
  cleanupUnreferencedAppStoreProgramGenerations,
  currentAppStoreProgramsRoot,
  defaultAppStoreRoot,
  inspectUnreferencedAppStoreProgramGenerations,
} from "../app-store.js";
import { mountedAppWorkspaceBindingIssue } from "../app-store-runtime-state.js";
import type { BridgeSecurity } from "../bridge-security.js";
import {
  getBridgeSettingsSnapshot,
  normalizeBridgeSettingsPatch,
  recreateBridgeApp,
  saveBridgeSettings,
  syncMountedAppGroupPresentations,
  syncMountedAppMemberPresentations,
  syncNumberedGroupPresentations,
} from "../bridge-state.js";
import { BRIDGE_KERNEL_IDS, type BridgeKernelId, type BridgeSettings, type BridgeState } from "../bridge-types.js";
import {
  describeKernelLogins,
  kernelLoginRouteProfiles,
  kernelLoginSession,
  startKernelLoginAction,
} from "../kernel-login.js";
import { getBridgeRuntimeControls, getBridgeRuntimeControlsByKernel } from "../kernel-selection.js";
import { resolveHostLanguageSettings } from "../language-preference.js";
import { migrateMountedAppManifestV1 } from "../migrations/app-manifest-v1.js";
import { mountedAppManifestIssue, readMountedAppManifest, resolveMountedAppWorkspaceRoot } from "../mounted-apps.js";
import { legacyAppStoreRoot, storeAppLayoutV2ProgramRoots } from "../migrations/store-app-layout-v2.js";
import { refreshOpenClawGatewayProviders } from "../openclaw-provider-discovery.js";
import { refreshProviderModelDiscovery } from "../provider-model-discovery.js";
import { getAllBridgeProviderProfiles, getBridgeProviderModelCatalog } from "../provider-profiles.js";
import { bridgeDataPath, bridgeUserDataDirectory } from "../storage-paths.js";
import { applyProviderSetupMigration } from "../system-provider-discovery.js";
import { inspectOpenGroveStorage } from "../storage-overview.js";

type SendJson = (response: ServerResponse, status: number, data: unknown) => void;
type ReadJsonBody = (request: IncomingMessage) => Promise<unknown>;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export async function handleSettingsRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  state: BridgeState;
  security?: BridgeSecurity;
  sendJson: SendJson;
  readJsonBody: ReadJsonBody;
}): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = options;
  if (request.method === "GET" && url.pathname === "/settings") {
    // Settings must render from the last known catalog immediately. Discovery
    // also runs at startup and every six hours; this call only nudges a refresh.
    void refreshOpenClawGatewayProviders(state);
    sendJson(
      response,
      200,
      bridgeSettingsPayload(state, {
        ok: true,
      }),
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/settings/provider-models") {
    sendJson(response, 200, {
      ok: true,
      providers: [
        ...getBridgeProviderModelCatalog(state.settings.customProviders),
        ...kernelLoginRouteProfiles(state).map((profile) => ({ id: profile.id, models: profile.models })),
      ],
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/settings/kernel-logins") {
    sendJson(response, 200, {
      ok: true,
      logins: await describeKernelLogins(state),
    });
    return true;
  }

  const loginAction = kernelLoginActionFromPath(url.pathname);
  if (request.method === "POST" && loginAction) {
    try {
      const session = startKernelLoginAction(state, loginAction.kernelId, loginAction.action);
      sendJson(response, 202, { ok: true, session });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const loginSessionId = kernelLoginSessionIdFromPath(url.pathname);
  if (request.method === "GET" && loginSessionId) {
    const session = kernelLoginSession(loginSessionId);
    sendJson(
      response,
      session ? 200 : 404,
      session ? { ok: true, session } : { ok: false, error: "kernel_login_session_not_found" },
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/settings/storage") {
    const stats = state.store.storageStats?.() ?? {
      kind: state.store.kind,
      databaseBytes: 0,
      blobBytes: 0,
      orphanBlobBytes: 0,
      migrationBackupBytes: 0,
      categories: [],
    };
    const overview = await inspectOpenGroveStorage({
      roots: {
        userDataDir: bridgeUserDataDirectory(state),
        programRoots: storeAppLayoutV2ProgramRoots({
          storeRoot: appStoreDataRoot(state),
          currentProgramsRoot: currentAppStoreProgramsRoot(appStoreDataRoot(state)),
        }),
        currentWorkspacesRoot: defaultOpenGroveWorkspacesDir(),
        legacyAppsRoot: legacyAppStoreRoot(),
        externalWorkspaceRoots: storageWorkspaceDirectories(state),
        appStoreRoots: [appStoreDataRoot(state)],
        updaterCacheDir: readAppEnv("UPDATER_CACHE_DIR")?.trim(),
      },
      orphanBlobBytes: stats.orphanBlobBytes,
      rebuildableFilePaths: [bridgeDataPath(state, "provider-models-cache.json")],
    });
    const programCleanup = inspectUnreferencedAppStoreProgramGenerations(appStoreDataRoot(state), state.settings);
    sendJson(response, 200, {
      ok: true,
      stats,
      overview,
      cleanupEstimates: {
        unreferencedFilesBytes: stats.orphanBlobBytes + programCleanup.reclaimableBytes,
        rebuildableBytes: overview.categories.find((category) => category.id === "rebuildable")?.bytes ?? 0,
        migrationBackupBytes: stats.migrationBackupBytes,
      },
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/settings/storage/maintenance/start") {
    const admission = beginBridgeRunMaintenance(state);
    if (!admission.ok) {
      const error =
        admission.error === "storage_maintenance_active_runs"
          ? `desktop_storage_maintenance_active_runs:${admission.activeRuns}`
          : "desktop_storage_maintenance_in_progress";
      sendJson(response, 409, { ok: false, error, activeRuns: admission.activeRuns });
      return true;
    }
    sendJson(response, 200, { ok: true, leaseId: admission.leaseId });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/settings/storage/maintenance/end") {
    const payload = record(await readJsonBody(request));
    const leaseId = stringValue(payload.leaseId);
    const released = endBridgeRunMaintenance(state, leaseId ?? "");
    sendJson(response, released ? 200 : 409, {
      ok: released,
      ...(released ? {} : { error: "desktop_storage_maintenance_lease_invalid" }),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/settings/storage/cleanup") {
    const blobCleanup = state.store.cleanupOrphanedBlobs?.() ?? { removedBlobs: 0, reclaimedBytes: 0 };
    const programCleanup = cleanupUnreferencedAppStoreProgramGenerations(appStoreDataRoot(state), state.settings);
    const cleanup = {
      removedBlobs: blobCleanup.removedBlobs,
      removedProgramGenerations: programCleanup.removed.length,
      reclaimedBytes: blobCleanup.reclaimedBytes + programCleanup.reclaimedBytes,
    };
    sendJson(response, 200, {
      ok: true,
      cleanup,
      stats: state.store.storageStats?.(),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/settings/storage/clear-history") {
    const payload = record(await readJsonBody(request));
    const scope = stringValue(payload.scope);
    if (scope === "runtime-events") {
      const activeRun = state.app.sessions
        .listRuns()
        .some(
          (run) =>
            run.status === "running" || run.status === "waiting_for_approval" || run.status === "waiting_for_user",
        );
      if (activeRun) {
        sendJson(response, 409, { ok: false, error: "history_clear_blocked_by_active_run" });
        return true;
      }
      const removed =
        state.store.clearRuntimeEventArchive?.() ?? state.app.events.list().length + state.app.executions.list().length;
      state.app.events.clear();
      state.app.executions.clear();
      state.store.saveFrom(state.app);
      const cleanup = state.store.cleanupOrphanedBlobs?.();
      sendJson(response, 200, { ok: true, scope, removed, cleanup, stats: state.store.storageStats?.() });
      return true;
    }
    if (scope === "room-event-archive") {
      const before = state.store.clearRoomEventArchive?.() ?? 0;
      // Reinsert only the in-memory hot delivery window. Messages remain in the
      // authoritative message collection and are never deleted by this action.
      state.store.saveFrom(state.app);
      const retained = state.app.rooms.snapshot().events.length;
      const cleanup = state.store.cleanupOrphanedBlobs?.();
      sendJson(response, 200, {
        ok: true,
        scope,
        removed: Math.max(0, before - retained),
        cleanup,
        stats: state.store.storageStats?.(),
      });
      return true;
    }
    if (scope === "rebuildable-caches") {
      clearCommandVersionCache();
      const toolSchemaCacheEntries = Object.keys(state.app.workingState.get().toolSchemaCache).length;
      state.app.workingState.update({ toolSchemaCache: {} });
      const providerModelsCache = bridgeDataPath(state, "provider-models-cache.json");
      const removedProviderCache = existsSync(providerModelsCache);
      if (removedProviderCache) unlinkSync(providerModelsCache);
      state.store.saveFrom(state.app);
      sendJson(response, 200, {
        ok: true,
        scope,
        removed: toolSchemaCacheEntries + Number(removedProviderCache),
        stats: state.store.storageStats?.(),
      });
      return true;
    }
    if (scope === "migration-backups") {
      const cleanup = state.store.clearMigrationBackups?.() ?? { removedFiles: 0, reclaimedBytes: 0 };
      sendJson(response, 200, {
        ok: true,
        scope,
        removed: cleanup.removedFiles,
        cleanup,
        stats: state.store.storageStats?.(),
      });
      return true;
    }
    sendJson(response, 400, { ok: false, error: "unknown_history_clear_scope" });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/settings/install-kernel") {
    const payload = record(await readJsonBody(request));
    const kernelId = stringValue(payload.kernelId);
    const actionId = stringValue(payload.actionId);
    const action = findKernelInstallAction(state, kernelId, actionId);
    if (!action) {
      sendJson(response, 404, { ok: false, error: "install_action_not_found" });
      return true;
    }
    if (!Array.isArray(action.command) || action.command.length === 0) {
      sendJson(response, 400, { ok: false, error: "install_command_missing" });
      return true;
    }

    const startedAt = new Date().toISOString();
    try {
      const result = await runInstallCommand(action.command, {
        cwd: stringValue(action.cwd),
        env: applyKernelProxyEnv(
          { ...process.env },
          resolveKernelProxySettings(state.settings.kernelProxy, process.env),
        ),
      });
      clearCommandVersionCache();
      let runtimeRefreshError: string | undefined;
      try {
        recreateBridgeApp(state);
      } catch (error) {
        runtimeRefreshError = error instanceof Error ? error.message : String(error);
      }
      sendJson(
        response,
        200,
        bridgeSettingsPayload(state, {
          ok: true,
          degraded: Boolean(runtimeRefreshError),
          ...(runtimeRefreshError ? { warning: "runtime_refresh_failed", runtimeRefreshError } : {}),
          kernelId,
          actionId: action.id,
          command: action.command,
          startedAt,
          finishedAt: new Date().toISOString(),
          ...result,
        }),
      );
    } catch (error) {
      clearCommandVersionCache();
      sendJson(
        response,
        500,
        bridgeSettingsPayload(state, {
          ok: false,
          kernelId,
          actionId: action.id,
          command: action.command,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return true;
  }

  if (request.method !== "PATCH" || url.pathname !== "/settings") {
    return false;
  }

  const previousSettings = state.settings;
  const patchPayload = await readJsonBody(request);
  const patchRecord = record(patchPayload);
  const nestedSettings = record(patchRecord.settings);
  const patchSource = Object.keys(nestedSettings).length > 0 ? nestedSettings : patchRecord;
  let nextSettings = applyProviderSetupMigration(normalizeBridgeSettingsPatch(patchPayload, previousSettings));
  if (previousSettings.appUpdates.automatic === false && nextSettings.appUpdates.automatic === true) {
    // The renderer invalidates its authenticated client-update query after this
    // save; dropping the cursor makes that request perform an immediate check.
    nextSettings.appUpdates = { automatic: true };
  }
  const removedProviderIds = Object.prototype.hasOwnProperty.call(patchSource, "customProviders")
    ? removedProviderIdsBetween(previousSettings, nextSettings)
    : new Set<string>();
  const mountedAppPolicyIssue = Object.prototype.hasOwnProperty.call(patchSource, "mountedApps")
    ? nextSettings.mountedApps
        .filter((app) => app.enabled !== false && Boolean(app.path?.trim()))
        .filter((app) => mountedAppNeedsPolicyValidation(previousSettings.mountedApps, app))
        .map((app) => {
          const migration = migrateMountedAppManifestV1(app.path!);
          const manifestIssue =
            migration.status === "failed"
              ? "app_manifest_migration_failed"
              : mountedAppManifestIssue(app.path!, readMountedAppManifest(app.path!));
          const issue =
            manifestIssue ??
            mountedAppWorkspaceBindingIssue(app, {
              appStoreRoot: defaultAppStoreRoot(),
              programsRoot: currentAppStoreProgramsRoot(bridgeDataPath(state, "app-store")),
            });
          return { app, issue };
        })
        .find((candidate) => candidate.issue)
    : undefined;
  if (mountedAppPolicyIssue) {
    sendJson(
      response,
      422,
      bridgeSettingsPayload(state, {
        ok: false,
        error: mountedAppPolicyIssue.issue,
        appId: mountedAppPolicyIssue.app.id,
      }),
    );
    return true;
  }
  nextSettings = clearRemovedProviderSettingsReferences(nextSettings, removedProviderIds);
  const providerConfigChanged =
    JSON.stringify(nextSettings.modelProviderBindings) !== JSON.stringify(previousSettings.modelProviderBindings) ||
    JSON.stringify(nextSettings.customProviders) !== JSON.stringify(previousSettings.customProviders);
  const presentationLanguageChanged =
    resolveHostLanguageSettings(nextSettings) !== resolveHostLanguageSettings(previousSettings);
  const restartRequired =
    nextSettings.kernel !== previousSettings.kernel ||
    nextSettings.workspaceRoot !== previousSettings.workspaceRoot ||
    JSON.stringify(nextSettings.mountedApps) !== JSON.stringify(previousSettings.mountedApps) ||
    JSON.stringify(nextSettings.kernelProxy) !== JSON.stringify(previousSettings.kernelProxy) ||
    JSON.stringify(nextSettings.kernelPathOverrides) !== JSON.stringify(previousSettings.kernelPathOverrides) ||
    providerConfigChanged;

  if (!restartRequired) {
    state.settings = nextSettings;
    if (presentationLanguageChanged) {
      const memberPresentationChanged = syncMountedAppMemberPresentations(state);
      const groupPresentationChanged = syncMountedAppGroupPresentations(state);
      const numberedGroupPresentationChanged = syncNumberedGroupPresentations(state);
      if (memberPresentationChanged || groupPresentationChanged || numberedGroupPresentationChanged) {
        state.store.saveFrom(state.app);
      }
    }
    saveBridgeSettings(state);
    sendJson(
      response,
      200,
      bridgeSettingsPayload(state, {
        ok: true,
        restarted: false,
      }),
    );
    return true;
  }

  state.store.saveFrom(state.app);
  state.settings = nextSettings;
  try {
    recreateBridgeApp(state);
    saveBridgeSettings(state);
    if (clearRemovedProviderEmployeeOverrides(state, removedProviderIds)) {
      state.store.saveFrom(state.app);
    }
    if (providerConfigChanged) {
      // 新绑定/新 key 立即拉一次模型名单,不等 TTL。
      void refreshProviderModelDiscovery({
        profiles: getAllBridgeProviderProfiles(state.settings.customProviders),
        force: true,
      });
    }
  } catch (error) {
    state.settings = previousSettings;
    let rollbackError: string | undefined;
    try {
      recreateBridgeApp(state);
    } catch (recoveryError) {
      rollbackError = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
    }
    sendJson(
      response,
      400,
      bridgeSettingsPayload(state, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(rollbackError ? { rollbackError } : {}),
      }),
    );
    return true;
  }

  sendJson(
    response,
    200,
    bridgeSettingsPayload(state, {
      ok: true,
      restarted: true,
    }),
  );
  return true;
}

function kernelLoginActionFromPath(pathname: string):
  | {
      kernelId: BridgeKernelId;
      action: "login" | "logout";
    }
  | undefined {
  const match = pathname.match(/^\/settings\/kernel-logins\/([^/]+)\/(login|logout)$/);
  const kernelId = match?.[1];
  if (!kernelId || !(BRIDGE_KERNEL_IDS as readonly string[]).includes(kernelId)) return undefined;
  return { kernelId: kernelId as BridgeKernelId, action: match[2] as "login" | "logout" };
}

function kernelLoginSessionIdFromPath(pathname: string): string | undefined {
  return pathname.match(/^\/settings\/kernel-login-sessions\/([0-9a-f-]{36})$/i)?.[1];
}

function removedProviderIdsBetween(
  previousSettings: BridgeState["settings"],
  nextSettings: BridgeState["settings"],
): Set<string> {
  const nextProviderIds = new Set(
    getAllBridgeProviderProfiles(nextSettings.customProviders).map((provider) => provider.id),
  );
  return new Set(
    getAllBridgeProviderProfiles(previousSettings.customProviders)
      .map((provider) => provider.id)
      .filter((providerId) => !nextProviderIds.has(providerId)),
  );
}

export function clearRemovedProviderSettingsReferences(
  nextSettings: BridgeSettings,
  removedProviderIds: ReadonlySet<string>,
): BridgeSettings {
  if (!removedProviderIds.size) return nextSettings;
  return {
    ...nextSettings,
    modelProviderBindings: nextSettings.modelProviderBindings.filter(
      (binding) => !removedProviderIds.has(binding.providerId),
    ),
  };
}

function clearRemovedProviderEmployeeOverrides(state: BridgeState, removedProviderIds: ReadonlySet<string>): boolean {
  if (!removedProviderIds.size) return false;
  let changed = false;
  for (const member of state.app.rooms.listMembers()) {
    if (!member.providerId || !removedProviderIds.has(member.providerId)) continue;
    const userOverrides = member.userOverrides?.filter((field) => field !== "providerId");
    state.app.rooms.patchMember(member.id, {
      providerId: undefined,
      userOverrides: userOverrides?.length ? userOverrides : undefined,
    });
    changed = true;
  }
  return changed;
}

function mountedAppNeedsPolicyValidation(
  previousApps: BridgeState["settings"]["mountedApps"],
  nextApp: BridgeState["settings"]["mountedApps"][number],
): boolean {
  const previous = previousApps.find((candidate) => candidate.id === nextApp.id);
  return (
    !previous ||
    previous.enabled === false ||
    previous.path?.trim() !== nextApp.path?.trim() ||
    previous.workspacePath?.trim() !== nextApp.workspacePath?.trim()
  );
}

function bridgeSettingsPayload(state: BridgeState, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    settings: getBridgeSettingsSnapshot(state),
    runtimeControls: getBridgeRuntimeControls(state),
    runtimeControlsByKernel: getBridgeRuntimeControlsByKernel(state),
  };
}

function findKernelInstallAction(
  state: BridgeState,
  kernelId: string | undefined,
  actionId: string | undefined,
): Record<string, unknown> | undefined {
  if (!kernelId || !actionId) {
    return undefined;
  }
  const settings = getBridgeSettingsSnapshot(state);
  const kernels = Array.isArray(settings.kernels) ? settings.kernels : [];
  const kernel = kernels.find((item) => record(item).id === kernelId);
  const rawActions = record(kernel).installActions;
  const actions = Array.isArray(rawActions) ? rawActions : [];
  return actions.map(record).find((action) => action.id === actionId);
}

function storageWorkspaceDirectories(state: BridgeState): string[] {
  return state.settings.mountedApps.flatMap((mountedApp) => {
    if (!mountedApp.path?.trim()) return [];
    const manifest = readMountedAppManifest(mountedApp.path).manifest;
    if (!manifest && !mountedApp.workspacePath?.trim()) return [];
    return [resolveMountedAppWorkspaceRoot(mountedApp.path, manifest ?? {}, mountedApp.workspacePath)];
  });
}

async function runInstallCommand(
  command: unknown[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const invocation = kernelInstallCommandInvocation(command, { environment: options.env });

  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd || process.cwd(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("install_timed_out"));
    }, INSTALL_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = limitOutput(stdout + chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = limitOutput(stderr + chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const exitCode = code ?? 0;
      if (exitCode === 0) {
        resolve({ exitCode, stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `install_failed:${exitCode}`));
    });
  });
}

export function kernelInstallCommandInvocation(
  command: unknown[],
  options: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
  } = {},
): { command: string; args: string[] } {
  const executable = stringValue(command[0]);
  const args = command.slice(1).map((item) => String(item));
  if (!executable) {
    throw new Error("install_command_missing");
  }
  return resolveCommandInvocation(executable, args, {
    platform: options.platform,
    environment: options.environment,
  });
}

function limitOutput(value: string): string {
  return value.length > 40_000 ? value.slice(value.length - 40_000) : value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
