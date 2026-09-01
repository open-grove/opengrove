import { memo, useEffect, useState, type CSSProperties } from "react";
import clsx from "clsx";
import { Bot, Check, Image as ImageIcon, ShieldAlert, X, UserRound } from "lucide-react";
import type { AgentEventRecord, NotePart, RunRecord, SkillRecord, StoredMessage } from "../../bridge";
import { summarize } from "../../format";
import { useI18n, type TranslationFn } from "../../i18n";
import { hasRenderableMessageParts, isRenderableMessagePart, normalizeMessagePartsForDisplay } from "../../messages";
import { isSuppressedSystemNoise } from "../../runtime/app-shell-state";
import { attachmentImagePreviewUrl } from "../../runtime/ui-model";
import {
  isConnectorProcessNote,
  isNativeAgentCommentaryNote,
  processGroupsToActivityEntries,
  splitAssistantPartsForSurface,
  summarizeProcessGroups,
  type AssistantPartGroup,
} from "./assistant-run-view-model";
import {
  ApprovalInteractionCard,
  AssistantProcessBlock,
  QuestionInteractionCard,
  activityItemStatus,
  choiceFormFromItem,
  renderActivitySummary,
} from "./message-activity";
import { Disclosure } from "./disclosure";
import { ThreadTextBlock } from "./message-markdown";
import type { ChatImagePayload } from "./message-types";
import { ChatResourcePreviewPanel } from "./chat-resource-preview-panel";
import { useChatResourceActions } from "./use-chat-resource-actions";
import { useLatestCallback } from "./use-latest-callback";
import type { ChatResourceAction, ChatResourceContext, ChatResourceRef } from "./resource-model";
import { AgentStateIndicator } from "../ui/agent-state-indicator";
import { TextShimmer } from "../ui/motion/text-shimmer";
import { TextTransition } from "../ui/motion/text-transition";
import { agentOrbStateFromRun } from "./agent-state-presentation";

export function MessageList(props: {
  messages: StoredMessage[];
  workspaceRoot?: string;
  skills?: SkillRecord[];
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject" | "cancel", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline" | "cancel", response?: unknown): void;
  onInsertPrompt?(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onTrySkill?(skillName: string): void;
  onEditSkill?(skillName: string): void;
  onSaveImageArtifact?(image: ChatImagePayload): void;
}) {
  const { t } = useI18n();
  const [previewImage, setPreviewImage] = useState<ChatImagePayload | null>(null);
  const resourceActions = useChatResourceActions();
  const resourceContext: ChatResourceContext | undefined = props.workspaceRoot
    ? { origin: "workspace", workspaceRoot: props.workspaceRoot }
    : undefined;
  // 父层回调每次 render 都会重建；包成稳定引用，保证 memo 化的 ThreadMessage 生效。
  const onResolveApproval = useLatestCallback(props.onResolveApproval);
  const onResolveQuestion = useLatestCallback(props.onResolveQuestion);
  const onInsertPrompt = useLatestCallback(props.onInsertPrompt);
  const onSubmitPrompt = useLatestCallback(props.onSubmitPrompt);
  const onTrySkill = useLatestCallback(props.onTrySkill);
  const onEditSkill = useLatestCallback(props.onEditSkill);
  const onSaveImageArtifact = useLatestCallback(props.onSaveImageArtifact);
  const visibleMessages = props.messages.filter((message) => !isSuppressedSystemNoise(message));
  const activeChoiceFormKey = findActiveChoiceFormKey(visibleMessages);

  useEffect(() => {
    if (previewImage) {
      blurActiveElement();
    }
  }, [previewImage]);

  return (
    <>
      <div className="thread-stack">
        {visibleMessages.map((message, index) => (
          <ThreadMessage
            key={message.id}
            message={message}
            skills={props.skills}
            runtimeEvents={props.runtimeEvents}
            runs={props.runs}
            pendingQuestionIds={props.pendingQuestionIds}
            precedingUserText={previousUserMessageText(visibleMessages, index)}
            activeChoiceFormKey={activeChoiceFormKey}
            onResolveApproval={onResolveApproval}
            onResolveQuestion={onResolveQuestion}
            onInsertPrompt={onInsertPrompt}
            onSubmitPrompt={onSubmitPrompt}
            onTrySkill={onTrySkill}
            onEditSkill={onEditSkill}
            onPreviewImage={setPreviewImage}
            onSaveImageArtifact={onSaveImageArtifact}
            onOpenResource={resourceActions.openResource}
            resourceContext={resourceContext}
          />
        ))}
      </div>
      {previewImage ? (
        <div
          className="thread-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={previewImage.alt || t("chat.imagePreview")}
          onClick={() => setPreviewImage(null)}
        >
          <div className="thread-image-lightbox-panel" onClick={(event) => event.stopPropagation()}>
            <div className="thread-image-lightbox-header">
              <div>{previewImage.alt || t("chat.imagePreview")}</div>
              <button
                type="button"
                className="thread-image-icon-button"
                onClick={() => setPreviewImage(null)}
                aria-label={t("chat.closePreview")}
              >
                <X size={16} />
              </button>
            </div>
            <img src={previewImage.src} alt={previewImage.alt || t("chat.imagePreview")} />
          </div>
        </div>
      ) : null}
      {resourceActions.preview ? (
        <ChatResourcePreviewPanel preview={resourceActions.preview} onClose={resourceActions.closePreview} />
      ) : null}
    </>
  );
}

function blurActiveElement(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }
}

const ThreadMessage = memo(function ThreadMessage(props: {
  message: StoredMessage;
  skills?: SkillRecord[];
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
  precedingUserText?: string;
  activeChoiceFormKey?: string;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject" | "cancel", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline" | "cancel", response?: unknown): void;
  onInsertPrompt?(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onTrySkill?(skillName: string): void;
  onEditSkill?(skillName: string): void;
  onPreviewImage?(image: ChatImagePayload): void;
  onSaveImageArtifact?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const { message } = props;
  const { t } = useI18n();
  const hasParts = hasRenderableMessageParts(message);
  const messagePending = isMessageEffectivelyPending(message, props.runtimeEvents, props.runs, props.precedingUserText);
  const roleMeta = messageRoleMeta(message.role, messagePending);

  return (
    <article className={clsx("thread-message", `role-${message.role}`)} data-role={message.role}>
      <header className="thread-message-header">
        <div className={clsx("thread-message-avatar", `role-${message.role}`)} aria-hidden="true">
          {roleMeta.icon}
        </div>
        <div className="thread-message-meta">
          <div className="thread-message-role-row">
            <span className="thread-message-role">{roleMeta.title}</span>
            {messagePending ? (
              <span className="thread-inline-status">
                <AgentStateIndicator
                  state={agentOrbStateFromRun(props.runtimeEvents, [], message.runId)}
                  label={t("chat.processing")}
                  labelVisible={false}
                />
                {t("chat.processing")}
              </span>
            ) : null}
          </div>
          <div className="thread-message-subtitle">{roleMeta.subtitle}</div>
        </div>
      </header>

      <div className="thread-message-content">
        {message.role === "user" ? (
          <UserMessageBody message={message} />
        ) : message.role === "assistant" && hasParts ? (
          <AssistantMessageBody
            message={message}
            skills={props.skills}
            runtimeEvents={props.runtimeEvents}
            runs={props.runs}
            precedingUserText={props.precedingUserText}
            activeChoiceFormKey={props.activeChoiceFormKey}
            pendingQuestionIds={props.pendingQuestionIds}
            onResolveApproval={props.onResolveApproval}
            onResolveQuestion={props.onResolveQuestion}
            onInsertPrompt={props.onInsertPrompt}
            onSubmitPrompt={props.onSubmitPrompt}
            onTrySkill={props.onTrySkill}
            onEditSkill={props.onEditSkill}
            onPreviewImage={props.onPreviewImage}
            onSaveImageArtifact={props.onSaveImageArtifact}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
          />
        ) : message.role === "assistant" && messagePending ? (
          <AssistantPendingBody
            message={message}
            runtimeEvents={props.runtimeEvents}
            runs={props.runs}
            precedingUserText={props.precedingUserText}
          />
        ) : message.role === "assistant" ? (
          <AssistantPlainBody
            message={message}
            skills={props.skills}
            runtimeEvents={props.runtimeEvents}
            runs={props.runs}
            precedingUserText={props.precedingUserText}
            onTrySkill={props.onTrySkill}
            onEditSkill={props.onEditSkill}
            onPreviewImage={props.onPreviewImage}
            onSaveImageArtifact={props.onSaveImageArtifact}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
          />
        ) : (
          <ThreadTextBlock
            text={message.text}
            skills={props.skills}
            onTrySkill={props.onTrySkill}
            onEditSkill={props.onEditSkill}
            onPreviewImage={props.onPreviewImage}
            onSaveImageArtifact={props.onSaveImageArtifact}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
          />
        )}
      </div>
    </article>
  );
});

function UserMessageBody(props: { message: StoredMessage }) {
  const { t } = useI18n();
  const attachments = props.message.context?.attachments ?? [];
  const artifacts = props.message.context?.artifacts ?? [];
  const selectedText = props.message.context?.selectedText?.trim() ?? "";
  const displayText = visibleUserMessageText(props.message.text);
  return (
    <div className="thread-user-stack">
      <div className="thread-user-bubble">{displayText}</div>
      {selectedText ? (
        <div className="thread-context-chip">
          {t("chat.selectedTextChip", { summary: summarize(selectedText, 180) })}
        </div>
      ) : null}
      {artifacts.length ? (
        <div className="thread-context-files">
          {artifacts.map((artifact) => (
            <span className="thread-context-file" key={artifact.id || artifact.title}>
              {t("chat.artifactChip", { title: artifact.title || artifact.id })}
            </span>
          ))}
        </div>
      ) : null}
      {attachments.length ? (
        <div className="thread-context-files">
          {attachments.map((attachment) => {
            if (attachment.kind === "image") {
              const previewUrl = attachmentImagePreviewUrl(attachment);
              return (
                <span
                  className="thread-context-file thread-context-file-image"
                  key={attachment.id || attachment.name}
                  title={attachment.name}
                >
                  {previewUrl ? (
                    <img className="thread-context-file-thumb" src={previewUrl} alt="" />
                  ) : (
                    <span className="thread-context-file-image-fallback" aria-hidden="true">
                      <ImageIcon size={18} />
                    </span>
                  )}
                </span>
              );
            }
            return (
              <span className="thread-context-file" key={attachment.id || attachment.name}>
                {attachment.kind === "text" ? t("chat.attachmentTextLabel") : t("chat.attachmentFileLabel")} ·{" "}
                {attachment.name}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const CHOICE_CONTINUATION_MARKER = "请基于这些选择继续完成原始任务。";
const THINKING_IDLE_DELAY_MS = 1200;

function visibleUserMessageText(text: string): string {
  if (!text.includes(CHOICE_CONTINUATION_MARKER)) {
    return text;
  }
  const answerLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s*.+?[：:]\s*.+/.test(line))
    .map((line) => line.replace(/^\d+\.\s*.+?[：:]\s*/, "").trim())
    .filter(Boolean);
  return answerLines.length ? answerLines.join("；") : text;
}

function previousUserMessageText(messages: StoredMessage[], messageIndex: number): string {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.text || "";
    }
  }
  return "";
}

function messageDurationSeconds(
  message: StoredMessage,
  runtimeEvents: AgentEventRecord[] = [],
  runs: RunRecord[] = [],
  inputHint = "",
  nowMs = Date.now(),
): number {
  const timing = messageTiming(message, runtimeEvents, runs, inputHint);
  const startedAt = Date.parse(timing.startedAt || "");
  const finishedAt = timing.finishedAt ? Date.parse(timing.finishedAt) : message.pending ? nowMs : Number.NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    return Number.NaN;
  }
  return Math.max(0, Math.round((finishedAt - startedAt) / 1000));
}

function formatDurationSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) {
    return "";
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function messageTiming(
  message: StoredMessage,
  runtimeEvents: AgentEventRecord[] = [],
  runs: RunRecord[] = [],
  inputHint = "",
): { startedAt?: string; finishedAt?: string } {
  const runId = message.runId || runIdFromInput(inputHint, runs);
  const eventTiming = timingFromEvents(runId, runtimeEvents);
  const runTiming = timingFromRuns(runId, runs);
  return {
    startedAt: message.startedAt || eventTiming.startedAt || runTiming.startedAt,
    finishedAt: message.finishedAt || eventTiming.finishedAt || runTiming.finishedAt,
  };
}

function timingFromEvents(
  runId: string,
  runtimeEvents: AgentEventRecord[],
): { startedAt?: string; finishedAt?: string } {
  if (!runId || !Array.isArray(runtimeEvents)) {
    return {};
  }
  const runEvents = runtimeEvents.filter((event) => event?.runId === runId);
  const started = runEvents.find((event) => event?.type === "turn.started" && typeof event.at === "string");
  const finished = [...runEvents]
    .reverse()
    .find((event) => event?.type === "turn.finished" && typeof event.at === "string");
  return {
    startedAt: started?.at,
    finishedAt: finished?.at,
  };
}

function timingFromRuns(runId: string, runs: RunRecord[]): { startedAt?: string; finishedAt?: string } {
  if (!runId || !Array.isArray(runs)) {
    return {};
  }
  const run = runs.find((item) => item?.id === runId || item?.runId === runId);
  return {
    startedAt: typeof run?.startedAt === "string" ? run.startedAt : undefined,
    finishedAt:
      typeof run?.endedAt === "string" ? run.endedAt : typeof run?.finishedAt === "string" ? run.finishedAt : undefined,
  };
}

function runIdFromInput(inputHint: string, runs: RunRecord[]): string {
  const normalizedHint = normalizePromptForTiming(inputHint);
  if (!normalizedHint || !Array.isArray(runs)) {
    return "";
  }
  const candidates = runs
    .filter((run) => normalizePromptForTiming(run?.input) === normalizedHint)
    .sort((left, right) =>
      String(right?.startedAt || right?.createdAt || "").localeCompare(
        String(left?.startedAt || left?.createdAt || ""),
      ),
    );
  return candidates[0]?.id || candidates[0]?.runId || "";
}

function normalizePromptForTiming(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function isMessageEffectivelyPending(
  message: StoredMessage,
  runtimeEvents: AgentEventRecord[] = [],
  runs: RunRecord[] = [],
  inputHint = "",
): boolean {
  if (!message.pending || hasTerminalMessageNote(message)) {
    return false;
  }
  return !messageTiming(message, runtimeEvents, runs, inputHint).finishedAt;
}

function hasTerminalMessageNote(message: StoredMessage): boolean {
  return (message.parts || []).some((part) => part.type === "note" && part.tone === "error" && Boolean(part.text));
}

function AssistantMessageBody(props: {
  message: StoredMessage;
  skills?: SkillRecord[];
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
  precedingUserText?: string;
  activeChoiceFormKey?: string;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject" | "cancel", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline" | "cancel", response?: unknown): void;
  onInsertPrompt?(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onTrySkill?(skillName: string): void;
  onEditSkill?(skillName: string): void;
  onPreviewImage?(image: ChatImagePayload): void;
  onSaveImageArtifact?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const parts = normalizeMessagePartsForDisplay(props.message.parts).filter(isRenderableMessagePart);
  const turnGroups = splitAssistantPartsForSurface(parts, props.message.id);
  const groups = [...turnGroups.processGroups, ...turnGroups.answerGroups];

  return (
    <div className="thread-part-stack">
      <AssistantProcessTimeline
        message={props.message}
        groups={turnGroups.processGroups}
        current
        showDuration
        runtimeEvents={props.runtimeEvents}
        runs={props.runs}
        inputHint={props.precedingUserText}
        activeChoiceFormKey={props.activeChoiceFormKey}
        pendingQuestionIds={props.pendingQuestionIds}
        onResolveApproval={props.onResolveApproval}
        onResolveQuestion={props.onResolveQuestion}
        onInsertPrompt={props.onInsertPrompt}
        onSubmitPrompt={props.onSubmitPrompt}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
      />
      {turnGroups.processGroups.length === 0 ? (
        <AssistantTurnStatus
          message={props.message}
          groups={turnGroups.processGroups}
          runtimeEvents={props.runtimeEvents}
          runs={props.runs}
          inputHint={props.precedingUserText}
        />
      ) : null}
      {turnGroups.answerGroups.map((group) => {
        if (group.type === "text") {
          return (
            <ThreadTextBlock
              key={group.part.id}
              text={recoverFinalTextForMessage(
                props.message,
                group.part.text,
                props.runtimeEvents,
                props.runs,
                props.precedingUserText,
              )}
              skills={props.skills}
              onTrySkill={props.onTrySkill}
              onEditSkill={props.onEditSkill}
              onPreviewImage={props.onPreviewImage}
              onSaveImageArtifact={props.onSaveImageArtifact}
              onOpenResource={props.onOpenResource}
              resourceContext={props.resourceContext}
            />
          );
        }
        if (group.type === "question") {
          return (
            <QuestionInteractionCard
              key={group.key}
              part={group.part}
              pendingQuestionIds={props.pendingQuestionIds}
              onResolveQuestion={props.onResolveQuestion}
            />
          );
        }
        if (group.type === "approval") {
          return (
            <ApprovalInteractionCard key={group.key} part={group.part} onResolveApproval={props.onResolveApproval} />
          );
        }
        if (group.type === "note") {
          if (isCompactionNoteTone(group.part.tone)) {
            return <CompactionDivider key={group.part.id} text={group.part.text} tone={group.part.tone} />;
          }
          if (group.part.tone === "status") {
            return (
              <ThreadTextBlock
                key={group.part.id}
                text={group.part.text}
                skills={props.skills}
                onTrySkill={props.onTrySkill}
                onEditSkill={props.onEditSkill}
                onPreviewImage={props.onPreviewImage}
                onSaveImageArtifact={props.onSaveImageArtifact}
                onOpenResource={props.onOpenResource}
                resourceContext={props.resourceContext}
              />
            );
          }
          return (
            <div key={group.part.id} className={clsx("thread-note-block", `tone-${group.part.tone || "muted"}`)}>
              {group.part.text}
            </div>
          );
        }
        return null;
      })}
      <AssistantTailThinking
        message={props.message}
        groups={groups}
        runtimeEvents={props.runtimeEvents}
        runs={props.runs}
        inputHint={props.precedingUserText}
      />
    </div>
  );
}

function AssistantProcessTimeline(props: {
  message: StoredMessage;
  groups: AssistantPartGroup[];
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
  inputHint?: string;
  current?: boolean;
  showDuration?: boolean;
  activeChoiceFormKey?: string;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject" | "cancel", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline" | "cancel", response?: unknown): void;
  onInsertPrompt?(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
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
  const hasRunningItem = items.some((item) => activityItemStatus(item) === "running");
  const isActive =
    hasRunningItem ||
    Boolean(
      props.current && isMessageEffectivelyPending(props.message, props.runtimeEvents, props.runs, props.inputHint),
    );
  const shouldOpenByDefault = hasPendingQuestion || hasPendingApproval || hasActiveChoiceForm;

  if (!props.groups.length) {
    return null;
  }

  const summary = summarizeProcessGroups(
    props.groups,
    {
      active: isActive,
      pendingQuestion: hasPendingQuestion,
      pendingApproval: hasPendingApproval,
      activeChoiceForm: hasActiveChoiceForm,
    },
    t,
  );
  const runDuration =
    isActive || !props.showDuration
      ? ""
      : formatDurationSeconds(messageDurationSeconds(props.message, props.runtimeEvents, props.runs, props.inputHint));
  const summaryWithDuration = [summary, runDuration].filter(Boolean).join(" · ");
  const agentActivity = {
    state: agentOrbStateFromRun(props.runtimeEvents, props.groups, props.message.runId),
    label: summaryWithDuration || t("chat.processing"),
  };

  return (
    <Disclosure
      variant="process"
      active={isActive}
      defaultOpen={shouldOpenByDefault}
      summary={
        <>
          {isActive ? <AgentStateIndicator {...agentActivity} labelVisible={false} /> : null}
          <TextTransition identity={summaryWithDuration}>
            {isActive ? <TextShimmer>{summaryWithDuration}</TextShimmer> : renderActivitySummary(summaryWithDuration)}
          </TextTransition>
        </>
      }
    >
      {props.groups.map((group, index) => {
        if (group.type === "activity") {
          const entries = activityEntries.filter((entry) => entry.groupKey === group.key);
          return entries.length ? (
            <div key={group.key} style={{ "--i": index } as CSSProperties}>
              <AssistantProcessBlock
                entries={entries}
                activeChoiceFormKey={props.activeChoiceFormKey}
                renderMode="embedded"
                detailMode="full"
                includeReasoningInSummary={false}
                unwrapSingleExploration
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
          ) : null;
        }
        if (group.type === "note") {
          return (
            <AssistantRunNoteRow
              key={group.part.id}
              part={group.part}
              index={index}
              onOpenResource={props.onOpenResource}
              resourceContext={props.resourceContext}
            />
          );
        }
        return null;
      })}
    </Disclosure>
  );
}

function AssistantRunNoteRow(props: {
  part: NotePart;
  index?: number;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const { t } = useI18n();
  const staggerStyle = props.index === undefined ? undefined : ({ "--i": props.index } as CSSProperties);
  if (isCompactionNoteTone(props.part.tone)) {
    return (
      <div style={staggerStyle}>
        <CompactionDivider text={props.part.text} tone={props.part.tone} />
      </div>
    );
  }
  if (isNativeAgentCommentaryNote(props.part)) {
    return (
      <div style={staggerStyle}>
        <AssistantCommentaryBlock
          part={props.part}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
        />
      </div>
    );
  }
  return (
    <div className={clsx("thread-run-note-row", `tone-${props.part.tone || "muted"}`)} style={staggerStyle}>
      <span>{processNoteToneLabel(props.part, t)}</span>
      <strong>{props.part.text}</strong>
    </div>
  );
}

function AssistantCommentaryBlock(props: {
  part: NotePart;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  return (
    <div className="thread-run-commentary">
      <ThreadTextBlock
        text={props.part.text}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
      />
    </div>
  );
}

function processNoteToneLabel(part: NotePart, t: TranslationFn): string {
  if (part.tone === "diagnostic" && isConnectorProcessNote(part.text)) return t("chat.noteToneProcess");
  if (part.tone === "guidance") return t("composer.guide");
  if (part.tone === "status") return t("chat.noteToneStatus");
  if (part.tone === "diagnostic") return t("chat.noteToneDiagnostic");
  if (part.tone === "error") return t("chat.noteToneError");
  if (part.tone === "warn") return t("chat.noteToneWarn");
  return t("chat.noteToneRecord");
}

function isCompactionNoteTone(tone: string | undefined): boolean {
  return tone === "compaction-started" || tone === "compaction-finished";
}

function CompactionDivider(props: { text: string; tone?: string }) {
  const active = props.tone === "compaction-started";
  return (
    <div className={clsx("thread-compaction-divider", active && "is-active")}>
      {active ? <TextShimmer>{props.text}</TextShimmer> : <span>{props.text}</span>}
    </div>
  );
}

function AssistantPendingBody(props: {
  message: StoredMessage;
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
  precedingUserText?: string;
}) {
  return (
    <div className="thread-part-stack">
      <AssistantTurnStatus
        message={props.message}
        groups={[]}
        runtimeEvents={props.runtimeEvents}
        runs={props.runs}
        inputHint={props.precedingUserText}
      />
      <AssistantTailThinking
        message={props.message}
        groups={[]}
        runtimeEvents={props.runtimeEvents}
        runs={props.runs}
        inputHint={props.precedingUserText}
      />
    </div>
  );
}

function AssistantPlainBody(props: {
  message: StoredMessage;
  skills?: SkillRecord[];
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
  precedingUserText?: string;
  onTrySkill?(skillName: string): void;
  onEditSkill?(skillName: string): void;
  onPreviewImage?(image: ChatImagePayload): void;
  onSaveImageArtifact?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  return (
    <div className="thread-part-stack">
      <AssistantTurnStatus
        message={props.message}
        groups={[]}
        runtimeEvents={props.runtimeEvents}
        runs={props.runs}
        inputHint={props.precedingUserText}
      />
      <ThreadTextBlock
        text={props.message.text}
        skills={props.skills}
        onTrySkill={props.onTrySkill}
        onEditSkill={props.onEditSkill}
        onPreviewImage={props.onPreviewImage}
        onSaveImageArtifact={props.onSaveImageArtifact}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
      />
    </div>
  );
}

function AssistantTurnStatus(props: {
  message: StoredMessage;
  groups: AssistantPartGroup[];
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
  inputHint?: string;
}) {
  const { t } = useI18n();
  const items = processGroupsToActivityEntries(props.groups).map(({ item }) => item);
  const hasPendingApproval = items.some(
    (item) =>
      (item.type === "approval" && item.part.approvalStatus === "pending" && item.part.approvalId) ||
      (item.type === "question" && item.part.questionStatus === "pending" && item.part.questionId),
  );
  const hasRunningItem = items.some((item) => activityItemStatus(item) === "running");
  const messagePending = isMessageEffectivelyPending(props.message, props.runtimeEvents, props.runs, props.inputHint);
  const isActive = messagePending || hasRunningItem;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!isActive) {
      return undefined;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  const durationSeconds = messageDurationSeconds(
    props.message,
    props.runtimeEvents,
    props.runs,
    props.inputHint,
    nowMs,
  );
  const shouldShow = hasPendingApproval || isActive || props.groups.length > 0 || Number.isFinite(durationSeconds);
  if (!shouldShow) {
    return null;
  }
  const statusLabel = hasPendingApproval
    ? t("chat.awaitingConfirmation")
    : isActive
      ? t("chat.processing")
      : t("chat.processed");
  const agentActivity = {
    state: agentOrbStateFromRun(props.runtimeEvents, props.groups, props.message.runId),
    label: statusLabel,
  };
  const duration = formatDurationSeconds(durationSeconds);
  const showDoneCheck = !isActive && !hasPendingApproval && !hasTerminalMessageNote(props.message);
  const statusText = [statusLabel, duration].filter(Boolean).join(" ");

  return (
    <div className="thread-turn-status" data-active={isActive ? "true" : "false"}>
      <span className="thread-turn-status-label">
        {isActive ? <AgentStateIndicator {...agentActivity} labelVisible={false} /> : null}
        {!isActive && showDoneCheck ? (
          <Check size={14} className="thread-turn-status-check" aria-hidden="true" />
        ) : null}
        {isActive ? <TextShimmer>{statusText}</TextShimmer> : <span>{statusText}</span>}
      </span>
      <div className="thread-turn-status-line" aria-hidden="true" />
    </div>
  );
}

function AssistantTailThinking(props: {
  message: StoredMessage;
  groups: AssistantPartGroup[];
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
  inputHint?: string;
}) {
  const { t } = useI18n();
  const messagePending = isMessageEffectivelyPending(props.message, props.runtimeEvents, props.runs, props.inputHint);
  const hasRecentTextOutput = useHasRecentAssistantTextOutput(props.message, props.groups, messagePending);
  const items = processGroupsToActivityEntries(props.groups).map(({ item }) => item);
  const hasRunningItem = items.some((item) => activityItemStatus(item) === "running");
  const hasPendingApproval = items.some(
    (item) =>
      (item.type === "approval" && item.part.approvalStatus === "pending" && item.part.approvalId) ||
      (item.type === "question" && item.part.questionStatus === "pending" && item.part.questionId),
  );
  const isActive = messagePending || hasRunningItem;

  if (!isActive || hasPendingApproval || hasRecentTextOutput) {
    return null;
  }

  return (
    <div className="thread-tail-thinking">
      <TextShimmer>{t("chat.thinking")}</TextShimmer>
    </div>
  );
}

function useHasRecentAssistantTextOutput(
  message: StoredMessage,
  groups: AssistantPartGroup[],
  active: boolean,
): boolean {
  const text = assistantTextSnapshot(message, groups);
  const [textState, setTextState] = useState(() => ({ text, changedAt: Date.now() }));
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setTextState((current) => {
      if (current.text === text) {
        return current;
      }
      return { text, changedAt: Date.now() };
    });
  }, [text]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, [active]);

  const changedThisRender = text !== textState.text;
  const changedAt = changedThisRender ? nowMs : textState.changedAt;
  return Boolean(text) && (changedThisRender || nowMs - changedAt < THINKING_IDLE_DELAY_MS);
}

function assistantTextSnapshot(message: StoredMessage, groups: AssistantPartGroup[]): string {
  const textFromGroups = groups
    .filter((group): group is Extract<AssistantPartGroup, { type: "text" }> => group.type === "text")
    .map((group) => group.part.text || "")
    .join("");
  return textFromGroups || message.text || "";
}

function recoverFinalTextForMessage(
  message: StoredMessage,
  text: string,
  runtimeEvents: AgentEventRecord[] = [],
  runs: RunRecord[] = [],
  inputHint = "",
): string {
  const current = String(text || "");
  const runId = message.runId || runIdFromInput(inputHint, runs);
  if (!runId || !runtimeEvents.length) {
    return current;
  }
  const finalText = findRuntimeFinalText(runId, runtimeEvents);
  if (!shouldUseRuntimeFinalText(current, finalText)) {
    return current;
  }
  return finalText;
}

function findRuntimeFinalText(runId: string, runtimeEvents: AgentEventRecord[]): string {
  for (let index = runtimeEvents.length - 1; index >= 0; index -= 1) {
    const event = runtimeEvents[index];
    if (event?.runId !== runId) {
      continue;
    }
    const text =
      event?.type === "assistant.final" ? event.text : event?.type === "model.response" ? event?.response?.text : "";
    if (typeof text === "string" && text.trim()) {
      return text;
    }
  }
  return "";
}

function shouldUseRuntimeFinalText(currentText: string, finalText: string): boolean {
  const current = currentText.trim();
  const final = finalText.trim();
  if (!current || !final || current === final) {
    return false;
  }
  return true;
}

function findActiveChoiceFormKey(messages: StoredMessage[]): string | undefined {
  const lastUserMessageIndex = messages.reduce(
    (latest, message, index) => (message.role === "user" ? index : latest),
    -1,
  );
  for (let index = messages.length - 1; index > lastUserMessageIndex; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const { processGroups } = splitAssistantPartsForSurface(
      normalizeMessagePartsForDisplay(message.parts).filter(isRenderableMessagePart),
      message.id,
    );
    const entries = processGroupsToActivityEntries(processGroups);
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = entries[entryIndex];
      if (entry && choiceFormFromItem(entry.item)) return entry.groupKey;
    }
  }
  return undefined;
}

function messageRoleMeta(role: StoredMessage["role"], pending: boolean) {
  if (role === "user") {
    return {
      title: "You",
      subtitle: "Prompt",
      icon: <UserRound size={14} />,
    };
  }
  if (role === "system") {
    return {
      title: "System",
      subtitle: pending ? "Updating" : "State change",
      icon: <ShieldAlert size={14} />,
    };
  }
  return {
    title: "Agent",
    subtitle: pending ? "Streaming response" : "Response",
    icon: <Bot size={14} />,
  };
}
