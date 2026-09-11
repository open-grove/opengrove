import assert from "node:assert/strict";
import { test } from "node:test";
import { startRemoteRoomHost } from "./fixtures/remote-room-host.js";
import type { RoomChannelMember } from "../rooms/channel-store.js";

test("group submission does not wait for a stalled Router exchange", { timeout: 30_000 }, async (t) => {
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
  t.signal.addEventListener("abort", release, { once: true });
  const submitting = host.request("/rooms/group/messages", {
    text: "hello",
    targetIds: [memberId],
    assistantMessageIds: ["group-cloud-reply"],
  });
  try {
    // A successful response while the exchange gate is still closed proves
    // submission does not depend on Router latency. The test timeout bounds hangs.
    await submitting;
  } finally {
    release();
    t.signal.removeEventListener("abort", release);
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
  const exchanges = host.fixture.exchanges.length;
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
  host.fixture.tasks["current-task"]!.artifacts = [{ parts: [{ text: "The original session is still observing." }] }];
  host.fixture.tasks["current-task"]!.status.state = "TASK_STATE_COMPLETED";
  assert.equal(
    (await host.waitMessage("current-task", (message) => message.status === "done")).text,
    "The original session is still observing.",
  );
  await host.request("/rooms/current/messages", {
    text: "HOLD",
    targetIds: [memberId],
    assistantMessageIds: ["after-stale-logout"],
  });
  await host.waitMessage("after-stale-logout", (message) => Boolean(message.remoteTask?.taskId));
  assert.equal(host.fixture.exchanges.length, exchanges, "sending must reuse the original communication session");
  assert.equal(host.fixture.revoked.length, revoked);
  // The actual owner's logout still detaches its work immediately, including offline cleanup.
  await host.request("/auth/logout", {});
  const paused = await host.waitMessage("after-stale-logout", (message) => message.status !== "running");
  assert.equal(paused.remoteTask?.pending, true);
});
