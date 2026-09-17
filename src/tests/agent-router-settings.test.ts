import assert from "node:assert/strict";
import { test } from "node:test";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { startRemoteAgentService } from "./fixtures/remote-agent-service.js";
import { startRemoteRoomHost } from "./fixtures/remote-room-host.js";
import { createBridgeState, saveBridgeSettings } from "../server/bridge-state.js";
import { bridgeSettingsPath } from "../server/bridge-settings-store.js";
import { disposeBridgeKernelWorkers } from "../server/kernel-lifecycle.js";
import { handleSettingsRoute } from "../server/routes/settings.js";
import { networkSessionsFor } from "../server/remote-agents/session.js";

for (const restartRequired of [false, true]) {
  test(`a committed settings change reports later state persistence failure, restart=${restartRequired}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "opengrove-settings-commit-"));
    const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
    t.after(async () => {
      await disposeBridgeKernelWorkers(state);
      await state.store.close?.();
      rmSync(directory, { recursive: true, force: true });
    });
    state.settings = { ...state.settings, languagePreference: "zh-CN", agentRouterUrl: "https://old.example" };
    const oldNetwork = networkSessionsFor(state);
    state.app.rooms.createRoom({
      id: "numbered",
      title: "新群聊 6",
      badge: "本地",
      generatedTitle: { kind: "numbered-group", sequence: 6 },
      memberIds: [],
    });
    state.store.saveFrom(state.app);
    saveBridgeSettings(state);
    const path = bridgeSettingsPath(state);
    const saveFrom = state.store.saveFrom.bind(state.store);
    state.store.saveFrom = (app) => {
      if (JSON.parse(readFileSync(path, "utf8")).agentRouterUrl === "https://new.example")
        throw new Error("injected_state_write_failure");
      return saveFrom(app);
    };
    const responses: Array<{ status: number; data: Record<string, unknown> }> = [];
    try {
      await handleSettingsRoute({
        request: { method: "PATCH" } as never,
        response: {} as never,
        url: new URL("http://opengrove.test/settings"),
        state,
        readJsonBody: async () => ({
          languagePreference: "en",
          agentRouterUrl: "https://new.example",
          ...(restartRequired
            ? { kernelProxy: { ...state.settings.kernelProxy, noProxy: "settings-test.invalid" } }
            : {}),
        }),
        sendJson: (_response, status, data) => {
          responses.push({ status, data: data as Record<string, unknown> });
        },
      });
    } finally {
      state.store.saveFrom = saveFrom;
    }
    assert.equal(responses[0]?.status, 200);
    assert.equal(responses[0]?.data.degraded, true);
    assert.equal(responses[0]?.data.warning, "settings_state_persist_failed");
    assert.equal(state.settings.agentRouterUrl, "https://new.example");
    assert.equal(state.settings.languagePreference, "en");
    assert.notEqual(
      networkSessionsFor(state),
      oldNetwork,
      "committed changes invalidate old service credentials even after a state write fails",
    );
    assert.equal(JSON.parse(readFileSync(path, "utf8")).agentRouterUrl, "https://new.example");
  });

  test(`failed settings commit preserves presentation and Router, restart=${restartRequired}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "opengrove-settings-failure-"));
    const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
    t.after(async () => {
      await disposeBridgeKernelWorkers(state);
      await state.store.close?.();
      rmSync(directory, { recursive: true, force: true });
    });
    state.settings = { ...state.settings, languagePreference: "zh-CN", agentRouterUrl: "https://old.example" };
    const oldNetwork = networkSessionsFor(state);
    state.app.rooms.createRoom({
      id: "numbered",
      title: "新群聊 6",
      badge: "本地",
      generatedTitle: { kind: "numbered-group", sequence: 6 },
      memberIds: [],
    });
    state.store.saveFrom(state.app);
    saveBridgeSettings(state);
    const path = bridgeSettingsPath(state);
    assert.ok(realpathSync(path).startsWith(realpathSync(directory) + sep));
    renameSync(path, path + ".backup");
    mkdirSync(path);
    const responses: number[] = [];
    let rejected = false;
    try {
      await handleSettingsRoute({
        request: { method: "PATCH" } as never,
        response: {} as never,
        url: new URL("http://opengrove.test/settings"),
        state,
        readJsonBody: async () => ({
          languagePreference: "en",
          agentRouterUrl: "https://new.example",
          ...(restartRequired
            ? { kernelProxy: { ...state.settings.kernelProxy, noProxy: "settings-test.invalid" } }
            : {}),
        }),
        sendJson: (_response, status) => {
          responses.push(status);
        },
      });
    } catch {
      rejected = true;
    } finally {
      rmdirSync(path);
      renameSync(path + ".backup", path);
    }
    assert.ok(rejected || responses.some((status) => status >= 400));
    assert.equal(state.settings.languagePreference, "zh-CN");
    assert.equal(state.settings.agentRouterUrl, "https://old.example");
    assert.equal(networkSessionsFor(state), oldNetwork, "a rejected change keeps the previous service session");
    assert.equal(state.app.rooms.getRoom("numbered")?.title, "新群聊 6");
    state.store.loadInto(state.app);
    assert.equal(
      state.app.rooms.getRoom("numbered")?.title,
      "新群聊 6",
      "failed commit must not persist translated titles",
    );
    assert.equal(JSON.parse(readFileSync(path, "utf8")).agentRouterUrl, "https://old.example");
  });
}

test("ordinary users can save Router settings, which start empty and survive restart", async (t) => {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
  delete process.env.OPENGROVE_AGENT_ROUTER_URL;
  const before = await host.request<{ settings: { agentRouterUrl: string } }>("/settings");
  assert.equal(before.settings.agentRouterUrl, "");
  assert.deepEqual(await host.request("/network/account"), { ok: true, configured: false });
  await host.login("regular");
  const result = await host.request<{ restarted: boolean; settings: { agentRouterUrl: string } }>(
    "/settings",
    { agentRouterUrl: `  ${host.fixture.serviceUrl}/  ` },
    "PATCH",
  );
  assert.equal(result.settings.agentRouterUrl, host.fixture.serviceUrl);
  assert.equal(result.restarted, false);
  assert.deepEqual(await host.request("/network/account"), { ok: true, configured: true });
  assert.equal(host.fixture.calls.length, 0, "saving does not connect or send credentials");
  const connection = await fetch(host.baseUrl + "/network/account", {
    method: "POST",
    headers: { ...host.headers, cookie: host.cookies },
    body: "{}",
  });
  assert.equal(connection.status, 403, "saving a local URL does not grant cloud account privileges");
  assert.equal(host.fixture.exchanges.length, 0);
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
  assert.equal(managed.settings.agentRouterUrl, "");
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
    "https://agents.example/_agent-router/v1?",
    "https://agents.example/_agent-router/v1#",
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
  await host.connect();
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
  await host.connect();
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
  await host.authorize();
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

test("an environment address is display-only and cannot become a saved fallback", async (t) => {
  const host = await startRemoteRoomHost();
  t.after(() => host.dispose());
  const response = await fetch(host.baseUrl + "/settings", {
    method: "PATCH",
    headers: host.headers,
    body: JSON.stringify({ agentRouterUrl: host.fixture.serviceUrl }),
  });
  assert.equal(response.status, 409, "even an identical environment URL is not writable");
  const snapshot = await host.request<{ settings: { agentRouterUrl: string; agentRouterEffectiveUrl: string } }>(
    "/settings",
  );
  assert.equal(snapshot.settings.agentRouterUrl, "");
  assert.equal(snapshot.settings.agentRouterEffectiveUrl, host.fixture.serviceUrl);
  await host.request("/settings", { developerMode: true }, "PATCH");
  delete process.env.OPENGROVE_AGENT_ROUTER_URL;
  await host.restart();
  assert.deepEqual(await host.request("/network/account"), { ok: true, configured: false });
  await host.request("/settings", { agentRouterUrl: "https://saved.example/_agent-router/v1" }, "PATCH");
  process.env.OPENGROVE_AGENT_ROUTER_URL = host.fixture.serviceUrl;
  const managed = await host.request<{ settings: { agentRouterUrl: string; agentRouterEffectiveUrl: string } }>(
    "/settings",
  );
  assert.equal(managed.settings.agentRouterUrl, "https://saved.example/_agent-router/v1");
  assert.equal(managed.settings.agentRouterEffectiveUrl, host.fixture.serviceUrl);
  delete process.env.OPENGROVE_AGENT_ROUTER_URL;
  await host.restart();
  const restored = await host.request<{ settings: { agentRouterUrl: string } }>("/settings");
  assert.equal(restored.settings.agentRouterUrl, "https://saved.example/_agent-router/v1");
});
