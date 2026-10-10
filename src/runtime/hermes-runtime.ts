import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { HermesAgent, compactHermes } from "@open-grove/agent-host/hermes";
import { APP_CONFIG_DIR } from "../identity.js";
import { createHostToolBridge } from "./host-tool-bridge.js";
import type {
  AgentCompactRequest,
  AgentCompactResult,
  AgentEvent,
  AgentRuntime,
  AgentSessionTrace,
  AgentSteerRequest,
  AgentSteerResult,
  AgentTurnRequest,
  ApprovalRequest,
  JsonObject,
  JsonValue,
  QuestionRequest,
  ToolResult,
} from "../core.js";
import { AsyncEventQueue } from "./codex/async-event-queue.js";
import { StdioJsonRpcClient } from "./stdio-json-rpc-client.js";
import { recentSessionMessages } from "./session-history.js";
import { resolveRuntimeRunId } from "./run-id.js";
import { hermesApprovalMode, type HermesProviderRuntimeConfig } from "./hermes/config.js";
import { envFingerprint, mergeRuntimeEnv } from "./hermes/env.js";
import { readRememberedHermesGatewaySession, rememberHermesGatewaySession } from "./hermes/session-memory.js";
import {
  createHermesGatewayApproval,
  createHermesGatewayQuestion,
  extractQuestionAnswer,
  hermesToolId,
  readHermesGatewayUsage,
  resolveHermesToolCallId,
} from "./hermes/gateway-events.js";
import { resolveHermesTuiGatewayLaunch } from "./hermes/gateway-launch.js";
import { createGatewayTurnState, type HermesGatewayTurnState } from "./hermes/gateway-turn.js";
import { asObject, readNumber, readString, readText, toJsonObject, toJsonValue } from "./hermes/json.js";
import {
  buildHermesPrompt,
  cleanHermesAssistantText,
  normalizeOptionalString,
  stripHermesTemplateTokens,
} from "./hermes/prompt.js";
import { prepareHermesRuntimeEnv } from "./hermes/home-env.js";
import {
  contextBudgetDiagnostic,
  contextBudgetExceeded,
  estimateTextTokens,
  hardContextWindowExceeded,
  resolveContextTokenBudget,
} from "./context-token-budget.js";

export type { HermesProviderApiMode, HermesProviderRuntimeConfig } from "./hermes/config.js";
export { hermesHealth, resolveHermesCommandPath, resolveInstalledHermesCommandPath } from "./hermes/command.js";

export interface HermesRuntimeOptions {
  command: string;
  commandArgs?: string[];
  acpArgs?: string[];
  gatewayCommand?: string;
  gatewayArgs?: string[];
  cwd?: string;
  configuredModel?: string;
  configuredProvider?: string;
  runtimeBindingFingerprint?: string;
  providerConfig?: HermesProviderRuntimeConfig;
  toolsets?: string[];
  nativeSkillDir?: string;
  requestTimeoutMs?: number;
  approvalTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class HermesRuntime implements AgentRuntime {
  private readonly agents = new Map<string, HermesAgent>();
  private readonly agentByThread = new Map<string, HermesAgent>();
  private readonly activeRuns = new Map<string, { agent: HermesAgent; threadId: string }>();

  constructor(private readonly options: HermesRuntimeOptions) {}
  close(): void {
    for (const agent of this.agents.values()) agent.close();
    this.agents.clear();
    this.agentByThread.clear();
    this.activeRuns.clear();
  }
  async steerTurn(request: AgentSteerRequest): Promise<AgentSteerResult> {
    if (!request.instruction.trim()) return { ok: false, guided: false, error: "instruction_required" };
    const active = this.activeRuns.get(request.runId);
    const agent = active?.agent ?? this.agentByThread.get(request.threadId);
    if (!agent) return { ok: false, guided: false, error: "run_not_found" };
    await agent.steer(active?.threadId ?? request.threadId, request.instruction.trim());
    return { ok: true, guided: true };
  }
  async compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    const agent = this.agentByThread.get(request.threadId);
    if (!agent) return { ok: false, compacted: false, error: "gateway_unavailable" };
    return agent.compact(request.threadId, request.reason);
  }

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const controller = new AbortController();
    request = {
      ...request,
      signal: request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal,
    };
    const queue = new AsyncEventQueue<AgentEvent>();
    const runId = resolveRuntimeRunId(request.runId);
    let turnStarted = false;
    let turnFinished = false;
    let producerFailure = "";
    const producer = this.produceGatewayTurn(request, queue, runId)
      .then(() => queue.close())
      .catch((error) => {
        producerFailure = error instanceof Error ? error.message : String(error);
        queue.push({
          type: "error",
          runId,
          message: producerFailure,
        });
        queue.close();
      });
    try {
      for await (const event of queue) {
        if (event.type === "error" && !turnStarted) {
          turnStarted = true;
          yield { type: "turn.started", runId, at: new Date().toISOString() };
        }
        if (event.type === "turn.started") turnStarted = true;
        if (event.type === "turn.finished") turnFinished = true;
        yield event;
      }
      await producer;
    } finally {
      controller.abort();
      await producer;
    }
    if (turnStarted && !turnFinished) {
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: {
          taskState: "TASK_STATE_FAILED",
          reasonCode: producerFailure ? "hermes_gateway_failed" : "hermes_native_terminal_missing",
          outcomeUnknown: true,
        },
      };
    }
  }

  private async produceGatewayTurn(
    request: AgentTurnRequest,
    queue: AsyncEventQueue<AgentEvent>,
    runId: string,
  ): Promise<void> {
    const cwd = resolve(this.options.cwd ?? process.cwd());
    const requestedModel =
      normalizeOptionalString(request.requestedModelId) ?? normalizeOptionalString(this.options.configuredModel);
    const runtimeEnv = mergeRuntimeEnv(this.options.env, request.runtimeEnv);
    const hostTools = request.tools.length ? createHostToolBridge(request, runId, queue, "hermes") : undefined;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          route: this.options.runtimeBindingFingerprint ?? "native",
          model: requestedModel,
          tools: hostTools?.fingerprint,
          access: request.accessMode,
          cwd,
        }),
      )
      .digest("hex");
    const homeKey = createHash("sha256")
      .update(JSON.stringify({ thread: request.context.sessionId, fingerprint }))
      .digest("hex");
    const key = `${homeKey}:${envFingerprint(runtimeEnv)}`;
    let agent = this.agents.get(key);
    if (!agent) {
      const launch = resolveHermesTuiGatewayLaunch(this.options);
      const prepared = prepareHermesRuntimeEnv({
        runtimeEnv,
        providerConfig: this.options.providerConfig,
        nativeSkillDir: this.options.nativeSkillDir,
        isolatedHome: undefined,
        persistentHome: join(cwd, APP_CONFIG_DIR, "native-state", "hermes", homeKey),
        accessMode: request.accessMode,
      });
      const env = {
        ...prepared.env,
        PWD: cwd,
        TERMINAL_CWD: cwd,
        ...(launch.pythonSourceRoot ? { HERMES_PYTHON_SRC_ROOT: launch.pythonSourceRoot } : {}),
      };
      agent = new HermesAgent({
        command: launch.command,
        args: launch.args,
        cwd,
        env,
        exclusiveProfile: !!prepared.isolatedHome,
        requestTimeoutMs: this.options.requestTimeoutMs,
      });
      this.agents.set(key, agent);
    }
    this.agentByThread.set(request.context.sessionId, agent);
    this.activeRuns.set(runId, { agent, threadId: request.context.sessionId });
    const prompt = buildHermesPrompt(request);
    const priorMessages = recentSessionMessages(request);
    let state: HermesGatewayTurnState | undefined;
    try {
      for await (const event of agent.run({
        sessionId: request.context.sessionId,
        runId,
        cwd,
        instructions: "",
        input: prompt,
        model: requestedModel,
        provider: normalizeOptionalString(this.options.configuredProvider)
          ? `custom:${this.options.configuredProvider?.replace(/^custom:/, "")}`
          : undefined,
        signal: request.signal,
        toolBridge: hostTools,
        bindingFingerprint: fingerprint,
        bindings: {
          get: async () => {
            const old = readRememberedHermesGatewaySession(request, fingerprint);
            return old ? { threadId: old.sessionId, fingerprint } : undefined;
          },
          set: async (_id, binding) => rememberHermesGatewaySession(request, binding.threadId, fingerprint),
        },
        beforeTurn: async (client, context) => {
          state = createGatewayTurnState({
            runId,
            request,
            queue,
            client,
            sessionId: context.liveSessionId,
            pendingRequestSignal: context.signal,
            hostToolName: hostTools?.isToolName,
          });
          if (request.accessMode !== undefined && request.accessMode !== "full-access") {
            const actual = asObject(
              await client.request(
                "config.get",
                { key: "approvals.mode" },
                { timeoutMs: 15_000, signal: context.signal },
              ),
            ).value;
            if (actual !== hermesApprovalMode(request.accessMode))
              throw new Error(`runtime_access_mode_unavailable: Hermes reports ${String(actual)}`);
          }
          if (request.assembledContext)
            queue.push({ type: "context.assembled", runId, context: request.assembledContext });
          await this.prepareContextBudget(
            client,
            context.liveSessionId,
            request,
            queue,
            runId,
            priorMessages,
            estimateTextTokens(prompt),
          );
          queue.push({
            type: "runtime.diagnostic",
            runId,
            at: new Date().toISOString(),
            name: "hermes.gateway.session",
            data: {
              sessionId: context.threadId,
              liveSessionId: context.liveSessionId,
              resuming: context.resumed,
              hostInstructionsChannel: "user-input",
              hostStateDelivery: "full-per-host-turn",
              hostCompactionRecovery: "next-host-turn",
              accessMode: request.accessMode ?? "default",
              approvalMode: hermesApprovalMode(request.accessMode),
            },
          });
          const sessionTrace: AgentSessionTrace = {
            provider: "hermes",
            sessionId: context.threadId,
            persistent: true,
            priorMessageCount: context.resumed ? priorMessages.length : 0,
            priorMessages: context.resumed ? priorMessages : [],
          };
          queue.push({
            type: "model.requested",
            runId,
            request: {
              systemPrompt: "Hermes native Gateway; current OpenGrove context is in this turn's prompt.",
              userInput: request.input,
              modelId: requestedModel,
              session: sessionTrace,
              context: request.assembledContext,
              tools: request.tools.map((t) => t.spec),
              skills: request.skills ?? [],
              packs: request.packs ?? [],
              capabilities: request.capabilities ?? [],
            },
          });
        },
        onRequest: async (rpc, context) => {
          if (!state) throw new Error("hermes_interaction_before_turn_setup");
          const current = { ...state, pendingRequestSignal: context.signal };
          const payload = asObject(rpc.params);
          if (rpc.method === "approval") return this.handleGatewayApproval(current, payload);
          if (rpc.method === "clarify") {
            const answers: JsonObject = {};
            for (const value of Array.isArray(payload.questions) ? payload.questions : []) {
              const question = asObject(value);
              const id = readString(question, "qid");
              if (!id) throw new Error("hermes_question_id_missing");
              answers[id] = await this.handleGatewayQuestion(current, "clarify.request", {
                ...question,
                request_id: String(rpc.id),
              });
            }
            return { answers };
          }
          if (rpc.method === "sudo" || rpc.method === "secret")
            return {
              value:
                (await this.handleGatewayQuestion(current, `${rpc.method}.request`, {
                  ...payload,
                  request_id: String(rpc.id),
                })) ?? "",
            };
          return undefined;
        },
      })) {
        if (event.type === "turn.started") queue.push({ type: "turn.started", runId, at: new Date().toISOString() });
        if (event.type === "native.notification" && state)
          this.handleGatewayNotification(
            {
              ...event.notification,
              params: event.notification.params === undefined ? undefined : toJsonValue(event.notification.params),
            },
            state,
          );
        if (event.type === "model.response") {
          const finalText = cleanHermesAssistantText(event.text);
          const streamed = cleanHermesAssistantText(state?.assistantText ?? "");
          queue.push({
            type: "model.response",
            runId,
            response: {
              text: streamed && streamed.trim() === finalText.trim() ? streamed : finalText,
              ...(state?.usage ? { usage: state.usage } : {}),
            },
          });
        }
        if (event.type === "turn.finished") {
          if (event.outcome.error) queue.push({ type: "error", runId, message: event.outcome.error });
          queue.push({
            type: "turn.finished",
            runId,
            at: new Date().toISOString(),
            outcome: {
              taskState:
                event.outcome.status === "completed"
                  ? "TASK_STATE_COMPLETED"
                  : event.outcome.status === "cancelled"
                    ? "TASK_STATE_CANCELED"
                    : "TASK_STATE_FAILED",
              ...(event.outcome.error ? { reasonCode: event.outcome.error } : {}),
              ...(event.outcome.outcomeUnknown ? { outcomeUnknown: true } : {}),
            },
          });
        }
      }
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private async prepareContextBudget(
    client: StdioJsonRpcClient,
    sessionId: string,
    request: AgentTurnRequest,
    queue: AsyncEventQueue<AgentEvent>,
    runId: string,
    priorMessages: ReturnType<typeof recentSessionMessages>,
    incomingTokens: number,
  ): Promise<void> {
    let nativeContextUsedTokens: number | undefined;
    let modelContextWindow: number | undefined;
    let usageReason = "session.usage";
    try {
      const usage = asObject(
        await client.request("session.usage", { session_id: sessionId }, { timeoutMs: 15_000, signal: request.signal }),
      );
      nativeContextUsedTokens = readNumber(usage, "context_used") ?? readNumber(usage, "total");
      modelContextWindow = readNumber(usage, "context_max");
      if (nativeContextUsedTokens === undefined) {
        usageReason = "OpenGrove session estimate; session.usage omitted context usage";
      }
    } catch (error) {
      usageReason = `OpenGrove session estimate; session.usage unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }

    const contextUsedTokens = nativeContextUsedTokens ?? estimateTextTokens(JSON.stringify(priorMessages));
    const usageSource = nativeContextUsedTokens !== undefined ? ("native" as const) : ("estimated" as const);
    const projectedContextTokens = contextUsedTokens + incomingTokens;
    const budget = resolveContextTokenBudget(request.contextTokenBudget, modelContextWindow);
    const effectiveBudget = budget.effectiveBudget;
    if (budget.budgetSource !== "configured" || effectiveBudget === undefined) {
      queue.push(
        contextBudgetDiagnostic({
          runId,
          kernel: "hermes",
          ...budget,
          usageSource,
          enforcementMode: "native-trigger",
          contextUsedTokens,
          reason: `${usageReason}; employee/App budget unconfigured, preserving Kernel default behavior`,
        }),
      );
      return;
    }
    if (!contextBudgetExceeded(projectedContextTokens, effectiveBudget)) {
      queue.push(
        contextBudgetDiagnostic({
          runId,
          kernel: "hermes",
          ...budget,
          usageSource,
          enforcementMode: "native-trigger",
          contextUsedTokens,
          reason: usageReason,
        }),
      );
      return;
    }

    queue.push({
      type: "compaction.started",
      runId,
      at: new Date().toISOString(),
      reason: `Hermes projected context reached ${projectedContextTokens}/${effectiveBudget} tokens`,
    });
    try {
      await this.requestGatewayCompression(client, sessionId, {
        session_id: sessionId,
        reason: "OpenGrove context token budget reached",
        max_tokens: effectiveBudget,
      });
      queue.push({
        type: "compaction.finished",
        runId,
        at: new Date().toISOString(),
        summary: "Hermes native session compression finished.",
      });
      queue.push(
        contextBudgetDiagnostic({
          runId,
          kernel: "hermes",
          ...budget,
          usageSource,
          enforcementMode: "native-trigger",
          contextUsedTokens,
          compactionTriggered: true,
          compactionSucceeded: true,
          reason: "session.compress",
        }),
      );
    } catch (error) {
      queue.push(
        contextBudgetDiagnostic({
          runId,
          kernel: "hermes",
          ...budget,
          usageSource,
          enforcementMode: "native-trigger",
          contextUsedTokens,
          compactionTriggered: true,
          compactionSucceeded: false,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      if (hardContextWindowExceeded(projectedContextTokens, budget)) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `context_hard_window_exceeded:${projectedContextTokens}/${budget.modelContextWindow}:${reason}`,
        );
      }
    }
  }

  private async requestGatewayCompression(
    client: StdioJsonRpcClient,
    sessionId: string,
    params: JsonObject,
  ): Promise<void> {
    const result = await compactHermes(
      client,
      sessionId,
      typeof params.reason === "string" ? params.reason : undefined,
      this.options.requestTimeoutMs,
    );
    if (!result.ok) throw new Error(result.error);
  }

  private handleGatewayNotification(
    notification: { method: string; params?: JsonValue },
    state: HermesGatewayTurnState,
  ): void {
    if (notification.method !== "event") return;
    const params = asObject(notification.params);
    const eventType = readString(params, "type");
    const sessionId = readString(params, "session_id");
    if (sessionId !== state.sessionId) return;
    if (!eventType || eventType === "gateway.ready") return;
    const payload = asObject(params.payload);

    if (eventType === "message.delta") {
      const text = stripHermesTemplateTokens(readText(payload, "text") ?? "");
      if (!text) return;
      state.assistantText += text;
      state.queue.push({ type: "assistant.delta", runId: state.runId, text });
      return;
    }

    if (eventType === "message.complete") {
      this.flushGatewayReasoning(state);
      state.finalText = stripHermesTemplateTokens(readText(payload, "text") ?? "");
      state.usage = readHermesGatewayUsage(asObject(payload.usage));
      state.status = readString(payload, "status") ?? "complete";
      state.errorMessage = readString(payload, "warning");
      return;
    }

    if (eventType === "error") {
      this.flushGatewayReasoning(state);
      state.status = "error";
      state.errorMessage = readString(payload, "message") ?? "hermes_gateway_error";
      return;
    }

    if (eventType === "tool.start") {
      this.handleGatewayToolStart(state, payload);
      return;
    }

    if (eventType === "tool.progress") {
      // Hermes 0.20 does not currently emit a generic correlated progress event.
      // Keep this transport mapping for forward compatibility without advertising it as a wired capability.
      this.handleGatewayToolProgress(state, payload);
      return;
    }

    if (eventType === "tool.complete") {
      this.handleGatewayToolComplete(state, payload);
      return;
    }

    if (eventType === "thinking.delta") {
      const text = readText(payload, "text") ?? readText(payload, "content") ?? "";
      state.thinkingDeltaCount += 1;
      state.thinkingTextLength += text.length;
      return;
    }

    if (eventType === "reasoning.available" || eventType === "reasoning.delta") {
      const text = readText(payload, "text") ?? readText(payload, "content") ?? "";
      if (text) {
        if (eventType === "reasoning.available" && !state.reasoningText) {
          state.reasoningText = text;
        } else if (eventType !== "reasoning.available") {
          state.reasoningText += text;
        }
      }
      state.reasoningEventCount += 1;
      state.reasoningTextLength += text.length;
      return;
    }

    if (eventType === "session.info" || eventType === "status.update" || eventType.startsWith("subagent.")) {
      state.queue.push({
        type: "runtime.diagnostic",
        runId: state.runId,
        at: new Date().toISOString(),
        name: `hermes.gateway.${eventType}`,
        data: toJsonObject(payload),
      });
    }
  }

  private flushGatewayReasoning(state: HermesGatewayTurnState): void {
    if (state.thinkingDeltaCount || state.reasoningEventCount) {
      state.queue.push({
        type: "runtime.diagnostic",
        runId: state.runId,
        at: new Date().toISOString(),
        name: "hermes.gateway.reasoning.stream",
        data: {
          thinkingDeltaCount: state.thinkingDeltaCount,
          thinkingTextLength: state.thinkingTextLength,
          reasoningEventCount: state.reasoningEventCount,
          reasoningTextLength: state.reasoningTextLength,
        },
      });
      state.thinkingDeltaCount = 0;
      state.thinkingTextLength = 0;
      state.reasoningEventCount = 0;
      state.reasoningTextLength = 0;
    }
    const thinkingText = state.reasoningText.trim();
    if (!thinkingText) return;
    state.reasoningText = "";
    const id = `${state.runId}:reasoning:${++state.reasoningSequence}`;
    state.queue.push({
      type: "reasoning.started",
      runId: state.runId,
      reasoning: { id, kind: "native", kernelId: "hermes" },
    });
    state.queue.push({
      type: "reasoning.completed",
      runId: state.runId,
      reasoning: { id, kind: "native", kernelId: "hermes", text: thinkingText },
    });
  }

  private handleGatewayToolStart(state: HermesGatewayTurnState, payload: Record<string, unknown>): void {
    const name = readString(payload, "name") ?? "tool";
    if (state.hostToolName?.(name.replace(/^mcp_agent_host_/, ""))) return;
    const callId = readString(payload, "tool_id") ?? name;
    if (state.toolCalls.has(callId)) return;
    const toolId = hermesToolId(name);
    const input = toJsonValue({
      name,
      preview: readString(payload, "preview"),
      context: payload.context,
    });
    state.toolCalls.set(callId, { toolId, input });
    state.queue.push({ type: "tool.started", runId: state.runId, toolId, callId, input });
  }

  private handleGatewayToolProgress(state: HermesGatewayTurnState, payload: Record<string, unknown>): void {
    const name = readString(payload, "name") ?? "tool";
    const toolId = hermesToolId(name);
    const resolved = resolveHermesToolCallId(state.toolCalls, toolId, readString(payload, "tool_id"));
    if (resolved.ambiguous) {
      this.reportAmbiguousGatewayToolEvent(state, "tool.progress", toolId);
      return;
    }
    const callId = resolved.callId ?? name;
    if (!state.toolCalls.has(callId)) {
      this.handleGatewayToolStart(state, { ...payload, tool_id: callId });
    }
    state.queue.push({
      type: "tool.progress",
      runId: state.runId,
      toolId,
      callId,
      update: toJsonValue(payload),
    });
  }

  private handleGatewayToolComplete(state: HermesGatewayTurnState, payload: Record<string, unknown>): void {
    const name = readString(payload, "name") ?? "tool";
    if (state.hostToolName?.(name.replace(/^mcp_agent_host_/, ""))) return;
    const nativeToolId = hermesToolId(name);
    const resolved = resolveHermesToolCallId(state.toolCalls, nativeToolId, readString(payload, "tool_id"));
    if (resolved.ambiguous) {
      this.reportAmbiguousGatewayToolEvent(state, "tool.complete", nativeToolId);
    }
    const callId = resolved.callId ?? name;
    const current = state.toolCalls.get(callId);
    const toolId = current?.toolId ?? nativeToolId;
    const value = toJsonValue(payload);
    const result: ToolResult = { ok: true, value };
    if (callId) {
      state.toolCalls.delete(callId);
    }
    state.queue.push({ type: "tool.finished", runId: state.runId, toolId, callId, result });
  }

  private reportAmbiguousGatewayToolEvent(
    state: HermesGatewayTurnState,
    eventType: "tool.progress" | "tool.complete",
    toolId: string,
  ): void {
    state.queue.push({
      type: "runtime.diagnostic",
      runId: state.runId,
      at: new Date().toISOString(),
      name: "hermes.gateway.tool.correlation_ambiguous",
      data: {
        eventType,
        toolId,
        activeCallIds: Array.from(state.toolCalls.entries())
          .filter(([, current]) => current.toolId === toolId)
          .map(([callId]) => callId),
      },
    });
  }

  private async handleGatewayApproval(
    state: HermesGatewayTurnState,
    payload: Record<string, unknown>,
  ): Promise<JsonObject> {
    const approval = createHermesGatewayApproval(payload, state.runId, state.request);
    state.queue.push({ type: "approval.requested", runId: state.runId, request: approval });

    let decided: ApprovalRequest;
    try {
      decided = await state.request.context.approvals.waitForDecision(approval.id, {
        timeoutMs: this.options.approvalTimeoutMs ?? 300_000,
        signal: state.pendingRequestSignal,
      });
    } catch (error) {
      const current = state.request.context.approvals.get(approval.id);
      const timedOut = error instanceof Error && error.message.startsWith("Approval request timed out:");
      decided =
        current?.status === "pending"
          ? state.request.context.approvals.decide(approval.id, timedOut ? "rejected" : "canceled", {
              system: true,
              reasonCode: state.request.signal?.aborted
                ? "run_canceled"
                : timedOut
                  ? "approval_timeout"
                  : "native_request_failed",
              error: error instanceof Error ? error.message : String(error),
            })
          : (current ?? approval);
    }
    state.queue.push({ type: "approval.resolved", runId: state.runId, request: decided });
    return { choice: decided.status === "approved" ? "once" : "deny" };
  }

  private async handleGatewayQuestion(
    state: HermesGatewayTurnState,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<string | null> {
    const requestId = readString(payload, "request_id");
    if (!requestId) return null;
    const question = createHermesGatewayQuestion(payload, eventType, state.runId, state.request);
    state.queue.push({ type: "question.requested", runId: state.runId, question });
    let decided: QuestionRequest;
    try {
      decided = await state.request.context.questions.waitForDecision(question.id, {
        signal: state.pendingRequestSignal,
      });
    } catch (error) {
      const current = state.request.context.questions.get(question.id);
      decided =
        current?.status === "pending"
          ? state.request.context.questions.decide(question.id, "canceled", {
              system: true,
              reasonCode: state.request.signal?.aborted ? "run_canceled" : "native_request_failed",
              error: error instanceof Error ? error.message : String(error),
            })
          : (current ?? question);
    }
    state.queue.push({ type: "question.answered", runId: state.runId, question: decided });
    return decided.status === "answered" ? extractQuestionAnswer(decided.response) : null;
  }
}
