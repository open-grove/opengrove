import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { startRemoteRoomHost } from "./fixtures/remote-room-host.js";
import type { RoomChannelMember, RoomChannelMessage } from "../rooms/channel-store.js";

async function connectedHost(t: TestContext) {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
  await host.login("admin");
  const { memberId } = await host.request<{ memberId: string }>("/network/contacts", { address: host.fixture.address });
  await host.request("/rooms/dm", { memberId, roomId: "conversation" });
  const send = (id: string, text: string, extra = {}, roomId = "conversation") =>
    host.request(`/rooms/${roomId}/messages`, {
      text,
      targetIds: [memberId],
      userMessageId: `user-${id}`,
      assistantMessageIds: [id],
      ...extra,
    });
  return { host, memberId, send };
}

test("network configuration is read-only and account connection requires a verified admin", async (t) => {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
  assert.deepEqual(await host.request("/network/account"), { ok: true, configured: true });
  assert.equal(host.fixture.exchanges.length, 0);
  const unauthenticated = await fetch(host.baseUrl + "/network/account", {
    method: "POST",
    headers: host.headers,
    body: "{}",
  });
  assert.equal(unauthenticated.status, 401);
  await host.login("regular");
  const restricted = await fetch(host.baseUrl + "/network/account", {
    method: "POST",
    headers: { ...host.headers, cookie: host.cookies },
    body: "{}",
  });
  assert.equal(restricted.status, 403);
  await host.login("admin");
  host.fixture.config.rejectExternalOnce = true;
  const result = await host.request<{ account: { owner: string } }>("/network/account", {});
  assert.match(result.account.owner, /^@admin:/);
  assert.equal(host.fixture.exchanges.length, 2);
  assert.notEqual(host.fixture.exchanges[0]?.accessToken, host.fixture.exchanges[1]?.accessToken);
});

test("direct turns retain context, deduplicate retries, start fresh contexts and continue input requests", async (t) => {
  const { host, memberId, send } = await connectedHost(t);
  await send("first", "remember:pineapple");
  const first = await host.waitMessage("first", (m) => m.status === "done");
  assert.equal(host.sendCalls()[0]!.params.message?.contextId, undefined);
  await send("second", "recall");
  const second = await host.waitMessage("second", (m) => m.status === "done");
  assert.equal(second.text, "pineapple");
  assert.equal(second.remoteTask?.contextId, first.remoteTask?.contextId);
  await send("second", "recall");
  assert.equal(host.sendCalls().length, 2);
  await host.request("/rooms/dm", { memberId, roomId: "new" });
  await send("fresh", "recall", {}, "new");
  const fresh = await host.waitMessage("fresh", (m) => m.status === "done");
  assert.equal(fresh.text, "unknown");
  assert.notEqual(fresh.remoteTask?.contextId, first.remoteTask?.contextId);
  await send("input", "INPUT");
  const input = await host.waitMessage("input", (m) => m.status === "done");
  assert.equal(input.text, "Please confirm the target.");
  await send("answer", "--help");
  const answer = await host.waitMessage("answer", (m) => m.status === "done");
  assert.equal(answer.text, "reply:--help");
  assert.equal(host.sendCalls().at(-1)?.params.message?.taskId, input.remoteTask?.taskId);
  const before = host.sendCalls().length;
  await send("file", "inspect", { selectedFile: { path: "/private/local-only.txt" } });
  await host.waitMessage("file", (m) => m.status === "failed");
  assert.equal(host.sendCalls().length, before);
});

test("streamed progress stays in execution status and Stop reports confirmed cancellation", async (t) => {
  const { host, send } = await connectedHost(t);
  await send("progress", "PROGRESS");
  const progress = await host.waitMessage("progress", (m) => Boolean(m.remoteTask?.taskId));
  assert.equal(progress.text, "");
  assert.equal(progress.remoteTask?.statusText, "Connecting to the remote worker…");
  await host.waitMessage("progress", () =>
    host.fixture.calls.some((call) => call.method === "SubscribeToTask" && call.params.id === "task-progress"),
  );
  host.fixture.tasks.progress!.status = {
    state: "TASK_STATE_COMPLETED",
    message: { parts: [{ text: "Delivery complete." }] },
  };
  host.fixture.tasks.progress!.artifacts = [{ parts: [{ text: "This is the actual response." }] }];
  const done = await host.waitMessage("progress", (m) => m.status === "done");
  assert.equal(done.text, "This is the actual response.");
  assert.equal(done.remoteTask?.statusText, "Delivery complete.");
  await send("hold", "HOLD");
  await host.waitMessage("hold", (m) => Boolean(m.remoteTask?.taskId));
  await host.request("/rooms/conversation/messages/hold/cancel", {});
  const stopped = await host.waitMessage("hold", (m) => m.remoteTask?.statusText === "Canceled.");
  assert.equal(stopped.status, "interrupted");
  assert.equal(stopped.remoteTask?.pending, false);
  assert.ok(host.fixture.calls.some((c) => c.method === "SubscribeToTask" && c.params.id === "task-progress"));
  assert.ok(host.fixture.calls.some((c) => c.method === "CancelTask" && c.params.id === "task-hold"));
});

test("restart recovers known and uncertain tasks while the recipient directory is offline", async (t) => {
  const { host, memberId, send } = await connectedHost(t);
  host.fixture.config.directoryUnavailable = true;
  await send("detached", "HOLD");
  await host.waitMessage("detached", (m) => Boolean(m.remoteTask?.taskId));
  await host.restart();
  assert.equal(
    host.fixture.calls.some((c) => c.method === "CancelTask"),
    false,
  );
  host.fixture.tasks.detached!.status.state = "TASK_STATE_COMPLETED";
  host.fixture.tasks.detached!.artifacts = [{ parts: [{ text: "Finished while closed." }] }];
  await host.request("/network/account", {});
  assert.equal((await host.waitMessage("detached", (m) => m.status === "done")).text, "Finished while closed.");
  await send("uncertain", "RECOVER");
  const failed = await host.waitMessage("uncertain", (m) => m.status === "failed");
  assert.equal(failed.remoteTask?.pending, true);
  assert.equal(failed.remoteTask?.sendStarted, true);
  await host.request("/rooms/conversation/messages/user-uncertain", { text: "edited after the send" }, "PATCH");
  await host.restart();
  const snapshot = await host.request<{ members: RoomChannelMember[]; messages: RoomChannelMessage[] }>("/rooms");
  assert.equal(snapshot.members.find((m) => m.id === memberId)?.disabled, false);
  assert.equal(snapshot.messages.find((m) => m.id === "uncertain")?.remoteTask?.messageId, "uncertain");
  await host.request("/network/account", {});
  assert.equal((await host.waitMessage("uncertain", (m) => m.status === "done")).text, "reply:RECOVER");
  const calls = host.sendCalls().filter((c) => c.params.message?.messageId === "uncertain");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.params, calls[1]!.params);
  assert.equal(host.fixture.directoryRequests.length, 1);
});

test("logout and account switching preserve pending work without allowing another owner to send", async (t) => {
  const { host, memberId, send } = await connectedHost(t);
  const patched = await host.request<{ member: RoomChannelMember }>(
    `/rooms/members/${memberId}`,
    { source: "local", kernel: "codex", remoteAgent: { senderAgentId: "forged" } },
    "PATCH",
  );
  assert.equal(patched.member.source, "remote");
  assert.equal(patched.member.remoteAgent?.senderAgentId, "sender-admin");
  await send("pending", "HOLD");
  await host.waitMessage("pending", (m) => Boolean(m.remoteTask?.taskId));
  await host.request("/auth/logout", {});
  assert.equal((await host.waitMessage("pending", (m) => m.status !== "running")).remoteTask?.pending, true);
  await host.login("second");
  const rejected = await fetch(host.baseUrl + "/rooms/conversation/messages", {
    method: "POST",
    headers: { ...host.headers, cookie: host.cookies },
    body: JSON.stringify({ text: "wrong account", targetIds: [memberId] }),
  });
  assert.equal(rejected.status, 409);
  assert.equal(host.sendCalls().length, 1);
  await host.request("/rooms");
  assert.equal(host.sendCalls().length, 1);
  await host.login("admin");
  await host.request("/rooms/conversation/messages/pending/cancel", {});
  await host.waitMessage("pending", (m) => m.remoteTask?.pending === false);
  const snapshot = JSON.stringify(await host.request("/rooms"));
  assert.equal(snapshot.includes("ars_"), false);
  assert.equal(snapshot.includes("product-admin-"), false);
  assert.equal(readFileSync(join(host.directory, "state.sqlite")).includes(Buffer.from("ars_")), false);
});

test("Stop abandons an unsent group message while offline and prevents later recovery", async (t) => {
  const { host, memberId, send } = await connectedHost(t);
  await host.request("/rooms", { id: "offline", title: "Offline group", memberIds: [memberId] });
  host.fixture.config.routerUnavailable = true;
  await host.restart();
  await send("unsent", "Do not deliver after I stop.", {}, "offline");
  const failed = await host.waitMessage("unsent", (message) => message.status === "failed");
  assert.equal(failed.remoteTask?.pending, true);
  assert.equal(failed.remoteTask?.sendStarted, undefined);
  const stopped = await host.request<{ message: RoomChannelMessage }>("/rooms/offline/messages/unsent/cancel", {});
  assert.equal(stopped.message.status, "interrupted");
  assert.equal(stopped.message.remoteTask?.pending, false);
  assert.equal(stopped.message.remoteTask?.statusText, "Canceled before sending.");

  host.fixture.config.routerUnavailable = false;
  await host.request("/auth/logout", {});
  await host.login("admin");
  await host.request("/network/account", {});
  await send("after-stop", "The connection works.");
  await host.waitMessage("after-stop", (message) => message.status === "done");
  assert.deepEqual(
    host.sendCalls().map((call) => call.params.message?.messageId),
    ["after-stop"],
  );
});

test("Stop works after logout without borrowing the old account's Router session", async (t) => {
  const { host, send } = await connectedHost(t);
  await send("logged-out", "HOLD");
  await host.waitMessage("logged-out", (message) => Boolean(message.remoteTask?.taskId));
  await host.request("/auth/logout", {});
  const stopped = await host.request<{ message: RoomChannelMessage }>(
    "/rooms/conversation/messages/logged-out/cancel",
    {},
  );
  assert.equal(stopped.message.remoteTask?.pending, false);
  assert.equal(stopped.message.remoteTask?.statusText, "Stopped retrying. The remote task may still be running.");
  assert.equal(host.fixture.calls.filter((call) => call.method === "CancelTask").length, 0);
  assert.equal(host.fixture.tasks["logged-out"]?.status.state, "TASK_STATE_WORKING");
  await host.login("admin");
  await host.request("/network/account", {});
  await send("authorized-probe", "The connection works.");
  await host.waitMessage("authorized-probe", (message) => message.status === "done");
  const current = (
    await host.request<{ messages: RoomChannelMessage[] }>("/rooms/conversation/messages")
  ).messages.find((message) => message.id === "logged-out");
  assert.equal(current?.remoteTask?.pending, false);
  assert.equal(current?.status, "interrupted");
});

test("Stop never resends a submission whose receipt was lost", async (t) => {
  const { host, send } = await connectedHost(t);
  await send("lost-receipt", "RECOVER");
  const failed = await host.waitMessage("lost-receipt", (message) => message.status === "failed");
  assert.equal(failed.remoteTask?.taskId, undefined);
  assert.equal(failed.remoteTask?.sendStarted, true);
  assert.equal(host.fixture.tasks["lost-receipt"]?.status.state, "TASK_STATE_COMPLETED");
  const stopped = await host.request<{ message: RoomChannelMessage }>(
    "/rooms/conversation/messages/lost-receipt/cancel",
    {},
  );
  assert.equal(stopped.message.remoteTask?.pending, false);
  assert.equal(stopped.message.remoteTask?.statusText, "Stopped retrying. The remote task may still be running.");
  await host.request("/network/account", {});
  await send("receipt-probe", "Still connected.");
  await host.waitMessage("receipt-probe", (message) => message.status === "done");
  assert.equal(host.sendCalls().filter((call) => call.params.message?.messageId === "lost-receipt").length, 1);
});

test("Stop leaves an unconfirmed remote cancellation stopped locally", async (t) => {
  const { host, send } = await connectedHost(t);
  await send("slow-cancel", "HOLD");
  await host.waitMessage("slow-cancel", (message) => Boolean(message.remoteTask?.taskId));
  host.fixture.config.delayCancellation = true;
  const stopped = await host.request<{ message: RoomChannelMessage }>(
    "/rooms/conversation/messages/slow-cancel/cancel",
    {},
  );
  assert.equal(stopped.message.status, "interrupted");
  assert.equal(stopped.message.remoteTask?.pending, false);
  assert.equal(stopped.message.remoteTask?.statusText, "Stopped retrying. The remote task may still be running.");
  assert.equal(host.fixture.tasks["slow-cancel"]?.status.state, "TASK_STATE_WORKING");
  assert.equal(host.fixture.calls.filter((call) => call.method === "CancelTask").length, 1);
  await host.request("/network/account", {});
  await send("cancel-probe", "Still connected.");
  await host.waitMessage("cancel-probe", (message) => message.status === "done");
  const current = (
    await host.request<{ messages: RoomChannelMessage[] }>("/rooms/conversation/messages")
  ).messages.find((message) => message.id === "slow-cancel");
  assert.equal(current?.status, "interrupted");
  assert.equal(current?.remoteTask?.pending, false);
});

test("Stop during connection prevents a late exchange from sending the queued message", async (t) => {
  const { host, memberId, send } = await connectedHost(t);
  await host.request("/rooms", { id: "connecting", title: "Connecting group", memberIds: [memberId] });
  let release!: () => void;
  host.fixture.config.exchangeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await host.restart();
    const exchanges = host.fixture.exchanges.length;
    await send("connecting-stop", "Must never be delivered.", {}, "connecting");
    await host.waitMessage("connecting-stop", () => host.fixture.exchanges.length > exchanges);
    const stopped = await host.request<{ message: RoomChannelMessage }>(
      "/rooms/connecting/messages/connecting-stop/cancel",
      {},
    );
    assert.equal(stopped.message.status, "interrupted");
    release();
    await send("connection-probe", "The connection finished.", {}, "connecting");
    await host.waitMessage("connection-probe", (message) => message.status === "done");
    assert.deepEqual(
      host.sendCalls().map((call) => call.params.message?.messageId),
      ["connection-probe"],
    );
  } finally {
    release();
  }
});

test("a recovery already waiting for a connection cannot restart stopped work", async (t) => {
  const { host, send } = await connectedHost(t);
  await send("recovering-stop", "HOLD");
  const first = await host.waitMessage("recovering-stop", (message) => Boolean(message.remoteTask?.taskId));
  await host.restart();
  let release!: () => void;
  host.fixture.config.exchangeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const exchanges = host.fixture.exchanges.length;
    const getCalls = () =>
      host.fixture.calls.filter((call) => call.method === "GetTask" && call.params.id === "task-recovering-stop")
        .length;
    const gets = getCalls();
    await host.request("/auth/session");
    await host.waitMessage("recovering-stop", () => host.fixture.exchanges.length > exchanges);
    const stopping = host.request<{ message: RoomChannelMessage }>(
      "/rooms/conversation/messages/recovering-stop/cancel",
      {},
    );
    await host.waitMessage("recovering-stop", (message) => message.remoteTask?.pending === false);
    release();
    const stopped = await stopping;
    assert.equal(stopped.message.runId, first.runId);
    assert.equal(stopped.message.remoteTask?.pending, false);
    await send("recovery-probe", "The connection works.");
    await host.waitMessage("recovery-probe", (message) => message.status === "done");
    assert.equal(getCalls(), gets);
  } finally {
    release();
  }
});

test("stopping a queued turn preserves the Employee's other active work", async (t) => {
  const { host, memberId, send } = await connectedHost(t);
  await send("queue-head", "HOLD");
  await host.waitMessage("queue-head", (message) => Boolean(message.remoteTask?.taskId));
  await send("queued-stop", "Never deliver this queued turn.");
  const stopped = await host.request<{ message: RoomChannelMessage }>(
    "/rooms/conversation/messages/queued-stop/cancel",
    {},
  );
  assert.equal(stopped.message.status, "interrupted");
  const snapshot = await host.request<{ members: RoomChannelMember[] }>("/rooms");
  assert.equal(snapshot.members.find((member) => member.id === memberId)?.status, "running");
  await host.request("/rooms/conversation/messages/queue-head/cancel", {});
  await send("queue-probe", "The queue is available.");
  await host.waitMessage("queue-probe", (message) => message.status === "done");
  assert.deepEqual(
    host.sendCalls().map((call) => call.params.message?.messageId),
    ["queue-head", "queue-probe"],
  );
});

test("renewal, changed sender and malformed responses have explicit outcomes", async (t) => {
  const { host, memberId, send } = await connectedHost(t);
  host.fixture.config.rejectCredentialOnce = true;
  await send("renew", "renew session");
  await host.waitMessage("renew", (m) => m.status === "done");
  for (const text of ["FAIL", "AUTH", "MALFORMED"]) {
    await send(text, text);
    const failed = await host.waitMessage(text, (m) => m.status === "failed");
    if (text === "MALFORMED") {
      assert.equal(failed.text, "");
      assert.equal(failed.remoteTask?.pending, true);
    }
  }
  await host.restart();
  host.fixture.config.changedSender = true;
  const changed = await fetch(host.baseUrl + "/rooms/conversation/messages", {
    method: "POST",
    headers: { ...host.headers, cookie: host.cookies },
    body: JSON.stringify({ text: "do not send", targetIds: [memberId] }),
  });
  assert.equal(changed.status, 409);
});
