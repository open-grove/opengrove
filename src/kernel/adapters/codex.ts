import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CodexRuntime, type CodexRuntimeOptions } from "../../runtime/codex-runtime.js";
import { withCodexResponsesChatProxy } from "../../runtime/codex/responses-chat-proxy.js";
import { resolveCodexCommandPath } from "../../runtime/codex/command-path.js";
import { APP_PROTOCOL_ID, appEnvName, readAppEnv } from "../../identity.js";
import { RuntimeKernelAdapter } from "../adapter.js";
import { bridgeKernelSupportsHostTools } from "../host-tools.js";
import {
  commandDiscoveryHealth,
  directorySource,
  fileSource,
  kernelExecutableProbe,
  plannedInstallAction,
  probeCommandPath,
  resolveHomePath,
} from "../discovery.js";
import type { KernelAdapterContract, KernelDiscovery, KernelHealth, ProviderProfile } from "../types.js";
import type { BridgeRuntimeControls } from "../../server/bridge-types.js";
import { BRIDGE_MODEL_IDS } from "../model-ids.js";
import { readCodexConfiguredModel } from "./profile-utils.js";
import { numberValue } from "./profile-utils.js";
import {
  type BridgeRuntimeControlOption,
  type KernelLocalRouteProfile,
  hasCredentialRecord,
  readFileText,
  readJsonObject,
  readTomlString,
  readTomlTable,
  stringValue,
} from "./profile-utils.js";

export class CodexKernelAdapter extends RuntimeKernelAdapter {
  constructor(private readonly codexOptions: CodexRuntimeOptions = {}) {
    super({
      id: "codex",
      title: "Codex",
      runtime: new CodexRuntime(codexOptions),
      capabilities: {
        sessionHistory: "kernel",
        reasoning: { nativeText: "unsupported", summary: "supported" },
        streaming: true,
        toolCalls: true,
        hostTools: bridgeKernelSupportsHostTools("codex"),
        approvals: true,
        elicitation: true,
        artifacts: true,
        compaction: true,
        authRefresh: true,
        sandbox: ["read-only", "workspace-write", "danger-full-access"],
        knowledge: {
          nativeSkills: true,
          toolMediatedSkills: false,
          progressiveDisclosure: true,
          nativeArtifacts: false,
          deliveryLedger: true,
        },
        nativeThreadGoal: true,
        nativeSkillCatalog: true,
      },
      contract: CODEX_KERNEL_CONTRACT,
    });
  }

  async discover(): Promise<KernelDiscovery> {
    return discoverCodexKernel(this.codexOptions, process.cwd(), this.contract.diagnostics);
  }

  override async healthCheck(): Promise<KernelHealth> {
    const candidate = codexExecutableCandidate(this.codexOptions.command);
    return codexCommandHealth(probeCommandPath(candidate.command), candidate);
  }
}

export function createCodexKernelAdapter(options: CodexRuntimeOptions = {}): CodexKernelAdapter {
  return new CodexKernelAdapter({
    ...options,
    approvalPolicy: options.approvalPolicy ?? readCodexApprovalPolicy(),
    sandbox: options.sandbox ?? readCodexSandbox(),
  });
}

export function createCodexKernelAdapterFromOptions(
  options: import("../types.js").KernelCreateOptions,
): CodexKernelAdapter {
  const candidate = codexExecutableCandidate(options.command);
  const commandProbe = probeCommandPath(candidate.command);
  const command =
    commandProbe.resolvedPath && commandProbe.probe.status !== "failed" ? commandProbe.resolvedPath : undefined;
  if (!command) {
    throw new Error(codexCommandHealth(commandProbe, candidate).message || "Codex CLI was not found.");
  }
  const providerConfig = options.provider ? codexProviderConfigFromProfile(options.provider) : undefined;
  const configuredModel = options.provider ? options.model || readCodexConfiguredModel() : readCodexConfiguredModel();
  return createCodexKernelAdapter({
    command,
    cwd: options.cwd,
    configuredModel,
    configuredModelProvider: providerConfig?.providerKey,
    providerConfig,
    allowServiceTier: !providerConfig,
    runtimeBindingFingerprint: options.runtimeBindingFingerprint,
    statePath: options.dataPath ? join(options.dataPath, "codex-threads.json") : undefined,
    env: options.env,
  });
}

export function codexProviderConfigFromProfile(
  provider: import("../types.js").ProviderProfile,
): CodexRuntimeOptions["providerConfig"] | undefined {
  const baseUrl = provider.baseUrl?.trim();
  if (!baseUrl) return undefined;
  const providerKey = `opengrove_${
    provider.id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "provider"
  }`.slice(0, 64);
  const envKey = appEnvName(
    `${
      provider.id
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "PROVIDER"
    }_API_KEY`,
  );
  const config: NonNullable<CodexRuntimeOptions["providerConfig"]> = {
    providerKey,
    name: provider.name || provider.id,
    baseUrl,
    envKey,
    wireApi: provider.wireApi ?? "responses",
  };
  return config.wireApi === "chat"
    ? withCodexResponsesChatProxy(config, {
        upstreamBaseUrl: baseUrl,
        apiKey: provider.apiKey,
      })
    : config;
}

function readCodexApprovalPolicy() {
  const value = readAppEnv("CODEX_APPROVAL_POLICY");
  return value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted"
    ? value
    : "never";
}

function readCodexSandbox() {
  const value = readAppEnv("CODEX_SANDBOX");
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : "danger-full-access";
}

export function discoverCodexKernel(
  options: CodexRuntimeOptions = {},
  _cwd = process.cwd(),
  diagnostics = CODEX_KERNEL_CONTRACT.diagnostics,
): KernelDiscovery {
  const codexHome = options.env?.CODEX_HOME || process.env.CODEX_HOME || resolveHomePath(".codex");
  const candidate = codexExecutableCandidate(options.command);
  const discovery = probeCommandPath(candidate.command);
  const command = discovery.resolvedPath;
  const installed = Boolean(command);
  const available = installed && discovery.probe.status !== "failed";
  return {
    kernelId: "codex",
    title: "Codex",
    installed,
    available,
    binaryPath: command,
    version: discovery.probe.version,
    executableProbe: kernelExecutableProbe(discovery, {
      role: "runtime-required",
      source: candidate.source,
      sourceName: candidate.sourceName,
    }),
    health: codexCommandHealth(discovery, candidate),
    configHome: codexHome,
    diagnostics,
    knowledgeSources: [
      fileSource({
        id: "codex.user-agents-md",
        title: "AGENTS.md",
        kind: "project_instructions",
        scope: "user",
        path: `${codexHome}/AGENTS.md`,
        native: true,
        syncMode: "index",
        description: "Codex 全局常驻指令文件。",
      }),
      directorySource({
        id: "codex.user-skills",
        title: "skills",
        kind: "skills",
        scope: "user",
        path: `${codexHome}/skills`,
        native: true,
        syncMode: "index",
      }),
      directorySource({
        id: "codex.system-skills",
        title: "Bundled Codex system skills",
        kind: "skills",
        scope: "system",
        path: `${codexHome}/skills/.system`,
        native: true,
        userVisible: false,
        knowledgeLike: false,
        syncMode: "index",
        enabledByDefault: false,
        description: "Codex 自带 skill 缓存，只建议只读查看。",
      }),
      directorySource({
        id: "codex.user-agent-skills",
        title: "skills (~/.agents)",
        kind: "skills",
        scope: "user",
        path: resolveHomePath(".agents", "skills"),
        native: true,
        syncMode: "index",
      }),
      fileSource({
        id: "codex.config",
        title: "Codex config.toml",
        kind: "config",
        scope: "user",
        path: `${codexHome}/config.toml`,
        native: true,
        knowledgeLike: false,
        syncMode: "none",
      }),
      fileSource({
        id: "codex.auth",
        title: "Codex auth.json",
        kind: "auth",
        scope: "user",
        path: `${codexHome}/auth.json`,
        native: true,
        userVisible: false,
        knowledgeLike: false,
        enabledByDefault: false,
        syncMode: "none",
        description: "凭证文件只用于状态提示和 token 刷新，不进入资料库正文。",
      }),
      directorySource({
        id: "codex.sessions",
        title: "Codex native sessions",
        kind: "sessions",
        scope: "user",
        path: `${codexHome}/sessions`,
        native: true,
        knowledgeLike: false,
        enabledByDefault: false,
        syncMode: "none",
      }),
      directorySource({
        id: "codex.plugins",
        title: "Codex plugins cache",
        kind: "plugins",
        scope: "user",
        path: `${codexHome}/plugins/cache`,
        native: true,
        knowledgeLike: false,
        enabledByDefault: false,
        syncMode: "none",
      }),
    ],
    installActions: [
      plannedInstallAction({
        id: "codex.install",
        title: "Install Codex CLI",
        command: ["npm", "install", "-g", "@openai/codex"],
      }),
    ],
    notes: ["Codex 的 skill 是原生渐进式加载；OpenGrove 应优先发布目录引用，不重复把完整 skill 正文塞进提示词。"],
  };
}

function codexExecutableCandidate(configuredCommand: string | undefined) {
  const configured = configuredCommand?.trim();
  if (configured) {
    return { command: configured, source: "configured" as const, sourceName: undefined };
  }
  const environment = readAppEnv("CODEX_BIN")?.trim();
  if (environment) {
    return { command: environment, source: "environment" as const, sourceName: appEnvName("CODEX_BIN") };
  }
  return { command: resolveCodexCommandPath(), source: "discovered" as const };
}

function codexCommandHealth(
  discovery: ReturnType<typeof probeCommandPath>,
  candidate: ReturnType<typeof codexExecutableCandidate>,
): KernelHealth {
  return commandDiscoveryHealth(discovery, {
    title: "Codex",
    role: "runtime-required",
    source: candidate.source,
    sourceName: candidate.sourceName,
    missingMessage: `Codex CLI was not found. Set ${appEnvName("CODEX_BIN")}.`,
  });
}

export const CODEX_KERNEL_CONTRACT: KernelAdapterContract = {
  paths: {
    configHomeEnvVar: "CODEX_HOME",
    defaultConfigHome: ".codex",
    cliCommand: "codex",
    projectSkillDir: ".codex/skills",
    nativeSkillMarker: "/.codex/skills/",
    knowledgeBuckets: [
      { pathContains: "/.codex/skills/.system/", bucket: "codex.system-skills" },
      { pathContains: "/.codex/skills/", bucket: "codex.project-codex-skills" },
      { pathContains: "/.agents/skills/", bucket: "codex.project-agent-skills" },
    ],
    defaultKnowledgeBucket: "codex.user-skills",
  },
  display: {
    defaultModelId: "codex-default",
    modelDisplayAliases: [],
    modelDisplaySuffixAlias: null,
  },
  inputFormats: {
    planMode: { withInput: "/plan {input}", withoutInput: "/plan" },
    skillInvocation: { withArgs: "${name} {args}", withoutArgs: "${name}" },
    modelAliasStrategy: "none",
    nativeModelNormalization: false,
  },
  labels: { title: "Codex", integrationMode: "sdk" },
  ownership: [
    {
      feature: "session",
      owner: "shared",
      nativeName: "thread",
      appResponsibility: "Own OpenGrove project/session ids, activity records, and UI navigation.",
      kernelResponsibility: "Own Codex thread/start, thread/resume, thread/fork, archive, and extended history.",
      adapterResponsibility: "Persist OpenGrove session id to Codex thread id bindings.",
    },
    {
      feature: "turn_lifecycle",
      owner: "shared",
      nativeName: "turn",
      appResponsibility: "Record normalized run lifecycle and trajectory.",
      kernelResponsibility: "Own turn/start, streaming item events, interrupt, and final turn result.",
      adapterResponsibility:
        "Translate Codex turn lifecycle into OpenGrove turn.started/turn.finished/error/run.paused events.",
    },
    {
      feature: "transport",
      owner: "adapter",
      nativeName: "Codex app-server JSON-RPC",
      adapterResponsibility:
        "Use the structured app-server protocol and preserve native thread, turn, item, request, and notification ids.",
    },
    {
      feature: "model_loop",
      owner: "kernel",
      nativeName: "codex core loop",
      kernelResponsibility:
        "Call the model, decide native tools, continue after native tool results, and compact as needed.",
      adapterResponsibility: "Do not replay or duplicate Codex's internal loop.",
    },
    {
      feature: "native_tool_execution",
      owner: "kernel",
      nativeName: "Codex native tools",
      kernelResponsibility: "Execute shell, patch/file changes, image generation, web search, and MCP tools.",
      adapterResponsibility:
        "Map native item events, approvals, tool results, generated files, and media into OpenGrove events/artifacts.",
    },
    {
      feature: "host_tool_execution",
      owner: "shared",
      nativeName: "dynamic tools",
      appResponsibility: "Own OpenGrove tools such as choices, browser/computer staging, memory, and artifact writes.",
      kernelResponsibility: "Request OpenGrove dynamic tools through app-server tool call requests.",
      adapterResponsibility:
        "Expose OpenGrove tools as Codex dynamic tools and route deferred tool calls back to OpenGrove.",
    },
    {
      feature: "approval",
      owner: "shared",
      nativeName: "requestApproval",
      appResponsibility: "Own approval inbox UI, user decision, and durable audit trail.",
      kernelResponsibility: "Decide when command/file/permission operations need review.",
      adapterResponsibility: "Bridge item/commandExecution, item/fileChange, and item/permissions approval requests.",
    },
    {
      feature: "user_question",
      owner: "shared",
      nativeName: "requestUserInput / MCP elicitation",
      appResponsibility: "Own structured choice/form UI.",
      kernelResponsibility: "Pause native turn until user answers elicitation/user input.",
      adapterResponsibility: "Return exactly the user-selected answers in Codex's expected response shape.",
    },
    {
      feature: "skill_discovery",
      owner: "shared",
      nativeName: "skills/list",
      appResponsibility: "Own OpenGrove vault skill source of truth and publication ledger.",
      kernelResponsibility: "Scan native Codex skill directories and expose native skill metadata.",
      adapterResponsibility:
        "Refresh Codex skill cache before native skill turns when OpenGrove has just published skills.",
    },
    {
      feature: "skill_loading",
      owner: "kernel",
      nativeName: "Codex native skill loader",
      appResponsibility: "Publish OpenGrove skills into the Codex-compatible project/user skill directories.",
      kernelResponsibility: "Progressively load SKILL.md and referenced files.",
      adapterResponsibility: "Send skill references instead of duplicating full skill bodies in prompt context.",
    },
    {
      feature: "context_assembly",
      owner: "shared",
      appResponsibility:
        "Pass only explicit user-added context, attachments, and narrow vault UI hints; leave filesystem/page reading to Codex tools.",
      kernelResponsibility: "Apply Codex's own context, history, tool, and compaction policies.",
      adapterResponsibility:
        "Place OpenGrove context into developer instructions, user input, attachments, and dynamic tool metadata.",
    },
    {
      feature: "knowledge_retrieval",
      owner: "shared",
      appResponsibility: "Provide only explicitly selected OpenGrove knowledge context and configured MCP resources.",
      kernelResponsibility: "Own native filesystem, web-search, and MCP retrieval performed inside the Codex loop.",
      adapterResponsibility:
        "Preserve native retrieval tool events and do not pre-expand unselected knowledge into the prompt.",
    },
    {
      feature: "artifact_extraction",
      owner: "shared",
      appResponsibility: "Own OpenGrove ArtifactRecord lifecycle, preview, feedback, and vault files.",
      kernelResponsibility: "May create native files/media through tools.",
      adapterResponsibility:
        "Extract images/audio/video/files from Codex item/tool results without relying on model wording.",
    },
    {
      feature: "memory_write",
      owner: "app",
      appResponsibility: "Own memory suggestions, confirmation, scoring, and decay.",
      adapterResponsibility: "Attach native provenance when memory is created from Codex events.",
    },
    {
      feature: "compaction",
      owner: "shared",
      nativeName: "hook/started type=compaction",
      appResponsibility: "Write memory/context snapshots at compaction boundaries.",
      kernelResponsibility: "Decide and execute Codex native compaction.",
      adapterResponsibility: "Map compaction started/finished hooks into OpenGrove events.",
    },
    {
      feature: "auth",
      owner: "shared",
      nativeName: "account/chatgptAuthTokens/refresh",
      appResponsibility: "Provide AuthProfile or Codex auth-file backed token refresh without exposing secrets.",
      kernelResponsibility: "Request token refresh when ChatGPT auth expires.",
      adapterResponsibility: "Read the configured auth profile and return Codex's expected refresh payload.",
    },
    {
      feature: "sandbox",
      owner: "shared",
      nativeName: "sandboxPolicy / approvalsReviewer",
      appResponsibility: "Expose product-level access modes.",
      kernelResponsibility: "Enforce Codex sandbox semantics.",
      adapterResponsibility: "Translate OpenGrove access modes into Codex sandboxPolicy and approvalPolicy values.",
    },
    {
      feature: "trajectory",
      owner: "app",
      appResponsibility: "Persist normalized run trajectories and OpenGrove-side artifacts.",
      adapterResponsibility: "Include Codex native ids in normalized events for replay/debug.",
    },
    {
      feature: "diagnostics",
      owner: "adapter",
      nativeName: "app-server JSON-RPC",
      appResponsibility: "Expose diagnostic locations and privacy policy in UI/docs.",
      adapterResponsibility: "Capture OpenGrove <-> Codex app-server RPC with redaction.",
    },
  ],
  eventMappings: [
    {
      appEvent: "turn.started / turn.finished / run.paused",
      nativeEvent: "turn/start + turn lifecycle notifications",
      direction: "native_to_app",
      adapterResponsibility: "Map Codex turn ids and pause reasons into OpenGrove run lifecycle events.",
    },
    {
      appEvent: "reasoning.started / reasoning.completed",
      nativeEvent: "item/started type=reasoning, item/reasoning/summaryTextDelta, item/completed",
      direction: "native_to_app",
      adapterResponsibility:
        "Map Codex-provided readable reasoning summaries as kind=summary without reconstructing raw model reasoning.",
    },
    {
      appEvent: "tool.call.started / tool.call.completed",
      nativeEvent: "item/tool_call / item/tool_result and dynamic tool requests",
      direction: "bidirectional",
      adapterResponsibility:
        "Route OpenGrove dynamic tools to OpenGrove execution and preserve Codex native tool provenance.",
    },
    {
      appEvent: "approval.requested / approval.resolved",
      nativeRequest:
        "item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval",
      direction: "bidirectional",
      adapterResponsibility: "Render typed OpenGrove approval UI and return Codex decision objects.",
    },
    {
      appEvent: "question.requested / question.answered",
      nativeRequest: "item/tool/requestUserInput, mcpServer/elicitation/request",
      direction: "bidirectional",
      adapterResponsibility: "Keep elicitation separate from approval and return Codex-native answer payloads.",
    },
    {
      appEvent: "compaction.started / compaction.finished",
      nativeEvent: "hook/started type=compaction and matching completion signal",
      direction: "native_to_app",
      adapterResponsibility: "Trigger OpenGrove memory snapshot and record compaction provenance.",
    },
    {
      appEvent: "artifact.created",
      nativeEvent: "tool_result / item_completed with media or file references",
      direction: "native_to_app",
      adapterResponsibility: "Extract media/file artifacts generically and link them to the source run/item.",
    },
  ],
  diagnostics: {
    defaultModeId: "codex-app-server-rpc",
    modes: [
      {
        id: "codex-app-server-rpc",
        title: "Codex app-server RPC capture",
        layer: "adapter-rpc",
        status: "implemented",
        enabledByDefault: true,
        output: "data/codex-rpc-captures/",
        env: [
          appEnvName("CODEX_RPC_CAPTURE"),
          appEnvName("CODEX_RPC_CAPTURE_DIR"),
          appEnvName("CODEX_RPC_CAPTURE_MAX_INLINE_BYTES"),
          appEnvName("CODEX_RPC_CAPTURE_STDERR"),
        ],
        redaction: "redacted",
        notes: [
          "Records JSON-RPC requests/responses/notifications between OpenGrove and codex app-server.",
          "Large payloads are moved to blob files; auth/token/secret-like fields are redacted recursively.",
        ],
      },
      {
        id: "codex-native-sessions",
        title: "Codex native session JSONL",
        layer: "native-transcript",
        status: "external",
        output: "~/.codex/sessions/**/*.jsonl",
        redaction: "external",
        notes: [
          "Owned by Codex itself. Useful for checking base instructions, dynamic tools, sandbox, model, and effort.",
        ],
      },
      {
        id: `${APP_PROTOCOL_ID}-trajectory`,
        title: "OpenGrove trajectory JSON",
        layer: "trajectory",
        status: "implemented",
        enabledByDefault: true,
        output: "data/trajectories/",
        redaction: "redacted",
      },
    ],
    nativeTranscript: {
      path: "~/.codex/sessions/**/*.jsonl",
      availability: "available",
      notes: [
        "Codex writes its own session transcript, but OpenGrove should still rely on adapter RPC capture for bridge debugging.",
      ],
    },
    notes: [
      "Codex is the reference adapter for full native-harness bridging: OpenGrove should not duplicate native shell/patch/tool execution.",
    ],
  },
};

// ===== Runtime controls builder =====

const MODEL_LABELS: Record<string, string> = {
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.2": "GPT-5.2",
};

let _codexFallbackModels: BridgeRuntimeControlOption[] | undefined;
function codexFallbackModels(): BridgeRuntimeControlOption[] {
  if (!_codexFallbackModels) {
    _codexFallbackModels = BRIDGE_MODEL_IDS.filter((id) => id.startsWith("gpt-")).map((id) => ({
      id,
      label: MODEL_LABELS[id] ?? id,
    }));
  }
  return _codexFallbackModels;
}

const DEFAULT_REASONING_OPTIONS: BridgeRuntimeControlOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
];

interface CodexModelsCache {
  source: string;
  models: Array<Record<string, unknown>>;
}

function readCodexModelsCache(codexHome = resolve(homedir(), ".codex")): CodexModelsCache {
  const path = resolve(codexHome, "models_cache.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { models?: unknown };
    return {
      source: path,
      models: Array.isArray(parsed.models)
        ? parsed.models.filter((model): model is Record<string, unknown> =>
            Boolean(model && typeof model === "object" && !Array.isArray(model)),
          )
        : [],
    };
  } catch {
    return { source: "codex-fallback", models: [] };
  }
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
}

function reasoningEffortLabel(value: string): string {
  return value === "low"
    ? "Low"
    : value === "medium"
      ? "Medium"
      : value === "xhigh"
        ? "Extra high"
        : value === "max"
          ? "Maximum"
          : "High";
}

function normalizeReasoningOptions(value: unknown): BridgeRuntimeControlOption[] {
  if (!Array.isArray(value)) return DEFAULT_REASONING_OPTIONS;
  const options = value
    .map((item) => {
      if (typeof item === "string") {
        const effort = normalizeReasoningEffort(item);
        return effort ? { id: effort, label: reasoningEffortLabel(effort) } : undefined;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const record = item as Record<string, unknown>;
      const effort = normalizeReasoningEffort(record.effort);
      return effort
        ? {
            id: effort,
            label: reasoningEffortLabel(effort),
            description: stringValue(record.description),
          }
        : undefined;
    })
    .filter((item): item is BridgeRuntimeControlOption => Boolean(item));
  return options.length ? options : DEFAULT_REASONING_OPTIONS;
}

function normalizeSpeedTiers(value: unknown): BridgeRuntimeControlOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      item === "fast"
        ? { id: "fast", label: "Fast", description: "1.5× speed with increased usage" }
        : typeof item === "string"
          ? { id: item, label: item }
          : undefined,
    )
    .filter((item): item is BridgeRuntimeControlOption => Boolean(item));
}

export function buildCodexRuntimeControls(configHome: string): BridgeRuntimeControls {
  const cache = readCodexModelsCache(configHome);
  const cacheModels = cache.models
    .filter((model) => stringValue(model.visibility) !== "hide")
    .map((model) => ({
      id: stringValue(model.slug),
      label: stringValue(model.display_name) || stringValue(model.slug),
      priority: numberValue(model.priority),
      reasoning: normalizeReasoningOptions(model.supported_reasoning_levels),
      defaultReasoning: normalizeReasoningEffort(model.default_reasoning_level),
      speed: normalizeSpeedTiers(model.additional_speed_tiers),
    }))
    // models_cache.json 是 Codex CLI 自己声明的模型清单（自动更新），直接信任可见项；
    // 不再拿 BRIDGE_MODEL_IDS 白名单准入，否则内核升级出的新模型会被静默滤掉。
    .filter(
      (
        model,
      ): model is {
        id: string;
        label: string;
        priority: number | undefined;
        reasoning: BridgeRuntimeControlOption[];
        defaultReasoning: string | undefined;
        speed: BridgeRuntimeControlOption[];
      } => Boolean(model.id),
    );

  const models = cacheModels.length
    ? cacheModels
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
        .map((model) => ({ id: model.id, label: model.label }))
    : codexFallbackModels();
  const current = cacheModels.find((model) => model.id === readCodexConfiguredModel()) ?? cacheModels[0];
  return {
    kernel: "codex",
    source: cache.source,
    models,
    defaultModel: readCodexConfiguredModel(),
    reasoningEfforts: current?.reasoning?.length ? current.reasoning : DEFAULT_REASONING_OPTIONS,
    defaultReasoningEffort: current?.defaultReasoning ?? "medium",
    speedTiers: [
      { id: "standard", label: "Standard", description: "Default speed and regular usage" },
      ...(current?.speed ?? []),
    ],
    defaultSpeedTier: "standard",
  };
}

// ===== Provider env builder =====

export function buildCodexProviderEnv(profile: ProviderProfile): Record<string, string> | undefined {
  if (!profile.apiKey) return undefined;
  const normalized = profile.id
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const envKey = appEnvName(`${normalized || "PROVIDER"}_API_KEY`);
  return { [envKey]: profile.apiKey };
}

// ===== Kernel-local Login/Provider route reader =====

export function readCodexLocalRouteProfile(configHomeOverride?: string): KernelLocalRouteProfile {
  const codexHome = configHomeOverride?.trim() || process.env.CODEX_HOME?.trim() || resolve(homedir(), ".codex");
  const configPath = resolve(codexHome, "config.toml");
  const authPath = resolve(codexHome, "auth.json");
  const modelsCachePath = resolve(codexHome, "models_cache.json");
  const config = existsSync(configPath) ? readFileText(configPath) : "";
  const modelProvider = readTomlString(config, "model_provider");
  const providerBlock = modelProvider ? readTomlTable(config, `model_providers.${modelProvider}`) : {};
  const baseUrl = stringValue(providerBlock.base_url);
  const apiKeyEnv = stringValue(providerBlock.env_key);
  const model = readTomlString(config, "model");
  const effort = readTomlString(config, "model_reasoning_effort") || "medium";
  const models = readCodexProfileModelsCache(modelsCachePath);
  const auth = readJsonObject(authPath);
  const authMode = stringValue(auth.auth_mode)?.toLowerCase();
  const loginConfigured = authMode === "chatgpt" || hasCredentialRecord(auth.tokens);
  const apiKeyConfigured = Boolean(
    stringValue(auth.OPENAI_API_KEY) ||
      process.env.OPENAI_API_KEY?.trim() ||
      (apiKeyEnv && process.env[apiKeyEnv]?.trim()),
  );
  // Merely naming Codex's built-in `openai` model provider does not replace a
  // ChatGPT product login. Only an external endpoint/key configuration does.
  const routeKind =
    baseUrl || apiKeyEnv || authMode === "apikey" || (!loginConfigured && apiKeyConfigured)
      ? ("provider" as const)
      : ("login" as const);
  return {
    kernel: "codex",
    source: [configPath, modelsCachePath].filter((path) => existsSync(path)).join(",") || "codex-defaults",
    sourcePaths: [configPath, authPath, modelsCachePath],
    env: {
      OPENAI_BASE_URL: baseUrl ?? "",
      OPENAI_API_KEY: stringValue(auth.OPENAI_API_KEY) ? "<configured>" : "",
    },
    settingsModel: model,
    providerId: routeKind === "login" ? "codex-login" : modelProvider || (baseUrl ? "openai-compatible" : "openai"),
    providerLabel:
      routeKind === "login"
        ? "ChatGPT"
        : stringValue(providerBlock.name) || (baseUrl ? modelProvider || "OpenAI-compatible provider" : "OpenAI API"),
    baseUrl,
    apiKeyEnv,
    authConfigured: routeKind === "login" ? loginConfigured : apiKeyConfigured,
    routeKind,
    models,
    defaultModel: model || models[0]?.id,
    reasoningEfforts: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra high" },
    ],
    defaultReasoningEffort: effort,
    speedTiers: [{ id: "standard", label: "Standard" }],
    defaultSpeedTier: "standard",
  };
}

function readCodexProfileModelsCache(path: string): BridgeRuntimeControlOption[] {
  const parsed = readJsonObject(path);
  const models = Array.isArray(parsed.models) ? parsed.models : [];
  return models
    .map((item) => (item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {}))
    .filter((model) => stringValue(model.visibility) !== "hide")
    .map((model) => {
      const id = stringValue(model.slug) || stringValue(model.id);
      const label = stringValue(model.display_name) || stringValue(model.label) || id;
      return id ? { id, label: label || id } : undefined;
    })
    .filter((item): item is BridgeRuntimeControlOption => Boolean(item));
}
