import { useState, type CSSProperties, type ReactNode } from "react";
import "./thread-cards-status.css";
import { Disclosure, useDisclosure } from "./disclosure";
import clsx from "clsx";
import {
  Box,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FileText,
  Image as ImageIcon,
  Pencil,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ToolPart } from "../../bridge";
import { Button } from "../ui/button";
import { rawDiagnosticText, translate, useI18n, type TranslationFn } from "../../i18n";
import {
  activityItemDetailDisplay,
  activityItemError,
  activityItemKind,
  activityItemStatus,
  activityItemTitle,
  activityItemTitleTooltip,
  artifactCardsFromItem,
  buildActivityRenderNodes,
  buildActivityItems,
  buildQuestionResponse,
  choiceFormFromItem,
  editActivityInfo,
  editDiffFromItem,
  isImageArtifactKind,
  primaryActivityKind,
  questionPromptLabel,
  summarizeActivityItems,
  type ActivityArtifactCard,
  type ActivityEntry,
  type ActivityItem,
  type ChoiceForm,
  type EditDiffLine,
} from "./message-activity-model";
import { ResourceCardFrame } from "./resource-card";
import { ResourceLink } from "./resource-link";
import {
  artifactCardToResource,
  type ChatResourceAction,
  type ChatResourceContext,
  type ChatResourceRef,
} from "./resource-model";
import { TextShimmer } from "../ui/motion/text-shimmer";
import { TextTransition } from "../ui/motion/text-transition";

export {
  activityItemKind,
  activityItemStatus,
  buildActivityItems,
  choiceFormFromItem,
  summarizeActivityItems,
  type ActivityEntry,
} from "./message-activity-model";

type PendingActionResult = void | Promise<unknown>;

export function AssistantProcessBlock(props: {
  entries: ActivityEntry[];
  activeChoiceFormKey?: string;
  openRunningByDefault?: boolean;
  renderMode?: "standalone" | "embedded";
  detailMode?: "summary" | "full";
  includeReasoningInSummary?: boolean;
  unwrapSingleExploration?: boolean;
  unwrapEmbeddedList?: boolean;
  showArtifactCards?: boolean;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): PendingActionResult;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): PendingActionResult;
  onInsertPrompt?(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const hasPendingApproval = props.entries.some(
    ({ item }) => item.type === "approval" && item.part.approvalStatus === "pending" && item.part.approvalId,
  );
  const hasPendingQuestion = props.entries.some(
    ({ item }) => item.type === "question" && item.part.questionStatus === "pending" && item.part.questionId,
  );
  const hasActiveChoiceForm = props.entries.some(
    ({ groupKey, item }) => groupKey === props.activeChoiceFormKey && Boolean(choiceFormFromItem(item)),
  );
  const items = props.entries.map(({ item }) => item);
  const hasRunningItem = props.entries.some(({ item }) => activityItemStatus(item) === "running");
  const hasProblem = props.entries.some(({ item }) =>
    ["blocked", "incomplete", "rejected", "failed", "error"].includes(activityItemStatus(item)),
  );
  const shouldOpenByDefault =
    (props.openRunningByDefault && hasRunningItem) || hasPendingQuestion || hasPendingApproval || hasActiveChoiceForm;
  const { open: detailsOpen, toggle: toggleDetails } = useDisclosure({ defaultOpen: shouldOpenByDefault });
  const completedItems = hasRunningItem ? items.filter((item) => activityItemStatus(item) !== "running") : items;
  const summaryItems = completedItems.length ? completedItems : items;
  const liveEntries = hasRunningItem ? props.entries.filter(({ item }) => activityItemStatus(item) === "running") : [];
  const summary = summarizeActivityItems(summaryItems, {
    active: hasRunningItem && !completedItems.length,
    pendingQuestion: hasPendingQuestion,
    pendingApproval: hasPendingApproval,
    activeChoiceForm: hasActiveChoiceForm,
    includeReasoning: props.includeReasoningInSummary,
  });
  const summaryKind = primaryActivityKind(summaryItems);
  const renderNodes = buildActivityRenderNodes(props.entries);
  const baseClassName = clsx(
    "thread-activity",
    props.renderMode === "embedded" ? "thread-activity-embedded" : null,
    props.entries.length === 1 ? "thread-activity-inline" : null,
    hasProblem ? "tone-warn" : null,
    hasPendingQuestion || hasPendingApproval ? "tone-approval" : null,
    hasPendingQuestion ? "has-question" : null,
  );

  if (
    props.renderMode === "embedded" &&
    props.unwrapEmbeddedList &&
    !hasPendingApproval &&
    !hasPendingQuestion &&
    !hasActiveChoiceForm
  ) {
    return (
      <ActivityEntryList
        entries={props.entries}
        activeChoiceFormKey={props.activeChoiceFormKey}
        openRunningByDefault={props.openRunningByDefault}
        detailMode={props.detailMode}
        includeReasoningInSummary={props.includeReasoningInSummary}
        pendingQuestionIds={props.pendingQuestionIds}
        onResolveApproval={props.onResolveApproval}
        onResolveQuestion={props.onResolveQuestion}
        onInsertPrompt={props.onInsertPrompt}
        onSubmitPrompt={props.onSubmitPrompt}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
        showArtifactCards={props.showArtifactCards}
      />
    );
  }

  if (
    props.renderMode === "embedded" &&
    props.unwrapSingleExploration &&
    renderNodes.length === 1 &&
    (renderNodes[0]?.type === "exploration" || renderNodes[0]?.type === "edit" || renderNodes[0]?.type === "command")
  ) {
    return (
      <ActivityEntryList
        entries={props.entries}
        activeChoiceFormKey={props.activeChoiceFormKey}
        openRunningByDefault={props.openRunningByDefault}
        detailMode={props.detailMode}
        includeReasoningInSummary={props.includeReasoningInSummary}
        pendingQuestionIds={props.pendingQuestionIds}
        onResolveApproval={props.onResolveApproval}
        onResolveQuestion={props.onResolveQuestion}
        onInsertPrompt={props.onInsertPrompt}
        onSubmitPrompt={props.onSubmitPrompt}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
        showArtifactCards={props.showArtifactCards}
      />
    );
  }

  if (props.renderMode === "embedded" && props.entries.length > 1) {
    return (
      <div
        className={baseClassName}
        data-active={hasRunningItem ? "true" : "false"}
        data-open={detailsOpen ? "true" : "false"}
      >
        <button type="button" className="thread-activity-toggle" aria-expanded={detailsOpen} onClick={toggleDetails}>
          <span className="thread-activity-summary">
            <ActivitySummaryIcon kind={summaryKind} />
            <TextTransition className="thread-activity-summary-text" identity={summary}>
              {hasRunningItem ? <TextShimmer>{summary}</TextShimmer> : renderActivitySummary(summary)}
            </TextTransition>
          </span>
          <ChevronRight className="thread-activity-chevron" size={14} strokeWidth={2.1} aria-hidden="true" />
        </button>
        {detailsOpen ? (
          <ActivityEntryList
            entries={props.entries}
            activeChoiceFormKey={props.activeChoiceFormKey}
            openRunningByDefault={props.openRunningByDefault}
            detailMode={props.detailMode}
            includeReasoningInSummary={props.includeReasoningInSummary}
            pendingQuestionIds={props.pendingQuestionIds}
            onResolveApproval={props.onResolveApproval}
            onResolveQuestion={props.onResolveQuestion}
            onInsertPrompt={props.onInsertPrompt}
            onSubmitPrompt={props.onSubmitPrompt}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
            showArtifactCards={props.showArtifactCards}
          />
        ) : null}
      </div>
    );
  }

  if (props.entries.length === 1) {
    const entry = props.entries[0];
    return entry ? (
      <div className={baseClassName} data-active={hasRunningItem ? "true" : "false"} data-open="true">
        <ActivityItemRow
          item={entry.item}
          choiceFormActive={entry.groupKey === props.activeChoiceFormKey}
          detailMode={props.detailMode}
          onResolveApproval={props.onResolveApproval}
          onResolveQuestion={props.onResolveQuestion}
          onInsertPrompt={props.onInsertPrompt}
          onSubmitPrompt={props.onSubmitPrompt}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
          showArtifactCards={props.showArtifactCards}
        />
      </div>
    ) : null;
  }

  return (
    <>
      <div
        className={baseClassName}
        data-active={hasRunningItem ? "true" : "false"}
        data-open={detailsOpen ? "true" : "false"}
      >
        <button type="button" className="thread-activity-toggle" aria-expanded={detailsOpen} onClick={toggleDetails}>
          <span className="thread-activity-summary">
            <ActivitySummaryIcon kind={summaryKind} />
            <TextTransition className="thread-activity-summary-text" identity={summary}>
              {hasRunningItem ? <TextShimmer>{summary}</TextShimmer> : renderActivitySummary(summary)}
            </TextTransition>
          </span>
          <ChevronRight className="thread-activity-chevron" size={14} strokeWidth={2.1} aria-hidden="true" />
        </button>
        {detailsOpen ? (
          <ActivityEntryList
            entries={props.entries}
            activeChoiceFormKey={props.activeChoiceFormKey}
            openRunningByDefault={props.openRunningByDefault}
            detailMode={props.detailMode}
            includeReasoningInSummary={props.includeReasoningInSummary}
            onResolveApproval={props.onResolveApproval}
            onResolveQuestion={props.onResolveQuestion}
            onInsertPrompt={props.onInsertPrompt}
            onSubmitPrompt={props.onSubmitPrompt}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
            showArtifactCards={props.showArtifactCards}
          />
        ) : null}
      </div>
      {!detailsOpen && liveEntries.length ? (
        <div className="thread-activity-live-list">
          {liveEntries.map(({ groupKey, item }) => (
            <ActivityItemRow
              key={`${groupKey}:${item.key}:live`}
              item={item}
              choiceFormActive={groupKey === props.activeChoiceFormKey}
              detailMode={props.detailMode}
              pendingQuestionIds={props.pendingQuestionIds}
              onResolveApproval={props.onResolveApproval}
              onResolveQuestion={props.onResolveQuestion}
              onInsertPrompt={props.onInsertPrompt}
              onSubmitPrompt={props.onSubmitPrompt}
              onOpenResource={props.onOpenResource}
              resourceContext={props.resourceContext}
              showArtifactCards={props.showArtifactCards}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ActivityEntryList(props: {
  entries: ActivityEntry[];
  activeChoiceFormKey?: string;
  openRunningByDefault?: boolean;
  detailMode?: "summary" | "full";
  includeReasoningInSummary?: boolean;
  showArtifactCards?: boolean;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): PendingActionResult;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): PendingActionResult;
  onInsertPrompt?(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  return (
    <div className="thread-activity-list">
      {buildActivityRenderNodes(props.entries).map((node, index) =>
        node.type === "exploration" || node.type === "edit" || node.type === "command" || node.type === "skill" ? (
          <div key={node.key} style={{ "--i": index } as CSSProperties}>
            <ActivityCluster
              kind={node.type}
              entries={node.entries}
              activeChoiceFormKey={props.activeChoiceFormKey}
              openRunningByDefault={props.openRunningByDefault}
              detailMode={props.detailMode}
              includeReasoningInSummary={props.includeReasoningInSummary}
              pendingQuestionIds={props.pendingQuestionIds}
              onResolveApproval={props.onResolveApproval}
              onResolveQuestion={props.onResolveQuestion}
              onInsertPrompt={props.onInsertPrompt}
              onSubmitPrompt={props.onSubmitPrompt}
              onOpenResource={props.onOpenResource}
              resourceContext={props.resourceContext}
              showArtifactCards={props.showArtifactCards}
            />
          </div>
        ) : (
          <div key={`${node.entry.groupKey}:${node.entry.item.key}`} style={{ "--i": index } as CSSProperties}>
            <ActivityItemRow
              item={node.entry.item}
              choiceFormActive={node.entry.groupKey === props.activeChoiceFormKey}
              detailMode={props.detailMode}
              pendingQuestionIds={props.pendingQuestionIds}
              onResolveApproval={props.onResolveApproval}
              onResolveQuestion={props.onResolveQuestion}
              onInsertPrompt={props.onInsertPrompt}
              onSubmitPrompt={props.onSubmitPrompt}
              onOpenResource={props.onOpenResource}
              resourceContext={props.resourceContext}
              showArtifactCards={props.showArtifactCards}
            />
          </div>
        ),
      )}
    </div>
  );
}

function ActivityCluster(props: {
  kind: "exploration" | "edit" | "command" | "skill";
  entries: ActivityEntry[];
  activeChoiceFormKey?: string;
  openRunningByDefault?: boolean;
  detailMode?: "summary" | "full";
  includeReasoningInSummary?: boolean;
  showArtifactCards?: boolean;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): PendingActionResult;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): PendingActionResult;
  onInsertPrompt?(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const items = props.entries.map(({ item }) => item);
  const hasRunningItem = items.some((item) => activityItemStatus(item) === "running");
  const hasProblem = items.some((item) =>
    ["blocked", "incomplete", "rejected", "failed", "error"].includes(activityItemStatus(item)),
  );
  const rawSummary = summarizeActivityItems(items, {
    active: hasRunningItem,
    includeReasoning: props.includeReasoningInSummary,
  });
  const summary = activityClusterSummary(props.kind, rawSummary);

  return (
    <Disclosure
      variant="exploration"
      active={hasRunningItem}
      defaultOpen={hasProblem || (props.kind !== "skill" && Boolean(props.openRunningByDefault && hasRunningItem))}
      summary={
        <>
          <span className="thread-activity-row-icon" aria-hidden="true">
            <ActivitySummaryIcon
              kind={
                props.kind === "edit"
                  ? "edit"
                  : props.kind === "command"
                    ? "command"
                    : props.kind === "skill"
                      ? "skill"
                      : "search"
              }
            />
          </span>
          <TextTransition className="thread-activity-summary-text" identity={summary}>
            {hasRunningItem ? <TextShimmer>{summary}</TextShimmer> : summary}
          </TextTransition>
        </>
      }
    >
      {props.entries.map(({ groupKey, item }, index) => (
        <div key={`${groupKey}:${item.key}`} style={{ "--i": index } as CSSProperties}>
          <ActivityItemRow
            item={item}
            choiceFormActive={groupKey === props.activeChoiceFormKey}
            detailMode={props.detailMode}
            pendingQuestionIds={props.pendingQuestionIds}
            onResolveApproval={props.onResolveApproval}
            onResolveQuestion={props.onResolveQuestion}
            onInsertPrompt={props.onInsertPrompt}
            onSubmitPrompt={props.onSubmitPrompt}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
            showArtifactCards={props.showArtifactCards}
          />
        </div>
      ))}
    </Disclosure>
  );
}

// 中文摘要的语气改写（"已编辑"→"编辑了"）；英文摘要不匹配这些前缀，原样透传。
function activityClusterSummary(kind: "exploration" | "edit" | "command" | "skill", rawSummary: string): string {
  if (kind === "edit") return rawSummary.replace(/^已编辑 /, "编辑了 ");
  if (kind === "command") return rawSummary.replace(/^已运行 /, "执行了 ");
  return rawSummary.replace(/^已探索 /, "读取了 ").replace(/(\d+) 次搜索/g, "搜索了 $1 次");
}

function ActivityItemRow(props: {
  item: ActivityItem;
  choiceFormActive: boolean;
  detailMode?: "summary" | "full";
  showArtifactCards?: boolean;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): PendingActionResult;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): PendingActionResult;
  onInsertPrompt?(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const { t } = useI18n();
  const status = activityItemStatus(props.item);
  const kind = activityItemKind(props.item);
  const choiceForm = choiceFormFromItem(props.item);
  const detail = choiceForm
    ? null
    : activityItemDetailDisplay(props.item, {
        full: props.detailMode === "full" && !collapsesInlineDetail(kind),
      });
  const title = activityItemTitle(props.item);
  const titleTooltip = choiceForm ? "" : activityItemTitleTooltip(props.item);
  const [fullDetailOpen, setFullDetailOpen] = useState(false);
  const fullDetail =
    props.detailMode === "full" && !choiceForm ? collapsibleFullDetail(kind, titleTooltip, detail?.title) : "";
  const artifactCards = props.showArtifactCards === false ? [] : artifactCardsFromItem(props.item);
  const editInfo = kind === "edit" ? editActivityInfo(props.item) : null;
  const editDiff = kind === "edit" ? editDiffFromItem(props.item) : null;
  const [editDiffOpen, setEditDiffOpen] = useState(false);
  const errorText = activityItemError(props.item);
  const fullErrorText = errorText ? activityItemError(props.item, { full: true }) : "";
  const editResources = editInfo
    ? editInfo.fullPaths.map((path, index) => ({
        path,
        title: fileLabel(path),
        resource: artifactCardToResource(
          {
            id: `${props.item.key}:edit-file:${index}`,
            title: fileLabel(path),
            kind: translate("activity.file"),
            summary: path,
            path,
            uri: "",
            imageUri: "",
          },
          props.resourceContext,
        ),
      }))
    : [];
  const editStatusLabel =
    status === "running"
      ? t("activity.editing")
      : ["blocked", "incomplete", "rejected", "failed", "error"].includes(status)
        ? t("activity.editIncomplete")
        : t("activity.edited");
  const pendingApprovalPart =
    props.item.type === "approval" && props.item.part.approvalStatus === "pending" && props.item.part.approvalId
      ? props.item.part
      : null;
  const pendingQuestionPart =
    props.item.type === "question" && props.item.part.questionStatus === "pending" && props.item.part.questionId
      ? props.item.part
      : null;
  const questionUnavailable = Boolean(
    pendingQuestionPart && props.pendingQuestionIds && !props.pendingQuestionIds.has(pendingQuestionPart.questionId),
  );
  const interactivePart = !questionUnavailable && pendingQuestionPart ? pendingQuestionPart : pendingApprovalPart;
  const [approvalResolutionPending, setApprovalResolutionPending] = useState(false);
  const [approvalResolutionError, setApprovalResolutionError] = useState("");
  // 与 QuestionRequestCard 的 resolutionPending 同一模式：提交期间禁止重复点击，
  // 失败时把错误留在卡片上（红色小字），而不是只写进全局消息流。
  const runApprovalResolution = (action: "approve" | "reject") => {
    if (!interactivePart || approvalResolutionPending) return;
    setApprovalResolutionPending(true);
    setApprovalResolutionError("");
    const resetOnFailure = (error: unknown) => {
      setApprovalResolutionPending(false);
      setApprovalResolutionError(error instanceof Error ? error.message : String(error));
    };
    try {
      const result = props.onResolveApproval(interactivePart.approvalId, action, undefined);
      if (result instanceof Promise) {
        void result.then(() => setApprovalResolutionPending(false), resetOnFailure);
      } else {
        setApprovalResolutionPending(false);
      }
    } catch (error) {
      resetOnFailure(error);
    }
  };
  if (choiceForm) {
    return (
      <div className="thread-activity-row is-choice-form">
        <div className="thread-activity-row-body">
          <ChoiceFormBlock
            form={choiceForm}
            disabled={!props.choiceFormActive}
            onInsertPrompt={props.onInsertPrompt}
            onSubmitPrompt={props.onSubmitPrompt}
          />
        </div>
      </div>
    );
  }
  return (
    <div className={clsx("thread-activity-row", `status-${status}`, pendingQuestionPart ? "is-question" : null)}>
      <span className="thread-activity-row-icon" aria-hidden="true">
        <ActivitySummaryIcon kind={activityItemKind(props.item)} />
      </span>
      <div className="thread-activity-row-body">
        {editInfo ? (
          <>
            <div className="thread-activity-edit" title={editInfo.fullPaths.join("\n") || editInfo.label}>
              <span className="thread-activity-edit-prefix">{editStatusLabel}</span>
              {editResources.length > 1 ? (
                <>
                  <span className="thread-activity-edit-file-count">{editInfo.label}</span>
                  <span className="thread-activity-edit-file-list">
                    {editResources.map((item) =>
                      item.resource ? (
                        <ResourceLink
                          key={item.path}
                          resource={item.resource}
                          className="thread-activity-edit-file"
                          onOpenResource={props.onOpenResource}
                        >
                          {item.title}
                        </ResourceLink>
                      ) : (
                        <span key={item.path} className="thread-activity-edit-file">
                          {item.title}
                        </span>
                      ),
                    )}
                  </span>
                </>
              ) : editResources[0]?.resource ? (
                <ResourceLink
                  resource={editResources[0].resource}
                  className="thread-activity-edit-file"
                  onOpenResource={props.onOpenResource}
                >
                  {editInfo.label}
                </ResourceLink>
              ) : (
                <span className="thread-activity-edit-file">{editInfo.label}</span>
              )}
              {editInfo.added !== undefined ? (
                <span className="thread-activity-edit-added">+{editInfo.added}</span>
              ) : null}
              {editInfo.removed !== undefined ? (
                <span className="thread-activity-edit-removed">-{editInfo.removed}</span>
              ) : null}
              {editDiff && editDiff.length ? (
                <button
                  type="button"
                  className="thread-activity-edit-diff-toggle"
                  aria-expanded={editDiffOpen}
                  aria-label={editDiffOpen ? t("activity.collapseDiff") : t("activity.expandDiff")}
                  onClick={() => setEditDiffOpen((current) => !current)}
                >
                  <ChevronRight size={13} strokeWidth={2.1} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {editDiff && editDiff.length && editDiffOpen ? <EditDiffBlock lines={editDiff} /> : null}
          </>
        ) : (
          <>
            {fullDetail ? (
              <button
                type="button"
                className="thread-activity-row-toggle"
                aria-expanded={fullDetailOpen}
                title={titleTooltip || undefined}
                onClick={() => setFullDetailOpen((current) => !current)}
              >
                <span className="thread-activity-row-title-line">
                  <span className="thread-activity-row-title">{title}</span>
                  <ChevronRight
                    className="thread-activity-row-detail-chevron"
                    size={13}
                    strokeWidth={2.1}
                    aria-hidden="true"
                  />
                </span>
                {detail?.label ? <span className="thread-activity-row-detail">{detail.label}</span> : null}
              </button>
            ) : (
              <>
                <div className="thread-activity-row-title" title={titleTooltip || undefined}>
                  {title}
                </div>
                {detail ? (
                  <div className="thread-activity-row-detail" title={detail.title || undefined}>
                    {detail.label}
                  </div>
                ) : null}
              </>
            )}
            {fullDetail && fullDetailOpen ? <pre className="thread-activity-row-full-detail">{fullDetail}</pre> : null}
          </>
        )}
        {artifactCards.length ? (
          <ArtifactCardList
            cards={artifactCards}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
          />
        ) : null}
        {pendingQuestionPart ? (
          <QuestionRequestCard
            part={pendingQuestionPart}
            disabledReason={questionUnavailable ? t("activity.questionExpired") : ""}
            onAnswer={(answer) => {
              return props.onResolveQuestion(
                pendingQuestionPart.questionId,
                "answer",
                buildQuestionResponse(pendingQuestionPart, answer),
              );
            }}
            onDecline={() => props.onResolveQuestion(pendingQuestionPart.questionId, "decline")}
          />
        ) : null}
        {interactivePart && !pendingQuestionPart ? (
          <>
            <div className="thread-approval-actions compact">
              <Button
                variant="primary"
                disabled={approvalResolutionPending}
                onClick={() => {
                  runApprovalResolution("approve");
                }}
              >
                {pendingQuestionPart ? t("activity.answer") : t("activity.confirm")}
              </Button>
              <Button
                disabled={approvalResolutionPending}
                onClick={() => {
                  runApprovalResolution("reject");
                }}
              >
                {t("activity.reject")}
              </Button>
            </div>
            {approvalResolutionError ? (
              <div className="thread-activity-row-error thread-approval-error">
                {rawDiagnosticText(approvalResolutionError)}
              </div>
            ) : null}
          </>
        ) : null}
        {errorText ? (
          <div
            className="thread-activity-row-error"
            title={fullErrorText ? rawDiagnosticText(fullErrorText) : undefined}
          >
            {rawDiagnosticText(errorText)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function collapsesInlineDetail(kind: string): boolean {
  return ["command", "monitor", "search", "read", "browser"].includes(kind);
}

function collapsibleFullDetail(kind: string, titleDetail: string, rowDetail?: string): string {
  if (!collapsesInlineDetail(kind)) {
    return "";
  }
  // For `read`, the title tooltip is just the (absolute) file path — it stays available on hover
  // via the row's `title` attribute, so we keep it out of the expandable block to avoid dumping
  // long absolute paths inline. Genuine row detail (output/error overflow) is still expandable.
  const titlePart = kind === "read" ? "" : titleDetail;
  const parts = [titlePart, rowDetail ?? ""].map((value) => value.trim()).filter(Boolean);
  return parts.filter((part, index) => parts.indexOf(part) === index).join("\n\n");
}

function fileLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function EditDiffBlock(props: { lines: EditDiffLine[] }) {
  const { t } = useI18n();
  return (
    <pre className="thread-activity-edit-diff" aria-label={t("activity.changesAria")}>
      {props.lines.map((line, index) => (
        <code key={index} className={`thread-activity-edit-diff-line is-${line.kind}`}>
          <span className="thread-activity-edit-diff-sign" aria-hidden="true">
            {line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "meta" ? "" : " "}
          </span>
          <span className="thread-activity-edit-diff-text">{line.text}</span>
        </code>
      ))}
    </pre>
  );
}

function ArtifactCardList(props: {
  cards: ActivityArtifactCard[];
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const { t } = useI18n();
  return (
    <div className="thread-artifact-card-list" aria-label={t("activity.artifactsAria")}>
      {props.cards.map((card) => {
        const resource = artifactCardToResource(card, props.resourceContext);
        const content = (
          <>
            <span className="thread-artifact-card-icon" aria-hidden="true">
              {isImageArtifactKind(card.kind) ? (
                <ImageIcon size={15} strokeWidth={2.1} />
              ) : (
                <FileText size={15} strokeWidth={2.1} />
              )}
            </span>
            <div className="thread-artifact-card-body">
              <div className="thread-artifact-card-title">{card.title}</div>
              <div className="thread-artifact-card-meta">
                <span>{card.kind}</span>
                {card.summary ? <span>{card.summary}</span> : null}
              </div>
              {card.imageUri ? (
                <img className="thread-artifact-card-image" src={card.imageUri} alt={card.title} />
              ) : null}
            </div>
          </>
        );
        return resource ? (
          <ResourceCardFrame key={`${card.id}:${card.title}`} resource={resource} onOpenResource={props.onOpenResource}>
            {content}
          </ResourceCardFrame>
        ) : (
          <article className="thread-artifact-card" key={`${card.id}:${card.title}`}>
            {content}
          </article>
        );
      })}
    </div>
  );
}

export function QuestionInteractionCard(props: {
  part: ToolPart;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): PendingActionResult;
}) {
  const { t } = useI18n();
  const status = props.part.questionStatus || "pending";
  const pending = status === "pending";
  const unavailable = Boolean(
    pending &&
      props.part.questionId &&
      props.pendingQuestionIds &&
      !props.pendingQuestionIds.has(props.part.questionId),
  );

  if (pending) {
    return (
      <QuestionRequestCard
        part={props.part}
        disabledReason={unavailable ? t("activity.questionExpired") : ""}
        onAnswer={(answer) =>
          props.onResolveQuestion(props.part.questionId, "answer", buildQuestionResponse(props.part, answer))
        }
        onDecline={() => props.onResolveQuestion(props.part.questionId, "decline")}
      />
    );
  }

  const declined = status === "declined";
  const rows = declined
    ? questionPages(props.part).map((page) => ({ id: page.id, prompt: page.title, answer: "" }))
    : questionAnswerRows(props.part, t);
  return (
    <section
      className={clsx("thread-question-summary", declined ? "is-declined" : "is-answered")}
      aria-label={declined ? t("activity.skippedQuestionAria") : t("activity.answeredQuestionAria")}
    >
      {rows.map((row) => (
        <div className="thread-question-summary-item" key={row.id}>
          <div className="thread-question-summary-prompt">{row.prompt}</div>
          <div className="thread-question-summary-answer">{declined ? t("activity.skipped") : row.answer}</div>
        </div>
      ))}
    </section>
  );
}

export function ApprovalInteractionCard(props: {
  part: ToolPart;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): PendingActionResult;
}) {
  const item = buildActivityItems([props.part])[0];
  if (!item || item.type !== "approval") {
    return null;
  }
  return (
    <div className="thread-approval-interaction">
      <ActivityItemRow
        item={item}
        choiceFormActive={false}
        detailMode="full"
        onResolveApproval={props.onResolveApproval}
        onResolveQuestion={() => undefined}
      />
    </div>
  );
}

function QuestionRequestCard(props: {
  part: NonNullable<ToolPart>;
  disabledReason?: string;
  onAnswer(answer: string | Record<string, string>): PendingActionResult;
  onDecline(): PendingActionResult;
}) {
  const { t } = useI18n();
  const questions = questionPages(props.part);
  const [pageIndex, setPageIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [skippedQuestions, setSkippedQuestions] = useState<Record<string, boolean>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [customAnswerOpen, setCustomAnswerOpen] = useState<Record<string, boolean>>({});
  const [resolutionPending, setResolutionPending] = useState(false);
  const page = questions[Math.min(pageIndex, Math.max(questions.length - 1, 0))];
  const options = page?.options ?? [];
  const currentAnswer = page ? (answers[page.id] ?? "") : "";
  const optionValues = options.map((option) => option.value || option.label);
  const currentAnswerIsCustom = Boolean(
    page && currentAnswer && !page.multiSelect && !optionValues.includes(currentAnswer),
  );
  const currentCustomAnswer = page ? (customAnswers[page.id] ?? (currentAnswerIsCustom ? currentAnswer : "")) : "";
  const currentSelections = currentAnswer
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const isCustomAnswerOpen = Boolean(page && customAnswerOpen[page.id]);
  const currentAnswered = currentAnswer.trim().length > 0;
  const hasMultipleQuestions = questions.length > 1;
  const canGoBack = pageIndex > 0;
  const canGoForward = pageIndex < questions.length - 1;
  const questionIsDone = (question: { id: string }, nextAnswers = answers, nextSkipped = skippedQuestions) =>
    (nextAnswers[question.id] ?? "").trim().length > 0 || Boolean(nextSkipped[question.id]);
  const allQuestionsDone = questions.every((question) => questionIsDone(question));
  const firstIncompleteQuestionIndex = (nextAnswers = answers, nextSkipped = skippedQuestions) =>
    questions.findIndex((question) => !questionIsDone(question, nextAnswers, nextSkipped));
  const disabled = Boolean(props.disabledReason) || resolutionPending;
  const runResolution = (resolve: () => PendingActionResult) => {
    if (disabled) return;
    setResolutionPending(true);
    try {
      const result = resolve();
      if (result instanceof Promise) {
        void result.catch(() => setResolutionPending(false));
      }
    } catch (error) {
      setResolutionPending(false);
      throw error;
    }
  };
  const answerCurrentQuestion = (value: string) => {
    if (disabled) return;
    if (!page) return;
    setAnswers((current) => ({ ...current, [page.id]: value }));
    setSkippedQuestions((current) => ({ ...current, [page.id]: false }));
  };
  const advanceOrSubmit = (nextAnswers: Record<string, string>) => {
    if (hasMultipleQuestions && canGoForward) {
      setPageIndex((current) => Math.min(questions.length - 1, current + 1));
      return;
    }
    const incompleteIndex = firstIncompleteQuestionIndex(nextAnswers);
    if (hasMultipleQuestions && incompleteIndex >= 0) {
      setPageIndex(incompleteIndex);
      return;
    }
    runResolution(() => props.onAnswer(nextAnswers));
  };
  const submitAnswers = (nextAnswers = answers) => {
    if (disabled) return;
    if (!questions.length) {
      runResolution(() => props.onAnswer(""));
      return;
    }
    const complete = questions.every((question) => questionIsDone(question, nextAnswers));
    if (!complete) return;
    const output = { ...nextAnswers };
    if (page && !options.length) {
      output[page.id] = currentAnswer;
    }
    runResolution(() => props.onAnswer(output));
  };
  const chooseOption = (option: { value: string; label: string }) => {
    if (disabled) return;
    if (!page) return;
    const value = option.value || option.label;
    setCustomAnswerOpen((current) => ({ ...current, [page.id]: false }));
    if (page.multiSelect) {
      const selected = currentSelections.includes(value);
      const nextSelections = selected
        ? currentSelections.filter((item) => item !== value)
        : [...currentSelections, value];
      setAnswers({ ...answers, [page.id]: nextSelections.join(", ") });
      setSkippedQuestions((current) => ({ ...current, [page.id]: false }));
      return;
    }
    const nextAnswers = { ...answers, [page.id]: value };
    setAnswers(nextAnswers);
    setSkippedQuestions((current) => ({ ...current, [page.id]: false }));
    advanceOrSubmit(nextAnswers);
  };
  const submitCustomAnswer = () => {
    if (disabled) return;
    if (!page) return;
    const value = currentCustomAnswer.trim();
    if (!value) return;
    if (page.multiSelect) {
      const nextSelections = currentSelections.includes(value) ? currentSelections : [...currentSelections, value];
      const nextAnswers = { ...answers, [page.id]: nextSelections.join(", ") };
      setAnswers(nextAnswers);
      setSkippedQuestions((current) => ({ ...current, [page.id]: false }));
      setCustomAnswers((current) => ({ ...current, [page.id]: "" }));
      setCustomAnswerOpen((current) => ({ ...current, [page.id]: false }));
      return;
    }
    const nextAnswers = { ...answers, [page.id]: value };
    setAnswers(nextAnswers);
    setSkippedQuestions((current) => ({ ...current, [page.id]: false }));
    setCustomAnswerOpen((current) => ({ ...current, [page.id]: false }));
    advanceOrSubmit(nextAnswers);
  };
  const skipCurrentQuestion = () => {
    if (disabled) return;
    if (!page) return;
    const nextAnswers = { ...answers };
    delete nextAnswers[page.id];
    const nextSkipped = { ...skippedQuestions, [page.id]: true };
    setAnswers(nextAnswers);
    setSkippedQuestions(nextSkipped);
    setCustomAnswers((current) => ({ ...current, [page.id]: "" }));
    setCustomAnswerOpen((current) => ({ ...current, [page.id]: false }));
    if (hasMultipleQuestions && canGoForward) {
      setPageIndex((current) => Math.min(questions.length - 1, current + 1));
      return;
    }
    const incompleteIndex = firstIncompleteQuestionIndex(nextAnswers, nextSkipped);
    if (incompleteIndex >= 0) {
      setPageIndex(incompleteIndex);
      return;
    }
    runResolution(() => props.onAnswer(nextAnswers));
  };
  return (
    <section
      className={clsx("thread-question-card", resolutionPending ? "is-resolving" : null)}
      aria-busy={resolutionPending || undefined}
    >
      <div className="thread-question-card-header">
        <div>
          <div className="thread-question-card-title">{page?.title || questionPromptLabel(props.part)}</div>
          {page?.description ? <div className="thread-question-card-description">{page.description}</div> : null}
        </div>
        {hasMultipleQuestions ? (
          <div className="thread-question-card-nav" aria-label={t("activity.questionPaginationAria")}>
            <button
              type="button"
              disabled={!canGoBack || disabled}
              onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
              aria-label={t("activity.prevQuestion")}
            >
              <ChevronLeft size={16} strokeWidth={2.1} />
            </button>
            <span>
              {pageIndex + 1} of {questions.length}
            </span>
            <button
              type="button"
              disabled={!canGoForward || disabled}
              onClick={() => setPageIndex((current) => Math.min(questions.length - 1, current + 1))}
              aria-label={t("activity.nextQuestion")}
            >
              <ChevronRight size={16} strokeWidth={2.1} />
            </button>
          </div>
        ) : null}
      </div>
      {options.length ? (
        <div className="thread-question-options">
          {options.map((option, index) => (
            <button
              className={clsx(
                "thread-question-option",
                page?.multiSelect
                  ? currentSelections.includes(option.value || option.label)
                    ? "selected"
                    : null
                  : currentAnswer === option.value || currentAnswer === option.label
                    ? "selected"
                    : null,
              )}
              key={`${option.value}-${index}`}
              type="button"
              disabled={disabled}
              onClick={() => chooseOption(option)}
            >
              <span className="thread-question-option-index">{index + 1}.</span>
              <span className="thread-question-option-label">{option.label}</span>
              {option.description ? (
                <span className="thread-question-option-description">{option.description}</span>
              ) : null}
            </button>
          ))}
          {isCustomAnswerOpen ? (
            <div className="thread-question-custom-answer">
              <input
                autoFocus
                value={currentCustomAnswer}
                disabled={disabled}
                onChange={(event) => {
                  if (!page) return;
                  setCustomAnswers((current) => ({ ...current, [page.id]: event.target.value }));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submitCustomAnswer();
                  }
                }}
                placeholder={t("activity.customAnswerPlaceholder")}
              />
              <Button disabled={!currentCustomAnswer.trim() || disabled} onClick={submitCustomAnswer}>
                {resolutionPending
                  ? t("activity.submitting")
                  : page?.multiSelect
                    ? t("activity.add")
                    : canGoForward
                      ? t("activity.continue")
                      : t("activity.submit")}
              </Button>
              <Button
                disabled={disabled}
                onClick={() => {
                  if (!page) return;
                  setCustomAnswers((current) => ({ ...current, [page.id]: "" }));
                  setCustomAnswerOpen((current) => ({ ...current, [page.id]: false }));
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          ) : (
            <button
              className={clsx("thread-question-option", currentAnswerIsCustom ? "selected" : null)}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (!page) return;
                setCustomAnswerOpen((current) => ({ ...current, [page.id]: true }));
              }}
            >
              <span className="thread-question-option-index">{options.length + 1}.</span>
              <span className="thread-question-option-label">{t("activity.otherOption")}</span>
              <span className="thread-question-option-description">
                {currentAnswerIsCustom ? currentAnswer : t("activity.ownAnswerHint")}
              </span>
            </button>
          )}
        </div>
      ) : (
        <textarea
          className="thread-approval-input"
          value={currentAnswer}
          disabled={disabled}
          onChange={(event) => answerCurrentQuestion(event.target.value)}
          placeholder={t("activity.answerPlaceholder")}
          rows={3}
        />
      )}
      {props.disabledReason ? (
        <div className="thread-question-card-expired">{props.disabledReason}</div>
      ) : (
        <div className="thread-approval-actions compact">
          {hasMultipleQuestions && canGoBack ? (
            <Button disabled={disabled} onClick={() => setPageIndex((current) => Math.max(0, current - 1))}>
              {t("activity.prevQuestion")}
            </Button>
          ) : null}
          {hasMultipleQuestions && canGoForward && (!options.length || page?.multiSelect) ? (
            <Button
              variant="primary"
              disabled={!currentAnswered || disabled}
              onClick={() => setPageIndex((current) => Math.min(questions.length - 1, current + 1))}
            >
              {t("activity.continue")}
            </Button>
          ) : null}
          {options.length && page?.multiSelect && hasMultipleQuestions && !canGoForward ? (
            <Button variant="primary" disabled={!allQuestionsDone || disabled} onClick={() => submitAnswers()}>
              {resolutionPending
                ? t("activity.submitting")
                : allQuestionsDone
                  ? t("activity.submit")
                  : t("activity.submitAfterAll")}
            </Button>
          ) : null}
          {options.length && page?.multiSelect && !hasMultipleQuestions ? (
            <Button variant="primary" disabled={!allQuestionsDone || disabled} onClick={() => submitAnswers()}>
              {resolutionPending ? t("activity.submitting") : t("activity.submit")}
            </Button>
          ) : null}
          {!options.length && !canGoForward ? (
            <Button variant="primary" disabled={!allQuestionsDone || disabled} onClick={() => submitAnswers()}>
              {resolutionPending ? t("activity.submitting") : t("activity.answer")}
            </Button>
          ) : null}
          {hasMultipleQuestions ? (
            <Button disabled={disabled} onClick={skipCurrentQuestion}>
              {resolutionPending ? t("activity.submitting") : t("activity.skip")}
            </Button>
          ) : null}
          <Button
            disabled={disabled}
            onClick={() => runResolution(props.onDecline)}
            title={hasMultipleQuestions ? t("activity.declineAllTooltip") : undefined}
          >
            {resolutionPending
              ? hasMultipleQuestions
                ? t("activity.cancelling")
                : t("activity.skipping")
              : hasMultipleQuestions
                ? t("activity.cancelAll")
                : t("activity.skip")}
          </Button>
        </div>
      )}
    </section>
  );
}

function questionPages(part: ToolPart): Array<{
  id: string;
  title: string;
  description: string;
  multiSelect: boolean;
  options: Array<{ value: string; label: string; description: string }>;
}> {
  const questionInput = recordValue(part.questionInput);
  const isAskUserQuestion = stringValue(questionInput.toolName) === "AskUserQuestion";
  const containers = [
    questionInput,
    recordValue(questionInput.params),
    recordValue(questionInput.input),
    recordValue(recordValue(questionInput.params).input),
  ];
  for (const container of containers) {
    const questions = Array.isArray(container.questions)
      ? container.questions
      : Array.isArray(container.fields)
        ? container.fields
        : [];
    const pages = questions
      .map((question, questionIndex) => {
        const value = recordValue(question);
        const options = Array.isArray(value.options)
          ? value.options
              .map((option) => {
                const optionValue = recordValue(option);
                const label =
                  stringValue(optionValue.label) || stringValue(optionValue.title) || stringValue(optionValue.value);
                if (!label) return null;
                return {
                  value: stringValue(optionValue.value) || label,
                  label,
                  description: stringValue(optionValue.description),
                };
              })
              .filter((option): option is { value: string; label: string; description: string } => Boolean(option))
          : [];
        const id = isAskUserQuestion
          ? stringValue(value.question) ||
            stringValue(value.header) ||
            stringValue(value.id) ||
            stringValue(value.name) ||
            `question_${questionIndex + 1}`
          : stringValue(value.id) ||
            stringValue(value.name) ||
            stringValue(value.header) ||
            stringValue(value.question) ||
            `question_${questionIndex + 1}`;
        const title =
          stringValue(value.title) ||
          stringValue(value.label) ||
          stringValue(value.question) ||
          stringValue(value.header) ||
          stringValue(value.prompt) ||
          stringValue(value.message) ||
          stringValue(value.text) ||
          questionPromptLabel(part);
        return {
          id,
          title,
          description: stringValue(value.description) || stringValue(value.helpText),
          multiSelect: value.multiSelect === true,
          options,
        };
      })
      .filter((page) => page.title || page.options.length);
    if (pages.length) {
      return pages;
    }
  }
  return [
    {
      id: "answer",
      title: questionPromptLabel(part),
      description: "",
      multiSelect: false,
      options: [],
    },
  ];
}

function questionAnswerRows(
  part: ToolPart,
  t: TranslationFn = translate,
): Array<{ id: string; prompt: string; answer: string }> {
  const pages = questionPages(part);
  return pages.map((page) => ({
    id: page.id,
    prompt: page.title,
    answer: questionAnswerForPage(part.result, page.id, page.title, pages.length === 1, t),
  }));
}

function questionAnswerForPage(
  response: unknown,
  questionId: string,
  questionTitle: string,
  singleQuestion: boolean,
  t: TranslationFn = translate,
): string {
  if (response === undefined) return t("activity.answered");
  const root = recordValue(response);
  const answers = recordValue(recordProperty(root, "answers"));
  const content = recordValue(recordProperty(root, "content"));
  const keyedCandidates = [
    recordProperty(answers, questionId),
    recordProperty(answers, questionTitle),
    recordProperty(content, questionId),
    recordProperty(content, questionTitle),
    recordProperty(root, questionId),
    recordProperty(root, questionTitle),
  ];
  for (const candidate of keyedCandidates) {
    const formatted = questionAnswerText(candidate);
    if (formatted) return formatted;
  }
  if (singleQuestion) {
    for (const candidate of [
      recordProperty(root, "answer"),
      recordProperty(root, "value"),
      recordProperty(root, "text"),
      response,
    ]) {
      const formatted = questionAnswerText(candidate);
      if (formatted) return formatted;
    }
  }
  return t("activity.answeredNotDisplayable");
}

const MAX_QUESTION_ANSWER_DEPTH = 32;

function questionAnswerText(value: unknown, ancestors: Set<object> = new Set(), depth = 0): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object" || depth >= MAX_QUESTION_ANSWER_DEPTH) return "";
  if (ancestors.has(value)) return "";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .map((item) => questionAnswerText(item, ancestors, depth + 1))
        .filter(Boolean)
        .join("、");
    }
    const record = value as Record<string, unknown>;
    for (const candidate of ["answers", "answer", "value", "text"].map((key) => recordProperty(record, key))) {
      const formatted = questionAnswerText(candidate, ancestors, depth + 1);
      if (formatted) return formatted;
    }
    return "";
  } finally {
    ancestors.delete(value);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ChoiceFormBlock(props: {
  form: ChoiceForm;
  disabled?: boolean;
  onInsertPrompt?(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
}) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const disabled = props.disabled || submitted;

  return (
    <section className="thread-choice-form">
      <div className="thread-choice-form-header">
        <div>
          <div className="thread-choice-form-kicker">{t("activity.choiceRequired")}</div>
          <div className="thread-choice-form-title">{props.form.title}</div>
        </div>
      </div>
      {props.form.instructions ? (
        <div className="thread-choice-form-instructions">{props.form.instructions}</div>
      ) : null}
      <div className="thread-choice-question-list">
        {props.form.questions.map((question, index) => (
          <div className="thread-choice-question" key={`${question.id || "question"}-${index}`}>
            <div className="thread-choice-question-title">
              {index + 1}. {question.prompt}
            </div>
            <div className="thread-choice-options">
              {question.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={clsx("thread-choice-option", answers[index] === option.value && "selected")}
                  disabled={disabled || (option.action !== "insert" && !props.onSubmitPrompt)}
                  onClick={() => {
                    setAnswers({ [index]: option.value });
                    if (option.action === "insert") {
                      props.onInsertPrompt?.(option.label);
                      return;
                    }
                    if (!props.onSubmitPrompt) return;
                    setSubmitted(true);
                    props.onSubmitPrompt(option.label);
                  }}
                >
                  <span>{option.label}</span>
                  {option.description ? <small>{option.description}</small> : null}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Render an activity summary string, colouring any "+N" / "-N" edit-diff tokens green/red so the
// collapsed summary matches the expanded edit row. Other text is emitted verbatim.
export function renderActivitySummary(summary: string): ReactNode {
  const parts = summary.split(/(\s[+-]\d+)(?=\s|$)/g);
  if (parts.length === 1) {
    return summary;
  }
  return parts.map((part, index) => {
    const match = part.match(/^(\s)([+-])(\d+)$/);
    if (!match) {
      return <span key={index}>{part}</span>;
    }
    const [, lead, sign, digits] = match;
    return (
      <span key={index}>
        {lead}
        <span className={sign === "+" ? "thread-activity-edit-added" : "thread-activity-edit-removed"}>
          {sign}
          {digits}
        </span>
      </span>
    );
  });
}

function ActivitySummaryIcon(props: { kind: string }) {
  if (props.kind === "search") {
    return <Search size={14} />;
  }
  if (props.kind === "read") {
    return <FileText size={14} />;
  }
  if (props.kind === "planning") {
    return <FileText size={14} />;
  }
  if (props.kind === "command" || props.kind === "monitor") {
    return <Terminal size={14} />;
  }
  if (props.kind === "edit") {
    return <Pencil size={14} />;
  }
  if (props.kind === "skill") {
    return <Sparkles size={14} />;
  }
  if (props.kind === "question") {
    return <CircleHelp size={14} />;
  }
  if (props.kind === "reasoning") {
    return <Sparkles size={14} />;
  }
  if (props.kind === "artifact" || props.kind === "memory") {
    return <Box size={14} />;
  }
  return <Wrench size={14} />;
}
