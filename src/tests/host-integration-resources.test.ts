import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenGroveClient } from "#client";
import { createSqliteStateStore } from "../storage/sqlite-state-store.js";
import type { PersistableAgentStatePorts } from "../storage/json-state-store.js";
import { startOpenGroveServer } from "../server/create-server.js";

test("external clients discover extensions, manage workflows and access only bound workspace files", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-integration-resources-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "outside.txt"), "Outside");
  await symlink(join(root, "outside.txt"), join(workspace, "link.txt"));
  await writeFile(join(root, "bridge-settings.json"), JSON.stringify({ workspaceRoot: workspace }));
  const skillRoot = join(root, "source-skill");
  await mkdir(skillRoot);
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: integration-fixture\ndescription: Use for the integration fixture.\n---\nReturn a concise result.\n",
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
    app.sessions.restore({
      sessions: [
        {
          id: "external",
          activity: "api",
          status: "idle",
          runIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: { integrationSession: { workspaceRoot: workspace } },
        },
      ],
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const client = createOpenGroveClient({ baseUrl, headers: { "x-opengrove-token": "test" } });
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
    const scopedApprovals = await fetch(`${baseUrl}/approvals?runId=one&status=pending`, {
      headers: { "x-opengrove-token": "test" },
    });
    assert.deepEqual(
      (await scopedApprovals.json()).approvals.map((approval: { id: string }) => approval.id),
      ["one"],
    );
    const scopedQuestions = await fetch(`${baseUrl}/questions?runId=two&status=pending`, {
      headers: { "x-opengrove-token": "test" },
    });
    assert.deepEqual(
      (await scopedQuestions.json()).questions.map((question: { id: string }) => question.id),
      ["two"],
    );
    const runtimes = await client.host.runtime.list();
    assert.ok(runtimes.kernels.some((kernel) => kernel.id === "codex"));
    const extensions = await client.extension.extension.list();
    assert.ok(extensions.extensions.items.some((item) => item.kind === "tool"));
    const imported = await client.extension.skill.import({ sourcePath: skillRoot, name: "integration-fixture" });
    assert.equal(imported.result.ok, true);
    const published = await client.extension.skill.publish({
      librarySkillId: "integration-fixture",
      targetKernelIds: ["codex"],
      scope: "project",
    });
    assert.equal(published.result.ok, true);
    const deployment = published.result.records[0];
    assert.ok(deployment);
    assert.ok(deployment.targetPath);
    assert.ok(deployment.targetPath.startsWith(workspace));
    assert.match(await readFile(join(deployment.targetPath, "SKILL.md"), "utf8"), /Return a concise result/);
    const skillWorkflow = await client.routine.routine.create({
      title: "Use published Skill",
      steps: [{ toolId: "skill.invoke", input: { skill: "integration-fixture" } }],
    });
    const skillResult = await client.routine.routine.run({ routineId: skillWorkflow.routine.id });
    assert.equal(skillResult.summary.status, "succeeded");
    assert.match(JSON.stringify(skillResult.toolResults), /Return a concise result/);
    const unpublished = await client.extension.skill.unpublish({ deploymentIds: [deployment.id] });
    assert.equal(unpublished.result.ok, true);
    const written = await client.workspace.file.write({ sessionId: "external", path: "result.txt", content: "First" });
    assert.equal(written.file.content, "First");
    const read = await client.workspace.file.read({ sessionId: "external", path: "result.txt" });
    assert.equal(read.file.revision, written.file.revision);
    await client.workspace.file.write({
      sessionId: "external",
      path: "result.txt",
      content: "Second",
      expectedRevision: read.file.revision,
    });
    await assert.rejects(
      client.workspace.file.write({
        sessionId: "external",
        path: "result.txt",
        content: "Stale",
        expectedRevision: read.file.revision,
      }),
      /conflict/,
    );
    await assert.rejects(client.workspace.file.read({ sessionId: "external", path: "../outside.txt" }), /outside_root/);
    await assert.rejects(
      client.workspace.file.write({ sessionId: "external", path: "link.txt", content: "Bad" }),
      /outside_root/,
    );
    assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "Outside");
    const files = await client.workspace.file.list({ sessionId: "external" });
    assert.ok(files.entries.some((entry) => entry.path === "result.txt"));
    await assert.rejects(client.workspace.file.list({ sessionId: "unbound" }), /session_workspace_not_found/);
    const artifact = await client.artifacts.collection.create({
      type: "edit-result",
      title: "Original",
      data: { value: 7 },
    });
    await client.artifacts.collection.update({ artifactId: artifact.artifact.id, title: "Updated" });
    const artifacts = await client.artifacts.collection.list({ type: "edit-result" });
    assert.equal(artifacts.artifacts[0]?.title, "Updated");
    assert.equal((await client.artifacts.collection.delete({ artifactId: artifact.artifact.id })).deleted, true);
    const created = await client.routine.routine.create({
      title: "External workflow",
      steps: [{ toolId: "unavailable.example" }],
    });
    assert.equal(created.routine.steps[0]?.id, "step_1");
    const listed = await client.routine.routine.list();
    assert.ok(listed.routines.some((routine) => routine.id === created.routine.id));
    await client.routine.routine.schedule({
      routineId: created.routine.id,
      trigger: "schedule",
      schedule: { at: "23:59" },
    });
    const disabled = await client.routine.routine.schedule({ routineId: created.routine.id, enabled: false });
    assert.equal(disabled.routine.trigger, "manual");
    const outcome = await client.routine.routine.run({ routineId: created.routine.id });
    assert.equal(outcome.summary.status, "failed");
    await assert.rejects(client.routine.routine.run({ routineId: "missing" }), /routine_not_found/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
