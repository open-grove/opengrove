import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startLocalBridgeServer } from "../server/local-bridge.js";
import { startRemoteAgentService } from "./fixtures/remote-agent-service.js";
import type { RoomChannelMember, RoomChannelMessage } from "../rooms/channel-store.js";

test("remote Contacts and Rooms preserve context, cancel and recover an accepted request across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-remote-room-"));
  const fixture = await startRemoteAgentService();
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({
    OPENGROVE_AGENT_ROUTER_URL: fixture.serviceUrl,
    OPENGROVE_AGENT_ROUTER_PROVIDER: "opengrove",
    OPENGROVE_AGENT_ROUTER_ALLOW_LOCAL_HTTP: "1",
    OPENGROVE_WW_BASE_URL: fixture.baseUrl,
    OPENGROVE_WEB_AUTH_MODE: "bridge-token",
    OPENGROVE_DATA_DIR: directory,
    OPENGROVE_USER_DATA_DIR: join(directory, "user"),
    OPENGROVE_DIAGNOSTICS_DIR: join(directory, "diagnostics"),
    OPENGROVE_RELEASE_CONTROL_URL: fixture.baseUrl,
  })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  let cookies = "";
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
      headers: { ...headers, cookie: cookies },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) {
      const jar = new Map(
        cookies
          .split("; ")
          .filter(Boolean)
          .map((entry) => entry.split("=") as [string, string]),
      );
      for (const entry of setCookies) {
        const [key, value] = entry.split(";")[0]!.split("=");
        jar.set(key!, value!);
      }
      cookies = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
    }
    const result = await response.json();
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  const sendCalls = () => fixture.calls.filter((call) => call.method === "SendMessage");
  const login = (user: string) => request("/auth/login", { email: `${user}@example.test`, code: "123456" });
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
      `message timed out: ${id}; last=${JSON.stringify(observed)}; calls=${JSON.stringify(fixture.calls.slice(-5))}`,
    );
  }
  try {
    await ready();
    const unauthenticated = await fetch(baseUrl + "/network/account", { method: "POST", headers, body: "{}" });
    assert.equal(unauthenticated.status, 401, "the desktop token alone cannot access network accounts");
    await login("regular");
    const restricted = await fetch(baseUrl + "/network/account", {
      method: "POST",
      headers: { ...headers, cookie: cookies },
      body: "{}",
    });
    assert.equal(restricted.status, 403);
    assert.equal(fixture.exchanges.length, 0);
    await login("admin");
    fixture.config.rejectExternalOnce = true;
    const { account } = await request<{ account: { owner: string } }>("/network/account", {});
    assert.equal(fixture.exchanges.length, 2);
    assert.notEqual(
      fixture.exchanges[0]?.accessToken,
      fixture.exchanges[1]?.accessToken,
      "product rejection refreshes WW auth through the foreground response",
    );
    assert.ok(account.owner.startsWith("@admin:"));
    const { memberId } = await request<{ memberId: string }>("/network/contacts", {
      address: fixture.address,
    });
    fixture.config.directoryUnavailable = true;
    const snapshot = await request<{ members: RoomChannelMember[] }>("/rooms");
    assert.equal(snapshot.members.find((member) => member.id === memberId)?.source, "remote");
    const patched = await request<{ member: RoomChannelMember }>(
      `/rooms/members/${memberId}`,
      { source: "local", kernel: "codex", remoteAgent: { senderAgentId: "forged" } },
      "PATCH",
    );
    assert.equal(patched.member.remoteAgent?.senderAgentId, "sender-admin");
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
    assert.equal(Boolean(sendCalls()[0]!.params.message?.contextId), false, "the server allocates a fresh context");
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
    await request("/rooms/dm", { memberId, roomId: "remote-progress" });
    await send("remote-progress", "progress", "PROGRESS");
    const progress = await waitMessage("progress", (message) => Boolean(message.remoteTask?.taskId));
    assert.equal(progress.text, "", "real SDK status.message progress must not enter reply text");
    assert.equal(progress.remoteTask?.statusText, "Connecting to the remote worker…");
    fixture.tasks.progress!.status = {
      state: "TASK_STATE_COMPLETED",
      message: { parts: [{ text: "Delivery complete." }] },
    };
    fixture.tasks.progress!.artifacts = [{ parts: [{ text: "This is the actual response." }] }];
    const progressDone = await waitMessage("progress", (message) => message.status === "done");
    assert.equal(progressDone.text, "This is the actual response.");
    assert.equal(progressDone.remoteTask?.statusText, "Delivery complete.");
    await send("remote-first", "needs-input", "INPUT");
    const input = await waitMessage("needs-input", (message) => message.status === "done");
    assert.equal(input.text, "Please confirm the target.");
    await send("remote-first", "input-answer", "--help");
    const answer = await waitMessage("input-answer", (message) => message.status === "done");
    assert.ok(sendCalls().at(-1)?.params.message?.taskId === input.remoteTask!.taskId!);
    assert.equal(answer.text, "reply:--help");
    const countBeforeFile = sendCalls().length;
    await send("remote-first", "file", "inspect", { selectedFile: { path: "/private/local-only.txt" } });
    await waitMessage("file", (message) => message.status === "failed");
    assert.equal(sendCalls().length, countBeforeFile, "local file references are never forwarded");
    await send("remote-first", "hold", "HOLD");
    const working = await waitMessage("hold", (message) => Boolean(message.remoteTask?.taskId));
    assert.equal(working.text, "", "connection and progress belong to execution status, not the reply body");
    assert.match(working.remoteTask?.statusText ?? "", /working|处理/);
    fixture.config.delayCancellation = true;
    await request("/rooms/remote-first/messages/hold/cancel", {});
    await waitMessage(
      "hold",
      (message) => message.remoteTask?.cancelRequested === true && message.remoteTask.pending === true,
    );
    await waitMessage("hold", (message) => message.status === "interrupted" && message.remoteTask?.pending === false);
    fixture.config.delayCancellation = false;
    assert.ok(fixture.calls.some((call) => call.method === "CancelTask" && call.params.id === "task-hold"));
    await send("remote-new", "detach", "HOLD");
    await waitMessage("detach", (message) => Boolean(message.remoteTask?.taskId));
    await close();
    assert.equal(
      fixture.calls.some((call) => call.method === "CancelTask" && call.params.id === "task-detach"),
      false,
      "closing the Host must not cancel remote work",
    );
    fixture.tasks.detach = {
      id: "task-detach",
      contextId: "context-fresh",
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "Finished while the Host was closed." }] }],
    };
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
    await request(
      "/rooms/remote-recover/messages/user-recovery",
      { text: "edited locally after an uncertain send" },
      "PATCH",
    );
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
    assert.equal(sendCalls().filter((call) => call.params.message?.messageId === "recovery").length, 2);
    assert.ok(fixture.tasks.recovery, "the accepted task remains the one keyed by the original message");
    const recoveredCalls = sendCalls().filter((call) => call.params.message?.messageId === "recovery");
    assert.deepEqual(
      recoveredCalls[0]?.params,
      recoveredCalls[1]?.params,
      "uncertain replay is byte-for-byte the same input",
    );
    fixture.config.rejectCredentialOnce = true;
    await send("remote-new", "renewal", "renew session");
    await waitMessage("renewal", (message) => message.status === "done");
    const countBeforeSwitch = sendCalls().length;
    await send("remote-new", "logout-pending", "HOLD");
    await waitMessage("logout-pending", (message) => Boolean(message.remoteTask?.taskId));
    await request("/auth/logout", {});
    const loggedOut = await waitMessage("logout-pending", (message) => message.status !== "running");
    assert.equal(loggedOut.remoteTask?.pending, true);
    assert.ok(fixture.revoked.length > 0);
    await login("second");
    const wrongAccount = await fetch(baseUrl + "/rooms/remote-new/messages", {
      method: "POST",
      headers: { ...headers, cookie: cookies },
      body: JSON.stringify({ text: "must not cross accounts", targetIds: [memberId] }),
    });
    assert.equal(wrongAccount.status, 409);
    assert.equal(sendCalls().length, countBeforeSwitch + 1);
    await request("/rooms");
    assert.equal(sendCalls().length, countBeforeSwitch + 1);
    await login("admin");
    await request("/rooms");
    await request("/rooms/remote-new/messages/logout-pending/cancel", {});
    await waitMessage("logout-pending", (message) => message.remoteTask?.pending === false);
    for (const text of ["FAIL", "AUTH", "MALFORMED"]) {
      await request("/rooms/dm", { memberId, roomId: `failure-${text}` });
      await send(`failure-${text}`, `failure-${text}`, text);
      const failure = await waitMessage(`failure-${text}`, (message) => message.status === "failed");
      if (text === "MALFORMED") {
        assert.equal(failure.text, "");
        assert.equal(failure.remoteTask?.pending, true);
      }
    }
    const snapshotText = JSON.stringify(await request("/rooms"));
    assert.equal(snapshotText.includes("ars_"), false);
    assert.equal(snapshotText.includes("product-admin-"), false);
    await close();
    assert.equal(readFileSync(join(directory, "state.sqlite")).includes(Buffer.from("ars_")), false);
    server = start();
    await ready();
    fixture.config.changedSender = true;
    const changed = await fetch(baseUrl + "/rooms/remote-new/messages", {
      method: "POST",
      headers: { ...headers, cookie: cookies },
      body: JSON.stringify({ text: "do not send", targetIds: [memberId] }),
    });
    assert.equal(changed.status, 409);
    assert.equal(
      fixture.directoryRequests.length,
      1,
      "saved targets support send/get/cancel and restart recovery while the recipient directory is down",
    );
  } finally {
    await close();
    await fixture.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
