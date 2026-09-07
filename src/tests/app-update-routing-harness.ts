import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenGroveClient } from "#client";
import { startOpenGroveServer } from "../server/create-server.js";

const dir = await mkdtemp(join(tmpdir(), "opengrove-app-update-routing-"));
const envKeys = [
  "OPENGROVE_WW_BASE_URL",
  "OPENGROVE_RELEASE_CONTROL_URL",
  "OPENGROVE_WEB_AUTH_MODE",
  "OPENGROVE_DIAGNOSTICS_DIR",
  "OPENGROVE_DESKTOP_CHANNEL",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let catalogRequests = 0;
let versionRequests = 0;
let releaseCatalog: (() => void) | undefined;
let holdCatalog = false;
const fakeServices = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  if (path === "/v1/users/me") {
    const token = request.headers.authorization;
    if (token === "Bearer access-outage") {
      response.writeHead(503).end(JSON.stringify({ error: { code: 100001, message: "unavailable" } }));
      return;
    }
    const userId = token === "Bearer access-owner" ? "owner" : token === "Bearer access-other" ? "other" : undefined;
    if (!userId) {
      response.writeHead(401).end(JSON.stringify({ error: { code: 110201, message: "invalid access" } }));
      return;
    }
    response.end(JSON.stringify({ data: { user_id: userId, email: `${userId}@example.test`, role: "member" } }));
    return;
  }
  if (path === "/v1/client/latest-version" || path === "/v1/public/client/latest-version") {
    versionRequests += 1;
    response.end(JSON.stringify({ mac: { version: 10002, download_url: "https://example.test/client.dmg" } }));
    return;
  }
  if (path === "/v1/app-store/packages") {
    catalogRequests += 1;
    const respond = () => response.end(JSON.stringify({ packages: [] }));
    if (holdCatalog) releaseCatalog = respond;
    else respond();
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: "unexpected_request", path }));
});

try {
  fakeServices.listen(0, "127.0.0.1");
  await once(fakeServices, "listening");
  const servicesUrl = `http://127.0.0.1:${(fakeServices.address() as AddressInfo).port}`;
  process.env.OPENGROVE_WW_BASE_URL = servicesUrl;
  process.env.OPENGROVE_RELEASE_CONTROL_URL = servicesUrl;
  process.env.OPENGROVE_DIAGNOSTICS_DIR = join(dir, "diagnostics");
  process.env.OPENGROVE_DESKTOP_CHANNEL = "dev";
  delete process.env.OPENGROVE_WEB_AUTH_MODE;
  await writeFile(
    join(dir, "ww-provider.json"),
    JSON.stringify({
      version: 1,
      installationId: "1f291082-8f06-4ab0-a59a-f0fd11168928",
      ownerIssuer: servicesUrl,
      ownerUserId: "owner",
      pending: [],
    }),
  );
  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    statePath: join(dir, "state.json"),
    bridgeToken: "desktop-token",
  });
  try {
    if (!server.listening) await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    let sessionSequence = 0;
    const cookie = (user: string) => {
      const session = `${user}-${++sessionSequence}`;
      return `opengrove_auth_access=access-${user}; opengrove_auth_refresh=refresh-${session}; opengrove_auth_session=update-${session}`;
    };
    const ownerHeaders = { cookie: cookie("owner") };
    const client = createOpenGroveClient({ baseUrl, headers: ownerHeaders });

    for (const headers of [{}, ownerHeaders, { cookie: cookie("other") }]) {
      const response = await fetch(`${baseUrl}/auth/client-update`, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(response.headers.getSetCookie(), []);
      // Give the old fire-and-forget update task a chance to reach the fixture.
      await delay(50);
      assert.equal(catalogRequests, 0, "client version reads must not schedule App updates");
    }
    assert.equal(versionRequests, 3);

    for (const [headers, status] of [
      [{}, 401],
      [{ cookie: cookie("other") }, 401],
      [{ cookie: cookie("other"), "x-opengrove-token": "desktop-token" }, 403],
      [{ "x-opengrove-token": "desktop-token" }, 401],
      [{ cookie: cookie("outage"), "x-opengrove-token": "desktop-token" }, 503],
    ] as const) {
      const response = await fetch(`${baseUrl}/app-store/updates`, { method: "POST", headers });
      assert.equal(response.status, status, `App scheduling must reject ${JSON.stringify(headers)}`);
      await response.arrayBuffer();
    }
    assert.equal(catalogRequests, 0);

    holdCatalog = true;
    assert.deepEqual(await client.apps.updates.schedule(), { ok: true, status: "scheduled" });
    const duplicate = await fetch(`${baseUrl}/app-store/updates`, { method: "POST", headers: ownerHeaders });
    assert.deepEqual(await duplicate.json(), { ok: true, status: "already_running" });
    await waitFor(() => Boolean(releaseCatalog));
    releaseCatalog?.();
    releaseCatalog = undefined;
    await waitFor(async () => {
      const settings = await fetch(`${baseUrl}/settings`, { headers: ownerHeaders }).then((response) =>
        response.json(),
      );
      return Boolean(settings.settings.appUpdates.lastSuccessfulCheckAt);
    });
    const throttled = await fetch(`${baseUrl}/app-store/updates`, { method: "POST", headers: ownerHeaders });
    assert.deepEqual(await throttled.json(), { ok: true, status: "skipped", reason: "check_interval" });
    assert.equal(catalogRequests, 1);
    assert.equal(versionRequests, 3, "App updates do not query the desktop release service");

    const disable = await fetch(`${baseUrl}/settings`, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ appUpdates: { automatic: false } }),
    });
    assert.equal(disable.status, 200);
    await disable.arrayBuffer();
    const disabled = await fetch(`${baseUrl}/app-store/updates`, { method: "POST", headers: ownerHeaders });
    assert.deepEqual(await disabled.json(), { ok: true, status: "skipped", reason: "automatic_updates_disabled" });
    const enable = await fetch(`${baseUrl}/settings`, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ appUpdates: { automatic: true } }),
    });
    assert.equal(enable.status, 200);
    await enable.arrayBuffer();
    holdCatalog = false;
    const reenabled = await fetch(`${baseUrl}/app-store/updates`, { method: "POST", headers: ownerHeaders });
    assert.deepEqual(await reenabled.json(), { ok: true, status: "scheduled" });
    await waitFor(() => catalogRequests === 2);
    assert.equal(versionRequests, 3);
    const owner = JSON.parse(await readFile(join(dir, "ww-provider.json"), "utf8")) as { ownerUserId: string };
    assert.equal(owner.ownerUserId, "owner");
  } finally {
    releaseCatalog?.();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
} finally {
  fakeServices.closeAllConnections();
  await new Promise<void>((resolve, reject) => fakeServices.close((error) => (error ? reject(error) : resolve())));
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await rm(dir, { recursive: true, force: true });
}

console.log("app update routing harness ok");

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, "background App update must settle");
    await delay(10);
  }
}
