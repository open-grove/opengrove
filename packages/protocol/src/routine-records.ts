import { z } from "zod";
import { agentEventSchema } from "./agent-event-records.js";
import { diagnosticProblemRefSchema, toolResultSchema } from "./workspace-records.js";

export const routineRunSummarySchema = z.object({
  id: z.string(),
  routineId: z.string(),
  status: z.enum(["running", "succeeded", "failed", "paused_for_approval"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  eventCount: z.number(),
  error: z.string().optional(),
  problem: diagnosticProblemRefSchema.optional(),
});
export const routineRunResultSchema = z.object({
  summary: routineRunSummarySchema,
  events: z.array(agentEventSchema),
  toolResults: z.array(toolResultSchema),
});
