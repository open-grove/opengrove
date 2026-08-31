import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { ChevronDown, MessageCircle, Plus, Search, X } from "lucide-react";
import {
  type AgentEventRecord,
  type AttachmentPayload,
  type ExtensionItemCollection,
  type ExtensionItemRecord,
  type KernelOption,
  type ModelId,
  type ModelProviderBinding,
  type ProviderProfile,
  type RuntimeControls,
  type SkillRecord,
} from "../../bridge";
import type { ApprovalRecord } from "../../bridge-inventory-types";
import { applyApprovalResultToMessages, applyQuestionResultToMessages } from "../../messages";
import {
  MAX_COMPOSER_ATTACHMENTS,
  composerFilesFromClipboardData,
  mergeComposerAttachments,
  readComposerAttachment,
} from "../../runtime/ui-model";
import {
  cancelServerRoomRun,
  deleteServerRoomMessage,
  addServerRoomMember,
  bindMountedAppBuilder,
  createServerRoom,
  openServerDirectRoom,
  patchServerRoomMember,
  patchServerRoom,
  postServerRoomMessageWithReplyFallback,
  removeServerRoomMember,
  restoreServerRoomMemberAppDefaults,
  sortRoomMessages,
} from "../rooms/rooms-api";
import type { MentionOption } from "../rooms/room-composer";
import {
  agentAuthorMention,
  canSendRoomDraft,
  draftWithAuthorMention,
  findMentionContext,
  roomMentionToken,
  type MentionMenuState,
} from "../rooms/room-chat-utils";
import { resolveRoomSendTargets } from "../rooms/rooms-message-actions";
import { RoomChatSurface } from "../rooms/room-chat-surface";
import { EmployeeSettingsDialog } from "../rooms/employee-settings-surface";
import { RoomHeaderActions } from "../rooms/room-header-actions";
import { findActiveRoomChoiceForm } from "../rooms/room-message-stream";
import { RoomGroupAvatar } from "../rooms/room-group-avatar";
import { RoomSettingsPanel, type RoomMemberPickerMode } from "../rooms/room-settings-panel";
import { interruptRoomMessage, roomMessageFromStored, roomMessageToStored } from "../rooms/room-message-model";
import { rawDiagnosticText, translate, useI18n, type TranslationFn } from "../../i18n";
import { ChatResourcePreviewPanel } from "../chat/chat-resource-preview-panel";
import type { ChatResourceAction, ChatResourceRef } from "../chat/resource-model";
import { useChatResourceActions } from "../chat/use-chat-resource-actions";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { MotionPopover } from "../ui/motion/popover";
import { Tooltip } from "../ui/tooltip";
import { useConfirm } from "../ui/confirm-dialog";
import { UnreadCount } from "../ui/unread-count";
import "./mounted-app-workbench.css";
import {
  APP_BUILDER_EMPLOYEE_DEFINITION_ID,
  createId,
  dedupeRoomMembers,
  employeeProfilePatch,
  appScopedGroupRoomId,
  isAppScopedRoomForApp,
  isRoomPmMember,
  nowIso,
  projectRoomMemberIdentity,
  remapRoomMemberReferences,
  roomMemberDisplayName,
  ROOM_OWNER_MEMBER,
  type Room,
  type RoomMember,
  type RoomMessage,
  type RoomsState,
} from "../rooms/rooms-model";
import { RoomMemberAvatar } from "../rooms/member-avatar";
import { groupEventsByRunId } from "../rooms/rooms-guide";
import { countMountedAppPendingActionParts } from "./mounted-app-shell-model";
import { mountedAppWorkspaceHint } from "./mounted-app-model";

type EnsuredMountedAppRoom = {
  room: Omit<Room, "messages">;
  member?: RoomMember;
};

const DEFAULT_MOUNTED_APP_GROUP_SOURCE_ID = "default";

export function canArchiveMountedAppGroup(room: Room, appId: string | undefined): boolean {
  return room.kind === "group" && !room.archived && isAppScopedRoomForApp(room, appId);
}

export function shouldEnsureMountedAppDefaultGroup(
  defaultGroupRoomId: string,
  dissolvedDefaultGroupIds: ReadonlySet<string>,
): boolean {
  return !dissolvedDefaultGroupIds.has(defaultGroupRoomId);
}

export function MountedAppChatPanel(props: {
  app: ExtensionItemRecord | undefined;
  selectedPath: string;
  runtimeEvents?: AgentEventRecord[];
  pendingApprovals?: ApprovalRecord[];
  pendingQuestionIds?: ReadonlySet<string>;
  roomsState: RoomsState;
  roomsHydrated: boolean;
  setRoomsState: Dispatch<SetStateAction<RoomsState>>;
  onResolveApproval?(approvalId: string, action: "approve" | "reject", response?: unknown): Promise<unknown> | void;
  onResolveQuestion?(questionId: string, action: "answer" | "decline", response?: unknown): Promise<unknown> | void;
  queuedAttachment?: AttachmentPayload | null;
  onOpenWorkspacePath?(path: string): void;
  onPendingCountChange?(count: number): void;
  activeKernel?: string;
  activeModel?: ModelId;
  extensions?: ExtensionItemCollection;
  kernelOptions?: KernelOption[];
  providers?: ProviderProfile[];
  modelProviderBindings?: ModelProviderBinding[];
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  skills?: SkillRecord[];
  onMarkRoomRead?(roomId: string): Promise<void> | void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const streamRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const headerMoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const memberPanelInteractedOutsideRef = useRef(false);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeAppNameRef = useRef("");
  const acceptedQueuedAttachmentIdRef = useRef("");
  const compositionGuardTimerRef = useRef<number | null>(null);
  const compositionEndedByEnterRef = useRef(false);
  const pendingGroupRoomCreatesRef = useRef(new Map<string, Promise<EnsuredMountedAppRoom>>());
  const ensuredGroupRoomIdsRef = useRef(new Set<string>());
  const dissolvedDefaultGroupIdsRef = useRef(new Set<string>());
  const isComposingTextRef = useRef(false);
  const suppressNextEnterRef = useRef(false);
  const state = props.roomsState;
  const setState = props.setRoomsState;
  const stateRef = useRef(state);
  const runtimeEventsSnapshot = props.runtimeEvents ?? [];
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [replyingToMessageId, setReplyingToMessageId] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [headerSearchOpen, setHeaderSearchOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [memberPanelOpen, setMemberPanelOpen] = useState(false);
  const [memberPickerMode, setMemberPickerMode] = useState<RoomMemberPickerMode>(null);
  const [memberPickerQuery, setMemberPickerQuery] = useState("");
  const [editingEmployeeId, setEditingEmployeeId] = useState("");
  const [memberManagementError, setMemberManagementError] = useState("");
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingCancelRunIds, setPendingCancelRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const [roomsInitStatus, setRoomsInitStatus] = useState<"loading" | "ready" | "error">("loading");
  const [createGroupDialogOpen, setCreateGroupDialogOpen] = useState(false);
  const [createGroupDraftTitle, setCreateGroupDraftTitle] = useState("");
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Room | null>(null);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [deleteGroupError, setDeleteGroupError] = useState("");
  const resourceActions = useChatResourceActions();
  const [mentionMenu, setMentionMenu] = useState<MentionMenuState>({
    open: false,
    query: "",
    start: 0,
    end: 0,
    activeIndex: 0,
  });
  const appChatId = mountedAppPrimaryId(props.app);
  const defaultGroupRoomId = useMemo(
    () => appScopedGroupRoomId(appChatId, DEFAULT_MOUNTED_APP_GROUP_SOURCE_ID),
    [appChatId],
  );
  const defaultGroupTitle = props.app
    ? t("mountedApp.groupTitle", { title: props.app.title })
    : t("mountedApp.groupTitleFallback");

  function rememberDefaultGroupLifecycle(rooms: ReadonlyArray<Room>) {
    const defaultGroup = rooms.find(
      (room) =>
        room.id === defaultGroupRoomId ||
        (room.scope?.kind === "app" && room.scope.appId === appChatId && room.scope.role === "default"),
    );
    if (!defaultGroup) return;
    if (defaultGroup.archived) {
      dissolvedDefaultGroupIdsRef.current.add(defaultGroupRoomId);
    } else {
      dissolvedDefaultGroupIdsRef.current.delete(defaultGroupRoomId);
    }
  }

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (memberPanelOpen) return;
    setMemberPickerMode(null);
    setMemberPickerQuery("");
  }, [memberPanelOpen]);

  useEffect(() => {
    setRoomsInitStatus(props.roomsHydrated ? "ready" : "loading");
    rememberDefaultGroupLifecycle(state.rooms);
    for (const room of state.rooms) {
      if (room.kind === "group" && isAppScopedRoomForApp(room, appChatId)) {
        ensuredGroupRoomIdsRef.current.add(room.id);
      }
    }
  }, [appChatId, props.roomsHydrated, state.rooms]);

  const deletedMemberIds = useMemo(() => new Set(state.deletedMemberIds ?? []), [state.deletedMemberIds]);
  const membersById = useMemo(() => new Map(state.members.map((member) => [member.id, member])), [state.members]);
  const contactMembers = useMemo(
    () =>
      state.members.filter(
        (member) => !deletedMemberIds.has(member.id) && !member.disabled && member.source !== "human",
      ),
    [deletedMemberIds, state.members],
  );
  const appMembers = useMemo(() => filterMountedAppMembers(props.app, contactMembers), [contactMembers, props.app]);
  const appMemberIds = useMemo(() => new Set(appMembers.map((member) => member.id)), [appMembers]);
  const sharedMembers = useMemo(
    () => filterMountedAppSharedMembers(props.app, contactMembers, appMemberIds),
    [appMemberIds, contactMembers, props.app],
  );
  const removedAppMembers = useMemo(
    () => restorableMountedAppMembers(props.app, state.members),
    [props.app, state.members],
  );
  const selectableMembers = useMemo(() => [...appMembers, ...sharedMembers], [appMembers, sharedMembers]);
  const defaultGroupMembers = useMemo(
    () => (appMembers.length ? appMembers : selectableMembers),
    [appMembers, selectableMembers],
  );
  const selectableMemberIds = useMemo(() => new Set(selectableMembers.map((member) => member.id)), [selectableMembers]);
  const defaultGroupRoom = state.rooms.find(
    (room) =>
      room.id === defaultGroupRoomId ||
      (room.scope?.kind === "app" && room.scope.appId === appChatId && room.scope.role === "default"),
  );
  const defaultGroupDisplayMembers = useMemo(
    () =>
      defaultGroupRoom
        ? defaultGroupRoom.memberIds
            .map((memberId) => membersById.get(memberId))
            .filter((member): member is RoomMember => Boolean(member))
        : defaultGroupMembers,
    [defaultGroupMembers, defaultGroupRoom, membersById],
  );
  const customGroupTemplateMemberIds = useMemo(
    () => mountedAppGroupTemplateMemberIds(defaultGroupRoom, defaultGroupMembers, selectableMemberIds),
    [defaultGroupMembers, defaultGroupRoom, selectableMemberIds],
  );
  const appGroupRooms = useMemo(
    () =>
      state.rooms.filter(
        (room) =>
          room.kind === "group" &&
          !room.archived &&
          room.scope?.role !== "default" &&
          isAppScopedRoomForApp(room, appChatId),
      ),
    [appChatId, state.rooms],
  );
  const activeRoom = state.rooms.find((room) => room.id === state.activeRoomId);
  const replyingToMessage = activeRoom?.messages.find((message) => message.id === replyingToMessageId);
  const activeRoomIsValid = Boolean(activeRoom && roomIsSelectableInMountedApp(activeRoom, appChatId));
  useEffect(() => {
    setReplyingToMessageId("");
  }, [activeRoom?.id]);
  useEffect(() => {
    if (!props.roomsHydrated || !activeRoomIsValid || !activeRoom?.unread || !props.onMarkRoomRead) return;
    void props.onMarkRoomRead(activeRoom.id);
  }, [activeRoom?.id, activeRoom?.unread, activeRoomIsValid, props.onMarkRoomRead, props.roomsHydrated]);
  const activeRoomRunIds = useMemo(() => {
    const runIds = new Set<string>();
    for (const message of activeRoom?.messages ?? []) {
      if (message.runId) {
        runIds.add(message.runId);
      }
    }
    return runIds;
  }, [activeRoom?.messages]);
  const runtimeEventsByRunId = useMemo(
    () => groupEventsByRunId(runtimeEventsSnapshot, activeRoomRunIds),
    [activeRoomRunIds, runtimeEventsSnapshot],
  );
  const pendingApprovalIds = useMemo(
    () =>
      new Set(
        (props.pendingApprovals ?? [])
          .filter((approval) => !approval.status || approval.status === "pending")
          .map((approval) => approval.id)
          .filter((id): id is string => Boolean(id)),
      ),
    [props.pendingApprovals],
  );
  const pendingReplyCount = useMemo(() => {
    const includeRoom = (room: Room) => roomIsSelectableInMountedApp(room, appChatId);
    const partCount = countMountedAppPendingActionParts(
      state.rooms,
      includeRoom,
      props.pendingQuestionIds,
      pendingApprovalIds,
    );
    const choiceCount = state.rooms
      .filter(includeRoom)
      .filter((room) =>
        findActiveRoomChoiceForm(room.messages, room.id === activeRoom?.id ? runtimeEventsByRunId : undefined),
      ).length;
    return partCount + choiceCount;
  }, [activeRoom?.id, appChatId, pendingApprovalIds, props.pendingQuestionIds, runtimeEventsByRunId, state.rooms]);
  const activeRoomMembers = useMemo(
    () =>
      activeRoomIsValid && activeRoom
        ? activeRoom.memberIds
            .map((memberId) => membersById.get(memberId))
            .filter((member): member is RoomMember => Boolean(member))
        : [],
    [activeRoom, activeRoomIsValid, membersById],
  );
  const activeRoomIsAppGroup = Boolean(
    activeRoomIsValid && activeRoom?.kind === "group" && isAppScopedRoomForApp(activeRoom, appChatId),
  );
  const activeRoomCanRename = Boolean(activeRoomIsAppGroup && activeRoom);
  const appGroupDisplayMembers = useMemo(() => {
    if (!activeRoomIsAppGroup) return activeRoomMembers;
    return [...activeRoomMembers].sort((left, right) => Number(isRoomPmMember(right)) - Number(isRoomPmMember(left)));
  }, [activeRoomIsAppGroup, activeRoomMembers]);
  const appGroupSettingsMembers = useMemo(
    () => [ROOM_OWNER_MEMBER, ...appGroupDisplayMembers.filter((member) => member.id !== ROOM_OWNER_MEMBER.id)],
    [appGroupDisplayMembers],
  );
  const appGroupAddCandidates = useMemo(() => {
    if (!activeRoomIsAppGroup || !activeRoom) return [];
    const activeIds = new Set(activeRoom.memberIds);
    return [...selectableMembers, ...removedAppMembers].filter((member) => !activeIds.has(member.id));
  }, [activeRoom, activeRoomIsAppGroup, removedAppMembers, selectableMembers]);
  const appGroupRemoveCandidates = useMemo(() => {
    if (!activeRoomIsAppGroup) return [];
    return activeRoomMembers;
  }, [activeRoomIsAppGroup, activeRoomMembers]);
  const appGroupMemberPickerOptions = useMemo(() => {
    const candidates = memberPickerMode === "remove" ? appGroupRemoveCandidates : appGroupAddCandidates;
    const value = memberPickerQuery.trim().toLowerCase();
    if (!value) return candidates;
    return candidates.filter((member) =>
      [member.name, member.role, member.kernel, member.model].some((field) => field.toLowerCase().includes(value)),
    );
  }, [appGroupAddCandidates, appGroupRemoveCandidates, memberPickerMode, memberPickerQuery]);
  const editingEmployee = editingEmployeeId
    ? state.members.find((member) => member.id === editingEmployeeId)
    : undefined;
  const editingEmployeeKernelOptions = useMemo<KernelOption[]>(() => {
    if (props.kernelOptions?.length) return props.kernelOptions;
    if (!editingEmployee) return [];
    return [
      {
        id: editingEmployee.kernel as KernelOption["id"],
        label: editingEmployee.kernel,
        available: true,
        active: true,
      },
    ];
  }, [editingEmployee, props.kernelOptions]);
  const targetableRoomMembers = useMemo(
    () => mountedAppTargetableRoomMembers(activeRoom, activeRoomMembers),
    [activeRoom, activeRoomMembers],
  );
  const filteredAppGroupRooms = useMemo(() => filterRooms(appGroupRooms, query), [appGroupRooms, query]);
  const defaultGroupMatchesQuery = useMemo(
    () => roomTextMatches(defaultGroupRoom?.title || defaultGroupTitle, query, "群组 App group"),
    [defaultGroupRoom?.title, defaultGroupTitle, query],
  );
  const mentionOptions = useMemo(() => {
    const value = mentionMenu.query.trim().toLowerCase();
    const allOption: MentionOption = {
      id: "all",
      kind: "all",
      label: t("mountedApp.mentionAll"),
      detail: t("mountedApp.mentionAllHint"),
    };
    const allAliases = ["所有人", "全部", "all"];
    const includeAll =
      activeRoom?.kind === "group" && (!value || allAliases.some((alias) => alias.toLowerCase().includes(value)));
    const memberOptions: MentionOption[] = targetableRoomMembers
      .filter((member) => {
        if (member.disabled) return false;
        if (!value) return true;
        return [roomMemberDisplayName(member), member.name, member.role, member.kernel, member.model].some((item) =>
          item.toLowerCase().includes(value),
        );
      })
      .map((member) => ({
        id: member.id,
        kind: "member",
        label: roomMemberDisplayName(member),
        member,
      }));
    return [...(includeAll ? [allOption] : []), ...memberOptions];
  }, [activeRoom?.kind, mentionMenu.query, t, targetableRoomMembers]);
  const messageCount = activeRoom?.messages.length ?? 0;

  useEffect(() => {
    props.onPendingCountChange?.(pendingReplyCount);
  }, [pendingReplyCount, props.onPendingCountChange]);

  useEffect(() => {
    const appName = props.app?.name || "";
    if (!appName) return;
    if (activeAppNameRef.current !== appName) {
      activeAppNameRef.current = appName;
      setQuery("");
      setSelectorOpen(false);
      setMemberPanelOpen(false);
      setDraft("");
      setAttachments([]);
      setMentionMenu((current) => ({ ...current, open: false }));
      setState((current) => ({ ...current, activeRoomId: "" }));
    }
  }, [props.app?.name]);

  useEffect(() => {
    const attachment = props.queuedAttachment;
    if (!attachment || acceptedQueuedAttachmentIdRef.current === attachment.id) return;
    acceptedQueuedAttachmentIdRef.current = attachment.id;
    setAttachments((current) => {
      if (current.some((item) => item.id === attachment.id) || current.length >= MAX_COMPOSER_ATTACHMENTS) {
        return current;
      }
      return [...current, attachment];
    });
    focusComposer();
  }, [props.queuedAttachment]);

  useEffect(() => {
    if (!props.app) return;
    const stored = readStoredAppRoomSelection(props.app.name);
    const activeRoomExists = Boolean(activeRoom && state.rooms.some((room) => room.id === activeRoom.id));
    const storedRoom = stored.roomId ? state.rooms.find((room) => room.id === stored.roomId) : undefined;
    if (
      stored.explicit &&
      storedRoom &&
      roomIsSelectableInMountedApp(storedRoom, appChatId) &&
      storedRoom.id !== activeRoom?.id
    ) {
      openSelectableRoom(storedRoom, { explicit: true });
      return;
    }
    if (activeRoomExists && activeRoomIsValid) return;
    if (stored.explicit && storedRoom && roomIsSelectableInMountedApp(storedRoom, appChatId)) {
      openSelectableRoom(storedRoom, { explicit: true });
      return;
    }
    if (stored.explicit && stored.roomId && roomsInitStatus === "loading") {
      return;
    }
    if (roomsInitStatus === "loading") {
      return;
    }
    if (
      (defaultGroupRoom || defaultGroupMembers.length) &&
      shouldEnsureMountedAppDefaultGroup(defaultGroupRoomId, dissolvedDefaultGroupIdsRef.current)
    ) {
      openDefaultGroupRoom({ explicit: false });
      return;
    }
    const firstAppGroupRoom = appGroupRooms[0];
    if (firstAppGroupRoom) {
      selectRoom(firstAppGroupRoom.id, { explicit: false });
      return;
    }
    if (state.activeRoomId) {
      setState((current) => (current.activeRoomId ? { ...current, activeRoomId: "" } : current));
    }
    if (stored.roomId) {
      clearStoredAppRoomSelection(props.app.name);
    }
  }, [
    activeRoom,
    activeRoomIsValid,
    appChatId,
    appGroupRooms,
    defaultGroupMembers,
    defaultGroupRoom,
    props.app,
    roomsInitStatus,
    state.activeRoomId,
    state.rooms,
  ]);

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.scrollTop = stream.scrollHeight;
  }, [messageCount, state.activeRoomId]);

  useEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  }, [draft]);

  useEffect(() => {
    if (!mentionMenu.open || mentionMenu.activeIndex < mentionOptions.length) return;
    setMentionMenu((current) => ({
      ...current,
      activeIndex: Math.max(0, mentionOptions.length - 1),
    }));
  }, [mentionMenu.activeIndex, mentionMenu.open, mentionOptions.length]);

  useEffect(
    () => () => {
      if (compositionGuardTimerRef.current !== null) {
        window.clearTimeout(compositionGuardTimerRef.current);
      }
    },
    [],
  );

  function selectRoom(roomId: string, options: { explicit?: boolean } = {}) {
    setState((current) => ({
      ...current,
      activeRoomId: roomId,
    }));
    if (props.app?.name) {
      writeStoredAppRoomSelection(props.app.name, roomId, options.explicit === true);
    }
    setSelectorOpen(false);
    setQuery("");
    setDraft("");
    setAttachments([]);
    setMentionMenu((current) => ({ ...current, open: false }));
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  function openSelectableRoom(room: Room, options: { explicit?: boolean } = {}) {
    if (!roomIsSelectableInMountedApp(room, appChatId)) return;
    selectRoom(room.id, options);
  }

  function openDefaultGroupRoom(options: { explicit?: boolean } = {}) {
    if (!props.app || !appChatId) return;
    if (options.explicit) {
      dissolvedDefaultGroupIdsRef.current.delete(defaultGroupRoomId);
    } else if (!shouldEnsureMountedAppDefaultGroup(defaultGroupRoomId, dissolvedDefaultGroupIdsRef.current)) {
      return;
    }
    const existing = defaultGroupRoom;
    if (existing) {
      selectRoom(existing.id, options);
      return;
    }
    const memberIds = defaultGroupMembers
      .map((member) => member.id)
      .filter((memberId) => selectableMemberIds.has(memberId));
    if (!memberIds.length) return;
    const createdAt = nowIso();
    const appTitle = props.app?.title || "App";
    const room: Room = {
      id: defaultGroupRoomId,
      kind: "group",
      scope: { kind: "app", appId: appChatId, role: "default" },
      title: defaultGroupTitle,
      badge: appTitle,
      memberIds,
      adminMemberIds: defaultGroupMembers.filter(isRoomPmMember).map((member) => member.id),
      pinned: false,
      unread: 0,
      updatedAt: createdAt,
      messages: [],
    };
    setState((current) => ({ ...current, rooms: [room, ...current.rooms], activeRoomId: defaultGroupRoomId }));
    if (props.app?.name) {
      writeStoredAppRoomSelection(props.app.name, defaultGroupRoomId, options.explicit === true);
    }
    const createPromise = createServerRoom(room)
      .then((result): EnsuredMountedAppRoom => {
        ensuredGroupRoomIdsRef.current.add(defaultGroupRoomId);
        ensuredGroupRoomIdsRef.current.add(result.room.id);
        return { room: result.room };
      })
      .finally(() => {
        pendingGroupRoomCreatesRef.current.delete(defaultGroupRoomId);
      });
    pendingGroupRoomCreatesRef.current.set(defaultGroupRoomId, createPromise);
    void createPromise
      .then((result) => {
        setState((current) => {
          const currentRoom = current.rooms.find(
            (candidate) => candidate.id === defaultGroupRoomId || candidate.id === result.room.id,
          );
          const serverRoom: Room = {
            ...result.room,
            messages: currentRoom?.messages.length ? currentRoom.messages : room.messages,
          };
          return mergeMountedAppChatState(current, {
            rooms: [
              serverRoom,
              ...current.rooms.filter(
                (candidate) => candidate.id !== defaultGroupRoomId && candidate.id !== serverRoom.id,
              ),
            ],
            activeRoomId: current.activeRoomId === defaultGroupRoomId ? serverRoom.id : current.activeRoomId,
          });
        });
        if (props.app?.name && result.room.id !== defaultGroupRoomId) {
          writeStoredAppRoomSelection(props.app.name, result.room.id, options.explicit === true);
        }
      })
      .catch((error) => {
        setState((current) => ({
          ...current,
          rooms: current.rooms.map((candidate) =>
            candidate.id === defaultGroupRoomId
              ? mergeRoomMessages(candidate, [
                  {
                    id: createId("message"),
                    senderId: "system",
                    senderName: t("mountedApp.systemSenderName"),
                    senderType: "system",
                    text: mountedAppChatErrorMessage(error, t),
                    targetIds: [],
                    status: "failed",
                    createdAt,
                    finishedAt: new Date().toISOString(),
                  },
                ])
              : candidate,
          ),
        }));
      });
    setSelectorOpen(false);
    setQuery("");
    setDraft("");
    setAttachments([]);
    setMentionMenu((current) => ({ ...current, open: false }));
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  // ===== App 群组生命周期 =====

  function openCreateAppGroupDialog() {
    if (!customGroupTemplateMemberIds.length) return;
    setCreateGroupDraftTitle(nextMountedAppGroupTitle(defaultGroupDisplayTitle, state.rooms, appChatId, t));
    setSelectorOpen(false);
    setMemberPanelOpen(false);
    setCreateGroupDialogOpen(true);
  }

  function createAppGroupRoom(rawTitle: string) {
    if (!props.app) return;
    const templateMemberIds = customGroupTemplateMemberIds;
    if (!templateMemberIds.length) return;
    const createdAt = nowIso();
    const nextTitle = nextMountedAppGroupTitle(defaultGroupDisplayTitle, state.rooms, appChatId, t);
    const generatedSequence = nextMountedAppGroupSequence(state.rooms, appChatId);
    const roomId = appScopedGroupRoomId(appChatId, createId("group"));
    const room: Room = {
      id: roomId,
      kind: "group",
      scope: { kind: "app", appId: appChatId || props.app.id, role: "group" },
      title: rawTitle.trim() || nextTitle,
      generatedTitle:
        !rawTitle.trim() || rawTitle.trim() === nextTitle
          ? { kind: "app-group", appId: appChatId || props.app.id, sequence: generatedSequence }
          : undefined,
      badge: props.app.title || "App",
      memberIds: templateMemberIds,
      adminMemberIds: templateMemberIds.filter((memberId) =>
        defaultGroupMembers.some((member) => member.id === memberId && isRoomPmMember(member)),
      ),
      pinned: false,
      unread: 0,
      updatedAt: createdAt,
      messages: [],
    };
    setState((current) => ({ ...current, rooms: [room, ...current.rooms], activeRoomId: room.id }));
    if (props.app.name) {
      writeStoredAppRoomSelection(props.app.name, room.id, true);
    }
    const createPromise = createServerRoom(room)
      .then((result): EnsuredMountedAppRoom => {
        ensuredGroupRoomIdsRef.current.add(room.id);
        ensuredGroupRoomIdsRef.current.add(result.room.id);
        return { room: result.room };
      })
      .finally(() => {
        pendingGroupRoomCreatesRef.current.delete(room.id);
      });
    pendingGroupRoomCreatesRef.current.set(room.id, createPromise);
    void createPromise
      .then((result) => {
        setState((current) => {
          const currentRoom = current.rooms.find(
            (candidate) => candidate.id === room.id || candidate.id === result.room.id,
          );
          const serverRoom: Room = {
            ...result.room,
            messages: currentRoom?.messages ?? room.messages,
          };
          return mergeMountedAppChatState(current, {
            rooms: [
              serverRoom,
              ...current.rooms.filter((candidate) => candidate.id !== room.id && candidate.id !== serverRoom.id),
            ],
            activeRoomId: current.activeRoomId === room.id ? serverRoom.id : current.activeRoomId,
          });
        });
        if (props.app?.name && result.room.id !== room.id) {
          writeStoredAppRoomSelection(props.app.name, result.room.id, true);
        }
      })
      .catch((error) => {
        setState((current) => ({
          ...current,
          rooms: current.rooms.map((candidate) =>
            candidate.id === room.id
              ? mergeRoomMessages(candidate, [
                  {
                    id: createId("message"),
                    senderId: "system",
                    senderName: t("mountedApp.systemSenderName"),
                    senderType: "system",
                    text: mountedAppChatErrorMessage(error, t),
                    targetIds: [],
                    status: "failed",
                    createdAt,
                    finishedAt: new Date().toISOString(),
                  },
                ])
              : candidate,
          ),
        }));
      });
    setSelectorOpen(false);
    setQuery("");
    setDraft("");
    setAttachments([]);
    setMentionMenu((current) => ({ ...current, open: false }));
    setCreateGroupDialogOpen(false);
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  function renameActiveGroup(rawTitle: string) {
    if (!activeRoomCanRename || !activeRoom) return;
    const nextTitle = rawTitle.trim();
    if (!nextTitle || nextTitle === activeRoom.title) {
      return;
    }
    const roomId = activeRoom.id;
    const previousTitle = activeRoom.title;
    setState((current) => ({
      ...current,
      rooms: current.rooms.map((room) =>
        room.id === roomId ? { ...room, title: nextTitle, updatedAt: nowIso() } : room,
      ),
    }));
    void patchServerRoom(roomId, { title: nextTitle }).catch(() => {
      setState((current) => ({
        ...current,
        rooms: current.rooms.map((room) =>
          room.id === roomId ? { ...room, title: previousTitle, updatedAt: nowIso() } : room,
        ),
      }));
    });
  }

  function openDeleteGroupDialog(room: Room) {
    if (!canArchiveMountedAppGroup(room, appChatId)) return;
    setSelectorOpen(false);
    setMemberPanelOpen(false);
    setDeleteGroupError("");
    setDeleteGroupTarget(room);
  }

  async function archiveSelectedGroup() {
    if (!deleteGroupTarget || deletingGroup) return;
    if (!canArchiveMountedAppGroup(deleteGroupTarget, appChatId)) {
      setDeleteGroupTarget(null);
      return;
    }
    const roomId = deleteGroupTarget.id;
    const deletingActiveRoom = stateRef.current.activeRoomId === roomId;
    const dissolvingDefaultGroup = roomId === defaultGroupRoomId;
    const fallbackRoom = stateRef.current.rooms.find(
      (room) => room.id !== roomId && roomIsSelectableInMountedApp(room, appChatId),
    );
    setDeletingGroup(true);
    setDeleteGroupError("");
    try {
      await patchServerRoom(roomId, { archived: true });
      ensuredGroupRoomIdsRef.current.delete(roomId);
      if (dissolvingDefaultGroup) {
        dissolvedDefaultGroupIdsRef.current.add(defaultGroupRoomId);
      }
      setState((current) => ({
        ...current,
        rooms: current.rooms.filter((room) => room.id !== roomId),
        activeRoomId: current.activeRoomId === roomId ? (fallbackRoom?.id ?? "") : current.activeRoomId,
      }));
      setDeleteGroupTarget(null);
      if (deletingActiveRoom) {
        if (fallbackRoom) {
          if (props.app?.name) {
            writeStoredAppRoomSelection(props.app.name, fallbackRoom.id, true);
          }
        } else if (props.app?.name) {
          clearStoredAppRoomSelection(props.app.name);
        }
        if (!dissolvingDefaultGroup && !fallbackRoom) {
          openDefaultGroupRoom({ explicit: true });
        }
      }
    } catch (error) {
      setDeleteGroupError(mountedAppChatErrorMessage(error, t));
    } finally {
      setDeletingGroup(false);
    }
  }

  function insertPrompt(prompt: string) {
    setDraft(prompt);
    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
      composerInputRef.current?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  function submitPromptFromActivity(prompt: string) {
    if (!sendText(prompt, [], replyingToMessage)) {
      insertPrompt(prompt);
    } else {
      setReplyingToMessageId("");
    }
  }

  function replyToAppRoomMessage(message: RoomMessage) {
    const mention = agentAuthorMention(message, activeRoomMembers);
    if (!mention) return;
    const nextDraft = draftWithAuthorMention(draft, mention);
    setDraft(nextDraft.value);
    setReplyingToMessageId(message.id);
    setMentionMenu((current) => ({ ...current, open: false }));
    focusComposer(nextDraft.cursor);
  }

  function mentionAppRoomMessageAuthor(message: RoomMessage) {
    const mention = agentAuthorMention(message, activeRoomMembers);
    if (!mention) return;
    const nextDraft = draftWithAuthorMention(draft, mention);
    setDraft(nextDraft.value);
    setMentionMenu((current) => ({ ...current, open: false }));
    focusComposer(nextDraft.cursor);
  }

  async function deleteAppRoomMessage(roomId: string, messageId: string) {
    const room = stateRef.current.rooms.find((item) => item.id === roomId);
    const previous = room?.messages.find((message) => message.id === messageId);
    if (!previous || (previous.senderType === "agent" && previous.status === "running")) return;
    if (
      (await confirm({
        title: t("confirm.deleteMessageTitle"),
        body: t("confirm.irreversibleBody"),
        confirmLabel: t("common.delete"),
        danger: true,
      })) !== "primary"
    )
      return;
    setState((current) => ({
      ...current,
      rooms: current.rooms.map((item) =>
        item.id === roomId
          ? { ...item, messages: item.messages.filter((message) => message.id !== messageId), updatedAt: nowIso() }
          : item,
      ),
    }));
    void deleteServerRoomMessage(roomId, messageId).catch(() => {
      setState((current) => ({
        ...current,
        rooms: current.rooms.map((item) => {
          if (item.id !== roomId || item.messages.some((message) => message.id === previous.id)) return item;
          return {
            ...item,
            messages: [...item.messages, previous].sort(sortRoomMessages),
            updatedAt: nowIso(),
          };
        }),
      }));
    });
  }

  function openMountedAppResource(resource: ChatResourceRef, action: ChatResourceAction = "preview") {
    if (
      action === "preview" &&
      props.app &&
      resource.origin === "mounted-app" &&
      resource.path &&
      mountedAppResourceBelongsToApp(resource, props.app)
    ) {
      props.onOpenWorkspacePath?.(resource.path);
      return;
    }
    void resourceActions.openResource(resource, action);
  }

  // 审批解决：调用宿主回传的 /approvals 决策，再就地把本地会话里的审批卡片翻成已解决，
  // 避免要等下一次 /events 轮询(≤2s)才更新。镜像 RoomsView 的 resolveRoomApproval。
  async function resolveAppApproval(approvalId: string, action: "approve" | "reject", response?: unknown) {
    try {
      const result = await props.onResolveApproval?.(approvalId, action, response);
      if (!result) return;
      setState((current) => ({
        ...current,
        rooms: current.rooms.map((room) => {
          let roomChanged = false;
          const messages = room.messages.map((message) => {
            if (!message.parts?.length) return message;
            const stored = roomMessageToStored(message);
            const updated = applyApprovalResultToMessages([stored], approvalId, result, action);
            if (!updated) return message;
            roomChanged = true;
            return roomMessageFromStored(message, stored, message.status);
          });
          return roomChanged ? { ...room, messages, updatedAt: nowIso() } : room;
        }),
      }));
    } catch (error) {
      appendAppSystemMessage(t("mountedApp.resolveApprovalFailed", { message: mountedAppChatErrorMessage(error, t) }));
    }
  }

  // 问题解决：和审批一样就地回写 App 聊天里的问题卡片，否则提交成功后会等不到本地 UI 状态更新，
  // 看起来像按钮没有反应。
  async function resolveAppQuestion(questionId: string, action: "answer" | "decline", response?: unknown) {
    try {
      const result = await props.onResolveQuestion?.(questionId, action, response);
      if (!result) return;
      setState((current) => ({
        ...current,
        rooms: current.rooms.map((room) => {
          let roomChanged = false;
          const messages = room.messages.map((message) => {
            if (!message.parts?.length) return message;
            const stored = roomMessageToStored(message);
            const updated = applyQuestionResultToMessages([stored], questionId, result, action);
            if (!updated) return message;
            roomChanged = true;
            return roomMessageFromStored(message, stored, message.status);
          });
          return roomChanged ? { ...room, messages, updatedAt: nowIso() } : room;
        }),
      }));
    } catch (error) {
      appendAppSystemMessage(t("mountedApp.resolveQuestionFailed", { message: mountedAppChatErrorMessage(error, t) }));
    }
  }

  function appendAppSystemMessage(text: string) {
    const createdAt = nowIso();
    setState((current) => ({
      ...current,
      rooms: current.rooms.map((room) =>
        room.id === current.activeRoomId
          ? mergeRoomMessages(room, [
              {
                id: createId("message"),
                senderId: "system",
                senderName: t("mountedApp.systemSenderName"),
                senderType: "system",
                text,
                targetIds: [],
                status: "failed",
                createdAt,
                finishedAt: createdAt,
              },
            ])
          : room,
      ),
    }));
  }

  function openAppGroupEmployeeSettings(member: RoomMember) {
    if (member.source === "human") return;
    setMemberPanelOpen(false);
    setEditingEmployeeId(member.id);
  }

  async function saveAppGroupEmployeeProfile(nextMember: RoomMember) {
    const previousMember = stateRef.current.members.find((member) => member.id === nextMember.id);
    if (!previousMember) return;
    const patch = employeeProfilePatch(previousMember, nextMember);
    if (!Object.keys(patch).length) return;
    const applyMember = (member: RoomMember) =>
      setState((current) => ({
        ...current,
        members: current.members.map((candidate) => (candidate.id === previousMember.id ? member : candidate)),
        rooms: projectRoomMemberIdentity(current.rooms, previousMember.id, member),
      }));
    applyMember({ ...previousMember, ...patch });
    try {
      const result = await patchServerRoomMember(previousMember.id, patch, { clearUndefined: true });
      applyMember(result.member ?? { ...previousMember, ...patch });
    } catch (error) {
      applyMember(previousMember);
      setMemberManagementError(
        t("contacts.saveFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }

  async function restoreAppGroupEmployeeDefaults(member: RoomMember) {
    const result = await restoreServerRoomMemberAppDefaults(member.id);
    setState((current) => applyMountedAppEmployeeDefaults(current, member.id, result.member));
  }

  function addAppGroupMember(member: RoomMember) {
    if (!activeRoomIsAppGroup || !activeRoom || activeRoom.memberIds.includes(member.id)) return;
    const roomId = activeRoom.id;
    setMemberManagementError("");
    if (member.employeeDefinitionId === APP_BUILDER_EMPLOYEE_DEFINITION_ID && !member.appId && appChatId) {
      void bindMountedAppBuilder(appChatId, roomId)
        .then((result) =>
          setState((current) =>
            mergeMountedAppChatState(current, {
              member: result.member,
              rooms: current.rooms.map((room) =>
                room.id === roomId
                  ? { ...room, memberIds: appendRoomMemberId(room.memberIds, result.member.id), updatedAt: nowIso() }
                  : room,
              ),
            }),
          ),
        )
        .catch((error) => {
          setMemberManagementError(
            t("mountedApp.memberAddFailed", {
              message: mountedAppChatErrorMessage(error, t),
            }),
          );
        });
      return;
    }
    const previousMember = state.members.find((candidate) => candidate.id === member.id);
    const memberToAdd = restoreMountedAppMember(member);
    setState((current) =>
      mergeMountedAppChatState(current, {
        member: memberToAdd,
        rooms: current.rooms.map((room) =>
          room.id === roomId
            ? { ...room, memberIds: appendRoomMemberId(room.memberIds, memberToAdd.id), updatedAt: nowIso() }
            : room,
        ),
      }),
    );
    void addServerRoomMember(roomId, memberToAdd)
      .then((result) => setState((current) => mergeMountedAppChatState(current, { member: result.member })))
      .catch((error) => {
        setState((current) => ({
          ...current,
          members: previousMember
            ? upsertMountedAppChatMember(current.members, previousMember)
            : current.members.filter((candidate) => candidate.id !== memberToAdd.id),
          rooms: current.rooms.map((room) =>
            room.id === roomId
              ? {
                  ...room,
                  memberIds: room.memberIds.filter((memberId) => memberId !== memberToAdd.id),
                  adminMemberIds: room.adminMemberIds.filter((memberId) => memberId !== memberToAdd.id),
                  updatedAt: nowIso(),
                }
              : room,
          ),
        }));
        setMemberManagementError(
          t("mountedApp.memberAddFailed", {
            message: mountedAppChatErrorMessage(error, t),
          }),
        );
      });
  }

  function removeAppGroupMember(member: RoomMember) {
    if (!activeRoomIsAppGroup || !activeRoom) return;
    const roomId = activeRoom.id;
    const wasAdministrator = activeRoom.adminMemberIds.includes(member.id);
    setMemberManagementError("");
    setState((current) => ({
      ...current,
      rooms: current.rooms.map((room) =>
        room.id === roomId
          ? {
              ...room,
              memberIds: room.memberIds.filter((memberId) => memberId !== member.id),
              adminMemberIds: room.adminMemberIds.filter((memberId) => memberId !== member.id),
              updatedAt: nowIso(),
            }
          : room,
      ),
    }));
    void removeServerRoomMember(roomId, member.id).catch((error) => {
      setState((current) => ({
        ...current,
        rooms: current.rooms.map((room) =>
          room.id === roomId
            ? {
                ...room,
                memberIds: appendRoomMemberId(room.memberIds, member.id),
                adminMemberIds: wasAdministrator
                  ? appendRoomMemberId(room.adminMemberIds, member.id)
                  : room.adminMemberIds,
                updatedAt: nowIso(),
              }
            : room,
        ),
      }));
      setMemberManagementError(
        t("mountedApp.memberRemoveFailed", {
          message: mountedAppChatErrorMessage(error, t),
        }),
      );
    });
  }

  function toggleAppGroupAdministrator(member: RoomMember) {
    if (!activeRoomIsAppGroup || !activeRoom) return;
    const roomId = activeRoom.id;
    const previousAdminMemberIds = activeRoom.adminMemberIds;
    const nextAdminMemberIds = previousAdminMemberIds.includes(member.id)
      ? previousAdminMemberIds.filter((memberId) => memberId !== member.id)
      : [...previousAdminMemberIds, member.id];
    setMemberManagementError("");
    setState((current) => ({
      ...current,
      rooms: current.rooms.map((room) =>
        room.id === roomId ? { ...room, adminMemberIds: nextAdminMemberIds, updatedAt: nowIso() } : room,
      ),
    }));
    void patchServerRoom(roomId, { adminMemberIds: nextAdminMemberIds }).catch((error) => {
      setState((current) => ({
        ...current,
        rooms: current.rooms.map((room) =>
          room.id === roomId ? { ...room, adminMemberIds: previousAdminMemberIds, updatedAt: nowIso() } : room,
        ),
      }));
      setMemberManagementError(
        t("rooms.updateMemberAdminFailed", {
          message: mountedAppChatErrorMessage(error, t),
        }),
      );
    });
  }

  function updateActiveGroupPinned(pinned: boolean) {
    if (!activeRoomIsAppGroup || !activeRoom || pinned === Boolean(activeRoom.pinned)) return;
    const roomId = activeRoom.id;
    const previousPinned = Boolean(activeRoom.pinned);
    setState((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (room.id === roomId ? { ...room, pinned, updatedAt: nowIso() } : room)),
    }));
    void patchServerRoom(roomId, { pinned }).catch((error) => {
      setState((current) => ({
        ...current,
        rooms: current.rooms.map((room) =>
          room.id === roomId ? { ...room, pinned: previousPinned, updatedAt: nowIso() } : room,
        ),
      }));
      setMemberManagementError(mountedAppChatErrorMessage(error, t));
    });
  }

  function focusComposer(cursor?: number) {
    window.requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input) return;
      input.focus();
      if (typeof cursor === "number") {
        input.setSelectionRange(cursor, cursor);
      }
    });
  }

  function handleDraftChange(value: string, cursor: number) {
    setDraft(value);
    const mentionContext = findMentionContext(value, cursor);
    if (!mentionContext) {
      setMentionMenu((current) => ({ ...current, open: false }));
      return;
    }
    setMentionMenu({
      open: true,
      query: mentionContext.query,
      start: mentionContext.start,
      end: mentionContext.end,
      activeIndex: 0,
    });
  }

  function openMentionMenuFromButton() {
    const input = composerInputRef.current;
    const selectionStart = input?.selectionStart ?? draft.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const activeContext = findMentionContext(draft, selectionStart);
    if (activeContext) {
      setMentionMenu({
        open: true,
        query: activeContext.query,
        start: activeContext.start,
        end: activeContext.end,
        activeIndex: 0,
      });
      focusComposer(selectionStart);
      return;
    }

    const before = draft.slice(0, selectionStart);
    const after = draft.slice(selectionEnd);
    const spacer = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const mentionStart = before.length + spacer.length;
    const nextDraft = `${before}${spacer}@${after}`;
    setDraft(nextDraft);
    setMentionMenu({
      open: true,
      query: "",
      start: mentionStart,
      end: mentionStart + 1,
      activeIndex: 0,
    });
    focusComposer(mentionStart + 1);
  }

  function applyMention(option: MentionOption) {
    const token = roomMentionToken(option);
    const before = draft.slice(0, mentionMenu.start);
    const after = draft.slice(mentionMenu.end).replace(/^\s*/, "");
    const spacer = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const nextDraft = `${before}${spacer}${token} ${after}`;
    const cursor = before.length + spacer.length + token.length + 1;
    setDraft(nextDraft);
    setMentionMenu((current) => ({ ...current, open: false, query: "", activeIndex: 0 }));
    focusComposer(cursor);
  }

  function moveMentionSelection(offset: number) {
    setMentionMenu((current) => {
      if (!current.open || mentionOptions.length === 0) return current;
      return {
        ...current,
        activeIndex: (current.activeIndex + offset + mentionOptions.length) % mentionOptions.length,
      };
    });
  }

  // forwarding-boundary: provides the semantic attachment action used by the composer UI.
  function openAttachmentPicker() {
    fileInputRef.current?.click();
  }

  async function handleAttachmentInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    await addRoomAttachments(files);
  }

  async function handleComposerPaste(event: ReactClipboardEvent<HTMLElement>) {
    const files = composerFilesFromClipboardData(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    await addRoomAttachments(files);
  }

  async function addRoomAttachments(files: File[]) {
    const remainingSlots = Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachments.length);
    if (remainingSlots === 0) return;
    const nextAttachments = await Promise.all(files.slice(0, remainingSlots).map(readComposerAttachment));
    setAttachments((current) => mergeComposerAttachments(current, nextAttachments));
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent;
    const isImeEvent =
      isComposingTextRef.current || nativeEvent.isComposing || event.key === "Process" || nativeEvent.keyCode === 229;
    if (isImeEvent) {
      compositionEndedByEnterRef.current =
        event.key === "Enter" || nativeEvent.code === "Enter" || nativeEvent.keyCode === 13;
      return;
    }
    if (event.key === "Enter" && suppressNextEnterRef.current) {
      event.preventDefault();
      suppressNextEnterRef.current = false;
      return;
    }

    if (mentionMenu.open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveMentionSelection(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveMentionSelection(-1);
        return;
      }
      const activeMention = mentionOptions[mentionMenu.activeIndex];
      if ((event.key === "Enter" || event.key === "Tab") && activeMention) {
        event.preventDefault();
        applyMention(activeMention);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendDraft();
    }
  }

  function handleComposerCompositionStart() {
    if (compositionGuardTimerRef.current !== null) {
      window.clearTimeout(compositionGuardTimerRef.current);
      compositionGuardTimerRef.current = null;
    }
    isComposingTextRef.current = true;
    compositionEndedByEnterRef.current = false;
    suppressNextEnterRef.current = false;
  }

  function handleComposerCompositionEnd() {
    isComposingTextRef.current = false;
    suppressNextEnterRef.current = compositionEndedByEnterRef.current;
    compositionEndedByEnterRef.current = false;
    if (!suppressNextEnterRef.current) return;
    compositionGuardTimerRef.current = window.setTimeout(() => {
      suppressNextEnterRef.current = false;
      compositionGuardTimerRef.current = null;
    }, 120);
  }

  function sendDraft() {
    if (!sendText(draft, attachments, replyingToMessage)) return;
    setDraft("");
    setAttachments([]);
    setReplyingToMessageId("");
    setMentionMenu((current) => ({ ...current, open: false }));
  }

  function sendText(rawText: string, outgoingAttachments: AttachmentPayload[] = [], replyToMessage?: RoomMessage) {
    if (!activeRoom || sending) return false;
    const text = rawText.trim() || (outgoingAttachments.length ? t("rooms.sentAttachment") : "");
    if (!canSendRoomDraft(text, outgoingAttachments.length)) return false;
    const createdAt = nowIso();
    const availableActiveMembers = targetableRoomMembers.filter(
      (member) => selectableMemberIds.has(member.id) && !member.disabled,
    );
    // 群聊里若员工正等待选择卡片的回复，把"点选项/直接打字"路由回提问的那个员工，
    // 避免无 @目标时落到"没有指定要回复的员工"。
    const pendingChoiceForm = findActiveRoomChoiceForm(activeRoom.messages, runtimeEventsByRunId);
    const choiceFormTarget = pendingChoiceForm
      ? availableActiveMembers.find((member) => member.id === pendingChoiceForm.memberId)
      : undefined;
    // Explicit @ targets follow the App's selectable-member list; optional PM
    // auto-routing still depends on the Room's current administrator choice.
    const { requestTargets, optimisticTargets } = resolveRoomSendTargets({
      text,
      room: activeRoom,
      members: availableActiveMembers,
      automaticPmMembers: activeRoomMembers,
      kernelOptions: props.kernelOptions ?? [],
      fallbackTarget: choiceFormTarget,
    });
    const inReplyToMessageId = replyToMessage?.id;
    const rootMessageId = replyToMessage ? (replyToMessage.rootMessageId ?? replyToMessage.id) : undefined;
    const userMessage: RoomMessage = {
      id: createId("message"),
      senderId: "user",
      senderName: t("mountedApp.selfSenderName"),
      senderType: "user",
      text,
      targetIds: optimisticTargets.map((member) => member.id),
      status: "sent",
      createdAt,
      attachments: outgoingAttachments,
      selectedFile: props.selectedPath ? { path: props.selectedPath } : undefined,
      inReplyToMessageId,
      rootMessageId,
    };
    const assistantMessages: RoomMessage[] = optimisticTargets.map((target) => ({
      id: createId("message"),
      senderId: target.id,
      senderName: target.name,
      senderType: "agent",
      text: "",
      targetIds: [target.id],
      status: "running",
      createdAt,
      startedAt: createdAt,
      inReplyToMessageId: userMessage.id,
      rootMessageId: userMessage.rootMessageId ?? userMessage.id,
    }));
    setSending(true);
    setState((current) => {
      const rooms = current.rooms.map((room) =>
        room.id === activeRoom.id
          ? {
              ...room,
              messages: [...room.messages, userMessage, ...assistantMessages],
              updatedAt: createdAt,
              unread: 0,
            }
          : room,
      );
      return {
        ...current,
        rooms,
        members: reconcileMountedAppMemberStatuses(
          current.members,
          rooms,
          new Set(optimisticTargets.map((member) => member.id)),
          new Set(),
        ),
      };
    });
    let postedRoomId = activeRoom.id;
    void ensureServerRoomForMessage(activeRoom)
      .then((ensured) => {
        const postRoomId = ensured?.room.id ?? activeRoom.id;
        postedRoomId = postRoomId;
        const postTargetIds =
          ensured?.member && activeRoom.kind === "direct"
            ? [ensured.member.id]
            : requestTargets.map((member) => member.id);
        if (ensured?.member || (ensured?.room.id && ensured.room.id !== activeRoom.id)) {
          setState((current) => {
            const existingRoom = current.rooms.find((room) => room.id === activeRoom.id);
            const movedRoom: Room | undefined =
              ensured?.room.id && ensured.room.id !== activeRoom.id
                ? {
                    ...ensured.room,
                    messages: existingRoom?.messages ?? [],
                    updatedAt: existingRoom?.updatedAt ?? ensured.room.updatedAt,
                  }
                : undefined;
            return mergeMountedAppChatState(current, {
              member: ensured.member,
              rooms: movedRoom
                ? [movedRoom, ...current.rooms.filter((room) => room.id !== activeRoom.id && room.id !== movedRoom.id)]
                : current.rooms,
              activeRoomId: movedRoom?.id ?? current.activeRoomId,
            });
          });
          if (props.app?.name && ensured?.room.id && ensured.room.id !== activeRoom.id) {
            writeStoredAppRoomSelection(props.app.name, ensured.room.id, true);
          }
        }
        return postServerRoomMessageWithReplyFallback({
          roomId: postRoomId,
          text,
          targetIds: postTargetIds,
          attachments: outgoingAttachments,
          selectedFile: props.selectedPath ? { path: props.selectedPath } : undefined,
          userMessageId: userMessage.id,
          assistantMessageIds: assistantMessages.map((message) => message.id),
          inReplyToMessageId,
        });
      })
      .then((result) => {
        const authoritativeMessageIds = new Set(result.assistantMessages.map((message) => message.id));
        const unmatchedOptimisticMessageIds = new Set(
          assistantMessages.filter((message) => !authoritativeMessageIds.has(message.id)).map((message) => message.id),
        );
        const authoritativeAgentMessages = result.assistantMessages.filter((message) => message.senderType === "agent");
        const affectedMemberIds = new Set([
          ...optimisticTargets.map((member) => member.id),
          ...authoritativeAgentMessages.map((message) => message.senderId),
        ]);
        const completedMemberIds = new Set(
          authoritativeAgentMessages.filter((message) => message.status === "done").map((message) => message.senderId),
        );
        setState((current) => {
          const rooms = current.rooms.map((room) => {
            if (room.id !== result.userMessage.roomId) return room;
            const withoutUnmatchedPlaceholders = unmatchedOptimisticMessageIds.size
              ? {
                  ...room,
                  messages: room.messages.filter((message) => !unmatchedOptimisticMessageIds.has(message.id)),
                }
              : room;
            return mergeRoomMessages(withoutUnmatchedPlaceholders, [result.userMessage, ...result.assistantMessages]);
          });
          return {
            ...current,
            rooms,
            members: reconcileMountedAppMemberStatuses(current.members, rooms, affectedMemberIds, completedMemberIds),
          };
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const failedMessages = assistantMessages.map((assistantMessage) => ({
          ...assistantMessage,
          text: mountedAppChatErrorMessage(message, t),
          status: "failed" as const,
          finishedAt: new Date().toISOString(),
        }));
        const affectedMemberIds = new Set(optimisticTargets.map((member) => member.id));
        setState((current) => {
          const rooms = current.rooms.map((room) =>
            room.id === postedRoomId ? mergeRoomMessages(room, failedMessages) : room,
          );
          return {
            ...current,
            rooms,
            members: reconcileMountedAppMemberStatuses(current.members, rooms, affectedMemberIds, new Set()),
          };
        });
      })
      .finally(() => setSending(false));
    return true;
  }

  function cancelRoomRun(roomId: string, messageId: string, runId?: string) {
    const room = state.rooms.find((item) => item.id === roomId);
    const previous = room?.messages.find((message) => message.id === messageId);
    if (!previous || previous.status !== "running") return;
    if (runId && pendingCancelRunIds.has(runId)) return;
    const snapshot = structuredClone(previous);
    if (runId) {
      setPendingCancelRunIds((current) => new Set(current).add(runId));
    }
    // 乐观：立即把该气泡标为已中断。
    setState((current) => ({
      ...current,
      rooms: current.rooms.map((item) =>
        item.id === roomId ? mergeRoomMessages(item, [interruptRoomMessage(previous)]) : item,
      ),
    }));
    void cancelServerRoomRun(roomId, messageId)
      .then((result) => {
        // 后端对"已取消"和"早已结束"都返回 200 + 权威 message，对齐回真实终态。
        if (result.message) {
          setState((current) => ({
            ...current,
            rooms: current.rooms.map((item) =>
              item.id === roomId ? mergeRoomMessages(item, [result.message!]) : item,
            ),
          }));
        }
      })
      .catch(() => {
        // 真失败(网络/5xx)：run 很可能还在跑，回滚到 cancel 前快照。
        setState((current) => ({
          ...current,
          rooms: current.rooms.map((item) => (item.id === roomId ? mergeRoomMessages(item, [snapshot]) : item)),
        }));
      })
      .finally(() => {
        if (runId) {
          setPendingCancelRunIds((current) => {
            const next = new Set(current);
            next.delete(runId);
            return next;
          });
        }
      });
  }

  function ensureServerRoomForMessage(room: Room): Promise<EnsuredMountedAppRoom | undefined> {
    if (room.kind === "group") {
      if (!isAppScopedRoomForApp(room, appChatId)) return Promise.resolve(undefined);
      if (ensuredGroupRoomIdsRef.current.has(room.id)) return Promise.resolve({ room });
      const pending = pendingGroupRoomCreatesRef.current.get(room.id);
      if (pending) return pending;
      const createPromise = createServerRoom(room)
        .then((result): EnsuredMountedAppRoom => {
          ensuredGroupRoomIdsRef.current.add(room.id);
          ensuredGroupRoomIdsRef.current.add(result.room.id);
          return { room: result.room };
        })
        .finally(() => {
          pendingGroupRoomCreatesRef.current.delete(room.id);
        });
      pendingGroupRoomCreatesRef.current.set(room.id, createPromise);
      return createPromise;
    }
    const memberId = room.directMemberId ?? room.memberIds[0];
    if (!memberId) return Promise.resolve(undefined);
    const member = state.members.find((item) => item.id === memberId);
    return openServerDirectRoom(memberId, room.title, {
      roomId: room.id,
      member,
      appId: appChatId,
      appTitle: props.app?.title,
    });
  }

  if (!props.app) {
    return null;
  }

  const defaultGroupDisplayTitle = defaultGroupRoom?.title || defaultGroupTitle;

  return (
    <section className="mounted-app-room-chat" aria-label={t("mountedApp.chatPanelLabel", { title: props.app.title })}>
      <header className="mounted-app-room-chat-header" ref={headerRef}>
        <div className="mounted-app-room-target-shell">
          <MotionPopover
            open={selectorOpen}
            onOpenChange={(open) => {
              setSelectorOpen(open);
              if (open) {
                setHeaderSearchOpen(false);
                setHeaderMenuOpen(false);
                setMemberPanelOpen(false);
              }
            }}
            anchorRef={headerRef}
            side="bottom"
            sideOffset={0}
            align="start"
            collisionPadding={0}
            className="mounted-app-room-picker"
            role="dialog"
            ariaLabel={t("mountedApp.switchChat")}
            trigger={
              <button
                className="mounted-app-room-target"
                type="button"
                onClick={() => {
                  setHeaderSearchOpen(false);
                  setHeaderMenuOpen(false);
                  setMemberPanelOpen(false);
                }}
                aria-expanded={selectorOpen}
              >
                <span className="mounted-app-room-target-icon">
                  {activeRoom?.kind === "group" ? (
                    <RoomGroupAvatar
                      title={activeRoom.title}
                      className="mounted-app-room-avatar"
                      members={activeRoomMembers}
                    />
                  ) : activeRoomMembers[0] ? (
                    <RoomMemberAvatar member={activeRoomMembers[0]} />
                  ) : (
                    <MessageCircle size={18} />
                  )}
                </span>
                <span>
                  <strong>
                    {(activeRoomIsValid ? activeRoom?.title : defaultGroupDisplayTitle) || t("mountedApp.selectChat")}
                  </strong>
                </span>
                <ChevronDown size={15} />
              </button>
            }
          >
            <label className="mounted-app-room-picker-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("mountedApp.searchGroups")}
              />
              {query ? (
                <Tooltip content={t("mountedApp.clearSearch")}>
                  <button type="button" onClick={() => setQuery("")} aria-label={t("mountedApp.clearSearch")}>
                    <X size={13} />
                  </button>
                </Tooltip>
              ) : null}
            </label>
            <div className="mounted-app-room-picker-section">
              <span>{t("mountedApp.groups")}</span>
              {(defaultGroupRoom || defaultGroupMembers.length) && defaultGroupMatchesQuery ? (
                <button
                  type="button"
                  onClick={() => openDefaultGroupRoom({ explicit: true })}
                  aria-label={
                    defaultGroupRoom?.unread
                      ? t("rooms.unreadCount", { title: defaultGroupDisplayTitle, count: defaultGroupRoom.unread })
                      : defaultGroupDisplayTitle
                  }
                >
                  <RoomGroupAvatar
                    title={defaultGroupDisplayTitle}
                    className="mounted-app-room-avatar"
                    members={defaultGroupDisplayMembers}
                  />
                  <span>
                    <strong>{defaultGroupDisplayTitle}</strong>
                    <small>{t("mountedApp.defaultGroupMeta", { count: defaultGroupDisplayMembers.length })}</small>
                  </span>
                  <UnreadCount count={defaultGroupRoom?.unread ?? 0} className="mounted-app-room-picker-unread" />
                </button>
              ) : null}
              {filteredAppGroupRooms.map((room) => (
                <button
                  type="button"
                  key={room.id}
                  onClick={() => openSelectableRoom(room, { explicit: true })}
                  aria-label={
                    room.unread ? t("rooms.unreadCount", { title: room.title, count: room.unread }) : room.title
                  }
                >
                  <RoomGroupAvatar
                    title={room.title}
                    className="mounted-app-room-avatar"
                    members={room.memberIds
                      .map((memberId) => membersById.get(memberId))
                      .filter((member): member is RoomMember => Boolean(member))}
                  />
                  <span>
                    <strong>{room.title}</strong>
                    <small>{t("mountedApp.groupMemberCount", { count: room.memberIds.length })}</small>
                  </span>
                  <UnreadCount count={room.unread} className="mounted-app-room-picker-unread" />
                </button>
              ))}
              {!defaultGroupRoom && !defaultGroupMembers.length ? (
                <div className="mounted-app-room-picker-empty">{t("mountedApp.emptyNoEmployees")}</div>
              ) : !defaultGroupMatchesQuery && !filteredAppGroupRooms.length ? (
                <div className="mounted-app-room-picker-empty">{t("mountedApp.noMatchingGroups")}</div>
              ) : null}
              {customGroupTemplateMemberIds.length ? (
                <button type="button" className="mounted-app-room-create-button" onClick={openCreateAppGroupDialog}>
                  <span className="mounted-app-room-create-icon" aria-hidden="true">
                    <Plus size={16} />
                  </span>
                  <span>
                    <strong>{t("mountedApp.createGroup")}</strong>
                    <small>{t("mountedApp.createGroupHint")}</small>
                  </span>
                </button>
              ) : null}
            </div>
          </MotionPopover>
        </div>
        {activeRoomIsValid && activeRoom ? (
          <RoomHeaderActions
            compact
            roomId={activeRoom.id}
            roomTitle={activeRoom.title}
            messages={activeRoom.messages}
            members={state.members}
            searchOpen={headerSearchOpen}
            menuOpen={headerMenuOpen}
            moreButtonRef={headerMoreButtonRef}
            onSearchOpenChange={(open) => {
              setHeaderSearchOpen(open);
              if (open) {
                setHeaderMenuOpen(false);
                setSelectorOpen(false);
                setMemberPanelOpen(false);
              }
            }}
            onMenuOpenChange={(open) => {
              setHeaderMenuOpen(open);
              if (open) {
                setHeaderSearchOpen(false);
                setSelectorOpen(false);
                setMemberPanelOpen(false);
              }
            }}
            onRename={activeRoomCanRename ? renameActiveGroup : undefined}
            onOpenSettings={
              activeRoomIsAppGroup
                ? () => {
                    setHeaderSearchOpen(false);
                    setHeaderMenuOpen(false);
                    setSelectorOpen(false);
                    setMemberManagementError("");
                    setMemberPanelOpen(true);
                  }
                : undefined
            }
            onDissolve={
              canArchiveMountedAppGroup(activeRoom, appChatId) ? () => openDeleteGroupDialog(activeRoom) : undefined
            }
          />
        ) : null}
        {activeRoomIsAppGroup && activeRoom ? (
          <MotionPopover
            open={memberPanelOpen}
            onOpenChange={(open) => {
              setMemberPanelOpen(open);
              if (open) memberPanelInteractedOutsideRef.current = false;
              if (!open) {
                setMemberPickerMode(null);
                setMemberPickerQuery("");
              }
            }}
            anchorRef={headerMoreButtonRef}
            side="bottom"
            sideOffset={6}
            align="end"
            className="mounted-app-member-popover"
            role="dialog"
            ariaLabel={t("rooms.groupSettings")}
            onInteractOutside={() => {
              memberPanelInteractedOutsideRef.current = true;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!memberPanelInteractedOutsideRef.current) {
                headerMoreButtonRef.current?.focus();
              }
              memberPanelInteractedOutsideRef.current = false;
            }}
          >
            {memberManagementError ? (
              <p className="mounted-app-member-error" role="alert">
                {memberManagementError}
              </p>
            ) : null}
            <RoomSettingsPanel
              activeRoom={activeRoom}
              memberPanelOpen
              presentation="popover"
              page="overview"
              memberQuery=""
              memberPickerMode={memberPickerMode}
              memberPickerQuery={memberPickerQuery}
              memberPickerOptions={appGroupMemberPickerOptions}
              visibleRoomMembers={appGroupSettingsMembers}
              filteredMembers={appGroupSettingsMembers}
              removableMembers={appGroupRemoveCandidates}
              visibleRoomMemberCount={appGroupSettingsMembers.length}
              onClose={() => setMemberPanelOpen(false)}
              onPageChange={() => undefined}
              onRenameRoom={renameActiveGroup}
              onPinnedChange={updateActiveGroupPinned}
              onMemberQueryChange={() => undefined}
              onOpenMemberPicker={(mode) => {
                setMemberPickerQuery("");
                setMemberPickerMode(mode);
              }}
              onCloseMemberPicker={() => {
                setMemberPickerMode(null);
                setMemberPickerQuery("");
              }}
              onMemberPickerQueryChange={setMemberPickerQuery}
              onAddMember={(member) => {
                addAppGroupMember(member);
                setMemberPickerMode(null);
                setMemberPickerQuery("");
              }}
              onRemoveMember={removeAppGroupMember}
              onToggleMemberAdmin={toggleAppGroupAdministrator}
              onOpenMemberProfile={openAppGroupEmployeeSettings}
              isMemberOwner={(member) => member.id === ROOM_OWNER_MEMBER.id}
            />
          </MotionPopover>
        ) : null}
      </header>
      {activeRoom && activeRoomIsValid ? (
        <RoomChatSurface
          streamRef={streamRef}
          composerInputRef={composerInputRef}
          fileInputRef={fileInputRef}
          roomId={activeRoom.id}
          roomTitle={activeRoom.title}
          messages={activeRoom.messages}
          members={state.members}
          workspaceRoot={props.app ? mountedAppWorkspaceHint(props.app) : undefined}
          runtimeEventsByRunId={runtimeEventsByRunId}
          pendingQuestionIds={props.pendingQuestionIds}
          pendingCancelRunIds={pendingCancelRunIds}
          onCancelRun={(messageId, runId) => cancelRoomRun(activeRoom.id, messageId, runId)}
          draft={draft}
          attachments={attachments}
          replyingToMessage={replyingToMessage}
          canSend={
            targetableRoomMembers.some((member) => selectableMemberIds.has(member.id) && !member.disabled) &&
            canSendRoomDraft(draft, attachments.length)
          }
          mentionOpen={mentionMenu.open}
          mentionOptions={mentionOptions}
          activeMentionIndex={mentionMenu.activeIndex}
          onResolveApproval={(approvalId, action, response) => resolveAppApproval(approvalId, action, response)}
          onResolveQuestion={(questionId, action, response) => resolveAppQuestion(questionId, action, response)}
          onInsertPrompt={insertPrompt}
          onSubmitPrompt={submitPromptFromActivity}
          onReplyMessage={replyToAppRoomMessage}
          onMentionMessageAuthor={mentionAppRoomMessageAuthor}
          onDeleteMessage={(messageId) => deleteAppRoomMessage(activeRoom.id, messageId)}
          onOpenMemberProfile={openAppGroupEmployeeSettings}
          onOpenResource={openMountedAppResource}
          onDraftChange={handleDraftChange}
          onAttachmentInputChange={handleAttachmentInputChange}
          onOpenAttachmentPicker={openAttachmentPicker}
          onRemoveAttachment={removeAttachment}
          onCancelReply={() => setReplyingToMessageId("")}
          onPaste={handleComposerPaste}
          onKeyDown={handleComposerKeyDown}
          onCompositionStart={handleComposerCompositionStart}
          onCompositionEnd={handleComposerCompositionEnd}
          onOpenMention={openMentionMenuFromButton}
          onMentionOpenChange={(open) => setMentionMenu((current) => ({ ...current, open }))}
          onSelectMention={applyMention}
          onHoverMention={(index) => setMentionMenu((current) => ({ ...current, activeIndex: index }))}
          onSend={sendDraft}
        />
      ) : (
        <div className="mounted-app-room-empty">
          <MessageCircle size={20} />
          <strong>{mountedAppEmptyTitle(selectableMembers.length, roomsInitStatus, t)}</strong>
          <p>{mountedAppEmptyDescription(selectableMembers.length, roomsInitStatus, t)}</p>
        </div>
      )}
      {/* ===== App 群组管理对话框 ===== */}
      <Dialog open={createGroupDialogOpen} onOpenChange={setCreateGroupDialogOpen}>
        <DialogContent className="mounted-app-create-group-dialog" aria-label={t("mountedApp.createGroup")}>
          <DialogTitle>{t("mountedApp.createGroup")}</DialogTitle>
          <form
            className="mounted-app-create-group-form"
            onSubmit={(event) => {
              event.preventDefault();
              createAppGroupRoom(createGroupDraftTitle);
            }}
          >
            <label className="mounted-app-create-group-field">
              <span>{t("mountedApp.groupName")}</span>
              <input
                autoFocus
                value={createGroupDraftTitle}
                onChange={(event) => setCreateGroupDraftTitle(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setCreateGroupDialogOpen(false)}>
                {t("common.cancel")}
              </button>
              <button className="primary-button" type="submit" disabled={!customGroupTemplateMemberIds.length}>
                {t("mountedApp.create")}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteGroupTarget)}
        onOpenChange={(open) => {
          if (open || deletingGroup) return;
          setDeleteGroupTarget(null);
          setDeleteGroupError("");
        }}
      >
        <DialogContent
          className="mounted-app-create-group-dialog"
          aria-label={t("rooms.dissolveGroup")}
          aria-describedby="mounted-app-delete-group-description"
        >
          <DialogTitle>{t("rooms.dissolveGroup")}</DialogTitle>
          <p id="mounted-app-delete-group-description">
            {t("rooms.dissolveGroupConfirm", { title: deleteGroupTarget?.title ?? "" })}
          </p>
          {deleteGroupError ? (
            <p className="mounted-app-delete-group-error">
              {t("rooms.dissolveGroupFailedWithDetail", { message: deleteGroupError })}
            </p>
          ) : null}
          <div className="modal-actions">
            <button
              className="ghost-button"
              type="button"
              onClick={() => {
                setDeleteGroupTarget(null);
                setDeleteGroupError("");
              }}
              disabled={deletingGroup}
            >
              {t("common.cancel")}
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={() => void archiveSelectedGroup()}
              disabled={deletingGroup}
            >
              {deletingGroup ? t("mountedApp.deletingGroup") : t("rooms.dissolveGroup")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      {editingEmployee ? (
        <EmployeeSettingsDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditingEmployeeId("");
          }}
          member={editingEmployee}
          rooms={state.rooms}
          activeKernel={props.activeKernel ?? editingEmployee.kernel}
          activeModel={props.activeModel ?? editingEmployee.model}
          extensions={props.extensions}
          kernelOptions={editingEmployeeKernelOptions}
          providers={props.providers}
          modelProviderBindings={props.modelProviderBindings}
          runtimeControls={props.runtimeControls}
          runtimeControlsByKernel={props.runtimeControlsByKernel}
          skills={props.skills}
          onRestoreAppDefaults={() => restoreAppGroupEmployeeDefaults(editingEmployee)}
          onSave={saveAppGroupEmployeeProfile}
        />
      ) : null}
      {resourceActions.preview ? (
        <ChatResourcePreviewPanel preview={resourceActions.preview} onClose={resourceActions.closePreview} />
      ) : null}
    </section>
  );
}

const MOUNTED_APP_NON_CHAT_MEMBER_IDS = new Set(["app-creator"]);

function filterMountedAppMembers(app: ExtensionItemRecord | undefined, members: RoomMember[]): RoomMember[] {
  if (!app) return [];
  return members.filter((member) => mountedAppMemberMatchesApp(app, member));
}

export function restorableMountedAppMembers(app: ExtensionItemRecord | undefined, members: RoomMember[]): RoomMember[] {
  if (!app) return [];
  return members.filter((member) => mountedAppMemberMatchesApp(app, member) && isMountedAppRemovalSentinel(member));
}

export function restoreMountedAppMember(member: RoomMember): RoomMember {
  if (!isMountedAppRemovalSentinel(member)) return member;
  return {
    ...member,
    status: "idle",
    lastActive: "已配置",
    disabled: false,
  };
}

export function filterMountedAppSharedMembers(
  app: ExtensionItemRecord | undefined,
  members: RoomMember[],
  appMemberIds: ReadonlySet<string>,
): RoomMember[] {
  if (!app) return [];
  const appEmployeeDefinitionIds = new Set(
    members
      .filter((member) => appMemberIds.has(member.id) && member.employeeDefinitionId)
      .map((member) => member.employeeDefinitionId as string),
  );
  return members.filter((member) => {
    if (appMemberIds.has(member.id)) return false;
    if (member.employeeDefinitionId && !member.appId && appEmployeeDefinitionIds.has(member.employeeDefinitionId))
      return false;
    if (!isCallableSharedEmployee(member)) return false;
    return !member.appId || mountedAppMemberMatchesApp(app, member);
  });
}

function isCallableSharedEmployee(member: RoomMember): boolean {
  if (!member.id || !member.kernel || member.disabled || member.status === "offline") return false;
  if (member.source === "human") return false;
  return !MOUNTED_APP_NON_CHAT_MEMBER_IDS.has(member.id);
}

function isMountedAppRemovalSentinel(member: RoomMember): boolean {
  return (
    member.id.startsWith("member-app-") &&
    Boolean(member.appId) &&
    (!member.source || member.source === "local") &&
    member.disabled === true &&
    member.status === "offline" &&
    member.lastActive === "已移除"
  );
}

function appendRoomMemberId(memberIds: string[], memberId: string): string[] {
  return memberIds.includes(memberId) ? memberIds : [...memberIds, memberId];
}

function mountedAppGroupTemplateMemberIds(
  defaultGroupRoom: Room | undefined,
  defaultGroupMembers: RoomMember[],
  selectableMemberIds: ReadonlySet<string>,
): string[] {
  const sourceIds = defaultGroupRoom ? defaultGroupRoom.memberIds : defaultGroupMembers.map((member) => member.id);
  return [...new Set(sourceIds.filter((memberId) => selectableMemberIds.has(memberId)))];
}

function nextMountedAppGroupTitle(
  defaultGroupTitle: string,
  rooms: Room[],
  appId: string | undefined,
  t: TranslationFn = translate,
): string {
  const baseTitle = defaultGroupTitle.trim() || t("mountedApp.groupTitleFallback");
  const existingTitles = new Set(rooms.map((room) => room.title.trim()).filter(Boolean));
  const existingAppGroupCount = rooms.filter(
    (room) =>
      room.kind === "group" && !room.archived && room.scope?.role !== "default" && isAppScopedRoomForApp(room, appId),
  ).length;
  for (let index = existingAppGroupCount + 2; ; index += 1) {
    const candidate = `${baseTitle} ${index}`;
    if (!existingTitles.has(candidate)) return candidate;
  }
}

function nextMountedAppGroupSequence(rooms: Room[], appId: string | undefined): number {
  return (
    rooms.filter(
      (room) =>
        room.kind === "group" && !room.archived && room.scope?.role !== "default" && isAppScopedRoomForApp(room, appId),
    ).length + 2
  );
}

function mountedAppMemberMatchesApp(app: ExtensionItemRecord, member: RoomMember): boolean {
  const memberAppId = normalizedIdentifier(member.appId);
  if (!memberAppId) return false;
  return mountedAppIdentifiers(app).some((candidate) => candidate === memberAppId);
}

function mountedAppPrimaryId(app: ExtensionItemRecord | undefined): string | undefined {
  if (!app) return undefined;
  return String(app.name || app.id.replace(/^app:/, "") || app.title || "").trim() || undefined;
}

function mountedAppResourceBelongsToApp(resource: ChatResourceRef, app: ExtensionItemRecord): boolean {
  const resourceAppId = normalizedIdentifier(resource.appId);
  if (!resourceAppId) return false;
  return mountedAppIdentifiers(app).includes(resourceAppId);
}

function mountedAppIdentifiers(app: ExtensionItemRecord): string[] {
  const source = recordFromUnknown(app.source);
  const metadata = recordFromUnknown(app.metadata);
  const values = [
    app.name,
    app.id,
    app.id.replace(/^app:/, ""),
    app.title,
    source.packageId,
    source.appId,
    metadata.packageId,
    metadata.appId,
  ];
  return [...new Set(values.map(normalizedIdentifier).filter(Boolean))];
}

function mountedAppTargetableRoomMembers(room: Room | undefined, activeRoomMembers: RoomMember[]): RoomMember[] {
  if (!room) return [];
  return activeRoomMembers;
}

function mountedAppEmptyTitle(
  memberCount: number,
  status: "loading" | "ready" | "error",
  t: TranslationFn = translate,
): string {
  if (memberCount > 0) return t("mountedApp.emptySelectChat");
  if (status === "loading") return t("mountedApp.emptyLoadingEmployees");
  if (status === "error") return t("mountedApp.emptyLoadEmployeesFailed");
  return t("mountedApp.emptyNoEmployees");
}

function mountedAppEmptyDescription(
  memberCount: number,
  status: "loading" | "ready" | "error",
  t: TranslationFn = translate,
): string {
  if (memberCount > 0) return t("mountedApp.emptySelectChatCopy");
  if (status === "loading") return t("mountedApp.emptyLoadingEmployeesCopy");
  if (status === "error") return t("mountedApp.emptyLoadEmployeesFailedCopy");
  return t("mountedApp.emptyNoEmployeesCopy");
}

function roomIsSelectableInMountedApp(room: Room | undefined, appId: string | undefined): boolean {
  if (!room) return false;
  if (room.kind !== "group" || room.archived) return false;
  if (!isAppScopedRoomForApp(room, appId)) return false;
  return true;
}

function filterRooms(rooms: Room[], query: string): Room[] {
  const value = query.trim().toLowerCase();
  if (!value) return rooms;
  return rooms.filter((room) => roomTextMatches(room.title, query, room.badge));
}

function roomTextMatches(title: string, query: string, detail = ""): boolean {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  return `${title} ${detail}`.toLowerCase().includes(value);
}

function mountedAppChatErrorMessage(error: unknown, t: TranslationFn = translate): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("room_not_found")) {
    return t("mountedApp.errorRoomNotFound");
  }
  if (message.includes("room_has_active_runs")) {
    return t("mountedApp.errorRoomHasActiveRuns");
  }
  return rawDiagnosticText(message);
}

function normalizedIdentifier(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^app:/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mergeRoomMessages(room: Room, messages: RoomMessage[]): Room {
  const byId = new Map(room.messages.map((message) => [message.id, message]));
  for (const message of messages) {
    byId.set(message.id, { ...byId.get(message.id), ...message });
  }
  return {
    ...room,
    messages: [...byId.values()].sort(sortRoomMessages),
    updatedAt: nowIso(),
  };
}

function reconcileMountedAppMemberStatuses(
  members: RoomMember[],
  rooms: Room[],
  affectedMemberIds: ReadonlySet<string>,
  completedMemberIds: ReadonlySet<string>,
): RoomMember[] {
  if (!affectedMemberIds.size) return members;
  const runningMemberIds = new Set(
    rooms.flatMap((room) =>
      room.messages
        .filter((message) => message.senderType === "agent" && message.status === "running")
        .map((message) => message.senderId),
    ),
  );
  return members.map((member) => {
    if (member.disabled || !affectedMemberIds.has(member.id)) return member;
    const status: RoomMember["status"] = runningMemberIds.has(member.id)
      ? "running"
      : completedMemberIds.has(member.id)
        ? "done"
        : "idle";
    return member.status === status ? member : { ...member, status, lastActive: "刚刚" };
  });
}

function mergeMountedAppChatState(
  state: RoomsState,
  input: {
    member?: RoomMember;
    rooms?: Room[];
    activeRoomId?: string;
  },
): RoomsState {
  const rawMembers = input.member ? upsertMountedAppChatMember(state.members, input.member) : state.members;
  const deduped = dedupeRoomMembers(rawMembers);
  const knownMemberIds = new Set(deduped.members.filter((member) => !member.disabled).map((member) => member.id));
  const rooms = (input.rooms ?? state.rooms).map((room) =>
    remapRoomMemberReferences(room, deduped.memberIdAliases, knownMemberIds),
  );
  const restoredMemberId = input.member && !input.member.disabled ? input.member.id : undefined;
  return {
    ...state,
    members: deduped.members,
    rooms,
    activeRoomId: input.activeRoomId ?? state.activeRoomId,
    deletedMemberIds: (state.deletedMemberIds ?? []).filter(
      (memberId) => memberId !== restoredMemberId && !deduped.memberIdAliases.has(memberId),
    ),
  };
}

export function applyMountedAppEmployeeDefaults(
  state: RoomsState,
  previousMemberId: string,
  member: RoomMember,
): RoomsState {
  return mergeMountedAppChatState(
    {
      ...state,
      rooms: projectRoomMemberIdentity(state.rooms, previousMemberId, member),
    },
    { member },
  );
}

function upsertMountedAppChatMember(members: RoomMember[], member: RoomMember): RoomMember[] {
  return members.some((item) => item.id === member.id)
    ? members.map((item) => (item.id === member.id ? { ...item, ...member } : item))
    : [...members, member];
}

function appChatStorageKey(appName: string): string {
  return `opengrove:mounted-app-chat:${appName}`;
}

function readStoredAppRoomSelection(appName: string): { roomId: string; explicit: boolean } {
  try {
    const raw = window.localStorage.getItem(appChatStorageKey(appName)) || "";
    if (!raw) return { roomId: "", explicit: false };
    if (!raw.startsWith("{")) return { roomId: raw, explicit: false };
    const parsed = JSON.parse(raw) as { roomId?: unknown; explicit?: unknown };
    return {
      roomId: typeof parsed.roomId === "string" ? parsed.roomId : "",
      explicit: parsed.explicit === true,
    };
  } catch {
    return { roomId: "", explicit: false };
  }
}

function writeStoredAppRoomSelection(appName: string, roomId: string, explicit: boolean): void {
  try {
    window.localStorage.setItem(appChatStorageKey(appName), JSON.stringify({ roomId, explicit }));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function clearStoredAppRoomSelection(appName: string): void {
  try {
    window.localStorage.removeItem(appChatStorageKey(appName));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
