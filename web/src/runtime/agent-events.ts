export type BridgeStreamChunk = Record<string, unknown>;

export type AgentEventChannel =
  | "assistant.streaming"
  | "assistant.final"
  | "assistant.status"
  | "reasoning.streaming"
  | "skill.lifecycle"
  | "tool.request"
  | "tool.progress"
  | "tool.result"
  | "approval.pending"
  | "approval.resolved"
  | "question.pending"
  | "question.resolved"
  | "planning.updated"
  | "run.lifecycle"
  | "model.response"
  | "agent.error"
  | "raw.agent-event";

export type UiRuntimeEvent =
  | {
      type: "run.start";
      raw: BridgeStreamChunk;
      threadId?: string;
      runId?: string;
    }
  | {
      type: "run.finish";
      raw: BridgeStreamChunk;
      data: Record<string, unknown>;
    }
  | {
      type: "run.error";
      raw: BridgeStreamChunk;
      message: string;
    }
  | {
      type: "agent.event";
      raw: BridgeStreamChunk;
      agentType: string;
      channel: AgentEventChannel;
      event: Record<string, unknown>;
    };

export function normalizeBridgeStreamChunk(chunk: BridgeStreamChunk): UiRuntimeEvent | undefined {
  const type = typeof chunk.type === "string" ? chunk.type : "";
  if (type === "start") {
    return {
      type: "run.start",
      raw: chunk,
      threadId: typeof chunk.threadId === "string" ? chunk.threadId : undefined,
      runId: typeof chunk.runId === "string" ? chunk.runId : undefined,
    };
  }
  if (type === "final") {
    return {
      type: "run.finish",
      raw: chunk,
      data: asRecord(chunk.data),
    };
  }
  if (type === "fatal") {
    return {
      type: "run.error",
      raw: chunk,
      message: typeof chunk.error === "string" && chunk.error ? chunk.error : "stream_failed",
    };
  }
  if (type !== "event") {
    return undefined;
  }

  const event = asRecord(chunk.event);
  const agentType = typeof event.type === "string" ? event.type : "unknown";
  return {
    type: "agent.event",
    raw: chunk,
    agentType,
    channel: agentEventChannel(agentType),
    event,
  };
}

export function isAgentRuntimeEvent(
  event: UiRuntimeEvent | undefined,
): event is Extract<UiRuntimeEvent, { type: "agent.event" }> {
  return event?.type === "agent.event";
}

function agentEventChannel(type: string): AgentEventChannel {
  switch (type) {
    case "assistant.delta":
      return "assistant.streaming";
    case "assistant.final":
      return "assistant.final";
    case "assistant.status":
      return "assistant.status";
    case "reasoning.started":
    case "reasoning.completed":
      return "reasoning.streaming";
    case "skill.invoked":
    case "skill.loaded":
    case "skill.forked":
    case "skill.cleared":
      return "skill.lifecycle";
    case "tool.started":
      return "tool.request";
    case "tool.progress":
      return "tool.progress";
    case "tool.finished":
      return "tool.result";
    case "approval.requested":
      return "approval.pending";
    case "approval.resolved":
      return "approval.resolved";
    case "question.requested":
      return "question.pending";
    case "question.answered":
      return "question.resolved";
    case "planning.updated":
      return "planning.updated";
    case "turn.started":
    case "turn.finished":
    case "compaction.started":
    case "compaction.finished":
      return "run.lifecycle";
    case "model.response":
      return "model.response";
    case "error":
      return "agent.error";
    default:
      return "raw.agent-event";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
