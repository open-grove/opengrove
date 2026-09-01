import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Check, CircleStop, Clock3, LoaderCircle, MonitorDown, Save } from "lucide-react";
import { BridgeRequestError, getMountedAppVersions, switchMountedAppVersion } from "../../bridge";
import type { AppStoreFormalVersion, MountedAppVersionStatus } from "../../bridge";
import { useI18n } from "../../i18n";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { appStoreQueryKeys } from "./app-store-query";

type VersionTarget =
  | {
      kind: "formal";
      version: string;
      archiveSha256: string;
    }
  | {
      kind: "local-draft";
    };

type SwitchBlocker = {
  kind: "unsaved" | "active-runs";
  target: VersionTarget;
  options: SwitchOptions;
};

type SwitchOptions = {
  discardUnsavedChanges?: boolean;
  forceStop?: boolean;
};

export function AppVersionManagementPage(props: {
  app: { id: string; title: string };
  onBack(): void;
  onOpenSaveAndPublish(): void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [blocker, setBlocker] = useState<SwitchBlocker | null>(null);
  const [switchError, setSwitchError] = useState("");
  const versionsQuery = useQuery({
    queryKey: appStoreQueryKeys.versions(props.app.id),
    queryFn: () => getMountedAppVersions(props.app.id),
  });
  const status = versionsQuery.data?.status;
  const switchMutation = useMutation({
    mutationFn: (input: { target: VersionTarget; discardUnsavedChanges?: boolean; forceStop?: boolean }) =>
      switchMountedAppVersion(props.app.id, input.target, input),
    onSuccess(result) {
      setBlocker(null);
      setSwitchError("");
      queryClient.setQueryData(appStoreQueryKeys.versions(props.app.id), {
        ...versionsQuery.data,
        ok: true,
        status: result.status,
      });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
      void queryClient.invalidateQueries({ queryKey: appStoreQueryKeys.all });
    },
    onError(error, input) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "app_version_unsaved_changes") {
        setBlocker({
          kind: "unsaved",
          target: input.target,
          options: {
            discardUnsavedChanges: input.discardUnsavedChanges,
            forceStop: input.forceStop,
          },
        });
        setSwitchError("");
        return;
      }
      if (message === "app_version_active_runs") {
        setBlocker({
          kind: "active-runs",
          target: input.target,
          options: {
            discardUnsavedChanges: input.discardUnsavedChanges,
            forceStop: input.forceStop,
          },
        });
        setSwitchError("");
        return;
      }
      setBlocker(null);
      setSwitchError(formatVersionError(error, t));
    },
  });

  function requestSwitch(target: VersionTarget, options: SwitchOptions = {}) {
    setSwitchError("");
    switchMutation.mutate({ target, ...options });
  }

  return (
    <section className="app-store-version-page" aria-label={t("appStore.version.titleAria", { name: props.app.title })}>
      <header className="app-store-publish-header">
        <div className="app-store-publish-header-title">
          <button
            type="button"
            className="app-store-publish-back"
            onClick={props.onBack}
            aria-label={t("appStore.version.backAria")}
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1>{t("appStore.version.title")}</h1>
            <p>{props.app.title}</p>
          </div>
        </div>
      </header>

      {blocker ? (
        <VersionSwitchBlocker
          kind={blocker.kind}
          pending={switchMutation.isPending}
          onSave={() => {
            setBlocker(null);
            props.onOpenSaveAndPublish();
          }}
          onContinue={() =>
            requestSwitch(
              blocker.target,
              blocker.kind === "unsaved"
                ? { ...blocker.options, discardUnsavedChanges: true }
                : { ...blocker.options, forceStop: true },
            )
          }
          onCancel={() => setBlocker(null)}
        />
      ) : null}

      {switchError ? (
        <div className="app-store-version-alert" data-tone="error" role="alert">
          <AlertTriangle size={18} />
          <span>{switchError}</span>
        </div>
      ) : null}

      {versionsQuery.isPending ? (
        <div className="app-store-publish-state">
          <LoaderCircle className="app-store-publish-spinner" size={22} />
          <p>{t("appStore.version.loading")}</p>
        </div>
      ) : versionsQuery.isError || !status ? (
        <div className="app-store-publish-state app-store-publish-state--error">
          <AlertTriangle size={22} />
          <p>{formatVersionError(versionsQuery.error, t)}</p>
          <button type="button" className="og-button" onClick={() => void versionsQuery.refetch()}>
            {t("common.retry")}
          </button>
        </div>
      ) : (
        <div className="app-store-version-content">
          <VersionOverview status={status} />

          {versionsQuery.data?.registryError ? (
            <div className="app-store-version-alert" data-tone="warning" role="status">
              <AlertTriangle size={18} />
              <span>{t("appStore.version.registryUnavailable")}</span>
            </div>
          ) : null}

          <section className="app-store-publish-section">
            <div className="app-store-publish-section-heading">
              <h2>{t("appStore.version.localDraft")}</h2>
              <p>{t("appStore.version.localDraftDesc")}</p>
            </div>
            {status.localDraft ? (
              <div className="app-store-version-draft-row">
                <div>
                  <strong>
                    {status.activeContent === "local-draft"
                      ? t("appStore.version.runningDraft")
                      : t("appStore.version.savedDraft")}
                  </strong>
                  <small>
                    {t("appStore.version.savedAt", {
                      time: formatVersionDate(status.localDraft.savedAt),
                    })}
                    {status.localDraft.publishBase?.version
                      ? t("appStore.version.detailSuffix", {
                          value: t("appStore.version.basedOn", {
                            version: status.localDraft.publishBase.version,
                          }),
                        })
                      : ""}
                  </small>
                </div>
                {status.activeContent === "local-draft" ? (
                  <span className="app-store-version-status-badge" data-tone="active">
                    <Check size={14} />
                    {t("appStore.version.running")}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="og-button"
                    disabled={switchMutation.isPending}
                    onClick={() => requestSwitch({ kind: "local-draft" })}
                  >
                    {switchMutation.isPending ? (
                      <LoaderCircle className="app-store-publish-spinner" size={15} />
                    ) : (
                      <MonitorDown size={15} />
                    )}
                    {t("appStore.version.openDraft")}
                  </button>
                )}
              </div>
            ) : (
              <p className="app-store-version-empty">{t("appStore.version.noDraft")}</p>
            )}
          </section>

          <section className="app-store-publish-section">
            <div className="app-store-publish-section-heading">
              <h2>{t("appStore.version.formalVersions")}</h2>
              <p>{t("appStore.version.formalVersionsDesc")}</p>
            </div>
            <div className="app-store-version-list">
              {status.versions.map((version) => (
                <FormalVersionRow
                  key={`${version.version}:${version.archiveSha256}`}
                  version={version}
                  status={status}
                  pending={switchMutation.isPending}
                  onSwitch={() =>
                    requestSwitch({
                      kind: "formal",
                      version: version.version,
                      archiveSha256: version.archiveSha256,
                    })
                  }
                />
              ))}
              {!status.versions.length ? (
                <p className="app-store-version-empty">{t("appStore.version.noFormalVersions")}</p>
              ) : null}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function VersionOverview(props: { status: MountedAppVersionStatus }) {
  const { t } = useI18n();
  const selected = props.status.selectedVersion?.version;
  const hasUnsavedSourceChanges =
    props.status.sourceStatusError !== undefined
      ? true
      : props.status.sourceChangedFileCount === undefined
        ? props.status.hasUnsavedChanges
        : props.status.sourceChangedFileCount > 0;
  return (
    <section className="app-store-version-overview" aria-label={t("appStore.version.overview")}>
      <VersionOverviewItem
        label={t("appStore.version.runningContent")}
        value={
          props.status.activeContent === "local-draft"
            ? t("appStore.version.myDraft")
            : selected
              ? `v${selected}`
              : t("appStore.version.unknown")
        }
      />
      <VersionOverviewItem
        label={t("appStore.version.selectedVersion")}
        value={selected ? `v${selected}` : t("appStore.version.none")}
      />
      <VersionOverviewItem
        label={t("appStore.version.latestVersion")}
        value={props.status.latestVersion ? `v${props.status.latestVersion.version}` : t("appStore.version.none")}
      />
      <VersionOverviewItem
        label={t("appStore.version.localChanges")}
        value={
          props.status.sourceStatusError
            ? t("appStore.version.sourceNeedsAttention", {
                path: props.status.sourceStatusPath ?? t("appStore.version.unknownSourcePath"),
              })
            : hasUnsavedSourceChanges
              ? t("appStore.version.unsaved")
              : props.status.sourceSavePoint
                ? t("appStore.version.sourceSavedAt", {
                    time: formatVersionDate(props.status.sourceSavePoint.savedAt),
                  })
                : t("appStore.version.saved")
        }
        tone={hasUnsavedSourceChanges ? "warning" : "success"}
      />
    </section>
  );
}

function VersionOverviewItem(props: { label: string; value: string; tone?: "warning" | "success" }) {
  return (
    <div className="app-store-version-overview-item" data-tone={props.tone ?? "neutral"}>
      <small>{props.label}</small>
      <strong>{props.value}</strong>
    </div>
  );
}

function FormalVersionRow(props: {
  version: AppStoreFormalVersion;
  status: MountedAppVersionStatus;
  pending: boolean;
  onSwitch(): void;
}) {
  const { t } = useI18n();
  const selected =
    props.status.selectedVersion?.version === props.version.version &&
    props.status.selectedVersion.archiveSha256 === props.version.archiveSha256;
  const running = selected && props.status.activeContent === "formal";
  const unavailable = props.version.availability !== "available";
  return (
    <article className="app-store-version-row" data-selected={selected ? "true" : "false"}>
      <div className="app-store-version-row-main">
        <strong>{t("appStore.version.versionValue", { version: props.version.version })}</strong>
        <div className="app-store-version-badges">
          {running ? (
            <span className="app-store-version-status-badge" data-tone="active">
              <Check size={14} />
              {t("appStore.version.running")}
            </span>
          ) : selected ? (
            <span className="app-store-version-status-badge">{t("appStore.version.selected")}</span>
          ) : props.version.availability === "host_incompatible" ? (
            <span className="app-store-version-status-badge" data-tone="warning">
              {t("appStore.version.hostUpdateRequired")}
            </span>
          ) : props.version.availability === "artifact_unavailable" ? (
            <span className="app-store-version-status-badge" data-tone="warning">
              {t("appStore.version.artifactUnavailable")}
            </span>
          ) : null}
        </div>
        <small>
          <Clock3 size={13} />
          {formatVersionDate(props.version.publishedAt)}
          {props.version.publishedBy ? t("appStore.version.detailSuffix", { value: props.version.publishedBy }) : ""}
        </small>
        {props.version.releaseNotes ? <p>{props.version.releaseNotes}</p> : null}
        {props.version.availability === "host_incompatible" &&
        typeof props.version.minHostReleaseNumber === "number" ? (
          <p>
            {t("appStore.version.minHostReleaseRequired", {
              releaseNumber: props.version.minHostReleaseNumber,
            })}
          </p>
        ) : null}
      </div>
      {!running ? (
        <button type="button" className="og-button" disabled={props.pending || unavailable} onClick={props.onSwitch}>
          {props.pending ? <LoaderCircle className="app-store-publish-spinner" size={15} /> : <MonitorDown size={15} />}
          {t("appStore.version.switch")}
        </button>
      ) : null}
    </article>
  );
}

function VersionSwitchBlocker(props: {
  kind: SwitchBlocker["kind"];
  pending: boolean;
  onSave(): void;
  onContinue(): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent className="app-store-version-blocker" aria-describedby="app-store-version-blocker-body">
        <div>
          <AlertTriangle size={20} />
          <div>
            <DialogTitle>
              {props.kind === "unsaved" ? t("appStore.version.unsavedTitle") : t("appStore.version.activeRunsTitle")}
            </DialogTitle>
            <p id="app-store-version-blocker-body">
              {props.kind === "unsaved" ? t("appStore.version.unsavedBody") : t("appStore.version.activeRunsBody")}
            </p>
          </div>
        </div>
        <div className="app-store-version-blocker-actions">
          {props.kind === "unsaved" ? (
            <button type="button" className="og-button" disabled={props.pending} onClick={props.onSave}>
              <Save size={15} />
              {t("appStore.version.goSave")}
            </button>
          ) : null}
          <button
            type="button"
            className="og-button og-button--danger"
            disabled={props.pending}
            onClick={props.onContinue}
          >
            {props.pending ? (
              <LoaderCircle className="app-store-publish-spinner" size={15} />
            ) : (
              <CircleStop size={15} />
            )}
            {props.kind === "unsaved"
              ? t("appStore.version.discardAndSwitch")
              : t("appStore.version.forceStopAndSwitch")}
          </button>
          <button type="button" className="og-button" disabled={props.pending} onClick={props.onCancel}>
            {t("common.cancel")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatVersionDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function formatVersionError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message === "app_version_run_stop_unconfirmed") return t("appStore.version.stopFailed");
  if (message === "app_store_archive_checksum_mismatch") return t("appStore.version.checksumFailed");
  if (message === "app_store_host_update_required") return t("appStore.version.hostUpdateRequired");
  if (message === "app_store_version_artifact_unavailable") return t("appStore.version.artifactUnavailable");
  if (error instanceof BridgeRequestError && error.traceId) {
    return `${t("appStore.version.switchFailed")} (${error.traceId})`;
  }
  return message || t("appStore.version.switchFailed");
}
