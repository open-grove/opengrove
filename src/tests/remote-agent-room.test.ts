import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startLocalBridgeServer } from "../server/local-bridge.js";
import type { RoomChannelMember, RoomChannelMessage } from "../rooms/channel-store.js";

test("remote Contacts and Rooms preserve context, cancel and recover an accepted request across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-remote-room-"));
  const executable = join(directory, "agent-router");
  copyFileSync(resolve("src/tests/fixtures/remote-agent-cli.mjs"), executable);
  chmodSync(executable, 0o755);
  const fixturePath = join(directory, "remote.json");
  const oldBin = process.env.OPENGROVE_AGENT_ROUTER_BIN;
  process.env.OPENGROVE_AGENT_ROUTER_BIN = executable;
  process.env.OPENGROVE_REMOTE_TEST_STATE = fixturePath;
  let server = start();
  let baseUrl = "";
  const headers = { "content-type": "application/json", "x-opengrove-token": "remote-room-test" };
  async function ready() {
    if (!server.listening) await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  }
  function start() {
    return startLocalBridgeServer({
      host: "127.0.0.1",
      port: 0,
      statePath: join(directory, "state.sqlite"),
      bridgeToken: "remote-room-test",
    });
  }
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  async function request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  const fixture = () =>
    JSON.parse(readFileSync(fixturePath, "utf8")) as {
      calls: string[][];
      tasks: Record<string, unknown>;
      changedSender?: boolean;
    };
  const sendCalls = () => fixture().calls.filter((args) => args[2] === "send");
  async function waitMessage(id: string, predicate: (message: RoomChannelMessage) => boolean) {
    let observed: RoomChannelMessage | undefined;
    for (let attempt = 0; attempt < 160; attempt++) {
      // Events are read-only; polling must not itself retry failed requests.
      const { events } = await request<{ events: { payload: { message?: RoomChannelMessage } }[] }>(
        "/rooms/events?limit=1000",
      );
      const message = events
        .map((event) => event.payload.message)
        .reverse()
        .find((message) => message?.id === id);
      observed = message;
      if (message && predicate(message)) return message;
      await delay(50);
    }
    throw new Error(
      `message timed out: ${id}; last=${JSON.stringify(observed)}; calls=${JSON.stringify(fixture().calls.slice(-5))}`,
    );
  }
  try {
    await ready();
    const { account } = await request<{ account: { owner: string } }>("/network/account", { profile: "test" });
    assert.equal(account.owner, "@owner:example.test");
    const { memberId } = await request<{ memberId: string }>("/network/contacts", {
      profile: "test",
      address: "owner/coder@example.test",
    });
    const snapshot = await request<{ members: RoomChannelMember[] }>("/rooms");
    assert.equal(snapshot.members.find((member) => member.id === memberId)?.source, "remote");
    const patched = await request<{ member: RoomChannelMember }>(
      `/rooms/members/${memberId}`,
      { source: "local", kernel: "codex", remoteAgent: { senderAgentId: "forged" } },
      "PATCH",
    );
    assert.equal(patched.member.remoteAgent?.senderAgentId, "sender-id");
    assert.equal(patched.member.source, "remote");
    await request("/rooms/dm", { memberId, roomId: "remote-first" });
    const send = (roomId: string, id: string, text: string, extra = {}) =>
      request(`/rooms/${roomId}/messages`, {
        text,
        targetIds: [memberId],
        userMessageId: `user-${id}`,
        assistantMessageIds: [id],
        ...extra,
      });
    await send("remote-first", "first", "remember:pineapple");
    const first = await waitMessage("first", (message) => message.status === "done");
    assert.equal(sendCalls()[0]!.includes("--context-id"), false, "the server allocates a fresh context");
    assert.equal(first.remoteTask?.contextId, "context-first");
    await send("remote-first", "second", "recall");
    const second = await waitMessage("second", (message) => message.status === "done");
    assert.equal(second.text, "pineapple");
    assert.equal(second.remoteTask?.contextId, first.remoteTask?.contextId);
    await send("remote-first", "second", "recall");
    assert.equal(sendCalls().length, 2, "HTTP retry must not start another task");
    const messages = await request<{ messages: RoomChannelMessage[] }>("/rooms/remote-first/messages");
    assert.equal(messages.messages.filter((message) => message.id === "second").length, 1);
    await request("/rooms/dm", { memberId, roomId: "remote-new" });
    await send("remote-new", "fresh", "recall");
    const fresh = await waitMessage("fresh", (message) => message.status === "done");
    assert.equal(fresh.text, "unknown");
    assert.notEqual(fresh.remoteTask?.contextId, first.remoteTask?.contextId);
    await send("remote-first", "needs-input", "INPUT");
    const input = await waitMessage("needs-input", (message) => message.status === "done");
    await send("remote-first", "input-answer", "--help");
    const answer = await waitMessage("input-answer", (message) => message.status === "done");
    assert.ok(sendCalls().at(-1)?.includes(input.remoteTask!.taskId!));
    assert.equal(answer.text, "reply:--help");
    const countBeforeFile = sendCalls().length;
    await send("remote-first", "file", "inspect", { selectedFile: { path: "/private/local-only.txt" } });
    await waitMessage("file", (message) => message.status === "failed");
    assert.equal(sendCalls().length, countBeforeFile, "local file references are never forwarded");
    await send("remote-first", "hold", "HOLD");
    const working = await waitMessage("hold", (message) => Boolean(message.remoteTask?.taskId));
    assert.equal(working.text, "", "connection and progress belong to execution status, not the reply body");
    assert.match(working.remoteTask?.statusText ?? "", /working|处理/);
    await request("/rooms/remote-first/messages/hold/cancel", {});
    await waitMessage("hold", (message) => message.status === "interrupted" && message.remoteTask?.pending === false);
    assert.ok(fixture().calls.some((args) => args[2] === "cancel" && args[4] === "task-hold"));
    await send("remote-new", "detach", "HOLD");
    await waitMessage("detach", (message) => Boolean(message.remoteTask?.taskId));
    await close();
    assert.equal(
      fixture().calls.some((args) => args[2] === "cancel" && args[4] === "task-detach"),
      false,
      "closing the Host must not cancel remote work",
    );
    const offline = fixture();
    offline.tasks.detach = {
      id: "task-detach",
      contextId: "context-fresh",
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "Finished while the Host was closed." }] }],
    };
    writeFileSync(fixturePath, JSON.stringify(offline));
    server = start();
    await ready();
    await request("/rooms");
    const detached = await waitMessage("detach", (message) => message.status === "done");
    assert.equal(detached.text, "Finished while the Host was closed.");
    await request("/rooms/dm", { memberId, roomId: "remote-recover" });
    await send("remote-recover", "recovery", "RECOVER");
    const failed = await waitMessage("recovery", (message) => message.status === "failed");
    assert.equal(failed.remoteTask?.pending, true);
    assert.equal(failed.remoteTask?.sendStarted, true);
    await close();
    server = start();
    await ready();
    const restored = await request<{ members: RoomChannelMember[]; messages: RoomChannelMessage[] }>("/rooms");
    assert.equal(restored.members.find((member) => member.id === memberId)?.source, "remote");
    assert.equal(restored.members.find((member) => member.id === memberId)?.disabled, false);
    assert.equal(restored.messages.find((message) => message.id === "recovery")?.remoteTask?.messageId, "recovery");
    assert.equal(restored.messages.find((message) => message.id === "recovery")?.remoteTask?.pending, true);
    assert.equal(restored.messages.find((message) => message.id === "recovery")?.status, "running");
    const recovered = await waitMessage("recovery", (message) => message.status === "done");
    assert.equal(recovered.text, "reply:RECOVER");
    assert.equal(failed.remoteTask?.contextId, undefined);
    assert.equal(recovered.remoteTask?.contextId, "context-recovery");
    assert.equal(sendCalls().filter((args) => args.includes("recovery")).length, 2);
    assert.ok(fixture().tasks.recovery, "the accepted task remains the one keyed by the original message");
    const changed = fixture();
    changed.changedSender = true;
    writeFileSync(fixturePath, JSON.stringify(changed));
    const countBeforeIdentityChange = sendCalls().length;
    await send("remote-new", "changed", "do not send");
    await waitMessage("changed", (message) => message.status === "failed");
    assert.equal(sendCalls().length, countBeforeIdentityChange);
  } finally {
    await close();
    if (oldBin === undefined) delete process.env.OPENGROVE_AGENT_ROUTER_BIN;
    else process.env.OPENGROVE_AGENT_ROUTER_BIN = oldBin;
    delete process.env.OPENGROVE_REMOTE_TEST_STATE;
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
