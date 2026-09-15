import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHostOperationCommand } from "../cli/host-operation-command.js";
import { createBridgeState } from "../server/bridge-state.js";
import { startOpenGroveServer } from "../server/create-server.js";

test("CLI queries persisted runs, sessions, and executions with revision polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-run-records-cli-"));
  const statePath = join(root, "state.sqlite");
  const seed = createBridgeState({ profile: "test", statePath });
  const at = "2026-09-15T00:00:00.000Z";
  seed.app.recordEvent(
    { type: "turn.started", runId: "run-record-cli", at },
    { sessionId: "session-cli", activity: "api", input: "Generate a report" },
  );
  seed.app.recordEvent(
    { type: "turn.finished", runId: "run-record-cli", at, outcome: { taskState: "TASK_STATE_COMPLETED" } },
    { sessionId: "session-cli", activity: "api" },
  );
  seed.store.saveFrom(seed.app);
  await seed.store.close?.();
  const token = "run-records-cli-test-token";
  const server = startOpenGroveServer({ host: "127.0.0.1", port: 0, profile: "test", statePath, bridgeToken: token });
  try {
    if (!server.listening) await once(server, "listening");
    const env = {
      OPENGROVE_BRIDGE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
      OPENGROVE_BRIDGE_TOKEN: token,
    };
    const runs = await runHostOperationCommand(
      ["run", "list", "--session-id", "session-cli", "--task-state", "TASK_STATE_COMPLETED", "--limit", "1"],
      { env },
    );
    assert.equal(runs.handled, true);
    assert.equal(runs.exitCode, 0, runs.stderr);
    const data = JSON.parse(runs.stdout ?? "null").data;
    assert.equal(data.runs.length, 1);
    assert.equal(data.runs[0].id, "run-record-cli");
    assert.equal(data.runs[0].input, "Generate a report");
    assert.equal(data.runs[0].lifecycle.taskState, "TASK_STATE_COMPLETED");
    const unchanged = await runHostOperationCommand(
      [
        "run",
        "list",
        "--session-id",
        "session-cli",
        "--task-state",
        "TASK_STATE_COMPLETED",
        "--limit",
        "1",
        "--after-revision",
        data.revision,
      ],
      { env },
    );
    assert.equal(unchanged.exitCode, 0, unchanged.stderr);
    assert.deepEqual(JSON.parse(unchanged.stdout ?? "null").data, {
      ok: true,
      unchanged: true,
      revision: data.revision,
    });
    const sessions = await runHostOperationCommand(["run", "session", "list", "--activity", "api"], { env });
    assert.equal(sessions.handled, true);
    assert.equal(sessions.exitCode, 0, sessions.stderr);
    assert.equal(JSON.parse(sessions.stdout ?? "null").data.sessions[0].id, "session-cli");
    const executions = await runHostOperationCommand(
      ["run", "execution", "list", "--run-id", "run-record-cli", "--kind", "loop"],
      { env },
    );
    assert.equal(executions.handled, true);
    assert.equal(executions.exitCode, 0, executions.stderr);
    const executionData = JSON.parse(executions.stdout ?? "null").data;
    assert.deepEqual(executionData.executions.map((item: { eventType: string }) => item.eventType).sort(), [
      "turn.finished",
      "turn.started",
    ]);
    const invalid = await runHostOperationCommand(["run", "list", "--limit", "1001"], { env });
    assert.equal(invalid.exitCode, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
