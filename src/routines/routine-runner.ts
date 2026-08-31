import type {
  ActivitySpace,
  AgentEvent,
  ApprovalInbox,
  ApprovalRequest,
  ArtifactStore,
  CapabilityRegistry,
  DiagnosticProblemRef,
  EventLog,
  JsonObject,
  JsonValue,
  MemoryLedger,
  PackRegistry,
  PermissionRequirement,
  Routine,
  RoutineRegistry,
  RoutineRunSummary,
  RoutineStep,
  RoutineStepCondition,
  SkillCatalog,
  ToolRegistry,
  ToolResult,
  WorkingStateStore,
} from "../core.js";
import { isRetryableDiagnosticError, type DiagnosticFacts } from "../diagnostics/problem-schema.js";
import { safeDiagnosticErrorCode } from "../diagnostics/redaction.js";
import { routineStepRoomId } from "./routine-step-validation.js";

// ===== step 间数据传递(P0) =====
// 暂停等审批时,会把 stepOutputs 快照写进 approval.resume 并被持久化。
// 单步输出快照上限,避免 persisted approvals 膨胀(超限截断为摘要引用)。
const MAX_ROUTINE_STEP_OUTPUT_BYTES = 16 * 1024;
const APP_COMMAND_RUN_TOOL_ID = "opengrove.app.command.run";

type StepOutputs = Map<string, JsonValue>;

interface MissingStepOutputReference {
  stepId: string;
  path?: string;
}

/** 按唯一格式契约渲染 `{{steps.<id>.output}}` 及其任意深度点路径。 */
function renderStepTemplate(
  template: string,
  outputs: StepOutputs,
): { text: string; missing: MissingStepOutputReference[] } {
  const missing: MissingStepOutputReference[] = [];
  // 注意:对每个占位符单独判断"步骤是否存在/已完成",缺失不静默。
  const text = template.replace(
    /\{\{\s*steps\.([A-Za-z0-9_-]+)\.output(?:\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))?\s*\}\}/g,
    (_m, refId, path) => {
      if (!outputs.has(refId)) {
        addMissingReference(missing, { stepId: refId, ...(path ? { path } : {}) });
        return "";
      }
      const value = outputs.get(refId);
      const resolved = path ? readOutputPath(value, path) : value;
      if (path && resolved === undefined) addMissingReference(missing, { stepId: refId, path });
      return stringifyForTemplate(resolved);
    },
  );
  return { text, missing };
}

function addMissingReference(missing: MissingStepOutputReference[], reference: MissingStepOutputReference): void {
  if (missing.some((item) => item.stepId === reference.stepId && item.path === reference.path)) return;
  missing.push(reference);
}

function stringifyForTemplate(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 对 step.input 递归渲染字符串字段(input 是 JSON 值,可能含嵌套字符串)。 */
function renderInputTemplate(
  input: JsonValue | undefined,
  outputs: StepOutputs,
): { value: JsonValue | undefined; missing: MissingStepOutputReference[] } {
  if (input === undefined) return { value: undefined, missing: [] };
  const missing: MissingStepOutputReference[] = [];
  const value = renderJsonValues(input, outputs, missing);
  return { value, missing };
}

function renderJsonValues(value: JsonValue, outputs: StepOutputs, missing: MissingStepOutputReference[]): JsonValue {
  if (typeof value === "string") {
    // R5: 必须把 renderStepTemplate 的 missing 收集回传,否则 input 里 {{steps.nope.output}}
    // 静默变空串、0 诊断(只有 prompt 字段有诊断,input 字段没有,不一致)。
    const rendered = renderStepTemplate(value, outputs);
    for (const missingReference of rendered.missing) {
      addMissingReference(missing, missingReference);
    }
    return rendered.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderJsonValues(item, outputs, missing));
  }
  if (value && typeof value === "object") {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderJsonValues(v as JsonValue, outputs, missing);
    }
    return out;
  }
  return value;
}

function evaluateStepCondition(
  condition: RoutineStepCondition,
  outputs: StepOutputs,
): { ok: boolean; reason?: string } {
  if (!outputs.has(condition.stepId)) {
    return { ok: false, reason: `when_output_missing:${condition.stepId}` };
  }
  const source = outputs.get(condition.stepId);
  const actual = condition.path ? readOutputPath(source, condition.path) : source;
  const operator = condition.operator ?? "truthy";
  switch (operator) {
    case "truthy":
      return { ok: isTruthyJson(actual), reason: "when_false" };
    case "equals":
      return { ok: JSON.stringify(actual) === JSON.stringify(condition.value), reason: "when_not_equal" };
    case "notEquals":
      return { ok: JSON.stringify(actual) !== JSON.stringify(condition.value), reason: "when_equal" };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compareNumericCondition(actual, condition.value, operator);
    default:
      return { ok: false, reason: "when_operator_invalid" };
  }
}

function readOutputPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const part of path
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

function isTruthyJson(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0 && Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

function compareNumericCondition(
  actual: JsonValue | undefined,
  expected: JsonValue | undefined,
  operator: "gt" | "gte" | "lt" | "lte",
): { ok: boolean; reason?: string } {
  const left = typeof actual === "number" ? actual : typeof actual === "string" ? Number(actual) : Number.NaN;
  const right = typeof expected === "number" ? expected : typeof expected === "string" ? Number(expected) : Number.NaN;
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return { ok: false, reason: "when_numeric_invalid" };
  }
  if (operator === "gt") return { ok: left > right, reason: "when_not_gt" };
  if (operator === "gte") return { ok: left >= right, reason: "when_not_gte" };
  if (operator === "lt") return { ok: left < right, reason: "when_not_lt" };
  return { ok: left <= right, reason: "when_not_lte" };
}

/** 把单步结果收敛为可序列化的业务输出快照。 */
function captureStepOutput(result: ToolResult, toolId?: string): JsonValue {
  if (result.ok && result.value !== undefined) {
    if (
      toolId === APP_COMMAND_RUN_TOOL_ID &&
      result.value &&
      typeof result.value === "object" &&
      !Array.isArray(result.value) &&
      Object.hasOwn(result.value, "json")
    ) {
      const businessOutput = result.value.json;
      // Routine 的 output 是下游步骤消费的业务数据。Host 执行信息仍保留在
      // toolResults 和 tool.finished 事件中，不把它混入 Routine 的数据接力合同。
      if (businessOutput !== undefined) return businessOutput;
    }
    return result.value;
  }
  return { ok: result.ok, error: result.error ?? null };
}

/** bounded 快照:超限截断为 artifact ref / 摘要,避免 persisted approval 膨胀。 */
function snapshotStepOutputs(outputs: StepOutputs): Record<string, JsonValue> {
  const snap: Record<string, JsonValue> = {};
  for (const [stepId, value] of outputs) {
    snap[stepId] = boundedSnapshot(value);
  }
  return snap;
}

async function notifyRunStart(
  observer: RoutineRunStatusObserver | undefined,
  routine: Routine,
  runId: string,
  startedAt: string,
): Promise<void> {
  await observer?.onRunStart?.({ routine, runId, startedAt });
}

async function notifyStepStatus(
  observer: RoutineRunStatusObserver | undefined,
  routine: Routine,
  runId: string,
  step: RoutineStep,
  status: RoutineObservedStepStatus,
  options: { output?: JsonValue; error?: string; activityRef?: RoutineStepActivityRef } = {},
): Promise<void> {
  await observer?.onStepStatus?.({
    routine,
    runId,
    step,
    status,
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(options.error ? { error: options.error } : {}),
    ...(options.activityRef ? { activityRef: options.activityRef } : {}),
    at: new Date().toISOString(),
  });
}

async function notifyRunFinish(
  observer: RoutineRunStatusObserver | undefined,
  routine: Routine,
  summary: RoutineRunSummary,
): Promise<void> {
  await observer?.onRunFinish?.({
    routine,
    summary,
    at: new Date().toISOString(),
  });
}

function boundedSnapshot(value: JsonValue): JsonValue {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { truncated: true, reason: "unserializable" };
  }
  if (serialized.length <= MAX_ROUTINE_STEP_OUTPUT_BYTES) return value;
  return {
    truncated: true,
    reason: "step_output_exceeded_limit",
    bytes: serialized.length,
    preview: serialized.slice(0, 512),
  };
}

export interface RoutineRunnerPorts {
  events: EventLog;
  approvals: ApprovalInbox;
  capabilities: CapabilityRegistry;
  memory: MemoryLedger;
  artifacts: ArtifactStore;
  skills: SkillCatalog;
  packs: PackRegistry;
  routines: RoutineRegistry;
  tools: ToolRegistry;
  workingState: WorkingStateStore;
  recordEvent(
    event: AgentEvent,
    options?: {
      sessionId?: string;
      activity?: ActivitySpace;
      input?: string;
    },
  ): AgentEvent;
}

export interface RoutineDraftOptions {
  title?: string;
  description?: string;
  capabilityIds?: string[];
  runId?: string;
  maxSteps?: number;
}

export interface RoutineRunResult {
  summary: RoutineRunSummary;
  events: AgentEvent[];
  toolResults: ToolResult[];
}

export interface RoutineRunOptions {
  startStepId?: string;
  approvedStepId?: string;
  runId?: string;
  memberExecutor?: RoutineMemberStepExecutor;
  problemReporter?: RoutineProblemReporter;
  statusObserver?: RoutineRunStatusObserver;
  /** 审批恢复时由 resumeRoutineAfterApproval 注入的前序步骤输出快照(F2)。 */
  priorStepOutputs?: Record<string, JsonValue>;
}

export interface RoutineProblemReporterInput {
  runId: string;
  phase: string;
  code: string;
  error: unknown;
  retryable: boolean;
  facts: DiagnosticFacts;
}

export type RoutineProblemReporter = (input: RoutineProblemReporterInput) => DiagnosticProblemRef;

export type RoutineObservedStepStatus = "running" | "waiting" | "done" | "failed";

export interface RoutineStepActivityRef {
  runId: string;
  messageId: string;
  roomId: string;
}

export interface RoutineRunStatusObserver {
  onRunStart?(input: { routine: Routine; runId: string; startedAt: string }): void | Promise<void>;
  onStepStatus?(input: {
    routine: Routine;
    runId: string;
    step: RoutineStep;
    status: RoutineObservedStepStatus;
    output?: JsonValue;
    error?: string;
    activityRef?: RoutineStepActivityRef;
    at: string;
  }): void | Promise<void>;
  onRunFinish?(input: { routine: Routine; summary: RoutineRunSummary; at: string }): void | Promise<void>;
}

export interface RoutineMemberStepRequest {
  memberId: string;
  roomId?: string;
  prompt: string;
  stepId: string;
  runId: string;
  onStarted?(activityRef: RoutineStepActivityRef): void | Promise<void>;
}

export type RoutineMemberStepExecutor = (request: RoutineMemberStepRequest) => Promise<ToolResult>;

export function createRoutineDraftFromEvents(app: RoutineRunnerPorts, options: RoutineDraftOptions = {}): Routine {
  const sourceEvents = options.runId
    ? app.events.list().filter((event) => event.runId === options.runId)
    : app.events.list();
  const toolEvents = sourceEvents.filter(
    (event): event is Extract<AgentEvent, { type: "tool.started" }> => event.type === "tool.started",
  );
  const selectedEvents =
    typeof options.maxSteps === "number" && options.maxSteps > 0 ? toolEvents.slice(-options.maxSteps) : toolEvents;

  const steps: RoutineStep[] = selectedEvents.map((event, index) => {
    const tool = app.tools.get(event.toolId);
    const approval = tool ? approvalForTool(tool.spec.permission) : undefined;
    return {
      id: `step_${index + 1}`,
      title: tool?.spec.title ?? event.toolId,
      toolId: event.toolId,
      capabilityId: findCapabilityIdForTool(app, event.toolId),
      input: event.input,
      approval,
    };
  });

  return app.routines.create({
    title: options.title ?? "Browser companion routine",
    description: options.description ?? "Drafted from the current event log.",
    status: "draft",
    trigger: "manual",
    capabilityIds: options.capabilityIds ?? app.capabilities.list().map((capability) => capability.id),
    approvalRules: [],
    steps,
  });
}

export async function runRoutine(
  app: RoutineRunnerPorts,
  routineId: string,
  options: RoutineRunOptions = {},
): Promise<RoutineRunResult> {
  const routine = app.routines.get(routineId);
  if (!routine) {
    throw new Error(`Routine not found: ${routineId}`);
  }

  const runId = options.runId ?? `routine_run_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const continuingRun = Boolean(options.runId && options.approvedStepId);
  const events: AgentEvent[] = continuingRun ? [] : [{ type: "turn.started", runId, at: startedAt }];
  const toolResults: ToolResult[] = [];
  const sessionId = app.workingState.get().sessionId ?? `routine:${routineId}`;
  const startIndex = options.startStepId ? routine.steps.findIndex((step) => step.id === options.startStepId) : 0;

  if (startIndex < 0) {
    throw new Error(`Routine step not found: ${options.startStepId}`);
  }

  // step 间接力:按 stepId 索引的前序输出快照。审批恢复时从 priorStepOutputs 续上(F2)。
  const stepOutputs: StepOutputs = new Map(Object.entries(options.priorStepOutputs ?? {}));
  const statusObserver = options.statusObserver;
  if (!continuingRun) {
    await notifyRunStart(statusObserver, routine, runId, startedAt);
  }

  for (const [stepOffset, step] of routine.steps.slice(startIndex).entries()) {
    const stepIndex = startIndex + stepOffset + 1;
    if (step.when) {
      const condition = evaluateStepCondition(step.when, stepOutputs);
      if (!condition.ok) {
        const reason = condition.reason ?? "when_false";
        const skippedOutput: JsonObject = { skipped: true, reason };
        events.push({
          type: "runtime.diagnostic",
          runId,
          at: new Date().toISOString(),
          name: "routine.when.skipped",
          data: { stepId: step.id, reason },
        });
        await notifyStepStatus(statusObserver, routine, runId, step, "done", {
          output: skippedOutput,
        });
        stepOutputs.set(step.id, skippedOutput);
        continue;
      }
    }
    // R0:flow 审批步(带 flowApproval 字段)。它不执行业务动作,只产出/等待对应 .flow.md 审批卡。
    // 复用 approval pause 机制做"等待",但判定/语义依据是 flowApproval 字段(不是 engine approval)。
    if (step.flowApproval) {
      await notifyStepStatus(
        statusObserver,
        routine,
        runId,
        step,
        options.approvedStepId === step.id ? "running" : "waiting",
      );
      const approvalOutcome = await executeFlowApprovalStep(app, routine, step, {
        runId,
        sessionId,
        startedAt,
        events,
        toolResults,
        stepOutputs,
        statusObserver,
        wasApproved: options.approvedStepId === step.id,
      });
      if (approvalOutcome) {
        await notifyRunFinish(statusObserver, routine, approvalOutcome.summary);
        return approvalOutcome;
      }
      await notifyStepStatus(statusObserver, routine, runId, step, "done", {
        output: { flowId: step.flowApproval.flowId, stepId: step.flowApproval.stepId, approved: true },
      });
      continue;
    }
    if (step.memberId) {
      await notifyStepStatus(statusObserver, routine, runId, step, "running");
      const memberOutcome = await executeMemberStep(app, routine, step, {
        runId,
        sessionId,
        startedAt,
        events,
        toolResults,
        memberExecutor: options.memberExecutor,
        problemReporter: options.problemReporter,
        statusObserver,
        stepOutputs,
        stepIndex,
      });
      if (memberOutcome) return memberOutcome;
      continue;
    }
    // F1: 既无 toolId 也无 memberId 的 step(v1 不执行 skill-only step)→ 显式失败,不静默 continue。
    if (!step.toolId) {
      await notifyStepStatus(statusObserver, routine, runId, step, "running");
      const error = step.skillId ? "skill_step_not_executable" : "step_no_target";
      const problem = options.problemReporter?.({
        runId,
        phase: step.skillId ? "routine-skill" : "routine-step",
        code: step.skillId ? "employee_routine_skill_not_executable" : "employee_routine_no_target",
        error,
        retryable: false,
        facts: {
          runKind: "routine",
          stepKind: step.skillId ? "skill" : "tool",
          stepIndex,
        },
      });
      events.push({
        type: "error",
        runId,
        message: step.skillId ? `routine_skill_step_not_executable:${step.id}` : `routine_step_no_target:${step.id}`,
        ...(problem ? { problem } : {}),
      });
      events.push({ type: "turn.finished", runId, at: new Date().toISOString() });
      const summary = finishRoutine(app, routine, {
        id: runId,
        routineId,
        status: "failed",
        startedAt,
        endedAt: new Date().toISOString(),
        eventCount: events.length,
        error,
        ...(problem ? { problem } : {}),
      });
      await notifyStepStatus(statusObserver, routine, runId, step, "failed", { error: summary.error });
      await notifyRunFinish(statusObserver, routine, summary);
      for (const event of events) {
        app.recordEvent(event, { sessionId, activity: "browser", input: routine.title });
      }
      return { summary, events, toolResults };
    }

    const tool = app.tools.require(step.toolId);
    // 执行该步前渲染 input,引用前序已完成步骤输出。
    const renderedInput = renderInputTemplate(step.input, stepOutputs);
    for (const missingReference of renderedInput.missing) {
      events.push({
        type: "runtime.diagnostic",
        runId,
        at: new Date().toISOString(),
        name: "routine.template.reference_missing",
        data: {
          stepId: step.id,
          referencedStepId: missingReference.stepId,
          ...(missingReference.path ? { referencedPath: missingReference.path } : {}),
        },
      });
    }
    const input = asJsonObject(renderedInput.value);
    const roomId = routineStepRoomId(step);
    if (roomId && typeof input.roomId !== "string") {
      input.roomId = roomId;
    }
    const mode = step.approval?.mode ?? tool.spec.permission.mode;
    const wasApproved = options.approvedStepId === step.id;
    if (mode !== "allow" && !wasApproved) {
      await notifyStepStatus(statusObserver, routine, runId, step, "waiting");
      const request = app.approvals.request({
        kind: "routine_step",
        title: step.title,
        reason: step.approval?.reason ?? tool.spec.permission.reason,
        toolId: step.toolId,
        capabilityId: step.capabilityId,
        input,
        resume: {
          type: "routine.step",
          routineId,
          stepId: step.id,
          runId,
          // F2:把前序输出快照随 approval 持久化,恢复时不会丢。
          stepOutputs: snapshotStepOutputs(stepOutputs),
        },
      });
      events.push({ type: "approval.requested", runId, request });
      events.push({
        type: "run.paused",
        runId,
        at: new Date().toISOString(),
        reason: request.reason,
        approvalId: request.id,
      });
      const summary = finishRoutine(app, routine, {
        id: runId,
        routineId,
        status: "paused_for_approval",
        startedAt,
        endedAt: new Date().toISOString(),
        eventCount: events.length,
      });
      await notifyRunFinish(statusObserver, routine, summary);
      for (const event of events) {
        app.recordEvent(event, {
          sessionId,
          activity: "browser",
          input: routine.title,
        });
      }
      return { summary, events, toolResults };
    }

    await notifyStepStatus(statusObserver, routine, runId, step, "running");
    events.push({ type: "tool.started", runId, toolId: step.toolId, input });
    const result = await tool
      .execute(input, {
        runId,
        capabilityId: step.capabilityId,
        memory: app.memory,
        artifacts: app.artifacts,
        workingState: app.workingState,
        approvals: app.approvals,
        skills: app.skills,
        packs: app.packs,
        policy: {
          mode: "allow",
          reason: wasApproved ? "Routine step approved by the user." : "Routine step allowed by routine configuration.",
        },
      })
      .catch(
        (error: unknown): ToolResult => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    toolResults.push(result);
    const output = captureStepOutput(result, step.toolId);
    stepOutputs.set(step.id, output);
    events.push({ type: "tool.finished", runId, toolId: step.toolId, result });

    if (!result.ok) {
      const problem =
        result.problem ??
        options.problemReporter?.({
          runId,
          phase: "routine-tool",
          code: stableRoutineErrorCode(result.error, "employee_routine_step_failed"),
          error: result.error ?? "routine_step_failed",
          retryable: isRetryableDiagnosticError(result.error),
          facts: { runKind: "routine", stepKind: "tool", stepIndex },
        });
      events.push({
        type: "error",
        runId,
        message: result.error ?? "routine_step_failed",
        ...(problem ? { problem } : {}),
      });
      events.push({ type: "turn.finished", runId, at: new Date().toISOString() });
      const summary = finishRoutine(app, routine, {
        id: runId,
        routineId,
        status: "failed",
        startedAt,
        endedAt: new Date().toISOString(),
        eventCount: events.length,
        error: result.error,
        ...(problem ? { problem } : {}),
      });
      await notifyStepStatus(statusObserver, routine, runId, step, "failed", { output, error: result.error });
      await notifyRunFinish(statusObserver, routine, summary);
      for (const event of events) {
        app.recordEvent(event, {
          sessionId,
          activity: "browser",
          input: routine.title,
        });
      }
      return { summary, events, toolResults };
    }
    await notifyStepStatus(statusObserver, routine, runId, step, "done", { output });
  }

  events.push({ type: "turn.finished", runId, at: new Date().toISOString() });
  const summary = finishRoutine(app, routine, {
    id: runId,
    routineId,
    status: "succeeded",
    startedAt,
    endedAt: new Date().toISOString(),
    eventCount: events.length,
  });
  await notifyRunFinish(statusObserver, routine, summary);
  for (const event of events) {
    app.recordEvent(event, {
      sessionId,
      activity: "browser",
      input: routine.title,
    });
  }
  return { summary, events, toolResults };
}

export async function resumeRoutineAfterApproval(
  app: RoutineRunnerPorts,
  approval: ApprovalRequest,
  options: Pick<RoutineRunOptions, "memberExecutor" | "problemReporter" | "statusObserver"> = {},
): Promise<RoutineRunResult | undefined> {
  if (approval.resume?.type !== "routine.step") {
    return undefined;
  }

  return runRoutine(app, approval.resume.routineId, {
    startStepId: approval.resume.stepId,
    approvedStepId: approval.resume.stepId,
    runId: approval.resume.runId,
    memberExecutor: options.memberExecutor,
    problemReporter: options.problemReporter,
    statusObserver: options.statusObserver,
    // F2:恢复前序步骤输出快照,否则恢复后引用会渲染成空串。
    priorStepOutputs: approval.resume.stepOutputs,
  });
}

// R0:flow 审批步执行器。它不执行业务动作,只产出/等待对应 .flow.md 审批卡(block)。
// 复用 approval pause 机制(app.approvals.request + run.paused + resumeRoutineAfterApproval):
// 跑到这里暂停、等用户审批(对应 .flow.md 的 approve-execute/approve-create 卡)。
// 判定/语义依据是 step.flowApproval 字段;真正的高危执行仍在后续 step、仍被 app wrapper 硬门禁兜底。
async function executeFlowApprovalStep(
  app: RoutineRunnerPorts,
  routine: Routine,
  step: RoutineStep,
  context: {
    runId: string;
    sessionId: string;
    startedAt: string;
    events: AgentEvent[];
    toolResults: ToolResult[];
    stepOutputs: StepOutputs;
    statusObserver?: RoutineRunStatusObserver;
    wasApproved: boolean;
  },
): Promise<RoutineRunResult | undefined> {
  const flow = step.flowApproval!;
  const stepToolId = `routine.flowApproval:${flow.flowId}:${flow.stepId}`;
  if (context.wasApproved) {
    const result: ToolResult = { ok: true, value: { flowId: flow.flowId, stepId: flow.stepId, approved: true } };
    context.toolResults.push(result);
    context.stepOutputs.set(step.id, captureStepOutput(result));
    context.events.push({ type: "tool.finished", runId: context.runId, toolId: stepToolId, result });
    return undefined;
  }
  const request = app.approvals.request({
    kind: "routine_step",
    title: step.title || `Flow 审批:${flow.flowId}/${flow.stepId}`,
    reason: `等待 app flow 审批卡通过:${flow.flowId}/${flow.stepId}(高危动作执行前必须审批)`,
    resume: {
      type: "routine.step",
      routineId: routine.id,
      stepId: step.id,
      runId: context.runId,
      stepOutputs: snapshotStepOutputs(context.stepOutputs),
    },
  });
  context.events.push({ type: "approval.requested", runId: context.runId, request });
  context.events.push({
    type: "run.paused",
    runId: context.runId,
    at: new Date().toISOString(),
    reason: request.reason,
    approvalId: request.id,
  });
  const summary = finishRoutine(app, routine, {
    id: context.runId,
    routineId: routine.id,
    status: "paused_for_approval",
    startedAt: context.startedAt,
    endedAt: new Date().toISOString(),
    eventCount: context.events.length,
  });
  for (const event of context.events) {
    app.recordEvent(event, { sessionId: context.sessionId, activity: "browser", input: routine.title });
  }
  return { summary, events: context.events, toolResults: context.toolResults };
}
async function executeMemberStep(
  app: RoutineRunnerPorts,
  routine: Routine,
  step: RoutineStep,
  context: {
    runId: string;
    sessionId: string;
    startedAt: string;
    events: AgentEvent[];
    toolResults: ToolResult[];
    memberExecutor?: RoutineMemberStepExecutor;
    problemReporter?: RoutineProblemReporter;
    statusObserver?: RoutineRunStatusObserver;
    stepOutputs: StepOutputs;
    stepIndex: number;
  },
): Promise<RoutineRunResult | undefined> {
  const memberId = step.memberId ?? "";
  const stepToolId = `routine.member:${memberId}`;
  // 执行前渲染 prompt,引用前序已完成步骤输出。
  const rendered = renderStepTemplate(step.prompt ?? step.title, context.stepOutputs);
  for (const missingReference of rendered.missing) {
    context.events.push({
      type: "runtime.diagnostic",
      runId: context.runId,
      at: new Date().toISOString(),
      name: "routine.template.reference_missing",
      data: {
        stepId: step.id,
        referencedStepId: missingReference.stepId,
        ...(missingReference.path ? { referencedPath: missingReference.path } : {}),
      },
    });
  }
  const prompt = rendered.text;
  const input = { memberId, roomId: step.roomId ?? "", prompt };
  context.events.push({ type: "tool.started", runId: context.runId, toolId: stepToolId, input });
  const result: ToolResult = context.memberExecutor
    ? await context
        .memberExecutor({
          memberId,
          roomId: step.roomId,
          prompt,
          stepId: step.id,
          runId: context.runId,
          onStarted: (activityRef) =>
            notifyStepStatus(context.statusObserver, routine, context.runId, step, "running", { activityRef }),
        })
        .catch((error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
    : { ok: false, error: "member_step_executor_unavailable" };
  context.toolResults.push(result);
  const output = captureStepOutput(result);
  context.stepOutputs.set(step.id, output);
  context.events.push({ type: "tool.finished", runId: context.runId, toolId: stepToolId, result });

  if (result.ok) {
    await notifyStepStatus(context.statusObserver, routine, context.runId, step, "done", { output });
    return undefined;
  }

  const problem =
    result.problem ??
    context.problemReporter?.({
      runId: context.runId,
      phase: "routine-member",
      code: routineMemberErrorCode(result.error),
      error: result.error ?? "routine_member_step_failed",
      retryable: isRetryableDiagnosticError(result.error),
      facts: { runKind: "routine", stepKind: "member", stepIndex: context.stepIndex },
    });
  context.events.push({
    type: "error",
    runId: context.runId,
    message: result.error ?? "routine_member_step_failed",
    ...(problem ? { problem } : {}),
  });
  context.events.push({ type: "turn.finished", runId: context.runId, at: new Date().toISOString() });
  const summary = finishRoutine(app, routine, {
    id: context.runId,
    routineId: routine.id,
    status: "failed",
    startedAt: context.startedAt,
    endedAt: new Date().toISOString(),
    eventCount: context.events.length,
    error: result.error,
    ...(problem ? { problem } : {}),
  });
  await notifyStepStatus(context.statusObserver, routine, context.runId, step, "failed", {
    output,
    error: result.error,
  });
  await notifyRunFinish(context.statusObserver, routine, summary);
  for (const event of context.events) {
    app.recordEvent(event, {
      sessionId: context.sessionId,
      activity: "browser",
      input: routine.title,
    });
  }
  return { summary, events: context.events, toolResults: context.toolResults };
}

function stableRoutineErrorCode(error: unknown, fallback: string): string {
  const code = safeDiagnosticErrorCode(error);
  return code === "unknown_error" ? fallback : code;
}

function routineMemberErrorCode(error: unknown): string {
  if (error === "member_step_executor_unavailable") {
    return "employee_routine_member_executor_unavailable";
  }
  if (typeof error === "string" && /timed out|timeout/i.test(error)) {
    return "employee_routine_member_timeout";
  }
  return stableRoutineErrorCode(error, "employee_routine_member_failed");
}

function finishRoutine(app: RoutineRunnerPorts, routine: Routine, summary: RoutineRunSummary): RoutineRunSummary {
  app.routines.update(routine.id, {
    lastRun: summary,
    status:
      summary.status === "failed"
        ? "needs_repair"
        : summary.status === "paused_for_approval"
          ? "paused"
          : routine.status === "paused"
            ? "draft"
            : routine.status,
  });
  return summary;
}

function approvalForTool(permission: PermissionRequirement): PermissionRequirement | undefined {
  return permission.mode === "allow" ? undefined : permission;
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function findCapabilityIdForTool(app: RoutineRunnerPorts, toolId: string): string | undefined {
  return app.capabilities.list().find((capability) => capability.tools.some((tool) => tool.id === toolId))?.id;
}
