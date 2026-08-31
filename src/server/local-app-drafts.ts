import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../core.js";
import type { AppReleaseEmployeeDefaults } from "./app-release.js";
import type { AppSavePoint } from "./app-revision-store.js";
import { appCandidateContentDigest } from "./app-content-digest.js";
import {
  extractAppStoreAppArchive,
  appStoreInstallContainerRoot,
  preservableWorkspaceRelativePath,
  withAppStoreInstallLock,
  type AppStoreArchive,
} from "./app-store.js";
import { readMountedAppManifest } from "./mounted-apps.js";
import { selectedFormalVersionFromMarker, type SelectedFormalAppVersion } from "./app-version-state.js";
import {
  appProgramActivationBackupParent,
  appProgramActivationTransactionParent,
  beginAppProgramActivationRecovery,
  commitAppProgramActivationRecovery,
  finalizeCommittedAppProgramActivation,
} from "./app-program-activation-recovery.js";
import { readCompatibleLocalAppDraftRecord } from "./local-app-draft-record.compat.js";
import { writePrivateFileAtomically } from "./private-file.js";

const LOCAL_APP_DRAFT_SCHEMA_VERSION = 1;

export interface LocalAppDraftPublishBase {
  packageKey?: string;
  version?: string;
  releaseCommitSha?: string;
  archiveSha256?: string;
}

export type LocalAppDraftSavePoint = AppSavePoint;

export interface LocalAppDraftSummary {
  schemaVersion: 1;
  localAppId: string;
  appId: string;
  savedAt: string;
  archiveSha256: string;
  archiveSize: number;
  contentDigest: string;
  workingContentDigest: string;
  employees: AppReleaseEmployeeDefaults[];
  savePoint?: LocalAppDraftSavePoint;
  publishBase?: LocalAppDraftPublishBase;
}

export interface LocalAppDraftRecord extends LocalAppDraftSummary {
  archiveFile: string;
}

export interface LocalAppDraftActivation {
  localAppId: string;
  appId: string;
  appRoot: string;
  backupContainer: string;
  previousAppRoot: string;
  previousWorkspaceRelativePath: string;
  nextWorkspaceRelativePath: string;
  workspaceMoved: boolean;
  gitMoved: boolean;
}

export interface LocalAppDraftPreparedOpen {
  readonly localAppId: string;
  readonly appId: string;
  readonly appRoot: string;
}

export interface LocalAppDraftFileOperations {
  rename(source: string, destination: string): void;
}

interface LocalAppDraftPreparedOpenState {
  owner: LocalAppDraftStore;
  transactionRoot: string;
  stagedAppRoot: string;
  nextWorkspaceRelativePath: string;
  packageManifest: Record<string, unknown>;
  draft: LocalAppDraftSummary;
  stagedTreeDigest: string;
  status: "prepared" | "activating" | "activated" | "disposed" | "recovery-required";
}

const preparedOpenStates = new WeakMap<LocalAppDraftPreparedOpen, LocalAppDraftPreparedOpenState>();

export class LocalAppDraftStore {
  constructor(
    private readonly root: string,
    private readonly fileOperations: LocalAppDraftFileOperations = { rename: renameSync },
  ) {}

  // ===== Record storage =====

  has(localAppId: string): boolean {
    return existsSync(join(this.draftRoot(localAppId), "current.json"));
  }

  delete(localAppId: string): boolean {
    const root = this.draftRoot(localAppId);
    if (!existsSync(root)) return false;
    rmSync(root, { recursive: true, force: true });
    return true;
  }

  deleteIfContentUnchanged(input: { localAppId: string; expectedContentDigest: string }): boolean {
    if (!/^[a-f0-9]{64}$/.test(input.expectedContentDigest)) {
      throw new Error("local_app_draft_content_digest_invalid");
    }
    return withAppStoreInstallLock(this.draftRoot(input.localAppId), () => {
      const record = this.readOrUpgradeRecord(input.localAppId);
      if (!record) return false;
      if (record.contentDigest !== input.expectedContentDigest) {
        throw new Error("app_store_publish_draft_changed");
      }
      rmSync(this.draftRoot(input.localAppId), { recursive: true, force: true });
      return true;
    });
  }

  save(input: {
    localAppId: string;
    appId: string;
    archive: AppStoreArchive;
    employees: AppReleaseEmployeeDefaults[];
    savePoint?: LocalAppDraftSavePoint;
    workingContentDigest?: string;
    publishBase?: LocalAppDraftPublishBase;
    expectedPrevious?: LocalAppDraftSummary;
  }): LocalAppDraftSummary {
    return withAppStoreInstallLock(this.draftRoot(input.localAppId), () => {
      if (input.expectedPrevious) {
        const current = this.readOrUpgradeRecord(input.localAppId);
        if (!current || !isDeepStrictEqual(publicDraftSummary(current), cloneDraftSummary(input.expectedPrevious))) {
          throw new Error("app_store_publish_draft_changed");
        }
      }
      return this.saveUnlocked(input);
    });
  }

  advancePublishBaseIfContentUnchanged(input: {
    localAppId: string;
    expectedContentDigest: string;
    publishBase: Required<LocalAppDraftPublishBase>;
  }): LocalAppDraftSummary {
    if (!/^[a-f0-9]{64}$/.test(input.expectedContentDigest) || !validCompletePublishBase(input.publishBase)) {
      throw new Error("local_app_draft_publish_base_invalid");
    }
    return withAppStoreInstallLock(this.draftRoot(input.localAppId), () => {
      const record = this.readOrUpgradeRecord(input.localAppId);
      if (!record) throw new Error("local_app_draft_not_found");
      if (record.contentDigest !== input.expectedContentDigest) {
        throw new Error("app_store_publish_draft_changed");
      }
      const updated: LocalAppDraftRecord = {
        ...record,
        publishBase: {
          packageKey: input.publishBase.packageKey,
          version: input.publishBase.version,
          releaseCommitSha: input.publishBase.releaseCommitSha.toLowerCase(),
          archiveSha256: input.publishBase.archiveSha256.toLowerCase(),
        },
      };
      writePrivateFileAtomically(
        join(this.draftRoot(input.localAppId), "current.json"),
        Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, "utf8"),
      );
      return publicDraftSummary(updated);
    });
  }

  restorePreviousIfContentUnchanged(input: {
    previous: LocalAppDraftSummary;
    expectedCurrent: LocalAppDraftSummary;
    archivePath: string;
  }): LocalAppDraftSummary {
    if (
      input.previous.localAppId.trim() !== input.previous.localAppId ||
      !input.previous.localAppId ||
      input.expectedCurrent.localAppId !== input.previous.localAppId
    ) {
      throw new Error("local_app_draft_restore_invalid");
    }
    return withAppStoreInstallLock(this.draftRoot(input.previous.localAppId), () => {
      const current = this.readOrUpgradeRecord(input.previous.localAppId);
      if (!current || !isDeepStrictEqual(publicDraftSummary(current), cloneDraftSummary(input.expectedCurrent))) {
        throw new Error("app_store_publish_draft_changed");
      }
      const archiveBytes = readFileSync(input.archivePath);
      if (
        archiveBytes.byteLength !== input.previous.archiveSize ||
        sha256(archiveBytes) !== input.previous.archiveSha256
      ) {
        throw new Error("local_app_draft_restore_archive_changed");
      }
      const draftRoot = this.draftRoot(input.previous.localAppId);
      const archivesRoot = join(draftRoot, "archives");
      mkdirSync(archivesRoot, { recursive: true });
      const archiveFile = `archives/${input.previous.archiveSha256}.tgz`;
      writePrivateFileAtomically(join(draftRoot, archiveFile), archiveBytes);
      const restored: LocalAppDraftRecord = {
        ...cloneDraftSummary(input.previous),
        archiveFile,
      };
      writePrivateFileAtomically(
        join(draftRoot, "current.json"),
        Buffer.from(`${JSON.stringify(restored, null, 2)}\n`, "utf8"),
      );
      for (const name of readdirSync(archivesRoot)) {
        if (name === basename(archiveFile)) continue;
        try {
          rmSync(join(archivesRoot, name), { force: true });
        } catch {
          // The restored pointer is already authoritative; stale bytes are harmless.
        }
      }
      return publicDraftSummary(restored);
    });
  }

  private saveUnlocked(input: {
    localAppId: string;
    appId: string;
    archive: AppStoreArchive;
    employees: AppReleaseEmployeeDefaults[];
    savePoint?: LocalAppDraftSavePoint;
    workingContentDigest?: string;
    publishBase?: LocalAppDraftPublishBase;
  }): LocalAppDraftSummary {
    if (stringValue(input.archive.manifest.id) !== input.appId) {
      throw new Error("local_app_draft_identity_mismatch");
    }
    if (stringValue(input.archive.packageManifest.appId) !== input.appId) {
      throw new Error("local_app_draft_identity_mismatch");
    }
    const contentDigest = appCandidateContentDigest(input.archive.packageManifest);
    const workingContentDigest = input.workingContentDigest ?? contentDigest;
    if (!/^[a-f0-9]{64}$/.test(workingContentDigest)) {
      throw new Error("local_app_draft_working_content_digest_invalid");
    }
    const draftRoot = this.draftRoot(input.localAppId);
    const archivesRoot = join(draftRoot, "archives");
    mkdirSync(archivesRoot, { recursive: true });
    const archiveFile = `archives/${input.archive.archiveSha256}.tgz`;
    const archivePath = join(draftRoot, archiveFile);
    if (existsSync(archivePath)) {
      if (
        statSync(archivePath).size !== input.archive.bytes.byteLength ||
        sha256(readFileSync(archivePath)) !== input.archive.archiveSha256
      ) {
        throw new Error("local_app_draft_archive_conflict");
      }
    } else {
      writePrivateFileAtomically(archivePath, input.archive.bytes);
    }
    const record: LocalAppDraftRecord = {
      schemaVersion: LOCAL_APP_DRAFT_SCHEMA_VERSION,
      localAppId: input.localAppId,
      appId: input.appId,
      savedAt: new Date().toISOString(),
      archiveFile,
      archiveSha256: input.archive.archiveSha256,
      archiveSize: input.archive.bytes.byteLength,
      contentDigest,
      workingContentDigest,
      employees: input.employees.map((employee) => ({ ...employee })),
      ...(input.savePoint ? { savePoint: { ...input.savePoint } } : {}),
      ...(input.publishBase ? { publishBase: { ...input.publishBase } } : {}),
    };
    writePrivateFileAtomically(
      join(draftRoot, "current.json"),
      Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"),
    );
    for (const name of readdirSync(archivesRoot)) {
      if (name === basename(archiveFile)) continue;
      try {
        rmSync(join(archivesRoot, name), { force: true });
      } catch {
        // The pointer already changed; stale unreferenced bytes can be cleaned up on a later save.
      }
    }
    return publicDraftSummary(record);
  }

  read(localAppId: string): LocalAppDraftSummary | undefined {
    const record = this.readOrUpgradeRecord(localAppId);
    return record ? publicDraftSummary(record) : undefined;
  }

  archivePath(localAppId: string): string | undefined {
    const record = this.readOrUpgradeRecord(localAppId);
    if (!record) return undefined;
    return verifiedDraftArchivePath(this.draftRoot(localAppId), record);
  }

  // ===== Prepared activation transaction =====

  prepareOpen(input: { localAppId: string; appRoot: string }): LocalAppDraftPreparedOpen {
    const record = this.readOrUpgradeRecord(input.localAppId);
    if (!record) throw new Error("local_app_draft_not_found");
    const archivePath = this.archivePath(input.localAppId);
    if (!archivePath) throw new Error("local_app_draft_not_found");
    const appRoot = resolve(input.appRoot);
    const transactionParent = appProgramActivationTransactionParent("local-draft", appRoot);
    mkdirSync(transactionParent, { recursive: true });
    const transactionRoot = mkdtempSync(join(transactionParent, "draft-"));
    const stagedAppRoot = join(transactionRoot, "next-app");
    try {
      extractAppStoreAppArchive({ archivePath, targetRoot: stagedAppRoot });
      const packageManifest = readDraftPackageManifest(stagedAppRoot);
      assertDraftPackageTree(stagedAppRoot, packageManifest);
      if (
        stringValue(packageManifest.appId) !== record.appId ||
        appCandidateContentDigest(packageManifest) !== record.contentDigest
      ) {
        throw new Error("local_app_draft_content_identity_mismatch");
      }
      rmSync(join(stagedAppRoot, ".opengrove-package-manifest.json"), { force: true });
      const draftManifest = requireMountedAppManifest(stagedAppRoot, "local_app_draft_identity_mismatch");
      if (stringValue(draftManifest.id) !== record.appId) {
        throw new Error("local_app_draft_identity_mismatch");
      }
      const nextWorkspaceRelativePath = preservableWorkspaceRelativePath(stagedAppRoot, draftManifest);
      if (!nextWorkspaceRelativePath) throw new Error("local_app_draft_workspace_invalid");
      const prepared = Object.freeze({
        localAppId: input.localAppId,
        appId: record.appId,
        appRoot,
      });
      preparedOpenStates.set(prepared, {
        owner: this,
        transactionRoot,
        stagedAppRoot,
        nextWorkspaceRelativePath,
        packageManifest,
        draft: publicDraftSummary(record),
        stagedTreeDigest: draftTreeDigest(stagedAppRoot),
        status: "prepared",
      });
      return prepared;
    } catch (error) {
      rmSync(transactionRoot, { recursive: true, force: true });
      throw error;
    }
  }

  cancelPreparedOpen(prepared: LocalAppDraftPreparedOpen): void {
    const state = preparedOpenStates.get(prepared);
    if (!state || state.owner !== this) return;
    if (state.status === "activating") throw new Error("local_app_draft_prepared_busy");
    if (state.status === "recovery-required") return;
    rmSync(state.transactionRoot, { recursive: true, force: true });
    state.status = "disposed";
    preparedOpenStates.delete(prepared);
  }

  preparedOpenSummary(prepared: LocalAppDraftPreparedOpen): LocalAppDraftSummary {
    const state = preparedOpenStates.get(prepared);
    if (!state || state.owner !== this || state.status !== "prepared") {
      throw new Error("local_app_draft_prepared_invalid");
    }
    return cloneDraftSummary(state.draft);
  }

  activatePreparedOpen(
    prepared: LocalAppDraftPreparedOpen,
    options: {
      selectedVersion?: SelectedFormalAppVersion;
      /** Host-owned Workspace binding used by side-by-side Store programs. */
      workspaceRoot?: string;
    } = {},
  ): LocalAppDraftActivation {
    const preparedState = preparedOpenStates.get(prepared);
    if (!preparedState || preparedState.owner !== this || preparedState.status !== "prepared") {
      throw new Error("local_app_draft_prepared_invalid");
    }
    const currentDraft = this.read(prepared.localAppId);
    if (
      !currentDraft ||
      currentDraft.archiveSha256 !== preparedState.draft.archiveSha256 ||
      currentDraft.contentDigest !== preparedState.draft.contentDigest
    ) {
      throw new Error("local_app_draft_target_changed");
    }
    preparedState.status = "activating";
    const { transactionRoot, stagedAppRoot, nextWorkspaceRelativePath } = preparedState;
    const appRoot = prepared.appRoot;
    let backupContainer: string | undefined;
    let completed: LocalAppDraftActivation | undefined;
    let preserveRecovery = false;
    try {
      assertPreparedOpenPaths(prepared, preparedState);
      assertStagedDraftTreeReady(prepared, preparedState);
      withAppStoreInstallLock(appStoreInstallContainerRoot(appRoot, prepared.appId), () => {
        const currentEntry = pathEntry(appRoot);
        const currentManifest = requireMountedAppManifest(appRoot, "local_app_draft_target_changed");
        if (
          !currentEntry?.isDirectory() ||
          currentEntry.isSymbolicLink() ||
          stringValue(currentManifest.id) !== prepared.appId
        ) {
          throw new Error("local_app_draft_target_changed");
        }
        const previousWorkspaceRelativePath = options.workspaceRoot
          ? declaredWorkspaceRelativePath(appRoot, currentManifest)
          : preservableWorkspaceRelativePath(appRoot, currentManifest);
        if (!previousWorkspaceRelativePath) throw new Error("local_app_draft_workspace_invalid");

        const currentWorkspaceRoot = resolve(appRoot, previousWorkspaceRelativePath);
        const currentWorkspaceEntry = pathEntry(currentWorkspaceRoot);
        if (options.workspaceRoot) {
          assertExternalWorkspaceBinding(currentWorkspaceRoot, options.workspaceRoot);
        } else if (
          currentWorkspaceEntry &&
          (!currentWorkspaceEntry.isDirectory() || currentWorkspaceEntry.isSymbolicLink())
        ) {
          throw new Error("local_app_draft_workspace_invalid");
        }
        const currentGitRoot = join(appRoot, ".git");
        const currentGitEntry = pathEntry(currentGitRoot);
        const recovery = beginAppProgramActivationRecovery({
          kind: "local-draft",
          appRoot,
          transactionRoot,
          stagedAppRoot,
          previousWorkspaceRelativePath,
          nextWorkspaceRelativePath,
          previousWorkspacePresent: Boolean(currentWorkspaceEntry && !options.workspaceRoot),
          previousGitPresent: Boolean(currentGitEntry),
        });
        backupContainer = recovery.backupContainer;
        const previousAppRoot = recovery.previousAppRoot;
        const previousWorkspaceRoot = resolve(previousAppRoot, previousWorkspaceRelativePath);
        const stagedWorkspaceRoot = resolve(stagedAppRoot, nextWorkspaceRelativePath);
        let workspaceMoved = false;
        let gitMoved = false;
        let previousAppMoved = false;
        try {
          this.fileOperations.rename(appRoot, previousAppRoot);
          previousAppMoved = true;
          const workspaceEntry = pathEntry(previousWorkspaceRoot);
          if (options.workspaceRoot) {
            const stagedWorkspaceRoot = resolve(stagedAppRoot, nextWorkspaceRelativePath);
            rmSync(stagedWorkspaceRoot, { recursive: true, force: true });
            mkdirSync(dirname(stagedWorkspaceRoot), { recursive: true });
            symlinkSync(
              resolve(options.workspaceRoot),
              stagedWorkspaceRoot,
              process.platform === "win32" ? "junction" : "dir",
            );
          } else if (workspaceEntry) {
            if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) {
              throw new Error("local_app_draft_workspace_invalid");
            }
            rmSync(stagedWorkspaceRoot, { recursive: true, force: true });
            mkdirSync(dirname(stagedWorkspaceRoot), { recursive: true });
            this.fileOperations.rename(previousWorkspaceRoot, stagedWorkspaceRoot);
            workspaceMoved = true;
          }
          const previousGitRoot = join(previousAppRoot, ".git");
          if (currentGitEntry) {
            const movedGitEntry = pathEntry(previousGitRoot);
            if (
              !movedGitEntry ||
              (!movedGitEntry.isDirectory() && !movedGitEntry.isFile()) ||
              movedGitEntry.isSymbolicLink()
            ) {
              throw new Error("local_app_draft_git_invalid");
            }
            this.fileOperations.rename(previousGitRoot, join(stagedAppRoot, ".git"));
            gitMoved = true;
          }
          writeLocalDraftInstallMarker({
            previousAppRoot,
            stagedAppRoot,
            appId: prepared.appId,
            draftContentDigest: preparedState.draft.contentDigest,
            selectedVersion: options.selectedVersion,
          });
          rmSync(join(stagedAppRoot, ".opengrove-package-manifest.json"), { force: true });
          this.fileOperations.rename(stagedAppRoot, appRoot);
          completed = {
            localAppId: prepared.localAppId,
            appId: prepared.appId,
            appRoot,
            backupContainer,
            previousAppRoot,
            previousWorkspaceRelativePath,
            nextWorkspaceRelativePath,
            workspaceMoved,
            gitMoved,
          };
          preparedState.status = "activated";
        } catch (error) {
          try {
            if (gitMoved) {
              this.fileOperations.rename(join(stagedAppRoot, ".git"), join(previousAppRoot, ".git"));
            }
            if (workspaceMoved) {
              mkdirSync(dirname(previousWorkspaceRoot), { recursive: true });
              this.fileOperations.rename(stagedWorkspaceRoot, previousWorkspaceRoot);
            }
            if (previousAppMoved) this.fileOperations.rename(previousAppRoot, appRoot);
          } catch (rollbackError) {
            preserveRecovery = true;
            preparedState.status = "recovery-required";
            throw new AggregateError([error, rollbackError], "local_app_draft_open_rollback_failed");
          }
          throw error;
        }
      });
    } finally {
      if (!preserveRecovery) {
        rmSync(transactionRoot, { recursive: true, force: true });
        if (backupContainer && !completed) {
          rmSync(backupContainer, { recursive: true, force: true });
        }
        if (!completed) preparedState.status = "disposed";
        preparedOpenStates.delete(prepared);
      }
    }
    if (!completed) throw new Error("local_app_draft_open_failed");
    return completed;
  }

  finalizeOpen(activation: LocalAppDraftActivation): void {
    assertActivationPaths(activation);
    finalizeCommittedAppProgramActivation(activation.appRoot);
  }

  commitOpen(activation: LocalAppDraftActivation): void {
    assertActivationPaths(activation);
    if (!commitAppProgramActivationRecovery(activation.appRoot)) {
      throw new Error("local_app_draft_activation_recovery_missing");
    }
  }

  rollbackOpen(activation: LocalAppDraftActivation): void {
    assertActivationPaths(activation);
    withAppStoreInstallLock(appStoreInstallContainerRoot(activation.appRoot, activation.appId), () => {
      const failedAppRoot = join(activation.backupContainer, "failed-app");
      if (pathEntry(failedAppRoot) || !pathEntry(activation.previousAppRoot)) {
        throw new Error("local_app_draft_rollback_target_changed");
      }
      this.fileOperations.rename(activation.appRoot, failedAppRoot);
      let workspaceReturned = false;
      let gitReturned = false;
      try {
        if (activation.workspaceMoved) {
          const currentWorkspaceRoot = resolve(failedAppRoot, activation.nextWorkspaceRelativePath);
          const previousWorkspaceRoot = resolve(activation.previousAppRoot, activation.previousWorkspaceRelativePath);
          if (pathEntry(previousWorkspaceRoot)) throw new Error("local_app_draft_rollback_target_changed");
          mkdirSync(dirname(previousWorkspaceRoot), { recursive: true });
          this.fileOperations.rename(currentWorkspaceRoot, previousWorkspaceRoot);
          workspaceReturned = true;
        }
        if (activation.gitMoved) {
          const previousGitRoot = join(activation.previousAppRoot, ".git");
          if (pathEntry(previousGitRoot)) throw new Error("local_app_draft_rollback_target_changed");
          this.fileOperations.rename(join(failedAppRoot, ".git"), previousGitRoot);
          gitReturned = true;
        }
        this.fileOperations.rename(activation.previousAppRoot, activation.appRoot);
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        if (gitReturned) {
          try {
            this.fileOperations.rename(join(activation.previousAppRoot, ".git"), join(failedAppRoot, ".git"));
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
        }
        if (workspaceReturned) {
          try {
            this.fileOperations.rename(
              resolve(activation.previousAppRoot, activation.previousWorkspaceRelativePath),
              resolve(failedAppRoot, activation.nextWorkspaceRelativePath),
            );
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
        }
        if (!pathEntry(activation.appRoot) && pathEntry(failedAppRoot)) {
          try {
            this.fileOperations.rename(failedAppRoot, activation.appRoot);
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
        }
        if (recoveryErrors.length) {
          throw new AggregateError([error, ...recoveryErrors], "local_app_draft_state_rollback_failed");
        }
        throw error;
      }
      rmSync(activation.backupContainer, { recursive: true, force: true });
    });
  }

  // ===== Record compatibility boundary =====

  private readOrUpgradeRecord(localAppId: string): LocalAppDraftRecord | undefined {
    const draftRoot = this.draftRoot(localAppId);
    return readCompatibleLocalAppDraftRecord({
      localAppId,
      draftRoot,
      verifyArchivePath: (record) => verifiedDraftArchivePath(draftRoot, record),
      readPackageManifest: readDraftPackageManifest,
      assertPackageTree: assertDraftPackageTree,
      writeRecord: writePrivateFileAtomically,
    });
  }

  private draftRoot(localAppId: string): string {
    const key = createHash("sha256").update(localAppId, "utf8").digest("hex");
    return join(this.root, key);
  }
}

function assertActivationPaths(activation: LocalAppDraftActivation): void {
  const expectedBackupParent = resolve(appProgramActivationBackupParent("local-draft", activation.appRoot));
  if (
    dirname(resolve(activation.backupContainer)) !== expectedBackupParent ||
    resolve(activation.previousAppRoot) !== join(resolve(activation.backupContainer), "previous-app")
  ) {
    throw new Error("local_app_draft_recovery_path_invalid");
  }
}

function assertPreparedOpenPaths(prepared: LocalAppDraftPreparedOpen, state: LocalAppDraftPreparedOpenState): void {
  const expectedTransactionParent = resolve(appProgramActivationTransactionParent("local-draft", prepared.appRoot));
  if (
    dirname(resolve(state.transactionRoot)) !== expectedTransactionParent ||
    resolve(state.stagedAppRoot) !== join(resolve(state.transactionRoot), "next-app")
  ) {
    throw new Error("local_app_draft_prepared_path_invalid");
  }
}

function assertStagedDraftTreeReady(prepared: LocalAppDraftPreparedOpen, state: LocalAppDraftPreparedOpenState): void {
  const stagedEntry = pathEntry(state.stagedAppRoot);
  if (!stagedEntry?.isDirectory() || stagedEntry.isSymbolicLink()) {
    throw new Error("local_app_draft_prepared_content_changed");
  }
  assertDraftPackageTree(state.stagedAppRoot, state.packageManifest);
  const manifest = requireMountedAppManifest(state.stagedAppRoot, "local_app_draft_prepared_content_changed");
  if (
    stringValue(manifest.id) !== prepared.appId ||
    preservableWorkspaceRelativePath(state.stagedAppRoot, manifest) !== state.nextWorkspaceRelativePath ||
    draftTreeDigest(state.stagedAppRoot) !== state.stagedTreeDigest
  ) {
    throw new Error("local_app_draft_prepared_content_changed");
  }
}

function pathEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function declaredWorkspaceRelativePath(appRoot: string, manifest: JsonObject): string | undefined {
  const workspaceSetting =
    stringValue(recordValue(manifest.ui).workspace) || stringValue(recordValue(manifest.workspace).path) || "workspace";
  const workspaceRoot = resolve(appRoot, workspaceSetting);
  const relativePath = relative(resolve(appRoot), workspaceRoot);
  return relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
    ? relativePath
    : undefined;
}

function assertExternalWorkspaceBinding(linkedWorkspaceRoot: string, workspaceRoot: string): void {
  const workspaceEntry = pathEntry(workspaceRoot);
  if (!workspaceEntry?.isDirectory() || workspaceEntry.isSymbolicLink()) {
    throw new Error("local_app_draft_workspace_invalid");
  }
  try {
    if (resolve(realpathSync.native(linkedWorkspaceRoot)) !== resolve(realpathSync.native(workspaceRoot))) {
      throw new Error("local_app_draft_workspace_invalid");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "local_app_draft_workspace_invalid") throw error;
    throw new Error("local_app_draft_workspace_invalid");
  }
}

function requireMountedAppManifest(appRoot: string, errorCode: string): JsonObject {
  const result = readMountedAppManifest(appRoot);
  if (!result.manifest) throw new Error(errorCode);
  return result.manifest;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function publicDraftSummary(record: LocalAppDraftRecord): LocalAppDraftSummary {
  return cloneDraftSummary({
    schemaVersion: record.schemaVersion,
    localAppId: record.localAppId,
    appId: record.appId,
    savedAt: record.savedAt,
    archiveSha256: record.archiveSha256,
    archiveSize: record.archiveSize,
    contentDigest: record.contentDigest,
    workingContentDigest: record.workingContentDigest,
    employees: record.employees.map((employee) => ({ ...employee })),
    ...(record.savePoint ? { savePoint: { ...record.savePoint } } : {}),
    ...(record.publishBase ? { publishBase: { ...record.publishBase } } : {}),
  });
}

function cloneDraftSummary(draft: LocalAppDraftSummary): LocalAppDraftSummary {
  return {
    ...draft,
    employees: draft.employees.map((employee) => ({ ...employee })),
    ...(draft.savePoint ? { savePoint: { ...draft.savePoint } } : {}),
    ...(draft.publishBase ? { publishBase: { ...draft.publishBase } } : {}),
  };
}

function verifiedDraftArchivePath(
  draftRoot: string,
  record: Pick<LocalAppDraftRecord, "archiveFile" | "archiveSize" | "archiveSha256">,
): string {
  const path = resolve(draftRoot, record.archiveFile);
  if (dirname(path) !== resolve(draftRoot, "archives")) {
    throw new Error("local_app_draft_record_invalid");
  }
  const entry = pathEntry(path);
  if (
    !entry?.isFile() ||
    entry.isSymbolicLink() ||
    entry.size !== record.archiveSize ||
    sha256(readFileSync(path)) !== record.archiveSha256
  ) {
    throw new Error("local_app_draft_archive_invalid");
  }
  return path;
}

function readDraftPackageManifest(appRoot: string): Record<string, unknown> {
  const path = join(appRoot, ".opengrove-package-manifest.json");
  const entry = pathEntry(path);
  if (!entry?.isFile() || entry.isSymbolicLink()) {
    throw new Error("local_app_draft_package_manifest_invalid");
  }
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("local_app_draft_package_manifest_invalid");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "local_app_draft_package_manifest_invalid") {
      throw error;
    }
    throw new Error("local_app_draft_package_manifest_invalid");
  }
}

function assertDraftPackageTree(appRoot: string, packageManifest: Record<string, unknown>): void {
  const files = recordValue(packageManifest.files);
  if (packageManifest.schemaVersion !== 1 || !stringValue(packageManifest.appId) || !Object.keys(files).length) {
    throw new Error("local_app_draft_package_manifest_invalid");
  }
  const expectedPaths = new Set<string>();
  for (const [relativePath, digestValue] of Object.entries(files)) {
    const digest = stringValue(digestValue).toLowerCase();
    if (!safePackageRelativePath(relativePath) || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error("local_app_draft_package_manifest_invalid");
    }
    const path = resolve(appRoot, relativePath);
    const entry = pathEntry(path);
    if (!entry?.isFile() || entry.isSymbolicLink() || `sha256:${sha256(readFileSync(path))}` !== digest) {
      throw new Error("local_app_draft_prepared_content_changed");
    }
    expectedPaths.add(relativePath.split("/").join(sep));
  }
  const actualPaths = collectDraftTreeFiles(appRoot).filter(
    (relativePath) => relativePath !== ".opengrove-package-manifest.json",
  );
  if (
    actualPaths.length !== expectedPaths.size ||
    actualPaths.some((relativePath) => !expectedPaths.has(relativePath))
  ) {
    throw new Error("local_app_draft_prepared_content_changed");
  }
}

function safePackageRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\\")) return false;
  const segments = path.split("/");
  return !segments.some((segment) => !segment || segment === "." || segment === "..");
}

function collectDraftTreeFiles(root: string): string[] {
  const files: string[] = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    const currentEntry = pathEntry(current);
    if (!currentEntry || currentEntry.isSymbolicLink()) {
      throw new Error("local_app_draft_prepared_content_changed");
    }
    if (currentEntry.isFile()) {
      files.push(relative(root, current));
      continue;
    }
    if (!currentEntry.isDirectory()) {
      throw new Error("local_app_draft_prepared_content_changed");
    }
    for (const name of readdirSync(current).sort()) queue.push(join(current, name));
  }
  return files.sort();
}

function draftTreeDigest(root: string): string {
  const hash = createHash("sha256");
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    const entry = pathEntry(current);
    if (!entry || entry.isSymbolicLink()) {
      throw new Error("local_app_draft_prepared_content_changed");
    }
    const relativePath = relative(root, current).split(sep).join("/");
    if (entry.isDirectory()) {
      hash.update(`directory\0${relativePath}\0${Number(entry.mode) & 0o777}\n`);
      for (const name of readdirSync(current).sort()) queue.push(join(current, name));
      continue;
    }
    if (!entry.isFile()) throw new Error("local_app_draft_prepared_content_changed");
    hash.update(`file\0${relativePath}\0${Number(entry.mode) & 0o777}\0${entry.size}\0`);
    hash.update(readFileSync(current));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function writeLocalDraftInstallMarker(input: {
  previousAppRoot: string;
  stagedAppRoot: string;
  appId: string;
  draftContentDigest: string;
  selectedVersion?: SelectedFormalAppVersion;
}): void {
  const source = join(input.previousAppRoot, ".opengrove-store-package.json");
  const target = join(input.stagedAppRoot, ".opengrove-store-package.json");
  const entry = pathEntry(source);
  if (!entry) {
    rmSync(target, { force: true });
    return;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("local_app_draft_install_marker_invalid");
  }
  let marker: Record<string, unknown>;
  try {
    marker = recordValue(JSON.parse(readFileSync(source, "utf8")));
  } catch {
    throw new Error("local_app_draft_install_marker_invalid");
  }
  if (stringValue(marker.source) !== "registry" || stringValue(marker.appId) !== input.appId) {
    throw new Error("local_app_draft_install_marker_invalid");
  }
  const selectedVersion = input.selectedVersion ?? selectedFormalVersionFromMarker(marker);
  const draftMarker: Record<string, unknown> = {
    schemaVersion: 1,
    source: "registry",
    ...copyNonEmptyStringFields(marker, ["registryUrl", "packageRef", "packageKey", "packageId"]),
    appId: input.appId,
    activeContent: "local-draft",
    draftContentDigest: input.draftContentDigest,
    ...(selectedVersion ? { selectedVersion: { ...selectedVersion } } : {}),
  };
  writePrivateFileAtomically(target, Buffer.from(`${JSON.stringify(draftMarker, null, 2)}\n`, "utf8"));
}

function copyNonEmptyStringFields(source: Record<string, unknown>, fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = stringValue(source[field]);
    if (value) result[field] = value;
  }
  return result;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validCompletePublishBase(value: Required<LocalAppDraftPublishBase>): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value.packageKey) &&
    /^\d+\.\d+\.\d+$/.test(value.version) &&
    /^[a-f0-9]{40}$/i.test(value.releaseCommitSha) &&
    /^[a-f0-9]{64}$/i.test(value.archiveSha256)
  );
}
