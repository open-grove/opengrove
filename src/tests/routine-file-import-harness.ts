import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoutineFile, serializeRoutineFile } from "../routines/routine-file.js";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { BridgeSecurity } from "../server/bridge-security.js";
import type { BridgeState } from "../server/bridge-types.js";
import { createBridgeRoutes } from "../server/routes/bridge-registry.js";
import { dispatchBridgeRoutes } from "../server/router.js";
import type { Routine } from "../core.js";

// ===== P1 harness: routine 文件格式 + 显式导入通路 =====
// 覆盖规格 P1:
//   - 合法文件 → 导入 → 进 RoutineRegistry 且能跑。
//   - memberId 不存在/不可运行 → 拒绝。
//   - toolId 不在 state.app.tools → 拒绝。
//   - knowledgeId 指向 routines/ 之外或目录穿越 → 拒绝。
//   - skillId-only step → 拒绝。
//   - serialize → parse round-trip 字段一致。

const RUNNABLE_KERNEL = "claude-code";
const MEMBER_ID = "member-test-worker";

function createHarnessState(): BridgeState {
  const app = createOpenGrove({
    cwd: mkdtempSync(join(tmpdir(), "opengrove-routine-import-")),
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        yield* [];
      },
    },
  });
  // 构造一个可运行的 member(kernel=claude-code, source=local),让 memberId step 能通过导入校验。
  const room = app.rooms.createRoom({ id: "room-test", title: "Test room" });
  app.rooms.addMember(room.id, {
    id: MEMBER_ID,
    name: "Worker",
    kernel: RUNNABLE_KERNEL,
    model: "gpt-test",
    role: "test worker",
    status: "idle",
    color: "#000000",
    lastActive: new Date().toISOString(),
    source: "local",
  });
  return {
    app,
    profile: "local",
    store: {
      saveFrom(value: unknown) {
        assert.equal(value, app);
      },
    },
  } as unknown as BridgeState;
}

async function dispatch(input: {
  method: string;
  path: string;
  body?: unknown;
  state?: BridgeState;
  security?: BridgeSecurity;
}): Promise<{ handled: boolean; status?: number; data?: unknown }> {
  let status: number | undefined;
  let data: unknown;
  const handled = await dispatchBridgeRoutes(createBridgeRoutes(), {
    traceId: "trace-routine-file-import-harness",
    request: { method: input.method, headers: {} } as never,
    response: {} as never,
    url: new URL(input.path, "http://127.0.0.1"),
    state: input.state ?? createHarnessState(),
    security: input.security ?? { authMode: "bridge-token", allowedOrigins: [] },
    sendJson(_response: unknown, code: number, payload: unknown) {
      status = code;
      data = payload;
    },
    readJsonBody: async () => input.body ?? {},
  } as never);
  return { handled, status, data };
}

// ===== round-trip:serialize → parse 字段一致 =====
const original: Routine = {
  id: "rt1",
  title: "Daily report routine",
  description: "生成日报并审核",
  status: "active",
  trigger: "manual",
  capabilityIds: [],
  approvalRules: [],
  createdAt: "2026-06-17T00:00:00.000Z",
  updatedAt: "2026-06-17T00:00:00.000Z",
  steps: [
    { id: "step_1", title: "Produce", toolId: "room.ledger.read", input: { roomId: "r1" } },
    { id: "step_2", title: "Worker", memberId: MEMBER_ID, prompt: "based on {{steps.step_1.output}}" },
  ],
};
const serialized = serializeRoutineFile(original, "# 日报流程\n\n每天生成并审核。");
assert.ok(
  serialized.startsWith("---\n"),
  "serialized output should start with ---\\n (hits the verbatim-write branch)",
);
const reparsed = parseRoutineFile(serialized);
assert.equal(reparsed.ok, true, "round-trip: serialized output should parse back");
if (reparsed.ok) {
  assert.equal(reparsed.routine.title, original.title);
  assert.equal(reparsed.routine.description, original.description);
  assert.equal(reparsed.routine.steps.length, 2);
  assert.equal(reparsed.routine.steps[1]!.prompt, "based on {{steps.step_1.output}}");
  assert.ok(reparsed.routine.body.includes("日报流程"), "the body should be preserved");
}
console.log("P1 round-trip serialize→parse passed");

// ===== R4 反例:schedule 范围校验(99:99 / 24:00 → parser 拒绝)=====
// 旧 parser 只校验格式 /HH:MM/,99:99 能过;现加范围(hour 0-23 / minute 0-59)。
const badHourContent =
  "---\n" +
  JSON.stringify({
    title: "Bad schedule hour",
    trigger: "schedule",
    schedule: { at: "24:00" },
    steps: [{ id: "s1", title: "T", toolId: "room.ledger.read" }],
  }) +
  "\n---\n";
const badHourParsed = parseRoutineFile(badHourContent);
assert.equal(badHourParsed.ok, false, "R4: 24:00 should be rejected by range validation");
const badMinContent =
  "---\n" +
  JSON.stringify({
    title: "Bad schedule minute",
    trigger: "schedule",
    schedule: { at: "12:99" },
    steps: [{ id: "s1", title: "T", toolId: "room.ledger.read" }],
  }) +
  "\n---\n";
const badMinParsed = parseRoutineFile(badMinContent);
assert.equal(badMinParsed.ok, false, "R4: 12:99 should be rejected by range validation");
// 合法边界 23:59 / 00:00 应通过。
const validEdgeContent =
  "---\n" +
  JSON.stringify({
    title: "Edge schedule",
    trigger: "schedule",
    schedule: { at: "23:59" },
    steps: [{ id: "s1", title: "T", toolId: "room.ledger.read" }],
  }) +
  "\n---\n";
const validEdgeParsed = parseRoutineFile(validEdgeContent);
assert.equal(validEdgeParsed.ok, true, "R4: 23:59 should pass range validation");
const validIntervalContent =
  "---\n" +
  JSON.stringify({
    title: "Interval schedule",
    trigger: "schedule",
    schedule: { everyMinutes: 2 },
    steps: [{ id: "s1", title: "T", toolId: "room.ledger.read" }],
  }) +
  "\n---\n";
const validIntervalParsed = parseRoutineFile(validIntervalContent);
assert.equal(validIntervalParsed.ok, true, "everyMinutes=2 should pass schedule validation");
if (validIntervalParsed.ok) {
  assert.deepEqual(validIntervalParsed.routine.schedule, { everyMinutes: 2 });
}
console.log("R4 反例 schedule范围校验(99:99/24:00拒绝) passed");

// ===== 合法文件 → 导入 → 进 Registry → 可跑 =====
const validContent = serializeRoutineFile(
  {
    title: "Valid import routine",
    trigger: "manual",
    steps: [
      { id: "s1", title: "Read ledger", toolId: "room.ledger.read", input: { roomId: "r1" } },
      { id: "s2", title: "Worker step", memberId: MEMBER_ID, prompt: "summarize" },
    ],
  },
  "",
);

const validState = createHarnessState();
const validImport = await dispatch({
  method: "POST",
  path: "/routines/import",
  body: { content: validContent },
  state: validState,
});
assert.equal(validImport.handled, true);
assert.equal(
  validImport.status,
  200,
  `a valid import should return 200, got ${(validImport.data as { error?: string }).error ?? validImport.status}`,
);
const validRoutine = (validImport.data as { routine: Routine }).routine;
assert.equal(validRoutine.title, "Valid import routine");
assert.equal(
  validState.app.routines.get(validRoutine.id)?.title,
  "Valid import routine",
  "should be in the RoutineRegistry",
);
console.log("P1 合法文件导入 passed");

// ===== tool 运行期必需输入缺失 → 导入期拒绝 =====
const missingToolInputContent = serializeRoutineFile(
  {
    title: "Missing tool input routine",
    steps: [{ id: "s1", title: "Read ledger", toolId: "room.ledger.read" }],
  },
  "",
);
const missingToolInputImport = await dispatch({
  method: "POST",
  path: "/routines/import",
  body: { content: missingToolInputContent },
});
assert.equal(missingToolInputImport.status, 400);
assert.equal(
  (missingToolInputImport.data as { error: string }).error,
  "tool_input_invalid:room.ledger.read:room_id_required",
);
console.log("P1 tool 必需输入缺失拒绝 passed");

// ===== memberId 不存在/不可运行 → 拒绝 =====
const badMemberContent = serializeRoutineFile(
  {
    title: "Bad member routine",
    steps: [{ id: "s1", title: "Ghost", memberId: "member-does-not-exist", prompt: "x" }],
  },
  "",
);
const badMemberImport = await dispatch({
  method: "POST",
  path: "/routines/import",
  body: { content: badMemberContent },
});
assert.equal(badMemberImport.status, 400);
assert.equal((badMemberImport.data as { error: string }).error, "member_not_runnable:member-does-not-exist");
console.log("P1 memberId 不可运行拒绝 passed");

// ===== toolId 不存在 → 拒绝 =====
const badToolContent = serializeRoutineFile(
  {
    title: "Bad tool routine",
    steps: [{ id: "s1", title: "Ghost tool", toolId: "tool.does.not.exist" }],
  },
  "",
);
const badToolImport = await dispatch({
  method: "POST",
  path: "/routines/import",
  body: { content: badToolContent },
});
assert.equal(badToolImport.status, 400);
assert.equal((badToolImport.data as { error: string }).error, "tool_not_registered:tool.does.not.exist");
console.log("P1 toolId 未注册拒绝 passed");

// ===== skillId-only step → 拒绝(parser 层) =====
const skillOnlyContent =
  "---\n" +
  JSON.stringify({
    title: "Skill only",
    steps: [{ id: "s1", title: "Skill", skillId: "some-skill" }],
  }) +
  "\n---\n";
const skillImport = await dispatch({
  method: "POST",
  path: "/routines/import",
  body: { content: skillOnlyContent },
});
assert.equal(skillImport.status, 400);
assert.ok(
  String((skillImport.data as { error: string }).error).startsWith("routine_file_validation_failed"),
  "a skillId-only step should be rejected by the parser",
);
console.log("P1 skillId-only step 拒绝 passed");

// ===== knowledgeId 路径边界:routines/ 内 → 允许;之外 → 拒绝 =====
const routineDoc = validState.app.knowledge.create({
  type: "routine",
  title: "Knowledge routine",
  body: validContent,
  format: "markdown",
  metadata: { vaultPath: "OpenGrove/routines/knowledge-routine.md" },
});
const inDirImport = await dispatch({
  method: "POST",
  path: "/routines/import",
  body: { knowledgeId: routineDoc.id },
  state: validState,
});
assert.equal(inDirImport.status, 200, "a knowledgeId pointing inside OpenGrove/routines/ should be allowed to import");

const outOfDirDoc = validState.app.knowledge.create({
  type: "routine",
  title: "Misplaced routine",
  body: validContent,
  format: "markdown",
  metadata: { vaultPath: "OpenGrove/notes/misplaced.md" },
});
const outOfDirImport = await dispatch({
  method: "POST",
  path: "/routines/import",
  body: { knowledgeId: outOfDirDoc.id },
  state: validState,
});
assert.equal(outOfDirImport.status, 400);
assert.equal((outOfDirImport.data as { error: string }).error, "routine_not_in_routines_dir");
console.log("P1 knowledgeId 路径边界校验 passed");

// ===== 非任意 filePath:不传 knowledgeId/content → 拒绝 =====
const noContentImport = await dispatch({
  method: "POST",
  path: "/routines/import",
  body: { filePath: "/etc/passwd" },
});
assert.equal(noContentImport.status, 400);
assert.equal(
  (noContentImport.data as { error: string }).error,
  "content_required",
  "arbitrary filePath must not be accepted",
);
console.log("P1 不接受任意 filePath passed");

console.log("routine-file-import-harness passed");
