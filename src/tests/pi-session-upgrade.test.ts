import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { migratePi084Sessions } from "../runtime/pi-session-upgrade.compat.js";
import { NativePiSessionRepository } from "../runtime/pi-session-repository.js";

test("0.84.4 native tool transcript migrates once, retaining identity, backup and fork history", async () => {
  const root = await mkdtemp(join(tmpdir(), "og-pi-upgrade-"));
  const cwd = "/opengrove-upgrade-fixture";
  const directory = join(root, "--opengrove-upgrade-fixture--");
  const path = join(directory, "fixture.jsonl");
  try {
    await mkdir(directory);
    await copyFile("src/tests/fixtures/pi-084/tool-session.jsonl", path);
    const original = await readFile(path, "utf8");
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const native = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: root });
    assert.deepEqual(await native.list(undefined, BACKGROUND_CONTEXT), [], "upstream 0.85 skips the old v4 header");
    await Promise.all([migratePi084Sessions(root, env), migratePi084Sessions(root, env)]);
    assert.equal(await readFile(`${path}.pre-pi085`, "utf8"), original);
    const converted = await readFile(path, "utf8");
    await migratePi084Sessions(root, env);
    assert.equal(await readFile(path, "utf8"), converted);
    const repository = new NativePiSessionRepository(root, cwd, env);
    assert.deepEqual(await repository.list(), [
      { sessionId: "pi-084-upgrade-session", nativeSessionId: "opengrove-a4b6ee3d74cc7caccf5e8ff96d9644b3" },
    ]);
    const session = await repository.openOrCreate("pi-084-upgrade-session");
    const branch = await session.branch("main", BACKGROUND_CONTEXT);
    const entries = await branch!.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
    assert.equal(entries.length, 4);
    assert.deepEqual(
      entries.map((entry) => entry.type === "message" && entry.message.role),
      ["user", "assistant", "toolResult", "assistant"],
    );
    assert.match(JSON.stringify(entries), /cedar-314/);
    assert.equal(await repository.fork("pi-084-upgrade-session", "migrated-fork"), "forked");
    assert.equal(await repository.fork("pi-084-upgrade-session", "migrated-fork"), "target_exists");
    const restarted = new NativePiSessionRepository(root, cwd, env);
    assert.deepEqual((await restarted.list()).map((item) => item.sessionId).sort(), [
      "migrated-fork",
      "pi-084-upgrade-session",
    ]);
    assert.equal(await restarted.delete("migrated-fork"), true);
    await native.close(BACKGROUND_CONTEXT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported old records fail without replacing or hiding the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "og-pi-upgrade-invalid-"));
  const directory = join(root, "session");
  try {
    await mkdir(directory);
    const content =
      (await readFile("src/tests/fixtures/pi-084/tool-session.jsonl", "utf8")) + '{"kind":"record","type":"unknown"}\n';
    const path = join(directory, "fixture.jsonl");
    await writeFile(path, content);
    await assert.rejects(
      migratePi084Sessions(root, new NodeExecutionEnv({ cwd: process.cwd() })),
      /pi_session_upgrade_unsupported_record/,
    );
    assert.equal(await readFile(path, "utf8"), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
