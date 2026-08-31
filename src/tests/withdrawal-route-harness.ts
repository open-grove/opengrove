import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { APP_BRIDGE_TOKEN_HEADER } from "../identity.js";
import { cacheAuthSessionUser } from "../server/bridge-security.js";
import { handleWithdrawalRoute } from "../server/routes/withdrawal.js";
import type { BridgeRouteContext } from "../server/router.js";

const BRIDGE_ORIGIN = "http://127.0.0.1:37371";
const FOREIGN_LOOPBACK_ORIGIN = "http://127.0.0.1:41000";
const upstreamRequests: Array<{ path: string; authorization: string; body: unknown; bodyText: string }> = [];
const upstreamContentTypes: string[] = [];
const upstream = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const authorization = String(request.headers.authorization ?? "");
  if (url.pathname === "/v1/users/me") {
    sendJson(response, 200, {
      data: {
        user_id: authorization.includes("admin-access") ? "admin-user" : "member-user",
        email: authorization.includes("admin-access") ? "admin@example.test" : "member@example.test",
        role: authorization.includes("admin-access") ? "admin" : "member",
        cash_balance_cents: 12_888,
        cash_frozen_cents: 0,
        total_cash_earned_cents: 42_890,
        total_cash_withdrawn_cents: 0,
      },
    });
    return;
  }
  const bodyText = request.method === "GET" ? "" : await readBody(request);
  const body = bodyText ? JSON.parse(bodyText) : undefined;
  upstreamRequests.push({ path: `${url.pathname}${url.search}`, authorization, body, bodyText });
  upstreamContentTypes.push(String(request.headers["content-type"] ?? ""));
  if (
    url.pathname === "/v1/payment/payout-profile/verifications" &&
    (body as { real_name?: unknown } | undefined)?.real_name === "non-json"
  ) {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("internal bank provider secret");
    return;
  }
  sendJson(response, 200, { ok: true, order_id: "payout-order-1", status: "processing" });
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const address = upstream.address() as AddressInfo;
const wwBaseUrl = `http://127.0.0.1:${address.port}`;

try {
  cacheUser("admin-session", "admin-access", "admin-user", "admin");
  cacheUser("member-session", "member-access", "member-user", "member");

  const crossOrigin = await callRoute(
    "member-session",
    "member-access",
    "/v1/payout-orders",
    {
      ignored: "cross-origin-request-must-not-pass",
    },
    "POST",
    {
      bridgeOrigin: BRIDGE_ORIGIN,
      origin: FOREIGN_LOOPBACK_ORIGIN,
    },
  );
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(crossOrigin.body, { ok: false, error: "withdrawal_origin_not_allowed" });
  assert.equal(crossOrigin.bodyReads, 0);
  assert.equal(upstreamRequests.length, 0);

  const missingSession = await callRoute(
    "",
    "",
    "/v1/payment/payout-profile/verifications",
    {
      real_name: "sensitive-body-must-not-be-read",
    },
    "POST",
    {
      bridgeOrigin: BRIDGE_ORIGIN,
      cookie: "",
      origin: BRIDGE_ORIGIN,
    },
  );
  assert.equal(missingSession.status, 401);
  assert.deepEqual(missingSession.body, { ok: false, error: "session_required" });
  assert.equal(missingSession.bodyReads, 0);
  assert.equal(upstreamRequests.length, 0);

  const unconfigured = await callRoute(
    "member-session",
    "member-access",
    "/v1/payment/payout-profile/verifications",
    {
      real_name: "sensitive-body-must-not-be-read",
    },
    "POST",
    {
      bridgeOrigin: BRIDGE_ORIGIN,
      configureWw: false,
      origin: BRIDGE_ORIGIN,
    },
  );
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(unconfigured.body, { ok: false, error: "ww_auth_not_configured" });
  assert.equal(unconfigured.bodyReads, 0);
  assert.equal(upstreamRequests.length, 0);

  const member = await callRoute(
    "member-session",
    "member-access",
    "/v1/payout-orders",
    {
      ignored: "must-not-pass",
    },
    "POST",
    {
      bridgeOrigin: BRIDGE_ORIGIN,
      origin: BRIDGE_ORIGIN,
    },
  );
  assert.equal(member.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    path: "/v1/payout-orders",
    authorization: "Bearer member-access",
    body: undefined,
    bodyText: "",
  });

  const configuredHostOrigin = "https://app.example.test";
  const list = await callRoute(
    "member-session",
    "member-access",
    "/v1/payout-orders?page=2&page_size=50",
    undefined,
    "GET",
    {
      allowedOrigins: [configuredHostOrigin],
      bridgeOrigin: BRIDGE_ORIGIN,
      origin: configuredHostOrigin,
    },
  );
  assert.equal(list.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    path: "/v1/payout-orders?page=2&page_size=50",
    authorization: "Bearer member-access",
    body: undefined,
    bodyText: "",
  });

  const profileVerification = await callRoute(
    "member-session",
    "member-access",
    "/v1/payment/payout-profile/verifications",
    {
      real_name: "张三",
      id_card: "11010519491231002X",
      bank_card_no: "6222020000000000",
      phone_no: "13800138000",
      ignored: "must-not-pass",
    },
  );
  assert.equal(profileVerification.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    path: "/v1/payment/payout-profile/verifications",
    authorization: "Bearer member-access",
    body: {
      real_name: "张三",
      id_card: "11010519491231002X",
      bank_card_no: "6222020000000000",
      phone_no: "13800138000",
    },
    bodyText: JSON.stringify({
      real_name: "张三",
      id_card: "11010519491231002X",
      bank_card_no: "6222020000000000",
      phone_no: "13800138000",
    }),
  });

  const detail = await callRoute(
    "member-session",
    "member-access",
    "/v1/payout-orders/payout-order-1",
    undefined,
    "GET",
    {
      bridgeOrigin: BRIDGE_ORIGIN,
      bridgeToken: "desktop-capability",
      origin: FOREIGN_LOOPBACK_ORIGIN,
      presentedBridgeToken: "desktop-capability",
    },
  );
  assert.equal(detail.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    path: "/v1/payout-orders/payout-order-1",
    authorization: "Bearer member-access",
    body: undefined,
    bodyText: "",
  });

  const signApplication = await callRoute("member-session", "member-access", "/v1/payment/h5-sign/applications", {
    ignored: "must-not-pass",
  });
  assert.equal(signApplication.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    path: "/v1/payment/h5-sign/applications",
    authorization: "Bearer member-access",
    body: undefined,
    bodyText: "",
  });

  const synced = await callRoute("member-session", "member-access", "/v1/payout-orders/payout-order-1/sync", {
    ignored: "must-not-pass",
  });
  assert.equal(synced.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    path: "/v1/payout-orders/payout-order-1/sync",
    authorization: "Bearer member-access",
    body: undefined,
    bodyText: "",
  });

  const connectStatus = await callRoute(
    "member-session",
    "member-access",
    "/v1/stripe-connect/status",
    undefined,
    "GET",
  );
  assert.equal(connectStatus.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    path: "/v1/stripe-connect/status",
    authorization: "Bearer member-access",
    body: undefined,
    bodyText: "",
  });

  const upstreamRequestCountBeforeConsent = upstreamRequests.length;
  const consent = await callRoute(
    "member-session",
    "member-access",
    "/v1/stripe-connect/consents",
    {
      agreement_version: "2026-08-19",
      accepted_at: "must-not-pass",
      ignored: "must-not-pass",
    },
    "POST",
    {
      handled: false,
    },
  );
  assert.equal(consent.bodyReads, 0);
  assert.equal(upstreamRequests.length, upstreamRequestCountBeforeConsent);

  const onboarding = await callRoute("member-session", "member-access", "/v1/stripe-connect/tax-onboarding-links", {
    ignored: "must-not-pass",
  });
  assert.equal(onboarding.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    path: "/v1/stripe-connect/tax-onboarding-links",
    authorization: "Bearer member-access",
    body: undefined,
    bodyText: "",
  });
  assert.equal(upstreamContentTypes.at(-1), "");

  const connectSync = await callRoute("member-session", "member-access", "/v1/stripe-connect/sync", {
    ignored: "must-not-pass",
  });
  assert.equal(connectSync.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    path: "/v1/stripe-connect/sync",
    authorization: "Bearer member-access",
    body: undefined,
    bodyText: "",
  });
  assert.equal(upstreamContentTypes.at(-1), "");

  const nonJson = await callRoute("member-session", "member-access", "/v1/payment/payout-profile/verifications", {
    real_name: "non-json",
    id_card: "11010519491231002X",
    bank_card_no: "6222020000000000",
    phone_no: "13800138000",
  });
  assert.equal(nonJson.status, 502);
  assert.deepEqual(nonJson.body, { ok: false, error: "withdrawal_upstream_non_json" });
  assert.equal(JSON.stringify(nonJson.body).includes("bank provider secret"), false);

  const unavailableUpstream = createServer();
  await new Promise<void>((resolve) => unavailableUpstream.listen(0, "127.0.0.1", resolve));
  const unavailableAddress = unavailableUpstream.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    unavailableUpstream.close((error) => (error ? reject(error) : resolve())),
  );
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  const unavailable = await (async () => {
    try {
      return await callRoute("member-session", "member-access", "/v1/stripe-connect/status", undefined, "GET", {
        wwBaseUrl: `http://127.0.0.1:${unavailableAddress.port}`,
      });
    } finally {
      console.warn = originalWarn;
    }
  })();
  assert.equal(unavailable.status, 502);
  assert.deepEqual(unavailable.body, { ok: false, error: "withdrawal_proxy_failed" });
  assert.equal(warnings[0]?.[0], "withdrawal_proxy_request_failed");
  assert.deepEqual(warnings[0]?.[1], {
    traceId: "withdrawal-harness",
    method: "GET",
    pathname: "/v1/stripe-connect/status",
    reason: "ECONNREFUSED",
  });
  assert.equal(JSON.stringify(warnings).includes("member-access"), false);

  console.log("withdrawal-route-harness ok");
} finally {
  await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
}

function cacheUser(sessionId: string, accessToken: string, userId: string, role: string): void {
  cacheAuthSessionUser(
    sessionId,
    accessToken,
    {
      userId,
      email: `${userId}@example.test`,
      displayName: userId,
      role,
    },
    3_600,
  );
}

async function callRoute(
  sessionId: string,
  accessToken: string,
  path: string,
  requestBody: unknown,
  method = "POST",
  options: {
    allowedOrigins?: string[];
    bridgeOrigin?: string;
    bridgeToken?: string;
    configureWw?: boolean;
    cookie?: string;
    origin?: string;
    presentedBridgeToken?: string;
    handled?: boolean;
    wwBaseUrl?: string;
  } = {},
): Promise<{ status: number; body: unknown; bodyReads: number }> {
  let status = 0;
  let body: unknown;
  let bodyReads = 0;
  const cookie =
    options.cookie ??
    `opengrove_auth_access=${accessToken}; opengrove_auth_refresh=refresh; opengrove_auth_session=${sessionId}`;
  const handled = await handleWithdrawalRoute({
    request: {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.presentedBridgeToken ? { [APP_BRIDGE_TOKEN_HEADER]: options.presentedBridgeToken } : {}),
      },
    } as unknown as IncomingMessage,
    response: { setHeader() {} } as unknown as ServerResponse,
    url: new URL(path, options.bridgeOrigin ?? "http://opengrove.test"),
    traceId: "withdrawal-harness",
    state: {} as BridgeRouteContext["state"],
    security: {
      authMode: "session",
      ...(options.configureWw === false ? {} : { wwBaseUrl: options.wwBaseUrl ?? wwBaseUrl }),
      allowedOrigins: options.allowedOrigins ?? [],
      ...(options.bridgeToken ? { bridgeToken: options.bridgeToken } : {}),
    },
    sendJson: (_response, responseStatus, responseBody) => {
      status = responseStatus;
      body = responseBody;
    },
    readJsonBody: async () => {
      bodyReads += 1;
      return requestBody;
    },
  });
  assert.equal(handled, options.handled ?? true);
  return { status, body, bodyReads };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
