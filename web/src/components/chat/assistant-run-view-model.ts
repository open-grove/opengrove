import type { MessagePart, NotePart, ReasoningPart, SkillPart, TextPart, ToolPart } from "../../bridge";
import { translate, type TranslationFn } from "../../i18n";
import {
  activityItemKind,
  activityItemStatus,
  buildActivityItems,
  summarizeActivityItems,
  type ActivityEntry,
} from "./message-activity-model";

export type AssistantPartGroup =
  | { type: "text"; part: TextPart }
  | { type: "note"; key: string; part: NotePart }
  | { type: "question"; key: string; part: ToolPart }
  | { type: "approval"; key: string; part: ToolPart }
  | { type: "activity"; key: string; parts: Array<ToolPart | SkillPart | ReasoningPart> };

export interface SplitAssistantParts {
  answerGroups: AssistantPartGroup[];
  processGroups: AssistantPartGroup[];
  segments: AssistantTurnSegment[];
}

export type AssistantTurnSegment =
  | { type: "content"; key: string; group: AssistantPartGroup }
  | { type: "process"; key: string; groups: AssistantPartGroup[] };

export interface ProcessSummaryFlags {
  active: boolean;
  pendingQuestion: boolean;
  pendingApproval: boolean;
  activeChoiceForm: boolean;
}

export function splitAssistantPartsForSurface(parts: MessagePart[], messageId: string): SplitAssistantParts {
  const answerGroups: AssistantPartGroup[] = [];
  const processGroups: AssistantPartGroup[] = [];
  const orderedGroups: AssistantPartGroup[] = [];
  // Status/guidance notes are buffered deliberately: low-level notes between
  // tools belong inside the same aggregate and must not split it into multiple
  // bars. Native commentary and compaction remain explicit chronological
  // boundaries and are flushed immediately below.
  const pendingProcessNotes: Extract<AssistantPartGroup, { type: "note" }>[] = [];
  let activityParts: Array<ToolPart | SkillPart | ReasoningPart> = [];
  let activityGroupIndex = 0;
  let processNoteGroupIndex = 0;

  const flushActivity = () => {
    if (activityParts.length) {
      const group: AssistantPartGroup = {
        type: "activity",
        key: `${messageId}:activity-${activityGroupIndex++}-${activityParts[0]?.id || "group"}`,
        parts: activityParts,
      };
      processGroups.push(group);
      orderedGroups.push(group);
      activityParts = [];
    }
    if (pendingProcessNotes.length) {
      processGroups.push(...pendingProcessNotes);
      orderedGroups.push(...pendingProcessNotes);
      pendingProcessNotes.length = 0;
    }
  };

  const pushProcessNote = (part: NotePart) => {
    pendingProcessNotes.push({
      type: "note",
      key: `${messageId}:process-note-${processNoteGroupIndex++}-${part.id}`,
      part,
    });
  };

  for (const part of parts) {
    if (part.type === "tool" && part.phase === "question") {
      flushActivity();
      const group: AssistantPartGroup = {
        type: "question",
        key: `${messageId}:question-${part.id}`,
        part,
      };
      answerGroups.push(group);
      orderedGroups.push(group);
      continue;
    }
    if (part.type === "tool" && part.phase === "approval") {
      flushActivity();
      const group: AssistantPartGroup = {
        type: "approval",
        key: `${messageId}:approval-${part.id}`,
        part,
      };
      answerGroups.push(group);
      orderedGroups.push(group);
      continue;
    }
    if (part.type === "tool" || part.type === "skill" || part.type === "reasoning") {
      activityParts.push(part);
      continue;
    }
    if (part.type === "note" && isProcessNotePart(part)) {
      if (isNativeAgentCommentaryNote(part) || isCompactionNotePart(part)) {
        flushActivity();
        const group: AssistantPartGroup = {
          type: "note",
          key: `${messageId}:process-note-${processNoteGroupIndex++}-${part.id}`,
          part,
        };
        processGroups.push(group);
        orderedGroups.push(group);
        continue;
      }
      pushProcessNote(part);
      continue;
    }
    flushActivity();
    if (part.type === "text") {
      const group: AssistantPartGroup = { type: "text", part };
      answerGroups.push(group);
      orderedGroups.push(group);
    } else if (part.type === "note") {
      const group: AssistantPartGroup = { type: "note", key: `${messageId}:note-${part.id}`, part };
      answerGroups.push(group);
      orderedGroups.push(group);
    }
  }

  flushActivity();
  const visibleProcessGroups = hideConnectorTransportNotesWhenNativeActivity(processGroups);
  const visibleProcessGroupSet = new Set(visibleProcessGroups);
  const visibleOrderedGroups = orderedGroups.filter(
    (group) => !processGroups.includes(group) || visibleProcessGroupSet.has(group),
  );
  return {
    answerGroups,
    processGroups: visibleProcessGroups,
    segments: assistantTurnSegments(visibleOrderedGroups, visibleProcessGroupSet),
  };
}

function assistantTurnSegments(
  groups: AssistantPartGroup[],
  processGroupSet: ReadonlySet<AssistantPartGroup>,
): AssistantTurnSegment[] {
  const segments: AssistantTurnSegment[] = [];
  let pendingProcessGroups: AssistantPartGroup[] = [];
  let processSegmentIndex = 0;

  const flushProcessSegment = () => {
    if (!pendingProcessGroups.length) return;
    const firstGroup = pendingProcessGroups[0];
    const firstKey = firstGroup && "key" in firstGroup ? firstGroup.key : `process-${processSegmentIndex}`;
    segments.push({
      type: "process",
      key: `process-segment-${processSegmentIndex++}-${firstKey}`,
      groups: pendingProcessGroups,
    });
    pendingProcessGroups = [];
  };

  groups.forEach((group, index) => {
    if (processGroupSet.has(group)) {
      pendingProcessGroups.push(group);
      return;
    }
    flushProcessSegment();
    const key = "key" in group ? group.key : `${group.type}-${group.part.id}-${index}`;
    segments.push({ type: "content", key, group });
  });
  flushProcessSegment();
  return segments;
}

function isCompactionNotePart(part: NotePart): boolean {
  return part.tone === "compaction-started" || part.tone === "compaction-finished";
}

/**
 * 判定一条 note 是否为 agent 过程评注(区别于最终正文)。
 *
 * Source-neutral:不依赖具体 source 字符串,只依据 agent_message 的 phase 语义。
 * 最终答案类 phase(final_answer/answer/final,或无 phase)视为正文 → false;
 * 其余 phase(commentary/thinking/reasoning 等)视为评注 → true。
 *
 * 这样新 kernel 接入无需改本函数:只要其 projector 把最终答案标为 final_answer 类、
 * 过程输出标为其它 phase,判定即自动正确。
 */
export function isNativeAgentCommentaryNote(part: NotePart): boolean {
  const data = recordLike(part.data);
  if (!data || data.kind !== "agent_message") {
    return false;
  }
  const phase = typeof data.phase === "string" ? data.phase : "";
  return !isFinalAnswerPhase(phase);
}

/** 最终答案类 phase:这些视为正文,不是过程评注。无 phase 也按正文处理。 */
function isFinalAnswerPhase(phase: string): boolean {
  return !phase || phase === "final_answer" || phase === "answer" || phase === "final";
}

export function isConnectorProcessNote(text: string): boolean {
  return /^(已派发到本机 Connector|Connector\b|正在运行工具|已运行工具|本机 Connector)/.test(text.trim());
}

export function isProcessNotePart(part: NotePart): boolean {
  return (
    part.tone === "diagnostic" ||
    part.tone === "status" ||
    part.tone === "guidance" ||
    part.tone === "compaction-started" ||
    part.tone === "compaction-finished"
  );
}

export function processGroupsToActivityEntries(groups: AssistantPartGroup[]): ActivityEntry[] {
  const activityParts: Array<ToolPart | SkillPart | ReasoningPart> = [];
  const groupKeyByPartId = new Map<string, string>();
  groups.forEach((group) => {
    if (group.type !== "activity") return;
    group.parts.forEach((part) => {
      activityParts.push(part);
      groupKeyByPartId.set(part.id, group.key);
    });
  });
  return buildActivityItems(activityParts).map((item) => {
    const anchorPart =
      item.type === "skill" || item.type === "question" || item.type === "approval" || item.type === "reasoning"
        ? item.part
        : (item.call ?? item.result);
    return {
      groupKey: groupKeyByPartId.get(anchorPart?.id ?? "") ?? "",
      item,
    };
  });
}

export function summarizeProcessGroups(
  groups: AssistantPartGroup[],
  flags: ProcessSummaryFlags,
  t: TranslationFn = translate,
): string {
  const entries = processGroupsToActivityEntries(groups);
  const items = entries.map((entry) => entry.item);
  if (items.length) {
    const runningItems = items.filter((item) => activityItemStatus(item) === "running");
    if (flags.active && runningItems.length) {
      return summarizeActivityItems(runningItems, {
        active: true,
        pendingQuestion: flags.pendingQuestion,
        pendingApproval: flags.pendingApproval,
        activeChoiceForm: flags.activeChoiceForm,
      });
    }
    const completedItems = runningItems.length ? items.filter((item) => activityItemStatus(item) !== "running") : items;
    const summaryItems = completedItems.length ? completedItems : items;
    return summarizeActivityItems(summaryItems, {
      active: flags.active && !completedItems.length,
      pendingQuestion: flags.pendingQuestion,
      pendingApproval: flags.pendingApproval,
      activeChoiceForm: flags.activeChoiceForm,
    });
  }
  if (flags.active) {
    return t("chat.processing");
  }
  const noteCount = groups.filter((group) => group.type === "note").length;
  return t("chat.processNotesRecorded", { count: noteCount });
}

export function processGroupsHaveRunningActivity(groups: AssistantPartGroup[]): boolean {
  return processGroupsToActivityEntries(groups).some(({ item }) => activityItemStatus(item) === "running");
}

function hideConnectorTransportNotesWhenNativeActivity(groups: AssistantPartGroup[]): AssistantPartGroup[] {
  if (!processGroupsToActivityEntries(groups).some(({ item }) => activityItemKind(item) !== "connector")) {
    return groups;
  }
  return groups.filter((group) => group.type !== "note" || !isConnectorProcessNote(group.part.text));
}

function recordLike(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
