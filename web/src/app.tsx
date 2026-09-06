import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "./app-shell.css";
import "./app-workspace.css";
import "./app-chat-frame.css";
import "./app-mobile-nav.css";
import "./components/sidebar/icon-primitives.css";
import "./components/sidebar/sidebar-shell.css";
import "./components/sidebar/sidebar-conversations.css";
import "./components/sidebar/section-sidebar.css";
import { Bot } from "lucide-react";
import type {
  BridgeSettingsResponse,
  BridgeSettings,
  ExtensionInventoryRecord,
  KernelInstallResponse,
  KernelLoginActionResponse,
  KernelLoginSessionResponse,
  KernelPreference,
  MessagePart,
  WorkspaceDirectoryResponse,
} from "./bridge";
import { BridgeRequestError, compactAskSession, DEFAULT_MODEL_ID, getJson, patchJson, postJson } from "./bridge";
import { clamp, createEmptyWorkingState, normalizeWorkingState } from "./format";
import { APP_PRODUCT_NAME, APP_STORAGE_KEYS } from "./identity";
import { markAccountOnboardingCompleted, readAccountOnboardingCompleted } from "./account-onboarding";
import { nextLanguageSettingsBackfill } from "./language-settings-sync";
import {
  readDesktopApi,
  readDesktopBridgeStartupState,
  type OpenGroveDesktopClientUpdateState,
  type OpenGroveDesktopSourceUpdateState,
} from "./desktop-api";
import { nextClientUpdateMetadataRefreshRelease } from "./client-update-presentation";
import { setHostSystemTheme } from "./theme";
import { detectSystemLanguage, rawDiagnosticText, useI18n } from "./i18n";
import { applyApprovalResultToMessages, applyQuestionResultToMessages } from "./messages";
import { buildContextPayload } from "./runtime/composer-context";
import {
  desktopBridgeReadyForBootstrap,
  desktopBridgeRequiresStartupGate,
  resolveBridgeReadyGenerationTransition,
} from "./runtime/desktop-bootstrap-policy";
import { modelBindingKey, readStoredModelBindings, writeStoredModelBinding } from "./runtime/app-shell-state";
import { useAppLayoutResize } from "./runtime/app-layout-resize";
import {
  buildApprovalResolutionMessage,
  buildConnectedToolsStatus,
  cloneMessage,
  composeSkillPrompt,
  collectMessageRunIds,
  fileNameFromAssetUri,
  formatKernelLabel,
  latestContextUsage,
  mergeFinalDataIntoCache,
  mimeTypeFromAssetUri,
  resolveCurrentSession,
  resolveLatestRun,
  resolveLatestRuntimeBlocker,
} from "./runtime/ui-model";
import { useBridgeQueries } from "./runtime/use-bridge-queries";
import { ChatComposer } from "./components/chat/chat-composer";
import { buildKernelCapabilityUiState } from "./runtime/kernel-capability-ui";
import { modelOptionMatchesId, modelOptionsForKernel, runtimeControlsForKernel } from "./runtime/kernel-models";
import { settingsWithProviderModels } from "./runtime/provider-model-catalog";
import { SlashCommandMenu } from "./components/chat/skill-command-menu";
import { ThreadShell } from "./components/chat/thread-shell";
import { AppRail, MobileNav, railSectionForView, type RailSectionId } from "./components/sidebar/app-navigation";
import { developerOnlyRailSection, developerOnlyView } from "./components/sidebar/navigation-mode-policy";
import { RoomsView } from "./components/rooms/rooms-view";
import { RoomsLoadingState } from "./components/rooms/rooms-view-layout";
import { ContactsView } from "./components/rooms/contacts-view";
import { useRoomsSharedState } from "./components/rooms/rooms-shared-state";
import { appScopedGroupUnreadCount, isAppScopedRoomId, visibleRoomUnreadCount } from "./components/rooms/rooms-model";
import { ConversationSidebar } from "./components/sidebar/conversation-sidebar";
import {
  buildSidebarProjectTree,
  sortSidebarThreads,
  type ConversationSortKey,
} from "./components/sidebar/conversation-sidebar-model";
import { AppCreateWizard } from "./components/apps/app-create-wizard";
import { AppSettingsDialog } from "./components/apps/app-settings-dialog";
import { mountedAppUiRuntime } from "./components/apps/mounted-app-model";
import { defaultMountedAppCrewOpen, mountedAppCrewStorageKey } from "./components/apps/mounted-app-shell-model";
import { SettingsDialog, type SettingsSectionId } from "./components/sidebar/settings-dialog";
import {
  isProviderUsable,
  modelIdsEquivalent,
  providerBindingLabel,
  providerRouteIdForKernel,
  providerServesModel,
  providerSupportsKernel,
} from "./components/sidebar/settings-model";
import { ExtensionsView } from "./components/extensions/extensions-view";
import { AppStoreView } from "./components/network/app-store-view";
import { appStoreUpdateCount } from "./components/network/app-store-query";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { useConfirm } from "./components/ui/confirm-dialog";
import { useToast } from "./components/ui/toast";
import { WorkspaceInspector } from "./components/workspace/workspace-views";
import { useUiStore, type UiProject, type UiThread } from "./store";
import { useVoiceInput } from "./voice/use-voice-input";
import {
  CloudAuthLoadingScreen,
  CloudAuthScreen,
  RoomsUnavailableState,
  TeamAccountPickerScreen,
  TeamGateScreen,
} from "./components/app-shell/app-gates";
import { AppTitlebar } from "./components/app-shell/app-titlebar";
import { ChatWorkspaceView, MountedAppWorkspaceView } from "./components/app-shell/app-main-views";
import { useBridgeAuthGate } from "./app-auth-gate";
import { devFixtureAccountSwitcherAvailable } from "./dev-fixture-accounts";
import { markAuthSessionLoggedOut } from "./app-auth-model";
import { useAppThreadRunner } from "./app-thread-runner";
import { useAppPersistentUiState, type RoomsAppView } from "./app-persistent-ui-state";
import { useMountedAppWorkflow } from "./app-mounted-app-workflow";
import { resolveMountedAppHostState } from "./app-mounted-app-workflow-model";
import { useAppComposerWorkflow } from "./app-composer-workflow";
import { useAppCreateWorkflow } from "./app-create-workflow";
import {
  readDirectKernelChatSelection,
  writeDirectKernelChatSelection,
  type DirectKernelChatSelection,
} from "./runtime/direct-kernel-chat-runtime";

type ExtensionsResponse = {
  ok: boolean;
  extensions?: ExtensionInventoryRecord;
  source?: string;
};

function contextUsageRunIds(runIds: string[], latestRun: { id?: unknown; runId?: unknown } | undefined): string[] {
  const ids = new Set(runIds);
  if (typeof latestRun?.id === "string" && latestRun.id) ids.add(latestRun.id);
  if (typeof latestRun?.runId === "string" && latestRun.runId) ids.add(latestRun.runId);
  return [...ids];
}

function messageHasPendingApproval(message: { parts?: MessagePart[] }): boolean {
  return Boolean(
    message.parts?.some(
      (part) => part?.type === "tool" && part.phase === "approval" && part.approvalStatus === "pending",
    ),
  );
}

export function App() {
  const { language, t, preference: languagePreference, setLanguagePreference } = useI18n();
  const desktopApi = readDesktopApi();
  const [desktopAccountOnboardingCompleted, setDesktopAccountOnboardingCompleted] =
    useState(readAccountOnboardingCompleted);
  const [accountLoginRequested, setAccountLoginRequested] = useState(false);
  // Set when someone chooses the email form over the test-account picker. Not
  // persisted: a fresh window should land on the picker again.
  const [emailLoginRequested, setEmailLoginRequested] = useState(false);
  const [desktopBridgeStartupState, setDesktopBridgeStartupState] = useState(readDesktopBridgeStartupState(desktopApi));
  const desktopBridgeReadyGenerationRef = useRef<number | undefined>(undefined);
  const desktopBridgeReady = desktopBridgeReadyForBootstrap({
    bridgeStartupState: desktopBridgeStartupState,
  });
  const desktopBridgeStartupGateRequired = desktopBridgeRequiresStartupGate({
    bridgeStartupState: desktopBridgeStartupState,
  });
  const { toast } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const systemDetail = (value: unknown) =>
    rawDiagnosticText(value instanceof Error ? value.message : String(value ?? ""));
  const [projectMenuOpenId, setProjectMenuOpenId] = useState("");
  const [projectCollapsedIds, setProjectCollapsedIds] = useState<string[]>([]);
  const [projectCollapseSnapshotIds, setProjectCollapseSnapshotIds] = useState<string[]>([]);
  const [conversationSortMenuOpen, setConversationSortMenuOpen] = useState(false);
  const [conversationSortKey, setConversationSortKey] = useState<ConversationSortKey>("updatedAt");
  const [planMode, setPlanMode] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const [workspacePickerPending, setWorkspacePickerPending] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSectionId>("mode");
  const [kernelLoginSessionId, setKernelLoginSessionId] = useState("");
  const handledKernelLoginSessionRef = useRef("");
  const [selectedOpsRunId, setSelectedOpsRunId] = useState("");
  const [desktopWindowFullscreen, setDesktopWindowFullscreen] = useState(false);
  const [sourceUpdate, setSourceUpdate] = useState<OpenGroveDesktopSourceUpdateState | undefined>();
  const [clientUpdate, setClientUpdate] = useState<OpenGroveDesktopClientUpdateState | undefined>();
  const [mountedAppDeveloperModeOpen, setMountedAppDeveloperModeOpen] = useState(false);
  const [mountedAppPendingCrewCount, setMountedAppPendingCrewCount] = useState(0);
  const [mountedAppSettingsId, setMountedAppSettingsId] = useState("");
  const [mountedAppVersionManagementId, setMountedAppVersionManagementId] = useState("");
  const [appStorePublishDirty, setAppStorePublishDirty] = useState(false);
  const [authToastMessage, setAuthToastMessage] = useState("");
  const threadScrollRef = useRef<HTMLElement | null>(null);
  const refreshedClientUpdateReleaseRef = useRef<number | undefined>(undefined);
  const languageSettingsBackfillAttemptRef = useRef("");

  useEffect(() => {
    void readDesktopApi()?.setLanguage?.(language);
  }, [language]);
  useEffect(() => desktopApi?.onBridgeStartupStateChange?.(setDesktopBridgeStartupState), [desktopApi]);
  useEffect(() => {
    const transition = resolveBridgeReadyGenerationTransition(
      desktopBridgeReadyGenerationRef.current,
      desktopBridgeStartupState,
    );
    desktopBridgeReadyGenerationRef.current = transition.generation;
    if (transition.restarted) void queryClient.invalidateQueries();
  }, [desktopBridgeStartupState, queryClient]);

  const {
    model,
    messages,
    activeView,
    projectId,
    projects,
    threads,
    threadId,
    composerHeight,
    contextText,
    setModel,
    setView,
    setSending,
    setComposerHeight,
    clearContext,
    appendMessage,
    appendMessageToThread,
    appendAssistantMessageToThread,
    updateThreadMessage,
    replaceMessages,
    startNewThread,
    startNewProject,
    renameProject,
    setProjectWorkspaceRoot,
    selectThread,
    deleteThread: deleteThreadFromStore,
    deleteProject: deleteProjectFromStore,
  } = useUiStore();
  const [directKernelChatSelection, setDirectKernelChatSelection] = useState<DirectKernelChatSelection>(() =>
    readDirectKernelChatSelection(threadId),
  );
  useEffect(() => {
    setDirectKernelChatSelection(readDirectKernelChatSelection(threadId));
  }, [threadId]);
  const {
    accessMode,
    budgetLimitUsd,
    clearRoomsSelection,
    railExpanded,
    reasoningEffort,
    responseSpeed,
    roomsAppView,
    roomsFocusRoomId,
    roomsOnboardingGuideDismissed,
    setAccessMode,
    setBudgetLimitUsd,
    setRailExpanded,
    setReasoningEffort,
    setResponseSpeed,
    setRoomsAppView,
    setRoomsFocusRoomId,
    setRoomsOnboardingGuideDismissed,
    sidebarCollapsed,
  } = useAppPersistentUiState(activeView);
  const { sidebarWidth, onComposerPointerDown, onSidebarResizePointerDown } = useAppLayoutResize({
    composerHeight,
    setComposerHeight,
  });

  const {
    desktopSavedSession,
    healthQuery,
    sessionQuery,
    settingsQuery,
    appStoreCatalogQuery,
    providerModelsQuery,
    kernelLoginsQuery,
    inventoryQuery,
    approvalsQuery,
    questionsQuery,
    contextRecordsQuery,
    opsRunsQuery,
    opsExecutionsQuery,
    eventsQuery,
    clientUpdateQuery,
  } = useBridgeQueries({
    contextRecordsEnabled: activeView === "ops",
    contextRunId: selectedOpsRunId,
    desktopAccountOnboardingCompleted,
    desktopBridgeReady,
    kernelLoginsEnabled: activeView === "settings",
  });
  const kernelLoginSessionQuery = useQuery({
    queryKey: ["kernel-login-session", kernelLoginSessionId],
    queryFn: () =>
      getJson<KernelLoginSessionResponse>(
        `/settings/kernel-login-sessions/${encodeURIComponent(kernelLoginSessionId)}`,
      ),
    enabled: Boolean(kernelLoginSessionId),
    refetchInterval: (query) => (query.state.data?.session?.status === "running" ? 750 : false),
  });
  useEffect(() => {
    const session = kernelLoginSessionQuery.data?.session;
    if (!session || (session.status !== "succeeded" && session.status !== "failed")) return;
    if (handledKernelLoginSessionRef.current === session.id) return;
    handledKernelLoginSessionRef.current = session.id;
    void queryClient.invalidateQueries({ queryKey: ["kernel-logins"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    setKernelLoginSessionId("");
    if (session.status === "failed") {
      toast({
        kind: "error",
        title: t("system.kernelLoginFailed", {
          kernelId: session.kernelId,
          message: systemDetail(session.error || session.output),
        }),
      });
    }
  }, [kernelLoginSessionQuery.data?.session, queryClient, t, toast]);
  const hydratedBridgeSettings = useMemo(
    () => settingsWithProviderModels(settingsQuery.data?.settings, providerModelsQuery.data),
    [providerModelsQuery.data, settingsQuery.data?.settings],
  );
  const bridgeSettings = hydratedBridgeSettings ?? settingsQuery.data?.settings;
  const providerModelsPending =
    Boolean(settingsQuery.data?.settings?.providers) &&
    hydratedBridgeSettings === undefined &&
    providerModelsQuery.isPending;
  useEffect(() => {
    const desktop = readDesktopApi();
    if (!desktop) {
      setHostSystemTheme(undefined);
    } else if (!desktop.getSystemTheme) {
      setHostSystemTheme(healthQuery.data?.appearance?.systemTheme);
    }
  }, [healthQuery.data?.appearance?.systemTheme]);
  useEffect(() => {
    const desktop = readDesktopApi();
    if (!desktop?.getSystemTheme) return;
    let active = true;
    void desktop
      .getSystemTheme()
      .then((theme) => {
        if (active) setHostSystemTheme(theme);
      })
      .catch(() => undefined);
    const unsubscribe = desktop.onSystemThemeChange?.(setHostSystemTheme);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  const settingsReady = Boolean(bridgeSettings);
  const developerMode = bridgeSettings?.developerMode === true;
  const railDeveloperMode = settingsReady ? developerMode : true;
  const directKernelChatEnabled = bridgeSettings?.directKernelChatEnabled === true;
  const railDirectKernelChatEnabled = settingsReady ? directKernelChatEnabled : true;
  const askGroveForLocalFolderHelp = async () => {
    appendMessage("system", t("shell.localFolderHelp"));
  };
  const {
    authFixtureSwitchMutation,
    authLoginMutation,
    authLogoutMutation,
    authSendCodeMutation,
    bridgeProtectedQueriesEnabled,
    requestAuthSessionRevalidation,
    resetSendCodeState,
    sendCodeRequiresCountry,
    sendCodeRequiresInvite,
    sendCodeSuccessCount,
    sessionAuthChecking,
    sessionAuthPendingLocallyAvailable,
    sessionAuthNeedsLogin,
    sessionAuthUnavailable,
    sessionAuthenticated,
    teamGateBlocksSignIn,
    teamGateChecking,
    teamGateSatisfied,
    teamAccounts,
    previousAccountEmail,
    teamRestoreMutation,
    teamAccountsFailed,
    teamUnlockMutation,
  } = useBridgeAuthGate({
    queryClient,
    healthQuery,
    sessionQuery,
    desktopSavedSession,
    desktopBridgeReady,
    desktopAccountOnboardingCompleted,
    languagePreference,
    onAuthSessionChanged: clearRoomsSelection,
    onProviderProvisioningFailed: (message) => toast({ kind: "error", title: message }),
    onNewUserRegistered: () => {
      // A freshly registered account gets the first-run guide even if this
      // browser dismissed it for a previous account.
      window.localStorage.removeItem(APP_STORAGE_KEYS.roomsOnboardingGuide);
      setRoomsOnboardingGuideDismissed(false);
    },
  });

  useEffect(() => {
    if (sessionQuery.data?.status !== "authenticated") return;
    markAccountOnboardingCompleted();
    setDesktopAccountOnboardingCompleted(true);
    setAccountLoginRequested(false);
  }, [sessionQuery.data?.status]);
  const roomsSessionKey =
    healthQuery.data?.auth?.mode === "session" ? `account:${sessionQuery.data?.user?.userId ?? "anonymous"}` : "local";

  useEffect(() => {
    if (!authToastMessage) return undefined;
    const timer = window.setTimeout(() => setAuthToastMessage(""), 2000);
    return () => window.clearTimeout(timer);
  }, [authToastMessage]);

  function showLoginExpiredToast(): void {
    authLoginMutation.reset();
    authSendCodeMutation.reset();
    setAuthToastMessage(t("auth.sessionExpired"));
    markAuthSessionLoggedOut(queryClient);
  }

  function continueWithoutAccount(): void {
    markAccountOnboardingCompleted();
    setDesktopAccountOnboardingCompleted(true);
    setAccountLoginRequested(false);
  }

  const { snapshot: roomsSnapshot, actions: roomsActions } = useRoomsSharedState({
    enabled: bridgeProtectedQueriesEnabled,
    onSessionRequired: requestAuthSessionRevalidation,
    sessionKey: roomsSessionKey,
  });
  const roomsState = useMemo(
    () => ({
      rooms: roomsSnapshot.rooms,
      members: roomsSnapshot.members,
      activeRoomId: roomsSnapshot.activeRoomId,
      deletedMemberIds: roomsSnapshot.deletedMemberIds,
    }),
    [roomsSnapshot.activeRoomId, roomsSnapshot.deletedMemberIds, roomsSnapshot.members, roomsSnapshot.rooms],
  );
  const roomsUnreadCount = useMemo(() => visibleRoomUnreadCount(roomsSnapshot.rooms), [roomsSnapshot.rooms]);
  const availableAppStoreUpdateCount = useMemo(
    () => appStoreUpdateCount(appStoreCatalogQuery.data),
    [appStoreCatalogQuery.data],
  );
  const extensionsInventoryNeeded =
    developerMode &&
    (activeView === "extensions" ||
      activeView === "contacts" ||
      (activeView === "rooms" && roomsAppView === "contacts"));
  const extensionsQuery = useQuery({
    queryKey: ["extensions"],
    queryFn: () => getJson<ExtensionsResponse>("/extensions"),
    enabled: bridgeProtectedQueriesEnabled && extensionsInventoryNeeded,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const inventory = inventoryQuery.data;
  const extensionInventory = extensionsQuery.data?.extensions ?? inventory?.mountedApps;
  const shouldShowRoomsOnboardingGuide = sessionAuthenticated && !roomsOnboardingGuideDismissed;
  const approvals = approvalsQuery.data?.approvals ?? [];
  const pendingApprovals = useMemo(() => approvals.filter((approval) => approval?.status === "pending"), [approvals]);
  const pendingQuestionIds = useMemo<ReadonlySet<string> | undefined>(() => {
    const questions = questionsQuery.data?.questions;
    if (!questions) return undefined;
    return new Set(
      questions
        .filter((question) => question?.status === "pending" && question.id)
        .map((question) => String(question.id)),
    );
  }, [questionsQuery.data?.questions]);
  const contextRecords = contextRecordsQuery.data?.records ?? [];
  const events = eventsQuery.data?.events ?? [];
  const artifacts = inventory?.artifacts ?? [];
  const skills = inventory?.skills ?? [];
  const tools = inventory?.tools ?? [];
  const sessions = inventory?.sessions ?? [];
  const runs = activeView === "ops" ? (opsRunsQuery.data?.runs ?? inventory?.runs ?? []) : (inventory?.runs ?? []);
  const executions =
    activeView === "ops"
      ? (opsExecutionsQuery.data?.executions ?? inventory?.executions ?? [])
      : (inventory?.executions ?? []);
  const workingState = normalizeWorkingState(inventory?.workingState ?? createEmptyWorkingState());
  const activeKernel = bridgeSettings?.activeKernel;
  const kernelOptions = bridgeSettings?.kernels ?? [];
  const activeKernelOption = kernelOptions.find((kernel) => kernel.id === activeKernel);
  const runtimeControls = settingsQuery.data?.runtimeControls;
  const runtimeControlsByKernel = settingsQuery.data?.runtimeControlsByKernel;
  const activeRuntimeControls = runtimeControlsForKernel(activeKernel, runtimeControls, runtimeControlsByKernel);
  const selectedChatKernelOption = kernelOptions.find((kernel) => kernel.id === directKernelChatSelection.kernel);
  const chatKernelOption = selectedChatKernelOption?.available
    ? selectedChatKernelOption
    : activeKernelOption?.available
      ? activeKernelOption
      : (kernelOptions.find((kernel) => kernel.available) ?? activeKernelOption ?? kernelOptions[0]);
  const chatKernel = chatKernelOption?.id ?? activeKernel;
  const chatRuntimeControls = runtimeControlsForKernel(chatKernel, runtimeControls, runtimeControlsByKernel);
  const chatKernelCapabilityUi = useMemo(
    () => buildKernelCapabilityUiState(chatKernelOption?.capabilityReport, chatKernel),
    [chatKernelOption?.capabilityReport, chatKernel],
  );
  const effectivePlanMode = planMode && chatKernelCapabilityUi.canShowPlanMode;
  const effectiveGoalMode = goalMode && chatKernelCapabilityUi.canShowGoalMode;
  const isCodexKernel = chatKernel === "codex";
  const chatProviderOptions = useMemo(() => {
    const deduped = new Map<string, { id: string; label: string; available: boolean }>();
    for (const provider of hydratedBridgeSettings?.providers ?? []) {
      if (
        !isProviderUsable(provider) ||
        !chatKernel ||
        !providerSupportsKernel(provider, chatKernel) ||
        !providerServesModel(provider, chatKernel, model, hydratedBridgeSettings?.providers ?? [])
      )
        continue;
      const id = providerRouteIdForKernel(provider, chatKernel);
      if (!deduped.has(id)) {
        deduped.set(id, { id, label: providerBindingLabel(provider, chatKernel, t), available: true });
      }
    }
    return [...deduped.values()];
  }, [hydratedBridgeSettings?.providers, chatKernel, model, t]);
  const selectedChatModelOption = modelOptionsForKernel(chatKernel, chatRuntimeControls).find((option) =>
    modelOptionMatchesId(option, model),
  );
  const boundChatProviderId =
    hydratedBridgeSettings?.modelProviderBindings?.find(
      (binding) =>
        modelIdsEquivalent(binding.modelId, model, hydratedBridgeSettings?.providers ?? [], binding.providerId) ||
        (selectedChatModelOption && modelOptionMatchesId(selectedChatModelOption, binding.modelId)),
    )?.providerId ?? "";
  const requestedChatProviderId = directKernelChatSelection.providerId;
  const chatProviderId =
    requestedChatProviderId !== undefined
      ? requestedChatProviderId === "" ||
        chatProviderOptions.some((provider) => provider.id === requestedChatProviderId)
        ? requestedChatProviderId
        : ""
      : chatProviderOptions.some((provider) => provider.id === boundChatProviderId)
        ? boundChatProviderId
        : "";
  const chatProviderLabel =
    chatProviderOptions.find((provider) => provider.id === chatProviderId)?.label ?? t("shell.followKernelProvider");
  const {
    activeSlashIndex,
    appendVoiceTranscript,
    applySkillSuggestion,
    attachments,
    composerInputRef,
    composerQuestionValue,
    composerSkillInvocation,
    contextArtifacts,
    dismissSlashPalette,
    fileInputRef,
    handleAttachmentInputChange,
    handleComposerPaste,
    handleQuestionChange,
    insertPrompt,
    isComposingText,
    matchingSkills,
    matchingSlashCommands,
    modelMenuKind,
    modelMenuPlacement,
    modelMenuRef,
    openAttachmentPicker,
    question,
    removeAttachment,
    removeContextArtifact,
    removeSkillInvocation,
    resetComposerDraft,
    setActiveSlashIndex,
    setComposerSkillInvocation,
    setForceSlashMenuOpen,
    setIsComposingText,
    setModelMenuKind,
    setQuestion,
    showSlashPalette,
    slashMenuItemCount,
    toggleModelMenu,
  } = useAppComposerWorkflow({
    activeKernel: chatKernel,
    activeKernelCapabilityReport: chatKernelOption?.capabilityReport,
    appendSystemMessage: (message) => appendMessage("system", message),
    formatMaxAttachmentsMessage: (count) => t("system.maxAttachments", { count }),
    formatPartialAttachmentsMessage: (selected, count) => t("system.partialAttachments", { selected, count }),
    isCodexKernel,
    setView,
    skills,
    threadScrollRef,
    workingState,
  });
  const {
    activeMountedApp,
    deleteMountedAppTab,
    embeddedMountedAppMode,
    mountedApps,
    selectMountedApp,
    unresolvedMountedAppRequestId,
  } = useMountedAppWorkflow({
    activeView,
    confirm,
    inventoryItems: inventory?.mountedApps?.items ?? [],
    queryClient,
    settings: bridgeSettings,
    setView,
    showErrorToast: (message) => toast({ kind: "error", title: message }),
  });
  const mountedAppSettingsTarget = mountedApps.find(
    (app) => app.name === mountedAppSettingsId || app.id === mountedAppSettingsId,
  );
  const activeMountedAppId = activeMountedApp?.name || "";
  const activeMountedAppSurface = mountedAppUiRuntime(activeMountedApp).surface;
  const mountedAppUnreadBadges = useMemo(
    () =>
      Object.fromEntries(
        mountedApps.map((app) => [app.name, { count: appScopedGroupUnreadCount(roomsSnapshot.rooms, app.name) }]),
      ),
    [mountedApps, roomsSnapshot.rooms],
  );
  useEffect(() => {
    setMountedAppPendingCrewCount(0);
    if (!activeMountedAppId) {
      setMountedAppDeveloperModeOpen(false);
      return;
    }
    try {
      const stored = window.localStorage.getItem(mountedAppCrewStorageKey(activeMountedAppId));
      setMountedAppDeveloperModeOpen(
        stored === null ? defaultMountedAppCrewOpen(activeMountedAppSurface) : stored === "true",
      );
    } catch {
      // non-critical-fallback: Invalid local preference data uses the surface-specific default.
      setMountedAppDeveloperModeOpen(defaultMountedAppCrewOpen(activeMountedAppSurface));
    }
  }, [activeMountedAppId, activeMountedAppSurface]);

  function toggleMountedAppDeveloperMode() {
    if (!activeMountedAppId) return;
    setMountedAppDeveloperModeOpen((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(mountedAppCrewStorageKey(activeMountedAppId), String(next));
      } catch {
        // Developer-mode persistence is optional; the active App remains usable without localStorage.
      }
      return next;
    });
  }

  useEffect(() => {
    if (!settingsReady) return;
    if (activeView === "chat") {
      if (directKernelChatEnabled) return;
    } else if (developerMode || !developerOnlyView(activeView)) return;
    setView(mountedApps[0] ? "app" : "app-store");
  }, [activeView, developerMode, directKernelChatEnabled, mountedApps, settingsReady, setView]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "app") {
      const requestedApp = params.get("app");
      if (requestedApp) selectMountedApp(requestedApp);
      setView("app");
      return;
    }
    if (params.get("view") === "rooms") {
      setView("rooms");
    }
  }, [setView]);

  useEffect(() => {
    const desktop = readDesktopApi();
    if (!desktop) return;
    let cancelled = false;
    const applyWindowState = (state: { fullscreen?: boolean } | undefined) => {
      if (!cancelled) {
        setDesktopWindowFullscreen(state?.fullscreen === true);
      }
    };
    const initialState = desktop.getWindowState?.();
    if (initialState) {
      void initialState.then(applyWindowState).catch(() => undefined);
    }
    const unsubscribe = desktop.onWindowStateChange?.(applyWindowState);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const desktop = readDesktopApi();
    if (!desktop?.getSourceUpdateState) return;
    let cancelled = false;
    desktop
      .getSourceUpdateState()
      .then((state) => {
        if (!cancelled) setSourceUpdate(state);
      })
      .catch(() => undefined);
    const unsubscribe = desktop.onSourceUpdateStateChange?.((state) => {
      if (!cancelled) setSourceUpdate(state);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const desktop = readDesktopApi();
    if (!desktop?.getClientUpdateState) return;
    let cancelled = false;
    const applyClientUpdateState = (state: OpenGroveDesktopClientUpdateState) => {
      if (cancelled) return;
      setClientUpdate(state);
      const refreshRelease = nextClientUpdateMetadataRefreshRelease(state, refreshedClientUpdateReleaseRef.current);
      if (refreshRelease !== undefined) {
        refreshedClientUpdateReleaseRef.current = refreshRelease;
        void queryClient.invalidateQueries({ queryKey: ["client-update"] });
      }
    };
    desktop
      .getClientUpdateState()
      .then(applyClientUpdateState)
      .catch(() => undefined);
    const unsubscribe = desktop.onClientUpdateStateChange?.(applyClientUpdateState);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [queryClient]);

  useEffect(() => {
    const latest = clientUpdateQuery.data?.latest;
    const current = clientUpdateQuery.data?.current;
    if (!latest || typeof current !== "number" || latest.version <= current) return;
    const desktop = readDesktopApi();
    if (!desktop?.checkForClientUpdate) return;
    void desktop
      .checkForClientUpdate()
      .then(setClientUpdate)
      .catch(() => undefined);
  }, [clientUpdateQuery.data?.current, clientUpdateQuery.data?.latest?.version]);

  async function handleTitlebarSourceUpdate() {
    const desktop = readDesktopApi();
    if (!desktop?.installSourceUpdate || sourceUpdate?.busy) return;
    const confirmed = await confirm({
      title: t("confirm.installSourceUpdateTitle"),
      body: t("confirm.restartInterruptsBody"),
      confirmLabel: t("common.install"),
    });
    if (confirmed !== "primary") return;
    try {
      setSourceUpdate(await desktop.installSourceUpdate());
    } catch (error) {
      setSourceUpdate((current) =>
        current
          ? {
              ...current,
              stage: "error",
              busy: false,
              updateAvailable: false,
              message: t("shell.updateFailed"),
              details: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }

  async function handleTitlebarClientUpdateInstall() {
    const desktop = readDesktopApi();
    if (!desktop?.installClientUpdate || clientUpdate?.stage !== "downloaded") return;
    const confirmed = await confirm({
      title: t("confirm.installClientUpdateTitle"),
      body: t("confirm.restartInterruptsBody"),
      confirmLabel: t("common.install"),
    });
    if (confirmed !== "primary") return;
    try {
      setClientUpdate(await desktop.installClientUpdate());
    } catch (error) {
      setClientUpdate((current) =>
        current
          ? {
              ...current,
              stage: "error",
              busy: false,
              updateAvailable: Boolean(current.downloadUrl),
              downloaded: false,
              canAutoInstall: false,
              message: t("shell.installUpdateFailed"),
              details: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }

  const {
    runningThreadIds,
    runningThreadSet,
    activeThreadIsRunning,
    activeThreadCanStop,
    queuedInstructions,
    queuePrompt,
    removeQueuedInstruction,
    updateQueuedInstruction,
    moveQueuedInstruction,
    guideQueuedInstruction,
    submitQueuedInstructionNow,
    runAskTurn,
    stopActiveTurn,
  } = useAppThreadRunner({
    t,
    queryClient,
    threadId,
    messages,
    threads,
    runs,
    events,
    model,
    reasoningEffort,
    responseSpeed,
    budgetLimitUsd: chatKernelCapabilityUi.canShowBudgetControls ? budgetLimitUsd : null,
    accessMode,
    planMode: effectivePlanMode,
    goalMode: effectiveGoalMode,
    setSending,
    appendMessageToThread,
    appendAssistantMessageToThread,
    updateThreadMessage,
  });
  const currentThreadRunIds = useMemo(() => collectMessageRunIds(messages), [messages]);
  const hasThreadActivity = messages.length > 0 || activeThreadIsRunning;
  const latestRun = resolveLatestRun(runs, workingState.sessionId, currentThreadRunIds, hasThreadActivity);
  const currentThreadContextRunIds = useMemo(
    () => contextUsageRunIds(currentThreadRunIds, latestRun),
    [currentThreadRunIds, latestRun],
  );
  const contextUsage = useMemo(
    () => latestContextUsage(events, { runIds: currentThreadContextRunIds }),
    [events, currentThreadContextRunIds],
  );
  const currentSession = resolveCurrentSession(sessions, workingState, threadId, latestRun, hasThreadActivity);
  const runtimeBlocker = resolveLatestRuntimeBlocker(executions, latestRun?.sessionId || currentSession?.id || "");
  const activeWorkspaceRoot = bridgeSettings?.workspaceRoot || "";
  const canChooseLocalDirectory = healthQuery.data?.capabilities?.desktop?.directoryPicker === true;
  const roomsRuntimeReady = Boolean(hydratedBridgeSettings && (settingsQuery.data || healthQuery.data));
  const {
    appCreateDialogOpen,
    appDraftDescription,
    appDraftPath,
    appDraftTitle,
    appCreatePending,
    appFolderPickerPending,
    chooseAppImportFolder,
    closeAppCreateDialog,
    openAppCreateDialog,
    requestAppBuilderFromDialog,
    setAppCreateDialogState,
    setAppDraftDescription,
    setAppDraftPath,
    setAppDraftTitle,
  } = useAppCreateWorkflow({
    notify: {
      error: (message) => toast({ kind: "error", title: message }),
      success: (message) => toast({ kind: "success", title: message }),
    },
    askGroveForLocalFolderHelp,
    canChooseLocalDirectory,
    chooseWorkspaceBridgeOutdatedMessage: t("system.chooseWorkspaceBridgeOutdated"),
    folderTitleFromPath,
    onAppCreated: (appId) => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
      window.setTimeout(() => selectMountedApp(appId), 120);
    },
    setConversationSortMenuOpen,
    setProjectMenuOpenId,
    setRoomsAppView,
    setRoomsFocusRoomId,
    setView,
  });
  const chatModelBindingKey = modelBindingKey(chatKernel, chatRuntimeControls?.source);
  const voiceInput = useVoiceInput({
    voiceSettings: bridgeSettings?.voice,
    copy: {
      browserUnavailable: t("shell.voiceBrowserUnavailable"),
      mediaUnavailable: t("shell.voiceMediaUnavailable"),
      transcriptionFailed: (message) => t("shell.voiceTranscriptionFailed", { message }),
      recordingFailed: (message) => t("shell.voiceRecordingFailed", { message }),
    },
    onTranscript: appendVoiceTranscript,
    onSystemMessage: (message) => appendMessage("system", message),
  });
  const sidebarProjects = useMemo(() => {
    const conversationThreads = threads.filter((thread) => !thread.id.startsWith("app_thread"));
    const tree = buildSidebarProjectTree(projects, conversationThreads, projectId, threadId, messages);
    return tree.map((project) => ({
      ...project,
      threads: sortSidebarThreads(project.threads, conversationSortKey),
    }));
  }, [projects, threads, projectId, threadId, messages, conversationSortKey]);
  const projectCollapsedSet = useMemo(() => new Set(projectCollapsedIds), [projectCollapsedIds]);
  const allProjectsCollapsed =
    sidebarProjects.length > 0 && sidebarProjects.every((project) => projectCollapsedSet.has(project.id));
  const currentProjectTitle = useMemo(
    () => projects.find((project) => project.id === projectId)?.title || APP_PRODUCT_NAME,
    [projectId, projects],
  );
  useEffect(() => {
    if (activeView !== "chat") return;
    const availableModels = modelOptionsForKernel(chatKernel, chatRuntimeControls);
    const storedModel = readStoredModelBindings()[chatModelBindingKey];
    const storedOption = storedModel
      ? availableModels.find((item) => modelOptionMatchesId(item, storedModel))
      : undefined;
    if (storedOption) {
      if (model !== storedOption.id) setModel(storedOption.id);
      return;
    }
    const selectedOption = availableModels.find((item) => modelOptionMatchesId(item, model));
    if (!selectedOption) {
      const fallback = availableModels[0]?.id ?? DEFAULT_MODEL_ID;
      setModel(fallback);
      writeStoredModelBinding(chatModelBindingKey, fallback);
      return;
    }
    if (selectedOption.id !== model) setModel(selectedOption.id);
    writeStoredModelBinding(chatModelBindingKey, selectedOption.id);
  }, [activeView, chatKernel, chatRuntimeControls, chatModelBindingKey, model, setModel]);

  useEffect(() => {
    const scrollEl = activeView === "chat" ? threadScrollRef.current : null;
    if (!scrollEl) return;
    const frameId = window.requestAnimationFrame(() => {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeView, activeThreadIsRunning, messages, threads]);

  const settingsMutation = useMutation({
    mutationFn: (payload: {
      developerMode?: BridgeSettings["developerMode"];
      directKernelChatEnabled?: BridgeSettings["directKernelChatEnabled"];
      languagePreference?: BridgeSettings["languagePreference"];
      systemLanguage?: BridgeSettings["systemLanguage"];
      kernel?: KernelPreference;
      workspaceRoot?: BridgeSettings["workspaceRoot"];
      mountedApps?: BridgeSettings["mountedApps"];
      kernelProxy?: BridgeSettings["kernelProxy"];
      appStore?: BridgeSettings["appStore"];
      appUpdates?: BridgeSettings["appUpdates"];
      voice?: BridgeSettings["voice"];
      kernelPathOverrides?: BridgeSettings["kernelPathOverrides"];
      modelProviderBindings?: BridgeSettings["modelProviderBindings"];
      customProviders?: BridgeSettings["customProviders"];
    }) => patchJson<BridgeSettingsResponse>("/settings", payload),
    onMutate(payload) {
      const previousSettings = queryClient.getQueryData<BridgeSettingsResponse>(["settings"]);
      queryClient.setQueryData<BridgeSettingsResponse>(["settings"], (current) =>
        current
          ? {
              ...current,
              settings: { ...current.settings, ...payload },
            }
          : current,
      );
      return {
        previousSettings,
        previousLanguagePreference: payload.languagePreference ? languagePreference : undefined,
      };
    },
    onSuccess(result, payload) {
      queryClient.setQueryData(["settings"], result);
      if (payload.appUpdates?.automatic === true) {
        // Re-enabling clears the server-side check cursor. This authenticated
        // request supplies the credentials needed to schedule the fresh check.
        queryClient.invalidateQueries({ queryKey: ["client-update"] });
      }
      if (payload.customProviders !== undefined) {
        queryClient.invalidateQueries({ queryKey: ["provider-models"] });
      }
      if (payload.kernelPathOverrides !== undefined) {
        queryClient.invalidateQueries({ queryKey: ["kernel-logins"] });
      }
      if (payload.customProviders !== undefined || payload.modelProviderBindings !== undefined) return;
      queryClient.invalidateQueries({ queryKey: ["health"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["extensions"] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
    },
    onError(error, _payload, context) {
      if (context?.previousSettings) queryClient.setQueryData(["settings"], context.previousSettings);
      if (context?.previousLanguagePreference) {
        setLanguagePreference(context.previousLanguagePreference);
      }
      const message = systemDetail(error);
      toast({ kind: "error", title: t("system.saveSettingsFailed", { message }) });
    },
  });

  useEffect(() => {
    const hostPreference = bridgeSettings?.languagePreference;
    if (hostPreference && hostPreference !== languagePreference) {
      setLanguagePreference(hostPreference);
      return;
    }
    const backfill = nextLanguageSettingsBackfill({
      hostPreference,
      hostSystemLanguage: bridgeSettings?.systemLanguage,
      localPreference: languagePreference,
      detectedSystemLanguage: detectSystemLanguage(),
      settingsAvailable: Boolean(settingsQuery.data?.settings),
      mutationPending: settingsMutation.isPending,
      lastAttemptKey: languageSettingsBackfillAttemptRef.current,
    });
    if (!backfill) return;
    languageSettingsBackfillAttemptRef.current = backfill.attemptKey;
    settingsMutation.mutate(backfill.patch);
  }, [
    bridgeSettings?.languagePreference,
    bridgeSettings?.systemLanguage,
    languagePreference,
    setLanguagePreference,
    settingsMutation.isPending,
    settingsQuery.data?.settings,
  ]);

  const extensionActionMutation = useMutation({
    mutationFn: (payload: { path: string; body: Record<string, unknown> }) => postJson<any>(payload.path, payload.body),
    onSuccess(result) {
      if (result?.extensions) {
        queryClient.setQueryData(["inventory"], (previous: any) =>
          previous ? { ...previous, extensions: result.extensions } : previous,
        );
        queryClient.setQueriesData({ queryKey: ["extensions"] }, (previous: any) =>
          previous ? { ...previous, extensions: result.extensions } : previous,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["extensions"] });
    },
    onError(error) {
      toast({
        kind: "error",
        title: t("system.extensionActionFailed", { message: systemDetail(error) }),
      });
    },
  });

  const openExtensionLocalPathMutation = useMutation({
    mutationFn: (path: string) => postJson<any>("/extensions/open-local-path", { path }),
    onError(error) {
      toast({
        kind: "error",
        title: t("system.openLocalFolderFailed", { message: systemDetail(error) }),
      });
    },
  });

  async function pickWorkspaceDirectory(): Promise<string | undefined> {
    setWorkspacePickerPending(true);
    try {
      const result = await postJson<WorkspaceDirectoryResponse>("/workspace/choose-directory", {});
      if (result.cancelled) {
        return undefined;
      }
      if (!result.ok || !result.path) {
        throw new Error(result.error || "directory_picker_failed");
      }
      return result.path;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = systemDetail(error);
      toast({
        kind: "error",
        title:
          rawMessage === "not_found"
            ? t("system.chooseWorkspaceBridgeOutdated")
            : t("system.chooseWorkspaceFailed", { message }),
      });
      return undefined;
    } finally {
      setWorkspacePickerPending(false);
    }
  }

  function folderTitleFromPath(path: string): string {
    const normalized = path.replace(/[\\/]+$/, "");
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || normalized || t("conversation.newProject");
  }

  function syncProjectWorkspace(projectIdToSync: string | undefined) {
    const workspaceRoot = projects.find((project) => project.id === projectIdToSync)?.workspaceRoot;
    if (workspaceRoot && workspaceRoot !== activeWorkspaceRoot) {
      settingsMutation.mutate({ workspaceRoot });
    }
  }

  const installKernelMutation = useMutation({
    mutationFn: (payload: { kernelId: string; actionId: string }) =>
      postJson<KernelInstallResponse>("/settings/install-kernel", payload),
    onSuccess(result, variables) {
      if (result.settings) {
        queryClient.setQueryData(["settings"], { ok: true, settings: result.settings });
      }
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["provider-models"] });
      queryClient.invalidateQueries({ queryKey: ["health"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      toast({
        kind: result.degraded ? "info" : "success",
        title: result.degraded
          ? t("system.kernelInstallNeedsRestart", { kernelId: variables.kernelId })
          : t("system.kernelInstallSucceeded", { kernelId: variables.kernelId }),
      });
    },
    onError(error, variables) {
      toast({
        kind: "error",
        title: t("system.kernelInstallFailed", {
          kernelId: variables.kernelId,
          message: systemDetail(error),
        }),
      });
    },
  });

  const kernelLoginMutation = useMutation({
    mutationFn: (payload: { kernelId: string; action: "login" | "logout" }) =>
      postJson<KernelLoginActionResponse>(
        `/settings/kernel-logins/${encodeURIComponent(payload.kernelId)}/${payload.action}`,
        {},
      ),
    onSuccess(result) {
      if (!result.session) return;
      queryClient.setQueryData<KernelLoginSessionResponse>(["kernel-login-session", result.session.id], {
        ok: true,
        session: result.session,
      });
      setKernelLoginSessionId(result.session.id);
    },
    onError(error) {
      toast({ kind: "error", title: systemDetail(error) });
    },
  });

  const approvalsMutation = useMutation({
    mutationFn: async ({
      approvalId,
      action,
      response,
    }: {
      approvalId: string;
      action: "approve" | "reject" | "cancel";
      response?: unknown;
    }) =>
      postJson<any>(
        `/approvals/${encodeURIComponent(approvalId)}/${action}`,
        response !== undefined ? { response } : {},
      ),
    onSuccess(result, variables) {
      queryClient.setQueryData(["approvals"], { ok: true, approvals: result.approvals || [] });
      mergeFinalDataIntoCache(queryClient, result);
      const currentMessages = useUiStore.getState().messages.map(cloneMessage);
      const updated = applyApprovalResultToMessages(currentMessages, variables.approvalId, result, variables.action);
      if (updated) {
        replaceMessages(currentMessages);
      } else {
        appendMessage("system", buildApprovalResolutionMessage(result, variables.action));
      }
      queryClient.invalidateQueries({ queryKey: ["events"] });
    },
    onError(error) {
      toast({
        kind: "error",
        title: t("system.resolveApprovalFailed", { message: systemDetail(error) }),
      });
    },
  });

  const questionsMutation = useMutation({
    mutationFn: async ({
      questionId,
      action,
      response,
    }: {
      questionId: string;
      action: "answer" | "decline" | "cancel";
      response?: unknown;
    }) =>
      postJson<any>(
        `/questions/${encodeURIComponent(questionId)}/${action}`,
        response !== undefined ? { response } : {},
      ),
    onSuccess(result, variables) {
      queryClient.setQueryData(["questions"], { ok: true, questions: result.questions || [] });
      mergeFinalDataIntoCache(queryClient, result);
      const currentMessages = useUiStore.getState().messages.map(cloneMessage);
      const updated = applyQuestionResultToMessages(currentMessages, variables.questionId, result, variables.action);
      if (updated) {
        replaceMessages(currentMessages);
      }
      queryClient.invalidateQueries({ queryKey: ["events"] });
    },
    onError(error) {
      toast({
        kind: "error",
        title: t("system.resolveQuestionFailed", { message: systemDetail(error) }),
      });
    },
  });

  const createArtifactMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => postJson<any>("/artifacts", payload),
    onSuccess() {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
    },
  });

  function openNewThread(targetProjectId?: string) {
    const nextProjectId = targetProjectId || projectId;
    startNewThread(nextProjectId);
    syncProjectWorkspace(nextProjectId);
    setProjectMenuOpenId("");
    resetComposerDraft();
  }

  function updateDirectKernelChatSelection(patch: Partial<DirectKernelChatSelection>) {
    setDirectKernelChatSelection((current) => {
      const next = { ...current, ...patch };
      writeDirectKernelChatSelection(threadId, next);
      return next;
    });
  }

  function openNewProject() {
    startNewProject({ workspaceRoot: activeWorkspaceRoot || undefined });
    resetComposerDraft();
  }

  async function openFolderProject() {
    const workspaceRoot = await pickWorkspaceDirectory();
    if (!workspaceRoot) {
      return;
    }
    startNewProject({
      title: folderTitleFromPath(workspaceRoot),
      workspaceRoot,
    });
    settingsMutation.mutate({ workspaceRoot });
    setProjectMenuOpenId("");
    setConversationSortMenuOpen(false);
    resetComposerDraft();
  }

  function openThread(nextThreadId: string) {
    const nextProjectId = threads.find((thread) => thread.id === nextThreadId)?.projectId;
    selectThread(nextThreadId);
    syncProjectWorkspace(nextProjectId);
    setProjectMenuOpenId("");
    resetComposerDraft();
  }

  async function deleteThreadWithConfirm(thread: UiThread) {
    if (thread.id.startsWith("empty:") || runningThreadSet.has(thread.id)) {
      return;
    }
    const ok = await confirm({
      title: t("confirm.deleteThreadTitle"),
      body: t("conversation.deleteThreadConfirm", { title: thread.title || t("conversation.newThreadFallback") }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (ok !== "primary") {
      return;
    }
    deleteThreadFromStore(thread.id);
  }

  async function deleteProjectWithConfirm(project: UiProject & { threads: UiThread[] }) {
    if (project.threads.some((thread) => runningThreadSet.has(thread.id))) {
      return;
    }
    const realThreadCount = project.threads.filter((thread) => !thread.id.startsWith("empty:")).length;
    const ok = await confirm({
      title: t("confirm.deleteProjectTitle"),
      body: t("conversation.deleteProjectConfirm", { title: project.title, count: realThreadCount }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (ok !== "primary") {
      return;
    }
    setProjectMenuOpenId("");
    deleteProjectFromStore(project.id);
  }

  function renameProjectTitle(projectId: string, title: string) {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      return;
    }
    renameProject(projectId, trimmedTitle);
    setProjectMenuOpenId("");
  }

  async function changeProjectFolder(project: UiProject) {
    const workspaceRoot = await pickWorkspaceDirectory();
    if (!workspaceRoot) {
      setProjectMenuOpenId("");
      return;
    }
    setProjectWorkspaceRoot(project.id, workspaceRoot);
    if (project.id === projectId) {
      settingsMutation.mutate({ workspaceRoot });
    }
    setProjectMenuOpenId("");
  }

  async function saveImageAsArtifact(image: { src: string; alt: string }) {
    try {
      const title = image.alt || fileNameFromAssetUri(image.src) || t("system.imageArtifact");
      const result = await createArtifactMutation.mutateAsync({
        type: "image",
        title,
        tags: ["image", "chat-image"],
        data: {
          imageUri: image.src,
          alt: image.alt,
          fileName: fileNameFromAssetUri(image.src),
          mimeType: mimeTypeFromAssetUri(image.src),
        },
        assets: [
          {
            kind: "image",
            uri: image.src,
            title,
            mimeType: mimeTypeFromAssetUri(image.src),
          },
        ],
        preview: {
          title,
          text: image.alt,
          imageUri: image.src,
          status: "saved",
        },
        provenance: {
          source: "chat-message",
          threadId,
        },
      });
      toast({ kind: "success", title: t("system.savedArtifact", { title: result.artifact?.title || title }) });
      mergeFinalDataIntoCache(queryClient, result);
    } catch (error) {
      toast({ kind: "error", title: t("system.saveImageFailed", { message: systemDetail(error) }) });
    }
  }

  function applySlashCommand(command: { name: string; source?: string }) {
    setForceSlashMenuOpen(false);
    if (command.source === "opengrove" && command.name === "tools") {
      appendMessage("system", buildConnectedToolsStatus(activeKernel, activeKernelOption?.capabilityReport));
      insertPrompt("");
      return;
    }
    if (command.name === "compact") {
      if (activeKernel === "codex") {
        void submitPrompt("/compact");
        return;
      }
      void compactCurrentThread();
      return;
    }
    insertPrompt(`/${command.name} `);
  }

  async function compactCurrentThread() {
    try {
      const result = await compactAskSession({
        threadId,
        reason: "Manual compaction requested from the composer.",
      });
      if (!result.ok || !result.compacted) {
        appendMessage(
          "system",
          t("shell.compactFailed", {
            message: rawDiagnosticText(result.error),
          }),
        );
        return;
      }
      appendMessage("system", t("shell.compactDone"));
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    } catch (error) {
      appendMessage("system", t("shell.compactFailed", { message: systemDetail(error) }));
    }
  }

  async function submitPrompt(prompt: string) {
    if (chatKernelOption && !chatKernelOption.available) {
      return;
    }
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return;
    }
    if (activeThreadCanStop) {
      queuePrompt(threadId, trimmedPrompt, {
        kernel: chatKernel,
        providerId: chatProviderId || undefined,
      });
      return;
    }
    setQuestion("");
    setComposerSkillInvocation(null);
    setActiveSlashIndex(0);
    setModelMenuKind(null);
    await runAskTurn(trimmedPrompt, null, [], {
      kernel: chatKernel,
      providerId: chatProviderId || undefined,
    });
  }

  async function sendAsk() {
    const trimmedQuestion = question.trim();
    const requestedSkill = composerSkillInvocation
      ? {
          name: composerSkillInvocation.name,
          args: trimmedQuestion,
        }
      : undefined;
    const turnAttachments = attachments;
    const turnArtifacts = contextArtifacts;
    const contextPayload = buildContextPayload(contextText, turnAttachments, turnArtifacts);
    if (
      !requestedSkill &&
      !trimmedQuestion &&
      !contextPayload.text.trim() &&
      !turnAttachments.length &&
      !turnArtifacts.length
    ) {
      appendMessage("system", t("system.inputRequired"));
      return;
    }

    const userContext =
      contextPayload.text.trim() || turnAttachments.length || turnArtifacts.length ? contextPayload : null;
    const userPrompt = requestedSkill
      ? composeSkillPrompt(requestedSkill.name, trimmedQuestion).trim()
      : trimmedQuestion ||
        (turnAttachments.length || turnArtifacts.length
          ? t("system.defaultAttachmentPrompt")
          : t("system.defaultTextPrompt"));
    clearContext();
    resetComposerDraft();
    await runAskTurn(userPrompt, userContext, turnAttachments, {
      requestedSkill,
      kernel: chatKernel,
      providerId: chatProviderId || undefined,
    });
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposingText || event.nativeEvent.isComposing || event.key === "Process") {
      return;
    }
    if (composerSkillInvocation && event.key === "Backspace" && !composerQuestionValue) {
      event.preventDefault();
      setComposerSkillInvocation(null);
      setActiveSlashIndex(0);
      return;
    }
    if (showSlashPalette && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSlashIndex((current) => (current + 1) % slashMenuItemCount);
      return;
    }
    if (showSlashPalette && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSlashIndex((current) => (current - 1 + slashMenuItemCount) % slashMenuItemCount);
      return;
    }
    if (showSlashPalette && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
      event.preventDefault();
      const selectedIndex = clamp(activeSlashIndex, 0, slashMenuItemCount - 1);
      if (selectedIndex < matchingSlashCommands.length) {
        const selectedCommand = matchingSlashCommands[selectedIndex];
        if (selectedCommand) {
          applySlashCommand(selectedCommand);
        }
      } else {
        const selectedSkill = matchingSkills[selectedIndex - matchingSlashCommands.length];
        if (selectedSkill) {
          applySkillSuggestion(selectedSkill);
        }
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendAsk();
    }
    if (event.key === "Escape" && showSlashPalette) {
      event.preventDefault();
      dismissSlashPalette();
    }
  }

  function toggleAllProjectsCollapsed() {
    setProjectMenuOpenId("");
    setConversationSortMenuOpen(false);
    if (allProjectsCollapsed) {
      setProjectCollapsedIds(
        projectCollapseSnapshotIds.filter((id) => sidebarProjects.some((project) => project.id === id)),
      );
      return;
    }
    setProjectCollapseSnapshotIds(projectCollapsedIds);
    setProjectCollapsedIds(sidebarProjects.map((project) => project.id));
  }

  function openConversationSortMenu() {
    setProjectMenuOpenId("");
    setConversationSortMenuOpen((current) => !current);
  }

  const mountedAppHostState = resolveMountedAppHostState({
    activeView,
    hasActiveMountedApp: Boolean(activeMountedApp),
    hasUnresolvedMountedAppRequest: Boolean(unresolvedMountedAppRequestId),
    inventoryError: inventoryQuery.isError,
    inventoryFetching: inventoryQuery.isFetching,
    inventoryPending: inventoryQuery.isPending,
  });
  const activeRailSection = railSectionForView(activeView);
  const effectiveRoomsAppView: RoomsAppView = activeView === "contacts" ? "contacts" : roomsAppView;

  const activeThreadQueuedInstructions = queuedInstructions
    .filter((item) => item.threadId === threadId)
    .map((item) => ({ id: item.id, prompt: item.prompt, status: item.status, lastError: item.lastError }));

  const renderSharedThreadShell = (threadMessages = messages) => (
    <ThreadShell
      messages={threadMessages}
      projectTitle={currentProjectTitle}
      workspaceRoot={activeWorkspaceRoot}
      skills={skills}
      runtimeEvents={events}
      runs={runs}
      pendingQuestionIds={pendingQuestionIds}
      onResolveApproval={(approvalId, action, response) =>
        approvalsMutation.mutateAsync({ approvalId, action, response })
      }
      onResolveQuestion={(questionId, action, response) =>
        questionsMutation.mutateAsync({ questionId, action, response })
      }
      onInsertPrompt={insertPrompt}
      onSubmitPrompt={bridgeSettings?.kernelUnavailableReason ? undefined : (prompt) => void submitPrompt(prompt)}
      onSaveImageArtifact={saveImageAsArtifact}
    />
  );

  const renderSharedComposer = () => (
    <ChatComposer
      sending={activeThreadCanStop}
      unavailableReason={bridgeSettings?.kernelUnavailableReason}
      contextText={contextText}
      attachments={attachments}
      contextArtifacts={contextArtifacts}
      composerSkillInvocation={composerSkillInvocation}
      composerQuestionValue={composerQuestionValue}
      composerHeight={composerHeight}
      model={model}
      activeKernel={chatKernel}
      runtimeControls={chatRuntimeControls}
      contextUsage={contextUsage}
      effort={reasoningEffort}
      responseSpeed={responseSpeed}
      budgetLimitUsd={budgetLimitUsd}
      accessMode={accessMode}
      modelMenuKind={modelMenuKind}
      modelMenuPlacement={modelMenuPlacement}
      planMode={planMode}
      goalMode={goalMode}
      canShowPlanMode={chatKernelCapabilityUi.canShowPlanMode}
      canShowGoalMode={chatKernelCapabilityUi.canShowGoalMode}
      canShowReasoningControls={chatKernelCapabilityUi.canShowReasoningControls}
      canShowSpeedControls={chatKernelCapabilityUi.canShowSpeedControls}
      canShowBudgetControls={chatKernelCapabilityUi.canShowBudgetControls}
      canGuideQueuedInstruction={chatKernelCapabilityUi.canGuideActiveTurn && activeThreadCanStop}
      queuedInstructions={activeThreadQueuedInstructions}
      composerInputRef={composerInputRef}
      fileInputRef={fileInputRef}
      modelMenuRef={modelMenuRef}
      onPointerDown={onComposerPointerDown}
      onClearContext={clearContext}
      onRemoveContextArtifact={removeContextArtifact}
      onRemoveAttachment={removeAttachment}
      onQuestionChange={handleQuestionChange}
      onKeyDown={handleComposerKeyDown}
      onPaste={handleComposerPaste}
      onCompositionStart={() => setIsComposingText(true)}
      onCompositionEnd={() => setIsComposingText(false)}
      onAttachmentInputChange={handleAttachmentInputChange}
      onOpenAttachmentPicker={openAttachmentPicker}
      onToggleModelMenu={toggleModelMenu}
      onTogglePlanMode={() => setPlanMode((current) => !current)}
      onToggleGoalMode={() => setGoalMode((current) => !current)}
      onGuideQueuedInstruction={(id) => void guideQueuedInstruction(id)}
      onRemoveQueuedInstruction={removeQueuedInstruction}
      onUpdateQueuedInstruction={updateQueuedInstruction}
      onMoveQueuedInstruction={moveQueuedInstruction}
      onSubmitQueuedInstructionNow={(id) => void submitQueuedInstructionNow(id)}
      onSetModel={(nextModel) => {
        setModel(nextModel);
        writeStoredModelBinding(chatModelBindingKey, nextModel);
        setModelMenuKind(null);
      }}
      onSetEffort={setReasoningEffort}
      onSetResponseSpeed={setResponseSpeed}
      onSetBudgetLimitUsd={setBudgetLimitUsd}
      onSetAccessMode={setAccessMode}
      onSubmitOrStop={() => (activeThreadCanStop ? stopActiveTurn() : void sendAsk())}
      onRemoveSkillInvocation={removeSkillInvocation}
      voiceInput={{
        state: voiceInput.state,
        error: voiceInput.error,
        onToggle: () => void voiceInput.toggle(),
      }}
      skillMenu={
        showSlashPalette ? (
          <SlashCommandMenu
            commands={matchingSlashCommands}
            skills={matchingSkills}
            activeIndex={activeSlashIndex}
            onSelectCommand={applySlashCommand}
            onSelect={applySkillSuggestion}
          />
        ) : null
      }
      onSkillMenuOpenChange={(open) => {
        if (!open) dismissSlashPalette();
      }}
    />
  );

  function requestAppStorePublishLeave(onLeave: () => void) {
    if (!appStorePublishDirty) {
      onLeave();
      return;
    }
    void confirm({
      title: t("appStore.version.unsavedTitle"),
      body: t("appStore.release.unsavedLeaveBody"),
      confirmLabel: t("appStore.version.goSave"),
      alternateLabel: t("appStore.release.discardAndLeave"),
      alternateDanger: true,
    }).then((result) => {
      if (result !== "alternate") return;
      setAppStorePublishDirty(false);
      onLeave();
    });
  }

  function applyRailSection(section: RailSectionId) {
    setMountedAppVersionManagementId("");
    setProjectMenuOpenId("");
    setConversationSortMenuOpen(false);
    if (settingsReady && section === "chat" && !directKernelChatEnabled) {
      setView(mountedApps[0] ? "app" : "app-store");
      return;
    }
    if (settingsReady && !developerMode && developerOnlyRailSection(section)) {
      setView(mountedApps[0] ? "app" : "app-store");
      return;
    }
    if (section === "chat") {
      setView("chat");
    } else if (section === "rooms") {
      setView(roomsAppView === "contacts" ? "contacts" : "rooms");
    } else if (section === "ops") {
      setView("ops");
    } else if (section === "extensions") {
      setView("extensions");
    } else if (section === "network") {
      setView("app-store");
    } else if (section === "apps") {
      if (mountedApps[0]) {
        setView("app");
      } else if (!developerMode) {
        setView("app-store");
      } else {
        openAppCreateDialog();
      }
    } else if (section === "settings") {
      setSettingsInitialSection(developerMode ? "kernels" : "mode");
      setView("settings");
    }
  }

  function openRailSection(section: RailSectionId) {
    requestAppStorePublishLeave(() => applyRailSection(section));
  }

  function openMountedAppVersionManagement(appId: string) {
    requestAppStorePublishLeave(() => {
      applyRailSection("network");
      setMountedAppVersionManagementId(appId);
    });
  }

  function openRoomsMessages(roomId?: string) {
    setProjectMenuOpenId("");
    setConversationSortMenuOpen(false);
    if (roomId !== undefined) {
      setRoomsFocusRoomId(roomId);
    }
    setRoomsAppView("messages");
    setView("rooms");
  }

  function openRoomsContacts() {
    setProjectMenuOpenId("");
    setConversationSortMenuOpen(false);
    setRoomsAppView("contacts");
    setView("contacts");
  }

  // 待审批计数点击：优先定位到包含待审批卡片的线程，其次定位到对应群聊，
  // 都找不到上下文时回到主对话视图（审批卡的默认落脚点）。
  function openPendingApprovals() {
    const approvalThread = threads.find((thread) => thread.messages.some(messageHasPendingApproval));
    if (approvalThread) {
      openThread(approvalThread.id);
      setView("chat");
      return;
    }
    const approvalRoom = roomsState.rooms.find(
      (room) => !isAppScopedRoomId(room) && room.messages.some(messageHasPendingApproval),
    );
    if (approvalRoom) {
      openRoomsMessages(approvalRoom.id);
      return;
    }
    setView("chat");
  }

  function hideRoomsOnboardingGuide() {
    setRoomsOnboardingGuideDismissed(true);
  }

  function completeRoomsOnboardingGuide() {
    window.localStorage.setItem(APP_STORAGE_KEYS.roomsOnboardingGuide, "dismissed");
    setRoomsOnboardingGuideDismissed(true);
  }

  if (desktopApi && desktopBridgeStartupGateRequired) {
    const blocker =
      desktopBridgeStartupState?.stage === "blocked"
        ? {
            code: desktopBridgeStartupState.code,
            message: desktopBridgeStartupState.message,
            actions: desktopBridgeStartupState.actions,
          }
        : undefined;
    return (
      <CloudAuthLoadingScreen
        blocker={blocker}
        recoveringLocalService
        migratingLocalData={desktopBridgeStartupState?.stage === "migrating"}
        onRetry={() => {
          void desktopApi.retryBridgeStartup?.();
        }}
      />
    );
  }

  // teamGateChecking joins this so a gated deployment does not flash the login
  // form for the moment before the gate answers.
  if (sessionAuthChecking || (teamGateChecking && (sessionAuthNeedsLogin || accountLoginRequested))) {
    return (
      <CloudAuthLoadingScreen
        onRetry={() => {
          if (healthQuery.data?.auth?.mode === "session") {
            void sessionQuery.refetch();
          } else {
            void healthQuery.refetch();
          }
        }}
      />
    );
  }

  // The team gate fronts sign-in, so it has to be answered before the login
  // form is worth showing. Checked only on the path that would show that form:
  // an already signed-in session keeps working (ww does not gate token refresh),
  // and interrupting it to demand a token would be pointless.
  if ((sessionAuthNeedsLogin || accountLoginRequested) && teamGateBlocksSignIn) {
    return (
      <TeamGateScreen
        pending={teamUnlockMutation.isPending}
        invalid={(teamUnlockMutation.error as { status?: number } | null)?.status === 401}
        unavailable={teamUnlockMutation.isError && (teamUnlockMutation.error as { status?: number }).status !== 401}
        onSubmit={(token) => teamUnlockMutation.mutate(token)}
        onResetError={() => teamUnlockMutation.reset()}
      />
    );
  }

  // Past the gate, offer the test accounts before the email form. Proving team
  // membership already happened, so a verification code on top of it buys
  // nothing; email sign-in stays one click away for your own account or for
  // exercising the real chain.
  if (
    (sessionAuthNeedsLogin || accountLoginRequested) &&
    !emailLoginRequested &&
    devFixtureAccountSwitcherAvailable({
      isOfficialRelease: readDesktopApi()?.isOfficialRelease,
      sessionAuthActive: healthQuery.data?.auth?.mode === "session",
      teamGateSatisfied,
    })
  ) {
    return (
      <TeamAccountPickerScreen
        accounts={teamAccounts}
        loading={teamAccounts.length === 0 && !teamAccountsFailed}
        switchingEmail={authFixtureSwitchMutation.isPending ? authFixtureSwitchMutation.variables?.email : undefined}
        error={authFixtureSwitchMutation.error instanceof Error ? authFixtureSwitchMutation.error.message : ""}
        onPick={(email) => {
          authFixtureSwitchMutation.reset();
          authFixtureSwitchMutation.mutate({ email });
        }}
        onUseEmail={() => setEmailLoginRequested(true)}
      />
    );
  }

  if (sessionAuthNeedsLogin || accountLoginRequested) {
    const authError =
      authFixtureSwitchMutation.error instanceof Error
        ? authFixtureSwitchMutation.error
        : authLoginMutation.error instanceof Error
          ? authLoginMutation.error
          : authSendCodeMutation.error instanceof Error
            ? authSendCodeMutation.error
            : undefined;
    return (
      <CloudAuthScreen
        sendCodePending={authSendCodeMutation.isPending}
        sendCodeRequiresCountry={sendCodeRequiresCountry}
        sendCodeRequiresInvite={sendCodeRequiresInvite}
        sendCodeSuccessCount={sendCodeSuccessCount}
        loginPending={authLoginMutation.isPending}
        toastMessage={authToastMessage}
        error={authError?.message || (sessionAuthUnavailable ? sessionQuery.data?.error || "auth_unavailable" : "")}
        retryAfter={(authSendCodeMutation.error as { retryAfter?: number } | null)?.retryAfter}
        onSendCode={(payload) => authSendCodeMutation.mutate(payload)}
        onLogin={(payload) => authLoginMutation.mutate(payload)}
        onContinueWithoutAccount={desktopApi ? continueWithoutAccount : undefined}
        onResetSendCodeState={resetSendCodeState}
        onResetError={() => {
          authLoginMutation.reset();
          authSendCodeMutation.reset();
        }}
      />
    );
  }

  if (embeddedMountedAppMode) {
    return (
      <div className="embedded-mounted-app-shell" data-layout="embedded-app">
        <button
          className="app-titlebar-developer-button embedded-mounted-app-developer-button"
          data-open={mountedAppDeveloperModeOpen ? "true" : "false"}
          type="button"
          onClick={toggleMountedAppDeveloperMode}
          aria-label={mountedAppDeveloperModeOpen ? t("shell.exitAppDeveloperMode") : t("shell.enterAppDeveloperMode")}
          title={mountedAppDeveloperModeOpen ? t("shell.exitAppDeveloperMode") : t("shell.enterAppDeveloperMode")}
        >
          <Bot size={17} aria-hidden="true" />
          {mountedAppPendingCrewCount > 0 ? (
            <span
              className="app-titlebar-developer-badge"
              aria-label={t("shell.pendingReplyCount", { count: mountedAppPendingCrewCount })}
            />
          ) : null}
        </button>
        <MountedAppWorkspaceView
          app={activeMountedApp}
          embedded
          hostState={resolveMountedAppHostState({
            activeView: "app",
            hasActiveMountedApp: Boolean(activeMountedApp),
            hasUnresolvedMountedAppRequest: Boolean(unresolvedMountedAppRequestId),
            inventoryError: inventoryQuery.isError,
            inventoryFetching: inventoryQuery.isFetching,
            inventoryPending: inventoryQuery.isPending,
          })}
          inventoryRetrying={inventoryQuery.isFetching}
          onRetryInventory={() => void inventoryQuery.refetch()}
          chatPanelKey={`${roomsSessionKey}:${activeMountedApp?.name ?? "app"}`}
          developerModeOpen={mountedAppDeveloperModeOpen}
          runtimeEvents={events}
          pendingApprovals={pendingApprovals}
          pendingQuestionIds={pendingQuestionIds}
          roomsState={roomsState}
          roomsHydrated={roomsSnapshot.hydrated}
          setRoomsState={roomsActions.setRoomsState}
          onMarkRoomRead={roomsActions.markRoomRead}
          activeKernel={activeKernel}
          activeModel={model}
          extensions={extensionInventory}
          kernelOptions={bridgeSettings?.kernels ?? []}
          providers={bridgeSettings?.providers}
          modelProviderBindings={bridgeSettings?.modelProviderBindings}
          runtimeControls={activeRuntimeControls}
          runtimeControlsByKernel={runtimeControlsByKernel}
          skills={skills}
          onPendingCountChange={setMountedAppPendingCrewCount}
          onResolveApproval={(approvalId, action, response) =>
            approvalsMutation.mutateAsync({ approvalId, action, response })
          }
          onResolveQuestion={(questionId, action, response) =>
            questionsMutation.mutateAsync({ questionId, action, response })
          }
        />
      </div>
    );
  }

  const desktopRuntime = readDesktopApi();
  const desktopPlatform = desktopRuntime?.platform || "";

  return (
    <div
      className="app-shell react-app"
      data-view={activeView}
      data-rail-expanded={railExpanded ? "true" : "false"}
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      style={
        {
          "--opengrove-rail-width": railExpanded ? "126px" : "58px",
          "--opengrove-sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <AppTitlebar
        desktopPlatform={desktopPlatform}
        desktopFullscreen={desktopWindowFullscreen}
        officialRelease={desktopRuntime?.isOfficialRelease}
        railExpanded={railExpanded}
        onToggleRail={() => setRailExpanded(!railExpanded)}
        sourceUpdate={sourceUpdate}
        onSourceUpdate={handleTitlebarSourceUpdate}
        clientUpdate={clientUpdateQuery.data}
        desktopClientUpdate={clientUpdate}
        onClientUpdateInstall={handleTitlebarClientUpdateInstall}
        accountState={sessionAuthPendingLocallyAvailable ? "checking" : sessionAuthUnavailable ? "offline" : undefined}
        accountRetrying={sessionQuery.isFetching}
        accountErrorReference={
          sessionQuery.data?.incidentId ||
          sessionQuery.data?.traceId ||
          (sessionQuery.error instanceof BridgeRequestError
            ? sessionQuery.error.incidentId || sessionQuery.error.traceId
            : undefined)
        }
        onAccountRetry={() => void sessionQuery.refetch()}
        developerModeVisible={activeView === "app" && Boolean(activeMountedApp)}
        developerModeOpen={mountedAppDeveloperModeOpen}
        pendingDeveloperReplies={mountedAppPendingCrewCount}
        onToggleDeveloperMode={toggleMountedAppDeveloperMode}
      />
      <AppRail
        activeSection={activeRailSection}
        expanded={railExpanded}
        developerMode={railDeveloperMode}
        directKernelChatEnabled={railDirectKernelChatEnabled}
        authUser={sessionQuery.data?.user}
        fixtureAccountSwitchError={
          authFixtureSwitchMutation.error instanceof Error ? authFixtureSwitchMutation.error.message : ""
        }
        fixtureAccountSwitchingEmail={
          authFixtureSwitchMutation.isPending ? authFixtureSwitchMutation.variables?.email : undefined
        }
        onSwitchFixtureAccount={
          devFixtureAccountSwitcherAvailable({
            isOfficialRelease: readDesktopApi()?.isOfficialRelease,
            sessionAuthActive: healthQuery.data?.auth?.mode === "session",
            teamGateSatisfied,
          })
            ? (account) => {
                authFixtureSwitchMutation.reset();
                authFixtureSwitchMutation.mutate({ email: account.email });
              }
            : undefined
        }
        fixtureAccounts={teamAccounts}
        previousAccountEmail={previousAccountEmail}
        restoringPreviousAccount={teamRestoreMutation.isPending}
        onRestorePreviousAccount={
          previousAccountEmail
            ? () => {
                teamRestoreMutation.reset();
                teamRestoreMutation.mutate();
              }
            : undefined
        }
        onAuthExpired={showLoginExpiredToast}
        onLogin={
          healthQuery.data?.auth?.mode === "session" &&
          sessionQuery.data?.status === "unauthenticated" &&
          desktopAccountOnboardingCompleted
            ? () => setAccountLoginRequested(true)
            : undefined
        }
        onLogout={
          healthQuery.data?.auth?.mode === "session" && sessionQuery.data?.user
            ? () => authLogoutMutation.mutate()
            : undefined
        }
        mountedApps={mountedApps}
        activeMountedAppId={activeView === "app" ? activeMountedApp?.name : ""}
        mountedAppBadges={mountedAppUnreadBadges}
        sectionBadges={{
          rooms: { count: roomsUnreadCount },
          network: { count: availableAppStoreUpdateCount, variant: "danger" },
        }}
        onCreateApp={openAppCreateDialog}
        onSelectMountedApp={(appId) => {
          requestAppStorePublishLeave(() => {
            setMountedAppVersionManagementId("");
            selectMountedApp(appId);
          });
        }}
        onManageMountedAppVersions={openMountedAppVersionManagement}
        onEditMountedApp={setMountedAppSettingsId}
        onDeleteMountedApp={deleteMountedAppTab}
        onOpenSection={openRailSection}
        onOpenSettings={() => openRailSection("settings")}
      />

      <Dialog open={appCreateDialogOpen} onOpenChange={setAppCreateDialogState}>
        <DialogContent className="app-create-dialog" aria-label={t("app.createApp")}>
          <DialogTitle>{t("app.createApp")}</DialogTitle>
          <AppCreateWizard
            title={appDraftTitle}
            source={appDraftPath}
            description={appDraftDescription}
            loading={settingsQuery.isLoading}
            saving={settingsMutation.isPending || appCreatePending}
            localFolderPicking={appFolderPickerPending}
            canRequestAgent
            onTitleChange={setAppDraftTitle}
            onSourceChange={setAppDraftPath}
            onDescriptionChange={setAppDraftDescription}
            onChooseLocalFolder={chooseAppImportFolder}
            onCancel={closeAppCreateDialog}
            onRequestAgent={requestAppBuilderFromDialog}
            onOpenStore={() => {
              closeAppCreateDialog();
              openRailSection("network");
            }}
          />
        </DialogContent>
      </Dialog>
      <AppSettingsDialog
        app={mountedAppSettingsTarget}
        open={Boolean(mountedAppSettingsId)}
        onOpenChange={(open) => {
          if (!open) setMountedAppSettingsId("");
        }}
      />

      <aside className="sidebar" data-section={activeRailSection} aria-label={t("layout.sidebar")}>
        <nav className="nav-list" aria-label={t("layout.spaceNav")}>
          {activeRailSection === "chat" ? (
            <ConversationSidebar
              projects={sidebarProjects}
              activeThreadId={threadId}
              activeView={activeView}
              runningThreadIds={runningThreadIds}
              pendingApprovalCount={pendingApprovals.length}
              collapsedProjectIds={projectCollapsedSet}
              allProjectsCollapsed={allProjectsCollapsed}
              projectMenuOpenId={projectMenuOpenId}
              conversationSortMenuOpen={conversationSortMenuOpen}
              conversationSortKey={conversationSortKey}
              onToggleAllProjectsCollapsed={toggleAllProjectsCollapsed}
              onOpenConversationSortMenu={openConversationSortMenu}
              onCloseConversationSortMenu={() => setConversationSortMenuOpen(false)}
              onSortKeyChange={setConversationSortKey}
              onOpenNewProject={openNewProject}
              onOpenFolderProject={openFolderProject}
              onOpenNewThread={openNewThread}
              onOpenThread={openThread}
              onToggleProjectCollapsed={(projectId) =>
                setProjectCollapsedIds((ids) =>
                  ids.includes(projectId) ? ids.filter((id) => id !== projectId) : [...ids, projectId],
                )
              }
              onToggleProjectMenu={(projectId) =>
                setProjectMenuOpenId((current) => (current === projectId ? "" : projectId))
              }
              onCloseProjectMenu={() => setProjectMenuOpenId("")}
              onRenameProject={renameProjectTitle}
              onChangeProjectFolder={changeProjectFolder}
              onDeleteProject={deleteProjectWithConfirm}
              onDeleteThread={deleteThreadWithConfirm}
              folderProjectPending={workspacePickerPending || settingsMutation.isPending}
            />
          ) : null}
        </nav>
      </aside>

      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label={t("layout.resizeSidebar")}
        aria-orientation="vertical"
        onPointerDown={onSidebarResizePointerDown}
      />

      <MobileNav
        activeView={activeView}
        developerMode={railDeveloperMode}
        directKernelChatEnabled={railDirectKernelChatEnabled}
        activeMountedAppId={activeView === "app" ? activeMountedApp?.name : ""}
        mountedApps={mountedApps}
        onSelectMountedApp={(appId) => {
          requestAppStorePublishLeave(() => selectMountedApp(appId));
        }}
        onSelect={(view) => {
          if (view === "rooms") {
            requestAppStorePublishLeave(() => openRoomsMessages());
            return;
          }
          requestAppStorePublishLeave(() => setView(view));
        }}
      />

      <main className="workspace">
        {activeView === "chat" ? (
          <ChatWorkspaceView
            empty={messages.length === 0}
            resetKey={threadId}
            kernelId={chatKernel}
            kernelLabel={formatKernelLabel(chatKernel, t) || t("workspace.kernel")}
            providerId={chatProviderId}
            providerLabel={chatProviderLabel}
            kernelOptions={kernelOptions.map((kernel) => ({
              id: kernel.id,
              label: kernel.label,
              available: kernel.available,
            }))}
            providerOptions={chatProviderOptions}
            providerOptionsLoading={providerModelsPending}
            onSelectKernel={(kernelId) => updateDirectKernelChatSelection({ kernel: kernelId, providerId: "" })}
            onSelectProvider={(providerId) => updateDirectKernelChatSelection({ providerId })}
            openWorkbenchLabel={t("layout.openWorkbench")}
            closeWorkbenchLabel={t("layout.closeWorkbench")}
            workbenchLabel={t("layout.workbench")}
            conversationToolsLabel={t("shell.conversationTools")}
            threadScrollRef={threadScrollRef}
            thread={renderSharedThreadShell()}
            composer={renderSharedComposer()}
            inspector={
              <WorkspaceInspector
                workingState={workingState}
                currentSession={currentSession}
                latestRun={latestRun}
                runtimeBlocker={runtimeBlocker}
                kernelLabel={formatKernelLabel(chatKernel, t)}
                threadId={threadId}
                sending={activeThreadCanStop}
                messages={messages}
                artifacts={artifacts}
                skills={skills}
                tools={tools}
                events={events}
                pendingApprovals={pendingApprovals}
                onOpenChat={() => setView("chat")}
                onOpenPendingApprovals={openPendingApprovals}
              />
            }
          />
        ) : null}

        {activeView === "app" ? (
          <MountedAppWorkspaceView
            app={activeMountedApp}
            hostState={mountedAppHostState}
            inventoryRetrying={inventoryQuery.isFetching}
            onRetryInventory={() => void inventoryQuery.refetch()}
            chatPanelKey={`${roomsSessionKey}:${activeMountedApp?.name ?? "app"}`}
            developerModeOpen={mountedAppDeveloperModeOpen}
            runtimeEvents={events}
            pendingApprovals={pendingApprovals}
            pendingQuestionIds={pendingQuestionIds}
            roomsState={roomsState}
            roomsHydrated={roomsSnapshot.hydrated}
            setRoomsState={roomsActions.setRoomsState}
            onMarkRoomRead={roomsActions.markRoomRead}
            activeKernel={activeKernel}
            activeModel={model}
            extensions={extensionInventory}
            kernelOptions={bridgeSettings?.kernels ?? []}
            providers={hydratedBridgeSettings?.providers}
            modelProviderBindings={hydratedBridgeSettings?.modelProviderBindings}
            runtimeControls={activeRuntimeControls}
            runtimeControlsByKernel={runtimeControlsByKernel}
            skills={skills}
            onPendingCountChange={setMountedAppPendingCrewCount}
            onResolveApproval={(approvalId, action, response) =>
              approvalsMutation.mutateAsync({ approvalId, action, response })
            }
            onResolveQuestion={(questionId, action, response) =>
              questionsMutation.mutateAsync({ questionId, action, response })
            }
          />
        ) : null}

        {activeView === "extensions" ? (
          <ExtensionsView
            extensions={extensionsQuery.data?.extensions}
            settings={bridgeSettings}
            loading={extensionsQuery.isLoading || settingsQuery.isLoading || providerModelsPending}
            saving={settingsMutation.isPending}
            actionPending={extensionActionMutation.isPending}
            onOpenLocalPath={(path) => openExtensionLocalPathMutation.mutate(path)}
            onAction={(path, body) => extensionActionMutation.mutate({ path, body })}
          />
        ) : null}

        {activeView === "app-store" ? (
          <AppStoreView
            presentation="grove"
            settings={bridgeSettings}
            runtimeControls={activeRuntimeControls}
            runtimeControlsByKernel={runtimeControlsByKernel}
            skills={skills}
            authUser={sessionQuery.data?.user}
            onOpenInstalledApp={selectMountedApp}
            versionManagementAppId={mountedAppVersionManagementId}
            onCloseVersionManagement={() => setMountedAppVersionManagementId("")}
            onPublishDirtyChange={setAppStorePublishDirty}
          />
        ) : null}

        {activeView === "rooms" && effectiveRoomsAppView === "messages" && roomsRuntimeReady ? (
          <RoomsView
            key={roomsSessionKey}
            roomsSnapshot={roomsSnapshot}
            roomsActions={roomsActions}
            activeKernel={activeKernel}
            activeModel={model}
            activeWorkspaceRoot={activeWorkspaceRoot}
            extensions={extensionInventory}
            kernelOptions={bridgeSettings?.kernels ?? []}
            providers={bridgeSettings?.providers}
            modelProviderBindings={bridgeSettings?.modelProviderBindings}
            runtimeControls={activeRuntimeControls}
            runtimeControlsByKernel={runtimeControlsByKernel}
            skills={skills}
            runtimeEvents={events}
            runs={runs}
            pendingQuestionIds={pendingQuestionIds}
            focusRoomId={roomsFocusRoomId}
            onActiveRoomChange={setRoomsFocusRoomId}
            onboardingGuideVisible={shouldShowRoomsOnboardingGuide}
            onResolveApproval={(approvalId, action, response) =>
              approvalsMutation.mutateAsync({ approvalId, action, response })
            }
            onResolveQuestion={(questionId, action, response) =>
              questionsMutation.mutateAsync({ questionId, action, response })
            }
            onOpenContacts={openRoomsContacts}
            onDismissOnboardingGuide={hideRoomsOnboardingGuide}
            onCompleteOnboardingGuide={completeRoomsOnboardingGuide}
          />
        ) : activeView === "rooms" &&
          effectiveRoomsAppView === "messages" &&
          (healthQuery.isLoading || settingsQuery.isLoading || providerModelsPending) ? (
          <RoomsLoadingState />
        ) : activeView === "rooms" && effectiveRoomsAppView === "messages" ? (
          <RoomsUnavailableState
            healthLoading={healthQuery.isLoading}
            healthError={healthQuery.error instanceof Error ? healthQuery.error.message : ""}
            onboardingGuideVisible={shouldShowRoomsOnboardingGuide}
            onDismissOnboardingGuide={hideRoomsOnboardingGuide}
          />
        ) : null}

        {(activeView === "rooms" || activeView === "contacts") &&
        effectiveRoomsAppView === "contacts" &&
        providerModelsPending ? (
          <RoomsLoadingState />
        ) : (activeView === "rooms" || activeView === "contacts") && effectiveRoomsAppView === "contacts" ? (
          <ContactsView
            key={roomsSessionKey}
            activeKernel={activeKernel}
            activeModel={model}
            activeWorkspaceRoot={activeWorkspaceRoot}
            extensions={extensionInventory}
            kernelOptions={bridgeSettings?.kernels ?? []}
            providers={hydratedBridgeSettings?.providers}
            modelProviderBindings={hydratedBridgeSettings?.modelProviderBindings}
            runtimeControls={activeRuntimeControls}
            runtimeControlsByKernel={runtimeControlsByKernel}
            skills={skills}
            roomsState={roomsState}
            setRoomsState={roomsActions.setRoomsState}
            onOpenMessages={openRoomsMessages}
          />
        ) : null}

        {activeView === "settings" || activeView === "ops" ? (
          <SettingsDialog
            embedded
            initialSection={activeView === "ops" ? "ops" : settingsInitialSection}
            settings={providerModelsPending ? undefined : hydratedBridgeSettings}
            clientUpdate={clientUpdateQuery.data}
            clientUpdateLoading={clientUpdateQuery.isLoading}
            clientUpdateError={clientUpdateQuery.error ? systemDetail(clientUpdateQuery.error) : ""}
            onCheckClientUpdate={async () => {
              const result = await clientUpdateQuery.refetch();
              if (result.error) throw result.error;
            }}
            loading={settingsQuery.isLoading || providerModelsPending}
            saving={settingsMutation.isPending}
            installingKernelId={installKernelMutation.isPending ? installKernelMutation.variables?.kernelId : ""}
            kernelLogins={kernelLoginsQuery.data?.logins ?? []}
            kernelLoginsLoading={kernelLoginsQuery.isLoading}
            kernelLoginSession={kernelLoginSessionQuery.data?.session}
            kernelLoginActionPending={kernelLoginMutation.isPending}
            error={
              settingsQuery.error
                ? systemDetail(settingsQuery.error)
                : providerModelsQuery.error
                  ? systemDetail(providerModelsQuery.error)
                  : kernelLoginsQuery.error
                    ? systemDetail(kernelLoginsQuery.error)
                    : ""
            }
            onClose={() => setView(directKernelChatEnabled ? "chat" : mountedApps[0] ? "app" : "app-store")}
            onInstallKernel={(kernelId, actionId) => installKernelMutation.mutate({ kernelId, actionId })}
            onKernelLoginAction={(kernelId, action) => kernelLoginMutation.mutate({ kernelId, action })}
            onSave={(payload) =>
              settingsMutation.mutate({
                ...payload,
                systemLanguage: detectSystemLanguage(),
              })
            }
            ops={{
              runs,
              executions,
              approvals,
              events,
              skills,
              tools,
              selectedRunId: selectedOpsRunId,
              contextRecords,
              onSelectRun: setSelectedOpsRunId,
              onOpenApprovals: openPendingApprovals,
            }}
          />
        ) : null}
      </main>
    </div>
  );
}
