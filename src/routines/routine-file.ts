import { z } from "zod";
import type { JsonValue, PermissionMode, Routine, RoutineSchedule, RoutineStep } from "../core.js";

// ===== routine 文件格式契约(P1,parser + P2 serializer 共用) =====
// .routine.md 文件 = 唯一定界格式,杜绝"如/或":
//   第一行 `---\n`，接一段 JSON 对象({ title, description?, trigger, schedule?, steps[] })，
//   再 `---`，之后是给人看的 markdown 正文（不参与执行）。
// 为什么这样定：body 以 `---\n` 起始，正好命中现有 knowledgeDocumentToMarkdownFile 的"原样写入"分支
// (knowledge-files.ts:952)→ P2 落盘原封不动、无需改 materializer；本文件用同一契约切出 JSON。

const ROUTINE_FILE_DELIMITER = "---";
const SCHEDULE_TIME_PATTERN = /^\d{2}:\d{2}$/;

const permissionModeSchema = z.enum(["allow", "ask", "deny"]);
const daysOfWeekSchema = z.array(z.number().int().min(0).max(6)).optional();
// R4:schedule.at 既要校验格式 HH:MM,也要校验范围(hour 0-23 / minute 0-59),
// 否则 99:99 / 24:00 能过(旧 /routines route 反而有范围校验)。
const wallClockScheduleSchema = z.object({
  at: z
    .string()
    .regex(SCHEDULE_TIME_PATTERN, "schedule.at must be HH:MM")
    .refine((at) => {
      const match = SCHEDULE_TIME_PATTERN.exec(at);
      if (!match) return true; // 格式已由 regex 拦
      const hour = Number(at.slice(0, 2));
      const minute = Number(at.slice(3, 5));
      return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
    }, "schedule.at hour must be 0-23 and minute 0-59"),
  daysOfWeek: daysOfWeekSchema,
});
const intervalScheduleSchema = z.object({
  everyMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  daysOfWeek: daysOfWeekSchema,
});
const scheduleSchema = z.union([wallClockScheduleSchema, intervalScheduleSchema]);

// approval 字段对齐 PermissionRequirement（mode + reason），可选。
// R3:导出让 workflow.create 复用同一 schema 校验自己即将写出的内容,保证"生成出来的一定能解析"。
export const approvalSchema = z.object({
  mode: permissionModeSchema,
  reason: z.string().min(1),
});

// R0:flow 审批步(rev5)。带 flowApproval 字段的 step 才算"flow 审批步"。
const flowApprovalSchema = z.object({
  flowId: z.string().min(1),
  stepId: z.string().min(1),
});

const stepInputSchema: z.ZodType<JsonValue> = z.unknown() as unknown as z.ZodType<JsonValue>;
const stepConditionSchema = z.object({
  stepId: z.string().min(1),
  path: z.string().min(1).optional(),
  operator: z.enum(["truthy", "equals", "notEquals", "gt", "gte", "lt", "lte"]).optional(),
  value: stepInputSchema.optional(),
});

// 单个 step：v1 必须有 toolId 或 memberId（不接受 skillId-only step，对齐 runner F1）。
const stepSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    toolId: z.string().min(1).optional(),
    capabilityId: z.string().min(1).optional(),
    memberId: z.string().min(1).optional(),
    roomId: z.string().min(1).optional(),
    prompt: z.string().optional(),
    input: stepInputSchema.optional(),
    when: stepConditionSchema.optional(),
    approval: approvalSchema.optional(),
    flowApproval: flowApprovalSchema.optional(),
  })
  .refine((step) => Boolean(step.toolId) || Boolean(step.memberId) || Boolean(step.flowApproval), {
    message: "each step must have a toolId, memberId, or flowApproval (skillId-only steps are not executable in v1)",
  });

const routineFileSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  trigger: z.enum(["manual", "schedule", "event"]).default("manual"),
  schedule: scheduleSchema.optional(),
  steps: z.array(stepSchema).min(1, "steps must contain at least one step"),
});

export type RoutineFileJson = z.infer<typeof routineFileSchema>;

export type ParseRoutineFileResult = { ok: true; routine: ParsedRoutineFile } | { ok: false; error: string };

export interface ParsedRoutineFile {
  title: string;
  description?: string;
  trigger: Routine["trigger"];
  schedule?: RoutineSchedule;
  steps: RoutineStep[];
  /** 正文（delimiter 之后的 markdown），给人看，不参与执行。 */
  body: string;
}

/**
 * 解析 .routine.md 文本：切出首尾 `---` 之间的 JSON 段 → JSON.parse → zod 严格校验。
 * 返回 ok=false 时 error 为人类可读的拒绝原因（导入期据此拒绝）。
 */
export function parseRoutineFile(text: string): ParseRoutineFileResult {
  const trimmedStart = text.replace(/^\uFEFF/, "");
  // 严格要求第一行就是 `---`。
  if (!trimmedStart.startsWith(`${ROUTINE_FILE_DELIMITER}\n`)) {
    return { ok: false, error: "routine_file_missing_frontmatter_delimiter" };
  }
  const afterFirstDelimiter = trimmedStart.slice(ROUTINE_FILE_DELIMITER.length + 1);
  const closingIndex = afterFirstDelimiter.indexOf(`\n${ROUTINE_FILE_DELIMITER}`);
  if (closingIndex < 0) {
    return { ok: false, error: "routine_file_missing_closing_delimiter" };
  }
  const jsonSegment = afterFirstDelimiter.slice(0, closingIndex);
  // closing delimiter 之后是正文（跳过 `\n---\n`）。
  const afterClosing = afterFirstDelimiter.slice(closingIndex + 1 + ROUTINE_FILE_DELIMITER.length);
  const body = afterClosing.startsWith("\n") ? afterClosing.slice(1) : afterClosing;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSegment);
  } catch {
    return { ok: false, error: "routine_file_frontmatter_not_json" };
  }

  const validated = routineFileSchema.safeParse(parsed);
  if (!validated.success) {
    const first = validated.error.issues[0];
    return {
      ok: false,
      error: `routine_file_validation_failed:${first?.path.join(".") ?? "root"}:${first?.message ?? "invalid"}`,
    };
  }

  const steps: RoutineStep[] = validated.data.steps.map((step) => ({
    id: step.id,
    title: step.title,
    ...(step.toolId ? { toolId: step.toolId } : {}),
    ...(step.capabilityId ? { capabilityId: step.capabilityId } : {}),
    ...(step.memberId ? { memberId: step.memberId } : {}),
    ...(step.roomId ? { roomId: step.roomId } : {}),
    ...(step.prompt ? { prompt: step.prompt } : {}),
    ...(step.input !== undefined ? { input: step.input } : {}),
    ...(step.when ? { when: step.when } : {}),
    ...(step.approval ? { approval: normalizeApproval(step.approval) } : {}),
    ...(step.flowApproval ? { flowApproval: step.flowApproval } : {}),
  }));

  return {
    ok: true,
    routine: {
      title: validated.data.title,
      ...(validated.data.description ? { description: validated.data.description } : {}),
      trigger: validated.data.trigger,
      ...(validated.data.schedule ? { schedule: validated.data.schedule } : {}),
      steps,
      body,
    },
  };
}

function normalizeApproval(approval: { mode: string; reason: string }): {
  mode: PermissionMode;
  reason: string;
} {
  return { mode: approval.mode as PermissionMode, reason: approval.reason };
}

/**
 * 把 routine 序列化为 .routine.md 内容（body 以 `---\n` 起，命中原样写入分支）。
 * P2 的 workflow.create 落盘走这个，保证 round-trip：serialize → parse 字段一致。
 */
export function serializeRoutineFile(
  routine: {
    title: string;
    description?: string;
    trigger?: Routine["trigger"];
    schedule?: RoutineSchedule;
    steps: RoutineStep[];
  },
  bodyMarkdown = "",
): string {
  const schedule = routine.schedule ? serializableSchedule(routine.schedule) : undefined;
  const frontmatter: RoutineFileJson = {
    title: routine.title,
    ...(routine.description ? { description: routine.description } : {}),
    trigger: routine.trigger ?? "manual",
    ...(schedule ? { schedule } : {}),
    steps: routine.steps.map((step) => {
      const out: Record<string, unknown> = { id: step.id, title: step.title };
      if (step.toolId) out.toolId = step.toolId;
      if (step.capabilityId) out.capabilityId = step.capabilityId;
      if (step.memberId) out.memberId = step.memberId;
      if (step.roomId) out.roomId = step.roomId;
      if (step.prompt) out.prompt = step.prompt;
      if (step.input !== undefined) out.input = step.input;
      if (step.when) out.when = step.when;
      if (step.approval) out.approval = step.approval;
      if (step.flowApproval) out.flowApproval = step.flowApproval;
      return out as unknown as RoutineFileJson["steps"][number];
    }),
  };
  const json = JSON.stringify(frontmatter, null, 2);
  const body = bodyMarkdown.trim();
  return body
    ? `${ROUTINE_FILE_DELIMITER}\n${json}\n${ROUTINE_FILE_DELIMITER}\n\n${body}\n`
    : `${ROUTINE_FILE_DELIMITER}\n${json}\n${ROUTINE_FILE_DELIMITER}\n`;
}

function serializableSchedule(schedule: RoutineSchedule): RoutineFileJson["schedule"] | undefined {
  const daysOfWeek = schedule.daysOfWeek?.length ? { daysOfWeek: schedule.daysOfWeek } : {};
  if (typeof schedule.everyMinutes === "number") {
    return { everyMinutes: schedule.everyMinutes, ...daysOfWeek };
  }
  if (schedule.at) {
    return { at: schedule.at, ...daysOfWeek };
  }
  return undefined;
}
