import type { OpenGroveApp } from "../app/create-opengrove.js";
import type { WorkingStateRecord } from "../core.js";

export function syncBridgeWorkingState(
  app: OpenGroveApp,
  patch: Partial<Omit<WorkingStateRecord, "updatedAt">> = {},
): WorkingStateRecord {
  const current = app.workingState.get();
  const sessionChanged =
    typeof patch.sessionId === "string" && patch.sessionId.trim().length > 0 && patch.sessionId !== current.sessionId;

  return app.workingState.update({
    ...(sessionChanged
      ? {
          taskSummary: undefined,
          activeGoal: undefined,
          pinnedArtifactIds: [],
          workingArtifactIds: [],
          activeToolCallIds: [],
          activePackId: undefined,
          activeSkillId: undefined,
        }
      : {}),
    ...patch,
    pendingApprovalIds: app.approvals.list("pending").map((request) => request.id),
    pendingQuestionIds: app.questions.list("pending").map((request) => request.id),
  });
}
