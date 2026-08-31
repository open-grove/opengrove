import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FlowFrontmatter, FlowStep } from "../app-builder/flow.js";
import { serializeFlowMarkdown } from "../app-builder/flow.js";
import type {
  JsonObject,
  JsonValue,
  RoutineSchedule,
  RoutineStep,
  RoutineStepCondition,
  ToolDefinition,
  ToolResult,
} from "../core.js";
import { serializeRoutineFile, approvalSchema } from "../routines/routine-file.js";
import { APP_VAULT_ROOT_NAME } from "../identity.js";
import { safePathSegment } from "../server/knowledge-path-utils.js";
import { knowledgeVaultRoot } from "../server/knowledge-roots.js";

// ===== workflow.create 宿主工具(P2,rev5 返工 R0/R1/R2/R3) =====
// 给员工一个宿主工具,产出 P1 格式的 .routine.md 文件。
// 安全红线(F3,R0 修正):确定性高危校验——检测到高危执行意图且 routine 无【flow 审批步】
// (flowApproval 字段,不是 engine approval),或 flow 审批步排在高危动作之后 → 工具层硬拦拒绝。
// engine approval(approval.mode)不再算 flow 审批(规格 §0:engine approval 不是安全边界)。

export interface WorkflowCreateToolContext {
  /** 校验 memberId 是当前 app/room 范围内可运行的成员(R1:对齐 import route 的 runnable+范围校验)。 */
  validateMember(memberId: string, scope: WorkflowCreateScope): string | undefined;
  /** 校验 toolId 已注册,返回拒绝原因或 undefined。 */
  validateTool(toolId: string): string | undefined;
  /** RC5:校验 flowApproval 指向当前 app 真实存在的 .flow.md 用户阻塞审批节点。 */
  validateFlowApproval?(flowApproval: WorkflowFlowApproval, scope: WorkflowCreateScope): string | undefined;
  /** 补齐可从当前 app scope 推导出的 tool step 输入,例如默认 app 群组 roomId。 */
  prepareToolStep?(step: WorkflowToolStepInput, scope: WorkflowCreateScope): WorkflowToolStepInput;
  /** 校验 tool step 的运行期必要输入,避免生成导入成功但运行必失败的 routine。 */
  validateToolInput?(step: WorkflowToolStepInput, scope: WorkflowCreateScope): string | undefined;
  /**
   * 创建 routine knowledge document 并落盘,返回 knowledgeId。
   * R2:本方法负责 slug/vaultPath 去重(它知道自己落盘目录里已有哪些文件),保证两次同名生成
   * 不产生"两 doc 同 vaultPath、body 不一致"。工具层只传 title,不预测 slug。
   */
  writeRoutineDocument(input: { title: string; body: string }): { knowledgeId: string };
  writeWorkflowFlow?(input: WorkflowFlowMirrorInput): WorkflowFlowMirrorResult | undefined;
}

export interface WorkflowCreateScope {
  appId?: string;
}

export interface WorkflowFlowApproval {
  flowId: string;
  stepId: string;
}

export interface WorkflowToolStepInput {
  toolId: string;
  roomId?: string;
  input?: JsonValue;
}

export interface WorkflowFlowMirrorInput {
  appId: string;
  knowledgeId: string;
  title: string;
  description?: string;
  steps: RoutineStep[];
  bodyMarkdown?: string;
}

export interface WorkflowFlowMirrorResult {
  mirrored: boolean;
  path?: string;
  warning?: string;
}

// 高危动作清单(可配置常量)。只按真实 toolId/命令判定,不从自由文本 prompt 猜执行意图。
const HIGH_RISK_TOOL_PATTERNS = [
  /drama-ops[\s-]+strategy-?execute/i,
  /drama-ops[\s-]+auto-?ads-?create/i,
  /auto-?ads-?create/i,
  /strategy-?execute/i,
  /ads[\s-]*create/i,
];

interface HighRiskAssessment {
  /** 每个高危 step 在 steps 数组里的下标。 */
  highRiskStepIndices: number[];
  /** 第一个 flow 审批步(带 flowApproval)的下标,没有为 -1。 */
  firstFlowApprovalIndex: number;
}

function assessSteps(steps: RoutineStep[]): HighRiskAssessment {
  const highRiskStepIndices: number[] = [];
  let firstFlowApprovalIndex = -1;
  steps.forEach((step, index) => {
    if (step.flowApproval && firstFlowApprovalIndex < 0) {
      firstFlowApprovalIndex = index;
    }
    const toolId = step.toolId ?? "";
    const isHighRisk = HIGH_RISK_TOOL_PATTERNS.some((pattern) => pattern.test(toolId));
    if (isHighRisk) highRiskStepIndices.push(index);
  });
  return { highRiskStepIndices, firstFlowApprovalIndex };
}

interface WorkflowStepInput {
  title: string;
  toolId?: string;
  memberId?: string;
  roomId?: string;
  prompt?: string;
  input?: JsonValue;
  when?: RoutineStepCondition;
  approval?: { mode: string; reason: string };
  flowApproval?: WorkflowFlowApproval;
}

interface WorkflowCreateInput {
  appId?: string;
  title: string;
  description?: string;
  steps: WorkflowStepInput[];
  schedule?: RoutineSchedule;
  scheduleError?: string;
  bodyMarkdown?: string;
}

export function createWorkflowCreateTool(
  spec: import("../core.js").ToolSpec,
  context: WorkflowCreateToolContext,
): ToolDefinition<JsonObject, JsonValue> {
  return {
    spec,
    async execute(input): Promise<ToolResult<JsonValue>> {
      const payload = readPayload(input);
      if (!payload.title) return { ok: false, error: "title_required" };
      if (payload.steps.length === 0) return { ok: false, error: "steps_required" };
      if (payload.scheduleError) return { ok: false, error: payload.scheduleError };

      // 构造 routineSteps,同时校验:每步必须有 toolId/memberId/flowApproval 之一(F1)。
      const routineSteps: RoutineStep[] = [];
      for (const [index, step] of payload.steps.entries()) {
        if (!step.toolId && !step.memberId && !step.flowApproval) {
          return { ok: false, error: `step_needs_target:${index}` };
        }
        // R3:approval 与 parser 同源校验(approvalSchema 即 routine-file.ts 用的同一 zod schema)。
        // 这样 workflow.create 写出的内容 parser 一定能读,不会"生成成功、parse 失败"。
        if (step.approval) {
          const approvalCheck = approvalSchema.safeParse(step.approval);
          if (!approvalCheck.success) {
            return {
              ok: false,
              error: `approval_invalid:${index}:${approvalCheck.error.issues[0]?.message ?? "invalid"}`,
            };
          }
        }
        if (step.flowApproval) {
          const flowApprovalError = context.validateFlowApproval?.(step.flowApproval, payload);
          if (flowApprovalError) {
            return { ok: false, error: flowApprovalError };
          }
        }
        const preparedToolStep = step.toolId
          ? context.prepareToolStep?.(
              {
                toolId: step.toolId,
                ...(step.roomId ? { roomId: step.roomId } : {}),
                ...(step.input !== undefined ? { input: step.input } : {}),
              },
              payload,
            )
          : undefined;
        const resolvedRoomId = preparedToolStep?.roomId ?? step.roomId;
        const resolvedInput = preparedToolStep?.input !== undefined ? preparedToolStep.input : step.input;
        routineSteps.push({
          id: `step_${index + 1}`,
          title: step.title || step.prompt?.slice(0, 60) || `Step ${index + 1}`,
          ...(step.toolId ? { toolId: step.toolId } : {}),
          ...(step.memberId ? { memberId: step.memberId } : {}),
          ...(resolvedRoomId ? { roomId: resolvedRoomId } : {}),
          ...(step.prompt ? { prompt: step.prompt } : {}),
          ...(resolvedInput !== undefined ? { input: resolvedInput } : {}),
          ...(step.when ? { when: step.when } : {}),
          ...(step.approval ? { approval: { mode: step.approval.mode as never, reason: step.approval.reason } } : {}),
          ...(step.flowApproval ? { flowApproval: step.flowApproval } : {}),
        });
      }

      // R0 F3 确定性高危校验(必须在 member/tool 注册校验之前)。
      // 高危意图 step 必须在它【之前】存在一个 flow 审批步(带 flowApproval);engine approval 不算。
      const assessment = assessSteps(routineSteps);
      if (assessment.highRiskStepIndices.length > 0) {
        if (assessment.firstFlowApprovalIndex < 0) {
          return {
            ok: false,
            error: `high_risk_without_flow_approval:${assessment.highRiskStepIndices.join(",")}`,
          };
        }
        // 每个 high-risk step 都必须在第一个 flow 审批步之后。
        const offending = assessment.highRiskStepIndices.filter((i) => i < assessment.firstFlowApprovalIndex);
        if (offending.length > 0) {
          return {
            ok: false,
            error: `high_risk_before_flow_approval:${offending.join(",")}`,
          };
        }
      }

      // member/tool 注册校验(高危校验之后)。R1:成员校验由 context.validateMember 做 runnable+范围。
      for (const step of routineSteps) {
        if (step.toolId) {
          const toolError = context.validateTool(step.toolId);
          if (toolError) return { ok: false, error: toolError };
          const toolInputError = context.validateToolInput?.(
            {
              toolId: step.toolId,
              ...(step.roomId ? { roomId: step.roomId } : {}),
              ...(step.input !== undefined ? { input: step.input } : {}),
            },
            payload,
          );
          if (toolInputError) return { ok: false, error: toolInputError };
        }
        if (step.memberId) {
          const memberError = context.validateMember(step.memberId, payload);
          if (memberError) return { ok: false, error: memberError };
        }
      }

      const body = serializeRoutineFile(
        {
          title: payload.title,
          ...(payload.description ? { description: payload.description } : {}),
          trigger: "manual",
          ...(payload.schedule ? { schedule: payload.schedule } : {}),
          steps: routineSteps,
        },
        payload.bodyMarkdown ?? "",
      );
      // R2:slug/vaultPath 去重由 context.writeRoutineDocument 负责(它感知落盘目录已存在文件)。
      const { knowledgeId } = context.writeRoutineDocument({ title: payload.title, body });
      const flow = payload.appId
        ? context.writeWorkflowFlow?.({
            appId: payload.appId,
            knowledgeId,
            title: payload.title,
            ...(payload.description ? { description: payload.description } : {}),
            steps: routineSteps,
            ...(payload.bodyMarkdown ? { bodyMarkdown: payload.bodyMarkdown } : {}),
          })
        : undefined;

      return {
        ok: true,
        value: {
          knowledgeId,
          ...(flow?.path ? { flowPath: flow.path } : {}),
          ...(payload.appId ? { flowMirrored: Boolean(flow?.mirrored && flow.path) } : {}),
          ...(payload.appId && !flow ? { warning: "workflow_flow_mirror_unavailable" } : {}),
          ...(flow?.warning ? { warning: flow.warning } : {}),
          title: payload.title,
          stepCount: routineSteps.length,
          ...(assessment.highRiskStepIndices.length > 0 ? { highRisk: true } : {}),
        } as unknown as JsonValue,
      };
    },
  };
}

// R2:slug/vaultPath 去重逻辑在 create-opengrove 的 writeRoutineDocument 实现里
// (那里能真实感知落盘目录已存在文件)。工具层只传 title,不预测 slug。

function readPayload(input: JsonObject): WorkflowCreateInput {
  const appId = typeof input.appId === "string" ? input.appId.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const steps = Array.isArray(input.steps)
    ? input.steps.map(readStep).filter((s): s is WorkflowStepInput => s !== null)
    : [];
  const schedule = readSchedule(input.schedule);
  const bodyMarkdown = typeof input.bodyMarkdown === "string" ? input.bodyMarkdown : "";
  const result: WorkflowCreateInput = {
    ...(appId ? { appId } : {}),
    title,
    steps,
    ...(schedule.ok && schedule.value ? { schedule: schedule.value } : {}),
    ...(!schedule.ok ? { scheduleError: schedule.error } : {}),
    bodyMarkdown,
  };
  if (description) result.description = description;
  return result;
}

function readStep(value: unknown): WorkflowStepInput | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title : "";
  const toolId = typeof obj.toolId === "string" ? obj.toolId : undefined;
  const memberId = typeof obj.memberId === "string" ? obj.memberId : undefined;
  const roomId = typeof obj.roomId === "string" ? obj.roomId : undefined;
  const prompt = typeof obj.prompt === "string" ? obj.prompt : undefined;
  const approval = readApproval(obj.approval);
  const when = readWhen(obj.when);
  const flowApproval = readFlowApproval(obj.flowApproval);
  const input = (obj.input !== undefined ? obj.input : undefined) as JsonValue | undefined;
  return {
    title,
    ...(toolId ? { toolId } : {}),
    ...(memberId ? { memberId } : {}),
    ...(roomId ? { roomId } : {}),
    ...(prompt ? { prompt } : {}),
    ...(approval ? { approval } : {}),
    ...(flowApproval ? { flowApproval } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(when ? { when } : {}),
  };
}

function readWhen(value: unknown): RoutineStepCondition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const stepId = typeof obj.stepId === "string" ? obj.stepId.trim() : "";
  if (!stepId) return undefined;
  const path = typeof obj.path === "string" && obj.path.trim() ? obj.path.trim() : undefined;
  const operator =
    obj.operator === "truthy" ||
    obj.operator === "equals" ||
    obj.operator === "notEquals" ||
    obj.operator === "gt" ||
    obj.operator === "gte" ||
    obj.operator === "lt" ||
    obj.operator === "lte"
      ? obj.operator
      : undefined;
  return {
    stepId,
    ...(path ? { path } : {}),
    ...(operator ? { operator } : {}),
    ...(obj.value !== undefined ? { value: obj.value as JsonValue } : {}),
  };
}

function readApproval(value: unknown): { mode: string; reason: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const mode = obj.mode;
  if (mode !== "allow" && mode !== "ask" && mode !== "deny") return undefined;
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return { mode, reason };
}

function readFlowApproval(value: unknown): WorkflowFlowApproval | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const flowId = typeof obj.flowId === "string" ? obj.flowId : "";
  const stepId = typeof obj.stepId === "string" ? obj.stepId : "";
  if (!flowId || !stepId) return undefined;
  return { flowId, stepId };
}

type ScheduleReadResult = { ok: true; value?: RoutineSchedule } | { ok: false; error: string };

function readSchedule(value: unknown): ScheduleReadResult {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== "object") return { ok: false, error: "schedule_invalid" };
  const obj = value as Record<string, unknown>;
  const rawEveryMinutes = obj.everyMinutes;
  const everyMinutes =
    typeof rawEveryMinutes === "number"
      ? rawEveryMinutes
      : typeof rawEveryMinutes === "string" && rawEveryMinutes.trim()
        ? Number(rawEveryMinutes)
        : undefined;
  const at = typeof obj.at === "string" ? obj.at : "";
  const daysOfWeek = Array.isArray(obj.daysOfWeek)
    ? obj.daysOfWeek.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6)
    : undefined;
  if (everyMinutes !== undefined) {
    if (at) return { ok: false, error: "schedule_invalid:choose_at_or_everyMinutes" };
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 24 * 60) {
      return { ok: false, error: "schedule_invalid:everyMinutes_out_of_range" };
    }
    return { ok: true, value: { everyMinutes, ...(daysOfWeek?.length ? { daysOfWeek } : {}) } };
  }
  if (!/^\d{2}:\d{2}$/.test(at)) return { ok: false, error: "schedule_invalid:at_must_be_HH_MM" };
  const hour = Number(at.slice(0, 2));
  const minute = Number(at.slice(3, 5));
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { ok: false, error: "schedule_invalid:at_out_of_range" };
  }
  return { ok: true, value: { at, ...(daysOfWeek?.length ? { daysOfWeek } : {}) } };
}

/**
 * 默认落盘实现:把 .routine.md 写到 knowledgeVaultRoot()/OpenGrove/routines/<slug>.routine.md。
 * R2:内部 dedupe slug(检测同名文件加 -2/-3 后缀),保证两次同名生成不两 doc 同 vaultPath、body 不一致。
 * 与现有知识库系统同口径(knowledgeVaultRoot 基于 process.cwd)。createOpenGrove 注入;测试可注入内存版。
 */
export function writeRoutineFileToVault(input: { title: string; body: string; slug?: string }): { slug: string } {
  const dir = resolve(knowledgeVaultRoot(), APP_VAULT_ROOT_NAME, "routines");
  mkdirSync(dir, { recursive: true });
  const slug = input.slug ?? dedupeRoutineSlug(input.title);
  const filePath = resolve(dir, `${slug}.routine.md`);
  writeFileSync(filePath, input.body, "utf8");
  return { slug };
}

export function workflowKnowledgeInitiator(knowledgeId: string): string {
  return `workflow:${knowledgeId}`;
}

export function writeWorkflowFlowFileToWorkspace(input: {
  workspaceRoot: string;
  title: string;
  knowledgeId: string;
  steps: RoutineStep[];
  description?: string;
  bodyMarkdown?: string;
}): WorkflowFlowMirrorResult {
  const relativePath = dedupeWorkflowFlowRelativePath(input.workspaceRoot, input.title);
  const filePath = resolve(input.workspaceRoot, relativePath);
  mkdirSync(resolve(input.workspaceRoot, "flows"), { recursive: true });
  writeFileSync(
    filePath,
    serializeWorkflowFlowFile({
      title: input.title,
      knowledgeId: input.knowledgeId,
      steps: input.steps,
      ...(input.description ? { description: input.description } : {}),
      ...(input.bodyMarkdown ? { bodyMarkdown: input.bodyMarkdown } : {}),
    }),
    "utf8",
  );
  return { mirrored: true, path: relativePath };
}

export function serializeWorkflowFlowFile(input: {
  title: string;
  knowledgeId: string;
  steps: RoutineStep[];
  description?: string;
  bodyMarkdown?: string;
  now?: string;
}): string {
  const now = input.now ?? new Date().toISOString();
  const frontmatter: FlowFrontmatter = {
    flow: "v1",
    kind: "definition",
    title: input.title,
    status: "pending",
    initiator: workflowKnowledgeInitiator(input.knowledgeId),
    updated: now,
    steps: input.steps.map(workflowStepToFlowStep),
  };
  const body = input.bodyMarkdown?.trim()
    ? input.bodyMarkdown
    : [
        `# ${input.title}`,
        ...(input.description ? ["", input.description] : []),
        "",
        "Generated by workflow.create.",
        "",
      ].join("\n");
  return serializeFlowMarkdown(frontmatter, body);
}

function workflowStepToFlowStep(step: RoutineStep): FlowStep {
  return {
    id: step.id,
    title: step.title,
    owner: step.flowApproval ? "user" : (step.memberId ?? step.toolId ?? step.capabilityId ?? step.skillId ?? "runner"),
    status: "pending",
    ...(step.flowApproval ? { blocking: true } : {}),
  };
}

function dedupeWorkflowFlowRelativePath(workspaceRoot: string, title: string): string {
  const base = safePathSegment(title);
  let candidate = `flows/${base}.flow.md`;
  let suffix = 2;
  while (existsSync(resolve(workspaceRoot, candidate))) {
    candidate = `flows/${base}-${suffix}.flow.md`;
    suffix += 1;
  }
  return candidate;
}

// R2:slug 去重——检测落盘目录已存在同名文件,存在则加 -2/-3 后缀。选加后缀而非报错(规格 §5):用户重复生成同名是正常操作。
export function dedupeRoutineSlug(title: string): string {
  const dir = resolve(knowledgeVaultRoot(), APP_VAULT_ROOT_NAME, "routines");
  mkdirSync(dir, { recursive: true });
  const base = safePathSegment(title);
  let candidate = base;
  let suffix = 2;
  const existing = readdirSync(dir);
  const existingSet = new Set(existing);
  while (existingSet.has(`${candidate}.routine.md`)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}
