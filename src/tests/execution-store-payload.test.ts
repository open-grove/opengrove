import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionStore } from "../core/stores/execution-store.js";
import { presentExecutionSummaries } from "../server/state-presentation.js";

test("execution records preserve complete diagnostics while the wire summary stays bounded", () => {
  const store = new ExecutionStore();
  const body = "x".repeat(2_000_000);
  const record = store.appendFromEvent({
    type: "tool.finished",
    runId: "run-1",
    toolId: "large.tool",
    result: { ok: true, value: { body } },
  });

  assert.equal(record.data?.body, body);
  assert.ok(JSON.stringify(presentExecutionSummaries([record])).length < 10_000);

  const restored = new ExecutionStore();
  restored.restore([record]);
  assert.deepEqual(restored.list(), [record]);
});

test("execution revisions change only when execution records mutate", () => {
  const store = new ExecutionStore();
  const initial = store.revision();
  store.appendFromEvent({
    type: "turn.started",
    runId: "run-1",
    at: "2026-08-04T00:00:00.000Z",
  });
  const appended = store.revision();
  assert.notEqual(appended, initial);
  assert.equal(store.revision(), appended);
  store.clear();
  assert.notEqual(store.revision(), appended);
});
