import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { clientToolSchema, clientToolCallSchema } from "#protocol";
import type { JsonObject, ToolDefinition, ToolResult } from "../core.js";
import type { BridgeState } from "./bridge-types.js";

type ClientTool = z.output<typeof clientToolSchema>;
type ClientToolCall = z.output<typeof clientToolCallSchema>;
interface PendingCall {
  record: ClientToolCall;
  settle(result: ToolResult, status: ClientToolCall["status"]): void;
}

/** Each broker belongs to one run; it never publishes tools into the shared registry. */
export class ClientToolCalls {
  private readonly calls = new Map<string, PendingCall>();
  private closed = false;

  constructor(
    private readonly runId: string,
    private readonly signal: AbortSignal,
  ) {}

  definitions(specs: ClientTool[]): ToolDefinition[] {
    return specs.map((spec) => ({
      spec: {
        id: spec.id,
        title: spec.id,
        description: spec.description,
        activity: "api",
        risk: "write",
        input: { type: "json-schema", schema: spec.inputSchema },
        permission: {
          mode: "allow",
          reason:
            "The caller explicitly supplied this task-scoped product tool; the product owns business authorization.",
        },
        liveness: {
          cancellation: "run-signal",
          deadlineSource: "business-rule",
          abandonOutcome: "outcome-unknown",
          terminalConfirmation: "tool-result",
        },
      },
      execute: (input) => this.request(spec, input),
    }));
  }

  list(): ClientToolCall[] {
    return structuredClone([...this.calls.values()].map((call) => call.record));
  }

  resolve(callId: string, result: ToolResult): "accepted" | "missing" | "conflict" {
    const call = this.calls.get(callId);
    if (!call) return "missing";
    if (call.record.status === "completed")
      return isDeepStrictEqual(call.record.result, result) ? "accepted" : "conflict";
    if (call.record.status !== "pending") return "conflict";
    if (this.signal.aborted || this.closed || Date.now() >= Date.parse(call.record.deadlineAt)) {
      call.settle(
        { ok: false, error: "client_tool_outcome_unknown" },
        this.signal.aborted || this.closed ? "canceled" : "timed_out",
      );
      return "conflict";
    }
    call.settle(structuredClone(result), "completed");
    return "accepted";
  }

  close(): void {
    this.closed = true;
    for (const call of this.calls.values())
      if (call.record.status === "pending") {
        call.settle({ ok: false, error: "client_tool_outcome_unknown" }, "canceled");
      }
  }

  private request(spec: ClientTool, input: JsonObject): Promise<ToolResult> {
    if (this.closed || this.signal.aborted) return Promise.resolve({ ok: false, error: "client_tool_canceled" });
    if (this.calls.size >= 1_000) return Promise.resolve({ ok: false, error: "client_tool_call_limit" });
    return new Promise((resolve) => {
      const now = Date.now();
      const record: ClientToolCall = {
        id: randomUUID(),
        runId: this.runId,
        toolId: spec.id,
        input: structuredClone(input),
        status: "pending",
        createdAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + spec.timeoutMs).toISOString(),
      };
      const settle = (result: ToolResult, status: ClientToolCall["status"]) => {
        if (record.status !== "pending") return;
        clearTimeout(timer);
        this.signal.removeEventListener("abort", abort);
        record.status = status;
        record.result = result;
        resolve(result);
      };
      const abort = () => settle({ ok: false, error: "client_tool_outcome_unknown" }, "canceled");
      const timer = setTimeout(
        () => settle({ ok: false, error: "client_tool_outcome_unknown" }, "timed_out"),
        spec.timeoutMs,
      );
      timer.unref();
      this.calls.set(record.id, { record, settle });
      this.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

const brokers = new WeakMap<BridgeState, Map<string, ClientToolCalls>>();
export function registerClientToolCalls(state: BridgeState, runId: string, signal: AbortSignal): ClientToolCalls {
  const root = state.rootState ?? state;
  let runs = brokers.get(root);
  if (!runs) {
    runs = new Map();
    brokers.set(root, runs);
  }
  const broker = new ClientToolCalls(runId, signal);
  runs.set(runId, broker);
  return broker;
}
export function findClientToolCalls(state: BridgeState, runId: string): ClientToolCalls | undefined {
  return brokers.get(state.rootState ?? state)?.get(runId);
}
export function forgetClientToolCalls(state: BridgeState, runId: string): void {
  brokers.get(state.rootState ?? state)?.delete(runId);
}
