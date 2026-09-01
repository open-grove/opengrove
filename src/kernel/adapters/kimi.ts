import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentEvent } from "../../core.js";
import type { AgentCompactRequest, AgentCompactResult, AgentRuntime } from "../../core.js";
import { appEnvName, readAppEnv } from "../../identity.js";
import { AcpCliRuntime } from "../../runtime/acp-cli-runtime.js";
import {
  commandDiscoveryHealth,
  directorySource,
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
  ProviderProfile,
} from "../types.js";
import { APP_PROTOCOL_ID } from "../../identity.js";
import {
  type KernelLocalRouteProfile,
  configHome,
  modelDisplayName,
  readFileText,
  readJsonObject,
  readTomlString,
} from "./profile-utils.js";
import { acpKernelOwnership } from "./acp-contract.js";

const KIMI_CAPABILITIES: KernelCapabilities = {
  sessionHistory: "kernel",
  reasoning: { nativeText: "conditional", summary: "unsupported" },
  streaming: true,
  toolCalls: true,
  hostTools: bridgeKernelSupportsHostTools("kimi"),
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

export const KIMI_KERNEL_CONTRACT: KernelAdapterContract = {
  paths: {
    configHomeEnvVar: "KIMI_CODE_HOME",
    defaultConfigHome: ".kimi-code",
    cliCommand: "kimi",
    projectSkillDir: ".kimi-code/skills",
    nativeSkillMarker: "/.kimi-code/skills/",
    knowledgeBuckets: [{ pathContains: "/.kimi-code/skills/", bucket: "kimi.skills" }],
    defaultKnowledgeBucket: `${APP_PROTOCOL_ID}.skills`,
  },
  display: {
    defaultModelId: "kimi-default",
    modelDisplayAliases: [],
    modelDisplaySuffixAlias: null,
  },
  inputFormats: {
    planMode: {
      withInput: "Create a plan first before taking action:\n{input}",
      withoutInput: "Create a plan first before taking action.",
    },
    skillInvocation: {
      withArgs: "/skill:{name} {args}",
      withoutArgs: "/skill:{name}",
      promptPlacement: "prompt-prefix",
    },
    modelAliasStrategy: "none",
    nativeModelNormalization: false,
  },
  labels: { title: "Kimi Code", integrationMode: "acp" },
  ownership: acpKernelOwnership("Kimi Code", { hostTools: true }),
  diagnostics: {
    defaultModeId: "acp-bridge",
    modes: [
      {
        id: "acp-bridge",
        title: "Kimi Code ACP bridge",
        layer: "process-stdio",
        status: "implemented",
        redaction: "redacted",
        notes: ["Kimi Code supports ACP out of the box through `kimi acp`; OpenGrove uses that path directly."],
      },
      {
        id: "process-stdio",
        title: "Kimi Code process stdio",
        layer: "process-stdio",
        status: "implemented",
        redaction: "redacted",
      },
    ],
  },
  notes: ["Kimi Code supports ACP out of the box through `kimi acp`; OpenGrove uses that path directly."],
};

export interface KimiKernelAdapterOptions {
  command?: string;
  cwd?: string;
  configuredModel?: string;
  runtimeBindingFingerprint?: string;
  env?: NodeJS.ProcessEnv;
}

export class KimiKernelAdapter implements KernelAdapter {
  readonly id = "kimi" as const;
  readonly title = "Kimi Code";
  readonly capabilities = KIMI_CAPABILITIES;
  readonly contract = KIMI_KERNEL_CONTRACT;
  readonly bindingMode = "env" as const;
  private readonly runtime?: AgentRuntime;

  constructor(private readonly options: KimiKernelAdapterOptions = {}) {
    const command = options.command || resolveKimiCommand();
    if (command) {
      this.runtime = new AcpCliRuntime({
        kernelId: "kimi",
        title: "Kimi Code",
        command,
        acpArgs: ["acp"],
        setModelFailure: "error",
        cwd: options.cwd,
        configuredModel: options.configuredModel,
        runtimeBindingFingerprint: options.runtimeBindingFingerprint,
        skillInvocationPromptPlacement: KIMI_KERNEL_CONTRACT.inputFormats.skillInvocation.promptPlacement,
        env: options.env,
      });
    }
  }

  async healthCheck(): Promise<KernelHealth> {
    const candidate = kimiExecutableCandidate(this.options.command);
    return kimiCommandHealth(probeCommandPath(candidate.command), candidate);
  }

  async discover(): Promise<KernelDiscovery> {
    return discoverKimiKernel(this.options.command);
  }

  async startSession(input: KernelSessionStart): Promise<KernelSessionHandle> {
    const now = new Date().toISOString();
    return {
      kernelId: this.id,
      sessionId: input.sessionId,
      nativeSessionId: `kimi_${input.sessionId}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  async resumeSession(sessionId: string): Promise<KernelSessionHandle> {
    return this.startSession({ sessionId });
  }

  async *runTurn(request: KernelTurnRequest): AsyncIterable<AgentEvent> {
    if (this.runtime) {
      yield* this.runtime.runTurn(request);
      return;
    }
    const runId = request.runId ?? `run_${Date.now()}`;
    const health = await this.healthCheck();
    const message =
      health.status !== "ok" && health.message
        ? health.message
        : `Kimi Code CLI runtime is not initialized. Re-select Kimi Code after installing or changing the executable.`;
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    yield { type: "assistant.delta", runId, text: message };
    yield { type: "model.response", runId, response: { text: message } };
    yield { type: "turn.finished", runId, at: new Date().toISOString() };
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

export function createKimiKernelAdapter(options: KimiKernelAdapterOptions = {}): KimiKernelAdapter {
  return new KimiKernelAdapter(options);
}

export function createKimiKernelAdapterFromOptions(
  options: import("../types.js").KernelCreateOptions,
): KimiKernelAdapter {
  const command = options.command || resolveKimiCommand();
  return new KimiKernelAdapter({
    command,
    cwd: options.cwd,
    configuredModel: options.model,
    runtimeBindingFingerprint: options.runtimeBindingFingerprint,
    env: options.env,
  });
}

export function discoverKimiKernel(configuredCommand?: string): KernelDiscovery {
  const candidate = kimiExecutableCandidate(configuredCommand);
  const discovery = probeCommandPath(candidate.command);
  const command = discovery.resolvedPath;
  const installed = Boolean(command);
  const available = installed && discovery.probe.status !== "failed";
  const configHome = resolveHomePath(".kimi-code");
  return {
    kernelId: "kimi",
    title: "Kimi Code",
    installed,
    available,
    binaryPath: command,
    version: discovery.probe.version,
    executableProbe: kernelExecutableProbe(discovery, {
      role: "runtime-required",
      source: candidate.source,
      sourceName: candidate.sourceName,
    }),
    health: kimiCommandHealth(discovery, candidate),
    configHome,
    diagnostics: KIMI_KERNEL_CONTRACT.diagnostics,
    knowledgeSources: [
      directorySource({
        id: "kimi.skills",
        title: "skills",
        kind: "skills",
        scope: "user",
        path: "~/.kimi-code/skills",
      }),
      directorySource({
        id: "kimi.config",
        title: "Kimi config",
        kind: "config",
        scope: "user",
        path: "~/.kimi-code",
        knowledgeLike: false,
      }),
    ],
    installActions: [
      plannedInstallAction({
        id: "kimi.install",
        title: "安装 Kimi Code",
        command: ["sh", "-c", "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"],
      }),
    ],
    notes: ["Kimi Code supports ACP out of the box through `kimi acp`; OpenGrove uses that path directly."],
  };
}

function kimiExecutableCandidate(configuredCommand: string | undefined) {
  const configured = configuredCommand?.trim();
  if (configured) {
    return { command: configured, source: "configured" as const, sourceName: undefined };
  }
  const environment = readAppEnv("KIMI_BIN")?.trim();
  if (environment) {
    return { command: environment, source: "environment" as const, sourceName: appEnvName("KIMI_BIN") };
  }
  return { command: "kimi", source: "path" as const };
}

function kimiCommandHealth(
  discovery: ReturnType<typeof probeCommandPath>,
  candidate: ReturnType<typeof kimiExecutableCandidate>,
): KernelHealth {
  return commandDiscoveryHealth(discovery, {
    title: "Kimi Code",
    role: "runtime-required",
    source: candidate.source,
    sourceName: candidate.sourceName,
    missingMessage: `Kimi Code CLI was not found. Set ${appEnvName("KIMI_BIN")}.`,
  });
}

export function resolveKimiCommand(): string | undefined {
  const configured = readAppEnv("KIMI_BIN")?.trim();
  if (configured) return resolveUsableCommandPath(configured);
  return resolveUsableCommandPath("kimi");
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

export function buildKimiProviderEnv(profile: ProviderProfile): Record<string, string> | undefined {
  if (!profile.apiKey || !profile.baseUrl || !profile.model) return undefined;
  const providerType =
    profile.protocol === "anthropic-compatible"
      ? "anthropic"
      : profile.protocol === "openai-compatible"
        ? "openai"
        : undefined;
  if (!providerType) return undefined;
  return {
    KIMI_MODEL_NAME: profile.model,
    KIMI_MODEL_API_KEY: profile.apiKey,
    KIMI_MODEL_BASE_URL: profile.baseUrl,
    KIMI_MODEL_PROVIDER_TYPE: providerType,
  };
}

// ===== Kernel-local Login route reader =====

export function readKimiLocalRouteProfile(configHomeOverride?: string): KernelLocalRouteProfile {
  const home = configHome(configHomeOverride, ".kimi-code");
  const configPath = resolve(home, "config.toml");
  const credentialPath = resolve(home, "credentials", "kimi-code.json");
  const config = readFileText(configPath);
  const credential = readJsonObject(credentialPath);
  const defaultModel = readTomlString(config, "default_model");
  const authConfigured = hasUsableKimiCredential(credential);
  return {
    kernel: "kimi",
    source: [configPath, credentialPath].filter((path) => existsSync(path)).join(",") || "kimi-defaults",
    sourcePaths: [configPath, credentialPath],
    env: {},
    providerId: "kimi-code",
    providerLabel: "Kimi Code",
    authConfigured,
    routeKind: "login",
    models: defaultModel ? [{ id: defaultModel, label: modelDisplayName(defaultModel) }] : [],
    defaultModel,
  };
}

function hasUsableKimiCredential(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  if (hasNonEmptyCredentialField(credential, ["key", "apiKey", "api_key"])) return true;
  if (hasNonEmptyCredentialField(credential, ["refresh", "refresh_token"])) return true;
  if (!hasNonEmptyCredentialField(credential, ["token", "access", "access_token"])) return false;
  const expiresAt = credentialExpiryTime(credential.expires_at ?? credential.expiresAt);
  return expiresAt === undefined || expiresAt > now;
}

function hasNonEmptyCredentialField(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof record[key] === "string" && Boolean((record[key] as string).trim()));
}

function credentialExpiryTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1_000_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric >= 1_000_000_000_000 ? numeric : numeric * 1_000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
