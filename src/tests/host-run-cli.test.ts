import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHostOperationCommand } from "../cli/host-operation-command.js";
import { startOpenGroveServer } from "../server/create-server.js";

test("CLI discovers the Host and controls direct runs through the real Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-run-cli-"));
  const token = "run-cli-test-token";
  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    profile: "test",
    statePath: join(root, "state.sqlite"),
    bridgeToken: token,
  });
  try {
    if (!server.listening) await once(server, "listening");
    const env = {
      OPENGROVE_BRIDGE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
      OPENGROVE_BRIDGE_TOKEN: token,
    };
    const bootstrap = await runHostOperationCommand(["host", "bootstrap"], { env });
    assert.equal(bootstrap.handled, true);
    assert.equal(bootstrap.exitCode, 0, bootstrap.stderr);
    assert.equal(JSON.parse(bootstrap.stdout ?? "null").data.environment.preset, "test");
    const cancelled = await runHostOperationCommand(["run", "direct", "cancel", "--run-id", "missing-run"], { env });
    assert.equal(cancelled.handled, true);
    assert.equal(cancelled.exitCode, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout ?? "null").data.cancelled, false);
    const guided = await runHostOperationCommand(
      ["run", "direct", "guide", "--run-id", "missing-run", "--instruction", "Focus on the result"],
      { env },
    );
    assert.equal(guided.handled, true);
    assert.equal(guided.exitCode, 1, guided.stdout);
    assert.equal(JSON.parse(guided.stderr ?? "null").data.error, "run_not_found");
    const compact = await runHostOperationCommand(
      ["run", "direct", "compact", "--thread-id", "missing-session", "--dry-run"],
      { env },
    );
    assert.equal(compact.handled, true);
    assert.equal(compact.exitCode, 0, compact.stderr);
    assert.deepEqual(JSON.parse(compact.stdout ?? "null").request.body, { threadId: "missing-session" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
