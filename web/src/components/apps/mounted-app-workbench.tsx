import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileInput,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  ImageIcon,
  ListChevronsDownUp,
  ListChevronsUpDown,
  ListVideo,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Video,
} from "lucide-react";
import { apiUrl } from "../../api-base";
import {
  createMountedAppFileSystemEntry,
  deleteMountedAppFileSystemEntry,
  getMountedAppDashboard,
  getMountedAppFile,
  importMountedAppLocalFiles,
  listMountedAppFiles,
  listMountedAppFlows,
  moveMountedAppFileSystemEntry,
  openMountedAppLocalFile,
  putMountedAppRawFile,
  refreshMountedAppDashboard,
  renameMountedAppFileSystemEntry,
  type AttachmentPayload,
  type ExtensionItemRecord,
  type MountedAppDashboardFunnel,
  type MountedAppDashboardFunnelChapter,
  type MountedAppDashboardGrade,
  type MountedAppDashboardItem,
  type MountedAppDashboardResponse,
  type MountedAppFileEntry,
  type MountedAppFileResponse,
  type MountedAppFileSystemResponse,
  type MountedAppFilesResponse,
  type MountedAppFlowStatus,
  type MountedAppFlowRecord,
  type MountedAppFlowsResponse,
} from "../../bridge";
import { clamp, compareLocalizedText, formatNumber } from "../../format";
import { translate, useI18n, type TranslationFn, type TranslationKey } from "../../i18n";
import { cachedDateTimeFormat } from "../../intl-formatters";
import { useConfirm } from "../ui/confirm-dialog";
import { AnimatedBackground } from "../ui/motion/animated-background";
import {
  cleanDashboardAlert,
  DashboardTextList,
  dashboardGradeShortLabel,
  GradeBadge,
} from "./mounted-app-dashboard-primitives";
import { MAX_TEXT_ATTACHMENT_CHARS, createAttachmentId } from "../../runtime/ui-model";
import { DirectoryPanel } from "../shared/directory-panel";
import {
  FilePreviewPanel,
  type FilePreviewDirtyState,
  type FileTextSelectionAttachment,
} from "../shared/file-preview-panel";
import { WorkspaceWorkbenchLayout } from "../shared/workspace-workbench-layout";
import "./mounted-app-workbench.css";
import {
  DirectoryTree,
  findDirectoryTreeElement,
  parentDirectoryPath,
  parentDirectoryPaths,
  type DirectoryTreeMenuState,
  type DirectoryTreeNode,
} from "../shared/directory-tree";
import {
  resolveMountedAppTabs,
  resolveMountedAppWorkbenchLayoutDefaults,
  type MountedAppPaneComponent,
  type MountedAppWorkbenchLayoutDefaults,
} from "./mounted-app-model";
import { MountedMcpAppView } from "./mounted-mcp-app-view";

type MountedAppTreeNode = DirectoryTreeNode<MountedAppFileEntry>;
type MountedAppResizeTarget = "files" | "chat";
type MountedAppWorkbenchLayoutMode = "standard" | "embedded";
type MountedAppWorkbenchLayoutState = {
  filesWidth: number;
  chatWidth: number;
};
type MountedAppWorkbenchLayoutConstraints = {
  filesMinWidth: number;
  filesMaxWidth: number;
  // Hard CSS grid floor. This may force overflow when the container cannot satisfy it.
  previewMinWidth: number;
  // Soft JS resize reserve. It caps adjacent panes without preventing the preview from shrinking.
  previewWidthReserve: number;
  chatMinWidth: number;
  chatMaxWidth: number;
  resizeHandleWidth: number;
};

const DEFAULT_MOUNTED_APP_WORKBENCH_LAYOUT: MountedAppWorkbenchLayoutState = {
  filesWidth: 280,
  chatWidth: 420,
};
const STANDARD_MOUNTED_APP_WORKBENCH_CONSTRAINTS: MountedAppWorkbenchLayoutConstraints = {
  filesMinWidth: 180,
  filesMaxWidth: 520,
  previewMinWidth: 0,
  previewWidthReserve: 320,
  chatMinWidth: 280,
  chatMaxWidth: 860,
  resizeHandleWidth: 10,
};
const COMPACT_EMBEDDED_APP_WORKBENCH_CONSTRAINTS: MountedAppWorkbenchLayoutConstraints = {
  filesMinWidth: 130,
  filesMaxWidth: 170,
  previewMinWidth: 190,
  previewWidthReserve: 190,
  chatMinWidth: 210,
  chatMaxWidth: 860,
  resizeHandleWidth: 8,
};
const WIDE_EMBEDDED_APP_WORKBENCH_CONSTRAINTS: MountedAppWorkbenchLayoutConstraints = {
  filesMinWidth: 180,
  filesMaxWidth: 220,
  previewMinWidth: 280,
  previewWidthReserve: 280,
  chatMinWidth: 280,
  chatMaxWidth: 860,
  resizeHandleWidth: 10,
};
// Preserves the retired CSS split: compact through 760px, wide from 761px.
const COMPACT_EMBEDDED_APP_WORKBENCH_MAX_WIDTH = 760;
// Stored preferences span every profile because standard and embedded modes share one App-scoped key.
// The active profile clamps them for rendering without destroying a preference valid in another mode.
const MIN_STORED_MOUNTED_APP_FILES_WIDTH = COMPACT_EMBEDDED_APP_WORKBENCH_CONSTRAINTS.filesMinWidth;
const MAX_STORED_MOUNTED_APP_FILES_WIDTH = STANDARD_MOUNTED_APP_WORKBENCH_CONSTRAINTS.filesMaxWidth;
const MIN_STORED_MOUNTED_APP_CHAT_WIDTH = COMPACT_EMBEDDED_APP_WORKBENCH_CONSTRAINTS.chatMinWidth;
const MAX_STORED_MOUNTED_APP_CHAT_WIDTH = STANDARD_MOUNTED_APP_WORKBENCH_CONSTRAINTS.chatMaxWidth;
const MOUNTED_APP_FLOW_HISTORY_LIMIT = 10;
const MOUNTED_APP_ACTIVE_FLOW_STATUSES: MountedAppFlowStatus[] = ["waiting_user", "running", "pending"];
const MOUNTED_APP_FLOW_STATUS_SORT_ORDER: MountedAppFlowStatus[] = [
  "waiting_user",
  "running",
  "pending",
  "failed",
  "done",
];

type MountedAppFlowWorkflowGroup = {
  id: string;
  title: string;
  status: MountedAppFlowStatus;
  latestFlow: MountedAppFlowRecord;
  flows: MountedAppFlowRecord[];
};

class MountedAppPreviewErrorBoundary extends Component<
  {
    children: ReactNode;
    resetKey: string;
    title: string;
    copy: string;
  },
  {
    error: Error | undefined;
    resetKey: string;
  }
> {
  state: {
    error: Error | undefined;
    resetKey: string;
  } = {
    error: undefined,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | undefined; resetKey: string }) {
    if (props.resetKey !== state.resetKey) {
      return { error: undefined, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[mounted-app] preview render failed", {
      resetKey: this.props.resetKey,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <div className="file-preview-empty mounted-app-preview-empty mounted-app-preview-error" role="alert">
        <CircleAlert size={22} />
        <strong>{this.props.title}</strong>
        <p>{this.props.copy}</p>
      </div>
    );
  }
}

export function MountedAppWorkbench(props: {
  app: ExtensionItemRecord | undefined;
  layoutMode?: MountedAppWorkbenchLayoutMode;
  runtimeRevision?: string;
  selectedPath: string;
  corePanel?: ReactNode;
  chatOpen?: boolean;
  onAddSelectionAttachment?(attachment: AttachmentPayload): void;
  onSelectedPathChange(path: string): void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const appId = props.app?.name || "";
  const declaredWorkbenchLayoutDefaults = useMemo(
    () => resolveMountedAppWorkbenchLayoutDefaults(props.app),
    [props.app?.metadata?.ui],
  );
  const queryClient = useQueryClient();
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const dashboardRefreshSpinnerTimeoutRef = useRef<number | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const resizeRef = useRef<{
    target: MountedAppResizeTarget;
    pointerId: number;
    handle: HTMLDivElement;
    directoryCollapsed: boolean;
    startPreferredLayout: MountedAppWorkbenchLayoutState;
    startX: number;
    startFilesWidth: number;
    startChatWidth: number;
    containerWidth: number;
    constraints: MountedAppWorkbenchLayoutConstraints;
  } | null>(null);
  const [editingPath, setEditingPath] = useState("");
  const tabs = useMemo(() => resolveMountedAppTabs(props.app, t), [props.app?.metadata?.ui, props.app?.name, t]);
  const [activeTabIdx, setActiveTabIdx] = useState(0);
  const activeTabIndex = Math.min(activeTabIdx, Math.max(tabs.length - 1, 0));
  const activeTab = tabs[activeTabIndex] ?? { component: "file-tree" as const, label: t("mountedApp.files") };
  const [activatedViewIds, setActivatedViewIds] = useState<string[]>([]);
  const directoryMode: MountedAppPaneComponent = activeTab.component;
  const activeDashboardIndex = tabs.slice(0, activeTabIndex).filter((tab) => tab.component === "dashboard").length;
  const [selectedDashboardItemId, setSelectedDashboardItemId] = useState("");
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [openPaths, setOpenPaths] = useState<Record<string, boolean>>(() => readStoredMountedAppOpenPaths(appId));
  const [directoryCollapsed, setDirectoryCollapsed] = useState(() => readStoredMountedAppDirectoryCollapsed(appId));
  const [preferredWorkbenchLayout, setPreferredWorkbenchLayout] = useState<MountedAppWorkbenchLayoutState>(() =>
    readStoredMountedAppWorkbenchLayout(appId, declaredWorkbenchLayoutDefaults),
  );
  const [workbenchContainerWidth, setWorkbenchContainerWidth] = useState(0);
  const [dashboardRefreshSettling, setDashboardRefreshSettling] = useState(false);
  const [fileDirtyState, setFileDirtyState] = useState<FilePreviewDirtyState | null>(null);
  const dashboardQueryKey = ["mounted-app-dashboard", appId, activeDashboardIndex] as const;
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useLayoutEffect(() => {
    const workbench = workbenchRef.current;
    if (!workbench) {
      setWorkbenchContainerWidth(0);
      return;
    }
    let resizeAnimationFrame = 0;
    const measureContainerWidth = () => {
      const width = mountedAppWorkbenchWidth(workbench);
      setWorkbenchContainerWidth((current) => (current === width ? current : width));
    };
    const scheduleContainerWidthMeasurement = () => {
      // ResizeObserver can notify repeatedly before paint; constrain React
      // layout updates to at most one measurement per animation frame.
      if (resizeAnimationFrame) return;
      resizeAnimationFrame = window.requestAnimationFrame(() => {
        resizeAnimationFrame = 0;
        measureContainerWidth();
      });
    };
    measureContainerWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleContainerWidthMeasurement);
      return () => {
        window.removeEventListener("resize", scheduleContainerWidthMeasurement);
        if (resizeAnimationFrame) window.cancelAnimationFrame(resizeAnimationFrame);
      };
    }
    const observer = new ResizeObserver(scheduleContainerWidthMeasurement);
    observer.observe(workbench);
    return () => {
      observer.disconnect();
      if (resizeAnimationFrame) window.cancelAnimationFrame(resizeAnimationFrame);
    };
  }, [appId]);

  useEffect(() => {
    setActivatedViewIds([]);
  }, [appId]);
  useEffect(() => {
    if (activeTab.component !== "view" || !activeTab.id) return;
    setActivatedViewIds((current) => (current.includes(activeTab.id!) ? current : [...current, activeTab.id!]));
  }, [activeTab.component, activeTab.id]);
  const filesQuery = useQuery<MountedAppFilesResponse>({
    queryKey: ["mounted-app-files", appId],
    queryFn: async () => {
      const previous = queryClient.getQueryData<MountedAppFilesResponse>(["mounted-app-files", appId]);
      const response = await listMountedAppFiles(appId, previous?.revision);
      return response.unchanged && previous ? { ...previous, revision: response.revision } : response;
    },
    enabled: Boolean(appId),
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const flowsQuery = useQuery<MountedAppFlowsResponse>({
    queryKey: ["mounted-app-flows", appId],
    queryFn: async () => {
      const previous = queryClient.getQueryData<MountedAppFlowsResponse>(["mounted-app-flows", appId]);
      const response = await listMountedAppFlows(appId, previous?.revision);
      return response.unchanged && previous ? { ...previous, revision: response.revision } : response;
    },
    enabled: Boolean(appId),
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const dashboardQuery = useQuery<MountedAppDashboardResponse>({
    queryKey: dashboardQueryKey,
    queryFn: () => getMountedAppDashboard(appId, { dashboardIndex: activeDashboardIndex }),
    enabled: Boolean(appId && directoryMode === "dashboard"),
    refetchInterval: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const dashboardRefreshMutation = useMutation({
    mutationFn: () => refreshMountedAppDashboard(appId, { dashboardIndex: activeDashboardIndex }),
    onSuccess: (dashboard) => {
      queryClient.setQueryData<MountedAppDashboardResponse>(dashboardQueryKey, dashboard);
    },
  });
  const fileQuery = useQuery<MountedAppFileResponse>({
    queryKey: ["mounted-app-file", appId, props.selectedPath],
    queryFn: async () => {
      const key = ["mounted-app-file", appId, props.selectedPath] as const;
      const previous = queryClient.getQueryData<MountedAppFileResponse>(key);
      const response = await getMountedAppFile(appId, props.selectedPath, previous?.revision);
      return response.unchanged && previous ? { ...previous, revision: response.revision } : response;
    },
    enabled: Boolean(appId && props.selectedPath && directoryMode !== "dashboard" && directoryMode !== "view"),
    refetchInterval: fileDirtyState ? false : 3_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const selectedEntry = useMemo(
    () => findEntry(filesQuery.data?.entries ?? [], props.selectedPath),
    [filesQuery.data?.entries, props.selectedPath],
  );
  const activeDashboardItem = useMemo(
    () => (dashboardQuery.data?.items ?? []).find((item) => item.id === selectedDashboardItemId),
    [dashboardQuery.data?.items, selectedDashboardItemId],
  );
  const dashboardRefreshing = dashboardRefreshMutation.isPending || dashboardRefreshSettling;
  const dashboardError =
    dashboardQuery.error instanceof Error
      ? dashboardQuery.error.message
      : dashboardRefreshMutation.error instanceof Error
        ? dashboardRefreshMutation.error.message
        : "";
  const selectedRawUrl = props.selectedPath
    ? apiUrl(`/apps/${encodeURIComponent(appId)}/raw?${new URLSearchParams({ path: props.selectedPath }).toString()}`)
    : undefined;
  const selectedDownloadUrl = props.selectedPath
    ? apiUrl(
        `/apps/${encodeURIComponent(appId)}/raw?${new URLSearchParams({ path: props.selectedPath, download: "1" }).toString()}`,
      )
    : undefined;
  const activeDirtyState = fileDirtyState?.path === props.selectedPath ? fileDirtyState : null;
  const effectiveDirectoryCollapsed = directoryMode === "view" || directoryCollapsed;
  const workbenchChatOpen = Boolean(props.corePanel && props.chatOpen !== false);
  const workbenchLayoutConstraints = resolveMountedAppWorkbenchLayoutConstraints(
    props.layoutMode ?? "standard",
    workbenchContainerWidth,
  );
  const effectiveWorkbenchLayout = constrainMountedAppWorkbenchLayout(
    preferredWorkbenchLayout,
    workbenchContainerWidth,
    effectiveDirectoryCollapsed,
    workbenchChatOpen,
    workbenchLayoutConstraints,
  );

  function refreshDashboard() {
    if (!appId || dashboardRefreshing) return;
    if (dashboardRefreshSpinnerTimeoutRef.current) {
      window.clearTimeout(dashboardRefreshSpinnerTimeoutRef.current);
      dashboardRefreshSpinnerTimeoutRef.current = null;
    }
    setDashboardRefreshSettling(true);
    const startedAt = Date.now();
    dashboardRefreshMutation.mutate(undefined, {
      onSettled: () => {
        const remainingMs = Math.max(0, 600 - (Date.now() - startedAt));
        dashboardRefreshSpinnerTimeoutRef.current = window.setTimeout(() => {
          dashboardRefreshSpinnerTimeoutRef.current = null;
          setDashboardRefreshSettling(false);
        }, remainingMs);
      },
    });
  }

  function mergeFileSystemResult(result: MountedAppFileSystemResponse) {
    queryClient.setQueryData<MountedAppFilesResponse>(["mounted-app-files", appId], (previous) =>
      previous ? { ...previous, entries: result.entries, truncated: result.truncated } : previous,
    );
    void queryClient.invalidateQueries({ queryKey: ["mounted-app-file", appId] });
    void queryClient.invalidateQueries({ queryKey: ["mounted-app-flows", appId] });
  }

  const createEntryMutation = useMutation({
    mutationFn: (payload: { kind: "file" | "folder"; parentPath: string }) =>
      createMountedAppFileSystemEntry(appId, {
        kind: payload.kind,
        parentPath: payload.parentPath,
        name: payload.kind === "folder" ? t("mountedApp.newFolder") : `${t("system.unnamed")}.md`,
        content: payload.kind === "file" ? `# ${t("system.unnamed")}\n` : undefined,
      }),
    onSuccess(result) {
      mergeFileSystemResult(result);
      if (result.entry?.path) {
        if (result.entry.kind === "file") void requestSelectedPathChange(result.entry.path);
      }
    },
  });

  const renameEntryMutation = useMutation({
    mutationFn: (payload: { sourcePath: string; name: string }) => renameMountedAppFileSystemEntry(appId, payload),
    onSuccess(result, payload) {
      mergeFileSystemResult(result);
      setEditingPath("");
      if (props.selectedPath === payload.sourcePath && result.entry?.path) {
        props.onSelectedPathChange(result.entry.path);
      }
    },
    onError() {
      setEditingPath("");
    },
  });

  const deleteEntryMutation = useMutation({
    mutationFn: (payload: { sourcePath: string }) => deleteMountedAppFileSystemEntry(appId, payload),
    onSuccess(result, payload) {
      mergeFileSystemResult(result);
      if (props.selectedPath === payload.sourcePath || props.selectedPath.startsWith(`${payload.sourcePath}/`)) {
        props.onSelectedPathChange("");
      }
    },
  });

  const moveEntryMutation = useMutation({
    mutationFn: (payload: { sourcePath: string; targetParentPath: string }) =>
      moveMountedAppFileSystemEntry(appId, payload),
    onSuccess(result, payload) {
      mergeFileSystemResult(result);
      if (
        result.entry?.path &&
        (props.selectedPath === payload.sourcePath || props.selectedPath.startsWith(`${payload.sourcePath}/`))
      ) {
        props.onSelectedPathChange(`${result.entry.path}${props.selectedPath.slice(payload.sourcePath.length)}`);
      }
    },
  });

  const saveTextMutation = useMutation({
    mutationFn: (payload: { path: string; content: string; contentType: string }) =>
      putMountedAppRawFile(appId, payload.path, new Blob([payload.content], { type: payload.contentType }), {
        contentType: payload.contentType,
      }),
    onSuccess(result, payload) {
      mergeFileSystemResult(result);
      queryClient.setQueryData<MountedAppFileResponse>(["mounted-app-file", appId, payload.path], (previous) => {
        if (!previous?.file) return previous;
        return {
          ...previous,
          file: {
            ...previous.file,
            ...(result.entry ?? {}),
            content: payload.content,
            contentTruncated: false,
          },
        };
      });
    },
  });

  const importFilesMutation = useMutation({
    mutationFn: (payload: { parentPath: string }) =>
      importMountedAppLocalFiles(appId, { parentPath: payload.parentPath }),
    onSuccess(result) {
      mergeFileSystemResult(result);
      if (result.entry?.path) void requestSelectedPathChange(result.entry.path);
    },
  });

  useEffect(() => {
    props.onSelectedPathChange("");
    setActiveTabIdx(0);
    setSelectedDashboardItemId("");
  }, [appId]);

  useEffect(
    () => () => {
      if (dashboardRefreshSpinnerTimeoutRef.current) {
        window.clearTimeout(dashboardRefreshSpinnerTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (activeTabIdx < tabs.length) return;
    setActiveTabIdx(0);
  }, [activeTabIdx, tabs]);

  useEffect(() => {
    if (directoryMode !== "dashboard" && directoryMode !== "view") return;
    if (props.selectedPath) props.onSelectedPathChange("");
  }, [directoryMode, props.selectedPath]);

  useEffect(() => {
    if (directoryMode !== "dashboard") return;
    const items = dashboardQuery.data?.items ?? [];
    if (!items.length) {
      setSelectedDashboardItemId("");
      return;
    }
    if (!selectedDashboardItemId || !items.some((item) => item.id === selectedDashboardItemId)) {
      setSelectedDashboardItemId(items[0]?.id ?? "");
    }
  }, [dashboardQuery.data?.items, directoryMode, selectedDashboardItemId]);

  useEffect(() => {
    setOpenPaths(readStoredMountedAppOpenPaths(appId));
    setDirectoryCollapsed(readStoredMountedAppDirectoryCollapsed(appId));
  }, [appId]);

  useEffect(() => {
    setPreferredWorkbenchLayout(readStoredMountedAppWorkbenchLayout(appId, declaredWorkbenchLayoutDefaults));
  }, [appId, declaredWorkbenchLayoutDefaults.filesWidth, declaredWorkbenchLayoutDefaults.chatWidth]);

  useEffect(() => {
    writeStoredMountedAppOpenPaths(appId, openPaths);
  }, [appId, openPaths]);

  useEffect(() => {
    writeStoredMountedAppDirectoryCollapsed(appId, directoryCollapsed);
  }, [appId, directoryCollapsed]);

  if (!props.app) {
    return (
      <div className="mounted-app-empty">
        <strong>{t("mountedApp.emptyTitle")}</strong>
        <p>{t("mountedApp.emptyCopy")}</p>
      </div>
    );
  }

  const appInfo = filesQuery.data?.app;
  const entries = filesQuery.data?.entries ?? [];
  const visibleEntries = filterMountedAppWorkspaceEntries(entries);
  const flows = flowsQuery.data?.flows ?? [];
  const flowGroups = buildMountedAppFlowGroups(flows);
  const folderPaths = collectFolderPaths(visibleEntries);
  const allFoldersOpen =
    folderPaths.length > 0 && folderPaths.every((path) => openPaths[path] ?? defaultFolderOpen(path));

  function setAllFolders(open: boolean) {
    setOpenPaths((current) => ({
      ...current,
      ...Object.fromEntries(folderPaths.map((path) => [path, open])),
    }));
  }

  function currentUploadParentPath(): string {
    if (selectedEntry?.kind === "directory") return selectedEntry.path;
    return props.selectedPath ? parentMountedAppPath(props.selectedPath) : "";
  }

  const uploadParentPath = currentUploadParentPath();
  const uploadButtonLabel = t("mountedApp.importFileTarget", { path: uploadParentPath || t("mountedApp.workspace") });

  function persistWorkbenchLayout(nextLayout: MountedAppWorkbenchLayoutState) {
    setPreferredWorkbenchLayout(nextLayout);
    writeStoredMountedAppWorkbenchLayout(appId, nextLayout);
  }

  async function requestSelectedPathChange(path: string) {
    if (path === props.selectedPath) return;
    await activeDirtyState?.save();
    props.onSelectedPathChange(path);
  }

  function beginWorkbenchResize(target: MountedAppResizeTarget, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    const containerWidth = mountedAppWorkbenchWidth(workbenchRef.current);
    const constraints = resolveMountedAppWorkbenchLayoutConstraints(props.layoutMode ?? "standard", containerWidth);
    const startLayout = constrainMountedAppWorkbenchLayout(
      preferredWorkbenchLayout,
      containerWidth,
      effectiveDirectoryCollapsed,
      workbenchChatOpen,
      constraints,
    );
    resizeRef.current = {
      target,
      pointerId: event.pointerId,
      handle,
      directoryCollapsed: effectiveDirectoryCollapsed,
      startPreferredLayout: preferredWorkbenchLayout,
      startX: event.clientX,
      startFilesWidth: startLayout.filesWidth,
      startChatWidth: startLayout.chatWidth,
      containerWidth,
      constraints,
    };
    handle.dataset.resizing = "true";

    function finishWorkbenchResize(finishEvent?: Event) {
      const resize = resizeRef.current;
      if (!resize) return;
      if (finishEvent instanceof PointerEvent && finishEvent.pointerId !== resize.pointerId) return;
      resizeRef.current = null;
      delete resize.handle.dataset.resizing;
      window.removeEventListener("pointermove", updateWorkbenchResize);
      window.removeEventListener("pointerup", finishWorkbenchResize);
      window.removeEventListener("pointercancel", finishWorkbenchResize);
      window.removeEventListener("blur", finishWorkbenchResize);
      document.removeEventListener("visibilitychange", finishWorkbenchResizeWhenHidden);
      resize.handle.removeEventListener("lostpointercapture", finishWorkbenchResize);
      resizeCleanupRef.current = null;
      if (resize.handle.hasPointerCapture(resize.pointerId)) {
        resize.handle.releasePointerCapture(resize.pointerId);
      }
    }

    function finishWorkbenchResizeWhenHidden() {
      if (document.visibilityState === "hidden") finishWorkbenchResize();
    }

    function updateWorkbenchResize(moveEvent: PointerEvent) {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== moveEvent.pointerId) return;
      if (moveEvent.buttons === 0) {
        finishWorkbenchResize();
        return;
      }
      const deltaX = moveEvent.clientX - resize.startX;
      const nextLayout =
        resize.target === "files"
          ? {
              ...resize.startPreferredLayout,
              filesWidth: clamp(
                resize.startFilesWidth + deltaX,
                resize.constraints.filesMinWidth,
                maxMountedAppFilesWidthWhenChatYields(resize.containerWidth, workbenchChatOpen, resize.constraints),
              ),
            }
          : {
              ...resize.startPreferredLayout,
              chatWidth: clamp(
                resize.startChatWidth - deltaX,
                resize.constraints.chatMinWidth,
                maxMountedAppChatWidth(
                  resize.containerWidth,
                  resize.startFilesWidth,
                  resize.directoryCollapsed,
                  resize.constraints,
                ),
              ),
            };
      persistWorkbenchLayout(nextLayout);
    }

    resizeCleanupRef.current = () => finishWorkbenchResize();
    window.addEventListener("pointermove", updateWorkbenchResize);
    window.addEventListener("pointerup", finishWorkbenchResize);
    window.addEventListener("pointercancel", finishWorkbenchResize);
    window.addEventListener("blur", finishWorkbenchResize);
    document.addEventListener("visibilitychange", finishWorkbenchResizeWhenHidden);
    handle.addEventListener("lostpointercapture", finishWorkbenchResize);
  }

  function adjustWorkbenchLayoutWithKeyboard(target: MountedAppResizeTarget, event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const containerWidth = mountedAppWorkbenchWidth(workbenchRef.current);
    const constraints = resolveMountedAppWorkbenchLayoutConstraints(props.layoutMode ?? "standard", containerWidth);
    const effectiveLayout = constrainMountedAppWorkbenchLayout(
      preferredWorkbenchLayout,
      containerWidth,
      effectiveDirectoryCollapsed,
      workbenchChatOpen,
      constraints,
    );
    const nextLayout =
      target === "files"
        ? {
            ...preferredWorkbenchLayout,
            filesWidth: clamp(
              effectiveLayout.filesWidth + direction * step,
              constraints.filesMinWidth,
              maxMountedAppFilesWidthWhenChatYields(containerWidth, workbenchChatOpen, constraints),
            ),
          }
        : {
            ...preferredWorkbenchLayout,
            chatWidth: clamp(
              effectiveLayout.chatWidth - direction * step,
              constraints.chatMinWidth,
              maxMountedAppChatWidth(
                containerWidth,
                effectiveLayout.filesWidth,
                effectiveDirectoryCollapsed,
                constraints,
              ),
            ),
          };
    persistWorkbenchLayout(nextLayout);
  }

  async function selectDirectoryTab(index: number) {
    setActiveTabIdx(index);
    if ((tabs[index]?.component === "dashboard" || tabs[index]?.component === "view") && props.selectedPath) {
      await activeDirtyState?.save();
      props.onSelectedPathChange("");
    }
  }

  function renderDirectoryContent() {
    if (directoryMode === "flow-list") {
      return (
        <FlowList
          groups={flowGroups}
          loading={flowsQuery.isLoading}
          selectedPath={props.selectedPath}
          onSelect={(path) => {
            void requestSelectedPathChange(path);
          }}
        />
      );
    }
    if (directoryMode === "dashboard") {
      return (
        <DashboardList
          dashboard={dashboardQuery.data}
          loading={dashboardQuery.isLoading}
          error={dashboardError}
          refreshing={dashboardRefreshing}
          selectedItemId={selectedDashboardItemId}
          onRefresh={refreshDashboard}
          onSelect={setSelectedDashboardItemId}
        />
      );
    }
    if (treeCollapsed) {
      return null;
    }
    if (filesQuery.isLoading) {
      return <MountedAppDirectoryLoadingState label={t("mountedApp.loading")} />;
    }
    if (!visibleEntries.length) {
      return (
        <div className="mounted-app-tree-state">
          <Folder size={15} />
          <span>{t("mountedApp.noFiles")}</span>
        </div>
      );
    }
    return (
      <FileTree
        appId={appId}
        editingPath={editingPath}
        entries={visibleEntries}
        openPaths={openPaths}
        selectedPath={props.selectedPath}
        onCancelRename={() => setEditingPath("")}
        onCreateEntry={(kind, parentPath) => createEntryMutation.mutate({ kind, parentPath })}
        onDeleteEntry={(entry) => {
          void (async () => {
            if (
              (await confirm({
                title: t("confirm.deleteEntryTitle", { name: entry.name }),
                body: t("confirm.irreversibleBody"),
                confirmLabel: t("common.delete"),
                danger: true,
              })) !== "primary"
            )
              return;
            deleteEntryMutation.mutate({ sourcePath: entry.path });
          })();
        }}
        onMoveEntry={(sourcePath, targetParentPath) => moveEntryMutation.mutate({ sourcePath, targetParentPath })}
        onOpenPathsChange={(update) => setOpenPaths(update)}
        onRenameEntry={(sourcePath, name) => renameEntryMutation.mutate({ sourcePath, name })}
        onSelect={(path) => {
          void requestSelectedPathChange(path);
        }}
        onStartRename={setEditingPath}
      />
    );
  }

  return (
    <>
      <WorkspaceWorkbenchLayout
        className="mounted-app-workbench"
        directoryCollapsed={directoryMode === "view" || directoryCollapsed}
        chatOpen={props.chatOpen}
        ref={workbenchRef}
        style={
          {
            "--mounted-app-files-width": `${effectiveWorkbenchLayout.filesWidth}px`,
            "--mounted-app-chat-width": `${effectiveWorkbenchLayout.chatWidth}px`,
            "--mounted-app-files-min-width": `${workbenchLayoutConstraints.filesMinWidth}px`,
            "--mounted-app-files-max-width": `${workbenchLayoutConstraints.filesMaxWidth}px`,
            "--mounted-app-preview-min-width": `${workbenchLayoutConstraints.previewMinWidth}px`,
            "--mounted-app-chat-min-width": `${workbenchLayoutConstraints.chatMinWidth}px`,
            "--mounted-app-chat-max-width": `${workbenchLayoutConstraints.chatMaxWidth}px`,
            "--mounted-app-resize-handle-width": `${workbenchLayoutConstraints.resizeHandleWidth}px`,
          } as CSSProperties
        }
        editorTopbar={
          <div className="mounted-app-pane-topbar">
            <div className="mounted-app-directory-tabs" role="tablist" aria-label={t("mountedApp.viewsLabel")}>
              <AnimatedBackground value={String(activeTabIndex)} backgroundClassName="mounted-app-directory-tabs-thumb">
                {tabs.map((tab, index) => {
                  const active = index === activeTabIndex;
                  return (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-active={active ? "true" : "false"}
                      data-id={String(index)}
                      key={`${tab.component}-${index}`}
                      onClick={() => {
                        void selectDirectoryTab(index);
                      }}
                    >
                      {tab.label}
                      {tab.component === "flow-list" && flowGroups.length ? (
                        <span className="mounted-app-directory-tabs-count">{flowGroups.length}</span>
                      ) : null}
                    </button>
                  );
                })}
              </AnimatedBackground>
            </div>
          </div>
        }
        directory={
          directoryMode === "view" ? null : (
            <aside
              className="mounted-app-tree-pane"
              aria-label={t("mountedApp.directoryLabel", { title: props.app.title })}
            >
              <DirectoryPanel
                title={
                  <div className="mounted-app-directory-title-row">
                    <button
                      className="mounted-app-tree-rail-toggle"
                      type="button"
                      onClick={() => setDirectoryCollapsed(true)}
                      aria-label={t("mountedApp.collapseDirectory")}
                      title={t("mountedApp.collapseDirectory")}
                    >
                      <ListVideo size={17} className="mounted-app-rail-icon-flip" />
                    </button>
                    {directoryMode === "file-tree" ? (
                      <button
                        type="button"
                        className="mounted-app-workspace-toggle"
                        aria-expanded={!treeCollapsed}
                        onClick={() => setTreeCollapsed((value) => !value)}
                        title={appInfo?.workspaceRoot ?? t("mountedApp.workspace")}
                      >
                        <span>{appInfo ? workspaceName(appInfo.workspaceRoot, t) : t("mountedApp.workspace")}</span>
                        {treeCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      </button>
                    ) : (
                      <span className="mounted-app-directory-root-label" title={activeTab.label}>
                        <span>{activeTab.label}</span>
                        {dashboardQuery.data ? (
                          <small className="mounted-app-directory-root-count">{dashboardQuery.data.items.length}</small>
                        ) : null}
                      </span>
                    )}
                  </div>
                }
                className="mounted-app-directory-panel"
                bodyClassName="mounted-app-tree-scroll"
                actions={
                  directoryMode === "dashboard" ? (
                    <button
                      className="sidebar-mini-action"
                      type="button"
                      disabled={dashboardRefreshing}
                      onClick={refreshDashboard}
                      aria-label={t("mountedApp.refresh")}
                      title={t("mountedApp.refresh")}
                    >
                      <RefreshCw
                        className="mounted-app-dashboard-refresh-icon"
                        data-spinning={dashboardRefreshing ? "true" : "false"}
                        size={15}
                      />
                    </button>
                  ) : directoryMode === "file-tree" ? (
                    <>
                      <button
                        className="sidebar-mini-action"
                        type="button"
                        disabled={importFilesMutation.isPending}
                        onClick={() => importFilesMutation.mutate({ parentPath: uploadParentPath })}
                        aria-label={uploadButtonLabel}
                        title={uploadButtonLabel}
                      >
                        {importFilesMutation.isPending ? <Loader2 size={16} /> : <FileInput size={16} />}
                      </button>
                      <button
                        className="sidebar-mini-action"
                        type="button"
                        onClick={() =>
                          createEntryMutation.mutate({ kind: "file", parentPath: currentUploadParentPath() })
                        }
                        aria-label={t("mountedApp.newMarkdown")}
                        title={t("mountedApp.newMarkdown")}
                      >
                        <FilePlus2 size={16} />
                      </button>
                      <button
                        className="sidebar-mini-action"
                        type="button"
                        onClick={() =>
                          createEntryMutation.mutate({ kind: "folder", parentPath: currentUploadParentPath() })
                        }
                        aria-label={t("mountedApp.newFolder")}
                        title={t("mountedApp.newFolder")}
                      >
                        <FolderPlus size={16} />
                      </button>
                      <button
                        className="sidebar-mini-action"
                        type="button"
                        disabled={!folderPaths.length}
                        onClick={() => setAllFolders(!allFoldersOpen)}
                        aria-label={allFoldersOpen ? t("mountedApp.collapseAll") : t("mountedApp.expandAll")}
                        title={allFoldersOpen ? t("mountedApp.collapseAll") : t("mountedApp.expandAll")}
                      >
                        {allFoldersOpen ? <ListChevronsDownUp size={16} /> : <ListChevronsUpDown size={16} />}
                      </button>
                    </>
                  ) : null
                }
              >
                {renderDirectoryContent()}
              </DirectoryPanel>
            </aside>
          )
        }
        directoryResizeHandle={
          directoryMode === "view" ? undefined : (
            <div
              className="mounted-app-resize-handle mounted-app-resize-handle-files"
              role="separator"
              aria-label={t("mountedApp.resizeFiles")}
              aria-orientation="vertical"
              aria-valuemin={workbenchLayoutConstraints.filesMinWidth}
              aria-valuemax={maxMountedAppFilesWidthWhenChatYields(
                workbenchContainerWidth,
                workbenchChatOpen,
                workbenchLayoutConstraints,
              )}
              aria-valuenow={effectiveWorkbenchLayout.filesWidth}
              tabIndex={0}
              onPointerDown={(event) => beginWorkbenchResize("files", event)}
              onKeyDown={(event) => adjustWorkbenchLayoutWithKeyboard("files", event)}
            />
          )
        }
        preview={
          <section className="mounted-app-preview-pane" aria-label={t("mountedApp.filePreview")}>
            {directoryMode !== "view" && directoryCollapsed ? (
              <button
                className="mounted-app-directory-reopen"
                type="button"
                onClick={() => setDirectoryCollapsed(false)}
                aria-label={t("mountedApp.expandDirectory")}
                title={t("mountedApp.expandDirectory")}
              >
                <ListVideo size={17} />
              </button>
            ) : null}
            <div className="mounted-app-preview-body">
              {tabs
                .filter((tab) => tab.component === "view" && tab.id && activatedViewIds.includes(tab.id))
                .map((tab) => (
                  <div
                    key={`${appId}:${tab.id}`}
                    className="mounted-app-view-tab-pane"
                    data-active={directoryMode === "view" && activeTab.id === tab.id ? "true" : "false"}
                  >
                    <MountedAppPreviewErrorBoundary
                      resetKey={`${appId}:${tab.id}:${props.runtimeRevision || "pending"}`}
                      title={t("mountedApp.mcpAppOpenFailed")}
                      copy={t("filePreview.renderFailedCopy")}
                    >
                      <MountedMcpAppView
                        app={props.app}
                        viewId={tab.id}
                        runtimeRevision={props.runtimeRevision}
                        deferUntilRuntimeRevision
                        active={directoryMode === "view" && activeTab.id === tab.id}
                      />
                    </MountedAppPreviewErrorBoundary>
                  </div>
                ))}
              {directoryMode === "view" ? null : directoryMode === "dashboard" ? (
                <DashboardPreview
                  item={activeDashboardItem}
                  loading={dashboardQuery.isLoading}
                  error={dashboardError}
                  refreshing={dashboardRefreshing}
                  source={dashboardQuery.data?.source}
                  onRefresh={refreshDashboard}
                />
              ) : (
                <MountedAppPreviewErrorBoundary
                  resetKey={props.selectedPath}
                  title={t("filePreview.renderFailedTitle")}
                  copy={t("filePreview.renderFailedCopy")}
                >
                  <FilePreviewPanel
                    file={fileQuery.data?.file}
                    loading={fileQuery.isLoading && Boolean(props.selectedPath)}
                    downloadUrl={selectedDownloadUrl}
                    rawUrl={selectedRawUrl}
                    saving={saveTextMutation.isPending}
                    selectedPath={props.selectedPath}
                    onAttachSelection={(selection) => {
                      if (props.app) {
                        props.onAddSelectionAttachment?.(selectionToComposerAttachment(props.app, selection, t));
                      }
                    }}
                    onDirtyStateChange={setFileDirtyState}
                    onOpenLocal={
                      props.selectedPath
                        ? () => {
                            openMountedAppLocalFile(appId, { path: props.selectedPath, target: "finder" }).catch(
                              (error) => {
                                console.warn("open mounted app local file failed", error);
                              },
                            );
                          }
                        : undefined
                    }
                    onSaveText={
                      props.selectedPath
                        ? (content) =>
                            saveTextMutation
                              .mutateAsync({
                                path: props.selectedPath,
                                content,
                                contentType: selectedEntry?.mimeType || "text/plain; charset=utf-8",
                              })
                              .then(() => undefined)
                        : undefined
                    }
                  />
                </MountedAppPreviewErrorBoundary>
              )}
            </div>
          </section>
        }
        chatResizeHandle={
          props.corePanel ? (
            <div
              className="mounted-app-resize-handle mounted-app-resize-handle-chat"
              role="separator"
              aria-label={t("mountedApp.resizeChat")}
              aria-orientation="vertical"
              aria-valuemin={workbenchLayoutConstraints.chatMinWidth}
              aria-valuemax={maxMountedAppChatWidth(
                workbenchContainerWidth,
                effectiveWorkbenchLayout.filesWidth,
                effectiveDirectoryCollapsed,
                workbenchLayoutConstraints,
              )}
              aria-valuenow={effectiveWorkbenchLayout.chatWidth}
              tabIndex={0}
              onPointerDown={(event) => beginWorkbenchResize("chat", event)}
              onKeyDown={(event) => adjustWorkbenchLayoutWithKeyboard("chat", event)}
            />
          ) : undefined
        }
        chat={
          props.corePanel ? (
            <aside className="mounted-app-chat-pane" aria-label={t("mountedApp.chatLabel", { title: props.app.title })}>
              {props.corePanel}
            </aside>
          ) : undefined
        }
      />
    </>
  );
}

function MountedAppDirectoryLoadingState(props: { label: string }) {
  return (
    <div className="og-skeleton-stack" role="status" aria-label={props.label} aria-busy="true">
      <span className="og-skeleton og-skeleton-line" style={{ width: "68%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "84%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "58%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "76%" }} />
    </div>
  );
}

function MountedAppPreviewLoadingState(props: { label: string }) {
  return (
    <div className="mounted-app-preview-empty" role="status" aria-label={props.label} aria-busy="true">
      <div className="og-skeleton-stack">
        <span className="og-skeleton og-skeleton-line" style={{ width: "34%" }} />
        <span className="og-skeleton og-skeleton-line" style={{ width: "72%" }} />
        <span className="og-skeleton og-skeleton-line" style={{ width: "61%" }} />
      </div>
    </div>
  );
}

function FileTree(props: {
  appId: string;
  editingPath: string;
  entries: MountedAppFileEntry[];
  openPaths: Record<string, boolean>;
  selectedPath: string;
  onCancelRename(): void;
  onCreateEntry(kind: "file" | "folder", parentPath: string): void;
  onDeleteEntry(entry: MountedAppFileEntry): void;
  onMoveEntry(sourcePath: string, targetParentPath: string): void;
  onOpenPathsChange(update: (current: Record<string, boolean>) => Record<string, boolean>): void;
  onRenameEntry(sourcePath: string, name: string): void;
  onSelect(path: string): void;
  onStartRename(path: string): void;
}) {
  const { t } = useI18n();
  const [menuState, setMenuState] = useState<DirectoryTreeMenuState | null>(null);
  const [dragSourcePath, setDragSourcePath] = useState("");
  const [dropTargetPath, setDropTargetPath] = useState("");
  const nodes = useMemo(() => mountedAppEntriesToNodes(props.entries), [props.entries]);

  useEffect(() => {
    if (!props.selectedPath) return;
    if (isHiddenMountedAppWorkspacePath(props.selectedPath)) return;
    const parents = parentPathsFromMountedAppPath(props.selectedPath);
    if (parents.length) {
      props.onOpenPathsChange((current) => ({
        ...current,
        ...Object.fromEntries(parents.map((path) => [path, true])),
      }));
    }
    scheduleMountedAppPathReveal(props.selectedPath);
  }, [props.selectedPath]);

  function toggleFolder(path: string, currentlyOpen: boolean) {
    props.onOpenPathsChange((current) => ({ ...current, [path]: !currentlyOpen }));
  }

  function openMenu(path: string) {
    setMenuState(path ? { path } : null);
  }

  function moveEntry(sourcePath: string, targetParentPath: string) {
    if (!canMoveMountedAppEntry(sourcePath, targetParentPath)) return;
    setDragSourcePath("");
    setDropTargetPath("");
    props.onMoveEntry(sourcePath, targetParentPath);
  }

  return (
    <div className="mounted-app-file-tree">
      <DirectoryTree
        className="sidebar-library-files mounted-app-sidebar-tree"
        childrenClassName="sidebar-vault-tree-children mounted-app-tree-children"
        itemClassName="mounted-app-file-node"
        rowClassName="mounted-app-tree-row"
        pathDataAttribute="data-mounted-app-path"
        nodes={nodes}
        labels={{
          more: t("mountedApp.more"),
          newFile: t("mountedApp.newMarkdown"),
          newFolder: t("mountedApp.newFolder"),
          rename: t("mountedApp.rename"),
          delete: t("mountedApp.delete"),
        }}
        openPaths={props.openPaths}
        dragSourcePath={dragSourcePath}
        dropTargetPath={dropTargetPath}
        editingPath={props.editingPath}
        menuState={menuState}
        canDropOn={(sourcePath, target) => target.kind === "folder" && canMoveMountedAppEntry(sourcePath, target.path)}
        defaultOpen={(node) => defaultFolderOpen(node.path)}
        isActive={(node) => node.kind === "file" && node.path === props.selectedPath}
        renderIcon={({ node }) => (node.kind === "folder" ? <Folder size={13} /> : fileIcon(node.data))}
        onCancelRename={props.onCancelRename}
        onCreateFile={(parentPath) => props.onCreateEntry("file", parentPath)}
        onCreateFolder={(parentPath) => props.onCreateEntry("folder", parentPath)}
        onDeleteEntry={(node) => {
          if (node.data) props.onDeleteEntry(node.data);
        }}
        onDrop={(sourcePath, target) => moveEntry(sourcePath, target.path)}
        onOpenMenu={openMenu}
        onRenameEntry={(sourcePath, name) => props.onRenameEntry(sourcePath, name)}
        onSelectFile={(node) => props.onSelect(node.path)}
        onSetDragSource={setDragSourcePath}
        onSetDropTarget={setDropTargetPath}
        onStartRename={(sourcePath) => props.onStartRename(sourcePath)}
        onToggleFolder={(path, currentlyOpen) => toggleFolder(path, currentlyOpen)}
      />
    </div>
  );
}

function FlowList(props: {
  groups: MountedAppFlowWorkflowGroup[];
  loading: boolean;
  selectedPath: string;
  onSelect(path: string): void;
}) {
  const { language, t } = useI18n();
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set());
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => new Set());
  const [expandedHistoryGroupIds, setExpandedHistoryGroupIds] = useState<Set<string>>(() => new Set());

  function toggleGroup(groupId: string, expanded: boolean) {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (expanded) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (expanded) {
        next.add(groupId);
      } else {
        next.delete(groupId);
      }
      return next;
    });
  }

  function expandHistory(groupId: string) {
    setExpandedHistoryGroupIds((current) => {
      const next = new Set(current);
      next.add(groupId);
      return next;
    });
  }

  if (props.loading) {
    return <MountedAppDirectoryLoadingState label={t("mountedApp.loading")} />;
  }
  if (!props.groups.length) {
    return (
      <div className="mounted-app-tree-state">
        <FileText size={15} />
        <span>{t("mountedApp.noWorkflows")}</span>
      </div>
    );
  }
  return (
    <div className="mounted-app-flow-list">
      {props.groups.map((group) => {
        const active = group.flows.some((flow) => flow.path === props.selectedPath);
        const collapsed = collapsedGroupIds.has(group.id);
        const expanded =
          !collapsed &&
          (active || expandedGroupIds.has(group.id) || MOUNTED_APP_ACTIVE_FLOW_STATUSES.includes(group.status));
        const fullHistoryExpanded = expandedHistoryGroupIds.has(group.id);
        const visibleRuns = fullHistoryExpanded ? group.flows : group.flows.slice(0, MOUNTED_APP_FLOW_HISTORY_LIMIT);
        const hiddenRunCount = Math.max(0, group.flows.length - visibleRuns.length);
        const latestTime = mountedAppFlowTimeLabel(group.latestFlow, language);
        const groupMeta = [
          mountedAppFlowStatusLabel(group.status, t),
          t("mountedApp.flowRunCount", { count: group.flows.length }),
          latestTime ? t("mountedApp.flowLatestRun", { time: latestTime }) : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <section className="mounted-app-flow-group" key={group.id}>
            <div className="mounted-app-flow-workflow">
              <button
                className="mounted-app-flow-expander"
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? t("mountedApp.flowCollapseRuns") : t("mountedApp.flowExpandRuns")}
                title={expanded ? t("mountedApp.flowCollapseRuns") : t("mountedApp.flowExpandRuns")}
                onClick={() => toggleGroup(group.id, expanded)}
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <button
                className="mounted-app-flow-workflow-row"
                type="button"
                data-active={active ? "true" : "false"}
                data-status={group.status}
                onClick={() => props.onSelect(group.latestFlow.path)}
              >
                <FileText size={14} />
                <span>
                  <strong>{group.title}</strong>
                  <small>{groupMeta}</small>
                </span>
              </button>
            </div>
            {expanded ? (
              <div className="mounted-app-flow-run-list">
                {visibleRuns.map((flow) => {
                  const status = mountedAppFlowStatus(flow);
                  const runTime = mountedAppFlowTimeLabel(flow, language) || mountedAppFlowDisplayTitle(flow);
                  return (
                    <button
                      className="mounted-app-flow-row"
                      type="button"
                      data-active={flow.path === props.selectedPath ? "true" : "false"}
                      data-status={status}
                      key={flow.path}
                      onClick={() => props.onSelect(flow.path)}
                    >
                      <FileText size={13} />
                      <span>
                        <strong>{runTime}</strong>
                        <small>
                          {flow.valid
                            ? `${mountedAppFlowStatusLabel(status, t)} · ${flow.path}`
                            : `${t("mountedApp.flowParseFailed")} · ${flow.path}`}
                        </small>
                      </span>
                    </button>
                  );
                })}
                {hiddenRunCount ? (
                  <button className="mounted-app-flow-more-runs" type="button" onClick={() => expandHistory(group.id)}>
                    {t("mountedApp.flowMoreRuns", { count: hiddenRunCount })}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function DashboardList(props: {
  dashboard: MountedAppDashboardResponse | undefined;
  loading: boolean;
  error: string;
  refreshing: boolean;
  selectedItemId: string;
  onRefresh(): void;
  onSelect(itemId: string): void;
}) {
  const { t } = useI18n();
  if (props.loading && !props.dashboard) {
    return <MountedAppDirectoryLoadingState label={t("mountedApp.dashboardLoading")} />;
  }
  if (props.error && !props.dashboard) {
    return (
      <div className="mounted-app-tree-state">
        <CircleAlert size={15} />
        <span>{dashboardErrorLabel(props.error, t)}</span>
        <button
          className="mounted-app-dashboard-retry"
          type="button"
          disabled={props.refreshing}
          onClick={props.onRefresh}
        >
          {props.refreshing ? (
            <Loader2 className="mounted-app-dashboard-refresh-icon" data-spinning="true" size={14} />
          ) : null}
          {t("mountedApp.retry")}
        </button>
      </div>
    );
  }
  const items = props.dashboard?.items ?? [];
  if (!items.length) {
    return (
      <div className="mounted-app-tree-state">
        <BarChart3 size={15} />
        <span>{t("mountedApp.dashboardEmpty")}</span>
      </div>
    );
  }
  return (
    <div className="mounted-app-dashboard-list">
      <DashboardErrorNotice error={props.error} refreshing={props.refreshing} onRefresh={props.onRefresh} />
      <section className="mounted-app-dashboard-items" aria-label={t("mountedApp.dashboardBooks")}>
        {items.map((item) => (
          <button
            className="mounted-app-dashboard-row"
            type="button"
            data-active={item.id === props.selectedItemId ? "true" : "false"}
            key={item.id}
            onClick={() => props.onSelect(item.id)}
          >
            <Folder size={14} />
            <span>
              <strong title={item.title}>{item.title}</strong>
            </span>
          </button>
        ))}
      </section>
    </div>
  );
}

function DashboardPreview(props: {
  item: MountedAppDashboardItem | undefined;
  loading: boolean;
  error: string;
  refreshing: boolean;
  source?: "cloud" | "local_mock";
  onRefresh(): void;
}) {
  const { t } = useI18n();
  if (props.loading && !props.item) {
    return <MountedAppPreviewLoadingState label={t("mountedApp.dashboardLoading")} />;
  }
  if (props.error && !props.item) {
    return (
      <div className="mounted-app-preview-empty">
        <CircleAlert size={18} />
        <strong>{dashboardErrorLabel(props.error, t)}</strong>
        <button
          className="mounted-app-dashboard-retry"
          type="button"
          disabled={props.refreshing}
          onClick={props.onRefresh}
        >
          {props.refreshing ? (
            <Loader2 className="mounted-app-dashboard-refresh-icon" data-spinning="true" size={14} />
          ) : null}
          {t("mountedApp.retry")}
        </button>
      </div>
    );
  }
  if (!props.item) {
    return (
      <div className="mounted-app-preview-empty">
        <BarChart3 size={18} />
        <strong>{t("mountedApp.dashboardSelectBook")}</strong>
      </div>
    );
  }
  // 飞书式呈现：把同一份档位数据重排成「大数字 hero + 可视化进度叙事 + 分组卡片」。
  // 留存与吸引力两组指标合并进一个进度条矩阵，漏斗从纯文字升级为分段可视化条。
  const item = props.item;
  const retentionMetrics = item.sections.retention?.metrics ?? [];
  const acquisitionMetrics = acquisitionLabelsForAuthor(item.sections.acquisition?.metrics, t);
  const funnel = item.sections.retention?.funnel;
  const suggestions = item.sections.diagnosis?.suggestions ?? [];
  const strengths = item.sections.diagnosis?.strengths ?? [];
  return (
    <div className="mounted-app-dashboard-preview">
      <header className="mounted-app-dashboard-preview-header">
        <h2>{item.title}</h2>
        <button
          type="button"
          disabled={props.refreshing}
          onClick={props.onRefresh}
          title={t("mountedApp.refresh")}
          aria-label={t("mountedApp.refresh")}
        >
          <RefreshCw
            className="mounted-app-dashboard-refresh-icon"
            data-spinning={props.refreshing ? "true" : "false"}
            size={15}
          />
        </button>
      </header>
      <div className="mounted-app-dashboard-preview-scroll">
        <DashboardErrorNotice error={props.error} refreshing={props.refreshing} onRefresh={props.onRefresh} />
        <DashboardHero grade={item.grade} topAlert={item.topAlert} commission={item.commission} />
        {retentionMetrics.length || acquisitionMetrics.length ? (
          <section className="mounted-app-dashboard-card">
            {retentionMetrics.length ? (
              <DashboardMetricGroup title={t("mountedApp.dashboardRetention")} metrics={retentionMetrics} />
            ) : null}
            {acquisitionMetrics.length ? (
              <DashboardMetricGroup title={t("mountedApp.dashboardAcquisitionFallback")} metrics={acquisitionMetrics} />
            ) : null}
          </section>
        ) : null}
        <DashboardFunnel funnel={funnel} />
        {suggestions.length || strengths.length ? (
          <section className="mounted-app-dashboard-card mounted-app-dashboard-diagnosis">
            <h3>{t("mountedApp.dashboardDiagnosis")}</h3>
            <div className="mounted-app-dashboard-diagnosis-grid">
              <DashboardTextList tone="suggestion" title={t("mountedApp.dashboardSuggestions")} items={suggestions} />
              <DashboardTextList tone="strength" title={t("mountedApp.dashboardStrengths")} items={strengths} />
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

// ===== Shared dashboard presentation =====

function DashboardErrorNotice(props: { error: string; refreshing: boolean; onRefresh(): void }) {
  const { t } = useI18n();
  if (!props.error) return null;
  return (
    <div className="mounted-app-dashboard-error-notice" role="status">
      <CircleAlert size={15} />
      <span>{dashboardErrorLabel(props.error, t)}</span>
      <button
        className="mounted-app-dashboard-retry"
        type="button"
        disabled={props.refreshing}
        onClick={props.onRefresh}
      >
        {props.refreshing ? (
          <Loader2 className="mounted-app-dashboard-refresh-icon" data-spinning="true" size={14} />
        ) : null}
        {t("mountedApp.retry")}
      </button>
    </div>
  );
}

function dashboardErrorLabel(error: string, t: TranslationFn): string {
  return error === "auth_required" ? t("mountedApp.dashboardAuthRequired") : t("mountedApp.dashboardUnavailable");
}

// Hero：飞书式焦点区——整体档徽章 + 顶部警示行 + 可选业务指标。
function DashboardHero(props: {
  grade: MountedAppDashboardGrade;
  topAlert?: string;
  commission?: MountedAppDashboardItem["commission"];
}) {
  const { t } = useI18n();
  const commissionParts = props.commission?.parts?.length
    ? props.commission.parts
    : props.commission?.estimate
      ? [{ label: props.commission.label || t("mountedApp.dashboardCommission"), estimate: props.commission.estimate }]
      : [];
  return (
    <section className="mounted-app-dashboard-card mounted-app-dashboard-hero">
      <div className="mounted-app-dashboard-hero-top">
        <span className="mounted-app-dashboard-hero-kicker">{t("mountedApp.dashboardOverallGrade")}</span>
        <GradeBadge grade={props.grade} />
      </div>
      {props.topAlert ? (
        <p className="mounted-app-dashboard-alert" data-grade={props.grade}>
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{cleanDashboardAlert(props.topAlert)}</span>
        </p>
      ) : null}
      {commissionParts.length ? (
        <div className="mounted-app-dashboard-hero-stats">
          {commissionParts.map((part) => (
            <div className="mounted-app-dashboard-stat" key={`${part.label}-${part.estimate}`}>
              <span>{part.label}</span>
              <strong>{part.estimate}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// 进度条矩阵：每个指标一行——标签 + 档位驱动的彩色进度条 + 档位文字。
function DashboardMetricGroup(props: {
  title: string;
  metrics: Array<{ label: string; grade: MountedAppDashboardGrade }>;
}) {
  return (
    <div className="mounted-app-dashboard-metric-group">
      <span className="mounted-app-dashboard-card-label">{props.title}</span>
      <div className="mounted-app-dashboard-metric-rows">
        {props.metrics.map((metric) => (
          <MetricRow key={metric.label} label={metric.label} grade={metric.grade} />
        ))}
      </div>
    </div>
  );
}

// 指标行：色条长度+颜色把档位变成视觉量，横排对齐一眼可比。
function MetricRow(props: { label: string; grade: MountedAppDashboardGrade }) {
  const { t } = useI18n();
  return (
    <div className="mounted-app-dashboard-metric" data-grade={props.grade}>
      <span className="mounted-app-dashboard-metric-label">{props.label}</span>
      <div className="mounted-app-dashboard-metric-bar" aria-hidden="true">
        <i />
      </div>
      <small className="mounted-app-dashboard-metric-grade">{dashboardGradeShortLabel(props.grade, t)}</small>
    </div>
  );
}

// 漏斗卡：有章节到达数据时渲染「章节留存带」——每章一根柱、高度=到达率，
// 免费/付费分界画竖虚线，最大流失章标红，结论放卡头；没有到达数据时退回
// 「免费章 / 付费章」比例条，避免渲染整页空行。
function DashboardFunnel(props: { funnel: MountedAppDashboardFunnel | undefined }) {
  const { t } = useI18n();
  const funnel = props.funnel;
  const chapters = (funnel?.chapters ?? [])
    .filter((chapter) => Number.isFinite(chapter.chapter) && chapter.chapter > 0)
    .sort((left, right) => left.chapter - right.chapter);
  const mode = funnel?.mode === "dropoff" ? "dropoff" : "split";
  const inferredTotal = chapters.reduce((largest, chapter) => Math.max(largest, chapter.chapter), 0);
  const inferredFree = inferDashboardFunnelFree(chapters);
  const free = typeof funnel?.freeChapters === "number" && funnel.freeChapters > 0 ? funnel.freeChapters : inferredFree;
  const total =
    typeof funnel?.totalChapters === "number" && funnel.totalChapters > 0 ? funnel.totalChapters : inferredTotal;
  if (total <= 0 && !chapters.length) return null;
  const drop = funnel?.maxDropChapter;
  const maxDrop =
    drop?.label ||
    (drop?.from && drop?.to
      ? t("mountedApp.dashboardFunnelDrop", { from: String(drop.from), to: String(drop.to) })
      : "");
  const dropSummary = [maxDrop, dashboardFunnelDropDelta(chapters, drop)].filter(Boolean).join(" · ");
  const hasReachData = chapters.some((chapter) => normalizedDashboardPercent(chapter.reachPercent) !== undefined);
  const boundaryRatio =
    total > 0 ? (mode === "dropoff" && drop?.from ? clamp(drop.from / total, 0, 1) : clamp(free / total, 0, 1)) : 0;
  // 断点落在「免费章→付费章」边界附近，用 from 章节在总量中的相对位置标记。
  const dropAt = drop?.from && total > 0 ? clamp(drop.from / total, 0, 1) : null;
  return (
    <section className="mounted-app-dashboard-card mounted-app-dashboard-funnel">
      <div className="mounted-app-dashboard-funnel-head">
        <span className="mounted-app-dashboard-card-label">{t("mountedApp.dashboardFunnel")}</span>
        {dropSummary ? <span className="mounted-app-dashboard-funnel-drop-summary">{dropSummary}</span> : null}
      </div>
      {hasReachData ? (
        <DashboardChapterBand chapters={chapters} free={free} dropTo={drop?.to} />
      ) : total > 0 ? (
        <>
          <div
            className="mounted-app-dashboard-funnel-bar"
            data-mode={mode}
            style={{ "--funnel-free": `${Math.round(boundaryRatio * 100)}%` } as CSSProperties}
            aria-hidden="true"
          >
            <span className="mounted-app-dashboard-funnel-free" />
            <span className="mounted-app-dashboard-funnel-paid" />
            {dropAt !== null ? (
              <span
                className="mounted-app-dashboard-funnel-marker"
                style={{ left: `${Math.round(dropAt * 100)}%` }}
                title={dropSummary || undefined}
              />
            ) : null}
          </div>
          {chapters.length ? (
            <p className="mounted-app-dashboard-funnel-nodata">{t("mountedApp.dashboardFunnelNoData")}</p>
          ) : null}
        </>
      ) : null}
      {mode === "split" ? (
        <div className="mounted-app-dashboard-funnel-legend">
          <span className="mounted-app-dashboard-funnel-legend-free">
            {t("mountedApp.dashboardFunnelFree")} · {free || "-"}
          </span>
          <span className="mounted-app-dashboard-funnel-legend-paid">
            {t("mountedApp.dashboardFunnelPaid")} · {total > free ? total - free : "-"}
          </span>
          <span className="mounted-app-dashboard-funnel-legend-total">
            {t("mountedApp.dashboardFunnelShape", { free: String(free || "-"), total: String(total || "-") })}
          </span>
        </div>
      ) : null}
    </section>
  );
}

// 一根柱 = 一章（章数多时一根柱聚合相邻几章），tooltip 承载章名/到达率/UV/免费付费。
const DASHBOARD_BAND_MAX_BARS = 60;

type DashboardBandBar = {
  key: string;
  title: string;
  reach: number | undefined;
  phase: "free" | "paid" | "mixed";
  drop: boolean;
};

// 章节留存带：X 轴按章节顺序排布，柱高=到达率，整条带即留存衰减曲线。
function DashboardChapterBand(props: { chapters: MountedAppDashboardFunnelChapter[]; free: number; dropTo?: number }) {
  const { t } = useI18n();
  const bars = buildDashboardBandBars(props.chapters, props.dropTo, t);
  const freeCount = props.chapters.filter((chapter) => chapter.chapter <= props.free).length;
  const boundaryRatio =
    props.free > 0 && freeCount > 0 && freeCount < props.chapters.length ? freeCount / props.chapters.length : null;
  const firstChapter = props.chapters[0];
  const lastChapter = props.chapters[props.chapters.length - 1];
  if (!firstChapter || !lastChapter) return null;
  return (
    <div className="mounted-app-dashboard-chapter-band" aria-label={t("mountedApp.dashboardChapterFunnel")}>
      <div className="mounted-app-dashboard-chapter-band-plot">
        {bars.map((bar) => (
          <span
            key={bar.key}
            className="mounted-app-dashboard-chapter-band-bar"
            data-phase={bar.phase}
            data-drop={bar.drop ? "true" : "false"}
            title={bar.title}
          >
            <i
              data-empty={bar.reach === undefined ? "true" : "false"}
              style={bar.reach === undefined ? undefined : { height: `${Math.max(4, Math.round(bar.reach))}%` }}
            />
          </span>
        ))}
        {boundaryRatio !== null ? (
          <span
            className="mounted-app-dashboard-chapter-band-boundary"
            style={{ left: `${(boundaryRatio * 100).toFixed(2)}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className="mounted-app-dashboard-chapter-band-axis" aria-hidden="true">
        <span>{firstChapter.label || String(firstChapter.chapter)}</span>
        <small>{t("mountedApp.dashboardFunnelReach")}</small>
        <span>{lastChapter.label || String(lastChapter.chapter)}</span>
      </div>
    </div>
  );
}

function buildDashboardBandBars(
  chapters: MountedAppDashboardFunnelChapter[],
  dropTo: number | undefined,
  t: TranslationFn,
): DashboardBandBar[] {
  const bucketSize = Math.max(1, Math.ceil(chapters.length / DASHBOARD_BAND_MAX_BARS));
  const bars: DashboardBandBar[] = [];
  for (let start = 0; start < chapters.length; start += bucketSize) {
    const bucket = chapters.slice(start, start + bucketSize);
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    const reaches = bucket
      .map((chapter) => normalizedDashboardPercent(chapter.reachPercent))
      .filter((value): value is number => value !== undefined);
    const reach = reaches.length ? reaches.reduce((sum, value) => sum + value, 0) / reaches.length : undefined;
    const label =
      bucket.length > 1
        ? t("mountedApp.dashboardFunnelBucket", { from: String(first.chapter), to: String(last.chapter) })
        : first.label || String(first.chapter);
    const phase = bucket.every((chapter) => chapter.paid === true)
      ? ("paid" as const)
      : bucket.every((chapter) => chapter.paid === false)
        ? ("free" as const)
        : ("mixed" as const);
    const reachLabel = formatDashboardPercent(reach);
    // UV 只在单章柱上展示；聚合桶里各章 UV 相加没有业务含义。
    const uvLabel =
      bucket.length === 1 && typeof first.uv === "number" && Number.isFinite(first.uv)
        ? `${formatDashboardInteger(first.uv)} ${t("mountedApp.dashboardFunnelUv")}`
        : "";
    const phaseLabel =
      phase === "paid"
        ? t("mountedApp.dashboardFunnelPaid")
        : phase === "free"
          ? t("mountedApp.dashboardFunnelFree")
          : "";
    bars.push({
      key: `${first.chapter}-${last.chapter}`,
      title: [
        label,
        reachLabel !== "-" ? `${t("mountedApp.dashboardFunnelReach")} ${reachLabel}` : "",
        uvLabel,
        phaseLabel,
      ]
        .filter(Boolean)
        .join(" · "),
      reach,
      phase,
      drop: dropTo !== undefined && bucket.some((chapter) => chapter.chapter === dropTo),
    });
  }
  return bars;
}

// 最大流失点的实际落差（到达率百分点差），两端都有数据时补进卡头摘要。
function dashboardFunnelDropDelta(
  chapters: MountedAppDashboardFunnelChapter[],
  drop: MountedAppDashboardFunnel["maxDropChapter"],
): string {
  if (!drop?.from || !drop?.to) return "";
  const fromReach = normalizedDashboardPercent(chapters.find((chapter) => chapter.chapter === drop.from)?.reachPercent);
  const toReach = normalizedDashboardPercent(chapters.find((chapter) => chapter.chapter === drop.to)?.reachPercent);
  if (fromReach === undefined || toReach === undefined) return "";
  const delta = fromReach - toReach;
  if (delta <= 0) return "";
  return `-${formatDashboardPercent(delta)}`;
}

function inferDashboardFunnelFree(chapters: MountedAppDashboardFunnelChapter[]): number {
  const paidStart = chapters
    .filter((chapter) => chapter.paid === true)
    .reduce(
      (first, chapter) => (first === undefined ? chapter.chapter : Math.min(first, chapter.chapter)),
      undefined as number | undefined,
    );
  if (paidStart && paidStart > 1) return paidStart - 1;
  return chapters
    .filter((chapter) => chapter.paid === false)
    .reduce((last, chapter) => Math.max(last, chapter.chapter), 0);
}

function normalizedDashboardPercent(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return clamp(value, 0, 100);
}

function formatDashboardPercent(value: number | undefined): string {
  if (value === undefined) return "-";
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}%`;
}

function formatDashboardInteger(value: number): string {
  return formatNumber(Math.max(0, Math.round(value)));
}

// 作者视角：获客只保留 CTR/CVR（题材吸引力 + 开头留人），去掉作者改不了的 CPA/ARPU。
// 同时把投放行话翻译成作者能懂、能动手的措辞。
const AUTHOR_ACQUISITION_LABELS: Array<{ match: RegExp; labelKey: TranslationKey }> = [
  { match: /ctr|点击率/i, labelKey: "mountedApp.acquisitionCoverAppeal" },
  { match: /cvr|转化率|落地页/i, labelKey: "mountedApp.acquisitionOpeningRetention" },
];

function acquisitionLabelsForAuthor(
  metrics: Array<{ label: string; grade: MountedAppDashboardGrade }> | undefined,
  t: TranslationFn = translate,
): Array<{ label: string; grade: MountedAppDashboardGrade }> {
  if (!metrics?.length) return [];
  const output: Array<{ label: string; grade: MountedAppDashboardGrade }> = [];
  for (const metric of metrics) {
    const mapped = AUTHOR_ACQUISITION_LABELS.find((entry) => entry.match.test(metric.label));
    if (!mapped) continue; // CPA/ARPU 等作者改不了的，不展示
    output.push({ label: t(mapped.labelKey), grade: metric.grade });
  }
  return output;
}

function findEntry(entries: MountedAppFileEntry[], path: string): MountedAppFileEntry | undefined {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    const child = findEntry(entry.children ?? [], path);
    if (child) return child;
  }
  return undefined;
}

function filterMountedAppWorkspaceEntries(entries: MountedAppFileEntry[]): MountedAppFileEntry[] {
  return entries.flatMap((entry) => {
    if (isHiddenMountedAppWorkspaceEntry(entry)) return [];
    if (entry.kind !== "directory") return [entry];
    return [
      {
        ...entry,
        children: filterMountedAppWorkspaceEntries(entry.children ?? []),
      },
    ];
  });
}

function isHiddenMountedAppWorkspaceEntry(entry: MountedAppFileEntry): boolean {
  return isHiddenMountedAppWorkspacePath(entry.path || entry.name);
}

function isHiddenMountedAppWorkspacePath(path: string): boolean {
  const segments = path
    .split(/[\\/]/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  return segments.some((name) => name === ".claude" || name === ".codex" || name === "readme.md" || name === "readme");
}

function mountedAppEntriesToNodes(entries: MountedAppFileEntry[]): MountedAppTreeNode[] {
  return entries.map((entry) => ({
    id: entry.path,
    name: entry.name,
    kind: entry.kind === "directory" ? "folder" : "file",
    path: entry.path,
    data: entry,
    children: mountedAppEntriesToNodes(entry.children ?? []),
  }));
}

function buildMountedAppFlowGroups(flows: MountedAppFlowRecord[]): MountedAppFlowWorkflowGroup[] {
  const groups = new Map<string, MountedAppFlowRecord[]>();
  for (const flow of flows) {
    const groupId = mountedAppFlowWorkflowId(flow);
    groups.set(groupId, [...(groups.get(groupId) ?? []), flow]);
  }
  return Array.from(groups.entries())
    .map(([id, groupFlows]) => {
      const sortedFlows = [...groupFlows].sort(compareMountedAppFlows);
      const latestFlow = sortedFlows[0];
      return latestFlow
        ? {
            id,
            title: mountedAppFlowDisplayTitle(latestFlow),
            status: mountedAppWorkflowStatus(sortedFlows),
            latestFlow,
            flows: sortedFlows,
          }
        : undefined;
    })
    .filter((group): group is MountedAppFlowWorkflowGroup => Boolean(group))
    .sort((a, b) => {
      const statusDelta = mountedAppFlowStatusRank(a.status) - mountedAppFlowStatusRank(b.status);
      if (statusDelta !== 0) return statusDelta;
      const timeDelta = mountedAppFlowTimestamp(b.latestFlow) - mountedAppFlowTimestamp(a.latestFlow);
      if (timeDelta !== 0) return timeDelta;
      return compareLocalizedText(a.title, b.title);
    });
}

function mountedAppFlowWorkflowId(flow: MountedAppFlowRecord): string {
  const initiator = typeof flow.frontmatter?.initiator === "string" ? flow.frontmatter.initiator.trim() : "";
  if (initiator.startsWith("routine:")) {
    const routineId = initiator.slice("routine:".length).trim();
    if (routineId) return `routine:${routineId}`;
  }
  if (initiator) return `initiator:${initiator}`;
  const title = flow.frontmatter?.title?.trim();
  if (title) return `title:${title.toLowerCase()}`;
  return `file:${flow.path}`;
}

function mountedAppWorkflowStatus(flows: MountedAppFlowRecord[]): MountedAppFlowStatus {
  const runFlows = flows.filter((flow) => !isMountedAppWorkflowDefinition(flow));
  const statusFlows = runFlows.length ? runFlows : flows;
  for (const status of MOUNTED_APP_ACTIVE_FLOW_STATUSES) {
    if (statusFlows.some((flow) => mountedAppFlowStatus(flow) === status)) return status;
  }
  return statusFlows[0] ? mountedAppFlowStatus(statusFlows[0]) : "failed";
}

function mountedAppFlowStatus(flow: MountedAppFlowRecord): MountedAppFlowStatus {
  return flow.frontmatter?.status ?? "failed";
}

function isMountedAppWorkflowDefinition(flow: MountedAppFlowRecord): boolean {
  const kind = typeof flow.frontmatter?.kind === "string" ? flow.frontmatter.kind.trim() : "";
  if (kind) return kind === "definition";
  // Legacy workflow.create definitions predate explicit kind. Routine runner
  // run files currently always include started, so flows/ files without it are
  // treated as definitions for backward compatibility only.
  return flow.path.replace(/\\/g, "/").startsWith("flows/") && !flow.frontmatter?.started;
}

function mountedAppFlowStatusRank(status: MountedAppFlowStatus): number {
  const index = MOUNTED_APP_FLOW_STATUS_SORT_ORDER.indexOf(status);
  return index === -1 ? MOUNTED_APP_FLOW_STATUS_SORT_ORDER.length : index;
}

function compareMountedAppFlows(a: MountedAppFlowRecord, b: MountedAppFlowRecord): number {
  const timeDelta = mountedAppFlowTimestamp(b) - mountedAppFlowTimestamp(a);
  if (timeDelta !== 0) return timeDelta;
  return b.path.localeCompare(a.path);
}

function mountedAppFlowTimestamp(flow: MountedAppFlowRecord): number {
  const value = flow.frontmatter?.updated || flow.frontmatter?.started || flow.mtime;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function mountedAppFlowTimeLabel(flow: MountedAppFlowRecord, locale?: string): string {
  const value = flow.frontmatter?.updated || flow.frontmatter?.started || flow.mtime;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value || "";
  return cachedDateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function mountedAppFlowDisplayTitle(flow: MountedAppFlowRecord): string {
  const title = flow.frontmatter?.title?.trim();
  if (title) return title;
  const fileName = flow.path.split("/").pop() || flow.path;
  return fileName.replace(/\.flow\.md$/i, "");
}

function mountedAppFlowStatusLabel(status: string, t: TranslationFn): string {
  switch (status) {
    case "waiting_user":
      return t("mountedApp.flowWaitingUser");
    case "running":
      return t("mountedApp.flowRunning");
    case "pending":
      return t("mountedApp.flowPending");
    case "done":
      return t("mountedApp.flowDone");
    case "failed":
      return t("mountedApp.flowFailed");
    default:
      return status;
  }
}

function fileIcon(entry: MountedAppFileEntry | undefined) {
  const mimeType = entry?.mimeType || "";
  if (mimeType.startsWith("image/")) return <ImageIcon size={14} />;
  if (mimeType.startsWith("video/")) return <Video size={14} />;
  return <FileText size={14} />;
}

function mountedAppOpenPathsStorageKey(appId: string): string {
  return `opengroveMountedAppOpenPaths:${appId || "default"}`;
}

function mountedAppDirectoryCollapsedStorageKey(appId: string): string {
  return `opengroveMountedAppDirectoryCollapsed:${appId || "default"}`;
}

function mountedAppWorkbenchLayoutStorageKey(appId: string): string {
  return `opengroveMountedAppWorkbenchLayout:${appId || "default"}`;
}

function defaultMountedAppWorkbenchLayout(
  declaredDefaults: MountedAppWorkbenchLayoutDefaults = {},
): MountedAppWorkbenchLayoutState {
  return {
    filesWidth: Math.round(
      clamp(
        declaredDefaults.filesWidth ?? DEFAULT_MOUNTED_APP_WORKBENCH_LAYOUT.filesWidth,
        MIN_STORED_MOUNTED_APP_FILES_WIDTH,
        MAX_STORED_MOUNTED_APP_FILES_WIDTH,
      ),
    ),
    chatWidth: Math.round(
      clamp(
        declaredDefaults.chatWidth ?? DEFAULT_MOUNTED_APP_WORKBENCH_LAYOUT.chatWidth,
        MIN_STORED_MOUNTED_APP_CHAT_WIDTH,
        MAX_STORED_MOUNTED_APP_CHAT_WIDTH,
      ),
    ),
  };
}

function resolveMountedAppWorkbenchLayoutConstraints(
  layoutMode: MountedAppWorkbenchLayoutMode,
  containerWidth: number,
): MountedAppWorkbenchLayoutConstraints {
  if (layoutMode !== "embedded") return STANDARD_MOUNTED_APP_WORKBENCH_CONSTRAINTS;
  // Before the first measurement, prefer the safer wide profile; layout measurement runs before paint.
  return containerWidth > 0 && containerWidth <= COMPACT_EMBEDDED_APP_WORKBENCH_MAX_WIDTH
    ? COMPACT_EMBEDDED_APP_WORKBENCH_CONSTRAINTS
    : WIDE_EMBEDDED_APP_WORKBENCH_CONSTRAINTS;
}

function maxMountedAppFilesWidth(
  containerWidth: number,
  chatWidth: number,
  chatOpen: boolean,
  constraints: MountedAppWorkbenchLayoutConstraints,
): number {
  if (!containerWidth) return constraints.filesMaxWidth;
  const chatReserve = chatOpen ? chatWidth + constraints.resizeHandleWidth : 0;
  const available = containerWidth - chatReserve - constraints.previewWidthReserve;
  return Math.max(constraints.filesMinWidth, Math.min(constraints.filesMaxWidth, available));
}

function maxMountedAppFilesWidthWhenChatYields(
  containerWidth: number,
  chatOpen: boolean,
  constraints: MountedAppWorkbenchLayoutConstraints,
): number {
  return maxMountedAppFilesWidth(containerWidth, constraints.chatMinWidth, chatOpen, constraints);
}

function maxMountedAppChatWidth(
  containerWidth: number,
  filesWidth: number,
  directoryCollapsed: boolean,
  constraints: MountedAppWorkbenchLayoutConstraints,
): number {
  if (!containerWidth) return constraints.chatMaxWidth;
  const directoryReserve = directoryCollapsed ? 0 : filesWidth;
  const available = containerWidth - directoryReserve - constraints.previewWidthReserve - constraints.resizeHandleWidth;
  return Math.max(constraints.chatMinWidth, Math.min(constraints.chatMaxWidth, available));
}

function mountedAppWorkbenchWidth(workbench: HTMLElement | null): number {
  return workbench?.clientWidth ?? 0;
}

function constrainMountedAppWorkbenchLayout(
  preferredLayout: MountedAppWorkbenchLayoutState,
  containerWidth: number,
  directoryCollapsed: boolean,
  chatOpen: boolean,
  constraints: MountedAppWorkbenchLayoutConstraints,
): MountedAppWorkbenchLayoutState {
  // Window constraints preserve the user's left-side file width first; chat yields until its minimum.
  const filesWidth = clamp(
    preferredLayout.filesWidth,
    constraints.filesMinWidth,
    maxMountedAppFilesWidthWhenChatYields(containerWidth, chatOpen, constraints),
  );
  const chatWidth = clamp(
    preferredLayout.chatWidth,
    constraints.chatMinWidth,
    maxMountedAppChatWidth(containerWidth, filesWidth, directoryCollapsed, constraints),
  );
  return {
    filesWidth: Math.round(filesWidth),
    chatWidth: Math.round(chatWidth),
  };
}

function sanitizeStoredMountedAppWorkbenchLayout(
  value: Partial<MountedAppWorkbenchLayoutState>,
  defaultLayout: MountedAppWorkbenchLayoutState = DEFAULT_MOUNTED_APP_WORKBENCH_LAYOUT,
): MountedAppWorkbenchLayoutState {
  const storedFilesWidth =
    typeof value.filesWidth === "number" && Number.isFinite(value.filesWidth)
      ? value.filesWidth
      : defaultLayout.filesWidth;
  const storedChatWidth =
    typeof value.chatWidth === "number" && Number.isFinite(value.chatWidth) ? value.chatWidth : defaultLayout.chatWidth;
  return {
    filesWidth: Math.round(
      clamp(storedFilesWidth, MIN_STORED_MOUNTED_APP_FILES_WIDTH, MAX_STORED_MOUNTED_APP_FILES_WIDTH),
    ),
    chatWidth: Math.round(clamp(storedChatWidth, MIN_STORED_MOUNTED_APP_CHAT_WIDTH, MAX_STORED_MOUNTED_APP_CHAT_WIDTH)),
  };
}

function readStoredMountedAppWorkbenchLayout(
  appId: string,
  declaredDefaults: MountedAppWorkbenchLayoutDefaults,
): MountedAppWorkbenchLayoutState {
  const defaultLayout = defaultMountedAppWorkbenchLayout(declaredDefaults);
  try {
    const raw = window.localStorage.getItem(mountedAppWorkbenchLayoutStorageKey(appId));
    if (!raw) return defaultLayout;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultLayout;
    return sanitizeStoredMountedAppWorkbenchLayout(parsed, defaultLayout);
  } catch {
    return defaultLayout;
  }
}

function writeStoredMountedAppWorkbenchLayout(appId: string, layout: MountedAppWorkbenchLayoutState): void {
  try {
    window.localStorage.setItem(
      mountedAppWorkbenchLayoutStorageKey(appId),
      JSON.stringify(sanitizeStoredMountedAppWorkbenchLayout(layout)),
    );
  } catch {
    // Width changes remain active for the current session even if storage is unavailable.
  }
}

function readStoredMountedAppDirectoryCollapsed(appId: string): boolean {
  try {
    return window.localStorage.getItem(mountedAppDirectoryCollapsedStorageKey(appId)) === "true";
  } catch {
    return false;
  }
}

function writeStoredMountedAppDirectoryCollapsed(appId: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(mountedAppDirectoryCollapsedStorageKey(appId), String(collapsed));
  } catch {
    // The toggle remains active for the current session even if storage is unavailable.
  }
}

function readStoredMountedAppOpenPaths(appId: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(mountedAppOpenPathsStorageKey(appId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const stored: Record<string, boolean> = {};
    for (const [path, open] of Object.entries(parsed)) {
      if (typeof path === "string" && path && typeof open === "boolean") {
        stored[path] = open;
      }
    }
    return stored;
  } catch {
    return {};
  }
}

function writeStoredMountedAppOpenPaths(appId: string, openPaths: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(mountedAppOpenPathsStorageKey(appId), JSON.stringify(openPaths));
  } catch {
    // non-critical-fallback: The tree remains usable for this session when preference storage is full.
  }
}

function defaultFolderOpen(path: string): boolean {
  return parentPathsFromMountedAppPath(path).length < 1;
}

function parentPathsFromMountedAppPath(path: string): string[] {
  return parentDirectoryPaths(path);
}

function collectFolderPaths(entries: MountedAppFileEntry[]): string[] {
  const output: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    output.push(entry.path);
    output.push(...collectFolderPaths(entry.children ?? []));
  }
  return output;
}

function canMoveMountedAppEntry(sourcePath: string, targetParentPath: string): boolean {
  if (!sourcePath || !targetParentPath || sourcePath === targetParentPath) return false;
  const sourceParent = parentMountedAppPath(sourcePath);
  if (sourceParent === targetParentPath) return false;
  return !targetParentPath.startsWith(`${sourcePath}/`);
}

function parentMountedAppPath(path: string): string {
  return parentDirectoryPath(path);
}

function workspaceName(workspaceRoot: string, t: TranslationFn): string {
  const name = workspaceRoot.split("/").filter(Boolean).pop() ?? "";
  return name.toLowerCase() === "workspace" ? t("mountedApp.workspace") : name || t("mountedApp.directory");
}

function selectionToComposerAttachment(
  app: ExtensionItemRecord,
  selection: FileTextSelectionAttachment,
  t: TranslationFn = translate,
): AttachmentPayload {
  const lineLabel = selection.lineRange
    ? selection.lineRange.start === selection.lineRange.end
      ? `L${selection.lineRange.start}`
      : `L${selection.lineRange.start}-L${selection.lineRange.end}`
    : "";
  const header = [
    "OpenGrove file selection",
    `App: ${app.title || app.name}`,
    `Path: ${selection.path}${lineLabel ? `:${lineLabel}` : ""}`,
    selection.mimeType ? `Type: ${selection.mimeType}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const text = `${header}\n\n${selection.text}`.slice(0, MAX_TEXT_ATTACHMENT_CHARS);
  return {
    id: createAttachmentId(),
    name: t("mountedApp.selectionAttachmentName", { name: selection.fileName }),
    kind: "text",
    mimeType: "text/plain",
    size: new TextEncoder().encode(text).length,
    text,
  };
}

function scheduleMountedAppPathReveal(path: string): void {
  if (!path || typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const target = findDirectoryTreeElement(path, "data-mounted-app-path");
      target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    });
  });
}
