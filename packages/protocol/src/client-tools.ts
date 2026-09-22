import { z } from "zod";
import { defineHostOperation, defineHostOperationResource } from "./operation.js";
import { hostErrorSchema, hostRequestErrors } from "./host-errors.js";
import { jsonObjectSchema } from "./run-records.js";
import { toolResultSchema } from "./workspace-records.js";

export const clientToolSchema = z.object({
  id: z.string().regex(/^client\.[a-zA-Z0-9_.-]{1,100}$/),
  description: z.string().min(1),
  inputSchema: jsonObjectSchema,
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
});
export const clientToolCallSchema = z.object({
  id: z.string(),
  runId: z.string(),
  toolId: z.string(),
  input: jsonObjectSchema,
  status: z.enum(["pending", "completed", "canceled", "timed_out"]),
  createdAt: z.string(),
  deadlineAt: z.string(),
  result: toolResultSchema.optional(),
});
export const listClientToolCallsOperation = defineHostOperation({
  id: "run.tool.list",
  summary: "Read product tool calls",
  description:
    "Read pending and settled client tool calls for one live direct run. Calls are not replayed after Host restart.",
  method: "GET",
  path: "/runs/{runId}/tool-calls",
  risk: "read",
  params: z.object({ runId: z.string().min(1) }),
  success: { status: 200, body: z.object({ ok: z.literal(true), calls: z.array(clientToolCallSchema) }) },
  errors: [...hostRequestErrors, { status: 404, body: hostErrorSchema }],
});
export const resolveClientToolCallOperation = defineHostOperation({
  id: "run.tool.resolve",
  summary: "Return a product tool result",
  description:
    "Resolve a pending tool call. Repeating the same result is idempotent; conflicting, expired, canceled or missing calls are rejected.",
  method: "POST",
  path: "/runs/{runId}/tool-calls/{callId}/result",
  risk: "write",
  params: z.object({ runId: z.string().min(1), callId: z.string().min(1) }),
  body: z.object({ result: toolResultSchema }),
  success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  errors: [...hostRequestErrors, { status: 404, body: hostErrorSchema }, { status: 409, body: hostErrorSchema }],
});
export const clientToolResource = defineHostOperationResource({
  id: "tool",
  title: "Product tools",
  description: "Run-scoped calls executed by an external product.",
  operations: [listClientToolCallsOperation, resolveClientToolCallOperation] as const,
});

export type ClientToolDefinitionInput = z.output<typeof clientToolSchema>;
