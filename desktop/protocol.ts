import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { APP_DESKTOP_UI_ORIGIN } from "../src/identity.js";
import { proxyDesktopBridgeRequest, type DesktopBridgeProxyContext } from "./bridge-proxy.js";
import { createDownstreamCancellation } from "./downstream-cancellation.js";
import { createDesktopContentSecurityPolicy } from "./security-policy.js";

export const DESKTOP_PROTOCOL = "opengrove-desktop";
export const DESKTOP_UI_ORIGIN = APP_DESKTOP_UI_ORIGIN;

export function registerDesktopProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function registerDesktopProtocol(
  webRoot: string,
  getContext: () => DesktopBridgeProxyContext & {
    mcpAppSandboxOrigin?: string;
  },
): void {
  const normalizedRoot = normalize(webRoot);
  protocol.handle(DESKTOP_PROTOCOL, async (request) => {
    const cancellation = createDownstreamCancellation(request.signal);
    try {
      const context = getContext();
      const bridgeResponse = await proxyDesktopBridgeRequest(request, context, (url, init) =>
        net.fetch(url, { ...init, signal: cancellation.signal }),
      );
      if (bridgeResponse) return cancellation.cancelable(bridgeResponse);

      const filePath = resolveWebAsset(normalizedRoot, new URL(request.url));
      const response = cancellation.cancelable(
        await net.fetch(pathToFileURL(filePath).toString(), { signal: cancellation.signal }),
      );
      if (extname(filePath).toLowerCase() !== ".html") {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", createDesktopContentSecurityPolicy(context.mcpAppSandboxOrigin));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      // 下游自己放弃了请求（播放器 seek 一次就会取消一批 Range 请求），这不是故障，别记成 502。
      if (!cancellation.signal.aborted) {
        console.error("Desktop custom-protocol request failed", error);
      }
      return new Response(
        JSON.stringify({
          ok: false,
          error: "desktop_protocol_request_failed",
        }),
        {
          status: 502,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    }
  });
}

function resolveWebAsset(webRoot: string, url: URL): string {
  const pathname = decodeURIComponent(url.pathname);
  const relativePath =
    pathname === "/" || pathname === "/ui/"
      ? "index.html"
      : pathname.startsWith("/ui/")
        ? pathname.slice("/ui/".length)
        : pathname.replace(/^\/+/, "");
  const candidate = normalize(join(webRoot, relativePath || "index.html"));
  if (!isInside(candidate, webRoot)) {
    return join(webRoot, "index.html");
  }
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }
  if (!extname(candidate)) {
    return join(webRoot, "index.html");
  }
  return candidate;
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
