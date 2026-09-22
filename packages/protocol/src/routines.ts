import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";
import { hostErrorSchema, hostRequestErrors } from "./host-errors.js";
import { permissionRequirementSchema, policyRuleSchema } from "./workspace-records.js";
import { routineRunResultSchema, routineRunSummarySchema } from "./routine-records.js";

export const routineScheduleSchema = z.object({
  at: z.string().optional(),
  everyMinutes: z.number().int().min(1).max(1440).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  lastFiredAt: z.string().optional(),
});
// Keep the existing route's schedule normalization and cross-field validation.
// Numeric strings are accepted at this protocol adapter boundary for existing clients.
const scheduleInputSchema = routineScheduleSchema.omit({ lastFiredAt: true }).extend({
  everyMinutes: z.union([z.number(), z.string()]).optional(),
});
export const routineStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  toolId: z.string().optional(),
  capabilityId: z.string().optional(),
  skillId: z.string().optional(),
  memberId: z.string().optional(),
  roomId: z.string().optional(),
  prompt: z.string().optional(),
  input: z.json().optional(),
  when: z
    .object({
      stepId: z.string(),
      path: z.string().optional(),
      operator: z.enum(["truthy", "equals", "notEquals", "gt", "gte", "lt", "lte"]).optional(),
      value: z.json().optional(),
    })
    .optional(),
  approval: permissionRequirementSchema.optional(),
  flowApproval: z.object({ flowId: z.string(), stepId: z.string() }).optional(),
});
export const routineSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  sourceKnowledgeId: z.string().optional(),
  status: z.enum(["draft", "active", "paused", "needs_repair", "archived"]),
  trigger: z.enum(["manual", "schedule", "event"]),
  schedule: routineScheduleSchema.optional(),
  capabilityIds: z.array(z.string()),
  steps: z.array(routineStepSchema),
  approvalRules: z.array(policyRuleSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRun: routineRunSummarySchema.optional(),
});
const mutation = { status: 200, body: z.object({ ok: z.literal(true), routine: routineSchema }) } as const;
const errors = [
  ...hostRequestErrors,
  { status: 404, body: hostErrorSchema },
  { status: 409, body: hostErrorSchema },
] as const;
export const listRoutinesOperation = defineHostOperation({
  id: "routine.routine.list",
  summary: "List workflows",
  description: "Read persisted local workflows.",
  method: "GET",
  path: "/routines",
  risk: "read",
  query: z.object({
    status: routineSchema.shape.status.optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  success: { status: 200, body: z.object({ ok: z.literal(true), routines: z.array(routineSchema) }) },
  errors,
});
export const createRoutineOperation = defineHostOperation({
  id: "routine.routine.create",
  summary: "Create a workflow",
  description: "Create a workflow from explicit tool or Employee steps, without requiring an App package.",
  method: "POST",
  path: "/routines",
  risk: "write",
  body: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(["draft", "active"]).default("active"),
    trigger: z.enum(["manual", "schedule", "event"]).default("manual"),
    schedule: scheduleInputSchema.optional(),
    steps: z.array(routineStepSchema.partial({ id: true, title: true })).min(1),
  }),
  success: mutation,
  errors,
});
export const importRoutineOperation = defineHostOperation({
  id: "routine.routine.import",
  summary: "Import a workflow definition",
  description: "Validate and import an inline .routine.md definition.",
  method: "POST",
  path: "/routines/import",
  risk: "write",
  body: z.object({ content: z.string().min(1).optional(), knowledgeId: z.string().min(1).optional() }),
  success: mutation,
  errors,
});
export const scheduleRoutineOperation = defineHostOperation({
  id: "routine.routine.schedule",
  summary: "Schedule or unschedule a workflow",
  description: "Set local Host scheduling. The Host must remain running; this is not a distributed scheduler.",
  method: "POST",
  path: "/routines/{routineId}/schedule",
  risk: "write",
  params: z.object({ routineId: z.string().min(1) }),
  body: z.object({
    trigger: z.enum(["manual", "schedule"]).optional(),
    enabled: z.boolean().optional(),
    schedule: scheduleInputSchema.optional(),
  }),
  success: mutation,
  errors,
});
export const runRoutineOperation = defineHostOperation({
  id: "routine.routine.run",
  summary: "Execute a workflow",
  description:
    "Execute the existing workflow runner and return its result, including a pause for approval. Client disconnection is not cancellation.",
  method: "POST",
  path: "/routines/{routineId}/run",
  risk: "write",
  params: z.object({ routineId: z.string().min(1) }),
  success: { status: 200, body: routineRunResultSchema.extend({ ok: z.literal(true) }) },
  errors,
});
export const routineOperationGroup = defineHostOperationGroup({
  id: "routine",
  title: "Workflows",
  description: "Compose and schedule local Agent work.",
  resources: [
    defineHostOperationResource({
      id: "routine",
      title: "Workflows",
      description: "Workflow definitions and execution.",
      operations: [
        listRoutinesOperation,
        createRoutineOperation,
        importRoutineOperation,
        scheduleRoutineOperation,
        runRoutineOperation,
      ] as const,
    }),
  ] as const,
});
