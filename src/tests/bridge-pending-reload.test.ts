import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  registerActiveBridgeRun,
  registerActiveBridgeRunInteraction,
  activeBridgeRunOwnsNativeRequest,
  reconcileActiveBridgeRunsAsProducerLost,
  setActiveBridgeRunExecutionState,
} from "../server/active-runs.js";
import { resolveApproval } from "../server/approval-actions.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import type { BridgeState } from "../server/bridge-types.js";
import { resolveQuestion } from "../server/question-actions.js";

test("hot rebuild preserves and resolves a pending request on its live producer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-pending-hot-reload-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "run-live-ask";
  const releaseRun = registerActiveBridgeRun(state, runId);
  try {
    const producerApp = state.app;
    const executionState = {
      ...state,
      rootState: state,
      app: producerApp,
    } satisfies BridgeState;
    setActiveBridgeRunExecutionState(state, runId, executionState);
    const approval = producerApp.approvals.request({
      kind: "tool",
      title: "Live Ask approval",
      reason: "The producer is waiting for this decision",
      resume: {
        type: "kernel.native",
        kernelId: "codex",
        runId,
        continuation: "same-loop",
      },
    });
    registerActiveBridgeRunInteraction(state, {
      runId,
      kind: "approval",
      interactionId: approval.id,
    });
    const producerDecision = producerApp.approvals.waitForDecision(approval.id);
    state.store.saveFrom(producerApp);

    recreateBridgeApp(state);
    assert.notEqual(state.app, producerApp);
    assert.equal(state.app.approvals.get(approval.id)?.status, "pending");
    const rebuiltRequest = state.app.approvals.request({
      kind: "tool",
      title: "Second scoped approval",
      reason: "Concurrent stores must not reuse interaction ids",
    });
    assert.notEqual(rebuiltRequest.id, approval.id);

    await resolveApproval(state, approval.id, "approved");
    assert.equal((await producerDecision).status, "approved");
    assert.equal(producerApp.approvals.get(approval.id)?.status, "approved");
    assert.equal(state.app.approvals.get(approval.id)?.status, "approved");
  } finally {
    releaseRun();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native request ownership is scoped by Run even when Kernels reuse their request ids", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-native-request-owner-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const releaseFirst = registerActiveBridgeRun(state, "run-owner-first");
  const releaseSecond = registerActiveBridgeRun(state, "run-owner-second");
  try {
    registerActiveBridgeRunInteraction(state, {
      runId: "run-owner-first",
      kind: "question",
      interactionId: "question-first",
      nativeRequestId: "request-1",
    });
    registerActiveBridgeRunInteraction(state, {
      runId: "run-owner-second",
      kind: "question",
      interactionId: "question-second",
      nativeRequestId: "request-1",
    });
    assert.equal(activeBridgeRunOwnsNativeRequest(state, "run-owner-first", "request-1", "question"), true);
    assert.equal(activeBridgeRunOwnsNativeRequest(state, "run-owner-second", "request-1", "question"), true);
  } finally {
    releaseFirst();
    releaseSecond();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("last producer release terminalizes a non-terminal Run without inventing success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-producer-release-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "run-producer-release";
  const release = registerActiveBridgeRun(state, runId);
  try {
    state.app.sessions.startRun({
      id: runId,
      sessionId: "session-producer-release",
      activity: "chat",
      input: "producer exits unexpectedly",
    });
    release();
    assert.deepEqual(state.app.sessions.getRun(runId)?.lifecycle, {
      taskState: "TASK_STATE_FAILED",
      reasonCode: "producer_lost",
      retryable: true,
      outcomeUnknown: true,
    });
  } finally {
    release();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("producer loss terminalizes both root and hot-rebuild execution Run records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-producer-dual-record-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "run-producer-dual-record";
  const release = registerActiveBridgeRun(state, runId);
  const producerApp = state.app;
  try {
    producerApp.sessions.startRun({
      id: runId,
      sessionId: "session-producer-dual-record",
      activity: "chat",
      input: "survive a hot rebuild",
    });
    state.store.saveFrom(producerApp);
    setActiveBridgeRunExecutionState(state, runId, { ...state, rootState: state, app: producerApp });
    recreateBridgeApp(state);
    assert.notEqual(state.app, producerApp);

    release();
    assert.equal(producerApp.sessions.getRun(runId)?.lifecycle.taskState, "TASK_STATE_FAILED");
    assert.equal(state.app.sessions.getRun(runId)?.lifecycle.taskState, "TASK_STATE_FAILED");
  } finally {
    release();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown reconciliation cancels orphan interactions and records an unknown failed outcome", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-shutdown-reconcile-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "run-shutdown-unknown";
  let cancelCalls = 0;
  const releaseRun = registerActiveBridgeRun(state, runId, { cancel: () => (cancelCalls += 1) });
  try {
    state.app.sessions.startRun({
      id: runId,
      sessionId: "session-shutdown",
      activity: "chat",
      input: "keep working",
    });
    setActiveBridgeRunExecutionState(state, runId, { ...state, rootState: state, app: state.app });
    const question = state.app.questions.request({
      title: "Still waiting",
      prompt: "Continue?",
      resume: { type: "kernel.native", kernelId: "codex", runId, continuation: "same-loop" },
    });
    registerActiveBridgeRunInteraction(state, { runId, kind: "question", interactionId: question.id });

    reconcileActiveBridgeRunsAsProducerLost(state, [runId], "host_shutdown");

    assert.equal(cancelCalls, 0, "reconciliation records facts and must not invoke cancellation a second time");
    assert.equal(state.app.questions.get(question.id)?.status, "canceled");
    assert.deepEqual(state.app.questions.get(question.id)?.response, { system: true, reasonCode: "host_shutdown" });
    assert.deepEqual(state.app.sessions.getRun(runId)?.lifecycle, {
      taskState: "TASK_STATE_FAILED",
      reasonCode: "host_shutdown",
      retryable: true,
      outcomeUnknown: true,
    });
    assert.ok(
      state.app.events
        .list()
        .some((event) => event.type === "turn.finished" && event.runId === runId && event.synthetic === true),
    );
  } finally {
    releaseRun();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hot rebuild preserves a resumable Routine approval without a live producer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-routine-hot-reload-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "routine-run-test";
  const releaseRun = registerActiveBridgeRun(state, runId);
  let released = false;
  try {
    state.app.sessions.startRun({
      id: runId,
      sessionId: "routine:test",
      activity: "browser",
      input: "Run a Routine that waits durably",
    });
    const approval = state.app.approvals.request({
      kind: "routine_step",
      title: "Routine approval",
      reason: "The continuation is persisted in the request",
      resume: {
        type: "routine.step",
        routineId: "routine-test",
        stepId: "approval-step",
        runId,
      },
    });
    state.app.recordEvent(
      { type: "approval.requested", runId, request: approval },
      { sessionId: "routine:test", activity: "browser", input: "Pause for approval" },
    );
    registerActiveBridgeRunInteraction(state, { runId, kind: "approval", interactionId: approval.id });
    releaseRun();
    released = true;
    assert.equal(state.app.approvals.get(approval.id)?.status, "pending");
    assert.equal(state.app.sessions.getRun(runId)?.lifecycle.taskState, "TASK_STATE_INPUT_REQUIRED");
    state.store.saveFrom(state.app);

    recreateBridgeApp(state);
    assert.equal(state.app.approvals.get(approval.id)?.status, "pending");
  } finally {
    if (!released) releaseRun();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cold restart cancels a paused Routine approval and terminalizes its Run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-routine-cold-restart-"));
  const statePath = join(directory, "state.sqlite");
  const beforeRestart = createBridgeState({ statePath });
  const runId = "routine-run-cold-restart";
  let afterRestart: BridgeState | undefined;
  try {
    beforeRestart.app.sessions.startRun({
      id: runId,
      sessionId: "routine:cold-restart",
      activity: "browser",
      input: "Run a routine that pauses for approval",
    });
    const approval = beforeRestart.app.approvals.request({
      kind: "routine_step",
      title: "Approve after restart",
      reason: "This continuation is not yet durable across process restart.",
      resume: {
        type: "routine.step",
        routineId: "routine-cold-restart",
        stepId: "approval-step",
        runId,
      },
    });
    beforeRestart.app.recordEvent(
      { type: "approval.requested", runId, request: approval },
      { sessionId: "routine:cold-restart", activity: "browser", input: "Pause for approval" },
    );
    beforeRestart.store.saveFrom(beforeRestart.app);
    await beforeRestart.store.close?.();

    afterRestart = createBridgeState({ statePath });
    assert.equal(afterRestart.app.approvals.get(approval.id)?.status, "canceled");
    assert.deepEqual(afterRestart.app.approvals.get(approval.id)?.response, {
      system: true,
      reasonCode: "producer_lost",
    });
    assert.deepEqual(afterRestart.app.sessions.getRun(runId)?.lifecycle, {
      taskState: "TASK_STATE_FAILED",
      reasonCode: "producer_lost",
      retryable: true,
      outcomeUnknown: true,
    });
  } finally {
    await afterRestart?.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a paused Bridge tool approval survives producer completion and replays after approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-ask-approval-replay-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "run-active-bridge-replay";
  const releaseRun = registerActiveBridgeRun(state, runId);
  let released = false;
  let executionCount = 0;
  try {
    state.app.tools.register({
      spec: {
        id: "test.approved-tool",
        title: "Approved tool",
        description: "Regression test tool",
        activity: "local",
        risk: "write",
        input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
        permission: { mode: "allow", reason: "test" },
      },
      async execute() {
        executionCount += 1;
        return { ok: true, value: { executionCount } };
      },
    });
    setActiveBridgeRunExecutionState(state, runId, {
      ...state,
      rootState: state,
      app: state.app,
    });
    const approval = state.app.approvals.request({
      kind: "tool",
      title: "Replay this tool",
      reason: "The original producer stopped at the approval boundary",
      toolId: "test.approved-tool",
      input: { approved: true },
      resume: { type: "tool", runId },
    });
    registerActiveBridgeRunInteraction(state, {
      runId,
      kind: "approval",
      interactionId: approval.id,
    });

    releaseRun();
    released = true;
    assert.equal(
      state.app.approvals.get(approval.id)?.status,
      "pending",
      "a persisted replay continuation must outlive its producer",
    );

    const result = await resolveApproval(state, approval.id, "approved");
    assert.equal(executionCount, 1);
    assert.equal(result.toolResult?.ok, true);
    assert.ok(state.app.events.list().some((event) => event.type === "approval.resolved"));
    assert.ok(state.app.events.list().some((event) => event.type === "run.resumed"));
    assert.ok(state.app.events.list().some((event) => event.type === "turn.finished"));
  } finally {
    if (!released) releaseRun();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an active producer waiter is resolved without replaying its tool twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-ask-approval-waiter-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "run-active-producer-waiter";
  const releaseRun = registerActiveBridgeRun(state, runId);
  let executionCount = 0;
  try {
    state.app.tools.register({
      spec: {
        id: "test.waiting-tool",
        title: "Waiting tool",
        description: "Regression test tool",
        activity: "local",
        risk: "write",
        input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
        permission: { mode: "allow", reason: "test" },
      },
      async execute() {
        executionCount += 1;
        return { ok: true, value: { executionCount } };
      },
    });
    setActiveBridgeRunExecutionState(state, runId, {
      ...state,
      rootState: state,
      app: state.app,
    });
    const approval = state.app.approvals.request({
      kind: "tool",
      title: "Wake the producer",
      reason: "The producer owns this continuation",
      toolId: "test.waiting-tool",
      input: { approved: true },
      resume: { type: "tool", runId },
    });
    const producerDecision = state.app.approvals.waitForDecision(approval.id);

    const result = await resolveApproval(state, approval.id, "approved");
    assert.equal((await producerDecision).status, "approved");
    assert.equal(executionCount, 0, "the Bridge must not duplicate work owned by the live producer");
    assert.equal(result.toolResult, undefined);
  } finally {
    releaseRun();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a user can cancel live native approval and question waiters without disguising the decision as rejection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-native-interaction-cancel-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "run-native-interaction-cancel";
  let nativeCancelCount = 0;
  const releaseRun = registerActiveBridgeRun(state, runId, {
    cancel: () => {
      nativeCancelCount += 1;
    },
  });
  try {
    state.app.sessions.startRun({
      id: runId,
      sessionId: "session-native-interaction-cancel",
      activity: "chat",
      input: "cancel the native interaction",
    });
    setActiveBridgeRunExecutionState(state, runId, { ...state, rootState: state, app: state.app });
    const approval = state.app.approvals.request({
      kind: "tool",
      title: "Cancel approval",
      reason: "The user stops this native request",
      resume: { type: "kernel.native", kernelId: "codex", runId, continuation: "same-loop" },
    });
    registerActiveBridgeRunInteraction(state, { runId, kind: "approval", interactionId: approval.id });
    const approvalDecision = state.app.approvals.waitForDecision(approval.id);
    const approvalResult = await resolveApproval(state, approval.id, "canceled", {
      system: false,
      reasonCode: "user_canceled",
    });
    assert.equal(approvalResult.approval.status, "canceled");
    assert.equal((await approvalDecision).status, "canceled");

    const question = state.app.questions.request({
      title: "Cancel question",
      prompt: "The user stops this native request",
      resume: { type: "kernel.native", kernelId: "codex", runId, continuation: "same-loop" },
    });
    registerActiveBridgeRunInteraction(state, { runId, kind: "question", interactionId: question.id });
    const questionDecision = state.app.questions.waitForDecision(question.id);
    const questionResult = await resolveQuestion(state, question.id, "canceled", {
      system: false,
      reasonCode: "user_canceled",
    });
    assert.equal(questionResult.question.status, "canceled");
    assert.equal((await questionDecision).status, "canceled");
    assert.equal(nativeCancelCount, 2, "each explicit user cancellation must reach the live Run producer");
    assert.equal(state.app.sessions.getRun(runId)?.lifecycle.activity, "cancel_pending");
    assert.equal(
      state.app.events.list().filter((event) => event.type === "run.cancel_requested" && event.runId === runId).length,
      2,
      "each cancellation request must enter the AgentEvent fact stream",
    );
  } finally {
    releaseRun();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
