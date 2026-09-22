import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenGroveClient } from "#client";
import { startOpenGroveServer } from "../server/create-server.js";

test("direct task submission validates runtime configuration and resource scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-direct-start-"));
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
    await assert.rejects(
      client.runs.direct.start({
        sessionId: "external-project",
        input: "Say hello",
        kernel: "pi",
        model: "test",
        providerId: "missing-provider",
        context: "Only use this project.",
      }),
      /Provider|provider|available/,
    );
    const invalid = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opengrove-token": "test" },
      body: JSON.stringify({
        sessionId: "invalid",
        input: "Hello",
        kernel: "pi",
        model: "test",
        providerId: "$login",
        workspaceRoot: join(root, "missing"),
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "workspace_directory_not_found");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
