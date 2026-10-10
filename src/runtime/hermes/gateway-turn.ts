import type { AgentEvent, AgentTurnRequest, JsonValue, UsageStats } from "../../core.js";
import { AsyncEventQueue } from "../codex/async-event-queue.js";
import { StdioJsonRpcClient } from "../stdio-json-rpc-client.js";

export interface HermesGatewayTurnState {
  runId: string;
  request: AgentTurnRequest;
  queue: AsyncEventQueue<AgentEvent>;
  client: StdioJsonRpcClient;
  sessionId: string;
  pendingRequestSignal: AbortSignal;
  assistantText: string;
  reasoningText: string;
  reasoningSequence: number;
  thinkingDeltaCount: number;
  thinkingTextLength: number;
  reasoningEventCount: number;
  reasoningTextLength: number;
  finalText: string;
  status: string;
  errorMessage?: string;
  usage?: UsageStats;
  toolCalls: Map<string, { toolId: string; input: JsonValue }>;
  hostToolName?(name: string): boolean;
}

export function createGatewayTurnState(
  input: Pick<
    HermesGatewayTurnState,
    "runId" | "request" | "queue" | "client" | "sessionId" | "pendingRequestSignal" | "hostToolName"
  >,
): HermesGatewayTurnState {
  return {
    ...input,
    assistantText: "",
    reasoningText: "",
    reasoningSequence: 0,
    thinkingDeltaCount: 0,
    thinkingTextLength: 0,
    reasoningEventCount: 0,
    reasoningTextLength: 0,
    finalText: "",
    status: "streaming",
    toolCalls: new Map(),
  };
}
