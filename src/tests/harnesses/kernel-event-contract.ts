import type { AgentEvent } from "../../core.js";

export interface AgentTurnEventInspection {
  turnStartedCount: number;
  turnFinishedCount: number;
  assistantDeltaCount: number;
  modelResponseCount: number;
  lifecycleClosedExactlyOnce: boolean;
  assistantDeltaBeforeResponse: boolean;
  modelResponseBeforeTurnFinished: boolean;
  assistantTextMatchesResponse: boolean;
  assistantText: string;
  responseText: string;
}

export function inspectAgentTurnEvents(events: AgentEvent[]): AgentTurnEventInspection {
  const turnStartedIndexes = eventIndexes(events, "turn.started");
  const turnFinishedIndexes = eventIndexes(events, "turn.finished");
  const assistantDeltaIndexes = eventIndexes(events, "assistant.delta");
  const modelResponseIndexes = eventIndexes(events, "model.response");
  const assistantText = events
    .filter((event): event is Extract<AgentEvent, { type: "assistant.delta" }> => event.type === "assistant.delta")
    .map((event) => event.text)
    .join("");
  const responses = events.filter(
    (event): event is Extract<AgentEvent, { type: "model.response" }> => event.type === "model.response",
  );
  const responseText = responses.length === 1 ? (responses[0]?.response.text ?? "") : "";
  const firstStarted = turnStartedIndexes[0];
  const firstFinished = turnFinishedIndexes[0];
  const firstDelta = assistantDeltaIndexes[0];
  const lastDelta = assistantDeltaIndexes.at(-1);
  const firstResponse = modelResponseIndexes[0];

  return {
    turnStartedCount: turnStartedIndexes.length,
    turnFinishedCount: turnFinishedIndexes.length,
    assistantDeltaCount: assistantDeltaIndexes.length,
    modelResponseCount: modelResponseIndexes.length,
    lifecycleClosedExactlyOnce:
      turnStartedIndexes.length === 1 &&
      turnFinishedIndexes.length === 1 &&
      firstStarted !== undefined &&
      firstFinished !== undefined &&
      firstStarted < firstFinished,
    assistantDeltaBeforeResponse:
      firstDelta !== undefined &&
      lastDelta !== undefined &&
      modelResponseIndexes.length === 1 &&
      firstStarted !== undefined &&
      firstResponse !== undefined &&
      firstStarted < firstDelta &&
      lastDelta < firstResponse,
    modelResponseBeforeTurnFinished:
      modelResponseIndexes.length === 1 &&
      turnFinishedIndexes.length === 1 &&
      firstStarted !== undefined &&
      firstResponse !== undefined &&
      firstFinished !== undefined &&
      firstStarted < firstResponse &&
      firstResponse < firstFinished,
    assistantTextMatchesResponse:
      assistantDeltaIndexes.length > 0 && responses.length === 1 && assistantText === responseText,
    assistantText,
    responseText,
  };
}

export function hasFinishedTool(events: AgentEvent[], toolId: string): boolean {
  return events.some((event) => event.type === "tool.finished" && event.toolId === toolId);
}

export function hasCorrelatedToolProgress(events: AgentEvent[], matchesTool: (toolId: string) => boolean): boolean {
  for (let progressIndex = 0; progressIndex < events.length; progressIndex += 1) {
    const progress = events[progressIndex];
    if (progress?.type !== "tool.progress" || !matchesTool(progress.toolId) || !progress.callId) continue;
    const started = events.findIndex(
      (event, index) =>
        index < progressIndex &&
        event.type === "tool.started" &&
        event.toolId === progress.toolId &&
        event.callId === progress.callId,
    );
    const finished = events.findIndex(
      (event, index) =>
        index > progressIndex &&
        event.type === "tool.finished" &&
        event.toolId === progress.toolId &&
        event.callId === progress.callId,
    );
    if (started >= 0 && finished > progressIndex) return true;
  }
  return false;
}

function eventIndexes(events: AgentEvent[], type: AgentEvent["type"]): number[] {
  return events.flatMap((event, index) => (event.type === type ? [index] : []));
}
