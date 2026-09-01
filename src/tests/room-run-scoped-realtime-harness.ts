import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove, type OpenGroveApp } from "../app/create-opengrove.js";
import type { AgentEvent, AgentRuntime, ApprovalResume } from "../core.js";
import { appEnvName } from "../identity.js";
import { resolveApproval } from "../server/approval-actions.js";
import { createBridgeState } from "../server/bridge-state.js";
import type { BridgeState } from "../server/bridge-types.js";
import { resolveQuestion } from "../server/question-actions.js";
import { recordRoomRunEvent, scheduleRoomAssistantRuns } from "../server/room-runs.js";
import { activeBridgeRunExecutionState, registerActiveBridgeRun } from "../server/active-runs.js";
import { roomExecutionState } from "../server/room-runs/execution-state.js";
import { consumeWwRetryableTurnAttempt } from "../server/ww-provider-recovery.js";
import { createWwRetryClaudeCliFixture, createWwRetryFixture } from "./harnesses/ww-retry-fixture.js";
import {
  clearActiveRoomRunExecutionState,
  hasActiveRoomRunController,
  registerActiveRoomRunExecutionState,
} from "../server/room-runs/scheduler.js";

const MODEL_ID = "harness-model";
const SESSION_ID = "room-agent-harness";
const USER_INPUT = "实时过程流测试";

async function main(): Promise<void> {
  await assertRoomProductionOrchestrationPersistsEachEventOnce();
  await assertRoomProductionOrchestrationRecoversWwCredential();
  await assertScopedEventsMirrorToRootWhileRunning();
  await assertScopedQuestionsResolveThroughRootState();
  await assertScopedSameLoopInteractionsRequireLiveWaiters();
  await assertNativeApprovalsResumeSameLoop();
  await assertNonScopedEventsAreNotMirroredTwice();
  await assertNonScopedEventsContinueAfterHotAppReplacement();
  await assertRoomRetryWithholdsFailedTerminalBeforePersistence();
  console.log("room-run-scoped-realtime-harness passed");
}

async function assertRoomProductionOrchestrationRecoversWwCredential(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-room-production-ww-retry-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const ww = await createWwRetryFixture();
  const cli = createWwRetryClaudeCliFixture(directory);
  const model = "claude-opus-4-8";
  const runtimeModeEnv = appEnvName("CLAUDE_CODE_RUNTIME");
  const previousRuntimeMode = process.env[runtimeModeEnv];
  try {
    process.env[runtimeModeEnv] = "cli";
    state.settings = {
      ...state.settings,
      customProviders: [ww.provider(model)],
      modelProviderBindings: [{ modelId: model, providerId: "ww" }],
      kernelPathOverrides: {
        ...state.settings.kernelPathOverrides,
        "claude-code": { binaryPath: cli.path },
      },
    };
    const target = state.app.rooms.upsertMember({
      id: "employee-room-production-ww-retry",
      name: "WW retry employee",
      kernel: "claude-code",
      model,
      providerId: "ww",
      role: "Exercise the production Room WW retry boundary.",
      status: "idle",
      color: "#f59e0b",
      lastActive: "now",
      source: "local",
    });
    const roomId = "room-production-ww-retry";
    state.app.rooms.ensureGroupRoom({
      id: roomId,
      title: "Production WW retry",
      badge: "Test",
      memberIds: [target.id],
    });

    const post = state.app.rooms.postUserMessage({
      roomId,
      text: "Recover the WW credential through the production Room scheduler",
      targetIds: [target.id],
      assistantTargets: [target],
      deliveryKind: "user_direct",
    });
    let finalizedEvents: AgentEvent[] = [];
    const finalized = new Promise<void>((resolve) => {
      scheduleRoomAssistantRuns(state, {
        roomId,
        triggerMessageId: post.userMessage.id,
        targets: [target],
        assistantMessages: post.assistantMessages,
        wwAuth: ww.auth,
        onMessageFinalized(result) {
          finalizedEvents = result.events;
          resolve();
        },
      });
    });
    await finalized;

    assert.equal(
      cli.calls(),
      2,
      `the production Room loop must retry after a safe WW key repair: ${JSON.stringify({
        ww: ww.counts(),
        events: finalizedEvents.map((event) =>
          event.type === "runtime.diagnostic"
            ? `${event.type}:${event.name}`
            : event.type === "error"
              ? `${event.type}:${event.message}`
              : event.type,
        ),
      })}`,
    );
    assert.deepEqual(ww.counts(), { list: 1, create: 1 });
    assert.equal(
      finalizedEvents.some((event) => event.type === "error"),
      false,
    );
    assert.equal(
      finalizedEvents.some(
        (event) => event.type === "turn.finished" && event.outcome.taskState === "TASK_STATE_FAILED",
      ),
      false,
    );
    assert.ok(
      finalizedEvents.some((event) => event.type === "runtime.diagnostic" && event.name === "ww.api_key.repaired"),
    );
    const completed = finalizedEvents.find(
      (event): event is Extract<AgentEvent, { type: "turn.finished" }> =>
        event.type === "turn.finished" && event.outcome.taskState === "TASK_STATE_COMPLETED",
    );
    assert.ok(completed);
    assert.equal(state.app.sessions.getRun(completed.runId)?.lifecycle.taskState, "TASK_STATE_COMPLETED");
  } finally {
    if (previousRuntimeMode === undefined) delete process.env[runtimeModeEnv];
    else process.env[runtimeModeEnv] = previousRuntimeMode;
    await ww.close();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function assertRoomProductionOrchestrationPersistsEachEventOnce(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-room-production-persistence-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  let releaseRuntime: () => void = () => undefined;
  let signalMidway: () => void = () => undefined;
  const midway = new Promise<void>((resolve) => {
    signalMidway = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  try {
    const providerId = "room-production-provider";
    state.settings.customProviders = [
      {
        id: providerId,
        name: "Room production provider",
        custom: true,
        enabled: true,
        origin: "user",
        protocol: "anthropic-compatible",
        anthropicBaseUrl: "https://room-production.example.test",
        apiKey: "room-production-test-key",
        credentialKind: "api-key",
        models: [{ id: state.model, label: state.model }],
      },
    ];
    state.settings.modelProviderBindings = [{ modelId: state.model, providerId }];
    const target = state.app.rooms.upsertMember({
      id: "employee-room-production-persistence",
      name: "Persistence employee",
      kernel: state.kernel,
      model: state.model,
      providerId,
      role: "Exercise the production Room Run event ownership boundary.",
      status: "idle",
      color: "#2563eb",
      lastActive: "now",
      source: "local",
    });
    const roomId = "room-production-persistence";
    state.app.rooms.ensureGroupRoom({
      id: roomId,
      title: "Production persistence",
      badge: "Test",
      memberIds: [target.id],
    });

    const preparedExecutionState = roomExecutionState(state, target);
    const adapter = preparedExecutionState.kernelAdapter;
    assert.ok(adapter, "the production Room harness requires a cached Kernel adapter");
    adapter.runTurn = async function* runHarnessTurn(request): AsyncIterable<AgentEvent> {
      const runId = request.runId ?? "missing-room-run-id";
      yield { type: "turn.started", runId, at: new Date().toISOString() };
      signalMidway();
      await released;
      yield { type: "assistant.delta", runId, text: "production Room answer" };
      yield { type: "model.response", runId, response: { text: "production Room answer" } };
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: { taskState: "TASK_STATE_COMPLETED" },
      };
    };

    const post = state.app.rooms.postUserMessage({
      roomId,
      text: "Run through the production Room scheduler",
      targetIds: [target.id],
      assistantTargets: [target],
      deliveryKind: "user_direct",
    });
    const [scheduled] = scheduleRoomAssistantRuns(state, {
      roomId,
      triggerMessageId: post.userMessage.id,
      targets: [target],
      assistantMessages: post.assistantMessages,
    });
    assert.ok(scheduled?.runId, "the production Room scheduler must allocate a Run identity");
    await midway;
    const liveExecutionState = activeBridgeRunExecutionState(state, scheduled.runId);
    assert.ok(liveExecutionState, "the active Run registry must expose the producing Room execution state");
    assert.equal(
      eventsForRun(liveExecutionState.app, scheduled.runId).filter((event) => event.type === "turn.started").length,
      1,
      "the production Room owner must persist turn.started exactly once in the producing App",
    );

    releaseRuntime();
    await waitFor(() => !hasActiveRoomRunController(state, scheduled.runId!), "production Room Run completion");
    assert.equal(
      eventsForRun(state.app, scheduled.runId).filter((event) => event.type === "turn.finished").length,
      1,
      "the root Room ledger must persist the terminal event exactly once",
    );
  } finally {
    releaseRuntime();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function assertRoomRetryWithholdsFailedTerminalBeforePersistence(): Promise<void> {
  let attempt = 0;
  const runtime: AgentRuntime = {
    async *runTurn(request) {
      attempt += 1;
      const runId = request.runId ?? "run-room-ww-retry";
      yield { type: "turn.started", runId, at: new Date().toISOString() };
      if (attempt === 1) {
        yield { type: "error", runId, message: "API Error: 401 API_KEY_INVALID (110203)" };
        yield {
          type: "turn.finished",
          runId,
          at: new Date().toISOString(),
          outcome: { taskState: "TASK_STATE_FAILED", reasonCode: "claude_agent_sdk_failed" },
        };
        return;
      }
      yield { type: "assistant.delta", runId, text: "recovered room answer" };
      yield { type: "model.response", runId, response: { text: "recovered room answer" } };
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: { taskState: "TASK_STATE_COMPLETED" },
      };
    },
  };
  const state = bridgeState(createHarnessApp(runtime));
  const runId = "run-room-ww-retry";
  const events: AgentEvent[] = [];
  for (let index = 0; index < 2; index += 1) {
    const result = await consumeWwRetryableTurnAttempt({
      events: state.app.runTurn("room retry input", {
        sessionId: "room-retry-session",
        runId,
        eventPersistence: "caller",
      }),
      withholdWwKeyFailure: index === 0,
      onEvent: (event) =>
        recordRoomRunEvent({
          state,
          activeExecutionState: state,
          eventSourceApp: state.app,
          event,
          events,
          model: MODEL_ID,
          sessionId: "room-retry-session",
          userInput: "room retry input",
        }),
    });
    if (!result.withheldError) break;
  }
  assert.equal(attempt, 2);
  assert.equal(state.app.sessions.getRun(runId)?.lifecycle.taskState, "TASK_STATE_COMPLETED");
  assert.equal(events.filter((event) => event.type === "model.response").length, 1);
  assert.equal(
    events.some((event) => event.type === "error" && event.message.includes("API_KEY_INVALID")),
    false,
  );
  const persistedTypes = state.app.events
    .list()
    .filter((event) => event.runId === runId)
    .map((event) => event.type);
  assert.ok(persistedTypes.includes("assistant.final"), "Room final text must be part of the durable event stream");
  assert.ok(
    persistedTypes.indexOf("assistant.final") < persistedTypes.indexOf("turn.finished"),
    "Room final text must be persisted before its terminal event",
  );
}

async function assertNativeApprovalsResumeSameLoop(): Promise<void> {
  const state = bridgeState(createHarnessApp(createIdleRuntime()));
  const resumes: ApprovalResume[] = [
    {
      type: "kernel.native",
      kernelId: "pi",
      runId: "run-native-approval",
      continuation: "same-loop",
    },
  ];

  for (const resume of resumes) {
    const runId = resume.runId ?? "run-native-approval";
    const release = registerActiveBridgeRun(state, runId);
    registerActiveRoomRunExecutionState(state, runId, state);
    const approval = state.app.approvals.request({
      kind: "tool",
      title: "Native tool approval",
      reason: "The native loop is waiting for this decision.",
      resume,
    });
    recordRoomRunEvent({
      state,
      activeExecutionState: state,
      eventSourceApp: state.app,
      event: { type: "approval.requested", runId, request: approval },
      events: [],
      model: MODEL_ID,
      sessionId: SESSION_ID,
      userInput: USER_INPUT,
    });
    const waiter = state.app.approvals.waitForDecision(approval.id);
    const result = await resolveApproval(state, approval.id, "approved");
    const decided = await waiter;
    assert.equal(result.approval.status, "approved");
    assert.equal(decided.status, "approved");
    release();
    const repeated = await resolveApproval(state, approval.id, "approved");
    assert.equal(repeated.alreadyResolved, true, "repeating a settled approval must remain idempotent");
  }
}

async function assertScopedEventsMirrorToRootWhileRunning(): Promise<void> {
  const gate = createGateRuntime();
  const rootState = bridgeState(createHarnessApp(createIdleRuntime()));
  const scopedState = bridgeState(createHarnessApp(gate.runtime), rootState);
  const runId = "run-scoped-realtime";
  const events: AgentEvent[] = [];

  const turn = collectRunEvents(rootState, scopedState, runId, events);
  await gate.midway;

  const midwayRootEvents = eventsForRun(rootState.app, runId);
  assert.equal(countByType(midwayRootEvents, "turn.started"), 1, "scoped turn.started should be visible before finish");
  assert.equal(
    countByType(midwayRootEvents, "assistant.delta"),
    1,
    "scoped assistant.delta should be visible before finish",
  );
  assert.equal(countByType(midwayRootEvents, "turn.finished"), 0, "harness must assert before turn.finished");

  gate.release();
  await turn;

  const finishedRootEvents = eventsForRun(rootState.app, runId);
  assert.equal(countByType(finishedRootEvents, "turn.started"), 1);
  assert.equal(countByType(finishedRootEvents, "assistant.delta"), 1);
  assert.equal(countByType(finishedRootEvents, "model.response"), 1);
  assert.equal(countByType(finishedRootEvents, "assistant.final"), 1);
  assert.equal(countByType(finishedRootEvents, "turn.finished"), 1);
  assert.deepEqual(
    eventTypeSequence(finishedRootEvents).filter((type) => type !== "skill.discovered"),
    eventTypeSequence(events).filter((type) => type !== "skill.discovered"),
    "root mirror should match the scoped run stream without end-of-run batch duplicates",
  );
}

async function assertScopedQuestionsResolveThroughRootState(): Promise<void> {
  const rootState = bridgeState(createHarnessApp(createIdleRuntime()));
  const scopedState = bridgeState(createHarnessApp(createIdleRuntime()), rootState);
  const runId = "run-scoped-question";
  const events: AgentEvent[] = [];
  const question = scopedState.app.questions.request({
    title: "AskUserQuestion",
    prompt: "Pick a path",
    input: {
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Choose?",
            header: "Choice",
            options: [{ label: "A", description: "Use A" }],
          },
        ],
      },
    },
    resume: {
      type: "kernel.native",
      kernelId: "claude-code",
      runId,
      continuation: "same-loop",
    },
    source: { type: "kernel.native", kernelId: "claude-code" },
  });
  const waiter = scopedState.app.questions.waitForDecision(question.id);
  registerActiveRoomRunExecutionState(rootState, runId, scopedState);
  try {
    recordRoomRunEvent({
      state: rootState,
      activeExecutionState: scopedState,
      eventSourceApp: scopedState.app,
      event: { type: "question.requested", runId, question },
      events,
      model: MODEL_ID,
      sessionId: SESSION_ID,
      userInput: USER_INPUT,
    });

    assert.equal(rootState.app.questions.get(question.id)?.status, "pending");
    const result = await resolveQuestion(rootState, question.id, "answered", { answers: { Choice: "A" } });
    const decided = await waiter;

    assert.equal(decided.status, "answered");
    assert.deepEqual(decided.response, { answers: { Choice: "A" } });
    assert.equal(result.question.status, "answered");
    assert.equal(rootState.app.questions.get(question.id)?.status, "answered");
    clearActiveRoomRunExecutionState(rootState, runId);
    const repeated = await resolveQuestion(rootState, question.id, "answered", { answers: { Choice: "A" } });
    assert.equal(repeated.alreadyResolved, true, "repeating a settled question must not require a live producer");
  } finally {
    clearActiveRoomRunExecutionState(rootState, runId);
  }
}

async function assertScopedSameLoopInteractionsRequireLiveWaiters(): Promise<void> {
  const rootState = bridgeState(createHarnessApp(createIdleRuntime()));
  const scopedState = bridgeState(createHarnessApp(createIdleRuntime()), rootState);
  const runId = "run-scoped-no-waiter";
  registerActiveRoomRunExecutionState(rootState, runId, scopedState);
  try {
    const question = scopedState.app.questions.request({
      title: "No question waiter",
      prompt: "This producer is not actually waiting.",
      resume: { type: "kernel.native", kernelId: "codex", runId, continuation: "same-loop" },
    });
    recordRoomRunEvent({
      state: rootState,
      activeExecutionState: scopedState,
      eventSourceApp: scopedState.app,
      event: { type: "question.requested", runId, question },
      events: [],
      model: MODEL_ID,
      sessionId: SESSION_ID,
      userInput: USER_INPUT,
    });
    await assert.rejects(
      resolveQuestion(rootState, question.id, "answered", { answer: "unsafe" }),
      /question_producer_not_live/,
    );
    assert.equal(scopedState.app.questions.get(question.id)?.status, "pending");

    const approval = scopedState.app.approvals.request({
      kind: "tool",
      title: "No approval waiter",
      reason: "This producer is not actually waiting.",
      resume: { type: "kernel.native", kernelId: "codex", runId, continuation: "same-loop" },
    });
    recordRoomRunEvent({
      state: rootState,
      activeExecutionState: scopedState,
      eventSourceApp: scopedState.app,
      event: { type: "approval.requested", runId, request: approval },
      events: [],
      model: MODEL_ID,
      sessionId: SESSION_ID,
      userInput: USER_INPUT,
    });
    await assert.rejects(resolveApproval(rootState, approval.id, "approved"), /approval_producer_not_live/);
    assert.equal(scopedState.app.approvals.get(approval.id)?.status, "pending");
  } finally {
    clearActiveRoomRunExecutionState(rootState, runId);
  }
}

async function assertNonScopedEventsAreNotMirroredTwice(): Promise<void> {
  const gate = createGateRuntime();
  const rootState = bridgeState(createHarnessApp(gate.runtime));
  const runId = "run-nonscoped-realtime";
  const events: AgentEvent[] = [];

  const turn = collectRunEvents(rootState, rootState, runId, events);
  await gate.midway;

  const midwayRootEvents = eventsForRun(rootState.app, runId);
  assert.equal(countByType(midwayRootEvents, "turn.started"), 1);
  assert.equal(countByType(midwayRootEvents, "assistant.delta"), 1);
  assert.equal(countByType(midwayRootEvents, "turn.finished"), 0);

  gate.release();
  await turn;

  const finishedRootEvents = eventsForRun(rootState.app, runId);
  assert.equal(countByType(finishedRootEvents, "turn.started"), 1);
  assert.equal(countByType(finishedRootEvents, "assistant.delta"), 1);
  assert.equal(countByType(finishedRootEvents, "model.response"), 1);
  assert.equal(countByType(finishedRootEvents, "assistant.final"), 1);
  assert.equal(countByType(finishedRootEvents, "turn.finished"), 1);
}

async function assertNonScopedEventsContinueAfterHotAppReplacement(): Promise<void> {
  const gate = createGateRuntime();
  const rootState = bridgeState(createHarnessApp(gate.runtime));
  const runId = "run-nonscoped-hot-reload";
  const events: AgentEvent[] = [];

  const turn = collectRunEvents(rootState, rootState, runId, events);
  await gate.midway;

  const producingApp = rootState.app;
  const replacementApp = createHarnessApp(createIdleRuntime());
  replacementApp.events.restore(producingApp.events.list());
  rootState.app = replacementApp;

  gate.release();
  await turn;

  const replacementEvents = eventsForRun(replacementApp, runId);
  assert.equal(countByType(replacementEvents, "turn.started"), 1);
  assert.equal(countByType(replacementEvents, "assistant.delta"), 1);
  assert.equal(countByType(replacementEvents, "model.response"), 1);
  assert.equal(countByType(replacementEvents, "turn.finished"), 1);
}

async function collectRunEvents(
  rootState: BridgeState,
  activeExecutionState: BridgeState,
  runId: string,
  events: AgentEvent[],
): Promise<void> {
  const eventSourceApp = activeExecutionState.app;
  for await (const event of eventSourceApp.runTurn(USER_INPUT, {
    sessionId: SESSION_ID,
    runId,
    requestedModelId: MODEL_ID,
    eventPersistence: "caller",
  })) {
    recordRoomRunEvent({
      state: rootState,
      activeExecutionState,
      eventSourceApp,
      event,
      events,
      model: MODEL_ID,
      sessionId: SESSION_ID,
      userInput: USER_INPUT,
    });
  }
}

function createGateRuntime(): {
  runtime: AgentRuntime;
  midway: Promise<void>;
  release: () => void;
} {
  let resolveMidway: () => void = () => undefined;
  let release: () => void = () => undefined;
  const midway = new Promise<void>((resolve) => {
    resolveMidway = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    midway,
    release,
    runtime: {
      async *runTurn(request) {
        const runId = request.runId ?? "run-harness";
        yield { type: "turn.started", runId, at: new Date().toISOString() };
        yield { type: "assistant.delta", runId, text: "partial" };
        resolveMidway();
        await released;
        yield { type: "model.response", runId, response: { text: "done" } };
        yield {
          type: "turn.finished",
          runId,
          at: new Date().toISOString(),
          outcome: { taskState: "TASK_STATE_COMPLETED" },
        };
      },
    },
  };
}

function createIdleRuntime(): AgentRuntime {
  return {
    async *runTurn(request) {
      const runId = request.runId ?? "run-idle";
      yield { type: "turn.started", runId, at: new Date().toISOString() };
      yield { type: "model.response", runId, response: { text: "idle" } };
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: { taskState: "TASK_STATE_COMPLETED" },
      };
    },
  };
}

function createHarnessApp(runtime: AgentRuntime): OpenGroveApp {
  return createOpenGrove({
    readPage: async () => ({
      title: "Harness",
      url: "opengrove://harness",
      visibleText: "",
    }),
    readComputer: async () => ({}),
    runtime,
    sessionId: "harness",
    userId: "harness",
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
  });
}

function bridgeState(app: OpenGroveApp, rootState?: BridgeState): BridgeState {
  const state = {
    app,
    store: {
      kind: "memory",
      path: "memory",
      loadInto: () => undefined,
      saveFrom: () => ({}),
    },
    rootState,
    profile: "local",
    snapshot: {},
    computerSnapshot: {},
    model: MODEL_ID,
    kernel: "codex",
    settings: {},
    saveCandidateNote: false,
    policyOverrides: [],
  } as unknown as BridgeState;
  state.rootState = rootState ?? state;
  return state;
}

function eventsForRun(app: OpenGroveApp, runId: string): AgentEvent[] {
  return app.events.list().filter((event) => event.runId === runId);
}

function countByType(events: AgentEvent[], type: AgentEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

function eventTypeSequence(events: AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
