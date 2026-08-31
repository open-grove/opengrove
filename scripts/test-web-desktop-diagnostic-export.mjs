import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-desktop-diagnostic-ui-"));
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
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function runBrowserHarness(path) {
  const browser = await launchChromiumForHarness();
  try {
    const page = await browser.newPage({ viewport: { width: 980, height: 760 }, locale: "zh-CN" });
    await page.goto(pathToFileURL(path).href);
    await page.waitForSelector("[data-harness-ready='true']", { state: "attached" });
    const exportButton = page.getByRole("button", { name: /Export diagnostics bundle|一键导出错误包/ });
    await exportButton.waitFor();
    const downloadButton = page.getByRole("button", {
      name: /Download latest for this machine|下载本机最新版|Download latest installer|下载最新安装包/,
    });
    assert.equal(await downloadButton.count(), 0, "Web mode must not expose the desktop installer download action");
    await exportButton.click();
    await page
      .getByText(
        /Exported: OpenGrove-system-forensics-test\.zip\. For troubleshooting only; share it only with trusted support personnel\.|已导出：OpenGrove-system-forensics-test\.zip。仅用于错误排查，请仅提交给可信人员。/,
      )
      .waitFor();
    await page.getByText(/This bundle is incomplete|该错误包不完整/).waitFor();
    assert.equal(
      await page.evaluate(() => window.__exportCalls),
      1,
      "Web mode must use the server diagnostic bundle route",
    );
    await page.getByText("v0.5.20", { exact: true }).waitFor();
    await page.evaluate(() => window.setHarnessHostVersion("0.5.21"));
    await page.getByText("v0.5.21", { exact: true }).waitFor();
    await page.evaluate(() => window.failHarnessHostVersion());
    await page.getByText(/Needs attention|需要处理/, { exact: true }).waitFor();

    await page.evaluate(() => window.renderDesktopHarness());
    await exportButton.waitFor();
    await page.getByText(/Running|运行正常/, { exact: true }).waitFor();
    assert.equal(
      await page.getByText("v0.4.2", { exact: true }).count(),
      0,
      "Desktop diagnostics must leave version presentation to the dedicated updates page",
    );
    assert.equal(
      await downloadButton.count(),
      0,
      "Desktop diagnostics must leave installer downloads to the dedicated updates page",
    );
    assert.equal(await page.getByText("API base", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /Open logs folder|打开日志目录/ }).count(), 0);
    await exportButton.click();
    await page
      .getByText(
        /Exported: OpenGrove-system-forensics-test\.zip\. For troubleshooting only; share it only with trusted support personnel\.|已导出：OpenGrove-system-forensics-test\.zip。仅用于错误排查，请仅提交给可信人员。/,
      )
      .waitFor();
    assert.equal(await page.evaluate(() => window.__exportCalls), 2, "Desktop settings must use the same server route");
    console.log("web-desktop-diagnostic-export harness ok");
  } finally {
    await browser.close();
  }
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
      buildApi.onResolve({ filter: /\.css$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path),
        namespace: "css-empty",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "css-empty" }, () => ({ contents: "", loader: "js" }));
    },
  };
}

function entrySource() {
  const componentPath = resolve(projectRoot, "web/src/components/sidebar/settings-desktop-panel.tsx");
  const confirmPath = resolve(projectRoot, "web/src/components/ui/confirm-dialog.tsx");
  return `
    import React from "react";
    import { flushSync } from "react-dom";
    import { createRoot } from "react-dom/client";
    import { SettingsDesktopPanel } from ${JSON.stringify(componentPath)};
    import { ConfirmProvider } from ${JSON.stringify(confirmPath)};

    const originalSetInterval = window.setInterval.bind(window);
    const originalClearInterval = window.clearInterval.bind(window);
    let hostVersion = "0.5.20";
    let hostVersionFailure = false;
    let hostRefresh;
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 10_000) {
        hostRefresh = () => callback(...args);
        return 411;
      }
      return originalSetInterval(callback, delay, ...args);
    };
    window.clearInterval = (interval) => {
      if (interval !== 411) originalClearInterval(interval);
    };
    window.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/opengrove-probe")) {
        if (hostVersionFailure) throw new Error("bridge unavailable");
        return new Response(JSON.stringify({
          ok: true,
          startedAt: "2026-07-24T00:00:00.000Z",
          build: { packageVersion: hostVersion, clientReleaseNumber: 10024 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/settings/storage")) {
        return new Response(JSON.stringify({
          ok: true,
          stats: {
            kind: "memory",
            databaseBytes: 0,
            blobBytes: 0,
            orphanBlobBytes: 0,
            migrationBackupBytes: 0,
            categories: [],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/diagnostics/bundle")) {
        window.__exportCalls += 1;
        return new Response("zip", {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": "attachment; filename=OpenGrove-system-forensics-test.zip",
            "x-opengrove-evidence-complete": "false",
          },
        });
      }
      return new Response(JSON.stringify({ ok: false }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    };
    window.setHarnessHostVersion = (nextVersion) => {
      hostVersion = nextVersion;
      hostVersionFailure = false;
      hostRefresh?.();
    };
    window.failHarnessHostVersion = () => {
      hostVersionFailure = true;
      hostRefresh?.();
    };

    const root = createRoot(document.getElementById("root"));
    window.__exportCalls = 0;
    const render = () => flushSync(() => root.render(
      React.createElement(ConfirmProvider, null,
        React.createElement(React.Fragment, null,
          React.createElement(SettingsDesktopPanel),
          React.createElement("span", { "data-harness-ready": "true", hidden: true }),
        ),
      ),
    ));
    window.renderDesktopHarness = () => {
      window.openGroveDesktop = {
        versions: { app: "0.4.2" },
        isOfficialRelease: false,
        diagnostics: async () => ({
          status: "running", pid: 123, port: 37371, restartCount: 0, crashCount: 0,
          paths: {}, recentMainLog: "", recentBridgeLog: "", recentCrashLog: "",
        }),
      };
      render();
    };
    render();
  `;
}
