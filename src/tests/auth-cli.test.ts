import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isAuthWorkflowCommand, runAuthCommand } from "../cli/auth-command.js";
import { readCliAuthState, writeCliAuthState } from "../cli/auth-state.js";
import { resolveCliBridge } from "../cli/bridge-connection.js";
import { createCliOpenGroveClient } from "../cli/client.js";
import { runHostOperationCommand } from "../cli/host-operation-command.js";

const bridgeApiUrl = "http://127.0.0.1:43123/api";
const user = {
  userId: "user-1",
  email: "user@example.test",
  displayName: "CLI User",
  role: "admin",
};

test("friendly auth commands coexist with canonical Protocol commands", () => {
  assert.equal(isAuthWorkflowCommand(["auth", "login"]), true);
  assert.equal(isAuthWorkflowCommand(["auth", "--help"]), true);
  assert.equal(isAuthWorkflowCommand(["auth", "session", "get"]), false);
});

test("auth help recommends the friendly status command", async () => {
  const result = await runAuthCommand(["--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /Recommended for checking login state: opengrove auth status/u);
});

test("global auth login persists one CLI session used by later Host commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-auth-cli-"));
  const authPath = join(root, "cli-auth.json");
  const requests: Array<{ url: string; cookie: string | null }> = [];
  try {
    const loginFetch = createFetch((url, init) => {
      requests.push({ url, cookie: new Headers(init?.headers).get("cookie") });
      if (url.endsWith("/opengrove-probe")) return json({ ok: true, product: "OpenGrove", stateId: "state-1" });
      if (url.endsWith("/api/auth/email-codes")) return json({ ok: true });
      if (url.endsWith("/api/auth/login")) {
        return json(
          { user, isNewUser: false },
          200,
          cookies(
            "opengrove_auth_access=access-1; Path=/; Max-Age=300; HttpOnly",
            "opengrove_auth_refresh=refresh-1; Path=/; Max-Age=3600; HttpOnly",
          ),
        );
      }
      if (url.endsWith("/api/auth/session")) {
        return json(
          { status: "authenticated", authenticated: true, verification: "verified", user },
          200,
          cookies("opengrove_auth_refresh=refresh-2; Path=/; Max-Age=3600; HttpOnly"),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const login = await runAuthCommand(["login", "--email", user.email, "--base-url", bridgeApiUrl], {
      authPath,
      fetch: loginFetch,
      prompt: async () => "123456",
    });
    assert.equal(login.exitCode, 0, login.stderr);
    assert.doesNotMatch(login.stdout ?? "", /refresh-[12]|access-1/u);
    const saved = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
    assert.equal(saved.bridgeApiUrl, bridgeApiUrl);
    assert.equal(saved.stateId, "state-1");
    assert.deepEqual(saved.cookies, {
      opengrove_auth_access: "access-1",
      opengrove_auth_refresh: "refresh-2",
    });
    if (process.platform !== "win32") assert.equal((await stat(authPath)).mode & 0o077, 0);
    assert.equal(
      requests.find((request) => request.url.endsWith("/api/auth/session"))?.cookie,
      "opengrove_auth_access=access-1; opengrove_auth_refresh=refresh-1",
    );

    const statusCookies: Array<string | null> = [];
    const status = await runAuthCommand(["status", "--base-url", bridgeApiUrl], {
      authPath,
      fetch: createFetch((url, init) => {
        if (url.endsWith("/opengrove-probe")) {
          return json({ ok: true, product: "OpenGrove", stateId: "state-1" });
        }
        statusCookies.push(new Headers(init?.headers).get("cookie"));
        return json({ status: "authenticated", authenticated: true, verification: "verified", user });
      }),
    });
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout ?? "{}").identity, "user");
    assert.deepEqual(statusCookies, ["opengrove_auth_access=access-1; opengrove_auth_refresh=refresh-2"]);

    const roomCookies: Array<string | null> = [];
    const room = await runHostOperationCommand(
      ["room", "message", "create", "--room-id", "room-1", "--text", "hello"],
      {
        createClient: (config) => createCliOpenGroveClient({ ...config, authPath }),
        fetch: createFetch((url, init) => {
          if (url.endsWith("/opengrove-probe")) {
            return json({ ok: true, product: "OpenGrove", stateId: "state-1" });
          }
          roomCookies.push(new Headers(init?.headers).get("cookie"));
          return json(
            roomMessageResponse,
            200,
            cookies("opengrove_auth_refresh=refresh-3; Path=/; Max-Age=3600; HttpOnly"),
          );
        }),
      },
    );
    assert.equal(room.exitCode, 0, room.stderr);
    assert.deepEqual(roomCookies, ["opengrove_auth_access=access-1; opengrove_auth_refresh=refresh-2"]);
    const rotated = JSON.parse(await readFile(authPath, "utf8")) as { cookies: Record<string, string> };
    assert.equal(rotated.cookies.opengrove_auth_refresh, "refresh-3");

    const logout = await runAuthCommand(["logout", "--base-url", bridgeApiUrl], {
      authPath,
      fetch: createFetch((url) => {
        if (url.endsWith("/opengrove-probe")) return json({ ok: true, product: "OpenGrove", stateId: "state-1" });
        if (url.endsWith("/api/auth/logout")) return json({ ok: true });
        throw new Error(`Unexpected URL: ${url}`);
      }),
    });
    assert.equal(logout.exitCode, 0, logout.stderr);
    await assert.rejects(readFile(authPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI discovers a dynamic local Bridge and verifies its identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-auth-cli-discovery-"));
  const discoveryPath = join(root, "bridge-info.json");
  try {
    await writeFile(discoveryPath, `${JSON.stringify({ apiUrl: bridgeApiUrl, stateId: "untrusted-hint" })}\n`, "utf8");
    const connection = await resolveCliBridge({
      baseUrl: "http://127.0.0.1:37371/api",
      baseUrlSource: "default",
      discoveryPaths: [discoveryPath],
      fetch: createFetch((url) => {
        assert.equal(url, "http://127.0.0.1:43123/opengrove-probe");
        return json({ ok: true, product: "OpenGrove", stateId: "verified-state" });
      }),
    });
    assert.deepEqual(connection, { apiUrl: bridgeApiUrl, stateId: "verified-state" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI rejects persisted credentials without a Bridge identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-auth-cli-invalid-state-"));
  const authPath = join(root, "cli-auth.json");
  try {
    await writeFile(
      authPath,
      `${JSON.stringify({
        version: 1,
        bridgeApiUrl,
        stateId: " ",
        cookies: { opengrove_auth_refresh: "refresh-secret" },
        savedAt: "2026-09-02T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    assert.equal(readCliAuthState(authPath), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed auth login never replaces an existing CLI session", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-auth-cli-failure-"));
  const authPath = join(root, "cli-auth.json");
  try {
    await writeCliAuthState(
      {
        bridgeApiUrl,
        stateId: "state-old",
        email: "old@example.test",
        cookies: { opengrove_auth_refresh: "refresh-old" },
      },
      authPath,
    );
    const before = await readFile(authPath, "utf8");
    const result = await runAuthCommand(["login", "--email", user.email, "--base-url", bridgeApiUrl], {
      authPath,
      prompt: async () => "123456",
      fetch: createFetch((url) => {
        if (url.endsWith("/opengrove-probe")) return json({ ok: true, product: "OpenGrove", stateId: "state-new" });
        if (url.endsWith("/api/auth/email-codes")) {
          return json({ ok: true }, 200, cookies("opengrove_auth_refresh=refresh-unverified; Path=/; Max-Age=3600"));
        }
        if (url.endsWith("/api/auth/login")) return json({ error: "verification_code_invalid" }, 401);
        throw new Error(`Unexpected URL: ${url}`);
      }),
    });
    assert.equal(result.exitCode, 3);
    assert.equal(await readFile(authPath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stored CLI credentials are never sent to a different Bridge identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-auth-cli-identity-"));
  const authPath = join(root, "cli-auth.json");
  const cookiesSeen: Array<string | null> = [];
  try {
    await writeCliAuthState(
      {
        bridgeApiUrl,
        stateId: "state-paired",
        cookies: { opengrove_auth_refresh: "refresh-secret" },
      },
      authPath,
    );
    const result = await runHostOperationCommand(
      ["room", "message", "create", "--room-id", "room-1", "--base-url", bridgeApiUrl],
      {
        createClient: (config) => createCliOpenGroveClient({ ...config, authPath }),
        fetch: createFetch((_url, init) => {
          cookiesSeen.push(new Headers(init?.headers).get("cookie"));
          return json({ ok: true, product: "OpenGrove", stateId: "state-other" });
        }),
      },
    );

    assert.equal(result.exitCode, 3);
    assert.deepEqual(cookiesSeen, [null]);
    assert.match(result.stderr ?? "", /bridge_identity_mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit Bridge token overrides the saved account session", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-auth-cli-token-"));
  const authPath = join(root, "cli-auth.json");
  const apiHeaders: Headers[] = [];
  try {
    await writeCliAuthState(
      {
        bridgeApiUrl,
        stateId: "state-1",
        cookies: { opengrove_auth_refresh: "refresh-secret" },
      },
      authPath,
    );
    const result = await runHostOperationCommand(
      [
        "room",
        "message",
        "create",
        "--room-id",
        "room-1",
        "--text",
        "hello",
        "--base-url",
        bridgeApiUrl,
        "--token",
        "bridge-token",
      ],
      {
        createClient: (config) => createCliOpenGroveClient({ ...config, authPath }),
        fetch: createFetch((url, init) => {
          if (url.endsWith("/opengrove-probe")) {
            return json({ ok: true, product: "OpenGrove", stateId: "state-1" });
          }
          apiHeaders.push(new Headers(init?.headers));
          return json(roomMessageResponse);
        }),
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(apiHeaders[0]?.get("x-opengrove-token"), "bridge-token");
    assert.equal(apiHeaders[0]?.get("cookie"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale cookie rotation cannot overwrite a newer CLI login", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-auth-cli-rotation-race-"));
  const authPath = join(root, "cli-auth.json");
  const response = deferred<Response>();
  const requestStarted = deferred<void>();
  try {
    await writeCliAuthState(
      {
        bridgeApiUrl,
        stateId: "state-1",
        email: "old@example.test",
        cookies: { opengrove_auth_refresh: "refresh-old" },
      },
      authPath,
    );
    const command = runHostOperationCommand(["room", "message", "create", "--room-id", "room-1", "--text", "hello"], {
      createClient: (config) => createCliOpenGroveClient({ ...config, authPath }),
      fetch: createFetch((url) => {
        if (url.endsWith("/opengrove-probe")) {
          return json({ ok: true, product: "OpenGrove", stateId: "state-1" });
        }
        requestStarted.resolve();
        return response.promise;
      }),
    });

    await requestStarted.promise;
    await writeCliAuthState(
      {
        bridgeApiUrl,
        stateId: "state-1",
        email: "new@example.test",
        cookies: { opengrove_auth_refresh: "refresh-new" },
      },
      authPath,
    );
    response.resolve(
      json(
        roomMessageResponse,
        200,
        cookies("opengrove_auth_refresh=refresh-from-stale-request; Path=/; Max-Age=3600"),
      ),
    );

    const result = await command;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(readCliAuthState(authPath)?.email, "new@example.test");
    assert.equal(readCliAuthState(authPath)?.cookies.opengrove_auth_refresh, "refresh-new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale unauthenticated status cannot delete a newer CLI login", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-auth-cli-status-race-"));
  const authPath = join(root, "cli-auth.json");
  const response = deferred<Response>();
  const requestStarted = deferred<void>();
  try {
    await writeCliAuthState(
      {
        bridgeApiUrl,
        stateId: "state-1",
        email: "old@example.test",
        cookies: { opengrove_auth_refresh: "refresh-old" },
      },
      authPath,
    );
    const command = runAuthCommand(["status", "--base-url", bridgeApiUrl], {
      authPath,
      fetch: createFetch((url) => {
        if (url.endsWith("/opengrove-probe")) {
          return json({ ok: true, product: "OpenGrove", stateId: "state-1" });
        }
        requestStarted.resolve();
        return response.promise;
      }),
    });

    await requestStarted.promise;
    await writeCliAuthState(
      {
        bridgeApiUrl,
        stateId: "state-1",
        email: "new@example.test",
        cookies: { opengrove_auth_refresh: "refresh-new" },
      },
      authPath,
    );
    response.resolve(json({ status: "unauthenticated", authenticated: false, reason: "expired" }));

    const result = await command;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(readCliAuthState(authPath)?.email, "new@example.test");
    assert.equal(readCliAuthState(authPath)?.cookies.opengrove_auth_refresh, "refresh-new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => handler(String(input), init)) as typeof fetch;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function json(body: unknown, status = 200, headers = new Headers()): Response {
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

function cookies(...values: string[]): Headers {
  const headers = new Headers();
  for (const value of values) headers.append("set-cookie", value);
  return headers;
}

const roomMessageResponse = {
  ok: true as const,
  room: {
    id: "room-1",
    kind: "group" as const,
    title: "CLI",
    badge: "CLI",
    memberIds: [],
    adminMemberIds: [],
    updatedAt: "2026-09-02T00:00:00.000Z",
    unread: 0,
  },
  userMessage: {
    id: "message-1",
    roomId: "room-1",
    channelSeq: 1,
    senderId: "user",
    senderName: "You",
    senderType: "user" as const,
    text: "hello",
    targetIds: [],
    status: "done" as const,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  },
  assistantMessages: [],
  currentEventSeq: 1,
};
