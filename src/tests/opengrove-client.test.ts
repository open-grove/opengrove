import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenGroveClient, OpenGroveClientError, OpenGroveProtocolError } from "#client";
import { defineHostOperation } from "#protocol";
import { z } from "zod";

const messageResponse = {
  ok: true as const,
  room: {
    id: "room / one",
    kind: "group" as const,
    title: "Architecture",
    badge: "AR",
    memberIds: ["agent-1"],
    adminMemberIds: ["agent-1"],
    updatedAt: "2026-09-01T00:00:00.000Z",
    unread: 0,
  },
  userMessage: {
    id: "message-1",
    roomId: "room / one",
    channelSeq: 1,
    senderId: "user",
    senderName: "You",
    senderType: "user" as const,
    text: "hello",
    targetIds: ["agent-1"],
    status: "done" as const,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  assistantMessages: [],
  currentEventSeq: 1,
};

test("OpenGrove Client calls the shared room-message operation", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createOpenGroveClient({
    baseUrl: "https://host.example.test/api/",
    credentials: "include",
    headers: () => ({ "x-opengrove-bridge-token": "bridge-token" }),
    fetch: (async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify(messageResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const result = await client.rooms.messages.create({
    roomId: "room / one",
    text: "hello",
    targetIds: ["agent-1"],
    attachments: [],
  });

  assert.equal(result.userMessage.id, "message-1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://host.example.test/api/rooms/room%20%2F%20one/messages");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[0]?.init?.credentials, "include");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-opengrove-bridge-token"), "bridge-token");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    text: "hello",
    targetIds: ["agent-1"],
    attachments: [],
  });
});

test("OpenGrove Client requests retain Protocol defaults", async () => {
  let requestBody: unknown;
  const client = createOpenGroveClient({
    baseUrl: "https://host.example.test/api",
    fetch: (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify(messageResponse), { status: 200 });
    }) as typeof fetch,
  });

  await client.rooms.messages.create({ roomId: "room-1" });

  assert.deepEqual(requestBody, { text: "", targetIds: [], attachments: [] });
});

test("OpenGrove Client rejects invalid input before sending a request", async () => {
  let requestCount = 0;
  const client = createOpenGroveClient({
    fetch: (async () => {
      requestCount += 1;
      return new Response();
    }) as typeof fetch,
  });

  await assert.rejects(
    client.rooms.messages.create({
      roomId: "",
      text: "hello",
      targetIds: [],
      attachments: [],
    }),
    (error) =>
      error instanceof OpenGroveProtocolError &&
      error.operationId === "room.message.create" &&
      error.issues.some((issue) => issue.path === "params.roomId"),
  );
  assert.equal(requestCount, 0);
});

test("OpenGrove Client preserves Host error messages and metadata", async () => {
  const client = createOpenGroveClient({
    fetch: (async () =>
      new Response(JSON.stringify({ error: "reply_message_not_found", code: "not_found", traceId: "trace-1" }), {
        status: 404,
      })) as typeof fetch,
  });

  await assert.rejects(
    client.rooms.messages.create({
      roomId: "room-1",
      text: "hello",
      targetIds: [],
      attachments: [],
    }),
    (error) =>
      error instanceof OpenGroveClientError &&
      error.message === "reply_message_not_found" &&
      error.status === 404 &&
      error.declared &&
      error.code === "not_found" &&
      error.traceId === "trace-1",
  );
});

test("OpenGrove Client preserves legacy 200 business failures", async () => {
  const client = createOpenGroveClient({
    fetch: (async () =>
      new Response(JSON.stringify({ ok: false, error: "room_message_rejected" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });

  await assert.rejects(
    client.rooms.messages.create({
      roomId: "room-1",
      text: "hello",
      targetIds: [],
      attachments: [],
    }),
    (error) =>
      error instanceof OpenGroveClientError &&
      error.message === "room_message_rejected" &&
      error.status === 200 &&
      !error.declared,
  );
});

test("OpenGrove Client rejects undeclared success status codes", async () => {
  const client = createOpenGroveClient({
    fetch: (async () => new Response(JSON.stringify(messageResponse), { status: 201 })) as typeof fetch,
  });

  await assert.rejects(
    client.rooms.messages.create({
      roomId: "room-1",
      text: "hello",
      targetIds: [],
      attachments: [],
    }),
    (error) => error instanceof OpenGroveClientError && error.status === 201 && !error.declared,
  );
});

test("low-level operations support query parameters without requiring a request body", async () => {
  const urls: string[] = [];
  const listRoomsOperation = defineHostOperation({
    id: "room.collection.list-test",
    summary: "List Rooms",
    description: "List Rooms for a Client transport test.",
    method: "GET",
    path: "/rooms",
    risk: "read",
    query: z.object({ limit: z.number().int().positive().optional() }),
    success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  });
  const client = createOpenGroveClient({
    baseUrl: "/api/",
    fetch: (async (input, init) => {
      urls.push(String(input));
      assert.equal(init?.body, undefined);
      assert.equal(new Headers(init?.headers).has("content-type"), false);
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch,
  });

  const result = await client.request(listRoomsOperation, { query: { limit: 20 } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(urls, ["/api/rooms?limit=20"]);
});
