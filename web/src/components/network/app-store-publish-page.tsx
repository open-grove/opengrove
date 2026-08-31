import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Globe2,
  HardDrive,
  History,
  LoaderCircle,
  Package,
  Save,
  ShieldCheck,
  Upload,
  XCircle,
} from "lucide-react";
import type {
  AppReleaseCheck,
  AppReleaseProgress,
  AppStorePackageVisibility,
  KernelOption,
  LocalAppDraftSummary,
  ModelProviderBinding,
  MountedAppReleaseDraft,
  ProviderProfile,
  RuntimeControls,
  SkillRecord,
} from "../../bridge";
import { useI18n } from "../../i18n";
import {
  BridgeRequestError,
  abandonMountedAppPublish,
  getMountedAppLocalDraft,
  getMountedAppPublishProgress,
  getMountedAppVersions,
  keepLocalChangesAfterMountedAppPublish,
  prepareMountedAppLocalDraft,
  prepareMountedAppPublish,
  publishMountedApp,
  refreshMountedAppPublishProgress,
  repairMountedAppBuildContract,
  reconcileMountedAppPublish,
  saveMountedAppLocalDraft,
} from "../../bridge";
import { RoomMemberAvatar } from "../rooms/member-avatar";
import { EmployeeSettingsSurface } from "../rooms/employee-settings-surface";
import { AppIdentityEditor } from "../apps/app-identity-editor";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { appStoreQueryKeys } from "./app-store-query";
import {
  type AppReleaseFailureDiagnostic,
  currentChecks,
  formatDraftSavedAt,
  isLocalPublishFinalizationConflict,
  kernelLabel,
  publishProgressFromError,
  releaseEmployeeToRoomMember,
  releaseAutomaticallyRecoverable,
  releaseErrorMessage,
  releaseFailureDiagnostic,
  releaseInProgress,
  releaseKernelOptions,
  releaseRecoveryRequiresManualContinue,
  releaseVisibleStage,
  releaseSkillRecords,
  roomMemberToReleaseEmployee,
  translatedCheck,
} from "./app-store-publish-model";

// ===== Page orchestration and recovery =====

function automaticRecoveryBudget(progress: AppReleaseProgress | undefined): {
  key: string;
  limit: number;
} {
  const remoteStatus = progress?.remoteStatus;
  return {
    key: progress?.remoteIntentId && remoteStatus ? `${progress.remoteIntentId}:${remoteStatus}:${progress.phase}` : "",
    limit: remoteStatus === "artifact_accepted" ? 2 : 1,
  };
}

export function AppStorePublishPage(props: {
  app: { id: string; title: string };
  activeKernel?: string;
  activeModel?: string;
  kernelOptions?: KernelOption[];
  providers: ProviderProfile[] | undefined;
  modelProviderBindings: ModelProviderBinding[] | undefined;
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  skills?: SkillRecord[];
  canPublish?: boolean;
  onDirtyChange?(dirty: boolean): void;
  onBack(): void;
  onPublished(result: { title: string; visibility: AppStorePackageVisibility }): void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [release, setRelease] = useState<MountedAppReleaseDraft>();
  const [releaseEdited, setReleaseEdited] = useState(false);
  const [applyToCurrentApp, setApplyToCurrentApp] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [trackedPublishVersion, setTrackedPublishVersion] = useState("");
  const [publishFinalizationBlocked, setPublishFinalizationBlocked] = useState(false);
  const [publishRequestPending, setPublishRequestPending] = useState(false);
  const [automaticRecoveryPaused, setAutomaticRecoveryPaused] = useState(false);
  const [leaveBlocked, setLeaveBlocked] = useState(false);
  const publishedHandled = useRef(false);
  const releaseEditRevision = useRef(0);
  const formalReleaseEdited = useRef(false);
  const hydratedReleaseSource = useRef<"none" | "local" | "formal">("none");
  const automaticRecoveryAttempts = useRef(new Map<string, number>());
  const hasUnsavedPageChanges = releaseEdited || applyToCurrentApp;
  const draftQuery = useQuery({
    queryKey: ["apps", props.app.id, "local-draft"],
    queryFn: async () => {
      try {
        return await getMountedAppLocalDraft(props.app.id);
      } catch (error) {
        if (error instanceof BridgeRequestError && error.message === "local_app_draft_not_found") {
          return { ok: true, draft: undefined } as const;
        }
        throw error;
      }
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const localPrepareQuery = useQuery({
    queryKey: ["apps", props.app.id, "local-draft", "prepare"],
    queryFn: async () => {
      const result = await prepareMountedAppLocalDraft(props.app.id);
      if (!result.release) throw new Error(result.error || "local_app_draft_prepare_failed");
      return result.release;
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const formalPrepareQuery = useQuery({
    queryKey: appStoreQueryKeys.publishPrepare(props.app.id),
    queryFn: async () => {
      const result = await prepareMountedAppPublish(props.app.id);
      if (!result.release) throw new Error(result.error || "app_store_release_prepare_failed");
      return result.release;
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    enabled: props.canPublish === true,
  });
  const versionsQuery = useQuery({
    queryKey: appStoreQueryKeys.versions(props.app.id),
    queryFn: () => getMountedAppVersions(props.app.id),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const progressQuery = useQuery({
    queryKey: appStoreQueryKeys.publishProgress(props.app.id),
    queryFn: async () => {
      let current;
      try {
        current = await getMountedAppPublishProgress(props.app.id);
      } catch (error) {
        if (error instanceof BridgeRequestError && error.message === "app_store_publish_journal_missing") {
          return { ok: true, progress: undefined } as const;
        }
        throw error;
      }
      return current;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    enabled: props.canPublish === true,
    refetchOnWindowFocus: false,
    refetchInterval(query) {
      const error = query.state.error;
      if (error && isLocalPublishFinalizationConflict(error)) return false;
      return publishRequestPending ? 2_000 : false;
    },
  });
  const localErrorProgress = publishProgressFromError(progressQuery.error);
  const localPublishProgress = localErrorProgress ?? progressQuery.data?.progress;
  const remoteStatusQuery = useQuery({
    queryKey: [...appStoreQueryKeys.publishProgress(props.app.id), "remote-status"],
    queryFn: () => refreshMountedAppPublishProgress(props.app.id),
    enabled:
      props.canPublish === true &&
      (localPublishProgress?.state === "publishing" ||
        (localPublishProgress?.state === "blocked" && Boolean(localPublishProgress.remoteIntentId))),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval(query) {
      const progress = query.state.data?.progress;
      const shouldRefresh =
        progress?.state === "publishing" || (progress?.state === "blocked" && Boolean(progress.remoteIntentId));
      return shouldRefresh ? 2_000 : false;
    },
  });
  useEffect(() => {
    if (releaseEdited) return;
    if (formalPrepareQuery.data && hydratedReleaseSource.current !== "formal") {
      hydratedReleaseSource.current = "formal";
      setRelease(structuredClone(formalPrepareQuery.data));
      return;
    }
    if (localPrepareQuery.data && hydratedReleaseSource.current === "none") {
      hydratedReleaseSource.current = "local";
      setRelease(structuredClone(localPrepareQuery.data));
    }
  }, [formalPrepareQuery.data, localPrepareQuery.data, releaseEdited]);
  useEffect(() => {
    if (!hasUnsavedPageChanges) return;
    const preventWindowClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventWindowClose);
    return () => window.removeEventListener("beforeunload", preventWindowClose);
  }, [hasUnsavedPageChanges]);
  useEffect(() => {
    props.onDirtyChange?.(hasUnsavedPageChanges);
  }, [hasUnsavedPageChanges, props.onDirtyChange]);
  useEffect(
    () => () => {
      props.onDirtyChange?.(false);
    },
    [props.onDirtyChange],
  );

  const publishProgress = remoteStatusQuery.data?.progress ?? localPublishProgress;
  const versionStatus = versionsQuery.data?.status;
  const publishBaseVersion =
    versionStatus?.activeContent === "local-draft"
      ? versionStatus.localDraft?.publishBase?.version
      : versionStatus?.selectedVersion?.version;
  const hasUnfinishedPublish = Boolean(publishProgress && releaseInProgress(publishProgress));
  useEffect(() => {
    if (!publishProgress || publishProgress.state === "published") return;
    setTrackedPublishVersion((current) => current || publishProgress.version);
  }, [publishProgress]);
  useEffect(() => {
    if (
      !trackedPublishVersion ||
      publishProgress?.state !== "published" ||
      publishProgress.version !== trackedPublishVersion ||
      publishedHandled.current
    ) {
      return;
    }
    publishedHandled.current = true;
    props.onPublished({
      title: publishProgress.title,
      visibility: publishProgress.visibility,
    });
  }, [props.onPublished, publishProgress, trackedPublishVersion]);
  useEffect(() => {
    if (!progressQuery.isError) return;
    if (isLocalPublishFinalizationConflict(progressQuery.error)) {
      setPublishFinalizationBlocked(true);
    }
    const progress = publishProgressFromError(progressQuery.error);
    const manualContinue = releaseRecoveryRequiresManualContinue(progressQuery.error);
    if (manualContinue) setAutomaticRecoveryPaused(true);
    if (
      releaseAutomaticallyRecoverable(progress) &&
      !isLocalPublishFinalizationConflict(progressQuery.error) &&
      !manualContinue
    ) {
      setSubmitError("");
      return;
    }
    setSubmitError(
      releaseErrorMessage(
        t,
        progressQuery.error instanceof Error ? progressQuery.error.message : String(progressQuery.error),
      ),
    );
  }, [progressQuery.error, progressQuery.isError, t]);
  useEffect(() => {
    if (!remoteStatusQuery.isError) return;
    setAutomaticRecoveryPaused(true);
  }, [remoteStatusQuery.error, remoteStatusQuery.isError]);

  const publishMutation = useMutation({
    mutationFn: (value: { release: MountedAppReleaseDraft; applyToCurrentApp: boolean; editRevision: number }) =>
      publishMountedApp(props.app.id, value.release, {
        applyToCurrentApp: value.applyToCurrentApp,
      }),
    onMutate() {
      setPublishFinalizationBlocked(false);
      setAutomaticRecoveryPaused(false);
      setPublishRequestPending(true);
    },
    onSuccess(result, submitted) {
      setPublishFinalizationBlocked(false);
      setAutomaticRecoveryPaused(false);
      setSubmitError("");
      if (releaseEditRevision.current === submitted.editRevision) {
        formalReleaseEdited.current = false;
        setReleaseEdited(false);
      }
      setTrackedPublishVersion(submitted.release.version);
      queryClient.setQueryData(appStoreQueryKeys.publishProgress(props.app.id), result);
      queryClient.setQueryData([...appStoreQueryKeys.publishProgress(props.app.id), "remote-status"], result);
      void draftQuery.refetch();
      void progressQuery.refetch();
    },
    onError(error) {
      setPublishFinalizationBlocked(isLocalPublishFinalizationConflict(error));
      const manualContinue = releaseRecoveryRequiresManualContinue(error);
      if (manualContinue) setAutomaticRecoveryPaused(true);
      const checks =
        error instanceof BridgeRequestError && Array.isArray(error.payload?.checks)
          ? (error.payload.checks as AppReleaseCheck[])
          : undefined;
      if (checks?.length) setRelease((current) => (current ? { ...current, checks } : current));
      const progress = publishProgressFromError(error);
      if (progress) {
        if (progress.state !== "published") {
          setTrackedPublishVersion((current) => current || progress.version);
        }
        queryClient.setQueryData(appStoreQueryKeys.publishProgress(props.app.id), { ok: false, progress });
        queryClient.setQueryData([...appStoreQueryKeys.publishProgress(props.app.id), "remote-status"], {
          ok: false,
          progress,
        });
      }
      const autoRecovering =
        releaseAutomaticallyRecoverable(progress) && !isLocalPublishFinalizationConflict(error) && !manualContinue;
      setSubmitError(
        autoRecovering ? "" : releaseErrorMessage(t, error instanceof Error ? error.message : String(error)),
      );
      void draftQuery.refetch();
      void progressQuery.refetch();
    },
    onSettled() {
      setPublishRequestPending(false);
    },
  });
  const recoveryMutation = useMutation({
    mutationFn: (retryFailedBuild: boolean) => reconcileMountedAppPublish(props.app.id, { retryFailedBuild }),
    onMutate() {
      setPublishFinalizationBlocked(false);
      setAutomaticRecoveryPaused(false);
      setSubmitError("");
    },
    onSuccess(result) {
      setPublishFinalizationBlocked(false);
      setAutomaticRecoveryPaused(false);
      setSubmitError("");
      queryClient.setQueryData(appStoreQueryKeys.publishProgress(props.app.id), result);
      queryClient.setQueryData([...appStoreQueryKeys.publishProgress(props.app.id), "remote-status"], result);
      void draftQuery.refetch();
      void progressQuery.refetch();
    },
    onError(error) {
      setPublishFinalizationBlocked(isLocalPublishFinalizationConflict(error));
      const manualContinue = releaseRecoveryRequiresManualContinue(error);
      if (manualContinue) setAutomaticRecoveryPaused(true);
      const progress = publishProgressFromError(error);
      if (progress) {
        queryClient.setQueryData(appStoreQueryKeys.publishProgress(props.app.id), { ok: false, progress });
        queryClient.setQueryData([...appStoreQueryKeys.publishProgress(props.app.id), "remote-status"], {
          ok: false,
          progress,
        });
      }
      const autoRecovering =
        releaseAutomaticallyRecoverable(progress) && !isLocalPublishFinalizationConflict(error) && !manualContinue;
      const automaticRecovery = automaticRecoveryBudget(progress);
      const automaticRecoveryExhausted =
        autoRecovering &&
        automaticRecovery.key !== "" &&
        (automaticRecoveryAttempts.current.get(automaticRecovery.key) ?? 0) >= automaticRecovery.limit;
      if (automaticRecoveryExhausted) setAutomaticRecoveryPaused(true);
      setSubmitError(
        autoRecovering && !automaticRecoveryExhausted
          ? ""
          : releaseErrorMessage(t, error instanceof Error ? error.message : String(error)),
      );
    },
  });
  useEffect(() => {
    const automaticRecoveryProgress =
      publishProgress?.phase === "registry_ready" ? publishProgress : remoteStatusQuery.data?.progress;
    const remoteStatus = automaticRecoveryProgress?.remoteStatus;
    const automaticRecovery = automaticRecoveryBudget(automaticRecoveryProgress);
    const remoteTransitionRequiresRecovery =
      automaticRecoveryProgress?.state === "registry-ready" ||
      (automaticRecoveryProgress?.state === "publishing" &&
        (remoteStatus === "awaiting_candidate" ||
          remoteStatus === "artifact_accepted" ||
          remoteStatus === "finalizing"));
    if (
      props.canPublish !== true ||
      publishRequestPending ||
      automaticRecoveryPaused ||
      recoveryMutation.isPending ||
      !releaseAutomaticallyRecoverable(automaticRecoveryProgress) ||
      !remoteTransitionRequiresRecovery ||
      !automaticRecovery.key ||
      (automaticRecoveryAttempts.current.get(automaticRecovery.key) ?? 0) >= automaticRecovery.limit
    ) {
      return;
    }
    automaticRecoveryAttempts.current.set(
      automaticRecovery.key,
      (automaticRecoveryAttempts.current.get(automaticRecovery.key) ?? 0) + 1,
    );
    recoveryMutation.mutate(false);
  }, [
    automaticRecoveryPaused,
    props.canPublish,
    publishProgress,
    publishRequestPending,
    recoveryMutation,
    remoteStatusQuery.data,
  ]);
  const keepLocalChangesMutation = useMutation({
    mutationFn: () => keepLocalChangesAfterMountedAppPublish(props.app.id),
    onMutate() {
      setPublishFinalizationBlocked(false);
    },
    onSuccess(result) {
      setPublishFinalizationBlocked(false);
      setSubmitError("");
      queryClient.setQueryData(appStoreQueryKeys.publishProgress(props.app.id), result);
      void draftQuery.refetch();
    },
    onError(error) {
      const progress = publishProgressFromError(error);
      if (progress) {
        queryClient.setQueryData(appStoreQueryKeys.publishProgress(props.app.id), { ok: false, progress });
      }
      setSubmitError(releaseErrorMessage(t, error instanceof Error ? error.message : String(error)));
    },
  });
  const abandonMutation = useMutation({
    mutationFn: () => abandonMountedAppPublish(props.app.id),
    onSuccess(result) {
      setSubmitError("");
      queryClient.setQueryData(appStoreQueryKeys.publishProgress(props.app.id), result);
      void formalPrepareQuery.refetch();
      void progressQuery.refetch();
    },
    onError(error) {
      const progress = publishProgressFromError(error);
      if (progress) {
        queryClient.setQueryData(appStoreQueryKeys.publishProgress(props.app.id), { ok: false, progress });
      }
      setSubmitError(releaseErrorMessage(t, error instanceof Error ? error.message : String(error)));
    },
  });
  const saveDraftMutation = useMutation({
    mutationFn: (value: { candidate: MountedAppReleaseDraft; editRevision: number }) =>
      saveMountedAppLocalDraft(props.app.id, value.candidate),
    onSuccess: (_result, submitted) => {
      if (releaseEditRevision.current === submitted.editRevision) {
        setReleaseEdited(formalReleaseEdited.current);
      }
      void draftQuery.refetch();
    },
  });
  const repairBuildContractMutation = useMutation({
    mutationFn: async () => {
      await repairMountedAppBuildContract(props.app.id);
      const [local, formal] = await Promise.all([localPrepareQuery.refetch(), formalPrepareQuery.refetch()]);
      const prepared = formal.data ?? local.data;
      if (!prepared) throw formal.error ?? local.error ?? new Error("app_store_release_prepare_failed");
      return prepared;
    },
    onSuccess(prepared) {
      setSubmitError("");
      setRelease((current) =>
        current ? { ...current, checks: structuredClone(prepared.checks) } : structuredClone(prepared),
      );
    },
    onError(error) {
      setSubmitError(releaseErrorMessage(t, error instanceof Error ? error.message : String(error)));
    },
  });
  const prepareError = localPrepareQuery.error;
  const formalBasisState: "unavailable" | "confirming" | "ready" | "failed" =
    props.canPublish !== true || hasUnfinishedPublish
      ? "unavailable"
      : formalPrepareQuery.isError
        ? "failed"
        : formalPrepareQuery.isPending || formalPrepareQuery.isFetching
          ? "confirming"
          : "ready";
  const formalPrepareError = formalBasisState === "failed" ? formalPrepareQuery.error : undefined;
  const formalPrepareErrorMessage = formalPrepareError
    ? releaseErrorMessage(
        t,
        formalPrepareError instanceof Error ? formalPrepareError.message : String(formalPrepareError),
      )
    : "";
  const remoteStatusErrorMessage = remoteStatusQuery.error
    ? releaseErrorMessage(
        t,
        remoteStatusQuery.error instanceof Error ? remoteStatusQuery.error.message : String(remoteStatusQuery.error),
      )
    : "";
  const requestReferenceError = [
    recoveryMutation.error,
    publishMutation.error,
    progressQuery.error,
    remoteStatusQuery.error,
  ].find((error) => error instanceof BridgeRequestError && /^[a-f0-9]{32}$/.test(error.requestId ?? ""));
  const requestReference =
    requestReferenceError instanceof BridgeRequestError ? requestReferenceError.requestId : undefined;
  const submitDiagnostic =
    releaseFailureDiagnostic(recoveryMutation.error) ??
    releaseFailureDiagnostic(publishMutation.error) ??
    releaseFailureDiagnostic(progressQuery.error) ??
    (requestReference ? { requestId: requestReference } : undefined);
  if (prepareError) {
    return (
      <section
        className="app-store-publish-page"
        aria-label={t("appStore.release.manageAria", { name: props.app.title })}
      >
        <PublishHeader title={props.app.title} onBack={props.onBack} />
        <div className="app-store-publish-state app-store-publish-state--error">
          <XCircle size={22} />
          <div>
            <strong>{t("appStore.release.prepareFailed")}</strong>
            <p>{releaseErrorMessage(t, prepareError instanceof Error ? prepareError.message : String(prepareError))}</p>
          </div>
        </div>
      </section>
    );
  }
  if (localPrepareQuery.isPending || (props.canPublish === true && progressQuery.isPending) || !release) {
    return (
      <section
        className="app-store-publish-page"
        aria-label={t("appStore.release.manageAria", { name: props.app.title })}
      >
        <PublishHeader title={props.app.title} pending onBack={props.onBack} />
        <div className="app-store-publish-state">
          <LoaderCircle className="app-store-publish-spinner" size={22} />
          <span>{t("appStore.release.loading")}</span>
        </div>
      </section>
    );
  }
  const requestBack = () => {
    if (hasUnsavedPageChanges) {
      setLeaveBlocked(true);
      return;
    }
    props.onBack();
  };
  return (
    <>
      <AppStorePublishReleaseEditor
        release={release}
        publishBaseVersion={publishBaseVersion}
        publishBasePending={versionsQuery.isPending}
        publishFormalBasisPending={formalBasisState === "confirming"}
        applyToCurrentApp={applyToCurrentApp}
        pending={
          publishMutation.isPending ||
          recoveryMutation.isPending ||
          abandonMutation.isPending ||
          keepLocalChangesMutation.isPending ||
          (!automaticRecoveryPaused &&
            (publishProgress?.state === "publishing" || publishProgress?.state === "registry-ready"))
        }
        submitError={submitError || remoteStatusErrorMessage || formalPrepareErrorMessage}
        submitDiagnostic={submitDiagnostic}
        publishProgress={publishProgress}
        publishRecoveryPending={
          recoveryMutation.isPending ||
          abandonMutation.isPending ||
          (!automaticRecoveryPaused &&
            (progressQuery.isFetching ||
              publishProgress?.state === "publishing" ||
              publishProgress?.state === "registry-ready"))
        }
        publishRecoveryPaused={automaticRecoveryPaused}
        publishAbandonPending={abandonMutation.isPending}
        publishResolutionPending={keepLocalChangesMutation.isPending}
        publishRecoveryBlocked={publishFinalizationBlocked}
        localDraft={saveDraftMutation.data?.draft ?? draftQuery.data?.draft}
        draftPending={draftQuery.isPending || saveDraftMutation.isPending}
        buildContractRepairPending={repairBuildContractMutation.isPending}
        canPublish={props.canPublish === true}
        publishEnabled={hasUnfinishedPublish || formalBasisState === "ready"}
        draftError={
          draftQuery.isError
            ? draftQuery.error instanceof Error
              ? draftQuery.error.message
              : String(draftQuery.error)
            : saveDraftMutation.isError
              ? saveDraftMutation.error instanceof Error
                ? saveDraftMutation.error.message
                : String(saveDraftMutation.error)
              : ""
        }
        onBack={requestBack}
        activeKernel={props.activeKernel}
        activeModel={props.activeModel}
        kernelOptions={props.kernelOptions}
        providers={props.providers}
        modelProviderBindings={props.modelProviderBindings}
        runtimeControls={props.runtimeControls}
        runtimeControlsByKernel={props.runtimeControlsByKernel}
        skills={props.skills}
        onChange={(next, scope) => {
          setSubmitError("");
          releaseEditRevision.current += 1;
          if (scope === "formal") formalReleaseEdited.current = true;
          setReleaseEdited(true);
          setRelease(next);
        }}
        onApplyToCurrentAppChange={setApplyToCurrentApp}
        onSaveDraft={(candidate) =>
          saveDraftMutation.mutate({
            candidate,
            editRevision: releaseEditRevision.current,
          })
        }
        onRepairBuildContract={() => repairBuildContractMutation.mutate()}
        onPublish={(next, options) =>
          publishMutation.mutate({
            release: next,
            applyToCurrentApp: options.applyToCurrentApp,
            editRevision: releaseEditRevision.current,
          })
        }
        onRetryPublishBuild={() => recoveryMutation.mutate(true)}
        onContinuePublish={() => recoveryMutation.mutate(false)}
        onAbandonPublish={() => abandonMutation.mutate()}
        onKeepLocalChanges={() => keepLocalChangesMutation.mutate()}
      />
      {leaveBlocked ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setLeaveBlocked(false);
          }}
        >
          <DialogContent className="app-store-version-blocker" aria-describedby="app-store-release-unsaved-body">
            <div>
              <AlertTriangle size={20} />
              <div>
                <DialogTitle>{t("appStore.version.unsavedTitle")}</DialogTitle>
                <p id="app-store-release-unsaved-body">{t("appStore.release.unsavedLeaveBody")}</p>
              </div>
            </div>
            <div className="app-store-version-blocker-actions">
              <button type="button" className="og-button" onClick={() => setLeaveBlocked(false)}>
                <Save size={15} />
                {t("appStore.version.goSave")}
              </button>
              <button
                type="button"
                className="og-button og-button--danger"
                onClick={() => {
                  setLeaveBlocked(false);
                  setReleaseEdited(false);
                  setApplyToCurrentApp(false);
                  props.onBack();
                }}
              >
                <XCircle size={15} />
                {t("appStore.release.discardAndLeave")}
              </button>
              <button type="button" className="og-button" onClick={() => setLeaveBlocked(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export function AppStorePublishReleaseEditor(props: {
  release: MountedAppReleaseDraft;
  publishBaseVersion?: string;
  publishBasePending?: boolean;
  publishFormalBasisPending?: boolean;
  activeKernel?: string;
  activeModel?: string;
  kernelOptions?: KernelOption[];
  providers: ProviderProfile[] | undefined;
  modelProviderBindings: ModelProviderBinding[] | undefined;
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  skills?: SkillRecord[];
  applyToCurrentApp?: boolean;
  pending?: boolean;
  submitError?: string;
  submitDiagnostic?: AppReleaseFailureDiagnostic;
  publishProgress?: AppReleaseProgress;
  publishRecoveryPending?: boolean;
  publishRecoveryPaused?: boolean;
  publishAbandonPending?: boolean;
  publishResolutionPending?: boolean;
  publishRecoveryBlocked?: boolean;
  localDraft?: LocalAppDraftSummary;
  draftPending?: boolean;
  buildContractRepairPending?: boolean;
  draftError?: string;
  canPublish?: boolean;
  publishEnabled?: boolean;
  onBack(): void;
  onChange(release: MountedAppReleaseDraft, scope?: "draft" | "formal"): void;
  onApplyToCurrentAppChange?(value: boolean): void;
  onSaveDraft(release: MountedAppReleaseDraft): void;
  onRepairBuildContract?(): void;
  onPublish(release: MountedAppReleaseDraft, options: { applyToCurrentApp: boolean }): void;
  onRetryPublishBuild?(): void;
  onContinuePublish?(): void;
  onAbandonPublish?(): void;
  onKeepLocalChanges?(): void;
}) {
  const { t } = useI18n();
  const release = props.release;
  const canPublish = props.canPublish !== false;
  const publishEnabled = canPublish && props.publishEnabled !== false;
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const selectedEmployeeIndex = selectedEmployeeId
    ? release.employees.findIndex((employee) => employee.memberId === selectedEmployeeId)
    : -1;
  const selectedEmployee = selectedEmployeeIndex >= 0 ? release.employees[selectedEmployeeIndex] : undefined;
  const checks = useMemo(() => currentChecks(release), [release]);
  const hasBlockingCheck = checks.some((check) => check.status === "blocked" && check.severity === "blocking");
  const hasUnfinishedPublish = Boolean(props.publishProgress && releaseInProgress(props.publishProgress));
  const employeeKernelOptions = useMemo(
    () => (props.kernelOptions?.length ? props.kernelOptions : releaseKernelOptions(release.employees)),
    [props.kernelOptions, release.employees],
  );
  const employeeSkillRecords = useMemo(
    () => (props.skills?.length ? props.skills : releaseSkillRecords(release.employees)),
    [props.skills, release.employees],
  );

  useEffect(() => {
    if (!selectedEmployeeId) return;
    if (release.employees.some((employee) => employee.memberId === selectedEmployeeId)) return;
    setSelectedEmployeeId(null);
  }, [release.employees, selectedEmployeeId]);

  function updateRelease(update: (current: MountedAppReleaseDraft) => void, scope: "draft" | "formal" = "draft") {
    const next = structuredClone(release);
    update(next);
    props.onChange(next, scope);
  }

  return (
    <section
      className="app-store-publish-page"
      aria-label={t(canPublish ? "appStore.release.publishAria" : "appStore.release.manageAria", {
        name: release.app.title,
      })}
    >
      <PublishHeader
        title={release.app.title}
        pending={props.pending}
        publishDisabled={!publishEnabled || hasBlockingCheck || hasUnfinishedPublish}
        onBack={props.onBack}
        onPublish={
          canPublish
            ? () => props.onPublish(release, { applyToCurrentApp: props.applyToCurrentApp === true })
            : undefined
        }
      />

      {props.publishProgress && props.publishProgress.state !== "published" ? (
        <PublishProgressNotice
          progress={props.publishProgress}
          canPublish={canPublish}
          pending={props.publishRecoveryPending === true}
          recoveryPaused={props.publishRecoveryPaused === true}
          abandonPending={props.publishAbandonPending === true}
          resolutionPending={props.publishResolutionPending === true}
          recoveryBlocked={props.publishRecoveryBlocked === true}
          onRetryBuild={props.onRetryPublishBuild}
          onContinue={props.onContinuePublish}
          onAbandon={props.onAbandonPublish}
          onKeepLocalChanges={props.onKeepLocalChanges}
        />
      ) : null}

      {props.submitError ? (
        <div className="app-store-publish-submit-error" role="alert">
          <AlertTriangle size={17} />
          <div>
            <span>{props.submitError}</span>
            {props.submitDiagnostic?.requestId && !props.submitDiagnostic.candidateStage ? (
              <div>
                {t("appStore.release.failureRequestId", {
                  requestId: props.submitDiagnostic.requestId,
                })}
              </div>
            ) : props.submitDiagnostic ? (
              <details>
                <summary>{t("appStore.registryError.details")}</summary>
                {props.submitDiagnostic.candidateStage ? (
                  <div>
                    {t("appStore.release.failureStage", {
                      stage: props.submitDiagnostic.candidateStage,
                    })}
                  </div>
                ) : null}
                {props.submitDiagnostic.requestId ? (
                  <div>
                    {t("appStore.release.failureRequestId", {
                      requestId: props.submitDiagnostic.requestId,
                    })}
                  </div>
                ) : null}
                {props.submitDiagnostic.localBuild ? (
                  <div className="app-store-publish-local-build-diagnostic">
                    <div>
                      {t("appStore.release.localBuildCommand", {
                        index: props.submitDiagnostic.localBuild.commandIndex,
                        command: `${props.submitDiagnostic.localBuild.argv.join(" ")}${
                          props.submitDiagnostic.localBuild.argvTruncated
                            ? t("appStore.release.localBuildArgvTruncated")
                            : ""
                        }`,
                      })}
                    </div>
                    <div>
                      {t("appStore.release.localBuildExitCode", {
                        code: props.submitDiagnostic.localBuild.exitCode,
                      })}
                    </div>
                    {props.submitDiagnostic.localBuild.stdout ? (
                      <section>
                        <strong>
                          {t("appStore.release.localBuildStdout", {
                            truncated: props.submitDiagnostic.localBuild.stdoutTruncated
                              ? t("appStore.release.localBuildTruncated")
                              : "",
                          })}
                        </strong>
                        <pre>{props.submitDiagnostic.localBuild.stdout}</pre>
                      </section>
                    ) : null}
                    {props.submitDiagnostic.localBuild.stderr ? (
                      <section>
                        <strong>
                          {t("appStore.release.localBuildStderr", {
                            truncated: props.submitDiagnostic.localBuild.stderrTruncated
                              ? t("appStore.release.localBuildTruncated")
                              : "",
                          })}
                        </strong>
                        <pre>{props.submitDiagnostic.localBuild.stderr}</pre>
                      </section>
                    ) : null}
                  </div>
                ) : null}
              </details>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="app-store-publish-content">
        <main className="app-store-publish-main">
          {canPublish ? (
            <PublishSection
              title={t("appStore.release.versionInfo")}
              description={t("appStore.release.versionInfoDesc")}
            >
              <div className="app-store-publish-field-group">
                <PublishField
                  label={t("appStore.release.versionLabel")}
                  required
                  hint={
                    props.publishFormalBasisPending
                      ? t("appStore.release.formalBasisPendingHint")
                      : release.latestPublishedVersion
                        ? t("appStore.release.latestVersion", { version: release.latestPublishedVersion })
                        : t("appStore.release.firstVersionHint")
                  }
                >
                  <input
                    value={release.version}
                    onChange={(event) =>
                      updateRelease((current) => {
                        current.version = event.target.value;
                      }, "formal")
                    }
                    placeholder="0.1.0"
                  />
                </PublishField>
                <PublishField
                  label={t("appStore.release.notesLabel")}
                  hint={`${release.releaseNotes.length}/800`}
                  stacked
                >
                  <textarea
                    value={release.releaseNotes}
                    maxLength={800}
                    rows={3}
                    onChange={(event) =>
                      updateRelease((current) => {
                        current.releaseNotes = event.target.value;
                      }, "formal")
                    }
                    placeholder={t("appStore.release.notesPlaceholder")}
                  />
                </PublishField>
              </div>
              <dl className="app-store-publish-identity">
                <ReadOnlyValue
                  label={t("appStore.release.publishBaseLabel")}
                  value={
                    props.publishBasePending
                      ? t("appStore.release.publishBaseLoading")
                      : props.publishBaseVersion
                        ? `v${props.publishBaseVersion}`
                        : t("appStore.release.firstPublishBase")
                  }
                />
                <ReadOnlyValue
                  label={t("appStore.release.registryLatestLabel")}
                  value={
                    props.publishFormalBasisPending
                      ? t("appStore.release.formalBasisPendingValue")
                      : release.latestPublishedVersion
                        ? `v${release.latestPublishedVersion}`
                        : t("appStore.release.registryLatestEmpty")
                  }
                />
              </dl>
            </PublishSection>
          ) : null}

          <PublishSection
            title={t("appStore.release.appInfo")}
            description={t(canPublish ? "appStore.release.appInfoDesc" : "appStore.release.appDraftInfoDesc")}
          >
            <AppIdentityEditor
              value={release.app}
              onChange={(app) =>
                updateRelease((current) => {
                  current.app = app;
                })
              }
            />
          </PublishSection>

          <PublishSection
            title={
              canPublish
                ? t("appStore.release.employeeDefaultsTitle", { count: release.employees.length })
                : t("appStore.release.employeeDraftTitle", { count: release.employees.length })
            }
            description={
              canPublish ? t("appStore.release.employeeDefaultsDesc") : t("appStore.release.employeeDraftDesc")
            }
          >
            {selectedEmployee ? (
              <div className="app-store-publish-employee-settings">
                <button
                  className="app-store-publish-employee-settings-back"
                  type="button"
                  onClick={() => setSelectedEmployeeId(null)}
                >
                  <ArrowLeft size={17} />
                  <span>
                    {canPublish
                      ? t("appStore.release.employeeDefaultsTitle", { count: release.employees.length })
                      : t("appStore.release.employeeDraftTitle", { count: release.employees.length })}
                  </span>
                </button>
                <div className="app-store-publish-employee-settings-surface">
                  <EmployeeSettingsSurface
                    key={selectedEmployee.memberId}
                    member={releaseEmployeeToRoomMember(selectedEmployee, release.identity.appId)}
                    rooms={[]}
                    activeKernel={props.activeKernel ?? selectedEmployee.kernel}
                    activeModel={props.activeModel ?? selectedEmployee.model}
                    kernelOptions={employeeKernelOptions}
                    providers={props.providers}
                    modelProviderBindings={props.modelProviderBindings}
                    providerRoutingEnabled={false}
                    runtimeControls={props.runtimeControls}
                    runtimeControlsByKernel={props.runtimeControlsByKernel}
                    skills={employeeSkillRecords}
                    onSave={(member) =>
                      updateRelease((current) => {
                        const employee = current.employees[selectedEmployeeIndex];
                        if (!employee) return;
                        current.employees[selectedEmployeeIndex] = roomMemberToReleaseEmployee(employee, member);
                      })
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="app-store-publish-employee-list">
                {release.employees.map((employee) => (
                  <button
                    className="app-store-publish-employee-row"
                    key={employee.memberId}
                    type="button"
                    onClick={() => setSelectedEmployeeId(employee.memberId)}
                  >
                    <RoomMemberAvatar
                      member={releaseEmployeeToRoomMember(employee, release.identity.appId)}
                      showStatus={false}
                    />
                    <span>
                      <strong>{employee.name}</strong>
                      <small>
                        {kernelLabel(employee.kernel)} · {employee.model}
                      </small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            )}
          </PublishSection>

          {canPublish ? (
            <PublishSection
              title={t("appStore.release.identityTitle")}
              description={t("appStore.release.identityDesc")}
            >
              <dl className="app-store-publish-identity">
                <ReadOnlyValue label={t("appStore.release.appIdLabel")} value={release.identity.appId} />
                <ReadOnlyValue
                  label={t("appStore.release.packageIdentityLabel")}
                  value={release.identity.packageKey || t("appStore.release.packageIdentityPending")}
                />
                <ReadOnlyValue
                  label={t("appStore.release.sourceLabel")}
                  value={
                    release.identity.source === "registry"
                      ? t("appStore.release.sourceRegistry")
                      : t("appStore.release.sourceMounted")
                  }
                />
                <ReadOnlyValue label={t("appStore.release.appRootLabel")} value={release.identity.appRoot} />
                <ReadOnlyValue label={t("appStore.release.workspaceLabel")} value={release.identity.workspaceRoot} />
              </dl>
            </PublishSection>
          ) : null}
        </main>

        <aside className="app-store-publish-side">
          <PublishSection
            title={t("appStore.release.localDraftTitle")}
            description={t("appStore.release.localDraftDesc")}
            compact
          >
            <div className="app-store-local-draft-card" data-state={props.localDraft ? "saved" : "empty"}>
              <HardDrive size={18} />
              <div>
                <strong>
                  {props.localDraft ? t("appStore.release.localDraftSaved") : t("appStore.release.localDraftEmpty")}
                </strong>
                <small>
                  {props.localDraft
                    ? t("appStore.release.localDraftSavedAt", {
                        time: formatDraftSavedAt(props.localDraft.savedAt),
                      })
                    : t("appStore.release.localDraftEmptyHint")}
                </small>
                {props.localDraft ? (
                  <small>
                    {props.localDraft.publishBase?.version
                      ? t("appStore.release.localDraftPublishBase", {
                          version: props.localDraft.publishBase.version,
                        })
                      : t("appStore.release.localDraftFirstPublishBase")}
                  </small>
                ) : null}
              </div>
            </div>
            {props.draftError ? (
              <p className="app-store-local-draft-error" role="alert">
                {props.draftError}
              </p>
            ) : null}
            <div className="app-store-local-draft-actions">
              <button
                className="og-button app-store-local-draft-save"
                type="button"
                disabled={props.draftPending}
                onClick={() => props.onSaveDraft(release)}
              >
                {props.draftPending ? (
                  <LoaderCircle className="app-store-publish-spinner" size={15} />
                ) : (
                  <Save size={15} />
                )}
                <span>
                  {props.draftPending ? t("appStore.release.localDraftSaving") : t("appStore.release.localDraftSave")}
                </span>
              </button>
            </div>
          </PublishSection>

          {canPublish ? (
            <PublishSection title={t("appStore.release.scopeTitle")} compact>
              <div
                className="app-store-publish-visibility"
                role="radiogroup"
                aria-label={t("appStore.publishVisibilityAriaLabel")}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={release.visibility === "restricted"}
                  data-active={release.visibility === "restricted" ? "true" : "false"}
                  onClick={() =>
                    updateRelease((current) => {
                      current.visibility = "restricted";
                    }, "formal")
                  }
                >
                  <ShieldCheck size={14} />
                  <span>{t("appStore.visibilityRestricted")}</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={release.visibility === "public"}
                  data-active={release.visibility === "public" ? "true" : "false"}
                  onClick={() =>
                    updateRelease((current) => {
                      current.visibility = "public";
                    }, "formal")
                  }
                >
                  <Globe2 size={14} />
                  <span>{t("appStore.release.visibilityPublic")}</span>
                </button>
              </div>
              <label className="app-store-publish-apply-local">
                <input
                  type="checkbox"
                  aria-label={t("appStore.release.applyToCurrentApp")}
                  checked={props.applyToCurrentApp === true}
                  onChange={(event) => props.onApplyToCurrentAppChange?.(event.target.checked)}
                />
                <span>
                  <strong>{t("appStore.release.applyToCurrentApp")}</strong>
                  <small>{t("appStore.release.applyToCurrentAppHint")}</small>
                </span>
              </label>
            </PublishSection>
          ) : null}

          {canPublish ? (
            <PublishSection
              title={t("appStore.release.checksTitle")}
              description={t("appStore.release.checksDesc")}
              compact
            >
              <div className="app-store-publish-checks">
                {checks.map((check) => (
                  <ReleaseCheck
                    key={check.id}
                    check={check}
                    repairPending={props.buildContractRepairPending === true}
                    onRepair={props.onRepairBuildContract}
                  />
                ))}
              </div>
            </PublishSection>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

// ===== Presentation components =====

function PublishHeader(props: {
  title: string;
  pending?: boolean;
  publishDisabled?: boolean;
  onBack(): void;
  onPublish?(): void;
}) {
  const { t } = useI18n();
  return (
    <header className="app-store-publish-header">
      <div className="app-store-publish-header-title">
        <button
          type="button"
          className="app-store-publish-back"
          onClick={props.onBack}
          aria-label={t("appStore.release.backAria")}
        >
          <ArrowLeft size={19} />
        </button>
        <span className="app-store-package-icon" aria-hidden="true">
          <Package size={18} />
        </span>
        <div>
          <h1>{t("appStore.saveAndPublishApp")}</h1>
          <p>{props.title}</p>
        </div>
      </div>
      {props.onPublish ? (
        <button
          className="og-button og-button--primary app-store-publish-submit"
          type="button"
          disabled={props.pending || props.publishDisabled}
          onClick={props.onPublish}
        >
          {props.pending ? <LoaderCircle className="app-store-publish-spinner" size={15} /> : <Upload size={15} />}
          <span>{props.pending ? t("appStore.release.publishing") : t("appStore.publish")}</span>
        </button>
      ) : null}
    </header>
  );
}

function PublishProgressNotice(props: {
  progress: AppReleaseProgress;
  canPublish: boolean;
  pending: boolean;
  recoveryPaused: boolean;
  abandonPending?: boolean;
  resolutionPending: boolean;
  recoveryBlocked: boolean;
  onRetryBuild?(): void;
  onContinue?(): void;
  onAbandon?(): void;
  onKeepLocalChanges?(): void;
}) {
  const { t } = useI18n();
  const progress = props.progress;
  const registryReady = progress.state === "registry-ready";
  const blocked = progress.state === "blocked";
  const opaqueConflict = progress.phase === "remote_conflict";
  const needsRetry = progress.state === "needs-retry";
  const closed = progress.state === "closed";
  const buildFailure = progress.buildFailure ?? progress.blockedRelease?.buildFailure;
  const allowedActions = progress.blockedRelease?.allowedActions ?? progress.allowedActions;
  const retryAllowed = allowedActions.includes("retry_candidate") || allowedActions.includes("retry_build");
  const abandonAllowed = allowedActions.includes("abandon");
  const blockedMatchesCurrentRequest = progress.blockedRelease?.matchesCurrentRequest === true;
  const blockedFailed = progress.blockedRelease?.status === "trusted_build_failed";
  const nonRetryableFailure =
    !blocked && progress.remoteStatus === "trusted_build_failed" && !allowedActions.includes("retry_build")
      ? buildFailure
      : undefined;
  const retryBuild = progress.remoteStatus === "trusted_build_failed" && allowedActions.includes("retry_build");
  const retryBlocked = blocked && blockedMatchesCurrentRequest && retryAllowed;
  const showRetryAction = (retryBuild || retryBlocked) && Boolean(props.onRetryBuild);
  const showAbandonAction = abandonAllowed && Boolean(props.onAbandon);
  const abandoning = props.abandonPending === true;
  const visibleStage = releaseVisibleStage(progress);
  const Icon = blocked || needsRetry || closed ? XCircle : registryReady ? CheckCircle2 : History;
  const ProgressIcon = (props.pending && !needsRetry) || abandoning ? LoaderCircle : Icon;
  const title = abandoning
    ? t("appStore.release.abandonPublishPendingTitle")
    : opaqueConflict
      ? t("appStore.release.progressOpaqueConflictTitle")
      : nonRetryableFailure
        ? t("appStore.release.progressNeedsFixTitle")
        : blocked
          ? t("appStore.release.progressBlockedTitle")
          : needsRetry
            ? t("appStore.release.progressNeedsRetryTitle")
            : closed
              ? t("appStore.release.progressClosedTitle")
              : registryReady
                ? t("appStore.release.progressStage.local-finalization.title")
                : t(`appStore.release.progressStage.${visibleStage}.title`);
  const detail = abandoning
    ? t("appStore.release.abandonPublishPendingDesc")
    : opaqueConflict
      ? t("appStore.release.progressOpaqueConflictDesc")
      : nonRetryableFailure
        ? t("appStore.release.progressNeedsFixDesc", {
            version: progress.blockedRelease?.version ?? progress.version,
            stage: nonRetryableFailure.stage,
            code: nonRetryableFailure.code,
          })
        : blocked
          ? t(
              !blockedMatchesCurrentRequest
                ? abandonAllowed
                  ? "appStore.release.progressBlockedDifferentEndableDesc"
                  : "appStore.release.progressBlockedDifferentDesc"
                : blockedFailed
                  ? "appStore.release.progressBlockedFailedDesc"
                  : abandonAllowed
                    ? "appStore.release.progressBlockedExpiredDesc"
                    : "appStore.release.progressBlockedDesc",
              {
                version: progress.blockedRelease?.version ?? progress.version,
              },
            )
          : needsRetry
            ? t("appStore.release.progressNeedsRetryDesc", { version: progress.version })
            : closed
              ? t("appStore.release.progressClosedDesc", { version: progress.version })
              : registryReady
                ? t("appStore.release.progressStage.local-finalization.desc", { version: progress.version })
                : t(`appStore.release.progressStage.${visibleStage}.desc`, { version: progress.version });
  return (
    <div className="app-store-publish-progress" data-state={progress.state} role="status">
      <ProgressIcon
        className={(props.pending && !needsRetry) || abandoning ? "app-store-publish-spinner" : undefined}
        size={18}
      />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
        {blocked && progress.blockedRelease ? (
          <small>
            {t("appStore.release.progressBlockedReference", {
              id: progress.blockedRelease.id,
              status: progress.blockedRelease.status,
              requestId: progress.blockedRelease.requestId ?? "-",
            })}
          </small>
        ) : null}
        {opaqueConflict && progress.requestId ? (
          <small>{t("appStore.release.progressOpaqueConflictReference", { requestId: progress.requestId })}</small>
        ) : null}
        {buildFailure ? (
          <small>
            {t("appStore.release.progressBuildFailureReference", {
              runId: buildFailure.workflowRunId,
            })}
          </small>
        ) : null}
        {!props.canPublish ? <small>{t("appStore.release.progressAdminRecoveryHint")}</small> : null}
      </div>
      {props.canPublish && (showRetryAction || showAbandonAction) ? (
        <div className="app-store-publish-progress-actions">
          {showRetryAction && props.onRetryBuild ? (
            <button className="og-button" type="button" disabled={props.pending} onClick={props.onRetryBuild}>
              {props.pending ? <LoaderCircle className="app-store-publish-spinner" size={14} /> : null}
              <span>{t(blocked ? "appStore.release.retryBlockedRelease" : "appStore.release.retryBuild")}</span>
            </button>
          ) : null}
          {showAbandonAction && props.onAbandon ? (
            <button
              className="og-button og-button--danger"
              type="button"
              disabled={props.pending}
              onClick={props.onAbandon}
            >
              {abandoning ? <LoaderCircle className="app-store-publish-spinner" size={14} /> : null}
              <span>
                {abandoning
                  ? t("appStore.release.abandonPublishPendingTitle")
                  : t(blocked ? "appStore.release.abandonBlockedRelease" : "appStore.release.abandonPublish")}
              </span>
            </button>
          ) : null}
        </div>
      ) : props.canPublish && opaqueConflict && props.onContinue ? (
        <button className="og-button" type="button" disabled={props.pending} onClick={props.onContinue}>
          {props.pending ? <LoaderCircle className="app-store-publish-spinner" size={14} /> : null}
          <span>{t("appStore.release.recheckAndContinueOpaqueConflict")}</span>
        </button>
      ) : props.canPublish && props.recoveryPaused && props.onContinue ? (
        <button className="og-button" type="button" disabled={props.pending} onClick={props.onContinue}>
          {props.pending ? <LoaderCircle className="app-store-publish-spinner" size={14} /> : null}
          <span>{t("appStore.release.resumePublish")}</span>
        </button>
      ) : props.canPublish && registryReady && props.recoveryBlocked && props.onKeepLocalChanges ? (
        <button
          className="og-button"
          type="button"
          disabled={props.resolutionPending}
          onClick={props.onKeepLocalChanges}
        >
          {props.resolutionPending ? <LoaderCircle className="app-store-publish-spinner" size={14} /> : null}
          <span>{t("appStore.release.keepLocalChanges")}</span>
        </button>
      ) : null}
    </div>
  );
}

function PublishSection(props: { title: string; description?: string; compact?: boolean; children: ReactNode }) {
  return (
    <section className="app-store-publish-section" data-compact={props.compact ? "true" : "false"}>
      <div className="app-store-publish-section-heading">
        <h2>{props.title}</h2>
        {props.description ? <p>{props.description}</p> : null}
      </div>
      {props.children}
    </section>
  );
}

function PublishField(props: {
  label: string;
  hint?: string;
  required?: boolean;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="app-store-publish-field" data-layout={props.stacked ? "stacked" : "default"}>
      <span className="app-store-publish-field-label">
        <span>
          {props.label}
          {props.required ? <em> *</em> : null}
        </span>
        {props.hint ? <small>{props.hint}</small> : null}
      </span>
      <span className="app-store-publish-field-control">{props.children}</span>
    </label>
  );
}

function ReadOnlyValue(props: { label: string; value: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd title={props.value}>{props.value}</dd>
    </div>
  );
}

function ReleaseCheck(props: { check: AppReleaseCheck; repairPending?: boolean; onRepair?(): void }) {
  const { t } = useI18n();
  const { check } = props;
  const translated = translatedCheck(t, check);
  const Icon = check.status === "passed" ? CheckCircle2 : check.status === "blocked" ? XCircle : AlertTriangle;
  return (
    <div className="app-store-publish-check" data-status={check.status}>
      <Icon size={16} />
      <div>
        <strong>{translated.label}</strong>
        <p>{translated.detail}</p>
        {check.id === "trusted-build-contract" && check.detail === "build_contract_missing" && props.onRepair ? (
          <button className="og-button" type="button" disabled={props.repairPending} onClick={props.onRepair}>
            {props.repairPending
              ? t("appStore.release.buildContractRepairing")
              : t("appStore.release.buildContractRepair")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
