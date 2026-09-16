import { hostSchemaRegistry } from "./schema-registry.js";
import { z } from "zod";
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
export const approvalRequestSchema = z
  .object({
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
  })
  .register(hostSchemaRegistry, { id: "Approval" });
export const questionRequestSchema = z
  .object({
    ...interactionFields,
    prompt: z.string(),
    status: questionStatusSchema,
    source: agentRequestSourceSchema.optional(),
  })
  .register(hostSchemaRegistry, { id: "Question" });
