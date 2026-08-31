import type { AgentEventRecord, JsonValue, ToolPart } from "../../bridge";
import { processGroupsToActivityEntries, type AssistantPartGroup } from "./assistant-run-view-model";
import { activityItemKind, activityItemStatus, type ActivityItem } from "./message-activity-model";
import type { OrbState } from "thinking-orbs";

const WORKING_EVENT_TYPES = new Set([
  "turn.started",
  "turn.finished",
  "model.requested",
  "tool.finished",
  "approval.requested",
  "approval.resolved",
  "question.requested",
  "question.answered",
  "planning.updated",
  "skill.invoked",
  "skill.loaded",
  "skill.forked",
  "skill.cleared",
  "compaction.started",
  "compaction.finished",
  "run.paused",
  "run.resumed",
  "memory.written",
  "error",
]);

/**
 * Resolve the small set of product-facing agent phases from signals the runtime
 * already emits. Event order wins; visible running activity is only a fallback
 * for restored messages or concurrent tools.
 */
export function agentOrbStateFromRun(
  events: AgentEventRecord[] | undefined,
  processGroups: AssistantPartGroup[] = [],
  runId = "",
): OrbState {
  let state: OrbState = "working";
  let hasPhaseEvent = false;
  let latestPhaseType = "";

  // Runtime events are global to the thread on some surfaces. Without a runId
  // there is no safe way to attribute them to this message, so fail closed and
  // derive the phase from this message's own visible process groups instead.
  for (const event of runId ? (events ?? []) : []) {
    if (event?.runId !== runId) continue;
    const type = String(event?.type || "");
    if (type === "assistant.delta" || type === "model.response" || type === "assistant.final") {
      state = "composing";
      hasPhaseEvent = true;
      latestPhaseType = type;
      continue;
    }
    if (type === "tool.started") {
      state = orbStateForToolEvent(event);
      hasPhaseEvent = true;
      latestPhaseType = type;
      continue;
    }
    if (WORKING_EVENT_TYPES.has(type)) {
      state = "working";
      hasPhaseEvent = true;
      latestPhaseType = type;
    }
  }

  const runningState = orbStateForRunningActivity(processGroups);
  if (!hasPhaseEvent || (latestPhaseType === "tool.finished" && runningState !== "working")) {
    return runningState;
  }
  return state;
}

function orbStateForRunningActivity(processGroups: AssistantPartGroup[]): OrbState {
  const runningItems = processGroupsToActivityEntries(processGroups)
    .map((entry) => entry.item)
    .filter((item) => activityItemStatus(item) === "running");
  const latestRunningItem = runningItems.at(-1);
  return latestRunningItem && isExplorationActivity(latestRunningItem) ? "searching" : "working";
}

function orbStateForToolEvent(event: AgentEventRecord): OrbState {
  return isExplorationActivity(toolEventActivityItem(event)) ? "searching" : "working";
}

function isExplorationActivity(item: ActivityItem): boolean {
  const kind = activityItemKind(item);
  return kind === "search" || kind === "read";
}

function toolEventActivityItem(event: AgentEventRecord): ActivityItem {
  const toolId = typeof event.toolId === "string" && event.toolId ? event.toolId : "tool";
  const part: ToolPart = {
    id: `runtime:${toolId}`,
    type: "tool",
    phase: "call",
    toolId,
    title: toolId,
    input: event.input as JsonValue | undefined,
    status: "running",
    error: "",
    approvalId: "",
    approvalStatus: "",
    approvalReason: "",
    questionId: "",
    questionStatus: "",
    questionPrompt: "",
  };
  return { type: "tool", key: part.id, call: part };
}
