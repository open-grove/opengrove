import { hasBridgeTokenAccess, readWwRuntimeAuth } from "../bridge-security.js";
import type { BridgeRouteContext } from "../router.js";

const WITHDRAWAL_PROXY_TIMEOUT_MS = 30_000;

const PAYMENT_PROXY_ROUTES = new Set([
  "GET /v1/users/me",
  "GET /v1/payment/payout-profile/status",
  "POST /v1/payment/payout-profile/verifications",
  "POST /v1/payment/h5-sign/applications",
  "GET /v1/stripe-connect/status",
  "POST /v1/stripe-connect/tax-onboarding-links",
  "POST /v1/stripe-connect/sync",
  "GET /v1/payout-orders",
  "POST /v1/payout-orders",
]);

export async function handleWithdrawalRoute(context: BridgeRouteContext): Promise<boolean> {
  const method = context.request.method ?? "GET";
  const pathname = context.url.pathname;
  if (!isWithdrawalProxyRoute(method, pathname)) return false;

  if (!isTrustedWithdrawalRequest(context)) {
    context.sendJson(context.response, 403, {
      ok: false,
      error: "withdrawal_origin_not_allowed",
    });
    return true;
  }

  if (!context.security.wwBaseUrl) {
    context.sendJson(context.response, 503, {
      ok: false,
      error: "ww_auth_not_configured",
    });
    return true;
  }

  const runtimeAuth = await readWwRuntimeAuth(context.request, context.response, context.security);
  if (!runtimeAuth?.auth.accessToken) {
    context.sendJson(context.response, 401, {
      ok: false,
      error: "session_required",
    });
    return true;
  }

  let body: unknown;
  try {
    body =
      method === "GET" || isWithdrawalEmptyPostRoute(method, pathname)
        ? undefined
        : sanitizeWithdrawalProxyBody(pathname, await context.readJsonBody(context.request));
  } catch (error) {
    context.sendJson(context.response, 400, {
      ok: false,
      error: error instanceof WithdrawalInputError ? error.code : "withdrawal_request_invalid",
    });
    return true;
  }
  const upstreamUrl = withdrawalUpstreamUrl(context.security.wwBaseUrl, context.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WITHDRAWAL_PROXY_TIMEOUT_MS);
  try {
    const upstream = await fetch(upstreamUrl, {
      method,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${runtimeAuth.auth.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    context.sendJson(context.response, upstream.status, await readWithdrawalProxyResponse(upstream));
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    console.warn("withdrawal_proxy_request_failed", {
      traceId: context.traceId,
      method,
      pathname,
      reason: withdrawalProxyFailureReason(error, aborted),
    });
    context.sendJson(context.response, aborted ? 504 : 502, {
      ok: false,
      error: aborted ? "withdrawal_proxy_timeout" : "withdrawal_proxy_failed",
    });
  } finally {
    clearTimeout(timeout);
  }

  return true;
}

function isTrustedWithdrawalRequest(context: BridgeRouteContext): boolean {
  if (hasBridgeTokenAccess(context.request, context.security)) return true;
  const originHeader = context.request.headers.origin;
  if (originHeader === undefined) return true;
  if (Array.isArray(originHeader)) return false;
  const origin = originHeader.trim();
  if (!origin) return true;
  return origin === context.url.origin || context.security.allowedOrigins.includes(origin);
}

function isWithdrawalProxyRoute(method: string, pathname: string): boolean {
  if (PAYMENT_PROXY_ROUTES.has(`${method} ${pathname}`)) return true;
  return (
    (method === "GET" && /^\/v1\/payout-orders\/[^/]+$/.test(pathname)) ||
    (method === "POST" && /^\/v1\/payout-orders\/[^/]+\/sync$/.test(pathname))
  );
}

function isWithdrawalEmptyPostRoute(method: string, pathname: string): boolean {
  return (
    method === "POST" &&
    (pathname === "/v1/payment/h5-sign/applications" ||
      pathname === "/v1/stripe-connect/tax-onboarding-links" ||
      pathname === "/v1/stripe-connect/sync" ||
      pathname === "/v1/payout-orders" ||
      /^\/v1\/payout-orders\/[^/]+\/sync$/.test(pathname))
  );
}

function withdrawalUpstreamUrl(baseUrl: string, url: URL): string {
  const upstream = new URL(url.pathname.replace(/^\/+/, ""), ensureTrailingSlash(baseUrl));
  upstream.search = url.search;
  return upstream.toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function sanitizeWithdrawalProxyBody(pathname: string, body: unknown): unknown {
  const record = asRecord(body);
  if (pathname === "/v1/payment/payout-profile/verifications") {
    return pickFields(record, ["real_name", "id_card", "bank_card_no", "phone_no"]);
  }
  return record;
}

async function readWithdrawalProxyResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return response.ok ? { ok: true } : { ok: false, error: "empty_response" };
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "withdrawal_upstream_non_json" };
  }
}

function pickFields(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => Object.prototype.hasOwnProperty.call(record, field))
      .map((field) => [field, record[field]]),
  );
}

function withdrawalProxyFailureReason(error: unknown, aborted: boolean): string {
  if (aborted) return "timeout";
  if (!(error instanceof Error)) return "unknown";
  const cause = error.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9_]+$/iu.test(code)) return code;
  }
  return error.name || "error";
}

class WithdrawalInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}
