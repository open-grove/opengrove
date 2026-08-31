import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-web-mcp-app-retry-"));
const entryPath = join(tempDir, "entry.tsx");
const bundlePath = join(tempDir, "entry.js");
const htmlPath = join(tempDir, "index.html");

try {
  await writeFile(entryPath, entrySource(), "utf8");
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
    plugins: [cssStubPlugin()],
  });
  await writeFile(
    htmlPath,
    "<!doctype html><html><body><div id='root'></div><script src='./entry.js'></script></body></html>",
    "utf8",
  );
  await runBrowserHarness(htmlPath);
  const timeoutFixture = await buildTimeoutFixture();
  await runTimeoutRetryHarness(timeoutFixture, "navigation");
  await runTimeoutRetryHarness(timeoutFixture, "handshake");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function buildTimeoutFixture() {
  const hostEntryPath = join(tempDir, "timeout-host-entry.tsx");
  const hostBundlePath = join(tempDir, "timeout-host-bundle.js");
  const viewEntryPath = join(tempDir, "timeout-view-entry.ts");
  const viewBundlePath = join(tempDir, "timeout-view-bundle.js");

  await writeFile(
    viewEntryPath,
    `
    import { App } from "@modelcontextprotocol/ext-apps";

    const app = new App(
      { name: "opengrove-retry-probe", version: "1.0.0" },
      {},
      { autoResize: false, strict: true },
    );

    void app.connect().then(() => {
      window.parent.postMessage({
        type: "opengrove/mcp-app-retry-ready",
        contractAttempt: globalThis.__retryContractAttempt,
      }, "*");
    });
  `,
    "utf8",
  );
  await build({
    entryPoints: [viewEntryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: viewBundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  const viewBundle = (await readFile(viewBundlePath, "utf8")).replaceAll("</script", "<\\/script");

  await writeFile(
    hostEntryPath,
    `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MCP_APP_LOAD_TIMEOUT_MS, MountedMcpAppView } from ${JSON.stringify(
      resolve(projectRoot, "web/src/components/apps/mounted-mcp-app-view.tsx"),
    )};
    import { setLanguagePreference } from ${JSON.stringify(resolve(projectRoot, "web/src/i18n.ts"))};

    globalThis.__OPENGROVE_API_BASE__ = "/api/";
    globalThis.__retryProbeMessages = [];
    globalThis.__mcpAppDeadlineRegistrations = 0;
    globalThis.__mcpAppLoadTimeoutMs = MCP_APP_LOAD_TIMEOUT_MS;
    const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
    globalThis.setTimeout = (handler, delay = 0, ...args) => {
      if (delay === MCP_APP_LOAD_TIMEOUT_MS) globalThis.__mcpAppDeadlineRegistrations += 1;
      return hostSetTimeout(handler, delay, ...args);
    };
    window.addEventListener("message", (event) => {
      if (event.data?.type === "opengrove/mcp-app-retry-ready") {
        globalThis.__retryProbeMessages.push(event.data);
      }
    });
    setLanguagePreference("zh-CN");
    createRoot(document.getElementById("root")).render(React.createElement(MountedMcpAppView, {
      app: { name: "retry-probe", title: "重试验收", kind: "app" },
    }));
  `,
    "utf8",
  );
  await build({
    entryPoints: [hostEntryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: hostBundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
    plugins: [timeoutHostFixturePlugin()],
  });

  return {
    hostBundle: await readFile(hostBundlePath),
    viewBundle,
  };
}

async function runTimeoutRetryHarness(fixture, scenario) {
  const state = {
    contractRequests: 0,
    sandboxRequests: 0,
    hangingResponses: new Set(),
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      send(
        response,
        200,
        "text/html; charset=utf-8",
        "<!doctype html><html><body><div id='root'></div><script src='/timeout-host-bundle.js'></script></body></html>",
      );
      return;
    }
    if (url.pathname === "/timeout-host-bundle.js") {
      send(response, 200, "text/javascript; charset=utf-8", fixture.hostBundle);
      return;
    }
    if (url.pathname === "/api/apps/retry-probe/mcp-app/contract") {
      state.contractRequests += 1;
      send(
        response,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({
          ok: true,
          contract: retryContract(fixture.viewBundle, state.contractRequests),
        }),
      );
      return;
    }
    if (url.pathname === "/mcp-app-sandbox") {
      state.sandboxRequests += 1;
      if (state.sandboxRequests === 1 && scenario === "navigation") {
        state.hangingResponses.add(response);
        response.once("close", () => state.hangingResponses.delete(response));
        return;
      }
      if (state.sandboxRequests === 1 && scenario === "handshake") {
        send(response, 200, "text/html; charset=utf-8", "<!doctype html><html><body>silent sandbox</body></html>");
        return;
      }
      send(response, 200, "text/html; charset=utf-8", sandboxHtml());
      return;
    }
    if (url.pathname === "/mcp-app-sandbox.js") {
      send(response, 200, "text/javascript; charset=utf-8", sandboxScript());
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not found");
  });

  try {
    await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const browser = await launchChromiumForHarness();
    try {
      const page = await browser.newPage({ locale: "zh-CN" });
      const pageProblems = [];
      page.on("pageerror", (error) => pageProblems.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") pageProblems.push(message.text());
      });
      await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
      await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
      await page.locator("iframe").waitFor();
      await waitFor(() => state.sandboxRequests === 1);
      const expectedDeadlineRegistrations = scenario === "navigation" ? 1 : 2;
      await waitFor(() =>
        page.evaluate(
          (expected) => globalThis.__mcpAppDeadlineRegistrations >= expected,
          expectedDeadlineRegistrations,
        ),
      );
      const loadTimeoutMs = await page.evaluate(() => globalThis.__mcpAppLoadTimeoutMs);
      await page.clock.fastForward(loadTimeoutMs);

      const failureAlert = page.getByRole("alert");
      await failureAlert.waitFor({ timeout: 2_000 });
      assert.match(
        await failureAlert.innerText(),
        scenario === "navigation" ? /mcp_app_frame_load_timeout/ : /mcp_app_handshake_timeout/,
      );
      await page.getByRole("button", { name: "重试" }).click({ timeout: 2_000 });

      await page.waitForFunction(() =>
        globalThis.__retryProbeMessages.some((message) => message.contractAttempt === 2),
      );
      assert.equal(
        await page.locator("iframe").count(),
        1,
        "retry must remount the MCP App iframe in the current panel",
      );
      assert.equal(
        state.contractRequests,
        2,
        "retry must fetch a fresh contract instead of reusing the pre-failure result",
      );
      assert.equal(state.sandboxRequests, 2, "retry must re-navigate the sandbox iframe");
      await page.clock.fastForward(loadTimeoutMs);
      assert.equal(
        await failureAlert.count(),
        0,
        `after a successful handshake, the stale ${scenario} timeout must not push the panel back into the failure state`,
      );
      assert.deepEqual(pageProblems, []);
      console.log(`web-mcp-app-${scenario}-timeout-retry harness ok`);
    } finally {
      await browser.close();
    }
  } finally {
    for (const response of state.hangingResponses) response.destroy();
    await new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
  }
}

async function runBrowserHarness(path) {
  const browser = await launchChromiumForHarness();
  try {
    const page = await browser.newPage({
      locale: "zh-CN",
      viewport: { width: 900, height: 700 },
    });
    const pageProblems = [];
    page.on("pageerror", (error) => pageProblems.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageProblems.push(message.text());
    });
    await page.goto(pathToFileURL(path).href);

    const failureAlert = page.getByRole("alert");
    const retryButton = page.getByRole("button", { name: "重试" });
    const connecting = page.getByText("正在连接 MCP App…");

    // 取契约失败：面板必须说清失败原因，并且给出一条出路——只有错误码的死胡同就是这次要修的缺陷。
    await failureAlert.waitFor({ timeout: 15_000 });
    assert.match(await failureAlert.innerText(), /MCP App 无法打开/, JSON.stringify(pageProblems));
    assert.match(await failureAlert.innerText(), /mcp_app_contract_unavailable/);
    await retryButton.waitFor();
    assert.equal(await contractRequestCount(page), 1);

    // 点重试要真的重跑整条加载流程，而不只是把错误信息擦掉。
    await page.evaluate(() => {
      window.__contractMode = "hang";
    });
    await retryButton.click();
    await connecting.waitFor();
    assert.equal(await contractRequestCount(page), 2);
    assert.equal(await failureAlert.count(), 0, "the failure state must not be shown while a retry is in progress");

    // 再次失败仍要停在可重试状态，不能一次失败之后就锁死。
    await page.evaluate(() => {
      window.__failPendingContract();
    });
    await failureAlert.waitFor();
    await retryButton.waitFor();
    await retryButton.click();
    await connecting.waitFor();
    assert.equal(await contractRequestCount(page), 3);

    // Host sandbox 配置错误不会随着重新拉取同一份 contract 改变，不能给用户一个空转的重试按钮。
    await page.evaluate(() => {
      window.__succeedPendingContract();
    });
    await failureAlert.waitFor();
    assert.match(await failureAlert.innerText(), /OPENGROVE_MCP_APP_SANDBOX_ORIGIN/);
    assert.equal(
      await retryButton.count(),
      0,
      "a Host sandbox configuration error must not offer an ineffective retry action",
    );

    assert.deepEqual(pageProblems, []);
    console.log("web-mcp-app-retry harness ok");
  } finally {
    await browser.close();
  }
}

function contractRequestCount(page) {
  return page.evaluate(() => window.__contractRequests.length);
}

async function launchChromiumForHarness() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

function cssStubPlugin() {
  return {
    name: "css-stub",
    setup(buildApi) {
      buildApi.onResolve({ filter: /runtime\/client-bootstrap$/ }, () => ({
        path: "client-bootstrap",
        namespace: "opengrove-retry-fixture",
      }));
      buildApi.onResolve({ filter: /\.css$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path),
        namespace: "css-empty",
      }));
      buildApi.onLoad({ filter: /client-bootstrap/, namespace: "opengrove-retry-fixture" }, () => ({
        contents: `
            export function getClientBootstrap() {
              return { mcpApps: {} };
            }
          `,
        loader: "js",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "css-empty" }, () => ({ contents: "", loader: "js" }));
    },
  };
}

function timeoutHostFixturePlugin() {
  return {
    name: "opengrove-retry-host-fixtures",
    setup(buildApi) {
      buildApi.onResolve({ filter: /runtime\/client-bootstrap$/ }, () => ({
        path: "client-bootstrap",
        namespace: "opengrove-retry-fixture",
      }));
      buildApi.onResolve({ filter: /\.css$/ }, () => ({
        path: "css",
        namespace: "opengrove-retry-fixture",
      }));
      buildApi.onLoad({ filter: /client-bootstrap/, namespace: "opengrove-retry-fixture" }, () => ({
        contents: `
            export function getClientBootstrap() {
              return { mcpApps: { sandboxOrigin: globalThis.location.origin } };
            }
          `,
        loader: "js",
      }));
      buildApi.onLoad({ filter: /css/, namespace: "opengrove-retry-fixture" }, () => ({ contents: "", loader: "js" }));
    },
  };
}

function retryContract(viewBundle, contractAttempt) {
  return {
    protocol: "mcp-apps",
    resource: {
      uri: "ui://opengrove/retry-probe",
      mimeType: "text/html;profile=mcp-app",
      text: `<!doctype html><html><body><script>globalThis.__retryContractAttempt=${contractAttempt}</script><script>${viewBundle}</script></body></html>`,
      _meta: {
        ui: {
          csp: {},
          permissions: {},
          prefersBorder: false,
        },
      },
    },
    launcherTool: {
      name: "opengrove.retry-probe.launch",
      inputSchema: { type: "object", properties: {} },
    },
    tools: [],
  };
}

function sandboxHtml() {
  return "<!doctype html><html><body><script src='/mcp-app-sandbox.js'></script></body></html>";
}

function sandboxScript() {
  return String.raw`
    const expectedHostOrigin = new URL(window.location.href).searchParams.get("hostOrigin");
    const inner = document.createElement("iframe");
    inner.setAttribute("sandbox", "allow-scripts allow-forms");
    document.body.appendChild(inner);
    const resourceReady = "ui/notifications/sandbox-resource-ready";
    const proxyReady = "ui/notifications/sandbox-proxy-ready";
    let proxyReadyTimer;

    window.addEventListener("message", (event) => {
      if (event.source === window.parent) {
        if (event.origin !== expectedHostOrigin) return;
        if (event.data?.method === resourceReady) {
          window.clearInterval(proxyReadyTimer);
          inner.srcdoc = event.data.params?.html || "";
          return;
        }
        inner.contentWindow?.postMessage(event.data, "*");
        return;
      }
      if (event.source === inner.contentWindow) {
        window.parent.postMessage(event.data, expectedHostOrigin);
      }
    });

    const announceReady = () => {
      window.parent.postMessage({ jsonrpc: "2.0", method: proxyReady, params: {} }, expectedHostOrigin);
    };
    announceReady();
    proxyReadyTimer = window.setInterval(announceReady, 100);
  `;
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for retry fixture state");
}

function entrySource() {
  const viewPath = resolve(projectRoot, "web/src/components/apps/mounted-mcp-app-view.tsx");
  const i18nPath = resolve(projectRoot, "web/src/i18n.ts");
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MountedMcpAppView } from ${JSON.stringify(viewPath)};
    import { setLanguagePreference } from ${JSON.stringify(i18nPath)};

    setLanguagePreference("zh-CN");

    const unavailable = () => new Response(
      JSON.stringify({ ok: false, error: "mcp_app_contract_unavailable" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
    const available = () => new Response(JSON.stringify({
      ok: true,
      contract: {
        protocol: "mcp-apps",
        resource: {
          uri: "ui://opengrove/retry-probe",
          mimeType: "text/html;profile=mcp-app",
          text: "<!doctype html><body>retry probe</body>",
          _meta: { ui: { csp: {}, permissions: {}, prefersBorder: false } },
        },
        launcherTool: {
          name: "opengrove.retry-probe.launch",
          inputSchema: { type: "object", properties: {} },
        },
        tools: [],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });

    window.__contractRequests = [];
    window.__contractMode = "fail";
    let releasePending;
    window.__failPendingContract = () => releasePending?.(unavailable());
    window.__succeedPendingContract = () => releasePending?.(available());
    window.fetch = (input, init) => {
      window.__contractRequests.push(typeof input === "string" ? input : input.url);
      if (window.__contractMode !== "hang") return Promise.resolve(unavailable());
      return new Promise((resolve, reject) => {
        releasePending = resolve;
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    };

    createRoot(document.getElementById("root")).render(React.createElement(MountedMcpAppView, {
      app: { name: "editorial-desk", title: "编辑部", kind: "app" },
    }));
  `;
}
