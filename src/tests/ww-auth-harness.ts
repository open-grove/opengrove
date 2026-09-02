import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { startOpenGroveServer } from "../server/create-server.js";

const dir = mkdtempSync(join(tmpdir(), "opengrove-ww-auth-"));
const previousWwBaseUrl = process.env.OPENGROVE_WW_BASE_URL;
const previousWebAuthMode = process.env.OPENGROVE_WEB_AUTH_MODE;
const previousDiagnosticsDir = process.env.OPENGROVE_DIAGNOSTICS_DIR;
const previousDesktopChannel = process.env.OPENGROVE_DESKTOP_CHANNEL;
const packageMetadata = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
  clientReleaseNumber: number;
};

let usersMeRequests = 0;
let refreshRequests = 0;
let loginBody: Record<string, unknown> | undefined;
let staleUserReads = 0;
let refreshStaleOldUserReads = 0;
let secondStaleUserReads = 0;
let changeableUserRole = "user";
let changeableUserReads = 0;
let profileUpdateBody: Record<string, unknown> | undefined;
let clientActivityBody: Record<string, unknown> | undefined;
let clientActivityRequests = 0;
let installPolicyRequests = 0;
const consumedRefreshTokens = new Set<string>();

const fakeWw = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/app-store/install-policy") {
    installPolicyRequests += 1;
    sendJson(response, 200, {
      policyKey: "standard",
      assignmentSource: "default",
      apps: [],
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/app-store/packages") {
    sendJson(response, 200, { packages: [] });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/email-codes") {
    void readJsonBody(request)
      .then((body) => {
        if (body.email === "limited@example.test") {
          response.setHeader("Retry-After", "42");
          sendJson(response, 429, {
            error: { code: 100002, message: "rate limited", request_id: "req-rate" },
          });
          return;
        }
        sendJson(response, 200, {
          data:
            body.email === "legacy-newbie@example.test"
              ? {}
              : {
                  requires_invite: body.email === "newbie@example.test",
                  requires_country: body.email === "newbie@example.test",
                },
          request_id: "req-code",
        });
      })
      .catch((error) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/email-login") {
    void readJsonBody(request)
      .then((body) => {
        loginBody = body;
        if (body.email === "newbie@example.test") {
          if (typeof body.country_code !== "string" || !body.country_code) {
            sendJson(response, 400, {
              error: { code: 110605, message: "Country or region required" },
              request_id: "req-country",
            });
            return;
          }
          if (body.country_code !== "JP") {
            sendJson(response, 400, {
              error: { code: 110606, message: "Country or region is invalid" },
              request_id: "req-country",
            });
            return;
          }
        }
        if (body.email === "newbie@example.test" || body.email === "legacy-newbie@example.test") {
          if (typeof body.invite_code !== "string" || !body.invite_code) {
            sendJson(response, 403, {
              error: { code: 110601, message: "Invite code required" },
              request_id: "req-invite",
            });
            return;
          }
          if (body.invite_code !== "ABCD-2345-WXYZ") {
            sendJson(response, 403, {
              error: { code: 110602, message: "Invite code is invalid" },
              request_id: "req-invite",
            });
            return;
          }
        }
        sendJson(response, 200, {
          data: {
            access_token:
              body.email === "badme@example.test"
                ? "access-bad"
                : body.email === "stale-session@example.test"
                  ? "access-stale-session"
                  : body.email === "refresh-stale@example.test"
                    ? "access-refresh-stale-old"
                    : body.email === "stale-session-two@example.test"
                      ? "access-stale-session-two"
                      : body.email === "update-outage@example.test"
                        ? "access-update-outage"
                        : "access-login",
            access_token_expires_in:
              body.email === "stale-session@example.test" ||
              body.email === "refresh-stale@example.test" ||
              body.email === "stale-session-two@example.test"
                ? 0.001
                : 60,
            refresh_token: body.email === "refresh-stale@example.test" ? "refresh-stale-old" : "refresh-login",
            refresh_token_expires_in: 3600,
            token_type: "Bearer",
            ...(body.email === "newbie@example.test" ? { is_new_user: true } : {}),
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
        const refreshToken = String(body.refresh_token);
        if (refreshToken === "refresh-parallel") {
          return delay(50).then(() =>
            sendJson(response, 200, {
              data: {
                access_token: "access-parallel",
                access_token_expires_in: 60,
                refresh_token: "refresh-parallel-next",
                refresh_token_expires_in: 3600,
                token_type: "Bearer",
              },
              request_id: "req-refresh-parallel",
            }),
          );
        }
        const rotatedTokens: Record<string, { access: string; refresh: string }> = {
          "refresh-login": { access: "access-refreshed", refresh: "refresh-refreshed" },
          "refresh-refreshed": { access: "access-refreshed-again", refresh: "refresh-refreshed-again" },
          "refresh-only": { access: "access-refreshed", refresh: "refresh-only-next" },
          "refresh-late": { access: "access-late", refresh: "refresh-late-next" },
          "refresh-stale-old": { access: "access-refresh-stale-new", refresh: "refresh-stale-new" },
        };
        const rotated = rotatedTokens[refreshToken];
        if (!rotated || consumedRefreshTokens.has(refreshToken)) {
          sendJson(response, 401, {
            error: { code: 110202, message: "refresh invalid", request_id: "req-refresh-invalid" },
          });
          return undefined;
        }
        if (refreshToken === "refresh-late") {
          consumedRefreshTokens.add(refreshToken);
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
        return undefined;
      })
      .catch((error) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
    sendJson(response, 200, { data: { ok: true }, request_id: "req-logout" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/public/client/latest-version") {
    sendJson(response, 200, {
      mac: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-mac.dmg",
      },
      mac_arm64: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-mac-arm64.dmg",
      },
      mac_x64: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-mac-x64.dmg",
      },
      windows: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-win.exe",
      },
      windows_x64: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-win-x64.exe",
      },
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/client/latest-version") {
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token === "access-update-outage") {
      sendJson(response, 503, {
        error: { code: 100503, message: "temporarily unavailable", request_id: "req-client-version-outage" },
      });
      return;
    }
    if (!token || token === "expired") {
      sendJson(response, 401, {
        error: { code: 110201, message: "access invalid", request_id: "req-client-version-unauthorized" },
      });
      return;
    }
    // 信封例外：直接返回版本 JSON，不包 data/request_id（与 ww docs/api.md 一致）。
    sendJson(response, 200, {
      mac: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-mac.dmg",
        updater_base_url: "https://download.example.test/",
        updater_feed_url: "https://download.example.test/latest-mac.yml",
        release_notes: "harness notes",
      },
      mac_arm64: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-mac-arm64.dmg",
        updater_base_url: "https://download.example.test/",
        updater_feed_url: "https://download.example.test/latest-mac.yml",
        release_notes: "harness notes arm64",
      },
      mac_x64: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-mac-x64.dmg",
        updater_base_url: "https://download.example.test/",
        updater_feed_url: "https://download.example.test/latest-mac.yml",
        release_notes: "harness notes x64",
      },
      windows: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-win.exe",
        updater_base_url: "https://download.example.test/",
        updater_feed_url: "https://download.example.test/latest.yml",
      },
      windows_x64: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-win-x64.exe",
        updater_base_url: "https://download.example.test/",
        updater_feed_url: "https://download.example.test/latest.yml",
      },
      linux_x64: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-linux-x64.AppImage",
        updater_base_url: "https://download.example.test/",
        updater_feed_url: "https://download.example.test/latest-linux.yml",
      },
      linux_arm64: {
        version: 10002,
        released_at: "2026-07-08T00:00:00Z",
        download_url: "https://download.example.test/OpenGrove-linux-arm64.AppImage",
        updater_base_url: "https://download.example.test/",
        updater_feed_url: "https://download.example.test/latest-linux.yml",
      },
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/client/activity") {
    clientActivityRequests += 1;
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token || token === "expired") {
      sendJson(response, 401, {
        error: { code: 110201, message: "access invalid", request_id: "req-client-activity-unauthorized" },
      });
      return;
    }
    void readJsonBody(request)
      .then((body) => {
        clientActivityBody = body;
        sendJson(response, 200, { data: { day: "2026-08-05" }, request_id: "req-client-activity" });
      })
      .catch((error) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === "PATCH" && url.pathname === "/v1/users/me") {
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token !== "access-login") {
      sendJson(response, 401, {
        error: { code: 110201, message: "access invalid", request_id: "req-profile-invalid" },
      });
      return;
    }
    void readJsonBody(request)
      .then((body) => {
        profileUpdateBody = body;
        sendJson(response, 200, {
          data: {
            user_id: "user_ww",
            email: "ww-user@example.test",
            display_name: body.display_name,
            avatar_url:
              body.avatar_data_url === null ? "" : "https://assets.example.test/ww/user-profiles/user_ww/avatar.jpg",
            profile_updated_at: "2026-07-28T08:00:00Z",
            profile_status: "available",
            role: "member",
          },
          request_id: "req-profile-update",
        });
      })
      .catch((error) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/users/me") {
    usersMeRequests += 1;
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token === "access-outage") {
      sendJson(response, 503, {
        error: { code: 100503, message: "temporarily unavailable", request_id: "req-me-outage" },
      });
      return;
    }
    if (token === "access-stale-session") {
      staleUserReads += 1;
      if (staleUserReads > 1) {
        sendJson(response, 503, {
          error: { code: 100503, message: "temporarily unavailable", request_id: "req-me-stale-outage" },
        });
        return;
      }
      sendJson(response, 200, {
        data: {
          user_id: "user_stale",
          email: "stale-session@example.test",
          role: "member",
        },
        request_id: "req-me-stale",
      });
      return;
    }
    if (token === "access-refresh-stale-old") {
      refreshStaleOldUserReads += 1;
      if (refreshStaleOldUserReads > 1) {
        sendJson(response, 401, {
          error: { code: 110201, message: "access invalid", request_id: "req-me-refresh-stale-expired" },
        });
        return;
      }
      sendJson(response, 200, {
        data: {
          user_id: "user_refresh_stale",
          email: "refresh-stale@example.test",
          role: "member",
        },
        request_id: "req-me-refresh-stale",
      });
      return;
    }
    if (token === "access-refresh-stale-new") {
      sendJson(response, 503, {
        error: { code: 100503, message: "temporarily unavailable", request_id: "req-me-refresh-stale-outage" },
      });
      return;
    }
    if (token === "access-stale-session-two") {
      secondStaleUserReads += 1;
      if (secondStaleUserReads > 1) {
        sendJson(response, 503, {
          error: { code: 100503, message: "temporarily unavailable", request_id: "req-me-stale-two-outage" },
        });
        return;
      }
      sendJson(response, 200, {
        data: {
          user_id: "user_stale_two",
          email: "stale-session-two@example.test",
          role: "member",
        },
        request_id: "req-me-stale-two",
      });
      return;
    }
    if (token === "access-update-outage") {
      sendJson(response, 200, {
        data: {
          user_id: "user_update_outage",
          email: "update-outage@example.test",
          role: "member",
        },
        request_id: "req-me-update-outage",
      });
      return;
    }
    if (token === "access-role-change") {
      changeableUserReads += 1;
      sendJson(response, 200, {
        data: {
          user_id: "user_role_change",
          email: "role-change@example.test",
          role: changeableUserRole,
        },
        request_id: "req-me-role-change",
      });
      return;
    }
    if (token === "expired") {
      sendJson(response, 401, {
        error: { code: 110201, message: "access invalid", request_id: "req-invalid" },
      });
      return;
    }
    if (token === "access-slow") {
      void delay(50).then(() =>
        sendJson(response, 200, {
          data: {
            user_id: "user_ww",
            email: "ww-user@example.test",
            ...(profileUpdateBody
              ? {
                  display_name:
                    typeof profileUpdateBody.display_name === "string" ? profileUpdateBody.display_name : "",
                  avatar_url:
                    profileUpdateBody.avatar_data_url === null
                      ? ""
                      : "https://assets.example.test/ww/user-profiles/user_ww/avatar.jpg",
                  profile_updated_at: "2026-07-28T08:00:00Z",
                  profile_status: "available",
                }
              : {}),
            role: "member",
            balance: 15000,
            total_granted: 15000,
          },
          request_id: "req-me-slow",
        }),
      );
      return;
    }
    if (
      token === "access-login" ||
      token === "access-refreshed" ||
      token === "access-refreshed-again" ||
      token === "access-parallel" ||
      token === "access-late"
    ) {
      sendJson(response, 200, {
        data: {
          user_id: "user_ww",
          email: "ww-user@example.test",
          ...(profileUpdateBody
            ? {
                display_name: typeof profileUpdateBody.display_name === "string" ? profileUpdateBody.display_name : "",
                avatar_url:
                  profileUpdateBody.avatar_data_url === null
                    ? ""
                    : "https://assets.example.test/ww/user-profiles/user_ww/avatar.jpg",
                profile_updated_at: "2026-07-28T08:00:00Z",
                profile_status: "available",
              }
            : {}),
          role: "member",
          balance: 15000,
          total_granted: 15000,
        },
        request_id: "req-me",
      });
      return;
    }
    sendJson(response, 401, {
      error: { code: 110201, message: "access invalid", request_id: "req-unknown" },
    });
    return;
  }
  sendJson(response, 404, { error: { code: 404, message: "not found" } });
});

try {
  fakeWw.listen(0, "127.0.0.1");
  await once(fakeWw, "listening");
  const fakeAddress = fakeWw.address() as AddressInfo;
  process.env.OPENGROVE_WW_BASE_URL = `http://127.0.0.1:${fakeAddress.port}`;
  process.env.OPENGROVE_DIAGNOSTICS_DIR = join(dir, "diagnostics");
  process.env.OPENGROVE_DESKTOP_CHANNEL = "dev";
  delete process.env.OPENGROVE_WEB_AUTH_MODE;
  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    statePath: join(dir, "state.json"),
    bridgeToken: "desktop-token",
  });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const publicHealth = await getJson(`${baseUrl}/api/health`);
    assert.equal(publicHealth.auth.authenticated, undefined);
    assert.equal("kernel" in publicHealth, false);
    assert.equal(usersMeRequests, 0);

    const outageCookie =
      "opengrove_auth_access=access-outage; opengrove_auth_refresh=refresh-outage; opengrove_auth_session=outage-session";
    const usersMeBeforeOutageHealth = usersMeRequests;
    const outageHealth = await getJson(`${baseUrl}/api/health`, { cookie: outageCookie });
    assert.equal(outageHealth.auth.authenticated, undefined);
    assert.equal(usersMeRequests, usersMeBeforeOutageHealth);

    const outageSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie: outageCookie },
    });
    assert.equal(outageSessionResponse.status, 200);
    const outageSession = await outageSessionResponse.json();
    assert.equal(outageSession.status, "temporarily_unavailable");
    assert.equal(outageSession.authenticated, undefined);
    assert.equal(setCookieHeader(outageSessionResponse).length, 0);
    const sessionProblems = readFileSync(join(dir, "diagnostics", "problems.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(sessionProblems.length, 1);
    assert.deepEqual(
      {
        incidentId: sessionProblems[0]?.incidentId,
        traceId: sessionProblems[0]?.traceId,
        category: sessionProblems[0]?.category,
        phase: sessionProblems[0]?.phase,
        code: sessionProblems[0]?.code,
        retryable: sessionProblems[0]?.retryable,
      },
      {
        incidentId: outageSession.incidentId,
        traceId: outageSession.traceId,
        category: "ww",
        phase: "session-verify",
        code: "auth_unavailable",
        retryable: true,
      },
    );

    const protectedDuringOutage = await fetch(`${baseUrl}/api/settings`, {
      headers: { cookie: outageCookie },
    });
    assert.equal(protectedDuringOutage.status, 503);
    assert.equal((await protectedDuringOutage.json()).error, "session_temporarily_unavailable");
    assert.equal(setCookieHeader(protectedDuringOutage).length, 0);

    const roleChangeCookie =
      "opengrove_auth_access=access-role-change; opengrove_auth_refresh=refresh-login; opengrove_auth_session=role-change-session";
    const realRoleChangeDateNow = Date.now;
    let roleChangeNow = realRoleChangeDateNow();
    Date.now = () => roleChangeNow;
    try {
      const beforeRoleChange = await getJson(`${baseUrl}/api/auth/session`, { cookie: roleChangeCookie });
      assert.equal(beforeRoleChange.user.role, "user");
      assert.equal(changeableUserReads, 1);

      changeableUserRole = "admin";
      const cachedRole = await getJson(`${baseUrl}/api/auth/session`, { cookie: roleChangeCookie });
      assert.equal(cachedRole.user.role, "user");
      assert.equal(changeableUserReads, 1);

      roleChangeNow += 10_001;
      const refreshedRole = await getJson(`${baseUrl}/api/auth/session`, { cookie: roleChangeCookie });
      assert.equal(refreshedRole.user.role, "admin");
      assert.equal(changeableUserReads, 2);
    } finally {
      Date.now = realRoleChangeDateNow;
    }

    const codeResponse = await postJson(`${baseUrl}/api/auth/email-codes`, { email: "ww-user@example.test" });
    assert.equal(codeResponse.ok, true);
    assert.equal(codeResponse.requiresInvite, false);

    const newUserCodeResponse = await postJson(`${baseUrl}/api/auth/email-codes`, { email: "newbie@example.test" });
    assert.equal(newUserCodeResponse.ok, true);
    assert.equal(newUserCodeResponse.requiresInvite, true);
    assert.equal(newUserCodeResponse.requiresCountry, true);

    const legacyNewUserCodeResponse = await postJson(`${baseUrl}/api/auth/email-codes`, {
      email: "legacy-newbie@example.test",
    });
    assert.equal(legacyNewUserCodeResponse.ok, true);
    assert.equal("requiresInvite" in legacyNewUserCodeResponse, false);
    assert.equal("requiresCountry" in legacyNewUserCodeResponse, false);
    assert.equal("isNewUser" in legacyNewUserCodeResponse, false);

    const legacyInviteRequiredResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "legacy-newbie@example.test", code: "123456" }),
    });
    assert.equal(legacyInviteRequiredResponse.status, 403);
    const legacyInviteRequiredJson = await legacyInviteRequiredResponse.json();
    assert.equal(legacyInviteRequiredJson.error, "invite_code_required");

    const limitedResponse = await fetch(`${baseUrl}/api/auth/email-codes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "limited@example.test" }),
    });
    assert.equal(limitedResponse.status, 429);
    assert.equal(limitedResponse.headers.get("retry-after"), "42");
    const limitedJson = await limitedResponse.json();
    assert.equal(limitedJson.error, "rate_limited");
    assert.equal(limitedJson.retryAfter, 42);
    assert.equal(limitedJson.requestId, "req-rate");
    assert.match(limitedJson.incidentId, /^OG-\d{8}-[A-F0-9]{6}$/);
    assert.equal(limitedResponse.headers.get("x-opengrove-trace-id"), limitedJson.traceId);

    const countryRequiredResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "newbie@example.test", code: "123456" }),
    });
    assert.equal(countryRequiredResponse.status, 400);
    const countryRequiredJson = await countryRequiredResponse.json();
    assert.equal(countryRequiredJson.error, "country_code_required");
    assert.equal(countryRequiredJson.requestId, "req-country");

    const countryInvalidResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "newbie@example.test", code: "123456", countryCode: "USA" }),
    });
    assert.equal(countryInvalidResponse.status, 400);
    assert.equal((await countryInvalidResponse.json()).error, "country_code_invalid");

    const badLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "badme@example.test",
        code: "123456",
      }),
    });
    assert.equal(badLoginResponse.status, 401);
    assert.equal(
      setCookieHeader(badLoginResponse).some((cookie) => cookie.startsWith("opengrove_auth_access=")),
      false,
    );

    const inviteRequiredResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "newbie@example.test", code: "123456", countryCode: "JP" }),
    });
    assert.equal(inviteRequiredResponse.status, 403);
    const inviteRequiredJson = await inviteRequiredResponse.json();
    assert.equal(inviteRequiredJson.error, "invite_code_required");
    assert.equal(inviteRequiredJson.requestId, "req-invite");
    assert.match(inviteRequiredJson.incidentId, /^OG-\d{8}-[A-F0-9]{6}$/);
    assert.equal("invite_code" in (loginBody ?? {}), false);

    const inviteInvalidResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "newbie@example.test",
        code: "123456",
        inviteCode: "WRONG-CODE",
        countryCode: "JP",
      }),
    });
    assert.equal(inviteInvalidResponse.status, 403);
    const inviteInvalidJson = await inviteInvalidResponse.json();
    assert.equal(inviteInvalidJson.error, "invite_code_invalid");
    assert.equal(inviteInvalidJson.requestId, "req-invite");

    const inviteLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "newbie@example.test",
        code: "123456",
        inviteCode: " abcd-2345-wxyz ",
        countryCode: " jp ",
      }),
    });
    assert.equal(inviteLoginResponse.status, 200);
    assert.equal(loginBody?.invite_code, "ABCD-2345-WXYZ");
    assert.equal(loginBody?.country_code, "JP");
    const inviteLoginJson = await inviteLoginResponse.json();
    assert.equal(inviteLoginJson.isNewUser, true);
    assert.equal(
      setCookieHeader(inviteLoginResponse).some((cookie) => cookie.startsWith("opengrove_auth_access=")),
      true,
    );

    const staleLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "stale-session@example.test", code: "123456" }),
    });
    assert.equal(staleLoginResponse.status, 200);
    const staleCookie = cookieHeader(setCookieHeader(staleLoginResponse));
    const staleSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie: staleCookie },
    });
    assert.equal(staleSessionResponse.status, 200);
    const staleSession = await staleSessionResponse.json();
    assert.equal(staleSession.status, "authenticated");
    assert.equal(staleSession.verification, "stale");
    assert.equal(staleSession.error, "auth_unavailable");
    assert.match(staleSession.incidentId, /^OG-/);
    assert.equal(staleSession.user.email, "stale-session@example.test");
    assert.equal(setCookieHeader(staleSessionResponse).length, 0);
    const usersMeAfterStaleFallback = usersMeRequests;
    const repeatedStaleSession = await getJson(`${baseUrl}/api/auth/session`, { cookie: staleCookie });
    assert.equal(repeatedStaleSession.status, "authenticated");
    assert.equal(repeatedStaleSession.verification, "stale");
    assert.equal(repeatedStaleSession.incidentId, staleSession.incidentId);
    assert.equal(usersMeRequests, usersMeAfterStaleFallback);
    const firstDegradedSessionProblems = readFileSync(join(dir, "diagnostics", "problems.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((problem) => problem.phase === "session-verify" && problem.level === "warning");
    assert.equal(firstDegradedSessionProblems.length, 1);
    const firstDegradedSessionIncidentId = firstDegradedSessionProblems[0]?.incidentId;

    const realDateNow = Date.now;
    let fakeNow = realDateNow();
    const refreshStaleCacheStartedAt = fakeNow;
    Date.now = () => fakeNow;
    try {
      const refreshStaleLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "refresh-stale@example.test", code: "123456" }),
      });
      assert.equal(refreshStaleLoginResponse.status, 200);
      const refreshStaleCookie = cookieHeader(setCookieHeader(refreshStaleLoginResponse));

      fakeNow += 2;
      const refreshStaleSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { cookie: refreshStaleCookie },
      });
      assert.equal(refreshStaleSessionResponse.status, 200);
      const refreshStaleSession = await refreshStaleSessionResponse.json();
      assert.equal(refreshStaleSession.status, "authenticated");
      assert.equal(refreshStaleSession.verification, "stale");
      assert.match(refreshStaleSession.incidentId, /^OG-/);
      assert.equal(refreshStaleSession.user.email, "refresh-stale@example.test");
      const rotatedRefreshStaleCookie = cookieHeader(setCookieHeader(refreshStaleSessionResponse));
      assert.match(rotatedRefreshStaleCookie, /opengrove_auth_access=access-refresh-stale-new/);

      const usersMeBeforeRefreshStaleRetry = usersMeRequests;
      fakeNow += 30_001;
      const retriedRefreshStaleSession = await getJson(`${baseUrl}/api/auth/session`, {
        cookie: rotatedRefreshStaleCookie,
      });
      assert.equal(retriedRefreshStaleSession.status, "authenticated");
      assert.equal(retriedRefreshStaleSession.verification, "stale");
      assert.equal(retriedRefreshStaleSession.incidentId, refreshStaleSession.incidentId);
      assert.equal(usersMeRequests, usersMeBeforeRefreshStaleRetry + 1);

      fakeNow = refreshStaleCacheStartedAt + 30 * 60 * 1000 + 1;
      const expiredRefreshStaleSession = await getJson(`${baseUrl}/api/auth/session`, {
        cookie: rotatedRefreshStaleCookie,
      });
      assert.equal(expiredRefreshStaleSession.status, "temporarily_unavailable");
    } finally {
      Date.now = realDateNow;
    }
    const degradedSessionProblemsBeforeSecondLogin = readFileSync(join(dir, "diagnostics", "problems.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((problem) => problem.phase === "session-verify" && problem.level === "warning");
    const secondStaleLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "stale-session-two@example.test", code: "123456" }),
    });
    assert.equal(secondStaleLoginResponse.status, 200);
    const secondStaleCookie = cookieHeader(setCookieHeader(secondStaleLoginResponse));
    const secondStaleSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie: secondStaleCookie },
    });
    assert.equal(secondStaleSessionResponse.status, 200);
    assert.equal((await secondStaleSessionResponse.json()).status, "authenticated");
    const degradedSessionProblems = readFileSync(join(dir, "diagnostics", "problems.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((problem) => problem.phase === "session-verify" && problem.level === "warning");
    assert.equal(degradedSessionProblems.length, degradedSessionProblemsBeforeSecondLogin.length + 1);
    assert.notEqual(degradedSessionProblems.at(-1)?.incidentId, firstDegradedSessionIncidentId);

    const updateOutageLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "update-outage@example.test", code: "123456" }),
    });
    assert.equal(updateOutageLoginResponse.status, 200);
    const updateOutageCookie = cookieHeader(setCookieHeader(updateOutageLoginResponse));
    const updateOutageResponse = await fetch(`${baseUrl}/api/auth/client-update`, {
      headers: { cookie: updateOutageCookie },
    });
    assert.equal(updateOutageResponse.status, 503);
    assert.equal(setCookieHeader(updateOutageResponse).length, 0);
    const sessionAfterUpdateOutage = await getJson(`${baseUrl}/api/auth/session`, { cookie: updateOutageCookie });
    assert.equal(sessionAfterUpdateOutage.status, "authenticated");
    assert.equal(sessionAfterUpdateOutage.user.email, "update-outage@example.test");

    const longDeviceName = "OpenGrove Web ".repeat(20);
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "ww-user@example.test",
        code: "123456",
        deviceName: longDeviceName,
        platform: "web",
        languagePreference: "system",
        systemLanguage: "zh-CN",
      }),
    });
    assert.equal(loginResponse.status, 200);
    assert.equal(loginBody?.platform, "unknown");
    assert.equal(Array.from(String(loginBody?.device_name)).length, 100);
    const loginBodyJson = await loginResponse.json();
    assert.equal(loginBodyJson.user.email, "ww-user@example.test");
    assert.equal(loginBodyJson.user.balance, undefined);
    assert.equal(loginBodyJson.isNewUser, false);
    assert.equal("invite_code" in (loginBody ?? {}), false);
    const loginCookies = setCookieHeader(loginResponse);
    assert.equal(
      loginCookies.some((cookie) => cookie.startsWith("opengrove_auth_access=")),
      true,
    );
    assert.equal(
      loginCookies.some((cookie) => cookie.startsWith("opengrove_auth_refresh=")),
      true,
    );
    assert.equal(
      loginCookies.some((cookie) => cookie.startsWith("opengrove_auth_session=")),
      true,
    );

    const usersMeAfterLogin = usersMeRequests;
    const cookie = cookieHeader(loginCookies);
    const browserActivityResponse = await fetch(`${baseUrl}/api/auth/activity`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ clientVersion: "0.6.1", clientReleaseNumber: 560 }),
    });
    assert.equal(browserActivityResponse.status, 403, "a signed-in browser must not impersonate the desktop app");
    assert.equal(clientActivityRequests, 0);

    const desktopActivityResponse = await fetch(`${baseUrl}/api/auth/activity`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-opengrove-token": "desktop-token" },
      body: JSON.stringify({ clientVersion: "0.6.1", clientReleaseNumber: 560 }),
    });
    assert.equal(desktopActivityResponse.status, 200);
    assert.equal(clientActivityRequests, 1);
    assert.deepEqual(clientActivityBody, {
      surface: "desktop",
      operating_system:
        process.platform === "darwin"
          ? "macos"
          : process.platform === "win32"
            ? "windows"
            : process.platform === "linux"
              ? "linux"
              : "unknown",
      architecture: process.arch === "arm64" || process.arch === "x64" ? process.arch : "unknown",
      client_version: "0.6.1",
      client_release_number: 560,
      bridge_version: packageMetadata.version,
      bridge_release_number: packageMetadata.clientReleaseNumber,
      release_channel: "dev",
    });
    assert.deepEqual(Object.keys(clientActivityBody ?? {}).sort(), [
      "architecture",
      "bridge_release_number",
      "bridge_version",
      "client_release_number",
      "client_version",
      "operating_system",
      "release_channel",
      "surface",
    ]);
    for (let index = 0; index < 100; index += 1) {
      const health = await getJson(`${baseUrl}/api/health`, { cookie });
      assert.equal(health.auth.authenticated, undefined);
    }
    assert.equal(usersMeRequests, usersMeAfterLogin);
    const firstSession = await getJson(`${baseUrl}/api/auth/session`, { cookie });
    assert.equal(firstSession.status, "authenticated");
    assert.equal(firstSession.authenticated, true);
    assert.equal(firstSession.user.email, "ww-user@example.test");
    assert.equal(firstSession.user.balance, undefined);
    assert.equal(firstSession.user.profileStatus, "missing");
    const initializedLanguageSettings = await getJson(`${baseUrl}/api/settings`, { cookie });
    assert.equal(initializedLanguageSettings.settings.languagePreference, "system");
    assert.equal(initializedLanguageSettings.settings.systemLanguage, "zh-CN");
    const explicitLanguageResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        languagePreference: "en",
        systemLanguage: "en",
      }),
    });
    assert.equal(explicitLanguageResponse.status, 200);
    const repeatedLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "ww-user@example.test",
        code: "123456",
        languagePreference: "system",
        systemLanguage: "zh-CN",
      }),
    });
    assert.equal(repeatedLoginResponse.status, 200);
    const repeatedLoginCookie = cookieHeader(setCookieHeader(repeatedLoginResponse));
    const preservedLanguageSettings = await getJson(`${baseUrl}/api/settings`, {
      cookie: repeatedLoginCookie,
    });
    assert.equal(preservedLanguageSettings.settings.languagePreference, "en");
    assert.equal(preservedLanguageSettings.settings.systemLanguage, "en");
    const unauthenticatedProfileResponse = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(
      unauthenticatedProfileResponse.status,
      401,
      "profile authentication must be resolved before parsing the request body",
    );
    const oversizedProfileResponse = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "用户", padding: "x".repeat(1024 * 1024) }),
    });
    assert.equal(oversizedProfileResponse.status, 413);
    const malformedAvatarResponse = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ avatarDataUrl: "data:image/jpeg;base64,/9j/not-base64!" }),
    });
    assert.equal(malformedAvatarResponse.status, 400);
    assert.equal((await malformedAvatarResponse.json()).error, "invalid_avatar");
    const oversizedAvatarResponse = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        avatarDataUrl: `data:image/jpeg;base64,${Buffer.alloc(512 * 1024 + 1).toString("base64")}`,
      }),
    });
    assert.equal(oversizedAvatarResponse.status, 400);
    const oversizedDimensionResponse = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ avatarDataUrl: profileAvatarDataUrl(2049, 256) }),
    });
    assert.equal(oversizedDimensionResponse.status, 400);
    const validAvatarDataUrl = profileAvatarDataUrl(256, 256);
    const profileResponse = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "林间用户",
        avatarDataUrl: validAvatarDataUrl,
      }),
    });
    assert.equal(profileResponse.status, 200);
    assert.deepEqual(profileUpdateBody, {
      display_name: "林间用户",
      avatar_data_url: validAvatarDataUrl,
    });
    const profileResponseJson = await profileResponse.json();
    assert.equal(profileResponseJson.user.displayName, "林间用户");
    assert.equal(profileResponseJson.user.profileStatus, "available");
    assert.equal(profileResponseJson.user.avatarUrl, "https://assets.example.test/ww/user-profiles/user_ww/avatar.jpg");
    const sessionAfterProfileUpdate = await getJson(`${baseUrl}/api/auth/session`, { cookie });
    assert.equal(sessionAfterProfileUpdate.status, "authenticated", JSON.stringify(sessionAfterProfileUpdate));
    assert.equal(sessionAfterProfileUpdate.user.displayName, "林间用户");
    assert.equal(sessionAfterProfileUpdate.user.profileUpdatedAt, "2026-07-28T08:00:00Z");
    assert.equal(sessionAfterProfileUpdate.user.profileStatus, "available");
    const clearProfileResponse = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: null,
        avatarDataUrl: null,
      }),
    });
    assert.equal(clearProfileResponse.status, 200);
    assert.deepEqual(profileUpdateBody, {
      display_name: null,
      avatar_data_url: null,
    });
    const clearedProfileUser = (await clearProfileResponse.json()).user;
    assert.equal(clearedProfileUser.displayName, "ww-user@example.test");
    assert.equal(clearedProfileUser.avatarUrl, undefined);
    assert.equal(clearedProfileUser.profileStatus, "available");
    const authenticatedSettings = await getJson(`${baseUrl}/api/settings`, { cookie });
    assert.equal(
      typeof authenticatedSettings.runtimeControlsByKernel,
      "object",
      "the protected settings response must carry per-kernel model controls when public health omits them",
    );
    assert.equal(
      typeof authenticatedSettings.runtimeControls,
      "object",
      "the protected settings response must carry active runtime controls in session auth mode",
    );
    const settingsPatchResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ developerMode: authenticatedSettings.settings.developerMode }),
    });
    assert.equal(settingsPatchResponse.status, 200);
    const patchedSettings = await settingsPatchResponse.json();
    assert.equal(
      typeof patchedSettings.runtimeControlsByKernel,
      "object",
      "a settings save must refresh model controls atomically instead of leaving the UI on a stale snapshot",
    );
    const usersMeAfterFirstSession = usersMeRequests;
    const secondSession = await getJson(`${baseUrl}/api/auth/session`, { cookie });
    assert.equal(secondSession.authenticated, true);
    assert.equal(usersMeRequests, usersMeAfterFirstSession);

    const usersMeBeforeParallelHealth = usersMeRequests;
    const parallelHealthResponses = await Promise.all([
      fetch(`${baseUrl}/api/health`, {
        headers: {
          cookie:
            "opengrove_auth_access=access-slow; opengrove_auth_refresh=refresh-login; opengrove_auth_session=parallel-health-session",
        },
      }),
      fetch(`${baseUrl}/api/health`, {
        headers: {
          cookie:
            "opengrove_auth_access=access-slow; opengrove_auth_refresh=refresh-login; opengrove_auth_session=parallel-health-session",
        },
      }),
    ]);
    assert.equal(usersMeRequests, usersMeBeforeParallelHealth);
    for (const response of parallelHealthResponses) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).auth.authenticated, undefined);
    }
    const parallelSessionResponses = await Promise.all([
      fetch(`${baseUrl}/api/auth/session`, {
        headers: {
          cookie:
            "opengrove_auth_access=access-slow; opengrove_auth_refresh=refresh-login; opengrove_auth_session=parallel-health-session",
        },
      }),
      fetch(`${baseUrl}/api/auth/session`, {
        headers: {
          cookie:
            "opengrove_auth_access=access-slow; opengrove_auth_refresh=refresh-login; opengrove_auth_session=parallel-health-session",
        },
      }),
    ]);
    assert.equal(usersMeRequests, usersMeBeforeParallelHealth + 1);
    for (const response of parallelSessionResponses) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).authenticated, true);
    }

    const clientUpdateUnauthenticated = await fetch(`${baseUrl}/api/auth/client-update`, {
      headers: { "x-opengrove-token": "desktop-token" },
    });
    assert.equal(clientUpdateUnauthenticated.status, 200);
    const publicClientUpdate = await clientUpdateUnauthenticated.json();
    assert.equal(publicClientUpdate.ok, true);
    assert.equal(typeof publicClientUpdate.current, "number");
    if (process.platform === "darwin" || process.platform === "win32") {
      assert.equal(publicClientUpdate.latest.version, 10002);
      assert.equal(publicClientUpdate.latest.releaseNotes, undefined);
      assert.equal(publicClientUpdate.latest.updaterFeedUrl, undefined);
    } else {
      assert.equal(publicClientUpdate.latest, null);
    }

    const refreshRequestsBeforeExpiredClientUpdate = refreshRequests;
    const expiredClientUpdateResponse = await fetch(`${baseUrl}/api/auth/client-update`, {
      headers: {
        cookie:
          "opengrove_auth_access=expired; opengrove_auth_refresh=refresh-client-update; opengrove_auth_session=client-update-session",
        "x-opengrove-token": "desktop-token",
      },
    });
    assert.equal(expiredClientUpdateResponse.status, 200);
    const expiredClientUpdate = await expiredClientUpdateResponse.json();
    assert.equal(expiredClientUpdate.ok, true);
    assert.equal(
      refreshRequests,
      refreshRequestsBeforeExpiredClientUpdate,
      "a client update check must not rotate the saved Cloud session",
    );
    assert.deepEqual(
      setCookieHeader(expiredClientUpdateResponse),
      [],
      "a client update check must not replace or clear auth cookies",
    );
    if (process.platform === "darwin" || process.platform === "win32") {
      assert.equal(expiredClientUpdate.latest.version, 10002);
      assert.equal(expiredClientUpdate.latest.releaseNotes, undefined);
      assert.equal(expiredClientUpdate.latest.updaterFeedUrl, undefined);
    } else {
      assert.equal(expiredClientUpdate.latest, null);
    }

    const refreshRequestsBeforeAuthenticatedClientUpdate = refreshRequests;
    const clientUpdateResponse = await fetch(`${baseUrl}/api/auth/client-update`, { headers: { cookie } });
    assert.equal(clientUpdateResponse.status, 200);
    const clientUpdate = await clientUpdateResponse.json();
    assert.equal(clientUpdate.ok, true);
    assert.equal(refreshRequests, refreshRequestsBeforeAuthenticatedClientUpdate);
    assert.deepEqual(setCookieHeader(clientUpdateResponse), []);
    assert.equal(typeof clientUpdate.current, "number");
    if (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") {
      assert.equal(clientUpdate.latest.version, 10002);
      const expectedDownloadUrl =
        process.platform === "win32"
          ? "https://download.example.test/OpenGrove-win-x64.exe"
          : process.platform === "linux"
            ? process.arch === "arm64"
              ? "https://download.example.test/OpenGrove-linux-arm64.AppImage"
              : "https://download.example.test/OpenGrove-linux-x64.AppImage"
            : process.arch === "x64"
              ? "https://download.example.test/OpenGrove-mac-x64.dmg"
              : "https://download.example.test/OpenGrove-mac-arm64.dmg";
      assert.equal(clientUpdate.latest.downloadUrl, expectedDownloadUrl);
      assert.equal(clientUpdate.latest.updaterBaseUrl, "https://download.example.test/");
      assert.match(clientUpdate.latest.updaterFeedUrl, /latest-(mac|linux)\.yml$|latest\.yml$/);
    } else {
      // 不支持的平台应得到 latest: null 而非报错。
      assert.equal(clientUpdate.latest, null);
    }

    const refreshRequestsBeforeRefreshHealth = refreshRequests;
    const refreshHealth = await fetch(`${baseUrl}/api/auth/session`, {
      headers: {
        cookie:
          "opengrove_auth_access=expired; opengrove_auth_refresh=refresh-login; opengrove_auth_session=refresh-session",
      },
    });
    assert.equal(refreshHealth.status, 200);
    assert.equal((await refreshHealth.json()).authenticated, true);
    assert.equal(refreshRequests, refreshRequestsBeforeRefreshHealth + 1);
    const refreshedCookies = setCookieHeader(refreshHealth);
    assert.equal(
      refreshedCookies.some((cookie) => cookie.includes("refresh-refreshed")),
      true,
    );

    const refreshOnlyRequestsBefore = refreshRequests;
    const refreshOnlyHealth = await fetch(`${baseUrl}/api/auth/session`, {
      headers: {
        cookie: "opengrove_auth_refresh=refresh-only; opengrove_auth_session=refresh-only-session",
      },
    });
    assert.equal(refreshOnlyHealth.status, 200);
    assert.equal((await refreshOnlyHealth.json()).authenticated, true);
    assert.equal(refreshRequests, refreshOnlyRequestsBefore + 1);
    assert.equal(
      setCookieHeader(refreshOnlyHealth).some((cookie) => cookie.includes("refresh-only-next")),
      true,
    );

    const lateRotationRequestsBefore = refreshRequests;
    const lateRotationCookie = "opengrove_auth_refresh=refresh-late; opengrove_auth_session=late-rotation-session";
    const lateRotationHealth = await fetch(`${baseUrl}/api/auth/session`, {
      headers: {
        cookie: lateRotationCookie,
      },
    });
    assert.equal(lateRotationHealth.status, 200);
    assert.equal((await lateRotationHealth.json()).authenticated, true);
    assert.equal(refreshRequests, lateRotationRequestsBefore + 1);
    assert.equal(
      setCookieHeader(lateRotationHealth).some((cookie) => cookie.includes("refresh-late-next")),
      true,
    );

    const lateReplayHealth = await fetch(`${baseUrl}/api/auth/session`, {
      headers: {
        cookie: lateRotationCookie,
      },
    });
    assert.equal(lateReplayHealth.status, 200);
    assert.equal((await lateReplayHealth.json()).authenticated, true);
    assert.equal(refreshRequests, lateRotationRequestsBefore + 1);
    assert.equal(
      setCookieHeader(lateReplayHealth).some((cookie) => cookie.includes("refresh-late-next")),
      true,
    );

    const lateRotatedCookie = cookieHeader(setCookieHeader(lateRotationHealth));
    const lateLogoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: lateRotatedCookie },
    });
    assert.equal(lateLogoutResponse.status, 200);
    const lateReplayAfterLogout = await fetch(`${baseUrl}/api/auth/session`, {
      headers: {
        cookie: lateRotationCookie,
      },
    });
    assert.equal(lateReplayAfterLogout.status, 200);
    assert.equal((await lateReplayAfterLogout.json()).authenticated, false);
    assert.equal(refreshRequests, lateRotationRequestsBefore + 1);

    const secondRefreshHealth = await fetch(`${baseUrl}/api/auth/session`, {
      headers: {
        cookie:
          "opengrove_auth_access=expired; opengrove_auth_refresh=refresh-refreshed; opengrove_auth_session=refresh-session-next",
      },
    });
    assert.equal(secondRefreshHealth.status, 200);
    assert.equal((await secondRefreshHealth.json()).authenticated, true);
    assert.equal(
      setCookieHeader(secondRefreshHealth).some((cookie) => cookie.includes("refresh-refreshed-again")),
      true,
    );

    const refreshRequestsBeforeParallel = refreshRequests;
    const parallelResponses = await Promise.all([
      fetch(`${baseUrl}/api/auth/session`, {
        headers: {
          cookie:
            "opengrove_auth_access=expired; opengrove_auth_refresh=refresh-parallel; opengrove_auth_session=parallel-session",
        },
      }),
      fetch(`${baseUrl}/api/auth/session`, {
        headers: {
          cookie:
            "opengrove_auth_access=expired; opengrove_auth_refresh=refresh-parallel; opengrove_auth_session=parallel-session",
        },
      }),
    ]);
    assert.equal(refreshRequests, refreshRequestsBeforeParallel + 1);
    for (const response of parallelResponses) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).authenticated, true);
    }

    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logoutResponse.status, 200);
    assert.equal(
      setCookieHeader(logoutResponse).some((entry) => entry.startsWith("opengrove_auth_access=;")),
      true,
    );
    const wwProblems = readFileSync(join(dir, "diagnostics", "problems.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((problem) => problem.category === "ww");
    assert.ok(wwProblems.length > 0);
    assert.equal(
      wwProblems.some((problem) => problem.code === "unknown_error"),
      false,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  const restoredSessionRoot = join(dir, "restored-session");
  mkdirSync(restoredSessionRoot, { recursive: true });
  const restoredSessionServer = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    statePath: join(restoredSessionRoot, "state.json"),
  });
  try {
    if (!restoredSessionServer.listening) await once(restoredSessionServer, "listening");
    const restoredSessionAddress = restoredSessionServer.address() as AddressInfo;
    const restoredSessionBaseUrl = `http://127.0.0.1:${restoredSessionAddress.port}`;
    const restoredSessionCookie = [
      "opengrove_auth_access=access-role-change",
      "opengrove_auth_refresh=refresh-login",
      "opengrove_auth_session=restored-language-session",
    ].join("; ");
    const restoredSessionResponse = await fetch(`${restoredSessionBaseUrl}/api/auth/session`, {
      headers: {
        cookie: restoredSessionCookie,
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    assert.equal(restoredSessionResponse.status, 200);
    const restoredSessionJson = await restoredSessionResponse.json();
    assert.equal(restoredSessionJson.status, "authenticated", JSON.stringify(restoredSessionJson));
    const restoredSessionSettings = await getJson(`${restoredSessionBaseUrl}/api/settings`, {
      cookie: restoredSessionCookie,
    });
    assert.equal(restoredSessionSettings.settings.languagePreference, "system");
    assert.equal(restoredSessionSettings.settings.systemLanguage, "zh-CN");
  } finally {
    await new Promise<void>((resolve, reject) => {
      restoredSessionServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
  assert.ok(installPolicyRequests > 0, "authenticated sessions must reconcile the WW App install policy");
  console.log("ww-auth-harness ok");
} finally {
  await new Promise<void>((resolve, reject) => {
    fakeWw.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousWwBaseUrl === undefined) {
    delete process.env.OPENGROVE_WW_BASE_URL;
  } else {
    process.env.OPENGROVE_WW_BASE_URL = previousWwBaseUrl;
  }
  if (previousWebAuthMode === undefined) {
    delete process.env.OPENGROVE_WEB_AUTH_MODE;
  } else {
    process.env.OPENGROVE_WEB_AUTH_MODE = previousWebAuthMode;
  }
  if (previousDiagnosticsDir === undefined) {
    delete process.env.OPENGROVE_DIAGNOSTICS_DIR;
  } else {
    process.env.OPENGROVE_DIAGNOSTICS_DIR = previousDiagnosticsDir;
  }
  if (previousDesktopChannel === undefined) {
    delete process.env.OPENGROVE_DESKTOP_CHANNEL;
  } else {
    process.env.OPENGROVE_DESKTOP_CHANNEL = previousDesktopChannel;
  }
  rmSync(dir, { recursive: true, force: true });
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

async function getJson(url: string, headers?: Record<string, string>): Promise<Record<string, any>> {
  const response = await fetch(url, { headers });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return (await response.json()) as Record<string, any>;
}

async function postJson(url: string, payload: unknown): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return (await response.json()) as Record<string, any>;
}

function setCookieHeader(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""].filter(Boolean);
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function profileAvatarDataUrl(width: number, height: number): string {
  const bytes = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}
