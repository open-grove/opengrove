import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHostOperationCommand } from "../cli/host-operation-command.js";
import { createSqliteStateStore } from "../storage/sqlite-state-store.js";
import type { PersistableAgentStatePorts } from "../storage/json-state-store.js";
import { startOpenGroveServer } from "../server/create-server.js";

test("CLI lists pending approvals and questions with their structured input", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-interaction-cli-"));
  const statePath = join(root, "state.sqlite");
  const store = createSqliteStateStore(statePath);
  let liveApp: PersistableAgentStatePorts | undefined;
  const at = "2026-09-15T00:00:00.000Z";
  const token = "run-records-cli-test-token";
  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    profile: "test",
    statePath,
    bridgeToken: token,
    store: {
      ...store,
      loadInto(app, options) {
        liveApp = app;
        return store.loadInto(app, options);
      },
    },
  });
  try {
    if (!server.listening) await once(server, "listening");
    assert.ok(liveApp);
    liveApp.approvals.restore([
      {
        id: "approval-cli",
        kind: "command",
        title: "Approve an action",
        reason: "Test request",
        status: "pending",
        createdAt: at,
        updatedAt: at,
        input: { command: "echo hello", nested: { values: [true, null, 7] } },
      },
    ]);
    liveApp.questions.restore([
      {
        id: "question-cli",
        title: "Choose a format",
        prompt: "Which format?",
        status: "pending",
        createdAt: at,
        updatedAt: at,
        input: { choices: ["JSON", "Text"] },
        source: { type: "host" },
      },
    ]);

    const env = {
      OPENGROVE_BRIDGE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
      OPENGROVE_BRIDGE_TOKEN: token,
    };
    const approvals = await runHostOperationCommand(
      ["interaction", "approval", "list", "--status", "pending", "--limit", "1"],
      { env },
    );
    assert.equal(approvals.handled, true);
    assert.equal(approvals.exitCode, 0, approvals.stderr);
    const approval = JSON.parse(approvals.stdout ?? "null").data.approvals[0];
    assert.equal(approval.id, "approval-cli");
    assert.deepEqual(approval.input, { command: "echo hello", nested: { values: [true, null, 7] } });
    const questions = await runHostOperationCommand(["interaction", "question", "list", "--status", "pending"], {
      env,
    });
    assert.equal(questions.handled, true);
    assert.equal(questions.exitCode, 0, questions.stderr);
    const question = JSON.parse(questions.stdout ?? "null").data.questions[0];
    assert.equal(question.id, "question-cli");
    assert.deepEqual(question.input, { choices: ["JSON", "Text"] });
    assert.deepEqual(question.source, { type: "host" });
    liveApp.approvals.restore(
      ["approve", "reject", "cancel"].map((action) => ({
        id: `approval-${action}`,
        kind: "command",
        title: "Review action",
        reason: "Fixture",
        status: "pending",
        createdAt: at,
        updatedAt: at,
      })),
    );
    const blocked = await runHostOperationCommand(
      ["interaction", "approval", "approve", "--approval-id", "approval-approve"],
      { env },
    );
    assert.equal(blocked.exitCode, 10);
    for (const [action, status] of [
      ["approve", "approved"],
      ["reject", "rejected"],
      ["cancel", "canceled"],
    ]) {
      const decision = await runHostOperationCommand(
        ["interaction", "approval", action!, "--approval-id", `approval-${action}`, "--yes"],
        { env },
      );
      assert.equal(decision.handled, true);
      assert.equal(decision.exitCode, 0, decision.stderr);
      const decided = JSON.parse(decision.stdout ?? "null").data;
      assert.equal(decided.approval.status, status);
      assert.ok(Array.isArray(decided.runs));
    }
    liveApp.questions.restore(
      ["answer", "decline", "cancel"].map((action) => ({
        id: `question-${action}`,
        title: "Choose format",
        prompt: "Which format?",
        status: "pending",
        createdAt: at,
        updatedAt: at,
      })),
    );
    for (const [action, status] of [
      ["answer", "answered"],
      ["decline", "declined"],
      ["cancel", "canceled"],
    ]) {
      const decision = await runHostOperationCommand(
        ["interaction", "question", action!, "--question-id", `question-${action}`, "--response", '{"choice":"JSON"}'],
        { env },
      );
      assert.equal(decision.handled, true);
      assert.equal(decision.exitCode, 0, decision.stderr);
      const decided = JSON.parse(decision.stdout ?? "null").data;
      assert.equal(decided.question.status, status);
      assert.deepEqual(decided.question.response, { choice: "JSON" });
    }
    const repeated = await runHostOperationCommand(
      ["interaction", "question", "answer", "--question-id", "question-answer"],
      { env },
    );
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout ?? "null").data.alreadyResolved, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
