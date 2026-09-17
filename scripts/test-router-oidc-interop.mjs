import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { AgentNetworkSessions } from "../dist/server/remote-agents/client.js";

// Invoked by WW TestWWRouterInterop. Every credential belongs to its disposable fixture.
const ww = process.env.ROUTER_INTEROP_WW_URL;
const accountToken = process.env.ROUTER_INTEROP_ACCOUNT_TOKEN;
const routerRoot = process.env.AGENT_ROUTER_INTEROP_ROOT;
assert.ok(ww && accountToken && routerRoot, "run WW's TestWWRouterInterop with both built checkouts");
const { ManagedService, createManagedApp } = await import(pathToFileURL(join(routerRoot, "dist/matrix/managed.js")));
const dir = await mkdtemp(join(tmpdir(), "router-oidc-interop-"));
const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const exported = await crypto.subtle.exportKey("jwk", keys.privateKey);
const { kty, crv, x, y, d } = exported;
const privateJwk = { kty, crv, x, y, d, kid: "interop", alg: "ES256" };
const publicJwk = { kty, crv, x, y, kid: "interop", alg: "ES256", use: "sig" };
const server = createServer({
  cert: await readFile(process.env.ROUTER_INTEROP_CERT),
  key: await readFile(process.env.ROUTER_INTEROP_KEY),
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const resource = `https://127.0.0.1:${server.address().port}/_agent-router/v1`;
const clientId = `router-${createHash("sha256").update(resource).digest("hex")}`;
const native = {
  client_id: clientId,
  client_name: "Interop Router",
  kind: "router-native",
  router_url: resource,
  redirect_uri: "http://127.0.0.1/oauth/callback",
  scopes: ["openid", "profile", "router.connect", "offline_access"],
  jwks: { keys: [] },
  enabled: true,
};
for (const registration of [
  native,
  {
    ...native,
    client_id: `${clientId}-verifier`,
    kind: "router-verifier",
    redirect_uri: "",
    scopes: [],
    jwks: { keys: [publicJwk] },
  },
]) {
  const response = await fetch(`${ww}/v1/admin/website-oauth/clients/${registration.client_id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", Authorization: `Bearer ${accountToken}` },
    body: JSON.stringify(registration),
  });
  assert.equal(response.status, 200, await response.text());
}
const actualFetch = globalThis.fetch;
const matrix = new Map();
const routerTokens = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://matrix.example/_synapse/admin/v2/users/")) {
    const name = decodeURIComponent(url.split("/").at(-1));
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer matrix-fixture-admin");
    if (init.method === "PUT") {
      matrix.set(name, { name, admin: false, deactivated: false, external_ids: JSON.parse(init.body).external_ids });
      return Response.json({ name }, { status: 201 });
    }
    return matrix.has(name) ? Response.json(matrix.get(name)) : Response.json({}, { status: 404 });
  }
  if (url === `${resource}/auth/exchange`) {
    const body = JSON.parse(init.body);
    routerTokens.push(body.accessToken);
    assert.notEqual(body.accessToken, accountToken);
    assert.notEqual(body.accessToken.split(".").length, 3, "Router received a primary JWT");
  }
  return actualFetch(input, init);
};
const service = new ManagedService(
  {
    serverName: new URL(resource).host,
    homeserver: "https://matrix.example",
    publicUrl: resource,
    stateDir: dir,
    asToken: "a".repeat(48),
    hsToken: "h".repeat(48),
    externalIdentity: {
      adminToken: "matrix-fixture-admin",
      providers: {
        opengrove: {
          issuer: "legacy-account-namespace",
          oidcIssuer: ww,
          clientId,
          introspectionClientId: `${clientId}-verifier`,
          privateJwk,
          requiredRoles: ["admin"],
        },
      },
    },
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
server.on("request", createManagedApp(service));
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
  const authorizationUrl = await network.beginAuthorization();
  assert.equal(new URL(authorizationUrl).origin, ww);
  await authorize(authorizationUrl);
  const connection = await network.connect();
  const agents = await connection.request(({ client }) => client.agents());
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, connection.sender.id);
  assert.equal(routerTokens.length, 1);
  assert.equal(matrix.size, 1);
  // Revoke via the central user's consent screen, then check the existing Router session.
  const grants = await page("/oauth/authorizations");
  assert.equal(grants.status, 200);
  const response = await page("/oauth/authorizations/revoke", {
    csrf: cookies.get("__Host-og-csrf"),
    client_id: clientId,
  });
  assert.equal(response.status, 303, await response.text());
  await assert.rejects(connection.request(({ client }) => client.agents()));
  await network.clear();
  // A fresh authorization retains the stable Router owner/sender namespace.
  network.observe({ accountIssuer: ww, accountUserId: "42" });
  await authorize(await network.beginAuthorization());
  const renewed = await network.connect();
  assert.equal(renewed.binding.owner, connection.binding.owner);
  assert.equal(renewed.sender.id, connection.sender.id);
  await network.clear();
  console.log(
    "PASS: WW native PKCE + signed ID token + Host callback + Router private_key_jwt introspection + scoped-only exchange + live revocation + stable sender",
  );
} finally {
  await network.clear();
  server.close();
  server.closeAllConnections();
  await service.close();
  globalThis.fetch = actualFetch;
  await rm(dir, { recursive: true, force: true });
}
