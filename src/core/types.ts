import type { A2ATaskState, RunLifecycle } from "#agent-protocol";
import type {
  ApprovalInbox,
  ArtifactStore,
  ExecutionStore,
  MemoryLedger,
  QuestionInbox,
  SessionStore,
  WorkingStateStore,
} from "./stores.js";
import type { PackRegistry } from "./registries.js";
import type { DiagnosticProblemRef, RuntimeErrorDiagnostics } from "../diagnostics/problem-schema.js";
import type { ReplyLanguagePreference } from "../localization/language-contracts.js";
export type { DiagnosticProblemRef } from "../diagnostics/problem-schema.js";
export type { RuntimeErrorDiagnostics } from "../diagnostics/problem-schema.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type ActivitySpace = "browser" | "chat" | "local" | "api" | "computer";
export type ToolRisk = "read" | "write" | "send" | "spend" | "delete";
export type PermissionMode = "allow" | "ask" | "deny";
export type MemoryScope = "user" | "workspace" | "page" | "session";
export type MemoryConfidence = "asserted" | "observed" | "inferred";
export type MemoryWriteMode = "direct" | "propose" | "ask";
export type SandboxPolicy = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type RuntimeAccessMode = "default" | "auto-review" | "full-access";
export type ResponseSpeed = "standard" | "fast";
export type DynamicToolsMode = "auto" | "always" | "disabled";
export type SessionHistoryMode = "auto" | "app" | "native";

export interface SourceRef {
  title?: string;
  url?: string;
  locator?: string;
  quote?: string;
}

export type ContextItemKind =
  | "page"
  | "selection"
  | "attachment"
  | "computer"
  | "artifact"
  | "session"
  | "execution"
  | "task"
  | "knowledge"
  | "memory"
  | "routine"
  | "permission"
  | "skill";

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  title: string;
  text: string;
  source?: SourceRef;
  score?: number;
  data?: JsonObject;
}

export interface ContextBudget {
  maxItems: number;
  usedItems: number;
  maxCharacters: number;
  usedCharacters: number;
  truncated: boolean;
}

export interface ContextEnvelope {
  id: string;
  createdAt: string;
  summary: string;
  items: ContextItem[];
  budget: ContextBudget;
  promptBlock: string;
}

export interface SchemaSpec {
  type: "json-schema";
  schema: JsonObject;
}

export interface ArtifactAsset {
  kind: "image" | "audio" | "video" | "file" | "url" | "text";
  uri?: string;
  path?: string;
  title?: string;
  mimeType?: string;
  metadata?: JsonObject;
}

export interface ArtifactPreview {
  title?: string;
  text?: string;
  imageUri?: string;
  mimeType?: string;
  status?: string;
}

export interface PermissionRequirement {
  mode: PermissionMode;
  reason: string;
}

export interface ToolLivenessContract {
  /** Whether the implementation observes ToolCallContext.signal cooperatively. */
  cancellation: "run-signal" | "none";
  /** Host Tools have no implicit wall-clock deadline; any deadline must name its real owner. */
  deadlineSource: "kernel-native" | "upstream-service" | "business-rule" | "none";
  /** What the Host may conclude after cancellation grace expires without a ToolResult. */
  abandonOutcome: "outcome-unknown";
  /** A returned ToolResult is the only confirmed Host Tool terminal receipt. */
  terminalConfirmation: "tool-result";
  cancellationGraceMs?: number;
}

export interface ToolSpec {
  id: string;
  title: string;
  description: string;
  activity: ActivitySpace;
  risk: ToolRisk;
  input: SchemaSpec;
  output?: SchemaSpec;
  permission: PermissionRequirement;
  /** Optional override; the Host bridge applies a conservative run-signal/no-deadline contract by default. */
  liveness?: ToolLivenessContract;
}

export interface PolicyRule {
  id?: string;
  toolId?: string;
  capabilityId?: string;
  risk?: ToolRisk;
  mode: PermissionMode;
  reason: string;
}

export interface PolicyDecision {
  mode: PermissionMode;
  reason: string;
  matchedRuleId?: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface ModelToolCall {
  id: string;
  toolId: string;
  input: JsonValue;
}

export interface UsageContextBreakdownEntry {
  category: string;
  tokens: number;
}

export interface UsageStats {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  // Total context-window size for the active model (the denominator for a usage ring).
  contextWindowSize?: number;
  // Tokens currently consumed against contextWindowSize (running total when available).
  contextUsedTokens?: number;
  // Optional per-category split (Claude exposes this; Codex does not).
  contextBreakdown?: UsageContextBreakdownEntry[];
}

export type ModelEvent =
  | { type: "model.delta"; text: string }
  | { type: "model.tool_call"; call: ModelToolCall }
  | { type: "model.done"; usage?: UsageStats }
  | { type: "model.error"; message: string };

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  output?: SchemaSpec;
  metadata?: JsonObject;
}

export interface AgentSessionTrace {
  provider: string;
  sessionId: string;
  persistent: boolean;
  priorMessageCount: number;
  priorMessages: ModelMessage[];
  nativeSessionId?: string;
}

export interface AgentModelRequestTrace {
  systemPrompt: string;
  userInput: string;
  modelId?: string;
  session?: AgentSessionTrace;
  messages?: ModelMessage[];
  context?: ContextEnvelope;
  tools: ToolSpec[];
  skills: SkillManifest[];
  packs: PackManifest[];
  capabilities: CapabilityManifest[];
}

export interface AgentModelResponseTrace {
  text: string;
  usage?: UsageStats;
}

export type AssistantFinalSource = "runtime" | "adapter" | "fallback";

export interface AssistantFinalEvent {
  type: "assistant.final";
  runId: string;
  text: string;
  at: string;
  source?: AssistantFinalSource;
}

export interface AssistantStatusEvent {
  type: "assistant.status";
  runId: string;
  at: string;
  text: string;
  data?: JsonObject;
}

export interface ModelAdapter {
  id: string;
  request(input: ModelRequest): AsyncIterable<ModelEvent>;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "canceled";

export type ApprovalKind =
  | "tool"
  | "command"
  | "file_change"
  | "permission_scope"
  | "routine_step"
  | "memory_write"
  | "browser_action"
  | "computer_action";

export type ApprovalResume =
  | { type: "tool"; runId?: string }
  // stepOutputs 携带暂停前已完成步骤的输出快照(bounded,见 routine-runner MAX_ROUTINE_STEP_OUTPUT_BYTES),
  // 让审批恢复后能继续引用前序步骤输出(F2:否则恢复时内存 stepOutputs 为空,引用会渲染成空串)。
  | { type: "routine.step"; routineId: string; stepId: string; runId: string; stepOutputs?: Record<string, JsonValue> }
  | {
      type: "kernel.native";
      kernelId: string;
      runId: string;
      continuation: "same-loop";
    };

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  title: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
  toolId?: string;
  capabilityId?: string;
  skillId?: string;
  input?: JsonValue;
  response?: JsonValue;
  resume?: ApprovalResume;
  nativeRequestId?: string;
  deadlineAt?: string;
  isBlocking?: boolean;
  autoResolutionMs?: number;
}

export type QuestionStatus = "pending" | "answered" | "declined" | "canceled";

export type AgentRequestSource = { type: "kernel.native"; kernelId: string } | { type: "host" } | { type: "unknown" };

export interface QuestionRequest {
  id: string;
  title: string;
  prompt: string;
  status: QuestionStatus;
  createdAt: string;
  updatedAt: string;
  input?: JsonValue;
  response?: JsonValue;
  source?: AgentRequestSource;
  resume?: ApprovalResume;
  nativeRequestId?: string;
  deadlineAt?: string;
  isBlocking?: boolean;
  autoResolutionMs?: number;
}

export interface PlanningUpdate {
  id: string;
  title?: string;
  text: string;
  status?: string;
  raw?: JsonObject;
  updatedAt: string;
  source?: AgentRequestSource;
}

export interface ToolResult<TOutput extends JsonValue = JsonValue> {
  ok: boolean;
  value?: TOutput;
  error?: string;
  problem?: DiagnosticProblemRef;
  sources?: SourceRef[];
}

export interface ToolCallContext {
  runId: string;
  capabilityId?: string;
  skillId?: string;
  memory: MemoryLedger;
  artifacts: ArtifactStore;
  workingState: WorkingStateStore;
  approvals: ApprovalInbox;
  skills: SkillCatalog;
  packs: PackRegistry;
  policy: PolicyDecision;
  /** Native runtimes pass their per-call cancellation signal through here. */
  signal?: AbortSignal;
  /** Tools may report structured intermediate state without turning it into final output. */
  onProgress?: (update: JsonValue) => void;
}

export interface ToolDefinition<TInput extends JsonValue = JsonObject, TOutput extends JsonValue = JsonValue> {
  spec: ToolSpec;
  execute(input: TInput, context: ToolCallContext): Promise<ToolResult<TOutput>>;
}

export interface MemorySource {
  kind: "user" | "agent" | "tool" | "skill";
  ref?: SourceRef;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  kind: string;
  text: string;
  confidence: MemoryConfidence;
  source: MemorySource;
  tags: string[];
  data?: JsonObject;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface MemoryWriteRequest {
  id?: string;
  scope: MemoryScope;
  kind: string;
  text: string;
  confidence: MemoryConfidence;
  source: MemorySource;
  tags?: string[];
  data?: JsonObject;
  expiresAt?: string;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  kind?: string;
  tags?: string[];
  limit?: number;
}

export interface MemoryHook {
  kind: string;
  mode: MemoryWriteMode;
  reason: string;
}

export type SkillSource = "bundled" | "project" | "user" | "pack";
export type SkillTrust = "trusted" | "untrusted";
export type SkillExecutionContext = "inline" | "fork";

export interface SkillManifest {
  id: string;
  name: string;
  /** Compatibility lookup names, such as a legacy directory name. */
  aliases?: string[];
  title: string;
  description: string;
  whenToUse?: string;
  format: "markdown-v1" | "markdown-v2";
  entry: string;
  skillRoot: string;
  activities: ActivitySpace[];
  toolIds: string[];
  memoryHooks: MemoryHook[];
  allowedTools: string[];
  argumentHint?: string;
  arguments?: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  model?: string;
  effort?: string;
  context: SkillExecutionContext;
  shell?: string[];
  paths?: string[];
  hooks?: JsonObject;
  source: SkillSource;
  trust: SkillTrust;
  packId?: string;
  capabilityId?: string;
  contentLength?: number;
  tags?: string[];
}

export interface LoadedSkill {
  manifest: SkillManifest;
  content: string;
  sourcePath: string;
  args?: string;
}

export interface RequiredSkillRequirement {
  configuredName: string;
  manifest?: SkillManifest;
  sourcePath?: string;
  hostLoadStatus: "available" | "failed";
  hostLoadError?: string;
  modelLoadAllowed: boolean;
}

export interface SkillCatalog {
  list(): SkillManifest[];
  get(idOrName: string): SkillManifest | undefined;
  resolve(name: string, options?: { includeDisabled?: boolean }): SkillManifest | undefined;
  load(name: string, args: string | undefined, sessionId: string): LoadedSkill;
}

export interface InvokedSkillRecord {
  skillId: string;
  skillName: string;
  title: string;
  content: string;
  contentPreview: string;
  sourcePath: string;
  source: SkillSource;
  trust: SkillTrust;
  context: SkillExecutionContext;
  args?: string;
  allowedTools: string[];
  model?: string;
  effort?: string;
  packId?: string;
  capabilityId?: string;
  invokedAt: string;
  origin: "user" | "model";
}

export interface EvalCase {
  id: string;
  description: string;
  input: string;
  expectedBehavior: string;
}

export interface CapabilitySource {
  kind: "native" | "wrapped-open-source" | "mcp" | "external-api" | "user-routine";
  project?: string;
  url?: string;
  license?: string;
}

export interface CapabilityManifest {
  id: string;
  title: string;
  version: string;
  description: string;
  source?: CapabilitySource;
  activities: ActivitySpace[];
  triggers?: JsonObject[];
  tools: ToolSpec[];
  skills: SkillManifest[];
  memoryHooks: MemoryHook[];
  policy: PolicyRule[];
  sandbox?: SandboxPolicy;
  evals?: EvalCase[];
}

export interface PackManifest {
  id: string;
  title: string;
  description: string;
  source: SkillSource;
  trust: SkillTrust;
  rootDir: string;
  skillIds: string[];
  toolIds: string[];
  capabilityIds: string[];
  artifactTypes: string[];
  referenceAssetDirs?: string[];
  tags?: string[];
}

export type RoutineStatus = "draft" | "active" | "paused" | "needs_repair" | "archived";
export type RoutineTrigger = "manual" | "schedule" | "event";
export type RoutineStepConditionOperator = "truthy" | "equals" | "notEquals" | "gt" | "gte" | "lt" | "lte";

export interface RoutineStepCondition {
  /** Previous step id whose output should be inspected. */
  stepId: string;
  /** Dot path inside the previous step output. Omit to inspect the whole output. */
  path?: string;
  /** Defaults to truthy. */
  operator?: RoutineStepConditionOperator;
  value?: JsonValue;
}

export interface RoutineStep {
  id: string;
  title: string;
  toolId?: string;
  capabilityId?: string;
  skillId?: string;
  memberId?: string;
  roomId?: string;
  // prompt 和 input 字符串支持 `{{steps.<stepId>.output}}` 及任意深度点路径插值,
  // 引用本 routine 中前序已完成步骤的输出;引用未完成/不存在的步骤或字段会渲染成空串并记 runtime.diagnostic。
  prompt?: string;
  input?: JsonValue;
  /** Optional gate evaluated against prior step output before this step runs. */
  when?: RoutineStepCondition;
  // engine 层 approval(runner 跑到非 allow 的 step 暂停等 resume)。**不是安全边界**(见规格 §0),
  // 仅作 UX 提示。workflow.create 的 F3 高危校验不看它,看下面的 flowApproval。
  approval?: PermissionRequirement;
  // flow 审批步(rev5 R0):这一步对应 app .flow.md 里的审批节点。带此字段的 step 才算"flow 审批步",
  // workflow.create 的 F3 校验要求高危动作前必须存在这样的 step;engine approval 不再满足该条件。
  flowApproval?: { flowId: string; stepId: string };
}

export interface RoutineSchedule {
  /** Local wall-clock fire time, "HH:MM" (24h). Mutually exclusive with everyMinutes. */
  at?: string;
  /** Fire repeatedly every N minutes. Mutually exclusive with at. */
  everyMinutes?: number;
  /** Days of week to fire on, 0=Sunday..6=Saturday. Omit for every day. Applies to both modes. */
  daysOfWeek?: number[];
  /** ISO timestamp of the last scheduler-initiated run, set by the scheduler. */
  lastFiredAt?: string;
}

export interface RoutineRunSummary {
  id: string;
  routineId: string;
  status: "running" | "succeeded" | "failed" | "paused_for_approval";
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  error?: string;
  problem?: DiagnosticProblemRef;
}

export interface Routine {
  id: string;
  title: string;
  description?: string;
  /** Knowledge document id this routine was imported from, when available. */
  sourceKnowledgeId?: string;
  status: RoutineStatus;
  trigger: RoutineTrigger;
  schedule?: RoutineSchedule;
  capabilityIds: string[];
  steps: RoutineStep[];
  approvalRules: PolicyRule[];
  createdAt: string;
  updatedAt: string;
  lastRun?: RoutineRunSummary;
}

export interface ArtifactRecord {
  id: string;
  type: string;
  title?: string;
  status?: string;
  version?: number;
  tags: string[];
  data: JsonObject;
  assets?: ArtifactAsset[];
  preview?: ArtifactPreview;
  createdAt: string;
  updatedAt: string;
  sourceRefs?: SourceRef[];
  parentId?: string;
  variantOf?: string;
  derivedFrom?: string[];
  lineage?: string[];
  provenance?: JsonObject;
}

export interface ArtifactCreateRequest {
  id?: string;
  type: string;
  title?: string;
  status?: string;
  version?: number;
  tags?: string[];
  data?: JsonObject;
  assets?: ArtifactAsset[];
  preview?: ArtifactPreview;
  sourceRefs?: SourceRef[];
  parentId?: string;
  variantOf?: string;
  derivedFrom?: string[];
  lineage?: string[];
  provenance?: JsonObject;
}

export interface ArtifactFilter {
  ids?: string[];
  type?: string;
  tags?: string[];
  parentId?: string;
  limit?: number;
}

export type SessionStatus = "active" | "idle" | "archived";
export interface SessionRecord {
  id: string;
  title?: string;
  activity?: ActivitySpace;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  latestRunId?: string;
  runIds: string[];
  lastUserInput?: string;
  metadata?: JsonObject;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  activity: ActivitySpace;
  /** Canonical run state. Old persisted `status` values are migrated on read. */
  lifecycle: RunLifecycle;
  input: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  endedAt?: string;
  modelId?: string;
  summary?: string;
  error?: string;
  problem?: DiagnosticProblemRef;
  pausedAt?: string;
  resumedAt?: string;
  pauseReason?: string;
  lastApprovalId?: string;
  lastQuestionId?: string;
  resumeCount: number;
  approvalIds: string[];
  questionIds: string[];
  toolIds: string[];
  eventCount: number;
}

export interface SessionFilter {
  ids?: string[];
  status?: SessionStatus;
  activity?: ActivitySpace;
  limit?: number;
}

export interface RunFilter {
  ids?: string[];
  sessionId?: string;
  taskState?: A2ATaskState;
  limit?: number;
}

export type ExecutionKind =
  | "loop"
  | "model"
  | "reasoning"
  | "tool_call"
  | "approval"
  | "question"
  | "planning"
  | "artifact"
  | "memory"
  | "error";

export interface ExecutionRecord {
  id: string;
  runId: string;
  sessionId?: string;
  kind: ExecutionKind;
  eventType: AgentEvent["type"];
  title: string;
  at: string;
  status?: string;
  toolId?: string;
  approvalId?: string;
  questionId?: string;
  artifactId?: string;
  data?: JsonObject;
}

export interface ExecutionFilter {
  sessionId?: string;
  runId?: string;
  kind?: ExecutionKind;
  limit?: number;
}

export interface WorkingStateRecord {
  sessionId?: string;
  taskSummary?: string;
  activeGoal?: string;
  selectedModel?: string;
  activePackId?: string;
  activeSkillId?: string;
  pinnedArtifactIds: string[];
  workingArtifactIds: string[];
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
  activeToolCallIds: string[];
  discoveredSkillIds: string[];
  discoveredSkillNames: string[];
  expandedSkillIds: string[];
  invokedSkills: InvokedSkillRecord[];
  loadedNestedMemoryPaths: string[];
  toolSchemaCache: Record<string, string>;
  updatedAt: string;
}

export interface AgentPageContext {
  url?: string;
  title?: string;
  selection?: string;
  visibleText?: string;
  locator?: string;
  attachments?: AgentAttachmentContext[];
}

export interface AgentAttachmentContext {
  id?: string;
  name: string;
  kind: "image" | "text" | "file";
  mimeType?: string;
  size?: number;
  text?: string;
  dataUrl?: string;
  localPath?: string;
}

export interface AgentComputerElementContext {
  id?: string;
  role?: string;
  name?: string;
  value?: string;
  description?: string;
}

export interface AgentComputerContext {
  app?: string;
  windowTitle?: string;
  url?: string;
  focusedElement?: string;
  observation?: string;
  accessibilityTree?: string;
  screenshotArtifactId?: string;
  observedAt?: string;
  elements?: AgentComputerElementContext[];
}

export interface AgentContext {
  sessionId: string;
  activity: ActivitySpace;
  memory: MemoryLedger;
  artifacts: ArtifactStore;
  skills: SkillCatalog;
  packs: PackRegistry;
  sessions: SessionStore;
  executions: ExecutionStore;
  workingState: WorkingStateStore;
  approvals: ApprovalInbox;
  questions: QuestionInbox;
  userId?: string;
  page?: AgentPageContext;
  computer?: AgentComputerContext;
}

export type UserLanguagePreference = ReplyLanguagePreference;

export interface AgentHostToolScope {
  sessionId: string;
  employeeId?: string;
  roomId?: string;
}

export interface AgentTurnRequest {
  input: string;
  context: AgentContext;
  tools: ToolDefinition[];
  runId?: string;
  /** Stable Host contract for the native session, such as Employee identity and Role. */
  sessionInstructions?: string;
  assembledContext?: ContextEnvelope;
  replyLanguagePreference?: ReplyLanguagePreference;
  requestedModelId?: string;
  requestedEffort?: string;
  responseSpeed?: ResponseSpeed;
  budgetLimitUsd?: number;
  /** Requested native compaction threshold. Runtimes must not truncate conversation history in the Host. */
  contextTokenBudget?: number;
  threadGoal?: AgentThreadGoalRequest;
  structuredOutputSchema?: JsonObject;
  accessMode?: RuntimeAccessMode;
  dynamicToolsMode?: DynamicToolsMode;
  sessionHistoryMode?: SessionHistoryMode;
  requestedSkillInvocation?: InvokedSkillRecord;
  requiredSkills?: LoadedSkill[];
  requiredSkillRequirements?: RequiredSkillRequirement[];
  signal?: AbortSignal;
  skills?: SkillManifest[];
  packs?: PackManifest[];
  capabilities?: CapabilityManifest[];
  policy?: PolicyRule[];
  runtimeEnv?: NodeJS.ProcessEnv;
  /** Host-owned identity boundary for transport-level Host Tool credentials. */
  hostToolScope?: AgentHostToolScope;
}

export interface AgentThreadGoalRequest {
  enabled: boolean;
  objective?: string;
  tokenBudget?: number;
}

export type AgentReasoningKind = "native" | "summary";

export interface AgentReasoning {
  id: string;
  kind: AgentReasoningKind;
  kernelId: string;
  text: string;
  redacted?: boolean;
  elapsedMs?: number;
}

export type AgentEvent =
  | { type: "turn.started"; runId: string; at: string }
  | { type: "context.assembled"; runId: string; context: ContextEnvelope }
  | {
      type: "compaction.started";
      runId: string;
      at: string;
      reason?: string;
      item?: JsonValue;
    }
  | {
      type: "compaction.finished";
      runId: string;
      at: string;
      summary?: string;
      item?: JsonValue;
    }
  | { type: "model.requested"; runId: string; request: AgentModelRequestTrace }
  | { type: "model.response"; runId: string; response: AgentModelResponseTrace }
  | { type: "runtime.diagnostic"; runId: string; at: string; name: string; data: JsonObject }
  | {
      type: "reasoning.started";
      runId: string;
      reasoning: Pick<AgentReasoning, "id" | "kind" | "kernelId">;
    }
  | { type: "reasoning.completed"; runId: string; reasoning: AgentReasoning }
  | { type: "assistant.delta"; runId: string; text: string }
  | AssistantFinalEvent
  | AssistantStatusEvent
  | { type: "skill.discovered"; runId: string; skills: SkillManifest[] }
  | { type: "skill.invoked"; runId: string; skill: SkillManifest; invocation: InvokedSkillRecord }
  | {
      type: "skill.loaded";
      runId: string;
      skillId: string;
      contentPreview: string;
      allowedTools: string[];
      model?: string;
      effort?: string;
      context: SkillExecutionContext;
    }
  | {
      type: "skill.forked";
      runId: string;
      skillId: string;
      forkSessionId: string;
      status: "started" | "finished";
      result?: string;
    }
  | { type: "skill.cleared"; runId: string; skillId?: string; reason: string }
  | { type: "tool.started"; runId: string; toolId: string; callId?: string; input: JsonValue }
  | { type: "tool.progress"; runId: string; toolId: string; callId?: string; update: JsonValue }
  | { type: "tool.finished"; runId: string; toolId: string; callId?: string; result: ToolResult }
  | { type: "approval.requested"; runId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; runId: string; request: ApprovalRequest }
  | { type: "question.requested"; runId: string; question: QuestionRequest }
  | { type: "question.answered"; runId: string; question: QuestionRequest }
  | { type: "planning.updated"; runId: string; plan: PlanningUpdate }
  | { type: "run.paused"; runId: string; at: string; reason: string; approvalId?: string }
  | { type: "run.resumed"; runId: string; at: string; reason?: string; approvalId?: string }
  | { type: "memory.written"; runId: string; record: MemoryRecord }
  | {
      type: "turn.finished";
      runId: string;
      at: string;
      outcome: RunLifecycle;
      /** True only when the Host synthesized this terminal fact during recovery or shutdown reconciliation. */
      synthetic?: boolean;
    }
  | {
      type: "error";
      runId: string;
      message: string;
      problem?: DiagnosticProblemRef;
      diagnostics?: RuntimeErrorDiagnostics;
    };

export interface AgentRuntime {
  runTurn(request: AgentTurnRequest): AsyncIterable<AgentEvent>;
  steerTurn?(request: AgentSteerRequest): Promise<AgentSteerResult>;
  compactSession?(request: AgentCompactRequest): Promise<AgentCompactResult>;
  listSessions?(): Promise<AgentSessionListResult>;
  deleteSession?(sessionId: string): Promise<AgentSessionDeleteResult>;
  forkSession?(sourceSessionId: string, targetSessionId: string): Promise<AgentSessionForkResult>;
}

export interface AgentSessionInfo {
  sessionId: string;
  nativeSessionId?: string;
}

export interface AgentSessionListResult {
  ok: boolean;
  sessions: AgentSessionInfo[];
  error?: string;
}

export interface AgentSessionDeleteResult {
  ok: boolean;
  deleted: boolean;
  error?: string;
}

export interface AgentSessionForkResult {
  ok: boolean;
  forked: boolean;
  session?: AgentSessionInfo;
  error?: string;
}

export interface AgentSteerRequest {
  runId: string;
  threadId: string;
  instruction: string;
}

export interface AgentSteerResult {
  ok: boolean;
  guided?: boolean;
  error?: string;
}

export interface AgentCompactRequest {
  runId?: string;
  threadId: string;
  reason?: string;
  /** Requested upper bound for the post-compaction context, not the number of recent tokens to retain. */
  maxTokens?: number;
  metadata?: JsonObject;
  signal?: AbortSignal;
}

export interface AgentCompactResult {
  ok: boolean;
  compacted?: boolean;
  error?: string;
  /** The Host stopped waiting without a confirmed native compaction outcome. */
  outcomeUnknown?: boolean;
}
