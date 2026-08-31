import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent,
} from "react";
import { publishEmployeeToAppStore } from "../../bridge";
import type {
  AgentEventRecord,
  AttachmentPayload,
  ExtensionItemCollection,
  KernelOption,
  ModelId,
  ModelProviderBinding,
  ProviderProfile,
  RunRecord,
  RuntimeControls,
  SkillRecord,
} from "../../bridge";
import { rawDiagnosticText, useI18n } from "../../i18n";
import { applyApprovalResultToMessages, applyQuestionResultToMessages } from "../../messages";
import {
  MAX_COMPOSER_ATTACHMENTS,
  composerFilesFromClipboardData,
  mergeComposerAttachments,
  readComposerAttachment,
} from "../../runtime/ui-model";
import type { MentionOption } from "./room-composer";
import {
  agentAuthorMention,
  canSendRoomDraft,
  draftWithAuthorMention,
  findMentionContext,
  roomMentionToken,
  type MentionMenuState,
} from "./room-chat-utils";
import { sendRoomText } from "./rooms-message-actions";
import { useConfirm } from "../ui/confirm-dialog";
import { interruptRoomMessage, roomMessageFromStored, roomMessageToStored } from "./room-message-model";
import {
  addServerRoomMember,
  cancelServerRoomRun,
  createServerRoom,
  deleteServerRoomMessage,
  mergeRoomMessageRecord,
  normalizeRoomMessage,
  openServerDirectRoom,
  patchServerRoom,
  patchServerRoomMember,
  removeServerRoomMember,
  restoreServerRoomMemberAppDefaults,
  sortRoomMessages,
  upsertServerRoomMember,
} from "./rooms-api";
import { removedMemberForRoom } from "./rooms-guide";
import { useRoomsDerivedState } from "./rooms-derived-state";
import { useRoomRunReconciliation } from "./rooms-run-reconciliation";
import { RoomsActiveLayout, RoomsEmptyState } from "./rooms-view-layout";
import type { RoomsSharedActions, RoomsSharedSnapshot } from "./rooms-shared-state";
import {
  createId,
  dedupeRoomMembers,
  directRoomMember,
  directRoomId,
  employeeProfilePatch,
  isAppScopedRoomId,
  isRoomPmMember,
  nowIso,
  projectRoomMemberIdentity,
  remapRoomMemberReferences,
  resolveVisibleRoomFocus,
  roomMemberDisplayName,
  type MemberStatus,
  type Room,
  type RoomMember,
  type RoomMessage,
} from "./rooms-model";

export function RoomsView(props: {
  roomsSnapshot: RoomsSharedSnapshot;
  roomsActions: RoomsSharedActions;
  activeKernel?: string;
  activeModel: ModelId;
  activeWorkspaceRoot: string;
  extensions?: ExtensionItemCollection;
  kernelOptions: KernelOption[];
  providers?: ProviderProfile[];
  modelProviderBindings?: ModelProviderBinding[];
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  skills?: SkillRecord[];
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
  pendingQuestionIds?: ReadonlySet<string>;
  focusRoomId?: string;
  onActiveRoomChange?(roomId: string): void;
  onboardingGuideVisible?: boolean;
  onResolveApproval?(approvalId: string, action: "approve" | "reject", response?: unknown): Promise<unknown> | void;
  onResolveQuestion?(questionId: string, action: "answer" | "decline", response?: unknown): Promise<unknown> | void;
  onOpenContacts(): void;
  onDismissOnboardingGuide?(): void;
  onCompleteOnboardingGuide?(): void;
}) {
  const { t } = useI18n();
  const systemDetail = (error: unknown) =>
    rawDiagnosticText(error instanceof Error ? error.message : String(error ?? ""));
  const confirm = useConfirm();
  const streamRef = useRef<HTMLElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const compositionGuardTimerRef = useRef<number | null>(null);
  const compositionEndedByEnterRef = useRef(false);
  const isComposingTextRef = useRef(false);
  const suppressNextEnterRef = useRef(false);
  const roomsRef = useRef<Room[]>(props.roomsSnapshot.rooms);
  const membersRef = useRef<RoomMember[]>(props.roomsSnapshot.members);
  const { rooms, members, activeRoomId, hydrated: roomsHydrated } = props.roomsSnapshot;
  const deletedMemberIds = props.roomsSnapshot.deletedMemberIds ?? [];
  const { setRooms, setMembers, setDeletedMemberIds, setActiveRoomId, recordServerEventSeq, markRoomRead } =
    props.roomsActions;
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [replyingToMessageId, setReplyingToMessageId] = useState("");
  const [pendingCancelRunIds, setPendingCancelRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState("");
  const actionErrorTimerRef = useRef<number | null>(null);
  const [roomQuery, setRoomQuery] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberPickerMode, setMemberPickerMode] = useState<"add" | "remove" | null>(null);
  const [memberPickerQuery, setMemberPickerQuery] = useState("");
  const [memberPanelOpen, setMemberPanelOpen] = useState(false);
  const [memberPanelPage, setMemberPanelPage] = useState<"overview" | "members">("overview");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [employeeDialogOpen, setEmployeeDialogOpen] = useState(false);
  const [editingEmployeeId, setEditingEmployeeId] = useState("");
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupDraftTitle, setGroupDraftTitle] = useState("");
  const [groupDraftMemberIds, setGroupDraftMemberIds] = useState<string[]>([]);
  const [mentionMenu, setMentionMenu] = useState<MentionMenuState>({
    open: false,
    query: "",
    start: 0,
    end: 0,
    activeIndex: 0,
  });
  const employeeKernelOptions = props.kernelOptions;
  const visibleRooms = useMemo(() => rooms.filter((room) => !isAppScopedRoomId(room)), [rooms]);

  const activeRoom = useMemo(
    () => visibleRooms.find((room) => room.id === activeRoomId) ?? visibleRooms[0],
    [activeRoomId, visibleRooms],
  );
  const replyingToMessage = activeRoom?.messages.find((message) => message.id === replyingToMessageId);
  const {
    activeRunIds,
    activeRoomRuntimeEventsByRunId,
    allRoomRunIds,
    allRoomRuntimeEventsByRunId,
    contactMembers,
    deletedMemberIdSet,
    filteredMembers,
    memberPickerOptions,
    mentionOptions,
    removableMembers,
    roomMembers,
    runningRoomEventsByRunId,
    runningRoomRunIds,
    runsById,
    visibleRoomMemberCount,
    visibleRoomMembers,
  } = useRoomsDerivedState({
    rooms: visibleRooms,
    members,
    deletedMemberIds,
    activeRoom,
    memberQuery,
    memberPickerMode,
    memberPickerQuery,
    mentionMenu,
    runtimeEvents: props.runtimeEvents,
    runs: props.runs,
  });

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  useEffect(() => {
    setReplyingToMessageId("");
  }, [activeRoom?.id]);

  useEffect(() => {
    if (!roomsHydrated || !activeRoom?.unread) return;
    void markRoomRead(activeRoom.id);
  }, [activeRoom?.id, activeRoom?.unread, markRoomRead, roomsHydrated]);

  useEffect(() => {
    const nextRoomId = resolveVisibleRoomFocus(
      activeRoomId,
      props.focusRoomId,
      visibleRooms.map((room) => room.id),
    );
    if (nextRoomId === null) return;
    openRoom(nextRoomId);
  }, [activeRoomId, props.focusRoomId, visibleRooms]);

  useEffect(() => {
    membersRef.current = members.map((member) =>
      removedMemberForRoom(member, deletedMemberIdSet, t("rooms.statusRemoved")),
    );
  }, [deletedMemberIdSet, members, t]);

  const roomRunReconciliation = useMemo(
    () => ({
      rooms: visibleRooms,
      runs: props.runs,
      activeRunIds,
      allRoomRunIds,
      allRoomRuntimeEventsByRunId,
      runningRoomRunIds,
      runningRoomEventsByRunId,
      runsById,
      setRooms,
      setMembers,
    }),
    [
      activeRunIds,
      allRoomRunIds,
      allRoomRuntimeEventsByRunId,
      visibleRooms,
      props.runs,
      runningRoomEventsByRunId,
      runningRoomRunIds,
      runsById,
    ],
  );
  useRoomRunReconciliation(roomRunReconciliation);
  const messageCount = activeRoom?.messages.length ?? 0;

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.scrollTop = stream.scrollHeight;
  }, [messageCount, activeRoomId]);

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
      if (actionErrorTimerRef.current !== null) {
        window.clearTimeout(actionErrorTimerRef.current);
      }
    },
    [],
  );

  // 操作失败的就地提示：几秒后自动消失，不打断当前会话。
  function showActionError(prefix: string, error: unknown) {
    const detail = systemDetail(error);
    setActionError(detail ? t("rooms.actionErrorWithDetail", { prefix, detail }) : prefix);
    if (actionErrorTimerRef.current !== null) {
      window.clearTimeout(actionErrorTimerRef.current);
    }
    actionErrorTimerRef.current = window.setTimeout(() => {
      setActionError("");
      actionErrorTimerRef.current = null;
    }, 5000);
  }

  function updateActiveRoom(updater: (room: Room) => Room) {
    if (!activeRoom) return;
    setRooms((current) => current.map((room) => (room.id === activeRoom.id ? updater(room) : room)));
  }

  function updateRoom(roomId: string, updater: (room: Room) => Room) {
    setRooms((current) => current.map((room) => (room.id === roomId ? updater(room) : room)));
  }

  function updateRoomMessage(roomId: string, messageId: string, updater: (message: RoomMessage) => RoomMessage) {
    updateRoom(roomId, (room) => ({
      ...room,
      messages: room.messages.map((message) => (message.id === messageId ? updater(message) : message)),
      updatedAt: nowIso(),
    }));
  }

  function upsertRoomMessages(roomId: string, incomingMessages: RoomMessage[]) {
    if (!incomingMessages.length) return;
    updateRoom(roomId, (room) => {
      const byId = new Map(room.messages.map((message) => [message.id, normalizeRoomMessage(message)]));
      const byRunId = new Map<string, string>();
      for (const message of byId.values()) {
        if (message.senderType === "agent" && message.runId) {
          byRunId.set(message.runId, message.id);
        }
      }
      for (const incoming of incomingMessages) {
        const normalizedIncoming = normalizeRoomMessage(incoming);
        const currentId = byId.has(incoming.id)
          ? incoming.id
          : normalizedIncoming.senderType === "agent" && normalizedIncoming.runId
            ? byRunId.get(normalizedIncoming.runId)
            : undefined;
        const current = currentId ? byId.get(currentId) : undefined;
        if (currentId && currentId !== incoming.id) {
          byId.delete(currentId);
        }
        byId.set(incoming.id, current ? mergeRoomMessageRecord(current, normalizedIncoming) : normalizedIncoming);
        if (normalizedIncoming.senderType === "agent" && normalizedIncoming.runId) {
          byRunId.set(normalizedIncoming.runId, incoming.id);
        }
      }
      return {
        ...room,
        messages: [...byId.values()].sort(sortRoomMessages),
        updatedAt: nowIso(),
      };
    });
  }

  function updateMemberStatus(memberIds: string[], status: MemberStatus) {
    if (!memberIds.length) return;
    const targetIds = new Set(memberIds);
    setMembers((current) =>
      current.map((member) =>
        targetIds.has(member.id) && !member.disabled ? { ...member, status, lastActive: "刚刚" } : member,
      ),
    );
  }

  function cancelRoomRun(roomId: string, messageId: string, runId?: string) {
    const room = roomsRef.current.find((item) => item.id === roomId);
    const previous = room?.messages.find((message) => message.id === messageId);
    if (!previous || previous.status !== "running") return;
    if (runId && pendingCancelRunIds.has(runId)) return;
    const snapshot = structuredClone(previous);
    if (runId) {
      setPendingCancelRunIds((current) => new Set(current).add(runId));
    }
    // 乐观：立即把该气泡标为已中断、成员回到空闲。
    updateRoomMessage(roomId, messageId, interruptRoomMessage);
    updateMemberStatus([previous.senderId], "idle");
    void cancelServerRoomRun(roomId, messageId)
      .then((result) => {
        // 后端对"已取消"和"早已结束"都返回 200 + 权威 message，对齐回真实终态。
        recordServerEventSeq(result.currentEventSeq);
        if (result.message) {
          upsertRoomMessages(roomId, [result.message]);
        }
      })
      .catch(() => {
        // 真失败(网络/5xx)：run 很可能还在跑，回滚到 cancel 前快照，避免留下假"已中断"。
        updateRoomMessage(roomId, messageId, () => snapshot);
        updateMemberStatus([previous.senderId], "running");
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

  function replyToRoomMessage(message: RoomMessage) {
    const mention = agentAuthorMention(message, roomMembers);
    if (!mention) return;
    const nextDraft = draftWithAuthorMention(draft, mention);
    setDraft(nextDraft.value);
    setReplyingToMessageId(message.id);
    setMentionMenu((current) => ({ ...current, open: false }));
    focusComposer(nextDraft.cursor);
  }

  function mentionRoomMessageAuthor(message: RoomMessage) {
    const mention = agentAuthorMention(message, roomMembers);
    if (!mention) return;
    const nextDraft = draftWithAuthorMention(draft, mention);
    setDraft(nextDraft.value);
    setMentionMenu((current) => ({ ...current, open: false }));
    focusComposer(nextDraft.cursor);
  }

  async function deleteRoomMessage(roomId: string, messageId: string) {
    const room = roomsRef.current.find((item) => item.id === roomId);
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
    setRooms((current) =>
      current.map((item) =>
        item.id === roomId
          ? { ...item, messages: item.messages.filter((message) => message.id !== messageId), updatedAt: nowIso() }
          : item,
      ),
    );
    void deleteServerRoomMessage(roomId, messageId)
      .then((result) => recordServerEventSeq(result.currentEventSeq))
      .catch(() => {
        setRooms((current) =>
          current.map((item) => {
            if (item.id !== roomId || item.messages.some((message) => message.id === previous.id)) return item;
            return {
              ...item,
              messages: [...item.messages, previous].sort(sortRoomMessages),
              updatedAt: nowIso(),
            };
          }),
        );
      });
  }

  async function resolveRoomApproval(approvalId: string, action: "approve" | "reject", response?: unknown) {
    const result = await props.onResolveApproval?.(approvalId, action, response);
    if (!result) return;
    setRooms((current) =>
      current.map((room) => {
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
    );
  }

  async function resolveRoomQuestion(questionId: string, action: "answer" | "decline", response?: unknown) {
    const result = await props.onResolveQuestion?.(questionId, action, response);
    if (!result) return;
    setRooms((current) =>
      current.map((room) => {
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
    );
  }

  function rememberActiveRoom(roomId: string) {
    props.onActiveRoomChange?.(roomId);
  }

  function openRoom(roomId: string) {
    rememberActiveRoom(roomId);
    setActiveRoomId(roomId);
    setMemberPanelOpen(false);
    setMemberPickerMode(null);
    setMemberPickerQuery("");
    setRoomQuery("");
    setDraft("");
    setAttachments([]);
    setMentionMenu((current) => ({ ...current, open: false }));
  }

  function openCreateGroupDialog() {
    setGroupDraftTitle(
      t("rooms.newGroupDefaultTitle", { index: visibleRooms.filter((room) => room.kind === "group").length + 1 }),
    );
    setGroupDraftMemberIds([]);
    setGroupDialogOpen(true);
    setCreateMenuOpen(false);
  }

  function openRecruitEmployeeDialog() {
    setEditingEmployeeId("");
    setEmployeeDialogOpen(true);
    setCreateMenuOpen(false);
  }

  function openEmployeeProfile(member: RoomMember) {
    if (member.source === "human") return;
    setEditingEmployeeId(member.id);
    setEmployeeDialogOpen(true);
    setCreateMenuOpen(false);
  }

  function updateEmployeeDialogOpen(open: boolean) {
    setEmployeeDialogOpen(open);
    if (!open) setEditingEmployeeId("");
  }

  async function publishEmployee(member: RoomMember) {
    const confirmed = await confirm({
      title: t("confirm.publishEmployeeTitle"),
      body: t("confirm.publishEmployeeBody"),
      confirmLabel: t("common.confirm"),
    });
    if (confirmed !== "primary") return;
    try {
      await publishEmployeeToAppStore({
        memberId: member.id,
        title: `${member.name} Employee Pack`,
        summary: member.publicDescription?.trim().slice(0, 160) || undefined,
        category: t("app.rooms"),
      });
    } catch (error) {
      showActionError(
        t("contacts.publishFailed", {
          message: systemDetail(error),
        }),
        "",
      );
      throw error;
    }
  }

  async function deleteEmployeeFromSettings(member: RoomMember) {
    const confirmed = await confirm({
      title: t("contacts.deleteEmployeeTitle"),
      body: t("contacts.deleteEmployeeConfirm", { name: member.name }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (confirmed !== "primary") return;
    updateEmployeeDialogOpen(false);
    setMembers((current) =>
      current.map((item) =>
        item.id === member.id
          ? {
              ...item,
              disabled: true,
              status: "offline",
            }
          : item,
      ),
    );
    setDeletedMemberIds((current) => Array.from(new Set([...current, member.id])));
    try {
      await patchServerRoomMember(member.id, {
        disabled: true,
        status: "offline",
      });
    } catch (error) {
      setMembers((current) => current.map((item) => (item.id === member.id ? member : item)));
      setDeletedMemberIds((current) => current.filter((memberId) => memberId !== member.id));
      showActionError(
        t("mountedApp.deleteGroupFailed", {
          message: systemDetail(error),
        }),
        "",
      );
    }
  }

  function addEmployee(member: RoomMember) {
    const restoredMember: RoomMember = {
      ...member,
      disabled: false,
      status: member.status === "offline" ? "idle" : member.status,
      lastActive: "刚刚",
    };
    const previousMember = members.find((item) => item.id === restoredMember.id);
    const previousDeletedMemberIds = deletedMemberIds;
    upsertLocalMember(restoredMember);
    setDeletedMemberIds((current) => current.filter((memberId) => memberId !== restoredMember.id));
    const shouldAddToActiveRoom = activeRoom?.kind === "group" && !activeRoom.memberIds.includes(restoredMember.id);
    const activeRoomIdForAdd = shouldAddToActiveRoom ? activeRoom?.id : "";
    const previousRoomMemberIds = shouldAddToActiveRoom ? activeRoom?.memberIds : undefined;
    void upsertServerRoomMember(restoredMember)
      .then((result) => {
        applySyncedMember(restoredMember.id, result.member);
        if (activeRoomIdForAdd && result.member?.id) {
          void addServerRoomMember(activeRoomIdForAdd, result.member).catch((error) => {
            if (previousRoomMemberIds) {
              updateRoom(activeRoomIdForAdd, (room) => ({
                ...room,
                memberIds: previousRoomMemberIds,
                updatedAt: nowIso(),
              }));
            }
            showActionError(t("rooms.addEmployeeToGroupFailed"), error);
          });
        }
      })
      .catch((error) => {
        // 回滚到添加前快照，避免留下本地有、服务端没有的"幽灵员工"。
        setMembers((current) =>
          previousMember
            ? current.map((item) => (item.id === previousMember.id ? previousMember : item))
            : current.filter((item) => item.id !== restoredMember.id),
        );
        setDeletedMemberIds(previousDeletedMemberIds);
        if (activeRoomIdForAdd && previousRoomMemberIds) {
          updateRoom(activeRoomIdForAdd, (room) => ({
            ...room,
            memberIds: previousRoomMemberIds,
            updatedAt: nowIso(),
          }));
        }
        showActionError(t("rooms.addEmployeeFailed"), error);
      });
    if (shouldAddToActiveRoom) {
      updateActiveRoom((room) => ({
        ...room,
        memberIds: [...room.memberIds, restoredMember.id],
        updatedAt: nowIso(),
      }));
    }
    focusComposer();
  }

  function upsertLocalMember(member: RoomMember) {
    setMembers((current) =>
      current.some((item) => item.id === member.id)
        ? current.map((item) => (item.id === member.id ? { ...item, ...member } : item))
        : [...current, member],
    );
  }

  async function saveEmployeeProfile(nextMember: RoomMember) {
    const previousMember =
      membersRef.current.find((member) => member.id === nextMember.id) ??
      members.find((member) => member.id === nextMember.id);
    if (!previousMember) return;
    const patch = employeeProfilePatch(previousMember, nextMember);
    if (!Object.keys(patch).length) return;
    setMembers((current) => current.map((member) => (member.id === nextMember.id ? { ...member, ...patch } : member)));
    setRooms((current) => projectRoomMemberIdentity(current, nextMember.id, nextMember));
    try {
      const result = await patchServerRoomMember(nextMember.id, patch, { clearUndefined: true });
      applySyncedMember(nextMember.id, result.member);
    } catch (error) {
      setMembers((current) => current.map((member) => (member.id === previousMember.id ? previousMember : member)));
      setRooms((current) => projectRoomMemberIdentity(current, previousMember.id, previousMember));
      showActionError(
        t("contacts.saveFailed", {
          message: systemDetail(error),
        }),
        "",
      );
      throw error;
    }
  }

  async function restoreEmployeeAppDefaults(member: RoomMember) {
    const result = await restoreServerRoomMemberAppDefaults(member.id);
    applySyncedMember(member.id, result.member);
  }

  function applySyncedMember(previousMemberId: string, syncedMember: RoomMember | undefined) {
    if (!syncedMember?.id) return;
    const sourceMembers = membersRef.current.length ? membersRef.current : members;
    const withoutPrevious =
      previousMemberId === syncedMember.id
        ? sourceMembers
        : sourceMembers.filter((member) => member.id !== previousMemberId);
    const nextMembers = withoutPrevious.some((member) => member.id === syncedMember.id)
      ? withoutPrevious.map((member) => (member.id === syncedMember.id ? { ...member, ...syncedMember } : member))
      : [...withoutPrevious, syncedMember];
    const deduped = dedupeRoomMembers(nextMembers);
    const knownMemberIds = new Set(deduped.members.filter((member) => !member.disabled).map((member) => member.id));
    setMembers(deduped.members);
    if (previousMemberId !== syncedMember.id) {
      setRooms((current) =>
        current.map((room) => ({
          ...room,
          memberIds: room.memberIds.map((memberId) => (memberId === previousMemberId ? syncedMember.id : memberId)),
          directMemberId: room.directMemberId === previousMemberId ? syncedMember.id : room.directMemberId,
        })),
      );
      setDeletedMemberIds((current) =>
        current.filter((memberId) => memberId !== previousMemberId && memberId !== syncedMember.id),
      );
    }
    setRooms((currentRooms) =>
      projectRoomMemberIdentity(currentRooms, previousMemberId, syncedMember).map((room) =>
        remapRoomMemberReferences(room, deduped.memberIdAliases, knownMemberIds),
      ),
    );
    setDeletedMemberIds((current) => current.filter((memberId) => !deduped.memberIdAliases.has(memberId)));
  }

  async function resolveServerMemberIds(memberIds: string[]): Promise<string[]> {
    const membersById = new Map(contactMembers.map((member) => [member.id, member]));
    const resolved: string[] = [];
    for (const memberId of memberIds) {
      const member = membersById.get(memberId);
      if (!member || !shouldResolveScopedUserMember(member)) {
        resolved.push(memberId);
        continue;
      }
      const result = await upsertServerRoomMember(member);
      applySyncedMember(member.id, result.member);
      resolved.push(result.member.id || memberId);
    }
    return [...new Set(resolved.filter(Boolean))];
  }

  function shouldResolveScopedUserMember(member: RoomMember): boolean {
    return member.id.startsWith("employee_");
  }

  function toggleGroupDraftMember(memberId: string) {
    setGroupDraftMemberIds((current) =>
      current.includes(memberId) ? current.filter((id) => id !== memberId) : [...current, memberId],
    );
  }

  async function createRoom(memberIds: string[], title: string) {
    if (!memberIds.length) return;
    const resolvedMemberIds = await resolveServerMemberIds(memberIds);
    if (!resolvedMemberIds.length) return;
    const globalPm = members.find((member) => !member.disabled && !member.appId && isRoomPmMember(member));
    const defaultMemberIds =
      globalPm && !resolvedMemberIds.includes(globalPm.id) ? [...resolvedMemberIds, globalPm.id] : resolvedMemberIds;
    const createdAt = nowIso();
    const sequence = visibleRooms.filter((room) => room.kind === "group").length + 1;
    const defaultTitle = t("rooms.newGroupDefaultTitle", { index: sequence });
    const resolvedTitle = title.trim() || defaultTitle;
    const newRoom: Room = {
      id: createId("room"),
      kind: "group",
      title: resolvedTitle,
      generatedTitle: resolvedTitle === defaultTitle ? { kind: "numbered-group", sequence } : undefined,
      badge: t("conversation.local"),
      memberIds: defaultMemberIds,
      adminMemberIds: defaultMemberIds.filter((memberId) => {
        const member = members.find((candidate) => candidate.id === memberId);
        return member ? isRoomPmMember(member) : false;
      }),
      pinned: false,
      unread: 0,
      updatedAt: createdAt,
      messages: [
        {
          id: createId("message"),
          senderId: "system",
          senderName: t("mountedApp.systemSenderName"),
          senderType: "system",
          text: t("rooms.newGroupWelcome"),
          targetIds: [],
          status: "done",
          createdAt,
        },
      ],
    };
    setRooms((current) => [newRoom, ...current]);
    void createServerRoom(newRoom).catch((error) => {
      // 创建失败：撤掉乐观插入的本地群，避免对着服务端不存在的群发消息。
      setRooms((current) => current.filter((room) => room.id !== newRoom.id));
      showActionError(t("rooms.createGroupFailed"), error);
    });
    rememberActiveRoom(newRoom.id);
    setActiveRoomId(newRoom.id);
    setMemberPanelOpen(false);
    setMemberPickerMode(null);
    setMemberPickerQuery("");
    setCreateMenuOpen(false);
    setRoomQuery("");
    setDraft("");
    setAttachments([]);
    setMentionMenu((current) => ({ ...current, open: false }));
  }

  function createGroupFromDialog() {
    const contactMemberIds = new Set(contactMembers.map((member) => member.id));
    const selectedMemberIds = groupDraftMemberIds.filter((memberId) => contactMemberIds.has(memberId));
    if (!selectedMemberIds.length) return;
    void createRoom(selectedMemberIds, groupDraftTitle)
      .then(() => setGroupDialogOpen(false))
      .catch((error: unknown) => showActionError(t("rooms.createGroupFailed"), error));
  }

  function openDirectMember(member: RoomMember) {
    const roomId = directRoomId(member.id);
    const existing = rooms.find((room) => room.id === roomId);
    if (!existing) {
      const createdAt = nowIso();
      const displayName = roomMemberDisplayName(member);
      const newRoom: Room = {
        id: roomId,
        kind: "direct",
        title: displayName,
        badge: t("contacts.directBadge"),
        memberIds: [member.id],
        adminMemberIds: [],
        directMemberId: member.id,
        pinned: false,
        unread: 0,
        updatedAt: createdAt,
        messages: [
          {
            id: createId("message"),
            senderId: "system",
            senderName: t("mountedApp.systemSenderName"),
            senderType: "system",
            text: t("rooms.directRoomWelcome", { name: displayName }),
            targetIds: [],
            status: "done",
            createdAt,
          },
        ],
      };
      setRooms((current) => [newRoom, ...current]);
      void openServerDirectRoom(member.id, member.name, { member })
        .then((result) => {
          applySyncedMember(member.id, result.member);
          const confirmedRoomId = result.room?.id || roomId;
          if (confirmedRoomId !== roomId) {
            setRooms((current) =>
              current.map((room) =>
                room.id === roomId
                  ? {
                      ...room,
                      ...result.room,
                      messages: room.messages,
                    }
                  : room,
              ),
            );
          }
          rememberActiveRoom(confirmedRoomId);
          setActiveRoomId(confirmedRoomId);
        })
        .catch((error) => {
          // 私聊在服务端创建失败：撤掉乐观的本地房间，避免假"已进入私聊"。
          setRooms((current) => current.filter((room) => room.id !== roomId));
          showActionError(t("rooms.openDirectRoomFailed"), error);
        });
    }
    rememberActiveRoom(roomId);
    setActiveRoomId(roomId);
    setMemberPanelOpen(false);
    setMemberPickerMode(null);
    setMemberPickerQuery("");
    setRoomQuery("");
    setDraft("");
    setAttachments([]);
    setMentionMenu((current) => ({ ...current, open: false }));
  }

  function openMemberManager() {
    setMemberPanelPage("overview");
    setMemberPanelOpen(true);
  }

  function openRoomMembers() {
    setMemberPanelPage("overview");
    setMemberPanelOpen(true);
  }

  function openMemberPicker(mode: "add" | "remove") {
    setMemberPanelPage("overview");
    setMemberPanelOpen(true);
    setMemberPickerMode((current) => (current === mode ? null : mode));
    setMemberPickerQuery("");
  }

  function closeMemberPicker() {
    setMemberPickerMode(null);
    setMemberPickerQuery("");
  }

  function renameActiveRoom(nextTitle: string) {
    if (!activeRoom || activeRoom.kind !== "group") return;
    const roomId = activeRoom.id;
    const previousTitle = activeRoom.title;
    if (!nextTitle || nextTitle === previousTitle) return;
    updateActiveRoom((room) => ({
      ...room,
      title: nextTitle,
      updatedAt: nowIso(),
    }));
    void patchServerRoom(roomId, { title: nextTitle }).catch((error) => {
      updateRoom(roomId, (room) => ({
        ...room,
        title: previousTitle,
        updatedAt: nowIso(),
      }));
      showActionError(t("rooms.renameGroupFailed"), error);
    });
  }

  function updateActiveRoomPinned(pinned: boolean) {
    if (!activeRoom || Boolean(activeRoom.pinned) === pinned) return;
    const roomId = activeRoom.id;
    const previousPinned = Boolean(activeRoom.pinned);
    updateActiveRoom((room) => ({
      ...room,
      pinned,
      updatedAt: nowIso(),
    }));
    void patchServerRoom(roomId, { pinned }).catch((error) => {
      updateRoom(roomId, (room) => ({
        ...room,
        pinned: previousPinned,
        updatedAt: nowIso(),
      }));
      showActionError(t(pinned ? "rooms.pinFailed" : "rooms.unpinFailed"), error);
    });
  }

  async function dissolveActiveRoom() {
    if (!activeRoom || activeRoom.kind !== "group") return;
    const room = activeRoom;
    const confirmed = await confirm({
      title: t("rooms.dissolveGroup"),
      body: t("rooms.dissolveGroupConfirm", { title: room.title }),
      confirmLabel: t("rooms.dissolveGroup"),
      danger: true,
    });
    if (confirmed !== "primary") return;
    try {
      await patchServerRoom(room.id, { archived: true });
      const nextRoom = visibleRooms.find((candidate) => candidate.id !== room.id);
      setRooms((current) => current.filter((candidate) => candidate.id !== room.id));
      setMemberPanelOpen(false);
      setMemberPickerMode(null);
      setMemberPickerQuery("");
      setDraft("");
      setAttachments([]);
      setActiveRoomId(nextRoom?.id ?? "");
      rememberActiveRoom(nextRoom?.id ?? "");
    } catch (error) {
      showActionError(t("rooms.dissolveGroupFailed"), error);
    }
  }

  function addMemberToActiveRoom(member: RoomMember) {
    if (!activeRoom || activeRoom.kind !== "group" || activeRoom.memberIds.includes(member.id)) {
      setMemberPanelOpen(true);
      return;
    }
    const roomId = activeRoom.id;
    const previousMemberIds = activeRoom.memberIds;
    updateActiveRoom((room) => ({
      ...room,
      memberIds: [...room.memberIds, member.id],
      updatedAt: nowIso(),
    }));
    void (async () => {
      let memberForServer = member;
      if (shouldResolveScopedUserMember(member)) {
        const result = await upsertServerRoomMember(member);
        memberForServer = result.member ?? member;
        applySyncedMember(member.id, memberForServer);
      }
      const result = await addServerRoomMember(roomId, memberForServer);
      applySyncedMember(memberForServer.id, result.member);
    })().catch((error) => {
      updateRoom(roomId, (room) => ({
        ...room,
        memberIds: previousMemberIds,
        updatedAt: nowIso(),
      }));
      showActionError(t("rooms.addMemberFailed"), error);
    });
    setMemberPanelOpen(true);
    setMemberQuery("");
    closeMemberPicker();
  }

  function removeMemberFromActiveRoom(member: RoomMember) {
    if (!activeRoom || activeRoom.kind !== "group" || activeRoom.memberIds.length <= 1) {
      setMemberPanelOpen(true);
      return;
    }
    const roomId = activeRoom.id;
    const previousMemberIds = activeRoom.memberIds;
    const previousAdminMemberIds = activeRoom.adminMemberIds;
    updateActiveRoom((room) => {
      const nextMemberIds = room.memberIds.filter((memberId) => memberId !== member.id);
      if (nextMemberIds.length === room.memberIds.length || nextMemberIds.length === 0) return room;
      return {
        ...room,
        memberIds: nextMemberIds,
        adminMemberIds: room.adminMemberIds.filter((memberId) => memberId !== member.id),
        updatedAt: nowIso(),
      };
    });
    void removeServerRoomMember(roomId, member.id).catch((error) => {
      updateRoom(roomId, (room) => ({
        ...room,
        memberIds: previousMemberIds,
        adminMemberIds: previousAdminMemberIds,
        updatedAt: nowIso(),
      }));
      showActionError(t("rooms.removeMemberFailed"), error);
    });
    setMemberPanelOpen(true);
    setMemberQuery("");
    closeMemberPicker();
  }

  function toggleMemberAdmin(member: RoomMember) {
    if (!activeRoom || activeRoom.kind !== "group" || !activeRoom.memberIds.includes(member.id)) return;
    const roomId = activeRoom.id;
    const previousAdminMemberIds = activeRoom.adminMemberIds;
    const nextAdminMemberIds = previousAdminMemberIds.includes(member.id)
      ? previousAdminMemberIds.filter((memberId) => memberId !== member.id)
      : [...previousAdminMemberIds, member.id];
    updateActiveRoom((room) => ({
      ...room,
      adminMemberIds: nextAdminMemberIds,
      updatedAt: nowIso(),
    }));
    void patchServerRoom(roomId, { adminMemberIds: nextAdminMemberIds }).catch((error) => {
      updateRoom(roomId, (room) => ({
        ...room,
        adminMemberIds: previousAdminMemberIds,
        updatedAt: nowIso(),
      }));
      showActionError(t("rooms.updateMemberAdminFailed"), error);
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

  // forwarding-boundary: provides the semantic attachment action used by the room composer UI.
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
    return sendRoomText({
      rawText,
      outgoingAttachments,
      activeRoom,
      roomMembers,
      kernelOptions: props.kernelOptions,
      replyingToMessage: replyToMessage,
      onCompleteOnboardingGuide: props.onCompleteOnboardingGuide,
      onUpdateMemberStatus: updateMemberStatus,
      onHasOtherRunningMessage: (memberId, excludedMessageIds) => {
        const excludedIds = new Set(excludedMessageIds);
        return roomsRef.current.some((room) =>
          room.messages.some(
            (message) =>
              !excludedIds.has(message.id) &&
              message.senderType === "agent" &&
              message.senderId === memberId &&
              message.status === "running",
          ),
        );
      },
      onUpdateRoom: updateRoom,
      onUpdateRoomMessage: updateRoomMessage,
      onUpsertRoomMessages: upsertRoomMessages,
      onServerEventSeq: (eventSeq) => {
        recordServerEventSeq(eventSeq);
      },
    });
  }

  if (!activeRoom) {
    return (
      <>
        <RoomsEmptyState
          loading={!roomsHydrated}
          onCreateEmployee={openRecruitEmployeeDialog}
          onOpenContacts={props.onOpenContacts}
          employeeDialogProps={{
            open: employeeDialogOpen,
            activeKernel: props.activeKernel,
            activeModel: props.activeModel,
            runtimeControls: props.runtimeControls,
            runtimeControlsByKernel: props.runtimeControlsByKernel,
            kernelOptions: employeeKernelOptions,
            providers: props.providers,
            modelProviderBindings: props.modelProviderBindings,
            onOpenChange: updateEmployeeDialogOpen,
            onCreate: addEmployee,
          }}
        />
        {actionError ? (
          <div className="rooms-action-error" role="alert">
            {actionError}
          </div>
        ) : null}
      </>
    );
  }

  const activeDirectMember = directRoomMember(activeRoom, roomMembers);
  const runningRoomMembers = roomMembers.filter((member) => !member.disabled && member.status === "running");
  const editingEmployee = editingEmployeeId ? members.find((member) => member.id === editingEmployeeId) : undefined;

  return (
    <>
      <RoomsActiveLayout
        activeRoom={activeRoom}
        activeRoomMembers={roomMembers}
        activeDirectMember={activeDirectMember}
        memberPanelOpen={memberPanelOpen}
        runningRoomMembers={runningRoomMembers}
        onOpenMemberManager={openMemberManager}
        onOpenRoomMembers={openRoomMembers}
        onOpenEmployeeProfile={openEmployeeProfile}
        onRenameRoom={renameActiveRoom}
        onDissolveRoom={() => void dissolveActiveRoom()}
        sidebarProps={{
          activeRoom,
          rooms: visibleRooms,
          members,
          roomQuery,
          createMenuOpen,
          onCreateMenuOpenChange: setCreateMenuOpen,
          onCreateGroup: openCreateGroupDialog,
          onRecruitEmployee: openRecruitEmployeeDialog,
          onOpenContacts: props.onOpenContacts,
          onRoomQueryChange: setRoomQuery,
          onOpenRoom: openRoom,
          onOpenDirectMember: openDirectMember,
        }}
        chatSurfaceProps={{
          streamRef,
          composerInputRef,
          fileInputRef,
          roomId: activeRoom.id,
          roomTitle: activeRoom.title,
          messages: activeRoom.messages,
          members,
          workspaceRoot: props.activeWorkspaceRoot,
          runtimeEventsByRunId: activeRoomRuntimeEventsByRunId,
          pendingQuestionIds: props.pendingQuestionIds,
          pendingCancelRunIds,
          onCancelRun: (messageId, runId) => cancelRoomRun(activeRoom.id, messageId, runId),
          trailingContent: null,
          draft,
          attachments,
          replyingToMessage,
          canSend: canSendRoomDraft(draft, attachments.length),
          mentionOpen: mentionMenu.open,
          mentionOptions,
          activeMentionIndex: mentionMenu.activeIndex,
          onResolveApproval: (approvalId, action, response) => {
            return resolveRoomApproval(approvalId, action, response);
          },
          onResolveQuestion: (questionId, action, response) => {
            return resolveRoomQuestion(questionId, action, response);
          },
          onInsertPrompt: insertPrompt,
          onSubmitPrompt: submitPromptFromActivity,
          onReplyMessage: replyToRoomMessage,
          onMentionMessageAuthor: mentionRoomMessageAuthor,
          onDeleteMessage: (messageId) => deleteRoomMessage(activeRoom.id, messageId),
          onOpenMemberProfile: openEmployeeProfile,
          onDraftChange: handleDraftChange,
          onAttachmentInputChange: handleAttachmentInputChange,
          onOpenAttachmentPicker: openAttachmentPicker,
          onRemoveAttachment: removeAttachment,
          onCancelReply: () => setReplyingToMessageId(""),
          onPaste: handleComposerPaste,
          onKeyDown: handleComposerKeyDown,
          onCompositionStart: handleComposerCompositionStart,
          onCompositionEnd: handleComposerCompositionEnd,
          onOpenMention: openMentionMenuFromButton,
          onMentionOpenChange: (open) => setMentionMenu((current) => ({ ...current, open })),
          onSelectMention: applyMention,
          onHoverMention: (index) => setMentionMenu((current) => ({ ...current, activeIndex: index })),
          onSend: sendDraft,
        }}
        settingsPanelProps={{
          activeRoom,
          activeDirectMember,
          memberPanelOpen,
          page: memberPanelPage,
          memberQuery,
          memberPickerMode,
          memberPickerQuery,
          memberPickerOptions,
          visibleRoomMembers,
          filteredMembers,
          removableMembers,
          visibleRoomMemberCount,
          onClose: () => setMemberPanelOpen(false),
          onPageChange: (page) => {
            setMemberPanelPage(page);
            closeMemberPicker();
          },
          onRenameRoom: renameActiveRoom,
          onPinnedChange: updateActiveRoomPinned,
          onMemberQueryChange: setMemberQuery,
          onOpenMemberPicker: openMemberPicker,
          onCloseMemberPicker: closeMemberPicker,
          onMemberPickerQueryChange: setMemberPickerQuery,
          onAddMember: addMemberToActiveRoom,
          onRemoveMember: removeMemberFromActiveRoom,
          onToggleMemberAdmin: toggleMemberAdmin,
          onOpenMemberProfile: openEmployeeProfile,
        }}
        createGroupDialogProps={{
          open: groupDialogOpen,
          title: groupDraftTitle,
          selectedMemberIds: groupDraftMemberIds,
          contactMembers,
          onOpenChange: setGroupDialogOpen,
          onTitleChange: setGroupDraftTitle,
          onToggleMember: toggleGroupDraftMember,
          onCreate: createGroupFromDialog,
        }}
        employeeDialogProps={{
          open: employeeDialogOpen && !editingEmployee,
          activeKernel: props.activeKernel,
          activeModel: props.activeModel,
          runtimeControls: props.runtimeControls,
          runtimeControlsByKernel: props.runtimeControlsByKernel,
          kernelOptions: employeeKernelOptions,
          providers: props.providers,
          modelProviderBindings: props.modelProviderBindings,
          onOpenChange: updateEmployeeDialogOpen,
          onCreate: addEmployee,
        }}
        employeeSettingsDialogProps={
          editingEmployee
            ? {
                open: employeeDialogOpen,
                onOpenChange: updateEmployeeDialogOpen,
                member: editingEmployee,
                rooms: visibleRooms,
                activeKernel: props.activeKernel,
                activeModel: props.activeModel,
                extensions: props.extensions,
                kernelOptions: employeeKernelOptions,
                providers: props.providers,
                modelProviderBindings: props.modelProviderBindings,
                runtimeControls: props.runtimeControls,
                runtimeControlsByKernel: props.runtimeControlsByKernel,
                skills: props.skills,
                onMessage: () => {
                  updateEmployeeDialogOpen(false);
                  openDirectMember(editingEmployee);
                },
                onPublish: () => publishEmployee(editingEmployee),
                onDelete: () => void deleteEmployeeFromSettings(editingEmployee),
                onRestoreAppDefaults: () => restoreEmployeeAppDefaults(editingEmployee),
                onSave: saveEmployeeProfile,
              }
            : undefined
        }
      />
      {actionError ? (
        <div className="rooms-action-error" role="alert">
          {actionError}
        </div>
      ) : null}
    </>
  );
}
