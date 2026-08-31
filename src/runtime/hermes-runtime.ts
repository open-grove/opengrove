import { resolve } from "node:path";
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
import { type HermesProviderRuntimeConfig } from "./hermes/config.js";
import { envFingerprint, mergeRuntimeEnv } from "./hermes/env.js";
import { readRememberedHermesGatewaySession, rememberHermesGatewaySession } from "./hermes/session-memory.js";
import {
  createHermesGatewayApproval,
  createHermesGatewayQuestion,
  extractQuestionAnswer,
  gatewayQuestionResponseKey,
  gatewayQuestionResponseMethod,
  hermesToolId,
  readHermesGatewayUsage,
  resolveHermesToolCallId,
  sleep,
} from "./hermes/gateway-events.js";
import { resolveHermesTuiGatewayLaunch } from "./hermes/gateway-launch.js";
import { readHermesFailureDiagnostic } from "./hermes/failure-diagnostic.js";
import { createGatewayTurnState, waitForGatewayTurn, type HermesGatewayTurnState } from "./hermes/gateway-turn.js";
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
  private isolatedHome?: string;
  private gatewayClient?: StdioJsonRpcClient;
  private gatewayClientEnvFingerprint = "";
  private readonly gatewaySessions = new Set<string>();
  private readonly gatewaySessionByThread = new Map<string, string>();
  private readonly activeGatewayTurns = new Map<string, { client: StdioJsonRpcClient; sessionId: string }>();

  constructor(private readonly options: HermesRuntimeOptions) {}

  close(): void {
    this.gatewayClient?.close();
    this.gatewayClient = undefined;
    this.gatewaySessions.clear();
    this.gatewaySessionByThread.clear();
    this.activeGatewayTurns.clear();
  }

  async steerTurn(request: AgentSteerRequest): Promise<AgentSteerResult> {
    const instruction = request.instruction.trim();
    if (!instruction) {
      return { ok: false, guided: false, error: "instruction_required" };
    }
    const active = this.activeGatewayTurns.get(request.runId) ?? this.activeGatewayTurns.get(request.threadId);
    if (!active || active.client.isClosed()) {
      return { ok: false, guided: false, error: "run_not_found" };
    }
    await active.client.request(
      "session.steer",
      { session_id: active.sessionId, text: instruction },
      { timeoutMs: 15_000 },
    );
    return { ok: true, guided: true };
  }

  async compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    const active = request.runId ? this.activeGatewayTurns.get(request.runId) : undefined;
    const client = active?.client ?? this.gatewayClient;
    const sessionId = active?.sessionId ?? this.gatewaySessionByThread.get(request.threadId);
    if (!client || client.isClosed()) {
      return { ok: false, compacted: false, error: "gateway_unavailable" };
    }
    if (!sessionId) {
      return { ok: false, compacted: false, error: "session_not_found" };
    }
    const params: JsonObject = {
      session_id: sessionId,
    };
    if (request.reason?.trim()) {
      params.reason = request.reason.trim();
    }
    if (typeof request.maxTokens === "number") {
      params.max_tokens = request.maxTokens;
    }
    await this.requestGatewayCompression(client, sessionId, params);
    return { ok: true, compacted: true };
  }

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();
    const runId = request.runId ?? `run_${Date.now()}`;
    const producer = this.produceGatewayTurn(request, queue, runId)
      .then(() => queue.close())
      .catch((error) => {
        queue.push({
          type: "error",
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
        queue.close();
      });
    try {
      for await (const event of queue) {
        yield event;
      }
      await producer;
    } finally {
      if (request.signal?.aborted && this.gatewayClient && !this.gatewayClient.isClosed()) {
        const nativeSessionId = readRememberedHermesGatewaySession(
          request,
          this.options.runtimeBindingFingerprint,
        )?.sessionId;
        if (nativeSessionId) {
          void this.gatewayClient
            .request("session.interrupt", { session_id: nativeSessionId }, { timeoutMs: 5_000 })
            .catch(() => {});
        }
      }
    }
  }

  private async produceGatewayTurn(
    request: AgentTurnRequest,
    queue: AsyncEventQueue<AgentEvent>,
    runId: string,
  ): Promise<void> {
    const requestedModel =
      normalizeOptionalString(request.requestedModelId) ?? normalizeOptionalString(this.options.configuredModel);
    const requestedProvider = normalizeOptionalString(this.options.configuredProvider);
    const runtimeEnv = mergeRuntimeEnv(this.options.env, request.runtimeEnv);
    const prompt = buildHermesPrompt(request);
    const client = await this.ensureGatewayClient(runtimeEnv);
    const nativeSession = await this.ensureGatewaySession(client, request);
    this.activeGatewayTurns.set(runId, { client, sessionId: nativeSession.sessionId });
    this.activeGatewayTurns.set(request.context.sessionId, { client, sessionId: nativeSession.sessionId });
    this.gatewaySessionByThread.set(request.context.sessionId, nativeSession.sessionId);
    const priorMessages = recentSessionMessages(request);
    const sessionTrace: AgentSessionTrace = {
      provider: "hermes",
      sessionId: nativeSession.sessionId,
      persistent: true,
      priorMessageCount: nativeSession.resuming ? priorMessages.length : 0,
      priorMessages: nativeSession.resuming ? priorMessages : [],
    };
    const turnState = createGatewayTurnState({
      runId,
      request,
      queue,
      client,
      sessionId: nativeSession.sessionId,
    });

    queue.push({ type: "turn.started", runId, at: new Date().toISOString() });
    if (request.assembledContext) {
      queue.push({ type: "context.assembled", runId, context: request.assembledContext });
    }
    await this.prepareContextBudget(
      client,
      nativeSession.sessionId,
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
        sessionId: nativeSession.sessionId,
        resuming: nativeSession.resuming,
        provider: requestedProvider ?? "",
      },
    });
    queue.push({
      type: "model.requested",
      runId,
      request: {
        systemPrompt: "Hermes TUI Gateway mode. OpenGrove host context is prepended to the user prompt when present.",
        userInput: request.input,
        modelId: requestedModel,
        session: sessionTrace,
        context: request.assembledContext,
        tools: request.tools.map((tool) => tool.spec),
        skills: request.skills ?? [],
        packs: request.packs ?? [],
        capabilities: request.capabilities ?? [],
      },
    });

    const cleanupNotifications = client.addNotificationHandler((notification) => {
      this.handleGatewayNotification(notification, turnState);
    });
    const abortPrompt = () => {
      void client
        .request("session.interrupt", { session_id: nativeSession.sessionId }, { timeoutMs: 5_000 })
        .catch(() => {});
    };
    if (request.signal?.aborted) abortPrompt();
    request.signal?.addEventListener("abort", abortPrompt, { once: true });

    try {
      await client.request(
        "prompt.submit",
        { session_id: nativeSession.sessionId, text: prompt },
        { timeoutMs: 30_000, signal: request.signal },
      );
      await waitForGatewayTurn(turnState, {
        timeoutMs: this.options.requestTimeoutMs ?? 900_000,
        signal: request.signal,
      });
      const finalText = cleanHermesAssistantText(turnState.finalText || turnState.assistantText);
      if (turnState.status === "error") {
        queue.push({
          type: "error",
          runId,
          message: finalText || turnState.errorMessage || "hermes_gateway_failed",
        });
      } else if (!finalText.trim()) {
        const diagnostic = readHermesFailureDiagnostic(this.isolatedHome) || client.stderr().trim();
        if (diagnostic) {
          queue.push({
            type: "runtime.diagnostic",
            runId,
            at: new Date().toISOString(),
            name: "hermes.gateway.empty_response_diagnostic",
            data: { diagnostic },
          });
        }
        queue.push({
          type: "error",
          runId,
          message: diagnostic || "hermes_empty_response",
        });
        queue.push({ type: "turn.finished", runId, at: new Date().toISOString() });
        return;
      } else {
        queue.push({
          type: "model.response",
          runId,
          response: { text: finalText, ...(turnState.usage ? { usage: turnState.usage } : {}) },
        });
      }
      queue.push({ type: "turn.finished", runId, at: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queue.push({
        type: "error",
        runId,
        message: client.stderr().trim() || message || "hermes_gateway_failed",
      });
    } finally {
      request.signal?.removeEventListener("abort", abortPrompt);
      cleanupNotifications();
      this.activeGatewayTurns.delete(runId);
      if (this.activeGatewayTurns.get(request.context.sessionId)?.sessionId === nativeSession.sessionId) {
        this.activeGatewayTurns.delete(request.context.sessionId);
      }
    }
  }

  private async ensureGatewayClient(runtimeEnv: NodeJS.ProcessEnv | undefined): Promise<StdioJsonRpcClient> {
    const envKey = envFingerprint(runtimeEnv);
    if (this.gatewayClient && !this.gatewayClient.isClosed() && this.gatewayClientEnvFingerprint === envKey) {
      return this.gatewayClient;
    }
    if (this.gatewayClient && !this.gatewayClient.isClosed()) {
      this.gatewayClient.close();
    }
    const launch = resolveHermesTuiGatewayLaunch(this.options);
    const cwd = resolve(this.options.cwd ?? process.cwd());
    const preparedEnv = prepareHermesRuntimeEnv({
      runtimeEnv,
      providerConfig: this.options.providerConfig,
      nativeSkillDir: this.options.nativeSkillDir,
      isolatedHome: this.isolatedHome,
    });
    this.isolatedHome = preparedEnv.isolatedHome;
    const env = preparedEnv.env;
    env.PWD = cwd;
    env.TERMINAL_CWD = cwd;
    if (launch.pythonSourceRoot && !env.HERMES_PYTHON_SRC_ROOT) {
      env.HERMES_PYTHON_SRC_ROOT = launch.pythonSourceRoot;
    }
    const client = StdioJsonRpcClient.start({
      command: launch.command,
      args: launch.args,
      cwd,
      env,
    });
    this.gatewayClient = client;
    this.gatewayClientEnvFingerprint = envKey;
    this.gatewaySessions.clear();
    return client;
  }

  private async ensureGatewaySession(
    client: StdioJsonRpcClient,
    request: AgentTurnRequest,
  ): Promise<{ sessionId: string; resuming: boolean }> {
    const remembered = readRememberedHermesGatewaySession(request, this.options.runtimeBindingFingerprint);
    if (remembered?.sessionId && this.gatewaySessions.has(remembered.sessionId)) {
      return { sessionId: remembered.sessionId, resuming: true };
    }

    const created = asObject(await client.request("session.create", { cols: 100 }, { timeoutMs: 30_000 }));
    const sessionId = readString(created, "session_id");
    if (!sessionId) {
      throw new Error("hermes_gateway_session_id_missing");
    }
    this.gatewaySessions.add(sessionId);
    rememberHermesGatewaySession(request, sessionId, this.options.runtimeBindingFingerprint);
    return { sessionId, resuming: false };
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
    const timeoutMs = this.options.requestTimeoutMs ?? 120_000;
    let lastBusyError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await client.request("session.compress", params, { timeoutMs });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/busy|interrupt/i.test(message)) {
          throw error;
        }
        lastBusyError = error;
      }
      if (attempt === 0) {
        await client.request("session.interrupt", { session_id: sessionId }, { timeoutMs: 15_000 }).catch(() => {});
      }
      await sleep(250);
    }
    if (lastBusyError instanceof Error) {
      throw lastBusyError;
    }
    if (lastBusyError) {
      throw new Error(String(lastBusyError));
    }
    try {
      await client.request("session.compress", params, { timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message);
    }
  }

  private handleGatewayNotification(
    notification: { method: string; params?: JsonValue },
    state: HermesGatewayTurnState,
  ): void {
    if (notification.method !== "event") return;
    const params = asObject(notification.params);
    const eventType = readString(params, "type");
    const sessionId = readString(params, "session_id");
    if (sessionId && sessionId !== state.sessionId) return;
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
      state.resolve();
      return;
    }

    if (eventType === "error") {
      this.flushGatewayReasoning(state);
      state.status = "error";
      state.errorMessage = readString(payload, "message") ?? "hermes_gateway_error";
      state.reject(new Error(state.errorMessage));
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

    if (eventType === "approval.request") {
      void this.handleGatewayApproval(state, payload);
      return;
    }

    if (eventType === "clarify.request" || eventType === "sudo.request" || eventType === "secret.request") {
      void this.handleGatewayQuestion(state, eventType, payload);
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

  private async handleGatewayApproval(state: HermesGatewayTurnState, payload: Record<string, unknown>): Promise<void> {
    const approval = createHermesGatewayApproval(payload, state.runId, state.request);
    state.queue.push({ type: "approval.requested", runId: state.runId, request: approval });

    let decided: ApprovalRequest;
    if (state.request.accessMode === "full-access") {
      decided = state.request.context.approvals.decide(approval.id, "approved", { autoApproved: true });
    } else {
      try {
        decided = await state.request.context.approvals.waitForDecision(approval.id, {
          timeoutMs: this.options.approvalTimeoutMs ?? 120_000,
          signal: state.request.signal,
        });
      } catch (error) {
        const current = state.request.context.approvals.get(approval.id);
        decided =
          current?.status === "pending"
            ? state.request.context.approvals.decide(approval.id, "rejected", {
                error: error instanceof Error ? error.message : String(error),
              })
            : (current ?? approval);
      }
    }
    state.queue.push({ type: "approval.resolved", runId: state.runId, request: decided });
    await state.client.request(
      "approval.respond",
      {
        session_id: state.sessionId,
        choice: decided.status === "approved" ? "allow" : "deny",
      },
      { timeoutMs: 15_000 },
    );
  }

  private async handleGatewayQuestion(
    state: HermesGatewayTurnState,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const requestId = readString(payload, "request_id");
    if (!requestId) return;
    const question = createHermesGatewayQuestion(payload, eventType, state.runId, state.request);
    state.queue.push({ type: "question.requested", runId: state.runId, question });
    let decided: QuestionRequest;
    try {
      decided = await state.request.context.questions.waitForDecision(question.id, {
        timeoutMs: 300_000,
        signal: state.request.signal,
      });
    } catch (error) {
      const current = state.request.context.questions.get(question.id);
      decided =
        current?.status === "pending"
          ? state.request.context.questions.decide(question.id, "declined", {
              error: error instanceof Error ? error.message : String(error),
            })
          : (current ?? question);
    }
    state.queue.push({ type: "question.answered", runId: state.runId, question: decided });
    await state.client.request(
      gatewayQuestionResponseMethod(eventType),
      {
        request_id: requestId,
        [gatewayQuestionResponseKey(eventType)]:
          decided.status === "answered" ? extractQuestionAnswer(decided.response) : "",
      },
      { timeoutMs: 15_000 },
    );
  }
}
