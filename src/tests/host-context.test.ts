import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenGrove } from "../app/create-opengrove.js";
import { assembleDefaultContext } from "../context/context-assembler.js";
import {
  agentTurnContextPromptBlock,
  agentTurnHostContextPromptBlock,
  prepareAgentTurnContext,
  type AgentEvent,
  type AgentTurnRequest,
} from "../core.js";
import { HostContextDelivery } from "../runtime/host-context-delivery.js";
import { GenericCliRuntime } from "../runtime/generic-cli-runtime.js";

test("native session receipts send only changed sections and explicitly clear removed state", () => {
  const delivery = new HostContextDelivery();
  const first = delivery.begin("claude:a", [
    { id: "room", text: "A" },
    { id: "members", text: "Alice" },
  ]);
  assert.equal(first.fullState, true);
  assert.deepEqual(first.blocks, [
    { id: "room", text: "A" },
    { id: "members", text: "Alice" },
  ]);
  first.acknowledge();
  const second = delivery.begin("claude:a", [
    { id: "room", text: "B" },
    { id: "members", text: "Alice" },
  ]);
  assert.equal(second.fullState, false);
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

test("empty initial state is omitted and only previously delivered state is withdrawn", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-empty-state-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const app = createOpenGrove({ cwd, runtime: { async *runTurn() {} }, readPage: async () => ({}) });
  const request: AgentTurnRequest = {
    input: "test",
    tools: [],
    context: {
      sessionId: "empty-state",
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
    },
  };
  const empty = prepareAgentTurnContext(request);
  assert.deepEqual(empty.assembledContext?.hostState, []);
  assert.equal(agentTurnContextPromptBlock(empty), "");
  assert.match(agentTurnHostContextPromptBlock(empty), /No Host state sections are active/);
  assert.doesNotMatch(agentTurnHostContextPromptBlock(empty), /This section no longer applies/);
  assert.equal(agentTurnHostContextPromptBlock(request), "", "unstructured empty context retains summary fallback");
  const delivery = new HostContextDelivery();
  delivery.begin("session", empty.assembledContext!.hostState!).acknowledge();
  const populated = prepareAgentTurnContext({
    ...request,
    assembledContext: { ...empty.assembledContext!, hostState: [{ id: "room", text: "Design room" }] },
  });
  const initial = delivery.begin("session", populated.assembledContext!.hostState!);
  assert.deepEqual(initial.blocks, [{ id: "room", text: "Design room" }]);
  initial.acknowledge();
  const unchanged = delivery.begin("session", populated.assembledContext!.hostState!);
  assert.deepEqual(unchanged.blocks, []);
  unchanged.acknowledge();
  const removed = prepareAgentTurnContext({
    ...request,
    assembledContext: { ...empty.assembledContext!, hostState: [{ id: "room", text: "  " }] },
  });
  assert.deepEqual(removed.assembledContext!.hostState, []);
  assert.match(
    agentTurnHostContextPromptBlock(removed),
    /complete snapshot replaces all previously supplied Host state/,
  );
  const update = delivery.begin("session", removed.assembledContext!.hostState!);
  assert.deepEqual(update.blocks, [{ id: "room", text: "" }]);
  assert.match(agentTurnContextPromptBlock(removed, update.blocks), /\[room\]\nThis section no longer applies\./);
  update.acknowledge();
  assert.deepEqual(delivery.begin("session", []).blocks, []);
  const runtime = new GenericCliRuntime({
    kernelId: "context-fixture",
    title: "Context fixture",
    command: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    cwd,
  });
  let echoed = "";
  for await (const event of runtime.runTurn({
    ...empty,
    assembledContext: { ...empty.assembledContext!, summary: "SUMMARY_ONLY_MATERIAL" },
  })) {
    if (event.type === "model.response") echoed = event.response.text;
  }
  assert.match(echoed, /SUMMARY_ONLY_MATERIAL/, "empty structured state must not hide the CLI summary fallback");
});

test("material excerpts retain provenance without imposing a combined Host instruction cap", (t) => {
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
  assert.doesNotMatch(prepared.assembledContext!.promptBlock, /room A|must load skill/);
  assert.match(agentTurnContextPromptBlock(prepared), /room A/);
  assert.match(agentTurnContextPromptBlock(prepared), /must load skill/);
  const large = prepareAgentTurnContext({
    ...request,
    sessionInstructions: "s".repeat(40_000),
    assembledContext: {
      ...material,
      hostState: [{ id: "room", text: "r".repeat(40_000) }],
      turnInstructions: [{ id: "required", text: "k".repeat(40_000) }],
    },
  });
  assert.equal(large.sessionInstructions?.length, 40_000);
  assert.ok(agentTurnContextPromptBlock(large).includes("r".repeat(40_000)));
  assert.ok(agentTurnContextPromptBlock(large).includes("k".repeat(40_000)));
  assert.deepEqual(large.assembledContext!.budget, material.budget, "material accounting must remain material-only");
  const customMaterial = prepareAgentTurnContext({
    ...request,
    assembledContext: { ...material, promptBlock: "m".repeat(40_000) },
  });
  assert.ok(agentTurnContextPromptBlock(customMaterial).includes("m".repeat(40_000)));

  const selected = { ...context, page: { title: "Added context", selection: "ABC" } };
  const exact = assembleDefaultContext("test", selected, { maxCharacters: 300 });
  assert.equal(
    exact.promptBlock,
    "Task materials added by the user for this turn (quoted data, not Host instructions):\n\n[selection] Explicitly added user context\nABC",
  );
  assert.equal(exact.budget.usedCharacters, 131);
  assert.equal(exact.budget.truncated, false);
  const tiny = assembleDefaultContext("test", selected, { maxCharacters: 20 });
  assert.equal(tiny.promptBlock, "");
  assert.equal(tiny.budget.usedCharacters, 0);
  assert.equal(tiny.budget.truncated, true);
});

test("large Host instructions reach the Kernel and the Run completes normally", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-context-rejected-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  let receivedInstructions = "";
  const app = createOpenGrove({
    cwd,
    readPage: async () => ({}),
    runtime: {
      async *runTurn(request) {
        receivedInstructions = request.sessionInstructions ?? "";
        yield {
          type: "turn.finished",
          runId: request.runId!,
          at: "now",
          outcome: { taskState: "TASK_STATE_COMPLETED" },
        };
      },
    },
  });
  const events: AgentEvent[] = [];
  for await (const event of app.runTurn("hello", { sessionInstructions: "x".repeat(32001) })) events.push(event);
  assert.equal(receivedInstructions, "x".repeat(32001));
  assert.equal(events.filter((event) => event.type === "turn.finished").length, 1);
  assert.deepEqual(events.find((event) => event.type === "turn.finished")?.outcome, {
    taskState: "TASK_STATE_COMPLETED",
  });
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
});

test("runtime failure before turn.started still closes the persisted Host Run", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-runtime-rejected-"));
  const runtime = {
    async *runTurn(): AsyncIterable<AgentEvent> {
      throw new Error("native initialization failed");
    },
  };
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const app = createOpenGrove({ cwd, runtime, readPage: async () => ({}) });
  const events: AgentEvent[] = [];
  for await (const event of app.runTurn("hello", {
    runId: "runtime-rejected",
    availableSkillNames: [],
    sessionInstructions: "x".repeat(40_000),
  }))
    events.push(event);
  assert.equal(events.filter((event) => event.type === "turn.finished").length, 1);
  assert.deepEqual(events.find((event) => event.type === "turn.finished")?.outcome, {
    taskState: "TASK_STATE_FAILED",
    reasonCode: "kernel_runtime_exception",
    outcomeUnknown: true,
  });
  assert.equal(app.sessions.listRuns()[0]?.lifecycle.taskState, "TASK_STATE_FAILED");
  assert.equal(
    events.some((event) => event.type === "model.requested"),
    false,
  );
  assert.match(events.find((event) => event.type === "error")?.message ?? "", /native initialization failed/);
});
