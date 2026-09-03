import type {
  ArtifactRecord,
  JsonValue,
  QuestionRequest,
  RunRecord,
  SessionRecord,
  WorkingStateRecord,
} from "../core.js";
import type { BridgeState } from "./bridge-types.js";
import { syncBridgeWorkingState } from "./bridge-working-state.js";
import { presentArtifactSummaries } from "./artifact-presentation.js";
import {
  presentExecutionSummaries,
  presentQuestionSummaries,
  presentRunSummaries,
  presentSessionSummaries,
  presentWorkingState,
} from "./state-presentation.js";
import {
  activeBridgeRunExecutionState,
  activeBridgeRunExecutionStateForQuestion,
  activeBridgeRunOwnsInteraction,
  activeBridgeRunOwnsNativeRequest,
  cancelActiveBridgeRun,
} from "./active-runs.js";

export async function resolveQuestion(
  state: BridgeState,
  questionId: string,
  status: "answered" | "declined" | "canceled",
  response?: JsonValue,
): Promise<{
  ok: true;
  question: QuestionRequest;
  alreadyResolved?: boolean;
  questions: QuestionRequest[];
  artifacts: ArtifactRecord[];
  workingState: WorkingStateRecord;
  sessions: SessionRecord[];
  runs: RunRecord[];
  executions: ReturnType<BridgeState["app"]["executions"]["list"]>;
}> {
  const { app } = state;
  const question = app.questions.get(questionId) ?? latestQuestionEvent(state, questionId);
  if (!question) {
    throw new Error(`question_not_found:${questionId}`);
  }
  if (question.status !== "pending") {
    if (question.status !== status) {
      throw new Error(`question_already_${question.status}:${questionId}`);
    }
    return bridgeQuestionState(app, question, { alreadyResolved: true });
  }
  const runId = question?.resume?.runId;
  const executionState =
    activeBridgeRunExecutionState(state, runId) ?? activeBridgeRunExecutionStateForQuestion(state, questionId);
  if (
    isSameLoopKernelQuestion(question) &&
    (!activeBridgeRunOwnsInteraction(state, questionId, "question") ||
      !activeBridgeRunOwnsNativeRequest(state, runId, question.nativeRequestId, "question") ||
      !executionState?.app.questions.hasDecisionWaiter(questionId))
  ) {
    throw new Error(`question_producer_not_live:${questionId}`);
  }
  if (executionState && executionState.app !== state.app) {
    const result = resolveScopedQuestion(state, executionState, questionId, status, response);
    if (status === "canceled") cancelActiveBridgeRun(state, runId);
    return result;
  }

  if (!app.questions.get(questionId)) app.questions.upsert(question);
  const resolved = app.questions.decide(questionId, status, response);
  if (status === "canceled") cancelActiveBridgeRun(state, runId);
  syncBridgeWorkingState(app);
  state.store.saveFrom(app);
  return bridgeQuestionState(app, resolved);
}

function isSameLoopKernelQuestion(question: QuestionRequest): boolean {
  return question.resume?.type === "kernel.native" && question.resume.continuation === "same-loop";
}

function resolveScopedQuestion(
  rootState: BridgeState,
  executionState: BridgeState,
  questionId: string,
  status: "answered" | "declined" | "canceled",
  response?: JsonValue,
): ReturnType<typeof bridgeQuestionState> {
  const scopedQuestion =
    executionState.app.questions.get(questionId) ?? latestQuestionEvent(executionState, questionId);
  if (!scopedQuestion) {
    const rootQuestion = rootState.app.questions.get(questionId) ?? latestQuestionEvent(rootState, questionId);
    if (!rootQuestion) {
      throw new Error(`question_not_found:${questionId}`);
    }
    executionState.app.questions.upsert(rootQuestion);
  }

  const current = executionState.app.questions.get(questionId);
  if (!current) {
    throw new Error(`question_not_found:${questionId}`);
  }
  if (current.status !== "pending") {
    if (current.status !== status) {
      throw new Error(`question_already_${current.status}:${questionId}`);
    }
    rootState.app.questions.upsert(current);
    rootState.store.saveFrom(rootState.app);
    return bridgeQuestionState(rootState.app, current, { alreadyResolved: true });
  }

  const resolved = executionState.app.questions.decide(questionId, status, response);
  rootState.app.questions.upsert(resolved);
  syncBridgeWorkingState(rootState.app);
  rootState.store.saveFrom(rootState.app);
  return bridgeQuestionState(rootState.app, resolved);
}

function latestQuestionEvent(state: BridgeState, questionId: string): QuestionRequest | undefined {
  let latest: QuestionRequest | undefined;
  for (const event of state.app.events.list()) {
    if (
      (event.type !== "question.requested" && event.type !== "question.answered") ||
      event.question.id !== questionId
    ) {
      continue;
    }
    if (!latest || Date.parse(event.question.updatedAt) >= Date.parse(latest.updatedAt)) {
      latest = event.question;
    }
  }
  return latest;
}

function bridgeQuestionState(
  app: BridgeState["app"],
  question: QuestionRequest,
  extras: { alreadyResolved?: boolean } = {},
) {
  return {
    ok: true as const,
    question: presentQuestionSummaries([question])[0]!,
    ...extras,
    questions: presentQuestionSummaries(app.questions.list("pending").slice(-500)),
    artifacts: presentArtifactSummaries(app.artifacts.list({ limit: 100 })),
    workingState: presentWorkingState(app.workingState.get()),
    sessions: presentSessionSummaries(app.sessions.list({ limit: 12 })),
    runs: presentRunSummaries(app.sessions.listRuns({ limit: 24 })),
    executions: presentExecutionSummaries(app.executions.list({ limit: 40 })),
  };
}
