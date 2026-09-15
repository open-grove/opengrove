import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";
import { hostRequestErrors } from "./host-errors.js";
import {
  approvalStatusSchema,
  questionStatusSchema,
  approvalRequestSchema,
  questionRequestSchema,
} from "./interaction-records.js";

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
