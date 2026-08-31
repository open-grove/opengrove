import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-release-recovery-"));
const entryPath = join(tempDir, "entry.tsx");
const bundlePath = join(tempDir, "entry.js");
const htmlPath = join(tempDir, "index.html");
const componentPath = join(projectRoot, "web/src/components/network/app-store-publish-page.tsx");
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
    await page.waitForFunction(() => window.__releaseFirstStatusPending === true);
    const localRecoveryNotice = page.locator('.app-store-publish-progress[data-state="publishing"]');
    await localRecoveryNotice.waitFor();
    assert.equal(
      await page.getByRole("button", { name: /发布中|Publishing/ }).isDisabled(),
      true,
      "the local journal must disable publish before the first remote status response arrives",
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.__releaseRequests.filter(
            (request) => request.path === "/apps/story-seed/publish/reconcile" && request.method === "POST",
          ).length,
      ),
      0,
      "the first remote status request must be read-only while the local stage is visible",
    );
    await page.evaluate(() => window.__resolveReleaseFirstStatus?.());
    await page.waitForFunction(() => window.__publishedResult?.version === "0.1.1", null, {
      timeout: 12_000,
    });
    const requests = await page.evaluate(() => window.__releaseRequests);
    assert.equal(
      requests.some((request) => request.path.startsWith("/app-store/publish-mounted-app")),
      false,
      "restart recovery must never fall back to the legacy direct Registry endpoint",
    );
    assert.equal(
      requests.filter((request) => request.path === "/apps/story-seed/publish/reconcile" && request.method === "POST")
        .length,
      1,
      "read-only polling must authorize one reconcile only after the remote status becomes actionable",
    );
    assert.ok(
      requests.filter((request) => request.path === "/apps/story-seed/publish/status" && request.method === "GET")
        .length >= 1,
      "an unfinished release discovered on mount must use read-only remote status polling",
    );
    assert.equal(
      requests.filter((request) => request.path === "/apps/story-seed/publish" && request.method === "POST").length,
      0,
      "restart recovery must resume the existing intent instead of creating a new one",
    );

    const blockedPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await blockedPage.goto(`${pathToFileURL(htmlPath).href}?scenario=blocked`);
    const blockedNotice = blockedPage.locator('.app-store-publish-progress[data-state="blocked"]');
    await blockedNotice.waitFor({ timeout: 12_000 });
    await blockedPage.waitForTimeout(2_500);
    const blockedRequests = await blockedPage.evaluate(() => window.__releaseRequests);
    assert.equal(
      blockedRequests.filter(
        (request) => request.path === "/apps/story-seed/publish/reconcile" && request.method === "POST",
      ).length,
      0,
      "a cross-device conflict must stop automatic recovery instead of POSTing every two seconds",
    );
    assert.equal(
      blockedRequests.filter((request) => request.path === "/apps/story-seed/publish" && request.method === "POST")
        .length,
      0,
      "a cross-device conflict must never create another release intent automatically",
    );
    assert.ok(
      blockedRequests.some((request) => request.path === "/apps/story-seed/publish/status" && request.method === "GET"),
      "a blocked device must follow the authoritative old intent through a read-only status request",
    );
    assert.equal(
      await blockedNotice.locator(".app-store-publish-progress-actions button").count(),
      2,
      "the blocked notice must expose explicit continue and abandon actions",
    );
    await blockedPage.close();

    const opaqueConflictPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await opaqueConflictPage.goto(`${pathToFileURL(htmlPath).href}?scenario=opaque-conflict`);
    const opaqueConflictNotice = opaqueConflictPage.locator('.app-store-publish-progress[data-state="blocked"]');
    await opaqueConflictNotice.waitFor({ timeout: 12_000 });
    await opaqueConflictPage
      .getByText(/暂时无法取得旧发布状态|old release status is temporarily unavailable/)
      .waitFor();
    await opaqueConflictPage.getByText("cccccccccccccccccccccccccccccccc").waitFor();
    await opaqueConflictPage
      .getByRole("button", {
        name: /重新检查并继续发布|Check again and continue publishing/,
      })
      .waitFor();
    await opaqueConflictPage.waitForTimeout(2_500);
    const opaqueConflictRequests = await opaqueConflictPage.evaluate(() => window.__releaseRequests);
    assert.equal(
      opaqueConflictRequests.filter(
        (request) => request.path === "/apps/story-seed/publish/status" && request.method === "GET",
      ).length,
      0,
      "an unowned conflict without a remote intent id must not poll remote status",
    );
    assert.equal(
      opaqueConflictRequests.filter((request) => request.method === "POST").length,
      0,
      "an unowned conflict must not retry or create another release automatically",
    );
    assert.equal(
      await opaqueConflictPage.getByRole("button", { name: /发布|Publish/ }).isDisabled(),
      true,
      "an unowned conflict must keep the publish action disabled",
    );
    await opaqueConflictPage.close();

    const missingIntentPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await missingIntentPage.goto(`${pathToFileURL(htmlPath).href}?scenario=status-not-found`);
    await missingIntentPage.getByText(/不存在或当前账号无权查看|no longer exists or this account cannot view/).waitFor({
      timeout: 12_000,
    });
    await missingIntentPage.getByText("dddddddddddddddddddddddddddddddd").waitFor();
    const missingIntentNotice = missingIntentPage.locator('.app-store-publish-progress[data-state="publishing"]');
    await missingIntentNotice.waitFor();
    assert.equal(
      await missingIntentNotice.locator(".app-store-publish-spinner").count(),
      0,
      "a failed authoritative status lookup must stop presenting the stale local journal as live progress",
    );
    assert.equal(
      await missingIntentPage.getByRole("button", { name: /发布中|Publishing/ }).count(),
      0,
      "the publish header must not claim that a missing remote intent is still publishing",
    );
    const continueMissingIntent = missingIntentPage.getByRole("button", {
      name: /继续发布|Continue publishing/,
    });
    await continueMissingIntent.waitFor();
    await continueMissingIntent.click();
    await missingIntentPage.waitForFunction(
      () =>
        window.__releaseRequests.filter(
          (request) => request.path === "/apps/story-seed/publish/reconcile" && request.method === "POST",
        ).length === 1,
    );
    await missingIntentPage.getByText("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee").waitFor();
    await continueMissingIntent.waitFor();
    await missingIntentPage.waitForTimeout(2_500);
    const missingIntentRequests = await missingIntentPage.evaluate(() => window.__releaseRequests);
    assert.equal(
      missingIntentRequests.filter(
        (request) => request.path === "/apps/story-seed/publish/reconcile" && request.method === "POST",
      ).length,
      1,
      "one failed manual continue must pause again instead of starting automatic POST retries",
    );
    assert.equal(
      await missingIntentPage.locator(".app-store-publish-spinner").count(),
      0,
      "a failed manual continue must return the whole page to a non-pending state",
    );
    await missingIntentPage.close();

    const externallyPublishedPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await externallyPublishedPage.goto(`${pathToFileURL(htmlPath).href}?scenario=blocked-published`);
    await externallyPublishedPage.waitForFunction(() => window.__publishedResult?.version === "0.1.1", null, {
      timeout: 12_000,
    });
    const externallyPublishedRequests = await externallyPublishedPage.evaluate(() => window.__releaseRequests);
    assert.equal(
      externallyPublishedRequests.filter(
        (request) => request.path === "/apps/story-seed/publish/reconcile" && request.method === "POST",
      ).length,
      1,
      "an externally published blocked intent must perform one exact local finalization",
    );
    assert.equal(
      externallyPublishedRequests.filter(
        (request) => request.path === "/apps/story-seed/publish" && request.method === "POST",
      ).length,
      0,
      "external completion must not submit the current App as a new release",
    );
    await externallyPublishedPage.close();
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-app-release-recovery ok");

function entrySource(component, globalStyles, appStoreStyles) {
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
    import { AppStorePublishPage } from ${JSON.stringify(component)};
    import ${JSON.stringify(globalStyles)};
    import ${JSON.stringify(appStoreStyles)};

    const release = {
      identity: {
        appId: "story-seed",
        packageKey: "opengrove.story-seed",
        source: "registry",
        appRoot: "/tmp/story-seed",
        workspaceRoot: "/tmp/story-seed/workspace",
      },
      app: { title: "故事种子", description: "故事大纲工作台" },
      version: "0.1.1",
      latestPublishedVersion: "0.1.0",
      releaseNotes: "",
      visibility: "restricted",
      employees: [{
        memberId: "member-app-story-seed-writer",
        name: "故事架构师",
        role: "共同创作故事大纲",
        kernel: "claude-code",
        model: "deepseek-v4-pro",
        reasoningEffort: "high",
        contextTokenBudget: 200000,
        accessMode: "full-access",
        color: "#148a47",
        availableSkillIds: [],
        defaultSkillIds: [],
        visibility: "private",
        publicSkills: [],
      }],
      checks: [
        { id: "manifest-and-ui", label: "App manifest 与 UI 入口", severity: "blocking", status: "passed", detail: "manifest_and_ui_valid" },
        { id: "portable-package", label: "包内容安全", severity: "blocking", status: "passed", detail: "portable_package_valid" },
        { id: "employee-skills", label: "员工 Skills", severity: "blocking", status: "passed", detail: "employee_skills_valid" },
        { id: "version", label: "版本号", severity: "blocking", status: "passed", detail: "version_valid" },
        { id: "trial-run", label: "试运行", severity: "warning", status: "passed", detail: "employee_trial_valid" },
        { id: "release-notes", label: "版本说明", severity: "warning", status: "warning", detail: "release_notes_missing" },
      ],
    };
    const scenario = new URLSearchParams(location.search).get("scenario");
    const blockedScenario = scenario === "blocked" || scenario === "blocked-published";
    const externallyPublishedScenario = scenario === "blocked-published";
    const opaqueConflictScenario = scenario === "opaque-conflict";
    const statusNotFoundScenario = scenario === "status-not-found";
    let progress = opaqueConflictScenario ? {
      localAppId: "story-seed",
      appId: "story-seed",
      packageKey: "opengrove.story-seed",
      version: "0.1.1",
      title: "故事种子",
      visibility: "restricted",
      phase: "remote_conflict",
      allowedActions: [],
      requestId: "cccccccccccccccccccccccccccccccc",
      applyToCurrentApp: false,
      state: "blocked",
      retryable: false,
      updatedAt: "2026-07-29T10:00:00.000Z",
    } : blockedScenario ? {
      localAppId: "story-seed",
      appId: "story-seed",
      packageKey: "opengrove.story-seed",
      version: "0.1.1",
      title: "故事种子",
      visibility: "restricted",
      phase: "remote_blocked",
      allowedActions: ["retry_candidate", "abandon"],
      remoteIntentId: "release-from-other-device",
      remoteStatus: "awaiting_candidate",
      applyToCurrentApp: false,
      state: "blocked",
      retryable: false,
      blockedRelease: {
        id: "release-from-other-device",
        status: "awaiting_candidate",
        packageKey: "opengrove.story-seed",
        version: "0.1.1",
        sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        createdAt: "2026-07-29T09:59:00.000Z",
        allowedActions: ["retry_candidate", "abandon"],
        requestId: "request-cross-device-conflict",
        matchesCurrentSource: true,
        matchesCurrentRequest: true,
      },
      updatedAt: "2026-07-29T10:00:00.000Z",
    } : {
      localAppId: "story-seed",
      appId: "story-seed",
      packageKey: "opengrove.story-seed",
      version: "0.1.1",
      title: "故事种子",
      visibility: "restricted",
      phase: "remote_pending",
      allowedActions: [],
      remoteIntentId: "release-same-device",
      remoteStatus: "artifact_accepted",
      applyToCurrentApp: false,
      state: "publishing",
      retryable: true,
      updatedAt: "2026-07-29T10:00:00.000Z",
    };
    let reconcileCalls = 0;
    let statusCalls = 0;
    let resolveReleaseFirstStatus;
    const firstStatusGate = new Promise((resolve) => {
      resolveReleaseFirstStatus = resolve;
    });
    window.__resolveReleaseFirstStatus = resolveReleaseFirstStatus;
    window.__releaseFirstStatusPending = false;
    window.__releaseRequests = [];
    window.fetch = async (input, init = {}) => {
      const method = init.method ?? "GET";
      const path = new URL(String(input), "http://opengrove.test").pathname;
      window.__releaseRequests.push({ method, path });
      if (method === "GET" && path === "/apps/story-seed/draft") {
        return jsonResponse(404, { ok: false, error: "local_app_draft_not_found" });
      }
      if (method === "GET" && path === "/apps/story-seed/draft/prepare") {
        return jsonResponse(200, { ok: true, release });
      }
      if (method === "GET" && path === "/apps/story-seed/publish/prepare") {
        return jsonResponse(200, { ok: true, release });
      }
      if (method === "GET" && path === "/apps/story-seed/publish") {
        return jsonResponse(200, { ok: true, progress });
      }
      if (method === "GET" && path === "/apps/story-seed/publish/status") {
        statusCalls += 1;
        if (statusNotFoundScenario) {
          return jsonResponse(404, {
            ok: false,
            error: "app_release_not_found",
            requestId: "dddddddddddddddddddddddddddddddd",
          });
        }
        if (!blockedScenario && !opaqueConflictScenario && statusCalls === 1) {
          window.__releaseFirstStatusPending = true;
          await firstStatusGate;
        }
        if (externallyPublishedScenario && statusCalls >= 2) {
          progress = {
            ...progress,
            phase: "registry_ready",
            remoteStatus: "published",
            allowedActions: [],
            state: "registry-ready",
            retryable: true,
            blockedRelease: undefined,
            updatedAt: "2026-07-29T10:00:04.000Z",
          };
        } else if (!blockedScenario && statusCalls >= 2) {
          progress = {
            ...progress,
            remoteStatus: "artifact_accepted",
            allowedActions: [],
            state: "publishing",
            retryable: true,
            updatedAt: "2026-07-29T10:00:04.000Z",
          };
        }
        return jsonResponse(200, { ok: true, progress });
      }
      if (method === "POST" && path === "/apps/story-seed/publish/reconcile") {
        reconcileCalls += 1;
        if (statusNotFoundScenario) {
          return jsonResponse(404, {
            ok: false,
            error: "app_release_not_found",
            requestId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            progress,
          });
        }
        progress = {
          ...progress,
          phase: "local_finalized",
          remoteStatus: "published",
          allowedActions: [],
          state: "published",
          retryable: false,
          blockedRelease: undefined,
          updatedAt: "2026-07-29T10:00:06.000Z",
        };
        return jsonResponse(200, {
          ok: true,
          progress,
        });
      }
      throw new Error("unexpected_request:" + method + ":" + path);
    };
    function jsonResponse(status, value) {
      return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    createRoot(document.getElementById("root")!).render(
      <QueryClientProvider client={queryClient}>
        <AppStorePublishPage
          app={{ id: "story-seed", title: "故事种子" }}
          canPublish
          onBack={() => {}}
          onPublished={() => {
            window.__publishedResult = { version: progress.version };
          }}
        />
      </QueryClientProvider>,
    );
  `;
}
