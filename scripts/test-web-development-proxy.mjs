import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { startOpenGroveServer } from "../dist/server/create-server.js";

const projectRoot = resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version;
const testRoot = await mkdtemp(join(tmpdir(), "opengrove-web-development-proxy-"));
const previousEnvironment = Object.fromEntries(
  [
    "OPENGROVE_BRIDGE_SETTINGS_PATH",
    "OPENGROVE_DATA_DIR",
    "OPENGROVE_MCP_APP_SANDBOX_ORIGIN",
    "OPENGROVE_USER_DATA_DIR",
    "OPENGROVE_WEB_AUTH_MODE",
    "OPENGROVE_WEB_DEV_BACKEND_URL",
    "OPENGROVE_WW_BASE_URL",
  ].map((name) => [name, process.env[name]]),
);

process.env.OPENGROVE_BRIDGE_SETTINGS_PATH = join(testRoot, "bridge-settings.json");
process.env.OPENGROVE_DATA_DIR = testRoot;
process.env.OPENGROVE_USER_DATA_DIR = testRoot;
process.env.OPENGROVE_WEB_AUTH_MODE = "bridge-token";
process.env.OPENGROVE_WW_BASE_URL = "";
delete process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN;

const bridge = startOpenGroveServer({
  host: "127.0.0.1",
  port: 0,
  bridgeToken: "",
  profile: "test",
  runtimeEnvironment: "test",
  statePath: join(testRoot, "state.json"),
});
let vite;

try {
  if (!bridge.listening) await new Promise((resolveListen) => bridge.once("listening", resolveListen));
  const bridgeAddress = bridge.address();
  assert.ok(bridgeAddress && typeof bridgeAddress === "object");
  process.env.OPENGROVE_WEB_DEV_BACKEND_URL = `http://127.0.0.1:${bridgeAddress.port}`;

  const vitePort = await availablePort();
  vite = await createViteServer({
    configFile: resolve(projectRoot, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: vitePort, strictPort: true },
  });
  await vite.listen();

  const hostOrigin = `http://127.0.0.1:${vitePort}`;
  const sandboxPath = `/mcp-app-sandbox?${new URLSearchParams({
    csp: JSON.stringify({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    }),
    hostOrigin,
  })}`;
  const sandboxHost = `mcp-app.localhost:${vitePort}`;
  const [sandbox, sandboxScript, missingMedia, ui, health] = await Promise.all([
    request(vitePort, sandboxPath, sandboxHost),
    request(vitePort, "/mcp-app-sandbox.js", sandboxHost),
    request(vitePort, "/mcp-app-media/missing", sandboxHost),
    request(vitePort, "/ui/", `127.0.0.1:${vitePort}`),
    request(vitePort, "/api/health", `127.0.0.1:${vitePort}`),
  ]);

  assert.equal(sandbox.status, 200, sandbox.body);
  assert.match(sandbox.headers["content-security-policy"] ?? "", /default-src 'none'/u);
  assert.match(sandbox.body, /<title>MCP App sandbox<\/title>/u);
  assert.equal(sandboxScript.status, 200, sandboxScript.body);
  assert.match(sandboxScript.headers["content-type"] ?? "", /text\/javascript/u);
  assert.match(sandboxScript.body, /sandbox-proxy-ready/u);
  assert.equal(missingMedia.status, 404);
  assert.equal(missingMedia.body, "Media capability not found");
  assert.equal(ui.status, 200, ui.body);
  assert.match(ui.body, /<title>OpenGrove<\/title>/u);
  const apiBaseMatch = /<meta\b[^>]*\bname="opengrove-api-base"[^>]*\bcontent="([^"]*)"/u.exec(ui.body);
  assert.ok(apiBaseMatch, "the development entry must declare its API base");
  const rootUiApiUrl = new URL(apiBaseMatch[1], `${hostOrigin}/ui/`);
  const nestedUiApiUrl = new URL(apiBaseMatch[1], `${hostOrigin}/instances/instance-7/ui/`);
  assert.equal(rootUiApiUrl.pathname, "/api/");
  assert.equal(nestedUiApiUrl.pathname, "/instances/instance-7/api/");
  assert.ok(ui.body.includes(`<meta name="opengrove-package-version" content="${packageVersion}" />`));
  assert.equal(health.status, 200, health.body);
  assert.equal(JSON.parse(health.body).ok, true);
} finally {
  await vite?.close();
  await new Promise((resolveClose, rejectClose) => {
    bridge.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(testRoot, { recursive: true, force: true });
}

console.log("Web development proxy harness passed.");

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
    });
  });
}

function request(port, path, host) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { host },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () => {
          resolveRequest({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", rejectRequest);
    request.setTimeout(10_000, () => request.destroy(new Error(`request timed out: ${path}`)));
    request.end();
  });
}
