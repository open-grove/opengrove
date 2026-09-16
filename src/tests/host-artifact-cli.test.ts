import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHostOperationCommand } from "../cli/host-operation-command.js";
import { startOpenGroveServer } from "../server/create-server.js";

test("CLI creates and reads an artifact without losing structured data or media metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-artifact-cli-"));
  const token = "artifact-cli-test-token";
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
    const created = await runHostOperationCommand(
      [
        "artifact",
        "create",
        "--id",
        "artifact-cli",
        "--title",
        "CLI result",
        "--data",
        '{"text":"A saved result","nested":{"values":[1,null,true]}}',
        "--assets",
        '[{"kind":"audio","uri":"https://example.test/recording.wav"}]',
        "--preview",
        '{"mimeType":"audio/wav","title":"Recording"}',
      ],
      { env },
    );
    assert.equal(created.handled, true);
    assert.equal(created.exitCode, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout ?? "null").data.artifact.id, "artifact-cli");
    const read = await runHostOperationCommand(["artifact", "get", "--artifact-id", "artifact-cli"], { env });
    assert.equal(read.handled, true);
    assert.equal(read.exitCode, 0, read.stderr);
    const artifact = JSON.parse(read.stdout ?? "null").data.artifact;
    assert.equal(artifact.type, "note");
    assert.deepEqual(artifact.data, { text: "A saved result", nested: { values: [1, null, true] } });
    assert.equal(artifact.assets[0].kind, "audio");
    assert.equal(artifact.preview.mimeType, "audio/wav");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
