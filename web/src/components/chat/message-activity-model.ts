import type { ReasoningPart, SkillPart, ToolPart } from "../../bridge";
import { formatJson, summarize } from "../../format";
import { visitSafeJsonValues } from "../../safe-json";
import { translate } from "../../i18n";
import { dictionaries } from "../../i18n-dictionaries";
import { apiUrl } from "../../api-base";

export type ActivityItem =
  | { type: "skill"; key: string; part: SkillPart }
  | { type: "reasoning"; key: string; part: ReasoningPart }
  | { type: "question"; key: string; part: ToolPart }
  | { type: "approval"; key: string; part: ToolPart }
  | { type: "tool"; key: string; call?: ToolPart; result?: ToolPart };

export interface ActivityEntry {
  groupKey: string;
  item: ActivityItem;
}

export type ActivityRenderNode =
  | { type: "item"; entry: ActivityEntry }
  | { type: "exploration"; key: string; entries: ActivityEntry[] }
  | { type: "edit"; key: string; entries: ActivityEntry[] }
  | { type: "command"; key: string; entries: ActivityEntry[] }
  | { type: "skill"; key: string; entries: ActivityEntry[] };

const EXPLORATION_KINDS = new Set(["read", "search"]);
const CLAUDE_NATIVE_TOOL_KIND: Record<string, string> = {
  bash: "command",
  bashoutput: "command",
  monitor: "monitor",
  killshell: "command",
  read: "read",
  notebookread: "read",
  glob: "search",
  grep: "search",
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  notebookedit: "edit",
  webfetch: "browser",
  websearch: "search",
  todowrite: "planning",
  exitplanmode: "planning",
  agent: "agent",
  task: "agent",
  slashcommand: "tool",
};

function clusterTypeForEntry(entry: ActivityEntry): "exploration" | "edit" | "command" | "skill" | null {
  if (activityItemKind(entry.item) === "skill") return "skill";
  if (entry.item.type !== "tool") return null;
  const kind = activityItemKind(entry.item);
  if (EXPLORATION_KINDS.has(kind)) return "exploration";
  if (kind === "edit") return "edit";
  if (kind === "command" || kind === "monitor") return "command";
  return null;
}

// Collapse read/search, command, and edit activity into expandable clusters,
// matching Codex desktop's activity accordions. Concrete commands, file names,
// and line counts stay one level lower than the aggregate row.
export function buildActivityRenderNodes(entries: ActivityEntry[]): ActivityRenderNode[] {
  const nodes: ActivityRenderNode[] = [];
  let cluster: ActivityEntry[] = [];
  let clusterType: "exploration" | "edit" | "command" | "skill" | null = null;

  const flush = () => {
    if (!clusterType) return;
    if (cluster.length) {
      nodes.push({
        type: clusterType,
        key: `${clusterType}-${cluster[0]?.item.key ?? nodes.length}`,
        entries: cluster,
      });
    }
    cluster = [];
    clusterType = null;
  };

  for (const entry of entries) {
    const nextClusterType = clusterTypeForEntry(entry);
    if (nextClusterType) {
      if (clusterType && clusterType !== nextClusterType) {
        flush();
      }
      clusterType = nextClusterType;
      cluster.push(entry);
      continue;
    }
    flush();
    nodes.push({ type: "item", entry });
  }
  flush();
  return nodes;
}

export interface ChoiceFormOption {
  value: string;
  label: string;
  description: string;
  action?: "submit" | "insert";
}

export interface ChoiceFormQuestion {
  id: string;
  prompt: string;
  options: ChoiceFormOption[];
}

export interface ChoiceForm {
  title: string;
  instructions: string;
  submitLabel: string;
  questions: ChoiceFormQuestion[];
}

export interface ActivityArtifactCard {
  id: string;
  title: string;
  kind: string;
  summary: string;
  uri: string;
  imageUri: string;
  path: string;
  mimeType?: string;
  knowledgeId?: string;
}

export function buildActivityItems(parts: Array<ToolPart | SkillPart | ReasoningPart>): ActivityItem[] {
  const items: ActivityItem[] = [];
  const usedResultIndexes = new Set<number>();
  const resultIndexByCallIndex = new Map<number, number>();

  // Reserve every unambiguous native-ID match first. This prevents a legacy or
  // partially persisted row from stealing the result of a concurrent call.
  parts.forEach((part, callIndex) => {
    if (part.type !== "tool" || part.phase !== "call" || !part.callId) return;
    const resultIndex = parts.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > callIndex &&
        candidate.type === "tool" &&
        candidate.phase === "result" &&
        candidate.callId === part.callId &&
        !usedResultIndexes.has(candidateIndex),
    );
    if (resultIndex < 0) return;
    resultIndexByCallIndex.set(callIndex, resultIndex);
    usedResultIndexes.add(resultIndex);
  });

  // Compatibility for legacy and mid-rollout records: pair by tool FIFO only
  // when at least one side lacks callId. Two conflicting native IDs stay apart.
  parts.forEach((part, callIndex) => {
    if (part.type !== "tool" || part.phase !== "call" || resultIndexByCallIndex.has(callIndex)) return;
    const resultIndex = parts.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > callIndex &&
        candidate.type === "tool" &&
        candidate.phase === "result" &&
        candidate.toolId === part.toolId &&
        (!part.callId || !candidate.callId) &&
        !usedResultIndexes.has(candidateIndex),
    );
    if (resultIndex < 0) return;
    resultIndexByCallIndex.set(callIndex, resultIndex);
    usedResultIndexes.add(resultIndex);
  });

  parts.forEach((part, index) => {
    if (part.type === "skill") {
      items.push({ type: "skill", key: part.id, part });
      return;
    }

    if (part.type === "reasoning") {
      items.push({ type: "reasoning", key: part.id, part });
      return;
    }

    if (part.phase === "question") {
      items.push({ type: "question", key: part.id, part });
      return;
    }

    if (part.phase === "approval") {
      items.push({ type: "approval", key: part.id, part });
      return;
    }

    if (part.phase === "call") {
      const resultIndex = resultIndexByCallIndex.get(index);
      const result =
        resultIndex !== undefined && parts[resultIndex]?.type === "tool" ? (parts[resultIndex] as ToolPart) : undefined;
      items.push({ type: "tool", key: result ? `${part.id}:${result.id}` : part.id, call: part, result });
      return;
    }

    if (part.phase === "result" && !usedResultIndexes.has(index)) {
      items.push({ type: "tool", key: part.id, result: part });
    }
  });

  return items;
}

export function choiceFormFromItem(item: ActivityItem): ChoiceForm | null {
  if (item.type !== "tool") {
    return null;
  }
  const value = recordValue(item.result?.result);
  if (stringValue(value.kind) !== "choice_form") {
    return null;
  }
  const questions = Array.isArray(value.questions)
    ? value.questions
        .map((question, index) => {
          const questionValue = recordValue(question);
          const options = Array.isArray(questionValue.options)
            ? questionValue.options
                .map((option, optionIndex) => {
                  const optionValue = recordValue(option);
                  const label = stringValue(optionValue.label);
                  if (!label) {
                    return null;
                  }
                  const action = choiceFormOptionAction(optionValue.action);
                  return {
                    value: stringValue(optionValue.value) || String(optionIndex + 1),
                    label,
                    description: stringValue(optionValue.description),
                    ...(action ? { action } : {}),
                  } satisfies ChoiceFormOption;
                })
                .filter((option): option is ChoiceFormOption => Boolean(option))
            : [];
          const prompt = stringValue(questionValue.prompt);
          if (!prompt || !options.length) {
            return null;
          }
          return {
            id: stringValue(questionValue.id) || `q${index + 1}`,
            prompt,
            options,
          };
        })
        .filter((question): question is ChoiceFormQuestion => Boolean(question))
    : [];
  if (!questions.length) {
    return null;
  }
  return {
    title: stringValue(value.title) || translate("activity.pleaseChoose"),
    instructions: stringValue(value.instructions),
    submitLabel: stringValue(value.submitLabel) || translate("activity.submit"),
    questions,
  };
}

function choiceFormOptionAction(value: unknown): ChoiceFormOption["action"] {
  return value === "insert" ? "insert" : value === "submit" ? "submit" : undefined;
}

export function summarizeActivityItems(
  items: ActivityItem[],
  options: {
    active?: boolean;
    pendingQuestion?: boolean;
    pendingApproval?: boolean;
    activeChoiceForm?: boolean;
    fallbackStatus?: string;
    includeReasoning?: boolean;
  } = {},
): string {
  if (options.pendingQuestion) {
    return translate("activity.waitingAnswer");
  }
  if (options.pendingApproval) {
    return translate("activity.waitingConfirm");
  }
  if (options.activeChoiceForm) {
    return translate("activity.waitingChoice");
  }
  const stats = activityStats(items);
  const fragments: string[] = [];

  if (options.active) {
    return activeActivitySummary(items);
  }

  if (stats.readCount) {
    fragments.push(translate("activity.exploredFiles", { count: stats.readCount }));
  }
  if (stats.searchCount) {
    fragments.push(translate("activity.searchCount", { count: stats.searchCount }));
  }
  if (stats.skillNames.length === 1) {
    fragments.push(translate("activity.usedSkill", { name: stats.skillNames[0]! }));
  } else if (stats.skillNames.length > 1) {
    fragments.push(translate("activity.usedSkills", { count: stats.skillNames.length }));
  }
  if (stats.browseCount) {
    fragments.push(translate("activity.browseCount", { count: stats.browseCount }));
  }
  if (options.includeReasoning !== false && stats.reasoningCount) {
    const reasoningElapsed = formatElapsedMs(stats.reasoningElapsedMs);
    const base =
      stats.reasoningCount === 1
        ? translate("activity.thought")
        : translate("activity.thoughtCount", { count: stats.reasoningCount });
    fragments.push(reasoningElapsed ? `${base} · ${reasoningElapsed}` : base);
  }
  if (stats.commandCount) {
    fragments.push(translate("activity.ranCommands", { count: stats.commandCount }));
  }
  if (stats.monitorCount) {
    fragments.push(
      stats.monitorCount === 1
        ? activityItemTitle(items.find((item) => activityItemKind(item) === "monitor")!)
        : translate("activity.monitoredTasks", { count: stats.monitorCount }),
    );
  }
  if (stats.agentCount) {
    fragments.push(
      stats.agentCount === 1
        ? translate("activity.delegatedAgent")
        : translate("activity.delegatedAgents", { count: stats.agentCount }),
    );
  }
  if (stats.editCount) {
    fragments.push(translate("activity.editedFiles", { count: stats.editCount }));
  }
  if (stats.memoryCount) {
    fragments.push(translate("activity.processedMemories", { count: stats.memoryCount }));
  }
  if (stats.artifactCount) {
    fragments.push(translate("activity.producedArtifacts", { count: stats.artifactCount }));
  }
  if (stats.planCount) {
    fragments.push(
      stats.planCount === 1
        ? translate("activity.updatedPlan")
        : translate("activity.updatedPlanCount", { count: stats.planCount }),
    );
  }
  if (stats.choiceFormCount) {
    fragments.push(translate("activity.choiceFormCount", { count: stats.choiceFormCount }));
  }
  if (stats.questionCount) {
    fragments.push(translate("activity.questionCount", { count: stats.questionCount }));
  }
  if (stats.approvalCount) {
    fragments.push(translate("activity.approvalCount", { count: stats.approvalCount }));
  }
  if (stats.problemCount) {
    fragments.push(
      stats.problemCount === 1
        ? translate("activity.oneError")
        : translate("activity.errorCount", { count: stats.problemCount }),
    );
  }

  if (!fragments.length) {
    if (options.fallbackStatus) {
      fragments.push(options.fallbackStatus);
    } else if (items.length === 1 && items[0]) {
      fragments.push(activityItemTitle(items[0]));
    } else {
      fragments.push(translate("activity.processedItems", { count: items.length }));
    }
  }

  return fragments.join(" ");
}

function activityStats(items: ActivityItem[]) {
  const skillNames = uniqueStrings(items.filter((item) => activityItemKind(item) === "skill").map(activitySkillName));
  return {
    skillNames,
    searchCount: items.filter((item) => activityItemKind(item) === "search").length,
    readCount: items.filter((item) => activityItemKind(item) === "read").length,
    browseCount: items.filter((item) => activityItemKind(item) === "browser").length,
    reasoningCount: items.filter((item) => activityItemKind(item) === "reasoning").length,
    commandCount: items.filter((item) => activityItemKind(item) === "command").length,
    monitorCount: items.filter((item) => activityItemKind(item) === "monitor").length,
    agentCount: items.filter((item) => activityItemKind(item) === "agent").length,
    editCount: countEditedFiles(items),
    reasoningElapsedMs: aggregateReasoningElapsedMs(items),
    planCount: items.filter((item) => activityItemKind(item) === "planning").length,
    memoryCount: items.filter((item) => activityItemKind(item) === "memory").length,
    artifactCount: items.filter((item) => activityItemKind(item) === "artifact").length,
    choiceFormCount: items.filter((item) => Boolean(choiceFormFromItem(item))).length,
    questionCount: items.filter((item) => item.type === "question" && item.part.questionStatus === "pending").length,
    approvalCount: items.filter((item) => item.type === "approval" && item.part.approvalStatus === "pending").length,
    problemCount: items.filter((item) =>
      ["blocked", "incomplete", "rejected", "failed", "error"].includes(activityItemStatus(item)),
    ).length,
  };
}

function activeActivitySummary(items: ActivityItem[]): string {
  const runningItem = items.find((item) => activityItemStatus(item) === "running") || items[0];
  if (!runningItem) return "";
  const target = activityTargetLabel(runningItem);
  switch (activityItemKind(runningItem)) {
    case "search":
      return target ? translate("activity.searchingTarget", { target }) : translate("activity.searchingFiles");
    case "read":
      return target ? translate("activity.readingTarget", { target }) : translate("activity.readingFiles");
    case "edit":
      return target ? translate("activity.editingTarget", { target }) : translate("activity.editingFiles");
    case "command":
      return target ? translate("activity.runningTarget", { target }) : translate("activity.runningCommand");
    case "monitor":
      return target ? translate("activity.monitoringTarget", { target }) : translate("activity.monitoringTask");
    case "agent":
      return target ? translate("activity.delegatingTarget", { target }) : translate("activity.delegatingAgent");
    case "browser":
      return target ? translate("activity.browsingTarget", { target }) : translate("activity.browsingPage");
    case "reasoning":
      return translate("activity.thinking");
    case "memory":
      return translate("activity.processingMemory");
    case "artifact":
      return translate("activity.generatingResult");
    case "planning":
      return translate("activity.updatingPlan");
    case "skill":
      return translate("activity.loadingSkill");
    default:
      return translate("activity.processingGeneric");
  }
}

export function primaryActivityKind(items: ActivityItem[]): string {
  const runningItem = items.find((item) => activityItemStatus(item) === "running");
  if (runningItem) {
    return activityItemKind(runningItem);
  }
  const priority = [
    "question",
    "planning",
    "agent",
    "edit",
    "search",
    "read",
    "monitor",
    "command",
    "browser",
    "reasoning",
    "artifact",
    "memory",
    "skill",
    "approval",
  ];
  return priority.find((kind) => items.some((item) => activityItemKind(item) === kind)) || "tool";
}

function countEditedFiles(items: ActivityItem[]): number {
  const editItems = items.filter((item) => activityItemKind(item) === "edit");
  const files = uniqueStrings(editItems.flatMap(activityItemFileHints));
  return files.length || editItems.length;
}

export function activityItemTitle(item: ActivityItem): string {
  const status = activityItemStatus(item);
  if (item.type === "skill") {
    const name = item.part.skillName || item.part.title || item.part.skillId || "skill";
    return `${status === "running" ? translate("activity.loadingPrefix") : translate("activity.usedPrefix")} /${name.replace(/^\//, "")}`;
  }
  if (item.type === "reasoning") {
    if (status === "running") return translate("activity.thinking");
    const elapsed = formatElapsedMs(item.part.elapsedMs);
    return elapsed ? translate("activity.thoughtElapsed", { elapsed }) : translate("activity.thought");
  }
  if (item.type === "approval") {
    const label = cleanToolLabel(item.part.title, item.part.toolId, translate("activity.action"));
    if (item.part.approvalStatus === "pending") {
      return translate("activity.waitingConfirmLabel", { label });
    }
    if (item.part.approvalStatus === "approved") {
      return translate("activity.confirmedLabel", { label });
    }
    if (item.part.approvalStatus === "canceled") {
      return translate("activity.canceledLabel", { label });
    }
    if (approvalTimedOut(item.part)) {
      return translate("activity.timeoutLabel", { label });
    }
    return translate("activity.rejectedLabel", { label });
  }
  if (item.type === "question") {
    const questionTitle = item.part.title || translate("activity.question");
    if (item.part.questionStatus === "pending") {
      return translate("activity.waitingAnswerTitle", { title: questionTitle });
    }
    if (item.part.questionStatus === "answered") {
      return translate("activity.answeredTitle", { title: questionTitle });
    }
    return item.part.questionStatus === "canceled"
      ? translate("activity.canceledTitle", { title: questionTitle })
      : translate("activity.skippedTitle", { title: questionTitle });
  }

  const tool = item.call || item.result;
  const kind = activityItemKind(item);
  const target = activityTargetLabel(item);
  if (kind === "skill") {
    return statusAwareTitle(
      status,
      translate("activity.loadingPrefix"),
      translate("activity.usedPrefix"),
      target || "skill",
    );
  }
  if (kind === "monitor") {
    return statusAwareTitle(
      status,
      translate("activity.monitoringPrefix"),
      translate("activity.monitoredPrefix"),
      target || translate("activity.backgroundTask"),
    );
  }
  const codexTitle = codexNativeActivityTitle(item, status);
  if (codexTitle) return codexTitle;
  if (kind === "search")
    return statusAwareTitle(
      status,
      translate("activity.searchingPrefix"),
      translate("activity.searchedPrefix"),
      target || translate("activity.fileWith", { preview: toolPreview(tool) }),
    );
  if (kind === "read")
    return statusAwareTitle(
      status,
      translate("activity.readingPrefix"),
      translate("activity.readPrefix"),
      target || translate("activity.fileWith", { preview: filePreview(item) }),
    );
  if (kind === "command")
    return statusAwareTitle(
      status,
      translate("activity.runningPrefix"),
      translate("activity.ranPrefix"),
      target || translate("activity.commandWith", { preview: toolPreview(tool) }),
    );
  if (kind === "edit")
    return statusAwareTitle(
      status,
      translate("activity.editingPrefix"),
      translate("activity.editedPrefix"),
      target || translate("activity.fileWith", { preview: filePreview(item) }),
    );
  if (kind === "browser")
    return statusAwareTitle(
      status,
      translate("activity.browsingPrefix"),
      translate("activity.browsedPrefix"),
      target || translate("activity.webWith", { preview: toolPreview(tool) }),
    );
  if (kind === "agent") return claudeAgentActivityTitle(item, status);
  if (kind === "reasoning") {
    if (status === "running") return translate("activity.thinking");
    const elapsed = formatElapsedMs(activityItemElapsedMs(item));
    return elapsed ? translate("activity.thoughtElapsed", { elapsed }) : translate("activity.thought");
  }
  if (kind === "memory")
    return statusAwareTitle(
      status,
      translate("activity.processingPrefix"),
      translate("activity.processedPrefix"),
      translate("activity.memoryWith", { preview: toolPreview(tool) }),
    );
  if (kind === "artifact")
    return statusAwareTitle(
      status,
      translate("activity.generatingPrefix"),
      translate("activity.generatedPrefix"),
      translate("activity.resultWith", { preview: toolPreview(tool) }),
    );
  if (kind === "planning")
    return statusAwareTitle(
      status,
      translate("activity.planningPrefix"),
      translate("activity.plannedPrefix"),
      toolPreview(tool),
    );
  return statusAwareTitle(
    status,
    translate("activity.callingPrefix"),
    translate("activity.calledPrefix"),
    cleanToolLabel(tool?.title, tool?.toolId, translate("activity.tool")),
  );
}

function statusAwareTitle(status: string, runningPrefix: string, completedPrefix: string, label: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "running") {
    return `${runningPrefix} ${label}`;
  }
  if (["blocked", "incomplete", "rejected", "failed", "error"].includes(normalized)) {
    return translate("activity.incompleteLabel", { label });
  }
  return `${completedPrefix} ${label}`;
}

export function activityItemDetail(item: ActivityItem): string {
  return activityItemDetailDisplay(item)?.label || "";
}

export function artifactCardsFromItem(item: ActivityItem): ActivityArtifactCard[] {
  if (item.type !== "tool") {
    return [];
  }
  // Monitor inputs often contain shell commands and absolute paths. They are runtime
  // plumbing, not user deliverables, so never turn them into artifact cards.
  if (activityItemKind(item) === "monitor") {
    return [];
  }
  // Edits already surface their file(s) via the dedicated edit row (editActivityInfo / editResources).
  // Running the generic artifact extractor over an edit's tool result also picks up incidental fields
  // (e.g. the tool-call id) and renders a stray "文件" card — suppress it here.
  if (activityItemKind(item) === "edit") {
    return [];
  }
  if (failedWorkflowCreateItem(item)) {
    return [];
  }
  const workflowCard = workflowCreateArtifactCard(item);
  if (workflowCard) {
    return [workflowCard];
  }
  const values = [item.result?.result, item.call?.result, item.result?.input, item.call?.input].filter(
    (value) => value !== undefined,
  );
  const cards = uniqueArtifactCards(values.flatMap((value) => extractArtifactCardsFromValue(value)));
  if (cards.length) {
    return cards.slice(0, 6);
  }
  if (activityItemKind(item) !== "artifact") {
    return [];
  }
  return activityItemFileHints(item)
    .slice(0, 6)
    .map((path, index) => ({
      id: `file:${path}:${index}`,
      title: pathBaseName(path) || path,
      kind: translate("activity.file"),
      summary: path,
      uri: "",
      imageUri: "",
      path,
    }));
}

export function activityItemDetailDisplay(
  item: ActivityItem,
  options: { full?: boolean } = {},
): { label: string; title?: string } | null {
  if (item.type === "skill") {
    const text = item.part.description || item.part.contentPreview || item.part.source || "";
    const label = options.full ? compactMultilineDetail(text) : summarize(text, 150);
    return label ? { label } : null;
  }
  if (item.type === "reasoning") {
    const label = options.full ? compactMultilineDetail(item.part.text) : summarize(item.part.text, 160);
    return label ? { label } : null;
  }
  if (item.type === "approval") {
    const workflowSummary = workflowCreateApprovalSummary(item.part);
    if (approvalTimedOut(item.part)) {
      const suffix = workflowSummary?.label ? ` · ${workflowSummary.label}` : "";
      return {
        label: `${translate("activity.approvalTimeoutDetail")}${suffix}`,
        title: workflowSummary?.title,
      };
    }
    if (workflowSummary) {
      return workflowSummary;
    }
    const text = item.part.approvalReason || commandText(item.part) || structuredTargetLabel(item.part);
    const label = options.full ? compactMultilineDetail(text) : summarize(text, 150);
    return label ? { label } : null;
  }
  if (item.type === "question") {
    const text = item.part.questionPrompt || formatMessageValue(item.part.questionInput ?? item.part.input);
    const label = options.full ? compactMultilineDetail(text) : summarize(text, 150);
    return label ? { label } : null;
  }

  const kind = activityItemKind(item);
  const readable = activityItemReadableDetail(item);
  if (kind === "planning") {
    const value = recordValue(item.call?.result ?? item.call?.input ?? item.result?.result ?? item.result?.input);
    const text = stringValue(value.text) || stringValue(value.summary) || formatMessageValue(value);
    const label = options.full ? compactMultilineDetail(text) : summarize(text, 160);
    return label ? { label } : null;
  }
  if (["command", "monitor", "search", "read", "browser"].includes(kind)) {
    const compacted = compactActivityDetailPaths(readable);
    const label = summarize(compacted, 160);
    return label ? { label, title: readable === label ? undefined : readable } : null;
  }
  if (kind === "agent") {
    const label = claudeAgentActivityDetail(item);
    return label ? { label } : null;
  }
  if (kind === "reasoning") {
    const text = reasoningActivityDetail(item);
    const label = options.full ? compactMultilineDetail(text) : summarize(text, 160);
    return label ? { label } : null;
  }
  const text = readable || activityItemRawText(item);
  const label = options.full ? compactMultilineDetail(text) : summarize(text, 160);
  return label ? { label } : null;
}

function compactMultilineDetail(text: string): string {
  return String(text || "")
    .split(/\r?\n/g)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function compactSingleLine(text: string): string {
  return compactMultilineDetail(text)
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

export function activityItemTitleTooltip(item: ActivityItem): string {
  if (item.type === "skill") {
    return item.part.source || item.part.skillId || item.part.skillName || "";
  }
  if (item.type === "question") {
    return item.part.questionPrompt || item.part.title || "";
  }
  if (item.type === "approval") {
    return item.part.approvalReason || commandText(item.part) || structuredTargetLabel(item.part);
  }
  if (item.type === "reasoning") {
    return item.part.text;
  }
  if (activityItemKind(item) === "agent") {
    return claudeAgentActivityDetail(item);
  }
  if (activityItemKind(item) === "monitor") {
    return "";
  }
  const fileHints = activityItemFileHints(item);
  if (fileHints.length) {
    return fileHints.join("\n");
  }
  const tool = item.call || item.result;
  if (!tool) {
    return "";
  }
  const structured = structuredTargetLabel(tool);
  if (structured) {
    return structured;
  }
  return commandText(tool);
}

function activityItemReadableDetail(item: ActivityItem): string {
  if (item.type !== "tool") {
    if (item.type === "question") {
      return item.part.questionPrompt || formatMessageValue(item.part.questionInput ?? item.part.input);
    }
    return "";
  }
  const native = codexNativeItemFromActivity(item);
  if (stringValue(native.type) === "commandExecution") {
    const cwd = stringValue(native.cwd);
    const exitCode = numberValue(native.exitCode);
    return [cwd ? `cwd: ${cwd}` : "", exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}` : ""]
      .filter(Boolean)
      .join(" · ");
  }
  const kind = activityItemKind(item);
  if (kind === "agent") {
    return claudeAgentActivityDetail(item);
  }
  if (kind === "monitor") {
    const resultText = readableResultText(item.result?.result);
    const error = item.result?.error || item.call?.error || "";
    return [resultText, error].filter(Boolean).join(" · ");
  }
  if (!["command", "search", "read", "browser"].includes(kind)) {
    return "";
  }
  const input = recordValue(item.call?.input || item.result?.input);
  const cwd = stringValue(input.cwd) || stringValue(input.workdir);
  const resultText = readableResultText(item.result?.result);
  const error = item.result?.error || item.call?.error || "";
  return [cwd ? `cwd: ${cwd}` : "", resultText, error].filter(Boolean).join(" · ");
}

function activityItemRawText(item: ActivityItem): string {
  if (item.type === "skill") {
    return [item.part.description, item.part.contentPreview, item.part.result].filter(Boolean).join("\n");
  }
  if (item.type === "approval") {
    return [item.part.approvalReason, commandText(item.part), structuredTargetLabel(item.part)]
      .filter(Boolean)
      .join("\n");
  }
  if (item.type === "question") {
    return [item.part.questionPrompt, formatMessageValue(item.part.questionInput ?? item.part.input)]
      .filter(Boolean)
      .join("\n");
  }
  if (item.type === "reasoning") {
    return item.part.text;
  }
  if (activityItemKind(item) === "agent") {
    return claudeAgentActivityDetail(item);
  }
  const text = [
    item.call ? formatMessageValue(item.call.input) : "",
    item.result ? formatMessageValue(item.result.result) : "",
    item.result?.error || item.call?.error || "",
  ]
    .filter(Boolean)
    .join("\n");
  return text;
}

export function activityItemError(item: ActivityItem, options: { full?: boolean } = {}): string {
  if (item.type !== "tool") {
    return "";
  }
  const error = item.result?.error || item.call?.error || "";
  if (!error) {
    return "";
  }
  const compact = compactMultilineDetail(error);
  return options.full ? compact : summarize(compact, 180);
}

export function activityItemStatus(item: ActivityItem): string {
  if (item.type === "skill") {
    if (item.part.status === "invoked" || item.part.status === "started") return "running";
    return item.part.status || "complete";
  }
  if (item.type === "reasoning") {
    return item.part.status || "running";
  }
  if (item.type === "approval") {
    return item.part.status || "requires-action";
  }
  if (item.type === "question") {
    return item.part.status || "requires-action";
  }
  return item.result?.status || item.call?.status || "running";
}

export function activityItemKind(item: ActivityItem): string {
  if (item.type === "skill") return "skill";
  if (item.type === "reasoning") return "reasoning";
  if (item.type === "question") return "question";
  if (item.type === "approval") return "approval";
  const nativeType = stringValue(codexNativeItemFromActivity(item).type);
  if (nativeType === "reasoning") return "reasoning";
  if (nativeType === "commandExecution") return commandActivityKind(item.call || item.result) || "command";
  if (nativeType === "fileChange") return "edit";
  if (nativeType === "webSearch") return "search";
  if (nativeType === "imageView") return "read";
  if (nativeType === "imageGeneration") return "artifact";
  if (nativeType === "contextCompaction") return "memory";
  const tool = item.call || item.result;
  const toolId = String(tool?.toolId || "").toLowerCase();
  if (isSkillInvokeToolId(toolId)) return "skill";
  if (toolId === "codex.reasoning" || toolId.includes("reasoning")) return "reasoning";
  if (toolId === "codex.commandexecution") return "command";
  if (isMonitorToolLabel(tool?.toolId) || isMonitorToolLabel(tool?.title)) return "monitor";
  const claudeKind = claudeNativeToolKind(tool?.toolId);
  if (claudeKind) return claudeKind;
  if (toolId.includes("filechange") || toolId.includes("file_change") || toolId.includes("patch")) return "edit";
  if (toolId.includes("command") || toolId.includes("exec")) return commandActivityKind(tool) || "command";
  if (toolId.includes("search")) return "search";
  if (toolId.includes("read") || toolId.includes("file")) return "read";
  if (toolId.includes("browser") || toolId.includes("computer")) return "browser";
  if (toolId.includes("memory")) return "memory";
  if (toolId.includes("artifact")) return "artifact";
  if (toolId.includes("plan") || toolId.includes("planning")) return "planning";
  return "tool";
}

function claudeNativeToolKind(toolId: unknown): string {
  const name = claudeNativeToolName(toolId).toLowerCase();
  return name ? CLAUDE_NATIVE_TOOL_KIND[name] || "" : "";
}

function cleanToolLabel(title: unknown, toolId: unknown, fallback: string): string {
  const titleText = stringValue(title);
  const toolIdText = stringValue(toolId);
  const titleClaudeName = claudeNativeToolName(titleText);
  const toolClaudeName = claudeNativeToolName(toolIdText);
  if (titleClaudeName) {
    return titleClaudeName;
  }
  if (titleText) {
    return titleText;
  }
  return toolClaudeName || toolIdText || fallback;
}

function approvalTimedOut(part: ToolPart): boolean {
  return /approval request timed out/i.test(part.error || "");
}

function failedWorkflowCreateItem(item: ActivityItem): boolean {
  if (item.type !== "tool") {
    return false;
  }
  const toolId = item.result?.toolId || item.call?.toolId;
  if (toolId !== "workflow.create") {
    return false;
  }
  const result = recordValue(item.result?.result ?? item.call?.result);
  const knowledgeId = stringValue(result.knowledgeId);
  const error = item.result?.error || item.call?.error || "";
  return Boolean(error) && !knowledgeId;
}

function workflowCreateArtifactCard(item: ActivityItem): ActivityArtifactCard | null {
  if (item.type !== "tool") {
    return null;
  }
  const toolId = item.result?.toolId || item.call?.toolId;
  if (toolId !== "workflow.create") {
    return null;
  }
  const result = recordValue(item.result?.result ?? item.call?.result);
  const input = recordValue(item.call?.input ?? item.result?.input);
  const knowledgeId = stringValue(result.knowledgeId);
  if (!knowledgeId) {
    return null;
  }
  const title = stringValue(result.title) || stringValue(input.title) || knowledgeId;
  const stepCount = numberValue(result.stepCount);
  const description = stringValue(input.description);
  return {
    id: `workflow:${knowledgeId}`,
    title,
    kind: translate("activity.kindWorkflow"),
    summary: [stepCount !== undefined ? translate("activity.stepCount", { count: stepCount }) : "", description]
      .filter(Boolean)
      .join(" · "),
    uri: "",
    imageUri: "",
    path: "",
    knowledgeId,
  };
}

function workflowCreateApprovalSummary(part: ToolPart): { label: string; title?: string } | null {
  if (part.toolId !== "workflow.create") {
    return null;
  }
  const input = recordValue(part.approvalInput ?? part.input);
  const title = stringValue(input.title);
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const stepTitles = steps
    .map((step, index) => stringValue(recordValue(step).title) || translate("activity.stepN", { index: index + 1 }))
    .filter(Boolean);
  const stepSummary = stepTitles.length
    ? translate("activity.workflowSteps", {
        count: stepTitles.length,
        steps: stepTitles.map((step, index) => `${index + 1}. ${step}`).join(" / "),
      })
    : translate("activity.workflowWillCreate");
  const label = title ? translate("activity.createWorkflow", { title, summary: stepSummary }) : stepSummary;
  const raw = formatMessageValue(input);
  return {
    label: summarize(label, 220),
    title: raw && raw !== label ? raw : undefined,
  };
}

function claudeNativeToolName(value: unknown): string {
  const text = stringValue(value);
  const match = text.match(/^claude\.(.+)$/i);
  return match?.[1]?.trim() || "";
}

function claudeAgentActivityTitle(item: ActivityItem, status: string): string {
  const label = claudeAgentTitleLabel(item);
  const completedPrefix =
    item.type === "tool" && item.result ? translate("activity.completedPrefix") : translate("activity.delegatedPrefix");
  return statusAwareTitle(status, translate("activity.delegatingPrefix"), completedPrefix, label);
}

function claudeAgentTitleLabel(item: ActivityItem): string {
  const meta = claudeAgentMetadata(item);
  const toolLabel = claudeAgentToolLabel(item);
  return meta.description ? `${toolLabel} · ${summarize(meta.description, 72)}` : toolLabel;
}

function claudeAgentActivityDetail(item: ActivityItem): string {
  const meta = claudeAgentMetadata(item);
  const toolLabel = claudeAgentToolLabel(item);
  const type = meta.agentType || toolLabel;
  const detail = [type, meta.description ? summarize(meta.description, 96) : ""].filter(Boolean).join(" · ");
  return detail || toolLabel;
}

function claudeAgentMetadata(item: ActivityItem): { agentType: string; description: string; status: string } {
  if (item.type !== "tool") {
    return { agentType: "", description: "", status: "" };
  }
  const input = recordValue(item.call?.input ?? item.result?.input);
  const result = recordValue(item.result?.result ?? item.call?.result);
  return {
    agentType:
      stringValue(input.subagent_type) ||
      stringValue(input.agentType) ||
      stringValue(input.agent_type) ||
      stringValue(result.agentType) ||
      stringValue(result.agent_type) ||
      stringValue(result.subagent_type),
    description: compactSingleLine(
      stringValue(input.description) ||
        stringValue(input.task) ||
        stringValue(input.title) ||
        stringValue(result.description) ||
        stringValue(result.title),
    ),
    status: stringValue(result.status),
  };
}

function claudeAgentToolLabel(item: ActivityItem): string {
  if (item.type !== "tool") {
    return "Agent";
  }
  const name = claudeNativeToolName(item.call?.toolId || item.result?.toolId).toLowerCase();
  return name === "task" ? "Task" : "Agent";
}

function codexNativeActivityTitle(item: ActivityItem, status: string): string {
  if (item.type !== "tool") return "";
  const native = codexNativeItemFromActivity(item);
  const type = stringValue(native.type);
  if (type === "mcpToolCall") {
    const label =
      [stringValue(native.server), stringValue(native.tool)].filter(Boolean).join(".") || translate("activity.mcpTool");
    return statusAwareTitle(status, translate("activity.callingPrefix"), translate("activity.calledPrefix"), label);
  }
  if (type === "collabAgentToolCall") {
    return statusAwareTitle(
      status,
      translate("activity.runningPrefix"),
      translate("activity.ranPrefix"),
      stringValue(native.tool) || translate("activity.collabTask"),
    );
  }
  if (type === "webSearch") {
    const query = stringValue(native.query);
    return statusAwareTitle(
      status,
      translate("activity.searchingPrefix"),
      translate("activity.searchedPrefix"),
      query ? `"${summarize(query, 54)}"` : translate("activity.web"),
    );
  }
  if (type === "imageView") {
    return statusAwareTitle(
      status,
      translate("activity.viewingPrefix"),
      translate("activity.viewedPrefix"),
      stringValue(native.path) || translate("activity.kindImage"),
    );
  }
  if (type === "imageGeneration") {
    return statusAwareTitle(
      status,
      translate("activity.generatingPrefix"),
      translate("activity.generatedPrefix"),
      translate("activity.kindImage"),
    );
  }
  if (type === "contextCompaction") {
    return status === "running" ? translate("activity.compacting") : translate("activity.compacted");
  }
  if (type === "plan") {
    return status === "running" ? translate("activity.updatingPlan") : translate("activity.updatedPlan");
  }
  return "";
}

function reasoningActivityDetail(item: ActivityItem): string {
  if (item.type === "reasoning") return item.part.text;
  if (item.type !== "tool") return "";
  const values = [item.call?.input, item.result?.result].map(recordValue);
  const fields = values.flatMap(reasoningSummaryFields);
  return fields.filter(Boolean).join(" · ");
}

function reasoningSummaryFields(value: Record<string, unknown>): string[] {
  const summary = value.summary;
  return [
    stringValue(value.thinkingText),
    stringValue(value.thinking_text),
    stringValue(value.summaryText),
    stringValue(value.summary_text),
    typeof summary === "string" ? summary : "",
    ...(Array.isArray(summary) ? summary.map(reasoningSummaryEntryText) : []),
    stringValue(value.status),
  ];
}

function reasoningSummaryEntryText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const entry = recordValue(value);
  return (
    stringValue(entry.text) ||
    stringValue(entry.summaryText) ||
    stringValue(entry.summary_text) ||
    stringValue(entry.message)
  );
}

function toolPreview(tool: ToolPart | undefined): string {
  if (!tool) return translate("activity.tool");
  const input = recordValue(tool.input);
  const command = commandText(tool);
  const title = stringValue(input.title);
  return summarize(command || title || cleanToolLabel(tool.title, tool.toolId, translate("activity.tool")), 72);
}

function activityTargetLabel(item: ActivityItem | undefined): string {
  if (!item) {
    return "";
  }
  if (item.type === "skill") {
    return item.part.skillName ? `/${item.part.skillName.replace(/^\//, "")}` : item.part.title || "";
  }
  if (item.type === "approval") {
    return item.part.title || item.part.toolId || "";
  }
  if (item.type === "question") {
    return item.part.title || item.part.questionPrompt || "";
  }
  if (item.type === "reasoning") {
    return "";
  }
  const kind = activityItemKind(item);
  if (kind === "skill") {
    const name = activitySkillName(item);
    return name ? `/${name.replace(/^\//, "")}` : "skill";
  }
  if (kind === "edit") {
    return filePreview(item);
  }
  const tool = item.call || item.result;
  if (!tool) {
    return "";
  }
  if (kind === "search") {
    return searchTargetLabel(tool);
  }
  if (kind === "read") {
    return readTargetLabel(tool);
  }
  if (kind === "command") {
    return commandTargetLabel(tool);
  }
  if (kind === "monitor") {
    return monitorTargetLabel(item);
  }
  if (kind === "agent") {
    return claudeAgentTitleLabel(item);
  }
  if (kind === "browser") {
    return browserTargetLabel(tool);
  }
  return "";
}

function activitySkillName(item: ActivityItem): string {
  if (item.type === "skill") {
    return item.part.skillName || item.part.title || item.part.skillId;
  }
  if (item.type !== "tool") return "";
  const values = [item.call?.input, item.result?.result].map(recordValue);
  for (const value of values) {
    const name = stringValue(value.skillName) || stringValue(value.skill) || stringValue(value.name);
    if (name) return name.replace(/^skill\./, "");
  }
  return "";
}

function isSkillInvokeToolId(toolId: string): boolean {
  const normalized = toolId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".");
  return normalized === "skill.invoke" || normalized.endsWith(".skill.invoke");
}

function searchTargetLabel(tool: ToolPart): string {
  const query = stringValue(codexNativeItemFromTool(tool).query);
  if (query) {
    return `"${summarize(query, 36)}"`;
  }
  const command = commandText(tool);
  const tokens = shellWords(command);
  const executable = commandExecutable(tokens);
  if (!tokens.length || !["rg", "grep", "ag", "fd", "find"].includes(executable)) {
    return structuredTargetLabel(tool) || "";
  }
  const positional = commandPositionals(tokens.slice(1));
  if (executable === "find") {
    return summarizePathTargets(positional.length ? positional : ["."]);
  }
  if (tokens.includes("--files")) {
    return summarizePathTargets(positional) || translate("activity.file");
  }
  const pathTargets = positional.slice(1).filter(isPathLikeToken);
  if (pathTargets.length) {
    return summarizePathTargets(pathTargets);
  }
  const fallbackPaths = positional.filter(isPathLikeToken);
  if (fallbackPaths.length) {
    return summarizePathTargets(fallbackPaths);
  }
  return positional[0] ? `"${summarize(positional[0], 36)}"` : translate("activity.file");
}

function readTargetLabel(tool: ToolPart): string {
  const command = commandText(tool);
  const tokens = shellWords(command);
  const positional = commandPositionals(tokens.slice(1));
  const paths = positional.filter(isPathLikeToken);
  if (paths.length) {
    return summarizePathTargets(paths.slice(-2));
  }
  return structuredTargetLabel(tool) || cleanToolLabel(tool.title, tool.toolId, "");
}

function commandTargetLabel(tool: ToolPart): string {
  const command = commandText(tool);
  const tokens = shellWords(command);
  if (tokens[0] === "npm" && tokens[1] === "run" && tokens[2]) {
    return summarize(command, 44);
  }
  if (tokens[0] === "npm" && tokens[1]) {
    return summarize(command, 44);
  }
  return summarize(command || structuredTargetLabel(tool) || cleanToolLabel(tool.title, tool.toolId, ""), 44);
}

function browserTargetLabel(tool: ToolPart): string {
  const input = recordValue(tool.input);
  const result = recordValue(tool.result);
  return (
    stringValue(input.url) ||
    stringValue(result.url) ||
    stringValue(input.title) ||
    stringValue(result.title) ||
    structuredTargetLabel(tool)
  );
}

function structuredTargetLabel(tool: ToolPart): string {
  const input = recordValue(tool.input);
  const result = recordValue(tool.result);
  return (
    [
      stringValue(input.path),
      stringValue(input.file),
      stringValue(input.filePath),
      stringValue(input.target),
      stringValue(result.path),
      stringValue(result.file),
      stringValue(result.filePath),
      stringValue(result.target),
    ].find(Boolean) || ""
  );
}

function commandText(tool: ToolPart | undefined): string {
  if (!tool) return "";
  const input = recordValue(tool.input);
  const result = recordValue(tool.result);
  return cleanShellCommand(
    stringValue(input.cmd) ||
      stringValue(input.command) ||
      stringValue(input.shellCommand) ||
      stringValue(input.args) ||
      stringValue(result.command) ||
      "",
  );
}

function isMonitorToolLabel(value: unknown): boolean {
  const normalized = stringValue(value).trim().toLowerCase();
  if (!normalized) return false;
  const segments = normalized.split(/[.:/_-]+/g).filter(Boolean);
  return segments.at(-1) === "monitor";
}

function monitorTargetLabel(item: ActivityItem): string {
  if (item.type !== "tool") return "";
  const values = [item.call?.input, item.result?.input, item.call?.result, item.result?.result].map(recordValue);
  for (const value of values) {
    const label = compactSingleLine(
      stringValue(value.description) || stringValue(value.label) || stringValue(value.title) || stringValue(value.task),
    );
    if (label) return summarize(label, 72);
  }
  return "";
}

function cleanShellCommand(command: string): string {
  let value = command.trim();
  value = value.replace(/^\/bin\/(?:zsh|bash|sh)\s+-lc\s+/, "").trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value) {
      words.push(value.replace(/\\(["'\\])/g, "$1"));
    }
  }
  return words;
}

function commandExecutable(tokens: string[]): string {
  const first = tokens[0] || "";
  return pathBaseName(first);
}

function commandPositionals(tokens: string[]): string[] {
  const positionals: string[] = [];
  const optionsWithValues = new Set([
    "-e",
    "-f",
    "-g",
    "--glob",
    "--type",
    "--type-add",
    "--context",
    "--after-context",
    "--before-context",
    "--max-depth",
    "--ignore-file",
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || isShellOperator(token)) {
      continue;
    }
    if (token.startsWith("-")) {
      if (optionsWithValues.has(token) && index + 1 < tokens.length) {
        index += 1;
      }
      continue;
    }
    positionals.push(token);
  }
  return positionals;
}

// forwarding-boundary: names the shell-token classification used by command presentation.
function isShellOperator(token: string): boolean {
  return ["|", "||", "&&", ";", ">", ">>", "<", "2>", "2>>"].includes(token);
}

function isPathLikeToken(token: string): boolean {
  const value = token.trim();
  if (!value || value.startsWith("$")) {
    return false;
  }
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.includes("/") ||
    /\.[A-Za-z0-9]{1,8}$/.test(value) ||
    ["src", "web", "extension", "scripts", "test", "tests", "docs"].includes(value)
  );
}

function summarizePathTargets(paths: string[]): string {
  const cleaned = uniqueStrings(paths.map(cleanPathToken).filter(Boolean));
  if (!cleaned.length) {
    return "";
  }
  if (cleaned.length === 1) {
    return displayPathTarget(cleaned[0]!);
  }
  const first = displayPathTarget(cleaned[0]!);
  return translate("activity.moreLocations", { first, count: cleaned.length });
}

function cleanPathToken(path: string): string {
  return path
    .replace(/^['"]|['"]$/g, "")
    .replace(/[,:;]+$/g, "")
    .trim();
}

function displayPathTarget(path: string): string {
  if (path === ".") {
    return translate("activity.currentDirectory");
  }
  if (path === "..") {
    return translate("activity.parentDirectory");
  }
  const normalized = path.replace(/\\/g, "/");
  const base = pathBaseName(normalized);
  if (/\.[A-Za-z0-9]{1,8}$/.test(base)) {
    return base;
  }
  if (normalized.startsWith("/") && base) {
    return base;
  }
  return normalized;
}

function compactActivityDetailPaths(detail: string): string {
  return detail
    .split(" · ")
    .map((segment) => {
      const cwdMatch = segment.match(/^cwd:\s*(.+)$/);
      if (cwdMatch?.[1]) {
        return `cwd: ${compactPathLabel(cwdMatch[1])}`;
      }
      return segment;
    })
    .join(" · ");
}

function compactPathLabel(path: string): string {
  const cleaned = cleanPathToken(path).replace(/[\\/]+$/g, "");
  if (!cleaned) {
    return path;
  }
  if (cleaned === ".") {
    return translate("activity.currentDirectory");
  }
  if (cleaned === "..") {
    return translate("activity.parentDirectory");
  }
  return pathBaseName(cleaned) || cleaned;
}

function commandActivityKind(tool: ToolPart | undefined): string {
  const command = commandText(tool);
  if (!command) return "command";
  const searchesFiles =
    /^(rg|grep|ag|fd|find)\b/.test(command) ||
    (/\b(rg|grep|ag|fd|find)\b/.test(command) && /\b(-n|--files|--glob|--hidden)\b/.test(command));
  if (searchesFiles) {
    return "search";
  }
  if (/^(sed|cat|nl|head|tail|wc|ls|tree)\b/.test(command)) {
    return "read";
  }
  if (/^(apply_patch|patch)\b/.test(command)) {
    return "edit";
  }
  return "command";
}

function readableResultText(value: unknown): string {
  const preferredKeys = ["output", "stdout", "stderr", "text", "message", "summary", "observation", "title"];
  const lines: string[] = [];
  visitSafeJsonValues(value, ({ value: current }) => {
    if (typeof current === "string") {
      if (current) lines.push(current);
      return false;
    }
    if (Array.isArray(current)) return true;
    if (!current || typeof current !== "object") return false;
    const record = current as Record<string, unknown>;
    lines.push(
      ...preferredKeys
        .map((key) => record[key])
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim())),
    );
    return false;
  });
  return lines.join("\n");
}

function extractArtifactCardsFromValue(value: unknown, depth = 0): ActivityArtifactCard[] {
  if (depth > 4 || value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractArtifactCardsFromValue(item, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const direct = artifactCardFromRecord(record);
  const nestedKeys = [
    "artifact",
    "artifacts",
    "artifact_ref",
    "artifact_refs",
    "artifactRef",
    "artifactRefs",
    "outputArtifact",
    "outputArtifacts",
    "assets",
    "files",
    "outputs",
  ];
  const nested = nestedKeys.flatMap((key) =>
    key in record ? extractArtifactCardsFromValue(record[key], depth + 1) : [],
  );
  return [...(direct ? [direct] : []), ...nested];
}

function artifactCardFromRecord(record: Record<string, unknown>): ActivityArtifactCard | null {
  const preview = recordValue(record.preview);
  const data = recordValue(record.data);
  const embeddedImageUri =
    stringValue(record.imageUri) ||
    stringValue(record.image_url) ||
    stringValue(record.imageUrl) ||
    stringValue(preview.imageUri) ||
    stringValue(data.imageUri) ||
    imageUriFromAssets(record.assets);
  const uri =
    stringValue(record.uri) ||
    stringValue(record.url) ||
    stringValue(record.href) ||
    stringValue(preview.uri) ||
    stringValue(data.uri);
  const path =
    stringValue(record.path) ||
    stringValue(record.filePath) ||
    stringValue(record.file_path) ||
    stringValue(data.filePath) ||
    stringValue(data.path);
  const type = stringValue(record.type) || stringValue(record.kind) || stringValue(data.type);
  const mimeType =
    stringValue(record.mimeType) ||
    stringValue(record.mime_type) ||
    stringValue(preview.mimeType) ||
    stringValue(data.mimeType);
  const title =
    stringValue(record.title) ||
    stringValue(record.name) ||
    stringValue(record.fileName) ||
    stringValue(data.fileName) ||
    pathBaseName(path || uri || embeddedImageUri) ||
    stringValue(record.id);
  const id = stringValue(record.id) || stringValue(record.artifactId) || stringValue(record.artifact_id) || title;
  const imageUri =
    embeddedImageUri ||
    (id && /image/i.test(`${type} ${mimeType}`) ? apiUrl(`/artifacts/${encodeURIComponent(id)}/content`) : "");
  const summary =
    stringValue(record.summary) ||
    stringValue(record.description) ||
    stringValue(preview.text) ||
    stringValue(data.summary) ||
    path ||
    uri ||
    imageUri;
  const hasSignal = Boolean(
    title &&
      (imageUri ||
        uri ||
        path ||
        summary ||
        /artifact|asset|image|file|document|diff|patch|snapshot/i.test(type) ||
        /image|text|pdf|json|markdown|zip|octet-stream/i.test(mimeType) ||
        stringValue(record.artifactId) ||
        stringValue(record.artifact_id)),
  );
  if (!hasSignal) {
    return null;
  }
  return {
    id,
    title,
    kind: artifactKindLabel(type, mimeType, imageUri),
    summary,
    uri,
    imageUri,
    path,
    mimeType,
  };
}

function imageUriFromAssets(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  for (const item of value) {
    const record = recordValue(item);
    const kind =
      `${stringValue(record.kind)} ${stringValue(record.type)} ${stringValue(record.mimeType)}`.toLowerCase();
    const uri = stringValue(record.uri) || stringValue(record.url);
    if (uri && (kind.includes("image") || /^data:image\//.test(uri))) {
      return uri;
    }
  }
  return "";
}

// kind 是展示文案，会随语言变化且可能被持久化为中英任一版本；判断是否图片一律走这里。
const IMAGE_KIND_LABELS = Object.values(dictionaries).map((dictionary) => dictionary["activity.kindImage"]);

export function isImageArtifactKind(kind: string): boolean {
  return IMAGE_KIND_LABELS.includes(kind);
}

function artifactKindLabel(type: string, mimeType: string, imageUri: string): string {
  const value = `${type} ${mimeType}`.toLowerCase();
  if (imageUri || value.includes("image")) {
    return translate("activity.kindImage");
  }
  if (value.includes("diff") || value.includes("patch")) {
    return translate("activity.kindDiff");
  }
  if (value.includes("markdown") || value.includes("text") || value.includes("document")) {
    return translate("activity.kindDocument");
  }
  if (value.includes("file") || value.includes("pdf") || value.includes("zip")) {
    return translate("activity.file");
  }
  return translate("activity.kindArtifact");
}

function uniqueArtifactCards(cards: ActivityArtifactCard[]): ActivityArtifactCard[] {
  const seen = new Set<string>();
  const output: ActivityArtifactCard[] = [];
  for (const card of cards) {
    const key = [card.id, card.title, card.uri, card.path, card.imageUri].filter(Boolean).join("|");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(card);
  }
  return output;
}

function codexNativeItemFromActivity(item: ActivityItem): Record<string, unknown> {
  if (item.type !== "tool") return {};
  const resultItem = item.result ? codexNativeItemFromTool(item.result) : {};
  if (stringValue(resultItem.type)) return resultItem;
  return item.call ? codexNativeItemFromTool(item.call) : {};
}

function activityItemElapsedMs(item: ActivityItem): number | undefined {
  if (item.type === "reasoning") return item.part.elapsedMs;
  if (item.type !== "tool") return undefined;
  const fromResult =
    numberValue(recordValue(item.result?.result).elapsedMs) ?? numberValue(recordValue(item.result?.input).elapsedMs);
  if (fromResult !== undefined) return fromResult;
  return numberValue(recordValue(item.call?.input).elapsedMs) ?? numberValue(recordValue(item.call?.result).elapsedMs);
}

export function formatElapsedMs(elapsedMs: number | undefined): string {
  if (elapsedMs === undefined || elapsedMs < 0) return "";
  const totalSeconds = Math.round(elapsedMs / 1000);
  if (totalSeconds <= 0) return "";
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function codexNativeItemFromTool(tool: ToolPart | undefined): Record<string, unknown> {
  if (!tool) return {};
  const input = recordValue(tool.input);
  if (isCodexNativeItem(input)) return input;
  const result = recordValue(tool.result);
  if (isCodexNativeItem(result)) return result;
  return {};
}

function isCodexNativeItem(value: Record<string, unknown>): boolean {
  return Boolean(stringValue(value.type)) && String(value.type) !== "tool";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function filePreview(item: ActivityItem): string {
  const files = activityItemFileHints(item);
  if (files.length === 1) return summarize(files[0]!, 54);
  if (files.length > 1) return translate("activity.files", { count: files.length });
  return translate("activity.fileChanges");
}

export function editActivityInfo(
  item: ActivityItem,
): { label: string; fullPaths: string[]; added?: number; removed?: number } | null {
  const fullPaths = activityItemFileHints(item);
  const stats = editStatsFromItem(item);
  if (fullPaths.length > 1) {
    return {
      label: translate("activity.files", { count: fullPaths.length }),
      fullPaths,
      ...stats,
    };
  }
  const fullPath = fullPaths[0] || filePreview(item);
  return {
    label: pathBaseName(fullPath),
    fullPaths: fullPaths.length ? fullPaths : [fullPath],
    ...stats,
  };
}

export type EditDiffLineKind = "add" | "del" | "context" | "meta";
export interface EditDiffLine {
  kind: EditDiffLineKind;
  text: string;
}

// Build a renderable line-level diff for an edit activity, source-agnostic:
//   1. an explicit unified `diff`/`patch` string (codex apply_patch style), parsed by leading +/-/@@;
//   2. otherwise reconstructed from old/new strings (Claude Edit) or per-edit pairs (MultiEdit).
// Returns null when there's nothing diff-like to show (caller falls back to no expandable block).
export function editDiffFromItem(item: ActivityItem): EditDiffLine[] | null {
  if (item.type !== "tool") {
    return null;
  }
  const values = activityItemStructuredValues(item);

  const diffTexts = uniqueStrings(values.flatMap(extractDiffTextsFromValue));
  if (diffTexts.length) {
    const lines = parseUnifiedDiffLines(diffTexts.join("\n"));
    if (lines.length) {
      return lines;
    }
  }

  const pairs = values.flatMap(extractEditPairsFromValue);
  if (pairs.length) {
    const lines: EditDiffLine[] = [];
    pairs.forEach((pair, index) => {
      if (index > 0) {
        lines.push({ kind: "meta", text: "" });
      }
      for (const line of String(pair.oldText).split("\n")) {
        if (pair.oldText === "") break;
        lines.push({ kind: "del", text: line });
      }
      for (const line of String(pair.newText).split("\n")) {
        if (pair.newText === "") break;
        lines.push({ kind: "add", text: line });
      }
    });
    if (lines.length) {
      return lines;
    }
  }
  return null;
}

function parseUnifiedDiffLines(text: string): EditDiffLine[] {
  const out: EditDiffLine[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (/^(?:diff |index |--- |\+\+\+ |@@)/.test(raw)) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1) });
    } else {
      out.push({ kind: "context", text: raw.replace(/^ /, "") });
    }
  }
  // Drop a leading/trailing run of blank context lines so the block hugs its content.
  while (out.length && out[0]?.kind === "context" && out[0].text === "") out.shift();
  while (out.length && out.at(-1)?.kind === "context" && out.at(-1)?.text === "") out.pop();
  return out;
}

function extractEditPairsFromValue(value: unknown, depth = 0): Array<{ oldText: string; newText: string }> {
  if (depth > 4 || !value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractEditPairsFromValue(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const pairs: Array<{ oldText: string; newText: string }> = [];
  const oldText =
    stringValue(record.old_string) ||
    stringValue(record.oldString) ||
    stringValue(record.oldText) ||
    stringValue(record.old);
  const newText =
    stringValue(record.new_string) ||
    stringValue(record.newString) ||
    stringValue(record.newText) ||
    stringValue(record.new);
  if (oldText || newText) {
    pairs.push({ oldText, newText });
  }
  // MultiEdit: { edits: [{ old_string, new_string }, ...] }
  if (Array.isArray(record.edits)) {
    pairs.push(...record.edits.flatMap((edit) => extractEditPairsFromValue(edit, depth + 1)));
  }
  return pairs;
}

function activityItemFileHints(item: ActivityItem): string[] {
  const values = activityItemStructuredValues(item);
  return uniqueStrings([...values.flatMap(extractFileHintsFromValue), ...extractFileHints(activityItemRawText(item))]);
}

function activityItemStructuredValues(item: ActivityItem): unknown[] {
  if (item.type === "reasoning") {
    return [item.part.text];
  }
  if (item.type === "tool") {
    return [item.call?.input, item.result?.result].filter((value) => value !== undefined);
  }
  if (item.type === "approval") {
    return [item.part.input, item.part.approvalInput].filter((value) => value !== undefined);
  }
  if (item.type === "question") {
    return [item.part.input, item.part.questionInput].filter((value) => value !== undefined);
  }
  return [];
}

function editStatsFromItem(item: ActivityItem): { added?: number; removed?: number } {
  const diffs = uniqueStrings(activityItemStructuredValues(item).flatMap(extractDiffTextsFromValue));
  if (diffs.length) {
    return editStatsFromText(diffs.join("\n"));
  }
  return editStatsFromText(activityItemRawText(item));
}

function aggregateReasoningElapsedMs(items: ActivityItem[]): number | undefined {
  let total = 0;
  let found = false;
  for (const item of items) {
    if (activityItemKind(item) !== "reasoning") {
      continue;
    }
    const elapsed = activityItemElapsedMs(item);
    if (elapsed !== undefined) {
      total += elapsed;
      found = true;
    }
  }
  return found ? total : undefined;
}

function editStatsFromText(text: string): { added?: number; removed?: number } {
  const explicitStats = [...text.matchAll(/(?:^|[^\S\r\n])\+(\d+)[^\S\r\n]+-?(\d+)(?=$|[^\S\r\n])/g)];
  if (explicitStats.length) {
    return explicitStats.reduce(
      (total, match) => ({
        added: (total.added || 0) + Number(match[1] || 0),
        removed: (total.removed || 0) + Number(match[2] || 0),
      }),
      { added: 0, removed: 0 },
    );
  }

  let added = 0;
  let removed = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++") && !line.startsWith("***")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return added || removed ? { added, removed } : {};
}

function pathBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function extractFileHintsFromValue(value: unknown): string[] {
  const hints: string[] = [];
  visitSafeJsonValues(value, ({ value: current, key }) => {
    if (typeof current !== "string") return true;
    if (key && isPathHintKey(key.toLowerCase())) hints.push(current);
    hints.push(...extractFileHints(current));
    return false;
  });
  return hints;
}

function extractDiffTextsFromValue(value: unknown): string[] {
  const diffs: string[] = [];
  visitSafeJsonValues(value, ({ value: current, key }) => {
    const lowerKey = key?.toLowerCase();
    if (typeof current === "string" && (lowerKey === "diff" || lowerKey === "patch")) {
      diffs.push(current);
    }
  });
  return diffs;
}

// forwarding-boundary: names the structured-tool field classification used by file hints.
function isPathHintKey(key: string): boolean {
  return ["file", "filepath", "file_path", "filename", "path", "target", "target_path"].includes(key);
}

function extractFileHints(text: string): string[] {
  const patterns = [
    /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/g,
    /(?:^|\n)\s*["']?(?:file|path|target|filename)["']?\s*[:=]\s*["']?([^"',\n}]+)/gi,
  ];
  return patterns.flatMap((pattern) =>
    [...String(text || "").matchAll(pattern)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value)),
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatMessageValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return formatJson(value);
}

export function questionPromptLabel(part: ToolPart): string {
  const input = recordValue(part?.questionInput);
  const params = recordValue(input.params);
  return (
    part.questionPrompt ||
    stringValue(params.title) ||
    stringValue(params.prompt) ||
    stringValue(params.message) ||
    translate("activity.answer")
  );
}

export function buildQuestionResponse(
  part: ToolPart,
  answer: string | Record<string, string>,
): Record<string, unknown> {
  const input = recordValue(part?.questionInput);
  const isAskUserQuestion = stringValue(input.toolName) === "AskUserQuestion";
  const ids = isAskUserQuestion ? askUserQuestionAnswerKeysFromInput(input) : questionIdsFromInput(input);
  const firstQuestionId = ids[0] || "";
  const fallbackAnswer = typeof answer === "string" ? answer.trim() : "";
  const answersById =
    typeof answer === "string"
      ? firstQuestionId
        ? { [firstQuestionId]: fallbackAnswer }
        : {}
      : Object.fromEntries(Object.entries(answer).map(([key, value]) => [key, value.trim()]));

  if (isAskUserQuestion) {
    const answersByQuestion = canonicalAskUserQuestionAnswers(input, answersById);
    return Object.keys(answersByQuestion).length
      ? { answers: answersByQuestion }
      : { answers: firstQuestionId ? { [firstQuestionId]: fallbackAnswer } : { answer: fallbackAnswer } };
  }

  if (stringValue(input.method) === "mcpServer/elicitation/request") {
    if (Object.keys(answersById).length) {
      return { content: answersById };
    }
    return {
      content: firstQuestionId ? { [firstQuestionId]: fallbackAnswer } : { answer: fallbackAnswer },
    };
  }
  if (Object.keys(answersById).length) {
    return {
      answers: Object.fromEntries(
        Object.entries(answersById).map(([id, value]) => [id, { answers: value ? [value] : [] }]),
      ),
    };
  }
  return {
    answers: firstQuestionId
      ? { [firstQuestionId]: { answers: fallbackAnswer ? [fallbackAnswer] : [] } }
      : { answer: fallbackAnswer },
  };
}

function questionIdsFromInput(input: Record<string, unknown>): string[] {
  const containers = [
    input,
    recordValue(input.params),
    recordValue(input.input),
    recordValue(recordValue(input.params).input),
  ];
  for (const container of containers) {
    const ids = questionIdsFromParams(container);
    if (ids.length) {
      return ids;
    }
  }
  return [];
}

function questionIdsFromParams(params: Record<string, unknown>): string[] {
  const questions = Array.isArray(params.questions)
    ? params.questions
    : Array.isArray(params.fields)
      ? params.fields
      : [];
  return questions
    .map((question) => {
      const value = recordValue(question);
      return (
        stringValue(value.id) || stringValue(value.name) || stringValue(value.header) || stringValue(value.question)
      );
    })
    .filter(Boolean);
}

function askUserQuestionAnswerKeysFromInput(input: Record<string, unknown>): string[] {
  const questions = askUserQuestionItemsFromInput(input);
  return questions
    .map((question, questionIndex) => {
      const value = recordValue(question);
      return (
        stringValue(value.question) ||
        stringValue(value.header) ||
        stringValue(value.id) ||
        stringValue(value.name) ||
        `question_${questionIndex + 1}`
      );
    })
    .filter(Boolean);
}

function canonicalAskUserQuestionAnswers(
  input: Record<string, unknown>,
  answers: Record<string, string>,
): Record<string, string> {
  const questions = askUserQuestionItemsFromInput(input);
  if (!questions.length) {
    return answers;
  }
  const aliases = new Map<string, string>();
  questions.forEach((question, questionIndex) => {
    const value = recordValue(question);
    const canonical =
      stringValue(value.question) ||
      stringValue(value.header) ||
      stringValue(value.id) ||
      stringValue(value.name) ||
      `question_${questionIndex + 1}`;
    [
      value.id,
      value.name,
      value.header,
      value.question,
      value.title,
      value.label,
      value.prompt,
      value.message,
      value.text,
      `question_${questionIndex + 1}`,
    ].forEach((alias) => {
      const key = stringValue(alias);
      if (key) {
        aliases.set(key, canonical);
      }
    });
  });
  return Object.fromEntries(
    Object.entries(answers)
      .filter(([, value]) => value.trim())
      .map(([key, value]) => [aliases.get(key) || key, value.trim()]),
  );
}

function askUserQuestionItemsFromInput(input: Record<string, unknown>): unknown[] {
  const containers = [
    input,
    recordValue(input.input),
    recordValue(input.params),
    recordValue(recordValue(input.params).input),
  ];
  for (const container of containers) {
    if (Array.isArray(container.questions)) {
      return container.questions;
    }
  }
  return [];
}
