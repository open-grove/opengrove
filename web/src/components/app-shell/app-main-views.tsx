import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Bot, Files, ListChecks, Loader2, PanelsTopLeft } from "lucide-react";
import clsx from "clsx";
import type {
  AgentEventRecord,
  AttachmentPayload,
  ExtensionItemCollection,
  ExtensionItemRecord,
  KernelOption,
  KernelPreference,
  ModelId,
  ModelProviderBinding,
  ProviderProfile,
  RuntimeControls,
  SkillRecord,
} from "../../bridge";
import type { MountedAppHostState } from "../../app-mounted-app-workflow-model";
import { getJson, postJson } from "../../bridge";
import type { ApprovalRecord } from "../../bridge-inventory-types";
import { MountedAppChatPanel } from "../apps/mounted-app-chat-panel";
import { mountedAppUiRuntime, type MountedAppUiRuntime } from "../apps/mounted-app-model";
import { MountedMcpAppView } from "../apps/mounted-mcp-app-view";
import { MountedAppDeveloperLayout } from "../apps/mounted-app-developer-layout";
import { DirectKernelRuntimePicker, type DirectKernelRuntimeOption } from "../chat/direct-kernel-runtime-picker";
import { MountedAppWorkbench } from "../apps/mounted-app-workbench";
import { rawDiagnosticText, useI18n } from "../../i18n";
import type { RoomsState } from "../rooms/rooms-model";

export function ChatWorkspaceView(props: {
  empty: boolean;
  resetKey?: string;
  kernelId?: KernelPreference | string;
  kernelLabel: string;
  providerId: string;
  providerLabel: string;
  kernelOptions: DirectKernelRuntimeOption[];
  providerOptions: DirectKernelRuntimeOption[];
  providerOptionsLoading?: boolean;
  onSelectKernel(kernelId: string): void;
  onSelectProvider(providerId: string): void;
  openWorkbenchLabel: string;
  closeWorkbenchLabel: string;
  workbenchLabel: string;
  conversationToolsLabel: string;
  threadScrollRef: RefObject<HTMLElement | null>;
  thread: ReactNode;
  composer: ReactNode;
  inspector: ReactNode;
}) {
  const { t } = useI18n();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const inspectorLabel = inspectorOpen ? props.closeWorkbenchLabel : props.openWorkbenchLabel;

  useEffect(() => {
    setInspectorOpen(false);
  }, [props.resetKey]);

  return (
    <DialogPrimitive.Root open={inspectorOpen} onOpenChange={setInspectorOpen} modal={false}>
      <section className="view-panel chat-view" data-view="chat" data-empty={props.empty ? "true" : "false"}>
        <div className="workspace-overlay-controls chat-frame-controls" aria-label={props.conversationToolsLabel}>
          <DirectKernelRuntimePicker
            t={t}
            kernelId={String(props.kernelId ?? "")}
            kernelLabel={props.kernelLabel}
            providerId={props.providerId}
            providerLabel={props.providerLabel}
            kernels={props.kernelOptions}
            providers={props.providerOptions}
            providersLoading={props.providerOptionsLoading}
            onSelectKernel={props.onSelectKernel}
            onSelectProvider={props.onSelectProvider}
          />
          <DialogPrimitive.Trigger asChild>
            <button
              className="topbar-icon-button chat-frame-workbench-button"
              data-open={inspectorOpen ? "true" : "false"}
              type="button"
              title={inspectorLabel}
              aria-label={inspectorLabel}
            >
              <ListChecks size={17} />
            </button>
          </DialogPrimitive.Trigger>
        </div>
        <div className="chat-layout" data-inspector={inspectorOpen ? "true" : "false"}>
          <section className="conversation">
            <section ref={props.threadScrollRef} className="thread chat-thread-scroll" aria-live="polite">
              {props.thread}
            </section>
            {props.composer}
          </section>
        </div>
        <AnimatePresence>
          {inspectorOpen ? (
            <DialogPrimitive.Content
              asChild
              forceMount
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              onInteractOutside={(event) => event.preventDefault()}
            >
              <motion.aside
                className="workspace-overlay-panel inspector"
                aria-label={props.workbenchLabel}
                initial={reduceMotion ? false : { opacity: 0, x: 18, scale: 0.985 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={reduceMotion ? undefined : { opacity: 0, x: 18, scale: 0.985 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                <DialogPrimitive.Title className="inspector-motion-title">{props.workbenchLabel}</DialogPrimitive.Title>
                {props.inspector}
              </motion.aside>
            </DialogPrimitive.Content>
          ) : null}
        </AnimatePresence>
      </section>
    </DialogPrimitive.Root>
  );
}

export function MountedAppWorkspaceView(props: {
  app: ExtensionItemRecord | undefined;
  embedded?: boolean;
  hostState?: MountedAppHostState;
  inventoryRetrying?: boolean;
  chatPanelKey?: string;
  runtimeEvents?: AgentEventRecord[];
  pendingApprovals?: ApprovalRecord[];
  pendingQuestionIds?: ReadonlySet<string>;
  roomsState: RoomsState;
  roomsHydrated: boolean;
  setRoomsState: Dispatch<SetStateAction<RoomsState>>;
  activeKernel?: string;
  activeModel?: ModelId;
  extensions?: ExtensionItemCollection;
  kernelOptions?: KernelOption[];
  providers?: ProviderProfile[];
  modelProviderBindings?: ModelProviderBinding[];
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  skills?: SkillRecord[];
  developerModeOpen?: boolean;
  onMarkRoomRead?(roomId: string): Promise<void> | void;
  onPendingCountChange?(count: number): void;
  onResolveApproval?(approvalId: string, action: "approve" | "reject", response?: unknown): Promise<unknown> | void;
  onResolveQuestion?(questionId: string, action: "answer" | "decline", response?: unknown): Promise<unknown> | void;
  onRetryInventory?(): void;
}) {
  const [selectedPath, setSelectedPath] = useState("");
  const [queuedAttachment, setQueuedAttachment] = useState<AttachmentPayload | null>(null);
  const fallbackRuntime = mountedAppUiRuntime(props.app);
  const appId = props.app?.name || "";
  const queryClient = useQueryClient();
  const runtimeQueryKey = ["mounted-app-runtime", appId] as const;
  const runtimeQuery = useQuery<MountedAppRuntimeResponse>({
    queryKey: runtimeQueryKey,
    queryFn: () => getJson<MountedAppRuntimeResponse>(`/apps/${encodeURIComponent(appId)}/runtime`),
    enabled: Boolean(appId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });
  const runtime = runtimeQuery.data?.ui ?? fallbackRuntime;
  const surface = runtime.surface;
  useEffect(() => {
    if (!runtimeQuery.data?.revision) return;
    void queryClient.invalidateQueries({ queryKey: ["inventory"] });
  }, [queryClient, runtimeQuery.data?.revision]);
  const setupMutation = useMutation({
    mutationFn: (choice: MountedAppSetupChoice) =>
      postJson<MountedAppRuntimeResponse>(`/apps/${encodeURIComponent(appId)}/setup`, { choice }),
    onMutate: async (choice) => {
      await queryClient.cancelQueries({ queryKey: runtimeQueryKey });
      const previous = queryClient.getQueryData<MountedAppRuntimeResponse>(runtimeQueryKey);
      if (choice === "file-workbench" && previous) {
        queryClient.setQueryData<MountedAppRuntimeResponse>(runtimeQueryKey, {
          ...previous,
          ui: { surface: "file-workbench", source: "surface" },
          setup: {
            choice,
            selectedAt: new Date().toISOString(),
          },
        });
      }
      return { previous };
    },
    onError: (_error, _choice, context) => {
      if (context?.previous) queryClient.setQueryData(runtimeQueryKey, context.previous);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(runtimeQueryKey, result);
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
      void queryClient.invalidateQueries({ queryKey: ["extensions"] });
    },
  });

  useEffect(() => {
    setSelectedPath("");
    setQueuedAttachment(null);
  }, [appId]);

  const setupChoice = runtimeQuery.data?.setup?.choice;
  const setupError = setupMutation.error instanceof Error ? setupMutation.error.message : "";
  const developerModeOpen = props.developerModeOpen === true;
  if (
    props.hostState === "resolving" ||
    props.hostState === "empty" ||
    props.hostState === "missing" ||
    props.hostState === "unavailable"
  ) {
    return (
      <section className={clsx("view-panel", "mounted-app-view")} data-view="app" data-surface={props.hostState}>
        <MountedAppDeveloperLayout
          appId=""
          open={false}
          canvas={
            props.hostState === "resolving" ? (
              <MountedAppResolvingSurface />
            ) : (
              <MountedAppHostStateSurface
                state={props.hostState}
                retrying={props.inventoryRetrying === true}
                onRetry={props.onRetryInventory}
              />
            )
          }
          chat={null}
        />
      </section>
    );
  }
  const chatPanel = props.app ? (
    <MountedAppChatPanel
      key={props.chatPanelKey}
      app={props.app}
      selectedPath={selectedPath}
      runtimeEvents={props.runtimeEvents}
      pendingApprovals={props.pendingApprovals}
      pendingQuestionIds={props.pendingQuestionIds}
      roomsState={props.roomsState}
      roomsHydrated={props.roomsHydrated}
      setRoomsState={props.setRoomsState}
      activeKernel={props.activeKernel}
      activeModel={props.activeModel}
      extensions={props.extensions}
      kernelOptions={props.kernelOptions}
      providers={props.providers}
      modelProviderBindings={props.modelProviderBindings}
      runtimeControls={props.runtimeControls}
      runtimeControlsByKernel={props.runtimeControlsByKernel}
      skills={props.skills}
      onMarkRoomRead={props.onMarkRoomRead}
      onResolveApproval={props.onResolveApproval}
      onResolveQuestion={props.onResolveQuestion}
      queuedAttachment={queuedAttachment}
      onOpenWorkspacePath={setSelectedPath}
      onPendingCountChange={props.onPendingCountChange}
    />
  ) : null;

  if (surface === "file-workbench") {
    return (
      <section className={clsx("view-panel", "mounted-app-view")} data-view="app" data-surface={surface}>
        <MountedAppWorkbench
          app={props.app}
          layoutMode={props.embedded ? "embedded" : "standard"}
          runtimeRevision={runtimeQuery.data?.revision}
          selectedPath={selectedPath}
          corePanel={chatPanel}
          chatOpen={developerModeOpen}
          onAddSelectionAttachment={setQueuedAttachment}
          onSelectedPathChange={setSelectedPath}
        />
      </section>
    );
  }

  return (
    <section className={clsx("view-panel", "mounted-app-view")} data-view="app" data-surface={surface}>
      <MountedAppDeveloperLayout
        appId={appId}
        open={developerModeOpen}
        canvas={
          surface === "setup" ? (
            <MountedAppSetupSurface
              appTitle={props.app?.title || "App"}
              choice={setupChoice}
              pending={setupMutation.isPending}
              error={setupError}
              onChoose={(choice) => setupMutation.mutate(choice)}
            />
          ) : surface === "view" ? (
            <MountedMcpAppView
              key={appId}
              app={props.app}
              runtimeRevision={runtimeQuery.data?.revision}
              deferUntilRuntimeRevision
            />
          ) : (
            <MountedAppNoneSurface unsupported={surface === "unsupported"} />
          )
        }
        chat={chatPanel}
      />
    </section>
  );
}

function MountedAppResolvingSurface() {
  const { t } = useI18n();
  return (
    <section className="mounted-app-none-surface" aria-busy="true">
      <div className="og-skeleton-stack" role="status" aria-label={t("mountedApp.loading")}>
        <span className="og-skeleton og-skeleton-line" style={{ width: "42%" }} />
        <span className="og-skeleton og-skeleton-line" style={{ width: "74%" }} />
        <span className="og-skeleton og-skeleton-line" style={{ width: "58%" }} />
      </div>
    </section>
  );
}

function MountedAppHostStateSurface(props: {
  state: "empty" | "missing" | "unavailable";
  retrying: boolean;
  onRetry?(): void;
}) {
  const { t } = useI18n();
  const title =
    props.state === "unavailable"
      ? t("shell.appHostUnavailableTitle")
      : props.state === "missing"
        ? t("shell.appHostMissingTitle")
        : t("shell.appHostEmptyTitle");
  const copy =
    props.state === "unavailable"
      ? t("shell.appHostUnavailableCopy")
      : props.state === "missing"
        ? t("shell.appHostMissingCopy")
        : t("shell.appHostEmptyCopy");
  return (
    <section className="mounted-app-none-surface" role={props.state === "unavailable" ? "alert" : undefined}>
      <div className="mounted-app-none-copy">
        <h2>{title}</h2>
        <p>{copy}</p>
        {props.state !== "empty" && props.onRetry ? (
          <button className="primary-button" type="button" onClick={props.onRetry} disabled={props.retrying}>
            {props.retrying ? t("gate.retrying") : t("mountedApp.retry")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

type MountedAppSetupChoice = "file-workbench" | "view";

interface MountedAppRuntimeResponse {
  ok: boolean;
  ui: MountedAppUiRuntime;
  revision?: string;
  setup?: {
    choice?: MountedAppSetupChoice;
    selectedAt?: string;
  };
  builderScheduled?: boolean;
}

function MountedAppSetupSurface(props: {
  appTitle: string;
  choice?: MountedAppSetupChoice;
  pending: boolean;
  error: string;
  onChoose(choice: MountedAppSetupChoice): void;
}) {
  const { t } = useI18n();
  return (
    <section className="mounted-app-setup">
      <div className="mounted-app-setup-card">
        <Bot size={30} aria-hidden="true" />
        <h2>{props.appTitle}</h2>
        <p>{t("shell.appSetupIntro")}</p>
        <div className="mounted-app-setup-options">
          <button
            className="mounted-app-setup-option"
            type="button"
            disabled={props.pending || props.choice === "view"}
            onClick={() => props.onChoose("file-workbench")}
          >
            <Files size={22} aria-hidden="true" />
            <span>
              <strong>{t("shell.appSetupWorkbenchTitle")}</strong>
              <small>{t("shell.appSetupWorkbenchCopy")}</small>
            </span>
          </button>
          <button
            className="mounted-app-setup-option"
            type="button"
            disabled={props.pending || props.choice === "view"}
            onClick={() => props.onChoose("view")}
          >
            {props.pending ? (
              <Loader2 className="spin" size={22} aria-hidden="true" />
            ) : (
              <PanelsTopLeft size={22} aria-hidden="true" />
            )}
            <span>
              <strong>{t("shell.appSetupCustomViewTitle")}</strong>
              <small>{t("shell.appSetupCustomViewCopy")}</small>
            </span>
          </button>
        </div>
        {props.choice === "view" ? (
          <p className="mounted-app-setup-status">{t("shell.appSetupViewHandedOff")}</p>
        ) : null}
        {props.error ? (
          <p className="mounted-app-setup-error" role="alert">
            {rawDiagnosticText(props.error)}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function MountedAppNoneSurface(props: { unsupported: boolean }) {
  const { t } = useI18n();
  return (
    <section className="mounted-app-none-surface">
      <div className="mounted-app-none-copy">
        <h2>{props.unsupported ? t("shell.appSurfaceUnsupportedTitle") : t("shell.appSurfaceNoneTitle")}</h2>
        <p>{props.unsupported ? t("shell.appSurfaceUnsupportedCopy") : t("shell.appSurfaceNoneCopy")}</p>
      </div>
    </section>
  );
}
