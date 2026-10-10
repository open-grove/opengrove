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
        BRIDGE_KERNEL_IDS.map((id) => [id, { configHome: join(root, "kernels", id), binaryPath: "/bin/echo" }]),
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
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opengrove-token": "test" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    await post("/extensions/skills/import", { sourcePath, name: "refresh-fixture" });
    await post("/extensions/skills/publish", {
      librarySkillId: "refresh-fixture",
      targetKernelIds: ["codex"],
      scope: "project",
    });
    const created = await post("/routines", {
      title: "Read the new Skill",
      steps: [{ toolId: "skill.invoke", input: { skill: "refresh-fixture" } }],
    });
    const result = await post(`/routines/${created.routine.id}/run`, {});
    assert.equal(result.summary.status, "succeeded", JSON.stringify(result));
    assert.match(JSON.stringify(result.toolResults), /Return the fresh Skill instructions/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
