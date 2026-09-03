import { existsSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenGrove } from "../app/create-opengrove.js";
import { hasFlowApprovalStep, listMountedAppFlows } from "../app-builder/flow-discovery.js";
import { importProjectAsApp } from "../app-builder/importer.js";
import { validateAppManifestFile } from "../app-builder/manifest.js";
import type { JsonObject } from "../core.js";
import { createAgentEventCheckpointPolicy } from "../core/event-persistence.js";
import { createUnavailableKernelAdapter } from "../kernel/adapters/unavailable.js";
import { hostMessage } from "../localization/host-messages.js";
import { DEFAULT_LOCALE, type SupportedLocale } from "../localization/locale-registry.js";
import { normalizeOpenGroveProfile } from "../profiles/profile.js";
import { type HostRuntimeAuthMode, resolveHostRuntimeEnvironment } from "../profiles/runtime-environment.js";
import { isBridgeKernelId, type RoomChannelMember } from "../rooms/channel-store.js";
import {
  isLegacyRoomPmMember,
  isRoomPmMember,
  legacyMountedAppMemberSlug,
  OPENGROVE_PM_MEMBER_ID,
  pmAgentMemberId,
} from "../rooms/room-pm.js";
import { routineStepRoomId, validateRoutineToolInput } from "../routines/routine-step-validation.js";
import { type PersistedAgentState, restorePersistedAgentState } from "../storage/json-state-store.js";
import { createSqliteStateStore } from "../storage/sqlite-state-store.js";
import { createAppCommandRunTool } from "../tools/app-command.js";
import type { AppImportInput, AppImportResult } from "../tools/app-import.js";
import { createDelegateTaskTool } from "../tools/delegation.js";
import {
  dedupeRoutineSlug,
  type WorkflowCreateScope,
  type WorkflowCreateToolContext,
  type WorkflowFlowApproval,
  type WorkflowToolStepInput,
  writeRoutineFileToVault,
  writeWorkflowFlowFileToWorkspace,
} from "../tools/workflow.js";
import { activeBridgeRunIds } from "./active-runs.js";
import { resolveMountedAppCliEnv, resolveMountedAppDeclaredCliCommand } from "./app-cli-env.js";
import {
  finalizeInterruptedAppProgramActivation,
  recoverInterruptedAppProgramActivations,
} from "./app-program-activation-recovery.js";
import { defaultAppGroupRoomId, findDefaultAppGroupRoom } from "./app-room-ids.js";
import { resolveMountedAppRuntimeEnv } from "./app-runtime-env.js";
import {
  cleanupUnreferencedAppStoreProgramGenerations,
  currentAppStoreProgramsRoot,
  defaultAppStoreRoot,
} from "./app-store.js";
import {
  type AppVersionActivationJournal,
  appVersionActivationJournalKey,
  appVersionActivationJournalRoot,
  removeAppVersionActivationJournal,
  scanAppVersionActivationJournals,
} from "./app-version-activation-journal.js";
import { MountedAppVersionStateStore } from "./app-version-state.js";
import {
  mountedAppDefaultEmployees,
  mountedAppMemberSlug,
  providerOnlyUserOverrides,
  publicEmployeeRole,
  replaceEmployeeRoleLead,
} from "./bridge-mounted-app-employees.js";
import {
  clearMountedAppUninstallMarkers,
  defaultBridgeSettings,
  effectiveMountedApps,
  bridgeSettingsFileExists as hasBridgeSettingsFile,
  loadBridgeSettings,
  saveBridgeSettings,
} from "./bridge-settings-store.js";
import { getBridgeTurnContext } from "./bridge-turn-context.js";
import type { BridgeMountedAppSettings, BridgeState, LocalBridgeServerOptions } from "./bridge-types.js";
import { DEFAULT_BRIDGE_MODEL_ID, LEGACY_NATIVE_PROVIDER_BINDING_ID } from "./bridge-types.js";
import { retireBridgeKernelAdapter } from "./kernel-lifecycle.js";
import {
  BridgeKernelUnavailableError,
  createBridgeKernel,
  getBridgeRuntimeControlsForKernel,
} from "./kernel-selection.js";
import { resolveHostLanguageSettings } from "./language-preference.js";
import { migrateMountedAppManifestV1 } from "./migrations/app-manifest-v1.js";
import { migrateAppMemberIdentitiesV1 } from "./migrations/app-member-identities-v1.js";
import { migrateAppRoomScopesV1 } from "./migrations/app-room-scopes-v1.js";
import {
  CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
  migrateImplicitProviderRoutesToExplicit,
  resolveLegacyNativeEmployeeProviderId,
} from "./migrations/implicit-provider-routes-v1.js";
import { migrateKernelNativeResumesV1 } from "./migrations/kernel-native-resume-v1.js";
import { type LocalUnscopedMigrationResult, migrateLocalStateToUnscoped } from "./migrations/local-unscoped-v1.js";
import {
  CURRENT_EMPLOYEE_MODEL_MIGRATION_VERSION,
  migrateLegacyNativeEmployeeModelsV1,
} from "./migrations/native-employee-model-v1.js";
import { migrateRoomAdministratorsV1 } from "./migrations/room-administrators-v1.js";
import { migrateRoutineAppCommandIdsV1 } from "./migrations/routine-app-command-id-v1.js";
import {
  legacyAppStoreProgramsRoot,
  legacyAppStoreRoot,
  migrateStoreAppLayoutsV2,
  retireLegacyStoreAppLayoutsV2,
  validateStoreAppLayoutWorkspaceCopiesV2,
} from "./migrations/store-app-layout-v2.js";
import { STORE_APP_LAYOUT_V2_LOG_EVENTS } from "./migrations/store-app-layout-v2-metadata.js";
import { migrateStoreWorkspaceBindingsV1 } from "./migrations/store-workspace-binding-v1.js";
import { mountedAppManifestIssue, readMountedAppManifest, resolveMountedAppTarget } from "./mounted-apps.js";
import { productDefaultEmployees } from "./product-default-employees.js";
import { getAllBridgeProviderProfiles } from "./provider-profiles.js";
import { delegateRoomTask, delegationTargetSummaries } from "./room-delegation.js";
import { activeRoomRunIds } from "./room-runs/scheduler.js";
import { activateRoutineWorkflow } from "./routine-activation.js";
import { bridgeDataPath } from "./storage-paths.js";
import { resolveSystemEmployeeRuntime } from "./system-employee-runtime.js";
import {
  activateLegacyProviderReferences,
  applyProviderSetupMigration,
  CURRENT_PROVIDER_SETUP_VERSION,
  legacyProviderProfilesForImplicitRouteMigration,
} from "./system-provider-discovery.js";
import { validateWorkflowMemberRef } from "./workflow-member-ref.js";
import { resolveBridgeWorkspaceRoot } from "./workspace-root.js";

export {
  bridgeSettingsFileExists,
  getBridgeSettingsSnapshot,
  getPublicBridgeSettingsSnapshot,
  normalizeBridgeSettingsPatch,
  saveBridgeSettings,
} from "./bridge-settings-store.js";

const MAX_NESTED_APP_SCAN_DEPTH = 6;
const MAX_NESTED_APP_CANDIDATES = 24;

export function createBridgeState(
  options: LocalBridgeServerOptions,
  authMode: HostRuntimeAuthMode = "bridge-token",
): BridgeState {
  const profile = normalizeOpenGroveProfile(options.profile, "local");
  let bridgeApp: BridgeState["app"] | undefined;
  const state: BridgeState = {
    get app() {
      if (!bridgeApp) throw new Error("bridge_app_not_initialized");
      return bridgeApp;
    },
    set app(value) {
      bridgeApp = value;
      state.appInitialized = true;
    },
    store: options.store ?? createSqliteStateStore(options.statePath),
    eventCheckpointPolicy: createAgentEventCheckpointPolicy(),
    profile,
    runtimeEnvironment: resolveHostRuntimeEnvironment({
      preset: options.runtimeEnvironment,
      profile,
      authMode,
    }),
    snapshot: {},
    computerSnapshot: {},
    model: DEFAULT_BRIDGE_MODEL_ID,
    kernel: "codex",
    settings: defaultBridgeSettings(),
    saveCandidateNote: false,
    policyOverrides: [],
  };
  state.rootState = state;

  const settingsFileExisted = hasBridgeSettingsFile(state);
  const loadedSettings = loadBridgeSettings(state);
  const needsImplicitProviderRouteMigration =
    loadedSettings.providerRouteMigrationVersion < CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION ||
    loadedSettings.modelProviderBindings.some((binding) => binding.providerId === LEGACY_NATIVE_PROVIDER_BINDING_ID);
  const legacyProviderRouteProfiles = needsImplicitProviderRouteMigration
    ? legacyProviderProfilesForImplicitRouteMigration(loadedSettings)
    : undefined;
  const needsLegacyProviderActivation =
    settingsFileExisted && (loadedSettings.providerSetupVersion ?? 0) < CURRENT_PROVIDER_SETUP_VERSION;
  const discoveredSettings = applyProviderSetupMigration(loadedSettings);
  state.settings = discoveredSettings;
  const appStoreRoot = bridgeDataPath(state, "app-store");
  const workspaceBindingMigration = migrateStoreWorkspaceBindingsV1({
    mountedApps: state.settings.mountedApps,
    storeRoot: appStoreRoot,
  });
  if (workspaceBindingMigration.changed) {
    state.settings = {
      ...state.settings,
      mountedApps: workspaceBindingMigration.mountedApps,
    };
    console.info("store_workspace_binding_migration_recovered", {
      appIds: workspaceBindingMigration.recoveredAppIds,
    });
  }
  if (workspaceBindingMigration.failures.length) {
    console.warn("store_workspace_binding_migration_failed", {
      failures: workspaceBindingMigration.failures,
    });
  }
  if (
    !needsLegacyProviderActivation &&
    (!settingsFileExisted ||
      workspaceBindingMigration.changed ||
      JSON.stringify(state.settings) !== JSON.stringify(loadedSettings))
  ) {
    saveBridgeSettings(state);
  }
  const versionActivationScan = scanAppVersionActivationJournals(appVersionActivationJournalRoot(appStoreRoot));
  const corruptJournalKeys = new Set(
    versionActivationScan.failures.flatMap((failure) => (failure.journalKey ? [failure.journalKey] : [])),
  );
  const corruptJournalRoots = new Set(
    state.settings.mountedApps.flatMap((mountedApp) =>
      corruptJournalKeys.has(appVersionActivationJournalKey(mountedApp.id)) ? [resolve(mountedApp.path)] : [],
    ),
  );
  if (versionActivationScan.failures.length) {
    console.error("app_version_activation_recovery_needs_manual_repair", {
      errorCode: "app_version_activation_journal_corrupted",
      journalCount: versionActivationScan.failures.length,
      matchedAppCount: corruptJournalRoots.size,
      unmatchedJournalCount: versionActivationScan.failures.length - corruptJournalRoots.size,
    });
    disableMountedAppsForRecovery(state, corruptJournalRoots, "app_version_activation_journal_corrupted");
  }
  const recoveryJournalRoots = new Set([
    ...corruptJournalRoots,
    ...versionActivationScan.journals.map((journal) => resolve(journal.record.appRoot)),
  ]);
  let versionActivationJournal =
    versionActivationScan.journals.length === 1 ? versionActivationScan.journals[0] : undefined;
  if (versionActivationScan.journals.length > 1) {
    disableMountedAppsForRecovery(state, recoveryJournalRoots, "app_version_activation_recovery_ambiguous");
  }
  let versionActivationRecovery: { authoritativeEmployeeConfigAppId?: string } | undefined;
  let versionActivationRecovered = false;
  if (versionActivationJournal) {
    try {
      versionActivationRecovery = prepareInterruptedAppVersionActivationRecovery(
        state,
        versionActivationJournal,
        appStoreRoot,
      );
      versionActivationRecovered = true;
    } catch (error) {
      disableMountedAppsForRecovery(
        state,
        new Set([resolve(versionActivationJournal.record.appRoot)]),
        error instanceof Error ? error.message : "app_version_activation_recovery_failed",
      );
      versionActivationJournal = undefined;
    }
  }
  const activationRecovery = recoverInterruptedAppProgramActivations(
    state.settings.mountedApps
      .map((mountedApp) => mountedApp.path)
      .filter((appRoot) => !recoveryJournalRoots.has(resolve(appRoot))),
  );
  if (activationRecovery.failed.length) {
    disableMountedAppsForRecovery(
      state,
      new Set(activationRecovery.failed.map((failure) => resolve(failure.appRoot))),
      "app_program_activation_recovery_failed",
    );
  }
  const storeAppLayoutRoots = {
    legacyProgramsRoot: legacyAppStoreProgramsRoot(appStoreRoot),
    legacyWorkspacesRoot: legacyAppStoreRoot(),
    programsRoot: currentAppStoreProgramsRoot(appStoreRoot),
    workspacesRoot: defaultAppStoreRoot(),
  };
  let preLayoutMigrationMountedApps: BridgeMountedAppSettings[] | undefined;
  let layoutMigratedAppIds: string[] = [];
  let startupMigrationActivityReported = false;
  if (
    !needsLegacyProviderActivation &&
    versionActivationScan.journals.length === 0 &&
    versionActivationScan.failures.length === 0 &&
    activationRecovery.failed.length === 0
  ) {
    try {
      const layoutMigration = migrateStoreAppLayoutsV2({
        mountedApps: state.settings.mountedApps,
        roots: storeAppLayoutRoots,
        onMigrationStart(appId) {
          console.info(STORE_APP_LAYOUT_V2_LOG_EVENTS.migrationStarted, { appId });
          if (startupMigrationActivityReported) return;
          startupMigrationActivityReported = true;
          try {
            options.onStartupActivity?.("migrating_local_data");
          } catch (error) {
            // non-critical-fallback: renderer progress is informational and must
            // never influence the migration transaction or Bridge startup.
            console.warn("store_app_layout_startup_activity_report_failed", {
              failure: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
      if (layoutMigration.changed) {
        preLayoutMigrationMountedApps = state.settings.mountedApps.map((mountedApp) => ({ ...mountedApp }));
        state.settings = {
          ...state.settings,
          mountedApps: layoutMigration.mountedApps,
        };
        layoutMigratedAppIds = layoutMigration.migratedAppIds;
        console.info(STORE_APP_LAYOUT_V2_LOG_EVENTS.copyCompleted, {
          appIds: layoutMigration.migratedAppIds,
        });
      }
      if (layoutMigration.failures.length) {
        console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.migrationDeferred, {
          failures: layoutMigration.failures,
        });
      }
    } catch (error) {
      if (preLayoutMigrationMountedApps) {
        state.settings = {
          ...state.settings,
          mountedApps: preLayoutMigrationMountedApps,
        };
        preLayoutMigrationMountedApps = undefined;
        layoutMigratedAppIds = [];
      }
      // non-critical-fallback: the persisted legacy mounts remain authoritative.
      console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.migrationDeferred, {
        failure: error instanceof Error ? error.message : "store_app_layout_migration_failed",
      });
    }
  }
  try {
    const programCleanup = cleanupUnreferencedAppStoreProgramGenerations(appStoreRoot, state.settings);
    if (programCleanup.retained.length) {
      console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.programCleanupDeferred, {
        retained: programCleanup.retained,
      });
    }
  } catch (error) {
    // non-critical-fallback: obsolete programs remain recoverable for a later cleanup pass.
    console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.programCleanupDeferred, {
      failure: error instanceof Error ? error.message : "app_store_program_cleanup_failed",
    });
  }
  let layoutMigrationActivationFailed = false;
  for (const mountedApp of state.settings.mountedApps) {
    if (mountedApp.enabled === false || !mountedApp.path?.trim()) continue;
    const appRoot = resolvePathLike(mountedApp.path);
    try {
      if (existsSync(appRoot)) {
        const migration = migrateMountedAppManifestV1(appRoot);
        if (migration.status === "failed" || migration.status === "invalid" || migration.status === "missing") {
          console.warn("mounted_app_manifest_migration_skipped", {
            appId: mountedApp.id,
            appRoot,
            status: migration.status,
            issues: migration.issues ?? [],
          });
          if (preLayoutMigrationMountedApps && layoutMigratedAppIds.includes(mountedApp.id)) {
            state.settings = {
              ...state.settings,
              mountedApps: preLayoutMigrationMountedApps,
            };
            layoutMigrationActivationFailed = true;
            console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.activationDeferred, {
              failure: `mounted_app_manifest_${migration.status}`,
              appId: mountedApp.id,
            });
            break;
          }
        }
      }
    } catch (error) {
      if (!preLayoutMigrationMountedApps) throw error;
      state.settings = {
        ...state.settings,
        mountedApps: preLayoutMigrationMountedApps,
      };
      layoutMigrationActivationFailed = true;
      console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.activationDeferred, {
        failure: error instanceof Error ? error.message : "mounted_app_manifest_migration_failed",
        appId: mountedApp.id,
      });
      break;
    }
  }
  try {
    recreateBridgeApp(
      state,
      versionActivationRecovery || preLayoutMigrationMountedApps
        ? {
            deferPersistedStateSave: true,
            ...(versionActivationRecovery?.authoritativeEmployeeConfigAppId
              ? { authoritativeEmployeeConfigAppId: versionActivationRecovery.authoritativeEmployeeConfigAppId }
              : {}),
          }
        : {},
    );
  } catch (error) {
    if (preLayoutMigrationMountedApps) {
      state.settings = {
        ...state.settings,
        mountedApps: preLayoutMigrationMountedApps,
      };
      try {
        recreateBridgeApp(state, {
          deferPersistedStateSave: true,
          ...(versionActivationRecovery?.authoritativeEmployeeConfigAppId
            ? { authoritativeEmployeeConfigAppId: versionActivationRecovery.authoritativeEmployeeConfigAppId }
            : {}),
        });
      } catch (legacyError) {
        throw new AggregateError([error, legacyError], "store_app_layout_legacy_recreation_failed");
      }
      layoutMigrationActivationFailed = true;
      console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.activationDeferred, {
        failure: error instanceof Error ? error.message : "store_app_layout_activation_failed",
      });
    } else {
      throw error;
    }
  }
  if (preLayoutMigrationMountedApps && !layoutMigrationActivationFailed) {
    const validationFailures = validateStoreAppLayoutWorkspaceCopiesV2({
      appIds: layoutMigratedAppIds,
      previousMountedApps: preLayoutMigrationMountedApps,
      mountedApps: state.settings.mountedApps,
      roots: storeAppLayoutRoots,
    });
    if (validationFailures.length) {
      state.settings = {
        ...state.settings,
        mountedApps: preLayoutMigrationMountedApps,
      };
      try {
        recreateBridgeApp(state, {
          deferPersistedStateSave: true,
          ...(versionActivationRecovery?.authoritativeEmployeeConfigAppId
            ? { authoritativeEmployeeConfigAppId: versionActivationRecovery.authoritativeEmployeeConfigAppId }
            : {}),
        });
      } catch (legacyError) {
        throw new AggregateError([legacyError], "store_app_layout_validation_legacy_recreation_failed");
      }
      layoutMigrationActivationFailed = true;
      console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.finalValidationDeferred, { failures: validationFailures });
    }
  }
  if (preLayoutMigrationMountedApps && !layoutMigrationActivationFailed) {
    try {
      // bridge-settings.json is the atomic activation pointer. Persist it only
      // after the new App has passed recreation, while every legacy path still exists.
      saveBridgeSettings(state);
      console.info(STORE_APP_LAYOUT_V2_LOG_EVENTS.migrationCompleted, { appIds: layoutMigratedAppIds });
    } catch (error) {
      state.settings = {
        ...state.settings,
        mountedApps: preLayoutMigrationMountedApps,
      };
      try {
        recreateBridgeApp(state, {
          deferPersistedStateSave: true,
          ...(versionActivationRecovery?.authoritativeEmployeeConfigAppId
            ? { authoritativeEmployeeConfigAppId: versionActivationRecovery.authoritativeEmployeeConfigAppId }
            : {}),
        });
      } catch (legacyError) {
        throw new AggregateError([error, legacyError], "store_app_layout_pointer_persist_legacy_recreation_failed");
      }
      layoutMigrationActivationFailed = true;
      console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.pointerSwitchDeferred, {
        failure: error instanceof Error ? error.message : "store_app_layout_post_activation_persist_failed",
      });
    }
  }
  if (preLayoutMigrationMountedApps && !layoutMigrationActivationFailed && !versionActivationRecovery) {
    try {
      state.store.saveFrom(state.app);
    } catch (error) {
      // non-critical-fallback: the persisted mount pointer is healthy; normalized state can retry later.
      console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.postActivationStatePersistDeferred, {
        failure: error instanceof Error ? error.message : "store_app_layout_post_activation_state_persist_failed",
      });
    }
  }
  if (!layoutMigrationActivationFailed) {
    try {
      const layoutRetirement = retireLegacyStoreAppLayoutsV2({
        mountedApps: state.settings.mountedApps,
        roots: storeAppLayoutRoots,
      });
      if (layoutRetirement.renamed.length) {
        console.info(STORE_APP_LAYOUT_V2_LOG_EVENTS.legacyPathsRetired, { paths: layoutRetirement.renamed });
      }
      if (layoutRetirement.retained.length) {
        console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.legacyRetirementDeferred, { paths: layoutRetirement.retained });
      }
    } catch (error) {
      // non-critical-fallback: retirement is rename-only and can be retried on a later startup.
      console.warn(STORE_APP_LAYOUT_V2_LOG_EVENTS.legacyRetirementDeferred, {
        failure: error instanceof Error ? error.message : "store_app_layout_legacy_retirement_failed",
      });
    }
  }
  if (versionActivationJournal?.record.phase === "activating") {
    // recreateBridgeApp has already restored the pre-activation snapshot and
    // applied every current startup migration to it. Persist that normalized
    // result instead of writing the stale journal snapshot back over it.
    state.store.saveFrom(state.app);
    saveBridgeSettings(state);
  }
  if (versionActivationJournal && versionActivationRecovered) {
    removeAppVersionActivationJournal(versionActivationJournal);
  }
  if (needsLegacyProviderActivation) {
    const activatedSettings = activateLegacyProviderReferences(
      state.settings,
      state.app.rooms.listMembers().map((member) => member.providerId),
    );
    if (activatedSettings !== state.settings) {
      state.settings = activatedSettings;
      recreateBridgeApp(state);
    }
    // Commit the setup-version marker and every recovered reference together,
    // after the persisted Employee ledger has been available for inspection.
    saveBridgeSettings(state);
  }
  const providerRouteMigration = migrateImplicitProviderRoutesToExplicit({
    migrationVersion: state.settings.providerRouteMigrationVersion,
    modelBindings: state.settings.modelProviderBindings,
    providers: legacyProviderRouteProfiles ?? getAllBridgeProviderProfiles(state.settings.customProviders),
    defaultKernelId: state.settings.kernel,
    targets: state.app.rooms
      .listMembers()
      .flatMap((member) =>
        isBridgeKernelId(member.kernel)
          ? [{ kernelId: member.kernel, modelId: member.model, employeeProviderId: member.providerId }]
          : [],
      ),
  });
  if (providerRouteMigration.versionAdvanced || providerRouteMigration.bindingsChanged) {
    state.settings = {
      ...state.settings,
      providerRouteMigrationVersion: providerRouteMigration.migrationVersion,
      modelProviderBindings: providerRouteMigration.modelBindings,
    };
    saveBridgeSettings(state);
    if (providerRouteMigration.bindingsChanged) recreateBridgeApp(state);
  }

  return state;
}

function disableMountedAppsForRecovery(state: BridgeState, appRoots: ReadonlySet<string>, errorCode: string): void {
  const affectedAppIds: string[] = [];
  state.settings = {
    ...state.settings,
    mountedApps: state.settings.mountedApps.map((mountedApp) => {
      if (!appRoots.has(resolve(mountedApp.path))) return mountedApp;
      affectedAppIds.push(mountedApp.id);
      return { ...mountedApp, enabled: false };
    }),
  };
  console.error("app_activation_recovery_needs_manual_repair", {
    errorCode,
    affectedAppIds,
  });
  if (affectedAppIds.length) saveBridgeSettings(state);
}

function prepareInterruptedAppVersionActivationRecovery(
  state: BridgeState,
  journal: AppVersionActivationJournal,
  appStoreRoot: string,
): { authoritativeEmployeeConfigAppId?: string } | undefined {
  if (journal.record.phase === "committed") {
    finalizeInterruptedAppProgramActivation(journal.record.appRoot);
    return undefined;
  }
  const programRecovery = recoverInterruptedAppProgramActivations([journal.record.appRoot]);
  if (programRecovery.failed.length) {
    throw new Error(
      `app_version_activation_program_recovery_failed:${programRecovery.failed
        .map((failure) => failure.error)
        .join("|")}`,
    );
  }
  state.settings = {
    ...state.settings,
    mountedApps: structuredClone(journal.record.previousMountedApps),
    uninstalledStoreAppIds: [...journal.record.previousUninstalledStoreAppIds],
  };
  new MountedAppVersionStateStore(join(appStoreRoot, "version-state")).restore(
    journal.record.localAppId,
    journal.record.previousVersionState,
  );
  saveBridgeSettings(state);
  const appId = readMountedAppManifest(journal.record.appRoot).manifest?.id;
  return {
    ...(typeof appId === "string" && appId ? { authoritativeEmployeeConfigAppId: appId } : {}),
  };
}

export interface RecreateBridgeAppOptions {
  authoritativeEmployeeConfigAppId?: string;
  authoritativeEmployeeConfigAppIds?: ReadonlySet<string>;
  deferPersistedStateSave?: boolean;
  agentStateSnapshot?: PersistedAgentState;
  kernelAdapter?: NonNullable<BridgeState["kernelAdapter"]>;
}

export function recreateBridgeApp(state: BridgeState, options: RecreateBridgeAppOptions = {}): void {
  const rootState = rootBridgeState(state);
  const previousApp = state.appInitialized ? state.app : undefined;
  const hotRebuild = previousApp !== undefined;
  // Scoped execution states are created by spreading the live root state, so
  // they intentionally enter this hot path and share the root run registry.
  const liveRoomRunIds = hotRebuild ? activeRoomRunIds(rootState) : undefined;
  const liveRunIds = hotRebuild ? activeBridgeRunIds(rootState) : undefined;
  const eventLogCheckpoint = hotRebuild ? previousApp.events.checkpoint() : undefined;
  // Only replacing the root app invalidates the HTTP long-poll sources.
  // Building a per-run scoped app starts from the root app by reference but
  // leaves that root app alive, so releasing its waiters here would cause
  // every browser to reconnect for an unrelated run startup.
  if (hotRebuild && rootState === state) {
    previousApp.events.releaseEventWaiters();
    previousApp.rooms.releaseEventWaiters();
    const directAskAdapters = [...(state.directAskExecutionStates?.values() ?? [])].map(
      (executionState) => executionState.kernelAdapter,
    );
    const replacedWorkers = new Set(
      [state.kernelAdapter, ...directAskAdapters, ...(state.roomKernelAdapters?.values() ?? [])].filter(
        (adapter): adapter is NonNullable<BridgeState["kernelAdapter"]> => Boolean(adapter),
      ),
    );
    state.directAskExecutionStates = new Map();
    state.roomKernelAdapters = new Map();
    for (const adapter of replacedWorkers) retireBridgeKernelAdapter(rootState, adapter);
  }
  const kernel = options.kernelAdapter ?? createBridgeKernelForState(state);
  state.kernelAdapter = kernel;
  state.kernelCapabilities = kernel.capabilities;
  if (!state.kernelUnavailableReason) {
    const systemRuntime = resolveSystemEmployeeRuntime(state);
    if (systemRuntime.kernel === state.kernel) state.model = systemRuntime.model;
  }
  const workspaceRoot = resolveBridgeWorkspaceRoot(state.settings);
  const mountedApps = effectiveMountedApps(state);
  state.app = createOpenGrove({
    readPage: () => getBridgeTurnContext()?.snapshot ?? state.snapshot,
    readComputer: () => getBridgeTurnContext()?.computerSnapshot ?? state.computerSnapshot,
    readReplyLanguagePreference: () => resolveHostLanguageSettings(state.settings),
    kernel,
    policy: state.policyOverrides,
    sessionId: "browser-bridge",
    userId: "local-user",
    cwd: process.cwd(),
    workspaceRoot,
    includeCodexSkills: kernel.capabilities.nativeSkillCatalog,
    mountedApps,
    groveGuide: {
      profile: state.profile,
      workspaceRoot,
      cwd: process.cwd(),
      mountedApps,
    },
    appImport: {
      profile: state.profile,
      workspaceRoot,
      cwd: process.cwd(),
      mountedApps,
      importApp: (input) => importAppIntoCurrentBridge(rootState, input),
    },
    workflowCreateContext: createBridgeWorkflowCreateContext(rootState),
    workflowActivation: {
      activate: (input) => activateRoutineWorkflow(rootState, input),
    },
    validateWorkflowFlowApproval: (flowApproval, scope) =>
      validateWorkflowFlowApprovalForBridgeState(rootState, flowApproval, scope),
  });
  state.app.tools.register(
    createDelegateTaskTool(
      {
        id: "room.delegate.task",
        title: "Delegate a room employee",
        description:
          "Writes a targeted source-employee-to-target-employee message in the room bound to the source Run, creates the target placeholder, and submits the target Run asynchronously. Success returns TASK_STATE_SUBMITTED without waiting for or returning the target's final reply.",
        activity: "chat",
        risk: "write",
        input: {
          type: "json-schema",
          schema: {
            type: "object",
            properties: {
              targetMemberId: { type: "string", description: "Member id of the target employee in the current room." },
              prompt: {
                type: "string",
                description:
                  "Task body for a normal employee delegation. Omit during PM auto-routing; the Host forwards the author's original message.",
              },
            },
            required: ["targetMemberId"],
            additionalProperties: false,
          },
        },
        permission: {
          mode: "allow",
          reason: "Delegating to a local employee runs within this node under its own run policies.",
        },
      },
      {
        delegate: (input) => delegateRoomTask(rootState, input),
        listTargets: (sourceRunId) => delegationTargetSummaries(rootState, sourceRunId),
        language: () => resolveHostLanguageSettings(rootState.settings),
      },
    ),
  );
  state.app.tools.register(
    createAppCommandRunTool(
      {
        id: "opengrove.app.command.run",
        title: "Run mounted App command",
        description: "Run a declared CLI from a mounted OpenGrove App by commandId and return stdout/stderr.",
        activity: "local",
        risk: "write",
        input: {
          type: "json-schema",
          schema: {
            type: "object",
            required: ["appId"],
            properties: {
              appId: { type: "string" },
              commandId: { type: "string" },
              args: { type: "array", items: { type: "string", maxLength: 16_384 }, maxItems: 100 },
              cwd: { type: "string" },
              parseJson: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        permission: {
          mode: "allow",
          reason: "Scheduled App-local probes must run without a per-tick approval pause.",
        },
      },
      {
        resolveApp(appId) {
          const target = resolveMountedAppTarget(rootState, appId);
          return target ? { id: target.id, appRoot: target.appRoot } : undefined;
        },
        resolveRuntimeEnv(appId) {
          const appRuntimeEnv = resolveMountedAppRuntimeEnv(rootState, appId)?.env;
          const appCliEnv = resolveMountedAppCliEnv(rootState, appId, undefined, appRuntimeEnv)?.env;
          return {
            ...(appRuntimeEnv ?? {}),
            ...(appCliEnv ?? {}),
          };
        },
        resolveCommand(appId, commandId, args) {
          return resolveMountedAppDeclaredCliCommand(rootState, appId, commandId, args);
        },
      },
    ),
  );
  const agentStateSnapshot = options.agentStateSnapshot;
  let loadedState: PersistedAgentState | undefined;
  if (agentStateSnapshot) {
    loadedState = state.store.restoreSnapshotInto
      ? state.store.restoreSnapshotInto(state.app, agentStateSnapshot, {
          activeRunIds: liveRunIds,
          activeRoomRunIds: liveRoomRunIds,
          preserveResumablePendingRequests: hotRebuild,
          language: resolveHostLanguageSettings(state.settings),
        })
      : agentStateSnapshot;
    if (!state.store.restoreSnapshotInto) restorePersistedAgentState(state.app, agentStateSnapshot);
  } else {
    loadedState = state.store.loadInto(state.app, {
      activeRunIds: liveRunIds,
      activeRoomRunIds: liveRoomRunIds,
      preserveResumablePendingRequests: hotRebuild,
      language: resolveHostLanguageSettings(state.settings),
    });
  }
  const unscopedMigration = migrateLoadedPersistedState(
    state,
    loadedState,
    mountedAppDefaultEmployees({ ...state.settings, mountedApps }),
  );
  const needsEmployeeModelMigration =
    state.settings.employeeModelMigrationVersion < CURRENT_EMPLOYEE_MODEL_MIGRATION_VERSION;
  const legacyNativeEmployeeModelChanged = needsEmployeeModelMigration
    ? migrateLegacyNativeEmployeeModelsV1(state.app.rooms, {
        beforeApply: loadedState
          ? () => backupLocalStateBeforeMigration(state.store.path, loadedState, "native-employee-model-v1")
          : undefined,
      })
    : false;
  const routineAppCommandMigration = migrateRoutineAppCommandIdsV1(state, {
    beforeApply: loadedState
      ? () => backupLocalStateBeforeMigration(state.store.path, loadedState, "routine-app-command-id-v1")
      : undefined,
  });
  if (eventLogCheckpoint) {
    state.app.events.restoreCheckpoint(eventLogCheckpoint);
  }
  const legacyEmployeeProviderRouteChanged = migrateLegacyNativeEmployeeProviderRoutes(state);
  const hadRooms = state.app.rooms.snapshot().rooms.length > 0;
  // Plan Kernel-default repairs against the loaded record before seed sync can
  // replace the route marker that tells us how to migrate it.
  // Apply the plans only after every seed-owned member has reached its final
  // startup shape, so the same sync cannot immediately undo the repair.
  const pendingRuntimeModelRepairs = new Map<string, ProviderBoundMemberModelRepair>();
  for (const member of state.app.rooms.listMembers()) {
    const repair = providerBoundMemberModelRepair(state, member);
    if (repair) pendingRuntimeModelRepairs.set(member.id, repair);
  }
  const existingMembers = new Map(state.app.rooms.listMembers().map((member) => [member.id, member]));
  const deletedMemberIds = new Set(state.app.rooms.listDeletedMemberIds());
  const productSeedMembers = syncProductDefaultSeedMembers(
    existingMembers,
    productDefaultEmployees(resolveHostLanguageSettings(state.settings)),
  );
  const appSeedMembers = applyEmployeeDefinitionRuntimeToScopedSeeds(
    mountedAppDefaultEmployees({ ...state.settings, mountedApps }),
    productSeedMembers,
  );
  const appSeedMemberIds = new Set(appSeedMembers.map((member) => member.id));
  const missingAppSeedMembers = appSeedMembers.filter(
    (member) => !existingMembers.has(member.id) && !deletedMemberIds.has(member.id),
  );
  let appSeedSyncChanged = false;
  for (const member of appSeedMembers) {
    const existing = existingMembers.get(member.id);
    if (!existing) continue;
    const authoritativeEmployeeConfig = Boolean(
      member.appId &&
        (member.appId === options.authoritativeEmployeeConfigAppId ||
          options.authoritativeEmployeeConfigAppIds?.has(member.appId)),
    );
    if (existing.disabled && !authoritativeEmployeeConfig && !shouldRestoreMountedAppSeedMember(existing, member))
      continue;
    const authoritativeExisting = authoritativeEmployeeConfig
      ? {
          ...existing,
          userOverrides: providerOnlyUserOverrides(existing),
        }
      : existing;
    const merged = syncMountedAppSeedMember(authoritativeExisting, member);
    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      state.app.rooms.upsertMember(merged, { emitEvent: true });
      appSeedSyncChanged = true;
    }
  }
  for (const member of existingMembers.values()) {
    if (!shouldDisableStaleMountedAppSeedMember(member, appSeedMemberIds)) continue;
    state.app.rooms.upsertMember(
      {
        ...member,
        status: "offline",
        lastActive: "manifest removed",
        disabled: true,
      },
      { emitEvent: true },
    );
    appSeedSyncChanged = true;
  }
  // v0.5.0 removed these Kernel integrations, but older installations may
  // still have generic employees for them in the persisted room ledger.
  // Preserve their history while removing the unusable employees from the
  // active product surface. Mounted App employees are normalized to the
  // current system Runtime above before this pass runs.
  for (const member of state.app.rooms.listMembers()) {
    if (!shouldDisableRemovedKernelEmployee(member)) continue;
    state.app.rooms.upsertMember(
      {
        ...member,
        status: "offline",
        lastActive: "kernel removed",
        disabled: true,
      },
      { emitEvent: true },
    );
    appSeedSyncChanged = true;
  }
  // Kernel availability is runtime capability, not employee identity. Mounted
  // Apps may declare concrete default employees, but generic kernels do not.
  const roomSeedChanged = state.app.rooms.ensureOpenGroup([...productSeedMembers, ...missingAppSeedMembers]);
  const appGroupConsistencyChanged = reconcileMountedAppGroupRooms(state.app.rooms, appSeedMembers);
  const appDefaultGroupChanged = syncMountedAppDefaultGroups(
    state.app.rooms,
    appSeedMembers,
    resolveHostLanguageSettings(state.settings),
  );
  const numberedGroupPresentationChanged = syncNumberedGroupPresentations(state, true);
  let runtimeModelRepairChanged = false;
  for (const member of state.app.rooms.listMembers()) {
    const repair = pendingRuntimeModelRepairs.get(member.id) ?? providerBoundMemberModelRepair(state, member);
    if (!repair) continue;
    const repaired = applyProviderBoundMemberModelRepair(member, repair);
    if (JSON.stringify(repaired) === JSON.stringify(member)) continue;
    state.app.rooms.upsertMember(repaired, { emitEvent: true });
    runtimeModelRepairChanged = true;
  }
  if (
    !options.deferPersistedStateSave &&
    rootState === state &&
    (!hadRooms ||
      unscopedMigration?.changed ||
      routineAppCommandMigration.changed ||
      roomSeedChanged ||
      appSeedSyncChanged ||
      appDefaultGroupChanged ||
      appGroupConsistencyChanged ||
      numberedGroupPresentationChanged ||
      runtimeModelRepairChanged ||
      legacyNativeEmployeeModelChanged ||
      legacyEmployeeProviderRouteChanged)
  ) {
    state.store.saveFrom(state.app);
  }
  if (!options.deferPersistedStateSave && rootState === state && needsEmployeeModelMigration) {
    state.settings = {
      ...state.settings,
      employeeModelMigrationVersion: CURRENT_EMPLOYEE_MODEL_MIGRATION_VERSION,
    };
    saveBridgeSettings(state);
  }
  state.app.skills.list();
}

export function migrateLegacyNativeEmployeeProviderRoutes(state: BridgeState): boolean {
  const providers = getAllBridgeProviderProfiles(state.settings.customProviders);
  let changed = false;
  for (const member of state.app.rooms.listMembers()) {
    if (!isBridgeKernelId(member.kernel) || member.providerId !== LEGACY_NATIVE_PROVIDER_BINDING_ID) continue;
    const providerId = resolveLegacyNativeEmployeeProviderId({
      kernelId: member.kernel,
      modelId: member.model,
      employeeProviderId: member.providerId,
      providers,
    });
    if (!providerId) continue;
    state.app.rooms.upsertMember({ ...member, providerId }, { emitEvent: true });
    changed = true;
  }
  return changed;
}

interface ProviderBoundMemberModelRepair {
  model: string;
  removeModelUserOverride?: boolean;
}

function providerBoundMemberModelRepair(
  state: BridgeState,
  member: RoomChannelMember,
): ProviderBoundMemberModelRepair | undefined {
  if (!isBridgeKernelId(member.kernel)) return undefined;
  if (member.model !== `${member.kernel}-default`) return undefined;

  const controls = getBridgeRuntimeControlsForKernel(state, member.kernel);
  const source = typeof controls.source === "string" ? controls.source : "";
  if (!source.startsWith("provider:")) return undefined;
  const models = Array.isArray(controls.models)
    ? controls.models
        .map((model) =>
          model && typeof model === "object" && !Array.isArray(model)
            ? String((model as Record<string, unknown>).id ?? "").trim()
            : "",
        )
        .filter(Boolean)
    : [];
  const defaultModel = typeof controls.defaultModel === "string" ? controls.defaultModel.trim() : "";
  const resolvedModel = defaultModel && models.includes(defaultModel) ? defaultModel : models[0];
  if (!resolvedModel || resolvedModel === member.model) return undefined;
  return {
    model: resolvedModel,
    removeModelUserOverride: true,
  };
}

function applyProviderBoundMemberModelRepair(
  member: RoomChannelMember,
  repair: ProviderBoundMemberModelRepair,
): RoomChannelMember {
  const userOverrides = new Set(member.userOverrides);
  if (repair.removeModelUserOverride) userOverrides.delete("model");
  return {
    ...member,
    model: repair.model,
    userOverrides: userOverrides.size ? [...userOverrides] : undefined,
  };
}

function rootBridgeState(state: BridgeState): BridgeState {
  return state.rootState ?? state;
}

function migrateLoadedPersistedState(
  state: BridgeState,
  loadedState: PersistedAgentState | undefined,
  appSeedMembers: RoomChannelMember[],
): LocalUnscopedMigrationResult | undefined {
  if (!loadedState) return undefined;
  const migrated = migrateLocalStateToUnscoped(loadedState);
  const roomAdministrators = migrateRoomAdministratorsV1(migrated.state);
  const appRoomScopes = migrateAppRoomScopesV1(roomAdministrators.state);
  const appMemberIdentities = migrateAppMemberIdentitiesV1(appRoomScopes.state, appSeedMembers);
  const kernelNativeResumes = migrateKernelNativeResumesV1(appMemberIdentities.state);
  if (
    !migrated.result.changed &&
    !roomAdministrators.changed &&
    !appRoomScopes.changed &&
    !appMemberIdentities.changed &&
    !kernelNativeResumes.changed
  )
    return migrated.result;
  if (migrated.result.changed) {
    backupLocalStateBeforeMigration(state.store.path, loadedState, "unscoped-migration");
  }
  if (roomAdministrators.changed) {
    backupLocalStateBeforeMigration(state.store.path, loadedState, "room-administrators-v1");
  }
  if (appRoomScopes.changed) {
    backupLocalStateBeforeMigration(state.store.path, loadedState, "app-room-scopes-v1");
  }
  if (appMemberIdentities.changed) {
    backupLocalStateBeforeMigration(state.store.path, loadedState, "app-member-identities-v1");
  }
  if (kernelNativeResumes.changed) {
    backupLocalStateBeforeMigration(state.store.path, loadedState, "kernel-native-resume-v1");
  }
  restorePersistedAgentState(state.app, kernelNativeResumes.state);
  return {
    ...migrated.result,
    changed: true,
  };
}

function backupLocalStateBeforeMigration(
  statePath: string,
  state: PersistedAgentState,
  step:
    | "unscoped-migration"
    | "room-administrators-v1"
    | "app-room-scopes-v1"
    | "app-member-identities-v1"
    | "kernel-native-resume-v1"
    | "routine-app-command-id-v1"
    | "native-employee-model-v1",
): void {
  if (!statePath) return;
  const backupPath = `${statePath}.before-${step}.json`;
  if (existsSync(backupPath)) return;
  const tempPath = `${backupPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempPath, backupPath);
}

function createBridgeWorkflowCreateContext(state: BridgeState): WorkflowCreateToolContext {
  return {
    validateMember(memberId, scope) {
      return validateWorkflowMemberRef(state.app.rooms, memberId, scope);
    },
    validateTool(toolId) {
      return state.app.tools.get(toolId) ? undefined : `tool_not_registered:${toolId}`;
    },
    prepareToolStep(step, scope) {
      return prepareRoutineToolStepForBridge(state, step, scope);
    },
    validateToolInput(step) {
      const inputError = validateRoutineToolInput(step);
      if (inputError) return inputError;
      if (step.toolId === "room.ledger.read") {
        const roomId = routineStepRoomId(step);
        if (roomId && !state.app.rooms.getRoom(roomId)) {
          return `tool_input_invalid:room.ledger.read:room_not_found:${roomId}`;
        }
      }
      return undefined;
    },
    validateFlowApproval(flowApproval, scope) {
      return validateWorkflowFlowApprovalForBridgeState(state, flowApproval, scope);
    },
    writeRoutineDocument({ title, body }) {
      const slug = dedupeRoutineSlug(title);
      const document = state.app.knowledge.create({
        type: "routine",
        title,
        body,
        format: "markdown",
        metadata: { vaultPath: `OpenGrove/routines/${slug}.routine.md` },
      });
      writeRoutineFileToVault({ title, body, slug });
      state.store.saveFrom(state.app);
      return { knowledgeId: document.id };
    },
    writeWorkflowFlow(input) {
      const target = resolveMountedAppTarget(state, input.appId);
      if (!target) {
        return {
          mirrored: false,
          warning: `workflow_flow_mirror_target_not_found:${input.appId}`,
        };
      }
      const flow = writeWorkflowFlowFileToWorkspace({
        workspaceRoot: target.workspaceRoot,
        title: input.title,
        knowledgeId: input.knowledgeId,
        steps: input.steps,
        ...(input.description ? { description: input.description } : {}),
        ...(input.bodyMarkdown ? { bodyMarkdown: input.bodyMarkdown } : {}),
      });
      const document = state.app.knowledge.get(input.knowledgeId);
      if (document) {
        state.app.knowledge.update(input.knowledgeId, {
          metadata: {
            ...(document.metadata ?? {}),
            workflowAppId: target.id,
            ...(flow.path ? { workflowFlowPath: flow.path } : {}),
          },
        });
        state.store.saveFrom(state.app);
      }
      return flow;
    },
  };
}

function prepareRoutineToolStepForBridge(
  state: BridgeState,
  step: WorkflowToolStepInput,
  scope: WorkflowCreateScope,
): WorkflowToolStepInput {
  if (step.toolId !== "room.ledger.read" || !validateRoutineToolInput(step)) {
    return step;
  }
  const roomId = scope.appId ? findDefaultAppGroupRoom(state.app.rooms.listRooms(), scope.appId)?.id : undefined;
  if (!roomId) {
    return step;
  }
  return {
    ...step,
    input: {
      ...recordInput(step.input),
      roomId,
    },
  };
}

function recordInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function validateWorkflowFlowApprovalForBridgeState(
  state: BridgeState,
  flowApproval: WorkflowFlowApproval,
  scope: WorkflowCreateScope,
): string | undefined {
  if (!scope.appId) {
    return `flow_approval_app_scope_required:${flowApproval.flowId}/${flowApproval.stepId}`;
  }
  const target = resolveMountedAppTarget(state, scope.appId);
  if (!target) {
    return `flow_approval_app_not_found:${scope.appId}`;
  }
  const flows = listMountedAppFlows(target.workspaceRoot);
  return hasFlowApprovalStep(flows, flowApproval)
    ? undefined
    : `flow_approval_not_found:${flowApproval.flowId}/${flowApproval.stepId}`;
}

export function syncMountedAppSeedMember(existing: RoomChannelMember, seed: RoomChannelMember): RoomChannelMember {
  // User-edited fields survive ordinary manifest re-seeding; the App Store update
  // boundary removes App-owned markers but retains the local Provider route before
  // calling this merge. A role override replaces only the public lead while fresh
  // App instructions remain attached.
  const userOverrides = normalizedMountedAppUserOverrides(existing, seed)?.filter(
    (field) =>
      !(
        seed.appId &&
        seed.employeeDefinitionId &&
        !seed.manifestDefaults &&
        SHARED_EMPLOYEE_DEFINITION_RUNTIME_FIELDS.has(field)
      ),
  );
  const overrides = new Set(userOverrides);
  const keep = <K extends keyof RoomChannelMember>(field: K): RoomChannelMember[K] =>
    overrides.has(field) ? existing[field] : seed[field];
  return {
    ...seed,
    name: keep("name"),
    displayName: seed.displayName,
    avatarMode: keep("avatarMode"),
    avatarSeed: keep("avatarSeed"),
    avatarDataUrl: keep("avatarDataUrl"),
    role: overrides.has("role") ? replaceEmployeeRoleLead(seed.role, publicEmployeeRole(existing.role)) : seed.role,
    displayRole: seed.displayRole,
    kernel: keep("kernel"),
    model: keep("model"),
    providerId: keep("providerId"),
    color: keep("color"),
    availableSkillIds: keep("availableSkillIds"),
    defaultSkillIds: keep("defaultSkillIds"),
    accessMode: keep("accessMode"),
    reasoningEffort: keep("reasoningEffort"),
    contextTokenBudget: keep("contextTokenBudget"),
    visibility: keep("visibility"),
    publicDescription: keep("publicDescription"),
    displayPublicDescription: seed.displayPublicDescription,
    publicSkills: keep("publicSkills"),
    displayPublicSkills: seed.displayPublicSkills,
    inputSpec: keep("inputSpec"),
    displayInputSpec: seed.displayInputSpec,
    outputSpec: keep("outputSpec"),
    displayOutputSpec: seed.displayOutputSpec,
    status: existing.status === "running" ? existing.status : seed.status,
    lastActive: existing.status === "running" ? existing.lastActive : seed.lastActive,
    storePackageId: existing.storePackageId ?? seed.storePackageId,
    manifestDefaults: {
      name: seed.name,
      avatarMode: seed.avatarMode,
      avatarSeed: seed.avatarSeed,
      avatarDataUrl: seed.avatarDataUrl,
      role: publicEmployeeRole(seed.role),
      kernel: seed.kernel,
      model: seed.model,
      color: seed.color,
      availableSkillIds: seed.availableSkillIds,
      defaultSkillIds: seed.defaultSkillIds,
      reasoningEffort: seed.reasoningEffort,
      contextTokenBudget: seed.contextTokenBudget,
      accessMode: seed.accessMode,
      visibility: seed.visibility,
      publicDescription: seed.publicDescription,
      publicSkills: seed.publicSkills,
      inputSpec: seed.inputSpec,
      outputSpec: seed.outputSpec,
    },
    userOverrides,
    disabled: false,
  };
}

export function syncMountedAppMemberPresentations(state: BridgeState): boolean {
  const seedMembers = [
    ...productDefaultEmployees(resolveHostLanguageSettings(state.settings)),
    ...mountedAppDefaultEmployees({
      ...state.settings,
      mountedApps: effectiveMountedApps(state),
    }),
  ];
  const seedsById = new Map(seedMembers.map((member) => [member.id, member]));
  let changed = false;
  for (const existing of state.app.rooms.listMembers()) {
    const seed = seedsById.get(existing.id);
    if (!seed || (existing.appId && seed.appId !== existing.appId)) continue;
    if (
      existing.displayName === seed.displayName &&
      existing.displayPublicDescription === seed.displayPublicDescription &&
      existing.displayRole === seed.displayRole &&
      JSON.stringify(existing.displayPublicSkills) === JSON.stringify(seed.displayPublicSkills) &&
      existing.displayInputSpec === seed.displayInputSpec &&
      existing.displayOutputSpec === seed.displayOutputSpec &&
      existing.sourceLabel === seed.sourceLabel
    ) {
      continue;
    }
    state.app.rooms.upsertMember(
      {
        ...existing,
        displayName: seed.displayName,
        displayPublicDescription: seed.displayPublicDescription,
        displayRole: seed.displayRole,
        displayPublicSkills: seed.displayPublicSkills,
        displayInputSpec: seed.displayInputSpec,
        displayOutputSpec: seed.displayOutputSpec,
        sourceLabel: seed.sourceLabel,
      },
      { emitEvent: true },
    );
    changed = true;
  }
  return changed;
}

export function syncProductDefaultSeedMembers(
  existingMembers: ReadonlyMap<string, RoomChannelMember>,
  seedMembers: RoomChannelMember[],
): RoomChannelMember[] {
  return seedMembers.map((seed) => {
    const existing = existingMembers.get(seed.id);
    if (existing) return syncMountedAppSeedMember(existing, seed);
    if (seed.id !== OPENGROVE_PM_MEMBER_ID) return seed;
    return migrateLegacyScopedPmRuntime(existingMembers, seed);
  });
}

const SHARED_EMPLOYEE_DEFINITION_RUNTIME_FIELDS = new Set([
  "avatarMode",
  "avatarSeed",
  "avatarDataUrl",
  "kernel",
  "model",
  "providerId",
  "accessMode",
  "reasoningEffort",
  "contextTokenBudget",
]);

function migrateLegacyScopedPmRuntime(
  existingMembers: ReadonlyMap<string, RoomChannelMember>,
  seed: RoomChannelMember,
): RoomChannelMember {
  const candidates = [...existingMembers.values()]
    .filter(
      (member) =>
        Boolean(member.appId) &&
        isLegacyRoomPmMember(member) &&
        member.userOverrides?.some((field) => SHARED_EMPLOYEE_DEFINITION_RUNTIME_FIELDS.has(field)),
    )
    .sort((left, right) => {
      const leftCount =
        left.userOverrides?.filter((field) => SHARED_EMPLOYEE_DEFINITION_RUNTIME_FIELDS.has(field)).length ?? 0;
      const rightCount =
        right.userOverrides?.filter((field) => SHARED_EMPLOYEE_DEFINITION_RUNTIME_FIELDS.has(field)).length ?? 0;
      return rightCount - leftCount || left.id.localeCompare(right.id);
    });
  const source = candidates[0];
  if (!source) return seed;
  const userOverrides = source.userOverrides?.filter((field) => SHARED_EMPLOYEE_DEFINITION_RUNTIME_FIELDS.has(field));
  const migrated = { ...seed, userOverrides };
  const overridden = new Set(userOverrides);
  if (overridden.has("avatarMode")) migrated.avatarMode = source.avatarMode;
  if (overridden.has("avatarSeed")) migrated.avatarSeed = source.avatarSeed;
  if (overridden.has("avatarDataUrl")) migrated.avatarDataUrl = source.avatarDataUrl;
  if (overridden.has("kernel")) migrated.kernel = source.kernel;
  if (overridden.has("model")) migrated.model = source.model;
  if (overridden.has("providerId")) migrated.providerId = source.providerId;
  if (overridden.has("accessMode")) migrated.accessMode = source.accessMode;
  if (overridden.has("reasoningEffort")) migrated.reasoningEffort = source.reasoningEffort;
  if (overridden.has("contextTokenBudget")) migrated.contextTokenBudget = source.contextTokenBudget;
  return migrated;
}

export function applyEmployeeDefinitionRuntimeToScopedSeeds(
  seedMembers: RoomChannelMember[],
  definitionMembers: RoomChannelMember[],
): RoomChannelMember[] {
  const definitions = new Map(
    definitionMembers
      .filter((member) => member.employeeDefinitionId && !member.appId)
      .map((member) => [member.employeeDefinitionId as string, member]),
  );
  return seedMembers.map((seed) => {
    if (!seed.appId || !seed.employeeDefinitionId) return seed;
    const definition = definitions.get(seed.employeeDefinitionId);
    if (!definition) return seed;
    if (seed.manifestDefaults) return seed;
    return {
      ...seed,
      avatarMode: definition.avatarMode,
      avatarSeed: definition.avatarSeed,
      // Keep large upload data on the logical definition instead of copying it
      // into every App-scoped runtime binding and room event.
      avatarDataUrl: undefined,
      kernel: definition.kernel,
      model: definition.model,
      providerId: definition.providerId,
      accessMode: definition.accessMode,
      reasoningEffort: definition.reasoningEffort,
      contextTokenBudget: definition.contextTokenBudget,
    };
  });
}

const KERNEL_DEFAULT_COLORS: Record<string, string> = {
  codex: "#2563eb",
  "claude-code": "#f59e0b",
  hermes: "#7c3aed",
  pi: "#0f766e",
  openclaw: "#ef4444",
  opencode: "#111827",
  kimi: "#00a5ff",
};

function normalizedMountedAppUserOverrides(existing: RoomChannelMember, seed: RoomChannelMember): string[] | undefined {
  if (!existing.userOverrides?.length) return existing.userOverrides;
  const overrides = new Set(existing.userOverrides);
  const defaultKernelColor = KERNEL_DEFAULT_COLORS[existing.kernel];
  if (
    overrides.has("color") &&
    defaultKernelColor &&
    existing.color === defaultKernelColor &&
    seed.color &&
    existing.color !== seed.color
  ) {
    overrides.delete("color");
  }
  return [...overrides];
}

export function shouldDisableStaleMountedAppSeedMember(
  member: RoomChannelMember,
  seedMemberIds: ReadonlySet<string>,
): boolean {
  const appId = member.appId?.trim();
  if (!appId || seedMemberIds.has(member.id)) return false;
  if (member.source && member.source !== "local") return false;
  const currentPrefix = `member-app-${mountedAppMemberSlug(appId)}-`;
  const legacyPrefix = `member-app-${legacyMountedAppMemberSlug(appId)}-`;
  if (!member.id.startsWith(currentPrefix) && !member.id.startsWith(legacyPrefix)) return false;
  return !member.disabled || member.status !== "offline" || member.lastActive !== "manifest removed";
}

const REMOVED_KERNEL_IDS = new Set(["qwen-code", "deepseek-tui", "gemini-cli"]);

export function shouldDisableRemovedKernelEmployee(member: RoomChannelMember): boolean {
  return !member.disabled && REMOVED_KERNEL_IDS.has(member.kernel);
}

export function shouldRestoreMountedAppSeedMember(existing: RoomChannelMember, seed: RoomChannelMember): boolean {
  const appId = existing.appId?.trim();
  if (!appId || appId !== seed.appId) return false;
  if (existing.source && existing.source !== "local") return false;
  // Exact removal sentinel means the member was deliberately removed and must
  // not be resurrected by manifest seed sync.
  if (existing.status === "offline" && existing.lastActive === "已移除") return false;
  return existing.id.startsWith(`member-app-${mountedAppMemberSlug(appId)}-`);
}

export function syncMountedAppDefaultGroups(
  rooms: BridgeState["app"]["rooms"],
  seedMembers: RoomChannelMember[],
  language: SupportedLocale = DEFAULT_LOCALE,
): boolean {
  const grouped = new Map<string, RoomChannelMember[]>();
  for (const member of seedMembers) {
    const appId = member.appId?.trim();
    if (!appId || member.disabled) continue;
    const members = grouped.get(appId) ?? [];
    members.push(member);
    grouped.set(appId, members);
  }
  let changed = false;
  for (const [appId, members] of grouped) {
    const currentMembersById = new Map(rooms.listMembers().map((member) => [member.id, member]));
    const activeMembers = members
      .map((member) => currentMembersById.get(member.id))
      .filter((member): member is RoomChannelMember => Boolean(member && !member.disabled));
    if (!activeMembers.length) continue;
    const appTitle = mountedAppGroupTitle(activeMembers[0], appId);
    const existing = findDefaultAppGroupRoom(rooms.listRooms(), appId);
    const roomId = existing?.id ?? availableDefaultAppGroupRoomId(rooms, appId);
    const scopedPmMemberIds = activeMembers.filter(isRoomPmMember).map((member) => member.id);
    const generatedSequence =
      existing?.generatedTitle?.kind === "app-group" && existing.generatedTitle.appId === appId
        ? existing.generatedTitle.sequence
        : existing
          ? inferLegacyGeneratedAppGroupSequence(existing.title, [appTitle, existing.badge])
          : 1;
    const ownsPresentation = generatedSequence === 1;
    changed =
      rooms.ensureGroupRoom({
        id: roomId,
        scope: { kind: "app", appId, role: "default" },
        title: ownsPresentation
          ? generatedAppGroupTitle(appTitle, 1, language)
          : (existing?.title ?? generatedAppGroupTitle(appTitle, 1, language)),
        badge: ownsPresentation ? appTitle : (existing?.badge ?? appTitle),
        generatedTitle: ownsPresentation ? { kind: "app-group", appId, sequence: 1 } : undefined,
        memberIds: activeMembers.map((member) => member.id),
        adminMemberIds: scopedPmMemberIds.length ? scopedPmMemberIds : undefined,
        preserveExistingMembers: true,
        preserveExistingAdmins: true,
      }) || changed;
    changed = migrateMountedAppGeneratedGroupTitles(rooms, appId, appTitle, language, true) || changed;
  }
  return changed;
}

function availableDefaultAppGroupRoomId(rooms: BridgeState["app"]["rooms"], appId: string): string {
  const preferred = defaultAppGroupRoomId(appId);
  if (!rooms.getRoom(preferred)) return preferred;
  for (let collision = 2; ; collision += 1) {
    const candidate = `${preferred}--${collision}`;
    if (!rooms.getRoom(candidate)) return candidate;
  }
}

/**
 * Reconciles mounted-App group rosters only after every App employee seed has
 * reached its final active/disabled state. This is intentionally a runtime,
 * idempotent consistency pass rather than a storage migration: only here do we
 * have enough information to distinguish the App PM projection from global PM.
 */
export function reconcileMountedAppGroupRooms(
  rooms: BridgeState["app"]["rooms"],
  seedMembers: RoomChannelMember[],
): boolean {
  const activeSeedsByApp = new Map<string, RoomChannelMember[]>();
  for (const member of seedMembers) {
    const appId = member.appId?.trim();
    if (!appId || member.disabled) continue;
    const appMembers = activeSeedsByApp.get(appId) ?? [];
    appMembers.push(member);
    activeSeedsByApp.set(appId, appMembers);
  }

  const currentMembersById = new Map(rooms.listMembers().map((member) => [member.id, member]));
  const appRooms = rooms
    .listRooms()
    .filter((room) => room.kind === "group" && !room.archived && room.scope?.kind === "app");
  let changed = false;
  for (const room of appRooms) {
    const scope = room.scope;
    if (scope?.kind !== "app") continue;
    const appId = scope.appId;
    const appSeeds = activeSeedsByApp.get(appId);
    // An unmounted App has no authoritative runtime roster. Preserve its Room
    // references and history until that exact App is mounted again.
    if (!appSeeds) continue;
    const activeAppSeeds = appSeeds.filter((seed) => {
      const stored = currentMembersById.get(seed.id);
      return Boolean(stored && !stored.disabled && stored.appId === appId);
    });
    const canonicalPmId = pmAgentMemberId(appId);
    const canonicalPm =
      activeAppSeeds.find((member) => member.id === canonicalPmId && isRoomPmMember(member)) ??
      activeAppSeeds.find(isRoomPmMember);
    const removedMemberIds = room.removedMemberIds ?? [];
    const removedMemberIdSet = new Set(removedMemberIds);
    const memberIds: string[] = [];
    let transferPmAdministrator = false;
    for (const memberId of room.memberIds) {
      const member = currentMembersById.get(memberId);
      if (!member || member.disabled) continue;
      if (isLegacyRoomPmMember(member)) {
        if (room.adminMemberIds.includes(memberId)) transferPmAdministrator = true;
        if (canonicalPm && !removedMemberIdSet.has(canonicalPm.id) && !memberIds.includes(canonicalPm.id)) {
          memberIds.push(canonicalPm.id);
        }
        continue;
      }
      if (member.appId && member.appId !== appId) continue;
      if (!memberIds.includes(memberId)) memberIds.push(memberId);
    }

    const ownsSeedRoster =
      scope.role === "default" ||
      room.id === defaultAppGroupRoomId(appId) ||
      (room.generatedTitle?.kind === "app-group" && room.generatedTitle.appId === appId);
    if (ownsSeedRoster) {
      for (const member of activeAppSeeds) {
        if (!removedMemberIdSet.has(member.id) && !memberIds.includes(member.id)) memberIds.push(member.id);
      }
    }

    const adminMemberIds = room.adminMemberIds.filter((memberId) => memberIds.includes(memberId));
    if (
      transferPmAdministrator &&
      canonicalPm &&
      memberIds.includes(canonicalPm.id) &&
      !adminMemberIds.includes(canonicalPm.id)
    ) {
      adminMemberIds.push(canonicalPm.id);
    }

    if (
      JSON.stringify(memberIds) === JSON.stringify(room.memberIds) &&
      JSON.stringify(adminMemberIds) === JSON.stringify(room.adminMemberIds)
    )
      continue;
    rooms.patchRoom(room.id, { memberIds, adminMemberIds });
    changed = true;
  }
  return changed;
}

export function syncMountedAppGroupPresentations(state: BridgeState): boolean {
  const language = resolveHostLanguageSettings(state.settings);
  const membersByApp = new Map<string, RoomChannelMember>();
  for (const member of state.app.rooms.listMembers()) {
    if (member.appId && !member.disabled && !membersByApp.has(member.appId)) {
      membersByApp.set(member.appId, member);
    }
  }
  let changed = false;
  for (const [appId, member] of membersByApp) {
    changed =
      migrateMountedAppGeneratedGroupTitles(
        state.app.rooms,
        appId,
        mountedAppGroupTitle(member, appId),
        language,
        false,
      ) || changed;
  }
  return changed;
}

export function syncNumberedGroupPresentations(state: BridgeState, allowLegacyInference = false): boolean {
  const language = resolveHostLanguageSettings(state.settings);
  let changed = false;
  for (const room of state.app.rooms.listRooms()) {
    if (room.kind !== "group" || room.scope?.kind === "app") continue;
    const sequence =
      room.generatedTitle?.kind === "numbered-group"
        ? room.generatedTitle.sequence
        : allowLegacyInference
          ? inferLegacyNumberedGroupSequence(room.title, room.badge)
          : undefined;
    if (!sequence) continue;
    const title = hostMessage(language, "room.new_group_title", { sequence });
    const badge = hostMessage(language, "room.local_badge");
    if (
      room.title === title &&
      room.badge === badge &&
      room.generatedTitle?.kind === "numbered-group" &&
      room.generatedTitle.sequence === sequence
    )
      continue;
    state.app.rooms.patchRoom(room.id, {
      title,
      badge,
      generatedTitle: { kind: "numbered-group", sequence },
    });
    changed = true;
  }
  return changed;
}

function migrateMountedAppGeneratedGroupTitles(
  rooms: BridgeState["app"]["rooms"],
  appId: string,
  appTitle: string,
  language: SupportedLocale,
  allowLegacyInference: boolean,
): boolean {
  let changed = false;
  for (const room of rooms.listRooms()) {
    if (room.kind !== "group" || room.scope?.kind !== "app" || room.scope.appId !== appId) continue;
    const sequence =
      room.generatedTitle?.kind === "app-group" && room.generatedTitle.appId === appId
        ? room.generatedTitle.sequence
        : allowLegacyInference
          ? inferLegacyGeneratedAppGroupSequence(room.title, [appTitle, room.badge])
          : undefined;
    if (!sequence) continue;
    const title = generatedAppGroupTitle(appTitle, sequence, language);
    if (
      room.title === title &&
      room.badge === appTitle &&
      room.generatedTitle?.kind === "app-group" &&
      room.generatedTitle.appId === appId &&
      room.generatedTitle.sequence === sequence
    )
      continue;
    rooms.patchRoom(room.id, {
      title,
      badge: appTitle,
      generatedTitle: { kind: "app-group", appId, sequence },
    });
    changed = true;
  }
  return changed;
}

function inferLegacyGeneratedAppGroupSequence(
  title: string,
  appTitleCandidates: Array<string | undefined>,
): number | undefined {
  for (const candidate of appTitleCandidates) {
    const appTitle = candidate?.trim();
    if (!appTitle) continue;
    for (const suffix of [" group", " 群组"]) {
      const base = `${appTitle}${suffix}`;
      if (title === base) return 1;
      if (!title.startsWith(`${base} `)) continue;
      const sequenceText = title.slice(base.length + 1);
      if (!/^[1-9]\d*$/.test(sequenceText)) continue;
      return Number(sequenceText);
    }
  }
  return undefined;
}

function generatedAppGroupTitle(appTitle: string, sequence: number, language: SupportedLocale): string {
  return sequence > 1
    ? hostMessage(language, "room.app_group_title_sequence", { appTitle, sequence })
    : hostMessage(language, "room.app_group_title", { appTitle });
}

function inferLegacyNumberedGroupSequence(title: string, badge: string): number | undefined {
  if (!new Set(["Matrix", "Local", "本地"]).has(badge.trim())) return undefined;
  const match = title.trim().match(/^(?:New group|新群聊) ([1-9]\d*)$/u);
  return match ? Number(match[1]) : undefined;
}

function mountedAppGroupTitle(member: RoomChannelMember | undefined, appId: string): string {
  const sourceLabel = member?.sourceLabel
    ?.trim()
    .replace(/\s+App$/i, "")
    .trim();
  return sourceLabel || appId;
}

async function importAppIntoCurrentBridge(state: BridgeState, input: AppImportInput): Promise<AppImportResult> {
  const language = resolveHostLanguageSettings(state.settings);
  const source = input.source?.trim();
  if (!source) {
    return {
      status: "needs_source",
      message: hostMessage(language, "app.import.needs_source"),
    };
  }

  const sourceKind = classifyAppImportSource(source);
  if (sourceKind !== "local") {
    return {
      status: "needs_local_stage",
      message: hostMessage(language, "app.import.needs_local_stage"),
      source,
      sourceKind,
    };
  }

  const sourceRoot = resolveImportSourcePath(source);
  if (!existsSync(sourceRoot)) {
    return {
      status: "source_missing",
      message: hostMessage(language, "app.import.source_missing"),
      source,
      appRoot: sourceRoot,
    };
  }
  if (!statSync(sourceRoot).isDirectory()) {
    return {
      status: "source_not_directory",
      message: hostMessage(language, "app.import.source_not_directory"),
      source,
      appRoot: sourceRoot,
    };
  }

  let appRoot = sourceRoot;
  let packaged = false;
  let packagedFrom = "";
  let selectedFromSourceRoot = "";
  let migrationIssues: string[] = [];
  let validation = validateAppManifestFile(appRoot);
  if (validation.manifestPath) {
    const migration = migrateMountedAppManifestV1(appRoot);
    if (migration.status === "failed" || migration.status === "invalid" || migration.status === "missing") {
      migrationIssues = migration.issues?.length ? migration.issues : [`app_manifest_migration_${migration.status}`];
    }
    validation = validateAppManifestFile(appRoot);
  }
  if (!validation.manifestPath) {
    const nestedCandidates = findNestedAppCandidates(sourceRoot);
    if (nestedCandidates.length > 0) {
      const selected = selectNestedAppCandidate(nestedCandidates, input);
      if (!selected) {
        return {
          status: "needs_app_selection",
          message: hostMessage(language, "app.import.needs_app_selection"),
          source,
          appRoot: sourceRoot,
          candidates: nestedCandidates.map(serializeNestedAppCandidate) as unknown as JsonObject[],
        };
      }
      appRoot = selected.path;
      selectedFromSourceRoot = sourceRoot;
      const migration = migrateMountedAppManifestV1(appRoot);
      if (migration.status === "failed" || migration.status === "invalid" || migration.status === "missing") {
        migrationIssues = migration.issues?.length ? migration.issues : [`app_manifest_migration_${migration.status}`];
      }
      validation = validateAppManifestFile(appRoot);
    }
  }

  if (!validation.manifestPath) {
    try {
      const imported = importProjectAsApp(sourceRoot, {
        title: input.title,
        description: input.description,
        appsDir: bridgeDataPath(state, "apps"),
        force: input.force === true,
      });
      appRoot = imported.appRoot;
      packaged = true;
      packagedFrom = sourceRoot;
      validation = validateAppManifestFile(appRoot);
    } catch (error) {
      return {
        status: "package_failed",
        message: error instanceof Error ? error.message : String(error),
        source,
        appRoot: sourceRoot,
      };
    }
  }

  if (migrationIssues.length || !validation.ok || !validation.manifest) {
    return {
      status: "manifest_needs_fix",
      message: hostMessage(language, "app.import.manifest_needs_fix"),
      source,
      appRoot,
      manifestPath: validation.manifestPath ?? "",
      issues: migrationIssues.length ? migrationIssues : validation.issues,
      packaged,
      packagedFrom,
    };
  }

  const uiPolicyIssue = mountedAppManifestIssue(appRoot);
  if (uiPolicyIssue) {
    return {
      status: "manifest_needs_fix",
      message: hostMessage(language, "app.import.legacy_ui_rejected"),
      source,
      appRoot,
      manifestPath: validation.manifestPath ?? "",
      issues: [uiPolicyIssue],
      packaged,
      packagedFrom,
    };
  }

  const id = validation.manifest.id || slug(input.title ?? basename(appRoot)) || "opengrove-app";
  const title = validation.manifest.title || input.title || titleFromSlug(id);
  const mountedApps = state.settings.mountedApps.map((item) => ({ ...item }));
  const previousIndex = mountedApps.findIndex(
    (item) => item.id === id || (item.path?.trim() ? resolvePathLike(item.path) === resolvePathLike(appRoot) : false),
  );
  const mountedApp: BridgeMountedAppSettings = {
    id,
    path: resolvePathLike(appRoot),
    enabled: true,
    title,
    appBuilderEnabled: previousIndex >= 0 ? mountedApps[previousIndex]?.appBuilderEnabled === true : false,
  };
  const alreadyMounted = previousIndex >= 0 && mountedApps[previousIndex]?.enabled !== false;
  if (previousIndex >= 0) {
    mountedApps[previousIndex] = {
      ...mountedApps[previousIndex],
      ...mountedApp,
    };
  } else {
    mountedApps.push(mountedApp);
  }
  state.settings = {
    ...state.settings,
    mountedApps,
  };
  clearMountedAppUninstallMarkers(state.settings, [id]);
  state.store.saveFrom(state.app);
  saveBridgeSettings(state);
  recreateBridgeApp(state);
  const appMembers = state.app.rooms
    .listMembers()
    .filter((member) => member.appId === id)
    .map((member) => ({
      id: member.id,
      name: member.name,
      kernel: member.kernel,
      availableSkillIds: member.availableSkillIds ?? [],
      defaultSkillIds: member.defaultSkillIds ?? [],
    }));

  return {
    status: alreadyMounted ? "already_mounted" : "mounted",
    message: alreadyMounted
      ? hostMessage(language, "app.import.already_mounted")
      : hostMessage(language, "app.import.mounted"),
    source,
    sourceKind,
    appRoot: mountedApp.path,
    manifestPath: validation.manifestPath ?? "",
    mountedApp: mountedApp as unknown as JsonObject,
    packaged,
    packagedFrom,
    selectedFromSourceRoot,
    liveReloaded: true,
    appMembers: appMembers as unknown as JsonObject[],
  };
}

interface NestedAppCandidate {
  path: string;
  relativePath: string;
  id: string;
  title: string;
  description: string;
  manifestPath: string;
  valid: boolean;
  issues: string[];
  validation: ReturnType<typeof validateAppManifestFile>;
}

function findNestedAppCandidates(sourceRoot: string): NestedAppCandidate[] {
  const candidates: NestedAppCandidate[] = [];
  const visited = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (candidates.length >= MAX_NESTED_APP_CANDIDATES || depth > MAX_NESTED_APP_SCAN_DEPTH) return;
    const resolvedDir = resolvePathLike(dir);
    if (visited.has(resolvedDir)) return;
    visited.add(resolvedDir);
    const manifestPath = join(resolvedDir, "opengrove.app.json");
    if (resolvedDir !== sourceRoot && existsSync(manifestPath)) {
      const validation = validateAppManifestFile(resolvedDir);
      const manifest = validation.manifest;
      candidates.push({
        path: resolvedDir,
        relativePath: relative(sourceRoot, resolvedDir) || ".",
        id: manifest?.id || slug(basename(resolvedDir)) || basename(resolvedDir),
        title: manifest?.title || titleFromSlug(basename(resolvedDir)),
        description: manifest?.description || "",
        manifestPath,
        valid: validation.ok,
        issues: validation.issues ?? [],
        validation,
      });
      return;
    }
    let entries;
    try {
      entries = readdirSync(resolvedDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipNestedAppScanDirectory(entry.name)) continue;
      visit(join(resolvedDir, entry.name), depth + 1);
    }
  };
  visit(sourceRoot, 0);
  return candidates;
}

function selectNestedAppCandidate(
  candidates: NestedAppCandidate[],
  input: AppImportInput,
): NestedAppCandidate | undefined {
  if (candidates.length === 1) return candidates[0];
  const query = normalizeSearchText([input.title, input.description].filter(Boolean).join(" "));
  const tokens = query.split(/\s+/g).filter((token) => token.length >= 2);
  if (!tokens.length) return undefined;
  const scored = candidates
    .map((candidate) => ({ candidate, score: nestedAppCandidateScore(candidate, tokens) }))
    .sort((left, right) => right.score - left.score);
  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score <= 0) return undefined;
  if (runnerUp && runnerUp.score === best.score) return undefined;
  return best.candidate;
}

function nestedAppCandidateScore(candidate: NestedAppCandidate, tokens: string[]): number {
  const id = normalizeSearchText(candidate.id);
  const title = normalizeSearchText(candidate.title);
  const relativePath = normalizeSearchText(candidate.relativePath);
  const description = normalizeSearchText(candidate.description);
  const haystack = `${id} ${title} ${relativePath} ${description}`;
  let score = 0;
  for (const token of tokens) {
    if (id === token || title === token) score += 40;
    if (id.includes(token)) score += 18;
    if (title.includes(token)) score += 16;
    if (relativePath.includes(token)) score += 8;
    if (description.includes(token)) score += 4;
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function serializeNestedAppCandidate(candidate: NestedAppCandidate): JsonObject {
  return {
    id: candidate.id,
    title: candidate.title,
    description: candidate.description,
    path: candidate.path,
    relativePath: candidate.relativePath,
    manifestPath: candidate.manifestPath,
    valid: candidate.valid,
    issues: candidate.issues,
  } as unknown as JsonObject;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}

function shouldSkipNestedAppScanDirectory(name: string): boolean {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === ".venv" ||
    name === "venv" ||
    name === "__pycache__" ||
    name === ".cache" ||
    name === "cache" ||
    name === "dist" ||
    name === "build" ||
    name === ".next" ||
    name === ".turbo" ||
    name === ".pytest_cache"
  );
}

function createBridgeKernelForState(state: BridgeState) {
  try {
    const kernel = createBridgeKernel(state);
    state.kernelUnavailableCode = undefined;
    state.kernelUnavailableReason = undefined;
    return kernel;
  } catch (error) {
    if (!(error instanceof BridgeKernelUnavailableError)) throw error;

    const reason = error.message;
    const unavailableKernel = state.runtimeOverride?.kernel ?? state.settings.kernel;
    state.kernelUnavailableCode = error.code;
    state.kernelUnavailableReason = reason;
    state.kernel = unavailableKernel;
    state.kernelProviderId = undefined;
    state.kernelRuntimeModel = undefined;
    return createUnavailableKernelAdapter({
      kernelId: unavailableKernel,
      title: unavailableKernel,
      reason,
      code: error.code,
    });
  }
}

function titleFromSlug(value: string): string {
  return (
    value
      .split(/[-_.]+/g)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ") || "App Employee"
  );
}

function resolvePathLike(path: string): string {
  if (path === "~") return resolve(process.env.HOME || "");
  if (path.startsWith("~/")) return resolve(process.env.HOME || "", path.slice(2));
  return resolve(path);
}

function resolveImportSourcePath(source: string): string {
  if (source.startsWith("file://")) {
    return resolve(fileURLToPath(source));
  }
  return resolvePathLike(source);
}

function classifyAppImportSource(source: string): "local" | "git" | "archive" | "url" {
  const trimmed = source.trim();
  if (/^(git@|ssh:\/\/)/i.test(trimmed) || /\.git(?:[#?].*)?$/i.test(trimmed)) return "git";
  if (/^https?:\/\//i.test(trimmed) && /\.(zip|tgz|tar|tar\.gz)(?:[#?].*)?$/i.test(trimmed)) return "archive";
  if (/^https?:\/\//i.test(trimmed)) return "url";
  return "local";
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
