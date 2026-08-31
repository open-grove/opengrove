import type { AgentEventRecord, RunRecord } from "../../bridge";
import type { RoomMember } from "./rooms-model";

export function runRecordId(run: RunRecord | undefined): string {
  return String(run?.id || run?.runId || "");
}

export function runRecordUpdatedAt(run: RunRecord): string {
  return String(run.finishedAt || run.endedAt || run.updatedAt || run.startedAt || run.createdAt || "");
}

export function isTerminalRunStatus(status: unknown): boolean {
  return !["", "running", "pending", "queued", "waiting_for_approval", "waiting_for_user"].includes(
    String(status || "").toLowerCase(),
  );
}

export function isFailedRunStatus(status: unknown): boolean {
  return ["failed", "error", "cancelled", "canceled"].includes(String(status || "").toLowerCase());
}

export function runDurationLabel(run: RunRecord | undefined): string | undefined {
  if (!run) return undefined;
  const started = new Date(String(run.startedAt || run.createdAt || "")).getTime();
  const finished = new Date(runRecordUpdatedAt(run)).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return undefined;
  }
  return `${Math.max(0.1, (finished - started) / 1000).toFixed(1)}s`;
}

export function groupEventsByRunId(
  events: AgentEventRecord[] | undefined,
  allowedRunIds: Set<string>,
): Map<string, AgentEventRecord[]> {
  const grouped = new Map<string, AgentEventRecord[]>();
  if (!events?.length || allowedRunIds.size === 0) return grouped;
  for (const event of events) {
    const runId = typeof event?.runId === "string" ? event.runId : "";
    if (!runId || !allowedRunIds.has(runId)) continue;
    const list = grouped.get(runId);
    if (list) {
      list.push(event);
    } else {
      grouped.set(runId, [event]);
    }
  }
  return grouped;
}

export function hasTerminalRoomEvent(events: AgentEventRecord[] | undefined): boolean {
  return Boolean(
    events?.some(
      (event) => event?.type === "turn.finished" || event?.type === "error" || event?.type === "assistant.final",
    ),
  );
}

export function finalRoomAnswerFromEvents(events: AgentEventRecord[] | undefined): string {
  if (!Array.isArray(events)) return "";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const text = event?.type === "assistant.final" ? event.text : "";
    if (typeof text === "string" && text.trim()) return text;
  }
  return "";
}

export function runRecordFinalAnswer(run: RunRecord | undefined): string {
  if (!run || !isTerminalRunStatus(run.status)) return "";
  if (isFailedRunStatus(run.status)) return String(run.error || "").trim();
  const summary = String(run.summary || "").trim();
  const input = String(run.input || "").trim();
  return summary && summary !== input ? summary : "";
}

export function removedMemberForRoom(
  member: RoomMember,
  deletedMemberIds: Set<string>,
  removedLabel = "Removed",
): RoomMember {
  if (!member.disabled && !deletedMemberIds.has(member.id)) return member;
  return {
    ...member,
    disabled: true,
    status: "offline",
    lastActive: removedLabel,
  };
}
