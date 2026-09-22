import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientToolCalls } from "../server/client-tool-calls.js";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { ToolCallContext } from "../core.js";

function setup() {
  const controller = new AbortController();
  const broker = new ClientToolCalls("run-a", controller.signal);
  const [tool] = broker.definitions([
    { id: "client.edit", description: "Edit the document", inputSchema: { type: "object" }, timeoutMs: 1_000 },
  ]);
  const app = createOpenGrove({
    readPage: () => ({}),
    runtime: {
      async *runTurn() {
        yield* [];
      },
    },
  });
  const context: ToolCallContext = {
    runId: "run-a",
    memory: app.memory,
    artifacts: app.artifacts,
    workingState: app.workingState,
    approvals: app.approvals,
    skills: app.skills,
    packs: app.packs,
    policy: { mode: "allow", reason: "test" },
  };
  assert.ok(tool);
  return { controller, broker, tool, context };
}

test("product call blocks for its own result and identical retries do not execute it again", async () => {
  const { broker, tool, context } = setup();
  const pending = tool.execute({ text: "new text" }, context);
  const [call] = broker.list();
  assert.ok(call);
  assert.equal(call.status, "pending");
  assert.equal(call.runId, "run-a");
  assert.deepEqual(call.input, { text: "new text" });
  const result = { ok: true, value: { revision: 2 } };
  assert.equal(broker.resolve(call.id, result), "accepted");
  assert.deepEqual(await pending, result);
  assert.equal(broker.resolve(call.id, result), "accepted");
  assert.equal(broker.resolve(call.id, { ok: true, value: { revision: 3 } }), "conflict");
  assert.equal(broker.resolve("other-call", result), "missing");
  broker.close();
});

test("canceled client calls reject late results and cannot hang an Agent", async () => {
  const { controller, broker, tool, context } = setup();
  const pending = tool.execute({}, context);
  const [call] = broker.list();
  assert.ok(call);
  controller.abort();
  assert.deepEqual(await pending, { ok: false, error: "client_tool_outcome_unknown" });
  assert.equal(broker.list()[0]?.status, "canceled");
  assert.equal(broker.resolve(call.id, { ok: true }), "conflict");
  assert.deepEqual(await tool.execute({}, context), { ok: false, error: "client_tool_canceled" });
});

test("closing one run settles only its tools and returns defensive call snapshots", async () => {
  const a = setup();
  const b = setup();
  const first = a.tool.execute({ text: "a" }, a.context);
  const second = b.tool.execute({ text: "b" }, b.context);
  const snapshot = a.broker.list();
  snapshot[0]!.input.text = "mutated";
  assert.equal(a.broker.list()[0]?.input.text, "a");
  a.broker.close();
  await first;
  assert.equal(b.broker.list()[0]?.status, "pending");
  b.broker.close();
  await second;
});

test("product calls expire with an unknown outcome and reject a later success", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fixture = setup();
  const pending = fixture.tool.execute({}, fixture.context);
  const call = fixture.broker.list()[0]!;
  context.mock.timers.tick(1001);
  assert.deepEqual(await pending, { ok: false, error: "client_tool_outcome_unknown" });
  assert.equal(fixture.broker.list()[0]?.status, "timed_out");
  assert.equal(fixture.broker.resolve(call.id, { ok: true }), "conflict");
  fixture.broker.close();
});
