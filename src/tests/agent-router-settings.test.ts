import assert from "node:assert/strict";
import { test } from "node:test";
import { sep } from "node:path";
import { mkdirSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { startRemoteAgentService } from "./fixtures/remote-agent-service.js";
import { startRemoteRoomHost } from "./fixtures/remote-room-host.js";

test("Router settings start empty, save immediately and survive restart", async (t) => {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
  delete process.env.OPENGROVE_AGENT_ROUTER_URL;
  const before = await host.request<{ settings: { agentRouterUrl: string } }>("/settings");
  assert.equal(before.settings.agentRouterUrl, "");
  assert.deepEqual(await host.request("/network/account"), { ok: true, configured: false });
  const result = await host.request<{ restarted: boolean; settings: { agentRouterUrl: string } }>(
    "/settings",
    { agentRouterUrl: `  ${host.fixture.serviceUrl}/  ` },
    "PATCH",
  );
  assert.equal(result.settings.agentRouterUrl, host.fixture.serviceUrl);
  assert.equal(result.restarted, false);
  assert.deepEqual(await host.request("/network/account"), { ok: true, configured: true });
  assert.equal(host.fixture.calls.length, 0, "saving does not connect or send credentials");
  await host.restart();
  assert.deepEqual(await host.request("/network/account"), { ok: true, configured: true });
  await host.request("/settings", { agentRouterUrl: "" }, "PATCH");
  await host.restart();
  assert.deepEqual(await host.request("/network/account"), { ok: true, configured: false });
});

test("invalid URLs and environment overrides cannot replace the trusted service", async (t) => {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
  const patch = (agentRouterUrl: unknown) =>
    fetch(host.baseUrl + "/settings", {
      method: "PATCH",
      headers: host.headers,
      body: JSON.stringify({ agentRouterUrl }),
    });
  const managed = await host.request<{ settings: { agentRouterUrl: string; agentRouterManaged: boolean } }>(
    "/settings",
  );
  assert.equal(managed.settings.agentRouterUrl, host.fixture.serviceUrl);
  assert.equal(managed.settings.agentRouterManaged, true);
  assert.equal((await patch("")).status, 409);
  delete process.env.OPENGROVE_AGENT_ROUTER_URL;
  delete process.env.OPENGROVE_AGENT_ROUTER_ALLOW_LOCAL_HTTP;
  await host.request("/settings", { agentRouterUrl: "https://agents.example/_agent-router/v1" }, "PATCH");
  for (const invalid of [
    null,
    42,
    {},
    "garbage",
    "file:///tmp/router",
    "http://agents.example",
    "http://127.0.0.1",
    "https://user:password@agents.example",
    "https://agents.example?token=secret",
    "https://agents.example/#fragment",
    "a".repeat(2049),
  ]) {
    const response = await patch(invalid);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_agent_router_url" });
  }
  const after = await host.request<{ settings: { agentRouterUrl: string; agentRouterManaged: boolean } }>("/settings");
  assert.equal(after.settings.agentRouterUrl, "https://agents.example/_agent-router/v1");
  assert.equal(after.settings.agentRouterManaged, false);
  assert.equal(host.fixture.exchanges.length, 0);
});

test("changing the Router revokes the old session and keeps conversations bound to their service", async (t) => {
  const host = await startRemoteRoomHost();
  const other = await startRemoteAgentService();
  t.after(async () => {
    await host.dispose();
    await other.close();
  });
  delete process.env.OPENGROVE_AGENT_ROUTER_URL;
  await host.request("/settings", { agentRouterUrl: host.fixture.serviceUrl }, "PATCH");
  await host.login("admin");
  const { memberId } = await host.request<{ memberId: string }>("/network/contacts", { address: host.fixture.address });
  await host.request("/rooms/dm", { memberId, roomId: "router-settings" });
  await host.request("/rooms/router-settings/messages", {
    text: "original",
    targetIds: [memberId],
    assistantMessageIds: ["original"],
  });
  await host.waitMessage("original", (message) => message.status === "done");
  assert.equal(host.sendCalls().length, 1);
  await host.request("/settings", { agentRouterUrl: other.serviceUrl }, "PATCH");
  assert.equal(other.exchanges.length, 0, "changing configuration does not automatically exchange credentials");
  const changed = await fetch(host.baseUrl + "/rooms/router-settings/messages", {
    method: "POST",
    headers: { ...host.headers, cookie: host.cookies },
    body: JSON.stringify({ text: "must not migrate", targetIds: [memberId], assistantMessageIds: ["changed-service"] }),
  });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { ok: false, error: "remote_service_changed" });
  assert.equal(host.sendCalls().length, 1);
  assert.equal(other.calls.length, 0);
  await host.request("/network/account", {});
  assert.equal(other.exchanges.length, 1, "explicit connection uses the newly selected Router");
  assert.equal(host.fixture.revoked.length, 1, "old communication credentials were revoked");
  await host.request("/settings", { agentRouterUrl: "" }, "PATCH");
  assert.deepEqual(await host.request("/network/account"), { ok: true, configured: false });
  const unavailable = await fetch(host.baseUrl + "/network/account", {
    method: "POST",
    headers: { ...host.headers, cookie: host.cookies },
    body: "{}",
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "remote_not_configured" });
});

test("an exchange already in flight cannot authorize contact creation after a service change", async (t) => {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
  delete process.env.OPENGROVE_AGENT_ROUTER_URL;
  await host.request("/settings", { agentRouterUrl: host.fixture.serviceUrl }, "PATCH");
  await host.login("admin");
  let release!: () => void;
  host.fixture.config.exchangeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adding = fetch(host.baseUrl + "/network/contacts", {
    method: "POST",
    headers: { ...host.headers, cookie: host.cookies },
    body: JSON.stringify({ address: host.fixture.address }),
  });
  try {
    for (let attempt = 0; attempt < 100 && !host.fixture.exchanges.length; attempt++) await delay(20);
    assert.equal(host.fixture.exchanges.length, 1);
    await host.request("/settings", { agentRouterUrl: "" }, "PATCH");
  } finally {
    release();
  }
  const response = await adding;
  assert.equal(response.ok, false);
  assert.equal(host.fixture.directoryRequests.length, 0, "the stale connection cannot resolve or create a contact");
});

test("a failed settings write leaves the previous Router active", async (t) => {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
  delete process.env.OPENGROVE_AGENT_ROUTER_URL;
  await host.request("/settings", { agentRouterUrl: host.fixture.serviceUrl }, "PATCH");
  const { settings } = await host.request<{ settings: { settingsPath: string } }>("/settings");
  assert.ok(realpathSync(settings.settingsPath).startsWith(realpathSync(host.directory) + sep));
  const backup = settings.settingsPath + ".before-write-failure";
  renameSync(settings.settingsPath, backup);
  mkdirSync(settings.settingsPath);
  try {
    const result = await fetch(host.baseUrl + "/settings", {
      method: "PATCH",
      headers: host.headers,
      body: JSON.stringify({ agentRouterUrl: "" }),
    });
    assert.equal(result.status, 500);
    const current = await host.request<{ settings: { agentRouterUrl: string } }>("/settings");
    assert.equal(current.settings.agentRouterUrl, host.fixture.serviceUrl);
    assert.deepEqual(await host.request("/network/account"), { ok: true, configured: true });
  } finally {
    rmdirSync(settings.settingsPath);
    renameSync(backup, settings.settingsPath);
  }
});
