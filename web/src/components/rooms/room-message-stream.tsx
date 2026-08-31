import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import "./room-message-stream.css";
import { Check, Image as ImageIcon, Square } from "lucide-react";
import {
  downloadBridgeFileWithMetadata,
  type AgentEventRecord,
  type AttachmentPayload,
  type MessagePart,
  type NotePart,
} from "../../bridge";
import { apiUrl } from "../../api-base";
import { rawDiagnosticText, useI18n, type TranslationFn } from "../../i18n";
import {
  applyStreamEventToMessage,
  closeDanglingMessageActivity,
  collectMessageText,
  isRenderableMessagePart,
  normalizeMessagePartsForDisplay,
} from "../../messages";
import { attachmentIcon, attachmentImagePreviewUrl } from "../../runtime/ui-model";
import {
  isConnectorProcessNote,
  isNativeAgentCommentaryNote,
  processGroupsHaveRunningActivity,
  processGroupsToActivityEntries,
  splitAssistantPartsForSurface,
  type AssistantPartGroup,
} from "../chat/assistant-run-view-model";
import {
  ApprovalInteractionCard,
  AssistantProcessBlock,
  QuestionInteractionCard,
  choiceFormFromItem,
  renderActivitySummary,
  summarizeActivityItems,
  type ActivityEntry,
} from "../chat/message-activity";
import { agentOrbStateFromRun } from "../chat/agent-state-presentation";
import { DISCLOSURE_MOTION_SETTLED_EVENT, Disclosure } from "../chat/disclosure";
import { ThreadTextBlock } from "../chat/message-markdown";
import type { ChatImagePayload } from "../chat/message-types";
import { ChatResourcePreviewPanel } from "../chat/chat-resource-preview-panel";
import { copyTextToClipboard, useChatResourceActions } from "../chat/use-chat-resource-actions";
import { useLatestCallback } from "../chat/use-latest-callback";
import {
  resolveRoomMessageResourceContext,
  type ChatResourceAction,
  type ChatResourceContext,
  type ChatResourceRef,
} from "../chat/resource-model";
import { AgentStateIndicator, type AgentStatePresentation } from "../ui/agent-state-indicator";
import { useConfirm } from "../ui/confirm-dialog";
import { MotionContextMenu, MotionMenu, MotionMenuItem, MotionMenuSeparator } from "../ui/motion/menu";
import { TextShimmer } from "../ui/motion/text-shimmer";
import { TextTransition } from "../ui/motion/text-transition";
import { ProductIcon } from "../ui/product-icon";
import { Tooltip } from "../ui/tooltip";
import { useOptionalToast } from "../ui/toast";
import { RoomMemberAvatar } from "./member-avatar";
import {
  cloneMessageParts,
  formatRoomDayLabel,
  formatRoomMessageTime,
  isDelegationTransportMessage,
  roomMessageDayKey,
  roomReplyPreview,
  roomActivityParts,
  roomMessageToStored,
  shouldUseRoomActivityEvent,
} from "./room-message-model";
import { agentAuthorMention } from "./room-chat-utils";
import { normalizeClientConnectorMessageParts } from "./rooms-legacy-message-normalization";
import {
  roomMemberDisplayName,
  type MessageStatus,
  type RoomMember,
  type RoomMessage,
  type RoomReplyPreview,
} from "./rooms-model";

const MESSAGE_TOOLBAR_GAP = 8;

type RoomMessageToolbarPlacement = "right" | "top";

export function RoomMessageStream(props: {
  roomId: string;
  messages: RoomMessage[];
  members: RoomMember[];
  workspaceRoot?: string;
  runtimeEventsByRunId: Map<string, AgentEventRecord[]>;
  pendingQuestionIds?: ReadonlySet<string>;
  pendingCancelRunIds?: ReadonlySet<string>;
  onCancelRun?(messageId: string, runId?: string): void;
  trailingContent?: ReactNode;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): void;
  onInsertPrompt(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onReplyMessage?(message: RoomMessage): void;
  onMentionMessageAuthor?(message: RoomMessage): void;
  onDeleteMessage?(messageId: string): void;
  onOpenMemberProfile?(member: RoomMember): void;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
}) {
  const { t } = useI18n();
  const resourceActions = useChatResourceActions();
  const mergedOpenResource = props.onOpenResource ?? resourceActions.openResource;
  // 父层回调每次 render 都会重建；包成稳定引用，保证 memo 化的 RoomMessageItem 生效。
  const onCancelRun = useLatestCallback(props.onCancelRun);
  const onResolveApproval = useLatestCallback(props.onResolveApproval);
  const onResolveQuestion = useLatestCallback(props.onResolveQuestion);
  const onInsertPrompt = useLatestCallback(props.onInsertPrompt);
  const onSubmitPrompt = useLatestCallback(props.onSubmitPrompt);
  const onReplyMessage = useLatestCallback(props.onReplyMessage);
  const onMentionMessageAuthor = useLatestCallback(props.onMentionMessageAuthor);
  const onDeleteMessage = useLatestCallback(props.onDeleteMessage);
  const onOpenMemberProfile = useLatestCallback(props.onOpenMemberProfile);
  const onPreviewImage = useLatestCallback(props.onPreviewImage);
  const openResource = useLatestCallback(mergedOpenResource);
  const visibleMessages = props.messages.filter((message) => !isDelegationTransportMessage(message));
  const replyPreviewByMessageId = useMemo(() => {
    const messageById = new Map(props.messages.map((message) => [message.id, message]));
    const previews = new Map<string, RoomReplyPreview>();
    for (const message of props.messages) {
      if (message.senderType !== "user" || !message.inReplyToMessageId) continue;
      previews.set(message.id, roomReplyPreview(messageById.get(message.inReplyToMessageId), props.members, t));
    }
    return previews;
  }, [props.members, props.messages, t]);
  const activeChoiceFormKey = findActiveRoomChoiceFormKey(visibleMessages, props.runtimeEventsByRunId);
  let previousDayKey = "";

  return (
    <div className="room-chat-stream">
      {visibleMessages.map((message) => {
        const dayKey = roomMessageDayKey(message.createdAt);
        const showDaySeparator = Boolean(dayKey && dayKey !== previousDayKey);
        if (dayKey) previousDayKey = dayKey;
        return (
          <Fragment key={message.id}>
            {showDaySeparator ? (
              <div className="room-chat-date-separator" data-day={dayKey}>
                {formatRoomDayLabel(message.createdAt)}
              </div>
            ) : null}
            <RoomMessageItem
              roomId={props.roomId}
              message={message}
              replyPreview={replyPreviewByMessageId.get(message.id)}
              members={props.members}
              workspaceRoot={props.workspaceRoot}
              runtimeEvents={message.runId ? props.runtimeEventsByRunId.get(message.runId) : undefined}
              pendingQuestionIds={props.pendingQuestionIds}
              pendingCancelRunIds={props.pendingCancelRunIds}
              onCancelRun={onCancelRun}
              activeChoiceFormKey={activeChoiceFormKey}
              onResolveApproval={onResolveApproval}
              onResolveQuestion={onResolveQuestion}
              onInsertPrompt={onInsertPrompt}
              onSubmitPrompt={onSubmitPrompt}
              onReplyMessage={onReplyMessage}
              onMentionMessageAuthor={onMentionMessageAuthor}
              onDeleteMessage={onDeleteMessage}
              onOpenMemberProfile={onOpenMemberProfile}
              onPreviewImage={onPreviewImage}
              onOpenResource={openResource}
            />
          </Fragment>
        );
      })}
      {props.trailingContent}
      {!props.onOpenResource && resourceActions.preview ? (
        <ChatResourcePreviewPanel preview={resourceActions.preview} onClose={resourceActions.closePreview} />
      ) : null}
    </div>
  );
}

const RoomMessageItem = memo(function RoomMessageItem(props: {
  roomId: string;
  message: RoomMessage;
  replyPreview?: RoomReplyPreview;
  members: RoomMember[];
  workspaceRoot?: string;
  runtimeEvents?: AgentEventRecord[];
  pendingQuestionIds?: ReadonlySet<string>;
  pendingCancelRunIds?: ReadonlySet<string>;
  onCancelRun?(messageId: string, runId?: string): void;
  activeChoiceFormKey?: string;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): void;
  onInsertPrompt(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onReplyMessage?(message: RoomMessage): void;
  onMentionMessageAuthor?(message: RoomMessage): void;
  onDeleteMessage?(messageId: string): void;
  onOpenMemberProfile?(member: RoomMember): void;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
}) {
  const { message } = props;
  const { t } = useI18n();
  const confirm = useConfirm();
  const toast = useOptionalToast()?.toast;
  const reduceMotion = useReducedMotion();
  const member = props.members.find((item) => item.id === message.senderId);
  const senderDisplayName = member ? roomMemberDisplayName(member) : message.senderName;
  const isUser = message.senderType === "user";
  const isSystem = message.senderType === "system";
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [actionSurfaceActive, setActionSurfaceActive] = useState(false);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarPlacement, setToolbarPlacement] = useState<RoomMessageToolbarPlacement>("right");
  const [toolbarStyle, setToolbarStyle] = useState<CSSProperties>();
  const resourceContext: ChatResourceContext | undefined = resolveRoomMessageResourceContext(
    member,
    props.workspaceRoot,
  );

  const doneDuration =
    message.status === "running" || message.status === "failed" || message.status === "interrupted"
      ? undefined
      : message.duration;
  const statusText =
    message.status === "running"
      ? t("rooms.statusRunning")
      : message.status === "failed"
        ? t("mountedApp.flowFailed")
        : message.status === "interrupted"
          ? t("contacts.runStatusInterrupted")
          : doneDuration
            ? t("rooms.doneWithDuration", { duration: doneDuration })
            : formatRoomMessageTime(message.createdAt);
  const agentStatusText =
    !isUser &&
    message.status !== "running" &&
    message.status !== "failed" &&
    message.status !== "interrupted" &&
    !doneDuration
      ? undefined
      : statusText;
  const parts = roomDisplayParts(message, props.runtimeEvents);
  const turnGroups = isUser
    ? { answerGroups: [], processGroups: [], segments: [] }
    : splitAssistantPartsForSurface(parts.filter(isRenderableMessagePart), message.id);
  const { answerGroups } = turnGroups;
  const hasTextPart = answerGroups.some((group) => group.type === "text");
  const hasRunningProcess = processGroupsHaveRunningActivity(turnGroups.processGroups);
  const agentPresentation: AgentStatePresentation | undefined =
    !isUser && (message.status === "running" || hasRunningProcess)
      ? {
          state: agentOrbStateFromRun(props.runtimeEvents, turnGroups.processGroups, message.runId),
          label: t("rooms.statusRunning"),
        }
      : undefined;
  const canUseMessageActions = !isSystem && !(message.senderType === "agent" && message.status === "running");
  const authorMention = agentAuthorMention(message, props.members);
  const canMentionAuthor = Boolean(canUseMessageActions && props.onMentionMessageAuthor && authorMention);
  const canReply = Boolean(canUseMessageActions && props.onReplyMessage && authorMention);
  const copyText = collectMessageText(roomMessageToStored(message)).trim() || message.text.trim();
  const canCopy = canUseMessageActions && Boolean(copyText);
  const canDelete = Boolean(canUseMessageActions && props.onDeleteMessage);
  const canExportDiagnostics =
    canUseMessageActions &&
    message.senderType === "agent" &&
    (message.status === "done" || message.status === "failed" || message.status === "interrupted") &&
    Boolean(message.runId);
  const hasMessageActions = canReply || canCopy || canDelete || canExportDiagnostics;
  const isTimeOnlyStatus =
    isUser &&
    message.status !== "running" &&
    message.status !== "failed" &&
    message.status !== "interrupted" &&
    !doneDuration;

  const shouldMeasureMessageActions = hasMessageActions && (actionSurfaceActive || contextMenuOpen || overflowMenuOpen);

  useLayoutEffect(() => {
    if (!shouldMeasureMessageActions) return;
    const content = contentRef.current;
    const toolbar = toolbarRef.current;
    if (!content || !toolbar) return;
    const stream = content.closest<HTMLElement>(".room-chat-stream");
    const updatePlacement = () => {
      if (content.querySelector('.og-disclosure-panel[data-animating="true"]')) return;
      const contentRect = content.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const anchor =
        content.querySelector<HTMLElement>(".room-chat-bubble") ??
        content.querySelector<HTMLElement>(".room-message-attachments") ??
        content.querySelector<HTMLElement>(".room-chat-agent-stack");
      const anchorRect = anchor?.getBoundingClientRect() ?? contentRect;
      const boundaryRight = stream?.getBoundingClientRect().right ?? window.innerWidth;
      const availableRight = boundaryRight - anchorRect.right;
      const nextPlacement: RoomMessageToolbarPlacement =
        availableRight >= toolbarRect.width + MESSAGE_TOOLBAR_GAP ? "right" : "top";
      setToolbarPlacement((current) => (current === nextPlacement ? current : nextPlacement));
      const nextStyle: CSSProperties =
        nextPlacement === "right"
          ? {
              left: anchorRect.right - contentRect.left + MESSAGE_TOOLBAR_GAP,
              top: anchorRect.top - contentRect.top,
            }
          : {
              right: Math.max(0, contentRect.right - anchorRect.right),
              top: anchorRect.top - contentRect.top - 6,
            };
      setToolbarStyle((current) =>
        current?.left === nextStyle.left && current?.right === nextStyle.right && current?.top === nextStyle.top
          ? current
          : nextStyle,
      );
    };
    updatePlacement();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePlacement);
    observer?.observe(content);
    observer?.observe(toolbar);
    if (stream) observer?.observe(stream);
    content.addEventListener(DISCLOSURE_MOTION_SETTLED_EVENT, updatePlacement);
    window.addEventListener("resize", updatePlacement);
    return () => {
      observer?.disconnect();
      content.removeEventListener(DISCLOSURE_MOTION_SETTLED_EVENT, updatePlacement);
      window.removeEventListener("resize", updatePlacement);
    };
  }, [shouldMeasureMessageActions]);

  if (isSystem) {
    return (
      <div className="room-chat-system" data-room-message-id={message.id}>
        {message.text}
      </div>
    );
  }

  const handleMessageContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!hasMessageActions) return;
    if (shouldIgnoreMessageContextMenu(event.target)) {
      (event as MouseEvent<HTMLElement> & { preventBaseUIHandler?(): void }).preventBaseUIHandler?.();
      return;
    }
    event.stopPropagation();
  };

  const exportDiagnostics = async () => {
    if (!canExportDiagnostics || exportingDiagnostics) return;
    const confirmed = await confirm({
      title: t("confirm.exportRunDiagnosticsTitle"),
      body: t("confirm.exportRunDiagnosticsBody"),
      confirmLabel: t("rooms.exportDiagnostics"),
    });
    if (!confirmed || exportingDiagnostics) return;
    setExportingDiagnostics(true);
    toast?.({ kind: "info", title: t("rooms.exportingDiagnostics") });
    try {
      const params = new URLSearchParams({ roomId: props.roomId, messageId: message.id });
      const result = await downloadBridgeFileWithMetadata(
        apiUrl(`/diagnostics/run-bundle?${params.toString()}`),
        `OpenGrove-run-${message.runId ?? "diagnostics"}.zip`,
        { timeoutMs: 120_000 },
      );
      toast?.({
        kind: "success",
        title: t("rooms.exportDiagnosticsSucceeded"),
        description: [
          result.fileName,
          formatDiagnosticBundleSize(result.sizeBytes),
          result.sha256 ? `SHA-256 ${result.sha256}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    } catch (error) {
      toast?.({
        kind: "error",
        title: t("rooms.exportDiagnosticsFailed"),
        description: diagnosticExportErrorMessage(error, t),
      });
    } finally {
      setExportingDiagnostics(false);
    }
  };

  const messageArticle = (
    <article
      className={isUser ? "room-chat-message from-user" : "room-chat-message from-agent"}
      data-context-menu-open={contextMenuOpen ? "true" : undefined}
      data-overflow-menu-open={overflowMenuOpen ? "true" : undefined}
      data-action-surface-active={actionSurfaceActive ? "true" : "false"}
      data-room-message-id={message.id}
      data-status={message.status}
      tabIndex={hasMessageActions ? 0 : undefined}
      onContextMenu={handleMessageContextMenu}
      onPointerEnter={() => setActionSurfaceActive(true)}
      onPointerLeave={() => setActionSurfaceActive(false)}
      onFocusCapture={() => setActionSurfaceActive(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setActionSurfaceActive(false);
        }
      }}
    >
      {!isUser ? (
        member && props.onOpenMemberProfile ? (
          <Tooltip content={t("employee.profileSettingsTitle")} side="right">
            <button
              className="room-chat-avatar-button"
              type="button"
              onClick={() => props.onOpenMemberProfile?.(member)}
              aria-label={t("employee.openSettingsFor", { name: senderDisplayName })}
            >
              <RoomMemberAvatar
                member={member}
                name={senderDisplayName}
                seed={message.senderId}
                className="room-chat-avatar"
                status={member.status}
                color={member.color}
              />
            </button>
          </Tooltip>
        ) : (
          <RoomMemberAvatar
            member={member}
            name={senderDisplayName}
            seed={message.senderId}
            className="room-chat-avatar"
            status={member?.status ?? "idle"}
            color={member?.color ?? "#64748b"}
          />
        )
      ) : null}
      <div ref={contentRef} className="room-chat-content">
        {!isUser ? (
          <div className="room-chat-author">
            {canMentionAuthor ? (
              <motion.button
                className="room-chat-author-name"
                type="button"
                aria-label={t("rooms.mentionNamed", { name: senderDisplayName })}
                initial="rest"
                animate="rest"
                whileHover="active"
                whileFocus="active"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onMentionMessageAuthor?.(message);
                }}
              >
                <motion.span
                  className="room-chat-author-mention-mark"
                  aria-hidden="true"
                  variants={{
                    rest: { width: 0, opacity: 0, x: 4 },
                    active: { width: "1.125em", opacity: 1, x: 0 },
                  }}
                  transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
                >
                  @
                </motion.span>
                <span className="room-chat-author-name-text">{senderDisplayName}</span>
              </motion.button>
            ) : (
              <strong>{senderDisplayName}</strong>
            )}
            <span className="room-chat-time">{formatRoomMessageTime(message.createdAt)}</span>
          </div>
        ) : null}
        {!isUser ? (
          <RoomAgentMessageBody
            answerGroups={turnGroups.answerGroups}
            processGroups={turnGroups.processGroups}
            fallbackText={message.text}
            hasTextPart={hasTextPart}
            status={message.status}
            statusText={agentStatusText}
            duration={doneDuration}
            cancel={
              message.status === "running" && props.onCancelRun
                ? {
                    pending: Boolean(message.runId && props.pendingCancelRunIds?.has(message.runId)),
                    onCancel: () => props.onCancelRun?.(message.id, message.runId),
                  }
                : undefined
            }
            activeChoiceFormKey={props.activeChoiceFormKey}
            pendingQuestionIds={props.pendingQuestionIds}
            onResolveApproval={props.onResolveApproval}
            onResolveQuestion={props.onResolveQuestion}
            onInsertPrompt={props.onInsertPrompt}
            onSubmitPrompt={props.onSubmitPrompt}
            onPreviewImage={props.onPreviewImage}
            onOpenResource={props.onOpenResource}
            resourceContext={resourceContext}
            agentPresentation={agentPresentation}
          />
        ) : (
          <RoomTextBubble text={message.text} isUser={isUser} replyPreview={props.replyPreview} />
        )}
        {message.attachments?.length ? <RoomMessageAttachments attachments={message.attachments} /> : null}
        {isUser && statusText ? (
          <div
            className="room-chat-status"
            data-kind={isTimeOnlyStatus ? "time" : "status"}
            data-status={message.status}
          >
            {statusText}
          </div>
        ) : null}
        {hasMessageActions ? (
          <RoomMessageToolbar
            toolbarRef={toolbarRef}
            placement={toolbarPlacement}
            style={toolbarStyle}
            canReply={canReply}
            canCopy={canCopy}
            canDelete={canDelete}
            canExportDiagnostics={canExportDiagnostics}
            exportingDiagnostics={exportingDiagnostics}
            copyText={copyText}
            onReply={() => props.onReplyMessage?.(message)}
            onDelete={() => props.onDeleteMessage?.(message.id)}
            onExportDiagnostics={() => void exportDiagnostics()}
            onMenuOpenChange={setOverflowMenuOpen}
          />
        ) : null}
      </div>
    </article>
  );

  if (!hasMessageActions) return messageArticle;

  return (
    <MotionContextMenu
      open={contextMenuOpen}
      onOpenChange={setContextMenuOpen}
      trigger={messageArticle}
      className="room-chat-message-context-menu"
      ariaLabel={t("rooms.messageActions")}
      size="compact"
    >
      {canReply ? (
        <MotionMenuItem onClick={() => props.onReplyMessage?.(message)}>
          <ProductIcon name="reply" size={15} />
          <span>{t("rooms.reply")}</span>
        </MotionMenuItem>
      ) : null}
      {canCopy ? (
        <MotionMenuItem onClick={() => void copyTextToClipboard(copyText)}>
          <ProductIcon name="copy" size={15} />
          <span>{t("common.copy")}</span>
        </MotionMenuItem>
      ) : null}
      {canExportDiagnostics ? (
        <MotionMenuItem
          disabled={exportingDiagnostics}
          closeOnClick={!exportingDiagnostics}
          onClick={() => void exportDiagnostics()}
        >
          <ProductIcon name={exportingDiagnostics ? "loading" : "download"} size={15} />
          <span>{exportingDiagnostics ? t("rooms.exportingDiagnostics") : t("rooms.exportDiagnostics")}</span>
        </MotionMenuItem>
      ) : null}
      {canDelete ? (
        <MotionMenuItem danger onClick={() => props.onDeleteMessage?.(message.id)}>
          <ProductIcon name="delete" size={15} />
          <span>{t("common.delete")}</span>
        </MotionMenuItem>
      ) : null}
    </MotionContextMenu>
  );
});

function RoomMessageToolbar(props: {
  toolbarRef: RefObject<HTMLDivElement | null>;
  placement: RoomMessageToolbarPlacement;
  style?: CSSProperties;
  canReply: boolean;
  canCopy: boolean;
  canDelete: boolean;
  canExportDiagnostics: boolean;
  exportingDiagnostics: boolean;
  copyText: string;
  onReply(): void;
  onDelete(): void;
  onExportDiagnostics(): void;
  onMenuOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(props.copyText);
      setCopied(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // non-critical-fallback: Clipboard failure clears the transient copied indicator.
      setCopied(false);
    }
  };

  return (
    <div
      ref={props.toolbarRef}
      className="room-message-toolbar"
      data-placement={props.placement}
      style={props.style}
      role="toolbar"
      aria-label={t("rooms.messageActions")}
    >
      {props.canReply ? (
        <Tooltip content={t("rooms.reply")}>
          <button
            type="button"
            className="room-message-toolbar-button"
            aria-label={t("rooms.reply")}
            onClick={(event) => {
              event.stopPropagation();
              props.onReply();
            }}
          >
            <ProductIcon name="reply" size={15} />
          </button>
        </Tooltip>
      ) : null}
      {props.canCopy ? (
        <Tooltip content={copied ? t("common.copied") : t("common.copy")}>
          <button
            type="button"
            className="room-message-toolbar-button"
            aria-label={copied ? t("common.copied") : t("common.copy")}
            onClick={(event) => {
              event.stopPropagation();
              void handleCopy();
            }}
          >
            <ProductIcon name={copied ? "check" : "copy"} size={15} />
          </button>
        </Tooltip>
      ) : null}
      {props.canDelete || props.canExportDiagnostics ? (
        <MotionMenu
          open={moreMenuOpen}
          onOpenChange={(open) => {
            setMoreMenuOpen(open);
            props.onMenuOpenChange(open);
          }}
          side="bottom"
          align="end"
          ariaLabel={t("rooms.messageActions")}
          size="compact"
          tooltipContent={t("rooms.moreActions")}
          trigger={
            <button
              type="button"
              className="room-message-toolbar-button"
              aria-label={t("rooms.moreActions")}
              onClick={(event) => event.stopPropagation()}
            >
              <ProductIcon name="more" size={15} />
            </button>
          }
        >
          {props.canExportDiagnostics ? (
            <MotionMenuItem
              disabled={props.exportingDiagnostics}
              closeOnClick={!props.exportingDiagnostics}
              onClick={props.onExportDiagnostics}
            >
              <ProductIcon name={props.exportingDiagnostics ? "loading" : "download"} size={15} />
              <span>{props.exportingDiagnostics ? t("rooms.exportingDiagnostics") : t("rooms.exportDiagnostics")}</span>
            </MotionMenuItem>
          ) : null}
          {props.canExportDiagnostics && props.canDelete ? <MotionMenuSeparator /> : null}
          {props.canDelete ? (
            <MotionMenuItem danger onClick={props.onDelete}>
              <ProductIcon name="delete" size={15} />
              <span>{t("common.delete")}</span>
            </MotionMenuItem>
          ) : null}
        </MotionMenu>
      ) : null}
    </div>
  );
}

function shouldIgnoreMessageContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      [
        "[data-resource-reference='true']",
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "summary",
        "[role='button']",
        "[role='menuitem']",
      ].join(","),
    ),
  );
}

function diagnosticExportErrorMessage(error: unknown, t: TranslationFn): string {
  const code = rawDiagnosticText(error instanceof Error ? error.message : String(error)).split(":", 1)[0];
  if (code === "run_diagnostic_bundle_too_large") return t("rooms.exportDiagnosticsTooLarge");
  if (code === "download_timeout") return t("rooms.exportDiagnosticsTimeout");
  if (code === "download_network_error") return t("rooms.exportDiagnosticsNetwork");
  return t("rooms.exportDiagnosticsUnknown");
}

function formatDiagnosticBundleSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function roomDisplayParts(
  message: RoomMessage,
  runtimeEventsForRun: AgentEventRecord[] | undefined,
): MessagePart[] {
  const messageParts = normalizeMessagePartsForDisplay(
    normalizeClientConnectorMessageParts(cloneMessageParts(message.parts)) ?? [],
  ).filter((part) => !isDuplicateFinalErrorNote(message, part));
  const hasActivityParts = roomActivityParts(messageParts).length > 0;
  if (hasActivityParts || !runtimeEventsForRun?.length) {
    return messageParts;
  }

  const activityEvents = runtimeEventsForRun.filter((event) =>
    shouldUseRoomActivityEvent(event, message.status, message.text),
  );
  if (!activityEvents.length) {
    return messageParts;
  }

  const stored = roomMessageToStored({ ...message, text: "", parts: [] });
  activityEvents.forEach((event, eventIndex) => {
    const beforeLength = stored.parts.length;
    applyStreamEventToMessage(stored, event);
    for (let partIndex = beforeLength; partIndex < stored.parts.length; partIndex += 1) {
      const part = stored.parts[partIndex];
      if (part) {
        part.id = stableRoomRuntimePartId(message.id, event, eventIndex, partIndex - beforeLength);
      }
    }
  });
  if (message.status === "done") {
    closeDanglingMessageActivity(stored);
  } else if (message.status === "failed" || message.status === "interrupted") {
    closeDanglingMessageActivity(stored, { status: "failed" });
  }
  return [...normalizeMessagePartsForDisplay(stored.parts), ...messageParts];
}

function stableRoomRuntimePartId(
  messageId: string,
  event: AgentEventRecord,
  eventIndex: number,
  partIndex: number,
): string {
  const eventRecord = event as Record<string, unknown>;
  const eventKey = [eventRecord.type, eventRecord.toolId, eventRecord.name, eventRecord.runId, eventIndex, partIndex]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => String(value).replace(/[^a-zA-Z0-9_-]+/g, "-"))
    .join("-");
  return `${messageId}:runtime-${eventKey || `${eventIndex}-${partIndex}`}`;
}

function isDuplicateFinalErrorNote(message: RoomMessage, part: MessagePart): boolean {
  if (message.status === "running" || part.type !== "note" || part.tone !== "error") {
    return false;
  }
  const noteText = part.text.trim();
  const messageText = message.text.trim();
  return Boolean(
    messageText &&
      (noteText === messageText ||
        noteText === `模型调用出错：${messageText}` ||
        messageText === `模型调用出错：${noteText}`),
  );
}

type RoomPartGroup = AssistantPartGroup;

export function findActiveRoomChoiceFormKey(
  messages: RoomMessage[],
  runtimeEventsByRunId: Map<string, AgentEventRecord[]> = new Map(),
): string | undefined {
  return findActiveRoomChoiceForm(messages, runtimeEventsByRunId)?.groupKey;
}

// 返回当前活跃选择卡片所属的群组 key 及提问员工的 senderId。
// 用于把"点选项/直接打字回复"路由回提问的那个员工，而不是在群聊里因无 @目标而落空。
export function findActiveRoomChoiceForm(
  messages: RoomMessage[],
  runtimeEventsByRunId: Map<string, AgentEventRecord[]> = new Map(),
): { groupKey: string; memberId: string } | undefined {
  const lastUserIndex = messages.reduce(
    (latest, message, index) => (message.senderType === "user" ? index : latest),
    -1,
  );
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index];
    if (!message || message.senderType !== "agent") continue;
    const { processGroups } = splitAssistantPartsForSurface(
      roomDisplayParts(message, message.runId ? runtimeEventsByRunId.get(message.runId) : undefined).filter(
        isRenderableMessagePart,
      ),
      message.id,
    );
    const entries = processGroupsToActivityEntries(processGroups);
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = entries[entryIndex];
      if (entry && choiceFormFromItem(entry.item)) {
        return { groupKey: entry.groupKey, memberId: message.senderId };
      }
    }
  }
  return undefined;
}

function RoomTextBubble(props: {
  text: string;
  isUser: boolean;
  replyPreview?: RoomReplyPreview;
  measureRef?: RefObject<HTMLDivElement | null>;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const { t } = useI18n();
  if (!props.text.trim() && !props.replyPreview) return null;
  return (
    <div className="room-chat-bubble" ref={props.measureRef}>
      {props.isUser && props.replyPreview ? (
        <blockquote
          className="room-chat-reply-quote"
          title={props.replyPreview.text}
          aria-label={
            props.replyPreview.senderName
              ? t("rooms.replyingTo", { name: props.replyPreview.senderName })
              : props.replyPreview.text
          }
        >
          {props.replyPreview.text}
        </blockquote>
      ) : null}
      {props.text.trim() ? (
        <RoomTextContent
          text={props.text}
          isUser={props.isUser}
          onPreviewImage={props.onPreviewImage}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
        />
      ) : null}
    </div>
  );
}

function RoomTextContent(props: {
  text: string;
  isUser: boolean;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  return props.isUser ? (
    <>{props.text}</>
  ) : (
    <ThreadTextBlock
      text={props.text}
      onPreviewImage={props.onPreviewImage}
      onOpenResource={props.onOpenResource}
      resourceContext={props.resourceContext}
    />
  );
}

type RoomRunCancel = { pending: boolean; onCancel(): void };

function RoomRunLeadingControl(props: { presentation?: AgentStatePresentation; cancel?: RoomRunCancel }) {
  const { t } = useI18n();
  const [touchArmed, setTouchArmed] = useState(false);
  const lastPointerTypeRef = useRef("");
  const presentation = props.presentation ?? {
    state: "working",
    label: t("rooms.statusRunning"),
  };
  const indicator = <AgentStateIndicator {...presentation} className="room-run-agent-orb" labelVisible={false} />;
  if (!props.cancel) {
    return <span className="room-run-leading-slot">{indicator}</span>;
  }
  return (
    <Tooltip content={t("rooms.stopRun")} side="right">
      <button
        type="button"
        className={`room-run-leading-slot room-run-leading-control${touchArmed ? " is-touch-armed" : ""}`}
        disabled={props.cancel.pending}
        onPointerDown={(event) => {
          lastPointerTypeRef.current = event.pointerType;
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (lastPointerTypeRef.current === "touch" && !touchArmed) {
            setTouchArmed(true);
            return;
          }
          setTouchArmed(false);
          props.cancel?.onCancel();
        }}
        onBlur={() => setTouchArmed(false)}
        aria-label={t("rooms.stopRun")}
      >
        <span className="room-run-leading-orb" aria-hidden="true">
          {indicator}
        </span>
        <span className="room-run-leading-stop" aria-hidden="true">
          <Square size={13} fill="currentColor" strokeWidth={0} />
        </span>
      </button>
    </Tooltip>
  );
}

function RoomAgentMessageBody(props: {
  answerGroups: RoomPartGroup[];
  processGroups: RoomPartGroup[];
  fallbackText: string;
  hasTextPart: boolean;
  status: MessageStatus;
  statusText?: string;
  duration?: string;
  cancel?: RoomRunCancel;
  activeChoiceFormKey?: string;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): void;
  onInsertPrompt(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
  agentPresentation?: AgentStatePresentation;
}) {
  const { t } = useI18n();
  const shouldRenderFallbackText = props.fallbackText.trim() && !props.hasTextPart;
  const processActivityEntries = processGroupsToActivityEntries(props.processGroups);
  const visibleProcessGroups = props.processGroups.filter((group) =>
    roomPartGroupHasDisplay(group, processActivityEntries),
  );
  const agentStackRef = useRef<HTMLDivElement | null>(null);
  const bubbleMeasureRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const stack = agentStackRef.current;
    const element = bubbleMeasureRef.current;
    if (!stack) return undefined;
    if (!element) {
      stack.style.removeProperty("--room-agent-bubble-width");
      return undefined;
    }

    let frame = 0;
    const updateWidth = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const width = Math.ceil(element.getBoundingClientRect().width);
        if (width > 0) {
          stack.style.setProperty("--room-agent-bubble-width", `${width}px`);
        } else {
          stack.style.removeProperty("--room-agent-bubble-width");
        }
      });
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [props.fallbackText, props.answerGroups, props.hasTextPart, props.status]);

  let measureRefUsed = false;
  const takeMeasureRef = () => {
    if (measureRefUsed) return undefined;
    measureRefUsed = true;
    return bubbleMeasureRef;
  };
  return (
    <div className="room-chat-agent-stack" ref={agentStackRef}>
      {visibleProcessGroups.length ? (
        <RoomRunDetailsBlock
          groups={visibleProcessGroups}
          status={props.status}
          duration={props.duration}
          cancel={props.cancel}
          activeChoiceFormKey={props.activeChoiceFormKey}
          pendingQuestionIds={props.pendingQuestionIds}
          onResolveApproval={props.onResolveApproval}
          onResolveQuestion={props.onResolveQuestion}
          onInsertPrompt={props.onInsertPrompt}
          onSubmitPrompt={props.onSubmitPrompt}
          onPreviewImage={props.onPreviewImage}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
          agentPresentation={props.agentPresentation}
        />
      ) : null}
      {props.answerGroups.map((group) =>
        group.type === "text" ? (
          <RoomTextBubble
            key={group.part.id}
            text={group.part.text}
            isUser={false}
            measureRef={takeMeasureRef()}
            onPreviewImage={props.onPreviewImage}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
          />
        ) : group.type === "note" ? (
          <RoomCommentaryBlock
            key={group.part.id}
            part={group.part}
            bubble
            measureRef={takeMeasureRef()}
            onPreviewImage={props.onPreviewImage}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
          />
        ) : group.type === "question" ? (
          <QuestionInteractionCard
            key={group.key}
            part={group.part}
            pendingQuestionIds={props.pendingQuestionIds}
            onResolveQuestion={props.onResolveQuestion}
          />
        ) : group.type === "approval" ? (
          <ApprovalInteractionCard key={group.key} part={group.part} onResolveApproval={props.onResolveApproval} />
        ) : null,
      )}
      {shouldRenderFallbackText ? (
        <RoomTextBubble
          text={props.fallbackText}
          isUser={false}
          measureRef={takeMeasureRef()}
          onPreviewImage={props.onPreviewImage}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
        />
      ) : null}
      {props.status === "running" && !visibleProcessGroups.length ? (
        <div className="room-chat-thinking-row">
          <RoomRunLeadingControl presentation={props.agentPresentation} cancel={props.cancel} />
          <div
            className={props.agentPresentation ? "room-chat-thinking room-chat-agent-live" : "room-chat-thinking"}
            ref={takeMeasureRef()}
          >
            {props.agentPresentation?.label ?? <TextShimmer>{t("rooms.thinking")}</TextShimmer>}
          </div>
        </div>
      ) : null}
      {props.status !== "running" && props.statusText && !visibleProcessGroups.length ? (
        <div className="room-chat-status-row">
          <div className="room-chat-status" data-status={props.status}>
            {props.status === "done" ? <Check size={12} className="room-chat-status-check" aria-hidden="true" /> : null}
            {props.statusText}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function roomPartGroupHasDisplay(group: RoomPartGroup, activityEntries: ActivityEntry[]): boolean {
  if (group.type === "note") {
    return shouldRenderRoomRunNote(group.part);
  }
  if (group.type === "activity") {
    return roomActivityEntriesForDisplay(group, activityEntries).length > 0;
  }
  return true;
}

function RoomActivityBlock(props: {
  entries: ActivityEntry[];
  activeChoiceFormKey?: string;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): void;
  onInsertPrompt(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  return (
    <div className="room-chat-tools">
      <AssistantProcessBlock
        entries={props.entries}
        activeChoiceFormKey={props.activeChoiceFormKey}
        renderMode="embedded"
        detailMode="full"
        includeReasoningInSummary={false}
        unwrapSingleExploration={true}
        showArtifactCards={false}
        pendingQuestionIds={props.pendingQuestionIds}
        onResolveApproval={props.onResolveApproval}
        onResolveQuestion={props.onResolveQuestion}
        onInsertPrompt={props.onInsertPrompt}
        onSubmitPrompt={props.onSubmitPrompt}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
      />
    </div>
  );
}

function RoomCommentaryBlock(props: {
  part: NotePart;
  bubble?: boolean;
  measureRef?: RefObject<HTMLDivElement | null>;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  return (
    <div
      className={props.bubble ? "room-chat-bubble room-run-commentary" : "room-run-commentary"}
      ref={props.measureRef}
    >
      <ThreadTextBlock
        text={props.part.text}
        onPreviewImage={props.onPreviewImage}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
      />
    </div>
  );
}

function RoomRunDetailsBlock(props: {
  groups: RoomPartGroup[];
  status: MessageStatus;
  duration?: string;
  live?: boolean;
  cancel?: RoomRunCancel;
  activeChoiceFormKey?: string;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): void;
  onInsertPrompt(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
  agentPresentation?: AgentStatePresentation;
}) {
  const { t } = useI18n();
  const activityEntries = processGroupsToActivityEntries(props.groups);
  const items = activityEntries.map((entry) => entry.item);
  const hasPendingApproval = items.some(
    (item) => item.type === "approval" && item.part.approvalStatus === "pending" && item.part.approvalId,
  );
  const hasPendingQuestion = items.some(
    (item) => item.type === "question" && item.part.questionStatus === "pending" && item.part.questionId,
  );
  const hasActiveChoiceForm = activityEntries.some(
    ({ groupKey, item }) => groupKey === props.activeChoiceFormKey && Boolean(choiceFormFromItem(item)),
  );
  const hasRunningActivity = processGroupsHaveRunningActivity(props.groups);
  const live = props.live ?? (props.status === "running" || hasRunningActivity);
  const shouldOpenByDefault = hasPendingQuestion || hasPendingApproval || hasActiveChoiceForm;
  const summaryText = live
    ? t("rooms.statusRunning")
    : items.length && props.status !== "failed" && props.status !== "interrupted"
      ? [
          summarizeActivityItems(items, {
            pendingQuestion: hasPendingQuestion,
            pendingApproval: hasPendingApproval,
            activeChoiceForm: hasActiveChoiceForm,
            includeReasoning: false,
          }),
          props.duration,
        ]
          .filter(Boolean)
          .join(" · ")
      : roomRunSummaryText(props.status, props.duration, live, t);
  return (
    <Disclosure
      variant="room-run"
      active={live}
      defaultOpen={shouldOpenByDefault}
      leading={live ? <RoomRunLeadingControl presentation={props.agentPresentation} cancel={props.cancel} /> : null}
      summary={
        <TextTransition identity={summaryText}>
          {live ? <TextShimmer>{summaryText}</TextShimmer> : renderActivitySummary(summaryText)}
        </TextTransition>
      }
    >
      {props.groups.map((group, index) => renderRoomRunGroup(group, props, index, activityEntries))}
    </Disclosure>
  );
}

function renderRoomRunGroup(
  group: RoomPartGroup,
  props: Pick<
    Parameters<typeof RoomRunDetailsBlock>[0],
    | "activeChoiceFormKey"
    | "pendingQuestionIds"
    | "onResolveApproval"
    | "onResolveQuestion"
    | "onInsertPrompt"
    | "onSubmitPrompt"
    | "onPreviewImage"
    | "onOpenResource"
    | "resourceContext"
  >,
  index: number,
  activityEntries: ActivityEntry[],
) {
  const staggerStyle = { "--i": index } as CSSProperties;
  if (group.type === "activity") {
    const entries = roomActivityEntriesForDisplay(group, activityEntries);
    if (!entries.length) return null;
    return (
      <div className="room-run-group room-run-group--activity" key={group.key} style={staggerStyle}>
        <RoomActivityBlock
          entries={entries}
          activeChoiceFormKey={props.activeChoiceFormKey}
          pendingQuestionIds={props.pendingQuestionIds}
          onResolveApproval={props.onResolveApproval}
          onResolveQuestion={props.onResolveQuestion}
          onInsertPrompt={props.onInsertPrompt}
          onSubmitPrompt={props.onSubmitPrompt}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
        />
      </div>
    );
  }
  if (group.type === "note") {
    if (!shouldRenderRoomRunNote(group.part)) return null;
    if (isCompactionNoteTone(group.part.tone)) {
      const active = group.part.tone === "compaction-started";
      return (
        <div
          key={group.part.id}
          className={`room-run-group thread-compaction-divider${active ? " is-active" : ""}`}
          style={staggerStyle}
        >
          {active ? <TextShimmer>{group.part.text}</TextShimmer> : <span>{group.part.text}</span>}
        </div>
      );
    }
    return (
      <div className="room-run-group" key={group.part.id} style={staggerStyle}>
        <RoomRunNoteRow
          part={group.part}
          onPreviewImage={props.onPreviewImage}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
        />
      </div>
    );
  }
  return null;
}

function roomActivityEntriesForDisplay(
  group: Extract<RoomPartGroup, { type: "activity" }>,
  activityEntries: ActivityEntry[],
): ActivityEntry[] {
  return activityEntries.filter(({ groupKey }) => groupKey === group.key);
}

function shouldRenderRoomRunNote(part: NotePart): boolean {
  return Boolean(roomRunNoteDisplayText(part));
}

function RoomRunNoteRow(props: {
  part: NotePart;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const { t } = useI18n();
  const displayText = roomRunNoteDisplayText(props.part);
  if (!displayText) {
    return null;
  }
  if (isNativeAgentCommentaryNote(props.part)) {
    return (
      <RoomCommentaryBlock
        part={displayText === props.part.text ? props.part : { ...props.part, text: displayText }}
        onPreviewImage={props.onPreviewImage}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
      />
    );
  }
  return (
    <div className={`room-run-detail-row tone-${props.part.tone || "muted"}`}>
      <span>{roomNoteToneLabel(props.part, t)}</span>
      <strong>{displayText}</strong>
    </div>
  );
}

function roomRunNoteDisplayText(part: NotePart): string {
  const text = part.text.trim();
  if (/^claude\.sdk\.hook_(?:started|progress|response)$/i.test(text)) {
    return "";
  }
  return text;
}

function isCompactionNoteTone(tone: string | undefined): boolean {
  return tone === "compaction-started" || tone === "compaction-finished";
}

function roomNoteToneLabel(part: NotePart, t: TranslationFn): string {
  const tone = part.tone;
  if (tone === "diagnostic" && isConnectorProcessNote(part.text)) return t("rooms.noteToneProcess");
  if (tone === "guidance") return t("composer.guide");
  if (tone === "status") return t("commands.statusTitle");
  if (tone === "diagnostic") return t("rooms.noteToneDiagnostic");
  if (tone === "error") return t("rooms.noteToneError");
  if (tone === "warn") return t("rooms.noteToneWarn");
  if (tone === "success") return t("ops.result");
  return t("rooms.noteToneLog");
}

function roomRunSummaryText(
  status: MessageStatus,
  duration: string | undefined,
  live: boolean,
  t: TranslationFn,
): string {
  if (live || status === "running") return t("chat.processing");
  const label =
    status === "failed"
      ? t("rooms.runFailed")
      : status === "interrupted"
        ? t("contacts.runStatusInterrupted")
        : t("rooms.runProcessed");
  return `${label}${duration ? ` ${duration}` : ""}`;
}

function RoomMessageAttachments(props: { attachments: AttachmentPayload[] }) {
  return (
    <div className="room-message-attachments">
      {props.attachments.map((attachment) => {
        const Icon = attachmentIcon(attachment);
        if (attachment.kind === "image") {
          const previewUrl = attachmentImagePreviewUrl(attachment);
          return (
            <Tooltip key={attachment.id || attachment.name} content={attachment.name}>
              <div className="room-message-attachment image">
                {previewUrl ? <img src={previewUrl} alt="" /> : <ImageIcon size={18} />}
              </div>
            </Tooltip>
          );
        }
        return (
          <Tooltip key={attachment.id || attachment.name} content={attachment.name}>
            <div className="room-message-attachment">
              <Icon size={14} />
              <span>{attachment.name}</span>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}
