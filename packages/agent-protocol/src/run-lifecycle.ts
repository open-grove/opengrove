import { z } from "zod";
import { type A2ATaskState, a2aTaskStateSchema } from "./a2a.js";

export const runLifecycleActivitySchema = z.enum(["running", "reconnecting", "cancel_pending", "waiting_on_child"]);
export type RunLifecycleActivity = z.infer<typeof runLifecycleActivitySchema>;

export const runLifecycleSchema = z
  .object({
    taskState: a2aTaskStateSchema,
    activity: runLifecycleActivitySchema.optional(),
    reasonCode: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
    outcomeUnknown: z.boolean().optional(),
    childRunId: z.string().min(1).optional(),
  })
  .superRefine((lifecycle, context) => {
    if (lifecycle.activity && lifecycle.taskState !== "TASK_STATE_WORKING") {
      context.addIssue({ code: "custom", path: ["activity"], message: "activity_requires_working_state" });
    }
    if (lifecycle.activity === "waiting_on_child" && !lifecycle.childRunId) {
      context.addIssue({ code: "custom", path: ["childRunId"], message: "waiting_child_run_id_required" });
    }
    if (lifecycle.childRunId && lifecycle.activity !== "waiting_on_child") {
      context.addIssue({ code: "custom", path: ["childRunId"], message: "child_run_requires_waiting_activity" });
    }
  });

export type RunLifecycle = z.infer<typeof runLifecycleSchema>;

export type RunLifecycleFact =
  | { kind: "submitted" }
  | { kind: "started" }
  | { kind: "reconnecting"; reasonCode?: string }
  | { kind: "cancel_requested" }
  | { kind: "waiting_on_child"; childRunId: string }
  | { kind: "completed" }
  | { kind: "content_refusal" }
  | { kind: "failed"; reasonCode?: string; retryable?: boolean; outcomeUnknown?: boolean }
  | { kind: "canceled"; reasonCode?: string }
  | { kind: "input_required"; reasonCode?: string }
  | { kind: "authentication_required"; resumable: boolean }
  | { kind: "rejected"; phase: "pre_start" | "in_progress"; reasonCode?: string }
  | { kind: "producer_lost" };

export function lifecycleFromRunFact(fact: RunLifecycleFact): RunLifecycle {
  switch (fact.kind) {
    case "submitted":
      return { taskState: "TASK_STATE_SUBMITTED" };
    case "started":
      return { taskState: "TASK_STATE_WORKING", activity: "running" };
    case "reconnecting":
      return {
        taskState: "TASK_STATE_WORKING",
        activity: "reconnecting",
        ...(fact.reasonCode ? { reasonCode: fact.reasonCode } : {}),
      };
    case "cancel_requested":
      return { taskState: "TASK_STATE_WORKING", activity: "cancel_pending" };
    case "waiting_on_child":
      return { taskState: "TASK_STATE_WORKING", activity: "waiting_on_child", childRunId: fact.childRunId };
    case "completed":
      return { taskState: "TASK_STATE_COMPLETED" };
    case "content_refusal":
      return { taskState: "TASK_STATE_COMPLETED", reasonCode: "content_refusal" };
    case "failed":
      return {
        taskState: "TASK_STATE_FAILED",
        reasonCode: fact.reasonCode || "unknown",
        ...(fact.retryable === undefined ? {} : { retryable: fact.retryable }),
        ...(fact.outcomeUnknown === undefined ? {} : { outcomeUnknown: fact.outcomeUnknown }),
      };
    case "canceled":
      return { taskState: "TASK_STATE_CANCELED", reasonCode: fact.reasonCode || "user_canceled", retryable: false };
    case "input_required":
      return {
        taskState: "TASK_STATE_INPUT_REQUIRED",
        ...(fact.reasonCode ? { reasonCode: fact.reasonCode } : {}),
      };
    case "authentication_required":
      return fact.resumable
        ? { taskState: "TASK_STATE_AUTH_REQUIRED", reasonCode: "authentication_required", retryable: true }
        : { taskState: "TASK_STATE_FAILED", reasonCode: "authentication_unrecoverable", retryable: false };
    case "rejected":
      return fact.phase === "pre_start"
        ? {
            taskState: "TASK_STATE_REJECTED",
            reasonCode: fact.reasonCode || "pre_start_rejected",
            retryable: false,
          }
        : { taskState: "TASK_STATE_FAILED", reasonCode: fact.reasonCode || "kernel_rejected", retryable: false };
    case "producer_lost":
      return { taskState: "TASK_STATE_FAILED", reasonCode: "producer_lost", retryable: true, outcomeUnknown: true };
  }
}

export function isWorkingRunLifecycle(lifecycle: RunLifecycle): boolean {
  return lifecycle.taskState === "TASK_STATE_SUBMITTED" || lifecycle.taskState === "TASK_STATE_WORKING";
}

export function isA2AResumableTaskState(state: A2ATaskState): boolean {
  return state === "TASK_STATE_INPUT_REQUIRED" || state === "TASK_STATE_AUTH_REQUIRED";
}
