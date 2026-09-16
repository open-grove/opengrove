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
    const employee = await runHostOperationCommand(
      [
        "employee",
        "upsert",
        "--id",
        "cli-colleague",
        "--name",
        "CLI Colleague",
        "--kernel",
        "pi",
        "--provider-id",
        "cli-provider",
        "--model",
        "model-a",
      ],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(employee.handled, true);
    assert.equal(employee.exitCode, 0, employee.stderr);
    assert.equal(JSON.parse(employee.stdout ?? "null").data.member.name, "CLI Colleague");
    const changedEmployee = await runHostOperationCommand(
      [
        "employee",
        "update",
        "--member-id",
        "cli-colleague",
        "--input",
        JSON.stringify({
          name: "Renamed Colleague",
          reasoningEffort: null,
          providerId: null,
        }),
      ],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(changedEmployee.handled, true);
    assert.equal(changedEmployee.exitCode, 0, changedEmployee.stderr);
    assert.equal(JSON.parse(changedEmployee.stdout ?? "null").data.member.name, "Renamed Colleague");
    assert.equal(JSON.parse(changedEmployee.stdout ?? "null").data.member.providerId, undefined);
    const restore = await runHostOperationCommand(["employee", "restore-defaults", "--member-id", "cli-colleague"], {
      env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token },
    });
    assert.equal(restore.handled, true);
    assert.equal(restore.exitCode, 1);
    assert.equal(JSON.parse(restore.stderr ?? "null").status, 409);
    const added = await runHostOperationCommand(
      ["room", "member", "join", "--room-id", "cli-room", "--member-id", "cli-colleague"],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(added.handled, true);
    assert.equal(added.exitCode, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout ?? "null").data.member.name, "Renamed Colleague");
    const configuredMember = JSON.parse(changedEmployee.stdout ?? "null").data.member;
    assert.equal(configuredMember.model, "model-a");
    assert.deepEqual(JSON.parse(added.stdout ?? "null").data.member, configuredMember);
    const rejoined = await runHostOperationCommand(
      ["room", "member", "join", "--room-id", "cli-room", "--member-id", "cli-colleague"],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(rejoined.exitCode, 0, rejoined.stderr);
    assert.deepEqual(JSON.parse(rejoined.stdout ?? "null").data.member, configuredMember);
    const missing = await runHostOperationCommand(
      ["room", "member", "join", "--room-id", "cli-room", "--member-id", "missing-employee"],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(missing.exitCode, 1, missing.stderr);
    assert.equal(JSON.parse(missing.stderr ?? "null").status, 404);
    const unchanged = await runHostOperationCommand(["room", "room", "list"], {
      env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token },
    });
    assert.equal(unchanged.exitCode, 0, unchanged.stderr);
    assert.deepEqual(
      JSON.parse(unchanged.stdout ?? "null").data.members.find(
        (member: { id: string }) => member.id === "cli-colleague",
      ),
      configuredMember,
    );
    // The existing POST still replaces submitted metadata, including omitted fields.
    const legacyAdd = await runHostOperationCommand(
      ["room", "member", "add", "--room-id", "cli-room", "--id", "cli-colleague"],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(legacyAdd.exitCode, 0, legacyAdd.stderr);
    assert.equal(JSON.parse(legacyAdd.stdout ?? "null").data.member.name, "cli-colleague");
    assert.notEqual(JSON.parse(legacyAdd.stdout ?? "null").data.member.model, "model-a");
    const removed = await runHostOperationCommand(
      ["room", "member", "remove", "--room-id", "cli-room", "--member-id", "cli-colleague"],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(removed.handled, true);
    assert.equal(removed.exitCode, 0, removed.stderr);
    assert.ok(!JSON.parse(removed.stdout ?? "null").data.room.memberIds.includes("cli-colleague"));
    const recorded = await runHostOperationCommand(
      [
        "room",
        "message",
        "record",
        "--room-id",
        "cli-room",
        "--sender-id",
        "cli-colleague",
        "--id",
        "cli-agent-message",
        "--text",
        "Recorded result",
      ],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(recorded.handled, true);
    assert.equal(recorded.exitCode, 0, recorded.stderr);
    assert.equal(JSON.parse(recorded.stdout ?? "null").data.message.status, "done");
    const cancelled = await runHostOperationCommand(
      ["room", "message", "cancel", "--room-id", "cli-room", "--message-id", "cli-agent-message"],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(cancelled.handled, true);
    assert.equal(cancelled.exitCode, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout ?? "null").data.cancelled, false);
    assert.equal(JSON.parse(cancelled.stdout ?? "null").data.message.status, "done");
    const edited = await runHostOperationCommand(
      ["room", "message", "update", "--room-id", "cli-room", "--message-id", "cli-agent-message", "--text", ""],
      { env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token } },
    );
    assert.equal(edited.handled, true);
    assert.equal(edited.exitCode, 0, edited.stderr);
    assert.equal(JSON.parse(edited.stdout ?? "null").data.message.text, "");
    const deleteArgs = ["room", "message", "delete", "--room-id", "cli-room", "--message-id", "cli-agent-message"];
    const confirmation = await runHostOperationCommand(deleteArgs, {
      env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token },
    });
    assert.equal(confirmation.exitCode, 10);
    const deleted = await runHostOperationCommand([...deleteArgs, "--yes"], {
      env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token },
    });
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    assert.equal(JSON.parse(deleted.stdout ?? "null").data.messageId, "cli-agent-message");
    const deletedAgain = await runHostOperationCommand([...deleteArgs, "--yes"], {
      env: { OPENGROVE_BRIDGE_URL: baseUrl, OPENGROVE_BRIDGE_TOKEN: token },
    });
    assert.equal(deletedAgain.exitCode, 0, deletedAgain.stderr);
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
