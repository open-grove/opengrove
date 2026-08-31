import type { IncomingMessage, ServerResponse } from "node:http";
import { APP_MCP_APP_SANDBOX_HOSTNAME } from "../identity.js";
import type { BridgeSecurity } from "./bridge-security.js";
import { mcpAppMediaCache, type McpAppMediaCache } from "./mcp-app-media-cache.js";
import { sendRawFileResponse } from "./raw-file-response.js";

const SANDBOX_HTML_PATHS = new Set(["/", "/mcp-app-sandbox"]);
const SANDBOX_SCRIPT_PATH = "/mcp-app-sandbox.js";
const MAX_CSP_QUERY_BYTES = 16_384;

export function isMcpAppSandboxRequest(request: IncomingMessage, security: BridgeSecurity): boolean {
  const requestHost = request.headers.host?.trim().toLowerCase();
  if (!requestHost) return false;
  if (security.mcpAppSandboxOrigin) {
    return requestHost === new URL(security.mcpAppSandboxOrigin).host.toLowerCase();
  }
  return requestHost.split(":")[0] === APP_MCP_APP_SANDBOX_HOSTNAME;
}

export function serveMcpAppSandbox(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  _security: BridgeSecurity,
  mediaCache: McpAppMediaCache = mcpAppMediaCache,
): void {
  if (url.pathname.startsWith("/mcp-app-media/")) {
    serveMcpAppMedia(request, response, url, mediaCache);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendSandboxText(response, 405, "Method not allowed", request.method === "HEAD");
    return;
  }
  if (url.pathname === "/mcp-app-sandbox/") {
    response.writeHead(307, {
      location: `../mcp-app-sandbox${url.search}`,
      "content-length": "0",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end();
    return;
  }
  if (url.pathname === SANDBOX_SCRIPT_PATH) {
    sendSandboxAsset(
      response,
      200,
      "text/javascript; charset=utf-8",
      MCP_APP_SANDBOX_SCRIPT,
      request.method === "HEAD",
    );
    return;
  }
  if (!SANDBOX_HTML_PATHS.has(url.pathname)) {
    sendSandboxText(response, 404, "Only the MCP App sandbox is served on this origin.", request.method === "HEAD");
    return;
  }

  const csp = parseSandboxCsp(url.searchParams.get("csp"));
  response.setHeader("Content-Security-Policy", buildSandboxCsp(csp));
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("Referrer-Policy", "strict-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  sendSandboxAsset(response, 200, "text/html; charset=utf-8", MCP_APP_SANDBOX_HTML, request.method === "HEAD");
}

interface SandboxCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

function parseSandboxCsp(value: string | null): SandboxCsp {
  if (!value || Buffer.byteLength(value) > MAX_CSP_QUERY_BYTES) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      connectDomains: sanitizeCspSources(parsed.connectDomains),
      resourceDomains: sanitizeCspSources(parsed.resourceDomains),
      frameDomains: sanitizeCspSources(parsed.frameDomains),
      baseUriDomains: sanitizeCspSources(parsed.baseUriDomains),
    };
  } catch {
    return {};
  }
}

function sanitizeCspSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === "string" && item.length <= 2_048 && !/[;\r\n'"\s]/u.test(item) && isAllowedCspSource(item),
  );
}

function isAllowedCspSource(value: string): boolean {
  const wildcard = value.startsWith("https://*.");
  if (value.includes("*") && !wildcard) return false;
  try {
    const url = new URL(wildcard ? value.replace("https://*.", "https://wildcard.") : value);
    return (
      url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
    );
  } catch {
    return false;
  }
}

function buildSandboxCsp(csp: SandboxCsp): string {
  const resources = csp.resourceDomains?.join(" ") ?? "";
  const connections = csp.connectDomains?.join(" ") || "'none'";
  const frames = csp.frameDomains?.join(" ") || "'none'";
  const baseUris = csp.baseUriDomains?.join(" ") || "'none'";
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' blob: data: ${resources}`.trim(),
    `style-src 'unsafe-inline' blob: data: ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: blob: ${resources}`.trim(),
    `media-src 'self' data: blob: ${resources}`.trim(),
    `worker-src blob: ${resources}`.trim(),
    `connect-src ${connections}`,
    `frame-src ${frames}`,
    `base-uri ${baseUris}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

function serveMcpAppMedia(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  mediaCache: McpAppMediaCache,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendSandboxText(response, 405, "Method not allowed", request.method === "HEAD");
    return;
  }
  const lease = mediaCache.acquire(url.pathname);
  if (!lease) {
    sendSandboxText(response, 404, "Media capability not found", request.method === "HEAD");
    return;
  }
  const release = () => lease.release();
  response.once("finish", release);
  response.once("close", release);
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    sendRawFileResponse(request, response, lease.rawFile, { head: request.method === "HEAD" });
  } catch (error) {
    release();
    throw error;
  }
}

function sendSandboxText(response: ServerResponse, status: number, text: string, head: boolean): void {
  sendSandboxAsset(response, status, "text/plain; charset=utf-8", text, head);
}

function sendSandboxAsset(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  head: boolean,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(head ? undefined : body);
}

const MCP_APP_SANDBOX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>MCP App sandbox</title>
<style>html,body{margin:0;width:100%;height:100%;background:transparent}body{display:flex}iframe{border:0;width:100%;height:100%;background:transparent}</style>
</head><body><script src="./mcp-app-sandbox.js"></script></body></html>`;

const MCP_APP_SANDBOX_SCRIPT = String.raw`
if (window.self === window.top) throw new Error("MCP App sandbox must be embedded");
const requestedHostOrigin = new URL(window.location.href).searchParams.get("hostOrigin");
const expectedHostOrigin = normalizeHostOrigin(requestedHostOrigin) || normalizeHostOrigin(document.referrer);
if (!expectedHostOrigin) throw new Error("MCP App sandbox requires an explicit Host origin");
const inner = document.createElement("iframe");
inner.setAttribute("sandbox", "allow-scripts allow-forms");
inner.setAttribute("title", "MCP App View");
document.body.appendChild(inner);
const RESOURCE_READY = "ui/notifications/sandbox-resource-ready";
const PROXY_READY = "ui/notifications/sandbox-proxy-ready";
const HOST_ESCAPE = "opengrove/mcp-app-exit-fullscreen";
const ESCAPE_RELAY = '<script>window.addEventListener("keydown",function(event){if(event.key==="Escape")parent.postMessage({type:"opengrove/mcp-app-exit-fullscreen"},"*")},true);<\/script>';
const permissions = { camera: "camera", microphone: "microphone", geolocation: "geolocation", clipboardWrite: "clipboard-write" };
let proxyReadyTimer;
const announceProxyReady = () => {
  window.parent.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, expectedHostOrigin);
};
window.addEventListener("message", (event) => {
  if (event.source === window.parent) {
    if (event.origin !== expectedHostOrigin) return;
    if (event.data?.method === RESOURCE_READY) {
      window.clearInterval(proxyReadyTimer);
      const params = event.data.params || {};
      const allow = Object.keys(params.permissions || {}).map((key) => permissions[key]).filter(Boolean).join("; ");
      if (allow) inner.setAttribute("allow", allow);
      if (typeof params.html === "string") inner.srcdoc = ESCAPE_RELAY + params.html;
      return;
    }
    inner.contentWindow?.postMessage(event.data, "*");
    return;
  }
  if (event.source === inner.contentWindow) {
    if (event.data?.type === HOST_ESCAPE) {
      window.parent.postMessage(event.data, expectedHostOrigin);
      return;
    }
    window.parent.postMessage(event.data, expectedHostOrigin);
  }
});
announceProxyReady();
proxyReadyTimer = window.setInterval(announceProxyReady, 250);

function normalizeHostOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim().replace(/\/$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.origin !== "null") return parsed.origin;
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i.test(trimmed)) return trimmed;
  } catch {
    // Invalid origins fall through to the rejected empty-origin result.
  }
  return "";
}
`;
