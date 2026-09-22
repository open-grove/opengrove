import { OpenGroveApi } from "./generated/sdk.gen.js";
import { createClient } from "./generated/client/index.js";
import type {
  Approval,
  Question,
  RunDirectStartData,
  RunDirectResultResponse,
  RunEventPage,
  RunToolListResponse,
  ToolResultInput,
} from "./generated/types.gen.js";

export type ProductToolCall = RunToolListResponse["calls"][number];
export type ProductTool = NonNullable<RunDirectStartData["body"]["tools"]>[number] & {
  execute(
    input: ProductToolCall["input"],
    context: { runId: string; callId: string; signal: AbortSignal; deadlineAt: string },
  ): Promise<ToolResultInput>;
};
export type AgentSessionOptions = Omit<RunDirectStartData["body"], "input" | "context" | "tools"> & {
  tools?: ProductTool[];
};
export interface TaskObserver {
  signal?: AbortSignal;
  pollMs?: number;
  /** Supplying this handler acknowledges incomplete replay; read result() for authoritative final output. */
  onHistoryGap?(gap: { historyTruncated: boolean; resetRequired: boolean }): void | Promise<void>;
  onEvent?(event: RunEventPage["events"][number]): void | Promise<void>;
  onApproval?(
    approval: Omit<Approval, "resume">,
  ): Promise<{ decision: "approve" | "reject" | "cancel"; response?: ToolResultInput["value"] }>;
  onQuestion?(question: Omit<Question, "resume">): Promise<ToolResultInput["value"]>;
}

function data<T>(response: { data?: T; error?: unknown }): T {
  if (response.data === undefined) throw response.error ?? new Error("opengrove_response_missing");
  return response.data;
}
const terminalStates = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

/** Connects only to the supplied Host. It does not start services or read local credentials. */
export async function connectOpenGrove(options: {
  baseUrl: string;
  token?: string;
  headers?: HeadersInit;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("x-opengrove-token", options.token);
  const api = new OpenGroveApi({
    client: createClient({ baseUrl: options.baseUrl, headers, fetch: options.fetch, throwOnError: true }),
  });
  const host = data(await api.host.host.bootstrap({ signal: options.signal }));
  return {
    api,
    host,
    session(config: AgentSessionOptions) {
      return {
        async run(input: string, context?: RunDirectStartData["body"]["context"]): Promise<AgentTask> {
          const { tools = [], ...runtime } = config;
          const started = data(
            await api.run.direct.start({
              body: {
                ...runtime,
                input,
                context,
                tools: tools.map(({ execute: _execute, ...definition }) => definition),
              },
            }),
          );
          return new AgentTask(api, started.runId, started.sessionId, tools);
        },
      };
    },
    task(runId: string, tools: ProductTool[] = []): AgentTask {
      return new AgentTask(api, runId, undefined, tools);
    },
  };
}

/** Observing a task is separate from canceling it. A failed task is returned with its actual lifecycle. */
export class AgentTask {
  private observing = false;
  private readonly executions = new Map<string, Promise<ToolResultInput>>();
  private readonly results = new Map<string, ToolResultInput>();
  private readonly handledInteractions = new Set<string>();
  private cursor: string | undefined;

  constructor(
    readonly api: OpenGroveApi,
    readonly runId: string,
    readonly sessionId: string | undefined,
    private readonly tools: ProductTool[] = [],
  ) {}

  async result(): Promise<RunDirectResultResponse> {
    return data(await this.api.run.direct.result({ path: { runId: this.runId } }));
  }
  async cancel() {
    return data(await this.api.run.direct.cancel({ body: { runId: this.runId } }));
  }
  async guide(instruction: string) {
    return data(await this.api.run.direct.guide({ body: { runId: this.runId, instruction } }));
  }

  async wait(observer: TaskObserver = {}): Promise<RunDirectResultResponse> {
    if (this.observing) throw new Error("task_already_observed");
    this.observing = true;
    const controller = new AbortController();
    const abort = () => controller.abort(observer.signal?.reason);
    observer.signal?.addEventListener("abort", abort, { once: true });
    if (observer.signal?.aborted) abort();
    const signal = controller.signal;
    const jobs = new Map<string, Promise<void>>();
    const callControllers = new Map<string, AbortController>();
    let failure: unknown;
    const launch = (id: string, action: () => Promise<void>) => {
      if (jobs.has(id)) return;
      const work = action()
        .catch((error: unknown) => {
          failure = error;
        })
        .finally(() => jobs.delete(id));
      jobs.set(id, work);
    };
    try {
      for (;;) {
        signal.throwIfAborted();
        if (failure) throw failure;
        const result = data(await this.api.run.direct.result({ path: { runId: this.runId }, signal }));
        const events = data(
          await this.api.run.event.list({ query: { runId: [this.runId], cursor: this.cursor, limit: 200 }, signal }),
        );
        if (events.resetRequired || (events.historyTruncated && !this.cursor)) {
          if (!observer.onHistoryGap) throw new Error("task_event_history_incomplete");
          await observer.onHistoryGap({
            historyTruncated: events.historyTruncated,
            resetRequired: events.resetRequired,
          });
        }
        for (const event of events.events) await observer.onEvent?.(event);
        this.cursor = events.cursor;
        if (result.finalized && terminalStates.has(result.run.lifecycle.taskState) && !events.hasMore) return result;

        const calls = data(await this.api.run.tool.list({ path: { runId: this.runId }, signal }));
        for (const call of calls.calls) {
          if (call.status !== "pending") {
            callControllers.get(call.id)?.abort(new Error(`product_tool_${call.status}`));
            continue;
          }
          launch(`tool:${call.id}`, async () => {
            let result = this.results.get(call.id);
            if (!result) {
              const tool = this.tools.find((candidate) => candidate.id === call.toolId);
              if (!tool) throw new Error(`product_tool_handler_missing:${call.toolId}`);
              let execution = this.executions.get(call.id);
              if (!execution) {
                const callController = new AbortController();
                callControllers.set(call.id, callController);
                const stop = () => callController.abort(signal.reason);
                signal.addEventListener("abort", stop, { once: true });
                if (signal.aborted) stop();
                const remaining = Date.parse(call.deadlineAt) - Date.now();
                const expire = () => callController.abort(new Error("product_tool_deadline_exceeded"));
                if (remaining <= 0) expire();
                const timer = Number.isFinite(remaining) ? setTimeout(expire, Math.max(0, remaining)) : undefined;
                execution = Promise.resolve()
                  .then(() => {
                    callController.signal.throwIfAborted();
                    return tool.execute(call.input, {
                      runId: this.runId,
                      callId: call.id,
                      signal: callController.signal,
                      deadlineAt: call.deadlineAt,
                    });
                  })
                  .catch((error: unknown) => ({
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                  }))
                  .finally(() => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", stop);
                    callControllers.delete(call.id);
                  });
                this.executions.set(call.id, execution);
              }
              result = await execution;
              this.results.set(call.id, result);
            }
            if (!signal.aborted) {
              const resolved = await this.api.run.tool.resolve({
                path: { runId: this.runId, callId: call.id },
                body: { result },
                signal,
                throwOnError: false,
              });
              // A task can be canceled or its call can expire while the product is working.
              if (resolved.response?.status !== 409) data(resolved);
            }
          });
        }
        if (observer.onApproval) {
          const approvals = data(
            await this.api.interaction.approval.list({ query: { runId: this.runId, status: "pending" }, signal }),
          );
          for (const approval of approvals.approvals) {
            const id = `approval:${approval.id}`;
            if (this.handledInteractions.has(id)) continue;
            launch(id, async () => {
              const decision = await observer.onApproval!(approval);
              signal.throwIfAborted();
              data(
                await this.api.interaction.approval[decision.decision]({
                  path: { approvalId: approval.id },
                  body: { response: decision.response },
                  signal,
                }),
              );
              this.handledInteractions.add(id);
            });
          }
        }
        if (observer.onQuestion) {
          const questions = data(
            await this.api.interaction.question.list({ query: { runId: this.runId, status: "pending" }, signal }),
          );
          for (const question of questions.questions) {
            const id = `question:${question.id}`;
            if (this.handledInteractions.has(id)) continue;
            launch(id, async () => {
              const response = await observer.onQuestion!(question);
              signal.throwIfAborted();
              data(
                await this.api.interaction.question.answer({
                  path: { questionId: question.id },
                  body: { response },
                  signal,
                }),
              );
              this.handledInteractions.add(id);
            });
          }
        }
        if (!events.hasMore) await delay(Math.max(50, observer.pollMs ?? 250), signal);
      }
    } finally {
      controller.abort();
      observer.signal?.removeEventListener("abort", abort);
      this.observing = false;
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
