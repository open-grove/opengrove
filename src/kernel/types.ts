import type {
  AgentCompactRequest,
  AgentCompactResult,
  AgentEvent,
  AgentSessionDeleteResult,
  AgentSessionForkResult,
  AgentSessionListResult,
  AgentSteerRequest,
  AgentSteerResult,
  AgentTurnRequest,
  JsonObject,
  SandboxPolicy,
  ToolDefinition,
} from "../core.js";
import type { KernelCapabilityReport } from "./capabilities/types.js";

export type KernelHealthStatus = "ok" | "degraded" | "unavailable";

export interface KernelHealth {
  status: KernelHealthStatus;
  message?: string;
  metadata?: JsonObject;
}

export type KernelExecutableProbeStatus = "available" | "timeout" | "missing" | "failed";
export type KernelExecutableRole = "runtime-required" | "optional-diagnostic";
export type KernelExecutableProbeSource = "configured" | "environment" | "path" | "bundled" | "discovered";

/** Executable discovery is separate from Kernel runtime availability; optional diagnostics never gate a Kernel. */
export interface KernelExecutableProbe {
  role: KernelExecutableRole;
  status: KernelExecutableProbeStatus;
  path?: string;
  requestedCommand?: string;
  source?: KernelExecutableProbeSource;
  sourceName?: string;
  version?: string;
  exitCode?: number;
  errorCode?: string;
}

export interface KernelCapabilities {
  /** Transcript owner. Kernel-owned history must never be replayed from Host run records. */
  sessionHistory: "kernel" | "host";
  /** Readable reasoning surfaces exposed by this concrete adapter. */
  reasoning: KernelReasoningCapabilities;
  /** Whether the adapter exposes incremental assistant answer text before the turn completes. */
  streaming: boolean;
  /** Whether the adapter exposes structured tool lifecycle events from either native or Host tools. */
  toolCalls: boolean;
  hostTools: boolean;
  approvals: boolean;
  elicitation: boolean;
  /** Whether Kernel-produced outputs are normalized onto OpenGrove's artifact surface. */
  artifacts: boolean;
  compaction: boolean;
  /** Whether the adapter exposes a Host-observable authentication refresh path. */
  authRefresh: boolean;
  sandbox: SandboxPolicy[];
  knowledge?: KernelKnowledgeCapabilities;
  metadata?: JsonObject;
  /** kernel natively manages thread-level goal (app need not inject) */
  nativeThreadGoal: boolean;
  /** kernel ships its own skill catalog; app layer should include it in context */
  nativeSkillCatalog: boolean;
}

export type KernelReasoningSupport = "unsupported" | "conditional" | "supported";

export interface KernelReasoningCapabilities {
  /** Kernel-originated reasoning text, preserved without Host semantic rewriting. */
  nativeText: KernelReasoningSupport;
  /** A Kernel/provider-authored reasoning summary explicitly identified as a summary. */
  summary: KernelReasoningSupport;
}

export interface KernelKnowledgeCapabilities {
  nativeSkills?: boolean;
  toolMediatedSkills?: boolean;
  progressiveDisclosure?: boolean;
  nativeArtifacts?: boolean;
  deliveryLedger?: boolean;
}

export type KernelHarnessOwner = "app" | "kernel" | "adapter" | "shared" | "unsupported";

export type KernelHarnessFeature =
  | "session"
  | "turn_lifecycle"
  | "model_loop"
  | "native_tool_execution"
  | "host_tool_execution"
  | "approval"
  | "user_question"
  | "skill_discovery"
  | "skill_loading"
  | "context_assembly"
  | "knowledge_retrieval"
  | "artifact_extraction"
  | "memory_write"
  | "compaction"
  | "auth"
  | "sandbox"
  | "transport"
  | "trajectory"
  | "diagnostics";

export interface KernelHarnessOwnershipRule {
  feature: KernelHarnessFeature;
  owner: KernelHarnessOwner;
  nativeName?: string;
  appResponsibility?: string;
  kernelResponsibility?: string;
  adapterResponsibility?: string;
  notes?: string;
}

export type KernelEventMappingDirection = "app_to_native" | "native_to_app" | "bidirectional";

export interface KernelEventMapping {
  appEvent: string;
  nativeEvent?: string;
  nativeRequest?: string;
  direction: KernelEventMappingDirection;
  adapterResponsibility: string;
  notes?: string;
}

export type KernelDiagnosticsCaptureLayer =
  | "adapter-rpc"
  | "process-stdio"
  | "native-transcript"
  | "provider-http"
  | "host-event-log"
  | "trajectory";

export type KernelDiagnosticsCaptureStatus = "implemented" | "planned" | "external";

export interface KernelDiagnosticsCaptureMode {
  id: string;
  title: string;
  layer: KernelDiagnosticsCaptureLayer;
  status: KernelDiagnosticsCaptureStatus;
  enabledByDefault?: boolean;
  output?: string;
  env?: string[];
  redaction?: "redacted" | "external" | "raw";
  notes?: string[];
}

export interface KernelDiagnosticsContract {
  defaultModeId?: string;
  modes: KernelDiagnosticsCaptureMode[];
  nativeTranscript?: {
    path?: string;
    availability: "available" | "partial" | "unavailable" | "unknown";
    notes?: string[];
  };
  notes?: string[];
}

export interface KernelPathContract {
  /** env var that overrides config home, e.g. "CODEX_HOME". null = no env override. */
  configHomeEnvVar: string | null;
  /** default config home relative to $HOME, e.g. ".codex" */
  defaultConfigHome: string;
  /** CLI binary command name, e.g. "claude" for claude-code */
  cliCommand: string;
  /** native skill directory relative to project root, e.g. ".codex/skills". null = no native skills on disk. */
  projectSkillDir: string | null;
  /** substring in a path that identifies it as a native skill entry, e.g. "/.codex/skills/". null = N/A. */
  nativeSkillMarker: string | null;
  /** ordered rules mapping path substrings to knowledge bucket IDs */
  knowledgeBuckets: KernelKnowledgeBucketRule[];
  /** fallback bucket when no rule matches */
  defaultKnowledgeBucket: string;
}

export interface KernelKnowledgeBucketRule {
  pathContains: string;
  bucket: string;
}

export interface KernelDisplayContract {
  /** default model ID when no configured model, e.g. "codex-default" */
  defaultModelId: string;
  /** display name strings that should normalize to defaultModelId */
  modelDisplayAliases: string[];
  /** suffix pattern (endsWith match) that also normalizes to defaultModelId */
  modelDisplaySuffixAlias: string | null;
}

export interface KernelInputFormatContract {
  /** plan mode input template. "{input}" is placeholder. */
  planMode: { withInput: string; withoutInput: string };
  /** Kernel-native skill invocation syntax. Both templates may use {name}; withArgs may also use {args}. */
  skillInvocation: {
    withArgs: string;
    withoutArgs: string;
    /** Where an exact native invocation must appear in the assembled prompt. */
    promptPlacement?: "user-request" | "prompt-prefix";
  };
  /** model alias strategy when kernel is bound to external provider */
  modelAliasStrategy: "family-alias" | "provider-qualified" | "none";
  /** whether native model IDs need alias normalization before passing to runtime */
  nativeModelNormalization: boolean;
}

export interface KernelAdapterContract {
  ownership: KernelHarnessOwnershipRule[];
  eventMappings?: KernelEventMapping[];
  diagnostics?: KernelDiagnosticsContract;
  notes?: string[];
  paths: KernelPathContract;
  display: KernelDisplayContract;
  inputFormats: KernelInputFormatContract;
  labels: KernelLabelsContract;
}

export interface KernelLabelsContract {
  /** 显示名，如 "Claude Agent" */
  title: string;
  /** 接入方式描述，如 "SDK 接入" */
  integrationMode: string;
  /** 需要保留的 Kernel 专用诊断；未提供时使用 Host 本地化的通用文案 */
  unavailableReason?: string;
}

export type KernelKnowledgeSourceKind =
  | "skills"
  | "commands"
  | "agents"
  | "memory"
  | "project_instructions"
  | "settings"
  | "config"
  | "auth"
  | "sessions"
  | "logs"
  | "plugins"
  | "mcp"
  | "toolsets"
  | "artifacts"
  | "references"
  | "vault"
  | "other";

export type KernelKnowledgeSourceScope = "app" | "user" | "project" | "workspace" | "system" | "managed" | "external";

export type KernelKnowledgeSourceSyncMode = "none" | "index" | "mirror" | "publish";

export interface KernelKnowledgeSource {
  id: string;
  title: string;
  kind: KernelKnowledgeSourceKind;
  scope: KernelKnowledgeSourceScope;
  path?: string;
  exists?: boolean;
  readable?: boolean;
  writable?: boolean;
  native?: boolean;
  userVisible?: boolean;
  knowledgeLike?: boolean;
  enabledByDefault?: boolean;
  enabled?: boolean;
  syncMode?: KernelKnowledgeSourceSyncMode;
  description?: string;
  notes?: string[];
  metadata?: JsonObject;
}

export interface KernelInstallAction {
  id: string;
  title: string;
  status?: "available" | "planned" | "manual";
  command?: string[];
  cwd?: string;
  description?: string;
  requiresConfirmation?: boolean;
}

export interface KernelDiscovery {
  kernelId: string;
  title: string;
  installed: boolean;
  available: boolean;
  active?: boolean;
  binaryPath?: string;
  version?: string;
  executableProbe?: KernelExecutableProbe;
  configHome?: string;
  health?: KernelHealth;
  knowledgeSources: KernelKnowledgeSource[];
  capabilityReport?: KernelCapabilityReport;
  installActions?: KernelInstallAction[];
  diagnostics?: KernelDiagnosticsContract;
  notes?: string[];
}

export interface AuthProfile {
  id: string;
  kernelId: string;
  title?: string;
  kind: "oauth" | "api-key" | "native-login" | "custom";
  data?: JsonObject;
  updatedAt?: string;
}

export interface KernelSessionStart {
  sessionId: string;
  cwd?: string;
  modelId?: string;
  sandbox?: SandboxPolicy;
  authProfile?: AuthProfile;
  tools?: ToolDefinition[];
  metadata?: JsonObject;
}

export interface KernelSessionHandle {
  kernelId: string;
  sessionId: string;
  nativeSessionId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
}

export interface KernelTurnRequest extends AgentTurnRequest {
  kernelSession?: KernelSessionHandle;
  authProfile?: AuthProfile;
  metadata?: JsonObject;
}

export interface CompactOptions {
  reason?: string;
  maxTokens?: number;
  metadata?: JsonObject;
}

export interface AuthRefreshResult {
  ok: boolean;
  profile?: AuthProfile;
  message?: string;
}

export type KernelEvent = AgentEvent;

// ===== Provider integration types =====

/** Unified options for creating any kernel adapter. Server passes these; adapter does the rest. */
export interface KernelCreateOptions {
  cwd: string;
  configHome: string;
  /** Exact command resolved from settings/discovery. In-process kernels omit it. */
  command?: string;
  env: NodeJS.ProcessEnv;
  provider?: ProviderProfile;
  model?: string;
  runtimeBindingFingerprint?: string;
  /** Path for adapter-specific state files (e.g., Codex thread state) */
  dataPath?: string;
}

export type ProviderProtocol = "openai-compatible" | "anthropic-compatible" | "gemini-compatible";

export type ProviderCredentialKind =
  | "none"
  | "native-login"
  | "api-key"
  | "env-key"
  | "aws"
  | "google-adc"
  | "kernel-native"
  | "gateway-managed";

/** 一个 provider 的完整描述。不管从哪来（内置/用户配置/kernel 自动发现）。 */
export interface ProviderProfile {
  /** provider ID, e.g. "anthropic", "aws-bedrock", "deepseek" */
  id: string;
  /** Human-readable provider name used in generated configs and diagnostics. */
  name?: string;
  /** API endpoint URL */
  baseUrl?: string;
  /** All declared protocol endpoints; adapters may need more than the selected route. */
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  geminiBaseUrl?: string;
  /** 内联存储的 key */
  apiKey?: string;
  /** 或者 env var 名（adapter 自己 resolve） */
  apiKeyEnv?: string;
  /** 当前选中的 model ID */
  model?: string;
  /** Protocol determined by binding plan. Adapter should use this, not guess from URL. */
  protocol?: ProviderProtocol;
  /** Authoritative credential classification from the binding plan. */
  credentialKind?: ProviderCredentialKind;
  /** OpenAI-compatible upstream wire protocol; adapters may translate when their native protocol differs. */
  wireApi?: "chat" | "responses";
  /** Available models with metadata (for adapters that encode model lists into config) */
  models?: ModelOption[];
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  apiModelId?: string;
  canonicalModelId?: string;
  family?: string;
  status?: "alpha" | "beta" | "deprecated";
}

export interface RuntimeControls {
  kernel: string;
  source: string;
  models: ModelOption[];
  defaultModel?: string;
  reasoningEfforts: ModelOption[];
  defaultReasoningEffort?: string;
  speedTiers: ModelOption[];
  defaultSpeedTier?: string;
}

// ===== KernelAdapter interface =====

export interface KernelAdapter {
  id: string;
  title: string;
  capabilities: KernelCapabilities;
  contract: KernelAdapterContract;
  /** Generated contracts are fallbacks; an adapter-supplied contract is authoritative. */
  contractOrigin?: "adapter" | "generated";

  // ===== 会话生命周期 =====
  healthCheck(): Promise<KernelHealth>;
  discover?(): Promise<KernelDiscovery>;
  startSession(input: KernelSessionStart): Promise<KernelSessionHandle>;
  resumeSession(sessionId: string): Promise<KernelSessionHandle>;
  runTurn(request: KernelTurnRequest): AsyncIterable<KernelEvent>;
  steerTurn?(request: AgentSteerRequest): Promise<AgentSteerResult>;
  interrupt?(sessionId: string): Promise<void>;
  compactSession?(request: AgentCompactRequest): Promise<AgentCompactResult>;
  /** @deprecated Implement compactSession to preserve the kernel's native result semantics. */
  compact?(sessionId: string, options?: CompactOptions): Promise<void>;
  listSessions?(): Promise<AgentSessionListResult>;
  deleteSession?(sessionId: string): Promise<AgentSessionDeleteResult>;
  forkSession?(sourceSessionId: string, targetSessionId: string): Promise<AgentSessionForkResult>;
  refreshAuth?(profile: AuthProfile): Promise<AuthRefreshResult>;
  dispose?(): Promise<void>;
}
