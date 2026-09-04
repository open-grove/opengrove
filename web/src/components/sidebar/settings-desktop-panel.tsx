import { useEffect, useState } from "react";
import { downloadBridgeFileWithMetadata, getJson, postJson } from "../../bridge";
import { apiUrl } from "../../api-base";
import { readDesktopApi, type OpenGroveDesktopDiagnostics } from "../../desktop-api";
import { getHostVersion, type HostVersion } from "../../host-version";
import { rawDiagnosticText, useI18n, type TranslationFn } from "../../i18n";
import { useConfirm } from "../ui/confirm-dialog";
import { ProductIcon } from "../ui/product-icon";
import {
  parseSettingsStorageCleanupResponse,
  parseSettingsStorageHistoryResponse,
  parseSettingsStorageMaintenanceEndResponse,
  parseSettingsStorageMaintenanceStartResponse,
  parseSettingsStorageResponse,
  settingsStorageCategoryIds,
  settingsStorageCategoryBytes,
  settingsStorageTotalBytes,
  type SettingsStorageCleanupEstimates,
  type SettingsStorageCategoryId,
  type SettingsStorageOverview,
} from "./settings-storage-model";

declare const __OPENGROVE_PACKAGE_VERSION__: string | undefined;

const WEB_PACKAGE_VERSION = readWebPackageVersion();
const HOST_VERSION_REFRESH_INTERVAL_MS = 10_000;

export function SettingsDesktopPanel() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const desktop = readDesktopApi();
  const [diagnostics, setDiagnostics] = useState<OpenGroveDesktopDiagnostics | undefined>();
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedFileName, setExportedFileName] = useState("");
  const [exportedEvidenceComplete, setExportedEvidenceComplete] = useState<boolean | undefined>();
  const [error, setError] = useState("");
  const [storageOverview, setStorageOverview] = useState<SettingsStorageOverview>();
  const [storageCleanupEstimates, setStorageCleanupEstimates] = useState<SettingsStorageCleanupEstimates>();
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [storageNotice, setStorageNotice] = useState("");
  const [hostVersion, setHostVersion] = useState<HostVersion>();
  const [page, setPage] = useState<"overview" | "storage">("overview");

  const refresh = async () => {
    if (!desktop?.diagnostics) return;
    setError("");
    try {
      setDiagnostics(await desktop.diagnostics());
    } catch (innerError) {
      setError(innerError instanceof Error ? innerError.message : String(innerError));
    }
  };

  useEffect(() => {
    void refresh();
    void refreshStorage();
    let disposed = false;
    let requestInFlight = false;
    const refreshHostVersion = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const next = await getHostVersion();
        if (!disposed) setHostVersion(next);
      } catch {
        // non-critical-fallback: A failed optional version probe renders no Host version.
        if (!disposed) setHostVersion(undefined);
      } finally {
        requestInFlight = false;
      }
    };
    void refreshHostVersion();
    if (desktop) {
      return () => {
        disposed = true;
      };
    }
    const interval = window.setInterval(() => void refreshHostVersion(), HOST_VERSION_REFRESH_INTERVAL_MS);
    const refreshWhenVisible = () => {
      if (!document.hidden) void refreshHostVersion();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [desktop]);

  const runtime = runtimeSummary(desktop, diagnostics, hostVersion);

  async function refreshStorage() {
    setStorageLoading(true);
    setStorageError("");
    try {
      const response = parseSettingsStorageResponse(await getJson<unknown>("/settings/storage"));
      setStorageOverview(response.overview);
      setStorageCleanupEstimates(response.cleanupEstimates);
    } catch {
      // non-critical-fallback: keep any last successful snapshot visible and offer a plain-language retry state.
      setStorageError(t("settings.storageLoadError"));
    } finally {
      setStorageLoading(false);
    }
  }

  async function clearStorageHistory(scope: "migration-backups") {
    if (
      (await confirm({
        title: t("confirm.clearMigrationBackupsTitle"),
        body: t("confirm.clearMigrationBackupsBody"),
        confirmLabel: t("common.confirm"),
        danger: true,
      })) !== "primary"
    )
      return;
    setStorageBusy(true);
    setStorageError("");
    setStorageNotice("");
    try {
      const response = parseSettingsStorageHistoryResponse(
        await postJson<unknown>("/settings/storage/clear-history", { scope }),
      );
      setStorageNotice(t("settings.storageMigrationBackupsDeleted", { size: formatBytes(response.reclaimedBytes) }));
      await refreshStorage();
    } catch {
      // non-critical-fallback: the backup remains intact and the user can retry without losing the storage snapshot.
      setStorageError(t("settings.storageBackupDeleteError"));
    } finally {
      setStorageBusy(false);
    }
  }

  async function safeCleanupStorage() {
    if (
      (await confirm({
        title: t("confirm.safeStorageCleanupTitle"),
        body: t("confirm.safeStorageCleanupBody"),
        confirmLabel: t("common.confirm"),
        danger: true,
      })) !== "primary"
    )
      return;
    setStorageBusy(true);
    setStorageError("");
    setStorageNotice("");
    try {
      if (desktop?.cleanupRebuildableStorage) {
        const result = await desktop.cleanupRebuildableStorage();
        setStorageNotice(storageCleanupNotice(result.reclaimedBytes, t, result.updaterCacheSkipped));
      } else {
        const { leaseId } = parseSettingsStorageMaintenanceStartResponse(
          await postJson<unknown>("/settings/storage/maintenance/start", {}),
        );
        let cleanupFailed = false;
        try {
          const unreferenced = parseSettingsStorageCleanupResponse(
            await postJson<unknown>("/settings/storage/cleanup", { leaseId }),
          );
          const rebuildable = parseSettingsStorageHistoryResponse(
            await postJson<unknown>("/settings/storage/clear-history", { scope: "rebuildable-caches", leaseId }),
          );
          setStorageNotice(storageCleanupNotice(unreferenced.reclaimedBytes + rebuildable.reclaimedBytes, t));
        } catch (error) {
          cleanupFailed = true;
          throw error;
        } finally {
          try {
            parseSettingsStorageMaintenanceEndResponse(
              await postJson<unknown>("/settings/storage/maintenance/end", { leaseId }),
            );
          } catch (error) {
            if (!cleanupFailed) throw error;
          }
        }
      }
      await refreshStorage();
    } catch (innerError) {
      setStorageError(storageCleanupError(innerError, t));
    } finally {
      setStorageBusy(false);
    }
  }

  const exportDiagnostics = async () => {
    setExporting(true);
    setExportedFileName("");
    setExportedEvidenceComplete(undefined);
    setError("");
    try {
      const result = await downloadBridgeFileWithMetadata(
        apiUrl("/diagnostics/bundle"),
        "OpenGrove-system-forensics.zip",
      );
      setExportedFileName(result.fileName);
      setExportedEvidenceComplete(result.evidenceComplete);
    } catch (innerError) {
      setError(
        t("settings.desktopExportFailed", {
          error: innerError instanceof Error ? innerError.message : String(innerError),
        }),
      );
    } finally {
      setExporting(false);
    }
  };

  if (page === "storage") {
    return (
      <div className="settings-page-stack">
        <StoragePanel
          overview={storageOverview}
          cleanupEstimates={storageCleanupEstimates}
          loading={storageLoading}
          busy={storageBusy}
          error={storageError}
          notice={storageNotice}
          onBack={() => setPage("overview")}
          onRefresh={refreshStorage}
          onCleanup={safeCleanupStorage}
          onClearHistory={clearStorageHistory}
        />
      </div>
    );
  }

  if (!desktop) {
    return (
      <div className="settings-page-stack">
        <section className="settings-list-section">
          <div className="settings-list-section-heading">
            <h2>{t("settings.desktopApp")}</h2>
          </div>
          <div className="settings-list">
            <DesktopInfoRow label={t("settings.webFrontendVersion")} value={formatVersion(WEB_PACKAGE_VERSION)} />
            <DesktopInfoRow label={t("settings.webServiceVersion")} value={runtime.version} />
            <DesktopInfoRow
              label={t("settings.webServiceStatus")}
              value={runtime.running ? t("settings.desktopRunningOk") : t("settings.desktopNeedsAttention")}
            />
            <DesktopInfoRow label={t("settings.webServiceStartedAt")} value={formatDateTime(runtime.startedAt)} />
          </div>
          <p className="settings-help">{t("settings.desktopNotDesktopCopy")}</p>
          <div className="settings-form-actions">
            <button type="button" onClick={exportDiagnostics} disabled={exporting}>
              {exporting ? t("settings.desktopExporting") : t("settings.desktopExportDiagnostics")}
            </button>
          </div>
          {error ? <p className="settings-warning">{rawDiagnosticText(error)}</p> : null}
          {exportedFileName ? (
            <p className="settings-success">{t("settings.desktopExported", { fileName: exportedFileName })}</p>
          ) : null}
          {exportedEvidenceComplete === false ? (
            <p className="settings-warning">{t("settings.desktopExportIncomplete")}</p>
          ) : null}
        </section>
        <StorageEntry loading={storageLoading} overview={storageOverview} onOpen={() => setPage("storage")} />
      </div>
    );
  }

  const restartBridge = async () => {
    if (!desktop.restartBridge) return;
    setBusy(true);
    setError("");
    try {
      setDiagnostics(await desktop.restartBridge());
    } catch (innerError) {
      setError(innerError instanceof Error ? innerError.message : String(innerError));
    } finally {
      setBusy(false);
    }
  };

  const resetData = async () => {
    if (!desktop.resetData) return;
    const confirmed = await confirm({
      title: t("confirm.resetDesktopDataTitle"),
      body: t("confirm.resetDesktopDataBody"),
      confirmLabel: t("common.confirm"),
      danger: true,
    });
    if (confirmed !== "primary") return;
    setBusy(true);
    setError("");
    try {
      await desktop.resetData();
      await refresh();
    } catch (innerError) {
      setError(innerError instanceof Error ? innerError.message : String(innerError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-page-stack">
      <section className="settings-list-section">
        <div className="settings-list-section-heading">
          <h2>{t("settings.desktopApp")}</h2>
        </div>
        <div className="settings-list settings-desktop-list">
          <div className="settings-list-row settings-update-status-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.webServiceStatus")}</strong>
            </span>
            <span className="settings-desktop-metric-value">
              {diagnostics
                ? runtime.running
                  ? t("settings.desktopRunningOk")
                  : t("settings.desktopNeedsAttention")
                : "—"}
            </span>
          </div>
          <DesktopActionRow
            label={t("settings.desktopRestartBridge")}
            description={t("settings.desktopRestartBridgeCopy")}
            actionLabel={t("settings.desktopRestartBridge")}
            disabled={busy || !desktop.restartBridge}
            onAction={restartBridge}
          />
          <DesktopActionRow
            label={t("settings.desktopOpenDataDir")}
            description={t("settings.desktopOpenDataDirCopy")}
            actionLabel={t("settings.desktopOpenDataDir")}
            disabled={busy || !desktop.openDataDir}
            onAction={() => void desktop.openDataDir?.()}
          />
          <DesktopActionRow
            label={t("settings.desktopExportDiagnostics")}
            description={t("settings.desktopExportDiagnosticsCopy")}
            actionLabel={exporting ? t("settings.desktopExporting") : t("settings.desktopExportDiagnostics")}
            disabled={busy || exporting}
            onAction={exportDiagnostics}
          />
        </div>
        {error ? <p className="settings-warning">{rawDiagnosticText(error)}</p> : null}
        {exportedFileName ? (
          <p className="settings-success">{t("settings.desktopExported", { fileName: exportedFileName })}</p>
        ) : null}
        {exportedEvidenceComplete === false ? (
          <p className="settings-warning">{t("settings.desktopExportIncomplete")}</p>
        ) : null}
      </section>

      <StorageEntry loading={storageLoading} overview={storageOverview} onOpen={() => setPage("storage")} />

      <section className="settings-list-section">
        <div className="settings-list-section-heading">
          <h2>{t("settings.desktopResetData")}</h2>
        </div>
        <div className="settings-list">
          <DesktopActionRow
            label={t("settings.desktopResetData")}
            description={t("settings.desktopResetDataCopy")}
            actionLabel={t("settings.desktopResetData")}
            tone="danger"
            disabled={busy || !desktop.resetData}
            onAction={resetData}
          />
        </div>
      </section>
    </div>
  );
}

// ===== Runtime summary =====

type RuntimeSummary = {
  running: boolean;
  version: string;
  startedAt?: string;
};

function runtimeSummary(
  desktop: ReturnType<typeof readDesktopApi>,
  diagnostics: OpenGroveDesktopDiagnostics | undefined,
  hostVersion: HostVersion | undefined,
): RuntimeSummary {
  if (desktop) {
    return {
      running: diagnostics?.status === "running",
      version: formatVersion(hostVersion?.packageVersion ?? ""),
    };
  }
  return {
    running: hostVersion?.available === true,
    version: formatVersion(hostVersion?.packageVersion ?? ""),
    startedAt: hostVersion?.startedAt,
  };
}

// ===== Storage management =====

function StoragePanel(props: {
  overview?: SettingsStorageOverview;
  cleanupEstimates?: SettingsStorageCleanupEstimates;
  loading: boolean;
  busy: boolean;
  error: string;
  notice: string;
  onBack(): void;
  onRefresh(): Promise<void>;
  onCleanup(): Promise<void>;
  onClearHistory(scope: "migration-backups"): Promise<void>;
}) {
  const { t } = useI18n();
  const visibleStorageCategoryIds = settingsStorageCategoryIds.filter(
    (id) => id !== "backups" || (props.cleanupEstimates?.migrationBackupBytes ?? 0) > 0,
  );
  const storageSegments = visibleStorageCategoryIds.map((id) => ({
    label: storageOverviewCategoryLabel(id, t),
    bytes: settingsStorageCategoryBytes(props.overview, id),
  }));
  const totalBytes = settingsStorageTotalBytes(props.overview);
  return (
    <section className="settings-list-section settings-storage-detail">
      <div className="settings-list-section-heading settings-storage-detail-heading">
        <span className="settings-storage-detail-title">
          <button className="settings-storage-back" type="button" onClick={props.onBack} aria-label={t("common.back")}>
            <ProductIcon name="back" size={18} />
          </button>
          <h2>{t("settings.storageSpaceTitle")}</h2>
        </span>
        <button
          className="settings-section-action"
          type="button"
          disabled={props.busy || props.loading}
          onClick={() => void props.onRefresh()}
        >
          {t("settings.storageRefreshStats")}
        </button>
      </div>
      <p className="settings-help">{t("settings.localStorageCopy")}</p>
      {!props.overview ? (
        <div className="settings-storage-summary">
          <strong>{props.loading ? t("settings.storageLoading") : t("settings.storageUnavailable")}</strong>
          {!props.loading && props.error ? <p className="settings-help">{props.error}</p> : null}
        </div>
      ) : (
        <>
          <div className="settings-storage-summary">
            <div className="settings-storage-total">
              <strong>{t("settings.storageTotalUsed")}</strong>
              <span>{formatBytes(totalBytes)}</span>
            </div>
            <div className="settings-storage-bar" aria-hidden="true">
              {storageSegments.map((segment) => (
                <span
                  key={segment.label}
                  style={{ width: `${totalBytes ? (segment.bytes / totalBytes) * 100 : 0}%` }}
                />
              ))}
            </div>
            <div className="settings-storage-legend">
              {storageSegments.map((segment) => (
                <span key={segment.label}>
                  <i aria-hidden="true" />
                  {segment.label}
                </span>
              ))}
            </div>
          </div>
          <div className="settings-storage-grid">
            {visibleStorageCategoryIds.map((id) => (
              <StorageCard
                key={id}
                label={storageOverviewCategoryLabel(id, t)}
                description={storageOverviewCategoryDescription(id, t, props.overview)}
                value={formatBytes(settingsStorageCategoryBytes(props.overview, id))}
              />
            ))}
          </div>
          <div className="settings-storage-subheading">{t("settings.storageMaintenance")}</div>
          <div className="settings-list settings-storage-list">
            <DesktopActionRow
              label={t("settings.storageSafeCleanup")}
              description={`${t("settings.storageSafeCleanupCopy")} ${t("settings.storageCleanupEstimateMaximum", {
                size: formatBytes(props.cleanupEstimates?.safeCleanupBytes ?? 0),
              })}`}
              actionLabel={props.busy ? t("settings.storageCleaning") : t("settings.storageSafeCleanup")}
              disabled={props.busy || !(props.cleanupEstimates?.safeCleanupBytes ?? 0)}
              onAction={() => void props.onCleanup()}
            />
            {(props.cleanupEstimates?.migrationBackupBytes ?? 0) > 0 ? (
              <DesktopActionRow
                label={t("settings.storageMigrationBackups")}
                description={`${t("settings.storageMigrationBackupsCopy")} ${backupKindSummary(props.overview, t)}`}
                actionLabel={t("settings.storageDeleteMigrationBackups")}
                tone="danger"
                disabled={props.busy}
                onAction={() => void props.onClearHistory("migration-backups")}
              />
            ) : null}
          </div>
        </>
      )}
      {props.overview && props.error ? <p className="settings-warning">{props.error}</p> : null}
      {props.notice ? <p className="settings-success">{props.notice}</p> : null}
    </section>
  );
}

function StorageEntry(props: { loading: boolean; overview?: SettingsStorageOverview; onOpen(): void }) {
  const { t } = useI18n();
  const totalBytes = settingsStorageTotalBytes(props.overview);
  return (
    <section className="settings-list-section settings-storage-entry-section">
      <button className="settings-storage-entry" type="button" onClick={props.onOpen}>
        <strong>{t("settings.storageSpaceTitle")}</strong>
        <span className="settings-storage-entry-meta">
          <span>{props.overview ? formatBytes(totalBytes) : props.loading ? "…" : "—"}</span>
          <ProductIcon name="next" size={17} />
        </span>
      </button>
    </section>
  );
}

function StorageCard(props: { label: string; description?: string; value: string }) {
  return (
    <div className="settings-storage-card">
      <span className="settings-storage-card-copy">
        <strong>{props.label}</strong>
        <span>{props.value}</span>
        {props.description ? <small>{props.description}</small> : null}
      </span>
    </div>
  );
}

function storageOverviewCategoryLabel(id: SettingsStorageCategoryId, t: TranslationFn): string {
  if (id === "works-and-files") return t("settings.storageCategoryWorksAndFiles");
  if (id === "apps-and-runtime") return t("settings.storageCategoryAppsAndRuntime");
  if (id === "rebuildable") return t("settings.storageCategoryRebuildable");
  if (id === "backups") return t("settings.storageCategoryBackups");
  return t("settings.storageCategoryConversationsAndSystem");
}

function storageOverviewCategoryDescription(
  id: SettingsStorageCategoryId,
  t: TranslationFn,
  overview?: SettingsStorageOverview,
): string {
  if (id === "works-and-files") return t("settings.storageCategoryWorksAndFilesCopy");
  if (id === "apps-and-runtime") return t("settings.storageCategoryAppsAndRuntimeCopy");
  if (id === "rebuildable") return t("settings.storageCategoryRebuildableCopy");
  if (id === "backups") {
    const migrationBackups = overview?.backups.filter((backup) => backup.kind === "migration") ?? [];
    const latest = migrationBackups[0];
    if (!latest) return t("settings.storageCategoryBackupsCopy");
    return `${t("settings.storageCategoryBackupsCopy")} ${t("settings.storageBackupSummary", {
      count: migrationBackups.length,
      time: formatDateTime(latest.createdAt),
    })}`;
  }
  return t("settings.storageCategoryConversationsAndSystemCopy");
}

function backupKindSummary(overview: SettingsStorageOverview | undefined, t: TranslationFn): string {
  const backups = overview?.backups.filter((backup) => backup.kind === "migration") ?? [];
  const latest = backups[0];
  if (!latest) return t("settings.storageBackupNone");
  return t("settings.storageBackupSummary", {
    count: backups.length,
    time: formatDateTime(latest.createdAt),
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

function storageCleanupNotice(
  reclaimedBytes: number | undefined,
  t: TranslationFn,
  updaterCacheSkipped = false,
): string {
  if (updaterCacheSkipped) {
    return t("settings.storageCleanupFreedUpdaterSkipped", { size: formatBytes(reclaimedBytes ?? 0) });
  }
  return reclaimedBytes && reclaimedBytes > 0
    ? t("settings.storageCleanupFreed", { size: formatBytes(reclaimedBytes) })
    : t("settings.storageCleanupCompleted");
}

function storageCleanupError(error: unknown, t: TranslationFn): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("desktop_storage_maintenance_active_runs:")) {
    return t("settings.storageCleanupErrorActiveRuns");
  }
  if (message === "rebuildable_cleanup_reused_bridge_unsupported") {
    return t("settings.storageCleanupErrorReusedBridge");
  }
  if (message === "desktop_storage_maintenance_in_progress") return t("settings.storageCleanupErrorInProgress");
  if (message.startsWith("rebuildable_cleanup_and_restart_failed:")) {
    return t("settings.storageCleanupErrorRestart");
  }
  return t("settings.storageCleanupErrorGeneric", { error: message });
}

// ===== Desktop presentation helpers =====

function formatDateTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatVersion(value: string): string {
  return value ? `v${value}` : "—";
}

function readWebPackageVersion(): string {
  const metaVersion =
    typeof document === "undefined"
      ? ""
      : (document.querySelector<HTMLMetaElement>('meta[name="opengrove-package-version"]')?.content.trim() ?? "");
  if (metaVersion && metaVersion !== "dev") return metaVersion;
  return typeof __OPENGROVE_PACKAGE_VERSION__ === "string" ? __OPENGROVE_PACKAGE_VERSION__ : "";
}

function DesktopInfoRow(props: { label: string; value: string }) {
  return (
    <div className="settings-list-row">
      <span className="settings-list-row-main">
        <strong>{props.label}</strong>
      </span>
      <span className="settings-desktop-metric-value">{props.value || "—"}</span>
    </div>
  );
}

function DesktopActionRow(props: {
  label: string;
  description: string;
  actionLabel: string;
  disabled?: boolean;
  tone?: "default" | "danger";
  onAction(): void | Promise<void>;
}) {
  return (
    <div className="settings-list-row settings-desktop-action-row">
      <span className="settings-list-row-main">
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
      <button
        className={props.tone === "danger" ? "settings-row-button danger" : "settings-row-button"}
        type="button"
        disabled={props.disabled}
        onClick={() => void props.onAction()}
      >
        {props.actionLabel}
      </button>
    </div>
  );
}
