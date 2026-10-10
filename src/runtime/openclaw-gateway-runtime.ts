import { assertRuntimeAccessMode } from "../runtime-access.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { OpenClawGatewayClient, OpenClawAgent, compactOpenClaw } from "@open-grove/agent-host/openclaw";
import { createHostToolBridge } from "./host-tool-bridge.js";
import type {
  AgentCompactRequest,
  AgentCompactResult,
  AgentEvent,
  AgentRuntime,
  AgentSessionTrace,
  AgentTurnRequest,
  JsonObject,
} from "../core.js";
import { agentTurnFullContextPromptBlock, prepareAgentTurnContext } from "../core.js";
import { appEnvName } from "../identity.js";
import { AsyncEventQueue } from "./codex/async-event-queue.js";
import { recentSessionMessages } from "./session-history.js";
import { resolveRuntimeRunId } from "./run-id.js";
import {
  contextBudgetDiagnostic,
  contextBudgetExceeded,
  estimateTextTokens,
  hardContextWindowExceeded,
  resolveContextTokenBudget,
} from "./context-token-budget.js";

export interface OpenClawGatewayConnection {
  url: string;
  token?: string;
  password?: string;
  sessionKey?: string;
}

export interface OpenClawGatewayConnectionResolveOptions {
  configHome?: string;
  allowLocalConfig?: boolean;
}

export interface OpenClawGatewayRuntimeOptions extends OpenClawGatewayConnection {
  cwd?: string;
  configuredModel?: string;
  runtimeBindingFingerprint?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export interface OpenClawGatewayDiscoveredProviderProfile {
  id: string;
  name: string;
  protocol: "custom-gateway";
  custom: true;
  enabled: true;
  origin: "discovered";
  sourceKernel: "openclaw";
  source: "OpenClaw Gateway";
  authConfigured: true;
  routeKind: "provider";
  credentialKind: "gateway-managed";
  modelsPinned: false;
  models: Array<{ id: string; label: string; description: "OpenClaw Gateway model" }>;
}

const DISCOVERY_TIMEOUT_MS = 3_000;
const DEFAULT_OPENCLAW_GATEWAY_PORT = 18789;

export async function discoverOpenClawGatewayVersion(
  connection: OpenClawGatewayConnection,
): Promise<string | undefined> {
  const client = new OpenClawGatewayClient({ ...connection, connectTimeoutMs: DISCOVERY_TIMEOUT_MS });
  try {
    await client.ensureConnected();
    return client.serverVersion;
  } finally {
    client.close();
  }
}

export async function discoverOpenClawGatewayProviderProfiles(
  connection: OpenClawGatewayConnection,
): Promise<OpenClawGatewayDiscoveredProviderProfile[]> {
  // Discovery is optional product enrichment. Keep its socket and RPC budget
  // short so an unreachable Gateway cannot consume long-lived background work.
  const client = new OpenClawGatewayClient({
    ...connection,
    connectTimeoutMs: DISCOVERY_TIMEOUT_MS,
  });
  try {
    const payload = asObject(
      await client.request("models.list", { view: "configured" }, { timeoutMs: DISCOVERY_TIMEOUT_MS }),
    );
    const providers = new Map<string, OpenClawGatewayDiscoveredProviderProfile>();
    for (const value of Array.isArray(payload.models) ? payload.models : []) {
      const model = asObject(value);
      if (model.available === false) continue;
      const providerId = readString(model, "provider") ?? "";
      const modelId = readString(model, "id") ?? "";
      if (!providerId || !modelId) continue;
      const profileId = openClawGatewayProviderProfileId(providerId);
      const profile = providers.get(profileId) ?? {
        id: profileId,
        name: identifierDisplayName(providerId),
        protocol: "custom-gateway",
        custom: true,
        enabled: true,
        origin: "discovered",
        sourceKernel: "openclaw",
        source: "OpenClaw Gateway",
        authConfigured: true,
        routeKind: "provider",
        credentialKind: "gateway-managed",
        modelsPinned: false,
        models: [],
      };
      const exactModelRef = modelId.toLowerCase().startsWith(`${providerId.toLowerCase()}/`)
        ? modelId
        : `${providerId}/${modelId}`;
      if (!profile.models.some((candidate) => candidate.id === exactModelRef)) {
        profile.models.push({
          id: exactModelRef,
          label: readString(model, "name") || identifierDisplayName(modelId),
          description: "OpenClaw Gateway model",
        });
      }
      providers.set(profileId, profile);
    }
    return [...providers.values()].sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    client.close();
  }
}

export class OpenClawGatewayRuntime implements AgentRuntime {
  private readonly client: OpenClawGatewayClient;
  private readonly agent: OpenClawAgent;

  constructor(private readonly options: OpenClawGatewayRuntimeOptions) {
    this.client = new OpenClawGatewayClient({
      url: options.url,
      token: options.token,
      password: options.password,
      clientVersion: "opengrove",
      clientName: "OpenGrove",
    });
    this.agent = new OpenClawAgent({ ...options, client: this.client, waitSliceMs: options.requestTimeoutMs });
  }

  close(): void {
    this.agent.close();
  }

  async compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    const sessionKey =
      this.options.sessionKey?.trim() || openClawSessionKey(request.threadId, this.options.runtimeBindingFingerprint);
    try {
      return await compactOpenClaw(this.client, sessionKey);
    } catch (error) {
      return { ok: false, compacted: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    assertRuntimeAccessMode("openclaw", request.accessMode);
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
        outcome: request.signal?.aborted
          ? { taskState: "TASK_STATE_FAILED", reasonCode: "cancel_outcome_unknown", outcomeUnknown: true }
          : {
              taskState: "TASK_STATE_FAILED",
              reasonCode: producerFailure ? "openclaw_gateway_failed" : "openclaw_native_terminal_missing",
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
    request = prepareAgentTurnContext(request);
    const extraSystemPrompt = ["You are running inside the OpenGrove host.", request.sessionInstructions?.trim()]
      .filter(Boolean)
      .join("\n\n");
    const model = request.requestedModelId?.trim() || this.options.configuredModel?.trim();
    const sessionKey =
      this.options.sessionKey?.trim() ||
      openClawSessionKey(request.context.sessionId, this.options.runtimeBindingFingerprint);
    const priorMessages = recentSessionMessages(request);
    const prompt = buildOpenClawPrompt(request);
    const hostTools = request.tools.length ? createHostToolBridge(request, runId, queue, "openclaw") : undefined;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          route: this.options.runtimeBindingFingerprint ?? "native",
          sessionKey,
          tools: hostTools?.fingerprint,
        }),
      )
      .digest("hex");
    let hasResponse = false;
    for await (const event of this.agent.run({
      sessionId: request.context.sessionId,
      sessionKey,
      runId,
      model,
      method: "agent",
      instructions: extraSystemPrompt,
      input: prompt,
      signal: request.signal,
      toolBridge: hostTools,
      bindingFingerprint: fingerprint,
      bindings: {
        get: async () => {
          const stored = asObject(
            request.context.sessions.get(request.context.sessionId)?.metadata?.openclawGatewayBindings,
          );
          return typeof stored[fingerprint] === "string" ? { threadId: stored[fingerprint], fingerprint } : undefined;
        },
        set: async (_id, binding) => {
          const current = request.context.sessions.get(request.context.sessionId);
          const previous = asObject(current?.metadata?.openclawGatewayBindings);
          const values: JsonObject = {};
          for (const [key, value] of Object.entries(previous)) if (typeof value === "string") values[key] = value;
          values[fingerprint] = binding.threadId;
          request.context.sessions.ensureSession({
            id: request.context.sessionId,
            activity: request.context.activity,
            metadata: { ...current?.metadata, openclawGatewayBindings: values },
          });
        },
      },
      beforeTurn: async (_client, context) => {
        if (!model) throw new Error("openclaw_gateway_model_selection_required");
        if (request.assembledContext)
          queue.push({ type: "context.assembled", runId, context: request.assembledContext });
        queue.push({
          type: "runtime.diagnostic",
          runId,
          at: new Date().toISOString(),
          name: "openclaw.gateway.session",
          data: {
            url: redactGatewayUrl(this.options.url),
            sessionKey,
            hostInstructionsChannel: "agent.extraSystemPrompt",
            hostStateDelivery: "full-per-host-turn",
            hostCompactionRecovery: "next-host-turn",
          },
        });
        if (context.selectedModel)
          queue.push({
            type: "runtime.diagnostic",
            runId,
            at: new Date().toISOString(),
            name: "openclaw.gateway.model-selected",
            data: asJsonObject(context.selectedModel),
          });
        const session: AgentSessionTrace = {
          provider: "openclaw",
          sessionId: sessionKey,
          nativeSessionId: context.threadId,
          persistent: true,
          priorMessageCount: priorMessages.length,
          priorMessages,
        };
        queue.push({
          type: "model.requested",
          runId,
          request: {
            systemPrompt: extraSystemPrompt,
            userInput: request.input,
            modelId: model,
            session,
            context: request.assembledContext,
            tools: request.tools.map((t) => t.spec),
            skills: request.skills ?? [],
            packs: request.packs ?? [],
            capabilities: request.capabilities ?? [],
          },
        });
        await this.prepareContextBudget({
          request,
          queue,
          runId,
          sessionKey,
          priorMessages,
          incomingTokens: estimateTextTokens(extraSystemPrompt + "\n\n" + prompt),
        });
      },
    })) {
      if (event.type === "turn.started") queue.push({ type: "turn.started", runId, at: new Date().toISOString() });
      if (event.type === "assistant.delta") queue.push(event);
      if (event.type === "model.response") {
        hasResponse = true;
        queue.push({ type: "model.response", runId, response: { text: event.text } });
      }
      if (event.type === "turn.finished") {
        const empty = event.outcome.status === "completed" && !hasResponse;
        if (event.outcome.error || empty)
          queue.push({ type: "error", runId, message: event.outcome.error ?? "openclaw_gateway_empty_response" });
        queue.push({
          type: "turn.finished",
          runId,
          at: new Date().toISOString(),
          outcome: {
            taskState:
              empty || event.outcome.status === "failed"
                ? "TASK_STATE_FAILED"
                : event.outcome.status === "cancelled"
                  ? "TASK_STATE_CANCELED"
                  : "TASK_STATE_COMPLETED",
            ...(event.outcome.status === "cancelled"
              ? { reasonCode: event.outcome.outcomeUnknown ? "cancel_outcome_unknown" : "user_canceled" }
              : event.outcome.error || empty
                ? { reasonCode: event.outcome.error ?? "openclaw_gateway_empty_response" }
                : {}),
            ...(event.outcome.outcomeUnknown ? { outcomeUnknown: true } : {}),
          },
        });
      }
    }
  }

  private async prepareContextBudget(input: {
    request: AgentTurnRequest;
    queue: AsyncEventQueue<AgentEvent>;
    runId: string;
    sessionKey: string;
    priorMessages: ReturnType<typeof recentSessionMessages>;
    incomingTokens: number;
  }): Promise<void> {
    let row: Record<string, unknown> | undefined;
    try {
      const listed = asObject(
        await this.client.request(
          "sessions.list",
          { search: input.sessionKey, limit: 50 },
          { timeoutMs: 30_000, signal: input.request.signal },
        ),
      );
      const sessions = Array.isArray(listed.sessions) ? listed.sessions.map(asObject) : [];
      row = sessions.find((candidate) => {
        const key = readString(candidate, "key") || readString(candidate, "sessionKey");
        return key === input.sessionKey;
      });
    } catch {
      // sessions.list is an optional usage probe; the diagnostic below records that the budget estimate was used instead.
      row = undefined;
    }

    const fresh = row?.totalTokensFresh !== false;
    const nativeUsed = fresh ? readNumber(row, "totalTokens") : undefined;
    const estimatedUsed = estimateTextTokens(JSON.stringify(input.priorMessages));
    const contextUsedTokens = nativeUsed ?? estimatedUsed;
    const projectedContextTokens = contextUsedTokens + input.incomingTokens;
    const budget = resolveContextTokenBudget(input.request.contextTokenBudget, readNumber(row, "contextTokens"));
    const usageSource = nativeUsed !== undefined ? ("native" as const) : ("estimated" as const);
    const effectiveBudget = budget.effectiveBudget;
    if (budget.budgetSource !== "configured" || effectiveBudget === undefined) {
      input.queue.push(
        contextBudgetDiagnostic({
          runId: input.runId,
          kernel: "openclaw",
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
          kernel: "openclaw",
          ...budget,
          usageSource,
          enforcementMode: "native-trigger",
          contextUsedTokens,
          reason: nativeUsed !== undefined ? "sessions.list" : "OpenGrove session estimate",
        }),
      );
      return;
    }

    input.queue.push({
      type: "compaction.started",
      runId: input.runId,
      at: new Date().toISOString(),
      reason: `OpenClaw projected context reached ${projectedContextTokens}/${effectiveBudget} tokens`,
    });
    const result = await this.compactSession({
      runId: input.runId,
      threadId: input.request.context.sessionId,
      reason: "OpenGrove context token budget reached",
      maxTokens: effectiveBudget,
    });
    if (result.ok && result.compacted) {
      input.queue.push({
        type: "compaction.finished",
        runId: input.runId,
        at: new Date().toISOString(),
        summary: "OpenClaw native session compaction finished.",
      });
      input.queue.push(
        contextBudgetDiagnostic({
          runId: input.runId,
          kernel: "openclaw",
          ...budget,
          usageSource,
          enforcementMode: "native-trigger",
          contextUsedTokens,
          compactionTriggered: true,
          compactionSucceeded: true,
          reason: "sessions.compact",
        }),
      );
      return;
    }

    const error = result.error || "openclaw_context_compaction_failed";
    input.queue.push(
      contextBudgetDiagnostic({
        runId: input.runId,
        kernel: "openclaw",
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
}

export function resolveOpenClawGatewayConnection(
  env: NodeJS.ProcessEnv = process.env,
  options: OpenClawGatewayConnectionResolveOptions = {},
): OpenClawGatewayConnection | undefined {
  const url = readEnv(
    env,
    appEnvName("OPENCLAW_GATEWAY_URL"),
    appEnvName("OPENCLAW_WS_URL"),
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_WS_URL",
  );
  const envConnection = {
    token: readEnv(
      env,
      appEnvName("OPENCLAW_GATEWAY_TOKEN"),
      appEnvName("OPENCLAW_TOKEN"),
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_TOKEN",
    ),
    password: readEnv(env, appEnvName("OPENCLAW_GATEWAY_PASSWORD"), "OPENCLAW_GATEWAY_PASSWORD"),
    sessionKey: readEnv(env, appEnvName("OPENCLAW_SESSION_KEY"), "OPENCLAW_SESSION_KEY"),
  };
  if (url) {
    return {
      url,
      ...envConnection,
    };
  }
  if (options.allowLocalConfig === false) return undefined;
  const localConnection = resolveOpenClawLocalConfigConnection(env, options.configHome);
  if (!localConnection) return undefined;
  return {
    ...localConnection,
    token: envConnection.token ?? localConnection.token,
    password: envConnection.password ?? localConnection.password,
    sessionKey: envConnection.sessionKey ?? localConnection.sessionKey,
  };
}

function resolveOpenClawLocalConfigConnection(
  env: NodeJS.ProcessEnv,
  configHome: string | undefined,
): OpenClawGatewayConnection | undefined {
  const config = readOpenClawConfig(env, configHome);
  if (!config) return undefined;
  const gateway = asObject(config.gateway);
  const mode = readString(gateway, "mode");
  if (mode === "remote") {
    const remote = asObject(gateway.remote);
    const remoteUrl = readString(remote, "url");
    if (!remoteUrl) return undefined;
    return {
      url: normalizeGatewayWsUrl(remoteUrl),
      token: readString(remote, "token"),
      password: readString(remote, "password"),
    };
  }

  const auth = asObject(gateway.auth);
  const authMode = readString(auth, "mode");
  const explicitUrl = readString(gateway, "url") || readString(gateway, "wsUrl") || readString(gateway, "webSocketUrl");
  const url = explicitUrl
    ? normalizeGatewayWsUrl(explicitUrl)
    : `${asObject(gateway.tls).enabled === true ? "wss" : "ws"}://${localGatewayHost(gateway)}:${readGatewayPort(gateway)}`;
  return {
    url,
    token: authMode === "password" ? undefined : readString(auth, "token"),
    password: authMode === "password" ? readString(auth, "password") : undefined,
  };
}

function readOpenClawConfig(
  env: NodeJS.ProcessEnv,
  configHome: string | undefined,
): Record<string, unknown> | undefined {
  const path = resolveOpenClawConfigPath(env, configHome);
  if (!path || !existsSync(path)) return undefined;
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function resolveOpenClawConfigPath(env: NodeJS.ProcessEnv, configHome: string | undefined): string {
  const explicitPath = readEnv(env, appEnvName("OPENCLAW_CONFIG_PATH"), "OPENCLAW_CONFIG_PATH");
  if (explicitPath) return resolveHomePath(explicitPath);
  const stateDir =
    configHome?.trim() ||
    readEnv(
      env,
      appEnvName("OPENCLAW_STATE_DIR"),
      appEnvName("OPENCLAW_CONFIG_HOME"),
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_HOME",
    ) ||
    resolve(homedir(), ".openclaw");
  return resolve(resolveHomePath(stateDir), "openclaw.json");
}

function readGatewayPort(gateway: Record<string, unknown>): number {
  const value = gateway.port;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_OPENCLAW_GATEWAY_PORT;
}

function localGatewayHost(gateway: Record<string, unknown>): string {
  const host = readString(gateway, "host") || readString(gateway, "customBindHost") || "127.0.0.1";
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

function normalizeGatewayWsUrl(value: string): string {
  const url = value.trim();
  if (/^https:\/\//i.test(url)) return `wss://${url.slice("https://".length)}`;
  if (/^http:\/\//i.test(url)) return `ws://${url.slice("http://".length)}`;
  return url;
}

function slugIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function openClawGatewayProviderProfileId(providerId: string): string {
  const prefix = "openclaw-gateway-";
  const slug = slugIdentifier(providerId);
  const unabridged = `${prefix}${slug}`;
  // Bridge Provider ids are persisted with a 48-character limit. Keep this
  // derivation within that contract so refresh cannot create a second id.
  if (unabridged.length <= 48) return unabridged;
  const digest = createHash("sha256").update(providerId).digest("hex").slice(0, 8);
  return `${prefix}${slug.slice(0, 48 - prefix.length - digest.length - 1)}-${digest}`;
}

function identifierDisplayName(value: string): string {
  return value
    .trim()
    .replace(/[._-]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bAi\b/g, "AI");
}

function buildOpenClawPrompt(request: AgentTurnRequest): string {
  const hostContext = agentTurnFullContextPromptBlock(request);
  return [hostContext ? `Host context:\n${hostContext}` : "", `User request:\n${request.input}`]
    .filter(Boolean)
    .join("\n\n");
}

function redactGatewayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "[redacted]");
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function openClawSessionKey(sessionId: string, runtimeBindingFingerprint: string | undefined): string {
  const base = sessionId.trim() || "main";
  const fingerprint = runtimeBindingFingerprint?.trim();
  return fingerprint ? `${base}:${fingerprint}` : base;
}

function readEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function resolveHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function asObject(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
