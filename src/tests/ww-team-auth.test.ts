import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startOpenGroveServer } from "../server/create-server.js";

interface TestUser {
  user_id: string;
  email: string;
  roles: string[];
  status: string;
}

interface TestResponse {
  required?: boolean;
  satisfied?: boolean;
  authenticated?: boolean;
  previousAccount?: string;
  reason?: string;
  error?: string;
  user?: { email: string };
}

const teamToken = "synthetic-team-admission-test-token-000000";
const access = new Map<string, TestUser>();
const refresh = new Map<string, string>();
const users: Record<string, TestUser> = {
  "fixture@example.test": { user_id: "fixture", email: "fixture@example.test", roles: ["reviewer"], status: "active" },
  "fixture-two@example.test": {
    user_id: "fixture-two",
    email: "fixture-two@example.test",
    roles: [],
    status: "active",
  },
  "real@example.org": { user_id: "real", email: "real@example.org", roles: ["user"], status: "active" },
};
let serial = 0;
let unavailableProfileEmail: string | undefined;
let bridge: Server;
let upstream: Server;
let root: string;
let base: string;
const previousEnv = new Map<string, string | undefined>();

function pair(email: string) {
  const user = users[email];
  assert.ok(user);
  const id = ++serial;
  const data = {
    access_token: `access-${id}`,
    refresh_token: `refresh-${id}`,
    access_token_expires_in: 3600,
    refresh_token_expires_in: 86400,
    token_type: "Bearer",
  };
  access.set(data.access_token, user);
  refresh.set(data.refresh_token, email);
  return data;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "opengrove-team-auth-"));
  upstream = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, string>;
    const ok = (data: unknown) => send(response, 200, { data });
    const fail = (status: number, code: number, message: string) =>
      send(response, status, { error: { code, message } });
    const gated = ["/v1/auth/team/accounts", "/v1/auth/team/login", "/v1/auth/email-login", "/v1/auth/email-codes"];
    if (gated.includes(path) && request.headers["x-team-token"] !== teamToken)
      return fail(401, 110201, "team token invalid");
    if (path === "/v1/auth/team/status")
      return ok({ required: true, satisfied: request.headers["x-team-token"] === teamToken });
    if (path === "/v1/auth/team/accounts")
      return ok([users["fixture@example.test"], users["fixture-two@example.test"]]);
    if (path === "/v1/auth/team/login") {
      if (!body.email?.endsWith("@example.test") || !users[body.email]) return fail(404, 404, "fixture missing");
      return ok(pair(body.email));
    }
    if (path === "/v1/auth/email-codes") return ok({});
    if (path === "/v1/auth/email-login") {
      if (body.email !== "real@example.org" || body.code !== "123456") return fail(401, 110201, "invalid login");
      return ok(pair(body.email));
    }
    if (path === "/v1/auth/logout") {
      refresh.delete(body.refresh_token ?? "");
      return ok({ ok: true });
    }
    if (path === "/v1/auth/token/refresh") {
      const email = refresh.get(body.refresh_token ?? "");
      if (!email) return fail(401, 110202, "refresh invalid");
      refresh.delete(body.refresh_token ?? "");
      return ok(pair(email));
    }
    if (path === "/v1/users/me") {
      const user = access.get(request.headers.authorization?.replace("Bearer ", "") ?? "");
      if (unavailableProfileEmail && user?.email === unavailableProfileEmail)
        return fail(503, 503, "profile temporarily unavailable");
      return user ? ok(user) : fail(401, 110201, "access invalid");
    }
    if (path === "/v1/api-keys") {
      if (request.method === "GET") return ok([]);
      return ok({
        id: String(serial),
        name: "OpenGrove WW Provider",
        api_key: "sk-synthetic",
        key_prefix: "sk-test",
        status: "active",
      });
    }
    if (path === "/v1/app-store/install-policy")
      return send(response, 200, { policyKey: "standard", assignmentSource: "default", apps: [] });
    if (path === "/v1/app-store/packages") return send(response, 200, { packages: [] });
    return fail(404, 404, "not found");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  for (const [key, value] of Object.entries({
    OPENGROVE_WW_BASE_URL: `http://127.0.0.1:${address.port}`,
    OPENGROVE_WEB_AUTH_MODE: "session",
    OPENGROVE_DATA_DIR: root,
    OPENGROVE_USER_DATA_DIR: join(root, "user"),
    OPENGROVE_DIAGNOSTICS_DIR: join(root, "diagnostics"),
  })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  bridge = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    runtimeEnvironment: "web-single",
    statePath: join(root, "state.json"),
  });
  if (!bridge.listening) await once(bridge, "listening");
  const bridgeAddress = bridge.address();
  assert.ok(bridgeAddress && typeof bridgeAddress !== "string");
  base = `http://127.0.0.1:${bridgeAddress.port}/api`;
});

after(async () => {
  for (const server of [bridge, upstream]) {
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function call(path: string, body?: unknown, cookie?: string) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const cookies = response.headers.getSetCookie();
  return {
    status: response.status,
    body: (await response.json()) as TestResponse,
    cookies,
    cookie: cookies.map((x) => x.split(";")[0]).join("; "),
  };
}

test("team admission belongs to the browser that supplied the token", async () => {
  const admitted = await call("/auth/team-unlock", { token: teamToken });
  assert.equal(admitted.status, 200);
  assert.equal((await call("/auth/team-status")).body.satisfied, false);
  assert.equal((await call("/auth/team-accounts")).status, 401);
  assert.equal((await call("/auth/team-signin", { email: "fixture@example.test" })).status, 401);
  assert.equal((await call("/auth/email-codes", { email: "real@example.org" })).status, 401);
  assert.equal((await call("/auth/login", { email: "real@example.org", code: "123456" })).status, 401);
  assert.ok(
    admitted.cookies.some((cookie) => cookie.startsWith("opengrove_auth_team=") && cookie.includes("HttpOnly")),
  );
  assert.ok(!admitted.cookie.includes(teamToken));
  assert.equal((await call("/auth/team-status", undefined, admitted.cookie)).body.satisfied, true);
  assert.equal((await call("/auth/team-accounts", undefined, admitted.cookie)).status, 200);
  assert.equal((await call("/auth/email-codes", { email: "real@example.org" }, admitted.cookie)).status, 200);
  const signedIn = await call("/auth/team-signin", { email: "fixture@example.test" }, admitted.cookie);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.user?.email, "fixture@example.test");
});

async function loginRealAccount(): Promise<string> {
  const admitted = await call("/auth/team-unlock", { token: teamToken });
  const signedIn = await call("/auth/login", { email: "real@example.org", code: "123456" }, admitted.cookie);
  assert.equal(signedIn.status, 200);
  return `${admitted.cookie}; ${signedIn.cookie}`;
}

function cookieValue(cookie: string, name: string): string {
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  assert.ok(value);
  return value;
}

test("restoring an account requires the matching private session credentials", async () => {
  const original = await loginRealAccount();
  const switched = await call("/auth/team-signin", { email: "fixture@example.test" }, original);
  assert.equal(switched.status, 200);
  const sessionId = cookieValue(switched.cookie, "opengrove_auth_session");
  const forged = `${sessionId}; opengrove_auth_refresh=invalid`;
  assert.equal((await call("/auth/team-status", undefined, forged)).body.previousAccount, undefined);
  assert.notEqual((await call("/auth/team-restore", {}, forged)).status, 200);

  // A different login to the same shared fixture account must not be enough.
  const other = await call("/auth/team-signin", { email: "fixture@example.test" }, original);
  const mixed = `${sessionId}; ${cookieValue(other.cookie, "opengrove_auth_access")}; ${cookieValue(other.cookie, "opengrove_auth_refresh")}`;
  assert.notEqual((await call("/auth/team-restore", {}, mixed)).status, 200);
  const restored = await call("/auth/team-restore", {}, switched.cookie);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.user?.email, "real@example.org");
});

test("logout revokes admission and removes the previous account even for cookie replay", async () => {
  const original = await loginRealAccount();
  const switched = await call("/auth/team-signin", { email: "fixture@example.test" }, original);
  const cookie = `${cookieValue(original, "opengrove_auth_team")}; ${switched.cookie}`;
  const otherBrowser = await call("/auth/team-unlock", { token: teamToken });
  assert.equal((await call("/auth/team-status", undefined, cookie)).body.previousAccount, "real@example.org");
  assert.equal((await call("/auth/logout", {}, cookie)).status, 200);
  assert.equal((await call("/auth/team-status", undefined, cookie)).body.satisfied, false);
  assert.equal((await call("/auth/team-status", undefined, cookie)).body.previousAccount, undefined);
  assert.notEqual((await call("/auth/team-restore", {}, cookie)).status, 200);
  assert.equal((await call("/auth/team-status", undefined, otherBrowser.cookie)).body.satisfied, true);
});

test("the original account remains restorable across switches and refresh rotation", async () => {
  const original = await loginRealAccount();
  const admission = cookieValue(original, "opengrove_auth_team");
  const first = await call("/auth/team-signin", { email: "fixture@example.test" }, original);
  const second = await call(
    "/auth/team-signin",
    { email: "fixture-two@example.test" },
    `${admission}; ${first.cookie}`,
  );
  assert.equal(second.status, 200);
  const expired = second.cookie.replace(/opengrove_auth_access=[^;]+/, "opengrove_auth_access=expired");
  const rotated = await call("/auth/session", undefined, expired);
  assert.equal(rotated.body.authenticated, true);
  assert.ok(rotated.cookie.includes("opengrove_auth_refresh="));
  const restored = await call("/auth/team-restore", {}, rotated.cookie);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.user?.email, "real@example.org");
  assert.equal((await call("/auth/team-status", undefined, restored.cookie)).body.previousAccount, undefined);
});

test("failed account switches preserve the current session and its cookies", async () => {
  const original = await loginRealAccount();
  const failed = await call("/auth/team-signin", { email: "missing@example.test" }, original);
  assert.equal(failed.status, 404);
  assert.deepEqual(failed.cookies, []);
  const current = await call("/auth/session", undefined, original);
  assert.equal(current.body.authenticated, true);
  assert.equal(current.body.user?.email, "real@example.org");
});

test("a profile outage after rotating the original token leaves restoration retryable", async () => {
  const original = await loginRealAccount();
  const switched = await call("/auth/team-signin", { email: "fixture@example.test" }, original);
  unavailableProfileEmail = "real@example.org";
  try {
    const failed = await call("/auth/team-restore", {}, switched.cookie);
    assert.ok(failed.status >= 500);
    assert.equal(
      (await call("/auth/team-status", undefined, switched.cookie)).body.previousAccount,
      "real@example.org",
    );
  } finally {
    unavailableProfileEmail = undefined;
  }
  const restored = await call("/auth/team-restore", {}, switched.cookie);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.user?.email, "real@example.org");
});
