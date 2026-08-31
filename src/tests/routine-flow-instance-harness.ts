import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import { parseFlowMarkdown, type FlowFrontmatter } from "../app-builder/flow.js";
import type { JsonValue, Routine, ToolDefinition, ToolResult } from "../core.js";
import { runRoutine, type RoutineRunStatusObserver } from "../routines/routine-runner.js";
import { createRoutineFlowInstanceObserverForWorkspace } from "../server/routine-flow-instance.js";

function createHarnessApp() {
  return createOpenGrove({
    cwd: mkdtempSync(join(tmpdir(), "opengrove-routine-flow-app-")),
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        yield* [];
      },
    },
  });
}

function flowPath(workspaceRoot: string, routine: Routine, runId: string): string {
  return resolve(workspaceRoot, "runs", `${routine.id}-${runId}.flow.md`);
}

function readFlow(workspaceRoot: string, routine: Routine, runId: string): FlowFrontmatter {
  const filePath = flowPath(workspaceRoot, routine, runId);
  assert.equal(existsSync(filePath), true, `flow instance should exist:${filePath}`);
  const parsed = parseFlowMarkdown(readFileSync(filePath, "utf8"));
  assert.equal(parsed.valid, true, `flow instance should parse:${parsed.issues.join(", ")}`);
  assert.ok(parsed.frontmatter, "flow frontmatter should exist");
  return parsed.frontmatter;
}

function observingFlowWriter(
  workspaceRoot: string,
  snapshots: Array<{ label: string; flow: FlowFrontmatter }>,
): RoutineRunStatusObserver {
  const writer = createRoutineFlowInstanceObserverForWorkspace(workspaceRoot);
  return {
    async onRunStart(input) {
      await writer.onRunStart?.(input);
      snapshots.push({ label: "start", flow: readFlow(workspaceRoot, input.routine, input.runId) });
    },
    async onStepStatus(input) {
      await writer.onStepStatus?.(input);
      snapshots.push({
        label: `${input.step.id}:${input.status}`,
        flow: readFlow(workspaceRoot, input.routine, input.runId),
      });
    },
    async onRunFinish(input) {
      await writer.onRunFinish?.(input);
      snapshots.push({
        label: `finish:${input.summary.status}`,
        flow: readFlow(workspaceRoot, input.routine, input.summary.id),
      });
    },
  };
}

function resultTool(id: string, result: ToolResult<JsonValue>): ToolDefinition {
  return {
    spec: {
      id,
      title: id,
      description: `${id} test tool`,
      activity: "local",
      risk: "read",
      input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
      permission: { mode: "allow", reason: "test" },
    },
    async execute() {
      return result;
    },
  };
}

const app = createHarnessApp();
const workspaceRoot = mkdtempSync(join(tmpdir(), "opengrove-routine-flow-workspace-"));
app.tools.register(resultTool("first", { ok: true, value: { text: "alpha" } }));
app.tools.register(resultTool("second", { ok: true, value: "omega" }));
app.tools.register(resultTool("fail", { ok: false, error: "planned_failure" }));

const routine = app.routines.create({
  title: "Flow mirror routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    { id: "A", title: "First", toolId: "first" },
    { id: "B", title: "Second", toolId: "second" },
  ],
});
const snapshots: Array<{ label: string; flow: FlowFrontmatter }> = [];
const run = await runRoutine(app, routine.id, {
  runId: "run-ok",
  statusObserver: observingFlowWriter(workspaceRoot, snapshots),
});
assert.equal(run.summary.status, "succeeded");
assert.deepEqual(
  snapshots.find((item) => item.label === "start")?.flow.steps.map((step) => step.status),
  ["pending", "pending"],
);
assert.equal(snapshots.find((item) => item.label === "A:running")?.flow.steps[0]?.status, "running");
assert.equal(snapshots.find((item) => item.label === "A:done")?.flow.steps[0]?.status, "done");
assert.match(snapshots.find((item) => item.label === "A:done")?.flow.steps[0]?.output ?? "", /alpha/);
assert.equal(snapshots.find((item) => item.label === "B:running")?.flow.steps[1]?.status, "running");
assert.equal(snapshots.find((item) => item.label === "finish:succeeded")?.flow.status, "done");

const failedRoutine = app.routines.create({
  title: "Flow failure routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [{ id: "F", title: "Fail", toolId: "fail" }],
});
const failedSnapshots: Array<{ label: string; flow: FlowFrontmatter }> = [];
const failedRun = await runRoutine(app, failedRoutine.id, {
  runId: "run-failed",
  statusObserver: observingFlowWriter(workspaceRoot, failedSnapshots),
});
assert.equal(failedRun.summary.status, "failed");
assert.equal(failedSnapshots.find((item) => item.label === "F:failed")?.flow.steps[0]?.status, "failed");
assert.equal(failedSnapshots.find((item) => item.label === "finish:failed")?.flow.status, "failed");

const approvalRoutine = app.routines.create({
  title: "Flow approval routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    {
      id: "approve",
      title: "Approve",
      flowApproval: { flowId: "ads-create", stepId: "approve-create" },
    },
  ],
});
const approvalSnapshots: Array<{ label: string; flow: FlowFrontmatter }> = [];
const approvalRun = await runRoutine(app, approvalRoutine.id, {
  runId: "run-approval",
  statusObserver: observingFlowWriter(workspaceRoot, approvalSnapshots),
});
assert.equal(approvalRun.summary.status, "paused_for_approval");
const waiting = approvalSnapshots.find((item) => item.label === "approve:waiting")?.flow;
assert.equal(waiting?.status, "waiting_user");
assert.equal(waiting?.steps[0]?.status, "waiting");
assert.equal(waiting?.steps[0]?.owner, "user");
assert.equal(waiting?.steps[0]?.blocking, true);

const memberRoutine = app.routines.create({
  title: "Flow member activity routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    {
      id: "member-step",
      title: "Ask member",
      memberId: "member-1",
      prompt: "Do the member step",
    },
  ],
});
const memberSnapshots: Array<{ label: string; flow: FlowFrontmatter }> = [];
const memberRun = await runRoutine(app, memberRoutine.id, {
  runId: "run-member",
  statusObserver: observingFlowWriter(workspaceRoot, memberSnapshots),
  memberExecutor: async (request) => {
    await request.onStarted?.({
      roomId: "room-1",
      messageId: "message-1",
      runId: "room-run-1",
    });
    return {
      ok: true,
      value: {
        memberId: "member-1",
        roomId: "room-1",
        messageId: "message-1",
        runId: "room-run-1",
        text: "member finished",
      },
    };
  },
});
assert.equal(memberRun.summary.status, "succeeded");
const memberRunningStepWithActivity = memberSnapshots
  .filter((item) => item.label === "member-step:running")
  .map((item) => item.flow.steps[0])
  .find((step) => step?.activityRunId === "room-run-1");
assert.equal(memberRunningStepWithActivity?.messageId, "message-1");
assert.equal(memberRunningStepWithActivity?.roomId, "room-1");
const memberDoneStep = memberSnapshots.find((item) => item.label === "member-step:done")?.flow.steps[0];
assert.equal(memberDoneStep?.activityRunId, "room-run-1");
assert.equal(memberDoneStep?.messageId, "message-1");
assert.equal(memberDoneStep?.roomId, "room-1");

console.log("routine-flow-instance-harness passed");
