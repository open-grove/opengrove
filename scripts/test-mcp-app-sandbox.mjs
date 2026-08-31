import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { startOpenGroveServer } from "../dist/server/create-server.js";

const TINY_MP4_BASE64 =
  "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";

const previousAuthMode = process.env.OPENGROVE_WEB_AUTH_MODE;
const previousSandboxOrigin = process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN;
const previousUserDataDir = process.env.OPENGROVE_USER_DATA_DIR;
const previousSettingsPath = process.env.OPENGROVE_BRIDGE_SETTINGS_PATH;
const testRoot = await mkdtemp(join(tmpdir(), "opengrove-mcp-app-browser-"));
const mountedAppRoot = join(testRoot, "mcp-app-basic");
const settingsPath = join(testRoot, "bridge-settings.json");
await cp(resolve("examples/mcp-app-basic"), mountedAppRoot, { recursive: true });
await writeFile(
  settingsPath,
  JSON.stringify(
    {
      mountedApps: [{ id: "mcp-app-basic", title: "MCP App Basic", path: mountedAppRoot, enabled: true }],
    },
    null,
    2,
  ),
);
process.env.OPENGROVE_WEB_AUTH_MODE = "bridge-token";
process.env.OPENGROVE_USER_DATA_DIR = testRoot;
process.env.OPENGROVE_BRIDGE_SETTINGS_PATH = settingsPath;
delete process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN;

const server = startOpenGroveServer({
  host: "127.0.0.1",
  port: 0,
  bridgeToken: "",
  profile: "test",
  runtimeEnvironment: "test",
  statePath: join(testRoot, "state.json"),
});
let browser;

try {
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const hostOrigin = `http://127.0.0.1:${address.port}`;
  const sandboxUrl = new URL(`http://mcp-app.localhost:${address.port}/mcp-app-sandbox`);
  sandboxUrl.searchParams.set(
    "csp",
    JSON.stringify({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    }),
  );
  sandboxUrl.searchParams.set("hostOrigin", hostOrigin);

  browser = await chromium.launch({
    headless: true,
    args: ["--no-proxy-server"],
  });
  const page = await browser.newPage();
  await page.goto(`${hostOrigin}/opengrove-probe`);
  const result = await page.evaluate(
    async ({ sandboxUrl, bridgeUrl }) => {
      const iframe = document.createElement("iframe");
      iframe.sandbox.add("allow-scripts", "allow-forms");
      iframe.referrerPolicy = "no-referrer";
      iframe.src = sandboxUrl;
      const loaded = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
      document.body.replaceChildren(iframe);
      await loaded;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      return await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("sandbox_e2e_timeout")), 10_000);
        const onMessage = (event) => {
          if (event.source !== iframe.contentWindow) return;
          if (event.data?.method === "ui/notifications/sandbox-proxy-ready") {
            const html = `<!doctype html><script>
            (async () => {
              let bridgeFetch = "unexpected_success";
              try {
                const response = await fetch(${JSON.stringify(bridgeUrl)}, { credentials: "include" });
                bridgeFetch = "http_" + response.status;
              } catch {
                bridgeFetch = "blocked";
              }
              parent.postMessage({ kind: "mcp-app-sandbox-e2e", bridgeFetch, origin: location.origin }, "*");
            })();
          <\/script>`;
            iframe.contentWindow.postMessage(
              {
                jsonrpc: "2.0",
                method: "ui/notifications/sandbox-resource-ready",
                params: { html, sandbox: "allow-scripts allow-forms", csp: {}, permissions: {} },
              },
              "*",
            );
            return;
          }
          if (event.data?.kind === "mcp-app-sandbox-e2e") {
            window.clearTimeout(timeout);
            window.removeEventListener("message", onMessage);
            resolve(event.data);
          }
        };
        window.addEventListener("message", onMessage);
      });
    },
    {
      sandboxUrl: sandboxUrl.toString(),
      bridgeUrl: `${hostOrigin}/api/bootstrap`,
    },
  );

  assert.deepEqual(result, {
    kind: "mcp-app-sandbox-e2e",
    bridgeFetch: "blocked",
    origin: "null",
  });
  const relayedEscape = await page.evaluate(async () => {
    const iframe = document.querySelector("iframe");
    if (!iframe?.contentWindow) throw new Error("sandbox iframe missing");
    return await new Promise((resolvePromise, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("sandbox_escape_relay_timeout")), 5_000);
      const onMessage = (event) => {
        if (event.source !== iframe.contentWindow || event.data?.type !== "opengrove/mcp-app-exit-fullscreen") return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolvePromise(event.data.type);
      };
      window.addEventListener("message", onMessage);
      iframe.contentWindow.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/sandbox-resource-ready",
          params: {
            html: '<!doctype html><script>window.setTimeout(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })), 0)<\/script>',
            sandbox: "allow-scripts allow-forms",
            csp: {},
            permissions: {},
          },
        },
        "*",
      );
    });
  });
  assert.equal(relayedEscape, "opengrove/mcp-app-exit-fullscreen");

  const contractResponse = await fetch(`${hostOrigin}/api/apps/mcp-app-basic/mcp-app/contract`);
  assert.equal(contractResponse.status, 200);
  const contractPayload = await contractResponse.json();
  assert.ok(contractPayload.ok && contractPayload.contract);
  const hostBundle = await bundleBrowserSource(independentHostSource(), "independent-mcp-host.js");
  await page.addScriptTag({ content: hostBundle });

  await mountContractInIndependentHost(page, {
    sandboxUrl: sandboxUrl.toString(),
    hostOrigin,
    contract: contractPayload.contract,
  });
  const openGroveView = await frameWithSelector(page, "#list-files");
  await openGroveView.locator("#status").waitFor({ state: "visible" });
  await openGroveView.locator("#list-files").click();
  await openGroveView.locator("#output").waitFor({ state: "visible" });
  await assertEventually(
    async () => (await openGroveView.locator("#output").textContent())?.includes("README.md") === true,
  );
  await openGroveView.locator("#write-read-file").click();
  await assertEventually(
    async () =>
      (await openGroveView.locator("#output").textContent())?.includes("workspace round trip complete") === true,
  );
  await openGroveView.locator("#run-command").click();
  await assertEventually(
    async () => (await openGroveView.locator("#output").textContent())?.includes("declared command complete") === true,
    10_000,
    async () => `command output: ${await openGroveView.locator("#output").textContent()}`,
  );
  await disposeIndependentHost(page);

  const upstreamBundle = await bundleBrowserSource(officialUpstreamAppSource(), "official-upstream-app.js");
  const upstreamResult = await mountOfficialUpstreamApp(page, {
    sandboxUrl: sandboxUrl.toString(),
    hostOrigin,
    contract: contractPayload.contract,
    resourceHtml: `<!doctype html><main id="official-upstream-app">Official upstream MCP App</main><script>${escapeInlineScript(upstreamBundle)}</script>`,
  });
  assert.equal(upstreamResult.kind, "official-upstream-mcp-app");
  assert.equal(upstreamResult.hasWorkspaceEntries, true);
  await testHostedSandboxMediaPlayback(browser);
  console.log("MCP App browser sandbox test passed.");
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (previousAuthMode === undefined) delete process.env.OPENGROVE_WEB_AUTH_MODE;
  else process.env.OPENGROVE_WEB_AUTH_MODE = previousAuthMode;
  if (previousSandboxOrigin === undefined) delete process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN;
  else process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN = previousSandboxOrigin;
  if (previousUserDataDir === undefined) delete process.env.OPENGROVE_USER_DATA_DIR;
  else process.env.OPENGROVE_USER_DATA_DIR = previousUserDataDir;
  if (previousSettingsPath === undefined) delete process.env.OPENGROVE_BRIDGE_SETTINGS_PATH;
  else process.env.OPENGROVE_BRIDGE_SETTINGS_PATH = previousSettingsPath;
  await rm(testRoot, { recursive: true, force: true });
}

async function testHostedSandboxMediaPlayback(activeBrowser) {
  const mountPrefix = "/proxy/demo";
  const certificatePath = join(testRoot, "sandbox-cert.pem");
  const keyPath = join(testRoot, "sandbox-key.pem");
  await generateSandboxCertificate(certificatePath, keyPath);

  const manifestPath = join(mountedAppRoot, "opengrove.app.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.ui.view.tools.push("opengrove.app.media.cache");
  manifest.ui.view.csp.connectDomains = ["https://media.example.test"];
  manifest.ui.view.csp.resourceDomains = ["https://media.example.test"];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const cacheKey = "hosted-sandbox-playback";
  const media = Buffer.from(TINY_MP4_BASE64, "base64");
  const cacheDirectory = join(mountedAppRoot, "workspace", ".cache", "opengrove-media");
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(join(cacheDirectory, `${createHash("sha256").update(cacheKey).digest("hex")}.mp4`), media);

  let bridgePort = 0;
  const proxy = createHttpsServer(
    {
      cert: await readFile(certificatePath),
      key: await readFile(keyPath),
    },
    (request, response) => {
      if (!request.url?.startsWith(`${mountPrefix}/`)) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Missing reverse-proxy mount prefix");
        return;
      }
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: bridgePort,
          path: request.url.slice(mountPrefix.length),
          method: request.method,
          headers: request.headers,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", (error) => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
        response.end(error.message);
      });
      request.pipe(upstream);
    },
  );
  await new Promise((resolvePromise) => proxy.listen(0, "127.0.0.1", resolvePromise));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const sandboxOrigin = `https://hosted-sandbox.localhost:${proxyAddress.port}`;
  process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN = sandboxOrigin;

  const hostedBridge = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    bridgeToken: "",
    profile: "test",
    runtimeEnvironment: "test",
    statePath: join(testRoot, "hosted-sandbox-state.json"),
  });
  let context;
  try {
    if (!hostedBridge.listening) await new Promise((resolvePromise) => hostedBridge.once("listening", resolvePromise));
    const bridgeAddress = hostedBridge.address();
    assert.ok(bridgeAddress && typeof bridgeAddress === "object");
    bridgePort = bridgeAddress.port;
    const hostOrigin = `http://127.0.0.1:${bridgePort}`;
    const cacheResponse = await fetch(`${hostOrigin}/api/apps/mcp-app-basic/mcp-app/call-tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "opengrove.app.media.cache",
        arguments: {
          sourceUrl: "https://media.example.test/tiny.mp4",
          cacheKey,
          expectedSize: media.byteLength,
          contentType: "video/mp4",
        },
      }),
    });
    assert.equal(cacheResponse.status, 200);
    const cachePayload = await cacheResponse.json();
    const mediaUrl = cachePayload.result?.structuredContent?.mediaUrl;
    assert.match(mediaUrl ?? "", /^\.\/mcp-app-media\/[A-Za-z0-9_-]+$/u);

    const sandboxUrl = new URL(`${sandboxOrigin}${mountPrefix}/mcp-app-sandbox/`);
    sandboxUrl.searchParams.set(
      "csp",
      JSON.stringify({
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      }),
    );
    sandboxUrl.searchParams.set("hostOrigin", hostOrigin);
    context = await activeBrowser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${hostOrigin}/opengrove-probe`);
    const playback = await page.evaluate(
      async ({ sandboxUrl: isolatedUrl, mediaSource }) => {
        const iframe = document.createElement("iframe");
        iframe.sandbox.add("allow-scripts", "allow-forms");
        iframe.src = isolatedUrl;
        const loaded = new Promise((resolvePromise) => iframe.addEventListener("load", resolvePromise, { once: true }));
        document.body.replaceChildren(iframe);
        await loaded;
        return await new Promise((resolvePromise, reject) => {
          const timeout = window.setTimeout(() => reject(new Error("hosted_media_playback_timeout")), 10_000);
          const onMessage = (event) => {
            if (event.source !== iframe.contentWindow) return;
            if (event.data?.method === "ui/notifications/sandbox-proxy-ready") {
              const html = `<!doctype html><video id="media" muted preload="auto" src=${JSON.stringify(mediaSource)}></video><script>
              const media = document.querySelector("#media");
              media.addEventListener("loadedmetadata", () => parent.postMessage({ kind: "hosted-media", readyState: media.readyState }, "*"), { once: true });
              media.addEventListener("error", () => parent.postMessage({ kind: "hosted-media", error: media.error?.code || "unknown" }, "*"), { once: true });
              media.load();
            <\/script>`;
              iframe.contentWindow.postMessage(
                {
                  jsonrpc: "2.0",
                  method: "ui/notifications/sandbox-resource-ready",
                  params: { html, sandbox: "allow-scripts allow-forms", csp: {}, permissions: {} },
                },
                "*",
              );
              return;
            }
            if (event.data?.kind === "hosted-media") {
              window.clearTimeout(timeout);
              window.removeEventListener("message", onMessage);
              resolvePromise(event.data);
            }
          };
          window.addEventListener("message", onMessage);
        });
      },
      {
        sandboxUrl: sandboxUrl.toString(),
        mediaSource: mediaUrl,
      },
    );
    assert.deepEqual(playback, { kind: "hosted-media", readyState: 1 });
  } finally {
    await context?.close();
    delete process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN;
    await new Promise((resolvePromise, reject) =>
      hostedBridge.close((error) => (error ? reject(error) : resolvePromise())),
    );
    proxy.closeAllConnections();
    await new Promise((resolvePromise, reject) => proxy.close((error) => (error ? reject(error) : resolvePromise())));
  }
}

function generateSandboxCertificate(certificatePath, keyPath) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
        "-subj",
        "/CN=hosted-sandbox.localhost",
        "-days",
        "1",
      ],
      (error) => (error ? reject(error) : resolvePromise()),
    );
  });
}

async function bundleBrowserSource(contents, sourcefile) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), sourcefile },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
    minify: true,
  });
  return result.outputFiles[0].text;
}

async function mountContractInIndependentHost(page, input) {
  await page.evaluate(async ({ sandboxUrl, hostOrigin, contract }) => {
    const iframe = document.createElement("iframe");
    iframe.id = "independent-host-frame";
    iframe.sandbox.add("allow-scripts", "allow-forms");
    iframe.referrerPolicy = "no-referrer";
    iframe.src = sandboxUrl;
    const loaded = new Promise((resolvePromise) => iframe.addEventListener("load", resolvePromise, { once: true }));
    document.body.replaceChildren(iframe);
    await loaded;
    window.__mcpIndependentHost = await window.startIndependentMcpHost({ iframe, contract, hostOrigin });
  }, input);
}

async function disposeIndependentHost(page) {
  await page.evaluate(async () => {
    await window.__mcpIndependentHost?.dispose?.();
    window.__mcpIndependentHost = undefined;
    document.body.replaceChildren();
  });
}

async function mountOfficialUpstreamApp(page, input) {
  return await page.evaluate(async ({ sandboxUrl, hostOrigin, contract, resourceHtml }) => {
    const iframe = document.createElement("iframe");
    iframe.id = "official-upstream-frame";
    iframe.sandbox.add("allow-scripts", "allow-forms");
    iframe.referrerPolicy = "no-referrer";
    iframe.src = sandboxUrl;
    const loaded = new Promise((resolvePromise) => iframe.addEventListener("load", resolvePromise, { once: true }));
    document.body.replaceChildren(iframe);
    await loaded;
    return await new Promise(async (resolvePromise, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("official_upstream_app_timeout")), 10_000);
      const onMessage = (event) => {
        if (event.source !== iframe.contentWindow || event.data?.kind !== "official-upstream-mcp-app") return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolvePromise(event.data);
      };
      window.addEventListener("message", onMessage);
      window.__mcpIndependentHost = await window.startIndependentMcpHost({
        iframe,
        contract,
        hostOrigin,
        resourceHtml,
      });
    });
  }, input);
}

async function frameWithSelector(page, selector) {
  let selected;
  await assertEventually(async () => {
    for (const frame of page.frames()) {
      if (await frame.locator(selector).count()) {
        selected = frame;
        return true;
      }
    }
    return false;
  });
  return selected;
}

async function assertEventually(predicate, timeoutMs = 10_000, detail) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.fail(`condition did not become true before timeout${detail ? `; ${await detail()}` : ""}`);
}

function escapeInlineScript(source) {
  return source.replace(/<\/script/giu, "<\\/script");
}

function independentHostSource() {
  return String.raw`
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

window.startIndependentMcpHost = async ({ iframe, contract, hostOrigin, resourceHtml }) => {
  const client = {
    getServerCapabilities() {
      return { tools: {}, resources: {} };
    },
    setNotificationHandler() {},
    async request(message) {
      if (message.method === "tools/call") {
        const response = await fetch(
          hostOrigin + "/api/apps/mcp-app-basic/mcp-app/call-tool",
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: message.params.name, arguments: message.params.arguments || {} }),
          },
        );
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || "tool_call_failed");
        return payload.result;
      }
      if (message.method === "tools/list") {
        return { tools: [contract.launcherTool, ...contract.tools] };
      }
      if (message.method === "resources/list") {
        return { resources: [{ uri: contract.resource.uri, name: "OpenGrove App", mimeType: contract.resource.mimeType, _meta: contract.resource._meta }] };
      }
      if (message.method === "resources/read") {
        return { contents: [contract.resource] };
      }
      throw new Error("unsupported independent host request: " + message.method);
    },
  };
  const bridge = new AppBridge(
    client,
    { name: "Independent MCP Apps Host", version: "1.0.0" },
    {
      serverTools: {},
      serverResources: {},
      logging: {},
      sandbox: {
        csp: contract.resource._meta.ui.csp,
        permissions: contract.resource._meta.ui.permissions,
      },
    },
    {
      hostContext: {
        toolInfo: { tool: contract.launcherTool },
        theme: "light",
        locale: "en",
        timeZone: "UTC",
        platform: "web",
        displayMode: "inline",
        availableDisplayModes: ["inline"],
      },
    },
  );
  bridge.onsandboxready = () => {
    void bridge.sendSandboxResourceReady({
      html: resourceHtml || contract.resource.text,
      sandbox: "allow-scripts allow-forms",
      csp: contract.resource._meta.ui.csp,
      permissions: contract.resource._meta.ui.permissions,
    });
  };
  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: {} })
      .then(() => bridge.sendToolResult({
        content: [{ type: "text", text: "independent host ready" }],
        structuredContent: { ready: true },
      }));
  };
  const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
  await bridge.connect(transport);
  return {
    async dispose() {
      await bridge.teardownResource({}).catch(() => undefined);
      await transport.close();
    },
  };
};
`;
}

function officialUpstreamAppSource() {
  // Adapted from the upstream ext-apps basic-server-vanillajs example; the tool name is
  // swapped for OpenGrove's scoped workspace tool so the same official App runtime is
  // exercised against the real OpenGrove HTTP bridge.
  return String.raw`
import { App } from "@modelcontextprotocol/ext-apps";

(async () => {
const app = new App(
  { name: "Official upstream fixture", version: "1.0.0" },
  {},
  { autoResize: false, strict: true },
);
app.onteardown = async () => ({});
app.ontoolinput = () => {};
app.ontoolresult = async () => {
  try {
    const listed = await app.callServerTool({
      name: "opengrove.app.workspace.list",
      arguments: { maxDepth: 3, maxEntries: 100 },
    });
    const entries = listed.structuredContent?.entries;
    window.parent.postMessage({
      kind: "official-upstream-mcp-app",
      hasWorkspaceEntries: Array.isArray(entries) && entries.length > 0,
    }, "*");
  } catch (error) {
    window.parent.postMessage({
      kind: "official-upstream-mcp-app",
      hasWorkspaceEntries: false,
      error: String(error),
    }, "*");
  }
};
await app.connect();
})();
`;
}
