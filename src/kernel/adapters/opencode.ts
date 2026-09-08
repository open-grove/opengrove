import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentEvent, RuntimeAccessMode } from "../../core.js";
import type { AgentCompactRequest, AgentCompactResult, AgentRuntime } from "../../core.js";
import { appEnvName, readAppEnv } from "../../identity.js";
import { AcpCliRuntime } from "../../runtime/acp-cli-runtime.js";
import { resolveRuntimeRunId } from "../../runtime/run-id.js";
import {
  commandDiscoveryHealth,
  directorySource,
  fileSource,
  kernelExecutableProbe,
  plannedInstallAction,
  probeCommandPath,
  resolveHomePath,
  resolveUsableCommandPath,
} from "../discovery.js";
import { bridgeKernelSupportsHostTools } from "../host-tools.js";
import type {
  KernelAdapter,
  KernelAdapterContract,
  KernelCapabilities,
  KernelDiscovery,
  KernelHealth,
  KernelSessionHandle,
  KernelSessionStart,
  KernelTurnRequest,
  ModelOption,
  ProviderProfile,
  ProviderProtocol,
} from "../types.js";
import { APP_PROTOCOL_ID } from "../../identity.js";
import {
  type KernelLocalRouteProfile,
  configHome,
  firstConfiguredCredentialId,
  providerDisplayName,
  readJsonObject,
} from "./profile-utils.js";
import type { BridgeProviderProfile } from "../../server/bridge-types.js";
import { acpKernelOwnership } from "./acp-contract.js";

const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";
const OPENCODE_NATIVE_DEFAULT_MODEL = "opencode/big-pickle";

const OPENCODE_CAPABILITIES: KernelCapabilities = {
  sessionHistory: "kernel",
  reasoning: { nativeText: "conditional", summary: "unsupported" },
  streaming: true,
  toolCalls: true,
  hostTools: bridgeKernelSupportsHostTools("opencode"),
  approvals: true,
  elicitation: false,
  artifacts: false,
  compaction: true,
  authRefresh: false,
  sandbox: ["danger-full-access"],
  knowledge: {
    nativeSkills: true,
    toolMediatedSkills: false,
    progressiveDisclosure: true,
    nativeArtifacts: false,
    deliveryLedger: true,
  },
  nativeThreadGoal: false,
  nativeSkillCatalog: false,
};

export const OPENCODE_KERNEL_CONTRACT: KernelAdapterContract = {
  paths: {
    configHomeEnvVar: null,
    defaultConfigHome: ".config/opencode",
    cliCommand: "opencode",
    projectSkillDir: ".opencode/skills",
    nativeSkillMarker: "/.opencode/skills/",
    knowledgeBuckets: [{ pathContains: "/.opencode/skills/", bucket: "opencode.skills" }],
    defaultKnowledgeBucket: `${APP_PROTOCOL_ID}.skills`,
  },
  display: {
    defaultModelId: "opencode-default",
    modelDisplayAliases: [],
    modelDisplaySuffixAlias: null,
  },
  inputFormats: {
    planMode: {
      withInput: "Create a plan first before taking action:\n{input}",
      withoutInput: "Create a plan first before taking action.",
    },
    skillInvocation: {
      withArgs: "Use the native OpenCode skill {name} for this request.\n\n{args}",
      withoutArgs: "Use the native OpenCode skill {name} for this request.",
    },
    modelAliasStrategy: "provider-qualified",
    nativeModelNormalization: false,
  },
  labels: { title: "OpenCode", integrationMode: "acp" },
  ownership: acpKernelOwnership("OpenCode"),
  diagnostics: {
    defaultModeId: "acp-bridge",
    modes: [
      {
        id: "acp-bridge",
        title: "OpenCode ACP bridge",
        layer: "process-stdio",
        status: "implemented",
        redaction: "redacted",
        notes: [
          "OpenGrove uses `opencode acp` instead of one-shot `opencode run`, so assistant deltas, tool calls, and permission requests stay structured.",
        ],
      },
      {
        id: "process-stdio",
        title: "OpenCode process stdio",
        layer: "process-stdio",
        status: "implemented",
        redaction: "redacted",
      },
    ],
  },
  notes: [
    "OpenGrove uses `opencode acp` instead of one-shot `opencode run`, so assistant deltas, tool calls, and permission requests stay structured.",
  ],
};

export interface OpenCodeKernelAdapterOptions {
  command?: string;
  cwd?: string;
  configuredModel?: string;
  runtimeBindingFingerprint?: string;
  env?: NodeJS.ProcessEnv;
}

export class OpenCodeKernelAdapter implements KernelAdapter {
  readonly id = "opencode" as const;
  readonly title = "OpenCode";
  readonly capabilities = OPENCODE_CAPABILITIES;
  readonly contract = OPENCODE_KERNEL_CONTRACT;
  readonly bindingMode = "env" as const;
  private readonly runtime?: AgentRuntime;

  constructor(private readonly options: OpenCodeKernelAdapterOptions = {}) {
    const command = options.command || resolveOpenCodeCommand();
    const configuredModel = normalizeOpenCodeModelId(options.configuredModel, options.env?.OPENCODE_CONFIG_CONTENT);
    if (command) {
      this.runtime = new AcpCliRuntime({
        kernelId: "opencode",
        title: "OpenCode",
        command,
        acpArgs: ["acp"],
        setModelFailure: "ignore",
        cwd: options.cwd,
        configuredModel,
        runtimeBindingFingerprint: options.runtimeBindingFingerprint,
        env: options.env,
      });
    }
  }

  async healthCheck(): Promise<KernelHealth> {
    const candidate = openCodeExecutableCandidate(this.options.command);
    return openCodeCommandHealth(probeCommandPath(candidate.command), candidate);
  }

  async discover(): Promise<KernelDiscovery> {
    return discoverOpenCodeKernel(this.options.command);
  }

  async startSession(input: KernelSessionStart): Promise<KernelSessionHandle> {
    const now = new Date().toISOString();
    return {
      kernelId: this.id,
      sessionId: input.sessionId,
      nativeSessionId: `opencode_${input.sessionId}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  async resumeSession(sessionId: string): Promise<KernelSessionHandle> {
    return this.startSession({ sessionId });
  }

  async *runTurn(request: KernelTurnRequest): AsyncIterable<AgentEvent> {
    if (this.runtime) {
      yield* this.runtime.runTurn(normalizeOpenCodeTurnRequest(request, this.options.env));
      return;
    }
    const runId = resolveRuntimeRunId(request.runId);
    const health = await this.healthCheck();
    const message =
      health.status !== "ok" && health.message
        ? health.message
        : `OpenCode CLI runtime is not initialized. Re-select OpenCode after installing or changing the executable.`;
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    yield { type: "assistant.delta", runId, text: message };
    yield { type: "model.response", runId, response: { text: message } };
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: {
        taskState: "TASK_STATE_REJECTED",
        reasonCode: "kernel_unavailable",
        retryable: false,
      },
    };
  }

  compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    return (
      this.runtime?.compactSession?.(request) ??
      Promise.resolve({
        ok: false,
        compacted: false,
        error: "compact_unavailable",
      })
    );
  }

  async compact(
    sessionId: string,
    options?: { reason?: string; maxTokens?: number; metadata?: AgentCompactRequest["metadata"] },
  ): Promise<void> {
    const result = await this.compactSession({
      threadId: sessionId,
      reason: options?.reason,
      maxTokens: options?.maxTokens,
      metadata: options?.metadata,
    });
    if (!result.ok) {
      throw new Error(result.error || "compact_unavailable");
    }
  }

  async dispose(): Promise<void> {
    await disposeRuntime(this.runtime);
  }
}

export function createOpenCodeKernelAdapter(options: OpenCodeKernelAdapterOptions = {}): OpenCodeKernelAdapter {
  return new OpenCodeKernelAdapter(options);
}

export function createOpenCodeKernelAdapterFromOptions(
  options: import("../types.js").KernelCreateOptions,
): OpenCodeKernelAdapter {
  const command = options.command || resolveOpenCodeCommand();
  const configuredModel = options.env.OPENCODE_CONFIG_CONTENT ? undefined : options.model;
  return new OpenCodeKernelAdapter({
    command,
    cwd: options.cwd,
    configuredModel,
    runtimeBindingFingerprint: options.runtimeBindingFingerprint,
    env: options.env,
  });
}

export function discoverOpenCodeKernel(configuredCommand?: string): KernelDiscovery {
  const candidate = openCodeExecutableCandidate(configuredCommand);
  const discovery = probeCommandPath(candidate.command);
  const command = discovery.resolvedPath;
  const installed = Boolean(command);
  const available = installed && discovery.probe.status !== "failed";
  const configHome = resolveHomePath(".config", "opencode");
  return {
    kernelId: "opencode",
    title: "OpenCode",
    installed,
    available,
    binaryPath: command,
    version: discovery.probe.version,
    executableProbe: kernelExecutableProbe(discovery, {
      role: "runtime-required",
      source: candidate.source,
      sourceName: candidate.sourceName,
    }),
    health: openCodeCommandHealth(discovery, candidate),
    configHome,
    diagnostics: OPENCODE_KERNEL_CONTRACT.diagnostics,
    knowledgeSources: [
      directorySource({
        id: "opencode.config",
        title: "OpenCode config",
        kind: "config",
        scope: "user",
        path: "~/.config/opencode",
        knowledgeLike: false,
      }),
      fileSource({
        id: "opencode.project-config",
        title: "opencode.json",
        kind: "config",
        scope: "project",
        path: `${process.cwd()}/opencode.json`,
        knowledgeLike: false,
      }),
    ],
    installActions: [
      plannedInstallAction({
        id: "opencode.install",
        title: "Install OpenCode",
        command: ["npm", "install", "-g", "opencode-ai"],
      }),
    ],
    notes: [
      "OpenGrove uses `opencode acp` instead of one-shot `opencode run`, so assistant deltas, tool calls, and permission requests stay structured.",
    ],
  };
}

function openCodeExecutableCandidate(configuredCommand: string | undefined) {
  const configured = configuredCommand?.trim();
  if (configured) {
    return { command: configured, source: "configured" as const, sourceName: undefined };
  }
  const environment = readAppEnv("OPENCODE_BIN")?.trim();
  if (environment) {
    return { command: environment, source: "environment" as const, sourceName: appEnvName("OPENCODE_BIN") };
  }
  return { command: "opencode", source: "path" as const };
}

function openCodeCommandHealth(
  discovery: ReturnType<typeof probeCommandPath>,
  candidate: ReturnType<typeof openCodeExecutableCandidate>,
): KernelHealth {
  return commandDiscoveryHealth(discovery, {
    title: "OpenCode",
    role: "runtime-required",
    source: candidate.source,
    sourceName: candidate.sourceName,
    missingMessage: `OpenCode CLI was not found. Set ${appEnvName("OPENCODE_BIN")}.`,
  });
}

export function resolveOpenCodeCommand(): string | undefined {
  const configured = readAppEnv("OPENCODE_BIN")?.trim();
  if (configured) return resolveUsableCommandPath(configured);
  return resolveUsableCommandPath("opencode");
}

// ===== OpenCode model / env normalization =====

function normalizeOpenCodeTurnRequest(
  request: KernelTurnRequest,
  env: NodeJS.ProcessEnv | undefined,
): KernelTurnRequest {
  const runtimeEnv = normalizeOpenCodeRuntimeEnv(request, env);
  const requestedModelId = normalizeOpenCodeModelId(
    request.requestedModelId,
    runtimeEnv?.OPENCODE_CONFIG_CONTENT ?? env?.OPENCODE_CONFIG_CONTENT,
  );
  return requestedModelId === request.requestedModelId && runtimeEnv === request.runtimeEnv
    ? request
    : { ...request, requestedModelId, runtimeEnv };
}

export function normalizeOpenCodeModelId(
  modelId: string | undefined,
  configContent: string | undefined,
): string | undefined {
  const trimmed = modelId?.trim();
  const config = parseJsonObject(configContent);
  const configuredDefault = readNonEmptyString(config.model);
  if (!trimmed || trimmed === "opencode-default") {
    return configuredDefault ?? OPENCODE_NATIVE_DEFAULT_MODEL;
  }
  if (isOpenGroveGenericModelId(trimmed)) {
    return configuredDefault ?? OPENCODE_NATIVE_DEFAULT_MODEL;
  }
  if (configuredDefault) {
    if (configuredDefault === trimmed || configuredDefault.endsWith(`/${trimmed}`)) {
      return configuredDefault;
    }
  }

  const providers = asRecord(config.provider);
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const models = asRecord(asRecord(providerConfig).models);
    if (Object.prototype.hasOwnProperty.call(models, trimmed)) {
      return `${providerId}/${trimmed}`;
    }
  }

  return trimmed;
}

function normalizeOpenCodeRuntimeEnv(
  request: KernelTurnRequest,
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  const sourceConfig =
    request.runtimeEnv?.OPENCODE_CONFIG_CONTENT ?? env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
  const nextConfig = openCodeConfigContentForAccessMode(sourceConfig, request.accessMode);
  if (request.runtimeEnv?.OPENCODE_CONFIG_CONTENT === nextConfig) return request.runtimeEnv;
  return {
    ...(request.runtimeEnv ?? {}),
    OPENCODE_CONFIG_CONTENT: nextConfig,
  };
}

export function openCodeConfigContentForAccessMode(
  configContent: string | undefined,
  accessMode: RuntimeAccessMode | undefined,
): string {
  const config = parseJsonObject(configContent);
  return JSON.stringify({
    $schema: readNonEmptyString(config.$schema) ?? OPENCODE_CONFIG_SCHEMA,
    model: OPENCODE_NATIVE_DEFAULT_MODEL,
    small_model: OPENCODE_NATIVE_DEFAULT_MODEL,
    ...config,
    permission: openCodePermissionForAccessMode(accessMode),
  });
}

function openCodePermissionForAccessMode(accessMode: RuntimeAccessMode | undefined): "allow" | { "*": "ask" } {
  return accessMode === "full-access" ? "allow" : { "*": "ask" };
}

function parseJsonObject(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    return asRecord(JSON.parse(input));
  } catch {
    return {};
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function readNonEmptyString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function isOpenGroveGenericModelId(modelId: string): boolean {
  return modelId.startsWith("gpt-") || modelId.startsWith("codex-");
}

async function disposeRuntime(runtime: AgentRuntime | undefined): Promise<void> {
  const disposable = runtime as
    | (AgentRuntime & {
        close?: () => void | Promise<void>;
        dispose?: () => void | Promise<void>;
      })
    | undefined;
  if (disposable?.dispose) {
    await disposable.dispose();
    return;
  }
  await disposable?.close?.();
}

// ===== Provider env builder =====

const OPENCODE_BEDROCK_PROVIDER_ID = "amazon-bedrock";
const OPENCODE_PROVIDER_PACKAGES: Record<ProviderProtocol, string> = {
  "openai-compatible": "@ai-sdk/openai-compatible",
  "anthropic-compatible": "@ai-sdk/anthropic",
  "gemini-compatible": "@ai-sdk/google",
};

export function buildOpenCodeProviderEnv(profile: ProviderProfile): Record<string, string> | undefined {
  // AWS Bedrock path (anthropic-compatible protocol)
  if (profile.protocol === "anthropic-compatible" && profile.credentialKind === "aws" && profile.baseUrl) {
    const env: Record<string, string> = {};
    if (profile.apiKey) env.AWS_BEARER_TOKEN_BEDROCK = profile.apiKey;
    const configContent = opencodeBedrockConfigContent(profile);
    if (configContent) env.OPENCODE_CONFIG_CONTENT = configContent;
    return Object.keys(env).length ? env : undefined;
  }

  if (!profile.baseUrl || !profile.apiKey) return undefined;
  const env: Record<string, string> =
    profile.protocol && profile.protocol !== "openai-compatible"
      ? {}
      : {
          OPENAI_BASE_URL: profile.baseUrl,
          OPENAI_API_KEY: profile.apiKey,
          MODEL_BASE_URL: profile.baseUrl,
          MODEL_API_KEY: profile.apiKey,
        };
  const configContent = opencodeApiConfigContent(profile);
  if (configContent) env.OPENCODE_CONFIG_CONTENT = configContent;
  if (profile.model) {
    env.OPENAI_MODEL = profile.model;
    env.DEFAULT_MODEL = profile.model;
    env.DEEPSEEK_MODEL = profile.model;
    env.QWEN_CODE_MODEL = profile.model;
  }
  return env;
}

function opencodeApiConfigContent(profile: ProviderProfile): string | undefined {
  if (!profile.baseUrl || !profile.apiKey) return undefined;
  const providerKey = opencodeProviderKey(profile.id, profile.protocol);
  const qualifiedModel = profile.model ? `${providerKey}/${profile.model}` : undefined;
  const config = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    ...(qualifiedModel ? { model: qualifiedModel, small_model: qualifiedModel } : {}),
    provider: {
      [providerKey]: {
        npm:
          (!profile.protocol || profile.protocol === "openai-compatible") && profile.wireApi === "responses"
            ? "@ai-sdk/openai"
            : OPENCODE_PROVIDER_PACKAGES[profile.protocol ?? "openai-compatible"],
        name: profile.name || profile.id,
        options: {
          // Anthropic's SDK adds /v1 itself; the AI SDK expects it in baseURL.
          baseURL:
            profile.protocol === "anthropic-compatible"
              ? `${profile.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`
              : profile.baseUrl,
          apiKey: profile.apiKey,
        },
        models: opencodeModelsConfig(profile.models, profile.model),
      },
    },
  };
  return JSON.stringify(config);
}

function opencodeBedrockConfigContent(profile: ProviderProfile): string | undefined {
  const providerKey = OPENCODE_BEDROCK_PROVIDER_ID;
  const qualifiedModel = profile.model ? `${providerKey}/${profile.model}` : undefined;
  const endpoint = profile.baseUrl?.trim();
  const region = endpoint?.match(/bedrock-runtime[.-]([a-z0-9-]+)\.amazonaws\.com/i)?.[1];
  const options: Record<string, string> = {};
  if (region) options.region = region;
  if (endpoint) options.endpoint = endpoint;
  const config = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    ...(qualifiedModel ? { model: qualifiedModel, small_model: qualifiedModel } : {}),
    provider: {
      [providerKey]: {
        name: profile.name || profile.id,
        ...(Object.keys(options).length ? { options } : {}),
        models: opencodeModelsConfig(profile.models, profile.model),
      },
    },
  };
  return JSON.stringify(config);
}

function opencodeModelsConfig(
  models: ModelOption[] | undefined,
  selectedModel: string | undefined,
): Record<string, unknown> {
  const seen = new Set<string>();
  const ids = [selectedModel, ...(models ?? []).map((m) => m.id)]
    .map((id) => id?.trim())
    .filter((id): id is string => Boolean(id && !seen.has(id) && seen.add(id)));
  return Object.fromEntries(
    ids.map((id) => {
      const model = models?.find((m) => m.id === id || m.apiModelId === id);
      const providerModelId = extractProviderModelId(model);
      return [
        id,
        {
          ...(providerModelId && providerModelId !== id ? { id: providerModelId } : {}),
          name: model?.label || id,
          ...(model?.metadata?.toolCall !== undefined ? { tool_call: model.metadata.toolCall } : {}),
          ...(model?.metadata?.reasoning !== undefined ? { reasoning: model.metadata.reasoning } : {}),
          ...(model?.metadata?.interleaved ? { interleaved: model.metadata.interleaved } : {}),
          ...(model?.metadata?.inputModalities || model?.metadata?.outputModalities
            ? { modalities: { input: model.metadata.inputModalities, output: model.metadata.outputModalities } }
            : {}),
          ...(model?.metadata?.contextWindow || model?.metadata?.maxOutputTokens
            ? {
                limit: {
                  ...(model.metadata.contextWindow ? { context: model.metadata.contextWindow } : {}),
                  ...(model.metadata.maxOutputTokens ? { output: model.metadata.maxOutputTokens } : {}),
                },
              }
            : {}),
        },
      ];
    }),
  );
}

function extractProviderModelId(model: ModelOption | undefined): string | undefined {
  return model?.apiModelId?.trim() || model?.description?.match(/provider model:\s*(.+)$/i)?.[1]?.trim();
}

export function opencodeProviderKey(providerId: string, protocol?: ProviderProtocol): string {
  const normalized = providerId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (isAwsBedrockProviderId(normalized)) return OPENCODE_BEDROCK_PROVIDER_ID;
  if (normalized === "gemini" && protocol === "gemini-compatible") return "google";
  if (normalized === "anthropic" && protocol === "anthropic-compatible") return "anthropic";
  return `opengrove-${normalized || "provider"}`.slice(0, 64);
}

function isAwsBedrockProviderId(providerId: string): boolean {
  return (
    providerId === "aws-bedrock" || providerId === "aws-bedrock-api-key" || providerId === OPENCODE_BEDROCK_PROVIDER_ID
  );
}

export function opencodeModelIdForProvider(providerId: string, model: string, protocol?: ProviderProtocol): string {
  return `${opencodeProviderKey(providerId, protocol)}/${model}`;
}

export function opencodeSupportsProvider(profile: BridgeProviderProfile): boolean {
  return Boolean(
    profile.openaiBaseUrl?.trim() ||
      profile.geminiBaseUrl?.trim() ||
      profile.anthropicBaseUrl?.trim() ||
      ((profile.credentialKind === "aws" || isAwsBedrockProviderId(profile.id)) && profile.models.length),
  );
}

// ===== Kernel-local Provider route reader =====

export function readOpenCodeLocalRouteProfile(configHomeOverride?: string): KernelLocalRouteProfile {
  const defaultHome = resolve(homedir(), ".config/opencode");
  const home = configHome(configHomeOverride, ".config/opencode");
  const configPath = resolve(home, "opencode.json");
  const usesDefaultHome = resolve(home) === resolve(defaultHome);
  const dataHome = usesDefaultHome
    ? resolve(process.env.XDG_DATA_HOME?.trim() || resolve(homedir(), ".local/share"), "opencode")
    : home;
  const authPath = resolve(dataHome, "auth.json");
  const auth = readJsonObject(authPath);
  const credentialId = firstConfiguredCredentialId(auth);
  const providerId = credentialId || "opencode-native";
  return {
    kernel: "opencode",
    source: [configPath, authPath].filter((path) => existsSync(path)).join(",") || "opencode-defaults",
    sourcePaths: [configPath, authPath],
    env: {},
    providerId,
    providerLabel: credentialId ? providerDisplayName(credentialId) : "OpenCode",
    authConfigured: Boolean(credentialId),
    routeKind: "provider",
    models: [],
  };
}
