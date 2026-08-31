import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove, type OpenGroveApp } from "../app/create-opengrove.js";
import { serializeFlowMarkdown } from "../app-builder/flow.js";
import { listMountedAppFlows } from "../app-builder/flow-discovery.js";
import type { JsonObject, JsonValue, ToolCallContext, ToolResult } from "../core.js";
import { serializeRoutineFile } from "../routines/routine-file.js";
import { runRoutine } from "../routines/routine-runner.js";
import { resolveApproval } from "../server/approval-actions.js";
import { createBridgeState } from "../server/bridge-state.js";
import type { BridgeState } from "../server/bridge-types.js";
import { activateRoutineWorkflow } from "../server/routine-activation.js";
import { createRoutineFlowInstanceObserver } from "../server/routine-flow-instance.js";
import { createRoutineMemberExecutor, tickRoutineScheduler } from "../server/routine-scheduler.js";
import { roomExecutionState } from "../server/room-runs/execution-state.js";
import { workflowKnowledgeInitiator } from "../tools/workflow.js";

const TOOL_CONTEXT = undefined as unknown as ToolCallContext;

function createState(): BridgeState {
  let state: BridgeState;
  const app = createOpenGrove({
    cwd: mkdtempSync(join(tmpdir(), "opengrove-workflow-activate-")),
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        yield* [];
      },
    },
    workflowActivation: {
      activate: (input) => activateRoutineWorkflow(state, input),
    },
  });
  state = {
    app,
    profile: "local",
    settings: { mountedApps: [] },
    store: {
      saveFrom(value: OpenGroveApp) {
        assert.equal(value, app);
      },
    },
  } as unknown as BridgeState;
  return state;
}

function registerEchoTool(app: OpenGroveApp): void {
  app.tools.register({
    spec: {
      id: "activate.echo",
      title: "Activate echo",
      description: "workflow.activate harness echo tool",
      activity: "local",
      risk: "read",
      input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
      permission: { mode: "allow", reason: "test" },
    },
    async execute(input: JsonValue): Promise<ToolResult<JsonValue>> {
      return { ok: true, value: input };
    },
  });
}

function createRoutineKnowledge(app: OpenGroveApp): string {
  const body = serializeRoutineFile({
    title: "Activate routine",
    trigger: "manual",
    steps: [{ id: "step_1", title: "Echo", toolId: "activate.echo", input: { ok: true } }],
  });
  return app.knowledge.create({
    type: "routine",
    title: "Activate routine",
    body,
    format: "markdown",
    metadata: { vaultPath: "OpenGrove/routines/Activate routine.routine.md" },
  }).id;
}

const state = createState();
registerEchoTool(state.app);
const knowledgeId = createRoutineKnowledge(state.app);
const activateTool = state.app.tools.require("workflow.activate");
const activated = await activateTool.execute({ knowledgeId } as JsonObject, TOOL_CONTEXT);
assert.equal(activated.ok, true, `workflow.activate should succeed:${activated.error ?? ""}`);
const value = activated.value as { routineId: string; runId: string; status: string };
assert.ok(value.routineId, "workflow.activate should return routineId");
assert.ok(value.runId, "workflow.activate should return runId");
assert.equal(value.status, "succeeded");
assert.equal(state.app.routines.get(value.routineId)?.lastRun?.status, "succeeded");

const missing = await activateTool.execute({ knowledgeId: "missing" } as JsonObject, TOOL_CONTEXT);
assert.equal(missing.ok, false);
assert.equal((missing as { error: string }).error, "knowledge_not_found");

const note = state.app.knowledge.create({
  type: "note",
  title: "Not a routine",
  body: "hello",
  format: "markdown",
  metadata: { vaultPath: "OpenGrove/notes/not-routine.md" },
});
const wrongType = await activateTool.execute({ knowledgeId: note.id } as JsonObject, TOOL_CONTEXT);
assert.equal(wrongType.ok, false);
assert.equal((wrongType as { error: string }).error, "knowledge_not_routine_type");

const scopedTempRoot = mkdtempSync(join(tmpdir(), "opengrove-workflow-scoped-root-"));
let scopedStore: ReturnType<typeof createBridgeState>["store"] | undefined;
try {
  const appRoot = join(scopedTempRoot, "story-seed");
  const appWorkspace = join(appRoot, "workspace");
  mkdirSync(appWorkspace, { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    JSON.stringify({ id: "story-seed", title: "Story Seed", workspace: { path: "workspace" } }),
    "utf8",
  );
  const bridgeState = createBridgeState({ statePath: join(scopedTempRoot, "state.json") });
  scopedStore = bridgeState.store;
  bridgeState.settings.workspaceRoot = scopedTempRoot;
  bridgeState.settings.mountedApps = [{ id: "story-seed", path: appRoot, enabled: true }];
  bridgeState.settings.customProviders.push({
    id: "workflow-harness-provider",
    name: "Workflow harness Provider",
    protocol: "anthropic-compatible",
    custom: true,
    origin: "user",
    anthropicBaseUrl: "https://example.invalid",
    credentialKind: "api-key",
    apiKey: "workflow-harness-key",
    models: [{ id: bridgeState.model, label: bridgeState.model }],
  });
  bridgeState.settings.modelProviderBindings = [
    {
      modelId: bridgeState.model,
      providerId: "workflow-harness-provider",
    },
  ];
  registerEchoTool(bridgeState.app);

  const scopedState = roomExecutionState(bridgeState, {
    id: "member-app-story-seed-pm",
    name: "Story Seed PM",
    kernel: bridgeState.kernel,
    model: bridgeState.model,
    role: "pm",
    status: "idle",
    color: "#2563eb",
    lastActive: "now",
    source: "local",
    appId: "story-seed",
  });
  assert.notEqual(scopedState, bridgeState, "app workspace mismatch should create a scoped runtime state");
  assert.equal(scopedState.rootState, bridgeState, "scoped runtime should keep a root state pointer");
  assert.equal(
    scopedState.settings.workspaceRoot,
    appWorkspace,
    "app PM cwd should fall back to mounted app workspace",
  );

  const scopedCreateTool = scopedState.app.tools.require("workflow.create");
  const created = await scopedCreateTool.execute(
    {
      appId: "story-seed",
      title: "Scoped root workflow",
      steps: [{ title: "Echo", toolId: "activate.echo", input: { ok: true } }],
    } as JsonObject,
    TOOL_CONTEXT,
  );
  assert.equal(created.ok, true, `scoped workflow.create should succeed:${created.error ?? ""}`);
  const createdValue = created.value as { knowledgeId: string; flowPath?: string; flowMirrored?: boolean };
  const scopedKnowledgeId = createdValue.knowledgeId;
  assert.ok(bridgeState.app.knowledge.get(scopedKnowledgeId), "scoped workflow.create should write root knowledge");
  assert.equal(createdValue.flowMirrored, true, "workflow.create should report a successful mirror");
  assert.equal(createdValue.flowPath, "flows/Scoped root workflow.flow.md");
  const createdFlowPath = createdValue.flowPath ?? "";
  assert.equal(
    existsSync(join(appWorkspace, createdFlowPath)),
    true,
    "workflow.create should mirror a flow into the mounted app workspace",
  );
  const createdDocument = bridgeState.app.knowledge.get(scopedKnowledgeId);
  assert.equal(createdDocument?.metadata?.workflowAppId, "story-seed");
  assert.equal(createdDocument?.metadata?.workflowFlowPath, createdFlowPath);
  const createdFlows = listMountedAppFlows(appWorkspace);
  const mirroredFlow = createdFlows.find((flow) => flow.path === createdFlowPath);
  assert.equal(mirroredFlow?.valid, true, `mirrored flow should parse:${mirroredFlow?.issues.join(", ") ?? ""}`);
  assert.equal(mirroredFlow?.frontmatter?.kind, "definition");
  assert.equal(mirroredFlow?.frontmatter?.initiator, workflowKnowledgeInitiator(scopedKnowledgeId));
  assert.equal(mirroredFlow?.frontmatter?.status, "pending");

  const scopedActivateTool = scopedState.app.tools.require("workflow.activate");
  const scopedActivated = await scopedActivateTool.execute(
    { knowledgeId: scopedKnowledgeId } as JsonObject,
    TOOL_CONTEXT,
  );
  assert.equal(scopedActivated.ok, true, `scoped workflow.activate should succeed:${scopedActivated.error ?? ""}`);
  const scopedValue = scopedActivated.value as { routineId: string; runId: string; status: string };
  assert.equal(scopedValue.status, "succeeded");
  assert.ok(
    bridgeState.app.routines.get(scopedValue.routineId),
    "scoped workflow.activate should run on root routines",
  );
  assert.equal(
    bridgeState.app.routines.get(scopedValue.routineId)?.sourceKnowledgeId,
    scopedKnowledgeId,
    "imported workflow routine should remember its source knowledge",
  );
  const activatedFlows = listMountedAppFlows(appWorkspace);
  const workflowFlows = activatedFlows.filter(
    (flow) => flow.frontmatter?.initiator === workflowKnowledgeInitiator(scopedKnowledgeId),
  );
  assert.equal(workflowFlows.length, 2, "workflow definition and activation run should share one workflow initiator");
  assert.ok(
    workflowFlows.some((flow) => flow.path === createdFlowPath),
    "workflow group should include the mirrored definition",
  );
  assert.ok(
    workflowFlows.some((flow) => flow.path.startsWith("runs/")),
    "workflow group should include the activation run instance",
  );

  const manualRun = await runRoutine(bridgeState.app, scopedValue.routineId, {
    runId: "manual-workflow-run",
    memberExecutor: createRoutineMemberExecutor(bridgeState),
    statusObserver: createRoutineFlowInstanceObserver(bridgeState),
  });
  assert.equal(manualRun.summary.status, "succeeded", "manual routine run should succeed");

  bridgeState.app.routines.update(scopedValue.routineId, {
    trigger: "schedule",
    schedule: { everyMinutes: 1 },
  });
  const fired = await tickRoutineScheduler(bridgeState, new Date("2026-07-09T00:00:00.000Z"));
  assert.deepEqual(fired, [scopedValue.routineId], "scheduled workflow routine should fire");

  const repeatedFlows = listMountedAppFlows(appWorkspace);
  const workflowRunFlows = repeatedFlows.filter(
    (flow) =>
      flow.path.startsWith("runs/") && flow.frontmatter?.initiator === workflowKnowledgeInitiator(scopedKnowledgeId),
  );
  assert.equal(
    workflowRunFlows.length,
    3,
    "activation, manual run, and scheduled run should share the workflow initiator",
  );
  assert.equal(
    repeatedFlows.some(
      (flow) => flow.path.startsWith("runs/") && flow.frontmatter?.initiator === `routine:${scopedValue.routineId}`,
    ),
    false,
    "workflow routine runs should not fall back to routine initiator grouping",
  );

  mkdirSync(join(appWorkspace, "flows"), { recursive: true });
  writeFileSync(
    join(appWorkspace, "flows", "Approval Gate.flow.md"),
    serializeFlowMarkdown({
      flow: "v1",
      title: "Approval Gate",
      status: "pending",
      updated: "2026-07-09T00:00:00.000Z",
      steps: [
        {
          id: "approve",
          title: "Approve",
          owner: "user",
          status: "pending",
          blocking: true,
        },
      ],
    }),
    "utf8",
  );

  const approvalCreated = await scopedCreateTool.execute(
    {
      appId: "story-seed",
      title: "Scoped approval workflow",
      steps: [
        { title: "Approve", flowApproval: { flowId: "Approval Gate", stepId: "approve" } },
        { title: "Echo after approval", toolId: "activate.echo", input: { approved: true } },
      ],
    } as JsonObject,
    TOOL_CONTEXT,
  );
  assert.equal(approvalCreated.ok, true, `approval workflow.create should succeed:${approvalCreated.error ?? ""}`);
  const approvalCreatedValue = approvalCreated.value as { knowledgeId: string; flowMirrored?: boolean };
  assert.equal(approvalCreatedValue.flowMirrored, true, "approval workflow should be mirrored");

  const approvalActivated = await scopedActivateTool.execute(
    {
      knowledgeId: approvalCreatedValue.knowledgeId,
    } as JsonObject,
    TOOL_CONTEXT,
  );
  assert.equal(
    approvalActivated.ok,
    true,
    `approval workflow.activate should succeed:${approvalActivated.error ?? ""}`,
  );
  const approvalValue = approvalActivated.value as { routineId: string; runId: string; status: string };
  assert.equal(approvalValue.status, "paused_for_approval", "flow approval workflow should pause");
  const approvalRunFlow = listMountedAppFlows(appWorkspace).find(
    (flow) =>
      flow.path.includes(approvalValue.runId) &&
      flow.frontmatter?.initiator === workflowKnowledgeInitiator(approvalCreatedValue.knowledgeId),
  );
  assert.equal(approvalRunFlow?.frontmatter?.status, "waiting_user", "approval run should start as waiting_user");

  const pendingApproval = bridgeState.app.approvals
    .list()
    .find((approval) => approval.status === "pending" && approval.resume?.runId === approvalValue.runId);
  assert.ok(pendingApproval, "approval workflow should create a pending approval");
  const resolvedApproval = await resolveApproval(bridgeState, pendingApproval.id, "approved");
  assert.equal(
    resolvedApproval.routineResult?.summary.status,
    "succeeded",
    "approval resume should finish the workflow",
  );
  const resumedApprovalRunFlow = listMountedAppFlows(appWorkspace).find(
    (flow) =>
      flow.path.includes(approvalValue.runId) &&
      flow.frontmatter?.initiator === workflowKnowledgeInitiator(approvalCreatedValue.knowledgeId),
  );
  assert.equal(
    resumedApprovalRunFlow?.frontmatter?.status,
    "done",
    "approval resume should update the existing run flow",
  );
} finally {
  await scopedStore?.close?.();
  rmSync(scopedTempRoot, { recursive: true, force: true });
}

console.log("workflow-activate-tool-harness passed");
