import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { WebSocket } from "undici";
import type {
  AgentCompactRequest,
  AgentCompactResult,
  AgentEvent,
  AgentRuntime,
  AgentSessionTrace,
  AgentTurnRequest,
  JsonObject,
  JsonValue,
} from "../core.js";
import { agentTurnHostContextPromptBlock, agentTurnReplyLanguageInstruction } from "../core.js";
import { appEnvName } from "../identity.js";
import { AsyncEventQueue } from "./codex/async-event-queue.js";
import { recentSessionMessages, recentSessionPromptBlock } from "./session-history.js";
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

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
};

type PendingGatewayRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
};

const CONNECT_TIMEOUT_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 3_000;
const OPENCLAW_COMPACT_TIMEOUT_MS = 120_000;
const OPENCLAW_WAIT_SLICE_MS = 30_000;
const OPENCLAW_WAIT_TRANSPORT_GRACE_MS = 5_000;
const OPENCLAW_CANCEL_SETTLE_MS = 15_000;
const DEFAULT_OPENCLAW_GATEWAY_PORT = 18789;
const OPENCLAW_MIN_PROTOCOL = 4;
const OPENCLAW_MAX_PROTOCOL = 4;
const OPENCLAW_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

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

  constructor(private readonly options: OpenClawGatewayRuntimeOptions) {
    this.client = new OpenClawGatewayClient({
      url: options.url,
      token: options.token,
      password: options.password,
    });
  }

  close(): void {
    this.client.close();
  }

  async compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    const sessionKey =
      this.options.sessionKey?.trim() || openClawSessionKey(request.threadId, this.options.runtimeBindingFingerprint);
    try {
      const result = asObject(
        await this.client.request(
          "sessions.compact",
          { key: sessionKey },
          { timeoutMs: this.options.requestTimeoutMs ?? OPENCLAW_COMPACT_TIMEOUT_MS },
        ),
      );
      if (result.compacted === true) return { ok: true, compacted: true };
      return {
        ok: false,
        compacted: false,
        error: readString(result, "reason") || "openclaw_compaction_not_confirmed",
      };
    } catch (error) {
      return {
        ok: false,
        compacted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async *runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
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

    for await (const event of queue) {
      if (event.type === "turn.started") turnStarted = true;
      if (event.type === "turn.finished") turnFinished = true;
      yield event;
    }
    await producer;
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
    const requestedModel = request.requestedModelId?.trim() || this.options.configuredModel?.trim();
    const prompt = buildOpenClawPrompt(request);
    const sessionKey =
      this.options.sessionKey?.trim() ||
      openClawSessionKey(request.context.sessionId, this.options.runtimeBindingFingerprint);
    const priorMessages = recentSessionMessages(request);
    const acceptedRunIds = new Set([runId]);
    const session: AgentSessionTrace = {
      provider: "openclaw",
      sessionId: sessionKey,
      nativeSessionId: sessionKey,
      persistent: true,
      priorMessageCount: priorMessages.length,
      priorMessages,
    };
    let assistantText = "";
    let sawTerminalError = false;

    queue.push({ type: "turn.started", runId, at: new Date().toISOString() });
    if (request.assembledContext) {
      queue.push({ type: "context.assembled", runId, context: request.assembledContext });
    }
    queue.push({
      type: "runtime.diagnostic",
      runId,
      at: new Date().toISOString(),
      name: "openclaw.gateway.session",
      data: {
        url: redactGatewayUrl(this.options.url),
        sessionKey,
      },
    });
    queue.push({
      type: "model.requested",
      runId,
      request: {
        systemPrompt: "OpenClaw Gateway mode. OpenGrove host context is prepended to the user prompt when present.",
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

    const cleanup = this.client.addEventListener((frame) => {
      if (frame.event !== "agent") return;
      const payload = asObject(frame.payload);
      const payloadRunId = readString(payload, "runId");
      if (payloadRunId && !acceptedRunIds.has(payloadRunId)) return;
      const stream = readString(payload, "stream");
      const data = asObject(payload.data);
      const lifecyclePhase = readString(data, "phase") || readString(payload, "phase");
      if (stream === "assistant") {
        const text = normalizeAssistantText(extractGatewayText(payload) || extractGatewayText(data));
        if (text) {
          const delta = gatewayAssistantDelta(assistantText, text);
          if (delta) {
            assistantText += delta;
            queue.push({ type: "assistant.delta", runId, text: delta });
          }
        }
        return;
      }
      if (stream === "lifecycle" && lifecyclePhase === "error") {
        sawTerminalError = true;
        queue.push({
          type: "error",
          runId,
          message: readString(data, "error") || readString(payload, "error") || "openclaw_gateway_run_failed",
        });
      }
    });

    let nativeRunId = runId;
    let chatSent = false;
    const waitController = new AbortController();
    let cancelSettleTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (!chatSent) return;
      void this.client
        .request("chat.abort", { sessionKey, runId: nativeRunId }, { timeoutMs: 10_000 })
        .catch(() => undefined);
      if (!cancelSettleTimer) {
        cancelSettleTimer = setTimeout(() => waitController.abort(), OPENCLAW_CANCEL_SETTLE_MS);
        cancelSettleTimer.unref?.();
      }
    };
    request.signal?.addEventListener("abort", abort, { once: true });

    try {
      await this.client.ensureConnected();
      if (request.signal?.aborted) {
        queue.push({ type: "model.response", runId, response: { text: "" } });
        queue.push({
          type: "turn.finished",
          runId,
          at: new Date().toISOString(),
          outcome: { taskState: "TASK_STATE_CANCELED", reasonCode: "user_canceled", retryable: false },
        });
        return;
      }
      if (!requestedModel) {
        throw new Error("openclaw_gateway_model_selection_required");
      }
      const selectedRoute = await this.selectSessionModel(sessionKey, requestedModel, request.signal);
      queue.push({
        type: "runtime.diagnostic",
        runId,
        at: new Date().toISOString(),
        name: "openclaw.gateway.model-selected",
        data: selectedRoute,
      });
      await this.prepareContextBudget({
        request,
        queue,
        runId,
        sessionKey,
        priorMessages,
        incomingTokens: estimateTextTokens(prompt),
      });
      const sent = asObject(
        await this.client.request(
          "chat.send",
          {
            sessionKey,
            sessionId: request.context.sessionId,
            message: prompt,
            deliver: false,
            idempotencyKey: runId,
          },
          { timeoutMs: 30_000 },
        ),
      );
      nativeRunId = readString(sent, "runId") || runId;
      chatSent = true;
      acceptedRunIds.add(nativeRunId);
      if (request.signal?.aborted) abort();
      const waitSliceMs = Math.max(100, this.options.requestTimeoutMs ?? OPENCLAW_WAIT_SLICE_MS);
      let waitStatus = "";
      while (true) {
        try {
          const wait = asObject(
            await this.client.request(
              "agent.wait",
              { runId: nativeRunId, timeoutMs: waitSliceMs },
              { timeoutMs: waitSliceMs + OPENCLAW_WAIT_TRANSPORT_GRACE_MS, signal: waitController.signal },
            ),
          );
          waitStatus = readString(wait, "status") || "";
        } catch (error) {
          if (!waitController.signal.aborted && error instanceof Error && error.message === "agent.wait timed out") {
            continue;
          }
          throw error;
        }
        if (!["timeout", "pending", "running", "working"].includes(waitStatus.trim().toLowerCase())) break;
      }
      const normalizedWaitStatus = waitStatus.trim().toLowerCase();
      const nativeCanceled = ["aborted", "cancelled", "canceled", "interrupted"].includes(normalizedWaitStatus);
      if (
        waitStatus &&
        !["ok", "complete", "completed", "success", "aborted", "cancelled", "canceled", "interrupted"].includes(
          normalizedWaitStatus,
        )
      ) {
        sawTerminalError = true;
        queue.push({ type: "error", runId, message: `openclaw_gateway_${waitStatus}` });
      }

      if (!assistantText.trim() && !nativeCanceled) {
        const finalText = await this.readLatestAssistantText(sessionKey);
        if (finalText) {
          assistantText = finalText;
          queue.push({ type: "assistant.delta", runId, text: finalText });
        }
      }
      if (!assistantText.trim() && !sawTerminalError && !nativeCanceled) {
        queue.push({ type: "error", runId, message: "openclaw_gateway_empty_response" });
      }
      queue.push({ type: "model.response", runId, response: { text: assistantText.trimEnd() } });
      queue.push({
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: sawTerminalError
          ? { taskState: "TASK_STATE_FAILED", reasonCode: "openclaw_gateway_run_failed" }
          : nativeCanceled
            ? {
                taskState: "TASK_STATE_CANCELED",
                reasonCode: request.signal?.aborted ? "user_canceled" : "native_interrupted",
                retryable: false,
              }
            : !assistantText.trim()
              ? { taskState: "TASK_STATE_FAILED", reasonCode: "openclaw_gateway_empty_response" }
              : ["ok", "complete", "completed", "success"].includes(normalizedWaitStatus)
                ? { taskState: "TASK_STATE_COMPLETED" }
                : {
                    taskState: "TASK_STATE_FAILED",
                    reasonCode: "openclaw_gateway_terminal_unknown",
                    outcomeUnknown: true,
                  },
      });
    } catch (error) {
      if (request.signal?.aborted && !chatSent) {
        queue.push({ type: "model.response", runId, response: { text: "" } });
        queue.push({
          type: "turn.finished",
          runId,
          at: new Date().toISOString(),
          outcome: { taskState: "TASK_STATE_CANCELED", reasonCode: "user_canceled", retryable: false },
        });
        return;
      }
      throw error;
    } finally {
      if (cancelSettleTimer) clearTimeout(cancelSettleTimer);
      cleanup();
      request.signal?.removeEventListener("abort", abort);
    }
  }

  private async selectSessionModel(
    sessionKey: string,
    requestedModel: string,
    signal: AbortSignal | undefined,
  ): Promise<JsonObject> {
    const selected = asObject(
      await this.client.request(
        "sessions.patch",
        { key: sessionKey, model: requestedModel },
        { timeoutMs: 30_000, signal },
      ),
    );
    const resolved = asObject(selected.resolved);
    const provider = readString(resolved, "modelProvider") ?? "";
    const model = readString(resolved, "model") ?? "";
    const canonicalModel =
      provider && model
        ? model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
          ? model
          : `${provider}/${model}`
        : "";
    if (!canonicalModel || canonicalModel.toLowerCase() !== requestedModel.trim().toLowerCase()) {
      throw new Error(`openclaw_gateway_model_mismatch:${requestedModel}:${canonicalModel || "unknown"}`);
    }
    return { sessionKey, requestedModel, canonicalModel };
  }

  private async readLatestAssistantText(sessionKey: string): Promise<string> {
    try {
      const history = asObject(
        await this.client.request("chat.history", { sessionKey, limit: 20 }, { timeoutMs: 30_000 }),
      );
      const messages = Array.isArray(history.messages) ? history.messages : [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asObject(messages[index]);
        if (readString(message, "role") !== "assistant") continue;
        const text = normalizeAssistantText(extractGatewayText(message));
        if (text) return text;
      }
    } catch {
      return "";
    }
    return "";
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

class OpenClawGatewayClient {
  private ws?: WebSocket;
  private connected = false;
  private connectPromise?: Promise<void>;
  private nextId = 1;
  private pending = new Map<string, PendingGatewayRequest>();
  private eventListeners = new Set<(frame: GatewayEventFrame) => void>();

  constructor(
    private readonly options: Pick<OpenClawGatewayConnection, "url" | "token" | "password"> & {
      connectTimeoutMs?: number;
    },
  ) {}

  async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openSocket();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    await this.ensureConnected();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("openclaw gateway is not connected");
    }
    return await this.requestOnSocket<T>(this.ws, method, params, options);
  }

  addEventListener(listener: (frame: GatewayEventFrame) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  close(): void {
    this.connected = false;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("openclaw gateway closed"));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = undefined;
  }

  private openSocket(): Promise<void> {
    this.close();
    const ws = new WebSocket(this.options.url);
    const connectTimeoutMs = this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.ws = ws;
    let connectSent = false;
    let connectNonce: string | undefined;
    let socketTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    return new Promise<void>((resolve, reject) => {
      const cleanupConnect = () => {
        if (socketTimer) {
          clearTimeout(socketTimer);
          socketTimer = undefined;
        }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupConnect();
        this.connected = false;
        reject(error);
      };
      const sendConnect = () => {
        if (connectSent || ws.readyState !== WebSocket.OPEN) return;
        connectSent = true;
        void this.requestOnSocket(ws, "connect", this.connectParams(connectNonce), { timeoutMs: connectTimeoutMs })
          .then(() => {
            if (settled) return;
            settled = true;
            cleanupConnect();
            this.connected = true;
            resolve();
          })
          .catch(fail);
      };
      const onMessage = (event: { data: unknown }) => {
        if (this.ws !== ws) return;
        const frame = parseGatewayFrame(event.data);
        if (!frame) return;
        if (frame.type === "event" && frame.event === "connect.challenge") {
          const payload = asObject(frame.payload);
          connectNonce = readString(payload, "nonce");
          if (!connectNonce) {
            fail(new Error("openclaw gateway challenge did not include a nonce"));
            ws.close();
            return;
          }
          sendConnect();
          return;
        }
        this.handleFrame(frame);
      };
      const onClose = () => {
        if (this.ws !== ws) return;
        cleanupConnect();
        this.connected = false;
        for (const pending of this.pending.values()) {
          pending.cleanup();
          pending.reject(new Error("openclaw gateway closed"));
        }
        this.pending.clear();
        if (!settled) {
          fail(new Error("openclaw gateway closed during connect"));
        }
      };
      const onError = () => {
        if (this.ws !== ws) return;
        this.connected = false;
        if (!settled) {
          fail(new Error("openclaw gateway socket error"));
        }
      };
      socketTimer = setTimeout(() => {
        fail(new Error("openclaw gateway connect timed out"));
        ws.close();
      }, connectTimeoutMs);
      socketTimer.unref?.();
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    });
  }

  private requestOnSocket<T>(
    ws: WebSocket,
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new Error(`${method} aborted`));
    }
    const id = `${Date.now()}-${this.nextId++}-${randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let cleanupAbort: (() => void) | undefined;
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        cleanupAbort?.();
        cleanupAbort = undefined;
      };
      const rejectPending = (error: Error) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => rejectPending(new Error(`${method} timed out`)), options.timeoutMs);
        timeout.unref?.();
      }
      if (options.signal) {
        const abortListener = () => rejectPending(new Error(`${method} aborted`));
        options.signal.addEventListener("abort", abortListener, { once: true });
        cleanupAbort = () => options.signal?.removeEventListener("abort", abortListener);
      }
      this.pending.set(id, {
        method,
        resolve(value) {
          cleanup();
          resolve(value as T);
        },
        reject(error) {
          cleanup();
          reject(error);
        },
        cleanup,
      });
      try {
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (error) {
        rejectPending(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private connectParams(_nonce?: string): JsonObject {
    return stripUndefined({
      minProtocol: OPENCLAW_MIN_PROTOCOL,
      maxProtocol: OPENCLAW_MAX_PROTOCOL,
      client: {
        id: "gateway-client",
        version: "opengrove",
        platform: process.platform,
        mode: "backend",
        instanceId: `opengrove-${process.pid}`,
      },
      role: "operator",
      scopes: OPENCLAW_OPERATOR_SCOPES,
      caps: ["tool-events"],
      auth: stripUndefined({
        token: this.options.token,
        password: this.options.password,
      }),
      device: undefined,
      userAgent: "OpenGrove",
      locale: "en-US",
    }) as JsonObject;
  }

  private handleFrame(frame: GatewayEventFrame | GatewayResponseFrame): void {
    if (frame.type === "event") {
      for (const listener of this.eventListeners) {
        listener(frame);
      }
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.payload);
      return;
    }
    const details = frame.error?.details === undefined ? "" : `: ${JSON.stringify(frame.error.details)}`;
    pending.reject(new Error(frame.error?.message || `${pending.method} failed${details}`));
  }
}

function buildOpenClawPrompt(request: AgentTurnRequest): string {
  const hostContext = agentTurnHostContextPromptBlock(request);
  const threadHistory = recentSessionPromptBlock(request);
  const selectedSkill = request.requestedSkillInvocation?.content.trim();
  const sections = [
    "You are running inside the OpenGrove host.",
    hostContext ? `Host context:\n${hostContext}` : "",
    threadHistory,
    selectedSkill
      ? [
          `OpenGrove selected skill ${request.requestedSkillInvocation?.skillName}:`,
          selectedSkill,
          request.requestedSkillInvocation?.args ? `Skill arguments:\n${request.requestedSkillInvocation.args}` : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : "",
    `User request:\n${request.input}`,
    agentTurnReplyLanguageInstruction(request),
  ].filter(Boolean);
  return sections.join("\n\n");
}

function parseGatewayFrame(data: unknown): GatewayEventFrame | GatewayResponseFrame | undefined {
  const raw =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : "";
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    if (parsed.type === "event" || parsed.type === "res") {
      return parsed as GatewayEventFrame | GatewayResponseFrame;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extractGatewayText(value: unknown): string {
  const record = asObject(value);
  const direct = readString(record, "text") || readString(record, "delta") || readString(record, "content");
  if (direct) return direct;
  const message = asObject(record.message);
  const messageText = readString(message, "text") || readString(message, "content");
  if (messageText) return messageText;
  const content = Array.isArray(record.content)
    ? record.content
    : Array.isArray(message.content)
      ? message.content
      : [];
  return content
    .map((item) => {
      const block = asObject(item);
      return readString(block, "text") || readString(block, "content") || "";
    })
    .filter(Boolean)
    .join("");
}

function normalizeAssistantText(value: string | undefined): string {
  const text = value?.trimEnd() ?? "";
  if (!text.trim()) return "";
  if (text.trim() === "NO_REPLY") return "";
  if (text.includes('"payloads"') && text.includes('"runId"')) return "";
  return text;
}

function gatewayAssistantDelta(previousText: string, nextText: string): string {
  if (!previousText) return nextText;
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
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

function stripUndefined(input: Record<string, unknown>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      output[key] = value.filter((item): item is JsonValue => item !== undefined) as JsonValue;
      continue;
    }
    if (value && typeof value === "object") {
      output[key] = stripUndefined(value as Record<string, unknown>);
      continue;
    }
    output[key] = value as JsonValue;
  }
  return output;
}
