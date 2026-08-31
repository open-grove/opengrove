import { useEffect, useMemo, useState } from "react";
import type { ClientUpdateResponse } from "../../bridge";
import { readDesktopApi, type OpenGroveDesktopClientUpdateState } from "../../desktop-api";
import { rawDiagnosticText, useI18n } from "../../i18n";
import { useConfirm } from "../ui/confirm-dialog";
import { ProductIcon } from "../ui/product-icon";

declare const __OPENGROVE_PACKAGE_VERSION__: string | undefined;

export function SettingsUpdatePanel(props: {
  clientUpdate?: ClientUpdateResponse;
  loading?: boolean;
  error?: string;
  onCheckClientUpdate?(): Promise<void> | void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const desktop = readDesktopApi();
  const [autoDownload, setAutoDownload] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [updateState, setUpdateState] = useState<OpenGroveDesktopClientUpdateState>();
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let disposed = false;
    const applyState = (state: OpenGroveDesktopClientUpdateState) => {
      if (disposed) return;
      setUpdateState(state);
      setAutoDownload(state.autoDownload);
    };
    void desktop
      ?.getClientUpdateState?.()
      .then((state) => {
        applyState(state);
      })
      .catch(() => undefined);
    const unsubscribe = desktop?.onClientUpdateStateChange?.(applyState);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [desktop]);

  const currentVersion = useMemo(() => {
    const appVersion = desktop?.versions?.app || updateState?.currentVersion || readPackageVersion();
    return semanticVersionLabel(appVersion) || "—";
  }, [desktop?.versions?.app, updateState?.currentVersion]);

  const latest = props.clientUpdate?.latest;
  const metadataUpdateAvailable = Boolean(
    latest && typeof props.clientUpdate?.current === "number" && latest.version > props.clientUpdate.current,
  );
  const updateAvailable = metadataUpdateAvailable || updateState?.updateAvailable === true;
  const latestSemver = semanticVersionLabel(updateState?.latestVersion);
  const latestLabel = latestSemver || (latest ? t("settings.updateReleaseNumber", { version: latest.version }) : "");
  const releaseNotes = latest?.releaseNotes?.trim() || t("settings.updateReleaseNotesFallback");
  const updateStateError = updateState?.stage === "error" ? updateState.details || updateState.message : "";

  const checkForUpdates = async () => {
    setChecking(true);
    setActionError("");
    try {
      if (desktop?.checkForClientUpdate) {
        const state = await desktop.checkForClientUpdate();
        setUpdateState(state);
        if (state.stage === "error") {
          throw new Error(state.details || state.message);
        }
      }
      await props.onCheckClientUpdate?.();
      setChecked(true);
    } catch (error) {
      setChecked(false);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };

  const downloadUpdate = async () => {
    setActionError("");
    if (desktop?.installClientUpdate && updateState?.stage === "downloaded") {
      const confirmed = await confirm({
        title: t("confirm.installClientUpdateTitle"),
        body: t("confirm.restartInterruptsBody"),
        confirmLabel: t("common.install"),
      });
      if (!confirmed) return;
      setChecking(true);
      try {
        setUpdateState(await desktop.installClientUpdate());
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setChecking(false);
      }
      return;
    }
    if (desktop?.checkForClientUpdate) {
      setChecking(true);
      try {
        let state = updateState;
        if (!state?.updateAvailable || state.stage === "idle" || state.stage === "up-to-date") {
          state = await desktop.checkForClientUpdate();
          setUpdateState(state);
        }
        if (state.stage === "available" && state.updaterBaseUrl && desktop.downloadClientUpdate) {
          setUpdateState(await desktop.downloadClientUpdate());
          return;
        }
        if (state.stage === "downloading" || state.stage === "downloaded") return;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setChecking(false);
      }
    }
    if (latest?.downloadUrl) window.open(latest.downloadUrl, "_blank", "noopener,noreferrer");
  };

  const setAutomaticDownload = async () => {
    const next = !autoDownload;
    setActionError("");
    if (!desktop?.setClientUpdateAutoDownload) return;
    try {
      const state = await desktop.setClientUpdateAutoDownload(next);
      setUpdateState(state);
      setAutoDownload(state.autoDownload);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const actionLabel =
    updateState?.stage === "downloaded"
      ? t("settings.updateInstall")
      : updateState?.stage === "downloading"
        ? t("settings.updateDownloading", { percent: updateState.downloadProgress ?? 0 })
        : checking
          ? t("settings.updateChecking")
          : t("settings.updateDownload");

  return (
    <div className="settings-page-stack settings-update-page">
      {updateAvailable ? (
        <section className="settings-update-available-card" aria-label={t("settings.updateAvailableTitle")}>
          <div className="settings-update-available-header">
            <span className="settings-update-app-icon" aria-hidden="true">
              <ProductIcon name="download" size={22} />
            </span>
            <span className="settings-update-release-copy">
              <strong>{t("settings.updateAvailableTitle")}</strong>
              <small>{latestLabel}</small>
            </span>
            <button
              className="settings-row-button"
              type="button"
              disabled={checking || props.loading || updateState?.stage === "downloading"}
              onClick={() => void downloadUpdate()}
            >
              {actionLabel}
            </button>
          </div>
          <p>{releaseNotes}</p>
          <small className="settings-update-source-note">{t("settings.updateNotesFromService")}</small>
        </section>
      ) : null}

      <section className="settings-list-section">
        <div className="settings-list">
          <div className="settings-list-row settings-update-status-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.updateInstalled")}</strong>
            </span>
            <span className="settings-desktop-metric-value">{currentVersion}</span>
          </div>
          <div className="settings-list-row settings-desktop-action-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.updateCheck")}</strong>
              <small>{t("settings.updateCheckCopy")}</small>
            </span>
            <span className="settings-update-check-control">
              {checked && !updateAvailable && !checking && !props.loading ? (
                <small className="settings-update-check-result">{t("settings.updateUpToDate")}</small>
              ) : null}
              <button
                className="settings-row-button"
                type="button"
                disabled={checking || props.loading}
                onClick={() => void checkForUpdates()}
              >
                {checking || props.loading ? t("settings.updateChecking") : t("settings.updateCheck")}
              </button>
            </span>
          </div>
        </div>
      </section>

      {desktop?.setClientUpdateAutoDownload && updateState?.supported ? (
        <section className="settings-list-section">
          <div className="settings-list-section-heading">
            <h2>{t("settings.updateAutomatic")}</h2>
          </div>
          <div className="settings-list">
            <div className="settings-list-row settings-update-auto-row">
              <span className="settings-list-row-main">
                <strong>{t("settings.updateAutoDownload")}</strong>
                <small>{t("settings.updateAutoDownloadCopy")}</small>
              </span>
              <button
                className={
                  autoDownload
                    ? "settings-provider-enable-button settings-mode-switch-button enabled"
                    : "settings-provider-enable-button settings-mode-switch-button"
                }
                type="button"
                role="switch"
                aria-checked={autoDownload}
                aria-label={t("settings.updateAutoDownload")}
                onClick={() => void setAutomaticDownload()}
              >
                <span aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {props.error ? <p className="settings-warning">{rawDiagnosticText(props.error)}</p> : null}
      {updateStateError ? <p className="settings-warning">{rawDiagnosticText(updateStateError)}</p> : null}
      {actionError ? <p className="settings-warning">{rawDiagnosticText(actionError)}</p> : null}
    </div>
  );
}

function semanticVersionLabel(value: string | undefined): string {
  const normalized = value?.replace(/^v/, "").trim() ?? "";
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(normalized) ? normalized : "";
}

function readPackageVersion(): string {
  const metaVersion =
    typeof document === "undefined"
      ? ""
      : (document.querySelector<HTMLMetaElement>('meta[name="opengrove-package-version"]')?.content.trim() ?? "");
  if (metaVersion && metaVersion !== "dev") return metaVersion;
  return typeof __OPENGROVE_PACKAGE_VERSION__ === "string" ? __OPENGROVE_PACKAGE_VERSION__ : "";
}
