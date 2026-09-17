import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NetworkOAuth } from "../server/remote-agents/oauth.js";
import { startRemoteAgentService } from "./fixtures/remote-agent-service.js";

for (const phase of ["refresh", "userinfo"] as const) {
  test(`temporary ${phase} failure preserves the authorization and does not revoke it`, async (t) => {
    const fixture = await startRemoteAgentService();
    const oauth = new NetworkOAuth(
      { accountIssuer: fixture.baseUrl, accountUserId: "admin" },
      fixture.serviceUrl,
      true,
    );
    t.after(async () => {
      oauth.clear();
      await fixture.close();
    });
    fixture.oauth.expireSoon();
    await fixture.oauth.authorize(await oauth.begin(), "admin");
    fixture.oauth.failures[phase] = 503;
    await assert.rejects(oauth.accessToken(), /remote_authorization_unavailable/);
    fixture.oauth.failures[phase] = 0;
    assert.match(await oauth.accessToken(), /^oauth-admin-2$/);
    assert.deepEqual(fixture.oauth.revoked, []);
    assert.equal(
      fixture.oauth.requests.filter((request) => request === "refresh_token").length,
      phase === "refresh" ? 2 : 1,
    );
  });
}

test("native authorization validates state, binds the current account and renews only at WW", async (t) => {
  const fixture = await startRemoteAgentService();
  const oauth = new NetworkOAuth({ accountIssuer: fixture.baseUrl, accountUserId: "admin" }, fixture.serviceUrl, true);
  t.after(async () => {
    oauth.clear();
    await fixture.close();
  });
  await assert.rejects(oauth.accessToken(), /remote_oauth_required/);
  fixture.oauth.expireSoon();
  fixture.oauth.registeredScopes.push("data.write", "models.invoke");
  const url = await oauth.begin();
  assert.equal(await oauth.begin(), url, "concurrent starts share one authorization");
  const authorize = new URL(url);
  assert.equal(authorize.origin, fixture.baseUrl);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("scope"), "openid profile network.connect offline_access");
  const bad = new URL(authorize.searchParams.get("redirect_uri")!);
  bad.searchParams.set("state", "wrong-state");
  bad.searchParams.set("code", "arbitrary");
  assert.equal((await fetch(bad)).status, 400);
  await fixture.oauth.authorize(url, "admin");
  const [first, concurrent] = await Promise.all([oauth.accessToken(), oauth.accessToken()]);
  assert.equal(first, concurrent, "a one-time refresh token is not used concurrently");
  assert.match(first, /^oauth-admin-2$/, "initial access was renewed at the issuer");
  assert.equal(fixture.exchanges.length, 0, "authorization and refresh never call Router");
  oauth.clear();
  await assert.rejects(oauth.accessToken());
});

test("cancel closes the loopback listener and a fresh attempt uses new state", async (t) => {
  const fixture = await startRemoteAgentService();
  const oauth = new NetworkOAuth({ accountIssuer: fixture.baseUrl, accountUserId: "admin" }, fixture.serviceUrl, true);
  t.after(async () => {
    oauth.clear();
    await fixture.close();
  });
  const first = new URL(await oauth.begin());
  oauth.cancel();
  await assert.rejects(fetch(first.searchParams.get("redirect_uri")!));
  const next = new URL(await oauth.begin());
  oauth.cancel(first.searchParams.get("state")!);
  assert.equal(
    oauth.authorizationStatus(next.searchParams.get("state")!).status,
    "pending",
    "a late cancellation cannot stop a newer attempt",
  );
  assert.notEqual(first.searchParams.get("state"), next.searchParams.get("state"));
  assert.notEqual(first.searchParams.get("code_challenge"), next.searchParams.get("code_challenge"));
  await fixture.oauth.authorize(next.toString(), "admin");
  assert.match(await oauth.accessToken(), /^oauth-admin-/);
});

test("an ambiguous refresh response does not replay a possibly consumed token or revoke the grant", async (t) => {
  const fixture = await startRemoteAgentService();
  const oauth = new NetworkOAuth({ accountIssuer: fixture.baseUrl, accountUserId: "admin" }, fixture.serviceUrl, true);
  t.after(async () => {
    oauth.clear();
    await fixture.close();
  });
  fixture.oauth.expireSoon();
  await fixture.oauth.authorize(await oauth.begin(), "admin");
  fixture.oauth.failures.refresh = 502;
  fixture.oauth.failures.refreshHtml = true;
  await assert.rejects(oauth.accessToken(), /remote_authorization_unavailable/);
  assert.equal(await oauth.accessToken(), "oauth-admin-1", "the unexpired access token is retained");
  const later = Date.now() + 46_000;
  t.mock.method(Date, "now", () => later);
  await assert.rejects(oauth.accessToken(), /remote_oauth_required/);
  assert.equal(fixture.oauth.requests.filter((request) => request === "refresh_token").length, 1);
  assert.deepEqual(fixture.oauth.revoked, []);
});

test("an explicitly rejected refresh requires new consent", async (t) => {
  const fixture = await startRemoteAgentService();
  const oauth = new NetworkOAuth({ accountIssuer: fixture.baseUrl, accountUserId: "admin" }, fixture.serviceUrl, true);
  t.after(async () => {
    oauth.clear();
    await fixture.close();
  });
  fixture.oauth.expireSoon();
  await fixture.oauth.authorize(await oauth.begin(), "admin");
  fixture.oauth.failures.refresh = 400;
  fixture.oauth.failures.refreshError = "invalid_grant";
  await assert.rejects(oauth.accessToken(), /remote_oauth_required/);
  await assert.rejects(oauth.accessToken(), /remote_oauth_required/);
});

test("logout during refreshed identity validation revokes the newly issued credential", async (t) => {
  const fixture = await startRemoteAgentService();
  const oauth = new NetworkOAuth({ accountIssuer: fixture.baseUrl, accountUserId: "admin" }, fixture.serviceUrl, true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    oauth.clear();
    await fixture.close();
  });
  fixture.oauth.expireSoon();
  await fixture.oauth.authorize(await oauth.begin(), "admin");
  let reached!: () => void;
  const validating = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    if (String(args[0]).endsWith("/v1/oauth/userinfo")) {
      reached();
      await gate;
    }
    return response;
  });
  const pending = assert.rejects(oauth.accessToken());
  await validating;
  oauth.clear();
  release();
  await pending;
  for (let i = 0; i < 50 && fixture.oauth.revoked.length < 2; i++) await delay(10);
  assert.equal(fixture.oauth.revoked.length, 2, "both old and newly rotated credentials must be revoked");
});

test("an unattended authorization expires and closes its callback after ten minutes", async (t) => {
  const fixture = await startRemoteAgentService();
  const oauth = new NetworkOAuth({ accountIssuer: fixture.baseUrl, accountUserId: "admin" }, fixture.serviceUrl, true);
  t.after(async () => {
    oauth.clear();
    await fixture.close();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const url = new URL(await oauth.begin());
  t.mock.timers.tick(10 * 60_000);
  assert.equal(oauth.authorizationStatus().error, "remote_authorization_expired");
  t.mock.timers.reset();
  await assert.rejects(fetch(url.searchParams.get("redirect_uri")!));
});

test("authorizing another browser account cannot adopt the current local account", async (t) => {
  const fixture = await startRemoteAgentService();
  const oauth = new NetworkOAuth({ accountIssuer: fixture.baseUrl, accountUserId: "admin" }, fixture.serviceUrl, true);
  t.after(async () => {
    oauth.clear();
    await fixture.close();
  });
  const url = new URL(await oauth.begin());
  url.searchParams.set("test_user", "other");
  assert.equal((await fetch(url)).status, 400);
  await assert.rejects(oauth.accessToken(), /remote_account_changed/);
  await assert.rejects(oauth.accessToken(), /remote_oauth_required/);
  assert.equal(fixture.exchanges.length, 0);
});
