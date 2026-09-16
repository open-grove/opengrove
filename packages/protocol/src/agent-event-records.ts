import { z } from "zod";
import { runLifecycleSchema } from "./run-lifecycle.js";
import { jsonObjectSchema } from "./run-records.js";
import { approvalRequestSchema, questionRequestSchema, agentRequestSourceSchema } from "./interaction-records.js";
import {
  sourceRefSchema,
  diagnosticProblemRefSchema,
  toolSpecSchema,
  toolResultSchema,
  skillManifestSchema,
  invokedSkillRecordSchema,
  skillExecutionContextSchema,
  packManifestSchema,
  capabilityManifestSchema,
  memoryRecordSchema,
} from "./workspace-records.js";

export const contextEnvelopeSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  summary: z.string(),
  promptBlock: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.enum([
        "page",
        "selection",
        "attachment",
        "computer",
        "artifact",
        "session",
        "execution",
        "task",
        "knowledge",
        "memory",
        "routine",
        "permission",
        "skill",
      ]),
      title: z.string(),
      text: z.string(),
      source: sourceRefSchema.optional(),
      score: z.number().optional(),
      data: jsonObjectSchema.optional(),
    }),
  ),
  budget: z.object({
    maxItems: z.number(),
    usedItems: z.number(),
    maxCharacters: z.number(),
    usedCharacters: z.number(),
    truncated: z.boolean(),
  }),
});
export const usageStatsSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  costUsd: z.number().optional(),
  latencyMs: z.number().optional(),
  contextWindowSize: z.number().optional(),
  contextUsedTokens: z.number().optional(),
  contextBreakdown: z.array(z.object({ category: z.string(), tokens: z.number() })).optional(),
});
const modelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  name: z.string().optional(),
});
const agentModelRequestTraceSchema = z.object({
  systemPrompt: z.string(),
  userInput: z.string(),
  modelId: z.string().optional(),
  session: z
    .object({
      provider: z.string(),
      sessionId: z.string(),
      persistent: z.boolean(),
      priorMessageCount: z.number(),
      priorMessages: z.array(modelMessageSchema),
      nativeSessionId: z.string().optional(),
    })
    .optional(),
  messages: z.array(modelMessageSchema).optional(),
  context: contextEnvelopeSchema.optional(),
  tools: z.array(toolSpecSchema),
  skills: z.array(skillManifestSchema),
  packs: z.array(packManifestSchema),
  capabilities: z.array(capabilityManifestSchema),
});
const reasoningIdentitySchema = z.object({ id: z.string(), kind: z.enum(["native", "summary"]), kernelId: z.string() });
function event<const T extends string, const P extends z.ZodRawShape>(type: T, payload: P) {
  return z.object({ type: z.literal(type), runId: z.string(), ...payload });
}
export const agentEventSchema = z.discriminatedUnion("type", [
  event("turn.started", { at: z.string() }),
  event("context.assembled", { context: contextEnvelopeSchema }),
  event("compaction.started", { at: z.string(), reason: z.string().optional(), item: z.json().optional() }),
  event("compaction.finished", { at: z.string(), summary: z.string().optional(), item: z.json().optional() }),
  event("model.requested", { request: agentModelRequestTraceSchema }),
  event("model.response", { response: z.object({ text: z.string(), usage: usageStatsSchema.optional() }) }),
  event("runtime.diagnostic", { at: z.string(), name: z.string(), data: jsonObjectSchema }),
  event("reasoning.started", { reasoning: reasoningIdentitySchema }),
  event("reasoning.completed", {
    reasoning: reasoningIdentitySchema.extend({
      text: z.string(),
      redacted: z.boolean().optional(),
      elapsedMs: z.number().optional(),
    }),
  }),
  event("assistant.delta", { text: z.string() }),
  event("assistant.final", {
    text: z.string(),
    at: z.string(),
    source: z.enum(["runtime", "adapter", "fallback"]).optional(),
  }),
  event("assistant.status", { text: z.string(), at: z.string(), data: jsonObjectSchema.optional() }),
  event("skill.discovered", { skills: z.array(skillManifestSchema) }),
  event("skill.invoked", { skill: skillManifestSchema, invocation: invokedSkillRecordSchema }),
  event("skill.loaded", {
    skillId: z.string(),
    contentPreview: z.string(),
    allowedTools: z.array(z.string()),
    model: z.string().optional(),
    effort: z.string().optional(),
    context: skillExecutionContextSchema,
  }),
  event("skill.forked", {
    skillId: z.string(),
    forkSessionId: z.string(),
    status: z.enum(["started", "finished"]),
    result: z.string().optional(),
  }),
  event("skill.cleared", { skillId: z.string().optional(), reason: z.string() }),
  event("tool.started", { toolId: z.string(), callId: z.string().optional(), input: z.json() }),
  event("tool.progress", { toolId: z.string(), callId: z.string().optional(), update: z.json() }),
  event("tool.finished", { toolId: z.string(), callId: z.string().optional(), result: toolResultSchema }),
  event("approval.requested", { request: approvalRequestSchema }),
  event("approval.resolved", { request: approvalRequestSchema }),
  event("question.requested", { question: questionRequestSchema }),
  event("question.answered", { question: questionRequestSchema }),
  event("planning.updated", {
    plan: z.object({
      id: z.string(),
      title: z.string().optional(),
      text: z.string(),
      status: z.string().optional(),
      raw: jsonObjectSchema.optional(),
      updatedAt: z.string(),
      source: agentRequestSourceSchema.optional(),
    }),
  }),
  event("run.cancel_requested", { at: z.string(), reason: z.string().optional() }),
  event("run.paused", { at: z.string(), reason: z.string(), approvalId: z.string().optional() }),
  event("run.resumed", { at: z.string(), reason: z.string().optional(), approvalId: z.string().optional() }),
  event("memory.written", { record: memoryRecordSchema }),
  event("turn.finished", { at: z.string(), outcome: runLifecycleSchema, synthetic: z.boolean().optional() }),
  event("error", {
    message: z.string(),
    problem: diagnosticProblemRefSchema.optional(),
    diagnostics: z
      .object({
        runtimeModelId: z.string().optional(),
        runtimeVersion: z.string().optional(),
        upstreamRequestId: z.string().optional(),
      })
      .optional(),
  }),
]);
export type AgentEventRecord = z.infer<typeof agentEventSchema>;
