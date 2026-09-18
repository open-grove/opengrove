import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenGrove } from "../app/create-opengrove.js";
import { assembleDefaultContext } from "../context/context-assembler.js";
import {
  agentTurnContextPromptBlock,
  prepareAgentTurnContext,
  type AgentEvent,
  type AgentTurnRequest,
} from "../core.js";
import { OpenClawGatewayRuntime } from "../runtime/openclaw-gateway-runtime.js";
import { HostContextDelivery } from "../runtime/host-context-delivery.js";

test("native session receipts send only changed sections and explicitly clear removed state", () => {
  const delivery = new HostContextDelivery();
  const first = delivery.begin("claude:a", [
    { id: "room", text: "A" },
    { id: "members", text: "Alice" },
  ]);
  assert.deepEqual(first.blocks, [
    { id: "room", text: "A" },
    { id: "members", text: "Alice" },
  ]);
  first.acknowledge();
  const second = delivery.begin("claude:a", [
    { id: "room", text: "B" },
    { id: "members", text: "Alice" },
  ]);
  assert.deepEqual(second.blocks, [{ id: "room", text: "B" }]);
  second.acknowledge();
  const third = delivery.begin("claude:a", [{ id: "room", text: "B" }]);
  assert.deepEqual(third.blocks, [{ id: "members", text: "" }]);
  third.acknowledge();
  assert.deepEqual(delivery.begin("claude:b", [{ id: "room", text: "B" }]).blocks, [{ id: "room", text: "B" }]);
  assert.deepEqual(delivery.begin("claude:a", [{ id: "room", text: "B" }]).blocks, []);
});

test("uncertain delivery and compaction cannot create a false receipt", () => {
  const delivery = new HostContextDelivery();
  const state = [{ id: "room", text: "A" }];
  const failed = delivery.begin("a", state);
  const retry = delivery.begin("a", state);
  assert.deepEqual(retry.blocks, state);
  failed.acknowledge();
  const overlapping = delivery.begin("a", state);
  assert.deepEqual(overlapping.blocks, state);
  overlapping.acknowledge();
  const beforeCompact = delivery.begin("a", state);
  assert.deepEqual(beforeCompact.blocks, []);
  delivery.invalidate("a");
  beforeCompact.acknowledge();
  assert.deepEqual(delivery.begin("a", state).blocks, state);
});

test("materials keep excerpt provenance and paths; total Host budget includes skills and stable rules", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-host-context-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const app = createOpenGrove({ cwd, runtime: { async *runTurn() {} }, readPage: async () => ({}) });
  const context: AgentTurnRequest["context"] = {
    sessionId: "context-test",
    activity: "chat",
    memory: app.memory,
    artifacts: app.artifacts,
    skills: app.skills,
    packs: app.packs,
    sessions: app.sessions,
    executions: app.executions,
    workingState: app.workingState,
    approvals: app.approvals,
    questions: app.questions,
    page: {
      attachments: [
        { id: "report", name: "report.txt", kind: "file", localPath: "/full/report.txt", text: "a".repeat(9000) },
      ],
    },
  };
  const material = assembleDefaultContext("test", context);
  assert.match(material.promptBlock, /Excerpt: 3200 of 9000 characters/);
  assert.match(material.promptBlock, /Local path: \/full\/report.txt/);
  assert.equal(material.budget.truncated, true);
  assert.equal(material.budget.usedCharacters, material.promptBlock.length);
  const small = assembleDefaultContext("test", context, { maxCharacters: 600 });
  assert.ok(small.promptBlock.length <= 600);
  assert.match(small.promptBlock, /Local path: \/full\/report.txt/);
  assert.match(small.promptBlock, /Excerpt truncated/);
  const request: AgentTurnRequest = {
    input: "test",
    context,
    tools: [],
    sessionInstructions: "stable",
    assembledContext: {
      ...material,
      hostState: [{ id: "room", text: "room A" }],
      turnInstructions: [{ id: "required", text: "must load skill" }],
    },
  };
  const prepared = prepareAgentTurnContext(request);
  assert.equal(prepared.sessionInstructions, "stable");
  assert.throws(
    () => agentTurnContextPromptBlock(prepared, [{ id: "removed".repeat(6000), text: "" }]),
    /host_context_budget_exceeded/,
  );
  assert.doesNotMatch(prepared.assembledContext!.promptBlock, /room A|must load skill/);
  assert.match(agentTurnContextPromptBlock(prepared), /room A/);
  assert.match(agentTurnContextPromptBlock(prepared), /must load skill/);
  assert.throws(
    () => prepareAgentTurnContext({ ...request, sessionInstructions: "s".repeat(32001) }),
    /host_context_budget_exceeded/,
  );
  assert.throws(
    () =>
      prepareAgentTurnContext({
        ...request,
        assembledContext: { ...material, turnInstructions: [{ id: "required", text: "s".repeat(32001) }] },
      }),
    /host_context_budget_exceeded/,
  );
  assert.throws(
    () => prepareAgentTurnContext({ ...request, assembledContext: { ...material, promptBlock: "s".repeat(32001) } }),
    /host_context_budget_exceeded/,
  );
});

test("oversized Host instructions fail before invoking the Kernel and close the Run", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-context-rejected-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  let invoked = false;
  const app = createOpenGrove({
    cwd,
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        invoked = true;
      },
    },
  });
  const events: AgentEvent[] = [];
  for await (const event of app.runTurn("hello", { sessionInstructions: "x".repeat(32001) })) events.push(event);
  assert.equal(invoked, false);
  assert.equal(events.filter((event) => event.type === "turn.finished").length, 1);
  assert.deepEqual(events.find((event) => event.type === "turn.finished")?.outcome, {
    taskState: "TASK_STATE_FAILED",
    reasonCode: "host_context_budget_exceeded",
  });
  assert.match(events.find((event) => event.type === "error")?.message ?? "", /required Host instructions/);
});

test("OpenClaw adapter-only context rejection closes the persisted Host Run", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-openclaw-context-rejected-"));
  const runtime = new OpenClawGatewayRuntime({ url: "ws://127.0.0.1:1" });
  t.after(() => {
    runtime.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const app = createOpenGrove({ cwd, runtime, readPage: async () => ({}) });
  const events: AgentEvent[] = [];
  // Fits the shared 32,000-character preflight, but OpenClaw's fixed Host
  // system preamble makes the final native request exceed that same budget.
  for await (const event of app.runTurn("hello", {
    runId: "openclaw-context-rejected",
    availableSkillNames: [],
    sessionInstructions: "x".repeat(31_748),
  }))
    events.push(event);
  assert.equal(events.filter((event) => event.type === "turn.finished").length, 1);
  assert.deepEqual(events.find((event) => event.type === "turn.finished")?.outcome, {
    taskState: "TASK_STATE_FAILED",
    reasonCode: "host_context_budget_exceeded",
  });
  assert.equal(app.sessions.listRuns()[0]?.lifecycle.taskState, "TASK_STATE_FAILED");
  assert.equal(
    events.some((event) => event.type === "model.requested"),
    false,
  );
  assert.match(events.find((event) => event.type === "error")?.message ?? "", /required Host instructions/);
});
