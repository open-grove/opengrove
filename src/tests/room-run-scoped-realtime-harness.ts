import assert from "node:assert/strict";
import { createOpenGrove, type OpenGroveApp } from "../app/create-opengrove.js";
import type { AgentEvent, AgentRuntime, ApprovalResume } from "../core.js";
import { resolveApproval } from "../server/approval-actions.js";
import type { BridgeState } from "../server/bridge-types.js";
import { resolveQuestion } from "../server/question-actions.js";
import { recordRoomRunEvent } from "../server/room-runs.js";
import {
  clearActiveRoomRunExecutionState,
  registerActiveRoomRunExecutionState,
} from "../server/room-runs/scheduler.js";

const MODEL_ID = "harness-model";
const SESSION_ID = "room-agent-harness";
const USER_INPUT = "实时过程流测试";

async function main(): Promise<void> {
  await assertScopedEventsMirrorToRootWhileRunning();
  await assertScopedQuestionsResolveThroughRootState();
  await assertNativeApprovalsResumeSameLoop();
  await assertNonScopedEventsAreNotMirroredTwice();
  await assertNonScopedEventsContinueAfterHotAppReplacement();
  console.log("room-run-scoped-realtime-harness passed");
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
    const approval = state.app.approvals.request({
      kind: "tool",
      title: "Native tool approval",
      reason: "The native loop is waiting for this decision.",
      resume,
    });
    const waiter = state.app.approvals.waitForDecision(approval.id);
    const result = await resolveApproval(state, approval.id, "approved");
    const decided = await waiter;
    assert.equal(result.approval.status, "approved");
    assert.equal(decided.status, "approved");
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
        yield { type: "turn.finished", runId, at: new Date().toISOString() };
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
      yield { type: "turn.finished", runId, at: new Date().toISOString() };
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
