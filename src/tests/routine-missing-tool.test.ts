import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenGrove } from "../app/create-opengrove.js";
import { runRoutine } from "../routines/routine-runner.js";

test("a Routine whose tool was removed records a terminal failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opengrove-routine-missing-tool-"));
  try {
    const app = createOpenGrove({ cwd, readPage: () => ({}), runtime: { async *runTurn() {} } });
    const routine = app.routines.create({
      title: "Removed tool",
      status: "active",
      trigger: "manual",
      capabilityIds: [],
      approvalRules: [],
      steps: [{ id: "missing", title: "Use removed tool", toolId: "removed.example", input: {} }],
    });
    const result = await runRoutine(app, routine.id);
    assert.equal(result.summary.status, "failed");
    assert.equal(result.summary.error, "tool_not_registered");
    assert.equal(app.routines.get(routine.id)?.lastRun?.status, "failed");
    assert.equal(result.events.at(-1)?.type, "turn.finished");
    assert.ok(
      app.events
        .list()
        .some((event) => event.type === "error" && event.message === "routine_tool_not_registered:removed.example"),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
