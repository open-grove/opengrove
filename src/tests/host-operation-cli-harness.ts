import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { packageRoot } from "../package-root.js";
import { startOpenGroveServer } from "../server/create-server.js";

const executeFile = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "opengrove-host-cli-"));
const token = "host-cli-harness-token";
const server = startOpenGroveServer({
  host: "127.0.0.1",
  port: 0,
  profile: "test",
  statePath: join(root, "state.sqlite"),
  bridgeToken: token,
});

try {
  if (!server.listening) await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  const headers = {
    "content-type": "application/json",
    "x-opengrove-token": token,
  };
  await postJson(`${baseUrl}/rooms/members`, headers, {
    id: "host-cli-human",
    name: "Host CLI Human",
    kernel: "user",
    model: "manual",
    role: "human collaborator",
    status: "idle",
    color: "#64748b",
    lastActive: "now",
    source: "human",
  });
  await postJson(`${baseUrl}/rooms`, headers, {
    id: "host-cli-room",
    title: "Host CLI E2E",
    memberIds: ["host-cli-human"],
    badge: "CLI",
  });

  const { stdout, stderr } = await executeFile(
    process.execPath,
    [
      join(packageRoot(), "dist", "cli.js"),
      "room",
      "message",
      "create",
      "--room-id",
      "host-cli-room",
      "--text",
      "Sent through the generated Host CLI",
      "--target-ids",
      "host-cli-human",
    ],
    {
      cwd: packageRoot(),
      env: {
        ...process.env,
        OPENGROVE_BRIDGE_URL: baseUrl,
        OPENGROVE_BRIDGE_TOKEN: token,
      },
    },
  );
  assert.equal(stderr, "");
  const output = JSON.parse(stdout) as {
    ok?: boolean;
    operation?: string;
    data?: { userMessage?: { roomId?: string; text?: string; targetIds?: string[] } };
  };
  assert.equal(output.ok, true);
  assert.equal(output.operation, "room.message.create");
  assert.equal(output.data?.userMessage?.roomId, "host-cli-room");
  assert.equal(output.data?.userMessage?.text, "Sent through the generated Host CLI");
  assert.deepEqual(output.data?.userMessage?.targetIds, ["host-cli-human"]);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

console.log("Host operation CLI harness passed.");

async function postJson(url: string, headers: HeadersInit, body: unknown): Promise<void> {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.text();
  assert.equal(response.status, 200, payload);
}
