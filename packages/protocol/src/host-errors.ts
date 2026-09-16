import { hostSchemaRegistry } from "./schema-registry.js";
import { z } from "zod";

export const hostErrorSchema = z
  .object({
    ok: z.literal(false).optional(),
    error: z.string(),
    code: z.string().optional(),
    message: z.string().optional(),
    contractId: z.string().optional(),
    traceId: z.string().optional(),
    incidentId: z.string().optional(),
    issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
  })
  .register(hostSchemaRegistry, { id: "HostError" });
export const hostRequestErrors = [
  { status: 400, body: hostErrorSchema, description: "The input is invalid." },
  { status: 401, body: hostErrorSchema, description: "A valid Host session or token is required." },
  { status: 403, body: hostErrorSchema, description: "The request is not authorized." },
  { status: 500, body: hostErrorSchema, description: "The Host could not complete the operation." },
  { status: 503, body: hostErrorSchema, description: "The Host or authenticated session is temporarily unavailable." },
] as const;
