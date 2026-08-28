import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { tailwindStylesPlugin } from "./esbuild-tailwind-plugin.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-storage-management-ui-"));
const entryPath = join(tempDir, "entry.tsx");
const bundlePath = join(tempDir, "entry.js");
const htmlPath = join(tempDir, "index.html");
const componentPath = join(projectRoot, "web/src/components/sidebar/settings-desktop-panel.tsx");
const confirmPath = join(projectRoot, "web/src/components/ui/confirm-dialog.tsx");
const globalStylesPath = join(projectRoot, "web/src/styles.css");

try {
  await writeFile(entryPath, entrySource(), "utf8");
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
    define: { "import.meta": "{}" },
    nodePaths: [join(projectRoot, "node_modules")],
    plugins: [tailwindStylesPlugin(globalStylesPath)],
  });
  await writeFile(
    htmlPath,
    '<!doctype html><html><head><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script src="./entry.js"></script></body></html>',
    "utf8",
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
    await page.goto(pathToFileURL(htmlPath).href);
    const storageEntry = page.getByRole("button", { name: /存储空间/ });
    await storageEntry.waitFor();
    await storageEntry.click();

    await page.getByRole("heading", { name: "存储空间", exact: true }).waitFor();
    assert.equal(await page.getByText("6.0 GB", { exact: true }).count(), 1);
    for (const label of ["我的作品与文件", "App 与运行组件", "可重新生成的临时文件", "恢复备份", "聊天与系统数据"]) {
      assert.ok((await page.getByText(label, { exact: true }).count()) > 0, `${label} must be visible`);
    }
    assert.equal(await page.getByText("数据库", { exact: true }).isVisible(), false);
    assert.match(await page.getByText(/最多可删除约 1.0 GB/).textContent(), /当前诊断日志等保护项会保留/);

    await page.getByRole("button", { name: "清理可重建缓存", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("清理可重建临时文件？", { exact: true }).waitFor();
    assert.match(await dialog.textContent(), /作品、聊天、App 程序、当前日志和恢复备份会保留/);
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await page.getByText(/已删除约 512 MB 的可重建文件/).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.cleanupRequested), "true");

    await page.getByText("高级详情", { exact: true }).click();
    assert.ok(await page.getByText("数据库", { exact: true }).isVisible());
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web storage management UI ok");

function entrySource() {
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { SettingsDesktopPanel } from ${JSON.stringify(componentPath)};
    import { ConfirmProvider } from ${JSON.stringify(confirmPath)};
    import ${JSON.stringify(globalStylesPath)};

    localStorage.setItem("opengroveLanguage", "zh-CN");
    const storagePayload = {
      ok: true,
      stats: {
        kind: "sqlite",
        databaseBytes: 300 * 1024 ** 2,
        blobBytes: 100 * 1024 ** 2,
        orphanBlobBytes: 20 * 1024 ** 2,
        migrationBackupBytes: 1024 ** 3,
        categories: [{ collection: "room_messages", records: 100, payloadBytes: 10 * 1024 ** 2, referencedBlobBytes: 0 }],
      },
      overview: {
        totalBytes: 6 * 1024 ** 3,
        scannedAt: "2026-08-13T00:00:00.000Z",
        categories: [
          { id: "works-and-files", bytes: 2 * 1024 ** 3 },
          { id: "apps-and-runtime", bytes: 1024 ** 3 },
          { id: "rebuildable", bytes: 1024 ** 3 },
          { id: "backups", bytes: 1024 ** 3 },
          { id: "conversations-and-system", bytes: 1024 ** 3 },
        ],
        cleanupCandidates: { rebuildableBytes: 1024 ** 3 },
        backups: [{ kind: "migration", bytes: 1024 ** 3, createdAt: "2026-08-12T00:00:00.000Z" }],
      },
      cleanupEstimates: {
        unreferencedFilesBytes: 20 * 1024 ** 2,
        rebuildableBytes: 1024 ** 3,
        migrationBackupBytes: 1024 ** 3,
      },
    };
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/settings/storage")) {
        return new Response(JSON.stringify(storagePayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    window.openGroveDesktop = {
      apiBase: "opengrove-desktop://ui/api",
      bridgeStartupState: { stage: "ready", generation: 1 },
      versions: { app: "0.6.5", clientReleaseNumber: 10030 },
      diagnostics: async () => ({ status: "running", restartCount: 0, crashCount: 0, paths: {}, recentMainLog: "", recentBridgeLog: "", recentCrashLog: "" }),
      getHostVersion: async () => ({ packageVersion: "0.6.5", clientReleaseNumber: 10030 }),
      cleanupRebuildableStorage: async () => {
        document.documentElement.dataset.cleanupRequested = "true";
        return { status: "cleaned", reclaimedBytes: 512 * 1024 ** 2, updaterCacheSkipped: false };
      },
    };
    createRoot(document.getElementById("root")!).render(
      <ConfirmProvider><SettingsDesktopPanel /></ConfirmProvider>,
    );
  `;
}
