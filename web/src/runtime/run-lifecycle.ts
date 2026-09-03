export type RunOverviewStatus = "done" | "running" | "pending" | "blocked";

export function runOverviewStatus(
  lifecycle: { taskState?: string } | undefined,
  hasRuntimeBlocker: boolean,
): RunOverviewStatus {
  if (hasRuntimeBlocker) return "blocked";
  switch (lifecycle?.taskState) {
    case "TASK_STATE_SUBMITTED":
    case "TASK_STATE_WORKING":
      return "running";
    case "TASK_STATE_INPUT_REQUIRED":
    case "TASK_STATE_AUTH_REQUIRED":
      return "pending";
    case "TASK_STATE_COMPLETED":
      return "done";
    case "TASK_STATE_FAILED":
    case "TASK_STATE_CANCELED":
    case "TASK_STATE_REJECTED":
      return "blocked";
    default:
      return lifecycle ? "pending" : "running";
  }
}
