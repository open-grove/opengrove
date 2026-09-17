import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { AgentNetworkSessions } from "../dist/server/remote-agents/client.js";

// WW's test supplies a real OIDC provider and product integration. Only the
// homeserver transport and account-login delivery below are synthetic.
const ww = process.env.ROUTER_INTEROP_WW_URL;
const accountToken = process.env.ROUTER_INTEROP_ACCOUNT_TOKEN;
const routerRoot = process.env.AGENT_ROUTER_INTEROP_ROOT;
assert.ok(ww && accountToken && routerRoot);
const { ManagedService, createManagedApp } = await import(pathToFileURL(join(routerRoot, "dist/matrix/managed.js")));
const dir = await mkdtemp(join(tmpdir(), "network-native-interop-"));
const server = createServer({
  cert: await readFile(process.env.ROUTER_INTEROP_CERT),
  key: await readFile(process.env.ROUTER_INTEROP_KEY),
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `https://127.0.0.1:${server.address().port}`;
const resource = `${origin}/_agent-router/v1`;
const serverName = new URL(origin).host;
const owner = `@ext_existing:${serverName}`;
const account = {
  name: owner,
  admin: false,
  deactivated: false,
  external_ids: [{ auth_provider: "legacy-account-namespace", external_id: "42" }],
};
const nativeTokens = new Map();
const routerTokens = [];
const oauthTokens = [];
const clientId = "opengrove-desktop";
let sequence = 0;
const service = new ManagedService(
  {
    serverName,
    homeserver: origin,
    publicUrl: resource,
    stateDir: dir,
    asToken: "a".repeat(48),
    hsToken: "h".repeat(48),
    // No externalIdentity, OAuth provider, product role or WW configuration.
  },
  {
    provision: async () => {},
    transport: (agent) => ({
      identity: async () => agent.matrixId,
      sync: async (since) => {
        await delay(10);
        return { next_batch: since ?? "0" };
      },
      state: async () => [],
      history: async () => ({ events: [] }),
      send: async () => "$fixture",
      stop: () => {},
    }),
  },
);
const existingSender = await service.create(owner, "client");
const managed = createManagedApp(service);
server.on("request", async (request, response) => {
  const path = new URL(request.url, origin).pathname;
  const token = request.headers.authorization?.replace("Bearer ", "") ?? "";
  const send = (status, value) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  if (path.startsWith("/_synapse/admin/")) {
    assert.equal(token, "matrix-fixture-admin");
    if (path.startsWith("/_synapse/admin/v1/auth_providers/")) return send(200, { user_id: owner });
    if (path.startsWith("/_synapse/admin/v2/users/")) return send(200, account);
    if (path.endsWith("/login")) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const expiresAt = JSON.parse(raw).valid_until_ms;
      assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 120000);
      const accessToken = `syt_fixture_${++sequence}`;
      nativeTokens.set(accessToken, { owner, expiresAt });
      return send(200, { access_token: accessToken });
    }
  }
  if (path === "/_matrix/client/v3/account/whoami") {
    const credential = nativeTokens.get(token);
    if (!credential || credential.expiresAt <= Date.now()) return send(401, { errcode: "M_UNKNOWN_TOKEN" });
    return send(200, { user_id: credential.owner });
  }
  if (path === "/_matrix/client/v3/logout") {
    nativeTokens.delete(token);
    return send(200, {});
  }
  if (path.startsWith("/_agent-router/")) {
    if (token) {
      assert.ok(token.startsWith("syt_fixture_"));
      routerTokens.push(token);
    }
    assert.ok(!path.includes("/auth/exchange"), "product exchange must not run inside Router");
    return managed(request, response);
  }
  return send(404, {});
});
const actualFetch = globalThis.fetch;
let denyWW = false;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith(ww) && denyWW) throw new Error("synthetic WW outage");
  if (url === `${ww}/v1/network/sessions`) {
    const token = new Headers(init.headers).get("Authorization").replace("Bearer ", "");
    assert.notEqual(token, accountToken);
    oauthTokens.push(token);
  }
  return actualFetch(input, init);
};
const registration = {
  client_id: clientId,
  client_name: "OpenGrove Desktop",
  application_type: "native",
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uri: "http://127.0.0.1/oauth/callback",
  scopes: ["openid", "profile", "network.connect", "offline_access"],
  jwks: { keys: [] },
  enabled: true,
};
let configured = await actualFetch(`${ww}/v1/admin/website-oauth/clients/${clientId}`, {
  method: "PUT",
  headers: { "content-type": "application/json", Authorization: `Bearer ${accountToken}` },
  body: JSON.stringify(registration),
});
assert.equal(configured.status, 200, await configured.text());
configured = await actualFetch(`${ww}/interop/network`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: resource, homeserver: origin, server_name: serverName }),
});
assert.equal(configured.status, 204, await configured.text());
const network = new AgentNetworkSessions({ baseUrl: resource, provider: "opengrove" });
network.observe({ accountIssuer: ww, accountUserId: "42" });
const cookies = new Map();
async function page(url, values) {
  const response = await actualFetch(new URL(url, ww), {
    redirect: "manual",
    method: values ? "POST" : "GET",
    headers: {
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...(values ? { "content-type": "application/x-www-form-urlencoded", origin: ww } : {}),
    },
    body: values ? new URLSearchParams(values) : undefined,
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [k, v] = cookie.split(";")[0].split("=");
    cookies.set(k, v);
  }
  return response;
}
async function authorize(url) {
  const start = await page(url);
  assert.equal(start.status, 302, await start.text());
  const loginURL = new URL(start.headers.get("location"), ww);
  const request = loginURL.searchParams.get("request");
  const login = await page(loginURL);
  assert.equal(login.status, 200);
  const csrf = cookies.get("__Host-og-csrf");
  let consent;
  if ((await login.text()).includes("邮箱验证码")) {
    const signed = await page("/oauth/login", { csrf, request, email: "editor@example.test", code: "123456" });
    assert.equal(signed.status, 303, await signed.text());
    consent = await page(signed.headers.get("location"));
  } else {
    consent = login;
  }
  assert.equal(consent.status, 200);
  const approved = await page("/oauth/consent", { csrf, request, decision: "allow" });
  assert.equal(approved.status, 303, await approved.text());
  const returned = await page(approved.headers.get("location"));
  assert.equal(returned.status, 302);
  const callback = await actualFetch(returned.headers.get("location"));
  assert.equal(callback.status, 200, await callback.text());
}
try {
  await assert.rejects(network.connect(), /remote_oauth_required/);
  await authorize(await network.beginAuthorization());
  const connection = await network.connect();
  assert.equal(connection.binding.owner, owner, "legacy native owner survives migration");
  assert.equal(connection.sender.id, existingSender.id, "the pre-existing sender survives migration");
  const agents = await connection.request(({ client }) => client.agents());
  assert.equal(agents[0].id, connection.sender.id);
  assert.ok(routerTokens.length > 0 && oauthTokens.length === 1);
  assert.ok(routerTokens.every((token) => !oauthTokens.includes(token) && token !== accountToken));
  denyWW = true;
  await connection.request(({ client }) => client.agents());
  denyWW = false;
  const response = await page("/oauth/authorizations/revoke", {
    csrf: cookies.get("__Host-og-csrf"),
    client_id: clientId,
  });
  assert.equal(response.status, 303, await response.text());
  // Revocation prevents renewal. Existing native credentials have a hard two-minute
  // limit; expire the homeserver fixture's clock instead of sleeping two minutes.
  await connection.request(({ client }) => client.agents());
  for (const credential of nativeTokens.values()) credential.expiresAt = 0;
  await assert.rejects(
    connection.request(({ client }) => client.agents()),
    /remote_oauth_required/,
  );
  await network.clear();
  network.observe({ accountIssuer: ww, accountUserId: "42" });
  await authorize(await network.beginAuthorization());
  const renewed = await network.connect();
  assert.equal(renewed.binding.owner, connection.binding.owner);
  assert.equal(renewed.sender.id, connection.sender.id);
  await network.clear();
  for (let attempt = 0; nativeTokens.size && attempt < 100; attempt++) await delay(10);
  assert.equal(nativeTokens.size, 0, "logout revokes native credentials at the homeserver");
  console.log(
    "PASS: WW PKCE + native-client registration + product-owned identity integration + unchanged Router + OAuth never reaches Router + bounded revocation + stable owner/sender + Router works during WW outage",
  );
} finally {
  denyWW = false;
  await network.clear();
  server.close();
  server.closeAllConnections();
  await service.close();
  globalThis.fetch = actualFetch;
  await rm(dir, { recursive: true, force: true });
}
