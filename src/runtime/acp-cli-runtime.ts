import { assertRuntimeAccessMode } from "../runtime-access.js";
import { resolve } from "node:path";
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
import { agentTurnHostContextPromptBlock } from "../core.js";
import { AsyncEventQueue } from "./codex/async-event-queue.js";
import {
  AcpSessionProjector,
  defaultAcpToolId,
  readAcpContextUsage,
  readAcpUsage,
  toJsonValue,
} from "./projectors/acp.js";
import { StdioJsonRpcClient } from "./stdio-json-rpc-client.js";
import { AcpAgent, compactKimi, compactOpenCode } from "@open-grove/agent-host/acp";
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
  private readonly agentsByEnv = new Map<string, AcpAgent>();
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
    for (const agent of this.agentsByEnv.values()) void agent.close();
    this.agentsByEnv.clear();
    this.acpClientsByEnv.clear();
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

    return compactOpenCode({
      command: this.options.command,
      cwd: this.options.cwd,
      env: normalizeAcpRuntimeEnv(this.options.kernelId, mergeRuntimeEnv(this.options.env, undefined)),
      sessionId: nativeSessionId,
      model: this.opencodeModelByThread.get(request.threadId) ?? this.options.configuredModel,
      signal: request.signal,
    });
  }

  private async compactKimiSession(
    client: StdioJsonRpcClient,
    nativeSessionId: string,
    signal?: AbortSignal,
  ): Promise<AgentCompactResult> {
    const result = await compactKimi({
      client,
      sessionId: nativeSessionId,
      beforeUsed:
        this.contextUsageBySession.get(nativeSessionId)?.used ?? this.estimatedTokensBySession.get(nativeSessionId),
      timeoutMs: this.options.requestTimeoutMs,
      signal,
    });
    if (result.usage) {
      this.contextUsageBySession.set(nativeSessionId, {
        ...this.contextUsageBySession.get(nativeSessionId),
        ...result.usage,
      });
      if (result.usage.used !== undefined) this.estimatedTokensBySession.set(nativeSessionId, result.usage.used);
    }
    return {
      ok: result.ok,
      compacted: result.compacted,
      ...(result.error ? { error: result.error } : {}),
      ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}),
    };
  }

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    assertRuntimeAccessMode(this.options.kernelId, request.accessMode);
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
          message:
            error instanceof AcpHostToolBridgeUnavailableError
              ? `OpenGrove could not connect its tools. Restart OpenGrove and allow 127.0.0.1 connections. (${error.code})`
              : translateAcpRuntimeError(message),
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
      // Agent Host owns transport cancellation and leases.
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
    const controller = new AbortController();
    const sourceSignal = request.signal;
    const abort = () => controller.abort(sourceSignal?.reason);
    sourceSignal?.addEventListener("abort", abort, { once: true });
    if (sourceSignal?.aborted) abort();
    request = { ...request, signal: controller.signal };
    try {
      const requestedModel =
        normalizeOptionalString(request.requestedModelId) ?? normalizeOptionalString(this.options.configuredModel);
      const runtimeEnv = normalizeAcpRuntimeEnv(
        this.options.kernelId,
        mergeRuntimeEnv(this.options.env, request.runtimeEnv),
      );
      const prompt = buildAcpPrompt(request, this.options.title, this.options.skillInvocationPromptPlacement);
      const envKey = envFingerprint(runtimeEnv);
      let agent = this.agentsByEnv.get(envKey);
      if (!agent) {
        agent = new AcpAgent({
          command: this.options.command,
          args: [...(this.options.commandArgs ?? []), ...(this.options.acpArgs ?? ["acp"])],
          cwd: resolve(this.options.cwd ?? process.cwd()),
          env: { ...process.env, ...runtimeEnv, PWD: resolve(this.options.cwd ?? process.cwd()) },
          clientInfo: { name: "opengrove", title: "OpenGrove", version: "0.0.0" },
          elicitation: { form: {} },
          requestTimeoutMs: this.options.requestTimeoutMs,
          controlRequestTimeoutMs: this.options.controlRequestTimeoutMs,
          cancellationGraceMs: this.options.cancelGraceMs,
          promptPayload: this.options.promptPayload,
          resumeSessions: this.options.resumeSessions,
          setModelFailure: this.options.setModelFailure ?? "ignore",
        });
        this.agentsByEnv.set(envKey, agent);
      }
      const client = await agent.connect();
      this.acpClientsByEnv.set(envKey, client);
      const hostTools = request.tools.length
        ? createHostToolBridge(request, runId, queue, this.options.kernelId)
        : undefined;
      const hostToolBinding = hostTools
        ? await this.hostToolBridgeServer.prepare({
            scope: request.hostToolScope ?? { sessionId: request.context.sessionId },
            bridge: hostTools,
          })
        : undefined;
      const fingerprint = hostToolBinding
        ? `${this.options.runtimeBindingFingerprint || "native"}:host-tools:${hostToolBinding.fingerprint}`
        : this.options.runtimeBindingFingerprint || "native";
      const priorMessages = recentSessionMessages(request);
      let assistantText = "";
      let nativeSessionId = "";
      let usage: ReturnType<typeof readAcpUsage>;
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
      const imageBlocks =
        asObject(agent.getCapabilities(client).promptCapabilities).image === true ? acpImageBlocks(request) : [];
      if (imageBlocks.length)
        queue.push({
          type: "runtime.diagnostic",
          runId,
          at: new Date().toISOString(),
          name: `${this.options.kernelId}.media_input.configured`,
          data: { imageInputs: imageBlocks.length },
        });
      try {
        hostToolBinding?.activate(hostTools!);
        for await (const event of agent.run({
          sessionId: request.context.sessionId,
          runId,
          cwd: resolve(this.options.cwd ?? process.cwd()),
          instructions: "",
          input: [{ type: "text", text: prompt }, ...imageBlocks],
          model: requestedModel,
          signal: request.signal,
          bindingFingerprint: fingerprint,
          mcpServers: hostToolBinding ? [hostToolBinding.mcpServer] : [],
          bindings: {
            get: async () => {
              const stored = readRememberedAcpSession(request, this.options.kernelId, fingerprint);
              return stored ? { threadId: stored.sessionId, fingerprint } : undefined;
            },
            set: async (_id, binding) =>
              rememberAcpSession(request, this.options.kernelId, binding.threadId, fingerprint),
          },
          onRequest: async (rpc, context) => {
            if (rpc.method === "elicitation/create")
              return this.handleAcpElicitation(asObject(rpc.params), request, runId, queue, context.signal);
            if (rpc.method !== "session/request_permission" && rpc.method !== "session/requestPermission")
              return undefined;
            return this.handleAcpPermissionRequest(asObject(rpc.params), { request, runId, queue });
          },
          beforeTurn: async (client, context) => {
            nativeSessionId = context.threadId;
            this.acpSessionByThread.set(request.context.sessionId, nativeSessionId);
            this.acpEnvKeyByThread.set(request.context.sessionId, envKey);
            if (requestedModel && this.options.kernelId === "opencode")
              this.opencodeModelByThread.set(request.context.sessionId, requestedModel);
            if (request.assembledContext)
              queue.push({ type: "context.assembled", runId, context: request.assembledContext });
            await this.prepareContextBudget({
              client,
              nativeSessionId,
              threadId: request.context.sessionId,
              request,
              queue,
              runId,
              priorMessages,
              incomingTokens: estimateTextTokens(prompt),
            });
            const policyDiagnostic = acpPolicyDiagnostic(this.options.kernelId, request, runtimeEnv);
            if (policyDiagnostic)
              queue.push({ type: "runtime.diagnostic", runId, at: new Date().toISOString(), ...policyDiagnostic });
            queue.push({
              type: "runtime.diagnostic",
              runId,
              at: new Date().toISOString(),
              name: `${this.options.kernelId}.acp.session`,
              data: {
                sessionId: nativeSessionId,
                resuming: context.resumed,
                hostInstructionsChannel: "user-input",
                hostStateDelivery: "full-per-host-turn",
                hostCompactionRecovery: "next-host-turn",
                hostToolMcpServers: hostToolBinding ? 1 : 0,
                hostToolIds: hostTools?.exposedToolIds ?? [],
              },
            });
            const session: AgentSessionTrace = {
              provider: this.options.kernelId,
              sessionId: nativeSessionId,
              persistent: true,
              priorMessageCount: context.resumed ? priorMessages.length : 0,
              priorMessages: context.resumed ? priorMessages : [],
            };
            queue.push({
              type: "model.requested",
              runId,
              request: {
                systemPrompt: `${this.options.title} ACP mode. OpenGrove host context is prepended to the user prompt when present.`,
                userInput: request.input,
                modelId: requestedModel,
                session,
                context: request.assembledContext,
                tools: request.tools.map((tool) => tool.spec),
                skills: request.skills ?? [],
                packs: request.packs ?? [],
                capabilities: request.capabilities ?? [],
              },
            });
          },
        })) {
          if (event.type === "native.notification") {
            if (event.notification.method !== "session/update" && event.notification.method !== "session/notification")
              continue;
            const update = asObject(asObject(event.notification.params).update);
            const contextUsage = readAcpContextUsage(update);
            if (contextUsage) this.contextUsageBySession.set(event.threadId, contextUsage);
            for (const projected of projector.project(update)) queue.push(projected);
          } else if (event.type === "native.response") usage = readAcpUsage(toJsonValue(event.response));
          else if (event.type === "model.response") {
            for (const projected of projector.flushReasoning()) queue.push(projected);
            if (assistantText.trim())
              queue.push({
                type: "model.response",
                runId,
                response: { text: assistantText.trimEnd(), ...(usage ? { usage } : {}) },
              });
            const previous = this.estimatedTokensBySession.get(nativeSessionId) ?? 0;
            this.estimatedTokensBySession.set(
              nativeSessionId,
              previous + estimateTextTokens(prompt) + estimateTextTokens(assistantText) + 16,
            );
          } else if (event.type === "turn.finished") {
            let outcome = event.outcome;
            if (outcome.status === "completed" && !assistantText.trim())
              outcome = {
                status: "failed",
                error: client.stderr().trim() || `${this.options.kernelId}_empty_response`,
              };
            if (outcome.status === "failed")
              queue.push({ type: "error", runId, message: outcome.error ?? "acp_failed" });
            queue.push({
              type: "turn.finished",
              runId,
              at: new Date().toISOString(),
              outcome: {
                taskState:
                  outcome.status === "completed"
                    ? "TASK_STATE_COMPLETED"
                    : outcome.status === "cancelled"
                      ? "TASK_STATE_CANCELED"
                      : "TASK_STATE_FAILED",
                ...(outcome.error ? { reasonCode: outcome.error } : {}),
                ...(outcome.outcomeUnknown ? { outcomeUnknown: true } : {}),
              },
            });
          }
        }
      } finally {
        if (hostTools) hostToolBinding?.deactivate(hostTools);
      }
    } finally {
      sourceSignal?.removeEventListener("abort", abort);
      controller.abort();
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

  private async handleAcpElicitation(
    params: Record<string, unknown>,
    request: AgentTurnRequest,
    runId: string,
    queue: AsyncEventQueue<AgentEvent>,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    if (params.mode !== "form") return { action: "decline" };
    const question = request.context.questions.request({
      title: `${this.options.title} asks for input`,
      prompt: readString(params, "message") ?? "Please provide the requested information.",
      input: toJsonValue(params),
      source: { type: "kernel.native", kernelId: this.options.kernelId },
      resume: { type: "kernel.native", kernelId: this.options.kernelId, runId, continuation: "same-loop" },
    });
    queue.push({ type: "question.requested", runId, question });
    let decided;
    try {
      decided = await request.context.questions.waitForDecision(question.id, { signal });
    } catch (error) {
      const current = request.context.questions.get(question.id);
      if (current?.status !== "pending") {
        if (!current) throw error;
        decided = current;
      } else
        decided = request.context.questions.decide(question.id, "canceled", {
          system: true,
          reasonCode: signal.aborted ? "run_canceled" : "native_request_failed",
        });
    }
    queue.push({ type: "question.answered", runId, question: decided });
    if (decided.status !== "answered") return { action: decided.status === "canceled" ? "cancel" : "decline" };
    const response = asObject(decided.response);
    const content = response.content ?? response.answers ?? response;
    return { action: "accept", content: toJsonValue(content) };
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

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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
