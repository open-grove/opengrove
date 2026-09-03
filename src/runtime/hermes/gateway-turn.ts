import type { AgentEvent, AgentTurnRequest, JsonValue, UsageStats } from "../../core.js";
import { AsyncEventQueue } from "../codex/async-event-queue.js";
import { StdioJsonRpcClient } from "../stdio-json-rpc-client.js";

export interface HermesGatewayTurnState {
  runId: string;
  request: AgentTurnRequest;
  queue: AsyncEventQueue<AgentEvent>;
  client: StdioJsonRpcClient;
  sessionId: string;
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
  resolve(): void;
  reject(error: Error): void;
}

export function createGatewayTurnState(input: {
  runId: string;
  request: AgentTurnRequest;
  queue: AsyncEventQueue<AgentEvent>;
  client: StdioJsonRpcClient;
  sessionId: string;
}): HermesGatewayTurnState {
  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // The gateway can die before runTurn reaches waitForGatewayTurn. Attach a
  // rejection observer immediately so Node does not promote that short window
  // to an unhandled rejection; callers still await the original promise.
  void completion.catch(() => undefined);
  const state = {
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
    toolCalls: new Map<string, { toolId: string; input: JsonValue }>(),
    resolve() {
      resolveCompletion?.();
    },
    reject(error: Error) {
      rejectCompletion?.(error);
    },
  } satisfies Omit<HermesGatewayTurnState, "usage"> & { completion?: Promise<void> };
  Object.defineProperty(state, "completion", { value: completion });
  return state as HermesGatewayTurnState & { completion: Promise<void> };
}

export async function waitForGatewayTurn(
  state: HermesGatewayTurnState,
  options: { timeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  const completion = (state as HermesGatewayTurnState & { completion: Promise<void> }).completion;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortTimeout: ReturnType<typeof setTimeout> | undefined;
  let cleanupAbort: (() => void) | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<void>((_, reject) => {
        if (options.timeoutMs !== undefined) {
          timeout = setTimeout(
            () => reject(new Error("hermes_gateway_turn_timed_out")),
            Math.max(100, options.timeoutMs),
          );
          timeout.unref?.();
        }
        if (options.signal) {
          const abortListener = () => {
            abortTimeout = setTimeout(() => reject(new Error("hermes_gateway_turn_aborted")), 15_000);
            abortTimeout.unref?.();
          };
          options.signal.addEventListener("abort", abortListener, { once: true });
          cleanupAbort = () => options.signal?.removeEventListener("abort", abortListener);
        }
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortTimeout) clearTimeout(abortTimeout);
    cleanupAbort?.();
  }
}
