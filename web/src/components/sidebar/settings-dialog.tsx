import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useIconStylePreference } from "../../appearance";
import type {
  AgentEventRecord,
  ApprovalRecord,
  BridgeSettings,
  ClientUpdateResponse,
  ExecutionRecord,
  MountedAppSettings,
  KernelLoginSession,
  KernelLoginView,
  KernelPathOverride,
  KernelPreference,
  KernelProxySettings,
  ModelProviderBinding,
  ProviderProfile,
  RunRecord,
  SkillRecord,
  VoiceSettings,
} from "../../bridge";
import { rawDiagnosticText, useI18n, type LanguagePreference } from "../../i18n";
import { useThemePreference, type ThemePreference } from "../../theme";
import { OpsCenterSettingsPanel } from "../system/ops-center-view";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { ProductIcon } from "../ui/product-icon";
import { SettingsAppearancePanel } from "./settings-appearance-panel";
import { SettingsAppsPanel } from "./settings-apps-panel";
import { SettingsNetworkPanel } from "./settings-connectivity-panels";
import { SettingsDesktopPanel } from "./settings-desktop-panel";
import { SettingsUpdatePanel } from "./settings-update-panel";
import { SettingsKernelPanel } from "./settings-kernel-panel";
import { SettingsModePanel } from "./settings-mode-panel";
import { isSettingsSectionVisible, visibleKernelOptions } from "./settings-mode-policy";
import {
  emptyKernelProxySettings,
  emptyProviderForm,
  emptyVoiceSettings,
  customProvidersAfterDelete,
  customProvidersAfterEnabledChange,
  normalizeKernelProxySettings,
  normalizeVoiceSettings,
  nextModelProviderBindings,
  mergeProviderProfileWithExisting,
  providerFormFromProfile,
  providerProfileFromForm,
  sortAvailableKernelsFirst,
  updateProviderForm,
  type ProviderFormState,
} from "./settings-model";
import { SettingsProviderSection } from "./settings-provider-section";
import {
  ICON_STYLE_OPTIONS,
  LANGUAGE_OPTIONS,
  SETTINGS_SECTIONS,
  THEME_OPTIONS,
  normalizeSettingsSection,
  sectionDescription,
  sectionTitle,
  type SettingsSectionId,
} from "./settings-sections";
import { SettingsVoicePanel } from "./settings-voice-panel";
import "./settings.css";
import styles from "./settings-dialog.module.css";

export type { SettingsSectionId } from "./settings-sections";

type OpsSettingsPayload = {
  runs: RunRecord[];
  executions: ExecutionRecord[];
  approvals: ApprovalRecord[];
  events: AgentEventRecord[];
  skills: SkillRecord[];
  tools: Record<string, unknown>[];
  selectedRunId: string;
  contextRecords?: Record<string, unknown>[];
  onSelectRun(runId: string): void;
  onOpenApprovals?(): void;
};

export function SettingsDialog(props: {
  settings?: BridgeSettings;
  loading: boolean;
  saving: boolean;
  installingKernelId?: string;
  kernelLogins?: KernelLoginView[];
  kernelLoginsLoading?: boolean;
  kernelLoginSession?: KernelLoginSession;
  kernelLoginActionPending?: boolean;
  error: string;
  embedded?: boolean;
  initialSection?: SettingsSectionId;
  clientUpdate?: ClientUpdateResponse;
  clientUpdateLoading?: boolean;
  clientUpdateError?: string;
  onCheckClientUpdate?(): Promise<void> | void;
  ops?: OpsSettingsPayload;
  onClose(): void;
  onInstallKernel?(kernelId: string, actionId: string): void;
  onKernelLoginAction?(kernelId: string, action: "login" | "logout"): void;
  onSave(payload: {
    developerMode?: boolean;
    directKernelChatEnabled?: boolean;
    languagePreference?: LanguagePreference;
    mountedApps?: MountedAppSettings[];
    kernelProxy?: KernelProxySettings;
    appStore?: BridgeSettings["appStore"];
    appUpdates?: BridgeSettings["appUpdates"];
    voice?: NonNullable<BridgeSettings["voice"]>;
    kernelPathOverrides?: Record<string, KernelPathOverride>;
    modelProviderBindings?: ModelProviderBinding[];
    customProviders?: ProviderProfile[];
  }): void;
}) {
  const { t, preference: languagePreference, setLanguagePreference } = useI18n();
  const { preference: themePreference, setThemePreference } = useThemePreference();
  const { preference: iconStylePreference, setIconStylePreference } = useIconStylePreference();
  const themeSelectOptions = THEME_OPTIONS.map((option) => ({ id: option.id, label: t(option.labelKey) }));
  const iconStyleSelectOptions = ICON_STYLE_OPTIONS.map((option) => ({ id: option.id, label: t(option.labelKey) }));
  const languageSelectOptions = LANGUAGE_OPTIONS.map((option) => ({ id: option.id, label: t(option.labelKey) }));
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(normalizeSettingsSection(props.initialSection));
  const [developerMode, setDeveloperMode] = useState(() => props.settings?.developerMode === true);
  const [directKernelChatEnabled, setDirectKernelChatEnabled] = useState(
    () => props.settings?.directKernelChatEnabled === true,
  );
  const [mountedApps, setMountedApps] = useState<MountedAppSettings[]>([]);
  const [automaticAppUpdates, setAutomaticAppUpdates] = useState(true);
  const [kernelProxy, setKernelProxy] = useState<KernelProxySettings>(emptyKernelProxySettings());
  const [voiceSettings, setVoiceSettings] = useState<NonNullable<BridgeSettings["voice"]>>(emptyVoiceSettings());
  const [kernelPathOverrides, setKernelPathOverrides] = useState<Record<string, KernelPathOverride>>({});
  const [modelProviderBindings, setModelProviderBindings] = useState<ModelProviderBinding[]>([]);
  const [customProviders, setCustomProviders] = useState<ProviderProfile[]>([]);
  const [providers, setProviders] = useState<ProviderProfile[]>(() => props.settings?.providers ?? []);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [providerDetailOpen, setProviderDetailOpen] = useState(false);
  const [providerAddOpen, setProviderAddOpen] = useState(false);
  const [providerForm, setProviderForm] = useState<ProviderFormState>(emptyProviderForm());
  const [providerAddDraftName, setProviderAddDraftName] = useState("");
  const [providerFormError, setProviderFormError] = useState("");
  const [providerDeleteTargetId, setProviderDeleteTargetId] = useState("");
  const [providerSaveState, setProviderSaveState] = useState<"idle" | "saved">("idle");
  const [providerApiKeyVisible, setProviderApiKeyVisible] = useState(false);
  const [expandedKernelId, setExpandedKernelId] = useState("");
  const settingsNavDeveloperMode = props.settings ? developerMode : true;
  const visibleSettingsSections = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => isSettingsSectionVisible(section.id, settingsNavDeveloperMode)),
    [settingsNavDeveloperMode],
  );
  const visibleActiveSection = isSettingsSectionVisible(activeSection, settingsNavDeveloperMode)
    ? activeSection
    : "mode";
  const skeletonLoading = props.loading && !props.settings;

  useEffect(() => {
    if (props.initialSection) {
      setActiveSection(normalizeSettingsSection(props.initialSection));
    }
  }, [props.initialSection]);

  useEffect(() => {
    // Keep optimistic local edits while any settings write is pending. The
    // saving dependency is intentional: its true-to-false edge resyncs the
    // latest server result after overlapping writes finish.
    if (!props.settings || props.saving) {
      return;
    }
    setDeveloperMode(props.settings.developerMode === true);
    setDirectKernelChatEnabled(props.settings.directKernelChatEnabled === true);
    setMountedApps(props.settings.mountedApps ?? []);
    setAutomaticAppUpdates(props.settings.appUpdates?.automatic !== false);
    setKernelProxy(normalizeKernelProxySettings(props.settings.kernelProxy));
    setVoiceSettings(normalizeVoiceSettings(props.settings.voice));
    setKernelPathOverrides(props.settings.kernelPathOverrides ?? {});
    setModelProviderBindings(props.settings.modelProviderBindings ?? []);
    setCustomProviders(props.settings.customProviders ?? []);
    setProviders(props.settings.providers ?? []);
    setSelectedProviderId((current) => {
      const providers = props.settings?.providers ?? [];
      if (current && providers.some((provider) => provider.id === current)) return current;
      return "";
    });
  }, [props.settings, props.saving]);

  useEffect(() => {
    if (providerSaveState !== "saved") return undefined;
    const timeout = window.setTimeout(() => setProviderSaveState("idle"), 1800);
    return () => window.clearTimeout(timeout);
  }, [providerSaveState]);

  useEffect(() => {
    setProviderApiKeyVisible(false);
  }, [selectedProviderId]);

  useEffect(() => {
    if (!providerDetailOpen || !selectedProviderId) return;
    const provider = providers.find((item) => item.id === selectedProviderId);
    if (!provider?.descriptionCode) return;
    const localizedDescription = providerFormFromProfile(provider, t).description;
    setProviderForm((current) =>
      current.descriptionCode && !current.descriptionEdited && current.description !== localizedDescription
        ? { ...current, description: localizedDescription }
        : current,
    );
  }, [providerDetailOpen, providers, selectedProviderId, t]);

  useEffect(() => {
    if (!props.settings || isSettingsSectionVisible(activeSection, developerMode)) return;
    setActiveSection("mode");
  }, [activeSection, developerMode, props.settings]);

  const kernels = useMemo(() => {
    const options = props.settings?.kernels?.length
      ? props.settings.kernels
      : [
          { id: "codex" as KernelPreference, label: "Codex", available: true },
          { id: "claude-code" as KernelPreference, label: "Claude Agent", available: true },
          { id: "hermes" as KernelPreference, label: "Hermes", available: true },
          { id: "pi" as KernelPreference, label: "Pi", available: true },
        ];
    return sortAvailableKernelsFirst(options);
  }, [props.settings, t]);
  const visibleKernels = useMemo(
    () => visibleKernelOptions(kernels, settingsNavDeveloperMode),
    [kernels, settingsNavDeveloperMode],
  );

  const providerDeleteTarget = providers.find((provider) => provider.id === providerDeleteTargetId);
  const detailForm = providerForm;
  const editableProviderModels = detailForm.models.length
    ? detailForm.models.split(",").map((item) => item.trim())
    : [];
  const providerModels = editableProviderModels.map((item) => item.trim()).filter(Boolean);

  const saveSettings = (next: {
    developerMode?: boolean;
    directKernelChatEnabled?: boolean;
    languagePreference?: LanguagePreference;
    mountedApps?: MountedAppSettings[];
    appUpdates?: BridgeSettings["appUpdates"];
    kernelProxy?: KernelProxySettings;
    voice?: NonNullable<BridgeSettings["voice"]>;
    kernelPathOverrides?: Record<string, KernelPathOverride>;
    modelProviderBindings?: ModelProviderBinding[];
    customProviders?: ProviderProfile[];
  }) => {
    props.onSave(next);
  };

  const saveLanguagePreference = (next: LanguagePreference) => {
    setLanguagePreference(next);
    saveSettings({ languagePreference: next });
  };

  const saveDeveloperMode = (enabled: boolean) => {
    setDeveloperMode(enabled);
    saveSettings({ developerMode: enabled });
  };

  const saveDirectKernelChatEnabled = (enabled: boolean) => {
    setDirectKernelChatEnabled(enabled);
    saveSettings({ directKernelChatEnabled: enabled });
  };

  const setKernelProxyDraft = (patch: Partial<KernelProxySettings>) => {
    setKernelProxy((current) => ({ ...current, ...patch }));
  };

  const saveKernelProxy = (patch: Partial<KernelProxySettings> = {}) => {
    const next = normalizeKernelProxySettings({ ...kernelProxy, ...patch });
    setKernelProxy(next);
    saveSettings({ kernelProxy: next });
  };

  const saveMountedApps = (next: MountedAppSettings[]) => {
    setMountedApps(next);
    saveSettings({ mountedApps: next });
  };

  const saveAutomaticAppUpdates = (enabled: boolean) => {
    setAutomaticAppUpdates(enabled);
    saveSettings({ appUpdates: { automatic: enabled } });
  };

  const patchMountedAppDraft = (appId: string, patch: Partial<MountedAppSettings>) => {
    setMountedApps((current) =>
      current.map((candidate) => (candidate.id === appId ? { ...candidate, ...patch } : candidate)),
    );
  };

  const updateMountedApp = (appId: string, patch: Partial<MountedAppSettings>) => {
    const next = mountedApps.map((item) =>
      item.id === appId
        ? {
            ...item,
            ...patch,
            path: patch.path !== undefined ? patch.path : item.path,
            title: patch.title !== undefined ? patch.title : item.title,
          }
        : item,
    );
    saveMountedApps(next);
  };

  const removeMountedApp = (appId: string) => {
    saveMountedApps(mountedApps.filter((item) => item.id !== appId));
  };

  const setVoiceDraft = (patch: Partial<VoiceSettings["stt"]>) => {
    setVoiceSettings((current) =>
      normalizeVoiceSettings({
        ...current,
        stt: {
          ...current.stt,
          ...patch,
        },
      }),
    );
  };

  const saveVoice = (patch: Partial<VoiceSettings["stt"]> = {}) => {
    const next = normalizeVoiceSettings({
      ...voiceSettings,
      stt: {
        ...voiceSettings.stt,
        ...patch,
      },
    });
    setVoiceSettings(next);
    saveSettings({ voice: next });
  };

  const setKernelPathDraft = (kernelId: string, key: keyof KernelPathOverride, value: string) => {
    setKernelPathOverrides((current) => ({
      ...current,
      [kernelId]: {
        ...(current[kernelId] ?? {}),
        [key]: value,
      },
    }));
  };

  const saveKernelPathOverride = (kernelId: string, patch: Partial<KernelPathOverride> = {}) => {
    const current = { ...(kernelPathOverrides[kernelId] ?? {}), ...patch };
    const normalized = {
      binaryPath: current.binaryPath?.trim(),
      configHome: current.configHome?.trim(),
    };
    const next = { ...kernelPathOverrides };
    const compact = Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => Boolean(value)),
    ) as KernelPathOverride;
    if (Object.keys(compact).length) {
      next[kernelId] = compact;
    } else {
      delete next[kernelId];
    }
    setKernelPathOverrides(next);
    saveSettings({ kernelPathOverrides: next });
  };

  const bindModelProvider = (modelId: string, providerId: string) => {
    const next = nextModelProviderBindings(modelProviderBindings, modelId, providerId, providers);
    setModelProviderBindings(next);
    saveSettings({ modelProviderBindings: next });
  };

  const saveProviderProfile = () => {
    const profile = providerProfileFromForm(providerForm);
    if (!profile) {
      setProviderFormError(t("settings.providerFormRequired"));
      return;
    }
    const existing = providers.find((item) => item.id === profile.id);
    const nextProfile = mergeProviderProfileWithExisting(profile, existing);
    setProviderFormError("");
    const next = [...customProviders.filter((item) => item.id !== nextProfile.id), nextProfile];
    const addedFromCatalog = providerAddOpen;
    setCustomProviders(next);
    setSelectedProviderId(addedFromCatalog ? "" : nextProfile.id);
    setProviderAddDraftName("");
    setProviderDetailOpen(!addedFromCatalog);
    setProviderAddOpen(false);
    const formProfile = nextProfile.modelsPinned ? nextProfile : { ...nextProfile, models: existing?.models ?? [] };
    setProviders((current) => [
      ...current.filter((item) => item.id !== nextProfile.id),
      { ...existing, ...formProfile },
    ]);
    setProviderForm(
      providerFormFromProfile(
        existing?.descriptionCode && !providerForm.descriptionEdited
          ? {
              ...formProfile,
              description: existing.description,
              descriptionCode: existing.descriptionCode,
            }
          : formProfile,
        t,
      ),
    );
    setProviderSaveState("saved");
    saveSettings({ customProviders: next });
  };

  const setProviderEnabled = (providerId: string, enabled: boolean) => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) return;
    const next = customProvidersAfterEnabledChange(customProviders, provider, enabled);
    const nextModelBindings = enabled
      ? modelProviderBindings
      : modelProviderBindings.filter((binding) => binding.providerId !== providerId);
    setCustomProviders(next);
    setModelProviderBindings(nextModelBindings);
    setProviders((current) =>
      current.map((item) =>
        item.id === providerId
          ? {
              ...item,
              enabled,
              ...(item.runtime
                ? {
                    runtime: {
                      ...item.runtime,
                      active: enabled,
                    },
                  }
                : {}),
            }
          : item,
      ),
    );
    saveSettings({
      customProviders: next,
      modelProviderBindings: nextModelBindings,
    });
  };

  const deleteProviderProfile = (providerId: string) => {
    const provider = providers.find((item) => item.id === providerId);
    const nextProviders = customProvidersAfterDelete(customProviders, provider);
    const nextModelBindings = modelProviderBindings.filter((binding) => binding.providerId !== providerId);
    setCustomProviders(nextProviders);
    setModelProviderBindings(nextModelBindings);
    setProviders((current) => current.filter((item) => item.id !== providerId));
    setSelectedProviderId((current) => (current === providerId ? "" : current));
    setProviderDetailOpen((open) => (selectedProviderId === providerId ? false : open));
    saveSettings({
      customProviders: nextProviders,
      modelProviderBindings: nextModelBindings,
    });
  };

  const confirmDeleteProvider = () => {
    if (!providerDeleteTargetId) return;
    deleteProviderProfile(providerDeleteTargetId);
    setProviderDeleteTargetId("");
  };

  const selectProvider = (provider: ProviderProfile) => {
    if (providerDetailOpen && selectedProviderId === provider.id) {
      closeProviderDetail();
      return;
    }
    setSelectedProviderId(provider.id);
    setProviderDetailOpen(true);
    setProviderForm(providerFormFromProfile(provider, t));
    setProviderFormError("");
    setProviderSaveState("idle");
  };

  const startAddProvider = () => {
    setSelectedProviderId("");
    setProviderAddDraftName("");
    setProviderDetailOpen(true);
    setProviderForm(emptyProviderForm());
    setProviderFormError("");
    setProviderSaveState("idle");
  };

  const startAddProviderFrom = (provider: ProviderProfile) => {
    setSelectedProviderId("");
    setProviderAddDraftName(provider.name);
    setProviderDetailOpen(true);
    setProviderForm(providerFormFromProfile(provider, t));
    setProviderFormError("");
    setProviderSaveState("idle");
  };

  const closeProviderDetail = () => {
    setProviderDetailOpen(false);
    setSelectedProviderId("");
    setProviderAddDraftName("");
    setProviderForm(emptyProviderForm());
    setProviderFormError("");
    setProviderSaveState("idle");
  };

  const openProviderAdd = () => {
    closeProviderDetail();
    setProviderAddOpen(true);
  };

  const closeProviderAdd = () => {
    setProviderAddOpen(false);
    closeProviderDetail();
  };

  const updateProviderDraft = (next: ProviderFormState) => {
    setProviderSaveState("idle");
    setProviderForm(next);
  };

  const updateProviderField = <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => {
    updateProviderDraft(updateProviderForm(providerForm, key, value));
  };

  const updatePrimaryBaseUrl = (value: string) => {
    const protocol = detailForm.protocol;
    const next = updateProviderForm(
      providerForm,
      protocol === "anthropic-compatible"
        ? "anthropicBaseUrl"
        : protocol === "gemini-compatible"
          ? "geminiBaseUrl"
          : "openaiBaseUrl",
      value,
    );
    updateProviderDraft(next);
  };

  const setProviderModels = (models: string[]) => {
    const seen = new Set<string>();
    const normalized = models
      .map((model) => model.trim())
      .filter((model) => {
        if (!model || seen.has(model)) return false;
        seen.add(model);
        return true;
      });
    updateProviderDraft(updateProviderForm(providerForm, "models", normalized.join(", ")));
  };

  const addProviderModel = () => {
    const base = "new-model";
    let candidate = base;
    let index = 2;
    while (providerModels.includes(candidate)) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    setProviderModels([...providerModels, candidate]);
  };

  const updateProviderModel = (modelIndex: number, value: string) => {
    const next = editableProviderModels.map((model, index) => (index === modelIndex ? value.replace(/,/g, "") : model));
    const serialized = next.join(", ");
    updateProviderDraft(updateProviderForm(providerForm, "models", serialized || (next.length ? " " : "")));
  };

  const removeProviderModelAt = (modelIndex: number) => {
    setProviderModels(editableProviderModels.filter((_, index) => index !== modelIndex));
  };

  const toggleKernelExpanded = (kernelId: string) => {
    setExpandedKernelId((current) => (current === kernelId ? "" : kernelId));
  };

  return (
    <div
      className={clsx(
        "settings-screen",
        styles.screen,
        props.embedded && "embedded",
        props.embedded && styles.embedded,
      )}
      role={props.embedded ? undefined : "dialog"}
      aria-modal={props.embedded ? undefined : "true"}
      aria-label={t("app.settings")}
    >
      <aside className={clsx("settings-screen-sidebar", styles.sidebar)}>
        {props.embedded ? (
          <header className={styles.sidebarHeader}>
            <h2>{t("app.settings")}</h2>
          </header>
        ) : (
          <button className={clsx("settings-back-button", styles.backButton)} type="button" onClick={props.onClose}>
            <ProductIcon name="back" size={18} />
            <span>{t("common.backToApp")}</span>
          </button>
        )}
        <nav className={clsx("settings-nav", styles.nav)} aria-label={t("settings.nav")}>
          {visibleSettingsSections.map((item) => {
            const active = visibleActiveSection === item.id;
            return (
              <button
                key={item.id}
                className={clsx(
                  "settings-nav-item",
                  styles.navItem,
                  item.id === "updates" && settingsNavDeveloperMode && styles.navItemDividerAfter,
                  active && "active",
                  active && styles.navItemActive,
                )}
                data-active={active ? "true" : "false"}
                data-settings-section={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
              >
                <ProductIcon name={item.icon} size={18} />
                <span>{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className={clsx("settings-screen-main", styles.main)}>
        <div
          className={clsx(
            "settings-screen-content",
            styles.content,
            visibleActiveSection === "ops" && "ops-settings-screen-content",
          )}
        >
          <header className={clsx("settings-screen-header", styles.header)}>
            <span className={clsx("settings-screen-kicker", styles.kicker)}>{t("settings.kicker")}</span>
            <h1>{sectionTitle(visibleActiveSection, t)}</h1>
            <p>{sectionDescription(visibleActiveSection, t)}</p>
          </header>

          {skeletonLoading ? <SettingsLoadingState /> : null}

          {!skeletonLoading && visibleActiveSection === "mode" ? (
            <SettingsModePanel
              t={t}
              developerMode={developerMode}
              directKernelChatEnabled={directKernelChatEnabled}
              loading={props.loading}
              saving={props.saving}
              onSaveDeveloperMode={saveDeveloperMode}
              onSaveDirectKernelChatEnabled={saveDirectKernelChatEnabled}
            />
          ) : null}

          {!skeletonLoading && visibleActiveSection === "kernels" ? (
            <SettingsKernelPanel
              t={t}
              kernels={visibleKernels}
              expandedKernelId={expandedKernelId}
              kernelPathOverrides={kernelPathOverrides}
              loading={props.loading}
              saving={props.saving}
              installingKernelId={props.installingKernelId}
              onToggleKernelExpanded={toggleKernelExpanded}
              onInstallKernel={props.onInstallKernel}
              onSetKernelPathDraft={setKernelPathDraft}
              onSaveKernelPathOverride={saveKernelPathOverride}
            />
          ) : null}

          {!skeletonLoading && visibleActiveSection === "ops" && props.ops ? (
            <OpsCenterSettingsPanel {...props.ops} settings={props.settings} />
          ) : null}

          {!skeletonLoading && visibleActiveSection === "providers" ? (
            <SettingsProviderSection
              t={t}
              providers={providers}
              kernels={visibleKernels}
              kernelLogins={props.kernelLogins ?? []}
              kernelLoginsLoading={props.kernelLoginsLoading === true}
              kernelLoginSession={props.kernelLoginSession}
              kernelLoginActionPending={props.kernelLoginActionPending === true}
              modelProviderBindings={modelProviderBindings}
              selectedProviderId={selectedProviderId}
              providerDetailOpen={providerDetailOpen}
              providerAddOpen={providerAddOpen}
              providerDraftName={providerAddDraftName}
              detailForm={detailForm}
              editableProviderModels={editableProviderModels}
              providerFormError={providerFormError}
              providerSaveState={providerSaveState}
              providerApiKeyVisible={providerApiKeyVisible}
              loading={props.loading}
              saving={props.saving}
              onSelectProvider={selectProvider}
              onOpenProviderAdd={openProviderAdd}
              onCloseProviderAdd={closeProviderAdd}
              onStartAddProvider={startAddProvider}
              onStartAddProviderFrom={startAddProviderFrom}
              onCloseProviderDetail={closeProviderDetail}
              onSetProviderDeleteTargetId={setProviderDeleteTargetId}
              onSetProviderEnabled={setProviderEnabled}
              onKernelLoginAction={props.onKernelLoginAction}
              onResetKernelBinaryPath={(kernelId) => saveKernelPathOverride(kernelId, { binaryPath: "" })}
              onBindModelProvider={bindModelProvider}
              onSaveProviderProfile={saveProviderProfile}
              onUpdateProviderField={updateProviderField}
              onUpdatePrimaryBaseUrl={updatePrimaryBaseUrl}
              onSetProviderModels={setProviderModels}
              onUpdateProviderModel={updateProviderModel}
              onRemoveProviderModelAt={removeProviderModelAt}
              onAddProviderModel={addProviderModel}
              onToggleProviderApiKeyVisible={() => setProviderApiKeyVisible((visible) => !visible)}
            />
          ) : null}

          {!skeletonLoading && visibleActiveSection === "apps" ? (
            <SettingsAppsPanel
              t={t}
              mountedApps={mountedApps}
              automaticUpdates={automaticAppUpdates}
              loading={props.loading}
              saving={props.saving}
              onPatchMountedAppDraft={patchMountedAppDraft}
              onUpdateMountedApp={updateMountedApp}
              onRemoveMountedApp={removeMountedApp}
              onSetAutomaticUpdates={saveAutomaticAppUpdates}
            />
          ) : null}

          {!skeletonLoading && visibleActiveSection === "voice" ? (
            <SettingsVoicePanel
              t={t}
              voiceSettings={voiceSettings}
              loading={props.loading}
              saving={props.saving}
              onSetVoiceDraft={setVoiceDraft}
              onSaveVoice={saveVoice}
            />
          ) : null}

          {!skeletonLoading && visibleActiveSection === "network" ? (
            <SettingsNetworkPanel
              t={t}
              kernelProxy={kernelProxy}
              loading={props.loading}
              saving={props.saving}
              onSetKernelProxyDraft={setKernelProxyDraft}
              onSaveKernelProxy={saveKernelProxy}
            />
          ) : null}

          {!skeletonLoading && visibleActiveSection === "desktop" ? <SettingsDesktopPanel /> : null}

          {!skeletonLoading && visibleActiveSection === "updates" ? (
            <SettingsUpdatePanel
              clientUpdate={props.clientUpdate}
              loading={props.clientUpdateLoading}
              error={props.clientUpdateError}
              onCheckClientUpdate={props.onCheckClientUpdate}
            />
          ) : null}

          {!skeletonLoading && visibleActiveSection === "appearance" ? (
            <SettingsAppearancePanel
              t={t}
              themePreference={themePreference as ThemePreference}
              themeSelectOptions={themeSelectOptions}
              iconStylePreference={iconStylePreference}
              iconStyleSelectOptions={iconStyleSelectOptions}
              languagePreference={languagePreference}
              languageSelectOptions={languageSelectOptions}
              onSetThemePreference={setThemePreference}
              onSetIconStylePreference={setIconStylePreference}
              onSetLanguagePreference={saveLanguagePreference}
            />
          ) : null}

          {!skeletonLoading && props.error ? (
            <p className="settings-warning">{rawDiagnosticText(props.error)}</p>
          ) : null}
        </div>
      </main>
      {providerDeleteTarget ? (
        <Dialog open onOpenChange={(open) => (!open ? setProviderDeleteTargetId("") : undefined)}>
          <DialogContent className="settings-confirm-dialog" aria-label={t("settings.removeProvider")}>
            <DialogTitle>{t("settings.removeProvider")}</DialogTitle>
            <p className="settings-confirm-copy">
              {t("settings.removeProviderConfirm", { name: providerDeleteTarget.name })}
            </p>
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setProviderDeleteTargetId("")}>
                {t("common.cancel")}
              </button>
              <button className="danger-button" type="button" onClick={confirmDeleteProvider}>
                {t("common.delete")}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function SettingsLoadingState() {
  const { t } = useI18n();
  return (
    <div className="og-skeleton-stack settings-loading-state" role="status" aria-label={t("mountedApp.loading")}>
      <span className="og-skeleton og-skeleton-line" style={{ width: "34%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "82%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "68%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "76%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "52%" }} />
    </div>
  );
}
