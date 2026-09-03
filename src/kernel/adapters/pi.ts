import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createRuntimeKernelAdapter } from "../adapter.js";
import { bridgeKernelSupportsHostTools } from "../host-tools.js";
import type {
  KernelAdapter,
  KernelAdapterContract,
  KernelCapabilities,
  KernelDiscovery,
  ProviderProfile,
} from "../types.js";
import { APP_PRODUCT_NAME, APP_PROTOCOL_ID, appEnvName, readAppEnv } from "../../identity.js";
import { PiAgentRuntime } from "../../runtime/pi-runtime.js";
import { createNativePiSessionFactory } from "../../runtime/native-pi-session.js";
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
import {
  type KernelLocalRouteProfile,
  configHome,
  firstConfiguredCredentialId,
  providerDisplayName,
  readJsonObject,
} from "./profile-utils.js";

export interface PiKernelAdapterOptions {
  cwd?: string;
  configuredModel?: string;
  runtimeBindingFingerprint?: string;
  env?: NodeJS.ProcessEnv;
}

const PI_KERNEL_CAPABILITIES: KernelCapabilities = {
  sessionHistory: "kernel",
  reasoning: { nativeText: "conditional", summary: "unsupported" },
  streaming: false,
  toolCalls: true,
  hostTools: bridgeKernelSupportsHostTools("pi"),
  approvals: true,
  elicitation: false,
  artifacts: false,
  compaction: true,
  authRefresh: false,
  sandbox: ["danger-full-access"],
  knowledge: {
    nativeSkills: false,
    toolMediatedSkills: true,
    progressiveDisclosure: true,
    nativeArtifacts: false,
    deliveryLedger: true,
  },
  nativeThreadGoal: false,
  nativeSkillCatalog: false,
};

export function createPiKernelAdapter(options: PiKernelAdapterOptions = {}): KernelAdapter {
  const env = { ...process.env, ...options.env };
  const dataDir = env.OPENGROVE_DATA_DIR?.trim() || readAppEnv("DATA_DIR")?.trim();
  return createRuntimeKernelAdapter({
    id: "pi",
    title: "Pi",
    runtime: new PiAgentRuntime({
      workspaceRoot: options.cwd,
      createSession: createNativePiSessionFactory({
        model: (requestedModelId) => resolvePiRuntimeModel(env, requestedModelId ?? options.configuredModel),
        getApiKey: (provider) => resolvePiApiKey(env, provider),
        cwd: options.cwd,
        sessionRoot: dataDir ? resolve(dataDir, "pi-sessions") : undefined,
      }),
    }),
    capabilities: PI_KERNEL_CAPABILITIES,
    contract: PI_KERNEL_CONTRACT,
  });
}

export function createPiKernelAdapterFromOptions(options: import("../types.js").KernelCreateOptions): KernelAdapter {
  return createPiKernelAdapter({
    cwd: options.cwd,
    configuredModel: options.model,
    runtimeBindingFingerprint: options.runtimeBindingFingerprint,
    env: options.env,
  });
}

export function canResolvePiRuntimeModel(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    readEnv(env, "OPENAI_API_KEY", "MODEL_API_KEY") ||
      readEnv(env, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN") ||
      readEnv(env, "GEMINI_API_KEY", "GOOGLE_API_KEY"),
  );
}

export function resolvePiRuntimeModel(env: NodeJS.ProcessEnv, requestedModelId?: string): Model<any> {
  const modelId =
    requestedModelId?.trim() ||
    readEnv(env, "PI_MODEL", "OPENAI_MODEL", "DEFAULT_MODEL", "ANTHROPIC_MODEL", "GEMINI_MODEL") ||
    "gpt-4o-mini";
  const provider = resolvePiProvider(env);
  const known = piKnownProviderCandidates(provider, modelId)
    .map((candidate) => getKnownPiModel(candidate, modelId))
    .find((candidate): candidate is Model<any> => Boolean(candidate));
  if (known && (!provider.baseUrl || known.baseUrl === provider.baseUrl)) {
    return known;
  }
  if (known && provider.baseUrl) {
    return { ...known, baseUrl: provider.baseUrl };
  }
  return createCustomPiModel(provider, modelId);
}

function resolvePiProvider(env: NodeJS.ProcessEnv): {
  kind: "openai" | "anthropic" | "google";
  configuredProvider?: string;
  api: "openai-completions" | "anthropic-messages" | "google-generative-ai";
  provider: string;
  baseUrl: string;
} {
  const configuredProvider = readEnv(env, "OPENGROVE_PI_PROVIDER_ID");
  const openAiBaseUrl = readEnv(env, "OPENAI_BASE_URL", "MODEL_BASE_URL");
  if (readEnv(env, "OPENAI_API_KEY", "MODEL_API_KEY") || openAiBaseUrl) {
    return {
      kind: "openai",
      ...(configuredProvider ? { configuredProvider } : {}),
      api: "openai-completions",
      provider: "opengrove-openai",
      baseUrl: openAiBaseUrl || "https://api.openai.com/v1",
    };
  }
  const anthropicBaseUrl = readEnv(env, "ANTHROPIC_BASE_URL");
  if (readEnv(env, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN") || anthropicBaseUrl) {
    return {
      kind: "anthropic",
      ...(configuredProvider ? { configuredProvider } : {}),
      api: "anthropic-messages",
      provider: "opengrove-anthropic",
      baseUrl: anthropicBaseUrl || "https://api.anthropic.com",
    };
  }
  return {
    kind: "google",
    ...(configuredProvider ? { configuredProvider } : {}),
    api: "google-generative-ai",
    provider: "opengrove-google",
    baseUrl: readEnv(env, "GEMINI_BASE_URL", "GOOGLE_BASE_URL") || "https://generativelanguage.googleapis.com",
  };
}

const PI_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  gemini: "google",
  "zhipu-glm": "zai",
  kimi: "moonshotai",
};

function piKnownProviderCandidates(provider: ReturnType<typeof resolvePiProvider>, modelId: string): string[] {
  const configured = provider.configuredProvider;
  const candidates = [
    configured,
    configured ? PI_PROVIDER_ALIASES[configured] : undefined,
    provider.kind,
    provider.kind === "openai" && /^deepseek-/i.test(modelId) ? "deepseek" : undefined,
  ];
  return Array.from(new Set(candidates.filter((candidate): candidate is string => Boolean(candidate))));
}

function getKnownPiModel(provider: string, modelId: string): Model<any> | undefined {
  try {
    return (getBuiltinModel as (provider: string, modelId: string) => Model<any> | undefined)(provider, modelId);
  } catch {
    return undefined;
  }
}

function createCustomPiModel(provider: ReturnType<typeof resolvePiProvider>, modelId: string): Model<any> {
  return {
    id: modelId,
    name: modelId,
    api: provider.api,
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    reasoning: /gpt-5|o[134]|claude|glm|deepseek|qwen|kimi/i.test(modelId),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...(provider.api === "openai-completions"
      ? {
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
        }
      : {}),
  };
}

function resolvePiApiKey(env: NodeJS.ProcessEnv, provider: string): string | undefined {
  const normalized = provider.toLowerCase();
  if (normalized.includes("anthropic")) {
    return readEnv(env, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN");
  }
  if (normalized.includes("google") || normalized.includes("gemini")) {
    return readEnv(env, "GEMINI_API_KEY", "GOOGLE_API_KEY");
  }
  return (
    readEnv(env, "OPENAI_API_KEY", "MODEL_API_KEY") ||
    readEnv(env, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN") ||
    readEnv(env, "GEMINI_API_KEY", "GOOGLE_API_KEY")
  );
}

function readEnv(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export const PI_KERNEL_CONTRACT: KernelAdapterContract = {
  paths: {
    configHomeEnvVar: null,
    defaultConfigHome: ".pi",
    cliCommand: "pi",
    projectSkillDir: null,
    nativeSkillMarker: null,
    knowledgeBuckets: [],
    defaultKnowledgeBucket: `${APP_PROTOCOL_ID}.skills`,
  },
  display: {
    defaultModelId: "pi-default",
    modelDisplayAliases: ["Pi"],
    modelDisplaySuffixAlias: null,
  },
  inputFormats: {
    planMode: {
      withInput: "Create a plan first before taking action:\n{input}",
      withoutInput: "Create a plan first before taking action.",
    },
    skillInvocation: { withArgs: "${name} {args}", withoutArgs: "${name}" },
    modelAliasStrategy: "none",
    nativeModelNormalization: false,
  },
  labels: { title: "Pi", integrationMode: "sdk", unavailableReason: "No usable API key is configured for Pi" },
  ownership: [
    {
      feature: "session",
      owner: "shared",
      nativeName: "AgentHarness SessionRepo / Session",
      appResponsibility: "Own OpenGrove session/run ids and choose the product persistence policy.",
      kernelResponsibility:
        "Own native conversation entries, session trees, create/open/list/delete/fork, and JSONL or in-memory repositories.",
      adapterResponsibility:
        "Bind OpenGrove session ids to Pi sessions and expose list/delete/fork through the common AgentRuntime and KernelAdapter lifecycle without replacing Pi's native semantics.",
      notes:
        "The adapter uses a stable hashed native id, forwards create/open/list/delete/fork through the common lifecycle, persists through Pi JSONL under the OpenGrove data directory, and uses Pi's in-memory repository for ephemeral/test runs.",
    },
    {
      feature: "turn_lifecycle",
      owner: "shared",
      nativeName: "Agent agent_start/turn_start/message_start/message_end/turn_end/agent_end",
      appResponsibility: "Own the product-level prompt-to-final Turn, normalized trajectory, and pause/resume records.",
      kernelResponsibility: "Own nested assistant-message, tool, and provider-turn boundaries inside the native loop.",
      adapterResponsibility:
        "Forward KernelTurnRequest and preserve native message boundaries when projecting process and final output.",
    },
    {
      feature: "transport",
      owner: "adapter",
      nativeName: "pi-agent-core in-process Agent/Models APIs",
      adapterResponsibility:
        "Use Pi's public in-process APIs and native event stream instead of CLI text parsing or provider-specific HTTP reconstruction.",
    },
    {
      feature: "model_loop",
      owner: "shared",
      nativeName: "NativePiSession",
      appResponsibility: "Own context assembly, tool gate, middleware, and memory/artifact side effects.",
      kernelResponsibility: "Own the provider model call and message continuation loop inside NativePiSession.",
      adapterResponsibility:
        "Keep provider/model details behind the Pi runtime contract and use Pi's public Models/Agent APIs.",
    },
    {
      feature: "native_tool_execution",
      owner: "kernel",
      nativeName: "AgentHarness read/bash/edit/write tools",
      kernelResponsibility: "Own the optional native coding-tool harness and its execution environment abstraction.",
      adapterResponsibility:
        "Leave native tools disabled until OpenGrove deliberately maps their policy, progress, and artifact semantics.",
      notes:
        "This is deliberately disabled: OpenGrove Host tools are the single policy, progress, artifact, and side-effect surface.",
    },
    {
      feature: "host_tool_execution",
      owner: "app",
      appResponsibility: "Own OpenGrove host tool definitions, policy gates, execution, and tool result middleware.",
      adapterResponsibility: "Expose OpenGrove tools directly to NativePiSession.",
    },
    {
      feature: "approval",
      owner: "shared",
      nativeName: "Agent.beforeToolCall",
      appResponsibility: "Own approval policy evaluation, approval inbox UI, user decisions, and audit trail.",
      kernelResponsibility: "Keep the native tool call pending until the beforeToolCall decision completes.",
      adapterResponsibility:
        "Wait for the Host decision inside beforeToolCall and return allow/block to the same Pi loop.",
      notes:
        "The adapter awaits the Host decision in beforeToolCall; approval resumes or blocks that same native tool call.",
    },
    {
      feature: "user_question",
      owner: "app",
      appResponsibility: "Own structured choice/question UI and route answers back into OpenGrove tools or Pi flow.",
      notes: "Pi currently has no independent native elicitation protocol.",
    },
    {
      feature: "skill_discovery",
      owner: "shared",
      nativeName: "loadSkills / AgentHarness resources",
      appResponsibility: "Own OpenGrove skill provenance, catalog policy, and knowledge vault.",
      kernelResponsibility: "Own native SKILL.md discovery and model-visible resource formatting when enabled.",
      notes:
        "Pi's loader is deliberately disabled so OpenGrove's provenance-aware catalog remains the single source of skill availability.",
    },
    {
      feature: "skill_loading",
      owner: "shared",
      nativeName: "AgentHarness.skill / promptFromTemplate",
      appResponsibility: "Choose which OpenGrove skills are available and preserve provenance/policy.",
      kernelResponsibility: "Own native skill and prompt-template invocation semantics.",
      adapterResponsibility:
        "Map OpenGrove skill selection to Pi resources or explicitly retain the current Host-tool fallback.",
      notes:
        "OpenGrove explicitly retains the Host-tool fallback to preserve its skill trust, pack, and progressive-disclosure semantics.",
    },
    {
      feature: "context_assembly",
      owner: "app",
      appResponsibility: "Assemble browser/computer/page/knowledge/memory/artifact context before the turn.",
    },
    {
      feature: "knowledge_retrieval",
      owner: "app",
      appResponsibility: "Plan and deliver knowledge context using OpenGrove KnowledgeStore/ContextPlanner.",
    },
    {
      feature: "artifact_extraction",
      owner: "app",
      appResponsibility: "Extract media/file artifacts from host tool results and model-visible outputs.",
    },
    {
      feature: "memory_write",
      owner: "app",
      appResponsibility: "Own memory proposals, writes, feedback, confidence, and decay.",
    },
    {
      feature: "compaction",
      owner: "shared",
      nativeName: "AgentHarness.compact / compaction helpers",
      appResponsibility: "Own when the product requests compaction and how memory snapshots are retained.",
      kernelResponsibility:
        "Own native summary generation, retained-tail selection, usage, and compaction session entries.",
      adapterResponsibility:
        "Use Pi's native shouldCompact/compaction pipeline for configured and model-window thresholds without Host-side conversation truncation.",
      notes:
        "Explicit and automatic compaction both persist Pi native summaries, usage, retained tails, and compaction entries. If native compaction cannot satisfy a hard window, the turn fails explicitly instead of dropping conversation history.",
    },
    {
      feature: "auth",
      owner: "shared",
      nativeName: "pi-ai Models",
      appResponsibility: "Own employee provider bindings and credential storage integration.",
      kernelResponsibility: "Own provider factories, request dispatch, credential resolution, and OAuth refresh.",
      adapterResponsibility:
        "Use Models.streamSimple and never include raw provider credentials in event logs or captures.",
    },
    {
      feature: "sandbox",
      owner: "app",
      appResponsibility: "Own policy rules and host tool permission decisions.",
      notes: "Pi has no separate process sandbox comparable to Codex sandboxPolicy.",
    },
    {
      feature: "trajectory",
      owner: "app",
      appResponsibility: "Persist OpenGrove trajectory JSON from normalized events.",
    },
    {
      feature: "diagnostics",
      owner: "shared",
      appResponsibility: "Use OpenGrove event log/trajectory as the authoritative product diagnostic surface.",
      kernelResponsibility:
        "Provide native usage, stop reason, response ids, raw provider stop reasons, and diagnostics.",
      adapterResponsibility: "Project safe native metadata without flattening it into chat text.",
    },
  ],
  eventMappings: [
    {
      appEvent: "reasoning.started / reasoning.completed",
      nativeEvent: "pi-ai AssistantMessage thinking blocks",
      direction: "native_to_app",
      adapterResponsibility:
        "Preserve provider thinking blocks as kind=native, including the provider-redacted marker when present.",
    },
    {
      appEvent: "tool.started / tool.progress / tool.finished",
      nativeEvent: "NativePiSession host tool call",
      direction: "bidirectional",
      adapterResponsibility: "Route directly through OpenGrove tool execution and preserve tool call ids.",
    },
    {
      appEvent: "approval.requested",
      nativeRequest: "Pi beforeToolCall gate",
      direction: "native_to_app",
      adapterResponsibility:
        "Use OpenGrove approval inbox for host tool gates and keep the native call awaiting the decision.",
      notes: "approval.resolved and run.resumed are emitted before the same native call executes.",
    },
    {
      appEvent: "skill.loaded",
      nativeRequest: "skill.invoke",
      direction: "bidirectional",
      adapterResponsibility:
        "Expose OpenGrove skill progressive disclosure as a host tool, not a native skill directory.",
    },
  ],
  diagnostics: {
    defaultModeId: `${APP_PROTOCOL_ID}-trajectory`,
    modes: [
      {
        id: `${APP_PROTOCOL_ID}-event-log`,
        title: `${APP_PRODUCT_NAME} normalized event log`,
        layer: "host-event-log",
        status: "implemented",
        enabledByDefault: true,
        redaction: "redacted",
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
      path: "$OPENGROVE_DATA_DIR/pi-sessions/**/*.jsonl",
      availability: "available",
      notes: [
        `Pi owns the native JSONL session tree; ${APP_PRODUCT_NAME} separately records normalized event logs and trajectories.`,
      ],
    },
  },
  notes: [
    `Pi is an in-process SDK Kernel. ${APP_PRODUCT_NAME} owns Host policy and product state, while Pi must retain ownership of its native loop, message boundaries, provider dispatch, and optional harness semantics.`,
  ],
};

// ===== Provider env builder =====

export function buildPiProviderEnv(profile: ProviderProfile): Record<string, string> | undefined {
  if (!profile.apiKey) return undefined;
  const env: Record<string, string> = {
    OPENGROVE_PI_PROVIDER_ID: profile.id,
  };

  const openaiBaseUrl =
    profile.protocol === "openai-compatible" ? (profile.baseUrl ?? profile.openaiBaseUrl) : undefined;
  const anthropicBaseUrl =
    profile.protocol === "anthropic-compatible" ? (profile.baseUrl ?? profile.anthropicBaseUrl) : undefined;
  const geminiBaseUrl =
    profile.protocol === "gemini-compatible" ? (profile.baseUrl ?? profile.geminiBaseUrl) : undefined;

  if (openaiBaseUrl) {
    env.OPENAI_BASE_URL = openaiBaseUrl;
    env.MODEL_BASE_URL = openaiBaseUrl;
    env.OPENAI_API_KEY = profile.apiKey;
    env.MODEL_API_KEY = profile.apiKey;
    if (profile.model) {
      env.OPENAI_MODEL = profile.model;
      env.DEFAULT_MODEL = profile.model;
      env.DEEPSEEK_MODEL = profile.model;
      env.QWEN_CODE_MODEL = profile.model;
    }
  }
  if (anthropicBaseUrl) {
    env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
    env.ANTHROPIC_API_KEY = profile.apiKey;
    env.ANTHROPIC_AUTH_TOKEN = profile.apiKey;
  }
  if (geminiBaseUrl) {
    env.GEMINI_BASE_URL = geminiBaseUrl;
    env.GEMINI_API_KEY = profile.apiKey;
    env.GOOGLE_API_KEY = profile.apiKey;
  }

  if (profile.model) env.PI_MODEL = profile.model;
  return Object.keys(env).length ? env : undefined;
}

// ===== Discovery =====

export function discoverPiKernel(configuredCommand?: string): KernelDiscovery {
  const candidate = piExecutableCandidate(configuredCommand);
  const discovery = probeCommandPath(candidate.command);
  const command = discovery.resolvedPath;
  const configHome = resolveHomePath(".pi");
  return {
    kernelId: "pi",
    title: "Pi",
    installed: true,
    available: true,
    binaryPath: command,
    version: discovery.probe.version,
    executableProbe: kernelExecutableProbe(discovery, {
      role: "optional-diagnostic",
      source: candidate.source,
      sourceName: candidate.sourceName,
    }),
    health: commandDiscoveryHealth(discovery, {
      title: "Pi",
      role: "optional-diagnostic",
      source: candidate.source,
      sourceName: candidate.sourceName,
      missingMessage: "Pi's optional CLI was not found.",
      runtimeStillAvailable: "The bundled in-process Pi SDK remains available.",
    }),
    configHome,
    diagnostics: PI_KERNEL_CONTRACT.diagnostics,
    knowledgeSources: [
      fileSource({
        id: "pi.agents",
        title: "AGENTS.md",
        kind: "project_instructions",
        scope: "user",
        path: "~/.pi/agent/AGENTS.md",
      }),
      directorySource({
        id: "pi.agent",
        title: "Pi agent config",
        kind: "config",
        scope: "user",
        path: "~/.pi/agent",
        knowledgeLike: false,
      }),
      directorySource({ id: "pi.skills", title: "skills", kind: "skills", scope: "user", path: "~/.pi/agent/skills" }),
      directorySource({
        id: "pi.packages",
        title: "packages",
        kind: "plugins",
        scope: "user",
        path: "~/.pi/agent/packages",
      }),
    ],
    installActions: [
      plannedInstallAction({
        id: "pi.install",
        title: "Install Pi",
        command: ["npm", "install", "-g", "@earendil-works/pi-coding-agent"],
      }),
    ],
    notes: [
      "OpenGrove uses the Pi Agent SDK in-process, binding OpenGrove sessions directly to NativePiSession instead of shelling out through a prompt-only CLI.",
    ],
  };
}

function piExecutableCandidate(configuredCommand: string | undefined) {
  const configured = configuredCommand?.trim();
  if (configured) {
    return { command: configured, source: "configured" as const, sourceName: undefined };
  }
  const environment = readAppEnv("PI_BIN")?.trim();
  if (environment) {
    return { command: environment, source: "environment" as const, sourceName: appEnvName("PI_BIN") };
  }
  return { command: "pi", source: "path" as const };
}

export function resolvePiCommand(): string | undefined {
  const configured = readAppEnv("PI_BIN")?.trim();
  if (configured) return resolveUsableCommandPath(configured);
  return resolveUsableCommandPath("pi");
}

// ===== Kernel-local Provider route reader =====

export function readPiLocalRouteProfile(configHomeOverride?: string): KernelLocalRouteProfile {
  const home = configHome(configHomeOverride, ".pi");
  const authPath = resolve(home, "agent", "auth.json");
  const auth = readJsonObject(authPath);
  const storedProviderId = firstConfiguredCredentialId(auth);
  const providerId = storedProviderId || "pi-native";
  return {
    kernel: "pi",
    source: existsSync(authPath) ? authPath : "pi-defaults",
    sourcePaths: [authPath],
    env: {},
    providerId,
    providerLabel: providerId === "pi-native" ? "Pi" : providerDisplayName(providerId),
    authConfigured: Boolean(storedProviderId),
    routeKind: "provider",
    models: [],
  };
}
