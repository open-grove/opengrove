import {
  APP_BRIDGE_TOKEN_HEADER,
  APP_DESKTOP_PROXY_TOKEN_HEADER,
  APP_MCP_APP_SANDBOX_HOSTNAME,
} from "../src/identity.js";
import { responseSetCookieHeaders } from "./auth-cookies.js";

const DESKTOP_PROTOCOL = "opengrove-desktop:";
const DESKTOP_UI_HOST = "ui";
const DESKTOP_MCP_APP_HOST = "mcp-app";
const TRANSPORT_MANAGED_REQUEST_HEADERS = [
  "connection",
  "content-length",
  "cookie2",
  "host",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

export interface DesktopBridgeProxyContext {
  bridgeApiBase?: string;
  bridgeToken: string;
  proxyToken: string;
  mergeCookieHeader(header: string | undefined): string | undefined;
  applySetCookieHeaders(headers: readonly string[]): void;
}

// 取消不在这一层：request.signal 在 Electron 里根本不触发，真正可用的信号由调用方持有，
// 所以 init 不带 signal，由调用方在自己的 fetch 上补（见 ./downstream-cancellation.ts）。
export type DesktopBridgeProxyFetch = (url: string, init: DesktopBridgeRequestInit) => Promise<Response>;

type DesktopBridgeRequestInit = RequestInit & {
  duplex?: "half";
};

export async function proxyDesktopBridgeRequest(
  request: Request,
  context: DesktopBridgeProxyContext,
  fetchBridge: DesktopBridgeProxyFetch,
): Promise<Response | undefined> {
  const sourceUrl = new URL(request.url);
  if (sourceUrl.protocol !== DESKTOP_PROTOCOL) return undefined;

  if (sourceUrl.hostname === DESKTOP_UI_HOST) {
    const route = desktopUiBridgeRoute(sourceUrl.pathname);
    if (!route) return undefined;
    if (!trustedDesktopUiRequest(request, context.proxyToken)) return bridgeRequestNotTrustedResponse();
    const bridgeApiBase = loopbackBridgeApiBase(context.bridgeApiBase);
    if (!bridgeApiBase) return bridgeUnavailableResponse();
    const targetUrl = resolveBridgeTarget(bridgeApiBase, route, sourceUrl.search);
    const headers = authenticatedBridgeHeaders(request.headers, context);
    headers.delete("origin");
    return fetchAndStoreAuthCookies(request, targetUrl, headers, context, fetchBridge);
  }

  if (sourceUrl.hostname === DESKTOP_MCP_APP_HOST) {
    if (!isMcpAppProxyRoute(sourceUrl.pathname)) return notFoundResponse();
    const bridgeApiBase = loopbackBridgeApiBase(context.bridgeApiBase);
    if (!bridgeApiBase) return bridgeUnavailableResponse();
    const targetUrl = resolveMcpAppSandboxTarget(bridgeApiBase, sourceUrl);
    const headers = forwardedHeaders(request.headers);
    headers.delete("origin");
    return fetchBridge(targetUrl, requestInit(request, headers));
  }

  return notFoundResponse();
}

function desktopUiBridgeRoute(pathname: string): { kind: "api" | "static"; pathname: string } | undefined {
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return { kind: "api", pathname: pathname.slice("/api".length) || "/" };
  }
  if (pathname.startsWith("/generated/") || pathname.startsWith("/vault-file/")) {
    return { kind: "static", pathname };
  }
  return undefined;
}

function resolveBridgeTarget(base: URL, route: { kind: "api" | "static"; pathname: string }, search: string): string {
  const target = new URL(base.origin);
  target.pathname = route.kind === "api" ? `${base.pathname.replace(/\/$/u, "")}${route.pathname}` : route.pathname;
  target.search = search;
  return target.toString();
}

function resolveMcpAppSandboxTarget(base: URL, sourceUrl: URL): string {
  const target = new URL(base.origin);
  target.hostname = APP_MCP_APP_SANDBOX_HOSTNAME;
  target.pathname = sourceUrl.pathname;
  target.search = sourceUrl.search;
  return target.toString();
}

function loopbackBridgeApiBase(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function trustedDesktopUiRequest(request: Request, proxyToken: string): boolean {
  return Boolean(proxyToken) && request.headers.get(APP_DESKTOP_PROXY_TOKEN_HEADER) === proxyToken;
}

function authenticatedBridgeHeaders(input: Headers, context: DesktopBridgeProxyContext): Headers {
  const headers = forwardedHeaders(input);
  headers.delete(APP_DESKTOP_PROXY_TOKEN_HEADER);
  if (context.bridgeToken) headers.set(APP_BRIDGE_TOKEN_HEADER, context.bridgeToken);
  const cookie = context.mergeCookieHeader(headers.get("cookie") ?? undefined);
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  return headers;
}

function forwardedHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of TRANSPORT_MANAGED_REQUEST_HEADERS) headers.delete(name);
  return headers;
}

async function fetchAndStoreAuthCookies(
  request: Request,
  targetUrl: string,
  headers: Headers,
  context: DesktopBridgeProxyContext,
  fetchBridge: DesktopBridgeProxyFetch,
): Promise<Response> {
  const response = await fetchBridge(targetUrl, requestInit(request, headers));
  context.applySetCookieHeaders(responseSetCookieHeaders(response.headers));
  return response;
}

function requestInit(request: Request, headers: Headers): DesktopBridgeRequestInit {
  return {
    method: request.method,
    headers,
    ...(request.method === "GET" || request.method === "HEAD" || !request.body
      ? {}
      : { body: request.body, duplex: "half" }),
  };
}

function isMcpAppProxyRoute(pathname: string): boolean {
  return (
    pathname === "/mcp-app-sandbox" || pathname === "/mcp-app-sandbox.js" || pathname.startsWith("/mcp-app-media/")
  );
}

function bridgeUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "desktop_bridge_unavailable",
    }),
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "retry-after": "1",
      },
    },
  );
}

function bridgeRequestNotTrustedResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "desktop_bridge_request_not_trusted",
    }),
    {
      status: 403,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

function notFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
