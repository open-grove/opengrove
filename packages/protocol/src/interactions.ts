import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";
import { hostRequestErrors } from "./host-errors.js";
import { jsonObjectSchema } from "./run-records.js";

export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "canceled"]);
export const questionStatusSchema = z.enum(["pending", "answered", "declined", "canceled"]);
export const agentRequestSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("kernel.native"), kernelId: z.string() }),
  z.object({ type: z.literal("host") }),
  z.object({ type: z.literal("unknown") }),
]);
export const approvalResumeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), runId: z.string().optional() }),
  z.object({
    type: z.literal("routine.step"),
    routineId: z.string(),
    stepId: z.string(),
    runId: z.string(),
    stepOutputs: jsonObjectSchema.optional(),
  }),
  z.object({
    type: z.literal("kernel.native"),
    kernelId: z.string(),
    runId: z.string(),
    continuation: z.literal("same-loop"),
  }),
]);
const interactionFields = {
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  input: z.json().optional(),
  response: z.json().optional(),
  resume: approvalResumeSchema.optional(),
  nativeRequestId: z.string().optional(),
  deadlineAt: z.string().optional(),
  isBlocking: z.boolean().optional(),
  autoResolutionMs: z.number().optional(),
};
export const approvalRequestSchema = z.object({
  ...interactionFields,
  kind: z.enum([
    "tool",
    "command",
    "file_change",
    "permission_scope",
    "routine_step",
    "memory_write",
    "browser_action",
    "computer_action",
  ]),
  reason: z.string(),
  status: approvalStatusSchema,
  toolId: z.string().optional(),
  capabilityId: z.string().optional(),
  skillId: z.string().optional(),
});
export const questionRequestSchema = z.object({
  ...interactionFields,
  prompt: z.string(),
  status: questionStatusSchema,
  source: agentRequestSourceSchema.optional(),
});
export const listApprovalsOperation = defineHostOperation({
  id: "interaction.approval.list",
  summary: "List approvals",
  description:
    "List Host approval summaries, newest first. Includes bounded request input and decision response; continuation internals are omitted.",
  method: "GET",
  path: "/approvals",
  risk: "read",
  query: z.object({ status: approvalStatusSchema.optional(), limit: z.number().int().min(1).max(500).default(100) }),
  success: {
    status: 200,
    body: z.object({ ok: z.literal(true), approvals: z.array(approvalRequestSchema.omit({ resume: true })) }),
  },
  errors: hostRequestErrors,
});
export type ListApprovalsOperation = typeof listApprovalsOperation;
export const listQuestionsOperation = defineHostOperation({
  id: "interaction.question.list",
  summary: "List questions",
  description:
    "List Host question summaries, newest first. Includes bounded choices and answers; continuation internals are omitted.",
  method: "GET",
  path: "/questions",
  risk: "read",
  query: z.object({ status: questionStatusSchema.optional(), limit: z.number().int().min(1).max(500).default(100) }),
  success: {
    status: 200,
    body: z.object({ ok: z.literal(true), questions: z.array(questionRequestSchema.omit({ resume: true })) }),
  },
  errors: hostRequestErrors,
});
export type ListQuestionsOperation = typeof listQuestionsOperation;
export const interactionOperationGroup = defineHostOperationGroup({
  id: "interaction",
  title: "Approvals and questions",
  description: "Inspect and resolve requests waiting for human input.",
  resources: [
    defineHostOperationResource({
      id: "approval",
      title: "Approvals",
      description: "Permission requests and decisions.",
      operations: [listApprovalsOperation] as const,
    }),
    defineHostOperationResource({
      id: "question",
      title: "Questions",
      description: "Questions and answers.",
      operations: [listQuestionsOperation] as const,
    }),
  ] as const,
});
