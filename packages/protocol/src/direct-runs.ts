import { jsonObjectSchema } from "./run-records.js";
import { clientToolSchema } from "./client-tools.js";
import { z } from "zod";
import { defineHostOperation } from "./operation.js";
import { hostErrorSchema, hostRequestErrors } from "./host-errors.js";
import { runRecordSchema } from "./run-records.js";

export const startDirectRunOperation = defineHostOperation({
  id: "run.direct.start",
  summary: "Start an independent Agent task",
  description:
    "Start a background task without an App or Room. Observe it through run events and records. One direct run per session may execute at a time; disconnecting the caller does not cancel execution.",
  method: "POST",
  path: "/runs",
  risk: "write",
  body: z.object({
    sessionId: z.string().trim().min(1).max(512),
    input: z.string().trim().min(1),
    kernel: z.enum(["codex", "claude-code", "hermes", "pi", "openclaw", "opencode", "kimi"]),
    model: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    workspaceRoot: z.string().trim().min(1).optional(),
    instructions: z.string().optional(),
    context: z.union([z.string(), jsonObjectSchema]).optional(),
    attachments: z
      .array(
        z.object({
          id: z.string().optional(),
          name: z.string().min(1),
          kind: z.enum(["image", "text", "file"]),
          mimeType: z.string().optional(),
          size: z.number().nonnegative().optional(),
          text: z.string().max(1_000_000).optional(),
          dataUrl: z.string().startsWith("data:").max(10_000_000).optional(),
        }),
      )
      .max(20)
      .default([]),
    tools: z.array(clientToolSchema).max(100).default([]),
    skills: z.array(z.string().trim().min(1)).default([]),
    accessMode: z.enum(["default", "auto-review", "full-access"]).default("default"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    planMode: z.boolean().default(false),
  }),
  success: {
    status: 202,
    body: z.object({ ok: z.literal(true), runId: z.string(), sessionId: z.string() }),
  },
  errors: [...hostRequestErrors, { status: 409, body: hostErrorSchema }],
});
export type StartDirectRunOperation = typeof startDirectRunOperation;

export const getDirectRunResultOperation = defineHostOperation({
  id: "run.direct.result",
  summary: "Read a task outcome",
  description:
    "Read a persisted run and its complete final answer, stored as an artifact independently of bounded event presentation. outputAvailable is false before finalization or when no output was saved.",
  method: "GET",
  path: "/runs/{runId}/result",
  risk: "read",
  params: z.object({ runId: z.string().min(1) }),
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      run: runRecordSchema,
      answer: z.string(),
      outputAvailable: z.boolean(),
      finalized: z.boolean(),
      artifactId: z.string().optional(),
    }),
  },
  errors: [...hostRequestErrors, { status: 404, body: hostErrorSchema }],
});
