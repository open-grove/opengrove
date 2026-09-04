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
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.storageRequestCount ?? "0"),
      "0",
      "opening Settings must not recursively scan storage before the storage page is entered",
    );
    await storageEntry.click();

    await page.getByRole("heading", { name: "存储空间", exact: true }).waitFor();
    await page.getByText("正在统计存储空间…", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("0 B", { exact: true }).count(),
      0,
      "loading must not masquerade as empty storage",
    );
    await page.getByText("6.0 GB", { exact: true }).waitFor();
    assert.equal(await page.getByText("6.0 GB", { exact: true }).count(), 1);
    for (const label of ["我的作品与文件", "App 与运行组件", "缓存和临时文件", "升级备份", "聊天与系统数据"]) {
      assert.ok((await page.getByText(label, { exact: true }).count()) > 0, `${label} must be visible`);
    }
    assert.match(
      await page
        .getByText(/共 1 份，最近保存于/)
        .first()
        .textContent(),
      /2026/,
    );
    assert.equal(
      await page.getByRole("button", { name: "删除重置恢复备份", exact: true }).count(),
      0,
      "unfinished reset-backup cleanup must not be exposed",
    );
    assert.equal(await page.getByText("数据库", { exact: true }).isVisible(), false);
    assert.match(await page.getByText(/预计可清理/).textContent(), /1\.0 GB/);

    await page.getByRole("button", { name: "安全释放空间", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("安全释放空间？", { exact: true }).waitFor();
    assert.match(await dialog.textContent(), /不会删除作品、App、聊天、知识库、账号或设置/);
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await page.getByText(/已清理约 512 MB 的缓存和临时文件/).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.cleanupRequested), "true");

    assert.equal(await page.getByText("高级详情", { exact: true }).count(), 0);
    assert.equal(await page.getByText("数据库", { exact: true }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "精简 Rooms 事件归档", exact: true }).count(),
      0,
      "Room ledger history must be read-only in storage details",
    );
    assert.equal(
      await page.getByRole("button", { name: "清除运行事件历史", exact: true }).count(),
      0,
      "runtime diagnostics history must be read-only in storage details",
    );
    for (const internalLabel of ["Blob 文件", "Agent 事件", "Rooms 事件归档", "knowledge_revisions"]) {
      assert.equal(
        await page.getByText(internalLabel, { exact: true }).count(),
        0,
        `${internalLabel} must stay internal`,
      );
    }

    await page.evaluate(() => {
      const payload = globalThis.storagePayload;
      payload.overview.backups = [];
      payload.overview.categories.find((category) => category.id === "backups").bytes = 0;
      payload.cleanupEstimates.migrationBackupBytes = 0;
    });
    await page.getByRole("button", { name: "刷新统计", exact: true }).click();
    await page.waitForFunction(() => !document.body.textContent?.includes("升级备份"));
    assert.equal(await page.getByText("升级备份", { exact: true }).count(), 0, "empty update backups stay hidden");
    assert.equal(await page.getByRole("button", { name: "删除升级备份", exact: true }).count(), 0);

    const fallbackPage = await browser.newPage({ viewport: { width: 1120, height: 900 } });
    try {
      await fallbackPage.goto(`${pathToFileURL(htmlPath).href}?browserFallback=1`);
      await fallbackPage.getByRole("button", { name: /存储空间/ }).click();
      await fallbackPage.getByText("6.0 GB", { exact: true }).waitFor();
      await fallbackPage.getByRole("button", { name: "安全释放空间", exact: true }).click();
      const fallbackDialog = fallbackPage.getByRole("dialog");
      await fallbackDialog.getByRole("button", { name: "确认", exact: true }).click();
      await fallbackPage.getByText("当前还有运行中的任务，请等任务结束后再清理。", { exact: true }).waitFor();
    } finally {
      await fallbackPage.close();
    }
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
        safeCleanupBytes: 1024 ** 3,
        migrationBackupBytes: 1024 ** 3,
      },
    };
    globalThis.storagePayload = storagePayload;
    const browserFallback = location.search.includes("browserFallback=1");
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/settings/storage")) {
        if (!init?.method || init.method === "GET") {
          document.documentElement.dataset.storageRequestCount = String(
            Number(document.documentElement.dataset.storageRequestCount ?? "0") + 1,
          );
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (browserFallback && url.endsWith("/maintenance/start")) {
          return new Response(JSON.stringify({ ok: true, leaseId: "lease-fallback" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (browserFallback && url.endsWith("/cleanup")) {
          return new Response(JSON.stringify({ ok: false, error: "desktop_storage_maintenance_active_runs:1" }), { status: 409, headers: { "content-type": "application/json" } });
        }
        if (browserFallback && url.endsWith("/maintenance/end")) {
          return new Response(JSON.stringify({ ok: false, error: "maintenance_release_failed" }), { status: 500, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(storagePayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    if (!browserFallback) window.openGroveDesktop = {
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
