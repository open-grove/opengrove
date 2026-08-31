import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenGroveAppManifest } from "../app-builder/manifest.js";
import { computeAppPackageManifest, type AppPackageManifest } from "../app-builder/cli.js";
import {
  restorePersistedAgentState,
  snapshotPersistedAgentState,
  type PersistedAgentState,
} from "../storage/json-state-store.js";
import type { BridgeState } from "./bridge-types.js";
import {
  activatePreparedAppStorePackageInstall,
  appStoreDataRoot,
  commitUpdatedAppStorePackageInstall,
  finalizeUpdatedAppStorePackageInstall,
  readAppStorePackageInstallMarker,
  rollbackUpdatedAppStorePackageInstall,
  type AppStoreInstallResult,
  type PreparedAppStorePackageInstall,
  type UpdatedAppStorePackageInstall,
} from "./app-store.js";
import { mountedAppEffectiveEmployeeDefaults } from "./app-release.js";
import { recreateBridgeApp, saveBridgeSettings, type RecreateBridgeAppOptions } from "./bridge-state.js";
import { resolveMountedAppTarget, type MountedAppTarget } from "./mounted-apps.js";
import {
  LocalAppDraftStore,
  type LocalAppDraftActivation,
  type LocalAppDraftPreparedOpen,
  type LocalAppDraftSummary,
} from "./local-app-drafts.js";
import { appCandidateContentDigest } from "./app-content-digest.js";
import { record } from "./http-utils.js";
import {
  MountedAppVersionStateStore,
  selectedFormalVersionFromMarker,
  type MountedAppVersionState,
  type SelectedFormalAppVersion,
} from "./app-version-state.js";
import {
  appVersionActivationJournalRoot,
  beginAppVersionActivationJournal,
  commitAppVersionActivationJournal,
  removeAppVersionActivationJournal,
  type AppVersionActivationJournal,
} from "./app-version-activation-journal.js";
import type { AppStoreFormalVersion } from "./app-store-registry.js";
import {
  AppRevisionStore,
  appRevisionWorkspacePath,
  isAppRevisionUnavailableError,
  isManagedAppRevisionWorkingCopy,
  type AppSavePoint,
} from "./app-revision-store.js";
import { cancelRoomAssistantRun, hasActiveRoomRunController } from "./room-runs.js";

export interface MountedAppVersionStatus {
  activeContent: "formal" | "local-draft";
  selectedVersion?: SelectedFormalAppVersion;
  latestVersion?: AppStoreFormalVersion;
  versions: AppStoreFormalVersion[];
  localDraft?: LocalAppDraftSummary;
  workingDigest?: string;
  savedContentDigest?: string;
  hasUnsavedChanges: boolean;
  workingDigestError?: string;
  sourceSavePoint?: AppSavePoint;
  sourceChangedFileCount?: number;
}

export interface FormalAppVersionActivationResult {
  install: AppStoreInstallResult;
  versionState: MountedAppVersionState;
  sourceSavePoint?: AppSavePoint;
}

export interface LocalDraftAppVersionActivationResult {
  draft: LocalAppDraftSummary;
  versionState: MountedAppVersionState;
}

export async function activateImportedFormalAppVersion(input: {
  state: BridgeState;
  localAppId: string;
  prepared: PreparedAppStorePackageInstall;
  selectedVersion: SelectedFormalAppVersion;
  versionStore: MountedAppVersionStateStore;
  activateBridgeApp?: (state: BridgeState, options?: RecreateBridgeAppOptions) => void;
  persistBridgeSettings?: (state: BridgeState) => void;
}): Promise<FormalAppVersionActivationResult> {
  const activateBridgeApp = input.activateBridgeApp ?? recreateBridgeApp;
  const persistBridgeSettings = input.persistBridgeSettings ?? saveBridgeSettings;
  const previousSettings = structuredClone(input.state.settings);
  const previousAgentState = snapshotPersistedAgentState(input.state.app, { compactVolatile: false });
  const previousVersionState = input.versionStore.read(input.localAppId);
  const revisionsRoot = join(appStoreDataRoot(input.state), "app-revisions");
  const revisions = new AppRevisionStore(revisionsRoot);
  let previousSourceSavePoint: AppSavePoint | undefined;
  const previousTarget = resolveMountedAppTarget(input.state, input.localAppId);
  if (previousTarget) {
    try {
      const previousRevision = await revisions.inspect({
        localAppId: input.localAppId,
        appRoot: previousTarget.appRoot,
        workspacePath: appRevisionWorkspacePath(previousTarget.manifest),
      });
      previousSourceSavePoint = {
        commitSha: previousRevision.commitSha,
        savedAt: previousRevision.savedAt,
      };
    } catch (error) {
      if (!isAppRevisionUnavailableError(error)) throw error;
    }
  }
  let updatedInstall: UpdatedAppStorePackageInstall | undefined;
  let activationJournal: AppVersionActivationJournal | undefined;
  let sourceSavePoint: AppSavePoint | undefined;
  let activated:
    | {
        install: AppStoreInstallResult;
        versionState: MountedAppVersionState;
        activeTarget: MountedAppTarget;
      }
    | undefined;

  try {
    activationJournal = beginAppVersionActivationJournal({
      root: appVersionActivationJournalRoot(appStoreDataRoot(input.state)),
      kind: "formal",
      localAppId: input.localAppId,
      appRoot: input.prepared.appRoot,
      previousMountedApps: previousSettings.mountedApps,
      previousUninstalledStoreAppIds: previousSettings.uninstalledStoreAppIds,
      previousAgentState,
      previousVersionState,
    });
    const persistedAgentState = persistCapturedAgentState(input.state, previousAgentState);
    const install: AppStoreInstallResult = activatePreparedAppStorePackageInstall({
      prepared: input.prepared,
      settings: input.state.settings,
      backupEnabled: true,
      onUpdatedAppRootCreated: (created) => {
        updatedInstall = created;
      },
    });
    if (!install.appRoot || !install.mountedApp) {
      throw new Error("app_version_formal_target_invalid");
    }
    activateBridgeApp(input.state, {
      authoritativeEmployeeConfigAppId: install.appId,
      deferPersistedStateSave: true,
      agentStateSnapshot: persistedAgentState,
    });
    const activeTarget = resolveMountedAppTarget(input.state, input.localAppId);
    if (!activeTarget) throw new Error("app_version_formal_target_invalid");
    const versionState = input.versionStore.write({
      localAppId: input.localAppId,
      activeContent: "formal",
      selectedVersion: input.selectedVersion,
      activeContentDigest: mountedAppWorkingDigest(input.state, activeTarget),
    });
    if (
      isManagedAppRevisionWorkingCopy({
        revisionsRoot,
        localAppId: input.localAppId,
        appRoot: activeTarget.appRoot,
      })
    ) {
      sourceSavePoint = await revisions.saveIfChanged({
        localAppId: input.localAppId,
        appRoot: activeTarget.appRoot,
        workspacePath: appRevisionWorkspacePath(activeTarget.manifest),
        message: `Activate OpenGrove App Store version ${input.selectedVersion.version}`,
      });
    }
    input.state.store.saveFrom(input.state.app);
    persistBridgeSettings(input.state);
    activationJournal = commitAppVersionActivationJournal(activationJournal);
    if (updatedInstall) commitUpdatedAppStorePackageInstall(updatedInstall);
    if (finalizeFormalProgramActivation(updatedInstall)) {
      removeAppVersionActivationJournal(activationJournal);
      activationJournal = undefined;
    }
    activated = { install, versionState, activeTarget };
  } catch (error) {
    let activationError: unknown = error;
    let rollbackCompleted = false;
    try {
      rollbackFormalProgramActivation(input.state, updatedInstall);
      input.versionStore.restore(input.localAppId, previousVersionState);
      input.state.settings = previousSettings;
      if (sourceSavePoint) {
        if (!previousSourceSavePoint) throw new Error("app_revision_rollback_save_point_missing");
        const restoredTarget = resolveMountedAppTarget(input.state, input.localAppId);
        if (!restoredTarget) throw new Error("app_version_formal_target_invalid");
        await revisions.restoreSavePoint({
          localAppId: input.localAppId,
          appRoot: restoredTarget.appRoot,
          workspacePath: appRevisionWorkspacePath(restoredTarget.manifest),
          commitSha: previousSourceSavePoint.commitSha,
        });
      }
      activateBridgeApp(input.state, {
        deferPersistedStateSave: true,
        agentStateSnapshot: previousAgentState,
      });
      restorePersistedAgentState(input.state.app, previousAgentState);
      input.state.store.saveFrom(input.state.app);
      persistBridgeSettings(input.state);
      rollbackCompleted = true;
    } catch (rollbackError) {
      activationError = new AggregateError([error, rollbackError], "app_version_activation_state_rollback_failed");
    }
    if (rollbackCompleted && activationJournal) {
      removeAppVersionActivationJournal(activationJournal);
    }
    throw activationError;
  }
  return {
    install: activated.install,
    versionState: activated.versionState,
    ...(sourceSavePoint ? { sourceSavePoint } : {}),
  };
}

export function activatePreparedLocalAppDraft(input: {
  state: BridgeState;
  localAppId: string;
  draftStore: LocalAppDraftStore;
  prepared: LocalAppDraftPreparedOpen;
  selectedVersion?: SelectedFormalAppVersion;
  versionStore: MountedAppVersionStateStore;
  activateBridgeApp?: (state: BridgeState, options?: RecreateBridgeAppOptions) => void;
  persistBridgeSettings?: (state: BridgeState) => void;
}): LocalDraftAppVersionActivationResult {
  const activateBridgeApp = input.activateBridgeApp ?? recreateBridgeApp;
  const persistBridgeSettings = input.persistBridgeSettings ?? saveBridgeSettings;
  const draft = input.draftStore.preparedOpenSummary(input.prepared);
  const previousSettings = structuredClone(input.state.settings);
  const previousAgentState = snapshotPersistedAgentState(input.state.app, { compactVolatile: false });
  const previousVersionState = input.versionStore.read(input.localAppId);
  let programActivation: LocalAppDraftActivation | undefined;
  let activationJournal: AppVersionActivationJournal | undefined;

  try {
    activationJournal = beginAppVersionActivationJournal({
      root: appVersionActivationJournalRoot(appStoreDataRoot(input.state)),
      kind: "local-draft",
      localAppId: input.localAppId,
      appRoot: input.prepared.appRoot,
      previousMountedApps: previousSettings.mountedApps,
      previousUninstalledStoreAppIds: previousSettings.uninstalledStoreAppIds,
      previousAgentState,
      previousVersionState,
    });
    const persistedAgentState = persistCapturedAgentState(input.state, previousAgentState);
    const mountedApp = input.state.settings.mountedApps.find(
      (candidate) => candidate.id === input.localAppId || candidate.path === input.prepared.appRoot,
    );
    programActivation = input.draftStore.activatePreparedOpen(input.prepared, {
      selectedVersion: input.selectedVersion,
      ...(mountedApp?.workspacePath ? { workspaceRoot: mountedApp.workspacePath } : {}),
    });
    activateBridgeApp(input.state, {
      authoritativeEmployeeConfigAppId: draft.appId,
      deferPersistedStateSave: true,
      agentStateSnapshot: persistedAgentState,
    });
    const versionState = input.versionStore.write({
      localAppId: input.localAppId,
      activeContent: "local-draft",
      selectedVersion: input.selectedVersion,
      activeContentDigest: draft.workingContentDigest,
    });
    input.state.store.saveFrom(input.state.app);
    persistBridgeSettings(input.state);
    activationJournal = commitAppVersionActivationJournal(activationJournal);
    input.draftStore.commitOpen(programActivation);
    if (finalizeDraftProgramActivation(input.draftStore, programActivation)) {
      removeAppVersionActivationJournal(activationJournal);
      activationJournal = undefined;
    }
    return { draft, versionState };
  } catch (error) {
    let activationError: unknown = error;
    let rollbackCompleted = false;
    try {
      if (programActivation) input.draftStore.rollbackOpen(programActivation);
      input.versionStore.restore(input.localAppId, previousVersionState);
      input.state.settings = previousSettings;
      activateBridgeApp(input.state, {
        deferPersistedStateSave: true,
        agentStateSnapshot: previousAgentState,
      });
      restorePersistedAgentState(input.state.app, previousAgentState);
      input.state.store.saveFrom(input.state.app);
      persistBridgeSettings(input.state);
      rollbackCompleted = true;
    } catch (rollbackError) {
      activationError = new AggregateError([error, rollbackError], "app_version_draft_state_rollback_failed");
    }
    if (rollbackCompleted && activationJournal) {
      removeAppVersionActivationJournal(activationJournal);
    }
    throw activationError;
  }
}

export function inspectMountedAppVersionStatus(input: {
  state: BridgeState;
  target: MountedAppTarget;
  localDraft?: LocalAppDraftSummary;
  versionState?: MountedAppVersionState;
  versions: AppStoreFormalVersion[];
}): MountedAppVersionStatus {
  const selectedVersion =
    input.versionState?.selectedVersion ??
    selectedFormalVersionFromMarker(readAppStorePackageInstallMarker(input.target.appRoot));
  const activeContent =
    input.versionState?.activeContent ?? (selectedVersion ? "formal" : input.localDraft ? "local-draft" : "formal");
  let workingDigest: string | undefined;
  let workingDigestError: string | undefined;
  try {
    workingDigest = mountedAppWorkingDigest(input.state, input.target);
  } catch (error) {
    workingDigestError = error instanceof Error ? error.message : String(error);
  }
  const savedContentDigest =
    input.versionState?.activeContentDigest ??
    (activeContent === "local-draft"
      ? input.localDraft?.contentDigest
      : installedFormalContentDigest(input.target.appRoot));
  const knownSavedDigests = new Set(
    [
      input.versionState?.activeContentDigest,
      installedFormalContentDigest(input.target.appRoot),
      input.localDraft?.contentDigest,
      input.localDraft?.workingContentDigest,
    ].filter((digest): digest is string => Boolean(digest)),
  );
  return {
    activeContent,
    ...(selectedVersion ? { selectedVersion } : {}),
    ...(input.versions[0] ? { latestVersion: input.versions[0] } : {}),
    versions: input.versions.map((version) => ({ ...version })),
    ...(input.localDraft ? { localDraft: input.localDraft } : {}),
    ...(workingDigest ? { workingDigest } : {}),
    ...(savedContentDigest ? { savedContentDigest } : {}),
    hasUnsavedChanges: !workingDigest || !knownSavedDigests.has(workingDigest),
    ...(workingDigestError ? { workingDigestError } : {}),
  };
}

export function mountedAppWorkingDigest(state: BridgeState, target: MountedAppTarget): string {
  return mountedAppWorkingDigestForRoot(target.appRoot, mountedAppWorkingManifest(state, target));
}

export function mountedAppWorkingManifest(state: BridgeState, target: MountedAppTarget): OpenGroveAppManifest {
  const manifest = structuredClone(target.manifest) as OpenGroveAppManifest;
  const store = record(manifest.store);
  manifest.store = {
    ...store,
    employeeDefaults: mountedAppWorkingEmployeeDefaults(state, target.id, store.employeeDefaults),
  } as OpenGroveAppManifest["store"];
  return manifest;
}

export function mountedAppWorkingDigestForRoot(appRoot: string, manifestOverride: OpenGroveAppManifest): string {
  return appCandidateContentDigest(mountedAppWorkingPackageManifestForRoot(appRoot, manifestOverride));
}

export function mountedAppWorkingPackageManifestForRoot(
  appRoot: string,
  manifestOverride: OpenGroveAppManifest,
): AppPackageManifest {
  return computeAppPackageManifest(appRoot, {
    manifestOverride,
    allowSetup: true,
    purpose: "local-draft",
  });
}

function mountedAppWorkingEmployeeDefaults(
  state: BridgeState,
  appId: string,
  declaredDefaultsValue: unknown,
): Array<Record<string, unknown>> {
  const declaredByMemberId = new Map(
    arrayRecords(declaredDefaultsValue).flatMap((defaults) => {
      const memberId = typeof defaults.memberId === "string" ? defaults.memberId.trim() : "";
      return memberId ? [[memberId, defaults] as const] : [];
    }),
  );
  const membersById = new Map(state.app.rooms.listMembers().map((member) => [member.id, member]));
  return mountedAppEffectiveEmployeeDefaults(state, appId).map((employee) => {
    const declared = declaredByMemberId.get(employee.memberId);
    const member = membersById.get(employee.memberId);
    const hasPackageOverride = member?.userOverrides?.some((field) => field !== "providerId") === true;
    // Host normalization and one-time migrations change runtime state, not the
    // immutable App source. Keep the released declaration in the working digest
    // until a user actually changes a package-owned Employee field.
    return declared && !hasPackageOverride ? structuredClone(declared) : { ...employee };
  });
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
}

export function activeMountedAppRuns(
  state: BridgeState,
  appId: string,
): Array<{
  roomId: string;
  messageId: string;
  runId: string;
  memberId: string;
}> {
  const memberIds = new Set(
    state.app.rooms
      .listMembers()
      .filter((member) => member.appId === appId)
      .map((member) => member.id),
  );
  if (!memberIds.size) return [];
  return state.app.rooms.listRooms().flatMap((room) =>
    state.app.rooms
      .listMessages(room.id, { limit: 500, audience: "all" })
      .filter(
        (message) =>
          message.senderType === "agent" &&
          message.status === "running" &&
          memberIds.has(message.senderId) &&
          Boolean(message.runId),
      )
      .map((message) => ({
        roomId: room.id,
        messageId: message.id,
        runId: message.runId!,
        memberId: message.senderId,
      })),
  );
}

export async function forceStopMountedAppRuns(
  state: BridgeState,
  appId: string,
  timeoutMs = 15_000,
): Promise<{ stopped: boolean; runs: ReturnType<typeof activeMountedAppRuns> }> {
  const initial = activeMountedAppRuns(state, appId);
  for (const run of initial) cancelRoomAssistantRun(state, run.runId);
  const deadline = Date.now() + timeoutMs;
  let remaining = activeMountedAppRuns(state, appId);
  while (remaining.some((run) => hasActiveRoomRunController(state, run.runId)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    remaining = activeMountedAppRuns(state, appId);
  }
  remaining = activeMountedAppRuns(state, appId);
  return {
    stopped: remaining.length === 0,
    runs: remaining,
  };
}

function installedFormalContentDigest(appRoot: string): string | undefined {
  const path = join(appRoot, ".opengrove-package-manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return undefined;
    return appCandidateContentDigest(manifest as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function rollbackFormalProgramActivation(
  state: BridgeState,
  updatedInstall: UpdatedAppStorePackageInstall | undefined,
): void {
  if (updatedInstall) {
    rollbackUpdatedAppStorePackageInstall({
      ...updatedInstall,
      storeRoot: appStoreDataRoot(state),
    });
  }
}

function finalizeFormalProgramActivation(updatedInstall: UpdatedAppStorePackageInstall | undefined): boolean {
  try {
    if (updatedInstall) finalizeUpdatedAppStorePackageInstall(updatedInstall);
    return true;
  } catch {
    // The activated tree is authoritative; a recovery copy is safer than undoing a valid switch.
    return false;
  }
}

function finalizeDraftProgramActivation(draftStore: LocalAppDraftStore, activation: LocalAppDraftActivation): boolean {
  try {
    draftStore.finalizeOpen(activation);
    return true;
  } catch {
    // The active draft is authoritative; a retained recovery copy is safer than undoing it.
    return false;
  }
}

function persistCapturedAgentState(state: BridgeState, snapshot: PersistedAgentState): PersistedAgentState {
  return state.store.saveSnapshot?.(snapshot) ?? state.store.saveFrom(state.app);
}
