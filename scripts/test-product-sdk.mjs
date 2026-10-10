import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenGroveApi } from "@opengrove/sdk";
import { createClient } from "@opengrove/sdk/client";
import { startOpenGroveServer } from "../dist/server/create-server.js";
import { BRIDGE_KERNEL_IDS } from "../dist/server/bridge-types.js";

const root = await mkdtemp(join(tmpdir(), "opengrove-product-sdk-"));
await writeFile(
  join(root, "bridge-settings.json"),
  JSON.stringify({
    workspaceRoot: root,
    kernelPathOverrides: Object.fromEntries(
      BRIDGE_KERNEL_IDS.map((id) => [id, { configHome: join(root, "kernels", id), binaryPath: process.execPath }]),
    ),
  }),
);
const server = startOpenGroveServer({
  host: "127.0.0.1",
  port: 0,
  profile: "test",
  statePath: join(root, "state.sqlite"),
  bridgeToken: "test",
});
try {
  if (!server.listening) await once(server, "listening");
  const client = createClient({
    baseUrl: `http://127.0.0.1:${server.address().port}/api`,
    headers: { "x-opengrove-token": "test" },
    throwOnError: true,
  });
  const sdk = new OpenGroveApi({ client });
  const inventory = await sdk.extension.extension.list();
  assert.ok(inventory.data.extensions.items.some((item) => item.kind === "tool"));
  const created = await sdk.artifact.artifact.create({
    body: { type: "sdk-result", title: "SDK artifact", data: { value: 1 } },
  });
  const artifactId = created.data.artifact.id;
  await sdk.artifact.artifact.update({ path: { artifactId }, body: { title: "Updated by SDK" } });
  assert.equal(
    (await sdk.artifact.artifact.list({ query: { id: [artifactId] } })).data.artifacts[0].title,
    "Updated by SDK",
  );
  assert.equal((await sdk.artifact.artifact.delete({ path: { artifactId } })).data.deleted, true);
  const routine = await sdk.routine.routine.create({
    body: { title: "SDK workflow", steps: [{ toolId: "removed.tool" }] },
  });
  const routineId = routine.data.routine.id;
  await sdk.routine.routine.schedule({ path: { routineId }, body: { enabled: false } });
  const run = await sdk.routine.routine.run({ path: { routineId } });
  assert.equal(run.data.summary.status, "failed");
  assert.equal(run.data.summary.error, "tool_not_registered");
  assert.equal(
    (await sdk.routine.routine.list()).data.routines.find((item) => item.id === routineId).lastRun.status,
    "failed",
  );
  assert.deepEqual((await sdk.interaction.approval.list({ query: { runId: "missing" } })).data.approvals, []);
  console.log("Generated SDK product interfaces passed against a real Host.");
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true });
}
