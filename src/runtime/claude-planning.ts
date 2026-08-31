import type { AgentEvent, JsonObject, JsonValue, PlanningUpdate } from "../core.js";
import { asJsonValue, isJsonObject, readString } from "./codex/json.js";

interface ClaudePlanningTask {
  id: string;
  content: string;
  status: string;
}

export interface ClaudePlanningState {
  seenTodoLikeTool: boolean;
  tasks: Map<string, ClaudePlanningTask>;
  pendingTaskIdsByCallId: Map<string, string>;
}

export function createClaudePlanningState(): ClaudePlanningState {
  return {
    seenTodoLikeTool: false,
    tasks: new Map(),
    pendingTaskIdsByCallId: new Map(),
  };
}

export function claudePlanningEventsForToolStarted(input: {
  runId: string;
  callId?: string;
  toolName: string;
  toolInput: JsonValue;
  state: ClaudePlanningState;
}): AgentEvent[] {
  const toolKind = claudePlanningToolKind(input.toolName);
  let plan: PlanningUpdate | undefined;
  if (toolKind === "todowrite") {
    plan = todoWritePlanningUpdate(input.toolInput, input.toolName);
  } else if (toolKind === "taskcreate") {
    plan = taskCreatePlanningUpdate(input);
  }
  if (plan) {
    input.state.seenTodoLikeTool = true;
    return [{ type: "planning.updated", runId: input.runId, plan }];
  }
  if (toolKind === "task" && !input.state.seenTodoLikeTool) {
    const fallbackPlan = taskPlanningUpdate(input.toolInput, input.toolName, "in_progress");
    return fallbackPlan ? [{ type: "planning.updated", runId: input.runId, plan: fallbackPlan }] : [];
  }
  return [];
}

export function claudePlanningEventsForToolFinished(input: {
  runId: string;
  callId?: string;
  toolName: string;
  toolInput: JsonValue;
  toolResult?: JsonValue;
  resultOk?: boolean;
  state: ClaudePlanningState;
}): AgentEvent[] {
  const toolKind = claudePlanningToolKind(input.toolName);
  let plan: PlanningUpdate | undefined;
  if (toolKind === "taskcreate") {
    plan = finishTaskCreatePlanningUpdate(input);
  } else if (toolKind === "taskupdate" && input.resultOk !== false) {
    plan = finishTaskUpdatePlanningUpdate(input);
  } else if (toolKind === "tasklist" && input.resultOk !== false) {
    plan = finishTaskListPlanningUpdate(input);
  }
  if (plan) {
    input.state.seenTodoLikeTool = true;
    return [{ type: "planning.updated", runId: input.runId, plan }];
  }
  if (toolKind !== "task" || input.state.seenTodoLikeTool) {
    return [];
  }
  const fallbackPlan = taskPlanningUpdate(input.toolInput, input.toolName, "completed");
  return fallbackPlan ? [{ type: "planning.updated", runId: input.runId, plan: fallbackPlan }] : [];
}

function todoWritePlanningUpdate(input: JsonValue, toolName: string): PlanningUpdate | undefined {
  const record = recordValue(input);
  const todos = planningItemsFromTodos(
    firstTodoArray(record.todos, record.items, record.tasks, record.entries, record.plan),
    "pending",
  );
  if (!todos.length) return undefined;
  return {
    id: "claude-todowrite",
    title: toolName,
    text: planText(todos),
    status: planStatus(todos),
    raw: {
      toolName,
      todos: todos.map((todo) => ({ content: todo.content, status: todo.status })),
      input: asJsonValue(input),
    },
    updatedAt: new Date().toISOString(),
    source: { type: "kernel.native", kernelId: "claude-code" },
  };
}

function taskCreatePlanningUpdate(input: {
  callId?: string;
  toolName: string;
  toolInput: JsonValue;
  state: ClaudePlanningState;
}): PlanningUpdate | undefined {
  const record = recordValue(input.toolInput);
  const content = taskContent(record);
  if (!content) return undefined;
  const temporaryId = `pending:${input.callId ?? stablePlanIdPart(content)}`;
  input.state.tasks.set(temporaryId, {
    id: temporaryId,
    content,
    status: normalizeClaudeTodoStatus(readString(record, "status") ?? "", "pending"),
  });
  if (input.callId) {
    input.state.pendingTaskIdsByCallId.set(input.callId, temporaryId);
  }
  return taskListPlanningUpdate(input.state, input.toolName, input.toolInput);
}

function finishTaskCreatePlanningUpdate(input: {
  callId?: string;
  toolName: string;
  toolInput: JsonValue;
  toolResult?: JsonValue;
  resultOk?: boolean;
  state: ClaudePlanningState;
}): PlanningUpdate | undefined {
  const pendingId = input.callId ? input.state.pendingTaskIdsByCallId.get(input.callId) : undefined;
  if (input.callId) {
    input.state.pendingTaskIdsByCallId.delete(input.callId);
  }
  if (input.resultOk === false) {
    if (!pendingId || !input.state.tasks.delete(pendingId)) return undefined;
    return taskListPlanningUpdate(input.state, input.toolName, input.toolInput, input.toolResult);
  }

  const resultTask = recordValue(recordValue(input.toolResult).task);
  const actualId = readString(resultTask, "id");
  if (!actualId) return undefined;
  const pendingTask = pendingId ? input.state.tasks.get(pendingId) : undefined;
  const content =
    readString(resultTask, "subject") ?? pendingTask?.content ?? taskContent(recordValue(input.toolInput));
  if (!content) return undefined;
  if (pendingId) {
    input.state.tasks.delete(pendingId);
  }
  input.state.tasks.set(actualId, {
    id: actualId,
    content,
    status: pendingTask?.status ?? "pending",
  });
  return taskListPlanningUpdate(input.state, input.toolName, input.toolInput, input.toolResult);
}

function finishTaskUpdatePlanningUpdate(input: {
  toolName: string;
  toolInput: JsonValue;
  toolResult?: JsonValue;
  state: ClaudePlanningState;
}): PlanningUpdate | undefined {
  const result = recordValue(input.toolResult);
  if (result.success === false) return undefined;
  const inputRecord = recordValue(input.toolInput);
  const taskId = readString(result, "taskId") ?? readString(inputRecord, "taskId");
  if (!taskId) return undefined;
  const statusChange = recordValue(result.statusChange);
  const status = readString(statusChange, "to") ?? readString(inputRecord, "status");
  const existing = input.state.tasks.get(taskId);
  if (status?.trim().toLowerCase() === "deleted") {
    if (!existing) return undefined;
    input.state.tasks.delete(taskId);
    return taskListPlanningUpdate(input.state, input.toolName, input.toolInput, input.toolResult);
  }
  const content = taskContent(inputRecord) || existing?.content;
  if (!content) return undefined;
  const normalizedStatus = normalizeClaudeTodoStatus(status ?? "", existing?.status ?? "pending");
  if (existing?.content === content && existing.status === normalizedStatus) return undefined;
  input.state.tasks.set(taskId, { id: taskId, content, status: normalizedStatus });
  return taskListPlanningUpdate(input.state, input.toolName, input.toolInput, input.toolResult);
}

function finishTaskListPlanningUpdate(input: {
  toolName: string;
  toolInput: JsonValue;
  toolResult?: JsonValue;
  state: ClaudePlanningState;
}): PlanningUpdate | undefined {
  const result = recordValue(input.toolResult);
  if (!Array.isArray(result.tasks)) return undefined;
  const tasks = result.tasks
    .map(recordValue)
    .map((task): ClaudePlanningTask | undefined => {
      const id = readString(task, "id");
      const content = taskContent(task);
      if (!id || !content) return undefined;
      return {
        id,
        content,
        status: normalizeClaudeTodoStatus(readString(task, "status") ?? "", "pending"),
      };
    })
    .filter((task): task is ClaudePlanningTask => Boolean(task));
  input.state.tasks.clear();
  for (const task of tasks) {
    input.state.tasks.set(task.id, task);
  }
  return taskListPlanningUpdate(input.state, input.toolName, input.toolInput, input.toolResult);
}

function taskListPlanningUpdate(
  state: ClaudePlanningState,
  toolName: string,
  input: JsonValue,
  result?: JsonValue,
): PlanningUpdate {
  const tasks = [...state.tasks.values()];
  return {
    id: "claude-tasks",
    title: "Tasks",
    text: planText(tasks),
    status: planStatus(tasks),
    raw: {
      toolName,
      tasks: tasks.map((task) => ({ id: task.id, content: task.content, status: task.status })),
      input: asJsonValue(input),
      ...(result !== undefined ? { result: asJsonValue(result) } : {}),
    },
    updatedAt: new Date().toISOString(),
    source: { type: "kernel.native", kernelId: "claude-code" },
  };
}

function taskPlanningUpdate(
  input: JsonValue,
  toolName: string,
  status: "completed" | "in_progress",
): PlanningUpdate | undefined {
  const record = recordValue(input);
  const item = singleTaskItem(record, status);
  if (!item) return undefined;
  const todos = [item];
  return {
    id: `claude-task:${stablePlanIdPart(item.content)}`,
    title: "Task",
    text: planText(todos),
    status,
    raw: {
      toolName,
      task: item,
      input: asJsonValue(input),
    },
    updatedAt: new Date().toISOString(),
    source: { type: "kernel.native", kernelId: "claude-code" },
  };
}

function planningItemsFromTodos(
  items: JsonObject[] | undefined,
  defaultStatus: string,
): Array<{ content: string; status: string }> {
  return (items ?? [])
    .map((item) => ({
      content:
        readString(item, "content") ??
        readString(item, "text") ??
        readString(item, "title") ??
        readString(item, "description") ??
        "",
      status: normalizeClaudeTodoStatus(readString(item, "status") ?? readString(item, "state") ?? "", defaultStatus),
    }))
    .filter((item) => item.content);
}

function singleTaskItem(record: JsonObject, defaultStatus: string): { content: string; status: string } | undefined {
  const content = taskContent(record);
  if (!content) return undefined;
  return {
    content,
    status: normalizeClaudeTodoStatus(readString(record, "status") ?? readString(record, "state") ?? "", defaultStatus),
  };
}

function taskContent(record: JsonObject): string {
  return (
    readString(record, "subject") ??
    readString(record, "description") ??
    readString(record, "prompt") ??
    readString(record, "task") ??
    readString(record, "content") ??
    readString(record, "title") ??
    ""
  );
}

function firstTodoArray(...values: unknown[]): JsonObject[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const records = value.map(recordValue).filter((item) => Object.keys(item).length > 0);
    if (records.length) return records;
  }
  return undefined;
}

function planText(items: Array<{ content: string; status: string }>): string {
  return items.map((item, index) => `${index + 1}. [${item.status}] ${item.content}`).join("\n");
}

function planStatus(items: Array<{ status: string }>): string {
  if (items.some((item) => item.status === "in_progress")) return "in_progress";
  if (items.length && items.every((item) => item.status === "completed")) return "completed";
  return "updated";
}

function normalizeClaudeTodoStatus(status: string, fallback = "pending"): string {
  const normalized = status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (["completed", "complete", "done", "finished", "success", "succeeded"].includes(normalized)) {
    return "completed";
  }
  if (["inprogress", "in_progress", "active", "running", "current", "doing"].includes(normalized)) {
    return "in_progress";
  }
  if (["pending", "todo", "not_started"].includes(normalized)) {
    return "pending";
  }
  return fallback;
}

function claudePlanningToolKind(
  toolName: string,
): "task" | "taskcreate" | "tasklist" | "taskupdate" | "todowrite" | undefined {
  const normalized = toolName
    .replace(/^claude[._-]?/i, "")
    .replace(/[\s._-]+/g, "")
    .toLowerCase();
  if (normalized === "todowrite") return "todowrite";
  if (normalized === "taskcreate") return "taskcreate";
  if (normalized === "tasklist") return "tasklist";
  if (normalized === "taskupdate") return "taskupdate";
  if (normalized === "task") return "task";
  return undefined;
}

function recordValue(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function stablePlanIdPart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task"
  );
}
