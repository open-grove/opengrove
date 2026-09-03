import assert from "node:assert/strict";
import { runOverviewStatus } from "../web/src/runtime/run-lifecycle.ts";

assert.equal(runOverviewStatus(undefined, false), "running");
assert.equal(runOverviewStatus({ taskState: "TASK_STATE_SUBMITTED" }, false), "running");
assert.equal(runOverviewStatus({ taskState: "TASK_STATE_WORKING" }, false), "running");
assert.equal(runOverviewStatus({ taskState: "TASK_STATE_INPUT_REQUIRED" }, false), "pending");
assert.equal(runOverviewStatus({ taskState: "TASK_STATE_AUTH_REQUIRED" }, false), "pending");
assert.equal(runOverviewStatus({ taskState: "TASK_STATE_COMPLETED" }, false), "done");
assert.equal(runOverviewStatus({ taskState: "TASK_STATE_FAILED" }, false), "blocked");
assert.equal(runOverviewStatus({ taskState: "TASK_STATE_CANCELED" }, false), "blocked");
assert.equal(runOverviewStatus({ taskState: "TASK_STATE_REJECTED" }, false), "blocked");
assert.equal(runOverviewStatus({ taskState: "TASK_STATE_COMPLETED" }, true), "blocked");

console.log("web-run-lifecycle ok");
