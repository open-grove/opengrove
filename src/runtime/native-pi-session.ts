import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import {
  type Api,
  type Model,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type MutableModels,
  createProvider,
  envApiKeyAuth,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PiAgent, type PiAgentOptions } from "@open-grove/agent-host/pi";
import { AsyncEventQueue } from "./codex/async-event-queue.js";
import {
  WorkingStateStore,
  type AgentEvent,
  type AgentSessionTrace,
  type JsonValue,
  type JsonObject,
  type ModelMessage,
  type ApprovalRequest,
} from "../core.js";
import {
  createNativePiSessionFactory as createLegacyFactory,
  createNativeToolNameMap,
  toNativeTools,
  type NativePiSessionOptions as LegacyOptions,
} from "./native-pi-session.compat.js";
import { NativePiSessionRepository } from "./pi-session-repository.js";
import type { PiSessionFactory, PiSessionContext } from "./pi-runtime.js";
import { imageAttachmentsWithDataUrl } from "./media-input.js";
import { contextBudgetDiagnostic, resolveContextTokenBudget, estimateTextTokens } from "./context-token-budget.js";
import { buildSkillSteeringText } from "../skills/runtime.js";

export interface NativePiSessionOptions extends Omit<PiAgentOptions, "model" | "bindings"> {
  model: Model<Api> | ((id?: string) => Model<Api>);
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}
/** Existing 0.85 JSONL sessions retain their native engine; all new sessions use Pi 1.1 durable. */
export function createNativePiSessionFactory(options: NativePiSessionOptions): PiSessionFactory {
  const models = options.models ?? createModels(options.getApiKey);
  const latest = new PiAgent({ ...options, models });
  const legacyRepository = new NativePiSessionRepository(options.sessionRoot, options.cwd);
  let legacyIds: Promise<Set<string>> | undefined;
  const isLegacy = async (id: string) =>
    (await (legacyIds ??= legacyRepository.list().then((items) => new Set(items.map((item) => item.sessionId))))).has(
      id,
    );
  // Protocol boundary: model identities/costs are plain provider data shared by both Pi generations.
  // Never send a new durable transcript through the old storage API or vice versa.
  const legacy = createLegacyFactory({
    cwd: options.cwd,
    sessionRoot: options.sessionRoot,
    getApiKey: options.getApiKey,
    streamFn: options.streamFn as unknown as LegacyOptions["streamFn"],
    model: options.model as unknown as LegacyOptions["model"],
  });
  const factory: PiSessionFactory = (runtime) => {
    const trace = async (): Promise<AgentSessionTrace> => {
      const conversation = await latest.conversation(runtime.sessionId);
      const messages = conversation ? (await conversation.context(background)).messages : [];
      return {
        provider: "pi",
        sessionId: runtime.sessionId,
        nativeSessionId: conversation ? String(conversation.id) : undefined,
        persistent: !!options.sessionRoot,
        priorMessageCount: messages.length,
        priorMessages: projectMessages(messages),
      };
    };
    return {
      emitsModelRequests: true,
      trace: async (input) => ((await isLegacy(runtime.sessionId)) ? legacy(runtime).trace?.(input) : trace()),
      compact: async (request) =>
        (await isLegacy(runtime.sessionId))
          ? legacy.compactSession!(request)
          : latest.compact(runtime.sessionId, request.reason),
      async *run(input, context) {
        if (await isLegacy(runtime.sessionId)) {
          yield* legacy(runtime).run(input, context);
          return;
        }
        const controller = new AbortController();
        const abort = () => controller.abort(context.signal?.reason);
        context.signal?.addEventListener("abort", abort, { once: true });
        if (context.signal?.aborted) abort();
        const queue = new AsyncEventQueue<AgentEvent>();
        const nativeNames = createNativeToolNameMap(runtime.tools);
        const originalName = (name: string) => nativeNames.get(name) ?? name;
        const push = (event: AgentEvent) => queue.push(event);
        const productTools = toNativeTools(runtime.tools, context, nativeNames, {
          onSkillInvoked: async (invocation) => {
            const manifest =
              context.agent.skills.get(invocation.skillId) ?? context.agent.skills.get(invocation.skillName);
            if (manifest) push({ type: "skill.invoked", runId: context.runId, skill: manifest, invocation });
            push({
              type: "skill.loaded",
              runId: context.runId,
              skillId: invocation.skillId,
              contentPreview: invocation.contentPreview,
              allowedTools: [...invocation.allowedTools],
              model: invocation.model,
              effort: invocation.effort,
              context: invocation.context,
            });
            if (invocation.context === "inline")
              await latest.steer(runtime.sessionId, buildSkillSteeringText(invocation));
          },
          runForkedSkill: async (invocation) => {
            const forkSessionId = `${runtime.sessionId}:skill:${invocation.skillName}:${Date.now()}`;
            push({
              type: "skill.forked",
              runId: context.runId,
              skillId: invocation.skillId,
              forkSessionId,
              status: "started",
            });
            const workingState = new WorkingStateStore();
            workingState.restore({
              ...context.agent.workingState.get(),
              sessionId: forkSessionId,
              activePackId: invocation.packId,
              activeSkillId: invocation.skillId,
              expandedSkillIds: [invocation.skillId],
              invokedSkills: [invocation],
            });
            let text = "";
            for await (const event of factory({
              ...runtime,
              sessionId: forkSessionId,
              requestedModelId: invocation.model,
              requestedEffort: invocation.effort,
            }).run(invocation.content, {
              ...context,
              runId: `${context.runId}:skill`,
              agent: { ...context.agent, sessionId: forkSessionId, workingState },
              assembledContext: undefined,
            }))
              if (event.type === "model.response") text = event.response.text;
            push({
              type: "skill.forked",
              runId: context.runId,
              skillId: invocation.skillId,
              forkSessionId,
              status: "finished",
              result: text,
            });
            return { forkSessionId, text };
          },
        });
        const producer = (async () => {
          let nativeTrace: AgentSessionTrace | undefined;
          const model = typeof options.model === "function" ? options.model(runtime.requestedModelId) : options.model;
          for await (const event of latest.run({
            sessionId: runtime.sessionId,
            runId: context.runId,
            cwd: options.cwd ?? process.cwd(),
            input,
            instructions: runtime.system,
            // Pi 1.1 supports reconfiguration natively. Product context and offered tools can change per turn.
            bindingFingerprint: `opengrove-pi-durable-v1:${options.cwd ?? process.cwd()}`,
            context: [
              context.assembledContext?.promptBlock,
              context.requestedSkillInvocation ? buildSkillSteeringText(context.requestedSkillInvocation) : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            model: runtime.requestedModelId ?? model.id,
            thinkingLevel: resolveEffort(runtime.requestedEffort),
            signal: controller.signal,
            images: imageAttachmentsWithDataUrl(context.agent.page?.attachments).map(({ image }) => ({
              type: "image",
              data: image.base64,
              mimeType: image.mediaType,
            })),
            extensions: [CodingTools],
            tools: productTools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: json(tool.parameters),
              execute: async (params, native) => {
                const result = await tool.execute(native.callId, params, native.signal, (update) =>
                  push({
                    type: "tool.progress",
                    runId: context.runId,
                    toolId: originalName(tool.name),
                    callId: native.callId,
                    update: json(update),
                  }),
                );
                return {
                  success: true,
                  contentItems: result.content.map((item) => ({
                    type: "inputText" as const,
                    text: item.type === "text" ? item.text : "[image]",
                  })),
                };
              },
            })),
            beforeTurn: async ({ conversation }) => {
              const nativeContext = await conversation.context(background);
              const priorMessages = projectMessages(nativeContext.messages);
              nativeTrace = {
                provider: "pi",
                sessionId: runtime.sessionId,
                nativeSessionId: String(conversation.id),
                persistent: !!options.sessionRoot,
                priorMessageCount: priorMessages.length,
                priorMessages,
              };
              const usage = estimateContextTokens(nativeContext.messages);
              const budget = resolveContextTokenBudget(context.contextTokenBudget, model.contextWindow);
              const projected =
                usage.tokens +
                estimateTextTokens([context.assembledContext?.promptBlock, input].filter(Boolean).join("\n\n"));
              const triggered =
                budget.budgetSource === "configured" &&
                budget.effectiveBudget !== undefined &&
                projected >= budget.effectiveBudget;
              if (triggered) {
                push({
                  type: "compaction.started",
                  runId: context.runId,
                  at: new Date().toISOString(),
                  reason: "Product context budget reached",
                });
                const result = await latest.compact(
                  runtime.sessionId,
                  `Keep this conversation within the product context budget of ${budget.effectiveBudget} tokens.`,
                );
                if (result.compacted)
                  push({
                    type: "compaction.finished",
                    runId: context.runId,
                    at: new Date().toISOString(),
                    summary: "Pi native compaction completed",
                  });
                const rebuilt =
                  estimateContextTokens((await conversation.context(background)).messages).tokens +
                  estimateTextTokens(input);
                if (rebuilt >= model.contextWindow)
                  throw new Error(
                    `context_window_exceeded_after_pi_compaction:${rebuilt}/${model.contextWindow}:${result.error ?? "insufficient"}`,
                  );
              }
              push(
                contextBudgetDiagnostic({
                  runId: context.runId,
                  kernel: "pi",
                  ...budget,
                  usageSource: usage.usageTokens ? "native" : "estimated",
                  enforcementMode: "native-trigger",
                  contextUsedTokens: usage.tokens,
                  compactionTriggered: triggered,
                  reason: "Pi durable native context",
                }),
              );
            },
            onBeforeTool: async (call, native) =>
              gateTool(context, originalName(call.name), object(call.arguments), native.signal, push),
            onModelRequest: (selected, native) =>
              push({
                type: "model.requested",
                runId: context.runId,
                request: {
                  systemPrompt: runtime.system,
                  userInput: input,
                  modelId: selected.id,
                  session: nativeTrace,
                  messages: projectMessages(native.messages),
                  context: context.assembledContext,
                  tools: runtime.tools.map((tool) => tool.spec),
                  skills: runtime.skills,
                  packs: runtime.packs,
                  capabilities: runtime.capabilities,
                },
              }),
          })) {
            if (event.type === "assistant.delta") push({ ...event, runId: context.runId });
            else if (event.type === "tool.started")
              push({
                type: "tool.started",
                runId: context.runId,
                callId: event.callId,
                toolId: originalName(event.tool),
                input: json(event.input),
              });
            else if (event.type === "tool.finished")
              push({
                type: "tool.finished",
                runId: context.runId,
                callId: event.callId,
                toolId: originalName(event.tool),
                result: {
                  ok: event.result.success,
                  value: json(event.result.contentItems),
                  ...(!event.result.success
                    ? {
                        error: event.result.contentItems
                          .filter((item) => item.type === "inputText")
                          .map((item) => item.text)
                          .join("\n"),
                      }
                    : {}),
                },
              });
            else if (event.type === "model.response")
              push({ type: "model.response", runId: context.runId, response: { text: event.text } });
            else if (event.type === "native.notification")
              push({
                type: "runtime.diagnostic",
                runId: context.runId,
                at: new Date().toISOString(),
                name: event.notification.method,
                data: object(json(event.notification.params)),
              });
            else if (event.type === "turn.finished") {
              if (event.outcome.status === "failed")
                push({ type: "error", runId: context.runId, message: event.outcome.error ?? "pi_native_failed" });
              push({
                type: "turn.finished",
                runId: context.runId,
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
        })()
          .catch((error) => queue.push({ type: "error", runId: context.runId, message: String(error) }))
          .finally(() => queue.close());
        try {
          for await (const event of queue) yield event;
        } finally {
          controller.abort();
          context.signal?.removeEventListener("abort", abort);
          await producer;
        }
      },
    };
  };
  factory.compactSession = async (request) =>
    (await isLegacy(request.threadId))
      ? legacy.compactSession!(request)
      : latest.compact(request.threadId, request.reason);
  factory.listSessions = async () => [...(await legacyRepository.list()), ...(await latest.listSessions())];
  factory.deleteSession = async (id) =>
    (await isLegacy(id))
      ? legacy.deleteSession!(id)
      : { ok: false, deleted: false, error: "pi_durable_native_delete_unsupported" };
  factory.forkSession = async (source, target) => {
    if (await isLegacy(source)) return legacy.forkSession!(source, target);
    const result = await latest.forkSession(source, target);
    return result === "forked"
      ? {
          ok: true,
          forked: true,
          session: { sessionId: target, nativeSessionId: String((await latest.conversation(target))!.id) },
        }
      : { ok: false, forked: false, error: result };
  };
  factory.dispose = async () => {
    await latest.close();
    await legacy.dispose?.();
    await legacyRepository.close();
  };
  return factory;
}
async function gateTool(
  context: PiSessionContext,
  toolId: string,
  input: JsonObject,
  signal: AbortSignal,
  push: (event: AgentEvent) => void,
): Promise<{ block: string } | undefined> {
  const native = ["read", "write", "edit", "bash"].includes(toolId);
  const capabilityId = context.capabilities.find((capability) =>
    capability.tools.some((tool) => tool.id === toolId),
  )?.id;
  const decision = await context.beforeToolCall({ toolId, capabilityId, input, source: native ? "native" : "host" });
  if (decision.mode === "allow") return undefined;
  if (decision.mode === "deny") return { block: decision.reason };
  const request = context.agent.approvals.request({
    kind: toolId === "bash" ? "command" : ["write", "edit"].includes(toolId) ? "file_change" : "tool",
    title: toolId,
    reason: decision.reason,
    toolId,
    capabilityId,
    input,
    resume: { type: "kernel.native", kernelId: "pi", runId: context.runId, continuation: "same-loop" },
  });
  push({ type: "approval.requested", runId: context.runId, request });
  push({
    type: "run.paused",
    runId: context.runId,
    at: new Date().toISOString(),
    reason: decision.reason,
    approvalId: request.id,
  });
  let resolved: ApprovalRequest;
  try {
    resolved = await context.agent.approvals.waitForDecision(request.id, { signal });
  } catch (error) {
    resolved =
      context.agent.approvals.get(request.id)?.status === "pending"
        ? context.agent.approvals.decide(request.id, "canceled", {
            system: true,
            reasonCode: signal.aborted ? "run_canceled" : "native_request_failed",
            error: String(error),
          })
        : (context.agent.approvals.get(request.id) ?? request);
  }
  push({ type: "approval.resolved", runId: context.runId, request: resolved });
  if (resolved.status !== "approved") return { block: `Approval ${resolved.status}: ${request.id}` };
  push({
    type: "run.resumed",
    runId: context.runId,
    at: new Date().toISOString(),
    reason: "Native Pi tool approved",
    approvalId: request.id,
  });
  return undefined;
}
function resolveEffort(value?: string): import("@earendil-works/pi-ai").ModelThinkingLevel | undefined {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value ?? "")
    ? (value as import("@earendil-works/pi-ai").ModelThinkingLevel)
    : undefined;
}
function projectMessages(messages: readonly unknown[]): ModelMessage[] {
  return messages.map((value) => {
    const message = object(value);
    return {
      role:
        message.role === "assistant"
          ? "assistant"
          : message.role === "toolResult"
            ? "tool"
            : message.role === "system"
              ? "system"
              : "user",
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? []),
      ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
    };
  });
}
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
function json(value: unknown): JsonValue {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
}

class CallbackCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();
  private readonly disabled = new Set<string>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly getApiKey?: NativePiSessionOptions["getApiKey"]) {}

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

function createModels(getApiKey?: NativePiSessionOptions["getApiKey"]): MutableModels {
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
