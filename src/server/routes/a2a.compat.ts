import type { A2ATaskState } from "#agent-protocol";

/**
 * Reads Room task state written before RunRecord.lifecycle became authoritative
 * in OpenGrove 0.6.6. This is only used when no RunRecord exists, so current
 * Runs can never be overwritten by a stale Room message projection. Remove
 * after the persisted Room migration guarantees a RunRecord for every task.
 */
export function taskStateFromLegacyRoomMessageStatus(status: string): A2ATaskState {
  if (status === "running") return "TASK_STATE_WORKING";
  if (status === "done") return "TASK_STATE_COMPLETED";
  if (status === "interrupted") return "TASK_STATE_CANCELED";
  if (status === "failed") return "TASK_STATE_FAILED";
  return "TASK_STATE_SUBMITTED";
}
