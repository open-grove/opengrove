import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalBridgeServer } from "../server/local-bridge.js";
import type { RoomChannelMember } from "../rooms/channel-store.js";

const directory = mkdtempSync(join(tmpdir(), "opengrove-room-user-reply-"));
const bridgeToken = "room-user-reply-token";
const server = startLocalBridgeServer({
  host: "127.0.0.1",
  port: 0,
  statePath: join(directory, "state.json"),
  bridgeToken,
});

try {
  if (!server.listening) {
    await once(server, "listening");
  }
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  const member: RoomChannelMember = {
    id: "employee-reply-target",
    name: "Claude Code",
    kernel: "user",
    model: "manual",
    role: "Reply target",
    status: "idle",
    color: "#64748b",
    lastActive: "now",
    source: "human",
  };

  await postJson(`${baseUrl}/rooms/members`, member);
  await postJson(`${baseUrl}/rooms`, {
    id: "room-user-reply",
    title: "User reply",
    memberIds: [member.id],
    badge: "Local",
  });
  const root = await postJson<{
    userMessage: { id: string };
  }>(`${baseUrl}/rooms/room-user-reply/messages`, {
    text: "@Claude Code Pick a topic.",
    targetIds: [member.id],
    userMessageId: "message-reply-root",
    assistantMessageIds: ["message-reply-root-assistant"],
  });
  const parent = await postJson<{
    message: {
      id: string;
      inReplyToMessageId?: string;
      rootMessageId?: string;
    };
  }>(`${baseUrl}/rooms/room-user-reply/agent-messages`, {
    id: "message-reply-parent",
    senderId: member.id,
    senderName: member.name,
    text: "You can throw one keyword or question at me.",
    targetIds: [],
    inReplyToMessageId: root.userMessage.id,
    rootMessageId: root.userMessage.id,
  });
  const reply = await postJson<{
    userMessage: {
      id: string;
      inReplyToMessageId?: string;
      rootMessageId?: string;
    };
    assistantMessages: Array<{
      inReplyToMessageId?: string;
      rootMessageId?: string;
    }>;
  }>(`${baseUrl}/rooms/room-user-reply/messages`, {
    text: "@Claude Code Let us discuss desktop agent apps.",
    targetIds: [member.id],
    userMessageId: "message-user-reply",
    assistantMessageIds: ["message-user-reply-assistant"],
    inReplyToMessageId: parent.message.id,
  });

  assert.equal(reply.userMessage.inReplyToMessageId, parent.message.id);
  assert.equal(reply.userMessage.rootMessageId, root.userMessage.id);
  assert.equal(reply.assistantMessages[0]?.inReplyToMessageId, reply.userMessage.id);
  assert.equal(reply.assistantMessages[0]?.rootMessageId, root.userMessage.id);

  const persisted = await getJson<{
    messages: Array<{
      id: string;
      inReplyToMessageId?: string;
      rootMessageId?: string;
    }>;
  }>(`${baseUrl}/rooms/room-user-reply/messages`);
  const persistedReply = persisted.messages.find((message) => message.id === reply.userMessage.id);
  assert.equal(persistedReply?.inReplyToMessageId, parent.message.id);
  assert.equal(persistedReply?.rootMessageId, root.userMessage.id);

  await deleteJson(`${baseUrl}/rooms/room-user-reply/messages/${root.userMessage.id}`);
  const replyAfterRootDeletion = await postJson<{
    userMessage: {
      inReplyToMessageId?: string;
      rootMessageId?: string;
    };
    assistantMessages: Array<{
      rootMessageId?: string;
    }>;
  }>(`${baseUrl}/rooms/room-user-reply/messages`, {
    text: "@Claude Code Continue without the deleted thread root.",
    targetIds: [member.id],
    userMessageId: "message-reply-after-root-deletion",
    assistantMessageIds: ["message-reply-after-root-deletion-assistant"],
    inReplyToMessageId: parent.message.id,
  });
  assert.equal(replyAfterRootDeletion.userMessage.inReplyToMessageId, parent.message.id);
  assert.equal(replyAfterRootDeletion.userMessage.rootMessageId, parent.message.id);
  assert.equal(replyAfterRootDeletion.assistantMessages[0]?.rootMessageId, parent.message.id);

  const missingParentResponse = await fetch(`${baseUrl}/rooms/room-user-reply/messages`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      text: "@Claude Code This parent does not exist.",
      targetIds: [member.id],
      inReplyToMessageId: "message-missing",
    }),
  });
  assert.equal(missingParentResponse.status, 404);
  assert.deepEqual(await missingParentResponse.json(), {
    ok: false,
    error: "reply_message_not_found",
  });

  console.log("room-user-reply-harness ok");
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 50,
  });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as T;
  assert.equal(response.ok, true, `${url} failed with HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: requestHeaders() });
  const json = (await response.json()) as T;
  assert.equal(response.ok, true, `${url} failed with HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function deleteJson(url: string): Promise<void> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: requestHeaders(),
  });
  const json = await response.json();
  assert.equal(response.ok, true, `${url} failed with HTTP ${response.status}: ${JSON.stringify(json)}`);
}

function requestHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-opengrove-token": bridgeToken,
  };
}
