import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  query as claudeQuery,
  type EffortLevel,
  type Options as ClaudeAgentSdkOptions,
  type PermissionMode as ClaudePermissionMode,
  type Query as ClaudeAgentQuery,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { APP_PRODUCT_NAME } from "../identity.js";
import type {
  AgentCompactRequest,
  AgentCompactResult,
  AgentEvent,
  AgentRuntime,
  AgentSessionTrace,
  AgentTurnRequest,
  JsonObject,
  JsonValue,
  RuntimeAccessMode,
  RuntimeErrorDiagnostics,
  ToolResult,
  UsageStats,
} from "../core.js";
import { agentTurnHostContextPromptBlock, agentTurnReplyLanguageInstruction } from "../core.js";
import { AsyncEventQueue } from "./codex/async-event-queue.js";
import { asJsonValue, isJsonObject, readString } from "./codex/json.js";
import { createClaudeSdkHostBridge, type ClaudeSdkHostBridge } from "./claude-agent-sdk-tools.js";
import { resolveRuntimeRunId } from "./run-id.js";
import {
  applyClaudeBedrockHelperEnv,
  applyClaudeHostManagedProviderEnv,
  hasAwsCredential,
  isClaudeProviderManagedByHost,
} from "./claude-bedrock-env.js";
import { writeClaudeModelsCache } from "./claude-models-cache.js";
import { normalizeClaudeRuntimeModelId, resolveClaudeRuntimeModel } from "./claude-model-normalize.js";
import type { ClaudeCodeRuntimeOptions } from "./claude-code-runtime.js";
import { runWithNativeSessionLock } from "./native-session-lock.js";
import { imageAttachmentsWithDataUrl } from "./media-input.js";
import { contextBudgetDiagnostic, resolveContextTokenBudget } from "./context-token-budget.js";
import {
  claudePlanningEventsForToolFinished,
  claudePlanningEventsForToolStarted,
  createClaudePlanningState,
  type ClaudePlanningState,
} from "./claude-planning.js";

export type ClaudeAgentSdkQueryFunction = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: ClaudeAgentSdkOptions;
}) => ClaudeAgentQuery;

export interface ClaudeAgentSdkRuntimeOptions extends Omit<ClaudeCodeRuntimeOptions, "cliPath"> {
  cliPath?: string;
  query?: ClaudeAgentSdkQueryFunction;
}

interface ClaudeSdkMessageState {
  assistantText: string;
  resultText: string;
  resultIsError: boolean;
  stderrText: string;
  compactionActive: boolean;
  compactionCompletionPending: boolean;
  compactionOccurred: boolean;
  usage?: UsageStats;
  toolCalls: Map<string, { toolId: string; toolName: string; input: JsonValue }>;
  planningState: ClaudePlanningState;
  reasoningText: string;
  reasoningCallSequence: number;
  currentStreamMessage?: ClaudeStreamMessageBuffer;
  flushedStreamMessageKeys: Set<string>;
  streamMessageSeq: number;
  runtimeModelId?: string;
  runtimeVersion?: string;
  upstreamRequestId?: string;
  providerMessageIds: string[];
}

interface ClaudeStreamMessageBuffer {
  key: string;
  textByBlockIndex: Map<number, string>;
  blockTypesByIndex: Map<number, string>;
  toolUseBlockIndexes: number[];
  stopReason?: string;
}

interface ClaudeRuntimeSessionBinding {
  nativeSessionId: string;
  cwd: string;
  requestedModel?: string;
  permissionMode: ClaudePermissionMode;
  runtimeEnv?: NodeJS.ProcessEnv;
}

interface ClaudeMcpServerSummary {
  name: string;
  status: string;
}

export class ClaudeAgentSdkRuntime implements AgentRuntime {
  private readonly sessionBindings = new Map<string, ClaudeRuntimeSessionBinding>();
  private readonly observedContextWindowByModel = new Map<string, number>();

  constructor(private readonly options: ClaudeAgentSdkRuntimeOptions) {}

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();
    const abortController = new AbortController();
    const forwardAbort = () => abortController.abort(request.signal?.reason);
    if (request.signal) {
      if (request.signal.aborted) {
        abortController.abort(request.signal.reason);
      } else {
        request.signal.addEventListener("abort", forwardAbort, { once: true });
      }
    }

    const producer = this.produceTurn(request, queue, abortController)
      .then(() => queue.close())
      .catch((error) => queue.fail(error));

    try {
      for await (const event of queue) {
        yield event;
      }
      await producer;
    } finally {
      request.signal?.removeEventListener("abort", forwardAbort);
      abortController.abort();
    }
  }

  private async produceTurn(
    request: AgentTurnRequest,
    queue: AsyncEventQueue<AgentEvent>,
    abortController: AbortController,
  ): Promise<void> {
    const runId = resolveRuntimeRunId(request.runId);
    const requestedModel = resolveClaudeRuntimeModel(
      request.requestedModelId,
      this.options.configuredModel,
      this.options.modelAliases,
    );
    const cwd = this.options.cwd ?? process.cwd();
    const permissionMode = resolveClaudePermissionMode(request.accessMode, this.options.permissionMode);
    const runtimeEnv = mergeRuntimeEnv(this.options.env, request.runtimeEnv);
    const runtimeBindingFingerprint = claudeRuntimeBindingFingerprint({
      base: this.options.runtimeBindingFingerprint,
      cwd,
      skillScope: normalizeClaudeSkillNames(request),
    });
    const nativeSession = resolveClaudeNativeSession(request, runtimeBindingFingerprint, {
      configDir: this.options.env?.CLAUDE_CONFIG_DIR,
      cwd,
    });
    rememberClaudeNativeSession(request, nativeSession.sessionId, runtimeBindingFingerprint);
    this.rememberSessionBinding(request.context.sessionId, {
      nativeSessionId: nativeSession.sessionId,
      cwd,
      requestedModel,
      permissionMode,
      runtimeEnv,
    });
    const systemPrompt = buildClaudeSdkSystemPrompt(request);
    const budgetLimitUsd = normalizeClaudeBudgetLimitUsd(request.budgetLimitUsd);
    const modelWindowKey = requestedModel ?? "__claude_default__";
    const contextBudget = resolveContextTokenBudget(
      request.contextTokenBudget,
      this.observedContextWindowByModel.get(modelWindowKey),
    );
    const preparedEnv = this.prepareEnv(requestedModel, runtimeEnv);
    const settingSources = this.settingSources();
    if (contextBudget.budgetSource === "configured" && contextBudget.effectiveBudget !== undefined) {
      preparedEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextBudget.effectiveBudget);
    }
    const hostBridge = createClaudeSdkHostBridge(request, runId, queue);
    const sessionTrace: AgentSessionTrace = {
      provider: "claude-code",
      sessionId: nativeSession.sessionId,
      persistent: true,
      priorMessageCount: nativeSession.resuming ? 1 : 0,
      priorMessages: [],
    };

    queue.push({ type: "turn.started", runId, at: new Date().toISOString() });
    if (request.assembledContext) {
      queue.push({ type: "context.assembled", runId, context: request.assembledContext });
    }
    queue.push(
      contextBudgetDiagnostic({
        runId,
        kernel: "claude-code",
        ...contextBudget,
        usageSource: "native",
        enforcementMode: "native-auto",
        reason:
          contextBudget.budgetSource === "configured"
            ? "CLAUDE_CODE_AUTO_COMPACT_WINDOW"
            : "employee/App budget unconfigured; preserving Claude Agent native default",
      }),
    );
    queue.push({
      type: "runtime.diagnostic",
      runId,
      at: new Date().toISOString(),
      name: "claude.env.configured",
      data: claudeEnvironmentSummary(preparedEnv, this.options.cliPath),
    });
    queue.push({
      type: "runtime.diagnostic",
      runId,
      at: new Date().toISOString(),
      name: "claude.policy.configured",
      data: {
        accessMode: request.accessMode ?? "unspecified",
        permissionMode,
        policySurface: "claude-permission-mode",
      },
    });
    queue.push({
      type: "runtime.diagnostic",
      runId,
      at: new Date().toISOString(),
      name: "claude.sdk.query.configured",
      data: {
        nativeSessionId: nativeSession.sessionId,
        sessionMode: nativeSession.resuming ? "resume" : "new",
        resume: nativeSession.resuming,
        cwd,
        settingSources,
        includePartialMessages: true,
        includeHookEvents: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          appendLength: systemPrompt.length,
          appendSha256: createHash("sha256").update(systemPrompt).digest("hex"),
        },
        model: requestedModel ?? "",
        effort: normalizeClaudeEffort(request.requestedEffort) ?? "",
        skills: request.requestedSkillInvocation?.skillName
          ? [request.requestedSkillInvocation.skillName]
          : normalizeClaudeSkillNames(request),
        permissionMode,
      },
    });
    queue.push({
      type: "runtime.diagnostic",
      runId,
      at: new Date().toISOString(),
      name: "claude.host_tools.configured",
      data: {
        runtimeMode: "sdk",
        available: true,
        transport: "opengrove-mcp",
      },
    });
    if (budgetLimitUsd !== undefined) {
      queue.push({
        type: "runtime.diagnostic",
        runId,
        at: new Date().toISOString(),
        name: "claude.budget.configured",
        data: {
          maxBudgetUsd: budgetLimitUsd,
          policySurface: "claude-max-budget-usd",
        },
      });
    }
    const imageBlocks = buildClaudeImageBlocks(request);
    if (imageBlocks.length) {
      queue.push({
        type: "runtime.diagnostic",
        runId,
        at: new Date().toISOString(),
        name: "claude.media_input.configured",
        data: { imageInputs: imageBlocks.length },
      });
    }

    queue.push({
      type: "model.requested",
      runId,
      request: {
        systemPrompt,
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

    const messageState: ClaudeSdkMessageState = {
      assistantText: "",
      resultText: "",
      resultIsError: false,
      stderrText: "",
      compactionActive: false,
      compactionCompletionPending: false,
      compactionOccurred: false,
      usage: undefined,
      toolCalls: new Map(),
      planningState: createClaudePlanningState(),
      reasoningText: "",
      reasoningCallSequence: 0,
      currentStreamMessage: undefined,
      flushedStreamMessageKeys: new Set(),
      streamMessageSeq: 0,
      runtimeModelId: undefined,
      runtimeVersion: undefined,
      upstreamRequestId: undefined,
      providerMessageIds: [],
    };
    let currentContextUsage: SDKControlGetContextUsageResponse | undefined;
    let contextUsageRequested = false;
    try {
      await runWithNativeSessionLock("claude-code", nativeSession.sessionId, async () => {
        const query = (this.options.query ?? claudeQuery)({
          prompt: imageBlocks.length
            ? claudeUserMessageStream(request.input, imageBlocks, nativeSession.sessionId)
            : request.input,
          options: this.createQueryOptions({
            request,
            cwd,
            requestedModel,
            permissionMode,
            nativeSession,
            systemPrompt,
            preparedEnv,
            hostBridge,
            settingSources,
            abortController,
            onStderr: (chunk) => {
              messageState.stderrText = limitDiagnosticText(messageState.stderrText + chunk);
            },
          }),
        });

        this.refreshClaudeModelsCache(query, runtimeEnv);

        try {
          for await (const message of query) {
            for (const event of mapClaudeSdkMessage(message, {
              runId,
              state: messageState,
              hostBridge,
              onInit: (init) => {
                rememberClaudeNativeSession(request, init.session_id, runtimeBindingFingerprint);
                this.rememberSessionBinding(request.context.sessionId, {
                  nativeSessionId: init.session_id,
                  cwd,
                  requestedModel: requestedModel || init.model,
                  permissionMode,
                  runtimeEnv,
                });
                recordClaudeRuntimeInventory(request, init);
              },
            })) {
              queue.push(event);
            }
            if (message.type === "result" && !contextUsageRequested) {
              contextUsageRequested = true;
              currentContextUsage = await readClaudeCurrentContextUsage(query);
            }
          }
          if (!contextUsageRequested && !request.signal?.aborted && !abortController.signal.aborted) {
            currentContextUsage = await readClaudeCurrentContextUsage(query);
          }
        } finally {
          query.close();
        }
      });
    } catch (error) {
      const diagnostics = claudeRuntimeErrorDiagnostics(messageState, error);
      queue.push({
        type: "error",
        runId,
        message: claudeSdkProcessErrorMessage(error, messageState.stderrText),
        ...(diagnostics ? { diagnostics } : {}),
      });
      const canceled = Boolean(request.signal?.aborted || abortController.signal.aborted);
      queue.push({
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: {
          taskState: canceled ? "TASK_STATE_CANCELED" : "TASK_STATE_FAILED",
          reasonCode: canceled ? "native_cancelled" : "claude_native_terminal_missing",
          outcomeUnknown: true,
        },
      });
      return;
    }

    const finalText = messageState.resultText || messageState.assistantText;
    // getContextUsage.maxTokens is the session's current usable window after
    // auto-compaction policy. It is the right denominator for the occupancy
    // ring, but must never become the hard model limit used to configure the
    // next turn or the policy feeds back into itself and ratchets downward.
    const modelContextWindow =
      positiveNumber(currentContextUsage?.rawMaxTokens) ?? positiveNumber(messageState.usage?.contextWindowSize);
    messageState.usage = withClaudeCurrentContextUsage(messageState.usage, currentContextUsage);
    if (messageState.compactionActive) {
      queue.push({
        type: "compaction.finished",
        runId,
        at: new Date().toISOString(),
        summary: "Claude Agent compaction finished.",
      });
    }
    if (messageState.resultIsError) {
      const diagnostics = claudeRuntimeErrorDiagnostics(messageState);
      queue.push({
        type: "error",
        runId,
        message: finalText || "claude_agent_sdk_failed",
        ...(diagnostics ? { diagnostics } : {}),
      });
    } else {
      queue.push({
        type: "model.response",
        runId,
        response: { text: finalText, ...(messageState.usage ? { usage: messageState.usage } : {}) },
      });
    }
    const finalContextBudget = resolveContextTokenBudget(request.contextTokenBudget, modelContextWindow);
    if (modelContextWindow !== undefined) {
      this.observedContextWindowByModel.set(modelWindowKey, modelContextWindow);
    }
    queue.push(
      contextBudgetDiagnostic({
        runId,
        kernel: "claude-code",
        ...finalContextBudget,
        usageSource: messageState.usage?.contextUsedTokens !== undefined ? "native" : "unavailable",
        enforcementMode: "native-auto",
        contextUsedTokens: messageState.usage?.contextUsedTokens,
        compactionTriggered: messageState.compactionOccurred,
        compactionSucceeded: messageState.compactionOccurred && !messageState.compactionActive,
        reason: "turn-final",
      }),
    );
    queue.push({
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: messageState.resultIsError
        ? { taskState: "TASK_STATE_FAILED", reasonCode: "claude_agent_sdk_failed" }
        : request.signal?.aborted
          ? { taskState: "TASK_STATE_CANCELED", reasonCode: "native_cancelled", retryable: false }
          : { taskState: "TASK_STATE_COMPLETED" },
    });
  }

  async compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    const binding = this.sessionBindings.get(request.threadId);
    if (!binding) {
      return { ok: false, compacted: false, error: "session_not_found" };
    }

    const abortController = new AbortController();
    const state = { started: false, finished: false, error: "" };
    const query = (this.options.query ?? claudeQuery)({
      prompt: "/compact",
      options: {
        abortController,
        cwd: binding.cwd,
        env: this.prepareEnv(binding.requestedModel, binding.runtimeEnv),
        includePartialMessages: true,
        includeHookEvents: true,
        // OpenGrove has no renderer for native Claude dialogs. An explicit empty
        // declaration also clears any renderer capability restored with the worker.
        supportedDialogKinds: [],
        settingSources: this.settingSources(),
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: binding.permissionMode,
        model: binding.requestedModel,
        pathToClaudeCodeExecutable: this.options.cliPath,
        resume: binding.nativeSessionId,
        stderr: (chunk) => {
          state.error = limitDiagnosticText(state.error + chunk);
        },
      },
    });

    try {
      await runWithNativeSessionLock("claude-code", binding.nativeSessionId, async () => {
        try {
          for await (const message of query) {
            const outcome = readClaudeCompactionOutcome(message);
            if (outcome.started) state.started = true;
            if (outcome.finished) state.finished = true;
            if (outcome.error) state.error = outcome.error;
          }
        } finally {
          query.close();
        }
      });
    } catch (error) {
      return {
        ok: false,
        compacted: false,
        error: claudeSdkProcessErrorMessage(error, state.error),
      };
    } finally {
      abortController.abort();
    }

    if (state.finished) {
      return { ok: true, compacted: true };
    }
    return {
      ok: false,
      compacted: false,
      error: state.error || (state.started ? "compact_started_without_boundary" : "compact_boundary_not_observed"),
    };
  }

  private rememberSessionBinding(threadId: string, binding: ClaudeRuntimeSessionBinding): void {
    this.sessionBindings.set(threadId, binding);
  }

  // Best-effort: ask the live SDK which models + effort levels are available and persist
  // them so the (synchronous) bridge can advertise per-model reasoning effort in the
  // composer. Never awaited and never throws into the turn — failures leave the bridge on
  // its static effort fallback.
  private refreshClaudeModelsCache(query: ClaudeAgentQuery, runtimeEnv: NodeJS.ProcessEnv | undefined): void {
    if (typeof query.supportedModels !== "function") {
      return;
    }
    const configHome = runtimeEnv?.CLAUDE_CONFIG_DIR ?? this.options.env?.CLAUDE_CONFIG_DIR ?? undefined;
    void Promise.resolve()
      .then(() => query.supportedModels())
      .then((models) => {
        if (Array.isArray(models) && models.length) {
          writeClaudeModelsCache(models, { configHome, now: new Date().toISOString() });
        }
      })
      .catch(() => {
        // Ignore — supportedModels() is optional and must never disrupt a turn.
      });
  }

  private createQueryOptions(input: {
    request: AgentTurnRequest;
    cwd: string;
    requestedModel?: string;
    permissionMode: ClaudePermissionMode;
    nativeSession: { sessionId: string; resuming: boolean };
    systemPrompt: string;
    preparedEnv: NodeJS.ProcessEnv;
    hostBridge: ClaudeSdkHostBridge;
    settingSources: NonNullable<ClaudeAgentSdkOptions["settingSources"]>;
    abortController: AbortController;
    onStderr(data: string): void;
  }): ClaudeAgentSdkOptions {
    const options: ClaudeAgentSdkOptions = {
      abortController: input.abortController,
      cwd: input.cwd,
      env: input.preparedEnv,
      includePartialMessages: true,
      includeHookEvents: true,
      // Native Claude dialogs are not exposed by the Host. Keep the declaration
      // explicit so a Run cannot inherit a renderer capability and park for input.
      supportedDialogKinds: [],
      settingSources: input.settingSources,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: input.systemPrompt,
      },
      tools: { type: "preset", preset: "claude_code" },
      mcpServers: input.hostBridge.mcpServers,
      canUseTool: input.hostBridge.canUseTool,
      onElicitation: input.hostBridge.onElicitation,
      permissionMode: input.permissionMode,
      skills: input.request.requestedSkillInvocation?.skillName
        ? [input.request.requestedSkillInvocation.skillName]
        : normalizeClaudeSkillNames(input.request),
      model: input.requestedModel,
      effort: normalizeClaudeEffort(input.request.requestedEffort),
      maxBudgetUsd: normalizeClaudeBudgetLimitUsd(input.request.budgetLimitUsd),
      pathToClaudeCodeExecutable: this.options.cliPath,
      stderr: input.onStderr,
      ...(input.nativeSession.resuming
        ? { resume: input.nativeSession.sessionId }
        : { sessionId: input.nativeSession.sessionId }),
    };
    if (input.permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }
    return options;
  }

  private prepareEnv(requestedModel: string | undefined, runtimeEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...runtimeEnv,
      CLAUDE_AGENT_SDK_CLIENT_APP: `${APP_PRODUCT_NAME}/0.0.0`,
    };
    const configuredBaseUrl = this.options.configuredBaseUrl?.trim();
    const configuredAuthToken = this.options.configuredAuthToken?.trim();
    const configuredModel = normalizeClaudeRuntimeModelId(requestedModel ?? this.options.configuredModel);
    if (configuredBaseUrl) {
      env.ANTHROPIC_BASE_URL = configuredBaseUrl;
    }
    if (configuredAuthToken) {
      env.ANTHROPIC_AUTH_TOKEN = configuredAuthToken;
    }
    if (configuredModel && !isClaudeFamilyAlias(configuredModel)) {
      env.ANTHROPIC_MODEL = configuredModel;
    }
    const hostManagedEnv = applyClaudeHostManagedProviderEnv(env, this.options.env);
    const providerEnv =
      configuredBaseUrl || configuredAuthToken ? hostManagedEnv : applyClaudeBedrockHelperEnv(hostManagedEnv);
    return providerEnv;
  }

  private settingSources(): NonNullable<ClaudeAgentSdkOptions["settingSources"]> {
    // Claude merges filesystem settings after process env. Isolation mode is
    // therefore required when OpenGrove owns the selected provider route.
    return isClaudeProviderManagedByHost(this.options.env) ? [] : ["user", "project", "local"];
  }
}

const CLAUDE_SUPPORTED_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type ClaudeBase64ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function buildClaudeImageBlocks(request: AgentTurnRequest): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const { image } of imageAttachmentsWithDataUrl(request.context.page?.attachments)) {
    if (!CLAUDE_SUPPORTED_IMAGE_MEDIA_TYPES.has(image.mediaType)) continue;
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType as ClaudeBase64ImageMediaType,
        data: image.base64,
      },
    });
  }
  return blocks;
}

// The SDK accepts a string prompt for text-only turns; image attachments require
// the streaming-input form, where the turn is a single user message whose content
// carries the text plus base64 image blocks. resume/sessionId still apply via options.
async function* claudeUserMessageStream(
  text: string,
  imageBlocks: ContentBlockParam[],
  sessionId: string,
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    session_id: sessionId,
    message: {
      role: "user",
      content: [{ type: "text", text }, ...imageBlocks],
    },
  };
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

function mapClaudeSdkMessage(
  message: SDKMessage,
  context: {
    runId: string;
    state: ClaudeSdkMessageState;
    hostBridge: ClaudeSdkHostBridge;
    onInit(init: Extract<SDKMessage, { type: "system"; subtype: "init" }>): void;
  },
): AgentEvent[] {
  if (message.type === "system" && message.subtype === "init") {
    context.state.runtimeModelId = message.model;
    context.state.runtimeVersion = message.claude_code_version;
    context.onInit(message);
    return [
      {
        type: "runtime.diagnostic",
        runId: context.runId,
        at: new Date().toISOString(),
        name: "claude.sdk.init",
        data: {
          sessionId: message.session_id,
          claudeCodeVersion: message.claude_code_version,
          model: message.model,
          permissionMode: message.permissionMode,
          slashCommands: message.slash_commands,
          skills: message.skills,
          tools: message.tools,
          mcpServers: summarizeClaudeMcpServers(message.mcp_servers),
        },
      },
    ];
  }

  if (message.type === "stream_event") {
    return mapClaudeStreamEvent(message, context);
  }

  if (message.type === "assistant") {
    if (message.request_id) context.state.upstreamRequestId = message.request_id;
    return mapAssistantMessage(message.message, context);
  }

  if (message.type === "user") {
    return mapUserMessage(message.message, message.tool_use_result, context);
  }

  if (message.type === "result") {
    const streamEvents = flushClaudeBufferedText(context);
    context.state.usage = normalizeClaudeUsage(message);
    if (message.subtype === "success") {
      context.state.resultText = message.result || context.state.assistantText;
      context.state.resultIsError = message.is_error === true;
    } else {
      context.state.resultText = message.errors.join("; ");
      context.state.resultIsError = true;
    }
    // Flush reasoning that arrived without any following streamed answer text.
    const reasoningEvents = flushClaudeReasoning(context);
    return [
      ...streamEvents,
      ...reasoningEvents,
      {
        type: "runtime.diagnostic",
        runId: context.runId,
        at: new Date().toISOString(),
        name: "claude.sdk.result",
        data: {
          subtype: message.subtype,
          durationMs: message.duration_ms,
          durationApiMs: message.duration_api_ms,
          turns: message.num_turns,
          totalCostUsd: message.total_cost_usd,
          usage: asJsonValue(message.usage),
          modelUsage: asJsonValue(message.modelUsage),
          stopReason: message.stop_reason ?? "",
          terminalReason: message.terminal_reason ?? "",
          requestId: context.state.upstreamRequestId ?? "",
          providerMessageIds: context.state.providerMessageIds,
          isError: message.subtype === "success" ? message.is_error === true : true,
          resultTextLength: context.state.resultText.length,
          resultTextSha256: createHash("sha256").update(context.state.resultText).digest("hex"),
          ...(message.subtype === "success" ? {} : { errors: message.errors }),
        },
      },
    ];
  }

  if (message.type === "system" && message.subtype === "status") {
    if (message.status === "compacting" && !context.state.compactionActive) {
      context.state.compactionActive = true;
      context.state.compactionCompletionPending = false;
      context.state.compactionOccurred = true;
      return [
        {
          type: "compaction.started",
          runId: context.runId,
          at: new Date().toISOString(),
          reason: "Claude Agent compacting",
        },
      ];
    }
    if (!message.status && context.state.compactionActive) {
      if (message.compact_result === "success" && !message.compact_error) {
        // Current Claude builds can emit compact_result before compact_boundary.
        // Keep the lifecycle open so the boundary's manual/auto metadata is not lost.
        context.state.compactionCompletionPending = true;
        return [];
      }
      context.state.compactionActive = false;
      context.state.compactionCompletionPending = false;
      return [
        {
          type: "compaction.finished",
          runId: context.runId,
          at: new Date().toISOString(),
          summary: message.compact_error || message.compact_result || "Claude Agent compaction finished.",
        },
      ];
    }
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    context.state.compactionOccurred = true;
    if (context.state.compactionActive || context.state.compactionCompletionPending) {
      context.state.compactionActive = false;
      context.state.compactionCompletionPending = false;
      return [
        {
          type: "compaction.finished",
          runId: context.runId,
          at: new Date().toISOString(),
          summary: "Claude Agent compact boundary recorded.",
          item: asJsonValue(message.compact_metadata),
        },
      ];
    }
    return [];
  }

  if (
    message.type === "system" &&
    (message.subtype === "hook_started" ||
      message.subtype === "hook_progress" ||
      message.subtype === "hook_response" ||
      message.subtype === "api_retry" ||
      message.subtype === "plugin_install")
  ) {
    return [
      {
        type: "runtime.diagnostic",
        runId: context.runId,
        at: new Date().toISOString(),
        name: `claude.sdk.${message.subtype}`,
        data: asJsonValue(message) as JsonObject,
      },
    ];
  }

  if (message.type === "auth_status") {
    return [
      {
        type: "runtime.diagnostic",
        runId: context.runId,
        at: new Date().toISOString(),
        name: "claude.sdk.auth_status",
        data: asJsonValue(message) as JsonObject,
      },
    ];
  }

  return [];
}

function claudeRuntimeErrorDiagnostics(
  state: ClaudeSdkMessageState,
  error?: unknown,
): RuntimeErrorDiagnostics | undefined {
  const upstreamRequestId = claudeUpstreamRequestId(error) ?? state.upstreamRequestId;
  const diagnostics: RuntimeErrorDiagnostics = {
    ...(state.runtimeModelId ? { runtimeModelId: state.runtimeModelId } : {}),
    ...(state.runtimeVersion ? { runtimeVersion: state.runtimeVersion } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
  };
  return Object.keys(diagnostics).length ? diagnostics : undefined;
}

// Claude SDK request ids correlate provider calls. Other runtimes must not reuse
// this rule for local JSON-RPC or host transport ids.
function claudeUpstreamRequestId(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const input = error as Record<string, unknown>;
  for (const key of ["upstreamRequestId", "requestId", "request_id"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readClaudeCompactionOutcome(message: SDKMessage): {
  started: boolean;
  finished: boolean;
  error?: string;
} {
  if (message.type === "system" && message.subtype === "status") {
    if (message.status === "compacting") {
      return { started: true, finished: false };
    }
    if (message.compact_result === "success") {
      return { started: false, finished: true };
    }
    if (message.compact_result === "failed") {
      return {
        started: false,
        finished: false,
        error: message.compact_error || "compact_failed",
      };
    }
  }
  if (message.type === "system" && message.subtype === "compact_boundary") {
    return { started: false, finished: true };
  }
  return { started: false, finished: false };
}

function normalizeClaudeUsage(message: Extract<SDKMessage, { type: "result" }>): UsageStats | undefined {
  const usage: JsonObject = isJsonObject(message.usage) ? message.usage : {};
  const inputTokens = readNumber(usage.input_tokens) ?? readNumber(usage.inputTokens);
  const outputTokens = readNumber(usage.output_tokens) ?? readNumber(usage.outputTokens);
  const cacheReadInputTokens = readNumber(usage.cache_read_input_tokens) ?? readNumber(usage.cacheReadInputTokens);
  const cacheCreationInputTokens =
    readNumber(usage.cache_creation_input_tokens) ?? readNumber(usage.cacheCreationInputTokens);
  const totalTokens =
    readNumber(usage.total_tokens) ??
    readNumber(usage.totalTokens) ??
    sumNumbers(inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens);
  const costUsd =
    readNumber(message.total_cost_usd) ?? readNumber((message as unknown as Record<string, unknown>).totalCostUsd);
  const latencyMs = readNumber(message.duration_ms);
  // Result usage is billing/turn telemetry. It is not the current context occupancy.
  // Keep the advertised model window as metadata, but only getContextUsage() may
  // populate contextUsedTokens and contextBreakdown.
  const contextWindowSize = readClaudeContextWindow(message.modelUsage);
  const normalized: UsageStats = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

async function readClaudeCurrentContextUsage(
  query: ClaudeAgentQuery,
): Promise<SDKControlGetContextUsageResponse | undefined> {
  if (typeof query.getContextUsage !== "function") {
    return undefined;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      query.getContextUsage(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), 2_000);
        timeout.unref?.();
      }),
    ]);
  } catch {
    // Context telemetry must never turn an otherwise successful native turn into an error.
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function withClaudeCurrentContextUsage(
  usage: UsageStats | undefined,
  context: SDKControlGetContextUsageResponse | undefined,
): UsageStats | undefined {
  if (!context) return usage;
  const contextUsedTokens = nonNegativeNumber(context.totalTokens);
  const contextWindowSize = positiveNumber(context.maxTokens) ?? positiveNumber(context.rawMaxTokens);
  const contextBreakdown = Array.isArray(context.categories)
    ? context.categories
        .map((entry) => ({
          category: typeof entry?.name === "string" ? entry.name.trim() : "",
          tokens: nonNegativeNumber(entry?.tokens),
        }))
        .filter(
          (entry): entry is { category: string; tokens: number } =>
            Boolean(entry.category) && entry.tokens !== undefined,
        )
    : [];
  const normalized: UsageStats = {
    ...(usage ?? {}),
    ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
    ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
    ...(contextBreakdown.length ? { contextBreakdown } : {}),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

function readClaudeContextWindow(modelUsage: unknown): number | undefined {
  if (!isJsonObject(modelUsage)) {
    return undefined;
  }
  let max: number | undefined;
  for (const entry of Object.values(modelUsage)) {
    if (!isJsonObject(entry)) continue;
    const window = readNumber(entry.contextWindow) ?? readNumber(entry.context_window);
    if (window !== undefined && (max === undefined || window > max)) {
      max = window;
    }
  }
  return max;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const normalized = readNumber(value);
  return normalized !== undefined && normalized >= 0 ? normalized : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const normalized = readNumber(value);
  return normalized !== undefined && normalized > 0 ? normalized : undefined;
}

function sumNumbers(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? present.reduce((total, value) => total + value, 0) : undefined;
}

function mapClaudeStreamEvent(
  message: Extract<SDKMessage, { type: "stream_event" }>,
  context: {
    runId: string;
    state: ClaudeSdkMessageState;
  },
): AgentEvent[] {
  const event = isJsonObject(message.event) ? message.event : undefined;
  if (!event) {
    return [];
  }
  const eventType = readString(event, "type") ?? "";
  if (eventType === "message_start") {
    const events = flushClaudeBufferedText(context);
    context.state.currentStreamMessage = createClaudeStreamMessageBuffer(context.state, message, event);
    return events;
  }
  if (eventType === "content_block_start") {
    const buffer = ensureClaudeStreamMessageBuffer(context.state, message);
    const index = readNumber(event.index) ?? 0;
    const block = isJsonObject(event.content_block) ? event.content_block : undefined;
    const blockType = block ? readString(block, "type") : undefined;
    if (blockType) {
      buffer.blockTypesByIndex.set(index, blockType);
      if (isClaudeToolUseBlockType(blockType) && !buffer.toolUseBlockIndexes.includes(index)) {
        buffer.toolUseBlockIndexes.push(index);
      }
    }
    return [];
  }
  if (eventType === "content_block_delta") {
    const thinking = readStreamThinkingDelta(event);
    if (thinking) {
      context.state.reasoningText += thinking;
      return [];
    }
    const text = readStreamTextDelta(event);
    if (!text) {
      return [];
    }
    const buffer = ensureClaudeStreamMessageBuffer(context.state, message);
    const index = readNumber(event.index) ?? 0;
    if (!buffer.blockTypesByIndex.has(index)) {
      buffer.blockTypesByIndex.set(index, "text");
    }
    buffer.textByBlockIndex.set(index, `${buffer.textByBlockIndex.get(index) ?? ""}${text}`);
    return [];
  }
  if (eventType === "message_delta") {
    const buffer = ensureClaudeStreamMessageBuffer(context.state, message);
    const delta = isJsonObject(event.delta) ? event.delta : undefined;
    const stopReason = delta ? readString(delta, "stop_reason") : undefined;
    if (stopReason) {
      buffer.stopReason = stopReason;
    }
    return [];
  }
  if (eventType === "message_stop") {
    return flushClaudeBufferedText(context);
  }
  return [];
}

function createClaudeStreamMessageBuffer(
  state: ClaudeSdkMessageState,
  message: Extract<SDKMessage, { type: "stream_event" }>,
  event?: JsonObject,
): ClaudeStreamMessageBuffer {
  const eventMessage = event && isJsonObject(event.message) ? event.message : undefined;
  return {
    key: readString(eventMessage, "id") ?? streamFallbackMessageKey(state, message),
    textByBlockIndex: new Map(),
    blockTypesByIndex: new Map(),
    toolUseBlockIndexes: [],
  };
}

function ensureClaudeStreamMessageBuffer(
  state: ClaudeSdkMessageState,
  message: Extract<SDKMessage, { type: "stream_event" }>,
): ClaudeStreamMessageBuffer {
  if (!state.currentStreamMessage) {
    state.currentStreamMessage = createClaudeStreamMessageBuffer(state, message);
  }
  return state.currentStreamMessage;
}

function streamFallbackMessageKey(
  state: ClaudeSdkMessageState,
  message: Extract<SDKMessage, { type: "stream_event" }>,
): string {
  const record = isJsonObject(message) ? message : {};
  const parentToolUseId = readString(record, "parent_tool_use_id") ?? "root";
  return readString(record, "uuid") ?? `stream:${parentToolUseId}:${state.streamMessageSeq++}`;
}

function flushClaudeBufferedText(context: { runId: string; state: ClaudeSdkMessageState }): AgentEvent[] {
  const buffer = context.state.currentStreamMessage;
  if (!buffer) {
    return [];
  }
  context.state.currentStreamMessage = undefined;
  context.state.flushedStreamMessageKeys.add(buffer.key);
  return emitClaudeClassifiedText(
    splitClaudeAssistantTextByToolBoundary(streamBufferContent(buffer), buffer.stopReason),
    context,
    buffer.stopReason,
  );
}

function streamBufferContent(buffer: ClaudeStreamMessageBuffer): JsonObject[] {
  const indexes = new Set<number>([
    ...Array.from(buffer.textByBlockIndex.keys()),
    ...Array.from(buffer.blockTypesByIndex.keys()),
    ...buffer.toolUseBlockIndexes,
  ]);
  return Array.from(indexes)
    .sort((left, right) => left - right)
    .flatMap((index) => {
      const type = buffer.blockTypesByIndex.get(index) ?? (buffer.textByBlockIndex.has(index) ? "text" : "tool_use");
      const text = buffer.textByBlockIndex.get(index);
      if (type === "text") {
        return text ? [{ type, text }] : [];
      }
      return [{ type }];
    });
}

function splitClaudeAssistantTextByToolBoundary(
  content: unknown,
  stopReason?: string,
): { commentaryText: string; answerText: string; toolUseIndexes: number[] } {
  const blocks = Array.isArray(content) ? content.filter(isJsonObject) : [];
  const toolUseIndexes = blocks.flatMap((block, index) => {
    const type = readString(block, "type") ?? "";
    return isClaudeToolUseBlockType(type) ? [index] : [];
  });
  const firstToolUseIndex = toolUseIndexes[0] ?? -1;
  const commentaryChunks: string[] = [];
  const answerChunks: string[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (readString(block, "type") !== "text") {
      continue;
    }
    const text = readString(block, "text");
    if (!text) {
      continue;
    }
    if ((firstToolUseIndex >= 0 && index < firstToolUseIndex) || (firstToolUseIndex < 0 && stopReason === "tool_use")) {
      commentaryChunks.push(text);
    } else {
      answerChunks.push(text);
    }
  }
  return {
    commentaryText: commentaryChunks.join(""),
    answerText: answerChunks.join(""),
    toolUseIndexes,
  };
}

function isClaudeToolUseBlockType(type: string): boolean {
  return type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use";
}

function emitClaudeClassifiedText(
  split: { commentaryText: string; answerText: string },
  context: { runId: string; state: ClaudeSdkMessageState },
  stopReason?: string,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (split.commentaryText) {
    events.push(...flushClaudeReasoning(context));
    events.push({
      type: "assistant.status",
      runId: context.runId,
      at: new Date().toISOString(),
      text: split.commentaryText,
      data: {
        source: "claude-sdk",
        kind: "agent_message",
        phase: "commentary",
        claudeKind: "tool_use_preamble",
        ...(stopReason ? { stopReason } : {}),
      },
    });
  }
  if (split.answerText) {
    events.push(...flushClaudeReasoning(context));
    context.state.assistantText += split.answerText;
    events.push({ type: "assistant.delta", runId: context.runId, text: split.answerText });
  }
  return events;
}

function mapAssistantMessage(
  message: { id?: unknown; content: unknown; stop_reason?: unknown },
  context: {
    runId: string;
    state: ClaudeSdkMessageState;
    hostBridge: ClaudeSdkHostBridge;
  },
): AgentEvent[] {
  const content = Array.isArray(message.content) ? message.content : [];
  const events: AgentEvent[] = [];
  const messageId = typeof message.id === "string" ? message.id : undefined;
  if (
    messageId &&
    context.state.providerMessageIds.length < 100 &&
    !context.state.providerMessageIds.includes(messageId)
  ) {
    context.state.providerMessageIds.push(messageId);
  }
  const stopReason = typeof message.stop_reason === "string" ? message.stop_reason : undefined;
  const activeStreamMessage = context.state.currentStreamMessage;
  const streamOwnsText = Boolean(activeStreamMessage && messageId && activeStreamMessage.key === messageId);
  const hasToolUse = content.some(
    (block) => isJsonObject(block) && isClaudeToolUseBlockType(readString(block, "type") ?? ""),
  );
  let textAlreadyFlushed = false;
  if (activeStreamMessage && streamOwnsText) {
    replaceClaudeStreamMessageContent(activeStreamMessage, content, stopReason);
    // A complete SDK assistant snapshot can arrive once per content block while
    // one native message is still streaming. Keep answer text buffered until
    // message_stop; tool-use snapshots flush here so their preamble remains
    // ordered before tool.started.
    if (hasToolUse) {
      events.push(...flushClaudeBufferedText(context));
      textAlreadyFlushed = true;
    }
  }
  if (!streamOwnsText && messageId) {
    textAlreadyFlushed = context.state.flushedStreamMessageKeys.has(messageId);
  }
  if (!streamOwnsText && !textAlreadyFlushed) {
    const split = splitClaudeAssistantTextByToolBoundary(content, stopReason);
    events.push(
      ...emitClaudeClassifiedText({ commentaryText: split.commentaryText, answerText: "" }, context, stopReason),
    );
  }
  for (const block of content) {
    if (!isJsonObject(block)) {
      continue;
    }
    if (block.type === "tool_use") {
      const callId = readString(block, "id") ?? "";
      const toolName = readString(block, "name") ?? "Tool";
      if (context.hostBridge.isOpenGroveMcpToolName(toolName)) {
        continue;
      }
      const toolId = `claude.${toolName}`;
      const input = asJsonValue(block.input);
      const toolAlreadyStarted = Boolean(callId && context.state.toolCalls.has(callId));
      if (callId) {
        context.state.toolCalls.set(callId, { toolId, toolName, input });
      }
      if (toolAlreadyStarted) {
        continue;
      }
      events.push({
        type: "tool.started",
        runId: context.runId,
        toolId,
        ...(callId ? { callId } : {}),
        input,
      });
      events.push(
        ...claudePlanningEventsForToolStarted({
          runId: context.runId,
          ...(callId ? { callId } : {}),
          toolName,
          toolInput: input,
          state: context.state.planningState,
        }),
      );
    }
  }
  if (!streamOwnsText && !textAlreadyFlushed) {
    const split = splitClaudeAssistantTextByToolBoundary(content, stopReason);
    events.push(...emitClaudeClassifiedText({ commentaryText: "", answerText: split.answerText }, context, stopReason));
  }
  return events;
}

function replaceClaudeStreamMessageContent(
  buffer: ClaudeStreamMessageBuffer,
  content: unknown[],
  stopReason?: string,
): void {
  buffer.textByBlockIndex.clear();
  buffer.blockTypesByIndex.clear();
  buffer.toolUseBlockIndexes.length = 0;
  content.forEach((block, index) => {
    if (!isJsonObject(block)) return;
    const blockType = readString(block, "type") ?? "";
    if (!blockType) return;
    buffer.blockTypesByIndex.set(index, blockType);
    if (blockType === "text") {
      const text = readString(block, "text");
      if (text) buffer.textByBlockIndex.set(index, text);
    } else if (isClaudeToolUseBlockType(blockType)) {
      buffer.toolUseBlockIndexes.push(index);
    }
  });
  buffer.stopReason = stopReason ?? buffer.stopReason;
}

function mapUserMessage(
  message: { content?: unknown },
  toolUseResult: unknown,
  context: {
    runId: string;
    state: ClaudeSdkMessageState;
    hostBridge: ClaudeSdkHostBridge;
  },
): AgentEvent[] {
  const content = Array.isArray(message.content) ? message.content : [];
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (!isJsonObject(block) || block.type !== "tool_result") {
      continue;
    }
    const callId = readString(block, "tool_use_id") ?? "";
    const call = context.state.toolCalls.get(callId);
    if (call && context.hostBridge.isOpenGroveMcpToolName(call.toolId)) {
      continue;
    }
    const result = normalizeClaudeToolResult(block, toolUseResult);
    events.push({
      type: "tool.finished",
      runId: context.runId,
      toolId: call?.toolId ?? "claude.tool",
      ...(callId ? { callId } : {}),
      result,
    });
    if (call) {
      events.push(
        ...claudePlanningEventsForToolFinished({
          runId: context.runId,
          ...(callId ? { callId } : {}),
          toolName: call.toolName,
          toolInput: call.input,
          toolResult: result.value,
          resultOk: result.ok,
          state: context.state.planningState,
        }),
      );
    }
  }
  return events;
}

function normalizeClaudeToolResult(block: JsonObject, toolUseResult: unknown): ToolResult {
  const isError = block.is_error === true;
  const rawValue = toolUseResult ?? block.content;
  const value = asJsonValue(rawValue);
  if (isError) {
    return {
      ok: false,
      error:
        typeof value === "string"
          ? value
          : isJsonObject(value) && typeof value.text === "string"
            ? value.text
            : "claude_tool_error",
      value: value === null ? undefined : value,
    };
  }
  return { ok: true, value: value === null ? undefined : value };
}

function readStreamTextDelta(event: unknown): string | undefined {
  if (!isJsonObject(event) || event.type !== "content_block_delta") {
    return undefined;
  }
  const delta = isJsonObject(event.delta) ? event.delta : undefined;
  return delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : undefined;
}

function readStreamThinkingDelta(event: unknown): string | undefined {
  if (!isJsonObject(event) || event.type !== "content_block_delta") {
    return undefined;
  }
  const delta = isJsonObject(event.delta) ? event.delta : undefined;
  return delta?.type === "thinking_delta" && typeof delta.thinking === "string" ? delta.thinking : undefined;
}

// Preserve Claude's native thinking text as reasoning without relabeling it as a
// summary. This stays separate from assistant.delta/model.response answer text.
function flushClaudeReasoning(context: { runId: string; state: ClaudeSdkMessageState }): AgentEvent[] {
  const thinkingText = context.state.reasoningText.trim();
  if (!thinkingText) {
    return [];
  }
  context.state.reasoningText = "";
  const id = `${context.runId}:reasoning:${++context.state.reasoningCallSequence}`;
  return [
    {
      type: "reasoning.started",
      runId: context.runId,
      reasoning: { id, kind: "native", kernelId: "claude-code" },
    },
    {
      type: "reasoning.completed",
      runId: context.runId,
      reasoning: {
        id,
        kind: "native",
        kernelId: "claude-code",
        text: limitDiagnosticText(thinkingText),
      },
    },
  ];
}

function buildClaudeSdkSystemPrompt(request: AgentTurnRequest): string {
  const requiredIds = new Set([
    ...(request.requiredSkills ?? []).map((skill) => skill.manifest.id),
    ...(request.requiredSkillRequirements ?? [])
      .map((requirement) => requirement.manifest?.id)
      .filter((skillId): skillId is string => Boolean(skillId)),
  ]);
  const optionalSkills = (request.skills ?? []).filter((skill) => !requiredIds.has(skill.id));
  const hostContext = agentTurnHostContextPromptBlock(request);
  const sections = [
    `You are running inside the ${APP_PRODUCT_NAME} host.`,
    "Use Claude Agent's native tools, slash commands, skills, hooks, MCP, permissions, and compaction behavior normally.",
    "OpenGrove host tools are exposed through the opengrove MCP server when you need app/browser/computer/skill bridge capabilities.",
    optionalSkills.length
      ? [
          "Employee optional skill scope (load only when relevant by reading the exact SKILL.md path, then follow its references progressively):",
          ...optionalSkills.map((skill) => `- ${skill.name}: ${skill.description}\n  SKILL.md: ${skill.entry}`),
        ].join("\n")
      : "",
    hostContext ? `OpenGrove host context:\n${hostContext}` : "",
    request.requestedSkillInvocation
      ? [
          `The user explicitly selected the Claude-compatible skill "${request.requestedSkillInvocation.skillName}" for this turn.`,
          request.requestedSkillInvocation.args
            ? `Use it for this task. User skill arguments:\n${request.requestedSkillInvocation.args}`
            : "Use it for this task.",
        ].join("\n")
      : "",
    agentTurnReplyLanguageInstruction(request),
  ].filter(Boolean);
  return sections.join("\n\n");
}

function resolveClaudeNativeSession(
  request: AgentTurnRequest,
  runtimeBindingFingerprint: string | undefined,
  options: { cwd: string; configDir?: string | undefined },
): { sessionId: string; resuming: boolean } {
  const current = request.context.sessions.get(request.context.sessionId);
  const fingerprint = runtimeBindingFingerprint || "native";
  const sessionByFingerprint = current?.metadata?.claudeCodeSessionIds;
  if (sessionByFingerprint && typeof sessionByFingerprint === "object" && !Array.isArray(sessionByFingerprint)) {
    const sessionId = (sessionByFingerprint as Record<string, unknown>)[fingerprint];
    if (typeof sessionId === "string" && sessionId.trim()) {
      return { sessionId, resuming: true };
    }
  }
  const metadataSession =
    typeof current?.metadata?.claudeCodeSessionId === "string" ? current.metadata.claudeCodeSessionId : undefined;
  const stableSessionId =
    metadataSession && fingerprint === "native"
      ? metadataSession
      : toStableClaudeSessionId(`${request.context.sessionId}:${fingerprint}`);
  return {
    sessionId: stableSessionId,
    resuming:
      Boolean(metadataSession && fingerprint === "native") || claudeNativeTranscriptExists(stableSessionId, options),
  };
}

function rememberClaudeNativeSession(
  request: AgentTurnRequest,
  nativeSessionId: string,
  runtimeBindingFingerprint: string | undefined,
): void {
  const current = request.context.sessions.get(request.context.sessionId);
  const fingerprint = runtimeBindingFingerprint || "native";
  const metadata: JsonObject = {
    ...(current?.metadata ?? {}),
    claudeCodeSessionIds: {
      ...readObject(current?.metadata?.claudeCodeSessionIds),
      [fingerprint]: nativeSessionId,
    },
  };
  if (fingerprint === "native") {
    metadata.claudeCodeSessionId = nativeSessionId;
    metadata.claudeCodeSessionUpdatedAt = new Date().toISOString();
  }
  request.context.sessions.ensureSession({
    id: request.context.sessionId,
    activity: request.context.activity,
    metadata,
  });
}

function recordClaudeRuntimeInventory(
  request: AgentTurnRequest,
  init: Extract<SDKMessage, { type: "system"; subtype: "init" }>,
): void {
  const current = request.context.workingState.get();
  request.context.workingState.update({
    selectedModel: init.model || current.selectedModel,
    toolSchemaCache: {
      ...current.toolSchemaCache,
      "claude.slashCommands": JSON.stringify(init.slash_commands),
      "claude.skills": JSON.stringify(init.skills),
      "claude.tools": JSON.stringify(init.tools),
      "claude.mcpServers": JSON.stringify(summarizeClaudeMcpServers(init.mcp_servers)),
      "claude.version": init.claude_code_version,
    },
  });
}

function summarizeClaudeMcpServers(mcpServers: readonly ClaudeMcpServerSummary[]): JsonObject[] {
  return mcpServers.map((server) => ({
    name: server.name,
    status: server.status,
  }));
}

function claudeNativeTranscriptExists(
  sessionId: string,
  options: { cwd: string; configDir?: string | undefined },
): boolean {
  const configDir = options.configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || resolve(homedir(), ".claude");
  const projectsDir = join(configDir, "projects");
  const projectPath = join(projectsDir, claudeProjectKey(options.cwd), `${sessionId}.jsonl`);
  if (existsSync(projectPath)) {
    return true;
  }

  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(projectsDir, entry.name, `${sessionId}.jsonl`))) {
        return true;
      }
    }
  } catch {
    // non-critical-fallback: Missing or unreadable native transcripts do not block a fresh session.
  }
  return false;
}

function claudeProjectKey(cwd: string): string {
  return resolve(cwd || process.cwd())
    .normalize("NFC")
    .replace(/[^A-Za-z0-9._-]/g, "-");
}

function claudeSdkProcessErrorMessage(error: unknown, stderrText: string): string {
  const base = error instanceof Error ? error.message : String(error || "claude_agent_sdk_failed");
  const stderr = sanitizeDiagnosticText(stderrText).trim();
  if (!stderr) {
    return base || "claude_agent_sdk_failed";
  }
  return base.includes(stderr) ? base : `${base}: ${stderr}`;
}

function limitDiagnosticText(value: string): string {
  const limit = 4_000;
  return value.length > limit ? value.slice(value.length - limit) : value;
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(
      /(AWS_BEARER_TOKEN_BEDROCK|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|authorization|api[_-]?key|token|secret|bearer)([=:\s"]+)[^\s"]+/gi,
      "$1$2<redacted>",
    )
    .replace(/(sk|ark|ABSK)[A-Za-z0-9_.=+/-]{12,}/g, "<redacted>");
}

function claudeEnvironmentSummary(env: NodeJS.ProcessEnv, cliPath: string | undefined): JsonObject {
  return stripUndefined({
    cliPath: cliPath || "auto",
    providerMode: claudeProviderMode(env),
    bedrockEnabled: isTruthyEnv(env.CLAUDE_CODE_USE_BEDROCK),
    vertexEnabled: isTruthyEnv(env.CLAUDE_CODE_USE_VERTEX),
    awsRegion: env.AWS_REGION,
    bedrockBaseUrl: env.ANTHROPIC_BEDROCK_BASE_URL,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
    proxyMode: claudeProxyMode(env),
    httpsProxy: env.HTTPS_PROXY || env.https_proxy,
    allProxy: env.ALL_PROXY || env.all_proxy,
    hasAwsCredential: hasAwsCredential(env),
    awsCredentialMode: awsCredentialMode(env),
    hasAwsBearerToken: Boolean(env.AWS_BEARER_TOKEN_BEDROCK?.trim()),
    hasAwsSessionCredentials: hasAwsSessionCredentials(env),
    hasAwsProfile: Boolean(env.AWS_PROFILE?.trim()),
    hasAnthropicAuthToken: Boolean(env.ANTHROPIC_AUTH_TOKEN?.trim()),
    hasAnthropicApiKey: Boolean(env.ANTHROPIC_API_KEY?.trim()),
    anthropicModel: env.ANTHROPIC_MODEL,
    defaultOpusModel: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    defaultSonnetModel: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    defaultHaikuModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    smallFastModel: env.ANTHROPIC_SMALL_FAST_MODEL,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR,
  }) as JsonObject;
}

function claudeProviderMode(env: NodeJS.ProcessEnv): string {
  if (isTruthyEnv(env.CLAUDE_CODE_USE_BEDROCK)) return "bedrock";
  if (isTruthyEnv(env.CLAUDE_CODE_USE_VERTEX)) return "vertex";
  if (env.ANTHROPIC_BASE_URL?.trim()) return "anthropic-compatible";
  return "native";
}

function claudeProxyMode(env: NodeJS.ProcessEnv): string {
  if (env.HTTPS_PROXY?.trim() || env.https_proxy?.trim()) return "https-proxy";
  if (env.ALL_PROXY?.trim() || env.all_proxy?.trim()) return "all-proxy";
  if (env.HTTP_PROXY?.trim() || env.http_proxy?.trim()) return "http-proxy";
  return "none";
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function awsCredentialMode(env: NodeJS.ProcessEnv): string {
  if (hasAwsSessionCredentials(env)) return "session-credentials";
  if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) return "bearer-token";
  if (env.AWS_PROFILE?.trim()) return "profile";
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim()) return "web-identity";
  return "none";
}

function hasAwsSessionCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function resolveClaudePermissionMode(
  accessMode: RuntimeAccessMode | undefined,
  configured: ClaudeAgentSdkRuntimeOptions["permissionMode"],
): ClaudePermissionMode {
  switch (accessMode) {
    case "default":
      return "default";
    case "auto-review":
      return "acceptEdits";
    case "full-access":
      return "bypassPermissions";
    default:
      return configured ?? "bypassPermissions";
  }
}

function normalizeClaudeEffort(value: string | undefined): EffortLevel | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

function normalizeClaudeBudgetLimitUsd(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(Math.min(value, 100) * 100) / 100;
}

function normalizeClaudeSkillNames(
  request: Pick<AgentTurnRequest, "skills" | "requiredSkillRequirements">,
): string[] | "all" {
  if (request.skills === undefined) return "all";
  return [
    ...new Set(
      [
        ...request.skills.map((skill) => skill.name.trim()),
        ...(request.requiredSkillRequirements ?? [])
          .filter((requirement) => requirement.modelLoadAllowed && requirement.manifest)
          .map((requirement) => requirement.manifest!.name.trim()),
      ].filter(Boolean),
    ),
  ];
}

function isClaudeFamilyAlias(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "");
  return normalized === "opus" || normalized === "sonnet" || normalized === "haiku";
}

function claudeRuntimeBindingFingerprint(input: { base?: string; cwd: string; skillScope: string[] | "all" }): string {
  return createHash("sha1")
    .update(
      [
        input.base || "native",
        input.cwd,
        Array.isArray(input.skillScope) ? input.skillScope.join(",") : input.skillScope,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
}

function readObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function toStableClaudeSessionId(input: string): string {
  const hash = createHash("sha1").update(input).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}
