import { z } from "zod";
import { defineHostOperation, defineHostOperationResource } from "./operation.js";

const appUpdateErrorSchema = z.object({
  ok: z.literal(false).optional(),
  error: z.string(),
  incidentId: z.string().optional(),
  traceId: z.string().optional(),
});

export const scheduleAppUpdatesOperation = defineHostOperation({
  id: "app.update.schedule",
  summary: "Schedule automatic App updates",
  description:
    "Schedule background updates for installed Store Apps using the workspace owner's account. Honors the automatic-update setting, check interval, and local App safety checks. May download and activate newer App versions; does not check the desktop client version. Requests authenticated by a desktop Bridge token also require a valid Cloud session and never refresh account cookies.",
  method: "POST",
  path: "/app-store/updates",
  risk: "write",
  success: {
    status: 200,
    body: z.object({
      ok: z.literal(true),
      status: z.enum(["scheduled", "already_running", "skipped"]),
      reason: z.string().optional(),
    }),
  },
  errors: (
    [
      [401, "A valid Cloud session is required; desktop background calls never refresh expired credentials."],
      [403, "The request origin or account is not authorized for this workspace."],
      [500, "An internal error or response contract violation occurred."],
      [503, "The account or App update service is temporarily unavailable."],
    ] as const
  ).map(([status, description]) => ({
    status,
    body: appUpdateErrorSchema,
    description,
  })),
});

export const appUpdateOperationResource = defineHostOperationResource({
  id: "update",
  title: "App updates",
  description: "Automatic updates of installed Store Apps, independent of desktop client versions.",
  operations: [scheduleAppUpdatesOperation] as const,
});

export type ScheduleAppUpdatesOperation = typeof scheduleAppUpdatesOperation;
