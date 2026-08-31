import type { AskFinalPayload } from "../bridge";
import { attachAskStream, runAskStream } from "../bridge";
import { isAgentRuntimeEvent, normalizeBridgeStreamChunk, type UiRuntimeEvent } from "./agent-events";

export type ThreadTurnPayload = Parameters<typeof runAskStream>[0];

export interface ThreadRuntimeHandlers {
  onRuntimeEvent?(event: UiRuntimeEvent): void;
  onAgentEvent?(event: Extract<UiRuntimeEvent, { type: "agent.event" }>): void;
  signal?: AbortSignal;
}

export async function runThreadTurn(
  payload: ThreadTurnPayload,
  handlers: ThreadRuntimeHandlers = {},
): Promise<AskFinalPayload> {
  return runAskStream(
    payload,
    (chunk) => {
      const runtimeEvent = normalizeBridgeStreamChunk(chunk);
      if (!runtimeEvent) {
        return;
      }
      handlers.onRuntimeEvent?.(runtimeEvent);
      if (runtimeEvent.type === "run.error") {
        throw new Error(runtimeEvent.message || "stream_failed");
      }
      if (isAgentRuntimeEvent(runtimeEvent)) {
        handlers.onAgentEvent?.(runtimeEvent);
      }
    },
    { signal: handlers.signal },
  );
}

export async function attachThreadTurn(
  query: { runId?: string; threadId?: string },
  handlers: ThreadRuntimeHandlers = {},
): Promise<AskFinalPayload> {
  return attachAskStream(
    query,
    (chunk) => {
      const runtimeEvent = normalizeBridgeStreamChunk(chunk);
      if (!runtimeEvent) {
        return;
      }
      handlers.onRuntimeEvent?.(runtimeEvent);
      if (runtimeEvent.type === "run.error") {
        throw new Error(runtimeEvent.message || "stream_failed");
      }
      if (isAgentRuntimeEvent(runtimeEvent)) {
        handlers.onAgentEvent?.(runtimeEvent);
      }
    },
    { signal: handlers.signal },
  );
}
