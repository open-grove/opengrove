import { useEffect, useMemo, useRef, useState, type ForwardRefExoticComponent, type RefAttributes } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpenText,
  Check,
  FileArchive,
  FileText,
  Globe2,
  Package,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sprout,
  Upload,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  ArrowClockwiseIcon,
  BookOpenTextIcon,
  CheckIcon,
  FileArchiveIcon,
  FileTextIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PackageIcon,
  PlantIcon,
  PlusIcon,
  ShieldCheckIcon,
  StorefrontIcon,
  UploadSimpleIcon,
  UserIcon,
  WarningIcon,
  XIcon,
  type IconProps as PhosphorIconProps,
} from "@phosphor-icons/react";
import type {
  AppStoreInstallResponse,
  AppStorePackageRecord,
  AppStorePackageVisibility,
  BridgeAuthUser,
  BridgeSettings,
  RuntimeControls,
  SkillRecord,
} from "../../bridge";
import {
  BridgeRequestError,
  getAppStoreCatalog,
  installAppStorePackage,
  publishRegistryAppStorePackage,
  relinkAppStorePackage,
  repairAppStorePackage,
} from "../../bridge";
import { compareLocalizedText } from "../../format";
import {
  formatAppStoreInstallError,
  resolveAppStorePackageAction,
  type AppStorePackageActionKind,
} from "./app-store-action";
import {
  LIVE_APP_STORE_CATALOG_SOURCE,
  appStoreQueryKeys,
  resolveAppStoreCatalogQueryPolicy,
  resolveAppStoreSaveAndPublishPolicy,
  type AppStoreCatalogSource,
} from "./app-store-query";
import { rawDiagnosticText, translate, useI18n, type TranslationFn } from "../../i18n";
import { localeForLanguage } from "../../locale";
import { useConfirm } from "../ui/confirm-dialog";
import { RoomMemberAvatar } from "../rooms/member-avatar";
import { AppIdentityIcon, AppIdentityIconTile } from "../ui/grove-app-icon";
import { ObjectSettingsRow, ObjectSettingsSection, ProductStatus } from "../ui/object-settings";
import { MotionPopover } from "../ui/motion/popover";
import { AppStorePublishPage } from "./app-store-publish-page";
import { AppVersionManagementPage } from "./app-version-management-page";
import "./app-store-view.css";
import "./app-store-error.css";

type AppStoreIconSystem = "lucide" | "phosphor-grove";
type AppStoreSystemIconName =
  | "archive"
  | "check"
  | "document"
  | "folder"
  | "globe"
  | "package"
  | "plus"
  | "refresh"
  | "search"
  | "seed"
  | "shield"
  | "store"
  | "upload"
  | "user"
  | "warning"
  | "x";

const LUCIDE_SYSTEM_ICONS = {
  archive: FileArchive,
  check: Check,
  document: FileText,
  folder: BookOpenText,
  globe: Globe2,
  package: Package,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  seed: Sprout,
  shield: ShieldCheck,
  store: Package,
  upload: Upload,
  user: UserRound,
  warning: AlertTriangle,
  x: X,
} satisfies Record<AppStoreSystemIconName, LucideIcon>;

const PHOSPHOR_SYSTEM_ICONS = {
  archive: FileArchiveIcon,
  check: CheckIcon,
  document: FileTextIcon,
  folder: BookOpenTextIcon,
  globe: GlobeIcon,
  package: PackageIcon,
  plus: PlusIcon,
  refresh: ArrowClockwiseIcon,
  search: MagnifyingGlassIcon,
  seed: PlantIcon,
  shield: ShieldCheckIcon,
  store: StorefrontIcon,
  upload: UploadSimpleIcon,
  user: UserIcon,
  warning: WarningIcon,
  x: XIcon,
} satisfies Record<AppStoreSystemIconName, ForwardRefExoticComponent<PhosphorIconProps & RefAttributes<SVGSVGElement>>>;

export function AppStoreView(props: {
  presentation?: "default" | "grove";
  iconSystem?: AppStoreIconSystem;
  settings?: BridgeSettings;
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  skills?: SkillRecord[];
  authUser?: BridgeAuthUser;
  catalogSource?: AppStoreCatalogSource;
  onOpenInstalledApp?(appId: string): void;
  versionManagementAppId?: string;
  onCloseVersionManagement?(): void;
  onPublishDirtyChange?(dirty: boolean): void;
}) {
  const { t } = useI18n();
  const iconSystem = props.iconSystem ?? "phosphor-grove";
  const grovePresentation = props.presentation === "grove";
  const confirm = useConfirm();
  const [installMessage, setInstallMessage] = useState("");
  const [installMessageTone, setInstallMessageTone] = useState<AppStoreMessageTone>("success");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<AppStoreKindFilter>("all");
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);
  const [publishMenuOpen, setPublishMenuOpen] = useState(false);
  const [publishVisibility, setPublishVisibility] = useState<AppStorePackageVisibility>("restricted");
  const [publishTarget, setPublishTarget] = useState<AppStorePublishTarget | null>(null);
  const [mountedAppPublishPage, setMountedAppPublishPage] = useState<{ id: string; title: string } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();
  const savedRegistryUrl = props.settings?.appStore?.registryUrl ?? "";
  const savedRegistryToken = props.settings?.appStore?.registryToken ?? "";
  const settingsRegistryConfigured = Boolean(savedRegistryUrl.trim() && savedRegistryToken.trim());
  const userIsAdmin = props.authUser?.role === "admin" || props.authUser?.roles?.includes("admin") === true;
  const developerMode = props.settings?.developerMode === true;
  const catalogSource = props.catalogSource ?? LIVE_APP_STORE_CATALOG_SOURCE;
  const catalogQueryPolicy = resolveAppStoreCatalogQueryPolicy(catalogSource);

  const catalogQuery = useQuery({
    queryKey: appStoreQueryKeys.catalog({
      userId: props.authUser?.userId,
      registryUrl: savedRegistryUrl,
      registryConfigured: settingsRegistryConfigured,
    }),
    queryFn: () => getAppStoreCatalog(),
    ...catalogQueryPolicy,
  });
  const catalog = catalogSource.kind === "static" ? catalogSource.data : catalogQuery.data;
  const catalogLoading = !catalog && catalogQuery.isPending;
  const catalogRegistryConfigured = catalog?.registryConfigured === true;
  const registryConfigured = catalogLoading || settingsRegistryConfigured || catalogRegistryConfigured;
  const registryDisplayUrl = savedRegistryUrl.trim() || t("appStore.builtinRegistryName");
  const publishMutation = useMutation({
    mutationFn: (input: { file: File; visibility: AppStorePackageVisibility }) =>
      publishRegistryAppStorePackage(input.file, input.visibility),
    onSuccess(result, input) {
      void queryClient.invalidateQueries({ queryKey: appStoreQueryKeys.all });
      showInstallMessage(
        t("appStore.publishArchiveSuccess", {
          name: result.package?.title || input.file.name,
          visibility: packageVisibilityLabel(input.visibility, t),
        }),
      );
    },
    onError(error, input) {
      showInstallMessage(
        t("appStore.uploadFailed", {
          name: input.file.name,
          error: formatAppStoreInstallError(error instanceof Error ? error.message : String(error), t),
        }),
        "error",
      );
    },
  });
  const publishPending = publishMutation.isPending;
  const mountedApps = useMemo(
    () =>
      (props.settings?.mountedApps ?? [])
        .filter((app) => app.enabled !== false && app.path?.trim())
        .map((app) => ({ id: app.id, title: app.title?.trim() || app.id })),
    [props.settings?.mountedApps],
  );
  const saveAndPublishPolicy = resolveAppStoreSaveAndPublishPolicy({
    mountedAppCount: mountedApps.length,
    isAdmin: userIsAdmin,
  });
  const versionManagementApp = props.versionManagementAppId
    ? mountedApps.find((app) => app.id === props.versionManagementAppId)
    : undefined;
  const installMutation = useMutation<AppStoreInstallResponse, Error, AppStoreInstallMutationInput>({
    mutationFn: (input) =>
      installAppStorePackage({
        packageId: input.item.id,
        backupEnabled: true,
        cleanupUnverifiedRoot: input.cleanupUnverifiedRoot,
      }),
    onSuccess(result, input) {
      const item = input.item;
      const install = result.install;
      void queryClient.invalidateQueries({ queryKey: appStoreQueryKeys.all });
      if (install?.installMode === "contacts" || item.publishKind === "employee") {
        void queryClient.invalidateQueries({ queryKey: appStoreQueryKeys.all });
        showInstallMessage(t("appStore.installedToLocal", { name: item.title }));
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
      const shouldOpenWorkbench =
        install?.openable ?? (item.openable === undefined ? item.openIssue !== "ui_not_workbench" : item.openable);
      const opening = shouldOpenWorkbench ? t("appStore.openingWorkbenchSuffix") : "";
      const hint = configurationHint(item, t);
      showInstallMessage(
        install?.status === "already_installed"
          ? item.installState === "legacy_unknown"
            ? t("appStore.reinstalledMsg", { name: item.title, opening, hint })
            : item.updateAvailable
              ? t("appStore.updatedMsg", { name: item.title, opening, hint })
              : t("appStore.installedSimple", { name: item.title })
          : t("appStore.installedMsg", { name: item.title, opening, hint }),
      );
      const appId =
        install?.openableAppId ?? install?.mountedApp?.id ?? install?.appId ?? item.installedAppId ?? item.appId;
      if (shouldOpenWorkbench && appId) window.setTimeout(() => props.onOpenInstalledApp?.(appId), 120);
    },
    async onError(error, input) {
      const item = input.item;
      const message = error instanceof Error ? error.message : String(error);
      if (message === "app_store_cleanup_confirmation_required" && !input.cleanupUnverifiedRoot) {
        const confirmed = await confirm({
          title: t("appStore.cleanupResidueTitle", { title: item.title }),
          body: t("appStore.cleanupResidueBody"),
          confirmLabel: t("common.confirm"),
          danger: true,
        });
        if (confirmed === "primary") {
          showInstallMessage(t("appStore.cleaningAndInstalling", { name: item.title }), "info");
          installMutation.mutate({ item, cleanupUnverifiedRoot: true });
        }
        return;
      }
      const reference = error instanceof BridgeRequestError ? error.incidentId || error.traceId : undefined;
      showInstallMessage(
        t("appStore.installFailed", {
          name: item.title,
          error: formatAppStoreInstallError(message, t),
          reference: reference ? t("appStore.incidentReference", { reference }) : "",
        }),
        "error",
      );
    },
  });
  const repairMutation = useMutation({
    mutationFn: (item: AppStorePackageRecord) => repairAppStorePackage({ packageId: item.id }),
    onSuccess(result, item) {
      void queryClient.invalidateQueries({ queryKey: appStoreQueryKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
      const repairedAppId = result.repair?.openableAppId ?? result.repair?.appId ?? item.appId;
      if (result.repair?.openable) {
        showInstallMessage(t("appStore.repairedOpening", { name: item.title }));
        window.setTimeout(() => props.onOpenInstalledApp?.(repairedAppId), 120);
      } else {
        showInstallMessage(t("appStore.repairedFiles", { name: item.title }));
      }
    },
    onError(error, item) {
      const message = error instanceof Error ? error.message : String(error);
      const reference = error instanceof BridgeRequestError ? error.incidentId || error.traceId : undefined;
      showInstallMessage(
        t("appStore.repairFailed", {
          name: item.title,
          error: formatAppStoreInstallError(message, t),
          reference: reference ? t("appStore.incidentReference", { reference }) : "",
        }),
        "error",
      );
    },
  });
  const relinkMutation = useMutation({
    mutationFn: (item: AppStorePackageRecord) => relinkAppStorePackage({ packageId: item.id }),
    onSuccess(result, item) {
      void queryClient.invalidateQueries({ queryKey: appStoreQueryKeys.all });
      const relinkedAppId = result.relink?.openableAppId ?? result.relink?.mountedAppId ?? item.appId;
      if (result.relink?.openable) {
        showInstallMessage(
          result.relink.status === "already_linked"
            ? t("appStore.linkedOpening", { name: item.title })
            : t("appStore.relinkedOpening", { name: item.title }),
        );
        window.setTimeout(() => props.onOpenInstalledApp?.(relinkedAppId), 120);
      } else {
        showInstallMessage(
          result.relink?.status === "already_linked"
            ? t("appStore.linkedToPackage", { name: item.title })
            : t("appStore.relinkedToPackage", { name: item.title }),
        );
      }
    },
    onError(error, item) {
      const message = error instanceof Error ? error.message : String(error);
      const reference = error instanceof BridgeRequestError ? error.incidentId || error.traceId : undefined;
      showInstallMessage(
        t("appStore.relinkFailed", {
          name: item.title,
          error: formatAppStoreInstallError(message, t),
          reference: reference ? t("appStore.incidentReference", { reference }) : "",
        }),
        "error",
      );
    },
  });
  const packages = useMemo(
    () => (catalog?.packages ?? []).filter((item) => developerMode || (item.publishKind ?? "app") !== "employee"),
    [catalog?.packages, developerMode],
  );
  const effectiveKindFilter: AppStoreKindFilter = developerMode || kindFilter !== "employee" ? kindFilter : "all";
  const visiblePackages = useMemo(
    () => packages.filter((item) => packageMatchesFilters(item, query, effectiveKindFilter)).sort(comparePackages),
    [effectiveKindFilter, packages, query],
  );
  const selectedPackage = selectedPackageId ? (packages.find((item) => item.id === selectedPackageId) ?? null) : null;
  const displayedPackages = catalogLoading ? [] : visiblePackages;

  async function runPackageAction(item: AppStorePackageRecord) {
    if (catalogSource.kind === "static") return;
    const action = resolveAppStorePackageAction(item);
    if (action.kind === "conflict") {
      setSelectedPackageId(item.id);
      showInstallMessage(t("appStore.conflictWarning", { name: item.title }), "warning");
    } else if (action.kind === "host-update") {
      setSelectedPackageId(null);
      showInstallMessage(t("appStore.hostUpdateWarning", { name: item.title }), "warning");
    } else if (action.kind === "relink") {
      const confirmed = await confirm({
        title: t("appStore.relinkTitle", { title: item.title }),
        body: t("appStore.relinkBody", { title: item.title }),
        confirmLabel: t("common.confirm"),
      });
      if (confirmed === "primary") {
        setSelectedPackageId(null);
        showInstallMessage(t("appStore.relinking", { name: item.title }), "info");
        relinkMutation.mutate(item);
      }
    } else if (action.kind === "open") {
      props.onOpenInstalledApp?.(item.openableAppId ?? item.installedAppId ?? item.appId);
    } else if (action.kind === "repair") {
      const confirmed = await confirm({
        title: t("appStore.repairTitle", { title: item.title }),
        body: t("appStore.repairBody"),
        confirmLabel: t("common.confirm"),
      });
      if (confirmed === "primary") {
        setSelectedPackageId(null);
        showInstallMessage(t("appStore.repairing", { name: item.title }), "info");
        repairMutation.mutate(item);
      }
    } else if (action.kind === "inspect") {
      setSelectedPackageId(null);
      showInstallMessage(
        t("appStore.inspectWarning", { name: item.title, issue: formatAppOpenIssue(item, t) }),
        "warning",
      );
    } else if (action.kind === "reinstall") {
      const confirmed = await confirm({
        title: t("appStore.reinstallTitle", { title: item.title }),
        body: t("appStore.reinstallBody", { title: item.title }),
        confirmLabel: t("common.confirm"),
      });
      if (confirmed === "primary") {
        setSelectedPackageId(null);
        showInstallMessage(t("appStore.reinstalling", { name: item.title }), "info");
        installMutation.mutate({ item });
      }
    } else if (action.kind === "installed") {
      setSelectedPackageId(null);
      showInstallMessage(
        item.openIssue === "ui_not_workbench"
          ? t("appStore.installedNoWorkbench", { name: item.title })
          : t("appStore.installedToLocal", { name: item.title }),
        "info",
      );
    } else {
      setSelectedPackageId(null);
      showInstallMessage(
        action.kind === "update"
          ? t("appStore.updating", { name: item.title })
          : t("appStore.installing", { name: item.title }),
        "info",
      );
      installMutation.mutate({ item });
    }
  }

  function showInstallMessage(message: string, tone: AppStoreMessageTone = "success") {
    setInstallMessage(message);
    setInstallMessageTone(tone);
  }

  function uploadSelectedPackage(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!registryConfigured) {
      showInstallMessage(t("appStore.notConnectedWarning"), "warning");
      return;
    }
    setPublishVisibility("restricted");
    setPublishTarget({ kind: "archive", file });
    setPublishMenuOpen(true);
  }

  function publishMountedApp(app: { id: string; title: string }) {
    setPublishTarget(null);
    setPublishMenuOpen(false);
    setMountedAppPublishPage(app);
  }

  function confirmPublishTarget() {
    const target = publishTarget;
    if (!target) return;
    setPublishTarget(null);
    setPublishMenuOpen(false);
    showInstallMessage(
      t("appStore.uploadingArchive", {
        visibility: packageVisibilityLabel(publishVisibility, t),
        name: target.file.name,
      }),
      "info",
    );
    publishMutation.mutate({ file: target.file, visibility: publishVisibility });
  }

  useEffect(() => {
    if (!developerMode && kindFilter === "employee") {
      setKindFilter("all");
    }
  }, [developerMode, kindFilter]);

  if (versionManagementApp) {
    return (
      <section
        className="view-panel tab-view app-store-view"
        data-view="app-store"
        data-presentation={grovePresentation ? "grove" : "default"}
      >
        <div className="app-store-page app-store-page--publish">
          <AppVersionManagementPage
            app={versionManagementApp}
            onBack={() => props.onCloseVersionManagement?.()}
            onOpenSaveAndPublish={() => {
              props.onCloseVersionManagement?.();
              setMountedAppPublishPage(versionManagementApp);
            }}
          />
        </div>
      </section>
    );
  }

  if (mountedAppPublishPage) {
    return (
      <section
        className="view-panel tab-view app-store-view"
        data-view="app-store"
        data-presentation={grovePresentation ? "grove" : "default"}
      >
        <div className="app-store-page app-store-page--publish">
          <AppStorePublishPage
            app={mountedAppPublishPage}
            activeKernel={props.settings?.activeKernel}
            activeModel={props.settings?.activeModel}
            kernelOptions={props.settings?.kernels}
            providers={props.settings?.providers}
            modelProviderBindings={props.settings?.modelProviderBindings}
            runtimeControls={props.runtimeControls}
            runtimeControlsByKernel={props.runtimeControlsByKernel}
            skills={props.skills}
            canPublish={saveAndPublishPolicy.canFormalPublish}
            onDirtyChange={props.onPublishDirtyChange}
            onBack={() => setMountedAppPublishPage(null)}
            onPublished={(result) => {
              void queryClient.invalidateQueries({ queryKey: appStoreQueryKeys.all });
              showInstallMessage(
                t("appStore.publishMountedSuccess", {
                  name: result.title,
                  visibility: packageVisibilityLabel(result.visibility, t),
                }),
              );
              setMountedAppPublishPage(null);
            }}
          />
        </div>
      </section>
    );
  }

  return (
    <section
      className="view-panel tab-view app-store-view"
      data-view="app-store"
      data-presentation={grovePresentation ? "grove" : "default"}
    >
      <div className="app-store-page">
        <header className="app-store-title">
          <div>
            <h1>
              {grovePresentation ? (
                <span className="app-store-title-icon" aria-hidden="true">
                  <AppStoreSystemIcon system={iconSystem} name="store" size={24} emphasis="strong" />
                </span>
              ) : null}
              {t("app.appStore")}
              <span
                className={registryConfigured ? "app-store-title-status ready" : "app-store-title-status"}
                role="img"
                aria-label={registryConfigured ? t("workspace.kernelConnected") : t("appStore.notConnected")}
                title={
                  registryConfigured
                    ? t("appStore.connectedTitle", { url: registryDisplayUrl })
                    : t("appStore.notConnectedTitle")
                }
              />
            </h1>
          </div>
          {registryConfigured || saveAndPublishPolicy.showEntry ? (
            <div className="app-store-title-actions">
              {registryConfigured ? (
                <label className="app-store-search">
                  <AppStoreSystemIcon system={iconSystem} name="search" size={18} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={developerMode ? t("appStore.searchPlaceholderDev") : t("appStore.searchPlaceholder")}
                  />
                </label>
              ) : null}
              {saveAndPublishPolicy.showEntry ? (
                <>
                  {saveAndPublishPolicy.canUploadArchive ? (
                    <input
                      ref={uploadInputRef}
                      className="app-store-upload-input"
                      type="file"
                      accept=".tgz,.tar.gz,.tar,.zip,application/gzip,application/x-gzip,application/zip"
                      onChange={(event) => {
                        uploadSelectedPackage(event.currentTarget.files);
                        event.currentTarget.value = "";
                      }}
                    />
                  ) : null}
                  <div className="app-store-publish-menu-anchor">
                    <MotionPopover
                      open={publishMenuOpen}
                      onOpenChange={(open) => {
                        setPublishMenuOpen(open);
                        if (!open) setPublishTarget(null);
                      }}
                      side="bottom"
                      sideOffset={6}
                      align="end"
                      className="app-store-publish-menu"
                      role="dialog"
                      ariaLabel={publishTarget ? t("appStore.confirmPublish") : t("appStore.saveAndPublishMethod")}
                      trigger={
                        <button
                          className="og-button og-button--primary app-store-upload-button"
                          type="button"
                          disabled={publishPending}
                          aria-haspopup="dialog"
                          aria-expanded={publishMenuOpen}
                        >
                          <AppStoreSystemIcon
                            system={iconSystem}
                            name={publishPending ? "refresh" : "upload"}
                            size={15}
                            emphasis="strong"
                          />
                          <span>{publishPending ? t("contacts.publishing") : t("appStore.saveAndPublish")}</span>
                        </button>
                      }
                    >
                      {publishTarget ? (
                        <AppStorePublishConfirmPanel
                          target={publishTarget}
                          visibility={publishVisibility}
                          pending={publishPending}
                          iconSystem={iconSystem}
                          onVisibilityChange={setPublishVisibility}
                          onConfirm={confirmPublishTarget}
                          onBack={() => setPublishTarget(null)}
                        />
                      ) : (
                        <>
                          <div className="app-store-publish-menu-heading">{t("appStore.saveOrPublishMounted")}</div>
                          {mountedApps.length ? (
                            mountedApps.map((app) => (
                              <button
                                key={app.id}
                                type="button"
                                className="app-store-publish-menu-item"
                                onClick={() => publishMountedApp(app)}
                              >
                                <AppStoreSystemIcon system={iconSystem} name="package" size={14} />
                                <span>{app.title}</span>
                              </button>
                            ))
                          ) : (
                            <div className="app-store-publish-menu-empty">{t("appStore.noMountedApps")}</div>
                          )}
                          {saveAndPublishPolicy.canUploadArchive ? (
                            <>
                              <div className="app-store-publish-menu-divider" />
                              <button
                                type="button"
                                className="app-store-publish-menu-item"
                                onClick={() => {
                                  setPublishMenuOpen(false);
                                  uploadInputRef.current?.click();
                                }}
                              >
                                <AppStoreSystemIcon system={iconSystem} name="archive" size={14} />
                                <span>{t("appStore.uploadExistingArchive")}</span>
                              </button>
                            </>
                          ) : null}
                        </>
                      )}
                    </MotionPopover>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </header>

        {installMessage ? (
          <div className="app-store-install-message" data-tone={installMessageTone} role="status" aria-live="polite">
            {installMessage}
          </div>
        ) : null}

        {registryConfigured ? (
          <>
            {developerMode ? (
              <div className="app-store-controls" aria-label={t("appStore.filterAriaLabel")}>
                <div className="app-store-filter-tabs" role="tablist" aria-label={t("appStore.publishKindAriaLabel")}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={effectiveKindFilter === "all"}
                    data-active={effectiveKindFilter === "all" ? "true" : "false"}
                    onClick={() => setKindFilter("all")}
                  >
                    {t("appStore.filterAll")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={effectiveKindFilter === "app"}
                    data-active={effectiveKindFilter === "app" ? "true" : "false"}
                    onClick={() => setKindFilter("app")}
                  >
                    App
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={effectiveKindFilter === "employee"}
                    data-active={effectiveKindFilter === "employee" ? "true" : "false"}
                    onClick={() => setKindFilter("employee")}
                  >
                    {t("app.rooms")}
                  </button>
                </div>
              </div>
            ) : null}

            <section className="app-store-catalog" aria-label={t("appStore.catalogAriaLabel")}>
              <div className="app-store-catalog-grid">
                {displayedPackages.map((item) => (
                  <AppStorePackageCard
                    key={item.id}
                    item={item}
                    iconSystem={iconSystem}
                    grovePresentation={grovePresentation}
                    pending={installMutation.isPending || repairMutation.isPending || relinkMutation.isPending}
                    actionLabel={packageActionLabel(item, t)}
                    onAction={() => runPackageAction(item)}
                    onOpen={() => setSelectedPackageId(item.id)}
                  />
                ))}
              </div>
              {catalogLoading ? (
                <AppStoreCatalogLoadingState />
              ) : catalog?.registryCatalogError ? (
                <RegistryCatalogErrorState
                  error={catalog.registryCatalogError}
                  onRetry={() => {
                    if (catalogSource.kind === "live") void catalogQuery.refetch();
                  }}
                />
              ) : displayedPackages.length === 0 ? (
                <div className="app-store-empty">{t("appStore.noMatches")}</div>
              ) : null}
            </section>
          </>
        ) : (
          <div className="app-store-empty">{t("appStore.loginToView")}</div>
        )}
        {selectedPackage ? (
          <AppStorePackageDialog
            item={selectedPackage}
            iconSystem={iconSystem}
            grovePresentation={grovePresentation}
            pending={installMutation.isPending || repairMutation.isPending || relinkMutation.isPending}
            actionLabel={packageActionLabel(selectedPackage, t)}
            onAction={() => runPackageAction(selectedPackage)}
            onClose={() => setSelectedPackageId(null)}
          />
        ) : null}
      </div>
    </section>
  );
}

function AppStoreCatalogLoadingState() {
  const { t } = useI18n();
  return (
    <div
      className="app-store-catalog-grid app-store-catalog-loading"
      role="status"
      aria-label={t("mountedApp.loading")}
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <article className="og-card app-store-app-card" aria-hidden="true" key={index}>
          <div className="app-store-app-card-main">
            <span className="og-skeleton og-skeleton-line" style={{ width: index % 2 ? "48%" : "62%" }} />
            <span
              className="og-skeleton og-skeleton-line"
              style={{ width: index % 3 ? "82%" : "70%", marginTop: 10 }}
            />
          </div>
          <div className="app-store-package-footer">
            <span className="og-skeleton og-skeleton-line" style={{ width: "55%" }} />
            <span className="og-skeleton app-store-catalog-loading-action" />
          </div>
        </article>
      ))}
    </div>
  );
}

type AppStorePublishTarget = { kind: "archive"; file: File };

function AppStorePublishConfirmPanel(props: {
  target: AppStorePublishTarget;
  visibility: AppStorePackageVisibility;
  pending: boolean;
  iconSystem: AppStoreIconSystem;
  onVisibilityChange(value: AppStorePackageVisibility): void;
  onConfirm(): void;
  onBack(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="app-store-publish-confirm-panel">
      <div className="app-store-publish-confirm-heading">
        <span className="app-store-package-icon" aria-hidden="true">
          <AppStoreSystemIcon system={props.iconSystem} name="archive" size={18} />
        </span>
        <div>
          <h2>{t("appStore.uploadArchive")}</h2>
          <p>{props.target.file.name}</p>
        </div>
      </div>
      <div
        className="app-store-publish-visibility"
        role="radiogroup"
        aria-label={t("appStore.publishVisibilityAriaLabel")}
      >
        <button
          type="button"
          role="radio"
          aria-checked={props.visibility === "restricted"}
          data-active={props.visibility === "restricted" ? "true" : "false"}
          onClick={() => props.onVisibilityChange("restricted")}
        >
          <AppStoreSystemIcon system={props.iconSystem} name="shield" size={14} />
          <span>{t("appStore.visibilityRestricted")}</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={props.visibility === "public"}
          data-active={props.visibility === "public" ? "true" : "false"}
          onClick={() => props.onVisibilityChange("public")}
        >
          <AppStoreSystemIcon system={props.iconSystem} name="globe" size={14} />
          <span>{t("employee.visibilityPublic")}</span>
        </button>
      </div>
      <div className="app-store-publish-confirm-actions">
        <button className="og-button" type="button" disabled={props.pending} onClick={props.onBack}>
          {t("withdrawal.back")}
        </button>
        <button
          className="og-button og-button--primary"
          type="button"
          disabled={props.pending}
          onClick={props.onConfirm}
        >
          <AppStoreSystemIcon system={props.iconSystem} name="upload" size={15} emphasis="strong" />
          <span>{t("appStore.confirmPublish")}</span>
        </button>
      </div>
    </div>
  );
}

function AppStorePackageCard(props: {
  item: AppStorePackageRecord;
  iconSystem: AppStoreIconSystem;
  grovePresentation: boolean;
  pending: boolean;
  actionLabel: string;
  onAction(): void;
  onOpen(): void;
}) {
  const { t } = useI18n();
  const action = resolveAppStorePackageAction(props.item, t);
  const agentSummaries = props.item.agents?.length
    ? props.item.agents
    : props.item.employee
      ? [props.item.employee]
      : [];
  const isEmployee = (props.item.publishKind ?? "app") === "employee";
  const employee = props.item.employee ?? props.item.agents?.[0];
  return (
    <article
      className="og-card app-store-app-card"
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpen();
        }
      }}
    >
      {props.grovePresentation ? (
        <div className="app-store-app-card-main app-store-app-card-main--grove">
          {isEmployee && employee ? (
            <AppStoreEmployeeAvatar employee={employee} className="app-store-employee-card-avatar" />
          ) : (
            <AppIdentityIconTile
              className="app-store-grove-icon"
              aria-hidden="true"
              icon={props.item.icon}
              input={props.item}
              iconSize={42}
            />
          )}
          <span className="app-store-app-card-copy">
            <strong>{props.item.title}</strong>
            <small>{props.item.summary}</small>
          </span>
        </div>
      ) : (
        <div className="app-store-app-card-main">
          <strong>{props.item.title}</strong>
          <small>{props.item.summary}</small>
        </div>
      )}
      <div className="app-store-package-footer">
        <div className="app-store-package-context">
          {!isEmployee && agentSummaries.length ? <AppStoreAgentStack agents={agentSummaries} /> : null}
          <div className="app-store-package-owner" aria-label={t("appStore.ownerAriaLabel")}>
            <span>{props.item.publisher}</span>
            <span>v{props.item.version}</span>
          </div>
        </div>
        <button
          className="og-button og-button--primary app-store-package-action"
          type="button"
          disabled={props.pending}
          onClick={(event) => {
            event.stopPropagation();
            props.onAction();
          }}
          aria-label={`${props.actionLabel} ${props.item.title}`}
          title={props.actionLabel}
        >
          <AppStoreActionIcon system={props.iconSystem} kind={action.kind} size={15} />
          <span>{props.actionLabel}</span>
        </button>
      </div>
    </article>
  );
}

function AppStoreAgentStack(props: { agents: NonNullable<AppStorePackageRecord["agents"]>; limit?: number }) {
  const { language } = useI18n();
  const limit = props.limit ?? 3;
  const visible = props.agents.slice(0, limit);
  const remaining = Math.max(0, props.agents.length - visible.length);
  return (
    <span
      className="app-store-agent-stack"
      aria-label={new Intl.ListFormat(localeForLanguage(language), {
        style: "short",
        type: "conjunction",
      }).format(props.agents.map((agent) => agent.name))}
    >
      {visible.map((agent) => (
        <RoomMemberAvatar
          key={agent.id}
          member={{
            id: agent.id,
            name: agent.name,
            avatarMode: agent.avatarMode,
            avatarSeed: agent.avatarSeed,
            avatarDataUrl: agent.avatarDataUrl,
            status: "idle",
            color: "#64748b",
            source: "local",
          }}
          showStatus={false}
        />
      ))}
      {remaining ? <span className="app-store-agent-stack-more">+{remaining}</span> : null}
    </span>
  );
}

type AppStoreEmployeeSummary = NonNullable<AppStorePackageRecord["agents"]>[number];

function AppStoreEmployeeAvatar(props: { employee: AppStoreEmployeeSummary; className: string }) {
  return (
    <RoomMemberAvatar
      className={props.className}
      member={{
        id: props.employee.id,
        name: props.employee.name,
        avatarMode: props.employee.avatarMode,
        avatarSeed: props.employee.avatarSeed,
        avatarDataUrl: props.employee.avatarDataUrl,
        status: "idle",
        color: "#64748b",
        source: "local",
      }}
      showStatus={false}
    />
  );
}

function AppStorePackageDialog(props: {
  item: AppStorePackageRecord;
  iconSystem: AppStoreIconSystem;
  grovePresentation: boolean;
  pending: boolean;
  actionLabel: string;
  onAction(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const action = resolveAppStorePackageAction(props.item, t);
  const employee = props.item.employee ?? props.item.agents?.[0];
  const agentSummaries = props.item.agents?.length ? props.item.agents : employee ? [employee] : [];
  const dependencySkills = props.item.dependencies?.skills ?? [];
  const dependencyTools = props.item.dependencies?.tools ?? employee?.tools ?? [];
  const dependencyKernels = props.item.dependencies?.kernels ?? [];
  const dependencyRuntimes = props.item.dependencies?.runtimes ?? [];
  const requirementGroups = groupedRequirements(props.item.requirements, t);
  const isEmployee = (props.item.publishKind ?? "app") === "employee";
  return (
    <div className="app-store-dialog-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        className="app-store-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.item.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="app-store-dialog-close"
          type="button"
          onClick={props.onClose}
          aria-label={t("mountedApp.close")}
          title={t("mountedApp.close")}
        >
          <AppStoreSystemIcon system={props.iconSystem} name="x" size={28} />
        </button>
        <div className="app-store-dialog-heading">
          {isEmployee && employee ? (
            <AppStoreEmployeeAvatar employee={employee} className="app-store-dialog-employee-avatar" />
          ) : props.grovePresentation ? (
            <AppIdentityIconTile
              className="app-store-dialog-hero-icon"
              aria-hidden="true"
              icon={props.item.icon}
              input={props.item}
              iconSize={46}
            />
          ) : (
            <span className="app-store-package-icon app-store-dialog-hero-icon" aria-hidden="true">
              <AppStorePackageIcon
                item={props.item}
                system={props.iconSystem}
                size={42}
                useGroveIdentity={props.grovePresentation}
              />
            </span>
          )}
          <h2>{props.item.title}</h2>
          <p>
            <span>{props.item.publisher}</span>
            <span>v{props.item.version}</span>
          </p>
          {!isEmployee && agentSummaries.length ? <AppStoreAgentStack agents={agentSummaries} limit={4} /> : null}
        </div>
        <p className="app-store-dialog-summary">{props.item.summary}</p>
        <ObjectSettingsSection
          title={isEmployee ? t("appStore.employeeDetailsAriaLabel") : t("appStore.packageDetailsAriaLabel")}
          className="app-store-dialog-overview"
        >
          <ObjectSettingsRow
            title={t("appStore.typeLabel")}
            value={isEmployee ? t("appStore.employeePackage") : t("appStore.appPackage")}
          />
          {props.item.visibility ? (
            <ObjectSettingsRow
              title={t("contacts.visibility")}
              value={packageVisibilityLabel(props.item.visibility, t)}
            />
          ) : null}
          <ObjectSettingsRow
            title={props.item.packageKey ? t("appStore.packageKeyLabel") : t("appStore.packageIdLabel")}
            value={props.item.packageKey ?? props.item.id}
          />
          {props.item.openIssue ? (
            <ObjectSettingsRow
              title={t("appStore.localStateLabel")}
              value={<ProductStatus tone="warning" compact label={formatAppOpenIssue(props.item, t)} />}
            />
          ) : null}
          {props.item.updateAvailable && props.item.updateSafe === false ? (
            <ObjectSettingsRow title={t("appStore.updateMethodLabel")} value={t("appStore.updateMethodManual")} />
          ) : null}
          {employee?.kernel ? <ObjectSettingsRow title={t("appStore.kernelLabel")} value={employee.kernel} /> : null}
          {employee?.model ? <ObjectSettingsRow title={t("composer.model")} value={employee.model} /> : null}
          {dependencyKernels.length ? (
            <ObjectSettingsRow title={t("appStore.requiredKernelsLabel")} value={dependencyKernels.join(", ")} />
          ) : null}
          {dependencyRuntimes.length ? (
            <ObjectSettingsRow title={t("appStore.runtimesLabel")} value={dependencyRuntimes.join(", ")} />
          ) : null}
          <ObjectSettingsRow
            title={t("appStore.doctorLabel")}
            value={
              <ProductStatus
                tone={props.item.doctor?.ok === false ? "warning" : "success"}
                compact
                label={formatDoctorSummary(props.item, t)}
              />
            }
          />
          {employee?.role ? <ObjectSettingsRow title={t("appStore.roleLabel")} detail={employee.role} /> : null}
          {employee?.publicDescription ? (
            <ObjectSettingsRow title={t("appStore.publicDescriptionLabel")} detail={employee.publicDescription} />
          ) : null}
          {employee?.inputSpec ? (
            <ObjectSettingsRow title={t("appStore.inputSpecLabel")} detail={employee.inputSpec} />
          ) : null}
          {employee?.outputSpec ? (
            <ObjectSettingsRow title={t("appStore.outputSpecLabel")} detail={employee.outputSpec} />
          ) : null}
        </ObjectSettingsSection>
        {employee?.publicSkills?.length ? (
          <div className="app-store-dialog-chip-section" aria-label={t("appStore.publicSkills")}>
            <strong>{t("appStore.publicSkills")}</strong>
            <div>
              {employee.publicSkills.map((skill) => (
                <span key={skill}>{skill}</span>
              ))}
            </div>
          </div>
        ) : null}
        {requirementGroups.length ? (
          <div className="app-store-dialog-requirements" aria-label={t("appStore.postInstallConfig")}>
            <strong>{t("appStore.postInstallConfig")}</strong>
            {requirementGroups.map((group) => (
              <div key={group.kind}>
                <span>{group.label}</span>
                <div>
                  {group.items.map((item) => (
                    <code key={`${group.kind}-${item}`}>{item}</code>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {dependencySkills.length ? (
          <div className="app-store-dialog-chip-section" aria-label={t("appStore.includedSkillsAriaLabel")}>
            <strong>Skills</strong>
            <div>
              {dependencySkills.map((skill) => (
                <span key={skill.id}>{skill.title || skill.name || skill.id}</span>
              ))}
            </div>
          </div>
        ) : null}
        {dependencyTools.length ? (
          <div className="app-store-dialog-chip-section" aria-label={t("appStore.includedToolsAriaLabel")}>
            <strong>Tools</strong>
            <div>
              {dependencyTools.map((tool) => (
                <span key={tool.id}>{tool.title || tool.id}</span>
              ))}
            </div>
          </div>
        ) : null}
        {props.item.doctor?.items.length ? (
          <div className="app-store-dialog-doctor" aria-label={t("appStore.doctorDetailsAriaLabel")}>
            {props.item.doctor.items.map((item) => (
              <span key={`${item.kind}-${item.id}`} data-status={item.status}>
                {item.label}
              </span>
            ))}
          </div>
        ) : null}
        <button
          className="og-button og-button--primary app-store-dialog-action"
          type="button"
          disabled={props.pending}
          onClick={props.onAction}
        >
          <AppStoreActionIcon system={props.iconSystem} kind={action.kind} size={action.kind === "install" ? 24 : 22} />
          <span>{props.actionLabel}</span>
        </button>
      </section>
    </div>
  );
}

function AppStorePackageIcon(props: {
  item: AppStorePackageRecord;
  system: AppStoreIconSystem;
  size: number;
  useGroveIdentity: boolean;
}) {
  if (props.useGroveIdentity && props.system === "phosphor-grove" && (props.item.publishKind ?? "app") !== "employee") {
    return <AppIdentityIcon icon={props.item.icon} input={props.item} size={props.size} aria-hidden="true" />;
  }
  if (props.useGroveIdentity && props.system === "phosphor-grove") {
    return <AppStoreSystemIcon system={props.system} name="user" size={props.size} />;
  }
  const Icon = appStorePackageIcon(props.item);
  return <Icon size={props.size} />;
}

function AppStoreActionIcon(props: { system: AppStoreIconSystem; kind: AppStorePackageActionKind; size: number }) {
  if (props.kind === "inspect" || props.kind === "conflict" || props.kind === "host-update") {
    return <AppStoreSystemIcon system={props.system} name="warning" size={props.size} emphasis="strong" />;
  }
  if (props.kind === "repair" || props.kind === "update" || props.kind === "reinstall" || props.kind === "relink") {
    return <AppStoreSystemIcon system={props.system} name="refresh" size={props.size} emphasis="strong" />;
  }
  if (props.kind === "install") {
    return <AppStoreSystemIcon system={props.system} name="plus" size={props.size} emphasis="strong" />;
  }
  return <AppStoreSystemIcon system={props.system} name="check" size={props.size} emphasis="strong" />;
}

function appStorePackageIcon(item: AppStorePackageRecord): LucideIcon {
  if ((item.publishKind ?? "app") === "employee") return UserRound;

  const icon = normalizedIconName(item.icon);
  if (icon === "seed") return Sprout;
  if (icon === "library" || icon === "document") return FileText;
  if (icon === "folder") return BookOpenText;

  if (item.appId === "story-seed" || item.packageKey === "opengrove.story-seed" || item.title.includes("故事种子")) {
    return Sprout;
  }
  return BookOpenText;
}

function AppStoreSystemIcon(props: {
  system: AppStoreIconSystem;
  name: AppStoreSystemIconName;
  size: number;
  emphasis?: "regular" | "strong";
}) {
  if (props.system === "phosphor-grove") {
    const Icon = PHOSPHOR_SYSTEM_ICONS[props.name];
    return <Icon size={props.size} weight={props.emphasis === "strong" ? "bold" : "regular"} aria-hidden="true" />;
  }
  const Icon = LUCIDE_SYSTEM_ICONS[props.name];
  return <Icon size={props.size} aria-hidden="true" />;
}

function normalizedIconName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

type AppStoreKindFilter = "all" | "app" | "employee";

type AppStoreInstallMutationInput = {
  item: AppStorePackageRecord;
  cleanupUnverifiedRoot?: boolean;
};

function RegistryCatalogErrorState(props: { error: string; onRetry(): void }) {
  const { t } = useI18n();
  return (
    <div className="app-store-empty app-store-registry-error">
      <AlertTriangle size={18} aria-hidden />
      <strong>{describeRegistryCatalogError(props.error, t)}</strong>
      <div className="app-store-registry-error-actions">
        <button type="button" onClick={props.onRetry}>
          <RefreshCw size={13} aria-hidden />
          {t("appStore.registryError.retry")}
        </button>
      </div>
      <details className="app-store-registry-error-details">
        <summary>{t("appStore.registryError.details")}</summary>
        <code>{rawDiagnosticText(props.error)}</code>
      </details>
    </div>
  );
}

function describeRegistryCatalogError(error: string, t: TranslationFn): string {
  if (/^registry_request_failed/.test(error)) return t("appStore.registryError.unreachable");
  if (/timeout|timed_out|econnrefused|enotfound|network|fetch failed/i.test(error))
    return t("appStore.registryError.timeout");
  if (/not_authenticated|unauthorized|forbidden|admin_required/.test(error))
    return t("appStore.registryError.unauthorized");
  if (error === "registry_not_configured") return t("appStore.registryError.notConfigured");
  return t("appStore.registryError.generic");
}

function packageVisibilityLabel(value: AppStorePackageVisibility, t: TranslationFn = translate): string {
  return value === "public" ? t("employee.visibilityPublic") : t("appStore.visibilityRestricted");
}

function packageActionLabel(item: AppStorePackageRecord, t: TranslationFn = translate): string {
  return resolveAppStorePackageAction(item, t).label;
}

function formatAppOpenIssue(item: AppStorePackageRecord, t: TranslationFn = translate): string {
  if (item.openIssue === "store_relink_required") return t("appStore.issueStoreRelinkRequired");
  if (item.openIssue === "source_conflict") return t("appStore.issueSourceConflict");
  if (item.openIssue === "install_evidence_missing") return t("appStore.issueEvidenceMissing");
  if (item.openIssue === "app_root_missing") return t("appStore.issueAppRootMissing");
  if (item.openIssue === "manifest_missing") return t("appStore.issueManifestMissing");
  if (item.openIssue === "manifest_invalid") return t("appStore.issueManifestInvalid");
  if (item.openIssue === "app_id_mismatch") return t("appStore.issueAppIdMismatch");
  if (item.openIssue === "mount_conflict") return t("appStore.issueMountConflict");
  if (item.openIssue === "ui_not_workbench") return t("appStore.issueUiNotWorkbench");
  return t("appStore.issueUnknown");
}

type AppStoreMessageTone = "success" | "error" | "warning" | "info";

function configurationHint(item: AppStorePackageRecord, t: TranslationFn = translate): string {
  return groupedRequirements(item.requirements).length ? t("appStore.configurationHint") : "";
}

function groupedRequirements(
  requirements: string[] | undefined,
  t: TranslationFn = translate,
): Array<{ kind: string; label: string; items: string[] }> {
  const groups = new Map<string, string[]>();
  for (const requirement of requirements ?? []) {
    const trimmed = requirement.trim();
    if (!trimmed) continue;
    const match = /^([a-z]+):(.*)$/i.exec(trimmed);
    const kind = match?.[1]?.toLowerCase() ?? "other";
    const value = (match?.[2] ?? trimmed).trim();
    if (!value) continue;
    const items = groups.get(kind) ?? [];
    if (!items.includes(value)) items.push(value);
    groups.set(kind, items);
  }
  const order = ["env", "provider", "system", "other"];
  return order
    .filter((kind) => groups.has(kind))
    .map((kind) => ({
      kind,
      label: requirementGroupLabel(kind, t),
      items: groups.get(kind) ?? [],
    }));
}

function requirementGroupLabel(kind: string, t: TranslationFn = translate): string {
  if (kind === "env") return t("appStore.requirementEnv");
  if (kind === "provider") return "Provider";
  if (kind === "system") return t("appStore.requirementSystem");
  return t("appStore.requirementOther");
}

function packageMatchesFilters(item: AppStorePackageRecord, query: string, kindFilter: AppStoreKindFilter): boolean {
  if (kindFilter !== "all" && (item.publishKind ?? "app") !== kindFilter) return false;
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const haystack = [
    packageDisplayTitle(item),
    item.summary,
    item.category,
    item.publisher,
    item.workspaceName,
    item.packageKey,
    item.packageRef,
    item.employee?.name,
    item.employee?.role,
    item.employee?.publicDescription,
    item.employee?.inputSpec,
    item.employee?.outputSpec,
    item.employee?.model,
    ...item.capabilities,
    ...item.requirements,
    ...(item.employee?.skills ?? []),
    ...(item.employee?.publicSkills ?? []),
    ...(item.employee?.toolIds ?? []),
    ...(item.dependencies?.skills?.map((skill) => `${skill.id} ${skill.name ?? ""} ${skill.title ?? ""}`) ?? []),
    ...(item.dependencies?.tools?.map((tool) => `${tool.id} ${tool.title ?? ""}`) ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(normalizedQuery);
}

function formatDoctorSummary(item: AppStorePackageRecord, t: TranslationFn = translate): string {
  const doctor = item.doctor;
  if (!doctor) return t("appStore.doctorNotChecked");
  if (doctor.ok && !doctor.warnings.length) return t("appStore.doctorPassed");
  const missing = doctor.missing.length ? t("appStore.doctorMissingCount", { count: doctor.missing.length }) : "";
  const warnings = doctor.warnings.length ? t("appStore.doctorWarningCount", { count: doctor.warnings.length }) : "";
  return [missing, warnings].filter(Boolean).join(" · ") || t("appStore.doctorPassed");
}

function comparePackages(left: AppStorePackageRecord, right: AppStorePackageRecord): number {
  return (
    timestampValue(right.uploadedAt) - timestampValue(left.uploadedAt) ||
    compareLocalizedText(packageDisplayTitle(right), packageDisplayTitle(left))
  );
}

function packageDisplayTitle(item: AppStorePackageRecord): string {
  return item.title || item.employee?.name || item.appId || item.id;
}

function timestampValue(value: string | undefined): number {
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}
