import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { appEnvName, readAppEnv } from "../../identity.js";
import { packageRoot } from "../../package-root.js";
import { GENERATED_ASSET_ROUTE, VAULT_FILE_ROUTE } from "../bridge-types.js";
import { isEnabledEnvFlag } from "../env-flags.js";
import { knowledgeVaultRoot } from "../knowledge-files.js";

export function serveStaticRoute(url: URL, response: ServerResponse, headOnly = false): boolean {
  return servePublicStaticRoute(url, response, headOnly) || serveProtectedStaticRoute(url, response, headOnly);
}

export function servePublicStaticRoute(url: URL, response: ServerResponse, headOnly = false): boolean {
  if (!isBrowserUiEnabled()) {
    return serveBrowserUiDisabledRoute(url, response, headOnly);
  }
  return serveUiRoute(url, response, headOnly);
}

export function serveProtectedStaticRoute(url: URL, response: ServerResponse, headOnly = false): boolean {
  return serveGeneratedAssetRoute(url, response, headOnly) || serveVaultFileRoute(url, response, headOnly);
}

function serveUiRoute(url: URL, response: ServerResponse, headOnly: boolean): boolean {
  if (url.pathname === "/" || url.pathname === "/ui") {
    response.writeHead(302, { location: "/ui/" });
    response.end();
    return true;
  }

  if (serveModernUiRootAssetRoute(url, response, headOnly)) {
    return true;
  }

  if (!url.pathname.startsWith("/ui/")) {
    return false;
  }

  if (!serveModernUiRoute(url, response, headOnly)) {
    sendJson(response, 404, { ok: false, error: "ui_asset_not_found" }, headOnly);
  }
  return true;
}

function serveBrowserUiDisabledRoute(url: URL, response: ServerResponse, headOnly: boolean): boolean {
  if (!isBrowserUiRequest(url)) {
    return false;
  }
  sendJson(
    response,
    404,
    {
      ok: false,
      error: "browser_ui_disabled",
      message: `The browser UI is disabled by default. Set ${appEnvName("ENABLE_BROWSER_UI")}=1 or run npm run bridge:web to serve /ui/.`,
    },
    headOnly,
  );
  return true;
}

function isBrowserUiRequest(url: URL): boolean {
  return (
    url.pathname === "/" ||
    url.pathname === "/ui" ||
    url.pathname.startsWith("/ui/") ||
    url.pathname === "/version.json" ||
    url.pathname.startsWith("/assets/")
  );
}

function isBrowserUiEnabled(): boolean {
  return isEnabledEnvFlag(readAppEnv("ENABLE_BROWSER_UI"));
}

function serveModernUiRootAssetRoute(url: URL, response: ServerResponse, headOnly: boolean): boolean {
  if (url.pathname !== "/version.json" && !url.pathname.startsWith("/assets/")) {
    return false;
  }

  const root = resolve(packageRoot(), "web-dist");
  if (!existsSync(root)) {
    return false;
  }

  const requested = url.pathname.replace(/^\/+/, "");
  const file = safeResolveInside(root, requested);
  if (!file || !existsSync(file)) {
    sendJson(response, 404, { ok: false, error: "ui_asset_not_found" }, headOnly);
    return true;
  }

  sendUiFile(response, file, undefined, headOnly);
  return true;
}

function serveGeneratedAssetRoute(url: URL, response: ServerResponse, headOnly: boolean): boolean {
  if (!url.pathname.startsWith(GENERATED_ASSET_ROUTE)) {
    return false;
  }

  const root = resolve(process.cwd(), "data/generated");
  const requested = decodeURIComponent(url.pathname.slice(GENERATED_ASSET_ROUTE.length)).replace(/^\/+/, "");
  const file = safeResolveInside(root, requested);
  if (!file || !existsSync(file)) {
    sendJson(response, 404, { ok: false, error: "generated_asset_not_found" }, headOnly);
    return true;
  }

  sendUiFile(response, file, undefined, headOnly);
  return true;
}

function serveVaultFileRoute(url: URL, response: ServerResponse, headOnly: boolean): boolean {
  if (!url.pathname.startsWith(VAULT_FILE_ROUTE)) {
    return false;
  }

  const root = knowledgeVaultRoot();
  const requested = decodeURIComponent(url.pathname.slice(VAULT_FILE_ROUTE.length)).replace(/^\/+/, "");
  const file = safeResolveInside(root, requested);
  if (!file || !existsSync(file)) {
    sendJson(response, 404, { ok: false, error: "vault_file_not_found" }, headOnly);
    return true;
  }

  try {
    if (!statSync(file).isFile()) {
      sendJson(response, 404, { ok: false, error: "vault_file_not_found" }, headOnly);
      return true;
    }
  } catch {
    sendJson(response, 404, { ok: false, error: "vault_file_not_found" }, headOnly);
    return true;
  }

  sendUiFile(response, file, undefined, headOnly);
  return true;
}

function serveModernUiRoute(url: URL, response: ServerResponse, headOnly: boolean): boolean {
  const root = resolve(packageRoot(), "web-dist");
  if (!existsSync(root)) {
    return false;
  }

  const routeName = url.pathname.slice("/ui/".length) || "index.html";
  const requested = routeName.replace(/^\/+/, "");
  const file = safeResolveInside(root, requested);
  if (file && existsSync(file)) {
    sendUiFile(response, file, undefined, headOnly);
    return true;
  }

  if (!requested.includes(".")) {
    const indexFile = safeResolveInside(root, "index.html");
    if (indexFile && existsSync(indexFile)) {
      sendUiFile(response, indexFile, undefined, headOnly);
      return true;
    }
  }

  return false;
}

function safeResolveInside(root: string, requestedPath: string): string | undefined {
  const candidate = resolve(root, requestedPath);
  const relation = relative(root, candidate);
  if (relation.startsWith("..") || relation.includes(`..${sep}`)) {
    return undefined;
  }
  return candidate;
}

function sendUiFile(
  response: ServerResponse,
  path: string,
  contentType = contentTypeForPath(path),
  headOnly = false,
): void {
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(headOnly ? undefined : readFileSync(path));
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function sendJson(response: ServerResponse, status: number, data: unknown, headOnly = false): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(headOnly ? undefined : JSON.stringify(data));
}
