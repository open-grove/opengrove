import type { OpenGroveApp } from "../app/create-opengrove.js";
import type {
  ApprovalRequest,
  ArtifactRecord,
  JsonValue,
  PolicyDecision,
  QuestionRequest,
  RunRecord,
  SessionRecord,
  ToolResult,
  WorkingStateRecord,
} from "../core.js";
import { resumeRoutineAfterApproval, type RoutineRunResult } from "../routines/routine-runner.js";
import type { BridgeState } from "./bridge-types.js";
import { syncBridgeWorkingState } from "./bridge-working-state.js";
import { createRoutineFlowInstanceObserver } from "./routine-flow-instance.js";
import { createRoutineMemberExecutor } from "./routine-scheduler.js";
import { createRoutineProblemReporter } from "./routine-problems.js";
import { asJsonObject } from "./http-utils.js";
import { presentArtifactSummaries } from "./artifact-presentation.js";
import {
  presentApprovalSummaries,
  presentExecutionSummaries,
  presentQuestionSummaries,
  presentRunSummaries,
  presentSessionSummaries,
  presentWorkingState,
} from "./state-presentation.js";
import { activeBridgeRunExecutionState, activeBridgeRunExecutionStateForApproval } from "./active-runs.js";

export async function resolveApproval(
  state: BridgeState,
  approvalId: string,
  status: "approved" | "rejected",
  approvalResponse?: JsonValue,
): Promise<{
  ok: true;
  approval: ApprovalRequest;
  alreadyResolved?: boolean;
  toolResult?: ToolResult;
  routineResult?: RoutineRunResult;
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
  artifacts: ArtifactRecord[];
  workingState: WorkingStateRecord;
  sessions: SessionRecord[];
  runs: RunRecord[];
  executions: ReturnType<BridgeState["app"]["executions"]["list"]>;
}> {
  const { app } = state;
  const approval = app.approvals.get(approvalId) ?? restoreApprovalFromEvents(state, approvalId);
  const resumeRunId = approval?.resume?.runId;
  const executionState =
    activeBridgeRunExecutionState(state, resumeRunId) ?? activeBridgeRunExecutionStateForApproval(state, approvalId);
  if (executionState && approvalBelongsToLiveProducer(executionState, approvalId, approval)) {
    return resolveScopedApproval(state, executionState, approvalId, status, approvalResponse);
  }
  if (!approval) {
    throw new Error(`approval_not_found:${approvalId}`);
  }

  if (approval.status !== "pending") {
    if (approval.status !== status) {
      throw new Error(`approval_already_${approval.status}:${approvalId}`);
    }
    return bridgeApprovalState(app, approval, { alreadyResolved: true });
  }

  const runId = approval.resume?.runId ?? `approval_${approvalId}`;
  const sessionId = app.workingState.get().sessionId ?? "browser-bridge";

  if (isSameLoopKernelResume(approval.resume)) {
    const resolved = app.approvals.decide(approvalId, status, approvalResponse);
    syncBridgeWorkingState(app);
    state.store.saveFrom(app);
    return bridgeApprovalState(app, resolved);
  }

  if (status === "rejected") {
    const rejected = app.approvals.decide(approvalId, "rejected", approvalResponse);
    app.recordEvent(
      {
        type: "approval.resolved",
        runId,
        request: rejected,
      },
      {
        sessionId,
        activity: "browser",
        input: rejected.title,
      },
    );
    app.recordEvent(
      {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
      },
      {
        sessionId,
        activity: "browser",
        input: rejected.title,
      },
    );
    syncBridgeWorkingState(app);
    state.store.saveFrom(app);
    return bridgeApprovalState(app, rejected);
  }

  const approved = app.approvals.decide(approvalId, "approved", approvalResponse);
  app.recordEvent(
    {
      type: "approval.resolved",
      runId,
      request: approved,
    },
    {
      sessionId,
      activity: "browser",
      input: approved.title,
    },
  );
  app.recordEvent(
    {
      type: "run.resumed",
      runId,
      at: new Date().toISOString(),
      reason: "Approved by user through the local bridge.",
      approvalId: approved.id,
    },
    {
      sessionId,
      activity: "browser",
      input: approved.title,
    },
  );

  const routineResult = await resumeRoutineAfterApproval(app, approved, {
    memberExecutor: createRoutineMemberExecutor(state),
    problemReporter: createRoutineProblemReporter(state),
    statusObserver: createRoutineFlowInstanceObserver(state),
  });
  const toolResult = routineResult ? undefined : await replayApprovedTool(state, approved);
  if (!routineResult) {
    app.recordEvent(
      {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
      },
      {
        sessionId,
        activity: "browser",
        input: approved.title,
      },
    );
  }
  syncBridgeWorkingState(app);
  state.store.saveFrom(app);
  return bridgeApprovalState(app, approved, { toolResult, routineResult });
}

function isSameLoopKernelResume(resume: ApprovalRequest["resume"]): boolean {
  return resume?.type === "kernel.native" && resume.continuation === "same-loop";
}

function approvalBelongsToLiveProducer(
  executionState: BridgeState,
  approvalId: string,
  approval: ApprovalRequest | undefined,
): boolean {
  if (isSameLoopKernelResume(approval?.resume)) return true;
  // Generic tool approvals have two continuation modes. Some runtimes wait
  // on the inbox and continue the original producer; others stop and require
  // Bridge replay. The waiter is the authoritative distinction, not the
  // identity of a wrapper BridgeState object.
  return executionState.app.approvals.hasDecisionWaiter(approvalId);
}

function resolveScopedApproval(
  rootState: BridgeState,
  executionState: BridgeState,
  approvalId: string,
  status: "approved" | "rejected",
  approvalResponse?: JsonValue,
): ReturnType<typeof bridgeApprovalState> {
  const scopedApproval =
    executionState.app.approvals.get(approvalId) ?? restoreApprovalFromEvents(executionState, approvalId);
  if (!scopedApproval) {
    const rootApproval = rootState.app.approvals.get(approvalId) ?? restoreApprovalFromEvents(rootState, approvalId);
    if (!rootApproval) {
      throw new Error(`approval_not_found:${approvalId}`);
    }
    executionState.app.approvals.upsert(rootApproval);
  }

  const current = executionState.app.approvals.get(approvalId);
  if (!current) {
    throw new Error(`approval_not_found:${approvalId}`);
  }
  if (current.status !== "pending") {
    if (current.status !== status) {
      throw new Error(`approval_already_${current.status}:${approvalId}`);
    }
    rootState.app.approvals.upsert(current);
    rootState.store.saveFrom(rootState.app);
    return bridgeApprovalState(rootState.app, current, { alreadyResolved: true });
  }

  const resolved = executionState.app.approvals.decide(approvalId, status, approvalResponse);
  rootState.app.approvals.upsert(resolved);
  syncBridgeWorkingState(rootState.app);
  rootState.store.saveFrom(rootState.app);
  return bridgeApprovalState(rootState.app, resolved);
}

function restoreApprovalFromEvents(state: BridgeState, approvalId: string): ApprovalRequest | undefined {
  const approval = latestApprovalEvent(state, approvalId);
  if (approval) {
    state.app.approvals.upsert(approval);
  }
  return approval;
}

function latestApprovalEvent(state: BridgeState, approvalId: string): ApprovalRequest | undefined {
  let latest: ApprovalRequest | undefined;
  for (const event of state.app.events.list()) {
    if (
      (event.type !== "approval.requested" && event.type !== "approval.resolved") ||
      event.request.id !== approvalId
    ) {
      continue;
    }
    if (!latest || Date.parse(event.request.updatedAt) >= Date.parse(latest.updatedAt)) {
      latest = event.request;
    }
  }
  return latest;
}

async function replayApprovedTool(state: BridgeState, approval: ApprovalRequest): Promise<ToolResult> {
  const { app } = state;
  if (!approval.toolId) {
    return { ok: true, value: { status: "approved" } };
  }

  const tool = app.tools.require(approval.toolId);
  const runId = approval.resume?.runId ?? `approval_${approval.id}`;
  const input = asJsonObject(approval.input);
  const policy: PolicyDecision = {
    mode: "allow",
    reason: "Approved by user through the local bridge.",
  };
  const sessionId = app.workingState.get().sessionId ?? "browser-bridge";

  app.recordEvent(
    { type: "tool.started", runId, toolId: approval.toolId, input },
    {
      sessionId,
      activity: "browser",
      input: approval.title,
    },
  );
  const result = await tool.execute(input, {
    runId,
    capabilityId: approval.capabilityId,
    skillId: approval.skillId,
    memory: app.memory,
    artifacts: app.artifacts,
    workingState: app.workingState,
    approvals: app.approvals,
    skills: app.skills,
    packs: app.packs,
    policy,
  });
  app.recordEvent(
    { type: "tool.finished", runId, toolId: approval.toolId, result },
    {
      sessionId,
      activity: "browser",
      input: approval.title,
    },
  );
  if (!result.ok) {
    app.recordEvent(
      {
        type: "error",
        runId,
        message: result.error ?? "approved_tool_failed",
      },
      {
        sessionId,
        activity: "browser",
        input: approval.title,
      },
    );
  }
  return result;
}

function bridgeApprovalState(
  app: OpenGroveApp,
  approval: ApprovalRequest,
  extras: {
    alreadyResolved?: boolean;
    toolResult?: ToolResult;
    routineResult?: RoutineRunResult;
  } = {},
) {
  return {
    ok: true as const,
    approval: presentApprovalSummaries([approval])[0]!,
    ...extras,
    approvals: presentApprovalSummaries(app.approvals.list("pending").slice(-500)),
    questions: presentQuestionSummaries(app.questions.list("pending").slice(-500)),
    artifacts: presentArtifactSummaries(app.artifacts.list({ limit: 100 })),
    workingState: presentWorkingState(app.workingState.get()),
    sessions: presentSessionSummaries(app.sessions.list({ limit: 12 })),
    runs: presentRunSummaries(app.sessions.listRuns({ limit: 24 })),
    executions: presentExecutionSummaries(app.executions.list({ limit: 40 })),
  };
}
