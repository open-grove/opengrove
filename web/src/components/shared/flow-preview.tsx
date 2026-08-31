import { AlertTriangle, CheckCircle2, Circle, Clock3, Loader2 } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type {
  EventsResponse,
  MountedAppFlowFrontmatter,
  MountedAppFlowStep,
  MountedAppFlowStepStatus,
  MountedAppFlowStatus,
} from "../../bridge";
import { useI18n, type TranslationFn } from "../../i18n";
import { useAgentEventsQuery } from "../../runtime/use-agent-events-query";
import { MarkdownPreview } from "../knowledge/markdown-preview";
import { extractFlowLiveTodos, type FlowLiveTodo, type FlowLiveTodoStatus } from "./flow-live-todos";

export function FlowPreview(props: { text: string }) {
  const { t } = useI18n();
  const parsed = parseFlowPreviewMarkdown(props.text);
  if (!parsed.valid || !parsed.frontmatter) {
    return (
      <div className="flow-preview">
        <div className="flow-invalid-banner">
          <AlertTriangle size={16} />
          <span>{t("flowPreview.invalidFrontmatter")}</span>
        </div>
        {parsed.issues.length ? (
          <ul className="flow-invalid-issues">
            {parsed.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
        <MarkdownPreview text={props.text} format="markdown" />
      </div>
    );
  }

  return <ValidFlowPreview body={parsed.body} flow={parsed.frontmatter} />;
}

function ValidFlowPreview(props: { body: string; flow: MountedAppFlowFrontmatter }) {
  const { t } = useI18n();
  const flow = props.flow;
  const steps = flow.steps ?? [];
  const activityRunIds = [
    ...new Set(steps.map((step) => stringValue(step.activityRunId)).filter((value): value is string => Boolean(value))),
  ].sort();
  const live = steps.some(
    (step) => Boolean(stringValue(step.activityRunId)) && (step.status === "running" || step.status === "waiting"),
  );
  const eventsQuery = useAgentEventsQuery({
    enabled: activityRunIds.length > 0,
    scopeKey: `flow:${activityRunIds.join(",")}`,
    runIds: activityRunIds,
    refetchInterval: live ? 1_000 : false,
    longPoll: live,
  });
  const events = eventsQuery.data?.events ?? [];
  const doneCount = steps.filter((step) => step.status === "done").length;
  const progress = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;
  const blockingStep = steps.find((step) => step.blocking || step.status === "waiting");

  return (
    <div className="flow-preview">
      <header className="flow-preview-header">
        <div>
          <span className="flow-preview-kicker">Flow</span>
          <h1>{flow.title}</h1>
          <p>
            {flow.initiator ? t("flowPreview.initiator", { name: flow.initiator }) : t("mountedApp.workflows")}
            {flow.updated ? ` · ${t("flowPreview.updated", { time: flow.updated })}` : ""}
          </p>
        </div>
        <span className="flow-status-badge" data-status={flow.status}>
          {flowStatusLabel(flow.status, t)}
        </span>
      </header>

      <div className="flow-progress" aria-label={t("flowPreview.progressLabel", { progress })}>
        <span style={{ width: `${progress}%` }} />
      </div>

      {blockingStep ? (
        <div className="flow-blocking-banner">
          <Clock3 size={16} />
          <span>{t("flowPreview.waitingOwner", { owner: blockingStep.owner, title: blockingStep.title })}</span>
        </div>
      ) : null}

      <ol className="flow-steps">
        {steps.map((step, index) => (
          <li className="flow-step" data-status={step.status} key={step.id || index}>
            <span className="flow-step-icon">{flowStepIcon(step.status)}</span>
            <div>
              <strong>{step.title}</strong>
              <span>
                {step.owner} · {flowStepStatusLabel(step.status, t)}
              </span>
              <FlowStepActivity
                events={events}
                loading={eventsQuery.isLoading}
                failed={eventsQuery.isError}
                step={step}
              />
              {step.note ? <p>{step.note}</p> : null}
            </div>
          </li>
        ))}
      </ol>

      {props.body.trim() ? (
        <section className="flow-body">
          <MarkdownPreview text={props.body} format="markdown" />
        </section>
      ) : null}
    </div>
  );
}

function FlowStepActivity(props: {
  step: MountedAppFlowStep;
  events: EventsResponse["events"];
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useI18n();
  const activityRunId = stringValue(props.step.activityRunId);
  const live = props.step.status === "running" || props.step.status === "waiting";
  const events = useMemo(
    () => props.events.filter((event) => event.runId === activityRunId),
    [activityRunId, props.events],
  );
  const todos = useMemo(() => extractFlowLiveTodos(events), [events]);

  if (!activityRunId) return null;
  if (todos.length) {
    return (
      <details className="flow-step-live-todos" open={live}>
        <summary>{t("flowPreview.liveTodos")}</summary>
        <FlowTodoList todos={todos} />
      </details>
    );
  }

  return (
    <details className="flow-step-activity-ref">
      <summary>{t("flowPreview.workerActivity")}</summary>
      <p>
        {props.failed
          ? t("flowPreview.activityLoadFailed")
          : props.loading
            ? t("flowPreview.activityLoading")
            : t("flowPreview.activityEmpty")}
      </p>
    </details>
  );
}

function FlowTodoList(props: { todos: FlowLiveTodo[] }) {
  return (
    <ul className="flow-step-todo-list">
      {props.todos.map((todo, index) => (
        <li data-status={todo.status} key={`${todo.status}-${index}-${todo.content}`}>
          <span aria-hidden="true">{todoStatusMark(todo.status)}</span>
          <span>{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}

function todoStatusMark(status: FlowLiveTodoStatus): string {
  if (status === "completed") return "☑";
  if (status === "in_progress") return "◌";
  return "○";
}

function flowStepIcon(status: MountedAppFlowStepStatus): ReactNode {
  if (status === "done") return <CheckCircle2 size={16} />;
  if (status === "running") return <Loader2 size={16} />;
  if (status === "waiting") return <Clock3 size={16} />;
  if (status === "failed") return <AlertTriangle size={16} />;
  return <Circle size={16} />;
}

function flowStatusLabel(status: MountedAppFlowStatus, t: TranslationFn): string {
  switch (status) {
    case "pending":
      return t("mountedApp.flowPending");
    case "running":
      return t("mountedApp.flowRunning");
    case "waiting_user":
      return t("mountedApp.flowWaitingUser");
    case "done":
      return t("mountedApp.flowDone");
    case "failed":
      return t("mountedApp.flowFailed");
  }
}

function flowStepStatusLabel(status: MountedAppFlowStepStatus, t: TranslationFn): string {
  switch (status) {
    case "pending":
      return t("mountedApp.flowPending");
    case "running":
      return t("mountedApp.flowRunning");
    case "waiting":
      return t("flowPreview.stepWaiting");
    case "done":
      return t("mountedApp.flowDone");
    case "failed":
      return t("mountedApp.flowFailed");
  }
}

function parseFlowPreviewMarkdown(text: string): {
  body: string;
  frontmatter?: MountedAppFlowFrontmatter;
  issues: string[];
  valid: boolean;
} {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { body: normalized, issues: ["missing frontmatter"], valid: false };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return { body: normalized, issues: ["frontmatter is not closed"], valid: false };
  }
  const raw = parseFlowFrontmatterYaml(normalized.slice(4, end));
  const issues = validateFlowFrontmatter(raw);
  return {
    body: normalized.slice(end + 5).trimStart(),
    frontmatter: issues.length ? undefined : (raw as MountedAppFlowFrontmatter),
    issues,
    valid: issues.length === 0,
  };
}

function parseFlowFrontmatterYaml(text: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const steps: Record<string, unknown>[] = [];
  let inSteps = false;
  let currentStep: Record<string, unknown> | undefined;

  for (const line of text.split("\n")) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (inSteps) {
      const stepStart = line.match(/^\s{2}-\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (stepStart) {
        currentStep = {};
        currentStep[stepStart[1] || ""] = parseYamlScalar(stepStart[2] || "");
        steps.push(currentStep);
        continue;
      }
      const stepProperty = line.match(/^\s{4}([A-Za-z0-9_-]+):\s*(.*)$/);
      if (stepProperty && currentStep) {
        currentStep[stepProperty[1] || ""] = parseYamlScalar(stepProperty[2] || "");
        continue;
      }
    }
    const topLevel = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!topLevel) continue;
    const key = topLevel[1] || "";
    if (key === "steps") {
      inSteps = true;
      output.steps = steps;
      continue;
    }
    inSteps = false;
    output[key] = parseYamlScalar(topLevel[2] || "");
  }
  return output;
}

function validateFlowFrontmatter(value: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (value.flow !== "v1") issues.push("flow must be v1");
  if (!stringValue(value.title)) issues.push("title is required");
  if (!isFlowStatus(value.status)) issues.push("status is invalid");
  const steps = Array.isArray(value.steps) ? (value.steps as Record<string, unknown>[]) : [];
  if (!steps.length) issues.push("steps must contain at least one step");
  for (const [index, step] of steps.entries()) {
    if (!stringValue(step.id)) issues.push(`steps.${index}.id is required`);
    if (!stringValue(step.title)) issues.push(`steps.${index}.title is required`);
    if (!stringValue(step.owner)) issues.push(`steps.${index}.owner is required`);
    if (!isFlowStepStatus(step.status)) issues.push(`steps.${index}.status is invalid`);
  }
  return issues;
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isFlowStatus(value: unknown): value is MountedAppFlowStatus {
  return (
    value === "pending" || value === "running" || value === "waiting_user" || value === "done" || value === "failed"
  );
}

function isFlowStepStatus(value: unknown): value is MountedAppFlowStepStatus {
  return value === "pending" || value === "running" || value === "waiting" || value === "done" || value === "failed";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
