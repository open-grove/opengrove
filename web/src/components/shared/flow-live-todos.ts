import type { AgentEventRecord } from "../../bridge";

export type FlowLiveTodoStatus = "completed" | "in_progress" | "pending";

export interface FlowLiveTodo {
  content: string;
  status: FlowLiveTodoStatus;
}

export function extractFlowLiveTodos(events: AgentEventRecord[]): FlowLiveTodo[] {
  let latest: FlowLiveTodo[] = [];
  for (const event of events) {
    if (event?.type !== "planning.updated") continue;
    const todos = extractTodosFromPlan(recordValue(event.plan));
    if (todos.length) latest = todos;
  }
  return latest;
}

function extractTodosFromPlan(plan: Record<string, unknown>): FlowLiveTodo[] {
  for (const candidate of planningListCandidates(plan)) {
    const todos = candidate.map(todoFromItem).filter((todo): todo is FlowLiveTodo => Boolean(todo));
    if (todos.length) return todos;
  }
  return todosFromText(stringValue(plan.text));
}

function planningListCandidates(plan: Record<string, unknown>): Record<string, unknown>[][] {
  const raw = recordValue(plan.raw);
  const rawPlan = recordValue(raw.plan);
  return [
    arrayRecords(plan.todos),
    arrayRecords(plan.items),
    arrayRecords(plan.steps),
    arrayRecords(plan.entries),
    arrayRecords(plan.plan),
    arrayRecords(raw.todos),
    arrayRecords(raw.items),
    arrayRecords(raw.steps),
    arrayRecords(raw.entries),
    arrayRecords(raw.plan),
    arrayRecords(rawPlan.todos),
    arrayRecords(rawPlan.items),
    arrayRecords(rawPlan.steps),
    arrayRecords(rawPlan.entries),
  ].filter((items) => items.length > 0);
}

function todoFromItem(item: Record<string, unknown>): FlowLiveTodo | undefined {
  const content = [
    stringValue(item.content),
    stringValue(item.text),
    stringValue(item.step),
    stringValue(item.title),
    stringValue(item.description),
  ].find(Boolean);
  if (!content) return undefined;
  return {
    content,
    status: normalizeTodoStatus(stringValue(item.status) || stringValue(item.state)),
  };
}

function todosFromText(text: string): FlowLiveTodo[] {
  if (!text) return [];
  const todos: FlowLiveTodo[] = [];
  for (const line of text.split("\n")) {
    const statusLine = line.match(/^\s*(?:[-*]|\d+[.)])\s*\[([^\]]+)]\s+(.+?)\s*$/);
    if (statusLine?.[2]) {
      todos.push({
        content: statusLine[2].trim(),
        status: normalizeTodoStatus(statusLine[1] || ""),
      });
      continue;
    }
    const checkboxLine = line.match(/^\s*[-*]\s+\[([ xX])]\s+(.+?)\s*$/);
    if (checkboxLine?.[2]) {
      todos.push({
        content: checkboxLine[2].trim(),
        status: checkboxLine[1]?.toLowerCase() === "x" ? "completed" : "pending",
      });
    }
  }
  return todos;
}

function normalizeTodoStatus(status: string): FlowLiveTodoStatus {
  const normalized = status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (["completed", "complete", "done", "finished", "succeeded", "success", "checked", "x"].includes(normalized)) {
    return "completed";
  }
  if (["inprogress", "in_progress", "running", "active", "working", "current", "doing"].includes(normalized)) {
    return "in_progress";
  }
  return "pending";
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordValue).filter((item) => Object.keys(item).length > 0) : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
