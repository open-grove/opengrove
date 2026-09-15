import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHostOperationCommand } from "../cli/host-operation-command.js";
import { startOpenGroveServer } from "../server/create-server.js";

test("CLI creates a Room through the real Host and reports the persisted room", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-collaboration-cli-"));
  const token = "collaboration-cli-test-token";
  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    profile: "test",
    statePath: join(root, "state.sqlite"),
    bridgeToken: token,
  });
  try {
    if (!server.listening) await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const result = await runHostOperationCommand(
      ["room", "room", "create", "--id", "cli-room", "--title", "CLI collaboration", "--badge", "CLI"],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(result.handled, true);
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout ?? "null");
    assert.equal(output.data.room.id, "cli-room");
    assert.equal(output.data.room.title, "CLI collaboration");
    const patch = await runHostOperationCommand(
      ["room", "room", "update", "--room-id", "cli-room", "--title", "Renamed room", "--pinned", "true"],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(patch.handled, true);
    assert.equal(patch.exitCode, 0, patch.stderr);
    const updated = JSON.parse(patch.stdout ?? "null");
    assert.equal(updated.data.room.title, "Renamed room");
    assert.equal(updated.data.room.pinned, true);
    const read = await runHostOperationCommand(
      ["room", "room", "read", "--room-id", "cli-room", "--observed-event-seq", String(updated.data.currentEventSeq)],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(read.handled, true);
    assert.equal(read.exitCode, 0, read.stderr);
    assert.equal(JSON.parse(read.stdout ?? "null").data.room.lastReadEventSeq, updated.data.currentEventSeq);
    const message = await runHostOperationCommand(
      [
        "room",
        "message",
        "create",
        "--room-id",
        "cli-room",
        "--text",
        "CLI history test",
        "--user-message-id",
        "cli-message",
      ],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(message.exitCode, 0, message.stderr);
    const history = await runHostOperationCommand(
      ["room", "message", "list", "--room-id", "cli-room", "--limit", "10", "--after-seq", "0", "--before-seq", "2"],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(history.handled, true);
    assert.equal(history.exitCode, 0, history.stderr);
    const messages = JSON.parse(history.stdout ?? "null").data.messages;
    assert.equal(messages.length, 1, JSON.stringify(messages));
    assert.equal(messages[0].id, "cli-message");
    assert.equal(messages[0].text, "CLI history test");
    const events = await runHostOperationCommand(
      ["room", "event", "list", "--after-event-seq", "0", "--event-version", "2", "--wait-ms", "0"],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(events.handled, true);
    assert.equal(events.exitCode, 0, events.stderr);
    const changes = JSON.parse(events.stdout ?? "null").data;
    assert.equal(changes.longPollSupported, true);
    assert.ok(
      changes.events.some(
        (event: { type: string; messageId?: string }) =>
          event.type === "room.message.created" && event.messageId === "cli-message",
      ),
    );
    const direct = await runHostOperationCommand(
      [
        "room",
        "direct",
        "open",
        "--member-id",
        "cli-employee",
        "--title",
        "CLI Direct",
        "--member",
        JSON.stringify({ id: "cli-employee", name: "CLI Employee", kernel: "pi" }),
      ],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(direct.handled, true);
    assert.equal(direct.exitCode, 0, direct.stderr);
    const directData = JSON.parse(direct.stdout ?? "null").data;
    assert.equal(directData.room.kind, "direct");
    assert.equal(directData.room.directMemberId, "cli-employee");
    assert.equal(directData.member.name, "CLI Employee");
    const listing = await runHostOperationCommand(["room", "room", "list", "--limit", "10"], {
      env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token },
    });
    assert.equal(listing.handled, true);
    assert.equal(listing.exitCode, 0, listing.stderr);
    const snapshot = JSON.parse(listing.stdout ?? "null").data;
    assert.ok(
      snapshot.rooms.some(
        (room: { id: string; title: string }) => room.id === "cli-room" && room.title === "Renamed room",
      ),
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
