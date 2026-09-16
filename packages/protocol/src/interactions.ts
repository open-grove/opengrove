import { stateQueryLimit, hostQueryFilter } from "./compat/host-http.js";
import { routineRunResultSchema } from "./routine-records.js";
import { artifactRecordSchema, workingStateRecordSchema, toolResultSchema } from "./workspace-records.js";
import { sessionRecordSchema, runRecordSchema, executionRecordSchema } from "./run-records.js";
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
  query: z.object({ status: hostQueryFilter(approvalStatusSchema), limit: stateQueryLimit(100, 500) }),
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
  query: z.object({ status: hostQueryFilter(questionStatusSchema), limit: stateQueryLimit(100, 500) }),
  success: {
    status: 200,
    body: z.object({ ok: z.literal(true), questions: z.array(questionRequestSchema.omit({ resume: true })) }),
  },
  errors: hostRequestErrors,
});
export type ListQuestionsOperation = typeof listQuestionsOperation;
const interactionResolutionState = {
  ok: z.literal(true),
  alreadyResolved: z.boolean().optional(),
  questions: z.array(questionRequestSchema),
  artifacts: z.array(artifactRecordSchema),
  workingState: workingStateRecordSchema,
  sessions: z.array(sessionRecordSchema),
  runs: z.array(runRecordSchema),
  executions: z.array(executionRecordSchema),
};
export const approvalResolutionSchema = z.object({
  ...interactionResolutionState,
  approval: approvalRequestSchema,
  approvals: z.array(approvalRequestSchema),
  toolResult: toolResultSchema.optional(),
  routineResult: routineRunResultSchema.optional(),
});
export const questionResolutionSchema = z.object({ ...interactionResolutionState, question: questionRequestSchema });
export const interactionDecisionBodySchema = z.object({
  response: z.json().optional().describe("Structured decision response or answer."),
});
function approvalDecision<const T extends "approve" | "reject" | "cancel">(
  action: T,
  summary: string,
  risk: "write" | "high-risk-write",
) {
  return defineHostOperation({
    id: `interaction.approval.${action}`,
    summary,
    description:
      "Resolve an approval through its original Host execution. Matching repeated decisions are idempotent. Native requests require their producer to remain live.",
    method: "POST",
    path: `/approvals/{approvalId}/${action}`,
    risk,
    params: z.object({ approvalId: z.string().trim().min(1) }),
    body: interactionDecisionBodySchema,
    success: { status: 200, body: approvalResolutionSchema, schemaId: "ApprovalResolution" },
    errors: hostRequestErrors,
  });
}
export const approveInteractionOperation = approvalDecision("approve", "Approve a requested action", "high-risk-write");
export const rejectInteractionOperation = approvalDecision("reject", "Reject a requested action", "write");
export const cancelApprovalOperation = approvalDecision("cancel", "Cancel an approval request", "write");
export type ApprovalDecisionOperation =
  | typeof approveInteractionOperation
  | typeof rejectInteractionOperation
  | typeof cancelApprovalOperation;
function questionDecision<const T extends "answer" | "decline" | "cancel">(action: T, summary: string) {
  return defineHostOperation({
    id: `interaction.question.${action}`,
    summary,
    description:
      "Resolve a question through its original Host execution. Matching repeated decisions are idempotent. Native requests require their producer to remain live.",
    method: "POST",
    path: `/questions/{questionId}/${action}`,
    risk: "write",
    params: z.object({ questionId: z.string().trim().min(1) }),
    body: interactionDecisionBodySchema,
    success: { status: 200, body: questionResolutionSchema, schemaId: "QuestionResolution" },
    errors: hostRequestErrors,
  });
}
export const answerQuestionOperation = questionDecision("answer", "Answer a question");
export const declineQuestionOperation = questionDecision("decline", "Decline a question");
export const cancelQuestionOperation = questionDecision("cancel", "Cancel a question");
export type QuestionDecisionOperation =
  | typeof answerQuestionOperation
  | typeof declineQuestionOperation
  | typeof cancelQuestionOperation;
export const interactionOperationGroup = defineHostOperationGroup({
  id: "interaction",
  title: "Approvals and questions",
  description: "Inspect and resolve requests waiting for human input.",
  resources: [
    defineHostOperationResource({
      id: "approval",
      title: "Approvals",
      description: "Permission requests and decisions.",
      operations: [
        listApprovalsOperation,
        approveInteractionOperation,
        rejectInteractionOperation,
        cancelApprovalOperation,
      ] as const,
    }),
    defineHostOperationResource({
      id: "question",
      title: "Questions",
      description: "Questions and answers.",
      operations: [
        listQuestionsOperation,
        answerQuestionOperation,
        declineQuestionOperation,
        cancelQuestionOperation,
      ] as const,
    }),
  ] as const,
});
