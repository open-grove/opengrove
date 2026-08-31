import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-mcp-app-open-link-"));
const hostEntryPath = join(tempDir, "host-entry.tsx");
const hostBundlePath = join(tempDir, "host-bundle.js");
const viewEntryPath = join(tempDir, "view-entry.ts");
const viewBundlePath = join(tempDir, "view-bundle.js");

try {
  await writeFile(
    viewEntryPath,
    `
    import { App } from "@modelcontextprotocol/ext-apps";

    const app = new App(
      { name: "opengrove-open-link-probe", version: "1.0.0" },
      {},
      { autoResize: false, strict: true },
    );

    function publish(payload) {
      window.parent.postMessage({
        type: "opengrove/mcp-app-open-link-probe",
        ...payload,
      }, "*");
    }

    window.addEventListener("message", (event) => {
      if (event.data?.type === "opengrove/mcp-app-capability-probe-request") {
        void Promise.all([
          app.callServerTool({ name: "opengrove.open-link-probe.launch", arguments: {} }),
          app.listServerResources({}),
          app.sendLog({ level: "info", data: "capability probe" }),
        ])
          .then(([toolResult, resources]) => publish({
            kind: "capability-probe",
            toolOk: toolResult.structuredContent?.ready === true,
            resourceCount: resources.resources.length,
          }))
          .catch((error) => publish({
            kind: "capability-probe",
            error: error instanceof Error ? error.message : String(error),
          }));
        return;
      }
      if (event.data?.type === "opengrove/mcp-app-host-request") {
        const { id, payload } = event.data;
        void Promise.resolve()
          .then(() => app.downloadFile(payload))
          .then((result) => publish({ kind: "result", id, result }))
          .catch((error) => publish({
            kind: "error",
            id,
            message: error instanceof Error ? error.message : String(error),
          }));
        return;
      }
      if (event.data?.type !== "opengrove/mcp-app-open-link-request") return;
      void app.openLink({ url: event.data.url })
        .then((result) => publish({ kind: "result", id: event.data.id, result }))
        .catch((error) => publish({
          kind: "error",
          id: event.data.id,
          message: error instanceof Error ? error.message : String(error),
        }));
    });

    void app.connect().then(() => {
      publish({
        kind: "ready",
        capabilities: app.getHostCapabilities(),
        hostContext: app.getHostContext(),
      });
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
    import { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { MountedMcpAppView } from ${JSON.stringify(
      resolve(projectRoot, "web/src/components/apps/mounted-mcp-app-view.tsx"),
    )};
    import { HOST_UI_CAPABILITY_NAMES } from ${JSON.stringify(
      resolve(projectRoot, "web/src/components/apps/mcp-app-host-capabilities.ts"),
    )};

    globalThis.__OPENGROVE_API_BASE__ = "/api/";
    globalThis.__opengroveHostCapabilityNames = HOST_UI_CAPABILITY_NAMES;
    function Harness() {
      const [active, setActive] = useState(true);
      return (
        <>
          <button id="activate-view" type="button" onClick={() => setActive(true)}>activate view</button>
          <button id="deactivate-view" type="button" onClick={() => setActive(false)}>deactivate view</button>
          <MountedMcpAppView
            active={active}
            app={{
              name: "open-link-probe",
              title: "Open link probe",
              enabled: true,
            }}
          />
        </>
      );
    }

    createRoot(document.getElementById("root")).render(<Harness />);
  `,
    "utf8",
  );
  await build({
    entryPoints: [hostEntryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    outfile: hostBundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    plugins: [hostFixturePlugin()],
  });

  const hostBundle = await readFile(hostBundlePath);
  const contract = {
    protocol: "mcp-apps",
    resource: {
      uri: "ui://opengrove/open-link-probe",
      mimeType: "text/html;profile=mcp-app",
      text: `<!doctype html><html><body><script>${viewBundle}</script></body></html>`,
      _meta: {
        ui: {
          csp: {},
          permissions: {},
          prefersBorder: false,
        },
      },
    },
    launcherTool: {
      name: "opengrove.open-link-probe.launch",
      inputSchema: { type: "object", properties: {} },
    },
    tools: [],
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      send(
        response,
        200,
        "text/html; charset=utf-8",
        [
          "<!doctype html>",
          '<html lang="en"><head><meta charset="utf-8"></head>',
          '<body><div id="root"></div><script src="/host-bundle.js"></script></body></html>',
        ].join(""),
      );
      return;
    }
    if (url.pathname === "/host-bundle.js") {
      send(response, 200, "text/javascript; charset=utf-8", hostBundle);
      return;
    }
    if (url.pathname === "/api/apps/open-link-probe/mcp-app/contract") {
      send(
        response,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({
          ok: true,
          contract,
        }),
      );
      return;
    }
    if (url.pathname === "/mcp-app-sandbox") {
      send(response, 200, "text/html; charset=utf-8", sandboxHtml());
      return;
    }
    if (url.pathname === "/mcp-app-sandbox.js") {
      send(response, 200, "text/javascript; charset=utf-8", sandboxScript());
      return;
    }
    if (url.pathname === "/external-target") {
      send(
        response,
        200,
        "text/html; charset=utf-8",
        [
          "<!doctype html>",
          '<html lang="en"><head><meta charset="utf-8"><title>External target</title></head>',
          "<body>External target</body></html>",
        ].join(""),
      );
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not found");
  });

  try {
    await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const hostUrl = `http://127.0.0.1:${address.port}/`;
    const webCapabilities = await runBrowserHarness(hostUrl, { desktop: false });
    const desktopCapabilities = await runBrowserHarness(hostUrl, { desktop: true });
    assert.deepEqual(
      desktopCapabilities,
      webCapabilities,
      "ADR 0048: the desktop Host must advertise exactly the same UI capability surface as the web Host",
    );
  } finally {
    await new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-mcp-app-open-link-harness ok");

async function runBrowserHarness(url, { desktop }) {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.addInitScript(
      ({ desktopHost }) => {
        if (desktopHost) globalThis.openGroveDesktop = {};
        globalThis.__opengroveOpenLinkProbeMessages = [];
        window.addEventListener("message", (event) => {
          if (event.data?.type === "opengrove/mcp-app-open-link-probe") {
            globalThis.__opengroveOpenLinkProbeMessages.push(event.data);
          }
        });
      },
      { desktopHost: desktop },
    );
    await page.goto(url);
    await page.waitForFunction(() =>
      globalThis.__opengroveOpenLinkProbeMessages.some((message) => message.kind === "ready"),
    );
    const ready = await page.evaluate(() =>
      globalThis.__opengroveOpenLinkProbeMessages.find((message) => message.kind === "ready"),
    );
    const expectedPlatform = desktop ? "desktop" : "web";
    assert.equal(
      ready.hostContext.platform,
      expectedPlatform,
      `the harness must exercise the real ${expectedPlatform} Host capability path`,
    );
    assert.deepEqual(
      ready.capabilities.openLinks,
      {},
      `the real ${expectedPlatform} Host must advertise the MCP Apps openLinks capability`,
    );
    const registryNames = await page.evaluate(() => globalThis.__opengroveHostCapabilityNames);
    assert.ok(registryNames.length > 0, "the capability registry must not be empty");
    for (const name of registryNames) {
      assert.ok(
        ready.capabilities[name] !== undefined,
        `ADR 0048: the ${expectedPlatform} Host must advertise the "${name}" capability declared by the registry`,
      );
    }
    assert.deepEqual(
      Object.keys(ready.capabilities).sort(),
      [...registryNames].sort(),
      `ADR 0048: the ${expectedPlatform} Host capability surface must come from the registry alone — no ad-hoc declarations`,
    );

    await page.evaluate(() => {
      document.querySelector("iframe")?.contentWindow?.postMessage(
        {
          type: "opengrove/mcp-app-capability-probe-request",
        },
        "*",
      );
    });
    await page.waitForFunction(() =>
      globalThis.__opengroveOpenLinkProbeMessages.some((message) => message.kind === "capability-probe"),
    );
    const capabilityProbe = await page.evaluate(() =>
      globalThis.__opengroveOpenLinkProbeMessages.find((message) => message.kind === "capability-probe"),
    );
    assert.equal(
      capabilityProbe.error,
      undefined,
      `ADR 0048: advertised capabilities must be callable on the ${expectedPlatform} Host — got: ${capabilityProbe.error}`,
    );
    assert.equal(
      capabilityProbe.toolOk,
      true,
      `the ${expectedPlatform} Host must route serverTools calls to the contract server`,
    );
    assert.equal(
      capabilityProbe.resourceCount,
      1,
      `the ${expectedPlatform} Host must route serverResources listings to the contract server`,
    );

    // ADR 0048:声明的模态必须和宿主真正落地的模态一致,App 才能据此提前降级。
    assert.deepEqual(
      ready.capabilities.downloadFile,
      {},
      `the ${expectedPlatform} Host must advertise the MCP Apps downloadFile capability`,
    );

    // ===== ui/download-file:宿主校验 → 一次用户确认 → 真实浏览器下载 =====
    const downloadPromise = page.waitForEvent("download");
    await beginHostRequest(page, "download-ok", {
      contents: [
        {
          type: "resource",
          resource: {
            uri: "file:///exports/../%E5%AF%BC%E5%87%BA%20report.json",
            mimeType: "application/json",
            text: JSON.stringify({ ok: true }),
          },
        },
      ],
    });
    const downloadDialog = page.getByRole("dialog");
    await downloadDialog.waitFor();
    assert.equal(
      await downloadDialog.locator(".mounted-app-download-list li strong").textContent(),
      "导出 report.json",
      "the confirmation must show the sanitized file name the Host will actually write",
    );
    await downloadDialog.getByRole("button", { name: "mountedApp.downloadFilesSave" }).click();
    const download = await downloadPromise;
    assert.equal(
      download.suggestedFilename(),
      "导出 report.json",
      "path traversal and percent-encoding must be resolved before the browser sees the name",
    );
    assert.deepEqual(
      (await waitForOpenLinkResult(page, "download-ok")).result,
      {},
      "a saved download must settle the MCP request successfully",
    );

    await beginHostRequest(page, "download-cancelled", {
      contents: [
        {
          type: "resource",
          resource: { uri: "file:///cancelled.txt", mimeType: "text/plain", text: "cancelled" },
        },
      ],
    });
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "common.cancel" }).click();
    assert.deepEqual(
      (await waitForOpenLinkResult(page, "download-cancelled")).result,
      { isError: true },
      "user cancellation must return isError without writing anything",
    );

    assert.deepEqual(
      (
        await requestHostCapability(page, "download-too-many", {
          contents: Array.from({ length: 6 }, (_unused, index) => ({
            type: "resource",
            resource: { uri: `file:///batch-${index}.txt`, mimeType: "text/plain", text: "batch" },
          })),
        })
      ).result,
      { isError: true },
      "batch downloads must stay bounded",
    );
    assert.deepEqual(
      (
        await requestHostCapability(page, "download-unsafe-link", {
          contents: [{ type: "resource_link", uri: "javascript:alert(1)", name: "unsafe" }],
        })
      ).result,
      { isError: true },
      "non-http(s) resource links must be rejected before any confirmation",
    );
    assert.deepEqual(
      (
        await requestHostCapability(page, "download-oversized", {
          contents: [
            {
              type: "resource",
              resource: { uri: "file:///oversized.txt", mimeType: "text/plain", text: "a".repeat(8 * 1024 * 1024 + 1) },
            },
          ],
        })
      ).result,
      { isError: true },
      "oversized inline resources must be rejected before the confirmation dialog",
    );
    assert.equal(
      await page.getByRole("dialog").count(),
      0,
      "rejected download requests must never render a confirmation",
    );

    const validUrl = new URL("/external-target?id=123", url).href;
    await beginOpenLink(page, "valid", validUrl);
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(
      await dialog.getByText(new URL(validUrl).origin, { exact: true }).count(),
      1,
      "the product confirmation must emphasize the destination origin",
    );
    const openLink = dialog.getByRole("link", { name: "mountedApp.openExternalLinkOpen" });
    assert.equal(await openLink.getAttribute("href"), validUrl);
    assert.equal(await openLink.getAttribute("target"), "_blank");
    assert.deepEqual(
      (await openLink.getAttribute("rel"))?.split(/\s+/).sort(),
      ["noopener", "noreferrer"],
      "the user-activated anchor must delegate opener and referrer isolation to the browser",
    );
    const popupPromise = page.context().waitForEvent("page");
    await openLink.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), validUrl);
    assert.equal(
      await popup.evaluate(() => window.opener === null),
      true,
      "the real browser navigation must not expose the Host through window.opener",
    );
    assert.equal(
      await popup.evaluate(() => document.referrer),
      "",
      "the real browser navigation must not disclose the Host URL as a referrer",
    );
    await popup.close();
    const opened = await waitForOpenLinkResult(page, "valid");
    assert.deepEqual(
      opened,
      {
        type: "opengrove/mcp-app-open-link-probe",
        kind: "result",
        id: "valid",
        result: {},
      },
      "an official MCP App must receive a successful ui/open-link result after the user follows the safe link",
    );

    await beginOpenLink(page, "middle-click", validUrl);
    const middleDialog = page.getByRole("dialog");
    await middleDialog.waitFor();
    const middlePopupPromise = page.context().waitForEvent("page");
    await middleDialog.getByRole("link", { name: "mountedApp.openExternalLinkOpen" }).click({
      button: "middle",
    });
    const middlePopup = await middlePopupPromise;
    await middlePopup.waitForURL(validUrl);
    assert.equal(middlePopup.url(), validUrl);
    await middlePopup.close();
    assert.deepEqual(
      await waitForOpenLinkResult(page, "middle-click"),
      {
        type: "opengrove/mcp-app-open-link-probe",
        kind: "result",
        id: "middle-click",
        result: {},
      },
      "middle-click navigation must settle the MCP request instead of leaving it pending",
    );

    const malformedUrl = await requestOpenLink(page, "malformed-url", "not an absolute URL");
    assert.deepEqual(
      malformedUrl,
      {
        type: "opengrove/mcp-app-open-link-probe",
        kind: "result",
        id: "malformed-url",
        result: { isError: true },
      },
      "the Web Host must reject malformed external URLs through the MCP Apps result contract",
    );
    const invalidProtocol = await requestOpenLink(page, "invalid-protocol", "javascript:alert(1)");
    assert.deepEqual(
      invalidProtocol,
      {
        type: "opengrove/mcp-app-open-link-probe",
        kind: "result",
        id: "invalid-protocol",
        result: { isError: true },
      },
      "the Web Host must reject non-http(s) URLs through the MCP Apps result contract",
    );
    assert.equal(
      await page.getByRole("dialog").count(),
      0,
      "invalid URLs must be rejected before rendering a confirmation",
    );

    await beginOpenLink(page, "cancelled", "http://example.test/cancelled");
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "common.cancel" }).click();
    const cancelled = await waitForOpenLinkResult(page, "cancelled");
    assert.deepEqual(
      cancelled,
      {
        type: "opengrove/mcp-app-open-link-probe",
        kind: "result",
        id: "cancelled",
        result: { isError: true },
      },
      "user cancellation must return isError without opening the external link",
    );

    const longUrl = `${new URL("/external-target?value=", url).href}${"a".repeat(300)}`;
    await beginOpenLink(page, "long-display", longUrl);
    const longDialog = page.getByRole("dialog");
    await longDialog.waitFor();
    const displayedUrl = await longDialog.locator(".mounted-app-external-link-target small").textContent();
    assert.ok(displayedUrl?.endsWith("…"));
    assert.ok((displayedUrl?.length ?? 0) <= 180);
    assert.equal(
      await longDialog.getByRole("link", { name: "mountedApp.openExternalLinkOpen" }).getAttribute("href"),
      longUrl,
      "visual truncation must not alter the actual destination",
    );
    await longDialog.getByRole("button", { name: "common.cancel" }).click();
    await waitForOpenLinkResult(page, "long-display");

    const oversizedUrl = `https://example.test/${"a".repeat(4_100)}`;
    const oversized = await requestOpenLink(page, "oversized", oversizedUrl);
    assert.deepEqual(
      oversized,
      {
        type: "opengrove/mcp-app-open-link-probe",
        kind: "result",
        id: "oversized",
        result: { isError: true },
      },
      "oversized URLs must be rejected before they can consume unbounded UI or parser work",
    );
    assert.equal(await page.getByRole("dialog").count(), 0);

    const firstPendingUrl = "http://example.test/first-pending";
    const secondPendingUrl = "http://example.test/second-pending";
    await beginOpenLink(page, "first-pending", firstPendingUrl);
    const firstPendingDialog = page.getByRole("dialog");
    await firstPendingDialog.waitFor();
    await beginOpenLink(page, "second-pending", secondPendingUrl);
    assert.deepEqual(
      await waitForOpenLinkResult(page, "second-pending"),
      {
        type: "opengrove/mcp-app-open-link-probe",
        kind: "result",
        id: "second-pending",
        result: { isError: true },
      },
      "a second request must be rejected while the first confirmation is still pending",
    );
    assert.equal(
      await firstPendingDialog.getByRole("link", { name: "mountedApp.openExternalLinkOpen" }).getAttribute("href"),
      firstPendingUrl,
      "a later request must not replace the destination the user is already reviewing",
    );
    await firstPendingDialog.getByRole("button", { name: "common.cancel" }).click();
    assert.deepEqual(await waitForOpenLinkResult(page, "first-pending"), {
      type: "opengrove/mcp-app-open-link-probe",
      kind: "result",
      id: "first-pending",
      result: { isError: true },
    });

    await page.locator("#deactivate-view").evaluate((button) => {
      button.click();
    });
    const inactive = await requestOpenLink(page, "inactive-view", validUrl);
    assert.deepEqual(
      inactive,
      {
        type: "opengrove/mcp-app-open-link-probe",
        kind: "result",
        id: "inactive-view",
        result: { isError: true },
      },
      "a background MCP App view must reject link requests without a body-level dialog",
    );
    assert.equal(await page.getByRole("dialog").count(), 0);

    assert.deepEqual(
      (
        await requestHostCapability(page, "inactive-download", {
          contents: [
            {
              type: "resource",
              resource: { uri: "file:///background.txt", mimeType: "text/plain", text: "background" },
            },
          ],
        })
      ).result,
      { isError: true },
      "a background view must not open a download confirmation",
    );
    assert.equal(await page.getByRole("dialog").count(), 0);

    await page.locator("#activate-view").click();
    await beginOpenLink(page, "deactivated-while-pending", validUrl);
    await page.getByRole("dialog").waitFor();
    await page.locator("#deactivate-view").evaluate((button) => {
      button.click();
    });
    assert.deepEqual(
      await waitForOpenLinkResult(page, "deactivated-while-pending"),
      {
        type: "opengrove/mcp-app-open-link-probe",
        kind: "result",
        id: "deactivated-while-pending",
        result: { isError: true },
      },
      "deactivating the originating view must cancel its pending confirmation",
    );
    assert.equal(await page.getByRole("dialog").count(), 0);
    return ready.capabilities;
  } finally {
    await browser.close();
  }
}

async function beginOpenLink(page, id, url) {
  await page.evaluate(
    ({ requestId, requestUrl }) => {
      document.querySelector("iframe")?.contentWindow?.postMessage(
        {
          type: "opengrove/mcp-app-open-link-request",
          id: requestId,
          url: requestUrl,
        },
        "*",
      );
    },
    { requestId: id, requestUrl: url },
  );
}

async function waitForOpenLinkResult(page, id) {
  await page.waitForFunction(
    (requestId) => globalThis.__opengroveOpenLinkProbeMessages.some((message) => message.id === requestId),
    id,
  );
  return page.evaluate(
    (requestId) => globalThis.__opengroveOpenLinkProbeMessages.find((message) => message.id === requestId),
    id,
  );
}

async function requestOpenLink(page, id, url) {
  await beginOpenLink(page, id, url);
  return waitForOpenLinkResult(page, id);
}

async function beginHostRequest(page, id, payload) {
  await page.evaluate(
    ({ requestId, requestPayload }) => {
      document.querySelector("iframe")?.contentWindow?.postMessage(
        {
          type: "opengrove/mcp-app-host-request",
          id: requestId,
          payload: requestPayload,
        },
        "*",
      );
    },
    { requestId: id, requestPayload: payload },
  );
}

async function requestHostCapability(page, id, payload) {
  await beginHostRequest(page, id, payload);
  return waitForOpenLinkResult(page, id);
}

function hostFixturePlugin() {
  return {
    name: "opengrove-open-link-host-fixtures",
    setup(buildApi) {
      buildApi.onResolve({ filter: /runtime\/client-bootstrap$/ }, () => ({
        path: "client-bootstrap",
        namespace: "opengrove-open-link-fixture",
      }));
      buildApi.onResolve({ filter: /\/i18n$/ }, () => ({
        path: "i18n",
        namespace: "opengrove-open-link-fixture",
      }));
      buildApi.onResolve({ filter: /\.css$/ }, () => ({
        path: "css",
        namespace: "opengrove-open-link-fixture",
      }));
      buildApi.onLoad({ filter: /client-bootstrap/, namespace: "opengrove-open-link-fixture" }, () => ({
        contents: `
            export function getClientBootstrap() {
              return { mcpApps: { sandboxOrigin: globalThis.location.origin } };
            }
          `,
        loader: "js",
      }));
      buildApi.onLoad({ filter: /i18n/, namespace: "opengrove-open-link-fixture" }, () => ({
        contents: `
            export function rawDiagnosticText(value) {
              return typeof value === "string" ? value.trim() : "";
            }
            export function translate(key) { return key; }
            export function useI18n() { return { language: "en", t: (key) => key }; }
          `,
        loader: "js",
      }));
      buildApi.onLoad({ filter: /css/, namespace: "opengrove-open-link-fixture" }, () => ({
        contents: "",
        loader: "js",
      }));
    },
  };
}

async function launchChromium() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sandboxHtml() {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"></head><body>',
    '<script src="/mcp-app-sandbox.js"></script>',
    "</body></html>",
  ].join("");
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
