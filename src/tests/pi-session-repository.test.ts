import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as background, value } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { NativePiSessionRepository } from "../runtime/pi-session-repository.js";

test("old Pi sessions are left untouched and cannot block fresh sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "og-pi-old-session-"));
  const cwd = "/opengrove-upgrade-fixture";
  try {
    const directory = join(root, "--opengrove-upgrade-fixture--");
    await mkdir(directory);
    const original = await readFile("src/tests/fixtures/pi-084/tool-session.jsonl", "utf8");
    const path = join(directory, "old.jsonl");
    await writeFile(path, original);
    await writeFile(join(directory, "broken.jsonl"), original + '{"kind":"entry","message":"torn');
    const repository = new NativePiSessionRepository(root, cwd);
    const session = await repository.openOrCreate("pi-084-upgrade-session");
    assert.equal(await session.branch("main", background), undefined, "unreadable old history starts fresh");
    assert.equal(await readFile(path, "utf8"), original, "no migration or source rewrite");
    await session.setValue(value("test-marker"), "new history", background);
    await session.close(background);
    const restarted = new NativePiSessionRepository(root, cwd);
    const reopened = await restarted.openOrCreate("pi-084-upgrade-session");
    assert.equal((await reopened.getValue(value("test-marker"), background))?.value, "new history");
    assert.equal(await restarted.delete("pi-084-upgrade-session"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listing Pi sessions reads native headers only and retains no transcript handles", async () => {
  const root = await mkdtemp(join(tmpdir(), "og-pi-session-list-"));
  const cwd = process.cwd();
  try {
    const seed = new NativePiSessionRepository(root, cwd);
    const session = await seed.openOrCreate("room/employee:中文");
    await session.setValue(value("large-transcript"), "x".repeat(256_000), background);
    await session.close(background);
    const env = new NodeExecutionEnv({ cwd });
    env.readTextFile = async () => {
      throw new Error("listing must not open a transcript");
    };
    const repository = new NativePiSessionRepository(root, cwd, env);
    assert.deepEqual(await repository.list(), [
      {
        sessionId: "room/employee:中文",
        nativeSessionId: "opengrove-session:room/employee:中文",
      },
    ]);
    assert.equal(await repository.delete("room/employee:中文"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
