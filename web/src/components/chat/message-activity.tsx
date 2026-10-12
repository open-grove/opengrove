import { ActivityRow, InteractionActions, EditDiff, QuestionForm, type QuestionAnswers } from "@olorinm/agent-ui";
import { SharedChatProvider } from "./shared-chat-provider";
import { useState, type CSSProperties, type ReactNode } from "react";
import "./thread-cards-status.css";
import { Disclosure, useDisclosure } from "./disclosure";
import clsx from "clsx";
import {
  Box,
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
  onResolveApproval(
    approvalId: string,
    action: "approve" | "reject" | "cancel",
    response?: unknown,
  ): PendingActionResult;
  onResolveQuestion(
    questionId: string,
    action: "answer" | "decline" | "cancel",
    response?: unknown,
  ): PendingActionResult;
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
  onResolveApproval(
    approvalId: string,
    action: "approve" | "reject" | "cancel",
    response?: unknown,
  ): PendingActionResult;
  onResolveQuestion(
    questionId: string,
    action: "answer" | "decline" | "cancel",
    response?: unknown,
  ): PendingActionResult;
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
  onResolveApproval(
    approvalId: string,
    action: "approve" | "reject" | "cancel",
    response?: unknown,
  ): PendingActionResult;
  onResolveQuestion(
    questionId: string,
    action: "answer" | "decline" | "cancel",
    response?: unknown,
  ): PendingActionResult;
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
  onResolveApproval(
    approvalId: string,
    action: "approve" | "reject" | "cancel",
    response?: unknown,
  ): PendingActionResult;
  onResolveQuestion(
    questionId: string,
    action: "answer" | "decline" | "cancel",
    response?: unknown,
  ): PendingActionResult;
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
    <ActivityRow
      status={status}
      className={pendingQuestionPart ? "is-question" : undefined}
      title={title}
      titleTooltip={titleTooltip || undefined}
      detail={detail ?? undefined}
      fullDetail={fullDetail}
      icon={<ActivitySummaryIcon kind={kind} />}
      header={
        editInfo ? (
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
        ) : undefined
      }
      error={errorText ? rawDiagnosticText(errorText) : undefined}
      errorTitle={fullErrorText ? rawDiagnosticText(fullErrorText) : undefined}
    >
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
          onCancel={() =>
            props.onResolveQuestion(pendingQuestionPart.questionId, "cancel", {
              system: false,
              reasonCode: "user_canceled",
            })
          }
        />
      ) : null}
      {interactivePart && !pendingQuestionPart ? (
        <SharedChatProvider>
          <InteractionActions
            key={interactivePart.approvalId}
            choices={[
              { id: "approve", label: t("activity.confirm"), primary: true },
              { id: "reject", label: t("activity.reject") },
              { id: "cancel", label: t("activity.cancelRun") },
            ]}
            onChoose={(action) =>
              props.onResolveApproval(interactivePart.approvalId, action as "approve" | "reject" | "cancel")
            }
          />
        </SharedChatProvider>
      ) : null}
    </ActivityRow>
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
  return <EditDiff lines={props.lines} label={t("activity.changesAria")} />;
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
  onResolveQuestion(
    questionId: string,
    action: "answer" | "decline" | "cancel",
    response?: unknown,
  ): PendingActionResult;
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
        onCancel={() =>
          props.onResolveQuestion(props.part.questionId, "cancel", {
            system: false,
            reasonCode: "user_canceled",
          })
        }
      />
    );
  }

  const canceled = status === "canceled";
  const declined = status === "declined";
  const unresolved = declined || canceled;
  const rows = unresolved
    ? questionPages(props.part).map((page) => ({ id: page.id, prompt: page.title, answer: "" }))
    : questionAnswerRows(props.part, t);
  return (
    <section
      className={clsx("thread-question-summary", unresolved ? "is-declined" : "is-answered")}
      aria-label={unresolved ? t("activity.skippedQuestionAria") : t("activity.answeredQuestionAria")}
    >
      {rows.map((row) => (
        <div className="thread-question-summary-item" key={row.id}>
          <div className="thread-question-summary-prompt">{row.prompt}</div>
          <div className="thread-question-summary-answer">
            {canceled ? t("activity.runCanceled") : declined ? t("activity.skipped") : row.answer}
          </div>
        </div>
      ))}
    </section>
  );
}

export function ApprovalInteractionCard(props: {
  part: ToolPart;
  onResolveApproval(
    approvalId: string,
    action: "approve" | "reject" | "cancel",
    response?: unknown,
  ): PendingActionResult;
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
  onAnswer(answer: QuestionAnswers): PendingActionResult;
  onDecline(): PendingActionResult;
  onCancel(): PendingActionResult;
}) {
  return (
    <SharedChatProvider>
      <QuestionForm
        key={props.part.questionId}
        questions={questionPages(props.part)}
        title={questionPromptLabel(props.part)}
        disabledReason={props.disabledReason}
        onAnswer={props.onAnswer}
        onDecline={props.onDecline}
        onCancel={props.onCancel}
      />
    </SharedChatProvider>
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
