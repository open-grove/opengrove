import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenGroveClient } from "#client";
import { runHostOperationCommand, HOST_OPERATION_CLI_EXIT } from "../cli/host-operation-command.js";
import { createSqliteStateStore } from "../storage/sqlite-state-store.js";
import type { PersistableAgentStatePorts } from "../storage/json-state-store.js";
import { startOpenGroveServer } from "../server/create-server.js";
import { BRIDGE_KERNEL_IDS } from "../server/bridge-types.js";

test("Client and CLI manage product resources and scope pending interactions to a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-product-interfaces-"));
  await writeFile(
    join(root, "bridge-settings.json"),
    JSON.stringify({
      workspaceRoot: root,
      kernelPathOverrides: Object.fromEntries(
        BRIDGE_KERNEL_IDS.map((id) => [id, { configHome: join(root, "kernels", id), binaryPath: process.execPath }]),
      ),
    }),
  );
  const statePath = join(root, "state.sqlite");
  const store = createSqliteStateStore(statePath);
  let app: PersistableAgentStatePorts | undefined;
  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    profile: "test",
    statePath,
    bridgeToken: "test",
    store: {
      ...store,
      loadInto(value, options) {
        app = value;
        return store.loadInto(value, options);
      },
    },
  });
  try {
    if (!server.listening) await once(server, "listening");
    assert.ok(app);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const headers = { "x-opengrove-token": "test" };
    const client = createOpenGroveClient({ baseUrl, headers });
    const cli = (args: string[]) => runHostOperationCommand([...args, "--base-url", baseUrl, "--token", "test"]);
    const at = new Date().toISOString();
    app.approvals.restore(
      ["one", "two"].map((id) => ({
        id,
        kind: "tool",
        title: id,
        reason: "test",
        status: "pending",
        createdAt: at,
        updatedAt: at,
        resume: { type: "tool", runId: id },
      })),
    );
    app.questions.restore(
      ["one", "two"].map((id) => ({
        id,
        title: id,
        prompt: "Choose",
        status: "pending",
        createdAt: at,
        updatedAt: at,
        resume: { type: "kernel.native", kernelId: "codex", runId: id, continuation: "same-loop" },
      })),
    );
    assert.deepEqual(
      (await client.interactions.approvals.list({ runId: "one", status: "pending" })).approvals.map((item) => item.id),
      ["one"],
    );
    assert.deepEqual(
      (await client.interactions.questions.list({ runId: "two", status: "pending" })).questions.map((item) => item.id),
      ["two"],
    );
    assert.deepEqual((await client.interactions.questions.list({ runId: "missing" })).questions, []);

    assert.ok((await client.extensions.collection.list()).extensions.items.some((item) => item.kind === "tool"));
    assert.equal((await fetch(`${baseUrl}/extensions?includeSystem=1`, { headers })).status, 200);
    const invalidKernel = await fetch(`${baseUrl}/extensions/skills/publish`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ targetKernelIds: ["unknown"] }),
    });
    assert.equal(invalidKernel.status, 400);
    await assert.rejects(
      client.extensions.skills.import({ sourcePath: join(root, "missing") }),
      (error) => error instanceof Error && "status" in error && error.status === 400,
    );
    const dryRun = await cli(["extension", "skill", "publish", "--target-kernel-ids", "codex", "--dry-run"]);
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    assert.equal(
      (await cli(["extension", "skill", "publish", "--target-kernel-ids", "codex"])).exitCode,
      HOST_OPERATION_CLI_EXIT.confirmationRequired,
    );

    const artifact = await client.artifacts.collection.create({
      type: "edit-result",
      title: "Original",
      tags: ["fixture"],
      data: { value: 7 },
    });
    const artifactId = artifact.artifact.id;
    await client.artifacts.collection.update({ artifactId, title: "Updated", data: { value: 8 } });
    assert.equal((await client.artifacts.collection.get({ artifactId })).artifact.data?.value, 8);
    const listed = await client.artifacts.collection.list({ type: "edit-result", id: [artifactId], tag: ["fixture"] });
    assert.deepEqual(
      listed.artifacts.map((item) => item.title),
      ["Updated"],
    );
    assert.equal((await client.artifacts.collection.list({ tag: ["unmatched"] })).artifacts.length, 0);
    assert.equal((await fetch(`${baseUrl}/artifacts?limit=garbage`, { headers })).status, 200);
    await assert.rejects(
      client.artifacts.collection.update({ artifactId: "missing", title: "No record" }),
      /artifact_not_found/,
    );
    assert.equal(
      (await cli(["artifact", "delete", "--artifact-id", artifactId])).exitCode,
      HOST_OPERATION_CLI_EXIT.confirmationRequired,
    );
    const deleted = await cli(["artifact", "delete", "--artifact-id", artifactId, "--yes"]);
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    await assert.rejects(client.artifacts.collection.get({ artifactId }), /artifact_not_found/);

    const created = await client.routines.collection.create({
      title: "External workflow",
      steps: [{ toolId: "unavailable.example" }],
    });
    const routineId = created.routine.id;
    assert.equal(created.routine.steps[0]?.id, "step_1");
    await client.routines.collection.schedule({ routineId, trigger: "schedule", schedule: { everyMinutes: "60" } });
    assert.equal((await client.routines.collection.schedule({ routineId, enabled: false })).routine.trigger, "manual");
    const outcome = await client.routines.collection.run({ routineId });
    assert.equal(outcome.summary.status, "failed");
    assert.equal(outcome.summary.error, "tool_not_registered");
    assert.equal(
      (await client.routines.collection.list()).routines.find((item) => item.id === routineId)?.lastRun?.status,
      "failed",
    );
    const cliList = await cli(["routine", "list"]);
    assert.equal(cliList.exitCode, 0, cliList.stderr);
    assert.match(cliList.stdout ?? "", /External workflow/);
    await assert.rejects(client.routines.collection.run({ routineId: "missing" }), /routine_not_found/);
    const imported = await client.routines.collection.import({
      content:
        "---\n" +
        JSON.stringify({
          title: "Imported workflow",
          trigger: "manual",
          steps: [{ id: "read", title: "Read ledger", toolId: "room.ledger.read", input: { roomId: "example" } }],
        }) +
        "\n---\nWorkflow instructions.",
    });
    assert.equal(imported.routine.title, "Imported workflow");
    assert.equal(imported.routine.steps[0]?.toolId, "room.ledger.read");
    await assert.rejects(client.routines.collection.import({ content: "invalid" }), /routine/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
