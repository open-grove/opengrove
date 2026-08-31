import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-version-management-"));
const entryPath = join(tempDir, "entry.tsx");
const bundlePath = join(tempDir, "entry.js");
const htmlPath = join(tempDir, "index.html");
const componentPath = join(projectRoot, "web/src/components/network/app-version-management-page.tsx");
const globalStylesPath = join(projectRoot, "web/src/styles.css");
const appStoreStylesPath = join(projectRoot, "web/src/components/network/app-store-view.css");

try {
  await writeFile(entryPath, entrySource(componentPath, globalStylesPath, appStoreStylesPath), "utf8");
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  await writeFile(
    htmlPath,
    '<!doctype html><html><head><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script src="./entry.js"></script></body></html>',
    "utf8",
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.getByRole("heading", { name: "版本管理" }).waitFor();

    assert.equal(
      (await page.getByText("我的本机草稿", { exact: true }).count()) > 0,
      true,
      "the local draft must stay visually separate from the formal version list",
    );
    assert.equal(
      await page.getByRole("button", { name: "打开本机草稿" }).count(),
      1,
      "a saved local draft must remain directly reopenable",
    );
    assert.equal(
      await page.getByText("需要 Host release number 10030", { exact: true }).count(),
      1,
      "an incompatible formal version must state the exact minimum Host release number",
    );

    await page.locator("button:not(:disabled)", { hasText: "切换到此版本" }).click();
    await page.getByRole("heading", { name: "检测到未保存的本机修改" }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "切换到此版本" }).count(),
      0,
      "the safety decision must interrupt the version page instead of leaving other switch actions interactive",
    );
    await page.getByRole("button", { name: "放弃修改并切换" }).click();
    await page.getByRole("heading", { name: "这个 App 仍有任务在运行" }).waitFor();
    await page.getByRole("button", { name: "强制停止并切换" }).click();

    const runningOverview = page.locator(".app-store-version-overview-item").filter({ hasText: "当前运行" });
    await runningOverview.getByText("v1.3.0", { exact: true }).waitFor();

    const switchCalls = await page.evaluate(() => window.__switchCalls);
    assert.equal(switchCalls.length, 3);
    assert.deepEqual(
      switchCalls.map((call) => ({
        discardUnsavedChanges: call.discardUnsavedChanges,
        forceStop: call.forceStop,
      })),
      [
        { discardUnsavedChanges: false, forceStop: false },
        { discardUnsavedChanges: true, forceStop: false },
        { discardUnsavedChanges: true, forceStop: true },
      ],
      "the second safety gate must preserve the user's first explicit confirmation",
    );

    await page.evaluate(() => window.__resetLocalDraftBlockers());
    await page.getByRole("button", { name: "打开本机草稿" }).click();
    await page.getByRole("heading", { name: "检测到未保存的本机修改" }).waitFor();
    const callsBeforeSaveNavigation = await page.evaluate(() => window.__switchCalls.length);
    await page.getByRole("button", { name: "去保存" }).click();
    assert.equal(await page.evaluate(() => window.__saveAndPublishOpened), true);
    assert.equal(
      await page.evaluate(() => window.__switchCalls.length),
      callsBeforeSaveNavigation,
      "go save must only navigate and must not save or resume the interrupted switch",
    );

    await page.getByRole("button", { name: "打开本机草稿" }).click();
    await page.getByRole("heading", { name: "检测到未保存的本机修改" }).waitFor();
    const callsBeforeCancel = await page.evaluate(() => window.__switchCalls.length);
    await page.getByRole("button", { name: "取消" }).click();
    assert.equal(
      await page.evaluate(() => window.__switchCalls.length),
      callsBeforeCancel,
      "cancel must not submit another switch request",
    );

    await page.getByRole("button", { name: "打开本机草稿" }).click();
    await page.getByRole("button", { name: "放弃修改并切换" }).click();
    await page.getByRole("heading", { name: "这个 App 仍有任务在运行" }).waitFor();
    await page.getByRole("button", { name: "强制停止并切换" }).click();
    await runningOverview.getByText("我的本机草稿", { exact: true }).waitFor();
    const selectedFormalRow = page.locator(".app-store-version-row").filter({ hasText: "v1.3.0" });
    assert.equal(
      await selectedFormalRow.getByRole("button", { name: "切换到此版本" }).count(),
      1,
      "the selected formal version must remain switchable while the local draft is running",
    );
    const draftCalls = await page.evaluate(() =>
      window.__switchCalls.filter((call) => call.target.kind === "local-draft"),
    );
    assert.equal(draftCalls.length, 5);
    assert.deepEqual(
      draftCalls.slice(-3).map((call) => ({
        target: call.target,
        discardUnsavedChanges: call.discardUnsavedChanges,
        forceStop: call.forceStop,
      })),
      [
        {
          target: { kind: "local-draft" },
          discardUnsavedChanges: false,
          forceStop: false,
        },
        {
          target: { kind: "local-draft" },
          discardUnsavedChanges: true,
          forceStop: false,
        },
        {
          target: { kind: "local-draft" },
          discardUnsavedChanges: true,
          forceStop: true,
        },
      ],
      "the local draft must pass through the same dirty and active-run gates",
    );

    await page.getByRole("button", { name: "返回 App 商店" }).click();
    assert.equal(await page.getByText("已返回", { exact: true }).count(), 1);
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-app-version-management ok");

function entrySource(component, globalStyles, appStoreStyles) {
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
    import { AppVersionManagementPage } from ${JSON.stringify(component)};
    import ${JSON.stringify(globalStyles)};
    import ${JSON.stringify(appStoreStyles)};

    const formalVersions = [{
      packageKey: "pkg-story-seed",
      packageId: "pkg-story-seed-v1-4-0",
      appId: "story-seed",
      title: "故事种子",
      version: "1.4.0",
      publishedBy: "OpenGrove Admin",
      publishedAt: "2026-07-30T08:00:00.000Z",
      releaseCommitSha: "c".repeat(40),
      releaseNotes: "需要新版 Host",
      artifactSource: "github-release",
      archiveName: "story-seed-v1.4.0.tgz",
      archiveSize: 4096,
      archiveSha256: "c".repeat(64),
      minHostReleaseNumber: 10030,
      availability: "host_incompatible",
      downloadReference: "version-1.4.0",
    }, {
      packageKey: "pkg-story-seed",
      packageId: "pkg-story-seed-v1-3-0",
      appId: "story-seed",
      title: "故事种子",
      version: "1.3.0",
      publishedBy: "OpenGrove Admin",
      publishedAt: "2026-07-29T08:00:00.000Z",
      releaseCommitSha: "b".repeat(40),
      releaseNotes: "更新员工默认配置",
      artifactSource: "github-release",
      archiveName: "story-seed-v1.3.0.tgz",
      archiveSize: 2048,
      archiveSha256: "b".repeat(64),
      minHostReleaseNumber: 10024,
      availability: "available",
      downloadReference: "version-1.3.0",
    }, {
      packageKey: "pkg-story-seed",
      packageId: "pkg-story-seed-v1-2-3",
      appId: "story-seed",
      title: "故事种子",
      version: "1.2.3",
      publishedBy: "OpenGrove Admin",
      publishedAt: "2026-07-20T08:00:00.000Z",
      releaseCommitSha: "a".repeat(40),
      releaseNotes: "稳定版本",
      artifactSource: "github-release",
      archiveName: "story-seed-v1.2.3.tgz",
      archiveSize: 1024,
      archiveSha256: "a".repeat(64),
      minHostReleaseNumber: 10020,
      availability: "available",
      downloadReference: "version-1.2.3",
    }];
    const localDraft = {
      schemaVersion: 1,
      localAppId: "local-story-seed",
      appId: "story-seed",
      savedAt: "2026-07-29T09:00:00.000Z",
      archiveSha256: "d".repeat(64),
      archiveSize: 4096,
      contentDigest: "e".repeat(64),
      publishBase: {
        packageKey: "pkg-story-seed",
        version: "1.2.3",
        releaseCommitSha: "a".repeat(40),
        archiveSha256: "a".repeat(64),
      },
    };
    const initialStatus = {
      activeContent: "formal",
      selectedVersion: {
        packageKey: "pkg-story-seed",
        version: "1.2.3",
        archiveSha256: "a".repeat(64),
        releaseCommitSha: "a".repeat(40),
      },
      latestVersion: formalVersions[0],
      versions: formalVersions,
      localDraft,
      workingDigest: "f".repeat(64),
      savedContentDigest: "a".repeat(64),
      hasUnsavedChanges: true,
    };
    let currentStatus = initialStatus;
    let hasActiveRuns = true;
    window.__switchCalls = [];
    window.__saveAndPublishOpened = false;
    window.__resetLocalDraftBlockers = () => {
      currentStatus = { ...currentStatus, hasUnsavedChanges: true };
      hasActiveRuns = true;
    };
    window.fetch = async (_input, init = {}) => {
      if ((init.method ?? "GET") === "GET") {
        return jsonResponse(200, { ok: true, status: currentStatus });
      }
      const body = JSON.parse(init.body);
      window.__switchCalls.push(structuredClone(body));
      if (currentStatus.hasUnsavedChanges && !body.discardUnsavedChanges) {
        return jsonResponse(409, { ok: false, error: "app_version_unsaved_changes" });
      }
      if (hasActiveRuns && !body.forceStop) {
        return jsonResponse(409, { ok: false, error: "app_version_active_runs" });
      }
      if (body.target.kind === "local-draft") {
        currentStatus = {
          ...currentStatus,
          activeContent: "local-draft",
          hasUnsavedChanges: false,
          workingDigest: localDraft.contentDigest,
          savedContentDigest: localDraft.contentDigest,
        };
        hasActiveRuns = false;
        return jsonResponse(200, {
          ok: true,
          status: currentStatus,
        });
      }
      currentStatus = {
        ...initialStatus,
        selectedVersion: {
          packageKey: "pkg-story-seed",
          version: "1.3.0",
          archiveSha256: "b".repeat(64),
          releaseCommitSha: "b".repeat(40),
        },
        hasUnsavedChanges: false,
        workingDigest: "b".repeat(64),
        savedContentDigest: "b".repeat(64),
      };
      hasActiveRuns = false;
      return jsonResponse(200, {
        ok: true,
        status: currentStatus,
      });
    };
    function jsonResponse(status, payload) {
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    function Harness() {
      const [open, setOpen] = useState(true);
      if (!open) return <p>已返回</p>;
      return (
        <AppVersionManagementPage
          app={{ id: "local-story-seed", title: "故事种子" }}
          onBack={() => setOpen(false)}
          onOpenSaveAndPublish={() => { window.__saveAndPublishOpened = true; }}
        />
      );
    }
    if (!localStorage.getItem("opengroveLanguage")) {
      localStorage.setItem("opengroveLanguage", "zh-CN");
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    createRoot(document.getElementById("root")).render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
  `;
}
