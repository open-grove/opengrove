import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startOpenGroveServer } from "../server/create-server.js";

// Exercises `opengrove auth ...` and `opengrove app release ...` end to end
// against a real Bridge socket in session auth mode: login pairing writes the
// 0600 jar bound to the Bridge identity, refresh rotation is persisted back,
// the admin gate rejects non-admin accounts, discovery finds the Bridge without
// flags, a foreign Bridge never receives this pairing's cookies, and structured
// Bridge errors reach the agent untouched. OpenGrove Cloud API and Release
// Control are the only mocked pieces. The publish state machine itself is
// covered by `release-cli-harness.ts` against a scripted Bridge.

const dir = mkdtempSync(join(tmpdir(), "opengrove-release-cli-real-"));
const cliHome = join(dir, "cli-home");
mkdirSync(cliHome, { recursive: true });
const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
const jarPath = join(cliHome, ".opengrove", "cli-auth.json");
const VALID_CODE = "654321";
const APP_ID = "release-fixture-app";

const previousEnv: Record<string, string | undefined> = {
  OPENGROVE_WW_BASE_URL: process.env.OPENGROVE_WW_BASE_URL,
  OPENGROVE_WEB_AUTH_MODE: process.env.OPENGROVE_WEB_AUTH_MODE,
  OPENGROVE_RELEASE_CONTROL_URL: process.env.OPENGROVE_RELEASE_CONTROL_URL,
  OPENGROVE_DIAGNOSTICS_DIR: process.env.OPENGROVE_DIAGNOSTICS_DIR,
};

let refreshRequests = 0;

const ACCOUNTS: Record<string, { access: string; refresh: string; role: string; userId: string }> = {
  "admin@example.test": { access: "access-admin-1", refresh: "refresh-admin-1", role: "admin", userId: "user_admin" },
  "user@example.test": { access: "access-user-1", refresh: "refresh-user-1", role: "user", userId: "user_plain" },
};
const ACCESS_ROLES: Record<string, { role: string; userId: string; email: string }> = {
  "access-admin-1": { role: "admin", userId: "user_admin", email: "admin@example.test" },
  "access-admin-2": { role: "admin", userId: "user_admin", email: "admin@example.test" },
  "access-user-1": { role: "user", userId: "user_plain", email: "user@example.test" },
};
const REFRESH_ROTATIONS: Record<string, { access: string; refresh: string }> = {
  "refresh-admin-1": { access: "access-admin-2", refresh: "refresh-admin-2" },
};
const SECRETS = Object.values(ACCOUNTS).flatMap((account) => [account.access, account.refresh]);

const fakeWw = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/app-store/install-policy") {
    sendJson(response, 200, { policyKey: "standard", assignmentSource: "default", apps: [] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/app-store/packages") {
    sendJson(response, 200, { packages: [] });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/email-codes") {
    sendJson(response, 200, { data: {}, request_id: "req-code" });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/email-login") {
    void readJsonBody(request)
      .then((body) => {
        const account = ACCOUNTS[String(body.email)];
        if (!account || body.code !== VALID_CODE) {
          sendJson(response, 401, {
            error: { code: 110101, message: "verification code invalid", request_id: "req-login-bad" },
          });
          return;
        }
        sendJson(response, 200, {
          data: {
            access_token: account.access,
            access_token_expires_in: 60,
            refresh_token: account.refresh,
            refresh_token_expires_in: 3600,
            token_type: "Bearer",
          },
          request_id: "req-login",
        });
      })
      .catch((error) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/token/refresh") {
    refreshRequests += 1;
    void readJsonBody(request)
      .then((body) => {
        const rotated = REFRESH_ROTATIONS[String(body.refresh_token)];
        if (!rotated) {
          sendJson(response, 401, {
            error: { code: 110202, message: "refresh invalid", request_id: "req-refresh-bad" },
          });
          return;
        }
        sendJson(response, 200, {
          data: {
            access_token: rotated.access,
            access_token_expires_in: 60,
            refresh_token: rotated.refresh,
            refresh_token_expires_in: 3600,
            token_type: "Bearer",
          },
          request_id: "req-refresh",
        });
      })
      .catch((error) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
    sendJson(response, 200, { data: { ok: true }, request_id: "req-logout" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/users/me") {
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const identity = ACCESS_ROLES[token];
    if (!identity) {
      sendJson(response, 401, { error: { code: 110201, message: "access invalid", request_id: "req-me-bad" } });
      return;
    }
    sendJson(response, 200, {
      data: { user_id: identity.userId, email: identity.email, role: identity.role },
      request_id: "req-me",
    });
    return;
  }
  sendJson(response, 404, { error: { code: 404, message: "not found" } });
});

const fakeReleaseControl = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && /^\/v1\/app-store\/packages\/[^/]+\/versions$/.test(url.pathname)) {
    sendJson(response, 200, { versions: [] });
    return;
  }
  sendJson(response, 404, { error: "not_found" });
});

// A live HTTP service that answers the probe like an OpenGrove Bridge but with
// a different stateId — the stand-in for "some other Bridge on this machine".
// Every request is recorded so cookie leaks are assertable at the wire level.
const foreignRequests: Array<{ method: string; path: string; hasCookie: boolean }> = [];
const fakeForeignBridge = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  foreignRequests.push({
    method: request.method ?? "",
    path: url.pathname,
    hasCookie: request.headers.cookie !== undefined,
  });
  if (request.method === "GET" && url.pathname === "/opengrove-probe") {
    sendJson(response, 200, { ok: true, product: "OpenGrove", profile: "local", stateId: "state-foreign-bridge" });
    return;
  }
  // Failure responses carry a Set-Cookie on purpose: a failed login must not
  // let a foreign Bridge's cookies reach the jar.
  response.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": "opengrove_auth_access=foreign-cookie; Path=/",
  });
  response.end(JSON.stringify({ ok: false, error: "not_found" }));
});

try {
  // Subscribe before listen: the second "listening" event can fire while the
  // first is being awaited, and a late once() would then hang forever.
  const mocksListening = Promise.all([
    once(fakeWw, "listening"),
    once(fakeReleaseControl, "listening"),
    once(fakeForeignBridge, "listening"),
  ]);
  fakeWw.listen(0, "127.0.0.1");
  fakeReleaseControl.listen(0, "127.0.0.1");
  fakeForeignBridge.listen(0, "127.0.0.1");
  await mocksListening;
  process.env.OPENGROVE_WW_BASE_URL = `http://127.0.0.1:${(fakeWw.address() as AddressInfo).port}`;
  process.env.OPENGROVE_RELEASE_CONTROL_URL = `http://127.0.0.1:${(fakeReleaseControl.address() as AddressInfo).port}`;
  process.env.OPENGROVE_DIAGNOSTICS_DIR = join(dir, "diagnostics");
  delete process.env.OPENGROVE_WEB_AUTH_MODE;

  const appRoot = join(dir, APP_ID);
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify({
      id: APP_ID,
      title: "Release Fixture App",
      description: "Fixture app for the release CLI real-bridge harness.",
      disablePmAgent: true,
      employees: [],
    })}\n`,
    "utf8",
  );
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "bridge-settings.json"),
    `${JSON.stringify({
      kernel: "claude-code",
      mountedApps: [{ id: APP_ID, path: appRoot, enabled: true }],
    })}\n`,
    "utf8",
  );

  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    statePath: join(dataDir, "state.json"),
  });
  try {
    if (!server.listening) await once(server, "listening");
    const bridgeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const apiUrl = `${bridgeUrl}/api`;
    const probe1 = (await (await fetch(`${bridgeUrl}/opengrove-probe`)).json()) as Record<string, unknown>;
    assert.equal(probe1.authMode, "session", "the harness must run the Bridge in session auth mode");
    assert.equal(typeof probe1.stateId, "string", "the Bridge probe must expose a stateId");

    // --- Bridge discovery file: written next to the state file on listen.
    const discovery = JSON.parse(readFileSync(join(dataDir, "bridge-info.json"), "utf8"));
    assert.equal(discovery.url, bridgeUrl);
    assert.equal(discovery.apiUrl, apiUrl);
    assert.equal(discovery.pid, process.pid);

    // --- Commands that need auth refuse to run before pairing; the Bridge's
    //     session gate is what the agent sees, not a CLI-side guess.
    const unpaired = await runCli(["app", "release", "prepare", "--app-id", APP_ID, "--base-url", apiUrl]);
    assert.equal(unpaired.code, 3, unpaired.stdout + unpaired.stderr);
    assert.equal(field(unpaired.json, "error", "type"), "authentication");
    assert.equal(field(unpaired.json, "error", "message"), "session_required");
    assert.equal(unpaired.json.status, 401);

    const unpairedStatus = await runCli(["auth", "status", "--base-url", apiUrl]);
    assert.equal(unpairedStatus.code, 0, unpairedStatus.stdout + unpairedStatus.stderr);
    assert.equal(unpairedStatus.json.identity, "none");
    assert.equal(field(unpairedStatus.json, "data", "reason"), "missing_cli_session");

    const unpairedLogout = await runCli(["auth", "logout", "--base-url", apiUrl]);
    assert.equal(unpairedLogout.code, 0);
    assert.equal(field(unpairedLogout.json, "data", "remoteRevocation"), "not_attempted");

    // --- A wrong verification code surfaces the Cloud API's structured error
    //     as the Bridge maps it, and leaves no jar behind.
    const badLogin = await runCli(["auth", "login", "--email", "admin@example.test", "--base-url", apiUrl], `111111\n`);
    assert.equal(badLogin.code, 3, badLogin.stdout + badLogin.stderr);
    assert.equal(field(badLogin.json, "error", "type"), "authentication");
    assert.equal(field(badLogin.json, "error", "message"), "verification_code_invalid");
    assert.equal(badLogin.json.status, 401);
    assert.equal(existsSyncSafe(jarPath), false);

    // --- Non-admin pairing works, but the admin gate rejects release actions.
    const userLogin = await runCli(
      ["auth", "login", "--email", "user@example.test", "--base-url", apiUrl],
      `${VALID_CODE}\n`,
    );
    assert.equal(userLogin.code, 0, userLogin.stdout + userLogin.stderr);
    assert.equal(userLogin.json.identity, "user");
    assert.equal(field(userLogin.json, "data", "authenticated"), true);
    assert.equal(field(userLogin.json, "data", "user", "email"), "user@example.test");
    const jarMode = statSync(jarPath).mode & 0o777;
    assert.equal(jarMode, 0o600, `jar must be private, got mode ${jarMode.toString(8)}`);
    const userJar = readJar();
    assert.equal(userJar.email, "user@example.test");
    assert.equal(userJar.bridgeApiUrl, apiUrl);
    assert.equal(userJar.stateId, probe1.stateId, "pairing must record the paired Bridge's stateId");
    assert.equal(typeof field(userJar, "cookies", "opengrove_auth_access"), "string");
    assert.equal(typeof field(userJar, "cookies", "opengrove_auth_refresh"), "string");
    assertNoSecretLeak(userLogin);

    const userPrepare = await runCli(["app", "release", "prepare", "--app-id", APP_ID, "--base-url", apiUrl]);
    assert.equal(userPrepare.code, 3, userPrepare.stdout + userPrepare.stderr);
    assert.equal(field(userPrepare.json, "error", "type"), "authorization");
    assert.equal(field(userPrepare.json, "error", "message"), "admin_required");
    assert.equal(userPrepare.json.status, 403);

    // --- Logout revokes remotely and removes the local pairing.
    const logout = await runCli(["auth", "logout", "--base-url", apiUrl]);
    assert.equal(logout.code, 0, logout.stdout + logout.stderr);
    assert.equal(field(logout.json, "data", "remoteRevocation"), "succeeded");
    assert.equal(existsSyncSafe(jarPath), false);

    // --- Admin pairing passes the gate; prepare returns the baseline draft
    //     computed by the real Bridge against the (empty) registry.
    const adminLogin = await runCli(
      ["auth", "login", "--email", "admin@example.test", "--base-url", apiUrl],
      `${VALID_CODE}\n`,
    );
    assert.equal(adminLogin.code, 0, adminLogin.stdout + adminLogin.stderr);
    assert.equal(field(adminLogin.json, "data", "user", "role"), "admin");
    assertNoSecretLeak(adminLogin);

    const adminStatus = await runCli(["auth", "status", "--base-url", apiUrl]);
    assert.equal(adminStatus.code, 0, adminStatus.stdout + adminStatus.stderr);
    assert.equal(adminStatus.json.identity, "user");
    assert.equal(field(adminStatus.json, "data", "user", "email"), "admin@example.test");

    const adminPrepare = await runCli(["app", "release", "prepare", "--app-id", APP_ID, "--base-url", apiUrl]);
    assert.equal(adminPrepare.code, 0, adminPrepare.stdout + adminPrepare.stderr);
    assert.equal(adminPrepare.json.operation, "app.release.prepare");
    const baseline = field(adminPrepare.json, "data", "release");
    assert.ok(baseline !== null && typeof baseline === "object", `prepare must return a baseline release draft`);
    assert.equal(field(baseline, "app", "title"), "Release Fixture App");
    assert.equal(typeof field(baseline, "version"), "string");

    // --- An expired access token is refreshed by the Bridge exactly once and
    //     the rotated pair is persisted back to the jar (losing it would break
    //     the pairing on the next command).
    const pairedJar = readJar();
    const pairedCookies = pairedJar.cookies as Record<string, string>;
    const tamperedJar = { ...pairedJar, cookies: { ...pairedCookies, opengrove_auth_access: "expired" } };
    writeJar(tamperedJar);
    const refreshesBefore = refreshRequests;
    const rotatedStatus = await runCli(["auth", "status", "--base-url", apiUrl]);
    assert.equal(rotatedStatus.code, 0, rotatedStatus.stdout + rotatedStatus.stderr);
    assert.equal(field(rotatedStatus.json, "data", "user", "email"), "admin@example.test");
    assert.equal(refreshRequests, refreshesBefore + 1, "one expired access token must trigger exactly one refresh");
    const rotatedJar = readJar();
    const rotatedCookies = rotatedJar.cookies as Record<string, string>;
    assert.notEqual(rotatedCookies.opengrove_auth_access, "expired", "the refreshed access cookie must be persisted");
    assert.notEqual(
      rotatedCookies.opengrove_auth_refresh,
      pairedCookies.opengrove_auth_refresh,
      "the rotated refresh cookie must be persisted",
    );
    assert.equal(rotatedJar.stateId, probe1.stateId);
    assertNoSecretLeak(rotatedStatus);

    // --- Discovery: with no --base-url and OPENGROVE_DATA_DIR pointing at the
    //     Bridge's data dir, the CLI finds the Bridge via bridge-info.json.
    const discovered = await runCli(["app", "release", "prepare", "--app-id", APP_ID], undefined, {
      env: { OPENGROVE_DATA_DIR: dataDir },
    });
    assert.equal(discovered.code, 0, discovered.stdout + discovered.stderr);
    assert.equal(field(discovered.json, "data", "release", "app", "title"), "Release Fixture App");

    // --- Session cookies are loopback-only: a non-local Bridge URL is refused
    //     before any request is sent, for both friendly and generated commands.
    const nonLocalStatus = await runCli(["auth", "status", "--base-url", "http://198.51.100.7:1234/api"]);
    assert.equal(nonLocalStatus.code, 3, nonLocalStatus.stdout + nonLocalStatus.stderr);
    assert.equal(field(nonLocalStatus.json, "error", "subtype"), "bridge_url_not_local");
    const nonLocalPrepare = await runCli([
      "app",
      "release",
      "prepare",
      "--app-id",
      APP_ID,
      "--base-url",
      "http://198.51.100.7:1234/api",
    ]);
    assert.equal(nonLocalPrepare.code, 3, nonLocalPrepare.stdout + nonLocalPrepare.stderr);
    assert.equal(field(nonLocalPrepare.json, "error", "subtype"), "bridge_url_not_local");

    // --- A malformed URL is a structured JSON error, not a bare crash.
    const badUrl = await runCli(["auth", "status", "--base-url", "not-a-url"]);
    assert.equal(badUrl.code, 2, badUrl.stdout + badUrl.stderr);
    assert.equal(field(badUrl.json, "error", "subtype"), "invalid_base_url");

    // --- Foreign-bridge protection: a live Bridge with a different stateId
    //     must never receive this pairing's cookies. Explicit address → error.
    const foreignApiUrl = `http://127.0.0.1:${(fakeForeignBridge.address() as AddressInfo).port}/api`;
    const explicitMismatch = await runCli(["auth", "status", "--base-url", foreignApiUrl]);
    assert.equal(explicitMismatch.code, 3, explicitMismatch.stdout + explicitMismatch.stderr);
    assert.equal(field(explicitMismatch.json, "error", "subtype"), "bridge_identity_mismatch");
    const explicitMismatchPrepare = await runCli([
      "app",
      "release",
      "prepare",
      "--app-id",
      APP_ID,
      "--base-url",
      foreignApiUrl,
    ]);
    assert.equal(explicitMismatchPrepare.code, 3, explicitMismatchPrepare.stdout + explicitMismatchPrepare.stderr);
    assert.equal(field(explicitMismatchPrepare.json, "error", "subtype"), "bridge_identity_mismatch");

    // --- Auto-discovery keeps searching past a mismatched live Bridge: the
    //     foreign Bridge answers first in the candidate order, but the paired
    //     Bridge (found via the jar's saved address) must win.
    const otherDataDir = join(dir, "other-data");
    mkdirSync(otherDataDir, { recursive: true });
    writeFileSync(join(otherDataDir, "bridge-info.json"), `${JSON.stringify({ apiUrl: foreignApiUrl })}\n`, "utf8");
    const foreignProbesBefore = foreignRequests.length;
    const skipMismatch = await runCli(["auth", "status"], undefined, { env: { OPENGROVE_DATA_DIR: otherDataDir } });
    assert.equal(skipMismatch.code, 0, skipMismatch.stdout + skipMismatch.stderr);
    assert.equal(field(skipMismatch.json, "data", "user", "email"), "admin@example.test");
    // The success must have come from actually skipping the foreign Bridge,
    // not from never reaching it (e.g. an unreadable discovery file).
    assert.ok(
      foreignRequests.length > foreignProbesBefore,
      "auto-discovery should have probed (and skipped) the foreign Bridge",
    );

    // --- login starts from an empty session context: even pointed at a
    //     foreign Bridge it must never send the old cookies, and its failure
    //     must leave the existing pairing untouched.
    const jarBeforeForeignLogin = readFileSync(jarPath, "utf8");
    const foreignLogin = await runCli(
      ["auth", "login", "--email", "admin@example.test", "--base-url", foreignApiUrl],
      `${VALID_CODE}\n`,
    );
    assert.notEqual(foreignLogin.code, 0, "login against a foreign Bridge must fail");
    assert.equal(
      readFileSync(jarPath, "utf8"),
      jarBeforeForeignLogin,
      "a failed login must not clobber the existing pairing",
    );
    assert.ok(
      foreignRequests.some((seen) => seen.path !== "/opengrove-probe"),
      "the login flow should have reached the foreign Bridge beyond the probe",
    );
    for (const seen of foreignRequests) {
      assert.equal(seen.hasCookie, false, `pairing cookies leaked to a foreign Bridge: ${seen.method} ${seen.path}`);
    }

    // --- A corrupt remembered address is only a hint: login must skip it and
    //     still find the Bridge through discovery.
    writeJar({ ...readJar(), bridgeApiUrl: "not-a-url" });
    const corruptSaved = await runCli(["auth", "login", "--email", "admin@example.test"], `${VALID_CODE}\n`, {
      env: { OPENGROVE_DATA_DIR: dataDir },
    });
    assert.equal(corruptSaved.code, 0, corruptSaved.stdout + corruptSaved.stderr);
    assert.equal(readJar().bridgeApiUrl, apiUrl);

    // --- Fail closed: a pairing without a recorded Bridge identity is not a
    //     session at all; nothing is sent and re-pairing is the way out.
    const jarNoState = readJar();
    delete jarNoState.stateId;
    writeJar(jarNoState);
    const incompletePairingStatus = await runCli(["auth", "status", "--base-url", apiUrl]);
    assert.equal(incompletePairingStatus.code, 0, incompletePairingStatus.stdout + incompletePairingStatus.stderr);
    assert.equal(field(incompletePairingStatus.json, "data", "reason"), "missing_cli_session");
    const incompletePairingPrepare = await runCli([
      "app",
      "release",
      "prepare",
      "--app-id",
      APP_ID,
      "--base-url",
      apiUrl,
    ]);
    assert.equal(incompletePairingPrepare.code, 3, incompletePairingPrepare.stdout + incompletePairingPrepare.stderr);
    assert.equal(field(incompletePairingPrepare.json, "error", "message"), "session_required");

    // --- Re-pairing against a different Bridge succeeds even from a broken
    //     pairing state (the old jar must never dead-lock login) and rebinds
    //     the jar to the new Bridge's identity.
    const secondBridgeData = join(dir, "second-bridge-data");
    mkdirSync(secondBridgeData, { recursive: true });
    const secondServer = startOpenGroveServer({
      host: "127.0.0.1",
      port: 0,
      statePath: join(secondBridgeData, "state.json"),
    });
    let secondApiUrl = "";
    try {
      if (!secondServer.listening) await once(secondServer, "listening");
      const secondUrl = `http://127.0.0.1:${(secondServer.address() as AddressInfo).port}`;
      secondApiUrl = `${secondUrl}/api`;
      const probe2 = (await (await fetch(`${secondUrl}/opengrove-probe`)).json()) as Record<string, unknown>;
      assert.equal(typeof probe2.stateId, "string");
      assert.notEqual(probe2.stateId, probe1.stateId, "the two Bridges must have distinct identities");
      const repaired = await runCli(
        ["auth", "login", "--email", "admin@example.test", "--base-url", secondApiUrl],
        `${VALID_CODE}\n`,
      );
      assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
      const reboundJar = readJar();
      assert.equal(reboundJar.stateId, probe2.stateId);
      assert.equal(reboundJar.bridgeApiUrl, secondApiUrl);
      // The first Bridge is no longer the paired one.
      const oldBridgeStatus = await runCli(["auth", "status", "--base-url", apiUrl]);
      assert.equal(oldBridgeStatus.code, 3, oldBridgeStatus.stdout + oldBridgeStatus.stderr);
      assert.equal(field(oldBridgeStatus.json, "error", "subtype"), "bridge_identity_mismatch");
      const oldBridgePrepare = await runCli(["app", "release", "prepare", "--app-id", APP_ID, "--base-url", apiUrl]);
      assert.equal(oldBridgePrepare.code, 3, oldBridgePrepare.stdout + oldBridgePrepare.stderr);
      assert.equal(field(oldBridgePrepare.json, "error", "subtype"), "bridge_identity_mismatch");
    } finally {
      await new Promise<void>((resolve, reject) => {
        secondServer.close((error) => (error ? reject(error) : resolve()));
      });
    }

    // --- Local logout remains successful when the paired Bridge is gone, but
    //     the degraded result is explicit for agents and operators.
    const failedRemoteLogout = await runCli(["auth", "logout", "--base-url", secondApiUrl]);
    assert.equal(failedRemoteLogout.code, 0, failedRemoteLogout.stdout + failedRemoteLogout.stderr);
    assert.equal(field(failedRemoteLogout.json, "data", "loggedOut"), true);
    assert.equal(field(failedRemoteLogout.json, "data", "remoteRevocation"), "failed");
    assert.equal(existsSyncSafe(jarPath), false);

    console.log("release-cli-real-bridge-harness ok");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
} finally {
  await Promise.all([
    new Promise<void>((resolve) => fakeWw.close(() => resolve())),
    new Promise<void>((resolve) => fakeReleaseControl.close(() => resolve())),
    new Promise<void>((resolve) => fakeForeignBridge.close(() => resolve())),
  ]);
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

async function runCli(args: string[], input?: string, options?: { env?: Record<string, string> }): Promise<CliResult> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      HOME: cliHome,
      USERPROFILE: cliHome,
      OPENGROVE_BRIDGE_URL: "",
      OPENGROVE_BRIDGE_TOKEN: "",
      OPENGROVE_DATA_DIR: join(cliHome, "no-such-data-dir"),
      ...options?.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  const [code] = (await once(child, "close")) as [number | null];
  // Success JSON goes to stdout, failure JSON to stderr; the login prompt is
  // also written to stderr, so parse from the first JSON object boundary.
  return { code, stdout, stderr, json: parseJson(code === 0 ? stdout : stderr) };
}

function parseJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  if (start === -1) return {};
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    // Non-JSON output leaves json empty; asserts will fail loudly.
    return {};
  }
}

function readJar(): Record<string, unknown> {
  return JSON.parse(readFileSync(jarPath, "utf8")) as Record<string, unknown>;
}

function writeJar(jar: Record<string, unknown>): void {
  writeFileSync(jarPath, JSON.stringify(jar), "utf8");
  chmodSync(jarPath, 0o600);
}

// Paired credentials must never appear in CLI output, on either stream.
function assertNoSecretLeak(result: CliResult): void {
  for (const secret of SECRETS) {
    assert.equal(result.stdout.includes(secret), false, "account credential leaked to CLI stdout");
    assert.equal(result.stderr.includes(secret), false, "account credential leaked to CLI stderr");
  }
}

function field(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
