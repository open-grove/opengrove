import type { StoredMessage } from "../../bridge";
import { ListChecks, Plus } from "lucide-react";
import { createEmptyWorkingState } from "../../format";
import { useI18n } from "../../i18n";
import { EmptyState } from "../ui/empty-state";
import "./overview.css";
import {
  OverviewMetaRow,
  OverviewProgressRow,
  OverviewResultRow,
  OverviewSourceRow,
  buildOverviewProgressItems,
  buildOverviewResultItems,
  buildOverviewRuntimeItems,
  buildOverviewSourceItems,
  filterOverviewArtifacts,
} from "./overview-model";

export function WorkspaceInspector(props: {
  workingState: any;
  currentSession: any;
  latestRun: any;
  runtimeBlocker: any;
  kernelLabel?: string;
  threadId: string;
  sending: boolean;
  messages: StoredMessage[];
  artifacts: any[];
  skills: any[];
  tools: any[];
  events: any[];
  pendingApprovals: any[];
  onOpenChat(): void;
  onOpenPendingApprovals?(): void;
}) {
  const { t } = useI18n();
  const hasThreadActivity = props.messages.length > 0 || props.sending;
  const currentRun = hasThreadActivity ? props.latestRun : null;
  const currentSession = hasThreadActivity ? props.currentSession : null;
  const effectiveWorkingState = hasThreadActivity ? props.workingState : createEmptyWorkingState();
  const threadArtifacts = hasThreadActivity
    ? filterOverviewArtifacts(props.artifacts, props.messages, props.threadId, currentRun?.id || "")
    : [];
  const threadEvents = currentRun?.id
    ? props.events.filter((event) => event?.runId === currentRun.id)
    : hasThreadActivity
      ? props.events
      : [];
  const progressItems = buildOverviewProgressItems({
    messages: props.messages,
    workingState: effectiveWorkingState,
    latestRun: currentRun,
    pendingApprovals: props.pendingApprovals,
    events: threadEvents,
    runtimeBlocker: props.runtimeBlocker,
    hasThreadActivity,
    sending: props.sending,
  });
  const resultItems = buildOverviewResultItems(threadArtifacts);
  const sourceItems = buildOverviewSourceItems({
    messages: props.messages,
    workingState: effectiveWorkingState,
    latestRun: currentRun,
    skills: props.skills,
    tools: props.tools,
    events: threadEvents,
    kernelLabel: props.kernelLabel,
    hasThreadActivity,
  });
  const completedCount = progressItems.filter((item) => item.status === "done").length;
  const progressSubtitle = !hasThreadActivity
    ? t("workspace.noProgressYet")
    : progressItems.length
      ? t("workspace.progressSummary", { total: progressItems.length, done: completedCount })
      : t("workspace.noProgressYet");
  const runtimeItems = buildOverviewRuntimeItems({
    currentSession,
    latestRun: currentRun,
    runtimeBlocker: props.runtimeBlocker,
    kernelLabel: props.kernelLabel,
    pendingApprovals: props.pendingApprovals,
    messageCount: props.messages.length,
    sending: props.sending,
  });

  return (
    <div className="overview-panel">
      <div className="overview-toolbar">
        <div className="overview-tab">
          <ListChecks size={16} />
          <span>{t("workspace.overviewTab")}</span>
        </div>
        <div className="overview-toolbar-actions">
          <button
            className="overview-icon-button"
            type="button"
            onClick={props.onOpenChat}
            title={t("workspace.addTask")}
            aria-label={t("workspace.addTask")}
          >
            <Plus size={17} />
          </button>
        </div>
      </div>

      <section className="overview-section">
        <div className="overview-section-title">{t("workspace.currentStatus")}</div>
        <div className="overview-meta-list">
          {runtimeItems.map((item) => (
            <OverviewMetaRow
              key={item.id}
              item={item}
              onOpen={item.id === "approval" ? props.onOpenPendingApprovals : undefined}
            />
          ))}
        </div>
      </section>

      <section className="overview-section">
        <div className="overview-section-title">{t("workspace.progress")}</div>
        <div className="overview-progress-subtitle">{progressSubtitle}</div>
        <div className="overview-progress-list">
          {progressItems.length ? (
            progressItems.map((item) => <OverviewProgressRow key={item.id} item={item} />)
          ) : (
            <EmptyState compact title={t("workspace.overviewProgressEmpty")} />
          )}
        </div>
      </section>

      <section className="overview-section">
        <div className="overview-section-title">{t("workspace.results")}</div>
        <div className="overview-result-list">
          {resultItems.visible.length ? (
            resultItems.visible.map((item) => <OverviewResultRow key={item.id} item={item} />)
          ) : (
            <EmptyState compact title={t("workspace.overviewResultsEmpty")} />
          )}
        </div>
        {resultItems.hiddenCount > 0 ? (
          <div className="overview-more">{t("workspace.showMoreCount", { count: resultItems.hiddenCount })}</div>
        ) : null}
      </section>

      <section className="overview-section">
        <div className="overview-section-title">{t("workspace.sources")}</div>
        <div className="overview-source-list">
          {sourceItems.length ? (
            sourceItems.map((item) => <OverviewSourceRow key={item.id} item={item} />)
          ) : (
            <EmptyState compact title={t("workspace.overviewSourcesEmpty")} />
          )}
        </div>
      </section>
    </div>
  );
}
