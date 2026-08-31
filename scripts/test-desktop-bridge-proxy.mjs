import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-desktop-bridge-proxy-"));
const bundlePath = join(tempDir, "bridge-proxy.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop", "bridge-proxy.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: bundlePath,
  });
  const { proxyDesktopBridgeRequest } = await import(pathToFileURL(bundlePath).href);

  const upstreamRequests = [];
  const storedSetCookies = [];
  const context = {
    bridgeApiBase: "http://127.0.0.1:43123/api",
    bridgeToken: "desktop-local-capability",
    proxyToken: "desktop-proxy-capability",
    mergeCookieHeader(header) {
      return [header, "opengrove_auth_refresh=saved-session"].filter(Boolean).join("; ");
    },
    applySetCookieHeaders(headers) {
      storedSetCookies.push(...headers);
    },
  };
  const fetchBridge = async (url, init) => {
    const upstreamRequest = new Request(url, init);
    upstreamRequests.push(upstreamRequest);
    if (upstreamRequest.url === "http://mcp-app.localhost:43123/mcp-app-media/media-capability") {
      return new Response("abcdefghij", {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "access-control-allow-origin": "*",
          "content-range": "bytes 10-19/36",
          "content-type": "video/mp4",
        },
      });
    }
    return new Response("upstream-stream", {
      status: 202,
      headers: {
        "content-type": "text/plain",
        "set-cookie": "opengrove_auth_access=fresh; Max-Age=60; Path=/",
      },
    });
  };

  const response = await proxyDesktopBridgeRequest(
    new Request("opengrove-desktop://ui/api/ask/stream?room=one", {
      method: "POST",
      headers: {
        "content-length": "999",
        "content-type": "application/json",
        cookie: "theme=dark",
        "x-opengrove-desktop-proxy-token": "desktop-proxy-capability",
      },
      body: JSON.stringify({ message: "hello" }),
      duplex: "half",
    }),
    context,
    fetchBridge,
  );
  assert.ok(response);
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "upstream-stream");
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, "http://127.0.0.1:43123/api/ask/stream?room=one");
  assert.equal(upstreamRequests[0].method, "POST");
  assert.equal(upstreamRequests[0].duplex, "half");
  assert.equal(upstreamRequests[0].headers.get("x-opengrove-token"), "desktop-local-capability");
  assert.equal(upstreamRequests[0].headers.get("cookie"), "theme=dark; opengrove_auth_refresh=saved-session");
  assert.equal(upstreamRequests[0].headers.has("origin"), false);
  assert.equal(upstreamRequests[0].headers.has("content-length"), false);
  assert.equal(upstreamRequests[0].headers.has("x-opengrove-desktop-proxy-token"), false);
  assert.deepEqual(await upstreamRequests[0].json(), { message: "hello" });
  assert.deepEqual(storedSetCookies, ["opengrove_auth_access=fresh; Max-Age=60; Path=/"]);

  const generated = await proxyDesktopBridgeRequest(
    desktopUiRequest("opengrove-desktop://ui/generated/image.png?size=2"),
    context,
    fetchBridge,
  );
  assert.ok(generated);
  assert.equal(upstreamRequests.at(-1).url, "http://127.0.0.1:43123/generated/image.png?size=2");

  const sandbox = await proxyDesktopBridgeRequest(
    new Request("opengrove-desktop://mcp-app/mcp-app-sandbox?hostOrigin=opengrove-desktop%3A%2F%2Fui"),
    context,
    fetchBridge,
  );
  assert.ok(sandbox);
  assert.equal(
    upstreamRequests.at(-1).url,
    "http://mcp-app.localhost:43123/mcp-app-sandbox?hostOrigin=opengrove-desktop%3A%2F%2Fui",
  );
  assert.equal(upstreamRequests.at(-1).headers.has("x-opengrove-token"), false);
  assert.equal(upstreamRequests.at(-1).headers.has("origin"), false);

  const media = await proxyDesktopBridgeRequest(
    new Request("opengrove-desktop://mcp-app/mcp-app-media/media-capability", {
      headers: {
        origin: "null",
        range: "bytes=10-19",
      },
    }),
    context,
    fetchBridge,
  );
  assert.ok(media);
  assert.equal(media.status, 206);
  assert.equal(await media.text(), "abcdefghij");
  assert.equal(upstreamRequests.at(-1).url, "http://mcp-app.localhost:43123/mcp-app-media/media-capability");
  assert.equal(upstreamRequests.at(-1).headers.get("range"), "bytes=10-19");
  assert.equal(upstreamRequests.at(-1).headers.has("origin"), false);
  assert.equal(upstreamRequests.at(-1).headers.has("x-opengrove-token"), false);
  assert.equal(upstreamRequests.at(-1).headers.has("cookie"), false);
  assert.equal(media.headers.get("accept-ranges"), "bytes");
  assert.equal(media.headers.get("access-control-allow-origin"), "*");
  assert.equal(media.headers.get("content-range"), "bytes 10-19/36");
  assert.equal(media.headers.get("content-type"), "video/mp4");

  const sandboxEscape = await proxyDesktopBridgeRequest(
    new Request("opengrove-desktop://mcp-app/api/bootstrap"),
    context,
    fetchBridge,
  );
  assert.equal(sandboxEscape?.status, 404, "the isolated MCP App origin must not reach Bridge APIs");

  const unavailable = await proxyDesktopBridgeRequest(
    desktopUiRequest("opengrove-desktop://ui/api/bootstrap"),
    { ...context, bridgeApiBase: undefined },
    fetchBridge,
  );
  assert.equal(unavailable?.status, 503);
  assert.deepEqual(await unavailable?.json(), {
    ok: false,
    error: "desktop_bridge_unavailable",
  });

  for (const bridgeApiBase of ["not a URL", "https://bridge.example.test/api"]) {
    const requestCount = upstreamRequests.length;
    const invalidTarget = await proxyDesktopBridgeRequest(
      desktopUiRequest("opengrove-desktop://ui/api/bootstrap"),
      { ...context, bridgeApiBase },
      fetchBridge,
    );
    assert.equal(invalidTarget?.status, 503);
    assert.deepEqual(await invalidTarget?.json(), {
      ok: false,
      error: "desktop_bridge_unavailable",
    });
    assert.equal(upstreamRequests.length, requestCount, "an invalid Bridge target must never be fetched");
  }

  const requestCount = upstreamRequests.length;
  const untrustedRequest = await proxyDesktopBridgeRequest(
    new Request("opengrove-desktop://ui/api/ask/stream", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
      body: "{}",
      duplex: "half",
    }),
    context,
    fetchBridge,
  );
  assert.equal(untrustedRequest?.status, 403);
  assert.deepEqual(await untrustedRequest?.json(), {
    ok: false,
    error: "desktop_bridge_request_not_trusted",
  });
  assert.equal(upstreamRequests.length, requestCount, "an untrusted desktop request must never reach the Bridge");

  const uiAsset = await proxyDesktopBridgeRequest(
    new Request("opengrove-desktop://ui/ui/assets/index.js"),
    context,
    fetchBridge,
  );
  assert.equal(uiAsset, undefined, "UI assets must stay on the packaged-file path");

  console.log("desktop-bridge-proxy harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function desktopUiRequest(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-opengrove-desktop-proxy-token", "desktop-proxy-capability");
  return new Request(url, { ...init, headers });
}
