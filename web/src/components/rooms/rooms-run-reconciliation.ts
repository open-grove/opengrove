import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { AgentEventRecord, MessagePart, RunRecord } from "../../bridge";
import { finalizeRoomMessageFromRun, roomMessageText } from "./room-message-model";
import {
  normalizeClientConnectorHelpText,
  normalizeClientConnectorMessageParts,
} from "./rooms-legacy-message-normalization";
import {
  finalRoomAnswerFromEvents,
  hasTerminalRoomEvent,
  isFailedRunLifecycle,
  isTerminalRunLifecycle,
  runDurationLabel,
  runRecordFinalAnswer,
  runRecordId,
} from "./rooms-guide";
import { nowIso, type MessageStatus, type Room, type RoomMember } from "./rooms-model";

export function useRoomRunReconciliation(input: {
  rooms: Room[];
  runs?: RunRecord[];
  activeRunIds: Set<string>;
  allRoomRunIds: Set<string>;
  allRoomRuntimeEventsByRunId: Map<string, AgentEventRecord[]>;
  runningRoomRunIds: Set<string>;
  runningRoomEventsByRunId: Map<string, AgentEventRecord[]>;
  runsById: Map<string, RunRecord>;
  setRooms: Dispatch<SetStateAction<Room[]>>;
  setMembers: Dispatch<SetStateAction<RoomMember[]>>;
}) {
  useEffect(() => {
    if (input.runningRoomRunIds.size === 0) return;
    const terminalRuns = new Map<string, RunRecord>();
    for (const run of input.runs ?? []) {
      const runId = runRecordId(run);
      if (runId && input.runningRoomRunIds.has(runId) && isTerminalRunLifecycle(run)) {
        terminalRuns.set(runId, run);
      }
    }

    const terminalRunIds = new Set(terminalRuns.keys());
    for (const [runId, events] of input.runningRoomEventsByRunId) {
      if (hasTerminalRoomEvent(events)) {
        terminalRunIds.add(runId);
      }
    }
    if (terminalRunIds.size === 0) return;

    const completedMemberIds = new Set<string>();
    for (const room of input.rooms) {
      for (const message of room.messages) {
        if (
          message.senderType === "agent" &&
          message.status === "running" &&
          message.runId &&
          terminalRunIds.has(message.runId)
        ) {
          completedMemberIds.add(message.senderId);
        }
      }
    }

    input.setRooms((current) => {
      let changed = false;
      const nextRooms = current.map((room) => {
        let roomChanged = false;
        const messages = room.messages.map((message) => {
          if (
            message.senderType !== "agent" ||
            message.status !== "running" ||
            !message.runId ||
            !terminalRunIds.has(message.runId)
          ) {
            return message;
          }
          const run = terminalRuns.get(message.runId);
          const events = input.runningRoomEventsByRunId.get(message.runId);
          const normalizedEvents = normalizeConnectorRunEvents(events);
          const status: MessageStatus =
            isFailedRunLifecycle(run) || events?.some((event) => event?.type === "error") ? "failed" : "done";
          const answer = normalizeConnectorRunAnswer(
            finalRoomAnswerFromEvents(normalizedEvents) || runRecordFinalAnswer(run),
          );
          roomChanged = true;
          changed = true;
          return normalizeConnectorRoomMessage(
            finalizeRoomMessageFromRun(message, normalizedEvents, status, runDurationLabel(run), answer),
          );
        });
        return roomChanged ? { ...room, messages, updatedAt: nowIso() } : room;
      });
      return changed ? nextRooms : current;
    });
    if (completedMemberIds.size > 0) {
      input.setMembers((current) =>
        current.map((member) =>
          completedMemberIds.has(member.id) && member.status === "running"
            ? { ...member, status: "done", lastActive: "刚刚" }
            : member,
        ),
      );
    }
  }, [input]);

  useEffect(() => {
    if (input.allRoomRunIds.size === 0) return;
    input.setRooms((current) => {
      let changed = false;
      const nextRooms = current.map((room) => {
        let roomChanged = false;
        const messages = room.messages.map((message) => {
          if (message.senderType !== "agent" || !message.runId || message.status === "running") {
            return message;
          }
          const run = input.runsById.get(message.runId);
          const events = input.allRoomRuntimeEventsByRunId.get(message.runId);
          const normalizedEvents = normalizeConnectorRunEvents(events);
          const eventAnswer = normalizeConnectorRunAnswer(finalRoomAnswerFromEvents(normalizedEvents));
          const currentText = roomMessageText(message).trim();
          const answer = eventAnswer || (!currentText ? normalizeConnectorRunAnswer(runRecordFinalAnswer(run)) : "");
          if (!answer) {
            return message;
          }
          if (eventAnswer && currentText === eventAnswer.trim()) {
            return message;
          }
          const status: MessageStatus =
            isFailedRunLifecycle(run) || events?.some((event) => event?.type === "error") ? "failed" : "done";
          roomChanged = true;
          changed = true;
          return normalizeConnectorRoomMessage(
            finalizeRoomMessageFromRun(
              message,
              normalizedEvents,
              status,
              message.duration || runDurationLabel(run),
              answer,
            ),
          );
        });
        return roomChanged ? { ...room, messages, updatedAt: nowIso() } : room;
      });
      return changed ? nextRooms : current;
    });
  }, [input]);

  // Long-running runs can legitimately outlive the recent run window. Only
  // terminal run records/events should finalize a message; absence from
  // the latest poll is not proof that the run was interrupted.
}

function normalizeConnectorRunAnswer(answer: string): string {
  return answer ? normalizeClientConnectorHelpText(answer) : "";
}

function normalizeConnectorRunEvents(events: AgentEventRecord[] | undefined): AgentEventRecord[] | undefined {
  if (!Array.isArray(events)) return events;
  let changed = false;
  const normalized = events.map((event) => {
    if (event?.type === "assistant.final" && typeof event.text === "string") {
      const text = normalizeClientConnectorHelpText(event.text);
      if (text === event.text) return event;
      changed = true;
      return { ...event, text };
    }
    if (event?.type !== "model.response" || typeof event.response?.text !== "string") return event;
    const text = normalizeClientConnectorHelpText(event.response.text);
    if (text === event.response.text) return event;
    changed = true;
    return { ...event, response: { ...event.response, text } };
  });
  return changed ? normalized : events;
}

function normalizeConnectorRoomMessage<T extends { text: string; parts?: MessagePart[] }>(message: T): T {
  const text = normalizeClientConnectorHelpText(message.text);
  const parts = normalizeClientConnectorMessageParts(message.parts);
  if (text === message.text && parts === message.parts) return message;
  return { ...message, text, ...(parts === message.parts ? {} : { parts }) };
}
