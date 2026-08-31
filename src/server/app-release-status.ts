export const RELEASE_CONTROL_STATUSES = [
  "awaiting_candidate",
  "building",
  "trusted_build_failed",
  "artifact_accepted",
  "finalizing",
  "published",
  "abandoned",
] as const;

export type ReleaseControlStatus = (typeof RELEASE_CONTROL_STATUSES)[number];
export type AppReleaseJournalRemoteStatus = ReleaseControlStatus | "publish_base_stale";

export const RELEASE_CONTROL_ACTIONS = ["retry_candidate", "retry_build", "abandon"] as const;

export type ReleaseControlAction = (typeof RELEASE_CONTROL_ACTIONS)[number];

export const RELEASE_CONTROL_FAILURE_STAGES = ["trusted_build", "artifact_pack", "artifact_gate", "workflow"] as const;

export interface ReleaseControlBuildFailure {
  stage: (typeof RELEASE_CONTROL_FAILURE_STAGES)[number];
  code: string;
  retryable: boolean;
  workflowRunId: string;
}

export function isReleaseControlStatus(value: unknown): value is ReleaseControlStatus {
  return typeof value === "string" && (RELEASE_CONTROL_STATUSES as readonly string[]).includes(value);
}

export function isReleaseControlActions(value: unknown): value is ReleaseControlAction[] {
  return (
    Array.isArray(value) &&
    value.length <= RELEASE_CONTROL_ACTIONS.length &&
    new Set(value).size === value.length &&
    value.every(
      (action) => typeof action === "string" && (RELEASE_CONTROL_ACTIONS as readonly string[]).includes(action),
    )
  );
}

export function isReleaseControlBuildFailure(value: unknown): value is ReleaseControlBuildFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const failure = value as Record<string, unknown>;
  return (
    Object.keys(failure).length === 4 &&
    typeof failure.stage === "string" &&
    (RELEASE_CONTROL_FAILURE_STAGES as readonly string[]).includes(failure.stage) &&
    typeof failure.code === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/.test(failure.code) &&
    typeof failure.retryable === "boolean" &&
    typeof failure.workflowRunId === "string" &&
    /^[1-9][0-9]{0,31}$/.test(failure.workflowRunId)
  );
}

export function isAppReleaseJournalRemoteStatus(value: unknown): value is AppReleaseJournalRemoteStatus {
  return value === "publish_base_stale" || isReleaseControlStatus(value);
}
