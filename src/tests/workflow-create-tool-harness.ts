import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenGrove, type OpenGroveApp } from "../app/create-opengrove.js";
import type { JsonObject, JsonValue, ToolCallContext, ToolDefinition } from "../core.js";
import { APP_VAULT_ROOT_NAME } from "../identity.js";
import { parseRoutineFile } from "../routines/routine-file.js";
import { knowledgeVaultRoot } from "../server/knowledge-roots.js";
import type { BridgeState } from "../server/bridge-types.js";
import { validateWorkflowFlowApprovalForBridgeState } from "../server/bridge-state.js";

// ===== P2/RC harness: workflow.create 真实入口 + schema 边界 =====
// 所有 RC 反例都从 createOpenGrove() 注册出的真实 workflow.create 走,并先过 tool.spec.input.schema
// 的轻量校验。避免再次出现"直接 new RoutineStep 绕过 schema,内部逻辑绿但真实入口断"。

const TOOL_CONTEXT = undefined as unknown as ToolCallContext;

interface HarnessContext {
  app: OpenGroveApp;
  tool: ToolDefinition<JsonObject, JsonValue>;
  cwd: string;
}

async function withHarnessApp<T>(fn: (context: HarnessContext) => Promise<T> | T): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-workflow-create-"));
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    const mountedAppRoot = seedMountedAppWithFlow(cwd);
    const bridgeState = {
      settings: {
        mountedApps: [{ id: "demo-app", path: mountedAppRoot, enabled: true }],
      },
    } as unknown as BridgeState;
    const app = createOpenGrove({
      cwd,
      readPage: async () => ({}),
      runtime: {
        async *runTurn() {
          yield* [];
        },
      },
      validateWorkflowFlowApproval(flowApproval, scope) {
        return validateWorkflowFlowApprovalForBridgeState(bridgeState, flowApproval, scope);
      },
    });
    app.rooms.createRoom({
      id: "app-room--demo-app--group--default",
      scope: { kind: "app", appId: "demo-app", role: "default" },
      title: "Demo App 群组",
      badge: "Demo App",
    });
    registerFakeHighRiskTool(app);
    return await fn({ app, tool: app.tools.require("workflow.create"), cwd });
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
}

function seedMountedAppWithFlow(cwd: string): string {
  const appRoot = join(cwd, "demo-app");
  const workspaceRoot = join(appRoot, "workspace");
  const flowsDir = join(workspaceRoot, "flows");
  mkdirSync(flowsDir, { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "demo-app",
        title: "Demo App",
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(flowsDir, "ads-create.flow.md"),
    [
      "---",
      "flow: v1",
      "title: Ads Create",
      "status: waiting_user",
      "steps:",
      "  - id: approve-create",
      "    title: Approve ad creation",
      "    owner: user",
      "    status: waiting",
      "    blocking: true",
      "---",
      "",
      "# Ads Create",
      "",
    ].join("\n"),
  );
  return appRoot;
}

function registerFakeHighRiskTool(app: OpenGroveApp): void {
  app.tools.register({
    spec: {
      id: "drama-ops auto-ads-create",
      title: "Fake drama ops ad creation",
      description: "Harness-only high-risk tool target.",
      activity: "local",
      risk: "spend",
      input: {
        type: "json-schema",
        schema: { type: "object", additionalProperties: true },
      },
      permission: {
        mode: "ask",
        reason: "Harness high-risk spend action.",
      },
    },
    async execute() {
      return { ok: true, value: { created: true } };
    },
  });
}

function addLocalMember(
  app: OpenGroveApp,
  input: {
    id: string;
    appId?: string;
    disabled?: boolean;
    kernel?: string;
  },
): void {
  const room = app.rooms.createRoom({ title: `Room for ${input.id}` });
  app.rooms.addMember(room.id, {
    id: input.id,
    name: input.id,
    kernel: input.kernel ?? "claude-code",
    model: "test-model",
    role: "test worker",
    status: "idle",
    color: "#000000",
    lastActive: new Date().toISOString(),
    source: "local",
    ...(input.appId ? { appId: input.appId } : {}),
    ...(input.disabled ? { disabled: true } : {}),
  });
}

function assertSchemaAccepts(tool: ToolDefinition, input: JsonObject, label: string): void {
  const error = validateJsonSchema(tool.spec.input.schema, input, "input");
  assert.equal(error, undefined, `${label} should pass workflow.create schema, got ${error ?? ""}`);
}

function validateJsonSchema(schema: JsonObject, value: unknown, path: string): string | undefined {
  const type = typeof schema.type === "string" ? schema.type : "";
  if (type === "object") {
    if (!isRecord(value)) return `${path}:expected object`;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return `${path}.${key}:required`;
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) return `${path}.${key}:additionalProperty`;
      }
    }
    for (const [key, childValue] of Object.entries(value)) {
      const childSchema = properties[key];
      if (isRecord(childSchema)) {
        const childError = validateJsonSchema(childSchema, childValue, `${path}.${key}`);
        if (childError) return childError;
      }
    }
    return undefined;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return `${path}:expected array`;
    const minItems = typeof schema.minItems === "number" ? schema.minItems : undefined;
    if (minItems !== undefined && value.length < minItems) return `${path}:minItems`;
    const itemSchema = isRecord(schema.items) ? schema.items : undefined;
    if (itemSchema) {
      for (const [index, item] of value.entries()) {
        const childError = validateJsonSchema(itemSchema, item, `${path}.${index}`);
        if (childError) return childError;
      }
    }
    return undefined;
  }
  if (type === "string") {
    if (typeof value !== "string") return `${path}:expected string`;
    const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
    if (enumValues && !enumValues.includes(value)) return `${path}:enum`;
    return undefined;
  }
  if (type === "number") {
    return typeof value === "number" ? undefined : `${path}:expected number`;
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function metadataVaultPath(document: { metadata?: JsonObject }): string {
  return typeof document.metadata?.vaultPath === "string" ? document.metadata.vaultPath : "";
}

// ===== RC1:flowApproval 进入真实工具 schema + 高危判定走真实入口 =====
await withHarnessApp(async ({ tool }) => {
  const schema = tool.spec.input.schema;
  const stepSchema = ((schema.properties as JsonObject).steps as JsonObject).items as JsonObject;
  const stepProperties = stepSchema.properties as JsonObject;
  assert.ok(stepProperties.flowApproval, "RC1: workflow.create step schema must expose flowApproval");

  const highRiskWithFlowApproval: JsonObject = {
    appId: "demo-app",
    title: "建广投放(带 flow 审批)",
    steps: [
      { title: "flow 审批", flowApproval: { flowId: "ads-create", stepId: "approve-create" } },
      { title: "建广告", toolId: "drama-ops auto-ads-create", prompt: "创建广告并放量", input: {} },
    ],
  };
  assertSchemaAccepts(tool, highRiskWithFlowApproval, "RC1 high-risk with flowApproval");
  const allowed = await tool.execute(highRiskWithFlowApproval, TOOL_CONTEXT);
  assert.equal(
    allowed.ok,
    true,
    `RC1: high-risk with a preceding flowApproval should be allowed: ${allowed.error ?? ""}`,
  );

  const highRiskWithFakeFlowApproval: JsonObject = {
    appId: "demo-app",
    title: "建广投放(伪造 flow 审批)",
    steps: [
      { title: "伪造审批", flowApproval: { flowId: "missing-flow", stepId: "approve-create" } },
      { title: "建广告", toolId: "drama-ops auto-ads-create", prompt: "创建广告并放量", input: {} },
    ],
  };
  assertSchemaAccepts(tool, highRiskWithFakeFlowApproval, "RC5 high-risk with fake flowApproval");
  const fakeRejected = await tool.execute(highRiskWithFakeFlowApproval, TOOL_CONTEXT);
  assert.equal(fakeRejected.ok, false, "RC5: a forged flowApproval must not pass the real entry point");
  assert.equal((fakeRejected as { error: string }).error, "flow_approval_not_found:missing-flow/approve-create");

  const highRiskWithEngineApprovalOnly: JsonObject = {
    appId: "demo-app",
    title: "建广投放(仅 engine approval)",
    steps: [
      {
        title: "建广告",
        toolId: "drama-ops auto-ads-create",
        prompt: "创建广告",
        input: {},
        approval: { mode: "ask", reason: "广告创建需人工审批" },
      },
    ],
  };
  assertSchemaAccepts(tool, highRiskWithEngineApprovalOnly, "RC1 high-risk with engine approval only");
  const rejected = await tool.execute(highRiskWithEngineApprovalOnly, TOOL_CONTEXT);
  assert.equal(rejected.ok, false, "RC1: an engine approval alone must not satisfy the flow approval requirement");
  assert.ok((rejected as { error: string }).error.startsWith("high_risk_without_flow_approval:"));
  console.log("RC1 schema + flowApproval high-risk gate passed");
});

// ===== Q1:自由文本不再触发高危拦截;真实高危 toolId 仍被硬拦 =====
await withHarnessApp(async ({ app, tool }) => {
  addLocalMember(app, { id: "analysis-worker", appId: "demo-app" });
  const adviceOnlyInput: JsonObject = {
    appId: "demo-app",
    title: "只写加投建议",
    steps: [
      {
        title: "只写建议",
        memberId: "analysis-worker",
        prompt: "只写加投建议,不建广,不执行建广,不改预算。",
      },
    ],
  };
  assertSchemaAccepts(tool, adviceOnlyInput, "Q1 advice-only negated high-risk prompt");
  const adviceOnly = await tool.execute(adviceOnlyInput, TOOL_CONTEXT);
  assert.equal(
    adviceOnly.ok,
    true,
    `Q1: a negated prompt without a high-risk toolId should be allowed: ${adviceOnly.error ?? ""}`,
  );

  const realHighRiskWithoutFlowApproval: JsonObject = {
    appId: "demo-app",
    title: "真实建广无 flow 审批",
    steps: [
      {
        title: "建广告",
        toolId: "drama-ops auto-ads-create",
        prompt: "执行建广",
        input: {},
      },
    ],
  };
  assertSchemaAccepts(tool, realHighRiskWithoutFlowApproval, "Q1 real high-risk tool without flow approval");
  const rejected = await tool.execute(realHighRiskWithoutFlowApproval, TOOL_CONTEXT);
  assert.equal(rejected.ok, false, "Q1: a real high-risk toolId without flow approval must still be rejected");
  assert.ok((rejected as { error: string }).error.startsWith("high_risk_without_flow_approval:"));
  console.log("Q1 high-risk toolId-only gate passed");
});

// ===== 基础正路:真实工具生成的文件能 parse =====
await withHarnessApp(async ({ tool }) => {
  const input: JsonObject = {
    title: "Daily attribution report",
    description: "出归因日报",
    steps: [{ title: "读账本", toolId: "room.ledger.read", input: { roomId: "app-room--demo-app--group--default" } }],
  };
  assertSchemaAccepts(tool, input, "valid workflow");
  const result = await tool.execute(input, TOOL_CONTEXT);
  assert.equal(result.ok, true, `a valid routine should be created successfully: ${result.error ?? ""}`);
  const knowledgeId = (result as unknown as { value: { knowledgeId: string } }).value.knowledgeId;
  assert.ok(knowledgeId, "should return a knowledgeId");
  const routinesDir = resolve(knowledgeVaultRoot(), APP_VAULT_ROOT_NAME, "routines");
  const filePath = resolve(routinesDir, "Daily attribution report.routine.md");
  const parsed = parseRoutineFile(readFileSync(filePath, "utf8"));
  assert.equal(parsed.ok, true, "the generated file should be parseable by parseRoutineFile");
  console.log("P2 valid create→file parse passed");
});

// ===== PM 可用性:room.ledger.read 缺 roomId 时,workflow.create 从 appId 补默认群组 roomId =====
await withHarnessApp(async ({ tool }) => {
  const missingRoomIdInput: JsonObject = {
    appId: "demo-app",
    title: "Missing room id",
    steps: [{ title: "读账本", toolId: "room.ledger.read" }],
  };
  assertSchemaAccepts(tool, missingRoomIdInput, "missing roomId workflow");
  const result = await tool.execute(missingRoomIdInput, TOOL_CONTEXT);
  assert.equal(
    result.ok,
    true,
    `when the PM omits roomId, the default app group should be filled in automatically: ${result.error ?? ""}`,
  );
  const routinesDir = resolve(knowledgeVaultRoot(), APP_VAULT_ROOT_NAME, "routines");
  const filePath = resolve(routinesDir, "Missing room id.routine.md");
  const parsed = parseRoutineFile(readFileSync(filePath, "utf8"));
  assert.equal(parsed.ok, true, "the auto-filled routine should be readable back by the parser");
  if (parsed.ok) {
    const stepInput = parsed.routine.steps[0]?.input as JsonObject | undefined;
    assert.equal(stepInput?.roomId, "app-room--demo-app--group--default");
  }
  console.log("room.ledger.read default app roomId fill passed");
});

// ===== 缺少 app scope 时仍拒绝:不能无上下文乱猜 roomId =====
await withHarnessApp(async ({ tool }) => {
  const missingScopeInput: JsonObject = {
    title: "Missing app scope room id",
    steps: [{ title: "读账本", toolId: "room.ledger.read" }],
  };
  assertSchemaAccepts(tool, missingScopeInput, "missing app scope roomId workflow");
  const result = await tool.execute(missingScopeInput, TOOL_CONTEXT);
  assert.equal(result.ok, false, "room.ledger.read missing roomId must still be rejected when there is no appId");
  assert.equal((result as { error: string }).error, "tool_input_invalid:room.ledger.read:room_id_required");
  console.log("room.ledger.read missing app scope rejection passed");
});

// ===== RC2:重复 title 后,knowledge doc metadata.vaultPath 也必须唯一且指向实际文件 =====
await withHarnessApp(async ({ app, tool }) => {
  const title = `RC2 duplicate ${Date.now()}`;
  const input: JsonObject = {
    title,
    steps: [{ title: "读", toolId: "room.ledger.read", input: { roomId: "app-room--demo-app--group--default" } }],
  };
  assertSchemaAccepts(tool, input, "RC2 duplicate first");
  const first = await tool.execute(input, TOOL_CONTEXT);
  assert.equal(first.ok, true, `RC2: the first creation should succeed: ${first.error ?? ""}`);
  assertSchemaAccepts(tool, input, "RC2 duplicate second");
  const second = await tool.execute(input, TOOL_CONTEXT);
  assert.equal(second.ok, true, `RC2: the second same-title creation should succeed: ${second.error ?? ""}`);

  const documents = app.knowledge.list().filter((document) => document.title === title);
  assert.equal(documents.length, 2, "RC2: two same-title creations should produce two routine knowledge docs");
  const vaultPaths = documents.map(metadataVaultPath);
  assert.equal(new Set(vaultPaths).size, 2, `RC2: vaultPath should be unique, got ${vaultPaths.join(", ")}`);
  for (const vaultPath of vaultPaths) {
    assert.ok(
      vaultPath.startsWith(`${APP_VAULT_ROOT_NAME}/routines/`),
      `RC2: vaultPath should be under routines: ${vaultPath}`,
    );
    assert.ok(
      existsSync(resolve(knowledgeVaultRoot(), vaultPath)),
      `RC2: vaultPath should point to a real on-disk file: ${vaultPath}`,
    );
  }
  console.log("RC2 duplicate title doc metadata + files passed");
});

// ===== RC3:app scope 真实入口校验,app A 不能编排 app B 成员 =====
await withHarnessApp(async ({ app, tool }) => {
  addLocalMember(app, { id: "member-app-a-worker", appId: "app-a" });
  addLocalMember(app, { id: "member-app-b-worker", appId: "app-b" });

  const crossAppInput: JsonObject = {
    appId: "app-a",
    title: "Cross app member routine",
    steps: [{ title: "调用 B", memberId: "member-app-b-worker", prompt: "work" }],
  };
  assertSchemaAccepts(tool, crossAppInput, "RC3 cross-app member");
  const crossApp = await tool.execute(crossAppInput, TOOL_CONTEXT);
  assert.equal(crossApp.ok, false, "RC3: app A workflow.create must not accept app B members");
  assert.equal((crossApp as { error: string }).error, "member_out_of_scope:member-app-b-worker");

  const missingScopeInput: JsonObject = {
    title: "Missing app scope routine",
    steps: [{ title: "调用 A", memberId: "member-app-a-worker", prompt: "work" }],
  };
  assertSchemaAccepts(tool, missingScopeInput, "RC3 missing appId for app member");
  const missingScope = await tool.execute(missingScopeInput, TOOL_CONTEXT);
  assert.equal(missingScope.ok, false, "RC3: a workflow using app members must pass an explicit appId scope");
  assert.equal((missingScope as { error: string }).error, "app_scope_required:member-app-a-worker");

  const sameAppInput: JsonObject = {
    appId: "app-a",
    title: "Same app member routine",
    steps: [{ title: "调用 A", memberId: "member-app-a-worker", prompt: "work" }],
  };
  assertSchemaAccepts(tool, sameAppInput, "RC3 same app member");
  const sameApp = await tool.execute(sameAppInput, TOOL_CONTEXT);
  assert.equal(sameApp.ok, true, `RC3: a same-app member should be allowed: ${sameApp.error ?? ""}`);

  console.log("RC3 app scope member validation passed");
});

// ===== R1/R3 旧反例仍保持:disabled 成员拒绝,approval 空 reason 拒绝 =====
await withHarnessApp(async ({ app, tool }) => {
  addLocalMember(app, { id: "member-app-a-disabled", appId: "app-a", disabled: true });
  const disabledInput: JsonObject = {
    appId: "app-a",
    title: "Disabled member routine",
    steps: [{ title: "disabled", memberId: "member-app-a-disabled", prompt: "work" }],
  };
  assertSchemaAccepts(tool, disabledInput, "disabled member");
  const disabled = await tool.execute(disabledInput, TOOL_CONTEXT);
  assert.equal(disabled.ok, false);
  assert.equal((disabled as { error: string }).error, "member_disabled:member-app-a-disabled");

  const emptyReasonInput: JsonObject = {
    appId: "demo-app",
    title: "Empty approval reason",
    steps: [
      { title: "flow 审批", flowApproval: { flowId: "ads-create", stepId: "approve-create" } },
      {
        title: "读账本",
        toolId: "room.ledger.read",
        input: { roomId: "app-room--demo-app--group--default" },
        approval: { mode: "ask", reason: "" },
      },
    ],
  };
  assertSchemaAccepts(tool, emptyReasonInput, "empty approval reason");
  const emptyReason = await tool.execute(emptyReasonInput, TOOL_CONTEXT);
  assert.equal(emptyReason.ok, false, "R3: an approval with an empty reason should be rejected before writing to disk");
  assert.ok((emptyReason as { error: string }).error.startsWith("approval_invalid:"));
  console.log("R1 disabled + R3 empty approval reason passed");
});

// ===== RC4:非法 schedule 不能静默降级成 manual =====
await withHarnessApp(async ({ tool }) => {
  const badScheduleInput: JsonObject = {
    title: "Bad schedule",
    schedule: { at: "24:00" },
    steps: [{ title: "读账本", toolId: "room.ledger.read", input: { roomId: "app-room--demo-app--group--default" } }],
  };
  assertSchemaAccepts(tool, badScheduleInput, "RC4 bad schedule");
  const result = await tool.execute(badScheduleInput, TOOL_CONTEXT);
  assert.equal(result.ok, false, "RC4: an invalid schedule must be rejected, not silently downgraded to manual");
  assert.equal((result as { error: string }).error, "schedule_invalid:at_out_of_range");
  console.log("RC4 invalid schedule rejection passed");
});

console.log("workflow-create-tool-harness passed");
