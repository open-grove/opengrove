import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRuntime, AgentTurnRequest, Routine } from "../core.js";
import { createRoutineMemberExecutor, isRoutineDue, startRoutineScheduler } from "../server/routine-scheduler.js";
import { runRoutine, type RoutineStepActivityRef } from "../routines/routine-runner.js";
import { createOpenGrove } from "../app/create-opengrove.js";
import { createBridgeState } from "../server/bridge-state.js";
import { createRoutineProblemReporter } from "../server/routine-problems.js";
import { createRuntimeKernelAdapter } from "../kernel/adapter.js";
import { resolveRoomExecutionTarget } from "../server/room-runs/execution-state.js";

function createHarnessRuntime(): AgentRuntime {
  return {
    async *runTurn(request) {
      const runId = request.runId ?? "routine-scheduler-harness-run";
      yield { type: "turn.started", runId, at: new Date().toISOString() };
      yield { type: "assistant.delta", runId, text: "ok" };
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: { taskState: "TASK_STATE_COMPLETED" },
      };
    },
  };
}

function scheduledRoutine(at: string, lastFiredAt?: string, daysOfWeek?: number[]): Routine {
  return {
    id: "routine_test",
    title: "Scheduled routine",
    status: "active",
    trigger: "schedule",
    schedule: { at, ...(lastFiredAt ? { lastFiredAt } : {}), ...(daysOfWeek ? { daysOfWeek } : {}) },
    capabilityIds: [],
    steps: [],
    approvalRules: [],
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  };
}

function intervalRoutine(everyMinutes: number, lastFiredAt?: string, daysOfWeek?: number[]): Routine {
  return {
    id: "routine_interval_test",
    title: "Interval routine",
    status: "active",
    trigger: "schedule",
    schedule: { everyMinutes, ...(lastFiredAt ? { lastFiredAt } : {}), ...(daysOfWeek ? { daysOfWeek } : {}) },
    capabilityIds: [],
    steps: [],
    approvalRules: [],
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  };
}

// 2026-06-10 is a Wednesday (day 3).
const wednesdayMorning = new Date(2026, 5, 10, 9, 5, 0);

// Due once fire time has passed and it has not fired today.
assert.equal(isRoutineDue(scheduledRoutine("09:00"), wednesdayMorning), true);
// Not due before fire time.
assert.equal(isRoutineDue(scheduledRoutine("09:30"), wednesdayMorning), false);
// Not due twice in the same day.
assert.equal(
  isRoutineDue(scheduledRoutine("09:00", new Date(2026, 5, 10, 9, 0, 30).toISOString()), wednesdayMorning),
  false,
);
// Due again the next day.
assert.equal(
  isRoutineDue(scheduledRoutine("09:00", new Date(2026, 5, 9, 9, 0, 30).toISOString()), wednesdayMorning),
  true,
);
// Day-of-week filter.
assert.equal(isRoutineDue(scheduledRoutine("09:00", undefined, [3]), wednesdayMorning), true);
assert.equal(isRoutineDue(scheduledRoutine("09:00", undefined, [1, 5]), wednesdayMorning), false);
// Interval schedules are due immediately when never fired, then after N minutes.
assert.equal(isRoutineDue(intervalRoutine(2), wednesdayMorning), true);
assert.equal(isRoutineDue(intervalRoutine(2, new Date(2026, 5, 10, 9, 3, 0).toISOString()), wednesdayMorning), true);
assert.equal(isRoutineDue(intervalRoutine(2, new Date(2026, 5, 10, 9, 4, 0).toISOString()), wednesdayMorning), false);
assert.equal(isRoutineDue(intervalRoutine(2, undefined, [3]), wednesdayMorning), true);
assert.equal(isRoutineDue(intervalRoutine(2, undefined, [1, 5]), wednesdayMorning), false);
assert.equal(isRoutineDue(intervalRoutine(0), wednesdayMorning), false);
// No schedule or malformed time → never due.
assert.equal(isRoutineDue({ ...scheduledRoutine("09:00"), schedule: undefined }, wednesdayMorning), false);
assert.equal(isRoutineDue(scheduledRoutine("25:99"), wednesdayMorning), false);

// A Kernel turn that legitimately waits indefinitely must not block the
// scheduler from launching another due Routine. The Host owns scheduler
// liveness, not an invented wall-clock deadline for the native turn.
const detachedRoutines = [
  { ...intervalRoutine(1), id: "routine_waiting" },
  { ...intervalRoutine(1), id: "routine_ready" },
];
const launchedRoutineIds: string[] = [];
let releaseWaitingRoutine: (() => void) | undefined;
const waitingRoutine = new Promise<void>((resolve) => {
  releaseWaitingRoutine = resolve;
});
const schedulerState = {
  app: {
    routines: {
      list: () => detachedRoutines,
      update: (routineId: string, patch: Partial<Routine>) => {
        const index = detachedRoutines.findIndex((routine) => routine.id === routineId);
        if (index < 0) return undefined;
        detachedRoutines[index] = { ...detachedRoutines[index]!, ...patch } as Routine;
        return detachedRoutines[index];
      },
    },
  },
  store: { saveFrom: () => undefined },
} as unknown as Parameters<typeof startRoutineScheduler>[0];
const stopDetachedScheduler = startRoutineScheduler(schedulerState, {
  tickMs: 5,
  executeRoutine: async (_state, routine) => {
    launchedRoutineIds.push(routine.id);
    if (routine.id === "routine_waiting") await waitingRoutine;
  },
});
await new Promise((resolve) => setTimeout(resolve, 30));
stopDetachedScheduler();
releaseWaitingRoutine?.();
assert.deepEqual(new Set(launchedRoutineIds), new Set(["routine_waiting", "routine_ready"]));

// Member steps run through the injected executor; results land in toolResults.
const app = createOpenGrove({
  cwd: mkdtempSync(join(tmpdir(), "opengrove-routine-scheduler-")),
  readPage: () => ({
    title: "Routine Scheduler Harness",
    url: "https://example.com/routine-scheduler",
    selection: "",
    locator: "harness",
    visibleText: "",
  }),
  runtime: createHarnessRuntime(),
  sessionId: "routine-scheduler-harness",
  userId: "local-user",
});
const memberRoutine = app.routines.create({
  title: "Member routine",
  status: "active",
  trigger: "schedule",
  schedule: { at: "09:00" },
  capabilityIds: [],
  approvalRules: [],
  steps: [{ id: "step_1", title: "出归因日报", memberId: "member-attribution", prompt: "生成今天的归因日报" }],
});

const requests: { memberId: string; prompt: string }[] = [];
const okRun = await runRoutine(app, memberRoutine.id, {
  memberExecutor: (request) => {
    requests.push({ memberId: request.memberId, prompt: request.prompt });
    return Promise.resolve({ ok: true, value: { messageId: "msg_1" } });
  },
});
assert.equal(okRun.summary.status, "succeeded");
assert.equal(requests.length, 1);
assert.equal(requests[0]?.memberId, "member-attribution");
assert.equal(requests[0]?.prompt, "生成今天的归因日报");
assert.equal(okRun.toolResults[0]?.ok, true);

// Executor failure → routine run fails with the error preserved.
const failedRun = await runRoutine(app, memberRoutine.id, {
  memberExecutor: () => Promise.resolve({ ok: false, error: "member_step_timeout" }),
  problemReporter: (input) => ({ incidentId: "OG-20260714-A1B2C3", code: input.code }),
});
assert.equal(failedRun.summary.status, "failed");
assert.equal(failedRun.summary.error, "member_step_timeout");
assert.deepEqual(failedRun.summary.problem, {
  incidentId: "OG-20260714-A1B2C3",
  code: "employee_routine_member_timeout",
});
assert.deepEqual(app.sessions.getRun(failedRun.summary.id)?.problem, failedRun.summary.problem);
assert.equal(
  app.routines.get(memberRoutine.id)?.status,
  "active",
  "an operational Run failure must not mark a valid Routine definition as needs_repair",
);

// No executor wired → fails fast instead of silently skipping.
const noExecutorRun = await runRoutine(app, memberRoutine.id, {
  problemReporter: (input) => ({ incidentId: "OG-20260714-D4E5F6", code: input.code }),
});
assert.equal(noExecutorRun.summary.status, "failed");
assert.equal(noExecutorRun.summary.error, "member_step_executor_unavailable");
assert.equal(noExecutorRun.summary.problem?.code, "employee_routine_member_executor_unavailable");
assert.equal(app.routines.get(memberRoutine.id)?.status, "active");

const previousDiagnosticsDir = process.env.OPENGROVE_DIAGNOSTICS_DIR;
const previousCodexBin = process.env.OPENGROVE_CODEX_BIN;
const bridgeDiagnosticsRoot = mkdtempSync(join(tmpdir(), "opengrove-routine-diagnostics-"));
process.env.OPENGROVE_DIAGNOSTICS_DIR = bridgeDiagnosticsRoot;
// The harness replaces every seeded Room worker with the fake adapter below
// before a turn runs. Use the current Node executable only to keep adapter
// discovery hermetic instead of requiring Codex to be installed on the host.
process.env.OPENGROVE_CODEX_BIN = process.execPath;
const bridgeState = createBridgeState({
  statePath: join(mkdtempSync(join(tmpdir(), "opengrove-routine-member-executor-")), "state.json"),
});
bridgeState.kernel = "codex";
bridgeState.model = "routine-harness-model";
bridgeState.settings.kernel = "codex";
bridgeState.settings.languagePreference = "en";
bridgeState.settings.customProviders.push({
  id: "acme-internal-gateway",
  name: "Acme Internal Gateway",
  protocol: "openai-compatible",
  custom: true,
  origin: "user",
  openaiBaseUrl: "https://example.invalid/v1",
  credentialKind: "api-key",
  apiKey: "routine-harness-key",
  models: [{ id: "routine-harness-model", label: "Harness model" }],
});
bridgeState.settings.modelProviderBindings = [
  {
    modelId: bridgeState.model,
    providerId: "acme-internal-gateway",
  },
];
bridgeState.app.rooms.upsertMember({
  id: "employee-live-todo",
  name: "Live Todo",
  kernel: bridgeState.kernel,
  model: bridgeState.model,
  role: "routine live todo harness employee",
  status: "idle",
  color: "#2563eb",
  lastActive: "now",
  source: "local",
});
bridgeState.app.rooms.openDirect({ memberId: "employee-live-todo", title: "Live Todo" });
let liveRoutineInput = "";
bridgeState.app.runTurn = async function* runFakeRoomTurn(input: string, options = {}): AsyncIterable<AgentEvent> {
  liveRoutineInput = input;
  const runId = (options as AgentTurnRequest).runId ?? "room-run";
  yield { type: "turn.started", runId, at: new Date().toISOString() };
  yield {
    type: "runtime.diagnostic",
    runId,
    at: new Date().toISOString(),
    name: "claude.sdk.init",
    data: { model: "claude-runtime-model", claudeCodeVersion: "2.1.test" },
  };
  if (input.includes("FAIL_EXPLICIT_CODE")) {
    throw Object.assign(new Error("Stream idle timeout - no chunks received (private custom provider details)"), {
      code: "provider_request_failed",
      request_id: "local-runtime-rpc-42",
    });
  }
  if (input.includes("FAIL_LIVE_ROUTINE")) {
    yield {
      type: "error",
      runId,
      message:
        "Claude Code returned an error result: API Error: Stream idle timeout - no chunks received (private provider failure details)",
      diagnostics: {
        runtimeModelId: "claude-runtime-model",
        runtimeVersion: "2.1.test",
        upstreamRequestId: "req-room-run-test",
      },
    };
    yield {
      type: "turn.finished",
      runId,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
    return;
  }
  yield {
    type: "planning.updated",
    runId,
    plan: {
      id: "plan-live",
      title: "Plan",
      text: "1. [inProgress] 处理派活",
      status: "inProgress",
      updatedAt: new Date().toISOString(),
      source: { type: "host" },
      raw: { plan: [{ step: input, status: "inProgress" }] },
    },
  };
  yield { type: "model.response", runId, response: { text: "LIVE_TODO_DONE" } };
  yield {
    type: "turn.finished",
    runId,
    at: new Date().toISOString(),
    outcome: { taskState: "TASK_STATE_COMPLETED" },
  };
};
const liveMember = bridgeState.app.rooms.listMembers().find((member) => member.id === "employee-live-todo");
assert.ok(liveMember);
resolveRoomExecutionTarget(bridgeState, liveMember);
const harnessAdapter = createRuntimeKernelAdapter({
  id: "codex",
  title: "Routine harness",
  runtime: {
    async *runTurn(request) {
      yield* bridgeState.app.runTurn(request.input, {
        runId: request.runId,
        requestedModelId: request.requestedModelId,
      });
    },
  },
});
for (const key of bridgeState.roomKernelAdapters?.keys() ?? []) {
  bridgeState.roomKernelAdapters?.set(key, harnessAdapter);
}
const liveRoutine = bridgeState.app.routines.create({
  title: "Live todo routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [{ id: "live-step", title: "Ask live employee", memberId: "employee-live-todo", prompt: "生成实时 todo" }],
});
const observedActivityRefs: RoutineStepActivityRef[] = [];
const liveRun = await runRoutine(bridgeState.app, liveRoutine.id, {
  memberExecutor: createRoutineMemberExecutor(bridgeState),
  statusObserver: {
    onStepStatus(input) {
      if (input.step.id === "live-step" && input.status === "running" && input.activityRef) {
        observedActivityRefs.push(input.activityRef);
      }
    },
  },
});
assert.equal(liveRun.summary.status, "succeeded");
assert.equal(observedActivityRefs.length, 1);
assert.match(observedActivityRefs[0]?.runId ?? "", /^room_run_/);
assert.ok(observedActivityRefs[0]?.messageId);
assert.ok(observedActivityRefs[0]?.roomId);
assert.match(liveRoutineInput, /Source: OpenGrove Routine/);
assert.match(liveRoutineInput, /<current-message>\n生成实时 todo\n<\/current-message>$/);
const liveRoutineTrigger = bridgeState.app.rooms
  .listMessages(observedActivityRefs[0]!.roomId, { limit: 20 })
  .find((message) => message.text === "生成实时 todo");
assert.equal(liveRoutineTrigger?.senderType, "system");
assert.equal(liveRoutineTrigger?.deliveryKind, "system_routine");

const failedLiveRoutine = bridgeState.app.routines.create({
  title: "Failed live routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    {
      id: "failed-live-step",
      title: "Fail live employee",
      memberId: "employee-live-todo",
      prompt: "FAIL_LIVE_ROUTINE",
    },
  ],
});
const failedLiveRun = await runRoutine(bridgeState.app, failedLiveRoutine.id, {
  memberExecutor: createRoutineMemberExecutor(bridgeState),
  problemReporter: createRoutineProblemReporter(bridgeState),
});
assert.equal(failedLiveRun.summary.status, "failed");
assert.match(failedLiveRun.summary.problem?.incidentId ?? "", /^OG-\d{8}-[A-F0-9]{6}$/);
assert.equal(failedLiveRun.summary.problem?.code, "employee_run_stream_idle_timeout");
assert.deepEqual(failedLiveRun.summary.problem, failedLiveRun.toolResults[0]?.problem);
const recordedProblems = readFileSync(join(bridgeDiagnosticsRoot, "problems.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(recordedProblems.length, 1, "Room failure should be recorded once and reused by Routine");
const { durationMs: failedRoomDurationMs, ...failedRoomFacts } = recordedProblems[0]?.facts ?? {};
assert.ok(Number.isInteger(failedRoomDurationMs) && failedRoomDurationMs >= 0);
assert.deepEqual(failedRoomFacts, {
  runKind: "room",
  kernelKind: "codex",
  providerKind: "custom-openai-compatible",
  selectedModelId: "routine-harness-model",
  requestedModelId: "routine-harness-model",
  runtimeModelId: "claude-runtime-model",
  runtimeVersion: "2.1.test",
  upstreamRequestId: "req-room-run-test",
});

const explicitCodeRoutine = bridgeState.app.routines.create({
  title: "Explicit error code routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    {
      id: "explicit-code-step",
      title: "Preserve explicit error code",
      memberId: "employee-live-todo",
      prompt: "FAIL_EXPLICIT_CODE",
    },
  ],
});
const explicitCodeRun = await runRoutine(bridgeState.app, explicitCodeRoutine.id, {
  memberExecutor: createRoutineMemberExecutor(bridgeState),
  problemReporter: createRoutineProblemReporter(bridgeState),
});
assert.equal(explicitCodeRun.summary.problem?.code, "provider_request_failed");
const allRecordedProblems = readFileSync(join(bridgeDiagnosticsRoot, "problems.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(allRecordedProblems.length, 2);
const { durationMs: explicitDurationMs, ...explicitFacts } = allRecordedProblems[1]?.facts ?? {};
assert.ok(Number.isInteger(explicitDurationMs) && explicitDurationMs >= 0);
assert.deepEqual(explicitFacts, {
  runKind: "room",
  kernelKind: "codex",
  providerKind: "custom-openai-compatible",
  selectedModelId: "routine-harness-model",
  requestedModelId: "routine-harness-model",
});
assert.doesNotMatch(JSON.stringify(allRecordedProblems[1]), /acme-internal-gateway/);
assert.doesNotMatch(JSON.stringify(allRecordedProblems[1]), /local-runtime-rpc-42/);

bridgeState.settings.modelProviderBindings = [
  {
    modelId: bridgeState.model,
    providerId: "deepseek",
  },
];
const previousDeepSeekKey = process.env.OPENGROVE_DEEPSEEK_API_KEY;
process.env.OPENGROVE_DEEPSEEK_API_KEY = "routine-harness-key";
const deepSeekMember = bridgeState.app.rooms.listMembers().find((member) => member.id === "employee-live-todo");
assert.ok(deepSeekMember);
bridgeState.app.rooms.upsertMember({ ...deepSeekMember, providerId: "deepseek" });
const builtinProviderRoutine = bridgeState.app.routines.create({
  title: "Built-in provider diagnostic routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    {
      id: "builtin-provider-step",
      title: "Preserve built-in provider identity",
      memberId: "employee-live-todo",
      prompt: "FAIL_LIVE_ROUTINE",
    },
  ],
});
await runRoutine(bridgeState.app, builtinProviderRoutine.id, {
  memberExecutor: createRoutineMemberExecutor(bridgeState),
  problemReporter: createRoutineProblemReporter(bridgeState),
});
const problemsWithBuiltinProvider = readFileSync(join(bridgeDiagnosticsRoot, "problems.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(problemsWithBuiltinProvider.length, 3);
assert.equal(problemsWithBuiltinProvider[2]?.facts?.providerKind, "deepseek");
if (previousDeepSeekKey === undefined) {
  delete process.env.OPENGROVE_DEEPSEEK_API_KEY;
} else {
  process.env.OPENGROVE_DEEPSEEK_API_KEY = previousDeepSeekKey;
}

if (previousDiagnosticsDir === undefined) {
  delete process.env.OPENGROVE_DIAGNOSTICS_DIR;
} else {
  process.env.OPENGROVE_DIAGNOSTICS_DIR = previousDiagnosticsDir;
}
if (previousCodexBin === undefined) {
  delete process.env.OPENGROVE_CODEX_BIN;
} else {
  process.env.OPENGROVE_CODEX_BIN = previousCodexBin;
}

console.log("routine-scheduler-harness passed");
