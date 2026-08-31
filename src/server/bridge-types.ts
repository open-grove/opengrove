import type { OpenGroveApp } from "../app/create-opengrove.js";
import type {
  AgentEvent,
  AgentSessionTrace,
  CapabilityManifest,
  ContextEnvelope,
  ExecutionRecord,
  JsonObject,
  ModelMessage,
  PackManifest,
  PolicyRule,
  ResponseSpeed,
  RunRecord,
  RuntimeAccessMode,
  SessionRecord,
  SkillManifest,
  ToolSpec,
  WorkingStateRecord,
  ArtifactRecord,
  ApprovalRequest,
  QuestionRequest,
  UserLanguagePreference,
} from "../core.js";
import type { AgentStateStore } from "../storage/json-state-store.js";
import type { DesktopBridgeStartupActivity } from "../desktop-bridge-startup-state.js";
import type { OpenGroveProfile } from "../profiles/profile.js";
import type { HostRuntimeEnvironment, HostRuntimePresetId } from "../profiles/runtime-environment.js";
import type { KernelAdapter, KernelCapabilities, ProviderCredentialKind } from "../kernel/types.js";
import type { BridgeModelId } from "../kernel/model-ids.js";
import type { BrowserPageSnapshot } from "../environment/browser-adapter.js";
import type { ComputerStateSnapshot } from "../environment/computer-adapter.js";
import type { HostLanguagePreference } from "./language-preference.js";

export {
  BRIDGE_MODEL_IDS,
  DEFAULT_BRIDGE_MODEL_ID,
  LEGACY_NATIVE_MODEL_ID,
} from "../kernel/model-ids.js";
export type {
  BridgeKnownModelId,
  BridgeModelId,
} from "../kernel/model-ids.js";

// BRIDGE_KERNEL_IDS 的权威定义在 rooms 层(channel-store.ts),server 层 re-export。
// 原因:可运行员工判定(isRunnableRoomAssistantTarget)依赖它,而该判定属 member 属性、
// app 层也要用(workflow.create 成员校验),放 rooms 层避免反向依赖。
export { BRIDGE_KERNEL_IDS } from "../rooms/channel-store.js";
import { BRIDGE_KERNEL_IDS } from "../rooms/channel-store.js";
export type BridgeKernelId = (typeof BRIDGE_KERNEL_IDS)[number];
export type BridgeKernelPreference = BridgeKernelId;

// Provider ids are normalized as slugs, so "$login" cannot collide with a
// real provider profile. Login is an explicit Kernel account route, not a Provider.
export const LOGIN_PROVIDER_BINDING_ID = "$login" as const;
// Compatibility input written by OpenGrove 0.6.1. New state must never emit it.
export const LEGACY_NATIVE_PROVIDER_BINDING_ID = "$native" as const;
// Internal route sentinel only. Unlike $login, this is never a valid user
// selection and must fail before a Kernel process is created.
export const UNCONFIGURED_PROVIDER_BINDING_ID = "$unconfigured" as const;

export type BridgeProviderProtocol =
  | "native-oauth"
  | "openai-compatible"
  | "anthropic-compatible"
  | "gemini-compatible"
  | "custom-gateway";

export type BridgeProviderCredentialKind = ProviderCredentialKind;

export interface BridgeProviderProfile {
  id: string;
  name: string;
  protocol: BridgeProviderProtocol;
  custom?: boolean;
  deleted?: boolean;
  enabled?: boolean;
  origin?: "builtin" | "discovered" | "user";
  sourceKernel?: BridgeKernelId;
  source?: string;
  sourcePaths?: string[];
  /** Runtime-only adapter observation. Never persist or expose it as user configuration. */
  authConfigured?: boolean;
  routeKind?: "login" | "provider";
  description?: string;
  descriptionCode?: "compatible" | "openai" | "anthropic" | "bedrock" | "vertex" | "gemini";
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  geminiBaseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  /** Temporarily quarantines a retained WW credential after owner verification failed. */
  provisioningBlocked?: boolean;
  credentialKind?: BridgeProviderCredentialKind;
  wireApi?: "chat" | "responses";
  /** True only when the user explicitly edits the model list. Derived/discovered lists must not set this. */
  modelsPinned?: boolean;
  models: BridgeRuntimeControlOption[];
  websiteUrl?: string;
  /** Public catalog identity. Provider-specific protocol/auth fields remain OpenGrove-owned overlays. */
  catalogProviderId?: string;
  docsUrl?: string;
}

export type BridgeProviderCredentialStatus = "configured" | "missing" | "unknown" | "not-required";

export interface BridgeProviderCredentialState {
  status: BridgeProviderCredentialStatus;
  configured: boolean;
  source: "inline" | "environment" | "ambient" | "kernel" | "gateway" | "login" | "none" | "unknown";
  writable: boolean;
}

export interface BridgeProviderRuntimeState {
  /** User-owned activation state. Credential discovery never changes it. */
  active: boolean;
  /** A Provider is usable only when it is active and its credential is ready. */
  usable: boolean;
  credential: BridgeProviderCredentialState;
}

/** Read-only Provider projection returned to renderers. It must never be persisted. */
export type BridgeProviderView = Omit<BridgeProviderProfile, "authConfigured"> & {
  runtime: BridgeProviderRuntimeState;
};

/** Bounded Provider projection used by /settings; full models are fetched separately. */
export type BridgeProviderSummary = Omit<BridgeProviderView, "models"> & {
  models: [];
  modelCount: number;
  modelCatalogRevision: string;
};

export interface BridgeProviderModelCatalogEntry {
  id: string;
  models: BridgeRuntimeControlOption[];
}

/** User-selected default Provider for one concrete model. */
export interface BridgeModelProviderBinding {
  modelId: string;
  providerId: string;
}

export interface BridgeRuntimeControlOption {
  id: string;
  label: string;
  description?: string;
  /** Canonical Provider for this model when aggregators expose the same model id. */
  defaultProviderId?: string;
  /** Exact model id sent to this Provider. Defaults to id for legacy/custom entries. */
  apiModelId?: string;
  /** Models.dev base model identity shared by equivalent Provider routes. */
  canonicalModelId?: string;
  family?: string;
  status?: "alpha" | "beta" | "deprecated";
}

export interface BridgeRuntimeControls {
  kernel: BridgeKernelId;
  source: string;
  models: BridgeRuntimeControlOption[];
  defaultModel?: string;
  reasoningEfforts: BridgeRuntimeControlOption[];
  defaultReasoningEffort?: string;
  speedTiers: BridgeRuntimeControlOption[];
  defaultSpeedTier?: string;
}

export const KNOWLEDGE_INVENTORY_LIMIT = 5_000;
export const KNOWLEDGE_FILE_SIZE_LIMIT = 2_000_000;
export const APP_FILE_TEXT_SIZE_LIMIT = 2_000_000;
export const GENERATED_ASSET_ROUTE = "/generated/";
export const VAULT_FILE_ROUTE = "/vault-file/";

export const MAX_CONTEXT_RECORDS = 8;
export const MAX_CONTEXT_RECORD_STRING = 2_000;
export const MAX_CONTEXT_RECORD_ARRAY_ITEMS = 12;
export const MAX_CONTEXT_RECORD_OBJECT_KEYS = 60;

export interface LocalBridgeServerOptions {
  host?: string;
  port?: number;
  statePath?: string;
  store?: AgentStateStore;
  profile?: OpenGroveProfile;
  runtimeEnvironment?: HostRuntimePresetId;
  bridgeToken?: string;
  allowedOrigins?: string[];
  privateHealthRequiresBridgeToken?: boolean;
  onListening?(info: LocalBridgeListeningInfo): void;
  onStartupActivity?(activity: DesktopBridgeStartupActivity): void;
}

export interface LocalBridgeListeningInfo {
  host: string;
  port: number;
  url: string;
  statePath: string;
}

export interface BridgeAskPayload {
  question: string;
  model: BridgeModelId;
  kernel?: BridgeKernelId;
  providerId?: string;
  effort?: string;
  responseSpeed?: ResponseSpeed;
  budgetLimitUsd?: number;
  accessMode?: RuntimeAccessMode;
  planMode?: boolean;
  goalMode?: boolean;
  threadId: string;
  appId?: string;
  snapshot: BrowserPageSnapshot;
  computerSnapshot: ComputerStateSnapshot;
  allowMemory: boolean;
  saveCandidateNote: boolean;
  requestedSkill?: {
    name: string;
    args?: string;
  };
}

export interface BridgeContextRecord {
  runId: string;
  startedAt?: string;
  finishedAt?: string;
  modelId?: string;
  session?: AgentSessionTrace;
  messages: ModelMessage[];
  userInput: string;
  systemPrompt: string;
  context?: ContextEnvelope;
  tools: ToolSpec[];
  skills: SkillManifest[];
  packs: PackManifest[];
  capabilities: CapabilityManifest[];
  responseText: string;
  toolEvents: AgentEvent[];
  events: AgentEvent[];
}

export const BRIDGE_STT_PROVIDER_IDS = ["openai", "groq", "local-whisper", "browser"] as const;

export type BridgeSttProviderId = (typeof BRIDGE_STT_PROVIDER_IDS)[number];

export interface BridgeVoiceSettings {
  stt: BridgeSttSettings;
}

export interface BridgeSttSettings {
  provider: BridgeSttProviderId;
  language: string;
  openai: BridgeCloudSttProviderSettings;
  groq: BridgeCloudSttProviderSettings;
  localWhisper: BridgeLocalWhisperSettings;
  browser: BridgeBrowserSttSettings;
}

export interface BridgeCloudSttProviderSettings {
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv: string;
}

export interface BridgeLocalWhisperSettings {
  model: string;
  command?: string;
  language: string;
}

export interface BridgeBrowserSttSettings {
  language: string;
}

export interface BridgeSttProviderInfo {
  id: BridgeSttProviderId;
  label: string;
  mode: "browser" | "recorded-upload" | "local-command";
  configured: boolean;
  defaultModel?: string;
  notes?: string[];
}

export interface BridgeSettings {
  settingsSchemaVersion: 1;
  developerMode: boolean;
  directKernelChatEnabled?: boolean;
  languagePreference?: HostLanguagePreference;
  systemLanguage?: UserLanguagePreference;
  kernel: BridgeKernelPreference;
  workspaceRoot?: string;
  providerSetupVersion?: number;
  /** One-time compatibility boundary for Provider routes inferred by OpenGrove <=0.6.1. */
  providerRouteMigrationVersion: number;
  /** One-time compatibility boundary for blank/native Employee models persisted by OpenGrove <=0.6.4. */
  employeeModelMigrationVersion: number;
  mountedApps: BridgeMountedAppSettings[];
  uninstalledStoreAppIds: string[];
  defaultAppSync: BridgeDefaultAppSyncSettings;
  appUpdates: BridgeAppUpdateSettings;
  kernelProxy: BridgeKernelProxySettings;
  appStore?: BridgeAppStoreSettings;
  voice: BridgeVoiceSettings;
  kernelPathOverrides: Record<string, BridgeKernelPathOverride>;
  /** Default Provider for a concrete model, independent of the selected Kernel. */
  modelProviderBindings: BridgeModelProviderBinding[];
  customProviders: BridgeProviderProfile[];
  roomCollaboration: BridgeRoomCollaborationSettings;
}

export interface BridgeDefaultAppSyncSettings {
  /** Package keys whose first installation was performed by the default-App policy. */
  managedPackageKeys: string[];
  /** The Host release whose install-policy Apps last completed a Store update check. */
  lastSuccessfulClientReleaseNumber?: number;
}

export interface BridgeAppUpdateSettings {
  /** Automatically keep installed registry Apps on their latest compatible release. */
  automatic: boolean;
  /** Last time a complete registry update check succeeded. */
  lastSuccessfulCheckAt?: string;
}

export interface BridgeRoomCollaborationSettings {
  maxDelegationsPerRun: number;
  maxDelegationChainDepth: number;
}

export interface BridgeMountedAppSettings {
  id: string;
  /** Active App program generation. Store updates may switch this path. */
  path: string;
  /** Host-owned persistent Workspace binding. Omitted for legacy/manual mounts. */
  workspacePath?: string;
  enabled: boolean;
  title?: string;
  appBuilderEnabled?: boolean;
  /** Present when a retained mount is quarantined and shown only so the user can repair or remove it. */
  policyIssue?: string;
}

export interface BridgeAppStoreSettings {
  registryUrl: string;
  registryToken?: string;
  releaseControlUrl?: string;
}

export interface BridgeKernelPathOverride {
  binaryPath?: string;
  configHome?: string;
}

export interface BridgeKernelProxySettings {
  enabled: boolean;
  proxyUrl: string;
  noProxy: string;
  nodeUseEnvProxy: boolean;
}

/** Explicit Provider route owned by one in-memory execution boundary. */
export interface BridgeProviderOverride {
  providerId: string;
}

/** Runtime-only selection for a direct Ask or Room execution. */
export interface BridgeRuntimeOverride {
  kernel: BridgeKernelId;
  model: BridgeModelId;
  providerOverride?: BridgeProviderOverride;
}

export interface BridgeState {
  app: OpenGroveApp;
  /** Loopback URL used by host-local capabilities without traversing an external gateway. */
  internalBridgeBaseUrl?: string;
  /** True after the required App store graph has been constructed at least once. */
  appInitialized?: boolean;
  store: AgentStateStore;
  rootState?: BridgeState;
  /** Runtime-only direct Ask states, keyed by the complete runtime boundary. */
  directAskExecutionStates?: Map<string, BridgeState>;
  /** Runtime-only pool of Employee Kernel workers, keyed by complete native runtime boundary. */
  roomKernelAdapters?: Map<string, KernelAdapter>;
  /** Explicit per-execution route. It never mutates or masquerades as persisted settings. */
  runtimeOverride?: BridgeRuntimeOverride;
  /** Runtime-only handle used to dispose pooled Kernel workers on settings restart. */
  kernelAdapter?: KernelAdapter;
  /** Provider credential realm actually bound to kernelAdapter. */
  kernelProviderId?: string;
  /** Concrete runtime model actually bound to kernelAdapter. */
  kernelRuntimeModel?: string;
  profile: OpenGroveProfile;
  runtimeEnvironment: HostRuntimeEnvironment;
  snapshot: BrowserPageSnapshot;
  computerSnapshot: ComputerStateSnapshot;
  model: BridgeModelId;
  kernel: BridgeKernelId;
  kernelCapabilities?: KernelCapabilities;
  kernelUnavailableCode?: string;
  kernelUnavailableReason?: string;
  settings: BridgeSettings;
  saveCandidateNote: boolean;
  policyOverrides: PolicyRule[];
}

export interface BridgeAskResult {
  ok: true;
  answer: string;
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
  artifacts: ArtifactRecord[];
  workingState: WorkingStateRecord;
  sessions: SessionRecord[];
  runs: RunRecord[];
  executions: ExecutionRecord[];
}

export interface BridgeKernelResolution {
  kernel: BridgeKernelId;
  adapter: KernelAdapter;
}

export type BridgeJsonObject = JsonObject;
