import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
} from "../core.js";
import { createCodexRpcCaptureRecorder } from "./codex-rpc-capture.js";
import { CodexAppServerClient, CodexRequestFailure } from "./codex/app-server-client.js";
import { AsyncEventQueue } from "./codex/async-event-queue.js";
import {
  handleCodexApprovalRequest,
  handleCodexElicitationRequest,
  handleCodexUserInputRequest,
  isCodexApprovalRequest,
} from "./codex/approval-bridge.js";
import { readCodexAuthRefreshResponse } from "./codex/auth.js";
import { createCodexDynamicToolBridge, readDynamicToolCallParams } from "./codex/dynamic-tool-bridge.js";
import { CodexEventProjector } from "./codex/event-projector.js";
import { isJsonObject, readString } from "./codex/json.js";
import {
  buildCodexDeveloperInstructions,
  buildCodexTurnInput,
  buildCodexTurnInputItems,
  imageGenerationTruthCorrection,
  refreshCodexNativeSkillList,
} from "./codex/input.js";
import {
  normalizeCodexModelId,
  resolveCodexApprovalPolicy,
  resolveCodexApprovalsReviewer,
  resolveReasoningEffort,
  resolveCodexSandboxMode,
  resolveCodexServiceTier,
} from "./codex/policy.js";
import { contextBudgetDiagnostic, resolveContextTokenBudget } from "./context-token-budget.js";
import {
  CODEX_THREAD_CONFIG_OVERRIDES,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  stripDisableFeatureFlags,
  unknownCodexFeatureFlagsFromStderr,
  type CodexApprovalPolicy,
  type CodexApprovalsReviewer,
  type CodexDynamicToolSpec,
  type CodexModelProviderRuntimeConfig,
  type CodexRuntimeOptions,
  type CodexSandboxMode,
  type CodexThreadSource,
  type CodexThreadBinding,
  type CodexThreadStartResponse,
  type CodexTurnInputItem,
  type CodexTurnStartResponse,
} from "./codex/types.js";

export { resolveCodexCommandPath } from "./codex/command-path.js";
export type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexRuntimeOptions,
  CodexSandboxMode,
} from "./codex/types.js";

type ActiveCodexTurn = {
  client: CodexAppServerClient;
  nativeThreadId: string;
  nativeTurnId: string;
};

export class CodexRuntime implements AgentRuntime {
  private readonly clients = new Map<string, CodexAppServerClient>();
  private readonly clientReady = new Map<string, Promise<CodexAppServerClient>>();
  private readonly clientLeases = new Map<CodexAppServerClient, number>();
  private readonly retiredClients = new Set<CodexAppServerClient>();
  private readonly bindings = new Map<string, CodexThreadBinding>();
  private readonly activeTurns = new Map<string, ActiveCodexTurn>();
  private bindingsLoaded = false;

  constructor(private readonly options: CodexRuntimeOptions = {}) {}

  async compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    this.loadBindings();
    const prefix = `${request.threadId}:`;
    const binding = Array.from(this.bindings.entries())
      .filter(([key, candidate]) => key.startsWith(prefix) && Boolean(candidate.threadId))
      .map(([, candidate]) => candidate)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!binding?.threadId) {
      return { ok: false, compacted: false, error: "session_not_found" };
    }

    const runtimeEnv = this.options.env;
    let client: CodexAppServerClient | undefined;
    const clientKey = envFingerprint(runtimeEnv);
    try {
      client = await this.ensureClient(runtimeEnv);
      this.leaseClient(client);
      await client.request<CodexThreadStartResponse>(
        "thread/resume",
        { threadId: binding.threadId },
        { timeoutMs: this.options.requestTimeoutMs ?? 60_000, signal: request.signal },
      );
    } catch (error) {
      if (client) {
        if (isAbandonedMutatingRequest(error, request.signal)) this.poisonClient(clientKey, client);
        this.releaseClient(client);
      }
      return {
        ok: false,
        compacted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const runId = request.runId ?? `compact_${Date.now()}`;
    const queue = new AsyncEventQueue<AgentEvent>();
    const projector = new CodexEventProjector(runId, binding.threadId, queue);
    let compacted = false;
    let compactError = "";
    let compactTurnId = "";
    let cancelRequested = request.signal?.aborted === true;
    let livenessTimer: ReturnType<typeof setTimeout> | undefined;
    const armLivenessBoundary = () => {
      if (livenessTimer) clearTimeout(livenessTimer);
      livenessTimer = setTimeout(() => {
        compactError = "codex_compact_liveness_timeout";
        queue.close();
      }, this.options.requestTimeoutMs ?? 60_000);
      livenessTimer.unref?.();
    };
    const notificationCleanup = client.addNotificationHandler((notification) => {
      if (codexNotificationMatches(notification, binding.threadId, compactTurnId || undefined)) {
        armLivenessBoundary();
      }
      const completed = projector.handleNotification(notification, compactTurnId || "*");
      const params = isJsonObject(notification.params) ? notification.params : undefined;
      if (notification.method === "thread/compacted" && readString(params ?? {}, "threadId") === binding.threadId) {
        compacted = true;
        queue.close();
        return;
      }
      if (completed) queue.close();
    });
    const closeCleanup = client.addCloseHandler((error) => {
      compactError = `codex_compact_producer_lost:${error.message}`;
      queue.close();
    });
    const abortCompact = () => {
      cancelRequested = true;
      if (compactTurnId) {
        void client
          .request("turn/interrupt", { threadId: binding.threadId, turnId: compactTurnId }, { timeoutMs: 15_000 })
          .catch(() => undefined);
      }
    };
    request.signal?.addEventListener("abort", abortCompact, { once: true });

    try {
      const started = await client.request<CodexTurnStartResponse>(
        "thread/compact/start",
        { threadId: binding.threadId },
        { timeoutMs: this.options.requestTimeoutMs ?? 60_000, signal: request.signal },
      );
      compactTurnId = started.turn?.id ?? "";
      armLivenessBoundary();
      if (cancelRequested && compactTurnId) abortCompact();
      for await (const event of queue) {
        if (event.type === "compaction.finished") compacted = true;
        if (event.type === "error") compactError = event.message;
      }
    } catch (error) {
      compactError = error instanceof Error ? error.message : String(error);
      if (!compactTurnId && isAbandonedMutatingRequest(error, request.signal)) this.poisonClient(clientKey, client);
    } finally {
      if (livenessTimer) clearTimeout(livenessTimer);
      request.signal?.removeEventListener("abort", abortCompact);
      closeCleanup();
      notificationCleanup();
      this.releaseClient(client);
    }

    if (compacted) {
      binding.updatedAt = new Date().toISOString();
      this.saveBindings();
      return { ok: true, compacted: true };
    }
    return {
      ok: false,
      compacted: false,
      ...(cancelRequested || compactError.startsWith("codex_compact_producer_lost:") ? { outcomeUnknown: true } : {}),
      error:
        compactError ||
        (cancelRequested ? "codex_compact_canceled_outcome_unknown" : "") ||
        projector.errorMessage() ||
        "compact_boundary_not_observed",
    };
  }

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const runId = request.runId ?? `run_${Date.now()}`;
    const cwd = this.options.cwd ?? process.cwd();
    const model = normalizeCodexModelId(request.requestedModelId, this.options.configuredModel);
    const modelProvider = this.options.configuredModelProvider?.trim() || undefined;
    const sandbox = resolveCodexSandboxMode(request, this.options.sandbox);
    const approvalPolicy = resolveCodexApprovalPolicy(request.accessMode, this.options.approvalPolicy);
    const approvalsReviewer = resolveCodexApprovalsReviewer(this.options.approvalsReviewer);
    const reasoningEffort = resolveReasoningEffort(request.requestedEffort);
    const serviceTier =
      this.options.allowServiceTier === false
        ? undefined
        : resolveCodexServiceTier(request.responseSpeed, this.options.serviceTier);
    const runtimeEnv = mergeRuntimeEnv(this.options.env, request.runtimeEnv);
    const runtimeEnvFingerprint = envFingerprint(runtimeEnv);
    const contextBudget = resolveContextTokenBudget(
      request.contextTokenBudget,
      readCodexModelContextWindow(model, runtimeEnv),
    );
    const threadConfig = codexThreadConfig(this.options.providerConfig, {
      reasoningEffort,
      reasoningSummary: reasoningEffort ? "detailed" : undefined,
      serviceTier,
      contextTokenBudget: contextBudget.budgetSource === "configured" ? contextBudget.effectiveBudget : undefined,
    });
    const staticDeveloperInstructions = buildCodexDeveloperInstructions();
    const developerInstructions = buildCodexDeveloperInstructions(request);
    const turnInput = buildCodexTurnInput(request);
    const turnInputItems = buildCodexTurnInputItems(request, turnInput);
    const exposeDynamicTools = shouldExposeCodexDynamicTools(request);
    const toolBridge = createCodexDynamicToolBridge(
      exposeDynamicTools ? request : { ...request, tools: [], capabilities: [] },
      runId,
    );
    const compactTurn = isCodexCompactCommand(request.input);

    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (request.assembledContext) {
      yield { type: "context.assembled", runId, context: request.assembledContext };
    }
    yield contextBudgetDiagnostic({
      runId,
      kernel: "codex",
      ...contextBudget,
      usageSource: "native",
      enforcementMode: "native-auto",
      reason:
        contextBudget.budgetSource === "configured"
          ? "model_auto_compact_token_limit"
          : "employee/App budget unconfigured; preserving Codex native default",
    });
    const mediaDiagnostic = codexMediaInputDiagnostic(turnInputItems);
    if (mediaDiagnostic) {
      yield {
        type: "runtime.diagnostic",
        runId,
        at: new Date().toISOString(),
        name: "codex.media_input.configured",
        data: mediaDiagnostic,
      };
    }
    if (request.structuredOutputSchema) {
      yield {
        type: "runtime.diagnostic",
        runId,
        at: new Date().toISOString(),
        name: "codex.output_schema.configured",
        data: codexOutputSchemaDiagnostic(request.structuredOutputSchema),
      };
    }

    let client: CodexAppServerClient;
    try {
      client = await this.ensureClient(runtimeEnv);
      await refreshCodexNativeSkillList(client, cwd, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", runId, message };
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: {
          taskState: "TASK_STATE_FAILED",
          reasonCode: "codex_app_server_unavailable",
          outcomeUnknown: true,
        },
      };
      return;
    }
    const clientKey = envFingerprint(runtimeEnv);
    this.leaseClient(client);

    const queue = new AsyncEventQueue<AgentEvent>();
    let activeThreadId = "";
    let activeTurnId = "";
    let activeTurn: ActiveCodexTurn | undefined;
    let pauseRequest: ApprovalRequest | undefined;
    let turnCompleted = false;
    let compactionTriggered = false;
    let compactionSucceeded = false;
    const pendingNotifications: Array<{ method: string; params?: JsonValue }> = [];
    const requestCleanup = client.addRequestHandler(async (serverRequest) => {
      queue.push({
        type: "runtime.diagnostic",
        runId,
        at: new Date().toISOString(),
        name: "codex.app_server.request",
        data: {
          method: serverRequest.method,
          hasParams: serverRequest.params !== undefined,
        },
      });
      if (serverRequest.method === "account/chatgptAuthTokens/refresh") {
        const response = readCodexAuthRefreshResponse(runtimeEnv);
        queue.push({
          type: "runtime.diagnostic",
          runId,
          at: new Date().toISOString(),
          name: "codex.auth.refresh",
          data: codexAuthRefreshDiagnostic(response),
        });
        return response;
      }
      if (isCodexApprovalRequest(serverRequest.method)) {
        if (!activeThreadId) return undefined;
        return await handleCodexApprovalRequest(serverRequest, {
          threadId: activeThreadId,
          turnId: activeTurnId,
          runId,
          request,
          queue,
        });
      }
      if (serverRequest.method === "item/tool/requestUserInput") {
        return await handleCodexUserInputRequest(serverRequest, {
          runId,
          request,
          queue,
        });
      }
      if (serverRequest.method === "mcpServer/elicitation/request") {
        return await handleCodexElicitationRequest(serverRequest, {
          runId,
          request,
          queue,
        });
      }
      if (serverRequest.method === "item/tool/call") {
        const call = readDynamicToolCallParams(serverRequest.params);
        if (!call || call.threadId !== activeThreadId) {
          return undefined;
        }
        const result = await toolBridge.handleToolCall(call, {
          queue,
          onPause(requestedApproval) {
            pauseRequest = requestedApproval;
          },
        });
        return result as unknown as JsonValue;
      }
      return undefined;
    });

    let thread: CodexThreadBinding;
    try {
      const runtimeBindingInput = {
        base: this.options.runtimeBindingFingerprint,
        model,
        modelProvider,
        dynamicToolsFingerprint: toolBridge.fingerprint,
        developerInstructionsFingerprint: textFingerprint(staticDeveloperInstructions),
        cwd,
        runtimeEnvFingerprint,
      };
      thread = await this.startOrResumeThread(client, request, {
        cwd,
        model,
        modelProvider,
        runtimeBindingFingerprint: codexRuntimeBindingFingerprint(runtimeBindingInput),
        sandbox,
        developerInstructions,
        dynamicTools: toolBridge.specs,
        dynamicToolsFingerprint: toolBridge.fingerprint,
        approvalPolicy,
        approvalsReviewer,
        reasoningEffort,
        serviceTier,
        config: threadConfig,
        // OpenGrove room chats are first-class in OpenGrove, but they are
        // host-owned agent runs from Codex Desktop's thread-list perspective.
        threadSource: this.options.threadSource ?? "subagent",
      });
    } catch (error) {
      requestCleanup();
      const abandoned = isAbandonedMutatingRequest(error, request.signal);
      if (abandoned) this.poisonClient(clientKey, client);
      this.releaseClient(client);
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", runId, message };
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: {
          taskState: "TASK_STATE_FAILED",
          reasonCode: abandoned ? "codex_control_outcome_unknown" : "codex_thread_start_failed",
          ...(abandoned ? { outcomeUnknown: true } : {}),
        },
      };
      return;
    }
    activeThreadId = thread.threadId;
    activeTurn = {
      client,
      nativeThreadId: thread.threadId,
      nativeTurnId: "",
    };
    const activeTurnKeys = this.activeTurnKeys(request, runId);
    for (const key of activeTurnKeys) {
      this.activeTurns.set(key, activeTurn);
    }
    const sessionTrace: AgentSessionTrace = {
      provider: "codex",
      sessionId: thread.threadId,
      persistent: true,
      priorMessageCount: 0,
      priorMessages: [],
    };

    yield {
      type: "model.requested",
      runId,
      request: {
        systemPrompt: developerInstructions,
        userInput: request.input,
        modelId: model,
        session: sessionTrace,
        context: request.assembledContext,
        tools: request.tools.map((tool) => tool.spec),
        skills: request.skills ?? [],
        packs: request.packs ?? [],
        capabilities: request.capabilities ?? [],
      },
    };
    yield {
      type: "runtime.diagnostic",
      runId,
      at: new Date().toISOString(),
      name: "codex.policy.configured",
      data: {
        accessMode: request.accessMode ?? "default",
        sandbox,
        approvalPolicy,
        approvalsReviewer,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        responseSpeed: request.responseSpeed ?? "standard",
        ...(serviceTier ? { serviceTier } : {}),
        threadId: thread.threadId,
        appliedTo: "thread",
      },
    };
    const threadGoalDiagnostic = await this.applyThreadGoal(client, thread.threadId, request);
    if (threadGoalDiagnostic) {
      yield threadGoalDiagnostic;
    }

    const projector = new CodexEventProjector(runId, thread.threadId, queue);
    let cancelRequested = false;
    let runtimeFailure = "";
    let compactLivenessTimer: ReturnType<typeof setTimeout> | undefined;
    const armCompactLivenessBoundary = () => {
      if (!compactTurn) return;
      if (compactLivenessTimer) clearTimeout(compactLivenessTimer);
      compactLivenessTimer = setTimeout(() => {
        runtimeFailure = "codex_compact_liveness_timeout";
        queue.close();
      }, this.options.requestTimeoutMs ?? 60_000);
      compactLivenessTimer.unref?.();
    };
    const closeCleanup = client.addCloseHandler((error) => {
      runtimeFailure = `codex_app_server_producer_lost:${error.message}`;
      queue.push({ type: "error", runId, message: runtimeFailure });
      queue.close();
    });
    let cancellationGrace: ReturnType<typeof setTimeout> | undefined;
    const abortTurn = () => {
      cancelRequested = true;
      if (activeTurnId) {
        void client
          .request("turn/interrupt", { threadId: thread.threadId, turnId: activeTurnId })
          .catch(() => undefined);
        cancellationGrace ??= setTimeout(() => {
          runtimeFailure = "codex_cancel_grace_expired";
          queue.close();
        }, 15_000);
      }
    };
    if (request.signal?.aborted) {
      abortTurn();
    }
    request.signal?.addEventListener("abort", abortTurn, { once: true });

    const replayPendingNotifications = async () => {
      for (const notification of pendingNotifications.splice(0)) {
        await handleNotification(notification);
      }
    };
    const handleNotification = async (notification: { method: string; params?: JsonValue }) => {
      if (!activeTurnId) {
        pendingNotifications.push(notification);
        return;
      }
      if (codexNotificationMatches(notification, thread.threadId, activeTurnId)) {
        armCompactLivenessBoundary();
      }
      const completed = projector.handleNotification(notification, activeTurnId);
      if (completed) {
        turnCompleted = true;
        queue.close();
      }
    };
    const notificationCleanup = client.addNotificationHandler(handleNotification);

    try {
      if (compactTurn) {
        const turn = await client.request<CodexTurnStartResponse>(
          "thread/compact/start",
          { threadId: thread.threadId },
          { timeoutMs: this.options.requestTimeoutMs ?? 60_000, signal: request.signal },
        );
        activeTurnId = turn.turn?.id ?? "";
        if (!activeTurnId) throw new Error("codex_compact_turn_id_missing");
        activeTurn.nativeTurnId = activeTurnId;
        armCompactLivenessBoundary();
        await replayPendingNotifications();
        if (cancelRequested) abortTurn();
      } else {
        const turn = await client.request<CodexTurnStartResponse>(
          "turn/start",
          {
            threadId: thread.threadId,
            input: turnInputItems as unknown as JsonValue,
            ...(request.structuredOutputSchema ? { outputSchema: request.structuredOutputSchema } : {}),
          },
          { timeoutMs: this.options.requestTimeoutMs ?? 60_000, signal: request.signal },
        );
        activeTurnId = turn.turn?.id ?? "";
        if (!activeTurnId) {
          throw new Error("codex_turn_id_missing");
        }
        activeTurn.nativeTurnId = activeTurnId;
        await replayPendingNotifications();
        if (cancelRequested) abortTurn();
      }
      for await (const event of queue) {
        if (event.type === "compaction.started") {
          compactionTriggered = true;
        } else if (event.type === "compaction.finished") {
          compactionTriggered = true;
          compactionSucceeded = true;
        }
        if (event.type === "approval.requested" && event.request.resume?.type !== "kernel.native") {
          pauseRequest = event.request;
        } else if (event.type === "approval.resolved" && pauseRequest?.id === event.request.id) {
          pauseRequest = undefined;
        }
        yield event;
      }
    } catch (error) {
      runtimeFailure = error instanceof Error ? error.message : String(error);
      if (!activeTurnId && isAbandonedMutatingRequest(error, request.signal)) {
        this.poisonClient(clientKey, client);
      }
      yield {
        type: "error",
        runId,
        message: runtimeFailure,
      };
    } finally {
      if (cancellationGrace) clearTimeout(cancellationGrace);
      if (compactLivenessTimer) clearTimeout(compactLivenessTimer);
      request.signal?.removeEventListener("abort", abortTurn);
      notificationCleanup();
      requestCleanup();
      closeCleanup();
      this.releaseClient(client);
      if (activeTurn) {
        for (const key of activeTurnKeys) {
          if (this.activeTurns.get(key) === activeTurn) {
            this.activeTurns.delete(key);
          }
        }
      }
    }

    if (!turnCompleted && !projector.finalText()) {
      queue.close();
    }
    const baseFinalText = projector.finalText();
    const truthCorrection = imageGenerationTruthCorrection(request, baseFinalText, projector.generatedImageCount());
    const finalText = truthCorrection ? [baseFinalText, truthCorrection].filter(Boolean).join("\n\n") : baseFinalText;
    if (projector.errorMessage()) {
      yield { type: "error", runId, message: projector.errorMessage() ?? "codex_turn_failed" };
    }
    if (truthCorrection && projector.didStreamAssistantText()) {
      yield { type: "assistant.delta", runId, text: `\n\n${truthCorrection}` };
    } else if (finalText && !projector.didStreamAssistantText()) {
      yield { type: "assistant.delta", runId, text: finalText };
    }
    yield {
      type: "model.response",
      runId,
      response: {
        text: finalText,
        usage: projector.usage(),
      },
    };
    const finalUsage = projector.usage();
    const finalContextBudget = resolveContextTokenBudget(request.contextTokenBudget, finalUsage?.contextWindowSize);
    yield contextBudgetDiagnostic({
      runId,
      kernel: "codex",
      ...finalContextBudget,
      usageSource: finalUsage?.contextUsedTokens !== undefined ? "native" : "unavailable",
      enforcementMode: "native-auto",
      contextUsedTokens: finalUsage?.contextUsedTokens,
      compactionTriggered,
      compactionSucceeded,
      reason: "turn-final",
    });
    if (pauseRequest) {
      yield {
        type: "run.paused",
        runId,
        at: new Date().toISOString(),
        reason: pauseRequest.reason,
        approvalId: pauseRequest.id,
      };
      return;
    }
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: projector.errorMessage()
        ? { taskState: "TASK_STATE_FAILED", reasonCode: projector.errorMessage() || "codex_turn_failed" }
        : runtimeFailure
          ? {
              taskState: "TASK_STATE_FAILED",
              reasonCode: "codex_runtime_failed",
              outcomeUnknown: true,
            }
          : cancelRequested
            ? isCodexCanceledTerminalStatus(projector.nativeTerminalStatus())
              ? { taskState: "TASK_STATE_CANCELED", reasonCode: "user_canceled" }
              : {
                  taskState: "TASK_STATE_FAILED",
                  reasonCode: "cancel_outcome_unknown",
                  outcomeUnknown: true,
                }
            : turnCompleted && projector.nativeTerminalStatus() === "completed"
              ? { taskState: "TASK_STATE_COMPLETED" }
              : {
                  taskState: "TASK_STATE_FAILED",
                  reasonCode:
                    projector.nativeTerminalStatus() && projector.nativeTerminalStatus() !== "completed"
                      ? `codex_unknown_terminal_status:${projector.nativeTerminalStatus()}`
                      : compactTurn
                        ? "codex_compact_terminal_missing"
                        : "codex_native_terminal_missing",
                  outcomeUnknown: true,
                },
    };
  }

  async steerTurn(request: AgentSteerRequest): Promise<AgentSteerResult> {
    const instruction = request.instruction.trim();
    if (!instruction) {
      return { ok: false, guided: false, error: "instruction_required" };
    }
    const activeTurn = await this.waitForActiveTurn(request, 5_000);
    if (!activeTurn) {
      return { ok: false, guided: false, error: "active_turn_not_found" };
    }
    if (!activeTurn.nativeTurnId) {
      return { ok: false, guided: false, error: "active_turn_not_ready" };
    }
    try {
      const response = await activeTurn.client.request<{ turnId?: string }>(
        "turn/steer",
        {
          threadId: activeTurn.nativeThreadId,
          expectedTurnId: activeTurn.nativeTurnId,
          input: [{ type: "text", text: instruction, text_elements: [] }],
        } as JsonValue,
        { timeoutMs: this.options.requestTimeoutMs ?? 15_000 },
      );
      const turnId = typeof response?.turnId === "string" ? response.turnId : undefined;
      return {
        ok: turnId === activeTurn.nativeTurnId,
        guided: turnId === activeTurn.nativeTurnId,
        ...(turnId && turnId !== activeTurn.nativeTurnId ? { error: "steered_different_turn" } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        guided: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private activeTurnKeys(request: AgentTurnRequest, runId: string): string[] {
    return [request.context.sessionId ? `thread:${request.context.sessionId}` : "", runId ? `run:${runId}` : ""].filter(
      Boolean,
    );
  }

  private steerLookupKeys(request: AgentSteerRequest): string[] {
    return [request.threadId ? `thread:${request.threadId}` : "", request.runId ? `run:${request.runId}` : ""].filter(
      Boolean,
    );
  }

  private async waitForActiveTurn(request: AgentSteerRequest, timeoutMs: number): Promise<ActiveCodexTurn | undefined> {
    const startedAt = Date.now();
    const keys = this.steerLookupKeys(request);
    while (Date.now() - startedAt < timeoutMs) {
      const activeTurn = keys
        .map((key) => this.activeTurns.get(key))
        .find((item): item is ActiveCodexTurn => Boolean(item));
      if (activeTurn?.nativeTurnId) {
        return activeTurn;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    return keys.map((key) => this.activeTurns.get(key)).find((item): item is ActiveCodexTurn => Boolean(item));
  }

  private async applyThreadGoal(
    client: CodexAppServerClient,
    threadId: string,
    request: AgentTurnRequest,
  ): Promise<AgentEvent | undefined> {
    if (!request.threadGoal) {
      return undefined;
    }
    const at = new Date().toISOString();
    try {
      if (!request.threadGoal.enabled) {
        const response = await client.request<{ cleared?: boolean }>(
          "thread/goal/clear",
          { threadId },
          { timeoutMs: this.options.requestTimeoutMs ?? 15_000 },
        );
        return {
          type: "runtime.diagnostic",
          runId: request.runId ?? "",
          at,
          name: "codex.goal.cleared",
          data: {
            threadId,
            cleared: response?.cleared === true,
          },
        };
      }
      const objective =
        request.threadGoal.objective?.trim() || request.input.trim() || "Continue pursuing the current OpenGrove goal.";
      const response = await client.request<{ goal?: JsonObject }>(
        "thread/goal/set",
        {
          threadId,
          objective,
          status: "active",
          ...(request.threadGoal.tokenBudget ? { tokenBudget: request.threadGoal.tokenBudget } : {}),
        },
        { timeoutMs: this.options.requestTimeoutMs ?? 15_000 },
      );
      const goal = response?.goal && typeof response.goal === "object" ? response.goal : undefined;
      return {
        type: "runtime.diagnostic",
        runId: request.runId ?? "",
        at,
        name: "codex.goal.configured",
        data: {
          threadId,
          objectivePreview: truncateDiagnosticText(objective, 180),
          status: typeof goal?.status === "string" ? goal.status : "active",
          tokenBudget:
            typeof goal?.tokenBudget === "number" ? goal.tokenBudget : (request.threadGoal.tokenBudget ?? null),
        },
      };
    } catch (error) {
      return {
        type: "runtime.diagnostic",
        runId: request.runId ?? "",
        at,
        name: "codex.goal.error",
        data: {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async ensureClient(runtimeEnv?: NodeJS.ProcessEnv): Promise<CodexAppServerClient> {
    const clientKey = envFingerprint(runtimeEnv);
    const initializing = this.clientReady.get(clientKey);
    if (initializing) return await initializing;
    const existing = this.clients.get(clientKey);
    if (existing && !existing.isClosed()) {
      return existing;
    }
    if (existing?.isClosed()) {
      this.clients.delete(clientKey);
    }
    const rpcCapture = createCodexRpcCaptureRecorder(this.options.rpcCapture, runtimeEnv);
    const env = { ...process.env, ...runtimeEnv };
    if (!env.TERM) {
      env.TERM = "dumb";
    }
    const command = this.options.command ?? "codex";
    const ready = this.startAppServerWithFlagFallback(
      command,
      this.options.args ?? DEFAULT_CODEX_APP_SERVER_ARGS,
      env,
      rpcCapture,
    );
    this.clientReady.set(clientKey, ready);
    try {
      const client = await ready;
      this.clients.set(clientKey, client);
      return client;
    } finally {
      if (this.clientReady.get(clientKey) === ready) this.clientReady.delete(clientKey);
    }
  }

  // Newer Codex builds remove `--disable` feature flags that older ones require. If the
  // first launch aborts with `Unknown feature flag: <name>`, drop exactly those flags and
  // retry once, so a single binary works across versions without a hard-coded cutoff.
  private async startAppServerWithFlagFallback(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    rpcCapture: ReturnType<typeof createCodexRpcCaptureRecorder>,
  ): Promise<CodexAppServerClient> {
    const client = CodexAppServerClient.start({ command, args, env, rpcCapture });
    try {
      await client.initialize();
      return client;
    } catch (error) {
      const rejectedFlags = unknownCodexFeatureFlagsFromStderr(client.recentStderr());
      const reducedArgs = stripDisableFeatureFlags(args, rejectedFlags);
      if (!rejectedFlags.length || reducedArgs === args) {
        client.close();
        throw error;
      }
      client.close();
      rpcCapture?.recordLifecycle("app_server.feature_flag_fallback", {
        droppedFlags: rejectedFlags,
      });
      const retried = CodexAppServerClient.start({ command, args: reducedArgs, env, rpcCapture });
      try {
        await retried.initialize();
        return retried;
      } catch (retryError) {
        retried.close();
        throw retryError;
      }
    }
  }

  close(): void {
    for (const client of new Set([...this.clients.values(), ...this.retiredClients])) {
      client.close();
    }
    this.clients.clear();
    this.clientReady.clear();
    this.clientLeases.clear();
    this.retiredClients.clear();
  }

  private leaseClient(client: CodexAppServerClient): void {
    this.clientLeases.set(client, (this.clientLeases.get(client) ?? 0) + 1);
  }

  private releaseClient(client: CodexAppServerClient): void {
    const remaining = Math.max(0, (this.clientLeases.get(client) ?? 1) - 1);
    if (remaining > 0) {
      this.clientLeases.set(client, remaining);
      return;
    }
    this.clientLeases.delete(client);
    if (this.retiredClients.delete(client)) client.close();
  }

  private poisonClient(clientKey: string, client: CodexAppServerClient): void {
    if (this.clients.get(clientKey) === client) this.clients.delete(clientKey);
    this.retiredClients.add(client);
    if ((this.clientLeases.get(client) ?? 0) === 0) {
      this.retiredClients.delete(client);
      client.close();
    }
  }

  private async startOrResumeThread(
    client: CodexAppServerClient,
    request: AgentTurnRequest,
    options: {
      cwd: string;
      model: string;
      modelProvider?: string;
      runtimeBindingFingerprint: string;
      developerInstructions: string;
      dynamicTools: CodexDynamicToolSpec[];
      dynamicToolsFingerprint: string;
      sandbox: CodexSandboxMode;
      approvalPolicy: CodexApprovalPolicy;
      approvalsReviewer: CodexApprovalsReviewer;
      reasoningEffort?: string;
      serviceTier?: string;
      config: JsonObject;
      threadSource: CodexThreadSource;
    },
  ): Promise<CodexThreadBinding> {
    this.loadBindings();
    const sessionId = request.context.sessionId || "local";
    const bindingKey = `${sessionId}:${options.runtimeBindingFingerprint}`;
    const existing = this.bindings.get(bindingKey);
    const modelProviderKey = options.modelProvider ?? "";
    if (
      existing?.threadId &&
      existing.dynamicToolsFingerprint === options.dynamicToolsFingerprint &&
      codexModelProviderMatches(existing.modelProvider, modelProviderKey) &&
      existing.runtimeBindingFingerprint === options.runtimeBindingFingerprint
    ) {
      try {
        const response = await client.request<CodexThreadStartResponse>(
          "thread/resume",
          {
            threadId: existing.threadId,
            model: options.model,
            ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
            approvalPolicy: options.approvalPolicy,
            approvalsReviewer: options.approvalsReviewer,
            sandbox: options.sandbox,
            config: options.config,
            ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
            ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
          },
          { timeoutMs: this.options.requestTimeoutMs ?? 60_000, signal: request.signal },
        );
        const threadId = response.thread?.id ?? existing.threadId;
        const binding = {
          ...existing,
          threadId,
          model: response.model ?? options.model,
          modelProvider: codexStoredModelProvider(response.modelProvider, options.modelProvider),
          runtimeBindingFingerprint: options.runtimeBindingFingerprint,
          cwd: options.cwd,
          updatedAt: new Date().toISOString(),
        };
        this.bindings.set(bindingKey, binding);
        this.saveBindings();
        return binding;
      } catch (error) {
        if (isAbandonedMutatingRequest(error, request.signal)) throw error;
        // non-critical-fallback: A rejected resume invalidates this binding and the normal path creates a fresh thread.
        this.bindings.delete(bindingKey);
        this.saveBindings();
      }
    }

    const response = await client.request<CodexThreadStartResponse>(
      "thread/start",
      {
        model: options.model,
        ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
        cwd: options.cwd,
        approvalPolicy: options.approvalPolicy,
        approvalsReviewer: options.approvalsReviewer,
        sandbox: options.sandbox,
        serviceName: "OpenGrove",
        threadSource: options.threadSource,
        developerInstructions: options.developerInstructions,
        dynamicTools: options.dynamicTools,
        config: options.config,
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      },
      { timeoutMs: this.options.requestTimeoutMs ?? 60_000, signal: request.signal },
    );
    const threadId = response.thread?.id;
    if (!threadId) {
      throw new Error("codex_thread_id_missing");
    }
    const createdAt = new Date().toISOString();
    const binding: CodexThreadBinding = {
      threadId,
      dynamicToolsFingerprint: options.dynamicToolsFingerprint,
      runtimeBindingFingerprint: options.runtimeBindingFingerprint,
      model: response.model ?? options.model,
      modelProvider: codexStoredModelProvider(response.modelProvider, options.modelProvider),
      cwd: options.cwd,
      createdAt,
      updatedAt: createdAt,
    };
    this.bindings.set(bindingKey, binding);
    this.saveBindings();
    return binding;
  }

  private loadBindings(): void {
    if (this.bindingsLoaded) {
      return;
    }
    this.bindingsLoaded = true;
    const path = this.options.statePath;
    if (!path || !existsSync(path)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      for (const [sessionId, binding] of Object.entries(parsed)) {
        if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
          continue;
        }
        const object = binding as Record<string, unknown>;
        if (typeof object.threadId !== "string") {
          continue;
        }
        this.bindings.set(sessionId, {
          threadId: object.threadId,
          dynamicToolsFingerprint:
            typeof object.dynamicToolsFingerprint === "string" ? object.dynamicToolsFingerprint : "",
          model: typeof object.model === "string" ? object.model : undefined,
          modelProvider: typeof object.modelProvider === "string" ? object.modelProvider : undefined,
          runtimeBindingFingerprint:
            typeof object.runtimeBindingFingerprint === "string" ? object.runtimeBindingFingerprint : undefined,
          cwd: typeof object.cwd === "string" ? object.cwd : undefined,
          createdAt: typeof object.createdAt === "string" ? object.createdAt : new Date().toISOString(),
          updatedAt: typeof object.updatedAt === "string" ? object.updatedAt : new Date().toISOString(),
        });
      }
    } catch (error) {
      const quarantinePath = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, quarantinePath);
        console.warn("codex_binding_state_quarantined", {
          path,
          quarantinePath,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (quarantineError) {
        throw new Error(
          `codex_binding_state_invalid:${error instanceof Error ? error.message : String(error)};quarantine_failed:${
            quarantineError instanceof Error ? quarantineError.message : String(quarantineError)
          }`,
        );
      }
    }
  }

  private saveBindings(): void {
    const path = this.options.statePath;
    if (!path) {
      return;
    }
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    let file: number | undefined;
    try {
      file = openSync(tempPath, "wx", 0o600);
      writeFileSync(file, `${JSON.stringify(Object.fromEntries(this.bindings.entries()), null, 2)}\n`, "utf8");
      fsyncSync(file);
      closeSync(file);
      file = undefined;
      renameSync(tempPath, path);
      const directoryHandle = openSync(directory, "r");
      try {
        fsyncSync(directoryHandle);
      } finally {
        closeSync(directoryHandle);
      }
    } finally {
      if (file !== undefined) closeSync(file);
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }
}

export function readCodexModelContextWindow(
  model: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): number | undefined {
  if (!model) return undefined;
  const codexHome = env?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex");
  try {
    const parsed = JSON.parse(readFileSync(resolve(codexHome, "models_cache.json"), "utf8")) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return undefined;
    const entry = parsed.models.find((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const record = candidate as Record<string, unknown>;
      return record.slug === model || record.id === model;
    }) as Record<string, unknown> | undefined;
    const value = entry?.context_window ?? entry?.contextWindow;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  } catch {
    return undefined;
  }
}

export function codexThreadConfig(
  provider: CodexModelProviderRuntimeConfig | undefined,
  overrides: {
    reasoningEffort?: string;
    reasoningSummary?: "auto" | "concise" | "detailed" | "none";
    serviceTier?: string;
    contextTokenBudget?: number;
  } = {},
): JsonObject {
  const config: JsonObject = {
    ...CODEX_THREAD_CONFIG_OVERRIDES,
    ...(overrides.reasoningEffort ? { model_reasoning_effort: overrides.reasoningEffort } : {}),
    ...(overrides.reasoningSummary ? { model_reasoning_summary: overrides.reasoningSummary } : {}),
    ...(overrides.serviceTier ? { service_tier: overrides.serviceTier } : {}),
    ...(overrides.contextTokenBudget ? { model_auto_compact_token_limit: overrides.contextTokenBudget } : {}),
  };
  if (!provider) return config;
  return {
    ...config,
    model_provider: provider.providerKey,
    [`model_providers.${provider.providerKey}.name`]: provider.name,
    [`model_providers.${provider.providerKey}.base_url`]: provider.baseUrl,
    [`model_providers.${provider.providerKey}.env_key`]: provider.envKey,
    [`model_providers.${provider.providerKey}.wire_api`]: provider.wireApi,
  };
}

function codexMediaInputDiagnostic(items: CodexTurnInputItem[]): JsonObject | undefined {
  const imageInputs = items.filter((item) => item.type === "image");
  const mentionInputs = items.filter((item) => item.type === "mention");
  if (!imageInputs.length && !mentionInputs.length) {
    return undefined;
  }
  return {
    imageInputs: imageInputs.length,
    mentionInputs: mentionInputs.length,
    inputItemTypes: items.map((item) => item.type),
  };
}

function codexOutputSchemaDiagnostic(schema: JsonObject): JsonObject {
  return {
    configured: true,
    schemaType: typeof schema.type === "string" ? schema.type : "",
    propertyCount:
      schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? Object.keys(schema.properties).length
        : 0,
  };
}

type CodexRuntimeBindingFingerprintInput = {
  base?: string;
  model: string;
  modelProvider?: string;
  dynamicToolsFingerprint: string;
  developerInstructionsFingerprint: string;
  cwd: string;
  runtimeEnvFingerprint: string;
};

export function codexRuntimeBindingFingerprint(input: CodexRuntimeBindingFingerprintInput): string {
  return [
    input.base || "native",
    input.modelProvider || "native",
    input.dynamicToolsFingerprint,
    input.developerInstructionsFingerprint,
    input.cwd,
    "normal",
    input.runtimeEnvFingerprint,
  ].join(":");
}

function textFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function mergeRuntimeEnv(
  base: NodeJS.ProcessEnv | undefined,
  override: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  const merged = { ...(base ?? {}), ...(override ?? {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return Object.keys(merged).length ? merged : undefined;
}

function codexAuthRefreshDiagnostic(response: JsonObject): JsonObject {
  const tokens =
    response.tokens && typeof response.tokens === "object" && !Array.isArray(response.tokens)
      ? (response.tokens as JsonObject)
      : response;
  return {
    requested: true,
    hasIdToken: typeof tokens.id_token === "string" || typeof tokens.idToken === "string",
    hasAccessToken: typeof tokens.access_token === "string" || typeof tokens.accessToken === "string",
    hasRefreshToken: typeof tokens.refresh_token === "string" || typeof tokens.refreshToken === "string",
    hasAccountId: typeof tokens.account_id === "string" || typeof tokens.accountId === "string",
  };
}

function truncateDiagnosticText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function envFingerprint(env: NodeJS.ProcessEnv | undefined): string {
  const entries = Object.entries(env ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .filter(([key]) => !isVolatileOpenGroveRuntimeEnvKey(key))
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "env:default";
  return `env:${createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16)}`;
}

function isAbandonedMutatingRequest(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof CodexRequestFailure && (error.kind === "aborted" || error.kind === "timeout"))
  );
}

function codexNotificationMatches(
  notification: { method: string; params?: JsonValue },
  threadId: string,
  turnId?: string,
): boolean {
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  if (!params) return false;
  const notificationThreadId = readString(params, "threadId");
  const notificationTurnId = readString(params, "turnId");
  const nestedTurn = isJsonObject(params.turn) ? params.turn : undefined;
  const nestedTurnId = readString(nestedTurn ?? {}, "id");
  return (
    (!notificationThreadId || notificationThreadId === threadId) &&
    (!turnId || (!notificationTurnId && !nestedTurnId) || notificationTurnId === turnId || nestedTurnId === turnId)
  );
}

function isCodexCanceledTerminalStatus(status: string | undefined): boolean {
  return status === "canceled" || status === "cancelled" || status === "interrupted";
}

function isVolatileOpenGroveRuntimeEnvKey(key: string): boolean {
  return key === "OPENGROVE_ROOM_LEDGER_CAPABILITY_JSON" || key === "OPENGROVE_SOURCE_ROOM_ID";
}

function isCodexCompactCommand(input: string): boolean {
  return input.trim() === "/compact";
}

function codexModelProviderMatches(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = codexComparableModelProvider(left);
  const normalizedRight = codexComparableModelProvider(right);
  return normalizedLeft === normalizedRight;
}

function codexStoredModelProvider(
  responseModelProvider: string | null | undefined,
  requestedModelProvider: string | undefined,
): string | undefined {
  const value = responseModelProvider ?? requestedModelProvider;
  if (!requestedModelProvider && codexComparableModelProvider(value) === "") {
    return undefined;
  }
  return value ?? requestedModelProvider;
}

function codexComparableModelProvider(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized === "openai" ? "" : normalized;
}

export function shouldExposeCodexDynamicTools(request: AgentTurnRequest): boolean {
  if (request.dynamicToolsMode === "always") {
    return true;
  }
  if (request.dynamicToolsMode === "disabled") {
    return false;
  }
  if (request.tools.length > 0 || (request.capabilities ?? []).some((capability) => capability.tools.length > 0)) {
    return true;
  }
  if (request.requestedSkillInvocation) {
    return true;
  }
  return /browser|computer|memory|selection|网页|浏览器|页面|选中|桌面|窗口|点击|保存笔记|记住|记忆/.test(
    request.input,
  );
}
