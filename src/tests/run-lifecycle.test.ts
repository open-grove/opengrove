import assert from "node:assert/strict";
import test from "node:test";
import { a2aTaskStateSchema, lifecycleFromRunFact } from "#agent-protocol";
import { createOpenGrove } from "../app/create-opengrove.js";
import { SessionStore } from "../core/stores/session-store.js";
import type { AgentEvent, AgentRuntime, ApprovalRequest } from "../core/types.js";
import { createAgentEventCheckpointPolicy } from "../core/event-persistence.js";
import { consumeWwRetryableTurnAttempt } from "../server/ww-provider-recovery.js";

const at = "2026-08-31T00:00:00.000Z";

test("A2A accepts the upstream unspecified sentinel without producing it for Host facts", () => {
  assert.equal(a2aTaskStateSchema.parse("TASK_STATE_UNSPECIFIED"), "TASK_STATE_UNSPECIFIED");
  assert.notEqual(lifecycleFromRunFact({ kind: "submitted" }).taskState, "TASK_STATE_UNSPECIFIED");
});

function startedStore(): SessionStore {
  const store = new SessionStore();
  store.startRun({ id: "run-1", sessionId: "session-1", activity: "chat", input: "hello" });
  return store;
}

test("old persisted run status migrates into lifecycle and is not written back", () => {
  const store = new SessionStore();
  store.restore({
    runs: [
      {
        id: "legacy-run",
        sessionId: "legacy-session",
        activity: "chat",
        status: "waiting_for_approval",
        input: "legacy",
        createdAt: at,
        updatedAt: at,
        startedAt: at,
        resumeCount: 0,
        approvalIds: [],
        questionIds: [],
        toolIds: [],
        eventCount: 0,
      },
    ],
  });

  const run = store.getRun("legacy-run");
  assert.equal(run?.lifecycle.taskState, "TASK_STATE_INPUT_REQUIRED");
  assert.equal(run?.lifecycle.reasonCode, "legacy_waiting_for_approval");
  assert.equal(Object.hasOwn(run ?? {}, "status"), false);
  assert.equal(JSON.stringify(store.listRuns()).includes('"status"'), false);
});

test("invalid persisted lifecycle fails closed instead of reviving as submitted", () => {
  const store = new SessionStore();
  store.restore({
    runs: [
      {
        id: "invalid-run",
        sessionId: "legacy-session",
        activity: "chat",
        lifecycle: { taskState: "TASK_STATE_UNSPECIFIED" },
        input: "legacy",
        createdAt: at,
        updatedAt: at,
        startedAt: at,
        resumeCount: 0,
        approvalIds: [],
        questionIds: [],
        toolIds: [],
        eventCount: 0,
      },
    ],
  });

  assert.deepEqual(store.getRun("invalid-run")?.lifecycle, {
    taskState: "TASK_STATE_FAILED",
    reasonCode: "persisted_lifecycle_invalid",
    retryable: false,
    outcomeUnknown: true,
  });
});

test("turn.finished requires an explicit outcome", () => {
  const store = startedStore();
  store.recordEvent({ type: "turn.finished", runId: "run-1", at } as AgentEvent);
  assert.deepEqual(store.getRun("run-1")?.lifecycle, {
    taskState: "TASK_STATE_FAILED",
    reasonCode: "terminal_outcome_missing",
    retryable: false,
    outcomeUnknown: true,
  });
});

test("a WW credential retry withholds the failed terminal before persistence and reuses the Run identity", async () => {
  const runId = "run-ww-retry";
  let nativeAttempt = 0;
  const runtime: AgentRuntime = {
    async *runTurn(request) {
      nativeAttempt += 1;
      const currentRunId = request.runId ?? runId;
      yield { type: "turn.started", runId: currentRunId, at };
      if (nativeAttempt === 1) {
        yield { type: "error", runId: currentRunId, message: "API_KEY_INVALID" };
        yield {
          type: "turn.finished",
          runId: currentRunId,
          at,
          outcome: { taskState: "TASK_STATE_FAILED", reasonCode: "claude_agent_sdk_failed" },
        };
        return;
      }
      yield { type: "model.response", runId: currentRunId, response: { text: "recovered answer" } };
      yield {
        type: "turn.finished",
        runId: currentRunId,
        at,
        outcome: { taskState: "TASK_STATE_COMPLETED" },
      };
    },
  };
  const app = createOpenGrove({ readPage: async () => ({}), runtime, cwd: process.cwd() });
  const visibleEvents: AgentEvent[] = [];

  const firstAttempt = await consumeWwRetryableTurnAttempt({
    events: app.runTurn("hello", {
      runId,
      sessionId: "session-ww-retry",
      eventPersistence: "caller",
    }),
    withholdWwKeyFailure: true,
    onEvent(event) {
      app.recordEvent(event, { sessionId: "session-ww-retry", input: "hello" });
      visibleEvents.push(event);
    },
  });

  assert.equal(firstAttempt.withheldError?.message, "API_KEY_INVALID");
  assert.equal(app.sessions.getRun(runId)?.lifecycle.taskState, "TASK_STATE_WORKING");
  assert.equal(app.sessions.getRun(runId)?.endedAt, undefined);

  const secondAttempt = await consumeWwRetryableTurnAttempt({
    events: app.runTurn("hello", {
      runId,
      sessionId: "session-ww-retry",
      eventPersistence: "caller",
    }),
    withholdWwKeyFailure: false,
    onEvent(event) {
      app.recordEvent(event, { sessionId: "session-ww-retry", input: "hello" });
      visibleEvents.push(event);
    },
  });

  assert.equal(secondAttempt.withheldError, undefined);
  assert.equal(app.sessions.getRun(runId)?.lifecycle.taskState, "TASK_STATE_COMPLETED");
  assert.equal(
    visibleEvents.filter((event) => event.type === "model.response").length,
    1,
    "the user must see only the recovered answer",
  );
  assert.equal(
    visibleEvents.some((event) => event.type === "error" && event.message === "API_KEY_INVALID"),
    false,
  );
});

test("a Runtime exception is converted into an explicit failed terminal event", async () => {
  const runtime: AgentRuntime = {
    async *runTurn() {
      throw new Error("runtime exploded");
    },
  };
  const app = createOpenGrove({ readPage: async () => ({}), runtime, cwd: process.cwd() });
  const events: AgentEvent[] = [];
  for await (const event of app.runTurn("hello", {
    runId: "run-runtime-exception",
    sessionId: "session-runtime-exception",
  }))
    events.push(event);

  assert.ok(events.some((event) => event.type === "error" && event.message === "runtime exploded"));
  assert.ok(
    events.some(
      (event) =>
        event.type === "turn.finished" &&
        event.outcome.taskState === "TASK_STATE_FAILED" &&
        event.outcome.reasonCode === "kernel_runtime_exception" &&
        event.outcome.outcomeUnknown === true,
    ),
  );
  assert.equal(app.sessions.getRun("run-runtime-exception")?.lifecycle.taskState, "TASK_STATE_FAILED");
});

test("turn.finished owns the terminal outcome after an earlier error", () => {
  const store = startedStore();
  store.recordEvent({ type: "error", runId: "run-1", message: "native process interrupted" });
  store.recordEvent({
    type: "turn.finished",
    runId: "run-1",
    at,
    outcome: { taskState: "TASK_STATE_CANCELED", reasonCode: "user_canceled", retryable: false },
  });

  assert.deepEqual(store.getRun("run-1")?.lifecycle, {
    taskState: "TASK_STATE_CANCELED",
    reasonCode: "user_canceled",
    retryable: false,
  });
  assert.equal(store.getRun("run-1")?.endedAt, at);
});

test("terminal lifecycle is monotonic under late events", () => {
  const store = startedStore();
  store.recordEvent({
    type: "turn.finished",
    runId: "run-1",
    at,
    outcome: lifecycleFromRunFact({ kind: "completed" }),
  });
  store.recordEvent({ type: "error", runId: "run-1", message: "late error" });
  assert.deepEqual(store.getRun("run-1")?.lifecycle, { taskState: "TASK_STATE_COMPLETED" });
  assert.equal(store.getRun("run-1")?.error, undefined);
});

test("rejected interaction remains paused until an explicit terminal outcome", () => {
  const store = startedStore();
  const request: ApprovalRequest = {
    id: "approval-1",
    kind: "tool",
    title: "Approve tool",
    reason: "Test",
    toolId: "tool-1",
    status: "rejected",
    createdAt: at,
    updatedAt: at,
  };
  const events: AgentEvent[] = [
    { type: "approval.requested", runId: "run-1", request: { ...request, status: "pending" } },
    { type: "approval.resolved", runId: "run-1", request },
  ];
  for (const event of events) store.recordEvent(event);
  assert.equal(store.getRun("run-1")?.lifecycle.taskState, "TASK_STATE_INPUT_REQUIRED");
});

test("approved interaction resumes working without guessing a terminal outcome", () => {
  const store = startedStore();
  const request: ApprovalRequest = {
    id: "approval-1",
    kind: "tool",
    title: "Approve tool",
    reason: "Test",
    toolId: "tool-1",
    status: "approved",
    createdAt: at,
    updatedAt: at,
  };
  store.recordEvent({ type: "approval.requested", runId: "run-1", request: { ...request, status: "pending" } });
  store.recordEvent({ type: "approval.resolved", runId: "run-1", request });
  assert.equal(store.getRun("run-1")?.lifecycle.taskState, "TASK_STATE_WORKING");
});

test("a non-blocking native question does not pause the Run", () => {
  const store = startedStore();
  store.recordEvent({
    type: "question.requested",
    runId: "run-1",
    question: {
      id: "question-1",
      title: "Optional input",
      prompt: "Add context if useful",
      status: "pending",
      isBlocking: false,
      nativeRequestId: "native-question-1",
      createdAt: at,
      updatedAt: at,
    },
  });

  assert.equal(store.getRun("run-1")?.lifecycle.taskState, "TASK_STATE_WORKING");
  assert.deepEqual(store.getRun("run-1")?.questionIds, ["question-1"]);
});

test("streaming deltas checkpoint a bounded tail without a second journal", () => {
  const runId = "run-delta-checkpoint";
  const checkpointPolicy = createAgentEventCheckpointPolicy();
  assert.equal(checkpointPolicy.shouldCheckpoint({ type: "turn.started", runId, at }, { now: 1_000 }), true);
  assert.equal(
    checkpointPolicy.shouldCheckpoint(
      { type: "assistant.delta", runId, text: "a" },
      { now: 1_100, maxPendingEvents: 2 },
    ),
    false,
  );
  assert.equal(
    checkpointPolicy.shouldCheckpoint(
      { type: "assistant.delta", runId, text: "b" },
      { now: 1_200, maxPendingEvents: 2 },
    ),
    true,
  );
  assert.equal(
    checkpointPolicy.shouldCheckpoint(
      { type: "tool.progress", runId, toolId: "bash", callId: "call-1", update: { status: "running" } },
      { now: 6_300 },
    ),
    true,
  );
  const independentPolicy = createAgentEventCheckpointPolicy();
  assert.equal(
    independentPolicy.shouldCheckpoint(
      { type: "assistant.delta", runId, text: "independent" },
      { now: 6_300, maxPendingEvents: 2 },
    ),
    false,
    "checkpoint cadence must be owned by one Host instance rather than a module-global Run map",
  );
});
