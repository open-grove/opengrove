import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-workspace-download-"));
const entryPath = join(tempDir, "workspace-download-entry.tsx");
const bundlePath = join(tempDir, "workspace-download-entry.js");
const htmlPath = join(tempDir, "index.html");
const streamRequests = [];
const downloadServer = createDownloadServer(streamRequests);
await new Promise((resolveListen, rejectListen) => {
  downloadServer.once("error", rejectListen);
  downloadServer.listen(0, "127.0.0.1", resolveListen);
});
const serverAddress = downloadServer.address();
assert(serverAddress && typeof serverAddress !== "string");
const bridgeOrigin = `http://127.0.0.1:${serverAddress.port}`;

try {
  await writeFile(entryPath, entrySource(bridgeOrigin), "utf8");
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
    [
      "<!doctype html>",
      "<html>",
      '<head><meta charset="utf-8"><title>OpenGrove workspace download harness</title></head>',
      '<body><div id="root"></div><script src="./workspace-download-entry.js"></script></body>',
      "</html>",
    ].join("\n"),
    "utf8",
  );
  await runBrowserHarness(htmlPath, bridgeOrigin, streamRequests);
} finally {
  downloadServer.closeAllConnections?.();
  await new Promise((resolveClose) => downloadServer.close(resolveClose));
  await rm(tempDir, { recursive: true, force: true });
}

async function runBrowserHarness(path, bridgeOrigin, streamRequests) {
  const browser = await launchChromiumForHarness();
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const requestKinds = [];
    const requestTokens = [];
    let requestMode = "auth";
    await page.route(`${bridgeOrigin}/api/apps/story-seed/raw**`, async (route) => {
      const requestedPath = new URL(route.request().url()).searchParams.get("path");
      if (requestedPath === "slow.md" || requestedPath === "stalled.md") {
        await route.fallback();
        return;
      }
      requestKinds.push(route.request().resourceType());
      requestTokens.push(route.request().headers()["x-opengrove-token"]);
      if (requestMode === "auth") {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "session_required" }),
        });
        return;
      }
      if (requestMode === "network") {
        await route.abort("connectionrefused");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/markdown",
        headers: {
          "Content-Disposition": 'attachment; filename="outline.md"',
        },
        body: "# outline\n",
      });
    });
    const imageRequests = [];
    async function fulfillImage(route, image) {
      imageRequests.push({
        image,
        kind: route.request().resourceType(),
        token: route.request().headers()["x-opengrove-token"],
      });
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from("89504e470d0a1a0a", "hex"),
      });
    }
    await page.route(`${bridgeOrigin}/generated/chat.png`, (route) => fulfillImage(route, "chat"));
    await page.route(`${bridgeOrigin}/generated/knowledge.png`, (route) => fulfillImage(route, "knowledge"));

    await page.goto(pathToFileURL(path).href);
    const downloadButton = page.locator(".file-preview-toolbar").getByRole("button", { name: /Download|下载/ });
    await page.waitForTimeout(100);
    assert.equal(
      await downloadButton.count(),
      1,
      `download control missing: ${await page.locator("body").innerHTML()}`,
    );

    await downloadButton.click();
    await page
      .getByRole("alert")
      .filter({ hasText: /sign-in|login|登录/i })
      .waitFor();
    assert.equal(await downloadButton.isEnabled(), true, "auth failure must release the download button");

    requestMode = "network";
    await downloadButton.click();
    await page
      .getByRole("alert")
      .filter({ hasText: /network|网络/i })
      .waitFor();
    assert.equal(await downloadButton.isEnabled(), true, "network failure must release the download button");

    requestMode = "success";
    const downloadPromise = page.waitForEvent("download", { timeout: 2_000 });
    await downloadButton.click({ noWaitAfter: true });
    let download;
    try {
      download = await downloadPromise;
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        alerts: Array.from(document.querySelectorAll('[role="alert"]')).map((element) => element.textContent),
        anchors: Array.from(document.querySelectorAll("a[download]")).map((anchor) => ({
          download: anchor.getAttribute("download"),
          href: anchor.getAttribute("href"),
        })),
        imageButtons: Array.from(document.querySelectorAll(".thread-image-action")).map((button) => ({
          disabled: button.disabled,
          title: button.getAttribute("title"),
          html: button.outerHTML,
        })),
      }));
      throw new Error(
        `workspace download event missing; requests=${JSON.stringify(requestKinds)} diagnostics=${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }

    assert.equal(await download.suggestedFilename(), "outline.md");
    assert.deepEqual(
      requestKinds,
      ["fetch", "fetch", "fetch"],
      "workspace download must stay inside the authenticated renderer request path",
    );
    assert.deepEqual(
      requestTokens,
      ["test-bridge-token", "test-bridge-token", "test-bridge-token"],
      "workspace download must preserve Bridge authentication headers",
    );

    try {
      await Promise.all([
        page.waitForEvent("download", { timeout: 2_000 }),
        page.getByRole("button", { name: /Download 图|下载 图/ }).click({ noWaitAfter: true }),
      ]);
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        alerts: Array.from(document.querySelectorAll('[role="alert"]')).map((element) => element.textContent),
        anchors: Array.from(document.querySelectorAll("a[download]")).map((anchor) => ({
          download: anchor.getAttribute("download"),
          href: anchor.getAttribute("href"),
        })),
        imageButtons: Array.from(document.querySelectorAll(".thread-image-action")).map((button) => ({
          disabled: button.disabled,
          title: button.getAttribute("title"),
          html: button.outerHTML,
        })),
      }));
      throw new Error(
        `chat image download event missing; requests=${JSON.stringify(imageRequests)} pageErrors=${JSON.stringify(pageErrors)} diagnostics=${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
    assert.deepEqual(
      imageRequests.filter((request) => request.kind === "fetch"),
      [{ image: "chat", kind: "fetch", token: "test-bridge-token" }],
      "markdown image downloads must preserve Bridge authentication headers",
    );

    const knowledgeInlineDownload = page.waitForEvent("download", { timeout: 2_000 });
    await page.getByRole("button", { name: /Save image 知识图|保存图片 知识图/ }).click({ noWaitAfter: true });
    await knowledgeInlineDownload;

    await page.locator(".markdown-image-preview-button").click();
    const knowledgeLightboxDownload = page.waitForEvent("download", { timeout: 2_000 });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /Save image|保存图片/ })
      .click({ noWaitAfter: true });
    await knowledgeLightboxDownload;
    assert.deepEqual(
      imageRequests.filter((request) => request.kind === "fetch" && request.image === "knowledge"),
      [
        { image: "knowledge", kind: "fetch", token: "test-bridge-token" },
        { image: "knowledge", kind: "fetch", token: "test-bridge-token" },
      ],
      "both knowledge markdown image downloads must preserve Bridge authentication headers",
    );

    const slowResult = await page.evaluate(() => window.__downloadSlowWithTimeout());
    assert.deepEqual(slowResult, { ok: true }, "download must continue while response bytes keep arriving");

    const timeoutResult = await page.evaluate(() => window.__downloadStalledWithTimeout());
    assert.deepEqual(timeoutResult, { ok: false, kind: "timeout", message: "download_timeout" });
    assert.deepEqual(
      streamRequests,
      [
        { path: "slow.md", token: "test-bridge-token" },
        { path: "stalled.md", token: "test-bridge-token" },
      ],
      "streaming downloads must preserve Bridge authentication headers",
    );
    console.log("web-workspace-download-harness ok");
  } finally {
    await browser.close();
  }
}

async function launchChromiumForHarness() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) {
      throw error;
    }
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

function cssStubPlugin() {
  return {
    name: "css-stub",
    setup(buildApi) {
      buildApi.onResolve({ filter: /\.css$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path),
        namespace: "css-empty-stub",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "css-empty-stub" }, () => ({
        contents: "",
        loader: "js",
      }));
    },
  };
}

function entrySource(bridgeOrigin) {
  const previewPath = resolve(projectRoot, "web/src/components/shared/file-preview-panel.tsx");
  const markdownPath = resolve(projectRoot, "web/src/components/chat/chat-markdown-renderer.tsx");
  const knowledgeMarkdownPath = resolve(projectRoot, "web/src/components/knowledge/markdown-preview.tsx");
  const bridgeClientPath = resolve(projectRoot, "web/src/bridge-client.ts");
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { FilePreviewPanel } from ${JSON.stringify(previewPath)};
    import { ChatMarkdownRenderer } from ${JSON.stringify(markdownPath)};
    import { MarkdownPreview } from ${JSON.stringify(knowledgeMarkdownPath)};
    import { downloadBridgeFile } from ${JSON.stringify(bridgeClientPath)};

    localStorage.setItem("opengroveBridgeToken", "test-bridge-token");
    globalThis.openGroveDesktop = { apiBase: ${JSON.stringify(`${bridgeOrigin}/api`)} };
    window.__downloadSlowWithTimeout = () => downloadBridgeFile(
      ${JSON.stringify(`${bridgeOrigin}/api/apps/story-seed/raw?path=slow.md`)},
      "slow.md",
      { timeoutMs: 80 },
    ).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, kind: error.kind, message: error.message }),
    );
    window.__downloadStalledWithTimeout = () => downloadBridgeFile(
      ${JSON.stringify(`${bridgeOrigin}/api/apps/story-seed/raw?path=stalled.md`)},
      "stalled.md",
      { timeoutMs: 80 },
    ).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, kind: error.kind, message: error.message }),
    );
    createRoot(document.getElementById("root")).render(
      <>
        <FilePreviewPanel
          file={{ name: "outline.md", path: "projects/outline.md", mimeType: "text/markdown", content: "# outline" }}
          loading={false}
          selectedPath="projects/outline.md"
          rawUrl=${JSON.stringify(`${bridgeOrigin}/api/apps/story-seed/raw?path=projects%2Foutline.md`)}
          downloadUrl=${JSON.stringify(`${bridgeOrigin}/api/apps/story-seed/raw?path=projects%2Foutline.md&download=1`)}
        />
        <ChatMarkdownRenderer markdown="![图](/generated/chat.png)" />
        <MarkdownPreview
          format="markdown"
          text=${JSON.stringify(`![知识图](${bridgeOrigin}/generated/knowledge.png)`)}
        />
      </>,
    );
  `;
}

function createDownloadServer(requests) {
  return createServer((request, response) => {
    const origin = request.headers.origin || "null";
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Headers", "x-opengrove-token");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", "http://127.0.0.1");
    const path = url.searchParams.get("path");
    if (url.pathname !== "/api/apps/story-seed/raw" || (path !== "slow.md" && path !== "stalled.md")) {
      response.writeHead(404);
      response.end();
      return;
    }

    requests.push({ path, token: request.headers["x-opengrove-token"] });
    response.writeHead(200, {
      "Content-Type": "text/markdown",
      "Content-Disposition": `attachment; filename="${path}"`,
    });
    response.flushHeaders();

    if (path === "stalled.md") {
      const timeout = setTimeout(() => response.end("# eventually\n"), 250);
      response.on("close", () => clearTimeout(timeout));
      return;
    }

    let chunk = 0;
    response.write("# slow\n");
    const interval = setInterval(() => {
      chunk += 1;
      response.write(`chunk-${chunk}\n`);
      if (chunk >= 8) {
        clearInterval(interval);
        response.end();
      }
    }, 20);
    response.on("close", () => clearInterval(interval));
  });
}
