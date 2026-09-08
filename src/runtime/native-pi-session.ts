import {
  AgentHarness,
  HarnessClosed,
  HarnessFault,
  BACKGROUND_CONTEXT as background,
  type AgentLane,
  type HarnessEvent,
  convertToLlm as convertNativeSessionMessages,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  shouldCompact,
  type AgentMessage as NativeAgentMessage,
  type AgentEvent as NativePiEvent,
  type AgentOptions,
  type AgentHarnessTool,
  type AgentTool,
  type CompactionSettings,
  type ExecutionEnv,
  type ExecutionToolContext,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  clampThinkingLevel,
  createProvider,
  envApiKeyAuth,
  type AssistantMessage,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Context as NativeModelContext,
  type ImageContent,
  type Model,
  type MutableModels,
  type Models,
  createAssistantMessageEventStream,
  type TSchema,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { NativePiSessionRepository, nativePiSessionId } from "./pi-session-repository.js";
import { WorkingStateStore } from "../core.js";
import type {
  AgentContext,
  AgentCompactRequest,
  AgentCompactResult,
  AgentEvent,
  AgentModelRequestTrace,
  AgentSessionTrace,
  ApprovalKind,
  ApprovalRequest,
  ContextEnvelope,
  InvokedSkillRecord,
  JsonObject,
  JsonValue,
  ModelMessage,
  ToolDefinition,
  ToolResult,
} from "../core.js";
import { buildSkillSteeringText } from "../skills/runtime.js";
import { imageAttachmentsWithDataUrl } from "./media-input.js";
import { contextBudgetDiagnostic, resolveContextTokenBudget } from "./context-token-budget.js";
import type { PiAgentRuntimeOptions, PiSession, PiSessionContext } from "./pi-runtime.js";

export interface NativePiSessionOptions {
  model: Model<any> | ((requestedModelId?: string) => Model<any>);
  streamFn?: StreamFn;
  getApiKey?: AgentOptions["getApiKey"];
  thinkingLevel?: ThinkingLevel | ((requestedEffort?: string) => ThinkingLevel);
  toolExecution?: AgentOptions["toolExecution"];
  /** Enables Pi's native durable JSONL SessionRepo. Omit for an in-memory repo. */
  sessionRoot?: string;
  cwd?: string;
  /** Injectable for deterministic compaction tests and custom provider catalogs. */
  models?: MutableModels;
  /** Close and natively recover a provider/tool that ignores cancellation beyond this deadline. */
  abortSettleTimeoutMs?: number;
  /** Injectable execution boundary for Pi's official coding tools. */
  executionEnv?: ExecutionEnv;
}

export function createNativePiSessionFactory(options: NativePiSessionOptions): PiAgentRuntimeOptions["createSession"] {
  // This map is an in-process single-writer guard. Deployments that share one
  // sessionRoot across Host processes must provide external coordination.
  const sessions = new Map<string, NativePiSession>();
  const models = options.models ?? createNativePiModels(options.getApiKey);
  const cwd = options.cwd ?? process.cwd();
  const executionEnv = options.executionEnv ?? new NodeExecutionEnv({ cwd });
  const repository = new NativePiSessionRepository(options.sessionRoot, cwd, executionEnv);
  const resolvedOptions = { ...options, cwd, models, executionEnv };

  const factory: PiAgentRuntimeOptions["createSession"] = (context) => {
    const sessionId = context.sessionId || "default";
    let session = sessions.get(sessionId);
    if (!session) {
      session = new NativePiSession(context, resolvedOptions, sessionId, repository);
      sessions.set(sessionId, session);
    } else {
      session.updateRuntimeContext(context);
    }
    return session;
  };
  factory.compactSession = async (request) => {
    let session = sessions.get(request.threadId);
    if (!session) {
      session = new NativePiSession(
        {
          sessionId: request.threadId,
          system: "",
          tools: [],
          skills: [],
          packs: [],
          capabilities: [],
        },
        resolvedOptions,
        request.threadId,
        repository,
      );
      sessions.set(request.threadId, session);
    }
    return session.compact(request);
  };
  factory.listSessions = () => repository.list();
  factory.deleteSession = async (sessionId) => {
    const active = sessions.get(sessionId);
    if (active?.isRunning) {
      return { ok: false, deleted: false, error: "pi_session_busy" };
    }
    await active?.close();
    const deleted = await repository.delete(sessionId);
    // Forget an inactive Host handle even when no durable entry existed. This
    // keeps repository and factory caches aligned for a later fork/create.
    sessions.delete(sessionId);
    return { ok: true, deleted };
  };
  factory.forkSession = async (sourceSessionId, targetSessionId) => {
    if (sessions.get(sourceSessionId)?.isRunning) {
      return { ok: false, forked: false, error: "pi_session_busy" };
    }
    const result = await repository.fork(sourceSessionId, targetSessionId);
    if (result === "source_not_found") {
      return { ok: false, forked: false, error: "pi_session_source_not_found" };
    }
    if (result === "target_exists") {
      return { ok: false, forked: false, error: "pi_session_target_exists" };
    }
    return {
      ok: true,
      forked: true,
      session: { sessionId: targetSessionId, nativeSessionId: nativePiSessionId(targetSessionId) },
    };
  };
  factory.dispose = async () => {
    try {
      await Promise.all([...sessions.values()].map((session) => session.close()));
    } finally {
      sessions.clear();
      await repository.close();
    }
  };
  return factory;
}

class NativePiSession implements PiSession {
  readonly emitsModelRequests = true;
  private harness?: AgentHarness<ExecutionToolContext>;
  private lane?: AgentLane;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private faulted = false;
  private streamFn?: StreamFn;
  private removeToolGate?: () => void;
  private nativeToolNames = new Map<string, string>();
  private pendingSkillOverlay?: InvokedSkillRecord;
  private activeSkillOverlay?: InvokedSkillRecord;
  private activeRuns = 0;

  constructor(
    private runtimeContext: Parameters<PiAgentRuntimeOptions["createSession"]>[0],
    private readonly options: NativePiSessionOptions,
    private readonly sessionId: string,
    private readonly repository: NativePiSessionRepository,
  ) {}

  updateRuntimeContext(context: Parameters<PiAgentRuntimeOptions["createSession"]>[0]) {
    this.runtimeContext = context;
  }

  get isRunning(): boolean {
    return this.activeRuns > 0 || this.opening !== undefined || this.closing !== undefined;
  }

  async close(): Promise<void> {
    await this.opening;
    await this.closeNativeHarness();
  }

  private closeNativeHarness(): Promise<void> {
    if (this.closing) return this.closing;
    const harness = this.harness;
    if (!harness) return Promise.resolve();
    this.harness = undefined;
    this.lane = undefined;
    this.faulted = false;
    this.removeToolGate?.();
    this.removeToolGate = undefined;
    this.closing = Promise.resolve()
      .then(() => harness.close(background))
      .finally(() => {
        this.repository.release(this.sessionId);
        this.closing = undefined;
      });
    return this.closing;
  }

  async trace(): Promise<AgentSessionTrace> {
    try {
      await this.ensureNativeSession();
      return await this.createSessionTrace();
    } catch (error) {
      if (error instanceof HarnessFault) this.faulted = true;
      throw error;
    }
  }

  private async createSessionTrace(): Promise<AgentSessionTrace> {
    const entries = await this.lane!.findEntries({ order: "oldestFirst" }, background);
    const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    return {
      provider: "pi",
      sessionId: this.sessionId,
      persistent: true,
      nativeSessionId: nativePiSessionId(this.sessionId),
      priorMessageCount: messages.length,
      priorMessages: toModelMessages(messages),
    };
  }

  async *run(input: string, context: PiSessionContext): AsyncIterable<AgentEvent> {
    this.activeRuns += 1;
    try {
      yield* this.runActiveTurn(input, context);
    } catch (error) {
      if (error instanceof HarnessFault) this.faulted = true;
      throw error;
    } finally {
      this.activeRuns = Math.max(0, this.activeRuns - 1);
    }
  }

  private async *runActiveTurn(input: string, context: PiSessionContext): AsyncIterable<AgentEvent> {
    await this.ensureNativeSession();
    const images = piImageContent(context);
    const queue: NativeSessionEvent[] = [];
    let done = false;
    let wake: (() => void) | undefined;
    let streamingMessage: NativeAgentMessage | undefined;
    const turnMessages: NativeAgentMessage[] = [];
    let faultReported = false;
    const projector = new PiNativeMessageProjector(context.runId);
    const push = (events: NativeSessionEvent[]) => {
      queue.push(...events);
      wake?.();
      wake = undefined;
    };
    const project = (projection: PiNativeMessageProjection) => {
      push(projection.events);
      if (projection.terminalMessage)
        push([
          {
            type: "model.response",
            runId: context.runId,
            response: {
              text: readAssistantText(projection.terminalMessage),
              usage: toUsageStats(
                projection.terminalMessage,
                resolveModel(this.options.model, this.runtimeContext.requestedModelId),
              ),
            },
          },
          createPiMessageDiagnostic(context.runId, projection.terminalMessage),
        ]);
    };
    await this.configureAgentForTurn(input, context, push);
    const contextPreparation = await this.prepareNativeContext(input, images, context);
    for (const event of contextPreparation.events) yield event;
    if (contextPreparation.error) {
      yield { type: "error", runId: context.runId, message: contextPreparation.error };
      return;
    }
    const listeners = (
      [
        "message_start",
        "message_update",
        "message_end",
        "turn_start",
        "turn_end",
        "tool_start",
        "tool_update",
        "tool_end",
        "run_end",
        "fault",
        "handler_error",
      ] as const
    ).map((type) =>
      this.harness!.events.on(type, (event) => {
        if (event.type === "fault" || event.type === "handler_error") {
          if (event.type === "fault") faultReported = true;
          push([
            { type: "error", runId: context.runId, message: event.type === "fault" ? event.message : event.error },
          ]);
          return;
        }
        if (event.type === "message_start" || event.type === "message_update") streamingMessage = event.message;
        if (event.type === "message_end") {
          streamingMessage = undefined;
          turnMessages.push(event.message);
        }
        if (event.type === "run_end") {
          if (event.status === "aborted") project(projector.abort(streamingMessage));
          else project(projector.project({ type: "agent_end", messages: turnMessages }));
          if (event.status === "failed") push([{ type: "error", runId: context.runId, message: event.error.message }]);
          return;
        }
        const nativeEvent = toPiAgentEvent(event);
        if (nativeEvent) {
          this.handleLoopEvent(nativeEvent, context, push);
          project(projector.project(nativeEvent));
          push(mapNativeToolEvent(nativeEvent, context.runId, this.nativeToolNames));
        }
      }),
    );
    let abortRequested = false;
    let abortTimedOut = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTask: Promise<void> | undefined;
    let abortTask: Promise<void> | undefined;
    const abortTurn = () => {
      if (abortRequested) return;
      abortRequested = true;
      abortTimer = setTimeout(() => {
        if (done) return;
        abortTimedOut = true;
        project(projector.abort(streamingMessage));
        push([
          {
            type: "error",
            runId: context.runId,
            message: "pi_abort_settlement_timeout: Pi provider or tool did not settle after cancellation",
          },
        ]);
        closeTask = this.closeNativeHarness().catch((error) =>
          push([{ type: "error", runId: context.runId, message: String(error) }]),
        );
      }, this.options.abortSettleTimeoutMs ?? 15_000);
      // Pi closes the effect gate; reopening reconciles orphaned tools and partial
      // assistant frames through its own recovery. Never fabricate tool results.
      abortTask = this.lane!.abort(background)
        .then((result) => {
          if (
            !result.ok &&
            result.error._tag !== "NoActiveOperation" &&
            !(abortTimedOut && result.error._tag === "Closed")
          )
            throw result.error;
        })
        .catch((error) => {
          // Closing an in-flight abort rejects with HarnessClosed; an abort
          // started after close instead returns Result.err(Closed).
          if (!(abortTimedOut && error instanceof HarnessClosed))
            push([{ type: "error", runId: context.runId, message: String(error) }]);
        });
    };
    const prompt = (async () => {
      if (context.requestedSkillInvocation?.context === "inline") {
        this.pendingSkillOverlay = undefined;
        this.activeSkillOverlay = context.requestedSkillInvocation;
        await this.lane!.steer(createSkillSteeringMessage(context.requestedSkillInvocation), undefined, background);
      }
      if (context.assembledContext?.promptBlock)
        await this.lane!.steer(createContextSteeringMessage(context.assembledContext), undefined, background);
      // Explicit admission closes the cancel-before-start race.
      const admitted = await this.lane!.accept({ kind: "prompt", prompt: input, images }, background);
      if (!admitted.ok) throw admitted.error;
      context.signal?.addEventListener("abort", abortTurn, { once: true });
      if (context.signal?.aborted) abortTurn();
      const result = await this.lane!.drive(
        { operationId: admitted.value.operationId, waitForRetry: true, pollDeferred: true },
        background,
      );
      if (!result.ok) throw result.error;
      if (result.value.kind !== "settled") throw new Error(`pi_operation_waiting: ${result.value.reason}`);
    })()
      .catch((error) => {
        if (error instanceof HarnessFault) this.faulted = true;
        if (!abortTimedOut && !(faultReported && error instanceof HarnessFault))
          push([
            { type: "error", runId: context.runId, message: error instanceof Error ? error.message : String(error) },
          ]);
      })
      .finally(() => {
        done = true;
        wake?.();
        wake = undefined;
      });
    try {
      while (!done || queue.length) {
        while (queue.length) yield queue.shift()!;
        if (!done)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    } finally {
      context.signal?.removeEventListener("abort", abortTurn);
      if (!done) abortTurn();
      await prompt;
      await abortTask;
      await closeTask;
      if (abortTimer) clearTimeout(abortTimer);
      for (const unsubscribe of listeners) unsubscribe();
    }
    while (queue.length) yield queue.shift()!;
  }

  async compact(request: AgentCompactRequest): Promise<AgentCompactResult> {
    const model = resolveModel(this.options.model, this.runtimeContext.requestedModelId);
    return this.compactWithSettings(request, piCompactionSettingsForRequest(model.contextWindow, request.maxTokens));
  }

  private async compactWithSettings(
    request: AgentCompactRequest,
    settings: CompactionSettings,
  ): Promise<AgentCompactResult> {
    try {
      await this.ensureNativeSession();
      if ((await this.lane!.inspectExecution(background)).current)
        return { ok: false, compacted: false, error: "pi_session_busy" };
      await this.harness!.setCompactionSettings(settings, background);
      let result;
      try {
        result = await this.lane!.compact({ customInstructions: request.reason }, background);
      } finally {
        await this.harness!.setCompactionSettings({ ...settings, enabled: false }, background);
      }
      if (!result.ok)
        return result.error._tag === "NothingToCompact"
          ? { ok: true, compacted: false }
          : { ok: false, compacted: false, error: result.error.message };
      const compacted = result.value.compaction.status === "completed";
      return result.value.compaction.status === "failed"
        ? { ok: false, compacted: false, error: result.value.compaction.error?.message ?? "pi_compaction_failed" }
        : { ok: true, compacted };
    } catch (error) {
      if (error instanceof HarnessFault) this.faulted = true;
      return { ok: false, compacted: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Estimate only: the Harness independently assembles the actual provider context. */
  private async estimateNativeContext(incoming: NativeAgentMessage) {
    const entries = await this.lane!.findEntries({ order: "newestFirst", stopAtType: "compaction" }, background);
    const messages: NativeAgentMessage[] = [];
    let summaryTokens = 0;
    for (const entry of entries.reverse()) {
      if (entry.type === "message") messages.push(entry.message);
      else if (entry.type === "compaction") {
        summaryTokens += Math.ceil(entry.summary.length / 4) + 40;
        messages.push(...entry.retainedTail);
      }
    }
    messages.push(incoming);
    const usage = estimateContextTokens(messages);
    return {
      ...usage,
      tokens: usage.tokens + summaryTokens,
      estimatedTokens: messages.reduce((sum, message) => sum + estimateTokens(message), summaryTokens),
    };
  }

  private async prepareNativeContext(
    input: string,
    images: ImageContent[] | undefined,
    context: PiSessionContext,
  ): Promise<{ events: AgentEvent[]; error?: string }> {
    const model = resolveModel(this.options.model, this.runtimeContext.requestedModelId);
    const budget = resolveContextTokenBudget(context.contextTokenBudget, model.contextWindow);
    const triggerWindow = budget.effectiveBudget ?? budget.modelContextWindow;
    const incomingMessage = createPiBudgetMessage(
      [context.assembledContext?.promptBlock, input].filter(Boolean).join("\n\n"),
      images,
    );
    const usage = await this.estimateNativeContext(incomingMessage);
    const usageSource = usage.usageTokens > 0 ? ("native" as const) : ("estimated" as const);

    if (triggerWindow === undefined) {
      return {
        events: [
          contextBudgetDiagnostic({
            runId: context.runId,
            kernel: "pi",
            ...budget,
            usageSource,
            enforcementMode: "native-trigger",
            contextUsedTokens: usage.tokens,
            reason: "Pi model context window unavailable; no Host truncation applied",
          }),
        ],
      };
    }

    const settings = piCompactionSettings(triggerWindow);
    if (!shouldCompact(usage.tokens, triggerWindow, settings)) {
      return {
        events: [
          contextBudgetDiagnostic({
            runId: context.runId,
            kernel: "pi",
            ...budget,
            usageSource,
            enforcementMode: "native-trigger",
            contextUsedTokens: usage.tokens,
            reason:
              budget.budgetSource === "configured"
                ? "Pi native compaction threshold not reached"
                : "Pi native model-window compaction threshold not reached",
          }),
        ],
      };
    }

    const reason =
      budget.budgetSource === "configured"
        ? `Pi projected context reached the configured ${triggerWindow}-token window`
        : `Pi projected context approached the native ${triggerWindow}-token model window`;
    const events: AgentEvent[] = [
      {
        type: "compaction.started",
        runId: context.runId,
        at: new Date().toISOString(),
        reason,
      },
    ];
    const result = await this.compactWithSettings(
      {
        runId: context.runId,
        threadId: this.sessionId,
        reason,
      },
      settings,
    );
    events.push(
      contextBudgetDiagnostic({
        runId: context.runId,
        kernel: "pi",
        ...budget,
        usageSource,
        enforcementMode: "native-trigger",
        contextUsedTokens: usage.tokens,
        compactionTriggered: true,
        compactionSucceeded: result.ok && result.compacted === true,
        reason: result.ok
          ? result.compacted === true
            ? "Pi native summary compaction completed"
            : "Pi native compaction found no eligible history"
          : result.error,
      }),
    );

    if (result.ok && result.compacted) {
      events.push({
        type: "compaction.finished",
        runId: context.runId,
        at: new Date().toISOString(),
        summary: "Pi native session compaction finished.",
      });
    }

    const rebuiltTokens = (await this.estimateNativeContext(incomingMessage)).estimatedTokens;
    const hardWindowExceeded = budget.modelContextWindow !== undefined && rebuiltTokens >= budget.modelContextWindow;
    if (hardWindowExceeded) {
      return {
        events,
        error: [
          `context_window_exceeded_after_pi_compaction: Pi native compaction could not fit this conversation into the model context window (${rebuiltTokens}/${budget.modelContextWindow} tokens).`,
          "No conversation history was discarded.",
          result.error ? `Native compaction detail: ${result.error}` : "The native compaction result was insufficient.",
        ].join(" "),
      };
    }

    return { events };
  }

  private async ensureNativeSession(): Promise<void> {
    await this.closing;
    if (this.faulted) await this.closeNativeHarness();
    if (this.harness) return;
    this.opening ??= this.openNativeSession().finally(() => {
      this.opening = undefined;
    });
    await this.opening;
  }

  private async openNativeSession(): Promise<void> {
    const session = await this.repository.openOrCreate(this.sessionId);
    const catalog = this.options.models!;
    const models = new Proxy(catalog, {
      get: (target, property, receiver) => {
        if (property === "getModel")
          return (provider: string, id: string) => {
            const selected = resolveModel(this.options.model, this.runtimeContext.requestedModelId);
            return selected.provider === provider && selected.id === id ? selected : target.getModel(provider, id);
          };
        if (property === "streamSimple")
          return ((model, context, options) => {
            const stream = this.streamFn ?? this.options.streamFn;
            return stream
              ? bridgePiStream(stream, model, context, options)
              : target.streamSimple(model, context, options);
          }) satisfies Models["streamSimple"];
        const member = Reflect.get(target, property, receiver);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    let harness: AgentHarness<ExecutionToolContext> | undefined;
    try {
      const created = await AgentHarness.create(
        {
          session,
          models,
          model: resolveModel(this.options.model, this.runtimeContext.requestedModelId),
          thinkingLevel: resolveThinkingLevel(this.options.thinkingLevel, this.runtimeContext.requestedEffort),
          systemPrompt: () => this.runtimeContext.system,
          toolContext: { env: this.options.executionEnv! },
          toolExecution: this.options.toolExecution ?? "parallel",
          // The Host owns the user-selected trigger; Pi owns summarization and storage.
          compaction: { ...DEFAULT_COMPACTION_SETTINGS, enabled: false },
          toProviderMessages: convertNativeSessionMessages,
        },
        background,
      );
      harness = created.harness;
      const lane = await harness.lane("main", background);
      for (const operation of created.open) {
        const interrupted = await harness.lane(operation.lane, background);
        const settled = await interrupted.abort(background);
        if (!settled.ok) throw settled.error;
      }
      this.harness = harness;
      this.lane = lane;
      harness.events.on("fault", () => {
        this.faulted = true;
      });
    } catch (error) {
      try {
        await (harness ?? session).close(background);
      } finally {
        this.repository.release(this.sessionId);
      }
      throw error;
    }
  }

  private async configureAgentForTurn(
    input: string,
    context: PiSessionContext,
    push: (events: NativeSessionEvent[]) => void,
  ): Promise<void> {
    this.nativeToolNames = createNativeToolNameMap(this.runtimeContext.tools);
    const model = resolveModel(this.options.model, this.runtimeContext.requestedModelId);
    const thinkingLevel = clampThinkingLevel(
      model,
      resolveThinkingLevel(this.options.thinkingLevel, this.runtimeContext.requestedEffort),
    );
    const tools = [
      ...toNativeTools(this.runtimeContext.tools, context, this.nativeToolNames, {
        onSkillInvoked: async (invocation) => {
          const manifest =
            context.agent.skills.get(invocation.skillId) ?? context.agent.skills.get(invocation.skillName);
          if (manifest) {
            push([{ type: "skill.invoked", runId: context.runId, skill: manifest, invocation }]);
            push([
              {
                type: "skill.loaded",
                runId: context.runId,
                skillId: invocation.skillId,
                contentPreview: invocation.contentPreview,
                allowedTools: [...invocation.allowedTools],
                model: invocation.model,
                effort: invocation.effort,
                context: invocation.context,
              },
            ]);
          }
          if (invocation.context === "inline") {
            this.pendingSkillOverlay = invocation;
            await this.lane!.steer(createSkillSteeringMessage(invocation), undefined, background);
          }
        },
        runForkedSkill: async (invocation) => {
          const forkSessionId = `${this.sessionId}:skill:${invocation.skillName}:${Date.now()}`;
          push([
            {
              type: "skill.forked",
              runId: context.runId,
              skillId: invocation.skillId,
              forkSessionId,
              status: "started",
            },
          ]);
          const result = await this.executeForkedSkill(invocation, context, forkSessionId);
          push([
            {
              type: "skill.forked",
              runId: context.runId,
              skillId: invocation.skillId,
              forkSessionId: result.forkSessionId,
              status: "finished",
              result: result.text,
            },
          ]);
          return result;
        },
      }).map(toHarnessTool),
      ...createPiCodingTools(),
    ];
    this.streamFn = this.createTracingStreamFn(input, context, push);
    await this.harness!.setTools(tools, background);
    await this.lane!.setActiveTools(
      tools.map((tool) => tool.name),
      background,
    );
    await this.lane!.setModel({ provider: model.provider, modelId: model.id }, background);
    await this.lane!.setThinkingLevel(thinkingLevel, background);
    await this.harness!.setCompactionSettings({ ...DEFAULT_COMPACTION_SETTINGS, enabled: false }, background);
    this.removeToolGate?.();
    this.removeToolGate = this.harness!.hooks.on("before_tool", async (nativeContext, nativeRequestContext) => {
      const signal = nativeRequestContext.abortSignal;
      const toolId = toOriginalToolId(this.nativeToolNames, nativeContext.toolName);
      const capabilityId = findCapabilityId(this.runtimeContext.tools, context, toolId);
      const decision = await context.beforeToolCall({
        toolId,
        capabilityId,
        input: isJsonObject(nativeContext.args) ? nativeContext.args : undefined,
        source: PI_CODING_TOOL_NAMES.has(toolId) ? "native" : "host",
      });

      if (decision.mode !== "allow") {
        if (decision.mode === "ask") {
          const approvalInput = enrichApprovalInput(toolId, nativeContext.args, context.agent);
          const request = context.agent.approvals.request({
            kind: piApprovalKind(toolId),
            title: toolId,
            reason: decision.reason,
            toolId,
            capabilityId,
            input: approvalInput,
            resume: {
              type: "kernel.native",
              kernelId: "pi",
              runId: context.runId,
              continuation: "same-loop",
            },
          });
          push([
            { type: "approval.requested", runId: context.runId, request },
            {
              type: "run.paused",
              runId: context.runId,
              at: new Date().toISOString(),
              reason: decision.reason,
              approvalId: request.id,
            },
          ]);
          let resolved: ApprovalRequest;
          try {
            resolved = await context.agent.approvals.waitForDecision(request.id, {
              signal: signal ?? context.signal,
            });
          } catch (error) {
            const pending = context.agent.approvals.get(request.id);
            resolved =
              pending?.status === "pending"
                ? context.agent.approvals.decide(request.id, "canceled", {
                    system: true,
                    reasonCode: (signal ?? context.signal)?.aborted ? "run_canceled" : "native_request_failed",
                    error: error instanceof Error ? error.message : String(error),
                  })
                : (pending ?? request);
          }
          push([{ type: "approval.resolved", runId: context.runId, request: resolved }]);
          if (resolved.status === "approved") {
            push([
              {
                type: "run.resumed",
                runId: context.runId,
                at: new Date().toISOString(),
                reason: "Pi native tool call approved; continuing the same agent loop.",
                approvalId: request.id,
              },
            ]);
            return undefined;
          }
          return { block: { reason: `${decision.reason} Approval ${resolved.status}: ${request.id}` } };
        }
        return { block: { reason: decision.reason } };
      }
      return undefined;
    });
  }

  private createTracingStreamFn(
    input: string,
    context: PiSessionContext,
    push: (events: NativeSessionEvent[]) => void,
  ): StreamFn {
    const delegate =
      this.options.streamFn ??
      ((model, llmContext, options) => this.options.models!.streamSimple(model, llmContext, options));
    return (model, llmContext, options) => {
      push([
        {
          type: "model.requested",
          runId: context.runId,
          request: this.createModelRequestTrace(input, context, model, llmContext),
        },
      ]);
      return delegate(model, llmContext, options);
    };
  }

  private createModelRequestTrace(
    input: string,
    context: PiSessionContext,
    model: Model<any>,
    llmContext: NativeModelContext,
  ): AgentModelRequestTrace {
    const providerMessages = llmContext.messages as NativeAgentMessage[];
    const lastMessage = providerMessages.at(-1);
    const priorMessages =
      lastMessage &&
      readMessageRole(lastMessage) === "user" &&
      stringifyMessageContent((lastMessage as { content?: unknown }).content) === input
        ? providerMessages.slice(0, -1)
        : providerMessages;
    return {
      systemPrompt: llmContext.systemPrompt ?? this.runtimeContext.system,
      userInput: input,
      modelId: model.id,
      session: {
        provider: "pi",
        sessionId: this.sessionId,
        persistent: true,
        nativeSessionId: nativePiSessionId(this.sessionId),
        priorMessageCount: priorMessages.length,
        priorMessages: toModelMessages(priorMessages),
      },
      messages: toModelMessages(llmContext.messages as NativeAgentMessage[]),
      context: context.assembledContext,
      tools: this.runtimeContext.tools.map((tool) => tool.spec),
      skills: this.runtimeContext.skills,
      packs: this.runtimeContext.packs,
      capabilities: this.runtimeContext.capabilities,
    };
  }

  private handleLoopEvent(
    event: NativePiEvent,
    context: PiSessionContext,
    push: (events: NativeSessionEvent[]) => void,
  ) {
    if (event.type === "turn_start" && this.pendingSkillOverlay) {
      this.activeSkillOverlay = this.pendingSkillOverlay;
      this.pendingSkillOverlay = undefined;
      return;
    }

    if (event.type === "turn_end" && this.activeSkillOverlay) {
      const cleared = this.activeSkillOverlay;
      this.activeSkillOverlay = undefined;
      push([{ type: "skill.cleared", runId: context.runId, skillId: cleared.skillId, reason: "skill_turn_complete" }]);
    }
  }

  private async executeForkedSkill(
    invocation: InvokedSkillRecord,
    context: PiSessionContext,
    forkSessionId: string,
  ): Promise<{ forkSessionId: string; text: string }> {
    const forkRunId = `${context.runId}:skill:${Date.now()}`;
    const ephemeralRepository = new NativePiSessionRepository(undefined, this.options.cwd);
    const forkSession = new NativePiSession(
      {
        ...this.runtimeContext,
        sessionId: forkSessionId,
        requestedModelId: invocation.model,
        requestedEffort: invocation.effort,
      },
      this.options,
      forkSessionId,
      ephemeralRepository,
    );
    const forkWorkingState = new WorkingStateStore();
    forkWorkingState.restore({
      ...context.agent.workingState.get(),
      sessionId: forkSessionId,
      activePackId: invocation.packId,
      activeSkillId: invocation.skillId,
      expandedSkillIds: [invocation.skillId],
      invokedSkills: [invocation],
    });
    let text = "";

    for await (const event of forkSession.run(invocation.content, {
      runId: forkRunId,
      agent: {
        ...context.agent,
        sessionId: forkSessionId,
        workingState: forkWorkingState,
      },
      tools: context.tools,
      skills: context.skills,
      packs: context.packs,
      capabilities: context.capabilities,
      contextTokenBudget: context.contextTokenBudget,
      assembledContext: undefined,
      beforeToolCall: async (gate) => context.beforeToolCall(gate),
    })) {
      if (event.type === "model.response") {
        text = event.response.text;
      }
    }

    return {
      forkSessionId,
      text,
    };
  }
}

class CallbackCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();
  private readonly disabled = new Set<string>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly getApiKey?: AgentOptions["getApiKey"]) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const stored = this.credentials.get(providerId);
    if (stored || this.disabled.has(providerId)) return stored;
    const key = await this.getApiKey?.(providerId);
    return key ? { type: "api_key", key } : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const next = await fn(await this.read(providerId));
      if (next) {
        this.credentials.set(providerId, next);
        this.disabled.delete(providerId);
      }
      return next ?? this.credentials.get(providerId);
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(providerId, async () => {
      this.credentials.delete(providerId);
      this.disabled.add(providerId);
    });
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(providerId, settled);
    void settled.finally(() => {
      if (this.chains.get(providerId) === settled) this.chains.delete(providerId);
    });
    return operation;
  }
}

function createNativePiModels(getApiKey?: AgentOptions["getApiKey"]): MutableModels {
  const models = builtinModels({ credentials: new CallbackCredentialStore(getApiKey) });
  models.setProvider(
    createProvider({
      id: "opengrove-openai",
      name: "OpenGrove OpenAI-compatible",
      auth: { apiKey: envApiKeyAuth("OpenGrove OpenAI-compatible API key", ["OPENAI_API_KEY", "MODEL_API_KEY"]) },
      models: [],
      api: {
        "openai-completions": openAICompletionsApi(),
        "openai-responses": openAIResponsesApi(),
      },
    }),
  );
  models.setProvider(
    createProvider({
      id: "opengrove-anthropic",
      name: "OpenGrove Anthropic-compatible",
      auth: {
        apiKey: envApiKeyAuth("OpenGrove Anthropic-compatible API key", ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]),
      },
      models: [],
      api: anthropicMessagesApi(),
    }),
  );
  models.setProvider(
    createProvider({
      id: "opengrove-google",
      name: "OpenGrove Google-compatible",
      auth: { apiKey: envApiKeyAuth("OpenGrove Google-compatible API key", ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) },
      models: [],
      api: googleGenerativeAIApi(),
    }),
  );
  return models;
}

type NativeSessionEvent =
  | Extract<AgentEvent, { type: "model.requested" }>
  | Extract<AgentEvent, { type: "model.response" | "assistant.delta" | "assistant.status" }>
  | Extract<AgentEvent, { type: "skill.invoked" | "skill.loaded" | "skill.forked" | "skill.cleared" }>
  | Extract<AgentEvent, { type: "reasoning.started" | "reasoning.completed" }>
  | Extract<AgentEvent, { type: "tool.started" | "tool.progress" | "tool.finished" }>
  | Extract<AgentEvent, { type: "approval.requested" | "approval.resolved" | "run.paused" | "run.resumed" }>
  | { type: "error"; runId: string; message: string }
  | Extract<AgentEvent, { type: "runtime.diagnostic" }>;

function piImageContent(context: PiSessionContext): ImageContent[] | undefined {
  const images = imageAttachmentsWithDataUrl(context.agent.page?.attachments).map(({ image }) => ({
    type: "image" as const,
    data: image.base64,
    mimeType: image.mediaType,
  }));
  return images.length ? images : undefined;
}

function createPiBudgetMessage(text: string, images: ImageContent[] | undefined): UserMessage {
  return {
    role: "user",
    content: images?.length ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text,
    timestamp: Date.now(),
  };
}

function piCompactionSettings(contextWindow: number, keepRecentTokens?: number): CompactionSettings {
  const normalizedWindow = Math.max(1, Math.floor(contextWindow));
  const reserveTokens = Math.min(
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    Math.max(1, Math.floor(normalizedWindow * 0.2)),
  );
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens: Math.min(
      Math.max(1, Math.floor(keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens)),
      Math.max(1, normalizedWindow - reserveTokens * 2),
    ),
  };
}

export function piCompactionSettingsForRequest(
  modelContextWindow: number,
  requestedMaxTokens?: number,
): CompactionSettings {
  const targetContextWindow =
    requestedMaxTokens !== undefined
      ? Math.min(modelContextWindow, Math.max(1, requestedMaxTokens))
      : modelContextWindow;
  return piCompactionSettings(targetContextWindow);
}

function toNativeTools(
  tools: ToolDefinition[],
  context: PiSessionContext,
  nativeToolNames: Map<string, string>,
  hooks: {
    onSkillInvoked(invocation: InvokedSkillRecord): void | Promise<void>;
    runForkedSkill(invocation: InvokedSkillRecord): Promise<{ forkSessionId: string; text: string }>;
  },
): AgentTool[] {
  return tools.map((tool): AgentTool => {
    const capabilityId = findCapabilityId(tools, context, tool.spec.id);

    return {
      name: toNativeToolName(nativeToolNames, tool.spec.id),
      label: tool.spec.title,
      description: tool.spec.description,
      parameters: tool.spec.input.schema as unknown as TSchema,
      async execute(_toolCallId, params, signal, onUpdate) {
        const result = await tool.execute(params as JsonObject, {
          runId: context.runId,
          capabilityId,
          memory: context.agent.memory,
          artifacts: context.agent.artifacts,
          workingState: context.agent.workingState,
          approvals: context.agent.approvals,
          skills: context.agent.skills,
          packs: context.agent.packs,
          policy: {
            mode: "allow",
            reason: "Execution reached this adapter only after Pi's native beforeToolCall gate approved the call.",
          },
          signal,
          onProgress: (update) =>
            onUpdate?.({
              content: [{ type: "text", text: stringifyProgress(update) }],
              details: update,
            }),
        });

        if (!result.ok) {
          throw new Error(result.error ?? "Tool failed");
        }

        if (tool.spec.id === "skill.invoke") {
          const invocation = readInvokedSkillFromWorkingState(context.agent.workingState.get().invokedSkills, params);
          if (invocation) {
            await hooks.onSkillInvoked(invocation);
            if (invocation.context === "fork") {
              const forked = await hooks.runForkedSkill(invocation);
              return {
                content: [{ type: "text", text: forked.text || `Forked skill /${invocation.skillName} completed.` }],
                details: {
                  ...(isJsonObject(result.value) ? result.value : {}),
                  forkSessionId: forked.forkSessionId,
                  forkedResult: forked.text,
                },
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Loaded skill /${invocation.skillName}. Continue using the injected skill instructions.`,
                },
              ],
              details: result.value,
            };
          }
        }

        return {
          content: [{ type: "text", text: stringifyToolResult(result) }],
          details: result,
        };
      },
    };
  });
}

const PI_CODING_TOOL_NAMES = new Set(["read", "write", "edit", "bash"]);

function createPiCodingTools(): AgentHarnessTool<ExecutionToolContext>[] {
  return [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
}

function toHarnessTool(tool: AgentTool): AgentHarnessTool<ExecutionToolContext> {
  return {
    ...tool,
    execute: (id, params, onUpdate, _env, _invocation, context) =>
      tool.execute(id, params, context.abortSignal, (update) => onUpdate?.(update)),
  };
}

function toPiAgentEvent(event: HarnessEvent): NativePiEvent | undefined {
  switch (event.type) {
    case "message_start":
    case "message_end":
      return { type: event.type, message: event.message };
    case "message_update":
      return { type: "message_update", message: event.message, assistantMessageEvent: event.event };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end", message: event.message, toolResults: event.toolResults };
    case "tool_start":
      return { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case "tool_update":
      return {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: undefined,
        partialResult: event.partialResult,
      };
    case "tool_end":
      return {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    default:
      return undefined;
  }
}

function bridgePiStream(
  streamFn: StreamFn,
  model: Parameters<Models["streamSimple"]>[0],
  context: NativeModelContext,
  options: Parameters<Models["streamSimple"]>[2],
) {
  const result = streamFn(model, context, options);
  if (Symbol.asyncIterator in result) return result;
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      const stream = await result;
      for await (const event of stream) output.push(event);
      output.end(await stream.result());
    } catch (error) {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        model: model.id,
        provider: model.provider,
        stopReason: "error",
        timestamp: Date.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      output.push({ type: "error", reason: "error", error: message });
      output.end(message);
    }
  })();
  return output;
}

function piApprovalKind(toolId: string): ApprovalKind {
  if (toolId === "bash") return "command";
  if (toolId === "write" || toolId === "edit") return "file_change";
  return "tool";
}

class PiNativeMessageProjector {
  private reasoningSequence = 0;
  private readonly completedNonToolMessages: AssistantMessage[] = [];
  private readonly reasoningStartedAtByContentIndex = new Map<number, number>();
  private readonly reasoningElapsedMsByContentIndex = new Map<number, number>();

  constructor(private readonly runId: string) {}

  project(event: NativePiEvent): PiNativeMessageProjection {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.reasoningStartedAtByContentIndex.clear();
          this.reasoningElapsedMsByContentIndex.clear();
        }
        return { events: [] };
      case "message_update": {
        // Pi text/thinking deltas describe an assistant message whose final role is
        // not known until its native boundary. Keep them inside the projector.
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_start" || update.type === "thinking_delta") {
          if (!this.reasoningStartedAtByContentIndex.has(update.contentIndex)) {
            this.reasoningStartedAtByContentIndex.set(update.contentIndex, Date.now());
          }
        }
        if (update.type === "thinking_end") {
          const startedAt = this.reasoningStartedAtByContentIndex.get(update.contentIndex);
          if (startedAt !== undefined) {
            this.reasoningElapsedMsByContentIndex.set(update.contentIndex, Math.max(0, Date.now() - startedAt));
          }
        }
        return { events: [] };
      }
      case "message_end":
        if (event.message.role !== "assistant") return { events: [] };
        return { events: this.completeMessage(event.message) };
      case "agent_end":
        return this.completeAgent(event.messages);
      default:
        return { events: [] };
    }
  }

  private completeMessage(message: AssistantMessage): NativeSessionEvent[] {
    const completedAt = Date.now();
    const events = message.content.flatMap((item, contentIndex) => {
      if (item.type !== "thinking" || !item.thinking.trim()) return [];
      const startedAt = this.reasoningStartedAtByContentIndex.get(contentIndex);
      const elapsedMs =
        this.reasoningElapsedMsByContentIndex.get(contentIndex) ??
        (startedAt === undefined ? undefined : Math.max(0, completedAt - startedAt));
      return createPiReasoningActivity(
        this.runId,
        item.thinking,
        item.redacted === true,
        ++this.reasoningSequence,
        elapsedMs,
      );
    });
    this.reasoningStartedAtByContentIndex.clear();
    this.reasoningElapsedMsByContentIndex.clear();
    const text = readAssistantText(message);
    if (assistantHasToolCall(message)) {
      if (text) events.push(createPiAssistantStatus(this.runId, text, message));
    } else {
      this.completedNonToolMessages.push(message);
    }
    return events;
  }

  abort(streamingMessage: NativeAgentMessage | undefined): PiNativeMessageProjection {
    if (
      streamingMessage?.role === "assistant" &&
      readAssistantText(streamingMessage) &&
      !assistantHasToolCall(streamingMessage) &&
      !this.completedNonToolMessages.some((message) => sameAssistantMessage(message, streamingMessage))
    ) {
      this.completedNonToolMessages.push(streamingMessage);
    }
    return this.completeAgent([...this.completedNonToolMessages]);
  }

  private completeAgent(messages: NativeAgentMessage[]): PiNativeMessageProjection {
    const terminalMessage = [...messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant" && !assistantHasToolCall(message));
    const events: NativeSessionEvent[] = [];
    for (const message of this.completedNonToolMessages) {
      const text = readAssistantText(message);
      if (!text) continue;
      if (terminalMessage && sameAssistantMessage(message, terminalMessage)) {
        events.push({ type: "assistant.delta", runId: this.runId, text });
      } else {
        events.push(createPiAssistantStatus(this.runId, text, message));
      }
    }
    this.completedNonToolMessages.length = 0;
    return { events, ...(terminalMessage ? { terminalMessage } : {}) };
  }
}

interface PiNativeMessageProjection {
  events: NativeSessionEvent[];
  terminalMessage?: AssistantMessage;
}

function mapNativeToolEvent(
  event: NativePiEvent,
  runId: string,
  nativeToolNames: Map<string, string>,
): NativeSessionEvent[] {
  switch (event.type) {
    case "tool_execution_start":
      return [
        {
          type: "tool.started",
          runId,
          toolId: toOriginalToolId(nativeToolNames, event.toolName),
          callId: event.toolCallId,
          input: asJsonValue(event.args),
        },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool.finished",
          runId,
          toolId: toOriginalToolId(nativeToolNames, event.toolName),
          callId: event.toolCallId,
          result: normalizeNativeToolResult(event.result, event.isError),
        },
      ];
    case "tool_execution_update":
      return [
        {
          type: "tool.progress",
          runId,
          toolId: toOriginalToolId(nativeToolNames, event.toolName),
          callId: event.toolCallId,
          update: asJsonValue(readDetails(event.partialResult) ?? event.partialResult),
        },
      ];
    default:
      return [];
  }
}

function createNativeToolNameMap(tools: ToolDefinition[]): Map<string, string> {
  return new Map(tools.map((tool, index) => [toSafeNativeToolName(tool.spec.id, index), tool.spec.id]));
}

function toNativeToolName(nativeToolNames: Map<string, string>, toolId: string): string {
  for (const [nativeName, originalId] of nativeToolNames) {
    if (originalId === toolId) {
      return nativeName;
    }
  }
  return toolId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function toSafeNativeToolName(toolId: string, index: number): string {
  const prefix = `opengrove_${index}_`;
  const slug = toolId.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
  return `${prefix}${slug}`.slice(0, 64);
}

function toOriginalToolId(nativeToolNames: Map<string, string>, nativeName: string): string {
  return nativeToolNames.get(nativeName) ?? nativeName;
}

function readAssistantText(message: { content?: unknown }): string {
  const content = message.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) =>
      item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item
        ? String(item.text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("");
}

function createPiReasoningActivity(
  runId: string,
  text: string,
  redacted: boolean,
  sequence: number,
  elapsedMs?: number,
): NativeSessionEvent[] {
  const id = `${runId}:reasoning:${sequence}`;
  return [
    { type: "reasoning.started", runId, reasoning: { id, kind: "native", kernelId: "pi" } },
    {
      type: "reasoning.completed",
      runId,
      reasoning: {
        id,
        kind: "native",
        kernelId: "pi",
        text: text.trim(),
        ...(redacted ? { redacted: true } : {}),
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
      },
    },
  ];
}

function assistantHasToolCall(message: AssistantMessage): boolean {
  return message.content.some((item) => item.type === "toolCall");
}

function sameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean {
  if (left === right) return true;
  if (left.responseId && right.responseId) return left.responseId === right.responseId;
  return (
    left.timestamp === right.timestamp &&
    left.model === right.model &&
    left.stopReason === right.stopReason &&
    readAssistantText(left) === readAssistantText(right)
  );
}

function createPiAssistantStatus(
  runId: string,
  text: string,
  message: AssistantMessage,
): Extract<AgentEvent, { type: "assistant.status" }> {
  return {
    type: "assistant.status",
    runId,
    at: new Date().toISOString(),
    text,
    data: {
      source: "pi-agent-core",
      kind: "agent_message",
      phase: "commentary",
      stopReason: message.stopReason,
    },
  };
}

function toUsageStats(message: AssistantMessage, model: Model<any>) {
  const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
  return {
    inputTokens,
    outputTokens: message.usage.output,
    totalTokens: message.usage.totalTokens,
    costUsd: message.usage.cost.total,
    contextWindowSize: model.contextWindow,
    contextUsedTokens: inputTokens,
  };
}

function createPiMessageDiagnostic(
  runId: string,
  message: AssistantMessage,
): Extract<AgentEvent, { type: "runtime.diagnostic" }> {
  return {
    type: "runtime.diagnostic",
    runId,
    at: new Date().toISOString(),
    name: "pi.message.completed",
    data: {
      provider: message.provider,
      model: message.model,
      api: message.api,
      stopReason: message.stopReason,
      ...(message.rawStopReason ? { rawStopReason: message.rawStopReason } : {}),
      ...(message.responseId ? { responseId: message.responseId } : {}),
      ...(message.responseModel ? { responseModel: message.responseModel } : {}),
      ...(message.usage.reasoning !== undefined ? { reasoningTokens: message.usage.reasoning } : {}),
      ...(message.diagnostics ? { diagnostics: asJsonValue(message.diagnostics) } : {}),
    },
  };
}

function normalizeNativeToolResult(result: unknown, isError: boolean): ToolResult {
  const value = asJsonValue(readDetails(result) ?? result);
  return {
    ok: !isError,
    value,
    error: isError ? readTextContent(result) || "Tool failed" : undefined,
  };
}

function enrichApprovalInput(_toolId: string, args: unknown, _agent: AgentContext): JsonValue {
  const input = asJsonObject(args);
  return input;
}

function findCapabilityId(tools: ToolDefinition[], context: PiSessionContext, toolId: string): string | undefined {
  const tool = tools.find((candidate) => candidate.spec.id === toolId);
  return context.capabilities.find((capability) => capability.tools.some((candidate) => candidate.id === tool?.spec.id))
    ?.id;
}

function stringifyToolResult(result: ToolResult): string {
  if (typeof result.value === "string") {
    return result.value;
  }
  return JSON.stringify(result.value ?? { ok: result.ok, error: result.error });
}

function stringifyProgress(update: JsonValue): string {
  return typeof update === "string" ? update : safeJson(update);
}

function readDetails(result: unknown): unknown {
  return result && typeof result === "object" && "details" in result
    ? (result as { details?: unknown }).details
    : undefined;
}

function readTextContent(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) {
    return "";
  }

  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function resolveModel(
  model: Model<any> | ((requestedModelId?: string) => Model<any>),
  requestedModelId?: string,
): Model<any> {
  return typeof model === "function" ? model(requestedModelId) : model;
}

function resolveThinkingLevel(
  thinkingLevel: ThinkingLevel | ((requestedEffort?: string) => ThinkingLevel) | undefined,
  requestedEffort?: string,
): ThinkingLevel {
  if (typeof thinkingLevel === "function") {
    return thinkingLevel(requestedEffort);
  }
  if (thinkingLevel) return thinkingLevel;
  switch (requestedEffort?.trim().toLowerCase()) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return requestedEffort.trim().toLowerCase() as ThinkingLevel;
    case "extra-high":
    case "extra_high":
      return "xhigh";
    case "maximum":
      return "max";
    default:
      return "off";
  }
}

function toModelMessages(messages: NativeAgentMessage[]): ModelMessage[] {
  return convertNativeSessionMessages(messages)
    .map((message) => toModelMessage(message))
    .filter((message): message is ModelMessage => Boolean(message));
}

function toModelMessage(message: NativeAgentMessage): ModelMessage | undefined {
  const role = readMessageRole(message);
  if (role === "user") {
    return {
      role: "user",
      content: stringifyMessageContent((message as { content?: unknown }).content),
    };
  }

  if (role === "assistant") {
    return {
      role: "assistant",
      content: stringifyMessageContent((message as { content?: unknown }).content),
    };
  }

  if (role === "toolResult") {
    return {
      role: "tool",
      name: readMessageToolName(message),
      content: stringifyMessageContent((message as { content?: unknown }).content),
    };
  }

  return undefined;
}

function readMessageRole(message: NativeAgentMessage): string {
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : "";
}

function readMessageToolName(message: NativeAgentMessage): string | undefined {
  const name = (message as { toolName?: unknown }).toolName;
  return typeof name === "string" ? name : undefined;
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return content === undefined ? "" : safeJson(content);
  }

  return content
    .map((part) => stringifyContentPart(part))
    .filter(Boolean)
    .join("\n");
}

function stringifyContentPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }

  if (!part || typeof part !== "object") {
    return part === undefined ? "" : String(part);
  }

  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }

  return safeJson(part);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function createSkillSteeringMessage(invocation: InvokedSkillRecord): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: buildSkillSteeringText(invocation) }],
    timestamp: Date.now(),
  };
}

function createContextSteeringMessage(context: ContextEnvelope): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: context.promptBlock }],
    timestamp: Date.now(),
  };
}

function readInvokedSkillFromWorkingState(
  invokedSkills: InvokedSkillRecord[],
  params: unknown,
): InvokedSkillRecord | undefined {
  const requestedSkill =
    params && typeof params === "object" && "skill" in params && typeof params.skill === "string"
      ? params.skill
          .trim()
          .replace(/^\//, "")
          .replace(/^skill\./, "")
      : "";
  return invokedSkills.find(
    (item) =>
      item.skillName === requestedSkill ||
      item.skillId === requestedSkill ||
      item.skillId === `skill.${requestedSkill}`,
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
