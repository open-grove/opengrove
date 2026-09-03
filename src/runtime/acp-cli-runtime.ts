import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { resolveCommandInvocation } from "../kernel/discovery.js";
import type {
  AgentCompactRequest,
  AgentCompactResult,
  AgentEvent,
  AgentRuntime,
  AgentSessionTrace,
  AgentTurnRequest,
  ApprovalRequest,
  JsonObject,
} from "../core.js";
import { agentTurnHostContextPromptBlock, agentTurnReplyLanguageInstruction } from "../core.js";
import { AsyncEventQueue } from "./codex/async-event-queue.js";
import {
  AcpSessionProjector,
  defaultAcpToolId,
  readAcpContextUsage,
  readAcpUsage,
  toJsonValue,
} from "./projectors/acp.js";
import { JsonRpcRequestFailure, StdioJsonRpcClient } from "./stdio-json-rpc-client.js";
import { recentSessionMessages, recentSessionPromptBlock } from "./session-history.js";
import { imageAttachmentsWithDataUrl } from "./media-input.js";
import { resolveRuntimeRunId } from "./run-id.js";
import {
  contextBudgetDiagnostic,
  contextBudgetExceeded,
  estimateTextTokens,
  hardContextWindowExceeded,
  resolveContextTokenBudget,
} from "./context-token-budget.js";
import { createHostToolBridge } from "./host-tool-bridge.js";
import {
  AcpHostToolBridgeServer,
  AcpHostToolBridgeUnavailableError,
  type AcpHostToolBridgeProvider,
  type AcpHostToolSessionBinding,
} from "./acp-host-tool-bridge.js";

export interface AcpCliRuntimeOptions {
  kernelId: string;
  title: string;
  command: string;
  commandArgs?: string[];
  acpArgs?: string[];
  cwd?: string;
  configuredModel?: string;
  runtimeBindingFingerprint?: string;
  promptPayload?: "prompt" | "content-and-prompt";
  resumeSessions?: boolean;
  setModelFailure?: "ignore" | "error";
  skillInvocationPromptPlacement?: "user-request" | "prompt-prefix";
  toolFailureMessage?: string;
  requestTimeoutMs?: number;
  /** Liveness boundary for mutating ACP session control requests, not a Turn deadline. */
  controlRequestTimeoutMs?: number;
  /** Host-owned grace for the native session/cancel request to close the current prompt. */
  cancelGraceMs?: number;
  approvalTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  hostToolBridgeProvider?: AcpHostToolBridgeProvider;
}

export class AcpCliRuntime implements AgentRuntime {
  private readonly acpClientsByEnv = new Map<string, StdioJsonRpcClient>();
  private readonly acpClientReadyByEnv = new Map<string, Promise<StdioJsonRpcClient>>();
  private readonly acpSessionsByClient = new WeakMap<StdioJsonRpcClient, Set<string>>();
  private readonly acpImagePromptSupportedByClient = new WeakMap<StdioJsonRpcClient, boolean>();
  private readonly acpClientLeases = new Map<StdioJsonRpcClient, number>();
  private readonly retiredAcpClients = new Set<StdioJsonRpcClient>();
  private readonly acpClientByRun = new Map<string, StdioJsonRpcClient>();
  private readonly acpSessionByThread = new Map<string, string>();
  private readonly acpEnvKeyByThread = new Map<string, string>();
  private readonly opencodeModelByThread = new Map<string, string>();
  private readonly contextUsageBySession = new Map<string, { used?: number; size?: number }>();
  private readonly estimatedTokensBySession = new Map<string, number>();
  private readonly hostToolBridgeServer: AcpHostToolBridgeProvider;

  constructor(private readonly options: AcpCliRuntimeOptions) {
    this.hostToolBridgeServer = options.hostToolBridgeProvider ?? new AcpHostToolBridgeServer();
  }

  close(): void {
    for (const client of new Set([...this.acpClientsByEnv.values(), ...this.retiredAcpClients])) client.close();
    this.acpClientsByEnv.clear();
    this.acpClientReadyByEnv.clear();
    this.retiredAcpClients.clear();
    this.acpClientLeases.clear();
    this.acpClientByRun.clear();
    this.acpSessionByThread.clear();
    this.acpEnvKeyByThread.clear();
    this.opencodeModelByThread.clear();
    this.contextUsageBySession.clear();
    this.estimatedTokensBySession.clear();
    this.hostToolBridgeServer.close();
  }

  async compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    if (this.options.kernelId !== "opencode" && this.options.kernelId !== "kimi") {
      return { ok: false, compacted: false, error: "compact_unavailable" };
    }
    const nativeSessionId =
      this.acpSessionByThread.get(request.threadId) ??
      readRememberedAcpSessionFromCompactRequest(request, this.options.kernelId, this.options.runtimeBindingFingerprint)
        ?.sessionId;
    if (!nativeSessionId) {
      return { ok: false, compacted: false, error: `${this.options.kernelId}_acp_session_not_found` };
    }

    if (this.options.kernelId === "kimi") {
      const envKey =
        this.acpEnvKeyByThread.get(request.threadId) ??
        envFingerprint(normalizeAcpRuntimeEnv(this.options.kernelId, mergeRuntimeEnv(this.options.env, undefined)));
      const client = this.acpClientsByEnv.get(envKey);
      if (!client || client.isClosed()) {
        return { ok: false, compacted: false, error: "kimi_acp_unavailable" };
      }
      return await this.compactKimiSession(client, nativeSessionId, request.signal);
    }

    const runtimeEnv = normalizeAcpRuntimeEnv(this.options.kernelId, mergeRuntimeEnv(this.options.env, undefined));
    let server: OpenCodeServerProcess | undefined;
    try {
      server = await startOpenCodeServer({
        command: this.options.command,
        cwd: resolve(this.options.cwd ?? process.cwd()),
        env: runtimeEnv,
      });
      const model =
        openCodeSummarizeModel(this.opencodeModelByThread.get(request.threadId), runtimeEnv) ??
        openCodeSummarizeModel(this.options.configuredModel, runtimeEnv) ??
        (await readOpenCodeDefaultSummarizeModel(server.url, request.signal));
      if (!model) {
        return { ok: false, compacted: false, error: "opencode_summarize_model_unavailable" };
      }

      const response = await fetch(`${server.url}/session/${encodeURIComponent(nativeSessionId)}/summarize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(model),
        signal: request.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          compacted: false,
          error: `opencode_summarize_failed:${response.status}:${text.slice(0, 240)}`,
        };
      }
      const compacted = text.trim() === "true" || parseBooleanJson(text) === true;
      return compacted
        ? { ok: true, compacted: true }
        : { ok: false, compacted: false, error: `opencode_summarize_not_confirmed:${text.slice(0, 240)}` };
    } catch (error) {
      return {
        ok: false,
        compacted: false,
        error: error instanceof Error ? error.message : String(error),
        ...(request.signal?.aborted ? { outcomeUnknown: true } : {}),
      };
    } finally {
      await server?.close();
    }
  }

  private async compactKimiSession(
    client: StdioJsonRpcClient,
    nativeSessionId: string,
    signal?: AbortSignal,
  ): Promise<AgentCompactResult> {
    const beforeUsed =
      this.contextUsageBySession.get(nativeSessionId)?.used ?? this.estimatedTokensBySession.get(nativeSessionId);
    let observedUsage: { used?: number; size?: number } | undefined;
    let commandText = "";
    const cleanupNotifications = client.addNotificationHandler((notification) => {
      if (notification.method !== "session/update" && notification.method !== "session/notification") return;
      const params = asObject(notification.params);
      if (readString(params, "sessionId") !== nativeSessionId) return;
      const update = asObject(params.update);
      const usage = readAcpContextUsage(update);
      if (usage) observedUsage = usage;
      if (readString(update, "sessionUpdate") === "agent_message_chunk") {
        commandText += readString(asObject(update.content), "text") ?? "";
      }
    });
    const cancelCompact = () => client.notify("session/cancel", { sessionId: nativeSessionId });
    if (signal?.aborted) cancelCompact();
    signal?.addEventListener("abort", cancelCompact, { once: true });
    try {
      await client.request(
        "session/prompt",
        {
          sessionId: nativeSessionId,
          prompt: [{ type: "text", text: "/compact" }],
        },
        { timeoutMs: this.options.requestTimeoutMs ?? 120_000, signal },
      );
      const commandResult = readKimiCompactionResult(commandText);
      if (commandResult && commandResult.tokensAfter < commandResult.tokensBefore) {
        const previousUsage = this.contextUsageBySession.get(nativeSessionId);
        this.contextUsageBySession.set(nativeSessionId, {
          ...(previousUsage?.size !== undefined ? { size: previousUsage.size } : {}),
          used: commandResult.tokensAfter,
        });
        this.estimatedTokensBySession.set(nativeSessionId, commandResult.tokensAfter);
        return { ok: true, compacted: true };
      }
      if (beforeUsed !== undefined && observedUsage?.used !== undefined && observedUsage.used < beforeUsed) {
        this.contextUsageBySession.set(nativeSessionId, observedUsage);
        this.estimatedTokensBySession.set(nativeSessionId, observedUsage.used);
        return { ok: true, compacted: true };
      }
      const receipt = commandText.trim().replaceAll(/\s+/g, " ").slice(0, 240);
      return {
        ok: false,
        compacted: false,
        error: receipt
          ? `kimi_compaction_not_confirmed:${receipt}`
          : "kimi_compaction_not_confirmed:no_compaction_receipt",
      };
    } catch (error) {
      return {
        ok: false,
        compacted: false,
        error: error instanceof Error ? error.message : String(error),
        ...(signal?.aborted ? { outcomeUnknown: true } : {}),
      };
    } finally {
      signal?.removeEventListener("abort", cancelCompact);
      cleanupNotifications();
    }
  }

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const runId = resolveRuntimeRunId(request.runId);
    if (request.signal?.aborted) {
      yield { type: "turn.started", runId, at: new Date().toISOString() };
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: { taskState: "TASK_STATE_CANCELED", reasonCode: "user_canceled", retryable: false },
      };
      return;
    }
    const queue = new AsyncEventQueue<AgentEvent>();
    let turnStarted = false;
    let turnFinished = false;
    let producerFailure = "";
    queue.push({ type: "turn.started", runId, at: new Date().toISOString() });
    const producer = this.produceAcpTurn(request, queue, runId)
      .then(() => queue.close())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        producerFailure = message;
        if (error instanceof AcpHostToolBridgeUnavailableError) {
          queue.push({
            type: "runtime.diagnostic",
            runId,
            at: new Date().toISOString(),
            name: `${this.options.kernelId}.acp.host_tools.unavailable`,
            data: {
              code: error.code,
              transport: "loopback-http",
              action: "restart_opengrove_or_allow_loopback",
            },
          });
        }
        queue.push({
          type: "error",
          runId,
          message: translateAcpRuntimeError(message),
        });
        queue.close();
      });
    try {
      for await (const event of queue) {
        if (event.type === "turn.started") turnStarted = true;
        if (event.type === "turn.finished") turnFinished = true;
        yield event;
      }
      await producer;
    } finally {
      const runClient = this.acpClientByRun.get(runId);
      if (request.signal?.aborted && runClient && !runClient.isClosed()) {
        const nativeSessionId = readRememberedAcpSession(
          request,
          this.options.kernelId,
          this.options.runtimeBindingFingerprint,
        )?.sessionId;
        if (nativeSessionId) {
          runClient.notify("session/cancel", { sessionId: nativeSessionId });
        }
      }
      this.releaseAcpClientForRun(runId);
    }
    if (turnStarted && !turnFinished) {
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: request.signal?.aborted
          ? {
              taskState: "TASK_STATE_FAILED",
              reasonCode: "acp_cancel_outcome_unknown",
              outcomeUnknown: true,
            }
          : {
              taskState: "TASK_STATE_FAILED",
              reasonCode: producerFailure ? "acp_producer_failed" : "acp_native_terminal_missing",
              outcomeUnknown: true,
            },
      };
    }
  }

  private async produceAcpTurn(
    request: AgentTurnRequest,
    queue: AsyncEventQueue<AgentEvent>,
    runId: string,
  ): Promise<void> {
    const requestedModel =
      normalizeOptionalString(request.requestedModelId) ?? normalizeOptionalString(this.options.configuredModel);
    const runtimeEnv = normalizeAcpRuntimeEnv(
      this.options.kernelId,
      mergeRuntimeEnv(this.options.env, request.runtimeEnv),
    );
    const prompt = buildAcpPrompt(request, this.options.title, this.options.skillInvocationPromptPlacement);
    const envKey = envFingerprint(runtimeEnv);
    const client = await this.ensureAcpClient(runtimeEnv);
    this.leaseAcpClientForRun(runId, client);
    const cwd = resolve(this.options.cwd ?? process.cwd());
    const hostTools = request.tools.length
      ? createHostToolBridge(request, runId, queue, this.options.kernelId)
      : undefined;
    const hostToolBinding = hostTools
      ? await this.hostToolBridgeServer.prepare({
          scope: request.hostToolScope ?? { sessionId: request.context.sessionId },
          bridge: hostTools,
        })
      : undefined;
    let nativeSession: { sessionId: string; resuming: boolean };
    try {
      nativeSession = await this.ensureAcpSession(client, request, cwd, requestedModel, hostToolBinding);
    } catch (error) {
      if (shouldPoisonAcpTransport(error, client)) this.poisonAcpClient(envKey, client);
      throw error;
    }
    this.acpSessionByThread.set(request.context.sessionId, nativeSession.sessionId);
    this.acpEnvKeyByThread.set(request.context.sessionId, envKey);
    if (requestedModel && this.options.kernelId === "opencode") {
      this.opencodeModelByThread.set(request.context.sessionId, requestedModel);
    }
    const priorMessages = recentSessionMessages(request);
    const sessionTrace: AgentSessionTrace = {
      provider: this.options.kernelId,
      sessionId: nativeSession.sessionId,
      persistent: true,
      priorMessageCount: nativeSession.resuming ? priorMessages.length : 0,
      priorMessages: nativeSession.resuming ? priorMessages : [],
    };
    let assistantText = "";
    const projector = new AcpSessionProjector({
      runId,
      kernelId: this.options.kernelId,
      diagnosticPrefix: `${this.options.kernelId}.acp`,
      toolFailureMessage: this.options.toolFailureMessage ?? `${this.options.title} tool failed`,
      ignoreToolCall: hostTools
        ? (update) => hostTools.isToolName(readString(update, "name") ?? readString(update, "title") ?? "")
        : undefined,
      onAssistantText(text) {
        assistantText += text;
      },
    });

    if (request.assembledContext) {
      queue.push({ type: "context.assembled", runId, context: request.assembledContext });
    }
    await this.prepareContextBudget({
      client,
      nativeSessionId: nativeSession.sessionId,
      threadId: request.context.sessionId,
      request,
      queue,
      runId,
      priorMessages,
      incomingTokens: estimateTextTokens(prompt),
    });
    const policyDiagnostic = acpPolicyDiagnostic(this.options.kernelId, request, runtimeEnv);
    if (policyDiagnostic) {
      queue.push({
        type: "runtime.diagnostic",
        runId,
        at: new Date().toISOString(),
        name: policyDiagnostic.name,
        data: policyDiagnostic.data,
      });
    }
    queue.push({
      type: "runtime.diagnostic",
      runId,
      at: new Date().toISOString(),
      name: `${this.options.kernelId}.acp.session`,
      data: {
        sessionId: nativeSession.sessionId,
        resuming: nativeSession.resuming,
        hostToolMcpServers: hostToolBinding ? 1 : 0,
        hostToolIds: hostTools?.exposedToolIds ?? [],
      },
    });
    queue.push({
      type: "model.requested",
      runId,
      request: {
        systemPrompt: `${this.options.title} ACP mode. OpenGrove host context is prepended to the user prompt when present.`,
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
      if (notification.method !== "session/update" && notification.method !== "session/notification") return;
      const params = asObject(notification.params);
      if (readString(params, "sessionId") !== nativeSession.sessionId) return;
      const update = asObject(params.update);
      const contextUsage = readAcpContextUsage(update);
      if (contextUsage) {
        this.contextUsageBySession.set(nativeSession.sessionId, contextUsage);
      }
      for (const event of projector.project(update)) {
        queue.push(event);
      }
    });
    const cleanupRequests = client.addRequestHandler(async (rpcRequest) => {
      if (rpcRequest.method !== "session/request_permission" && rpcRequest.method !== "session/requestPermission")
        return undefined;
      const params = asObject(rpcRequest.params);
      if (readString(params, "sessionId") !== nativeSession.sessionId) return undefined;
      return await this.handleAcpPermissionRequest(params, {
        request,
        runId,
        queue,
      });
    });
    const promptController = new AbortController();
    let cancelGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const abortPrompt = () => {
      client.notify("session/cancel", { sessionId: nativeSession.sessionId });
      if (cancelGraceTimer) return;
      cancelGraceTimer = setTimeout(() => promptController.abort(), this.options.cancelGraceMs ?? 15_000);
      cancelGraceTimer.unref?.();
    };
    if (request.signal?.aborted) abortPrompt();
    request.signal?.addEventListener("abort", abortPrompt, { once: true });

    try {
      hostToolBinding?.activate(hostTools!);
      const imageBlocks = this.acpImagePromptSupportedByClient.get(client) ? acpImageBlocks(request) : [];
      if (imageBlocks.length) {
        queue.push({
          type: "runtime.diagnostic",
          runId,
          at: new Date().toISOString(),
          name: `${this.options.kernelId}.media_input.configured`,
          data: { imageInputs: imageBlocks.length },
        });
      }
      const promptBlocks = [{ type: "text", text: prompt }, ...imageBlocks];
      const promptParams: JsonObject = {
        sessionId: nativeSession.sessionId,
        prompt: promptBlocks,
      };
      if (this.options.promptPayload === "content-and-prompt") {
        promptParams.content = promptBlocks;
      }
      const response = await client.request("session/prompt", promptParams, {
        timeoutMs: this.options.requestTimeoutMs,
        signal: promptController.signal,
      });
      for (const event of projector.flushReasoning()) {
        queue.push(event);
      }
      const usage = readAcpUsage(response);
      const finalText = assistantText.trimEnd();
      const previousEstimate = this.estimatedTokensBySession.get(nativeSession.sessionId) ?? 0;
      this.estimatedTokensBySession.set(
        nativeSession.sessionId,
        previousEstimate + estimateTextTokens(prompt) + estimateTextTokens(finalText) + 16,
      );
      if (!finalText.trim()) {
        const diagnostic = client.stderr().trim();
        if (diagnostic) {
          queue.push({
            type: "runtime.diagnostic",
            runId,
            at: new Date().toISOString(),
            name: `${this.options.kernelId}.acp.empty_response_diagnostic`,
            data: { diagnostic },
          });
        }
        queue.push({
          type: "error",
          runId,
          message: diagnostic || `${this.options.kernelId}_empty_response`,
        });
        queue.push({
          type: "turn.finished",
          runId,
          at: new Date().toISOString(),
          outcome: { taskState: "TASK_STATE_FAILED", reasonCode: "acp_empty_response" },
        });
        return;
      }
      queue.push({
        type: "model.response",
        runId,
        response: { text: finalText, ...(usage ? { usage } : {}) },
      });
      queue.push({
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: request.signal?.aborted
          ? { taskState: "TASK_STATE_CANCELED", reasonCode: "native_cancelled", retryable: false }
          : { taskState: "TASK_STATE_COMPLETED" },
      });
    } catch (error) {
      for (const event of projector.flushReasoning()) {
        queue.push(event);
      }
      const message = error instanceof Error ? error.message : String(error);
      const rawMessage = client.stderr().trim() || message || `${this.options.kernelId}_acp_failed`;
      queue.push({
        type: "error",
        runId,
        message: translateAcpRuntimeError(rawMessage),
      });
    } finally {
      if (cancelGraceTimer) clearTimeout(cancelGraceTimer);
      if (hostTools) hostToolBinding?.deactivate(hostTools);
      request.signal?.removeEventListener("abort", abortPrompt);
      cleanupRequests();
      cleanupNotifications();
    }
  }

  private async prepareContextBudget(input: {
    client: StdioJsonRpcClient;
    nativeSessionId: string;
    threadId: string;
    request: AgentTurnRequest;
    queue: AsyncEventQueue<AgentEvent>;
    runId: string;
    priorMessages: ReturnType<typeof recentSessionMessages>;
    incomingTokens: number;
  }): Promise<void> {
    const nativeUsage = this.contextUsageBySession.get(input.nativeSessionId);
    let estimatedTokens = this.estimatedTokensBySession.get(input.nativeSessionId);
    if (estimatedTokens === undefined) {
      estimatedTokens = estimateTextTokens(JSON.stringify(input.priorMessages));
      this.estimatedTokensBySession.set(input.nativeSessionId, estimatedTokens);
    }
    const contextUsedTokens = nativeUsage?.used ?? estimatedTokens;
    const projectedContextTokens = contextUsedTokens + input.incomingTokens;
    const budget = resolveContextTokenBudget(input.request.contextTokenBudget, nativeUsage?.size);
    const usageSource = nativeUsage?.used !== undefined ? ("native" as const) : ("estimated" as const);
    const effectiveBudget = budget.effectiveBudget;
    if (budget.budgetSource !== "configured" || effectiveBudget === undefined) {
      input.queue.push(
        contextBudgetDiagnostic({
          runId: input.runId,
          kernel: this.options.kernelId,
          ...budget,
          usageSource,
          enforcementMode: "native-trigger",
          contextUsedTokens,
          reason: "employee/App budget unconfigured; preserving Kernel default behavior",
        }),
      );
      return;
    }
    if (!contextBudgetExceeded(projectedContextTokens, effectiveBudget)) {
      input.queue.push(
        contextBudgetDiagnostic({
          runId: input.runId,
          kernel: this.options.kernelId,
          ...budget,
          usageSource,
          enforcementMode: "native-trigger",
          contextUsedTokens,
          reason: nativeUsage ? "ACP usage_update" : "OpenGrove session estimate",
        }),
      );
      return;
    }

    input.queue.push({
      type: "compaction.started",
      runId: input.runId,
      at: new Date().toISOString(),
      reason: `${this.options.title} projected context reached ${projectedContextTokens}/${effectiveBudget} tokens`,
    });
    const result =
      this.options.kernelId === "kimi"
        ? await this.compactKimiSession(input.client, input.nativeSessionId, input.request.signal)
        : await this.compactSession({
            runId: input.runId,
            threadId: input.threadId,
            reason: "OpenGrove context token budget reached",
            maxTokens: effectiveBudget,
          });
    if (result.ok && result.compacted) {
      if (this.options.kernelId === "opencode") {
        this.contextUsageBySession.delete(input.nativeSessionId);
        this.estimatedTokensBySession.set(input.nativeSessionId, 0);
      }
      input.queue.push({
        type: "compaction.finished",
        runId: input.runId,
        at: new Date().toISOString(),
        summary: `${this.options.title} native compaction finished.`,
      });
      input.queue.push(
        contextBudgetDiagnostic({
          runId: input.runId,
          kernel: this.options.kernelId,
          ...budget,
          usageSource,
          enforcementMode: "native-trigger",
          contextUsedTokens,
          compactionTriggered: true,
          compactionSucceeded: true,
          reason: this.options.kernelId === "opencode" ? "session summarize" : "/compact",
        }),
      );
      return;
    }

    const error = result.error || `${this.options.kernelId}_context_compaction_failed`;
    input.queue.push(
      contextBudgetDiagnostic({
        runId: input.runId,
        kernel: this.options.kernelId,
        ...budget,
        usageSource,
        enforcementMode: "native-trigger",
        contextUsedTokens,
        compactionTriggered: true,
        compactionSucceeded: false,
        reason: error,
      }),
    );
    if (hardContextWindowExceeded(projectedContextTokens, budget)) {
      throw new Error(`context_hard_window_exceeded:${projectedContextTokens}/${budget.modelContextWindow}:${error}`);
    }
  }

  private async ensureAcpClient(runtimeEnv: NodeJS.ProcessEnv | undefined): Promise<StdioJsonRpcClient> {
    const envKey = envFingerprint(runtimeEnv);
    const initializing = this.acpClientReadyByEnv.get(envKey);
    if (initializing) return await initializing;
    const existing = this.acpClientsByEnv.get(envKey);
    if (existing && !existing.isClosed()) return existing;
    if (existing) this.acpClientsByEnv.delete(envKey);
    const args = [...(this.options.commandArgs ?? []), ...(this.options.acpArgs ?? ["acp"])];
    const cwd = resolve(this.options.cwd ?? process.cwd());
    const env = normalizeAcpRuntimeEnv(this.options.kernelId, { ...process.env, ...runtimeEnv });
    const client = StdioJsonRpcClient.start({
      command: this.options.command,
      args,
      cwd,
      env: { ...env, PWD: cwd },
    });
    this.acpClientsByEnv.set(envKey, client);
    this.acpSessionsByClient.set(client, new Set());
    const ready = (async () => {
      const initializeResult = asObject(
        await client.request(
          "initialize",
          {
            protocolVersion: 1,
            clientInfo: {
              name: "opengrove",
              title: "OpenGrove",
              version: "0.0.0",
            },
            clientCapabilities: {
              auth: { terminal: false },
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          },
          { timeoutMs: 30_000 },
        ),
      );
      this.acpImagePromptSupportedByClient.set(client, acpImagePromptCapability(initializeResult));
      return client;
    })();
    this.acpClientReadyByEnv.set(envKey, ready);
    try {
      return await ready;
    } catch (error) {
      if (this.acpClientsByEnv.get(envKey) === client) this.acpClientsByEnv.delete(envKey);
      this.acpSessionsByClient.delete(client);
      this.acpImagePromptSupportedByClient.delete(client);
      client.close();
      throw error;
    } finally {
      if (this.acpClientReadyByEnv.get(envKey) === ready) this.acpClientReadyByEnv.delete(envKey);
    }
  }

  private leaseAcpClientForRun(runId: string, client: StdioJsonRpcClient): void {
    this.acpClientByRun.set(runId, client);
    this.acpClientLeases.set(client, (this.acpClientLeases.get(client) ?? 0) + 1);
  }

  private releaseAcpClientForRun(runId: string): void {
    const client = this.acpClientByRun.get(runId);
    if (!client) return;
    this.acpClientByRun.delete(runId);
    const remaining = Math.max(0, (this.acpClientLeases.get(client) ?? 1) - 1);
    if (remaining > 0) {
      this.acpClientLeases.set(client, remaining);
      return;
    }
    this.acpClientLeases.delete(client);
    if (this.retiredAcpClients.delete(client)) client.close();
  }

  private poisonAcpClient(envKey: string, client: StdioJsonRpcClient): void {
    if (this.acpClientsByEnv.get(envKey) === client) this.acpClientsByEnv.delete(envKey);
    this.retiredAcpClients.add(client);
    if ((this.acpClientLeases.get(client) ?? 0) === 0) {
      this.retiredAcpClients.delete(client);
      client.close();
    }
  }

  private async ensureAcpSession(
    client: StdioJsonRpcClient,
    request: AgentTurnRequest,
    cwd: string,
    requestedModel: string | undefined,
    hostToolBinding: AcpHostToolSessionBinding | undefined,
  ): Promise<{ sessionId: string; resuming: boolean }> {
    const sessionBindingFingerprint = hostToolBinding
      ? `${this.options.runtimeBindingFingerprint || "native"}:host-tools:${hostToolBinding.fingerprint}`
      : this.options.runtimeBindingFingerprint;
    const remembered = readRememberedAcpSession(request, this.options.kernelId, sessionBindingFingerprint);
    const clientSessions = this.acpSessionsByClient.get(client) ?? new Set<string>();
    this.acpSessionsByClient.set(client, clientSessions);
    if (remembered?.sessionId) {
      if (clientSessions.has(remembered.sessionId)) {
        await this.maybeSetAcpSessionModel(client, remembered.sessionId, requestedModel, request.signal);
        return { sessionId: remembered.sessionId, resuming: true };
      }
      if (this.options.resumeSessions !== false) {
        const loaded = await this.loadAcpSession(client, remembered.sessionId, cwd, hostToolBinding, request.signal);
        if (loaded) {
          clientSessions.add(loaded);
          rememberAcpSession(request, this.options.kernelId, loaded, sessionBindingFingerprint);
          await this.maybeSetAcpSessionModel(client, loaded, requestedModel, request.signal);
          return { sessionId: loaded, resuming: true };
        }
      }
    }

    const created = asObject(
      await client.request(
        "session/new",
        {
          cwd,
          mcpServers: hostToolBinding ? [hostToolBinding.mcpServer] : [],
          ...(requestedModel ? { model: requestedModel } : {}),
        },
        { timeoutMs: this.options.controlRequestTimeoutMs ?? 30_000, signal: request.signal },
      ),
    );
    const sessionId = readString(created, "sessionId");
    if (!sessionId) {
      throw new Error(`${this.options.kernelId}_acp_session_id_missing`);
    }
    clientSessions.add(sessionId);
    rememberAcpSession(request, this.options.kernelId, sessionId, sessionBindingFingerprint);
    await this.maybeSetAcpSessionModel(client, sessionId, requestedModel, request.signal);
    return { sessionId, resuming: false };
  }

  private async loadAcpSession(
    client: StdioJsonRpcClient,
    sessionId: string,
    cwd: string,
    hostToolBinding: AcpHostToolSessionBinding | undefined,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const loaded = asObject(
        await client.request(
          "session/load",
          { sessionId, cwd, mcpServers: hostToolBinding ? [hostToolBinding.mcpServer] : [] },
          { timeoutMs: this.options.controlRequestTimeoutMs ?? 30_000, signal },
        ),
      );
      return readString(loaded, "sessionId") ?? sessionId;
    } catch (error) {
      if (isAbandonedAcpControlRequest(error, signal)) throw error;
      return undefined;
    }
  }

  private async maybeSetAcpSessionModel(
    client: StdioJsonRpcClient,
    sessionId: string,
    requestedModel: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!requestedModel) return;
    try {
      await client.request(
        "session/set_model",
        { sessionId, modelId: requestedModel },
        { timeoutMs: this.options.controlRequestTimeoutMs ?? 15_000, signal },
      );
    } catch (error) {
      if (isAbandonedAcpControlRequest(error, signal)) throw error;
      if (this.options.setModelFailure === "error") {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${this.options.title} could not switch to model ${JSON.stringify(requestedModel)}: ${message}`,
        );
      }
    }
  }

  private async handleAcpPermissionRequest(
    params: Record<string, unknown>,
    context: {
      request: AgentTurnRequest;
      runId: string;
      queue: AsyncEventQueue<AgentEvent>;
    },
  ): Promise<JsonObject> {
    const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
    const allowOption =
      options.find((option) => readString(option, "kind") === "allow_once") ??
      options.find((option) => readString(option, "kind") === "allow_always") ??
      options.find((option) => readString(option, "optionId")?.startsWith("allow")) ??
      options.find((option) => readString(option, "optionId")?.includes("approve"));
    const allowOptionId = allowOption ? readString(allowOption, "optionId") : undefined;
    const approval = createAcpApproval(
      this.options.kernelId,
      this.options.title,
      params,
      context.runId,
      context.request,
    );
    context.queue.push({ type: "approval.requested", runId: context.runId, request: approval });

    if (context.request.accessMode === "full-access" && allowOptionId) {
      const decided = context.request.context.approvals.decide(approval.id, "approved", {
        optionId: allowOptionId,
        autoApproved: true,
      });
      context.queue.push({ type: "approval.resolved", runId: context.runId, request: decided });
      return { outcome: { outcome: "selected", optionId: allowOptionId } };
    }

    let decided: ApprovalRequest | undefined;
    try {
      decided = await context.request.context.approvals.waitForDecision(approval.id, {
        timeoutMs: this.options.approvalTimeoutMs,
        signal: context.request.signal,
      });
    } catch (error) {
      const current = context.request.context.approvals.get(approval.id);
      decided =
        current?.status === "pending"
          ? context.request.context.approvals.decide(approval.id, "canceled", {
              system: true,
              reasonCode: context.request.signal?.aborted ? "run_canceled" : "native_request_failed",
              error: error instanceof Error ? error.message : String(error),
            })
          : current;
    }
    if (decided) {
      context.queue.push({ type: "approval.resolved", runId: context.runId, request: decided });
    }
    if (decided?.status === "approved" && allowOptionId) {
      return { outcome: { outcome: "selected", optionId: allowOptionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }
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

function normalizeAcpRuntimeEnv(kernelId: string, env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (kernelId !== "opencode" || !env) return env;
  if (env.OPENCODE_CONFIG_CONTENT || env.CLOUDFLARE_GATEWAY_ID) return env;
  if (!Object.keys(env).some((key) => key.startsWith("CLOUDFLARE_"))) return env;
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith("CLOUDFLARE_")) {
      next[key] = undefined;
    }
  }
  return next;
}

function envFingerprint(env: NodeJS.ProcessEnv | undefined): string {
  return Object.entries(env ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .filter(([key]) => !isVolatileOpenGroveRuntimeEnvKey(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function isVolatileOpenGroveRuntimeEnvKey(key: string): boolean {
  return key === "OPENGROVE_ROOM_LEDGER_CAPABILITY_JSON" || key === "OPENGROVE_SOURCE_ROOM_ID";
}

function translateAcpRuntimeError(message: string): string {
  return message;
}

function isAbandonedAcpControlRequest(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof JsonRpcRequestFailure && (error.kind === "timeout" || error.kind === "aborted"))
  );
}

function shouldPoisonAcpTransport(error: unknown, client: StdioJsonRpcClient): boolean {
  return (
    client.isClosed() ||
    (error instanceof JsonRpcRequestFailure &&
      (error.kind === "transport" || error.kind === "closed" || error.kind === "timeout"))
  );
}

function acpPolicyDiagnostic(
  kernelId: string,
  request: AgentTurnRequest,
  runtimeEnv: NodeJS.ProcessEnv | undefined,
): { name: string; data: JsonObject } | undefined {
  if (kernelId !== "opencode") return undefined;
  const permissionMode = summarizeOpenCodePermission(runtimeEnv?.OPENCODE_CONFIG_CONTENT);
  return {
    name: "opencode.policy.configured",
    data: {
      accessMode: request.accessMode ?? "default",
      policySurface: "opencode-permission",
      permissionMode,
    },
  };
}

function summarizeOpenCodePermission(configContent: string | undefined): string {
  const config = parseJsonObject(configContent);
  const permission = config.permission;
  if (permission === "allow" || permission === "ask" || permission === "deny") return permission;
  const permissionObject = asObject(permission);
  const wildcard = readString(permissionObject, "*");
  if (wildcard === "allow" || wildcard === "ask" || wildcard === "deny") return wildcard;
  return Object.keys(permissionObject).length ? "custom" : "unknown";
}

function parseJsonObject(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    return asObject(JSON.parse(input));
  } catch {
    return {};
  }
}

function readKimiCompactionResult(text: string): { tokensBefore: number; tokensAfter: number } | undefined {
  if (!/Compaction completed\./i.test(text)) return undefined;
  const before = /Tokens before:\s*([\d,]+)/i.exec(text)?.[1];
  const after = /Tokens after:\s*([\d,]+)/i.exec(text)?.[1];
  if (!before || !after) return undefined;
  const tokensBefore = Number(before.replaceAll(",", ""));
  const tokensAfter = Number(after.replaceAll(",", ""));
  if (!Number.isFinite(tokensBefore) || !Number.isFinite(tokensAfter)) return undefined;
  return { tokensBefore, tokensAfter };
}

// ACP ContentBlock::Image carries base64 data plus mimeType (docs/.../v2/content.mdx).
function acpImageBlocks(request: AgentTurnRequest): JsonObject[] {
  return imageAttachmentsWithDataUrl(request.context.page?.attachments).map(({ image }) => ({
    type: "image",
    mimeType: image.mediaType,
    data: image.base64,
  }));
}

function buildAcpPrompt(
  request: AgentTurnRequest,
  title: string,
  skillInvocationPromptPlacement: "user-request" | "prompt-prefix" | undefined,
): string {
  const hostContext = agentTurnHostContextPromptBlock(request);
  const threadHistory = recentSessionPromptBlock(request);
  const exactNativeSkillInvocation =
    skillInvocationPromptPlacement === "prompt-prefix" && request.requestedSkillInvocation;
  const skillHint = request.requestedSkillInvocation
    ? [
        `The user invoked OpenGrove skill /${request.requestedSkillInvocation.skillName}.`,
        `${title} should use its native skill mechanism when that skill is available there.`,
      ].join(" ")
    : "";
  const sections = [
    exactNativeSkillInvocation ? request.input : "",
    "You are running inside the OpenGrove host.",
    hostContext ? `Host context:\n${hostContext}` : "",
    threadHistory,
    skillHint,
    exactNativeSkillInvocation ? "" : `User request:\n${request.input}`,
    agentTurnReplyLanguageInstruction(request),
  ].filter(Boolean);
  return sections.join("\n\n");
}

function createAcpApproval(
  kernelId: string,
  title: string,
  params: Record<string, unknown>,
  runId: string,
  request: AgentTurnRequest,
): ApprovalRequest {
  const toolCall = asObject(params.toolCall);
  const kind = readString(toolCall, "kind") === "execute" ? "command" : "tool";
  const toolTitle = readString(toolCall, "title") || readString(toolCall, "name") || `${title} permission request`;
  return request.context.approvals.request({
    kind,
    title: toolTitle,
    reason: `${title} ACP requested permission for ${toolTitle}.`,
    toolId: defaultAcpToolId(kernelId, toolCall),
    input: toJsonValue(params),
    resume: { type: "tool", runId },
  });
}

function readRememberedAcpSession(
  request: AgentTurnRequest,
  kernelId: string,
  runtimeBindingFingerprint: string | undefined,
): { sessionId: string } | undefined {
  const current = request.context.sessions.get(request.context.sessionId);
  const fingerprint = runtimeBindingFingerprint || "native";
  const key = `${kernelId}:${fingerprint}`;
  const sessions = asObject(current?.metadata?.acpSessionIds);
  const sessionId = readRememberedAcpSessionId(sessions, key);
  return sessionId ? { sessionId } : undefined;
}

function readRememberedAcpSessionFromCompactRequest(
  request: AgentCompactRequest,
  kernelId: string,
  runtimeBindingFingerprint: string | undefined,
): { sessionId: string } | undefined {
  const metadata = asObject(request.metadata);
  const sessionMetadata = asObject(metadata.sessionMetadata);
  const fingerprint = runtimeBindingFingerprint || "native";
  const key = `${kernelId}:${fingerprint}`;
  const sessions = asObject(sessionMetadata.acpSessionIds);
  const sessionId = readRememberedAcpSessionId(sessions, key);
  return sessionId ? { sessionId } : undefined;
}

function readRememberedAcpSessionId(sessions: Record<string, unknown>, key: string): string | undefined {
  const exactSessionId = readString(sessions, key);
  if (exactSessionId) return exactSessionId;
  const scopedPrefix = `${key}:host-tools:`;
  const scopedSessionIds = new Set(
    Object.entries(sessions)
      .filter(([entryKey]) => entryKey.startsWith(scopedPrefix))
      .map(([, value]) => (typeof value === "string" ? value : ""))
      .filter(Boolean),
  );
  return scopedSessionIds.size === 1 ? scopedSessionIds.values().next().value : undefined;
}

function rememberAcpSession(
  request: AgentTurnRequest,
  kernelId: string,
  nativeSessionId: string,
  runtimeBindingFingerprint: string | undefined,
): void {
  const current = request.context.sessions.get(request.context.sessionId);
  const fingerprint = runtimeBindingFingerprint || "native";
  const key = `${kernelId}:${fingerprint}`;
  const currentSessionIds = asObject(current?.metadata?.acpSessionIds);
  const acpSessionIds: JsonObject = {};
  for (const [entryKey, value] of Object.entries(currentSessionIds)) {
    if (typeof value === "string") {
      acpSessionIds[entryKey] = value;
    }
  }
  acpSessionIds[key] = nativeSessionId;
  const metadata: JsonObject = {
    ...(current?.metadata ?? {}),
    acpSessionIds,
    acpSessionUpdatedAt: new Date().toISOString(),
  };
  request.context.sessions.ensureSession({
    id: request.context.sessionId,
    activity: request.context.activity,
    metadata,
  });
}

type OpenCodeSummarizeModel = { providerID: string; modelID: string };

type OpenCodeServerProcess = {
  url: string;
  close(): Promise<void>;
};

function openCodeSummarizeModel(
  model: string | undefined,
  runtimeEnv: NodeJS.ProcessEnv | undefined,
): OpenCodeSummarizeModel | undefined {
  const configuredModel =
    normalizeOptionalString(model) ?? readString(parseJsonObject(runtimeEnv?.OPENCODE_CONFIG_CONTENT), "model");
  if (!configuredModel) return undefined;
  const separator = configuredModel.indexOf("/");
  if (separator <= 0 || separator >= configuredModel.length - 1) return undefined;
  return {
    providerID: configuredModel.slice(0, separator),
    modelID: configuredModel.slice(separator + 1),
  };
}

async function readOpenCodeDefaultSummarizeModel(
  serverUrl: string,
  signal?: AbortSignal,
): Promise<OpenCodeSummarizeModel | undefined> {
  const response = await fetch(`${serverUrl}/config/providers`, { signal });
  if (!response.ok) return undefined;
  const payload = asObject(await response.json().catch(() => undefined));
  const defaults = asObject(payload.default);
  for (const [providerID, modelID] of Object.entries(defaults)) {
    if (typeof modelID === "string" && providerID.trim() && modelID.trim()) {
      return { providerID, modelID };
    }
  }
  return undefined;
}

async function startOpenCodeServer(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
}): Promise<OpenCodeServerProcess> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(input.env ?? {}), PWD: input.cwd };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const invocation = resolveCommandInvocation(input.command, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  const url = await waitForOpenCodeServerUrl(child);
  return {
    url,
    close: () => closeOpenCodeServer(child),
  };
}

function waitForOpenCodeServerUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let settled = false;
    let output = "";
    const timeout = setTimeout(
      () => finish(undefined, new Error(`opencode_serve_timeout:${output.slice(0, 240)}`)),
      30_000,
    );
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/) ?? output.match(/http:\/\/localhost:(\d+)/);
      if (match?.[1]) {
        finish(`http://127.0.0.1:${match[1]}`);
      }
    };
    const onError = (error: Error) => finish(undefined, error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(undefined, new Error(`opencode_serve_exited:${code ?? signal ?? "unknown"}:${output.slice(0, 240)}`));
    };
    const finish = (url?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (url) resolveUrl(url);
      else reject(error ?? new Error("opencode_serve_failed"));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function closeOpenCodeServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveClose) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      resolveClose();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveClose();
    });
  });
}

function parseBooleanJson(text: string): boolean | undefined {
  try {
    const value = JSON.parse(text);
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function acpImagePromptCapability(initializeResult: Record<string, unknown>): boolean {
  const promptCapabilities = asObject(asObject(initializeResult.agentCapabilities).promptCapabilities);
  return promptCapabilities.image === true || isRecord(promptCapabilities.image);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
