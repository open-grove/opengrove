import { lifecycleFromRunFact, runLifecycleSchema, type RunLifecycle } from "#agent-protocol";

type LegacyRunStatus = "running" | "waiting_for_approval" | "waiting_for_user" | "succeeded" | "failed";

// Supports: OpenGrove 0.6.5 persisted RunRecord.status values.
// Remove when: OpenGrove 0.7.0 no longer supports state last written by 0.6.5.

// A2A accepts UNSPECIFIED at the wire boundary. Persisted Host state does not:
// storing the sentinel would turn an upstream omission into an internal fact.
const persistedRunLifecycleSchema = runLifecycleSchema.refine(
  (lifecycle) => lifecycle.taskState !== "TASK_STATE_UNSPECIFIED",
  "persisted_task_state_must_be_specified",
);

/**
 * Normalizes Run records written before OpenGrove 0.6.6 introduced the A2A
 * lifecycle. The compatibility read stays at the persistence boundary and is
 * removed once the local state migration has rewritten all legacy Run rows.
 */
export function normalizePersistedRunLifecycle(input: unknown, legacyStatus?: unknown): RunLifecycle {
  const parsed = persistedRunLifecycleSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }
  if (isLegacyRunStatus(legacyStatus)) {
    return lifecycleFromLegacyRunStatus(legacyStatus);
  }
  return {
    taskState: "TASK_STATE_FAILED",
    reasonCode: "persisted_lifecycle_invalid",
    retryable: false,
    outcomeUnknown: true,
  };
}

function lifecycleFromLegacyRunStatus(status: LegacyRunStatus): RunLifecycle {
  switch (status) {
    case "running":
      return lifecycleFromRunFact({ kind: "started" });
    case "waiting_for_approval":
      return lifecycleFromRunFact({ kind: "input_required", reasonCode: "legacy_waiting_for_approval" });
    case "waiting_for_user":
      return lifecycleFromRunFact({ kind: "input_required", reasonCode: "legacy_waiting_for_user" });
    case "succeeded":
      return lifecycleFromRunFact({ kind: "completed" });
    case "failed":
      return lifecycleFromRunFact({ kind: "failed", reasonCode: "legacy_failed" });
  }
}

function isLegacyRunStatus(value: unknown): value is LegacyRunStatus {
  return (
    value === "running" ||
    value === "waiting_for_approval" ||
    value === "waiting_for_user" ||
    value === "succeeded" ||
    value === "failed"
  );
}
