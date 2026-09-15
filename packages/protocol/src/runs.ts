import { z } from "zod";
import {
  activitySpaceSchema,
  sessionStatusSchema,
  executionKindSchema,
  sessionRecordSchema,
  runRecordSchema,
  executionRecordSchema,
} from "./run-records.js";
import { a2aTaskStateSchema } from "./task-state.js";
import { askCancelContract, askGuideContract, askCompactContract } from "./ask-controls.js";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";
import { hostRequestErrors } from "./host-errors.js";

export const cancelDirectRunOperation = defineHostOperation({
  id: "run.direct.cancel",
  summary: "Cancel a direct run",
  description:
    "Cancel an active direct streaming run by run ID or thread ID. A missing or completed run returns cancelled=false. Room message runs use room message cancel.",
  method: "POST",
  path: "/ask/cancel",
  risk: "write",
  body: askCancelContract.request,
  success: { status: 200, body: askCancelContract.response },
  errors: hostRequestErrors,
});
export type CancelDirectRunOperation = typeof cancelDirectRunOperation;
export const guideDirectRunOperation = defineHostOperation({
  id: "run.direct.guide",
  summary: "Guide an active direct run",
  description:
    "Send an instruction to an active direct streaming run. The selected Kernel determines whether steering is supported.",
  method: "POST",
  path: "/ask/guide",
  risk: "write",
  body: askGuideContract.request,
  success: { status: 200, body: askGuideContract.response },
  errors: hostRequestErrors,
});
export type GuideDirectRunOperation = typeof guideDirectRunOperation;
export const compactDirectSessionOperation = defineHostOperation({
  id: "run.direct.compact",
  summary: "Compact a direct session",
  description:
    "Ask the session's Kernel to compact its context. Kernel support and its confirmed result remain authoritative.",
  method: "POST",
  path: "/ask/compact",
  risk: "write",
  body: askCompactContract.request,
  success: { status: 200, body: askCompactContract.response },
  errors: hostRequestErrors,
});
export type CompactDirectSessionOperation = typeof compactDirectSessionOperation;
export const listSessionsOperation = defineHostOperation({
  id: "run.session.list",
  summary: "List recorded sessions",
  description: "List persisted Host sessions, optionally filtered by activity and status.",
  method: "GET",
  path: "/sessions",
  risk: "read",
  query: z.object({
    status: sessionStatusSchema.optional(),
    activity: activitySpaceSchema.optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  success: { status: 200, body: z.object({ ok: z.literal(true), sessions: z.array(sessionRecordSchema) }) },
  errors: hostRequestErrors,
});
export type ListSessionsOperation = typeof listSessionsOperation;
const unchangedRecordsSchema = z.object({ ok: z.literal(true), unchanged: z.literal(true), revision: z.string() });
export const listRunsOperation = defineHostOperation({
  id: "run.run.list",
  summary: "List recorded runs",
  description:
    "List persisted runs by session and task state. Pass the previous revision to receive unchanged=true when the query result is current.",
  method: "GET",
  path: "/runs",
  risk: "read",
  query: z.object({
    sessionId: z.string().optional(),
    taskState: a2aTaskStateSchema.optional(),
    limit: z.number().int().min(1).max(1000).default(200),
    afterRevision: z.string().optional(),
  }),
  success: {
    status: 200,
    body: z.union([
      unchangedRecordsSchema,
      z.object({ ok: z.literal(true), runs: z.array(runRecordSchema), revision: z.string() }),
    ]),
  },
  errors: hostRequestErrors,
});
export type ListRunsOperation = typeof listRunsOperation;
export const listExecutionsOperation = defineHostOperation({
  id: "run.execution.list",
  summary: "List execution steps",
  description:
    "List recorded execution steps by session, run, or step kind. A matching revision returns unchanged=true.",
  method: "GET",
  path: "/executions",
  risk: "read",
  query: z.object({
    sessionId: z.string().optional(),
    runId: z.string().optional(),
    kind: executionKindSchema.optional(),
    limit: z.number().int().min(1).max(1000).default(200),
    afterRevision: z.string().optional(),
  }),
  success: {
    status: 200,
    body: z.union([
      unchangedRecordsSchema,
      z.object({ ok: z.literal(true), executions: z.array(executionRecordSchema), revision: z.string() }),
    ]),
  },
  errors: hostRequestErrors,
});
export type ListExecutionsOperation = typeof listExecutionsOperation;
export const runOperationGroup = defineHostOperationGroup({
  id: "run",
  title: "Execution",
  description: "Run records, direct execution, and session controls.",
  resources: [
    defineHostOperationResource({
      id: "run",
      title: "Runs",
      description: "Query persisted run outcomes.",
      operations: [listRunsOperation] as const,
    }),
    defineHostOperationResource({
      id: "session",
      title: "Sessions",
      description: "Query persisted sessions.",
      operations: [listSessionsOperation] as const,
    }),
    defineHostOperationResource({
      id: "execution",
      title: "Execution steps",
      description: "Query recorded execution steps.",
      operations: [listExecutionsOperation] as const,
    }),
    defineHostOperationResource({
      id: "direct",
      title: "Direct sessions",
      description: "Control direct streaming execution.",
      operations: [cancelDirectRunOperation, guideDirectRunOperation, compactDirectSessionOperation] as const,
    }),
  ] as const,
});
