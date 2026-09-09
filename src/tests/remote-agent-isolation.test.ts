import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startRemoteRoomHost } from "./fixtures/remote-room-host.js";
import type { RoomChannelMember } from "../rooms/channel-store.js";

test("group submission does not wait for a stalled Router exchange", async (t) => {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
  await host.login("admin");
  const { memberId } = await host.request<{ memberId: string }>("/network/contacts", { address: host.fixture.address });
  await host.request("/rooms", { id: "group", title: "Shared conversation", memberIds: [memberId] });
  await host.restart();
  let release!: () => void;
  host.fixture.config.exchangeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submitting = host.request("/rooms/group/messages", {
    text: "hello",
    targetIds: [memberId],
    assistantMessageIds: ["group-cloud-reply"],
  });
  try {
    assert.equal(
      await Promise.race([submitting.then(() => true), delay(1000, false)]),
      true,
      "accepting a group message must not await the remote service",
    );
  } finally {
    release();
    await submitting;
  }
  await host.waitMessage("group-cloud-reply", (message) => message.status === "done");
});

for (const mode of ["unconfigured", "unavailable"] as const) {
  test(`local contacts, Rooms and product login remain usable when Router is ${mode}`, async (t) => {
    const host = await startRemoteRoomHost();
    t.after(() => host.dispose());
    if (mode === "unconfigured") delete process.env.OPENGROVE_AGENT_ROUTER_URL;
    else host.fixture.config.routerUnavailable = true;
    assert.deepEqual(await host.request("/network/account"), {
      ok: true,
      configured: mode !== "unconfigured",
    });
    const { member } = await host.request<{ member: RoomChannelMember }>("/rooms/members", {
      id: "local-employee",
      name: "Local employee",
      kernel: "codex",
      model: "default",
    });
    assert.notEqual(member.source, "remote");
    await host.request("/rooms/dm", {
      memberId: member.id,
      roomId: "local-room",
    });
    await host.request(`/rooms/members/${member.id}`, { name: "Renamed locally" }, "PATCH");
    await host.login("admin");
    assert.equal((await host.request<{ authenticated: boolean }>("/auth/session")).authenticated, true);
    await host.restart();
    const restored = await host.request<{ members: RoomChannelMember[] }>("/rooms");
    assert.equal(restored.members.find((item) => item.id === member.id)?.name, "Renamed locally");
    await host.request("/rooms/local-room/messages");
    assert.equal(host.fixture.exchanges.length, 0);
    assert.equal(host.fixture.calls.length, 0);
  });
}

test("stale and anonymous logout requests cannot revoke the current communication session", async (t) => {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
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
  for (const cookie of [oldCookies, ""]) {
    const response = await fetch(host.baseUrl + "/auth/logout", {
      method: "POST",
      headers: { ...host.headers, cookie },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal(host.fixture.revoked.length, revoked);
    assert.equal((await host.waitMessage("current-task", () => true)).status, "running");
  }
  // The actual owner's logout still detaches its work immediately, including offline cleanup.
  await host.request("/auth/logout", {});
  const paused = await host.waitMessage("current-task", (message) => message.status !== "running");
  assert.equal(paused.remoteTask?.pending, true);
});
