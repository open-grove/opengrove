import assert from "node:assert/strict";
import { test } from "node:test";
import { NetworkOAuth } from "../server/remote-agents/oauth.js";
import { startRemoteAgentService } from "./fixtures/remote-agent-service.js";

test("native authorization validates state, binds the current account and renews only at WW", async (t) => {
  const fixture = await startRemoteAgentService();
  const oauth = new NetworkOAuth({ accountIssuer: fixture.baseUrl, accountUserId: "admin" }, fixture.serviceUrl, true);
  t.after(async () => {
    oauth.clear();
    await fixture.close();
  });
  await assert.rejects(oauth.accessToken(), /remote_oauth_required/);
  fixture.oauth.expireSoon();
  const url = await oauth.begin();
  assert.equal(await oauth.begin(), url, "concurrent starts share one authorization");
  const authorize = new URL(url);
  assert.equal(authorize.origin, fixture.baseUrl);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
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
  assert.notEqual(first.searchParams.get("state"), next.searchParams.get("state"));
  assert.notEqual(first.searchParams.get("code_challenge"), next.searchParams.get("code_challenge"));
  await fixture.oauth.authorize(next.toString(), "admin");
  assert.match(await oauth.accessToken(), /^oauth-admin-/);
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
