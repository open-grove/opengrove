import { z } from "zod";
import { defineHostOperation, defineHostOperationResource } from "./operation.js";
import { hostRequestErrors } from "./host-errors.js";
import { startDirectRunOperation } from "./direct-runs.js";
import { jsonObjectSchema } from "./run-records.js";

const option = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  defaultProviderId: z.string().optional(),
  apiModelId: z.string().optional(),
  canonicalModelId: z.string().optional(),
  family: z.string().optional(),
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  metadata: jsonObjectSchema.optional(),
});
export const listRuntimesOperation = defineHostOperation({
  id: "host.runtime.list",
  summary: "Discover local Agent runtimes",
  description:
    "Read discovered Kernels and model controls for configured routes. Inspect an explicit Provider or Login route before starting work; no credentials are returned.",
  method: "GET",
  path: "/runtime",
  risk: "read",
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      modules: z.object({ rooms: z.boolean(), routines: z.boolean(), apps: z.boolean() }),
      kernels: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          available: z.boolean(),
          hostTools: z.boolean(),
          reason: z.string(),
          installed: z.boolean().optional(),
          version: z.string().optional(),
          providerId: z.string().optional(),
          capabilityReport: jsonObjectSchema.optional(),
        }),
      ),
      controls: z.record(
        z.string(),
        z.object({
          kernel: z.string(),
          source: z.string(),
          models: z.array(option),
          defaultModel: z.string().optional(),
          reasoningEfforts: z.array(option),
          defaultReasoningEffort: z.string().optional(),
          speedTiers: z.array(option),
          defaultSpeedTier: z.string().optional(),
        }),
      ),
    }),
  },
  errors: hostRequestErrors,
});
export const inspectRuntimeOperation = defineHostOperation({
  id: "host.runtime.inspect",
  summary: "Check a task runtime configuration",
  description:
    "Resolve an explicit route and workspace without changing Host defaults or starting a task. Availability is discovery evidence, not a completed native execution probe.",
  method: "POST",
  path: "/runtime/inspect",
  risk: "read",
  body: startDirectRunOperation.body.pick({ kernel: true, model: true, providerId: true, workspaceRoot: true }),
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      available: z.boolean(),
      reason: z.string().optional(),
      kernel: z.string(),
      model: z.string(),
      providerId: z.string().optional(),
      workspaceRoot: z.string(),
      capabilities: z
        .object({
          streaming: z.boolean(),
          hostTools: z.boolean(),
          approvals: z.boolean(),
          elicitation: z.boolean(),
          compaction: z.boolean(),
          nativeSkillCatalog: z.boolean(),
          sessionHistory: z.enum(["kernel", "host"]),
        })
        .optional(),
    }),
  },
  errors: hostRequestErrors,
});
export const runtimeResource = defineHostOperationResource({
  id: "runtime",
  title: "Agent runtimes",
  description: "Discover and validate local execution prerequisites.",
  operations: [listRuntimesOperation, inspectRuntimeOperation] as const,
});
