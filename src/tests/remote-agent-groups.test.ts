import assert from "node:assert/strict";
import { test } from "node:test";
import { startRemoteRoomHost } from "./fixtures/remote-room-host.js";
import type { RoomChannelMessage } from "../rooms/channel-store.js";

test("cloud employees participate in group mentions, replies and isolated contexts", async () => {
  const host = await startRemoteRoomHost();
  try {
    await host.login("admin");
    const { memberId } = await host.request<{ memberId: string }>("/network/contacts", {
      address: host.fixture.address,
      name: "Cloud coder",
    });
    await host.request("/rooms", { id: "group-one", title: "Project group", memberIds: [memberId] });
    await host.request("/rooms", { id: "group-two", title: "Another group", memberIds: [memberId] });
    await host.request("/rooms/group-one/messages", {
      text: "remember:orange",
      targetIds: [memberId],
      userMessageId: "group-user",
      assistantMessageIds: ["group-reply"],
    });
    const first = await host.waitMessage("group-reply", (message) => message.status === "done");
    assert.equal(first.text, "reply:remember:orange");
    const payload = host.sendCalls()[0]!.params.message!.parts[0]!.text;
    assert.match(payload, /Project group/);
    assert.match(payload, /Cloud coder/);
    await host.request("/rooms/group-one/messages", {
      text: "recall",
      inReplyToMessageId: "group-reply",
      targetIds: [memberId],
      assistantMessageIds: ["group-followup"],
    });
    const followup = await host.waitMessage("group-followup", (message) => message.status === "done");
    assert.equal(followup.text, "orange");
    assert.equal(followup.remoteTask?.contextId, first.remoteTask?.contextId);
    assert.match(host.sendCalls().at(-1)!.params.message!.parts[0]!.text, /remember:orange/);
    await host.request("/rooms/members/pm", { disabled: true }, "PATCH");
    const posted = await host.request<{ assistantMessages: RoomChannelMessage[] }>("/rooms/group-two/messages", {
      text: "@all recall",
    });
    const broadcastId = posted.assistantMessages.find((message) => message.senderId === memberId)!.id;
    const broadcast = await host.waitMessage(broadcastId, (message) => message.status === "done");
    assert.notEqual(broadcast.remoteTask?.contextId, first.remoteTask?.contextId);
  } finally {
    await host.dispose();
  }
});

test("read-only Rooms requests neither reconnect nor replay pending remote work", async () => {
  const host = await startRemoteRoomHost();
  try {
    await host.login("admin");
    const { memberId } = await host.request<{ memberId: string }>("/network/contacts", {
      address: host.fixture.address,
    });
    await host.request("/rooms/dm", { memberId, roomId: "recovery" });
    await host.request("/rooms/recovery/messages", {
      text: "RECOVER",
      targetIds: [memberId],
      assistantMessageIds: ["uncertain"],
    });
    await host.waitMessage("uncertain", (message) => message.status === "failed");
    await host.restart();
    const before = [host.fixture.calls.length, host.fixture.exchanges.length];
    for (let i = 0; i < 3; i++) {
      await host.request("/rooms");
      await host.request("/rooms/recovery/messages");
    }
    assert.deepEqual([host.fixture.calls.length, host.fixture.exchanges.length], before);
    await host.request("/network/account", {});
    const recovered = await host.waitMessage("uncertain", (message) => message.status === "done");
    assert.equal(recovered.text, "reply:RECOVER");
  } finally {
    await host.dispose();
  }
});

test("an old account's read request cannot disconnect the current local Host owner", async () => {
  const host = await startRemoteRoomHost();
  try {
    await host.login("regular");
    const oldCookies = host.cookies;
    await host.login("admin");
    const { memberId } = await host.request<{ memberId: string }>("/network/contacts", {
      address: host.fixture.address,
    });
    await host.request("/rooms/dm", { memberId, roomId: "current" });
    await host.request("/rooms/current/messages", {
      text: "HOLD",
      targetIds: [memberId],
      assistantMessageIds: ["current-task"],
    });
    await host.waitMessage("current-task", (message) => Boolean(message.remoteTask?.taskId));
    const revoked = host.fixture.revoked.length;
    const response = await fetch(host.baseUrl + "/auth/session", { headers: { ...host.headers, cookie: oldCookies } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reason, "session_invalidated");
    await fetch(host.baseUrl + "/rooms/current/messages", { headers: { ...host.headers, cookie: oldCookies } });
    assert.equal(host.fixture.revoked.length, revoked);
    const { messages } = await host.request<{ messages: RoomChannelMessage[] }>("/rooms/current/messages");
    assert.equal(messages.find((message) => message.id === "current-task")?.status, "running");
    await host.request("/rooms/current/messages/current-task/cancel", {});
    await host.waitMessage("current-task", (message) => message.remoteTask?.pending === false);
  } finally {
    await host.dispose();
  }
});

test("an invalid optional Router configuration cannot break the product login", async () => {
  const host = await startRemoteRoomHost();
  try {
    process.env.OPENGROVE_AGENT_ROUTER_URL = "invalid-url";
    await host.login("admin");
    const session = await host.request<{ authenticated: boolean }>("/auth/session");
    assert.equal(session.authenticated, true);
    await host.request("/rooms");
    assert.equal(host.fixture.exchanges.length, 0);
  } finally {
    await host.dispose();
  }
});
