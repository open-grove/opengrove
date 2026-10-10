import { createOpenGroveClient } from "#client";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startOpenGroveServer } from "../server/create-server.js";
import { BRIDGE_KERNEL_IDS } from "../server/bridge-types.js";

test("a newly published Skill is available to the next workflow without restarting the Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-extension-refresh-"));
  const workspaceRoot = join(root, "workspace");
  const sourcePath = join(root, "source-skill");
  await mkdir(workspaceRoot);
  await mkdir(sourcePath);
  await writeFile(
    join(sourcePath, "SKILL.md"),
    "---\nname: refresh-fixture\ndescription: Test refresh.\n---\nReturn the fresh Skill instructions.\n",
  );
  await writeFile(
    join(root, "bridge-settings.json"),
    JSON.stringify({
      workspaceRoot,
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
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const client = createOpenGroveClient({ baseUrl, headers: { "x-opengrove-token": "test" } });
    await client.extensions.skills.import({ sourcePath, name: "refresh-fixture" });
    const published = await client.extensions.skills.publish({
      librarySkillId: "refresh-fixture",
      targetKernelIds: ["codex"],
      scope: "project",
    });
    const created = await client.routines.collection.create({
      title: "Read the new Skill",
      steps: [{ toolId: "skill.invoke", input: { skill: "refresh-fixture" } }],
    });
    const result = await client.routines.collection.run({ routineId: created.routine.id });
    assert.equal(result.summary.status, "succeeded", JSON.stringify(result));
    assert.match(JSON.stringify(result.toolResults), /Return the fresh Skill instructions/);
    const deploymentIds = published.result.records.map((record) => record.id);
    await client.extensions.deployments.disable({ deploymentIds });
    const disabled = await client.routines.collection.run({ routineId: created.routine.id });
    assert.equal(disabled.summary.status, "failed");
    assert.match(disabled.summary.error ?? "", /unknown_skill/);
    await client.extensions.deployments.enable({ deploymentIds });
    assert.equal((await client.routines.collection.run({ routineId: created.routine.id })).summary.status, "succeeded");
    await writeFile(
      join(sourcePath, "SKILL.md"),
      "---\nname: refresh-fixture\ndescription: Test refresh.\n---\nUpdated Skill instructions.\n",
    );
    await client.extensions.skills.import({ sourcePath, name: "refresh-fixture", replace: true });
    await client.extensions.skills.republish({ deploymentIds });
    assert.match(
      JSON.stringify((await client.routines.collection.run({ routineId: created.routine.id })).toolResults),
      /Updated Skill instructions/,
    );
    await client.extensions.skills.unpublish({ deploymentIds });
    assert.equal((await client.routines.collection.run({ routineId: created.routine.id })).summary.status, "failed");
    await client.extensions.deployments.delete({ itemId: "skill:refresh-fixture", deleteLibrary: true });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
