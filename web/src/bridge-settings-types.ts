import type {
  KernelPreference,
  ReasoningEffort,
  RuntimeAccessMode,
  RuntimeControlOption,
  RuntimeControls,
} from "./bridge-models";
import type {
  AgentEventRecord,
  ApprovalRecord,
  ArtifactRecord,
  ComputerStateRecord,
  ExecutionRecord,
  QuestionRecord,
  RunRecord,
  SessionRecord,
  WorkingStateRecord,
} from "./bridge-inventory-types";
import type { LanguagePreference, ResolvedLanguage } from "./i18n-types";

export interface ApprovalsResponse {
  ok: boolean;
  approvals: ApprovalRecord[];
}

export interface QuestionsResponse {
  ok: boolean;
  questions: QuestionRecord[];
}

export interface EventsResponse {
  ok: boolean;
  events: AgentEventRecord[];
  cursor: string;
  oldestCursor: string;
  hasMore: boolean;
  hasOlder: boolean;
  historyTruncated: boolean;
  resetRequired: boolean;
  snapshot: boolean;
  /** Present on Bridge versions that understand waitMs. */
  longPollSupported?: boolean;
}

export interface ContextRecordsResponse {
  ok: boolean;
  records?: Record<string, unknown>[];
  revision?: string;
  unchanged?: boolean;
}

export interface KernelOption {
  id: KernelPreference;
  label: string;
  description?: string;
  integrationKind?: "sdk" | "cli" | "acp" | "gateway" | "structured-cli";
  hostTools?: boolean;
  available: boolean;
  active?: boolean;
  reason?: string;
  unavailableCode?: string;
  installed?: boolean;
  binaryPath?: string;
  version?: string;
  executableProbe?: KernelExecutableProbe;
  configHome?: string;
  bindingKind?: "provider" | "login" | "unresolved";
  bindingStatus?:
    | "ready"
    | "selection-required"
    | "missing-key"
    | "missing-provider"
    | "unsupported"
    | "disabled"
    | "unknown";
  providerAvailable?: boolean;
  providerId?: string;
  providerLabel?: string;
  capabilityReport?: KernelCapabilityReport;
  installActions?: KernelInstallAction[];
  diagnostics?: Record<string, unknown>;
}

export interface KernelExecutableProbe {
  role: "runtime-required" | "optional-diagnostic";
  status: "available" | "timeout" | "missing" | "failed";
  path?: string;
  requestedCommand?: string;
  source?: "configured" | "environment" | "path" | "bundled" | "discovered";
  sourceName?: string;
  version?: string;
  exitCode?: number;
  errorCode?: string;
}

export interface KernelCapabilityReport {
  schemaVersion: number;
  generatedAt: string;
  kernel: string;
  capabilities: KernelCapabilityReportEntry[];
}

export interface KernelCapabilityReportEntry {
  kernel: string;
  capability: string;
  native: "yes" | "no" | "unknown";
  exposed: "yes" | "no" | "partial" | "unknown";
  productBehavior: "enable" | "fallback" | "hide";
  nativeEvidence?: Record<string, unknown>;
  contractMapping?: Record<string, unknown>;
  contractTests: Record<string, unknown>[];
  auditStatus?: string;
  auditStatuses?: string[];
  notes: string[];
}

export interface KernelInstallAction {
  id: string;
  title: string;
  status?: string;
  command?: string[];
  cwd?: string;
  description?: string;
  requiresConfirmation?: boolean;
}

export interface KernelProxySettings {
  enabled: boolean;
  injected?: boolean;
  proxyUrl: string;
  noProxy: string;
  nodeUseEnvProxy: boolean;
  environmentProxyUrl?: string;
  source?: string;
}

export type VoiceSttProviderId = "openai" | "groq" | "local-whisper" | "browser";

export interface VoiceSettings {
  stt: VoiceSttSettings;
  sttProviders?: VoiceSttProviderInfo[];
}

export interface VoiceSttSettings {
  provider: VoiceSttProviderId;
  language: string;
  openai: VoiceCloudSttProviderSettings;
  groq: VoiceCloudSttProviderSettings;
  localWhisper: VoiceLocalWhisperSettings;
  browser: VoiceBrowserSttSettings;
}

export interface VoiceCloudSttProviderSettings {
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv: string;
}

export interface VoiceLocalWhisperSettings {
  model: string;
  command?: string;
  language: string;
}

export interface VoiceBrowserSttSettings {
  language: string;
}

export interface VoiceSttProviderInfo {
  id: VoiceSttProviderId;
  label: string;
  mode: "browser" | "recorded-upload" | "local-command";
  configured: boolean;
  defaultModel?: string;
  notes?: string[];
}

export interface VoiceTranscriptionResponse {
  ok: boolean;
  transcript?: string;
  language?: string;
  durationMs?: number;
  provider?: VoiceSttProviderId;
  model?: string;
  error?: string;
}

export interface BridgeSettings {
  developerMode?: boolean;
  directKernelChatEnabled?: boolean;
  languagePreference?: LanguagePreference;
  systemLanguage?: ResolvedLanguage;
  kernel: KernelPreference;
  workspaceRoot?: string;
  workspaceRootConfigured?: boolean;
  providerSetupVersion?: number;
  activeKernel: string;
  activeModel: string;
  kernelUnavailableCode?: string;
  kernelUnavailableReason?: string;
  kernels: KernelOption[];
  providers?: ProviderProfile[];
  customProviders?: ProviderProfile[];
  mountedApps?: MountedAppSettings[];
  modelProviderBindings?: ModelProviderBinding[];
  kernelPathOverrides?: Record<string, KernelPathOverride>;
  kernelProxy: KernelProxySettings;
  appStore?: AppStoreSettings;
  appUpdates?: AppUpdateSettings;
  voice?: VoiceSettings;
  settingsPath?: string;
}

export interface MountedAppSettings {
  id: string;
  path: string;
  workspacePath?: string;
  enabled: boolean;
  title?: string;
  appBuilderEnabled?: boolean;
  policyIssue?: string;
}

export interface AppStoreSettings {
  registryUrl: string;
  registryToken?: string;
  releaseControlUrl?: string;
}

export interface AppUpdateSettings {
  automatic: boolean;
  lastSuccessfulCheckAt?: string;
}

export interface AppStorePackageRecord {
  id: string;
  packageId?: string;
  title: string;
  summary: string;
  version: string;
  minHostReleaseNumber?: number;
  category: string;
  icon?: string;
  publishKind?: "app" | "employee";
  installMode: "workspace" | "contacts";
  packageUrl?: string;
  appId: string;
  workspaceName: string;
  requirements: string[];
  capabilities: string[];
  agents?: Array<{
    id: string;
    name: string;
    avatarMode?: "generated" | "initials" | "upload";
    avatarSeed?: string;
    avatarDataUrl?: string;
    role?: string;
    kernel?: string;
    model?: string;
    skills?: string[];
    toolIds?: string[];
    tools?: Array<{
      id: string;
      title?: string;
      description?: string;
      source?: string;
    }>;
    visibility?: "private" | "public";
    publicDescription?: string;
    publicSkills?: string[];
    inputSpec?: string;
    outputSpec?: string;
  }>;
  employee?: {
    id: string;
    name: string;
    avatarMode?: "generated" | "initials" | "upload";
    avatarSeed?: string;
    avatarDataUrl?: string;
    role?: string;
    kernel?: string;
    model?: string;
    skills?: string[];
    toolIds?: string[];
    tools?: Array<{
      id: string;
      title?: string;
      description?: string;
      source?: string;
    }>;
    visibility?: "private" | "public";
    publicDescription?: string;
    publicSkills?: string[];
    inputSpec?: string;
    outputSpec?: string;
  };
  dependencies?: {
    kernels?: string[];
    providers?: string[];
    runtimes?: string[];
    skills?: Array<{
      id: string;
      name?: string;
      title?: string;
      description?: string;
      source?: string;
      bundled?: boolean;
      path?: string;
      toolIds?: string[];
      allowedTools?: string[];
    }>;
    tools?: Array<{
      id: string;
      title?: string;
      description?: string;
      source?: string;
    }>;
    cli?: unknown[];
    mcp?: unknown[];
  };
  doctor?: {
    ok: boolean;
    items: Array<{
      id: string;
      kind: "kernel" | "skill" | "tool" | "provider" | "runtime" | "cli" | "mcp";
      label: string;
      status: "ok" | "missing" | "installable" | "warning";
      detail?: string;
    }>;
    missing: string[];
    warnings: string[];
  };
  backupScopes: string[];
  status: "available" | "preview";
  visibility?: "public" | "restricted";
  publisher: string;
  usageCount: number;
  source: "registry";
  packageKey?: string;
  packageRef?: string;
  uploadedAt?: string;
  archiveName?: string;
  archiveSize?: number;
  archiveSha256?: string;
  releaseCommitSha?: string;
  installState?:
    | "not_installed"
    | "installed_current"
    | "update_available"
    | "needs_relink"
    | "source_conflict"
    | "legacy_unknown";
  installed?: boolean;
  installedAppId?: string;
  updateAvailable?: boolean;
  openable?: boolean;
  openableAppId?: string;
  repairable?: boolean;
  updateSafe?: boolean;
  hostUpdateRequired?: boolean;
  openIssue?:
    | "app_root_missing"
    | "manifest_missing"
    | "manifest_invalid"
    | "app_id_mismatch"
    | "ui_not_workbench"
    | "mount_conflict"
    | "store_relink_required"
    | "source_conflict"
    | "install_evidence_missing";
}

export interface AppStoreInstallPlan {
  packageId: string;
  packageKey?: string;
  packageRef?: string;
  appId: string;
  installMode?: "workspace" | "contacts";
  mountedApp?: MountedAppSettings;
  member?: Record<string, unknown>;
  workspaceProvider: "local";
  backupEnabled: boolean;
  status: "installed" | "already_installed";
  appRoot?: string;
  doctor?: AppStorePackageRecord["doctor"];
  openable?: boolean;
  openableAppId?: string;
  openIssue?: AppStorePackageRecord["openIssue"];
}

export interface AppStoreResponse {
  ok: boolean;
  profile?: "local" | "test";
  architecture: Record<string, unknown>;
  registryConfigured?: boolean;
  packages: AppStorePackageRecord[];
  registryCatalogError?: string;
  error?: string;
}

export interface AppStoreInstallResponse {
  ok: boolean;
  plan?: AppStoreInstallPlan;
  install?: AppStoreInstallPlan;
  settings?: BridgeSettings;
  message?: string;
  error?: string;
}

export interface AppStoreUninstallResponse {
  ok: boolean;
  uninstall?: {
    appId: string;
    removedMountIds: string[];
    trashedPath?: string;
    trashError?: string;
    localDraftDisposition?: "none" | "retained" | "deleted";
    localDraftDeleteError?: string;
  };
  settings?: BridgeSettings;
  error?: string;
}

export interface LocalAppDraftSummary {
  schemaVersion: 1;
  localAppId: string;
  appId: string;
  savedAt: string;
  archiveSha256: string;
  archiveSize: number;
  contentDigest: string;
  workingContentDigest: string;
  employees: AppReleaseEmployeeDefaults[];
  savePoint?: AppSavePoint;
  publishBase?: {
    packageKey?: string;
    version?: string;
    releaseCommitSha?: string;
    archiveSha256?: string;
  };
}

export interface AppSavePoint {
  commitSha: string;
  savedAt: string;
}

export interface LocalAppDraftResponse {
  ok: boolean;
  draft?: LocalAppDraftSummary;
  error?: string;
}

export type AppStoreFormalVersionAvailability = "available" | "host_incompatible" | "artifact_unavailable";

export interface AppStoreFormalVersion {
  packageKey: string;
  packageId: string;
  appId: string;
  title: string;
  version: string;
  publishedBy: string;
  publishedAt: string;
  releaseCommitSha: string | null;
  releaseNotes: string;
  artifactSource: "registry" | "github-release";
  archiveName: string;
  archiveSize: number;
  archiveSha256: string;
  minHostReleaseNumber?: number;
  availability: AppStoreFormalVersionAvailability;
  downloadReference: string | null;
}

export interface SelectedFormalAppVersion {
  packageKey: string;
  version: string;
  archiveSha256: string;
  releaseCommitSha?: string;
}

export interface MountedAppVersionStatus {
  activeContent: "formal" | "local-draft";
  selectedVersion?: SelectedFormalAppVersion;
  latestVersion?: AppStoreFormalVersion;
  versions: AppStoreFormalVersion[];
  localDraft?: LocalAppDraftSummary;
  workingDigest?: string;
  savedContentDigest?: string;
  hasUnsavedChanges: boolean;
  workingDigestError?: string;
  sourceSavePoint?: AppSavePoint;
  sourceChangedFileCount?: number;
}

export interface MountedAppVersionsResponse {
  ok: boolean;
  localAppId?: string;
  packageKey?: string;
  status?: MountedAppVersionStatus;
  registryError?: string;
  error?: string;
}

export interface MountedAppVersionSwitchResponse {
  ok: boolean;
  install?: AppStoreInstallPlan;
  status?: MountedAppVersionStatus;
  runs?: Array<{
    roomId: string;
    messageId: string;
    runId: string;
    memberId: string;
  }>;
  error?: string;
}

export interface AppStoreRepairResponse {
  ok: boolean;
  repair?: {
    packageId: string;
    appId: string;
    appRoot: string;
    status: "repaired";
    openable: boolean;
    openableAppId?: string;
    openIssue?: AppStorePackageRecord["openIssue"];
  };
  error?: string;
}

export interface AppStoreRelinkResponse {
  ok: boolean;
  relink?: {
    packageId: string;
    appId: string;
    mountedAppId: string;
    appRoot: string;
    status: "relinked" | "already_linked";
    openable: boolean;
    openableAppId?: string;
    openIssue?: AppStorePackageRecord["openIssue"];
  };
  error?: string;
}

export interface AppStoreUploadResponse {
  ok: boolean;
  package?: AppStorePackageRecord;
  error?: string;
}

export type AppStorePackageVisibility = "public" | "restricted";

export type AppReleaseCheckSeverity = "blocking" | "warning";
export type AppReleaseCheckStatus = "passed" | "blocked" | "warning";

export interface AppReleaseCheck {
  id: string;
  label: string;
  severity: AppReleaseCheckSeverity;
  status: AppReleaseCheckStatus;
  detail: string;
}

export interface AppReleaseEmployeeDefaults {
  memberId: string;
  name: string;
  avatarMode?: "generated" | "initials" | "upload";
  avatarSeed?: string;
  avatarDataUrl?: string;
  role: string;
  kernel: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  contextTokenBudget?: number;
  accessMode?: RuntimeAccessMode;
  color: string;
  availableSkillIds: string[];
  defaultSkillIds: string[];
  visibility: "private" | "public";
  publicDescription?: string;
  publicSkills: string[];
  inputSpec?: string;
  outputSpec?: string;
}

export interface MountedAppReleaseDraft {
  identity: {
    appId: string;
    packageId?: string;
    packageKey?: string;
    source: "mounted" | "registry";
    appRoot: string;
    workspaceRoot: string;
  };
  app: {
    title: string;
    description: string;
    icon?: string;
  };
  version: string;
  latestPublishedVersion?: string;
  releaseNotes: string;
  visibility: AppStorePackageVisibility;
  minHostReleaseNumber: number;
  employees: AppReleaseEmployeeDefaults[];
  checks: AppReleaseCheck[];
}

export interface MountedAppIdentity {
  id: string;
  title: string;
  description: string;
  icon?: string;
}

export interface MountedAppIdentityResponse {
  ok: boolean;
  app?: MountedAppIdentity;
  error?: string;
}

export interface AppStorePrepareReleaseResponse {
  ok: boolean;
  release?: MountedAppReleaseDraft;
  error?: string;
}

export type AppReleaseProgressPhase =
  | "draft_saved"
  | "intent_created"
  | "source_snapshot_uploaded"
  | "remote_blocked"
  | "remote_conflict"
  | "remote_pending"
  | "remote_closed"
  | "registry_ready"
  | "local_preserved"
  | "local_finalized";

export interface AppReleaseBuildFailure {
  stage: "trusted_build" | "artifact_pack" | "artifact_gate" | "workflow";
  code: string;
  retryable: boolean;
  workflowRunId: string;
}

export type AppReleaseAction = "retry_candidate" | "retry_build" | "abandon";

export interface AppReleaseProgress {
  localAppId: string;
  appId: string;
  packageKey: string;
  version: string;
  title: string;
  visibility: AppStorePackageVisibility;
  phase: AppReleaseProgressPhase;
  remoteIntentId?: string;
  remoteStatus?: string;
  buildFailure?: AppReleaseBuildFailure;
  allowedActions: AppReleaseAction[];
  blockedRelease?: {
    id: string;
    status: string;
    packageKey: string;
    version: string;
    sourceSha256: string;
    createdAt: string;
    allowedActions: AppReleaseAction[];
    requestId?: string;
    matchesCurrentSource: boolean;
    matchesCurrentRequest: boolean;
    buildFailure?: AppReleaseBuildFailure;
  };
  requestId?: string;
  applyToCurrentApp: boolean;
  state: "publishing" | "blocked" | "needs-retry" | "registry-ready" | "closed" | "published";
  retryable: boolean;
  updatedAt: string;
}

export interface MountedAppPublishResponse {
  ok: boolean;
  progress?: AppReleaseProgress;
  error?: string;
  wwCode?: number;
  requestId?: string;
  detail?: unknown;
}

export interface KernelPathOverride {
  binaryPath?: string;
  configHome?: string;
}

export const LOGIN_PROVIDER_BINDING_ID = "$login" as const;

export interface ProviderCredentialState {
  status: "configured" | "missing" | "unknown" | "not-required";
  configured: boolean;
  source: "inline" | "environment" | "ambient" | "kernel" | "gateway" | "login" | "none" | "unknown";
  writable: boolean;
}

export interface ProviderRuntimeState {
  active: boolean;
  usable: boolean;
  credential: ProviderCredentialState;
}

export interface ProviderProfile {
  id: string;
  name: string;
  protocol: string;
  custom?: boolean;
  deleted?: boolean;
  enabled?: boolean;
  origin?: string;
  sourceKernel?: string;
  source?: string;
  sourcePaths?: string[];
  authConfigured?: boolean;
  routeKind?: "login" | "provider";
  description?: string;
  descriptionCode?: "compatible" | "openai" | "anthropic" | "bedrock" | "vertex" | "gemini";
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  geminiBaseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  provisioningBlocked?: boolean;
  credentialKind?:
    | "none"
    | "native-login"
    | "api-key"
    | "env-key"
    | "aws"
    | "google-adc"
    | "kernel-native"
    | "gateway-managed";
  wireApi?: "chat" | "responses";
  modelsPinned?: boolean;
  models?: RuntimeControlOption[];
  modelCount?: number;
  modelCatalogRevision?: string;
  websiteUrl?: string;
  catalogProviderId?: string;
  docsUrl?: string;
  /** Read-only state joined by the Bridge. Never include it in settings PATCHes. */
  runtime?: ProviderRuntimeState;
}

export interface ModelProviderBinding {
  modelId: string;
  providerId: string;
}

export interface BridgeSettingsResponse {
  ok: boolean;
  restarted?: boolean;
  settings: BridgeSettings;
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  error?: string;
}

export interface ProviderModelCatalogResponse {
  ok: boolean;
  providers: Array<{
    id: string;
    models: RuntimeControlOption[];
  }>;
}

export type KernelLoginStatus = "authenticated" | "missing" | "unknown" | "unavailable";

export interface KernelLoginView {
  kernelId: KernelPreference;
  label: string;
  status: KernelLoginStatus;
  loginAvailable: boolean;
  logoutAvailable: boolean;
  message?: string;
  configuredCommand?: string;
  configuredCommandIssue?: "missing" | "failed";
}

export interface KernelLoginsResponse {
  ok: boolean;
  logins: KernelLoginView[];
}

export interface KernelLoginSession {
  id: string;
  kernelId: KernelPreference;
  action: "login" | "logout";
  status: "running" | "succeeded" | "failed";
  output: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface KernelLoginActionResponse {
  ok: boolean;
  session?: KernelLoginSession;
  error?: string;
}

export interface KernelLoginSessionResponse {
  ok: boolean;
  session?: KernelLoginSession;
  error?: string;
}

export interface KernelInstallResponse {
  ok: boolean;
  degraded?: boolean;
  warning?: "runtime_refresh_failed";
  runtimeRefreshError?: string;
  kernelId?: string;
  actionId?: string;
  command?: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  settings?: BridgeSettings;
  error?: string;
}

export type KernelAuthStatus = "authenticated" | "missing" | "checking" | "unconfirmed" | "unknown" | "error";

export interface KernelAuthState {
  kernelId: string;
  status: KernelAuthStatus;
  method: "env-token" | "stored-credential" | "terminal" | "none" | "unknown";
  loginAvailable: boolean;
  message?: string;
  startedAt?: string;
  deadlineAt?: string;
  lastCheckedAt?: string;
}

export interface KernelAuthResponse {
  ok: boolean;
  auth: KernelAuthState;
  error?: string;
}

export interface KernelAuthLoginResponse extends KernelAuthResponse {}

export interface WorkspaceDirectoryResponse {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
}

export interface HealthResponse {
  ok: boolean;
  name: string;
  time: string;
  capabilities?: BridgeCapabilities;
  tokenRequired: boolean;
  auth?: BridgeAuthStatus;
  appearance?: {
    systemTheme?: ResolvedTheme;
  };
  error?: string;
}

type ResolvedTheme = "light" | "dark";

export interface BridgeAuthUser {
  userId: string;
  email: string;
  countryCode?: string;
  displayName: string;
  avatarUrl?: string;
  profileUpdatedAt?: string;
  profileStatus?: "available" | "missing" | "unavailable";
  role: string;
  roles?: string[];
  createdAt?: string;
  lastLoginAt?: string;
}

export interface BridgeAuthStatus {
  mode: "bridge-token" | "session";
  authenticated?: boolean;
  user?: BridgeAuthUser;
}

export interface AuthSessionResponse {
  status: "authenticated" | "unauthenticated" | "temporarily_unavailable";
  authenticated?: boolean;
  verification?: "verified" | "cached" | "stale";
  user?: BridgeAuthUser;
  reason?: string;
  error?: string;
  incidentId?: string;
  traceId?: string;
}

export interface ClientUpdateResponse {
  ok: boolean;
  current: number | null;
  latest: {
    version: number;
    downloadUrl: string;
    updaterBaseUrl?: string;
    updaterFeedUrl?: string;
    releasedAt?: string;
    releaseNotes?: string;
  } | null;
}

export interface BridgeAuthResponse {
  user: BridgeAuthUser;
  /** True only when this login registered a brand-new account. */
  isNewUser?: boolean;
  providerProvisioning?: {
    status: "configured" | "already-configured" | "skipped" | "failed";
    providerId?: string;
    createdApiKey?: boolean;
    defaultedKernels?: string[];
    reason?: string;
    error?: string;
  };
  error?: string;
}

export interface BridgeCapabilities {
  profile: "local" | "test";
  auth: string;
  multiUser: boolean;
  storage: string;
  blobStorage: string;
  kernelRuntime: string;
  workspaceScoped: boolean;
  approvals: boolean;
  api?: Record<string, unknown>;
  desktop?: Record<string, unknown>;
  features?: Record<string, unknown>;
}

export interface CapabilitiesResponse {
  ok: boolean;
  capabilities: BridgeCapabilities;
}

export interface AskFinalPayload {
  answer?: string;
  approvals?: ApprovalRecord[];
  questions?: QuestionRecord[];
  artifacts?: ArtifactRecord[];
  workingState?: WorkingStateRecord;
  computerState?: ComputerStateRecord;
  sessions?: SessionRecord[];
  runs?: RunRecord[];
  executions?: ExecutionRecord[];
  contextRecords?: Record<string, unknown>[];
  events?: AgentEventRecord[];
}
