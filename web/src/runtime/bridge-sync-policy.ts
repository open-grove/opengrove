import type { AgentEventRecord } from "../bridge";

const PENDING_ACTION_EVENT_TYPES = new Set([
  "approval.requested",
  "approval.resolved",
  "question.requested",
  "question.answered",
]);

export function pendingActionEventMarker(events: AgentEventRecord[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event?.type || !PENDING_ACTION_EVENT_TYPES.has(event.type)) continue;
    const action = event.type.startsWith("approval.") ? record(event.request) : record(event.question);
    return [
      event.type,
      stringValue(action.id),
      stringValue(action.status),
      stringValue(action.updatedAt),
      stringValue(event.at),
    ].join(":");
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
