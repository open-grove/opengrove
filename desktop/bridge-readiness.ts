import { clientBootstrapContract, type ClientBootstrap } from "@opengrove/agent-protocol";
import { APP_BRIDGE_TOKEN_HEADER } from "../src/identity.js";

interface DesktopBridgeReadinessOptions {
  apiBase: string;
  bridgeToken: string;
  cookieHeader?: string;
  timeoutMs?: number;
  fetchBridge?: (url: string, init: RequestInit) => Promise<Response>;
}

export async function verifyDesktopBridgeReady(options: DesktopBridgeReadinessOptions): Promise<ClientBootstrap> {
  const apiBase = loopbackApiBase(options.apiBase);
  const headers: Record<string, string> = {};
  if (options.bridgeToken) headers[APP_BRIDGE_TOKEN_HEADER] = options.bridgeToken;
  if (options.cookieHeader) headers.cookie = options.cookieHeader;
  const fetchBridge = options.fetchBridge ?? fetch;
  const response = await fetchBridge(`${apiBase}/bootstrap`, {
    cache: "no-store",
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  if (!response.ok) {
    throw new Error(`desktop_bridge_bootstrap_http_${response.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error("desktop_bridge_bootstrap_invalid");
  }
  const parsed = clientBootstrapContract.response.safeParse(body);
  if (!parsed.success) throw new Error("desktop_bridge_bootstrap_invalid");
  return parsed.data;
}

function loopbackApiBase(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    !url.pathname.endsWith("/api")
  ) {
    throw new Error("desktop_bridge_api_base_invalid");
  }
  return url.toString().replace(/\/$/u, "");
}
