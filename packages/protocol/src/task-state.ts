import { z } from "zod";

export const a2aTaskStateSchema = z.enum([
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export type A2ATaskState = z.infer<typeof a2aTaskStateSchema>;

export const a2aTerminalTaskStates = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
] as const satisfies readonly A2ATaskState[];

export function isA2ATerminalTaskState(state: A2ATaskState): boolean {
  return (a2aTerminalTaskStates as readonly string[]).includes(state);
}
