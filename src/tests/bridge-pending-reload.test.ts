import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerActiveBridgeRun, setActiveBridgeRunExecutionState } from "../server/active-runs.js";
import { resolveApproval } from "../server/approval-actions.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import type { BridgeState } from "../server/bridge-types.js";

test("hot rebuild preserves and resolves a pending request on its live producer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-pending-hot-reload-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "run-live-ask";
  const releaseRun = registerActiveBridgeRun(state, runId);
  try {
    const producerApp = state.app;
    const executionState = {
      ...state,
      rootState: state,
      app: producerApp,
    } satisfies BridgeState;
    setActiveBridgeRunExecutionState(state, runId, executionState);
    const approval = producerApp.approvals.request({
      kind: "tool",
      title: "Live Ask approval",
      reason: "The producer is waiting for this decision",
      resume: {
        type: "kernel.native",
        kernelId: "codex",
        runId,
        continuation: "same-loop",
      },
    });
    state.store.saveFrom(producerApp);

    recreateBridgeApp(state);
    assert.notEqual(state.app, producerApp);
    assert.equal(state.app.approvals.get(approval.id)?.status, "pending");

    await resolveApproval(state, approval.id, "approved");
    assert.equal(producerApp.approvals.get(approval.id)?.status, "approved");
    assert.equal(state.app.approvals.get(approval.id)?.status, "approved");
  } finally {
    releaseRun();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hot rebuild preserves a resumable Routine approval without a live producer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-routine-hot-reload-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  try {
    const approval = state.app.approvals.request({
      kind: "routine_step",
      title: "Routine approval",
      reason: "The continuation is persisted in the request",
      resume: {
        type: "routine.step",
        routineId: "routine-test",
        stepId: "approval-step",
        runId: "routine-run-test",
      },
    });
    state.store.saveFrom(state.app);

    recreateBridgeApp(state);
    assert.equal(state.app.approvals.get(approval.id)?.status, "pending");
  } finally {
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an active Ask without a producer waiter still replays an approved Bridge tool", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-ask-approval-replay-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "run-active-bridge-replay";
  const releaseRun = registerActiveBridgeRun(state, runId);
  let executionCount = 0;
  try {
    state.app.tools.register({
      spec: {
        id: "test.approved-tool",
        title: "Approved tool",
        description: "Regression test tool",
        activity: "local",
        risk: "write",
        input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
        permission: { mode: "allow", reason: "test" },
      },
      async execute() {
        executionCount += 1;
        return { ok: true, value: { executionCount } };
      },
    });
    setActiveBridgeRunExecutionState(state, runId, {
      ...state,
      rootState: state,
      app: state.app,
    });
    const approval = state.app.approvals.request({
      kind: "tool",
      title: "Replay this tool",
      reason: "The original producer stopped at the approval boundary",
      toolId: "test.approved-tool",
      input: { approved: true },
      resume: { type: "tool", runId },
    });

    const result = await resolveApproval(state, approval.id, "approved");
    assert.equal(executionCount, 1);
    assert.equal(result.toolResult?.ok, true);
    assert.ok(state.app.events.list().some((event) => event.type === "approval.resolved"));
    assert.ok(state.app.events.list().some((event) => event.type === "run.resumed"));
    assert.ok(state.app.events.list().some((event) => event.type === "turn.finished"));
  } finally {
    releaseRun();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an active producer waiter is resolved without replaying its tool twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-ask-approval-waiter-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const runId = "run-active-producer-waiter";
  const releaseRun = registerActiveBridgeRun(state, runId);
  let executionCount = 0;
  try {
    state.app.tools.register({
      spec: {
        id: "test.waiting-tool",
        title: "Waiting tool",
        description: "Regression test tool",
        activity: "local",
        risk: "write",
        input: { type: "json-schema", schema: { type: "object", additionalProperties: true } },
        permission: { mode: "allow", reason: "test" },
      },
      async execute() {
        executionCount += 1;
        return { ok: true, value: { executionCount } };
      },
    });
    setActiveBridgeRunExecutionState(state, runId, {
      ...state,
      rootState: state,
      app: state.app,
    });
    const approval = state.app.approvals.request({
      kind: "tool",
      title: "Wake the producer",
      reason: "The producer owns this continuation",
      toolId: "test.waiting-tool",
      input: { approved: true },
      resume: { type: "tool", runId },
    });
    const producerDecision = state.app.approvals.waitForDecision(approval.id);

    const result = await resolveApproval(state, approval.id, "approved");
    assert.equal((await producerDecision).status, "approved");
    assert.equal(executionCount, 0, "the Bridge must not duplicate work owned by the live producer");
    assert.equal(result.toolResult, undefined);
  } finally {
    releaseRun();
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
