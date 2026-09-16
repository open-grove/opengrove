import { hostSchemaRegistry } from "./schema-registry.js";
import { z } from "zod";
import { runLifecycleSchema } from "./run-lifecycle.js";

export const activitySpaceSchema = z.enum(["browser", "chat", "local", "api", "computer"]);
export const sessionStatusSchema = z.enum(["active", "idle", "archived"]);
export const executionKindSchema = z.enum([
  "loop",
  "model",
  "reasoning",
  "tool_call",
  "approval",
  "question",
  "planning",
  "artifact",
  "memory",
  "error",
]);
export const jsonObjectSchema = z.record(z.string(), z.json());
export const sessionRecordSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    activity: activitySpaceSchema.optional(),
    status: sessionStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    activeRunId: z.string().optional(),
    latestRunId: z.string().optional(),
    runIds: z.array(z.string()),
    lastUserInput: z.string().optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .register(hostSchemaRegistry, { id: "Session" });
export const runRecordSchema = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    activity: activitySpaceSchema,
    lifecycle: runLifecycleSchema,
    input: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    modelId: z.string().optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    problem: z.object({ incidentId: z.string(), code: z.string() }).optional(),
    pausedAt: z.string().optional(),
    resumedAt: z.string().optional(),
    pauseReason: z.string().optional(),
    lastApprovalId: z.string().optional(),
    lastQuestionId: z.string().optional(),
    resumeCount: z.number().int().nonnegative(),
    approvalIds: z.array(z.string()),
    questionIds: z.array(z.string()),
    toolIds: z.array(z.string()),
    eventCount: z.number().int().nonnegative(),
  })
  .register(hostSchemaRegistry, { id: "Run" });
export const executionRecordSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    sessionId: z.string().optional(),
    kind: executionKindSchema,
    eventType: z.string().describe("The recorded Agent event type."),
    title: z.string(),
    at: z.string(),
    status: z.string().optional(),
    toolId: z.string().optional(),
    approvalId: z.string().optional(),
    questionId: z.string().optional(),
    artifactId: z.string().optional(),
    data: jsonObjectSchema.optional(),
  })
  .register(hostSchemaRegistry, { id: "Execution" });
