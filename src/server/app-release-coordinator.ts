import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeAppStorePackageKey } from "../app-store-package-identity.js";
import {
  assertReleaseControlIntentMatchesJournal,
  ReleaseControlClient,
  ReleaseControlClientError,
  type ReleaseControlConflict,
  type ReleaseControlIntent,
} from "./app-release-client.js";
import type {
  AppReleaseJournalRemoteStatus,
  ReleaseControlAction,
  ReleaseControlBuildFailure,
  ReleaseControlStatus,
} from "./app-release-status.js";
import {
  AppReleaseJournalStore,
  terminalAppReleaseJournal,
  type AppReleaseBlockedRelease,
  type AppReleaseJournalRecord,
  type AppReleaseRegistryIdentity,
} from "./app-release-journal.js";
import { normalizeLocalAppReleasePublishBase, type LocalAppReleasePublishBase } from "./app-release-publish-base.js";
import { prepareAppReleaseSourceSnapshot } from "./app-release-source-snapshot.js";
import {
  AppReleaseBuildCommandError,
  prepareMountedAppReleaseBuild,
  saveMountedAppReleasePrebuildDraftWithRevision,
} from "./app-release-local-build.js";
import { compareVersions, stageMountedAppRelease, type MountedAppReleaseDraft } from "./app-release.js";
import {
  appStoreDataRoot,
  captureAppStorePublishTarget,
  disposePreparedAppStorePackageInstall,
  prepareAppStorePackageInstall,
  type AppStorePackageRecord,
  type PreparedAppStorePackageInstall,
} from "./app-store.js";
import type { AppStoreFormalVersion } from "./app-store-registry.js";
import type { ReleaseControlConfig } from "./release-control-config.js";
import {
  activateImportedFormalAppVersion,
  activeMountedAppRuns,
  mountedAppWorkingDigest,
} from "./app-version-manager.js";
import { MountedAppVersionStateStore } from "./app-version-state.js";
import type { BridgeState } from "./bridge-types.js";
import { LocalAppDraftStore, type LocalAppDraftPublishBase, type LocalAppDraftSummary } from "./local-app-drafts.js";
import { localAppDraftStore } from "./mounted-app-draft-service.js";
import type { MountedAppTarget } from "./mounted-apps.js";

// ===== Public contracts =====

interface VerifiedAppReleasePublishBase {
  expectedMainSha: string | null;
  publishBase: LocalAppReleasePublishBase | undefined;
}

export interface AppReleaseRegistryAccess {
  listVersions(packageKey: string): Promise<AppStoreFormalVersion[]>;
  importVersion(
    formalVersion: AppStoreFormalVersion,
    catalogPackage: AppStorePackageRecord,
  ): Promise<AppStorePackageRecord>;
}

export interface AppReleaseRemoteAccess {
  findByIdempotencyKey(idempotencyKey: string): Promise<ReleaseControlIntent>;
  findById(intentId: string): Promise<ReleaseControlIntent>;
  start(record: AppReleaseJournalRecord, sourceSnapshot: Buffer): Promise<ReleaseControlIntent>;
  retryCandidate(releaseId: string): Promise<ReleaseControlIntent>;
  retryBuild(releaseId: string): Promise<ReleaseControlIntent>;
  abandon(releaseId: string): Promise<ReleaseControlIntent>;
  finalize(releaseId: string): Promise<ReleaseControlIntent>;
}

export interface AppReleaseProgress {
  localAppId: string;
  appId: string;
  packageKey: string;
  version: string;
  title: string;
  visibility: MountedAppReleaseDraft["visibility"];
  phase: AppReleaseJournalRecord["phase"];
  remoteIntentId?: string;
  remoteStatus?: AppReleaseJournalRemoteStatus;
  buildFailure?: ReleaseControlBuildFailure;
  allowedActions: ReleaseControlAction[];
  blockedRelease?: AppReleaseBlockedRelease;
  requestId?: string;
  applyToCurrentApp: boolean;
  state: "publishing" | "blocked" | "needs-retry" | "registry-ready" | "closed" | "published";
  retryable: boolean;
  updatedAt: string;
}

export class AppReleaseCoordinatorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly progress?: AppReleaseProgress,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

// ===== Release orchestration =====

export class AppReleaseCoordinator {
  private readonly draftStore: LocalAppDraftStore;
  private readonly journalStore: AppReleaseJournalStore;
  private readonly versionStore: MountedAppVersionStateStore;

  constructor(
    private readonly options: {
      state: BridgeState;
      target: MountedAppTarget;
      registry: AppReleaseRegistryAccess;
      client: AppReleaseRemoteAccess;
      draftStore?: LocalAppDraftStore;
      journalStore?: AppReleaseJournalStore;
      versionStore?: MountedAppVersionStateStore;
      prepareLocalReleaseBuild?: typeof prepareMountedAppReleaseBuild;
    },
  ) {
    const dataRoot = appStoreDataRoot(options.state);
    this.draftStore = options.draftStore ?? localAppDraftStore(options.state);
    this.journalStore = options.journalStore ?? new AppReleaseJournalStore(join(dataRoot, "app-release-journals"));
    this.versionStore = options.versionStore ?? new MountedAppVersionStateStore(join(dataRoot, "version-state"));
  }

  readProgress(): AppReleaseProgress | undefined {
    const record = this.journalStore.read(this.options.target.localAppId);
    return record ? appReleaseProgress(record) : undefined;
  }

  async refreshRemoteProgress(): Promise<AppReleaseProgress> {
    const record = this.journalStore.read(this.options.target.localAppId);
    if (!record) {
      throw new AppReleaseCoordinatorError("app_store_publish_journal_missing", 404);
    }
    if (
      record.phase === "local_finalized" ||
      record.phase === "local_preserved" ||
      record.phase === "registry_ready" ||
      record.phase === "remote_closed" ||
      record.phase === "remote_conflict"
    ) {
      return appReleaseProgress(record);
    }
    if (record.phase === "remote_blocked") {
      const intent = await this.options.client.findById(record.remoteIntentId!);
      assertBlockedIntentMatches(record, intent);
      if (intent.status === "abandoned") {
        return appReleaseProgress(
          this.journalStore.markRemoteClosed({
            localAppId: record.localAppId,
            expectedRevision: record.revision,
            intentId: intent.id,
            reason: "abandoned",
          }),
        );
      }
      if (intent.status === "published") {
        try {
          assertReleaseControlIntentMatchesJournal(intent, record);
        } catch (error) {
          if (
            error instanceof ReleaseControlClientError &&
            error.message === "app_release_response_identity_mismatch"
          ) {
            return appReleaseProgress(
              this.journalStore.markRemoteClosed({
                localAppId: record.localAppId,
                expectedRevision: record.revision,
                intentId: intent.id,
                reason: "publish_base_stale",
              }),
            );
          }
          throw error;
        }
        return appReleaseProgress(await this.recordRemoteIntent(record, intent));
      }
      if (
        releaseControlIntentMatchesJournal(intent, record) &&
        (intent.status === "artifact_accepted" || intent.status === "finalizing")
      ) {
        return appReleaseProgress(await this.recordRemoteIntent(record, intent));
      }
      return appReleaseProgress(this.recordBlockedIntent(record, intent));
    }
    let intent: ReleaseControlIntent;
    try {
      intent = record.remoteIntentId
        ? await this.options.client.findById(record.remoteIntentId)
        : await this.options.client.findByIdempotencyKey(record.idempotencyKey);
    } catch (error) {
      if (
        error instanceof ReleaseControlClientError &&
        error.status === 404 &&
        error.message === "app_release_not_found" &&
        !record.remoteIntentId
      ) {
        return appReleaseProgress(record);
      }
      throw error;
    }
    assertReleaseControlIntentMatchesJournal(intent, record);
    return appReleaseProgress(await this.recordRemoteIntent(record, intent));
  }

  async start(input: {
    release: unknown;
    applyToCurrentApp: boolean;
    signal?: AbortSignal;
  }): Promise<AppReleaseProgress> {
    const unfinished = this.journalStore.read(this.options.target.localAppId);
    if (unfinished && !terminalAppReleaseJournal(unfinished)) {
      throw this.error("app_store_publish_in_progress", 409, unfinished);
    }
    let prebuild: Awaited<ReturnType<typeof saveMountedAppReleasePrebuildDraftWithRevision>>;
    try {
      prebuild = await saveMountedAppReleasePrebuildDraftWithRevision({
        state: this.options.state,
        target: this.options.target,
        submission: input.release,
        draftStore: this.draftStore,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "app_release_local_build_install_changed") {
        throw new AppReleaseCoordinatorError(error.message, 409, undefined, {
          cause: error.message,
        });
      }
      throw error;
    }
    const savedDraft = prebuild.draft;
    const installFence = prebuild.installFence;
    const workingCopyFence = prebuild.workingCopyFence;
    const initialPackageKey = releasePackageKeyFromTarget(this.options.target, savedDraft);
    const formalVersions = await this.options.registry.listVersions(initialPackageKey);
    const registryPackages = formalVersions
      .filter((version) => version.availability === "available")
      .map(formalVersionPackageRecord);
    const stagedRelease = stageMountedAppRelease({
      state: this.options.state,
      appId: this.options.target.id,
      registryPackages,
      release: input.release,
    });
    const packageKey = releasePackageKey(stagedRelease, savedDraft, this.options.target.id);
    const release: MountedAppReleaseDraft = {
      ...stagedRelease,
      identity: {
        ...stagedRelease.identity,
        packageId:
          stagedRelease.identity.packageId ??
          registryPackages.find((item) => item.packageKey === packageKey)?.packageId ??
          this.options.target.id,
        packageKey,
      },
    };
    const verifiedBase = await this.verifyPublishBase({
      packageKey,
      appId: this.options.target.id,
      requestedVersion: release.version,
      publishBase: savedDraft.publishBase,
      registryPackages,
    });
    const restoredPublishBase =
      verifiedBase.publishBase?.releaseCommitSha && !savedDraft.publishBase?.releaseCommitSha
        ? {
            packageKey: verifiedBase.publishBase.packageKey,
            version: verifiedBase.publishBase.version,
            releaseCommitSha: verifiedBase.publishBase.releaseCommitSha,
            archiveSha256: verifiedBase.publishBase.archiveSha256,
          }
        : undefined;
    let releaseDraft = savedDraft;
    let sourceSnapshot: ReturnType<typeof prepareAppReleaseSourceSnapshot>;
    try {
      if (restoredPublishBase) {
        // The local install predates Git-backed releases and lost its commit
        // identity through a Store update. The Registry vouches for the exact
        // same artifact, so persist the restored base before journalling.
        releaseDraft = this.draftStore.advancePublishBaseIfContentUnchanged({
          localAppId: this.options.target.localAppId,
          expectedContentDigest: savedDraft.contentDigest,
          publishBase: restoredPublishBase,
        });
      }
      const preparedBuild = await (this.options.prepareLocalReleaseBuild ?? prepareMountedAppReleaseBuild)({
        state: this.options.state,
        target: this.options.target,
        release,
        packageKey,
        draftStore: this.draftStore,
        prebuildDraft: releaseDraft,
        installFence,
        workingCopyFence,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      releaseDraft = preparedBuild.draft;
      sourceSnapshot = prepareAppReleaseSourceSnapshot({
        draftStore: this.draftStore,
        localAppId: this.options.target.localAppId,
        expectedDraftDigest: releaseDraft.contentDigest,
        expectedDraftArchiveSha256: releaseDraft.archiveSha256,
        release,
        packageKey,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "app_store_publish_draft_changed") {
        throw new AppReleaseCoordinatorError(error.message, 409);
      }
      if (error instanceof AppReleaseBuildCommandError) {
        throw new AppReleaseCoordinatorError("app_release_local_build_command_failed", 409, undefined, {
          cause: error.message,
          ...error.diagnostic,
          argv: [...error.diagnostic.argv],
        });
      }
      if (error instanceof Error) {
        const code = error.message.split(":", 1)[0] ?? "";
        if (
          code === "build_contract_missing" ||
          code === "build_contract_invalid" ||
          code === "local_app_draft_working_copy_changed" ||
          code.startsWith("app_release_local_build_")
        ) {
          throw new AppReleaseCoordinatorError(code, 409, undefined, {
            cause: error.message,
          });
        }
      }
      throw error;
    }
    this.journalStore.createOrResume({
      localAppId: this.options.target.localAppId,
      appId: this.options.target.id,
      packageId: release.identity.packageId!,
      // Retained in schema v1 only as local audit context. Repository ownership
      // is a Release Control concern and is never routed from this value.
      organization: "open-grove",
      packageKey,
      expectedMainSha: verifiedBase.expectedMainSha,
      publishBase: verifiedBase.publishBase,
      draftDigest: releaseDraft.contentDigest,
      ...(releaseDraft.savePoint ? { savePoint: releaseDraft.savePoint } : {}),
      sourceSnapshot,
      release,
      applyToCurrentApp: input.applyToCurrentApp,
    });
    return this.resume();
  }

  async resume(input: { retryFailedBuild?: boolean } = {}): Promise<AppReleaseProgress> {
    let record = this.journalStore.read(this.options.target.localAppId);
    if (!record) {
      throw new AppReleaseCoordinatorError("app_store_publish_journal_missing", 404);
    }
    let intent: ReleaseControlIntent | undefined;
    for (let transition = 0; transition < 6; transition += 1) {
      if (record.phase === "local_finalized" || record.phase === "local_preserved") {
        return appReleaseProgress(record);
      }
      if (record.phase === "remote_closed") {
        throw this.error(
          record.terminalReason === "publish_base_stale"
            ? "app_store_publish_base_stale"
            : "app_store_publish_abandoned",
          409,
          record,
        );
      }
      if (record.phase === "remote_conflict") {
        record = this.journalStore.clearOpaqueConflict({
          localAppId: record.localAppId,
          expectedRevision: record.revision,
        });
      }
      if (record.phase === "registry_ready") {
        record = await this.finalizeLocal(record);
        return appReleaseProgress(record);
      }
      if (record.phase === "remote_blocked") {
        if (input.retryFailedBuild !== true) return appReleaseProgress(record);
        const blocked = record.blockedRelease!;
        intent = await this.options.client.findById(blocked.id);
        assertBlockedIntentMatches(record, intent);
        assertReleaseControlIntentMatchesJournal(intent, record);
        if (intent.allowedActions.includes("retry_candidate") && intent.status === "awaiting_candidate") {
          intent = await this.runCandidateMutation(record, () => this.options.client.retryCandidate(intent!.id));
        } else if (
          intent.allowedActions.includes("retry_build") &&
          (intent.status === "trusted_build_failed" || intent.status === "building")
        ) {
          intent = await this.options.client.retryBuild(intent.id);
        } else {
          throw this.error("app_store_publish_retry_invalid", 409, record);
        }
        assertReleaseControlIntentMatchesJournal(intent, record);
        record = await this.recordRemoteIntent(record, intent);
        if (record.phase === "registry_ready") {
          record = await this.finalizeLocal(record);
          return appReleaseProgress(record);
        }
        if (intent.status !== "artifact_accepted" && intent.status !== "finalizing") {
          return appReleaseProgress(record);
        }
      }
      intent = intent ?? (await this.findOrStartRemoteIntent(record));
      assertReleaseControlIntentMatchesJournal(intent, record);
      record = await this.recordRemoteIntent(record, intent);
      if (record.phase === "registry_ready") {
        record = await this.finalizeLocal(record);
        return appReleaseProgress(record);
      }
      if (intent.status === "awaiting_candidate" && intent.allowedActions.includes("retry_candidate")) {
        intent = await this.runCandidateMutation(record, () => this.options.client.retryCandidate(intent!.id));
        assertReleaseControlIntentMatchesJournal(intent, record);
        record = await this.recordRemoteIntent(record, intent);
        if (record.phase === "registry_ready") {
          record = await this.finalizeLocal(record);
          return appReleaseProgress(record);
        }
      }
      if (input.retryFailedBuild === true && intent.allowedActions.includes("retry_build")) {
        intent = await this.options.client.retryBuild(intent.id);
        assertReleaseControlIntentMatchesJournal(intent, record);
        record = await this.recordRemoteIntent(record, intent);
        return appReleaseProgress(record);
      }
      if (input.retryFailedBuild === true && intent.status === "trusted_build_failed") {
        throw this.error("app_store_publish_retry_invalid", 409, record);
      }
      if (intent.status !== "artifact_accepted" && intent.status !== "finalizing") {
        return appReleaseProgress(record);
      }
      intent = await this.options.client.finalize(intent.id);
      assertReleaseControlIntentMatchesJournal(intent, record);
      record = await this.recordRemoteIntent(record, intent);
      if (record.phase !== "registry_ready") return appReleaseProgress(record);
    }
    throw this.error("app_store_publish_transition_limit", 500, record);
  }

  resolveKeepLocalChanges(): AppReleaseProgress {
    return resolveAppReleaseKeepLocalChanges({
      state: this.options.state,
      target: this.options.target,
      draftStore: this.draftStore,
      journalStore: this.journalStore,
    });
  }

  async endBlockedRelease(): Promise<AppReleaseProgress> {
    const record = this.journalStore.read(this.options.target.localAppId);
    if (record?.phase === "remote_blocked" && record.blockedRelease) {
      const current = await this.options.client.findById(record.blockedRelease.id);
      assertBlockedIntentMatches(record, current);
      if (!current.allowedActions.includes("abandon")) {
        throw this.error("app_store_publish_abandon_invalid", 409, record);
      }
      const abandoned = await this.options.client.abandon(record.blockedRelease.id);
      assertBlockedIntentMatches(record, abandoned);
      if (abandoned.status !== "abandoned") {
        throw this.error("app_store_publish_abandon_invalid", 409, record);
      }
      this.journalStore.clearBlocked({
        localAppId: record.localAppId,
        expectedRevision: record.revision,
      });
      return this.resume();
    }
    if (
      !record ||
      !record.remoteIntentId ||
      record.remoteStatus !== "trusted_build_failed" ||
      record.phase === "remote_closed"
    ) {
      throw new AppReleaseCoordinatorError(
        "app_store_publish_abandon_invalid",
        409,
        record ? appReleaseProgress(record) : undefined,
      );
    }
    const current = await this.options.client.findById(record.remoteIntentId);
    assertReleaseControlIntentMatchesJournal(current, record);
    if (!current.allowedActions.includes("abandon")) {
      throw this.error("app_store_publish_abandon_invalid", 409, record);
    }
    const intent = await this.options.client.abandon(record.remoteIntentId);
    assertReleaseControlIntentMatchesJournal(intent, record);
    if (intent.status !== "abandoned") {
      throw this.error("app_store_publish_abandon_invalid", 409, record);
    }
    return appReleaseProgress(await this.recordRemoteIntent(record, intent));
  }

  private async verifyPublishBase(input: {
    packageKey: string;
    appId: string;
    requestedVersion: string;
    publishBase?: LocalAppDraftPublishBase;
    registryPackages: AppStorePackageRecord[];
  }): Promise<VerifiedAppReleasePublishBase> {
    let publishBase: ReturnType<typeof normalizeLocalAppReleasePublishBase>;
    try {
      publishBase = normalizeLocalAppReleasePublishBase(input.publishBase);
    } catch {
      throw new AppReleaseCoordinatorError("app_store_publish_base_invalid", 409);
    }
    const catalogPackage = input.registryPackages.find(
      (item) => normalizeAppStorePackageKey(item.packageKey) === input.packageKey,
    );
    if (!publishBase) {
      if (catalogPackage) {
        throw new AppReleaseCoordinatorError("app_store_publish_base_missing", 409);
      }
      return { expectedMainSha: null, publishBase: undefined };
    }
    if (publishBase.packageKey !== input.packageKey) {
      throw new AppReleaseCoordinatorError("app_store_publish_identity_mismatch", 409);
    }
    if (!catalogPackage) {
      throw new AppReleaseCoordinatorError("app_store_publish_base_missing", 409);
    }
    if (catalogPackage.appId !== input.appId) {
      throw new AppReleaseCoordinatorError("app_store_publish_identity_mismatch", 409);
    }
    const versions = await this.options.registry.listVersions(input.packageKey);
    const available = versions
      .filter((version) => version.availability === "available")
      .sort((left, right) => compareVersions(right.version, left.version));
    const latest = available[0];
    if (
      !latest ||
      latest.packageKey !== input.packageKey ||
      latest.appId !== input.appId ||
      latest.version !== publishBase.version ||
      latest.archiveSha256 !== publishBase.archiveSha256
    ) {
      throw new AppReleaseCoordinatorError("app_store_publish_base_stale", 409);
    }
    // An install made before Git-backed releases (or updated by an older
    // Host) carries the exact formal version and archive but no commit
    // identity. When the authoritative formal version matches on every
    // identity and artifact field, its commit alone may restore the base.
    const restoredCommitSha =
      !publishBase.releaseCommitSha && latest.releaseCommitSha ? latest.releaseCommitSha : undefined;
    if (
      publishBase.releaseCommitSha
        ? latest.releaseCommitSha !== publishBase.releaseCommitSha
        : !restoredCommitSha && (latest.releaseCommitSha !== null || latest.artifactSource !== "registry")
    ) {
      throw new AppReleaseCoordinatorError("app_store_publish_base_stale", 409);
    }
    if (compareVersions(input.requestedVersion, latest.version) <= 0) {
      throw new AppReleaseCoordinatorError("app_store_release_version_not_greater", 409);
    }
    const resolvedPublishBase: LocalAppReleasePublishBase = restoredCommitSha
      ? { ...publishBase, releaseCommitSha: restoredCommitSha }
      : publishBase;
    return {
      expectedMainSha: resolvedPublishBase.releaseCommitSha ?? null,
      publishBase: resolvedPublishBase,
    };
  }

  private async recordRemoteIntent(
    record: AppReleaseJournalRecord,
    intent: ReleaseControlIntent,
  ): Promise<AppReleaseJournalRecord> {
    const latest = this.journalStore.read(record.localAppId);
    if (!latest || latest.intentDigest !== record.intentDigest) {
      throw this.error("app_store_publish_journal_conflict", 409, record);
    }
    record = latest;
    if (intent.status === "abandoned") {
      if (record.phase === "remote_closed" && record.remoteStatus === "abandoned") {
        return record;
      }
      return this.journalStore.markRemoteClosed({
        localAppId: record.localAppId,
        expectedRevision: record.revision,
        intentId: intent.id,
        reason: "abandoned",
      });
    }
    if (intent.status === "published") {
      const registryVersion = await this.verifyRegistryIndexed(record, intent);
      return this.journalStore.markRegistryReady({
        localAppId: record.localAppId,
        expectedRevision: record.revision,
        intentId: intent.id,
        status: intent.status,
        registryVersion,
      });
    }
    const phase = remoteJournalPhase(intent.status);
    if (
      record.remoteIntentId === intent.id &&
      record.remoteStatus === intent.status &&
      isDeepStrictEqual(record.buildFailure, intent.buildFailure) &&
      isDeepStrictEqual(record.allowedActions, intent.allowedActions) &&
      record.phase === phase
    ) {
      return record;
    }
    return this.journalStore.recordRemote({
      localAppId: record.localAppId,
      expectedRevision: record.revision,
      intentId: intent.id,
      status: intent.status,
      phase,
      buildFailure: intent.buildFailure,
      allowedActions: intent.allowedActions,
    });
  }

  private async findOrStartRemoteIntent(record: AppReleaseJournalRecord): Promise<ReleaseControlIntent> {
    if (record.remoteIntentId) {
      return this.options.client.findById(record.remoteIntentId);
    }
    try {
      return await this.options.client.findByIdempotencyKey(record.idempotencyKey);
    } catch (error) {
      if (
        error instanceof ReleaseControlClientError &&
        error.status === 409 &&
        error.message === "app_release_in_progress"
      ) {
        await this.throwInProgressConflict(record, error);
      }
      if (
        !(error instanceof ReleaseControlClientError) ||
        error.status !== 404 ||
        error.message !== "app_release_not_found"
      ) {
        throw error;
      }
    }
    try {
      return await this.runCandidateMutation(record, () =>
        this.options.client.start(record, this.journalStore.readSnapshot(record)),
      );
    } catch (error) {
      if (
        error instanceof ReleaseControlClientError &&
        error.status === 409 &&
        error.message === "app_release_in_progress"
      ) {
        await this.throwInProgressConflict(record, error);
      }
      throw error;
    }
  }

  private async runCandidateMutation(
    record: AppReleaseJournalRecord,
    operation: () => Promise<ReleaseControlIntent>,
  ): Promise<ReleaseControlIntent> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof ReleaseControlClientError &&
        error.status === 422 &&
        error.message === "app_release_secret_blocked" &&
        error.candidateStage === "candidate_ref_push" &&
        error.rejectedIntent
      ) {
        if (record.remoteIntentId && error.rejectedIntent.id !== record.remoteIntentId) {
          throw new ReleaseControlClientError(
            502,
            "app_release_response_identity_mismatch",
            error.requestId,
            error.candidateStage,
          );
        }
        assertReleaseControlIntentMatchesJournal(error.rejectedIntent, record);
        await this.recordRemoteIntent(record, error.rejectedIntent);
      }
      throw error;
    }
  }

  private async throwInProgressConflict(
    record: AppReleaseJournalRecord,
    error: ReleaseControlClientError,
  ): Promise<never> {
    if (error.releaseConflict) {
      let intent: ReleaseControlIntent;
      try {
        intent = await this.options.client.findById(error.releaseConflict.id);
      } catch (lookupError) {
        if (
          !(lookupError instanceof ReleaseControlClientError) ||
          lookupError.status !== 404 ||
          lookupError.message !== "app_release_not_found"
        ) {
          throw lookupError;
        }
        const opaqueConflict = this.journalStore.recordOpaqueConflict({
          localAppId: record.localAppId,
          expectedRevision: record.revision,
          requestId: error.requestId,
        });
        throw this.error("app_release_in_progress_unavailable", 409, opaqueConflict);
      }
      assertConflictMatchesIntent(error.releaseConflict, intent, error.requestId);
      const conflict = blockedReleaseFromConflict(
        record,
        {
          id: intent.id,
          status: intent.status,
          packageKey: intent.packageKey,
          version: intent.version,
          sourceSha256: intent.sourceSha256,
          createdAt: intent.createdAt,
          allowedActions: [...intent.allowedActions],
          ...(intent.buildFailure ? { buildFailure: intent.buildFailure } : {}),
        },
        error.requestId,
        releaseControlIntentMatchesJournal(intent, record),
      );
      const blocked = this.journalStore.recordBlocked({
        localAppId: record.localAppId,
        expectedRevision: record.revision,
        conflict,
      });
      throw this.error("app_release_in_progress", 409, blocked);
    }
    const opaqueConflict = this.journalStore.recordOpaqueConflict({
      localAppId: record.localAppId,
      expectedRevision: record.revision,
      requestId: error.requestId,
    });
    throw this.error("app_release_in_progress_unavailable", 409, opaqueConflict);
  }

  private recordBlockedIntent(record: AppReleaseJournalRecord, intent: ReleaseControlIntent): AppReleaseJournalRecord {
    const matchesCurrentRequest = releaseControlIntentMatchesJournal(intent, record);
    const conflict: ReleaseControlConflict = {
      id: intent.id,
      status: intent.status,
      packageKey: intent.packageKey,
      version: intent.version,
      sourceSha256: intent.sourceSha256,
      createdAt: intent.createdAt,
      allowedActions: [...intent.allowedActions],
      ...(intent.buildFailure ? { buildFailure: intent.buildFailure } : {}),
    };
    return this.journalStore.recordBlocked({
      localAppId: record.localAppId,
      expectedRevision: record.revision,
      conflict: blockedReleaseFromConflict(record, conflict, record.blockedRelease?.requestId, matchesCurrentRequest),
    });
  }

  private async verifyRegistryIndexed(
    record: AppReleaseJournalRecord,
    intent: ReleaseControlIntent,
  ): Promise<AppReleaseRegistryIdentity> {
    const commitSha = intent.candidateSha;
    const acceptedArchiveSha256 = intent.gatedArchiveSha256;
    const acceptedArchiveSize = intent.gatedArchiveSize;
    if (!commitSha || !acceptedArchiveSha256 || !acceptedArchiveSize) {
      throw this.error("app_store_publish_remote_evidence_missing", 502, record);
    }
    const versions = await this.options.registry.listVersions(record.packageKey);
    const formalVersion = versions.find(
      (version) =>
        version.packageKey === record.packageKey &&
        version.appId === record.appId &&
        version.version === record.release.version &&
        version.availability === "available" &&
        version.releaseCommitSha === commitSha &&
        version.archiveSha256 === acceptedArchiveSha256 &&
        version.archiveSize === acceptedArchiveSize,
    );
    if (!formalVersion) {
      throw this.error("app_store_publish_registry_not_ready", 503, record);
    }
    return registryIdentity(formalVersion);
  }

  private async finalizeLocal(record: AppReleaseJournalRecord): Promise<AppReleaseJournalRecord> {
    const registryVersion = record.registryVersion;
    if (!registryVersion) {
      throw this.error("app_store_publish_registry_identity_missing", 500, record);
    }
    const currentDraft = this.draftStore.read(record.localAppId);
    if (
      record.applyToCurrentApp &&
      selectedVersionMatches(this.versionStore.read(record.localAppId), registryVersion)
    ) {
      if (currentDraft?.contentDigest === record.draftDigest) {
        try {
          this.draftStore.deleteIfContentUnchanged({
            localAppId: record.localAppId,
            expectedContentDigest: record.draftDigest,
          });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "app_store_publish_draft_changed") {
            throw error;
          }
        }
      }
      return this.journalStore.markLocalFinalized({
        localAppId: record.localAppId,
        expectedRevision: record.revision,
      });
    }
    if (!currentDraft || currentDraft.contentDigest !== record.draftDigest) {
      throw this.error("app_store_publish_draft_changed", 409, record);
    }
    if (!record.applyToCurrentApp) {
      try {
        this.draftStore.advancePublishBaseIfContentUnchanged({
          localAppId: record.localAppId,
          expectedContentDigest: record.draftDigest,
          publishBase: registryVersion,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "app_store_publish_draft_changed") {
          throw this.error("app_store_publish_draft_changed", 409, record);
        }
        throw error;
      }
      return this.journalStore.markLocalFinalized({
        localAppId: record.localAppId,
        expectedRevision: record.revision,
      });
    }
    const workingDigest = mountedAppWorkingDigest(this.options.state, this.options.target);
    if (workingDigest !== currentDraft.workingContentDigest) {
      throw this.error("app_store_publish_working_copy_changed", 409, record);
    }
    const runs = activeMountedAppRuns(this.options.state, this.options.target.id);
    if (runs.length) {
      throw this.error("app_store_publish_active_runs", 409, record, runs);
    }
    const versions = await this.options.registry.listVersions(record.packageKey);
    const formalVersion = versions.find(
      (version) =>
        version.packageKey === registryVersion.packageKey &&
        version.version === registryVersion.version &&
        version.releaseCommitSha === registryVersion.releaseCommitSha &&
        version.archiveSha256 === registryVersion.archiveSha256 &&
        version.archiveSize === registryVersion.archiveSize &&
        version.availability === "available",
    );
    if (!formalVersion) {
      throw this.error("app_store_publish_registry_not_ready", 503, record);
    }
    const catalogPackage = formalVersionPackageRecord(formalVersion);
    const imported = await this.options.registry.importVersion(formalVersion, catalogPackage);
    const adoptTargetSnapshot = captureAppStorePublishTarget(this.options.target.appRoot);
    let prepared: PreparedAppStorePackageInstall | undefined;
    try {
      prepared = prepareAppStorePackageInstall({
        packageId: imported.id,
        settings: this.options.state.settings,
        storeRoot: appStoreDataRoot(this.options.state),
        adoptTargetSnapshot,
      });
      if (!prepared) throw new Error("app_store_package_not_found");
      const draftBeforeActivation = this.draftStore.read(record.localAppId);
      if (!draftBeforeActivation || draftBeforeActivation.contentDigest !== record.draftDigest) {
        throw this.error("app_store_publish_draft_changed", 409, record);
      }
      if (
        mountedAppWorkingDigest(this.options.state, this.options.target) !== draftBeforeActivation.workingContentDigest
      ) {
        throw this.error("app_store_publish_working_copy_changed", 409, record);
      }
      const activeRuns = activeMountedAppRuns(this.options.state, this.options.target.id);
      if (activeRuns.length) {
        throw this.error("app_store_publish_active_runs", 409, record, activeRuns);
      }
      await activateImportedFormalAppVersion({
        state: this.options.state,
        localAppId: record.localAppId,
        prepared,
        selectedVersion: {
          packageKey: registryVersion.packageKey,
          version: registryVersion.version,
          releaseCommitSha: registryVersion.releaseCommitSha,
          archiveSha256: registryVersion.archiveSha256,
        },
        versionStore: this.versionStore,
      });
      try {
        this.draftStore.deleteIfContentUnchanged({
          localAppId: record.localAppId,
          expectedContentDigest: record.draftDigest,
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "app_store_publish_draft_changed") {
          throw error;
        }
      }
      return this.journalStore.markLocalFinalized({
        localAppId: record.localAppId,
        expectedRevision: record.revision,
      });
    } finally {
      if (prepared) {
        try {
          disposePreparedAppStorePackageInstall(prepared);
        } catch {
          // A stale staging directory is safer than masking activation or rollback truth.
        }
      }
    }
  }

  private error(
    message: string,
    status: number,
    record: AppReleaseJournalRecord,
    detail?: unknown,
  ): AppReleaseCoordinatorError {
    return new AppReleaseCoordinatorError(message, status, appReleaseProgress(record), detail);
  }
}

// ===== Result mapping and helpers =====

export function resolveAppReleaseKeepLocalChanges(input: {
  state: BridgeState;
  target: MountedAppTarget;
  draftStore?: LocalAppDraftStore;
  journalStore?: AppReleaseJournalStore;
}): AppReleaseProgress {
  const draftStore = input.draftStore ?? localAppDraftStore(input.state);
  const journalStore =
    input.journalStore ?? new AppReleaseJournalStore(join(appStoreDataRoot(input.state), "app-release-journals"));
  const record = journalStore.read(input.target.localAppId);
  if (!record) {
    throw new AppReleaseCoordinatorError("app_store_publish_journal_missing", 404);
  }
  const progress = appReleaseProgress(record);
  if (record.phase !== "registry_ready") {
    throw new AppReleaseCoordinatorError("app_store_publish_local_resolution_invalid", 409, progress);
  }
  const currentDraft = draftStore.read(record.localAppId);
  const draftChanged = !currentDraft || currentDraft.contentDigest !== record.draftDigest;
  let workingCopyChanged = false;
  if (record.applyToCurrentApp && currentDraft) {
    try {
      workingCopyChanged = mountedAppWorkingDigest(input.state, input.target) !== currentDraft.workingContentDigest;
    } catch {
      // non-critical-fallback: An unreadable working copy is treated as modified so recovery never overwrites it.
      workingCopyChanged = true;
    }
  }
  if (!draftChanged && !workingCopyChanged) {
    throw new AppReleaseCoordinatorError("app_store_publish_local_resolution_invalid", 409, progress);
  }
  return appReleaseProgress(
    journalStore.markLocalPreserved({
      localAppId: record.localAppId,
      expectedRevision: record.revision,
    }),
  );
}

export function appReleaseProgress(record: AppReleaseJournalRecord): AppReleaseProgress {
  const needsRetry = record.remoteStatus === "trusted_build_failed";
  const published = record.phase === "local_finalized" || record.phase === "local_preserved";
  return {
    localAppId: record.localAppId,
    appId: record.appId,
    packageKey: record.packageKey,
    version: record.release.version,
    title: record.release.app.title,
    visibility: record.release.visibility,
    phase: record.phase,
    ...(record.remoteIntentId ? { remoteIntentId: record.remoteIntentId } : {}),
    ...(record.remoteStatus ? { remoteStatus: record.remoteStatus } : {}),
    ...(record.buildFailure ? { buildFailure: structuredClone(record.buildFailure) } : {}),
    allowedActions: [...(record.allowedActions ?? record.blockedRelease?.allowedActions ?? [])],
    ...(record.blockedRelease ? { blockedRelease: structuredClone(record.blockedRelease) } : {}),
    ...(record.conflictRequestId ? { requestId: record.conflictRequestId } : {}),
    applyToCurrentApp: record.applyToCurrentApp,
    state: published
      ? "published"
      : record.phase === "remote_closed"
        ? "closed"
        : record.phase === "remote_blocked" || record.phase === "remote_conflict"
          ? "blocked"
          : record.phase === "registry_ready"
            ? "registry-ready"
            : needsRetry
              ? "needs-retry"
              : "publishing",
    retryable:
      !published &&
      record.phase !== "remote_closed" &&
      record.phase !== "remote_blocked" &&
      record.phase !== "remote_conflict",
    updatedAt: record.updatedAt,
  };
}

function blockedReleaseFromConflict(
  record: AppReleaseJournalRecord,
  conflict: ReleaseControlConflict,
  requestId?: string,
  matchesCurrentRequest = false,
): AppReleaseBlockedRelease {
  if (conflict.packageKey !== record.packageKey) {
    throw new ReleaseControlClientError(502, "app_release_response_identity_mismatch", requestId);
  }
  const matchesCurrentSource =
    conflict.version === record.release.version && conflict.sourceSha256 === record.sourceSnapshot.sha256;
  return {
    ...conflict,
    allowedActions: conflict.allowedActions.filter((action) => action === "abandon" || matchesCurrentRequest),
    ...(requestId ? { requestId } : {}),
    matchesCurrentSource,
    matchesCurrentRequest: matchesCurrentRequest && matchesCurrentSource,
  };
}

function assertConflictMatchesIntent(
  conflict: ReleaseControlConflict,
  intent: ReleaseControlIntent,
  requestId?: string,
): void {
  if (
    intent.id !== conflict.id ||
    intent.packageKey !== conflict.packageKey ||
    intent.version !== conflict.version ||
    intent.sourceSha256 !== conflict.sourceSha256
  ) {
    throw new ReleaseControlClientError(502, "app_release_response_identity_mismatch", requestId ?? intent.requestId);
  }
}

function releaseControlIntentMatchesJournal(intent: ReleaseControlIntent, record: AppReleaseJournalRecord): boolean {
  try {
    assertReleaseControlIntentMatchesJournal(intent, record);
    return true;
  } catch (error) {
    if (error instanceof ReleaseControlClientError && error.message === "app_release_response_identity_mismatch") {
      return false;
    }
    throw error;
  }
}

function assertBlockedIntentMatches(record: AppReleaseJournalRecord, intent: ReleaseControlIntent): void {
  const blocked = record.blockedRelease;
  if (
    !blocked ||
    intent.id !== blocked.id ||
    intent.packageKey !== blocked.packageKey ||
    intent.version !== blocked.version ||
    intent.sourceSha256 !== blocked.sourceSha256
  ) {
    throw new ReleaseControlClientError(
      502,
      "app_release_response_identity_mismatch",
      intent.requestId ?? blocked?.requestId,
    );
  }
}

function releasePackageKey(release: MountedAppReleaseDraft, draft: LocalAppDraftSummary, appId: string): string {
  const packageKey =
    normalizeAppStorePackageKey(release.identity.packageKey) ??
    normalizeAppStorePackageKey(draft.publishBase?.packageKey) ??
    normalizeAppStorePackageKey(`opengrove.${appId.toLowerCase()}`);
  if (!packageKey) throw new AppReleaseCoordinatorError("app_store_package_key_invalid", 400);
  return packageKey;
}

function remoteJournalPhase(
  status: ReleaseControlStatus,
): "intent_created" | "source_snapshot_uploaded" | "remote_pending" {
  if (status === "awaiting_candidate") return "intent_created";
  return "remote_pending";
}

function registryIdentity(version: AppStoreFormalVersion): AppReleaseRegistryIdentity {
  if (!version.releaseCommitSha) {
    throw new AppReleaseCoordinatorError("app_store_publish_registry_identity_missing", 502);
  }
  return {
    packageKey: version.packageKey,
    version: version.version,
    releaseCommitSha: version.releaseCommitSha,
    archiveSha256: version.archiveSha256,
    archiveSize: version.archiveSize,
  };
}

function selectedVersionMatches(
  state: ReturnType<MountedAppVersionStateStore["read"]>,
  version: AppReleaseRegistryIdentity,
): boolean {
  return (
    state?.activeContent === "formal" &&
    state.selectedVersion?.packageKey === version.packageKey &&
    state.selectedVersion.version === version.version &&
    state.selectedVersion.releaseCommitSha === version.releaseCommitSha &&
    state.selectedVersion.archiveSha256 === version.archiveSha256
  );
}

export function createAppReleaseClient(config: ReleaseControlConfig): ReleaseControlClient {
  return new ReleaseControlClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });
}

function releasePackageKeyFromTarget(target: MountedAppTarget, draft: LocalAppDraftSummary): string {
  const packageKey =
    normalizeAppStorePackageKey(draft.publishBase?.packageKey) ??
    normalizeAppStorePackageKey(`opengrove.${target.id.toLowerCase()}`);
  if (!packageKey) throw new AppReleaseCoordinatorError("app_store_package_key_invalid", 400);
  return packageKey;
}

export function formalVersionPackageRecord(version: AppStoreFormalVersion): AppStorePackageRecord {
  return {
    id: version.packageId,
    packageId: version.packageId,
    packageKey: version.packageKey,
    appId: version.appId,
    title: version.title,
    summary: version.releaseNotes,
    version: version.version,
    category: "workspace",
    publishKind: "app",
    installMode: "workspace",
    workspaceName: version.title,
    requirements: [],
    capabilities: [],
    backupScopes: [],
    status: "available",
    visibility: "restricted",
    publisher: version.publishedBy || "OpenGrove Team",
    usageCount: 0,
    source: "registry",
    uploadedAt: version.publishedAt,
    archiveName: version.archiveName,
    archiveSize: version.archiveSize,
    archiveSha256: version.archiveSha256,
    releaseCommitSha: version.releaseCommitSha ?? undefined,
    minHostReleaseNumber: version.minHostReleaseNumber || undefined,
  };
}
