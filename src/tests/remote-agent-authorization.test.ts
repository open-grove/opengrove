import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBridgeState } from "../server/bridge-state.js";
import { clearNetworkSession, networkSessionsFor } from "../server/remote-agents/session.js";
import { createRoutineMemberExecutor } from "../server/routine-scheduler.js";
import { delegateRoomTask } from "../server/room-delegation.js";
import { scheduleRoomAssistantRuns } from "../server/room-runs.js";
import { validateWorkflowMemberRef, validateImportWorkflowMemberRef } from "../server/workflow-member-ref.js";
import type { RoomChannelMessage } from "../rooms/channel-store.js";
import { startRemoteRoomHost } from "./fixtures/remote-room-host.js";

test("A2A exposes only local Employees and cannot send or cancel remote work", async (t) => {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
  await host.login("admin");
  const { memberId } = await host.request<{ memberId: string }>("/network/contacts", {
    address: host.fixture.address,
  });
  await host.request("/rooms/members", { id: "local-coder", name: "Local coder", kernel: "codex", model: "default" });
  await host.request("/rooms/dm", { memberId, roomId: "authorized" });

  const unauthenticated = await fetch(host.baseUrl + "/rooms/authorized/messages", {
    method: "POST",
    headers: host.headers,
    body: JSON.stringify({ text: "unauthorized", targetIds: [memberId] }),
  });
  assert.equal(unauthenticated.status, 401);
  for (const cookie of ["", host.cookies]) {
    const headers = { ...host.headers, cookie };
    const listed = await fetch(host.baseUrl + "/a2a/agents", { headers });
    const { cards } = (await listed.json()) as { cards: { metadata: { ogExtensions: { employeeId: string } } }[] };
    const ids = cards.map((card) => card.metadata.ogExtensions.employeeId);
    assert.ok(ids.includes("local-coder"));
    assert.ok(!ids.includes(memberId), "a remote contact must not be published as this Host's Agent");
    assert.equal((await fetch(host.baseUrl + "/a2a/agents/local-coder/card", { headers })).status, 200);
    assert.equal((await fetch(host.baseUrl + `/a2a/agents/${memberId}/card`, { headers })).status, 404);
    const sent = await fetch(host.baseUrl + `/a2a/agents/${memberId}/message:send`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: { messageId: "a2a-unauthorized", role: "ROLE_USER", parts: [{ text: "unauthorized" }] },
      }),
    });
    assert.equal(sent.status, 404);
  }
  assert.equal(host.sendCalls().length, 0);

  await host.request("/rooms", { id: "unauthorized-group", title: "Group", memberIds: [memberId] });
  const deniedGroup = await fetch(host.baseUrl + "/rooms/unauthorized-group/messages", {
    method: "POST",
    headers: host.headers,
    body: JSON.stringify({
      text: "must not be replayed",
      targetIds: [memberId],
      assistantMessageIds: ["denied-group"],
    }),
  });
  assert.equal(deniedGroup.status, 200);
  const denied = await host.waitMessage("denied-group", (message) => message.status === "failed");
  assert.equal(denied.remoteTask?.pending, false, "an authorization failure must never become pending work");
  assert.doesNotMatch(
    denied.remoteTask?.statusText ?? "",
    /\bRetry\b|重试/,
    "a rejected message has no recovery action",
  );
  await host.request("/network/account", {});
  assert.equal(host.sendCalls().length, 0, "a later authorized reconnect must not replay an unauthorized message");

  await host.request("/rooms/authorized/messages", {
    text: "HOLD",
    targetIds: [memberId],
    assistantMessageIds: ["authorized-task"],
  });
  const running = await host.waitMessage("authorized-task", (message) => Boolean(message.remoteTask?.taskId));
  assert.equal(host.sendCalls().length, 1, "the verified Rooms route remains usable");
  const tasks = await host.request<{ tasks: { id: string }[] }>("/a2a/tasks");
  assert.ok(!tasks.tasks.some((task) => task.id === running.runId));
  for (const id of [running.runId!, running.id]) {
    assert.equal((await fetch(host.baseUrl + `/a2a/tasks/${id}`, { headers: host.headers })).status, 404);
    assert.equal(
      (await fetch(host.baseUrl + `/a2a/tasks/${id}:cancel`, { method: "POST", headers: host.headers, body: "{}" }))
        .status,
      404,
    );
  }
  assert.equal(host.fixture.calls.filter((call) => call.method === "CancelTask").length, 0);
  await host.request("/rooms/authorized/messages/authorized-task/cancel", {});
  await host.waitMessage(
    "authorized-task",
    (message) => message.status === "interrupted" && message.remoteTask?.pending === false,
  );
});

test("a cached admin connection does not authorize background work", async (t) => {
  const host = await startRemoteRoomHost();
  const state = createBridgeState({ statePath: join(host.directory, "background.sqlite") });
  t.after(async () => {
    await clearNetworkSession(state);
    state.store.close?.();
    await host.dispose();
  });
  const network = networkSessionsFor(state);
  network.observe({
    accountIssuer: host.fixture.baseUrl,
    accountUserId: "admin",
    accessToken: "product-admin-fixture",
  });
  const connection = await network.connect();
  const resolved = await connection.request(({ client }) => client.resolve(host.fixture.address));
  const remote = state.app.rooms.upsertMember({
    id: "remote-target",
    name: "Cloud coder",
    source: "remote",
    kernel: "remote",
    model: "remote",
    role: "",
    color: "#3b82f6",
    status: "idle",
    lastActive: "",
    remoteAgent: { ...connection.binding, address: resolved.address, matrixId: resolved.matrixId },
  });
  const pm = state.app.rooms.upsertMember({
    id: "local-pm",
    employeeDefinitionId: "pm",
    name: "Local PM",
    kernel: "codex",
    model: "default",
    role: "",
    color: "#3b82f6",
    status: "idle",
    lastActive: "",
  });
  const room = state.app.rooms.createRoom({
    id: "background",
    title: "Background",
    badge: "Test",
    memberIds: [pm.id, remote.id],
    adminMemberIds: [pm.id],
  });
  // Prove the retained connection can send, so a denied request cannot pass because Router is unavailable.
  await connection.request(({ client, sender }) =>
    client.send({
      agentId: sender.id,
      address: resolved.address,
      resolvedTarget: resolved,
      text: "connection probe",
      messageId: "connection-probe",
    }),
  );
  const sends = host.sendCalls().length;

  await t.test("routine", async () => {
    assert.equal(validateWorkflowMemberRef(state.app.rooms, remote.id, {}), "remote_authorization_required");
    assert.equal(validateImportWorkflowMemberRef(state.app.rooms, remote.id), "remote_authorization_required");
    const result = await createRoutineMemberExecutor(state)({
      memberId: remote.id,
      roomId: room.id,
      prompt: "routine request",
      stepId: "remote-step",
      runId: "routine-run",
    });
    assert.equal(result.ok, false);
    assert.equal(host.sendCalls().length, sends);
  });
  for (const mode of ["system", "pm"] as const) {
    await t.test(`${mode} delegation`, async () => {
      const source = state.app.rooms.postUserMessage({
        roomId: room.id,
        text: "PM request",
        targetIds: [pm.id],
        assistantTargets: [pm],
        deliveryKind: "pm_auto_route",
      });
      state.app.rooms.updateMessage(room.id, source.assistantMessages[0]!.id, {
        runId: "unapproved-pm",
        status: "done",
      });
      const result = await delegateRoomTask(state, {
        roomId: room.id,
        targetMemberId: remote.id,
        prompt: "delegated request",
        ...(mode === "pm" ? { sourceRunId: "unapproved-pm" } : {}),
      });
      if (result.ok) {
        const id = (result.value as { messageId: string }).messageId;
        for (let attempt = 0; attempt < 160 && state.app.rooms.getMessage(room.id, id)?.status === "running"; attempt++)
          await delay(25);
      }
      assert.equal(result.ok, false);
      assert.equal(host.sendCalls().length, sends);
    });
  }
  for (const forged of [false, true])
    await t.test(forged ? "forged authorization" : "executor defense", async () => {
      const posted = state.app.rooms.postUserMessage({
        roomId: room.id,
        text: "unapproved execution",
        targetIds: [remote.id],
        assistantTargets: [remote],
      });
      const final = await new Promise<RoomChannelMessage>((resolve) => {
        scheduleRoomAssistantRuns(state, {
          roomId: room.id,
          triggerMessageId: posted.userMessage.id,
          targets: [remote],
          assistantMessages: posted.assistantMessages,
          ...(forged ? { networkAuthorization: { accountIssuer: host.fixture.baseUrl, accountUserId: "admin" } } : {}),
          onMessageFinalized: ({ message }) => {
            resolve(message);
          },
        });
      });
      assert.equal(final.status, "failed");
      assert.equal(final.remoteTask?.pending, false, "unauthorized work must not become recoverable after login");
      assert.equal(host.sendCalls().length, sends);
    });
});
