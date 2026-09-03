import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentCompactRequest, AgentCompactResult, AgentEvent } from "../../core.js";
import {
  HermesRuntime,
  resolveInstalledHermesCommandPath,
  type HermesRuntimeOptions,
} from "../../runtime/hermes-runtime.js";
import { resolveRuntimeRunId } from "../../runtime/run-id.js";
import { APP_CONFIG_DIR, APP_PRODUCT_NAME, APP_PROTOCOL_ID, appEnvName, readAppEnv } from "../../identity.js";
import {
  commandDiscoveryHealth,
  directorySource,
  fileSource,
  kernelExecutableProbe,
  plannedInstallAction,
  probeCommandPath,
  resolveHomePath,
} from "../discovery.js";
import { bridgeKernelSupportsHostTools } from "../host-tools.js";
import type { KernelIntegrationManifest } from "../manifest.js";
import type {
  KernelAdapter,
  KernelAdapterContract,
  KernelCapabilities,
  KernelDiscovery,
  KernelHealth,
  KernelSessionHandle,
  KernelSessionStart,
  KernelTurnRequest,
  CompactOptions,
  ProviderProfile,
} from "../types.js";
import type { AgentSteerRequest, AgentSteerResult } from "../../core.js";
import type { BridgeRuntimeControls } from "../../server/bridge-types.js";
import { readHermesConfiguredModel } from "./profile-utils.js";
import {
  type KernelLocalRouteProfile,
  configHome,
  modelDisplayName,
  readDotEnvFile,
  readFileText,
  readSelectedProcessEnv,
  readYamlMapKeys,
  readYamlString,
} from "./profile-utils.js";

const HERMES_CAPABILITIES: KernelCapabilities = {
  sessionHistory: "kernel",
  reasoning: { nativeText: "conditional", summary: "unsupported" },
  streaming: true,
  toolCalls: true,
  hostTools: bridgeKernelSupportsHostTools("hermes"),
  approvals: true,
  elicitation: true,
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

export interface HermesKernelAdapterOptions extends Partial<HermesRuntimeOptions> {}

export class HermesKernelAdapter implements KernelAdapter {
  readonly id = "hermes";
  readonly title = "Hermes";
  readonly capabilities = HERMES_CAPABILITIES;
  readonly contract = HERMES_KERNEL_CONTRACT;
  private readonly runtime?: HermesRuntime;

  constructor(private readonly options: HermesKernelAdapterOptions = {}) {
    if (options.command) {
      this.runtime = new HermesRuntime({
        ...options,
        configuredProvider: options.configuredProvider ?? readHermesConfiguredProvider(),
        toolsets: options.toolsets ?? readHermesToolsets(),
      } as HermesRuntimeOptions);
    }
  }

  async healthCheck(): Promise<KernelHealth> {
    const candidate = hermesExecutableCandidate(this.options.command);
    return hermesCommandHealth(probeCommandPath(candidate.command), candidate);
  }

  async discover(): Promise<KernelDiscovery> {
    return discoverHermesKernel(this.options, process.cwd(), this.contract.diagnostics);
  }

  async startSession(input: KernelSessionStart): Promise<KernelSessionHandle> {
    const now = new Date().toISOString();
    return {
      kernelId: this.id,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
    };
  }

  async resumeSession(sessionId: string): Promise<KernelSessionHandle> {
    return this.startSession({ sessionId });
  }

  async dispose(): Promise<void> {
    this.runtime?.close();
  }

  async *runTurn(request: KernelTurnRequest): AsyncIterable<AgentEvent> {
    if (this.runtime) {
      yield* this.runtime.runTurn(request);
      return;
    }

    const runId = resolveRuntimeRunId(request.runId);
    yield { type: "turn.started", runId, at: new Date().toISOString() };
    if (request.assembledContext) {
      yield { type: "context.assembled", runId, context: request.assembledContext };
    }
    yield {
      type: "error",
      runId,
      message: `Hermes kernel adapter is selected, but no Hermes CLI command is configured. Install Hermes or set ${appEnvName("HERMES_BIN")}.`,
    };
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

  steerTurn(request: AgentSteerRequest): Promise<AgentSteerResult> {
    return (
      this.runtime?.steerTurn(request) ??
      Promise.resolve({
        ok: false,
        guided: false,
        error: "steer_unavailable",
      })
    );
  }

  compactSession(request: AgentCompactRequest): Promise<AgentCompactResult> {
    return (
      this.runtime?.compactSession(request) ??
      Promise.resolve({
        ok: false,
        compacted: false,
        error: "compact_unavailable",
      })
    );
  }

  async compact(sessionId: string, options?: CompactOptions): Promise<void> {
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
}

export function createHermesKernelAdapter(options: HermesKernelAdapterOptions = {}): HermesKernelAdapter {
  return new HermesKernelAdapter(options);
}

export function createHermesKernelAdapterFromOptions(
  options: import("../types.js").KernelCreateOptions,
): HermesKernelAdapter {
  const candidate = hermesExecutableCandidate(options.command);
  const candidateProbe = probeCommandPath(candidate.command);
  const command =
    candidateProbe.resolvedPath && candidateProbe.probe.status !== "failed" ? candidateProbe.resolvedPath : undefined;
  if (!command) {
    throw new Error(hermesCommandHealth(candidateProbe, candidate).message || "Hermes CLI was not found.");
  }
  const providerConfig = options.provider
    ? hermesProviderConfigFromProfile(options.provider, options.model)
    : undefined;
  const configuredModel = providerConfig ? options.model || readHermesConfiguredModel() : readHermesConfiguredModel();
  const nativeSkillDir = join(resolve(options.cwd), APP_CONFIG_DIR, "native-skills", "hermes");
  return new HermesKernelAdapter({
    command,
    cwd: options.cwd,
    configuredModel,
    configuredProvider: providerConfig?.providerKey,
    runtimeBindingFingerprint: options.runtimeBindingFingerprint,
    providerConfig,
    nativeSkillDir,
    env: options.env,
  });
}

function hermesProviderConfigFromProfile(
  provider: import("../types.js").ProviderProfile,
  model: string | undefined,
): import("../../runtime/hermes-runtime.js").HermesProviderRuntimeConfig | undefined {
  const baseUrl = provider.baseUrl?.trim();
  if (!baseUrl) return undefined;
  const protocol = provider.protocol;
  const apiMode: import("../../runtime/hermes-runtime.js").HermesProviderApiMode =
    protocol === "anthropic-compatible" ? "anthropic_messages" : "chat_completions";
  const providerKey = `opengrove-${
    provider.id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider"
  }`.slice(0, 64);
  const envKey = `OPENGROVE_${
    provider.id
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "PROVIDER"
  }_API_KEY`;
  return {
    providerKey,
    name: provider.id,
    baseUrl,
    apiKeyEnv: provider.apiKeyEnv || envKey,
    apiMode,
    model: model?.trim(),
    models: [],
  };
}

function readHermesConfiguredProvider() {
  return readAppEnv("HERMES_PROVIDER")?.trim() || undefined;
}

function readHermesToolsets() {
  const raw = readAppEnv("HERMES_TOOLSETS")?.trim();
  if (!raw) {
    return undefined;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function discoverHermesKernel(
  options: HermesKernelAdapterOptions = {},
  cwd = process.cwd(),
  diagnostics = HERMES_KERNEL_CONTRACT.diagnostics,
): KernelDiscovery {
  const hermesHome = options.env?.HERMES_HOME || process.env.HERMES_HOME || resolveHomePath(".hermes");
  const candidate = hermesExecutableCandidate(options.command);
  const discovery = probeCommandPath(candidate.command);
  const command = discovery.resolvedPath;
  const installed = Boolean(command);
  const available = installed && discovery.probe.status !== "failed";
  return {
    kernelId: "hermes",
    title: "Hermes",
    installed,
    available,
    binaryPath: command,
    version: discovery.probe.version,
    executableProbe: kernelExecutableProbe(discovery, {
      role: "runtime-required",
      source: candidate.source,
      sourceName: candidate.sourceName,
    }),
    health: hermesCommandHealth(discovery, candidate),
    configHome: hermesHome,
    diagnostics,
    knowledgeSources: [
      fileSource({
        id: "hermes.soul",
        title: "SOUL.md",
        kind: "project_instructions",
        scope: "user",
        path: `${hermesHome}/SOUL.md`,
        native: true,
        syncMode: "index",
        description: "Hermes 全局身份/行为底座。",
      }),
      directorySource({
        id: "hermes.local-skills",
        title: "skills",
        kind: "skills",
        scope: "user",
        path: `${hermesHome}/skills`,
        native: true,
        syncMode: "index",
      }),
      directorySource({
        id: `hermes.${APP_PROTOCOL_ID}-external-skills`,
        title: `${APP_PRODUCT_NAME} external Hermes skills`,
        kind: "skills",
        scope: "external",
        path: options.nativeSkillDir || `${cwd}/${APP_CONFIG_DIR}/native-skills/hermes`,
        native: true,
        userVisible: false,
        knowledgeLike: false,
        syncMode: "publish",
        description: `${APP_PRODUCT_NAME} 发布给 Hermes 的 external skill directory；Hermes 通过 skills.external_dirs 使用。`,
      }),
      directorySource({
        id: "hermes.memories",
        title: "memory",
        kind: "memory",
        scope: "user",
        path: `${hermesHome}/memories`,
        native: true,
        syncMode: "index",
      }),
      directorySource({
        id: "hermes.sessions",
        title: "Hermes sessions",
        kind: "sessions",
        scope: "user",
        path: `${hermesHome}/sessions`,
        native: true,
        knowledgeLike: false,
        enabledByDefault: false,
        syncMode: "none",
      }),
      directorySource({
        id: "hermes.logs",
        title: "Hermes logs",
        kind: "logs",
        scope: "user",
        path: `${hermesHome}/logs`,
        native: true,
        knowledgeLike: false,
        enabledByDefault: false,
        syncMode: "none",
      }),
      directorySource({
        id: "hermes.cron",
        title: "Hermes cron jobs",
        kind: "toolsets",
        scope: "user",
        path: `${hermesHome}/cron`,
        native: true,
        knowledgeLike: true,
        enabledByDefault: false,
        syncMode: "index",
      }),
      fileSource({
        id: "hermes.config",
        title: "Hermes config.yaml",
        kind: "config",
        scope: "user",
        path: `${hermesHome}/config.yaml`,
        native: true,
        knowledgeLike: false,
        syncMode: "none",
      }),
      fileSource({
        id: "hermes.env",
        title: "Hermes .env",
        kind: "auth",
        scope: "user",
        path: `${hermesHome}/.env`,
        native: true,
        userVisible: false,
        knowledgeLike: false,
        enabledByDefault: false,
        syncMode: "none",
      }),
      fileSource({
        id: "hermes.state-db",
        title: "Hermes state.db",
        kind: "memory",
        scope: "user",
        path: `${hermesHome}/state.db`,
        native: true,
        knowledgeLike: false,
        enabledByDefault: false,
        syncMode: "none",
      }),
    ],
    installActions: [
      plannedInstallAction({
        id: "hermes.install",
        title: "Install Hermes Agent CLI",
        command: [
          "bash",
          "-lc",
          "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup",
        ],
      }),
    ],
    notes: [
      `Hermes 的 skills/memories/config 都在 ~/.hermes 下，外部 skill 目录是 ${APP_PRODUCT_NAME} 与 Hermes 对接的关键入口。`,
      `Transport: ${HERMES_KERNEL_MANIFEST.transport.primary}.`,
    ],
  };
}

function hermesExecutableCandidate(configuredCommand: string | undefined) {
  const configured = configuredCommand?.trim();
  if (configured) {
    return { command: configured, source: "configured" as const, sourceName: undefined };
  }
  const environment = readAppEnv("HERMES_BIN")?.trim();
  if (environment) {
    return { command: environment, source: "environment" as const, sourceName: appEnvName("HERMES_BIN") };
  }
  return { command: resolveInstalledHermesCommandPath(), source: "discovered" as const };
}

function hermesCommandHealth(
  discovery: ReturnType<typeof probeCommandPath>,
  candidate: ReturnType<typeof hermesExecutableCandidate>,
): KernelHealth {
  return commandDiscoveryHealth(discovery, {
    title: "Hermes",
    role: "runtime-required",
    source: candidate.source,
    sourceName: candidate.sourceName,
    missingMessage: `Hermes CLI command is not configured. Install Hermes or set ${appEnvName("HERMES_BIN")}.`,
  });
}

export const HERMES_KERNEL_CONTRACT: KernelAdapterContract = {
  paths: {
    configHomeEnvVar: "HERMES_HOME",
    defaultConfigHome: ".hermes",
    cliCommand: "hermes",
    projectSkillDir: `${APP_CONFIG_DIR}/native-skills/hermes`,
    nativeSkillMarker: `/${APP_CONFIG_DIR}/native-skills/hermes/`,
    knowledgeBuckets: [
      { pathContains: `/${APP_CONFIG_DIR}/native-skills/hermes/`, bucket: `hermes.${APP_PROTOCOL_ID}-external-skills` },
      { pathContains: "/.hermes/memories/", bucket: "hermes.memories" },
    ],
    defaultKnowledgeBucket: "hermes.local-skills",
  },
  display: {
    defaultModelId: "hermes-default",
    modelDisplayAliases: [],
    modelDisplaySuffixAlias: null,
  },
  inputFormats: {
    planMode: {
      withInput: "Create a plan first before taking action:\n{input}",
      withoutInput: "Create a plan first before taking action.",
    },
    skillInvocation: {
      withArgs: "Use the native Hermes skill {name} for this request.\n\n{args}",
      withoutArgs: "Use the native Hermes skill {name} for this request.",
    },
    modelAliasStrategy: "none",
    nativeModelNormalization: false,
  },
  labels: { title: "Hermes", integrationMode: "acp" },
  ownership: [
    {
      feature: "session",
      owner: "adapter",
      nativeName: "Hermes TUI Gateway session",
      appResponsibility: `Own ${APP_PRODUCT_NAME} session/run ids and persist the Hermes Gateway session id binding.`,
      adapterResponsibility: `Create or reuse Hermes TUI Gateway sessions over stdio JSON-RPC and map them to ${APP_PRODUCT_NAME} sessions.`,
    },
    {
      feature: "turn_lifecycle",
      owner: "adapter",
      appResponsibility: `Record ${APP_PRODUCT_NAME} run lifecycle and trajectory.`,
      adapterResponsibility: `Send prompt.submit over Hermes TUI Gateway and normalize streamed event notifications into ${APP_PRODUCT_NAME} events.`,
    },
    {
      feature: "transport",
      owner: "adapter",
      nativeName: "Hermes TUI Gateway stdio JSON-RPC",
      adapterResponsibility: "Use structured Gateway requests/events rather than one-shot CLI output parsing.",
    },
    {
      feature: "model_loop",
      owner: "kernel",
      nativeName: "Hermes AIAgent",
      kernelResponsibility: "Own provider selection, model calls, native tools, rules, memory, and skill loading.",
      adapterResponsibility: "Use Hermes TUI Gateway instead of recreating its internal loop.",
    },
    {
      feature: "native_tool_execution",
      owner: "kernel",
      nativeName: "Hermes toolsets",
      kernelResponsibility: "Execute enabled Hermes toolsets inside the Hermes loop.",
      adapterResponsibility: `Map Hermes TUI Gateway tool.start/tool.complete events into ${APP_PRODUCT_NAME} tool.started/tool.finished events.`,
    },
    {
      feature: "host_tool_execution",
      owner: "unsupported",
      notes: "No Hermes host tool bridge is wired yet.",
    },
    {
      feature: "approval",
      owner: "shared",
      nativeName: "Hermes TUI Gateway approval.request",
      kernelResponsibility: "Decide when native tool execution requires permission.",
      adapterResponsibility: `Translate Hermes approval.request events into ${APP_PRODUCT_NAME} approvals and answer with approval.respond.`,
    },
    {
      feature: "user_question",
      owner: "shared",
      nativeName: "Hermes TUI Gateway clarify.request",
      kernelResponsibility: "Decide when the turn needs clarifying user input.",
      adapterResponsibility: `Translate clarify/sudo/secret requests into ${APP_PRODUCT_NAME} questions and answer with the matching Gateway respond method.`,
    },
    {
      feature: "skill_discovery",
      owner: "shared",
      nativeName: "Hermes skills_list / skill_view",
      appResponsibility: `Own ${APP_PRODUCT_NAME} vault skills and publication source.`,
      kernelResponsibility: "Discover local and external skills through Hermes' native skill tools.",
      adapterResponsibility: `Publish ${APP_PRODUCT_NAME} skills into an external skill directory and run Hermes with that directory configured.`,
    },
    {
      feature: "skill_loading",
      owner: "kernel",
      nativeName: "Hermes skill_view",
      appResponsibility: `Publish ${APP_PRODUCT_NAME} skills into the agreed Hermes external skill directory.`,
      kernelResponsibility: "Load SKILL.md and referenced files progressively through skill_view.",
      adapterResponsibility: `Avoid duplicating full ${APP_PRODUCT_NAME} skill bodies in prompt context when Hermes native skills are active.`,
    },
    {
      feature: "context_assembly",
      owner: "app",
      appResponsibility: `Pass explicit user-added context, attachments, and narrow ${APP_PRODUCT_NAME} surface hints.`,
    },
    {
      feature: "knowledge_retrieval",
      owner: "shared",
      appResponsibility: `Provide explicitly selected ${APP_PRODUCT_NAME} knowledge context.`,
      kernelResponsibility: "Own retrieval performed by Hermes-native web, file, and external tools.",
      adapterResponsibility:
        "Project certified tool lifecycle events without duplicating native retrieval in the Host.",
    },
    {
      feature: "artifact_extraction",
      owner: "app",
      appResponsibility: "Own artifact extraction once Hermes produces file/media references.",
    },
    {
      feature: "memory_write",
      owner: "app",
      appResponsibility: "Own memory writes, feedback, confidence, and decay.",
    },
    {
      feature: "compaction",
      owner: "adapter",
      nativeName: "Hermes TUI Gateway session.compress",
      adapterResponsibility: "Trigger native compression when the employee context budget is reached.",
      kernelResponsibility: "Summarize and rewrite the native session history.",
    },
    {
      feature: "auth",
      owner: "kernel",
      nativeName: "Hermes provider/config auth",
      kernelResponsibility: "Use Hermes config, .env, provider pools, or process env credentials.",
      adapterResponsibility: "Avoid logging provider credentials or other secrets.",
    },
    {
      feature: "sandbox",
      owner: "unsupported",
      notes: "No Hermes sandbox mapping is wired yet.",
    },
    {
      feature: "trajectory",
      owner: "app",
      appResponsibility: "Persist normalized trajectory records.",
    },
    {
      feature: "diagnostics",
      owner: "adapter",
      nativeName: "Hermes TUI Gateway JSON-RPC and process stderr",
      adapterResponsibility: `Expose ${APP_PRODUCT_NAME} trajectory plus Hermes Gateway/process diagnostic boundaries.`,
    },
  ],
  eventMappings: [
    {
      appEvent: "reasoning.started / reasoning.completed",
      nativeEvent: "reasoning.available / reasoning.delta",
      direction: "native_to_app",
      adapterResponsibility:
        "Preserve Hermes reasoning payloads as kind=native and keep them out of tool and answer events.",
    },
    {
      appEvent: "runtime.diagnostic",
      nativeEvent: "thinking.delta / reasoning.available / reasoning.delta",
      direction: "native_to_app",
      adapterResponsibility:
        "Aggregate Hermes reasoning transport counts once per message; never emit one diagnostic per token or treat animated thinking status as reasoning content.",
    },
    {
      appEvent: "model.requested",
      nativeRequest: "prompt.submit",
      direction: "app_to_native",
      adapterResponsibility:
        "Send the assembled turn prompt to Hermes TUI Gateway while preserving the OpenGrove run/session identity.",
    },
    {
      appEvent: "assistant.delta / model.response",
      nativeEvent: "message.delta / message.complete",
      direction: "native_to_app",
      adapterResponsibility: `Stream Hermes text chunks into ${APP_PRODUCT_NAME} assistant deltas and emit the completed model.response.`,
    },
    {
      appEvent: "tool.started / tool.finished",
      nativeEvent: "tool.start / tool.complete",
      direction: "native_to_app",
      adapterResponsibility: "Project Hermes native tool lifecycle into OpenGrove trajectory events.",
    },
    {
      appEvent: "approval.requested / approval.resolved",
      nativeRequest: "approval.request / approval.respond",
      direction: "bidirectional",
      adapterResponsibility: "Bridge Hermes native permission prompts to OpenGrove approval decisions.",
    },
    {
      appEvent: "question.requested / question.answered",
      nativeRequest: "clarify.request / clarify.respond",
      direction: "bidirectional",
      adapterResponsibility: "Bridge Hermes native clarification prompts to OpenGrove same-turn questions.",
    },
    {
      appEvent: "AbortSignal",
      nativeRequest: "session.interrupt",
      direction: "app_to_native",
      adapterResponsibility: "Request native interrupt when an OpenGrove run is stopped.",
    },
  ],
  diagnostics: {
    defaultModeId: "hermes-gateway-jsonrpc",
    modes: [
      {
        id: "hermes-gateway-jsonrpc",
        title: "Hermes TUI Gateway JSON-RPC stream",
        layer: "adapter-rpc",
        status: "implemented",
        enabledByDefault: true,
        redaction: "raw",
        notes: [
          "The adapter launches the Hermes venv python with `-u -m tui_gateway.entry` and exchanges line-delimited JSON-RPC messages over stdio.",
          `Hermes assistant chunks, tool calls, usage, clarification, and permission events are normalized into ${APP_PRODUCT_NAME} events.`,
        ],
      },
      {
        id: "hermes-process-stdio",
        title: "Hermes child process stderr",
        layer: "process-stdio",
        status: "implemented",
        enabledByDefault: false,
        redaction: "raw",
        notes: ["Captures the native Hermes process boundary for startup/runtime errors."],
      },
      {
        id: `${APP_PROTOCOL_ID}-trajectory`,
        title: `${APP_PRODUCT_NAME} trajectory JSON`,
        layer: "trajectory",
        status: "implemented",
        enabledByDefault: true,
        output: "data/trajectories/",
        redaction: "redacted",
      },
    ],
    nativeTranscript: {
      path: "~/.hermes/sessions/",
      availability: "partial",
      notes: [
        `Owned by Hermes. ${APP_PRODUCT_NAME} stores the Gateway session id binding and separately records normalized trajectory events for turn-level debugging.`,
      ],
    },
  },
  notes: [
    `Hermes has a real native skill system. ${APP_PRODUCT_NAME} publishes skills as external skill directories and should not host-inject duplicate skill bodies.`,
    "Hermes is bridged through TUI Gateway so session updates, tool calls, questions, and permission requests stay structured.",
  ],
};

export const HERMES_KERNEL_MANIFEST: KernelIntegrationManifest = {
  kernelId: "hermes",
  title: "Hermes",
  transport: {
    primary: "stdio-jsonrpc",
    launch: {
      command: "python",
      args: ["-u", "-m", "tui_gateway.entry"],
    },
    notes: [
      "Hermes TUI Gateway is the native host bridge for custom UIs. OpenGrove resolves the Hermes venv python from HERMES_BIN or HERMES_TUI_GATEWAY_PYTHON.",
    ],
  },
  session: {
    strategy: "native-persistent",
    nativeSessionKey: "hermesGatewaySessionIds",
    reuseAcrossModelChanges: false,
    notes: [
      "OpenGrove stores Hermes Gateway session ids by runtime binding fingerprint and reuses only sessions active in the current Gateway child.",
    ],
  },
  providerBinding: {
    mode: "config-file",
    configFiles: ["~/.hermes/config.yaml", "$HERMES_HOME/config.yaml"],
    env: [appEnvName("HERMES_HOME")],
    notes: [
      "OpenGrove can generate an isolated HERMES_HOME config.yaml so Hermes owns the provider call while OpenGrove avoids logging credentials.",
    ],
  },
  approvals: {
    mode: "native-request",
    nativeRequest: "approval.request / approval.respond",
    notes: [
      "Hermes native permission requests are turned into OpenGrove approval records and answered inline over TUI Gateway.",
    ],
  },
  eventProjector: {
    id: "hermes-tui-gateway-event",
    nativeEvents: [
      "message.delta",
      "message.complete",
      "tool.start",
      "tool.complete",
      "approval.request",
      "clarify.request",
      "thinking.delta",
      "reasoning.available",
      "reasoning.delta",
      "session.info",
      "status.update",
    ],
    appEvents: [
      "assistant.delta",
      "model.response",
      "tool.started",
      "tool.finished",
      "reasoning.started",
      "reasoning.completed",
      "runtime.diagnostic",
      "approval.requested",
      "approval.resolved",
      "question.requested",
      "question.answered",
    ],
  },
  harness: {
    fakeServer: "stdio-jsonrpc",
    smokePrompt: "Use a terminal tool to print an OpenGrove Gateway marker.",
    expectedEvents: ["assistant.delta", "tool.started", "tool.finished", "model.response", "turn.finished"],
    notes: ["Harness uses a fake Hermes TUI Gateway server over stdio JSON-RPC."],
  },
  capabilities: HERMES_CAPABILITIES,
  contract: HERMES_KERNEL_CONTRACT,
  rollout: {
    status: "implemented",
    next: ["Expose Gateway steer/compress controls when OpenGrove has first-class runtime control methods."],
  },
};

// ===== Runtime controls builder =====

export function buildHermesRuntimeControls(): BridgeRuntimeControls {
  const model = readHermesConfiguredModel() ?? "hermes-default";
  const label = readHermesConfiguredModel() ?? "Hermes default model";
  return {
    kernel: "hermes",
    source: "hermes-config",
    models: [{ id: model, label }],
    defaultModel: model,
    reasoningEfforts: [],
    speedTiers: [],
  };
}

// ===== Provider env builder =====

export function buildHermesProviderEnv(profile: ProviderProfile): Record<string, string> | undefined {
  const key = profile.apiKey || (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined);
  if (!key) return undefined;
  const envVarName = profile.apiKeyEnv || appEnvName(`${profile.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`);
  return { [envVarName]: key };
}

// ===== Kernel-local Provider route reader =====

const HERMES_PROVIDER_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "NOUS_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GLM_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CN_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "HF_TOKEN",
  "NVIDIA_API_KEY",
  "XIAOMI_API_KEY",
  "ARCEEAI_API_KEY",
  "OLLAMA_API_KEY",
  "KILOCODE_API_KEY",
  "AI_GATEWAY_API_KEY",
  "LM_API_KEY",
] as const;

export function readHermesLocalRouteProfile(configHomeOverride?: string): KernelLocalRouteProfile {
  const hermesHome = configHome(configHomeOverride, ".hermes");
  const configPath = resolve(hermesHome, "config.yaml");
  const envPath = resolve(hermesHome, ".env");
  const authPath = resolve(hermesHome, "auth.json");
  const config = existsSync(configPath) ? readFileText(configPath) : "";
  const env = { ...readDotEnvFile(envPath), ...readSelectedProcessEnv(HERMES_PROVIDER_ENV_KEYS) };
  const providerId = readYamlString(config, ["model", "provider"]) || "hermes-native";
  const providerName = readYamlString(config, ["providers", providerId, "name"]);
  const baseUrl =
    readYamlString(config, ["model", "base_url"]) || readYamlString(config, ["providers", providerId, "base_url"]);
  const apiMode =
    readYamlString(config, ["model", "api_mode"]) || readYamlString(config, ["providers", providerId, "transport"]);
  const apiKeyEnv =
    readYamlString(config, ["model", "key_env"]) || readYamlString(config, ["providers", providerId, "key_env"]);
  const resolvedApiKeyEnv = apiKeyEnv || inferHermesApiKeyEnv(providerId, baseUrl, env);
  if (resolvedApiKeyEnv && process.env[resolvedApiKeyEnv]?.trim()) {
    env[resolvedApiKeyEnv] = process.env[resolvedApiKeyEnv]!.trim();
  }
  const defaultModel =
    readYamlString(config, ["model", "default"]) || readYamlString(config, ["providers", providerId, "default_model"]);
  const models = readYamlMapKeys(config, ["providers", providerId, "models"]).map((id) => ({
    id,
    label: modelDisplayName(id),
  }));
  const protocol = apiMode?.includes("anthropic") ? "anthropic-compatible" : "openai-compatible";

  return {
    kernel: "hermes",
    source: existsSync(configPath) ? configPath : "hermes-defaults",
    sourcePaths: [configPath, envPath],
    env,
    settingsModel: defaultModel,
    providerId,
    providerLabel: providerName || hermesProviderLabel(providerId, baseUrl) || providerId || "Hermes",
    protocol,
    baseUrl,
    apiKeyEnv: resolvedApiKeyEnv,
    authConfigured: isHermesKernelManagedProviderConfigured(
      providerId,
      baseUrl,
      resolvedApiKeyEnv,
      env,
      existsSync(authPath),
    ),
    routeKind: "provider",
    models,
    defaultModel: defaultModel || models[0]?.id,
  };
}

function inferHermesApiKeyEnv(
  providerId: string,
  baseUrl: string | undefined,
  env: Record<string, string>,
): string | undefined {
  const text = `${providerId} ${baseUrl || ""}`.toLowerCase();
  const candidates = hermesApiKeyEnvCandidates(text);
  return candidates.find((key) => Boolean(env[key]?.trim())) ?? candidates[0];
}

function hermesApiKeyEnvCandidates(text: string): string[] {
  if (text.includes("openrouter")) return ["OPENROUTER_API_KEY", "OPENAI_API_KEY"];
  if (text.includes("nous-api")) return ["NOUS_API_KEY"];
  if (text.includes("anthropic")) return ["ANTHROPIC_API_KEY"];
  if (text.includes("gemini") || text.includes("google")) return ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
  if (text.includes("zai") || text.includes("zhipu") || text.includes("glm")) return ["GLM_API_KEY"];
  if (text.includes("kimi") || text.includes("moonshot")) return ["KIMI_API_KEY", "KIMI_CN_API_KEY"];
  if (text.includes("minimax-cn")) return ["MINIMAX_CN_API_KEY"];
  if (text.includes("minimax")) return ["MINIMAX_API_KEY"];
  if (text.includes("huggingface")) return ["HF_TOKEN"];
  if (text.includes("nvidia")) return ["NVIDIA_API_KEY"];
  if (text.includes("xiaomi")) return ["XIAOMI_API_KEY"];
  if (text.includes("arcee")) return ["ARCEEAI_API_KEY"];
  if (text.includes("ollama-cloud")) return ["OLLAMA_API_KEY"];
  if (text.includes("kilocode")) return ["KILOCODE_API_KEY"];
  if (text.includes("ai-gateway")) return ["AI_GATEWAY_API_KEY"];
  if (text.includes("lmstudio")) return ["LM_API_KEY"];
  if (text.includes("openai")) return ["OPENAI_API_KEY"];
  return [];
}

function hermesProviderLabel(providerId: string, baseUrl: string | undefined): string | undefined {
  const text = `${providerId} ${baseUrl || ""}`.toLowerCase();
  if (text.includes("openrouter")) return "OpenRouter";
  if (text.includes("anthropic")) return "Anthropic";
  if (text.includes("gemini") || text.includes("google")) return "Google Gemini";
  if (text.includes("zai") || text.includes("zhipu") || text.includes("glm")) return "Zhipu GLM";
  if (text.includes("kimi") || text.includes("moonshot")) return "Kimi";
  if (text.includes("minimax")) return "MiniMax";
  if (text.includes("xiaomi")) return "Xiaomi MiMo";
  if (text.includes("lmstudio")) return "LM Studio";
  if (text.includes("openai")) return "OpenAI";
  return undefined;
}

function isHermesKernelManagedProviderConfigured(
  providerId: string,
  baseUrl: string | undefined,
  apiKeyEnv: string | undefined,
  env: Record<string, string>,
  hasHermesAuth: boolean,
): boolean {
  const provider = providerId.trim().toLowerCase();
  if ((provider === "nous" || provider === "openai-codex") && hasHermesAuth) return true;
  if (apiKeyEnv && Boolean(env[apiKeyEnv]?.trim())) return true;
  return isLocalNoAuthHermesProvider(provider, baseUrl);
}

function isLocalNoAuthHermesProvider(providerId: string, baseUrl: string | undefined): boolean {
  if (providerId !== "lmstudio" && providerId !== "custom") return false;
  try {
    const url = new URL(baseUrl || "");
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
