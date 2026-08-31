import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest, JsonValue, ToolDefinition, ToolResult } from "../core.js";
import { createOpenGrove } from "../app/create-opengrove.js";
import { resumeRoutineAfterApproval, runRoutine } from "../routines/routine-runner.js";
import { defaultBridgeSettings } from "../server/bridge-settings-store.js";
import type { BridgeState } from "../server/bridge-types.js";
import {
  migrateRoutineAppCommandIdsV1,
  migrateRoutineAppCommandStepV1,
} from "../server/migrations/routine-app-command-id-v1.js";

// ===== P0 harness: routine step 间数据传递 =====
// 覆盖规格 P0 三例:
//   1. tool A(产出 "X")→ tool B(input 含 {{steps.A.output}})→ B 收到含 "X" 的 input。
//   2. A → 需审批 B(引用 A)→ approval resume → B 恢复后仍拿到 A 的输出(F2)。
//   3. 引用未完成步骤 → 渲染空串 + runtime.diagnostic;skill-only step → routine 失败(F1)。

function createHarnessApp() {
  return createOpenGrove({
    cwd: mkdtempSync(join(tmpdir(), "opengrove-routine-data-passing-")),
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        yield* [];
      },
    },
  });
}

const migratedAppCommandStep = migrateRoutineAppCommandStepV1(
  {
    id: "run-old-command",
    title: "Run old command",
    toolId: "opengrove.app.command.run",
    input: { appId: "demo", command: "./bin/demo", args: ["sync"] },
  },
  (appId, command) => (appId === "demo" && command === "./bin/demo" ? "demo-cli" : undefined),
);
assert.equal(migratedAppCommandStep.changed, true);
assert.deepEqual(migratedAppCommandStep.step.input, {
  appId: "demo",
  commandId: "demo-cli",
  args: ["sync"],
});
assert.equal(
  migrateRoutineAppCommandStepV1(migratedAppCommandStep.step, () => undefined).changed,
  false,
  "current commandId inputs must be idempotent",
);

const migrationOrderApp = createHarnessApp();
const unresolvedLegacyRoutine = migrationOrderApp.routines.create({
  title: "Unresolved legacy App command",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    {
      id: "legacy-command",
      title: "Legacy command",
      toolId: "opengrove.app.command.run",
      input: { appId: "missing-app", command: "./bin/missing" },
    },
  ],
});
let statusBeforeMigrationApply: string | undefined;
const migrationOrderResult = migrateRoutineAppCommandIdsV1(
  {
    app: migrationOrderApp,
    settings: defaultBridgeSettings(),
  } as BridgeState,
  {
    beforeApply: () => {
      statusBeforeMigrationApply = migrationOrderApp.routines.get(unresolvedLegacyRoutine.id)?.status;
    },
  },
);
assert.equal(migrationOrderResult.changed, true);
assert.equal(statusBeforeMigrationApply, "active", "backup hook must run before migration mutates Routine state");
assert.equal(migrationOrderApp.routines.get(unresolvedLegacyRoutine.id)?.status, "needs_repair");

/** 一个把 input 原样回显的测试 tool,permission=allow,不触发审批。 */
function echoTool(id: string): ToolDefinition {
  return {
    spec: {
      id,
      title: id,
      description: `echo tool ${id}`,
      activity: "local",
      risk: "read",
      input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
      permission: { mode: "allow", reason: "test tool" },
    },
    async execute(input: unknown): Promise<ToolResult> {
      return { ok: true, value: input as never };
    },
  };
}

// 记录每个 tool 实际收到的 input,便于断言"接力"是否生效。
const receivedInputs = new Map<string, unknown>();

// 例 1 & 例 2 共用一个 app:A 产出 { text: "X" },B 读取 A 的输出。
const app = createHarnessApp();
app.tools.register({
  spec: {
    id: "produce",
    title: "produce",
    description: "produces a fixed value",
    activity: "local",
    risk: "read",
    input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
    permission: { mode: "allow", reason: "test" },
  },
  async execute(): Promise<ToolResult> {
    return { ok: true, value: { text: "X", count: 7 } };
  },
});

// 例 0:when 条件不满足时跳过后续 step;满足时才执行。
{
  const gatedApp = createHarnessApp();
  gatedApp.tools.register({
    spec: {
      id: "probe.empty",
      title: "probe.empty",
      description: "returns no new items",
      activity: "local",
      risk: "read",
      input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
      permission: { mode: "allow", reason: "test" },
    },
    async execute(): Promise<ToolResult> {
      return { ok: true, value: { newCount: 0 } };
    },
  });
  const skippedRoutine = gatedApp.routines.create({
    title: "When skip",
    status: "active",
    trigger: "manual",
    capabilityIds: [],
    approvalRules: [],
    steps: [
      { id: "probe", title: "Probe", toolId: "probe.empty" },
      {
        id: "member",
        title: "Member",
        memberId: "member-writer",
        prompt: "should not run",
        when: { stepId: "probe", path: "newCount", operator: "gt", value: 0 },
      },
    ],
  });
  let skippedMemberRuns = 0;
  const skippedRun = await runRoutine(gatedApp, skippedRoutine.id, {
    memberExecutor: async () => {
      skippedMemberRuns += 1;
      return { ok: true };
    },
  });
  assert.equal(skippedRun.summary.status, "succeeded");
  assert.equal(skippedMemberRuns, 0);

  gatedApp.tools.register({
    spec: {
      id: "probe.hit",
      title: "probe.hit",
      description: "returns new items",
      activity: "local",
      risk: "read",
      input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
      permission: { mode: "allow", reason: "test" },
    },
    async execute(): Promise<ToolResult> {
      return { ok: true, value: { newCount: 1 } };
    },
  });
  const hitRoutine = gatedApp.routines.create({
    title: "When hit",
    status: "active",
    trigger: "manual",
    capabilityIds: [],
    approvalRules: [],
    steps: [
      { id: "probe", title: "Probe", toolId: "probe.hit" },
      {
        id: "member",
        title: "Member",
        memberId: "member-writer",
        prompt: "should run",
        when: { stepId: "probe", path: "newCount", operator: "gt", value: 0 },
      },
    ],
  });
  let hitMemberRuns = 0;
  const hitRun = await runRoutine(gatedApp, hitRoutine.id, {
    memberExecutor: async () => {
      hitMemberRuns += 1;
      return { ok: true };
    },
  });
  assert.equal(hitRun.summary.status, "succeeded");
  assert.equal(hitMemberRuns, 1);
}
app.tools.register({
  spec: {
    id: "consume",
    title: "consume",
    description: "records the rendered input",
    activity: "local",
    risk: "read",
    input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
    permission: { mode: "allow", reason: "test" },
  },
  async execute(input: unknown): Promise<ToolResult> {
    receivedInputs.set("consume", input);
    return { ok: true, value: { received: true } };
  },
});

// ===== 例 1:tool A → tool B,B 的 input 引用 A 的输出 =====
const relayRoutine = app.routines.create({
  title: "Relay routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    { id: "A", title: "Produce", toolId: "produce", input: { seed: "hello" } },
    {
      id: "B",
      title: "Consume",
      toolId: "consume",
      // 整串引用 + 一层点路径引用。
      input: {
        whole: "{{steps.A.output}}",
        text: "{{steps.A.output.text}}",
        missing: "{{steps.A.output.count}}",
        literal: "keep",
      },
    },
  ],
});

const relayRun = await runRoutine(app, relayRoutine.id, {});
assert.equal(relayRun.summary.status, "succeeded");
const consumedB = receivedInputs.get("consume") as { whole: string; text: string; missing: string; literal: string };
assert.equal(consumedB.text, "X", "B should get A.output.text = X via a one-level dot path");
assert.equal(
  consumedB.whole,
  JSON.stringify({ text: "X", count: 7 }),
  "B should get the full A.output as a JSON string",
);
assert.equal(consumedB.missing, "7", "count should resolve to 7");
assert.equal(consumedB.literal, "keep", "non-placeholder literals stay unchanged");
console.log("P0 例1 tool→tool 接力 passed");

// ===== App command 结构化结果:下游 Routine 只消费业务 JSON =====
{
  const commandRelayApp = createHarnessApp();
  let commandRelayInput: unknown;
  commandRelayApp.tools.register({
    spec: {
      id: "opengrove.app.command.run",
      title: "App command",
      description: "returns a Host execution envelope around business JSON",
      activity: "local",
      risk: "read",
      input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
      permission: { mode: "allow", reason: "test" },
    },
    async execute(): Promise<ToolResult> {
      return {
        ok: true,
        value: {
          appId: "demo-app",
          commandId: "create-order",
          exitCode: 0,
          stdoutBytes: 72,
          stdoutTruncated: false,
          json: {
            orderId: "order-42",
            customer: { id: "customer-7" },
          },
        },
      };
    },
  });
  commandRelayApp.tools.register({
    spec: {
      id: "command-result-consumer",
      title: "Command result consumer",
      description: "records projected App command business output",
      activity: "local",
      risk: "read",
      input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
      permission: { mode: "allow", reason: "test" },
    },
    async execute(input: unknown): Promise<ToolResult> {
      commandRelayInput = input;
      return { ok: true, value: { consumed: true } };
    },
  });
  const commandRelayRoutine = commandRelayApp.routines.create({
    title: "App command business-output relay",
    status: "active",
    trigger: "manual",
    capabilityIds: [],
    approvalRules: [],
    steps: [
      {
        id: "COMMAND",
        title: "Create order",
        toolId: "opengrove.app.command.run",
        input: { appId: "demo-app", commandId: "create-order" },
      },
      {
        id: "CONSUME",
        title: "Consume order",
        toolId: "command-result-consumer",
        when: { stepId: "COMMAND", path: "orderId", operator: "equals", value: "order-42" },
        input: {
          whole: "{{steps.COMMAND.output}}",
          orderId: "{{steps.COMMAND.output.orderId}}",
          customerId: "{{steps.COMMAND.output.customer.id}}",
          missing: "{{steps.COMMAND.output.customer.missing}}",
        },
      },
    ],
  });

  const commandRelayRun = await runRoutine(commandRelayApp, commandRelayRoutine.id, {});
  assert.equal(commandRelayRun.summary.status, "succeeded");
  assert.deepEqual(commandRelayInput, {
    whole: JSON.stringify({ orderId: "order-42", customer: { id: "customer-7" } }),
    orderId: "order-42",
    customerId: "customer-7",
    missing: "",
  });
  assert.equal(
    commandRelayRun.toolResults[0]?.value &&
      "json" in (commandRelayRun.toolResults[0].value as Record<string, unknown>),
    true,
    "the full Host execution envelope must remain available in tool results for diagnostics",
  );
  assert.equal(
    commandRelayRun.events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "routine.template.reference_missing" &&
        event.data?.referencedStepId === "COMMAND" &&
        event.data?.referencedPath === "customer.missing",
    ),
    true,
    "a missing nested output path must produce a visible diagnostic",
  );
  console.log("App command business output projection + deep template paths passed");
}

// ===== App command 标量结构化结果:数字、布尔值和 null 都作为业务输出 =====
{
  const scalarRelayApp = createHarnessApp();
  const scalarValues = new Map<string, JsonValue>([
    ["number", 42],
    ["boolean", false],
    ["null", null],
  ]);
  let scalarRelayInput: unknown;
  scalarRelayApp.tools.register({
    spec: {
      id: "opengrove.app.command.run",
      title: "App command scalar",
      description: "returns scalar business JSON inside the Host execution envelope",
      activity: "local",
      risk: "read",
      input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
      permission: { mode: "allow", reason: "test" },
    },
    async execute(input: unknown): Promise<ToolResult> {
      const kind = typeof input === "object" && input !== null && "kind" in input ? String(input.kind) : "";
      assert.equal(scalarValues.has(kind), true, `unknown scalar fixture: ${kind}`);
      return {
        ok: true,
        value: {
          appId: "demo-app",
          commandId: `return-${kind}`,
          exitCode: 0,
          json: scalarValues.get(kind)!,
        },
      };
    },
  });
  scalarRelayApp.tools.register({
    spec: {
      id: "scalar-result-consumer",
      title: "Scalar result consumer",
      description: "records projected scalar App command outputs",
      activity: "local",
      risk: "read",
      input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
      permission: { mode: "allow", reason: "test" },
    },
    async execute(input: unknown): Promise<ToolResult> {
      scalarRelayInput = input;
      return { ok: true, value: { consumed: true } };
    },
  });
  const scalarRelayRoutine = scalarRelayApp.routines.create({
    title: "App command scalar-output relay",
    status: "active",
    trigger: "manual",
    capabilityIds: [],
    approvalRules: [],
    steps: [
      {
        id: "NUMBER",
        title: "Return number",
        toolId: "opengrove.app.command.run",
        input: { kind: "number" },
      },
      {
        id: "BOOLEAN",
        title: "Return boolean",
        toolId: "opengrove.app.command.run",
        input: { kind: "boolean" },
      },
      {
        id: "NULL",
        title: "Return null",
        toolId: "opengrove.app.command.run",
        input: { kind: "null" },
      },
      {
        id: "CONSUME",
        title: "Consume scalar outputs",
        toolId: "scalar-result-consumer",
        input: {
          number: "{{steps.NUMBER.output}}",
          numberMissingChild: "{{steps.NUMBER.output.anything}}",
          boolean: "{{steps.BOOLEAN.output}}",
          null: "{{steps.NULL.output}}",
        },
      },
    ],
  });

  const scalarRelayRun = await runRoutine(scalarRelayApp, scalarRelayRoutine.id, {});
  assert.equal(scalarRelayRun.summary.status, "succeeded");
  assert.deepEqual(scalarRelayInput, {
    number: "42",
    numberMissingChild: "",
    boolean: "false",
    null: "",
  });
  assert.equal(
    scalarRelayRun.events.some(
      (event) =>
        event.type === "runtime.diagnostic" &&
        event.name === "routine.template.reference_missing" &&
        event.data?.referencedStepId === "NUMBER" &&
        event.data?.referencedPath === "anything",
    ),
    true,
    "a child path on scalar output must render empty and produce a visible diagnostic",
  );
  console.log("App command scalar business output projection passed");
}

// ===== 例 2:A → 需审批的 B(引用 A)→ approval resume → B 仍拿到 A 输出(F2)=====
// 需要一个 permission != allow 的 tool 来触发审批暂停。
app.tools.register({
  spec: {
    id: "gated",
    title: "gated",
    description: "a tool that needs approval",
    activity: "local",
    risk: "write",
    input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
    permission: { mode: "ask", reason: "gated action needs approval" },
  },
  async execute(input: unknown): Promise<ToolResult> {
    receivedInputs.set("gated", input);
    return { ok: true, value: { gated: true } };
  },
});

const approvalRoutine = app.routines.create({
  title: "Approval relay routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    { id: "P", title: "Produce", toolId: "produce", input: { seed: "p" } },
    {
      id: "G",
      title: "Gated",
      toolId: "gated",
      input: { fromP: "{{steps.P.output.text}}" },
    },
  ],
});

const firstRun = await runRoutine(app, approvalRoutine.id, {});
assert.equal(firstRun.summary.status, "paused_for_approval", "should pause at G waiting for approval");

// 找到为 G 创建的 pending approval request。
const pendingApproval = app.approvals
  .list()
  .find((request) => request.kind === "routine_step" && request.status === "pending") as ApprovalRequest | undefined;
assert.ok(pendingApproval, "there should be one pending routine_step approval");
assert.equal(pendingApproval.resume?.type, "routine.step");
// 关键 F2 断言:暂停时 stepOutputs 快照随 approval 持久化(A 的输出在里面)。
const resume = pendingApproval.resume as Extract<ApprovalRequest["resume"], { type: "routine.step" }>;
assert.ok(resume.stepOutputs, "the stepOutputs snapshot should be persisted with the approval at pause time");
assert.deepEqual(resume.stepOutputs?.P, { text: "X", count: 7 }, "the snapshot should contain P's output");

// 模拟用户审批 → 调 resumeRoutineAfterApproval 恢复。
const resumedRun = await resumeRoutineAfterApproval(app, pendingApproval, {});
assert.ok(resumedRun, "resume should return a result");
assert.equal(resumedRun?.summary.status, "succeeded", "after resume, G should complete successfully");
const gatedInput = receivedInputs.get("gated") as { fromP: string };
assert.equal(
  gatedInput.fromP,
  "X",
  "F2: after resume, G should still get P's output via the snapshot, not an empty string",
);
console.log("P0 例2 审批恢复保留前序输出(F2) passed");

// ===== 例 3a:引用未完成步骤 → 渲染空串 + runtime.diagnostic =====
const diagnosticApp = createHarnessApp();
const capturedMemberPrompts: string[] = [];
const memberRoutine = diagnosticApp.routines.create({
  title: "Missing ref routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    {
      id: "M",
      title: "Member step",
      memberId: "member-fake",
      // 引用一个不存在的 stepId。
      prompt: "based on {{steps.NONEXISTENT.output}} do work",
    },
  ],
});
const missingRun = await runRoutine(diagnosticApp, memberRoutine.id, {
  memberExecutor: (request) => {
    capturedMemberPrompts.push(request.prompt);
    return Promise.resolve({ ok: true, value: { done: true } });
  },
});
assert.equal(missingRun.summary.status, "succeeded");
assert.equal(
  capturedMemberPrompts[0],
  "based on  do work",
  "a reference to an unfinished step should render as an empty string",
);
const diagnostics = missingRun.events.filter((e) => e.type === "runtime.diagnostic");
assert.equal(diagnostics.length, 1, "should emit one runtime.diagnostic warning");
assert.equal(diagnostics[0]!.name, "routine.template.reference_missing");
console.log("P0 例3a 引用未完成步骤→空串+diagnostic passed");

// ===== 例 3b:skill-only step → routine 失败(F1,不静默跳过)=====
const skillApp = createHarnessApp();
const skillRoutine = skillApp.routines.create({
  title: "Skill-only routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [{ id: "S", title: "Skill step", skillId: "some-skill", prompt: "run skill" }],
});
const skillRun = await runRoutine(skillApp, skillRoutine.id, {});
assert.equal(skillRun.summary.status, "failed", "a skill-only step should fail the routine");
assert.equal(skillRun.summary.error, "skill_step_not_executable");
console.log("P0 例3b skill-only step 显式失败(F1) passed");

// ===== 例 4(补充):member step 引用 tool step 输出(member→tool 接力)=====
const mixedApp = createHarnessApp();
mixedApp.tools.register(echoTool("src-tool"));
const memberPromptsMixed: string[] = [];
const mixedRoutine = mixedApp.routines.create({
  title: "Mixed relay",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    { id: "T", title: "Tool", toolId: "src-tool", input: { report: "report-42" } },
    {
      id: "W",
      title: "Worker",
      memberId: "member-worker",
      prompt: "act on {{steps.T.output}}",
    },
  ],
});
const mixedRun = await runRoutine(mixedApp, mixedRoutine.id, {
  memberExecutor: (request) => {
    memberPromptsMixed.push(request.prompt);
    return Promise.resolve({ ok: true, value: { ok: true } });
  },
});
assert.equal(mixedRun.summary.status, "succeeded");
assert.equal(
  memberPromptsMixed[0],
  `act on ${JSON.stringify({ report: "report-42" })}`,
  "the member step should receive the tool step's output",
);
console.log("P0 例4 tool→member 接力 passed");

// ===== R5 反例:step.input 缺失模板引用 → 应打 diagnostic(不是静默变空)=====
// 旧 bug:renderJsonValues 丢掉了 missing,input 里 {{steps.nope.output}} 静默变空、0 诊断。
const inputRefApp = createHarnessApp();
inputRefApp.tools.register(echoTool("sink-tool"));
const inputRefRoutine = inputRefApp.routines.create({
  title: "Input missing ref routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    {
      id: "S",
      title: "Sink",
      toolId: "sink-tool",
      input: { x: "{{steps.NOPE.output}", y: "{{steps.NONO.output}}" },
    },
  ],
});
const inputRefRun = await runRoutine(inputRefApp, inputRefRoutine.id, {});
assert.equal(inputRefRun.summary.status, "succeeded");
const inputRefDiagnostics = inputRefRun.events.filter((e) => e.type === "runtime.diagnostic");
assert.ok(
  inputRefDiagnostics.length >= 1,
  "R5: a reference to a nonexistent step in input should emit a runtime.diagnostic (not 0)",
);
console.log("R5 反例 input缺失引用→打diagnostic passed");

// ===== R0 runner:flow 审批步执行 → 暂停等审批(approval pause)=====
const flowApp = createHarnessApp();
flowApp.tools.register(echoTool("act-tool"));
const flowRoutine = flowApp.routines.create({
  title: "Flow approval routine",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  steps: [
    { id: "F", title: "Flow 审批", flowApproval: { flowId: "ads-create", stepId: "approve-create" } },
    { id: "A", title: "执行动作", toolId: "act-tool" },
  ],
});
const flowRun = await runRoutine(flowApp, flowRoutine.id, {});
assert.equal(
  flowRun.summary.status,
  "paused_for_approval",
  "R0: the flow approval step should pause at F waiting for approval",
);
// 找到 F 步产生的 pending approval,reason 应标注是 flow 审批。
const flowApprovalReq = flowApp.approvals
  .list()
  .find((request) => request.kind === "routine_step" && request.status === "pending");
assert.ok(flowApprovalReq, "R0: a pending approval should be produced");
assert.ok(
  (flowApprovalReq.reason ?? "").includes("flow 审批") || (flowApprovalReq.reason ?? "").includes("flow"),
  "R0: the approval reason should mark it as a flow approval",
);
console.log("R0 runner flow审批步→暂停等审批 passed");

console.log("routine-data-passing-harness passed");
