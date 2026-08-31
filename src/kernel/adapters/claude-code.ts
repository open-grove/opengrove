import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeAgentSdkRuntime, type ClaudeAgentSdkRuntimeOptions } from "../../runtime/claude-agent-sdk-runtime.js";
import {
  ClaudeCodeRuntime,
  resolveClaudeCodeCliPath,
  resolveClaudeCodeCliPathDetailed,
  type ClaudeCodeCliPathSource,
  type ClaudeCodeRuntimeOptions,
} from "../../runtime/claude-code-runtime.js";
import { hasAwsCredential } from "../../runtime/claude-bedrock-env.js";
import { readClaudeDesktopBedrockConfig } from "../../runtime/claude-desktop-config.js";
import { readClaudeModelsCache, resolveClaudeEffortLevels } from "../../runtime/claude-models-cache.js";
import { APP_PROTOCOL_ID, appEnvName, readAppEnv } from "../../identity.js";
import { RuntimeKernelAdapter } from "../adapter.js";
import {
  commandDiscoveryHealth,
  directorySource,
  fileSource,
  kernelExecutableProbe,
  plannedInstallAction,
  probeCommandPath,
  resolveCommandInvocation,
  resolveHomePath,
} from "../discovery.js";
import {
  bridgeKernelSupportsHostTools,
  resolveClaudeCodeRuntimeMode,
  type ClaudeCodeRuntimeMode,
} from "../host-tools.js";
import type { KernelAdapterContract, KernelDiscovery, KernelHealth, ProviderProfile } from "../types.js";
import type { BridgeRuntimeControls } from "../../server/bridge-types.js";
import {
  type BridgeRuntimeControlOption,
  type KernelLocalRouteReadOptions,
  type KernelLocalRouteProfile,
  deepMerge,
  isEnabled,
  modelDisplayName,
  normalizeBaseUrl,
  readJsonObject,
  readStringMap,
  stringValue,
} from "./profile-utils.js";

export class ClaudeCodeKernelAdapter extends RuntimeKernelAdapter {
  constructor(private readonly claudeOptions: ClaudeAgentSdkRuntimeOptions) {
    const runtimeMode = resolveClaudeCodeRuntimeMode();
    const runtimeOptions = withResolvedClaudeCliPath(claudeOptions);
    super({
      id: "claude-code",
      title: "Claude Agent",
      runtime:
        runtimeMode === "sdk"
          ? new ClaudeAgentSdkRuntime(runtimeOptions)
          : new ClaudeCodeRuntime(toClaudeCodeRuntimeOptions(runtimeOptions)),
      capabilities: {
        sessionHistory: "kernel",
        reasoning: {
          nativeText: runtimeMode === "sdk" ? "conditional" : "unsupported",
          summary: "unsupported",
        },
        streaming: true,
        toolCalls: true,
        hostTools: bridgeKernelSupportsHostTools("claude-code"),
        approvals: true,
        elicitation: runtimeMode === "sdk",
        artifacts: false,
        compaction: runtimeMode === "sdk",
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
      },
      contract: claudeCodeKernelContract(runtimeMode),
    });
  }

  async discover(): Promise<KernelDiscovery> {
    return discoverClaudeCodeKernel(this.claudeOptions, process.cwd(), this.contract.diagnostics);
  }

  override async healthCheck(): Promise<KernelHealth> {
    const candidate = claudeExecutableCandidate(this.claudeOptions.cliPath, this.claudeOptions.cwd);
    return claudeCommandHealth(probeCommandPath(candidate.command), candidate);
  }
}

export function createClaudeCodeKernelAdapter(options: ClaudeAgentSdkRuntimeOptions): ClaudeCodeKernelAdapter {
  return new ClaudeCodeKernelAdapter(options);
}

export function createClaudeCodeKernelAdapterFromOptions(
  options: import("../types.js").KernelCreateOptions,
): ClaudeCodeKernelAdapter {
  const candidate = claudeExecutableCandidate(options.command, options.cwd);
  const commandProbe = probeCommandPath(candidate.command);
  const cliPath =
    commandProbe.resolvedPath && commandProbe.probe.status !== "failed" ? commandProbe.resolvedPath : undefined;
  if (!cliPath) {
    throw new Error(claudeCommandHealth(commandProbe, candidate).message || "Claude Agent runtime was not found.");
  }
  const modelAliases = options.provider ? claudeCodeModelAliasesFromProvider(options.provider) : {};
  return new ClaudeCodeKernelAdapter({
    cliPath,
    cwd: options.cwd,
    configuredModel: options.provider ? options.model : undefined,
    runtimeBindingFingerprint: options.runtimeBindingFingerprint,
    modelAliases,
    permissionMode: "bypassPermissions",
    env: options.env,
  });
}

function claudeCodeModelAliasesFromProvider(_provider: import("../types.js").ProviderProfile): Record<string, string> {
  // When bound to an external provider, the model field itself is already the
  // resolved kernel model (e.g. "opus"). No further alias mapping needed at
  // adapter construction — that logic lives in kernel-selection/registry.
  return {};
}

export { resolveClaudeCodeRuntimeMode } from "../host-tools.js";
export type { ClaudeCodeRuntimeMode } from "../host-tools.js";

export function claudeCodeKernelContract(
  runtimeMode: ClaudeCodeRuntimeMode = resolveClaudeCodeRuntimeMode(),
): KernelAdapterContract {
  return {
    ...CLAUDE_CODE_KERNEL_CONTRACT,
    labels: {
      ...CLAUDE_CODE_KERNEL_CONTRACT.labels,
      integrationMode: runtimeMode === "sdk" ? "sdk" : "cli",
    },
  };
}

function withResolvedClaudeCliPath(
  options: ClaudeAgentSdkRuntimeOptions,
): ClaudeAgentSdkRuntimeOptions & { cliPath: string } {
  return {
    ...options,
    cliPath: options.cliPath || resolveClaudeCodeCliPath(options.cwd) || readAppEnv("CLAUDE_CLI_PATH") || "claude",
  };
}

function toClaudeCodeRuntimeOptions(
  options: ClaudeAgentSdkRuntimeOptions & { cliPath: string },
): ClaudeCodeRuntimeOptions {
  const { query: _query, ...runtimeOptions } = options;
  return runtimeOptions;
}

export function discoverClaudeCodeKernel(
  options: Partial<ClaudeAgentSdkRuntimeOptions> = {},
  cwd = process.cwd(),
  diagnostics = CLAUDE_CODE_KERNEL_CONTRACT.diagnostics,
): KernelDiscovery {
  const claudeHome = options.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || resolveHomePath(".claude");
  const candidate = claudeExecutableCandidate(options.cliPath, cwd);
  const discovery = probeCommandPath(candidate.command);
  const cliPath = discovery.resolvedPath;
  const version = discovery.probe.version;
  const installed = Boolean(cliPath);
  const available = installed && discovery.probe.status !== "failed";
  const engineSourceNote = cliPath ? claudeEngineSourceNote(candidate.engineSource, cliPath, version) : undefined;
  return {
    kernelId: "claude-code",
    title: "Claude Agent",
    installed,
    available,
    binaryPath: cliPath,
    version,
    executableProbe: kernelExecutableProbe(discovery, {
      role: "runtime-required",
      source: candidate.source,
      sourceName: candidate.sourceName,
    }),
    health: claudeCommandHealth(discovery, candidate),
    configHome: claudeHome,
    diagnostics,
    knowledgeSources: [
      fileSource({
        id: "claude.user-claude-md",
        title: "CLAUDE.md",
        kind: "project_instructions",
        scope: "user",
        path: `${claudeHome}/CLAUDE.md`,
        native: true,
        syncMode: "index",
        description: "Claude 全局常驻指令文件。",
      }),
      directorySource({
        id: "claude.user-skills",
        title: "skills",
        kind: "skills",
        scope: "user",
        path: `${claudeHome}/skills`,
        native: true,
        syncMode: "index",
      }),
      directorySource({
        id: "claude.user-commands",
        title: "User slash commands",
        kind: "commands",
        scope: "user",
        path: `${claudeHome}/commands`,
        native: true,
        userVisible: false,
        knowledgeLike: false,
        syncMode: "index",
      }),
      directorySource({
        id: "claude.user-agents",
        title: "agents",
        kind: "agents",
        scope: "user",
        path: `${claudeHome}/agents`,
        native: true,
        knowledgeLike: true,
        syncMode: "index",
      }),
      directorySource({
        id: "claude.user-agent-memory",
        title: "memory",
        kind: "memory",
        scope: "user",
        path: `${claudeHome}/agent-memory`,
        native: true,
        syncMode: "index",
      }),
      directorySource({
        id: "claude.session-memory",
        title: "Session memory config",
        kind: "memory",
        scope: "user",
        path: `${claudeHome}/session-memory`,
        native: true,
        userVisible: false,
        knowledgeLike: false,
        syncMode: "index",
        description: "Claude Agent session memory 的 prompt/template 和缓存目录。",
      }),
      directorySource({
        id: "claude.output-styles",
        title: "Output styles",
        kind: "settings",
        scope: "user",
        path: `${claudeHome}/output-styles`,
        native: true,
        userVisible: false,
        knowledgeLike: false,
        syncMode: "index",
      }),
      fileSource({
        id: "claude.user-settings",
        title: "User settings.json",
        kind: "settings",
        scope: "user",
        path: `${claudeHome}/settings.json`,
        native: true,
        knowledgeLike: false,
        syncMode: "none",
      }),
      fileSource({
        id: "claude.project-settings",
        title: "Project settings.json",
        kind: "settings",
        scope: "project",
        path: `${cwd}/.claude/settings.json`,
        native: true,
        knowledgeLike: false,
        syncMode: "none",
      }),
      fileSource({
        id: "claude.local-settings",
        title: "Local settings.json",
        kind: "settings",
        scope: "workspace",
        path: `${cwd}/.claude/settings.local.json`,
        native: true,
        knowledgeLike: false,
        enabledByDefault: false,
        syncMode: "none",
      }),
      directorySource({
        id: "claude.native-transcripts",
        title: "Claude native transcripts",
        kind: "sessions",
        scope: "user",
        path: `${claudeHome}/projects`,
        native: true,
        knowledgeLike: false,
        enabledByDefault: false,
        syncMode: "none",
      }),
    ],
    installActions: [
      plannedInstallAction({
        id: "claude.install",
        title: "Install Anthropic Claude runtime",
        command: ["npm", "install", "-g", "@anthropic-ai/claude-code"],
      }),
    ],
    notes: [
      ...(engineSourceNote ? [engineSourceNote] : []),
      "Claude Agent 把 CLAUDE.md/rules 视为项目指令，把 skills/commands/agents/agent-memory 视为不同原生对象；OpenGrove 不应该把它们混成一个 flat skill 列表。",
    ],
  };
}

function claudeExecutableCandidate(configuredCommand: string | undefined, cwd = process.cwd()) {
  const configured = configuredCommand?.trim();
  if (configured) {
    return {
      command: configured,
      source: "configured" as const,
      sourceName: undefined,
      engineSource: "override" as const,
    };
  }
  const environment = readAppEnv("CLAUDE_CLI_PATH")?.trim();
  if (environment) {
    return {
      command: environment,
      source: "environment" as const,
      sourceName: appEnvName("CLAUDE_CLI_PATH"),
      engineSource: "override" as const,
    };
  }
  const resolved = resolveClaudeCodeCliPathDetailed(cwd);
  return {
    command: resolved?.path,
    source: resolved?.source === "bundled" ? ("bundled" as const) : ("discovered" as const),
    engineSource: resolved?.source ?? ("external" as const),
  };
}

function claudeCommandHealth(
  discovery: ReturnType<typeof probeCommandPath>,
  candidate: ReturnType<typeof claudeExecutableCandidate>,
): KernelHealth {
  return commandDiscoveryHealth(discovery, {
    title: "Claude Agent",
    role: "runtime-required",
    source: candidate.source,
    sourceName: candidate.sourceName,
    missingMessage: `Claude Agent runtime was not found. Set ${appEnvName("CLAUDE_CLI_PATH")}.`,
  });
}

function claudeEngineSourceNote(source: ClaudeCodeCliPathSource, cliPath: string, version: string | undefined): string {
  if (source === "bundled") {
    return `使用内置 Claude 引擎（随 OpenGrove 分发）：${version || "版本未知"}`;
  }
  if (source === "override") {
    return `使用显式 Claude 引擎：${cliPath}（${version || "版本未知"}）`;
  }
  return `使用外部 Claude 引擎：${cliPath}（${version || "版本未知"}）`;
}

export const CLAUDE_CODE_KERNEL_CONTRACT: KernelAdapterContract = {
  paths: {
    configHomeEnvVar: "CLAUDE_CONFIG_DIR",
    defaultConfigHome: ".claude",
    cliCommand: "claude",
    projectSkillDir: ".claude/skills",
    nativeSkillMarker: "/.claude/skills/",
    knowledgeBuckets: [
      { pathContains: "/.claude/skills/", bucket: "claude.project-skills" },
      { pathContains: "/.claude/commands/", bucket: "claude.project-commands" },
      { pathContains: "/.claude/agents/", bucket: "claude.project-agents" },
      { pathContains: "/.claude/agent-memory", bucket: "claude.project-agent-memory" },
      { pathContains: "/claude.md", bucket: "claude.project-claude-md" },
      { pathContains: "/.claude/rules/", bucket: "claude.project-claude-md" },
    ],
    defaultKnowledgeBucket: "claude.user-skills",
  },
  display: {
    defaultModelId: "claude-code-default",
    modelDisplayAliases: ["Claude Agent", "Claude Code", "AWS Bedrock (API Key)"],
    modelDisplaySuffixAlias: "(Claude Code)",
  },
  inputFormats: {
    planMode: {
      withInput: "Plan first, then wait for confirmation before making changes:\n{input}",
      withoutInput: "Plan first, then wait for confirmation before making changes.",
    },
    skillInvocation: { withArgs: "/{name} {args}", withoutArgs: "/{name}" },
    modelAliasStrategy: "family-alias",
    nativeModelNormalization: true,
  },
  labels: { title: "Claude Agent", integrationMode: "sdk" },
  ownership: [
    {
      feature: "session",
      owner: "shared",
      nativeName: "Claude session / transcript",
      appResponsibility: "Own OpenGrove session/run ids and project navigation.",
      kernelResponsibility: "Own Claude Agent session storage and transcript files.",
      adapterResponsibility: "Bind OpenGrove session ids to the stable Claude session id used by the bridge.",
    },
    {
      feature: "turn_lifecycle",
      owner: "shared",
      nativeName: "stream-json messages",
      appResponsibility: "Record normalized run lifecycle and trajectory.",
      kernelResponsibility: "Stream assistant/tool events through the Claude Agent SDK harness.",
      adapterResponsibility: "Map SDK messages into OpenGrove AgentEvent without rebuilding Claude's inner loop.",
    },
    {
      feature: "transport",
      owner: "adapter",
      nativeName: "Claude Agent SDK query stream",
      adapterResponsibility:
        "Use the in-process Agent SDK message/request callbacks; report the legacy CLI escape hatch as degraded instead of pretending SDK parity.",
    },
    {
      feature: "model_loop",
      owner: "kernel",
      nativeName: "Claude Agent QueryEngine",
      kernelResponsibility: "Own model calls, tool planning, native skill loading, and compact behavior.",
      adapterResponsibility: "Avoid rebuilding the Claude Agent native loop in OpenGrove.",
    },
    {
      feature: "native_tool_execution",
      owner: "kernel",
      nativeName: "Claude Agent tools",
      kernelResponsibility: "Execute Claude Agent native tools and MCP tools.",
      adapterResponsibility: "Map Claude tool_use/tool_result blocks into OpenGrove events when visible in the stream.",
    },
    {
      feature: "host_tool_execution",
      owner: "shared",
      appResponsibility: "Own OpenGrove host tools and tool-side artifacts.",
      kernelResponsibility: "Call exposed SDK MCP tools when OpenGrove host capabilities are useful.",
      adapterResponsibility:
        "In SDK mode, expose OpenGrove tools through an in-process MCP server and execute them through OpenGrove policy/approval stores. CLI mode has no Host Tool bridge and must report that degradation instead of claiming ledger reads or delegation.",
    },
    {
      feature: "approval",
      owner: "shared",
      nativeName: "CanUseToolFn / ToolUseConfirm",
      appResponsibility: "Own approval UI and durable approval records.",
      kernelResponsibility: "Decide native tool confirmation requirements.",
      adapterResponsibility:
        "Map CanUseTool permission prompts into OpenGrove approval requests and return the user's decision to Claude.",
    },
    {
      feature: "user_question",
      owner: "shared",
      nativeName: "handleElicitation / ask user",
      appResponsibility: "Own structured question UI.",
      kernelResponsibility: "May request user information through native elicitation paths.",
      adapterResponsibility:
        "Map SDK onElicitation requests into OpenGrove user-input approvals and return accepted form content.",
    },
    {
      feature: "skill_discovery",
      owner: "shared",
      nativeName: "Claude Agent plugin/bundled/MCP skills",
      appResponsibility: "Own OpenGrove vault skill source and publication ledger.",
      kernelResponsibility: "Discover native Claude Agent skills.",
      adapterResponsibility:
        "Publish OpenGrove skills into Claude-compatible skill locations instead of injecting full bodies.",
    },
    {
      feature: "skill_loading",
      owner: "kernel",
      nativeName: "Claude Agent native skill loader",
      appResponsibility: "Provide source files and metadata in a Claude-compatible layout.",
      kernelResponsibility: "Progressively load skill documents and references.",
      adapterResponsibility: "Declare publication targets and loading status.",
    },
    {
      feature: "context_assembly",
      owner: "shared",
      appResponsibility:
        "Pass explicit user-added context, attachments, and narrow vault UI hints; leave project reading to Claude Agent tools.",
      kernelResponsibility: "Add Claude Agent native system/user/tool context.",
      adapterResponsibility: "Keep OpenGrove context distinct from Claude native prompt internals.",
    },
    {
      feature: "knowledge_retrieval",
      owner: "shared",
      appResponsibility: "Provide only explicitly selected OpenGrove knowledge and configured MCP context.",
      kernelResponsibility:
        "Own native Read, Glob, Grep, WebSearch, WebFetch, and MCP retrieval inside the Claude Agent loop.",
      adapterResponsibility:
        "Preserve native retrieval as tool activity instead of flattening its raw payload into assistant text.",
    },
    {
      feature: "artifact_extraction",
      owner: "shared",
      appResponsibility: "Own OpenGrove ArtifactRecord lifecycle.",
      kernelResponsibility: "May create files/media through native tools.",
      adapterResponsibility: "Extract visible tool result attachments and file references into OpenGrove artifacts.",
    },
    {
      feature: "memory_write",
      owner: "app",
      appResponsibility: "Own OpenGrove memory writes, review, confidence, and decay.",
    },
    {
      feature: "compaction",
      owner: "shared",
      nativeName: "Claude compact boundary",
      appResponsibility: "Record OpenGrove memory/context snapshots.",
      kernelResponsibility: "Run native compact.",
      adapterResponsibility: "Map SDK compact status/boundary messages into OpenGrove compaction events.",
    },
    {
      feature: "auth",
      owner: "shared",
      nativeName: "Anthropic/Bedrock auth",
      appResponsibility: "Own AuthProfileStore entries when configured through OpenGrove.",
      kernelResponsibility: "Use the Claude Agent runtime's configured auth/provider path.",
      adapterResponsibility: "Avoid writing raw API keys or Bedrock credentials into diagnostic captures.",
    },
    {
      feature: "sandbox",
      owner: "shared",
      nativeName: "permission mode",
      appResponsibility: "Expose OpenGrove policy preference.",
      kernelResponsibility: "Enforce Claude Agent permission mode.",
      adapterResponsibility: "Map OpenGrove access modes into Claude permission modes.",
    },
    {
      feature: "trajectory",
      owner: "app",
      appResponsibility: "Persist normalized trajectory records.",
      adapterResponsibility: "Attach Claude native message/session ids when available.",
    },
    {
      feature: "diagnostics",
      owner: "adapter",
      nativeName: "stream-json / transcript",
      appResponsibility: "Expose available diagnostic layers and privacy notes.",
      adapterResponsibility: "Declare what can be recorded through the CLI stream and native transcript.",
    },
  ],
  eventMappings: [
    {
      appEvent: "turn.started",
      nativeRequest: "Claude Agent SDK query()",
      direction: "app_to_native",
      adapterResponsibility:
        "Start each OpenGrove run before creating the Claude SDK query and keep the same runId through the stream.",
    },
    {
      appEvent: "context.assembled",
      nativeRequest: "Claude Agent SDK prompt/systemPrompt options",
      direction: "app_to_native",
      adapterResponsibility:
        "Forward assembled OpenGrove context as explicit host context without replacing Claude Agent's native project context.",
    },
    {
      appEvent: "model.requested",
      nativeRequest: "Claude Agent SDK query({ prompt, options })",
      direction: "app_to_native",
      adapterResponsibility:
        "Map OpenGrove input, model id, session binding, tools, skills, packs, and capabilities into the SDK query options.",
    },
    {
      appEvent: "runtime.diagnostic",
      nativeEvent: "system.init / result / hook events / auth_status",
      direction: "native_to_app",
      adapterResponsibility:
        "Expose Claude SDK version, native session id, permission mode, slash commands, skills, MCP servers, result metadata, hooks, and auth status as structured diagnostics.",
    },
    {
      appEvent: "assistant.delta",
      nativeEvent: "stream_event content_block_delta / assistant text block",
      direction: "native_to_app",
      adapterResponsibility:
        "Convert SDK text deltas into incremental assistant.delta events and avoid replaying assistant text blocks when partial deltas were already seen.",
    },
    {
      appEvent: "reasoning.started / reasoning.completed",
      nativeEvent: "stream_event content_block_delta thinking_delta",
      direction: "native_to_app",
      adapterResponsibility:
        "Preserve SDK thinking text as kind=native and keep it separate from reasoning summaries and final-answer text.",
    },
    {
      appEvent: "tool.started",
      nativeEvent: "assistant tool_use block",
      direction: "native_to_app",
      adapterResponsibility:
        "Map visible Claude native tool_use blocks into claude.<toolName> tool.started events while suppressing OpenGrove MCP host-tool echo.",
    },
    {
      appEvent: "tool.finished",
      nativeEvent: "user tool_result block",
      direction: "native_to_app",
      adapterResponsibility:
        "Map visible Claude native tool_result blocks into matching tool.finished events and normalize successful/error results.",
    },
    {
      appEvent: "planning.updated",
      nativeEvent:
        "assistant TodoWrite / TaskCreate tool_use, TaskUpdate / TaskList tool_result; Task tool_use fallback",
      direction: "native_to_app",
      adapterResponsibility:
        "Aggregate Claude TaskCreate/TaskUpdate/TaskList records into one OpenGrove planning.updated list, project TodoWrite lists directly, and use Task description/prompt as a single fallback only when no todo-like tool has appeared in the run.",
    },
    {
      appEvent: "approval.requested",
      nativeRequest: "CanUseToolFn",
      direction: "bidirectional",
      adapterResponsibility:
        "Translate SDK permission prompts into OpenGrove approval requests, wait for the decision, and return allow/deny behavior to Claude.",
    },
    {
      appEvent: "question.requested / question.answered",
      nativeRequest: "onElicitation / AskUserQuestion",
      direction: "bidirectional",
      adapterResponsibility:
        "Carry structured user questions through OpenGrove question events and return accepted content to Claude.",
    },
    {
      appEvent: "compaction.started / compaction.finished",
      nativeEvent: "system.status compacting / compact_boundary",
      direction: "native_to_app",
      adapterResponsibility:
        "Map SDK compact status and compact boundary messages into OpenGrove compaction lifecycle events.",
    },
    {
      appEvent: "model.response",
      nativeEvent: "result success",
      direction: "native_to_app",
      adapterResponsibility:
        "Emit one final model.response using the SDK result text, falling back to accumulated assistant text when needed.",
    },
    {
      appEvent: "error",
      nativeEvent: "result error / SDK exception",
      direction: "native_to_app",
      adapterResponsibility:
        "Emit a readable redacted error for SDK failures and include bounded stderr diagnostics when available.",
    },
    {
      appEvent: "turn.finished",
      nativeEvent: "result terminal state / SDK exception",
      direction: "native_to_app",
      adapterResponsibility: "Always close the OpenGrove turn after success, SDK error, or mapped runtime failure.",
    },
  ],
  diagnostics: {
    defaultModeId: "claude-agent-sdk",
    modes: [
      {
        id: "claude-agent-sdk",
        title: "Claude Agent SDK event stream",
        layer: "adapter-rpc",
        status: "implemented",
        enabledByDefault: true,
        redaction: "redacted",
        notes: [
          "Runs Claude Agent through @anthropic-ai/claude-agent-sdk, including native tools, MCP, skills, slash commands, permission callbacks, elicitation, hooks, and compact messages.",
          "OpenGrove host tools are exposed as an in-process SDK MCP server named opengrove.",
        ],
      },
      {
        id: "claude-cli-stream",
        title: "Claude CLI stream-json capture",
        layer: "process-stdio",
        status: "planned",
        enabledByDefault: false,
        output: "data/claude-code-captures/",
        env: [
          appEnvName("CLAUDE_CODE_CAPTURE"),
          appEnvName("CLAUDE_CODE_CAPTURE_DIR"),
          appEnvName("CLAUDE_CODE_CAPTURE_MAX_INLINE_BYTES"),
          appEnvName("CLAUDE_CODE_CAPTURE_STDERR"),
          appEnvName("CLAUDE_CODE_CAPTURE_RAW_IO"),
        ],
        redaction: "raw",
        notes: [
          "Records Claude CLI stream-json stdout events plus OpenGrove-mapped events.",
          "By default it also records the raw OpenGrove user input, appended system prompt, and raw stdout JSON line, matching native transcript expectations.",
          `Set ${appEnvName("CLAUDE_CODE_CAPTURE_RAW_IO")}=0 to keep only bytes/hash summaries for input and stdout.`,
          "Structured event copies are still redacted for easier inspection, but raw fields are intentionally exact.",
          "It does not expose hidden reasoning or the final provider request payload.",
        ],
      },
      {
        id: "claude-native-transcript",
        title: "Claude Agent native transcript",
        layer: "native-transcript",
        status: "external",
        output: "~/.claude/projects/**/*.jsonl",
        redaction: "external",
        notes: [
          "Owned by the Claude Agent runtime. Useful for session messages, but not a full provider request/system-prompt dump.",
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
      path: "~/.claude/projects/**/*.jsonl",
      availability: "partial",
      notes: ["Claude native transcripts are useful but do not include hidden thinking or complete provider requests."],
    },
    notes: [
      "Claude Agent is driven through the Anthropic Agent SDK, preserving SDK-managed sessions, native tool events, approvals, and its native execution model.",
    ],
  },
};

// ===== Runtime controls builder =====

const CLAUDE_CODE_DEFAULT_MODEL_ID = "claude-code-default";

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

export function buildClaudeCodeRuntimeControls(
  configHome: string,
  localRouteProfile: { models?: BridgeRuntimeControlOption[]; defaultModel?: string; source?: string } | undefined,
): BridgeRuntimeControls {
  const profileModels = localRouteProfile?.models ?? [];
  const models = [
    { id: CLAUDE_CODE_DEFAULT_MODEL_ID, label: "Use Claude Agent configuration" },
    ...profileModels.filter((model) => model.id !== CLAUDE_CODE_DEFAULT_MODEL_ID),
  ];
  const defaultModel = localRouteProfile?.defaultModel ?? models[0]?.id;
  // Effort levels are model-specific and learned at runtime from the SDK
  // (query.supportedModels()), persisted to a cache. Advertise exactly what the
  // selected model supports; when the cache is absent the picker stays hidden (empty).
  const effortCache = readClaudeModelsCache(configHome);
  const effortLevels = resolveClaudeEffortLevels(effortCache, defaultModel);
  const reasoningEfforts: BridgeRuntimeControlOption[] = effortLevels.map((id) => ({
    id,
    label: reasoningEffortLabel(id),
  }));
  return {
    kernel: "claude-code",
    source: localRouteProfile?.source ?? "claude-code-defaults",
    models,
    defaultModel,
    reasoningEfforts,
    defaultReasoningEffort: reasoningEfforts.some((option) => option.id === "high") ? "high" : reasoningEfforts[0]?.id,
    speedTiers: [],
  };
}

// ===== Provider env builder =====

export function buildClaudeCodeProviderEnv(profile: ProviderProfile): Record<string, string> | undefined {
  if (!profile.baseUrl) return undefined;

  // Only handle anthropic-compatible protocol (or undefined for backward compat)
  if (profile.protocol && profile.protocol !== "anthropic-compatible") return undefined;

  // AWS Bedrock path
  if (profile.credentialKind === "aws") {
    const env: Record<string, string> = {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BEDROCK_BASE_URL: profile.baseUrl,
    };
    const region = profile.baseUrl.match(/bedrock-runtime[.-]([a-z0-9-]+)\.amazonaws\.com/i)?.[1];
    if (region) env.AWS_REGION = region;
    if (profile.apiKey) env.AWS_BEARER_TOKEN_BEDROCK = profile.apiKey;
    applyClaudeModelEnvVars(env, profile.model);
    return env;
  }

  // Google Vertex path
  if (profile.credentialKind === "google-adc") {
    const env: Record<string, string> = {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_BASE_URL: profile.baseUrl,
    };
    applyClaudeModelEnvVars(env, profile.model);
    return env;
  }

  // Standard Anthropic-compatible path
  if (!profile.apiKey || !profile.baseUrl) return undefined;
  const env: Record<string, string> = {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    ANTHROPIC_BASE_URL: profile.baseUrl,
  };
  if (profile.id === "ww" || profile.apiKey.startsWith("ww_sk_")) {
    env.ANTHROPIC_API_KEY = profile.apiKey;
    env.ANTHROPIC_AUTH_TOKEN = "";
  } else {
    env.ANTHROPIC_AUTH_TOKEN = profile.apiKey;
  }
  applyClaudeModelEnvVars(env, profile.model);
  return env;
}

function applyClaudeModelEnvVars(env: Record<string, string>, model: string | undefined): void {
  if (!model) return;
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
}

// ===== Kernel-local Login/Provider route reader =====

const CLAUDE_AUTH_STATUS_CACHE_TTL_MS = 10_000;
const claudeAuthStatusCache = new Map<string, { checkedAt: number; authenticated: boolean }>();

const CLAUDE_MODEL_FAMILIES = [
  {
    alias: "opus",
    label: "Opus",
    envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    nameKey: "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    descriptionKey: "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  },
  {
    alias: "sonnet",
    label: "Sonnet",
    envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    nameKey: "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    descriptionKey: "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  },
  {
    alias: "haiku",
    label: "Haiku",
    envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    nameKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    descriptionKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  },
] as const;

interface ClaudeProviderPreset {
  id: string;
  name: string;
  baseUrls: string[];
}

const CLAUDE_PROVIDER_PRESETS: ClaudeProviderPreset[] = [
  { id: "anthropic", name: "Claude Official", baseUrls: ["https://api.anthropic.com"] },
  { id: "aws-bedrock", name: "AWS Bedrock", baseUrls: ["https://bedrock-runtime."] },
  { id: "google-vertex", name: "Google Vertex AI", baseUrls: [] },
  { id: "gemini-native", name: "Gemini Native", baseUrls: ["https://generativelanguage.googleapis.com"] },
  { id: "deepseek", name: "DeepSeek", baseUrls: ["https://api.deepseek.com/anthropic"] },
  {
    id: "zhipu-glm",
    name: "Zhipu GLM",
    baseUrls: ["https://open.bigmodel.cn/api/anthropic", "https://api.z.ai/api/anthropic"],
  },
  { id: "qianfan", name: "Baidu Qianfan", baseUrls: ["https://qianfan.baidubce.com/anthropic/coding"] },
  {
    id: "bailian",
    name: "Bailian",
    baseUrls: ["https://dashscope.aliyuncs.com/apps/anthropic", "https://coding.dashscope.aliyuncs.com/apps/anthropic"],
  },
  { id: "kimi", name: "Kimi", baseUrls: ["https://api.moonshot.cn/anthropic", "https://api.kimi.com/coding"] },
  {
    id: "stepfun",
    name: "StepFun",
    baseUrls: ["https://api.stepfun.com/step_plan", "https://api.stepfun.ai/step_plan"],
  },
  { id: "modelscope", name: "ModelScope", baseUrls: ["https://api-inference.modelscope.cn"] },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrls: ["https://api.minimaxi.com/anthropic", "https://api.minimax.io/anthropic"],
  },
  { id: "volcengine", name: "Volcengine Ark", baseUrls: ["https://ark.cn-beijing.volces.com/api/coding"] },
  { id: "aihubmix", name: "AiHubMix", baseUrls: ["https://aihubmix.com", "https://api.aihubmix.com"] },
  { id: "siliconflow", name: "SiliconFlow", baseUrls: ["https://api.siliconflow.cn", "https://api.siliconflow.com"] },
  { id: "openrouter", name: "OpenRouter", baseUrls: ["https://openrouter.ai/api"] },
  { id: "therouter", name: "TheRouter", baseUrls: ["https://api.therouter.ai"] },
  { id: "novita", name: "Novita AI", baseUrls: ["https://api.novita.ai/anthropic"] },
  { id: "codex-oauth", name: "Codex", baseUrls: ["https://chatgpt.com/backend-api/codex"] },
  { id: "nvidia", name: "Nvidia", baseUrls: ["https://integrate.api.nvidia.com"] },
  { id: "pipellm", name: "PIPELLM", baseUrls: ["https://cc-api.pipellm.ai"] },
  { id: "xiaomi-mimo", name: "Xiaomi MiMo", baseUrls: ["https://api.xiaomimimo.com/anthropic"] },
  { id: "newapi", name: "NewAPI", baseUrls: [] },
  { id: "n1n", name: "n1n.ai", baseUrls: [] },
];

export function readClaudeCodeLocalRouteProfile(options: KernelLocalRouteReadOptions): KernelLocalRouteProfile {
  const cwd = options.cwd ?? process.cwd();
  const home = claudeConfigHome(options.configHome);
  const { settings, paths } = readMergedClaudeSettings(cwd, home);
  const settingsEnv = readStringMap((settings.env as Record<string, unknown> | undefined) ?? {});
  const env = {
    ...settingsEnv,
    ...readRelevantProcessEnv(),
  };
  const desktopBedrock = readClaudeDesktopBedrockConfig();
  if (desktopBedrock) {
    if (!env.CLAUDE_CODE_USE_BEDROCK) env.CLAUDE_CODE_USE_BEDROCK = "1";
    if (!env.AWS_REGION && desktopBedrock.region) env.AWS_REGION = desktopBedrock.region;
  }
  const settingsModel = stringValue(env.ANTHROPIC_MODEL) || stringValue(settings.model);
  const baseUrl = readClaudeBaseUrlFromEnv(env);
  const provider = detectClaudeProvider(env, baseUrl);
  const models = buildClaudeModelOptionsWithSdkCache(settings, env, home, desktopBedrock?.models);
  const defaultModel = resolveClaudeDefaultModel(settingsModel, models);
  const sourcePaths = paths.length ? paths : [resolve(home, "settings.json")];
  const authConfigured = hasClaudeAuth(provider.id, env, settings, {
    cliPath: options.binaryPath,
    configHome: home,
    credentialHelper: desktopBedrock?.credentialHelper,
    cwd,
  });
  const routeKind =
    provider.id === "anthropic" &&
    !baseUrl &&
    !stringValue(env.ANTHROPIC_AUTH_TOKEN) &&
    !stringValue(env.ANTHROPIC_API_KEY)
      ? ("login" as const)
      : ("provider" as const);

  return {
    kernel: "claude-code",
    source: paths.length ? sourcePaths.join(",") : "claude-code-defaults",
    sourcePaths,
    env,
    settingsModel,
    providerId: routeKind === "login" ? "claude-code-login" : provider.id,
    providerLabel: routeKind === "login" ? "Claude Agent" : provider.name,
    apiKeyEnv: claudeApiKeyEnv(provider.id, env),
    baseUrl,
    authConfigured,
    routeKind,
    models,
    defaultModel,
  };
}

function claudeConfigHome(configHomeOverride?: string): string {
  return configHomeOverride?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || resolve(homedir(), ".claude");
}

function readMergedClaudeSettings(
  cwd: string,
  claudeHome: string,
): { settings: Record<string, unknown>; paths: string[] } {
  const paths = claudeSettingsPaths(cwd, claudeHome).filter((path) => existsSync(path));
  const settings: Record<string, unknown> = {};
  for (const path of paths) {
    deepMerge(settings, readJsonObject(path));
  }
  return { settings, paths };
}

function claudeSettingsPaths(cwd: string, configHome: string): string[] {
  return [
    resolve(configHome, "settings.json"),
    resolve(cwd, ".claude", "settings.json"),
    resolve(cwd, ".claude", "settings.local.json"),
    ...managedClaudeSettingsPaths(),
  ];
}

function managedClaudeSettingsPaths(): string[] {
  const roots = ["/Library/Application Support/ClaudeCode", "/etc/claude-code"];
  const paths: string[] = [];
  for (const root of roots) {
    paths.push(join(root, "managed-settings.json"));
    const dropIn = join(root, "managed-settings.d");
    try {
      for (const file of readdirSync(dropIn)
        .filter((item) => item.endsWith(".json") && !item.startsWith("."))
        .sort()) {
        paths.push(join(dropIn, file));
      }
    } catch {
      // non-critical-fallback: An absent managed drop-in directory contributes no discovery paths.
    }
  }
  return paths;
}

function readRelevantProcessEnv(): Record<string, string> {
  const keys = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_REGION",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_PROFILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUD_ML_REGION",
  ];
  const output: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) output[key] = value;
  }
  return output;
}

function readClaudeBaseUrlFromEnv(env: Record<string, string>): string | undefined {
  const explicit = stringValue(env.ANTHROPIC_BASE_URL);
  if (explicit) return explicit;
  if (isEnabled(env.CLAUDE_CODE_USE_BEDROCK) && env.AWS_REGION) {
    return `https://bedrock-runtime.${env.AWS_REGION}.amazonaws.com`;
  }
  return undefined;
}

function detectClaudeProvider(env: Record<string, string>, baseUrl: string | undefined): { id: string; name: string } {
  if (isEnabled(env.CLAUDE_CODE_USE_BEDROCK) || baseUrl?.includes("bedrock-runtime.")) {
    return {
      id: env.AWS_BEARER_TOKEN_BEDROCK ? "aws-bedrock-api-key" : "aws-bedrock",
      name: env.AWS_BEARER_TOKEN_BEDROCK ? "AWS Bedrock (API Key)" : "AWS Bedrock",
    };
  }
  if (isEnabled(env.CLAUDE_CODE_USE_VERTEX) || env.GOOGLE_CLOUD_PROJECT || env.CLOUD_ML_REGION) {
    return { id: "google-vertex", name: "Google Vertex AI" };
  }

  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized) {
    const preset = CLAUDE_PROVIDER_PRESETS.flatMap((preset) =>
      preset.baseUrls.map((url) => ({ preset, url: normalizeBaseUrl(url) })),
    )
      .filter((item) => item.url && normalized.startsWith(item.url))
      .sort((a, b) => b.url.length - a.url.length)[0]?.preset;
    if (preset) return { id: preset.id, name: preset.name };
    return { id: "anthropic-compatible", name: "Anthropic-compatible provider" };
  }

  return { id: "anthropic", name: "Claude Official" };
}

function claudeApiKeyEnv(providerId: string, env: Record<string, string>): string | undefined {
  if (providerId === "aws-bedrock" || providerId === "aws-bedrock-api-key" || providerId === "google-vertex") {
    return undefined;
  }
  if (env.ANTHROPIC_AUTH_TOKEN) return "ANTHROPIC_AUTH_TOKEN";
  if (env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  return undefined;
}

function buildClaudeModelOptions(
  settings: Record<string, unknown>,
  env: Record<string, string>,
): BridgeRuntimeControlOption[] {
  const models: BridgeRuntimeControlOption[] = [];
  const add = (id: string | undefined, label: string | undefined, description?: string) => {
    const normalized = id?.trim();
    if (!normalized || models.some((item) => item.id === normalized)) return;
    models.push({ id: normalized, label: label?.trim() || normalized, description });
  };

  const explicitModel = stringValue(env.ANTHROPIC_MODEL);
  if (explicitModel && !isClaudeFamilyAlias(explicitModel)) {
    add(explicitModel, modelDisplayName(explicitModel));
  }

  const allowedAliases = readAvailableModelAliases(settings);
  for (const family of CLAUDE_MODEL_FAMILIES) {
    if (allowedAliases && !allowedAliases.has(family.alias)) continue;
    const pinned = stringValue(env[family.envKey]);
    const name = stringValue(env[family.nameKey]);
    const description = stringValue(env[family.descriptionKey]);
    add(
      family.alias,
      pinned ? name || `${family.label} · ${pinned}` : family.label,
      [description, pinned ? `provider model: ${pinned}` : ""].filter(Boolean).join(" · ") || undefined,
    );
  }

  const customModel = stringValue(env.ANTHROPIC_CUSTOM_MODEL_OPTION);
  if (customModel) {
    add(
      customModel,
      stringValue(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME) || modelDisplayName(customModel),
      stringValue(env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION),
    );
  }

  const overrides =
    settings.modelOverrides && typeof settings.modelOverrides === "object" && !Array.isArray(settings.modelOverrides)
      ? (settings.modelOverrides as Record<string, unknown>)
      : {};
  for (const [model, mapped] of Object.entries(overrides)) {
    add(model, modelDisplayName(model), stringValue(mapped) ? `provider model: ${stringValue(mapped)}` : undefined);
  }

  return models;
}

function buildClaudeModelOptionsWithSdkCache(
  settings: Record<string, unknown>,
  env: Record<string, string>,
  configHome: string,
  desktopModels: Array<{ id: string; label?: string }> | undefined,
): BridgeRuntimeControlOption[] {
  if (desktopModels?.length) {
    const models: BridgeRuntimeControlOption[] = [];
    const add = (id: string | undefined, label: string | undefined, description?: string) => {
      const normalized = id?.trim();
      if (!normalized || models.some((item) => item.id === normalized)) return;
      models.push({ id: normalized, label: label?.trim() || modelDisplayName(normalized), description });
    };
    for (const pinned of [stringValue(env.ANTHROPIC_MODEL), stringValue(settings.model)]) {
      if (pinned && !isClaudeFamilyAlias(pinned)) {
        add(pinned, modelDisplayName(pinned));
      }
    }
    for (const model of desktopModels) {
      add(model.id, model.label?.replace(/^Claude\s+/i, ""));
    }
    return models;
  }

  const cached = readClaudeModelsCache(configHome);
  if (!cached.length) {
    return buildClaudeModelOptions(settings, env);
  }

  const models: BridgeRuntimeControlOption[] = [];
  const add = (id: string | undefined, label: string | undefined, description?: string) => {
    const normalized = id?.trim();
    if (!normalized || models.some((item) => item.id === normalized)) return;
    models.push({ id: normalized, label: label?.trim() || modelDisplayName(normalized), description });
  };

  for (const pinned of [stringValue(env.ANTHROPIC_MODEL), stringValue(settings.model)]) {
    if (pinned && !isClaudeFamilyAlias(pinned)) {
      add(pinned, modelDisplayName(pinned));
    }
  }

  for (const model of cached) {
    if (model.id === "default" || model.legacy) continue;
    add(model.id, model.label ?? modelDisplayName(model.id));
  }

  return models.length ? models : buildClaudeModelOptions(settings, env);
}

function resolveClaudeDefaultModel(
  requested: string | undefined,
  models: BridgeRuntimeControlOption[],
): string | undefined {
  const model = requested?.trim();
  if (!model) return models[0]?.id;
  const suffix = model.endsWith("[1m]") ? "[1m]" : "";
  const alias = suffix ? model.slice(0, -4) : model;
  if (isClaudeFamilyAlias(alias)) return `${alias}${suffix}`;
  return model;
}

function readAvailableModelAliases(settings: Record<string, unknown>): Set<string> | undefined {
  const value = settings.availableModels;
  if (!Array.isArray(value)) return undefined;
  const aliases = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item === "opus" || item === "sonnet" || item === "haiku");
  return aliases.length ? new Set(aliases) : undefined;
}

function hasClaudeAuth(
  providerId: string,
  env: Record<string, string>,
  settings: Record<string, unknown>,
  options: { cliPath?: string; configHome: string; credentialHelper?: string; cwd: string },
): boolean {
  const configured =
    providerId === "aws-bedrock" || providerId === "aws-bedrock-api-key"
      ? hasAwsCredential(env) || Boolean(options.credentialHelper && existsSync(options.credentialHelper))
      : providerId === "google-vertex"
        ? hasGoogleApplicationDefaultCredentials(env)
        : Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || settings.apiKeyHelper);
  if (configured) return true;
  if (providerId === "aws-bedrock" || providerId === "aws-bedrock-api-key" || providerId === "google-vertex") {
    return false;
  }
  return readClaudeCliAuthStatus(options);
}

function hasGoogleApplicationDefaultCredentials(env: Record<string, string>): boolean {
  if (!env.GOOGLE_CLOUD_PROJECT?.trim()) return false;
  const explicitPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (explicitPath) return existsSync(explicitPath);
  const defaultPath =
    process.platform === "win32"
      ? resolve(
          process.env.APPDATA?.trim() || resolve(homedir(), "AppData", "Roaming"),
          "gcloud",
          "application_default_credentials.json",
        )
      : resolve(homedir(), ".config", "gcloud", "application_default_credentials.json");
  return existsSync(defaultPath);
}

function readClaudeCliAuthStatus(options: { cliPath?: string; configHome: string; cwd: string }): boolean {
  const cliPath = options.cliPath?.trim() || resolveClaudeCodeCliPath(options.cwd);
  if (!cliPath) return false;
  const cacheKey = `${cliPath}\0${options.configHome}`;
  const now = Date.now();
  const cached = claudeAuthStatusCache.get(cacheKey);
  if (cached && now - cached.checkedAt < CLAUDE_AUTH_STATUS_CACHE_TTL_MS) {
    return cached.authenticated;
  }
  let authenticated = false;
  try {
    const authArgs = ["auth", "status", "--json"];
    const invocation = isNodeScript(cliPath)
      ? { command: process.execPath, args: [cliPath, ...authArgs] }
      : resolveCommandInvocation(cliPath, authArgs);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: options.configHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2_000,
      windowsHide: true,
    });
    const parsed = JSON.parse(String(result.stdout || "")) as Record<string, unknown>;
    authenticated = parsed.loggedIn === true;
  } catch {
    // Authentication probes are read-only; a failed probe is an explicit unauthenticated result.
    authenticated = false;
  }
  claudeAuthStatusCache.set(cacheKey, { checkedAt: now, authenticated });
  return authenticated;
}

// forwarding-boundary: names the executable-format predicate used by CLI launch policy.
function isNodeScript(path: string): boolean {
  return /\.(?:cjs|mjs|js)$/i.test(path);
}

function isClaudeFamilyAlias(value: string): boolean {
  const normalized = value.trim().replace(/\[1m\]$/, "");
  return normalized === "opus" || normalized === "sonnet" || normalized === "haiku";
}
