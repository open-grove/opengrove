import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { createOpenGroveClient, OpenGroveProtocolError } from "#client";
import type { HostOperation } from "#protocol";
import { hostContractById } from "#protocol/compiled";
import { dispatchBridgeRoutes, type BridgeRouteContext } from "../server/router.js";
import { operationRoute } from "../server/routes/registry-utils.js";

const message = {
  id: "message-1",
  roomId: "room-1",
  channelSeq: 1,
  senderId: "employee-1",
  senderName: "Writer",
  senderType: "agent",
  text: "private contents",
  targetIds: [],
  status: "done",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
  attachments: [{ customMetadata: "retained" }],
};
const envelope = { ok: true, rooms: [], members: [], deletedMemberIds: [], currentEventSeq: 42 };
const listOperations = ["room.room.list", "room.message.list"] as const;

for (const operationId of listOperations) {
  test(`${operationId} isolates damaged messages at both HTTP boundaries`, async (t) => {
    const warnings = t.mock.method(console, "warn", () => {});
    const last = { ...message, id: "message-2", channelSeq: 2 };
    const payload = {
      ...envelope,
      messages: [null, { ...message, id: undefined, text: undefined }, message, { ...message, parts: [null] }, last],
    };
    const original = structuredClone(payload);
    const client = createOpenGroveClient({
      fetch: async () => new Response(JSON.stringify(payload), { status: 200 }),
    });
    const clientResult =
      operationId === "room.room.list"
        ? await client.rooms.collection.list({})
        : await client.rooms.messages.list({ roomId: "room-1" });
    const hostResult = await hostListResponse(operationId, payload);
    assert.equal(hostResult.status, 200);
    for (const result of [clientResult, hostResult.data]) {
      assert.deepEqual(result.messages, [message, last]);
      assert.equal(result.currentEventSeq, 42, "skipping display records must not rewind the event cursor");
    }
    assert.deepEqual(payload, original, "recovery must never delete or change source records");
    assert.equal(warnings.mock.callCount(), 2);
    for (const { arguments: args } of warnings.mock.calls) {
      assert.equal(args[0], "room_message_list_items_skipped");
      assert.equal(args[1].skippedCount, 3, "multiple invalid fields in one message count once");
      assert.equal(args[1].operationId, operationId);
      assert.equal(JSON.stringify(args).includes("private contents"), false);
    }
  });

  test(`${operationId} keeps envelopes strict, including when items are damaged`, async (t) => {
    const warnings = t.mock.method(console, "warn", () => {});
    for (const payload of [
      { ...envelope, messages: null },
      { ...envelope, messages: {} },
      { ...envelope, messages: [null], currentEventSeq: "wrong" },
      { ...envelope, messages: [null], ok: false },
      ...(operationId === "room.room.list" ? [{ ...envelope, rooms: [null], messages: [null] }] : []),
    ]) {
      const client = createOpenGroveClient({ fetch: async () => new Response(JSON.stringify(payload)) });
      await assert.rejects(
        operationId === "room.room.list"
          ? client.rooms.collection.list({})
          : client.rooms.messages.list({ roomId: "room-1" }),
        OpenGroveProtocolError,
      );
      assert.equal((await hostListResponse(operationId, payload)).status, 500);
    }
    assert.equal(warnings.mock.callCount(), 0, "failed responses must not claim successful recovery");
  });

  test(`${operationId} reports an entirely damaged page and accepts an empty page`, async (t) => {
    const warnings = t.mock.method(console, "warn", () => {});
    for (const messages of [[], [null, { id: "broken" }]]) {
      const payload = { ...envelope, messages };
      const client = createOpenGroveClient({ fetch: async () => new Response(JSON.stringify(payload)) });
      const result =
        operationId === "room.room.list"
          ? await client.rooms.collection.list({})
          : await client.rooms.messages.list({ roomId: "room-1" });
      assert.deepEqual(result.messages, []);
      assert.equal(result.currentEventSeq, 42);
      const host = await hostListResponse(operationId, payload);
      assert.equal(host.status, 200);
      assert.deepEqual(host.data.messages, []);
    }
    assert.equal(warnings.mock.callCount(), 2, "only damaged pages produce warnings");
  });
}

test("message writes still reject damaged success payloads", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const client = createOpenGroveClient({
    fetch: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          cancelled: true,
          message: { ...message, text: undefined },
          currentEventSeq: 42,
        }),
      ),
  });
  await assert.rejects(
    client.rooms.messages.cancel({ roomId: "room-1", messageId: "message-1" }),
    (error) =>
      error instanceof OpenGroveProtocolError && error.issues.length === 1 && error.issues[0]?.path === "message.text",
  );
  assert.equal(warnings.mock.callCount(), 0);
});

async function hostListResponse(operationId: (typeof listOperations)[number], payload: unknown) {
  let sent: { status: number; data: { messages?: unknown[]; currentEventSeq?: number } } | undefined;
  const context: BridgeRouteContext = {
    request: { method: "GET" } as IncomingMessage,
    response: {} as ServerResponse,
    url: new URL(
      operationId === "room.room.list" ? "http://localhost/rooms" : "http://localhost/rooms/room-1/messages",
    ),
    traceId: "trace-message-list",
    state: {} as BridgeRouteContext["state"],
    security: {} as BridgeRouteContext["security"],
    readJsonBody: async () => undefined,
    sendJson: (_response, status, data) => {
      sent = { status, data: data as NonNullable<typeof sent>["data"] };
    },
    reportContractViolation: () => {},
  };
  await dispatchBridgeRoutes(
    [
      operationRoute<HostOperation>(hostContractById[operationId], (routeContext) => {
        routeContext.sendJson(routeContext.response, 200, payload);
        return true;
      }),
    ],
    context,
  );
  assert.ok(sent);
  return sent;
}
