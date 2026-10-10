import { createHash } from "node:crypto";
import { CodexAgent, type TurnOutcome } from "@open-grove/agent-host/codex";
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
  AgentSteerRequest,
  AgentSteerResult,
  AgentTurnRequest,
  ApprovalRequest,
  JsonObject,
  JsonValue,
} from "../core.js";
import { createCodexRpcCaptureRecorder } from "./codex-rpc-capture.js";
import { CodexAppServerClient } from "./codex/app-server-client.js";
import { AsyncEventQueue } from "./codex/async-event-queue.js";
import {
  handleCodexApprovalRequest,
  handleCodexElicitationRequest,
  handleCodexUserInputRequest,
  isCodexApprovalRequest,
} from "./codex/approval-bridge.js";
import { resolveRuntimeRunId } from "./run-id.js";
import { createCodexDynamicToolBridge, readDynamicToolCallParams } from "./codex/dynamic-tool-bridge.js";
import { CodexEventProjector } from "./codex/event-projector.js";
import { asJsonValue, isJsonObject } from "./codex/json.js";
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
  toCodexSandboxPolicy,
} from "./codex/policy.js";
import { contextBudgetDiagnostic, resolveContextTokenBudget } from "./context-token-budget.js";
import {
  CODEX_THREAD_CONFIG_OVERRIDES,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  stripDisableFeatureFlags,
  unknownCodexFeatureFlagsFromStderr,
  type CodexModelProviderRuntimeConfig,
  type CodexRuntimeOptions,
  type CodexThreadBinding,
  type CodexTurnInputItem,
} from "./codex/types.js";

export { resolveCodexCommandPath } from "./codex/command-path.js";
export type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexRuntimeOptions,
  CodexSandboxMode,
} from "./codex/types.js";

type ActiveCodexTurn = { agent: CodexAgent; sessionId: string };

export class CodexRuntime implements AgentRuntime {
  private readonly bindings = new Map<string, CodexThreadBinding>();
  private readonly agents = new Map<string, CodexAgent>();
  private readonly activeTurns = new Map<string, ActiveCodexTurn>();
  private bindingsLoaded = false;

  constructor(private readonly options: CodexRuntimeOptions = {}) {}

  async compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    this.loadBindings();
    const entry = [...this.bindings.entries()]
      .filter(([key]) => key.startsWith(`${request.threadId}:`))
      .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!entry) return { ok: false, compacted: false, error: "session_not_found" };
    const [sessionId, binding] = entry;
    const agent = this.agentFor(this.options.env);
    let compacted = false;
    let outcome: TurnOutcome | undefined;
    for await (const event of agent.run({
      sessionId,
      runId: request.runId,
      cwd: binding.cwd ?? this.options.cwd ?? process.cwd(),
      instructions: "",
      input: "",
      mode: "compact",
      signal: request.signal,
      bindingFingerprint: binding.runtimeBindingFingerprint ?? "",
    })) {
      if (event.type === "native.notification") {
        const params = isJsonObject(event.notification.params) ? event.notification.params : undefined;
        const item = isJsonObject(params?.item) ? params.item : undefined;
        if (event.notification.method === "item/completed" && item?.type === "contextCompaction") compacted = true;
      }
      if (event.type === "turn.finished") outcome = event.outcome;
    }
    return compacted && outcome?.status === "completed"
      ? { ok: true, compacted: true }
      : {
          ok: false,
          compacted: false,
          error: outcome?.error ?? "compaction_not_confirmed",
          ...(outcome?.outcomeUnknown ? { outcomeUnknown: true } : {}),
        };
  }

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    const runId = resolveRuntimeRunId(request.runId);
    const cwd = this.options.cwd ?? process.cwd();
    const model = normalizeCodexModelId(request.requestedModelId, this.options.configuredModel);
    const modelProvider = this.options.configuredModelProvider?.trim() || undefined;
    const sandbox = resolveCodexSandboxMode(request, this.options.sandbox);
    const approvalPolicy = resolveCodexApprovalPolicy(request.accessMode, this.options.approvalPolicy);
    const approvalsReviewer = resolveCodexApprovalsReviewer(request.accessMode, this.options.approvalsReviewer);
    const reasoningEffort = resolveReasoningEffort(request.requestedEffort);
    const serviceTier =
      this.options.allowServiceTier === false
        ? undefined
        : resolveCodexServiceTier(request.responseSpeed, this.options.serviceTier);
    const runtimeEnv = mergeRuntimeEnv(this.options.env, request.runtimeEnv);
    const runtimeEnvFingerprint = envFingerprint(runtimeEnv);
    const contextBudget = resolveContextTokenBudget(
      request.contextTokenBudget,
      this.options.providerConfig?.modelContextWindows?.[model ?? ""] ?? readCodexModelContextWindow(model, runtimeEnv),
    );
    const threadConfig = codexThreadConfig(this.options.providerConfig, {
      model,
      reasoningEffort,
      reasoningSummary: reasoningEffort ? "detailed" : undefined,
      serviceTier,
      contextTokenBudget: contextBudget.budgetSource === "configured" ? contextBudget.effectiveBudget : undefined,
    });
    if (request.accessMode && sandbox === "workspace-write") {
      threadConfig["sandbox_workspace_write.network_access"] = false;
    }
    const staticDeveloperInstructions = buildCodexDeveloperInstructions();
    const developerInstructions = buildCodexDeveloperInstructions(request);
    const turnInput = buildCodexTurnInput(request);
    const turnInputItems = buildCodexTurnInputItems(request, turnInput);
    const exposeDynamicTools = shouldExposeCodexDynamicTools(request);
    const controller = new AbortController();
    const toolBridge = createCodexDynamicToolBridge(
      exposeDynamicTools
        ? { ...request, signal: controller.signal }
        : { ...request, signal: controller.signal, tools: [], capabilities: [] },
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

    const agent = this.agentFor(runtimeEnv);
    const runtimeBindingFingerprint = codexRuntimeBindingFingerprint({
      base: this.options.runtimeBindingFingerprint,
      model,
      modelProvider,
      dynamicToolsFingerprint: toolBridge.fingerprint,
      developerInstructionsFingerprint: textFingerprint(staticDeveloperInstructions),
      cwd,
      runtimeEnvFingerprint,
    });
    const sessionId = `${request.context.sessionId || "local"}:${runtimeBindingFingerprint}`;
    const activeTurn = { agent, sessionId };
    const activeKeys = [request.context.sessionId ? `thread:${request.context.sessionId}` : "", `run:${runId}`].filter(
      Boolean,
    );
    const queue = new AsyncEventQueue<AgentEvent>();
    let projector: CodexEventProjector | undefined;
    let pauseRequest: ApprovalRequest | undefined;
    let outcome: TurnOutcome | undefined;
    let compactionTriggered = false;
    let compactionSucceeded = false;
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    const forward = async () => {
      try {
        for await (const event of agent.run({
          sessionId,
          runId,
          cwd,
          instructions: developerInstructions,
          input: turnInputItems,
          tools: toolBridge.specs,
          signal: controller.signal,
          bindingFingerprint: runtimeBindingFingerprint,
          mode: compactTurn ? "compact" : "turn",
          thread: {
            model,
            ...(modelProvider ? { modelProvider } : {}),
            sandbox,
            approvalPolicy,
            approvalsReviewer,
            config: threadConfig,
            serviceName: "OpenGrove",
            threadSource: this.options.threadSource ?? "subagent",
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(serviceTier ? { serviceTier } : {}),
          },
          turn: {
            approvalPolicy,
            approvalsReviewer,
            ...(request.accessMode ? { sandboxPolicy: toCodexSandboxPolicy(sandbox) } : {}),
            ...(request.structuredOutputSchema ? { outputSchema: request.structuredOutputSchema } : {}),
          },
          beforeTurn: async (client, native) => {
            await refreshCodexNativeSkillList(client, cwd, { ...request, signal: native.signal });
            const diagnostic = await this.applyThreadGoal(client, native.threadId, request);
            if (diagnostic) queue.push(diagnostic);
          },
          onRequest: async (incoming, native) => {
            const serverRequest = {
              ...incoming,
              params: incoming.params === undefined ? undefined : asJsonValue(incoming.params),
            };
            queue.push({
              type: "runtime.diagnostic",
              runId,
              at: new Date().toISOString(),
              name: "codex.app_server.request",
              data: { method: serverRequest.method, hasParams: serverRequest.params !== undefined },
            });
            const currentRequest = { ...request, signal: native.signal };
            const context = { threadId: native.threadId, turnId: native.turnId, runId, request: currentRequest, queue };
            if (isCodexApprovalRequest(serverRequest.method)) return handleCodexApprovalRequest(serverRequest, context);
            if (serverRequest.method === "item/tool/requestUserInput")
              return handleCodexUserInputRequest(serverRequest, context);
            if (serverRequest.method === "mcpServer/elicitation/request")
              return handleCodexElicitationRequest(serverRequest, context);
            if (serverRequest.method === "item/tool/call") {
              const call = readDynamicToolCallParams(serverRequest.params);
              if (!call) return undefined;
              return (await toolBridge.handleToolCall(call, {
                queue,
                onPause: (approval) => {
                  pauseRequest = approval;
                },
              })) as unknown as JsonValue;
            }
            return undefined;
          },
        })) {
          if (event.type === "session.bound") {
            projector = new CodexEventProjector(runId, event.threadId, queue);
            for (const key of activeKeys) this.activeTurns.set(key, activeTurn);
            queue.push({
              type: "model.requested",
              runId,
              request: {
                systemPrompt: developerInstructions,
                userInput: request.input,
                modelId: model,
                session: {
                  provider: "codex",
                  sessionId: event.threadId,
                  persistent: true,
                  priorMessageCount: 0,
                  priorMessages: [],
                },
                context: request.assembledContext,
                tools: request.tools.map((tool) => tool.spec),
                skills: request.skills ?? [],
                packs: request.packs ?? [],
                capabilities: request.capabilities ?? [],
              },
            });
            queue.push({
              type: "runtime.diagnostic",
              runId,
              at: new Date().toISOString(),
              name: "codex.session.bound",
              data: { threadId: event.threadId, resumed: event.resumed },
            });
            queue.push({
              type: "runtime.diagnostic",
              runId,
              at: new Date().toISOString(),
              name: "codex.policy.configured",
              data: {
                accessMode: request.accessMode ?? "default",
                sandbox,
                approvalPolicy,
                approvalsReviewer,
                responseSpeed: request.responseSpeed ?? "standard",
                ...(reasoningEffort ? { reasoningEffort } : {}),
                ...(serviceTier ? { serviceTier } : {}),
                threadId: event.threadId,
                appliedTo: "thread",
              },
            });
          }
          if (event.type === "native.notification")
            projector?.handleNotification(
              {
                ...event.notification,
                params: event.notification.params === undefined ? undefined : asJsonValue(event.notification.params),
              },
              event.turnId,
            );
          if (event.type === "turn.finished") outcome = event.outcome;
        }
      } catch (error) {
        outcome = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          outcomeUnknown: true,
        };
      } finally {
        queue.close();
      }
    };
    const producer = forward();
    try {
      for await (const event of queue) {
        if (event.type === "compaction.started") compactionTriggered = true;
        if (event.type === "compaction.finished") {
          compactionTriggered = true;
          compactionSucceeded = true;
        }
        if (event.type === "approval.requested" && event.request.resume?.type !== "kernel.native")
          pauseRequest = event.request;
        if (event.type === "approval.resolved" && pauseRequest?.id === event.request.id) pauseRequest = undefined;
        yield event;
      }
      const baseFinalText = projector?.finalText() ?? "";
      const correction = imageGenerationTruthCorrection(request, baseFinalText, projector?.generatedImageCount() ?? 0);
      const finalText = [baseFinalText, correction].filter(Boolean).join("\n\n");
      if (correction && projector?.didStreamAssistantText())
        yield { type: "assistant.delta", runId, text: `\n\n${correction}` };
      else if (finalText && !projector?.didStreamAssistantText())
        yield { type: "assistant.delta", runId, text: finalText };
      const error = projector?.errorMessage() ?? outcome?.error;
      if (error) yield { type: "error", runId, message: error };
      const usage = projector?.usage();
      yield { type: "model.response", runId, response: { text: finalText, usage } };
      yield contextBudgetDiagnostic({
        runId,
        kernel: "codex",
        ...resolveContextTokenBudget(request.contextTokenBudget, usage?.contextWindowSize),
        usageSource: usage?.contextUsedTokens !== undefined ? "native" : "unavailable",
        enforcementMode: "native-auto",
        contextUsedTokens: usage?.contextUsedTokens,
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
        outcome:
          outcome?.status === "completed" && !projector?.errorMessage()
            ? { taskState: "TASK_STATE_COMPLETED" }
            : outcome?.status === "cancelled"
              ? { taskState: "TASK_STATE_CANCELED", reasonCode: "user_canceled", retryable: false }
              : {
                  taskState: "TASK_STATE_FAILED",
                  reasonCode: "codex_runtime_failed",
                  ...(outcome?.outcomeUnknown ? { outcomeUnknown: true } : {}),
                },
      };
    } finally {
      controller.abort();
      request.signal?.removeEventListener("abort", abort);
      await producer;
      for (const key of activeKeys) if (this.activeTurns.get(key) === activeTurn) this.activeTurns.delete(key);
    }
  }

  async steerTurn(request: AgentSteerRequest): Promise<AgentSteerResult> {
    if (!request.instruction.trim()) return { ok: false, guided: false, error: "instruction_required" };
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const active = this.activeTurns.get(`run:${request.runId}`) ?? this.activeTurns.get(`thread:${request.threadId}`);
      if (active)
        try {
          await active.agent.steer(active.sessionId, request.instruction);
          return { ok: true, guided: true };
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "active_turn_not_ready")
            return { ok: false, guided: false, error: String(error) };
        }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ok: false, guided: false, error: "active_turn_not_found" };
  }

  private agentFor(env?: NodeJS.ProcessEnv): CodexAgent {
    const key = envFingerprint(env);
    let agent = this.agents.get(key);
    if (!agent) {
      agent = new CodexAgent({
        connect: () =>
          this.startAppServerWithFlagFallback(
            this.options.command ?? "codex",
            this.options.args ?? DEFAULT_CODEX_APP_SERVER_ARGS,
            { ...process.env, ...env, TERM: env?.TERM ?? process.env.TERM ?? "dumb" },
            createCodexRpcCaptureRecorder(this.options.rpcCapture, env),
          ),
        requestTimeoutMs: this.options.requestTimeoutMs,
        bindings: {
          get: async (sessionId) => {
            this.loadBindings();
            const binding = this.bindings.get(sessionId);
            return binding
              ? { threadId: binding.threadId, fingerprint: binding.runtimeBindingFingerprint ?? "" }
              : undefined;
          },
          set: async (sessionId, next) => {
            this.loadBindings();
            const previous = this.bindings.get(sessionId);
            this.bindings.set(sessionId, {
              ...previous,
              threadId: next.threadId,
              runtimeBindingFingerprint: next.fingerprint,
              dynamicToolsFingerprint: previous?.dynamicToolsFingerprint ?? "",
              cwd: previous?.cwd ?? this.options.cwd ?? process.cwd(),
              model: previous?.model ?? this.options.configuredModel,
              createdAt: previous?.createdAt ?? new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            this.saveBindings();
          },
        },
      });
      this.agents.set(key, agent);
    }
    return agent;
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

  // Newer Codex builds remove `--disable` feature flags that older ones require. If the
  // first launch aborts with `Unknown feature flag: <name>`, drop exactly those flags and
  // retry once, so a single binary works across versions without a hard-coded cutoff.
  private async startAppServerWithFlagFallback(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    rpcCapture: ReturnType<typeof createCodexRpcCaptureRecorder>,
  ): Promise<CodexAppServerClient> {
    const client = await CodexAppServerClient.start({ command, args, env, rpcCapture });
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
      const retried = await CodexAppServerClient.start({ command, args: reducedArgs, env, rpcCapture });
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
    for (const agent of this.agents.values()) void agent.close();
    this.agents.clear();
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
    model?: string;
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
  const contextWindow = provider.modelContextWindows?.[overrides.model ?? ""];
  return {
    ...config,
    ...(contextWindow ? { model_context_window: contextWindow } : {}),
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

function isVolatileOpenGroveRuntimeEnvKey(key: string): boolean {
  return key === "OPENGROVE_ROOM_LEDGER_CAPABILITY_JSON" || key === "OPENGROVE_SOURCE_ROOM_ID";
}

function isCodexCompactCommand(input: string): boolean {
  return input.trim() === "/compact";
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
