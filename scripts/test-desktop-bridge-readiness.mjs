import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-desktop-bridge-readiness-"));
const bundlePath = join(tempDir, "bridge-readiness.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop", "bridge-readiness.ts")],
    alias: {
      "@opengrove/agent-protocol": join(projectRoot, "packages/agent-protocol/src/index.ts"),
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: bundlePath,
  });
  const { verifyDesktopBridgeReady } = await import(pathToFileURL(bundlePath).href);

  const requests = [];
  const bootstrap = await verifyDesktopBridgeReady({
    apiBase: "http://127.0.0.1:43123/api",
    bridgeToken: "desktop-capability",
    cookieHeader: "opengrove_auth_refresh=saved",
    fetchBridge: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(validBootstrap());
    },
  });
  assert.equal(bootstrap.hostId, "0123456789abcdef");
  assert.equal(requests[0].url, "http://127.0.0.1:43123/api/bootstrap");
  assert.equal(requests[0].init.headers["x-opengrove-token"], "desktop-capability");
  assert.equal(requests[0].init.headers.cookie, "opengrove_auth_refresh=saved");

  await assert.rejects(
    () =>
      verifyDesktopBridgeReady({
        apiBase: "http://127.0.0.1:43123/api",
        bridgeToken: "desktop-capability",
        fetchBridge: async () =>
          new Response("<!doctype html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      }),
    /desktop_bridge_bootstrap_invalid/u,
  );

  await assert.rejects(
    () =>
      verifyDesktopBridgeReady({
        apiBase: "http://127.0.0.1:43123/api",
        bridgeToken: "desktop-capability",
        fetchBridge: async () => jsonResponse({ error: "starting" }, 503),
      }),
    /desktop_bridge_bootstrap_http_503/u,
  );

  console.log("desktop-bridge-readiness harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function validBootstrap() {
  return {
    environment: {
      preset: "local-single",
      profile: "local",
      tenancy: "single-principal",
      execution: "local-process",
      workspace: "host-local",
      stateStore: "sqlite",
      blobStore: "filesystem",
      auth: "session",
    },
    auth: { mode: "session", tokenRequired: false },
    hostId: "0123456789abcdef",
    mcpApps: {},
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
