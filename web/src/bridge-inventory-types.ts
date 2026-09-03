export interface WorkingStateRecord {
  sessionId: string;
  taskSummary: string;
  activeGoal: string;
  selectedModel: string;
  activePackId: string;
  activeSkillId: string;
  pinnedArtifactIds: string[];
  workingArtifactIds: string[];
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
  activeToolCallIds: string[];
  discoveredSkillIds: string[];
  discoveredSkillNames: string[];
  expandedSkillIds: string[];
  invokedSkills: unknown[];
  loadedNestedMemoryPaths: string[];
  toolSchemaCache: Record<string, unknown>;
  updatedAt: string;
}

export interface ComputerElementRecord {
  id: string;
  role: string;
  name: string;
  value: string;
  description: string;
}

export interface ComputerStateRecord {
  app: string;
  windowTitle: string;
  url: string;
  focusedElement: string;
  observation: string;
  accessibilityTree: string;
  screenshotArtifactId: string;
  observedAt: string;
  elements: ComputerElementRecord[];
}

export interface AgentEventRecord {
  type?: string;
  runId?: string;
  at?: string;
  response?: {
    text?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RunRecord {
  id?: string;
  runId?: string;
  sessionId?: string;
  input?: string;
  summary?: string;
  modelId?: string;
  lifecycle?: {
    taskState?: string;
    activity?: string;
    reasonCode?: string;
    retryable?: boolean;
    outcomeUnknown?: boolean;
    childRunId?: string;
  };
  startedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  endedAt?: string;
  finishedAt?: string;
  toolIds?: string[];
  [key: string]: unknown;
}

export interface SessionRecord {
  id?: string;
  sessionId?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ArtifactRecord {
  id?: string;
  title?: string;
  type?: string;
  summary?: string;
  imageUri?: string;
  preview?: {
    text?: string;
    [key: string]: unknown;
  };
  data?: Record<string, unknown>;
  assets?: Array<Record<string, unknown>>;
  tags?: string[];
  [key: string]: unknown;
}

export interface SkillRecord {
  id?: string;
  name?: string;
  aliases?: string[];
  title?: string;
  displayName?: string;
  description?: string;
  whenToUse?: string;
  entry?: string;
  skillRoot?: string;
  source?: string;
  packId?: string;
  toolIds?: string[];
  allowedTools?: string[];
  userInvocable?: boolean;
  [key: string]: unknown;
}

export interface ApprovalRecord {
  id?: string;
  title?: string;
  status?: string;
  toolId?: string;
  input?: unknown;
  approvalInput?: unknown;
  [key: string]: unknown;
}

export interface QuestionRecord {
  id?: string;
  title?: string;
  prompt?: string;
  status?: string;
  input?: unknown;
  response?: unknown;
  source?: string;
  [key: string]: unknown;
}

export interface ExecutionRecord {
  id?: string;
  runId?: string;
  sessionId?: string;
  kind?: string;
  title?: string;
  status?: string;
  eventType?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InventoryResponse {
  ok: boolean;
  kernel?: string;
  artifacts: ArtifactRecord[];
  workingState: WorkingStateRecord;
  computerState?: ComputerStateRecord;
  sessions: SessionRecord[];
  runs: RunRecord[];
  executions: ExecutionRecord[];
  skills: SkillRecord[];
  packs?: Record<string, unknown>[];
  tools: Record<string, unknown>[];
  mountedApps?: MountedAppInventorySummary;
  capabilities?: Record<string, unknown>[];
}

export interface ExtensionItemCollection {
  items: ExtensionItemRecord[];
}

export interface MountedAppInventorySummary extends ExtensionItemCollection {
  scannedAt: string;
  workspaceRoot: string;
  deployments: ExtensionDeploymentRecord[];
}

export interface ExtensionInventoryRecord extends ExtensionItemCollection {
  scannedAt: string;
  workspaceRoot: string;
  items: ExtensionItemRecord[];
  deployments: ExtensionDeploymentRecord[];
  commandUsages: Record<string, unknown>[];
  summary: {
    itemCount?: number;
    deploymentCount?: number;
    enabledDeploymentCount?: number;
    byKind?: Record<string, number>;
    byKernel?: Record<string, number>;
    [key: string]: unknown;
  };
}

export interface ExtensionItemRecord {
  id: string;
  kind: string;
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  managedByOpenGrove: boolean;
  readonly: boolean;
  system: boolean;
  source?: Record<string, unknown>;
  deployments: ExtensionDeploymentRecord[];
  permissions: Record<string, unknown>[];
  commandUsages: Record<string, unknown>[];
  childIds: string[];
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface ExtensionDeploymentRecord {
  id: string;
  itemId: string;
  kind: string;
  kernelId?: string;
  scope: string;
  status: string;
  enabled: boolean;
  managedByOpenGrove: boolean;
  readonly: boolean;
  system: boolean;
  sourcePath?: string;
  targetPath?: string;
  configPath?: string;
  configFormat?: string;
  markerPath?: string;
  reason?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
  metadata?: Record<string, unknown>;
}

export interface MountedAppFileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  mimeType?: string;
  updatedAt?: string;
  children?: MountedAppFileEntry[];
}

export interface MountedAppRouteInfo {
  id: string;
  title: string;
  appRoot: string;
  workspaceRoot: string;
  workspaceKind?: string;
}

export interface MountedAppFilesResponse {
  ok: boolean;
  app: MountedAppRouteInfo;
  path: string;
  entries?: MountedAppFileEntry[];
  revision?: string;
  unchanged?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface MountedAppFileResponse {
  ok: boolean;
  app: MountedAppRouteInfo;
  file?: MountedAppFileEntry & {
    content?: string;
    contentTruncated?: boolean;
  };
  revision?: string;
  unchanged?: boolean;
  error?: string;
}

export interface MountedAppFileSystemResponse {
  ok: boolean;
  app: MountedAppRouteInfo;
  entry?: MountedAppFileEntry;
  deletedPath?: string;
  entries: MountedAppFileEntry[];
  truncated?: boolean;
  error?: string;
}

export type MountedAppFlowStatus = "pending" | "running" | "waiting_user" | "done" | "failed";
export type MountedAppFlowStepStatus = "pending" | "running" | "waiting" | "done" | "failed";

export interface MountedAppFlowStep {
  id: string;
  title: string;
  owner: string;
  status: MountedAppFlowStepStatus;
  output?: string;
  blocking?: boolean;
  note?: string;
  [key: string]: unknown;
}

export interface MountedAppFlowFrontmatter {
  flow: "v1";
  title: string;
  status: MountedAppFlowStatus;
  initiator?: string;
  started?: string;
  updated?: string;
  steps: MountedAppFlowStep[];
  [key: string]: unknown;
}

export interface MountedAppFlowRecord {
  path: string;
  frontmatter?: MountedAppFlowFrontmatter;
  rawFrontmatter?: Record<string, unknown>;
  valid: boolean;
  issues: string[];
  mtime: string;
}

export interface MountedAppFlowsResponse {
  ok: boolean;
  app: MountedAppRouteInfo;
  flows?: MountedAppFlowRecord[];
  revision?: string;
  unchanged?: boolean;
  truncated?: boolean;
  error?: string;
}

export type MountedAppDashboardGrade = "good" | "warn" | "weak" | "unknown";

export interface MountedAppDashboardMetric {
  label: string;
  grade: MountedAppDashboardGrade;
}

export interface MountedAppDashboardFunnelChapter {
  chapter: number;
  label: string;
  uv?: number;
  reachPercent?: number;
  paid?: boolean;
  grade: MountedAppDashboardGrade;
}

export interface MountedAppDashboardFunnel {
  freeChapters?: number;
  totalChapters?: number;
  mode?: "split" | "dropoff";
  maxDropChapter?: {
    from?: number;
    to?: number;
    label?: string;
  };
  chapters?: MountedAppDashboardFunnelChapter[];
}

export interface MountedAppDashboardCommission {
  label?: string;
  estimate: string;
  parts?: Array<{
    label: string;
    estimate: string;
  }>;
  state: "pending" | "paid";
  source: "local_mock" | "cloud";
  mock?: boolean;
}

export interface MountedAppDashboardItem {
  id: string;
  title: string;
  grade: MountedAppDashboardGrade;
  topAlert?: string;
  submittedAt?: string;
  dataAvailable?: boolean;
  preview?: boolean;
  dataGrade?: MountedAppDashboardGrade;
  dataTopAlert?: string;
  review?: {
    grade: MountedAppDashboardGrade;
    topAlert?: string;
    sections: {
      diagnosis?: {
        strengths?: string[];
        suggestions?: string[];
      };
    };
  };
  commission?: MountedAppDashboardCommission;
  sections: {
    acquisition?: {
      metrics?: MountedAppDashboardMetric[];
    };
    retention?: {
      metrics?: MountedAppDashboardMetric[];
      funnel?: MountedAppDashboardFunnel;
    };
    revenue?: {
      metrics?: MountedAppDashboardMetric[];
    };
    diagnosis?: {
      strengths?: string[];
      suggestions?: string[];
    };
  };
}

export interface MountedAppDashboardResponse {
  ok: boolean;
  app: MountedAppRouteInfo;
  overview: {
    activeCount: number;
    overallGrade: MountedAppDashboardGrade;
  };
  items: MountedAppDashboardItem[];
  source?: "cloud" | "local_mock";
  error?: string;
}
