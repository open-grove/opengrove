import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { tailwindStylesPlugin } from "./esbuild-tailwind-plugin.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-publish-page-"));
const entryPath = join(tempDir, "entry.tsx");
const bundlePath = join(tempDir, "entry.js");
const htmlPath = join(tempDir, "index.html");
const componentPath = join(projectRoot, "web/src/components/network/app-store-publish-page.tsx");
const toastPath = join(projectRoot, "web/src/components/ui/toast.tsx");
const confirmPath = join(projectRoot, "web/src/components/ui/confirm-dialog.tsx");
const globalStylesPath = join(projectRoot, "web/src/styles.css");
const appStoreStylesPath = join(projectRoot, "web/src/components/network/app-store-view.css");

try {
  await writeFile(
    entryPath,
    entrySource(componentPath, toastPath, confirmPath, globalStylesPath, appStoreStylesPath),
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => {
      console.error("publish-page browser error", error);
    });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.getByRole("heading", { name: "保存与发布 App" }).waitFor();
    await page.getByText("包结构与平台元数据", { exact: true }).waitFor();
    await page.getByText("包结构、Workspace 边界和 runtime receipt 有效", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("包内容安全", { exact: true }).count(),
      0,
      "the release page must not claim that opaque App contents were scanned for secrets",
    );
    await page.getByText("发布基础", { exact: true }).waitFor();
    await page.getByText("v0.0.8", { exact: true }).waitFor();
    await page.getByText("Registry 最新", { exact: true }).waitFor();
    await page.getByText("v0.0.9", { exact: true }).waitFor();
    await page.getByRole("button", { name: "返回 App 商店" }).click();
    await page.getByRole("button", { name: "重新打开发布页" }).click();

    assert.equal(await page.getByLabel(/版本号/).inputValue(), "0.1.0");
    assert.equal(await page.getByText("尚未保存草稿", { exact: true }).count(), 1);
    await page.getByRole("button", { name: "保存本机草稿" }).click();
    await page.getByText("已保存本机草稿", { exact: true }).waitFor();
    await page.getByText("发布基础 · v0.0.8", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "打开草稿" }).count(),
      0,
      "T2 must not expose draft activation before the shared T4 switch transaction owns it",
    );
    const employeeRow = page.getByRole("button", { name: /本机架构师/ });
    assert.equal(await employeeRow.count(), 1, "the release page should show one compact row per employee");
    assert.equal(
      await page.getByText("data:image/", { exact: false }).count(),
      0,
      "raw avatar data must not be exposed",
    );
    await employeeRow.click();
    assert.equal(await page.getByLabel("员工名称").inputValue(), "本机架构师");
    assert.equal(
      await page.getByText("无可用模型", { exact: true }).count(),
      0,
      "the release employee editor must receive the same Provider model catalog as normal employee settings",
    );
    assert.equal(
      await page.getByText("DeepSeek V4 Pro", { exact: true }).count(),
      1,
      "the released employee's selected Provider model must remain visible",
    );
    assert.equal(
      await page.getByText("Provider 覆盖", { exact: true }).count(),
      0,
      "App publishing must not expose a Provider route as an App-owned employee default",
    );
    assert.equal(await page.getByLabel(/上下文窗口/).inputValue(), "200000");
    const applyToCurrentApp = page.getByRole("checkbox", { name: "发布后切换到这个正式版本" });
    assert.equal(
      await applyToCurrentApp.isChecked(),
      true,
      "publishing must activate the released version on the current device by default",
    );
    if (process.env.OPENGROVE_UI_SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.OPENGROVE_UI_SCREENSHOT_PATH, fullPage: true });
    }

    const publishButton = page.getByRole("button", { name: "发布", exact: true });
    await page.getByRole("button", { name: "切换包阻断" }).click();
    assert.equal(await publishButton.isDisabled(), true, "every blocking release check must disable publish");
    await page.getByRole("button", { name: "切换包阻断" }).click();

    const stageExpectations = [
      ["模拟上传阶段", "正在上传并准备候选源码"],
      ["模拟候选阶段", "正在准备候选源码"],
      ["模拟构建阶段", "正在进行受信构建"],
      ["模拟登记阶段", "正在登记正式版本"],
      ["模拟收尾阶段", "正在完成本机收尾"],
    ];
    for (const [buttonName, expectedStage] of stageExpectations) {
      await page.getByRole("button", { name: buttonName }).click();
      await page.getByText(expectedStage, { exact: true }).waitFor();
    }
    await page.getByRole("button", { name: "清除模拟阶段" }).click();
    await page.getByLabel(/版本号/).fill("0.0.9");
    assert.equal(await publishButton.isDisabled(), true, "a lower release version must block publish in the UI");

    await page.getByLabel(/版本号/).fill("0.1.1");
    await page.getByLabel(/版本说明/).fill("调整员工安装默认值");
    await page.getByLabel(/上下文窗口/).fill("120000");
    await page.locator(".employee-dialog-field").filter({ hasText: "权限" }).getByRole("button").click();
    await page.getByRole("option", { name: /自动审查/ }).click();
    await page.getByLabel("员工名称").fill("发布版架构师");
    await page.getByLabel("员工名称").press("Enter");
    await page.getByRole("button", { name: "保存本机草稿" }).click();
    await page.getByText("已保存本机草稿", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel(/版本号/).inputValue(),
      "0.1.1",
      "saving the local draft must preserve the Admin's pending formal version",
    );
    assert.equal(
      await page.getByLabel(/版本说明/).inputValue(),
      "调整员工安装默认值",
      "saving the local draft must preserve the Admin's pending release notes",
    );
    const savedDraftEmployee = await page.evaluate(() => window.__lastDraftEmployee);
    assert.equal(savedDraftEmployee.name, "发布版架构师");
    assert.equal(savedDraftEmployee.contextTokenBudget, 120000);
    assert.equal(savedDraftEmployee.accessMode, "auto-review");
    await publishButton.click();
    await page.waitForFunction(() => window.__publishedResult?.title === "故事种子");

    const submitted = await page.evaluate(() => window.__releaseCalls.at(-1));
    assert.equal(submitted.release.version, "0.1.1");
    assert.equal(submitted.release.releaseNotes, "调整员工安装默认值");
    assert.equal(submitted.release.employees[0].name, "发布版架构师");
    assert.equal(submitted.release.employees[0].contextTokenBudget, 120000);
    assert.equal(submitted.release.employees[0].accessMode, "auto-review");
    assert.equal(submitted.release.employees[0].color, "#148a47");
    assert.equal(
      Object.prototype.hasOwnProperty.call(submitted.release.employees[0], "providerId"),
      false,
      "the browser release payload must remain Provider-agnostic",
    );
    assert.equal(submitted.applyToCurrentApp, true);

    await page.getByRole("button", { name: "模拟构建失败" }).click();
    await page.getByText("正式发布未完成", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "重试构建" }).count(),
      1,
      "a failed trusted build must expose the explicit retry action",
    );
    await page.getByRole("button", { name: "重试构建" }).click();
    assert.equal(await page.evaluate(() => window.__retryBuildCalls), 1);
    assert.equal(
      await page.getByRole("button", { name: "结束这次发布" }).count(),
      1,
      "a failed release must expose the explicit abandon path before the version can be reused",
    );
    await page.getByRole("button", { name: "结束这次发布" }).click();
    assert.equal(await page.evaluate(() => window.__abandonPublishCalls), 1);

    await page.getByRole("button", { name: "模拟确定性失败" }).click();
    await page.getByText("发布内容需要修复", { exact: true }).waitFor();
    await page.getByText(/artifact_gate.*package_manifest_invalid/).waitFor();
    await page.getByText("构建任务 32824193615", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "重试构建" }).count(),
      0,
      "a deterministic gate failure must not offer a retry that cannot change the result",
    );
    assert.equal(
      await page.getByRole("button", { name: "结束这次发布" }).count(),
      1,
      "a deterministic gate failure must retain the abandon path",
    );

    await page.getByRole("button", { name: "模拟旧发布占用" }).click();
    await page.getByText("已有一项正式发布占用此 App", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("发布内容需要修复", { exact: true }).count(),
      0,
      "another source's failed release must remain a blocked conflict rather than blaming the current draft",
    );
    assert.equal(
      await page.getByRole("button", { name: "结束旧发布并重新发布" }).count(),
      1,
      "a blocked release from another source must retain the conflict-specific abandon action",
    );

    await page.getByRole("button", { name: "模拟本机收尾阻断" }).click();
    const keepLocalChangesButton = page.getByRole("button", {
      name: "保留本机修改并结束本次发布",
    });
    assert.equal(
      await keepLocalChangesButton.count(),
      1,
      "an Admin must get an explicit resolution when Registry is ready but local finalization is blocked",
    );
    await keepLocalChangesButton.click();
    assert.equal(await page.evaluate(() => window.__keepLocalChangesCalls), 1);

    await page.getByRole("button", { name: "切换普通成员" }).click();
    assert.equal(
      await page.getByRole("button", { name: "发布", exact: true }).count(),
      0,
      "a non-admin must not see the formal publish action",
    );
    assert.equal(await page.getByLabel(/版本号/).count(), 0, "a non-admin must not see formal version fields");
    assert.equal(await page.getByText("发布范围", { exact: true }).count(), 0);
    assert.equal(await page.getByText("发布检查", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "保存本机草稿" }).count(), 1);
    assert.ok((await page.getByText("员工配置 · 1", { exact: true }).count()) >= 1);
    assert.equal(await page.getByText("员工默认配置 · 1", { exact: true }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "重试构建" }).count(),
      0,
      "non-admin App members may observe release state but cannot drive recovery",
    );
    assert.equal(
      await page.getByRole("button", { name: "结束这次发布" }).count(),
      0,
      "non-admin App members must not abandon an Admin release",
    );
    assert.equal(
      await page.getByRole("button", { name: "保留本机修改并结束本次发布" }).count(),
      0,
      "non-admin App members must not resolve an Admin release",
    );

    await page.evaluate(() => localStorage.setItem("opengroveLanguage", "en"));
    await page.reload();
    await page.getByRole("heading", { name: "Save & publish App" }).waitFor();
    await page.getByText("Release checks", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Publish", exact: true }).count(), 1);

    const guardPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await guardPage.goto(`${pathToFileURL(htmlPath).href}?http=1`);
    await guardPage.getByLabel(/版本号/).waitFor();
    await guardPage.getByLabel(/版本说明/).fill("尚未保存的页面修改");
    await guardPage.getByRole("button", { name: "返回 App 商店" }).click();
    await guardPage.getByRole("heading", { name: "检测到未保存的本机修改" }).waitFor();
    await guardPage.getByRole("button", { name: "去保存" }).click();
    assert.equal(
      await guardPage.evaluate(() => window.__backCalls),
      0,
      "go save must keep the edited release page open without silently saving",
    );
    await guardPage.getByRole("button", { name: "返回 App 商店" }).click();
    await guardPage.getByRole("button", { name: "取消" }).click();
    assert.equal(
      await guardPage.getByLabel(/版本说明/).inputValue(),
      "尚未保存的页面修改",
      "cancel must preserve the unsaved page values",
    );
    await guardPage.getByRole("button", { name: "返回 App 商店" }).click();
    await guardPage.getByRole("button", { name: "放弃修改并离开" }).click();
    assert.equal(
      await guardPage.evaluate(() => window.__backCalls),
      1,
      "discard must be the only path that leaves the edited release page",
    );
    await guardPage.close();

    const seamPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await seamPage.goto(`${pathToFileURL(htmlPath).href}?http=1`);
    await seamPage.getByLabel(/版本号|Version/).waitFor();
    await seamPage.getByRole("button", { name: /^(发布|Publish)$/ }).click();
    await seamPage.waitForFunction(() => window.__publishedResult?.version === "0.1.0");
    const releaseRequests = await seamPage.evaluate(() => window.__releaseRequests);
    assert.equal(
      releaseRequests.some(
        (request) => request.method === "GET" && request.path === "/apps/story-seed/publish/prepare",
      ),
      true,
      "the publish page must prepare through the journaled App release HTTP seam",
    );
    assert.equal(
      releaseRequests.filter((request) => request.method === "POST" && request.path === "/apps/story-seed/publish")
        .length,
      1,
      "publishing must create exactly one journaled release intent",
    );
    assert.equal(
      releaseRequests.some(
        (request) =>
          request.path === "/app-store/publish-mounted-app" ||
          request.path === "/app-store/publish-mounted-app/prepare",
      ),
      false,
      "the UI must never call the retired mounted App direct-publish endpoints",
    );
    await seamPage.close();

    const repairContractPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await repairContractPage.goto(`${pathToFileURL(htmlPath).href}?http=1&repair-contract=1`);
    await repairContractPage.getByText(/缺少 .opengrove-build.json|Missing .opengrove-build.json/).waitFor();
    await repairContractPage.getByRole("button", { name: /补齐本机构建配方|Add local build recipe/ }).click();
    await repairContractPage.getByText(/构建输入、输出与命令声明有效|Declared build inputs/).waitFor();
    assert.equal(
      await repairContractPage.evaluate(
        () =>
          window.__releaseRequests.filter(
            (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/build-contract",
          ).length,
      ),
      1,
      "a legacy App build contract must be repaired only after the Admin explicitly confirms the action",
    );
    await repairContractPage.close();

    const repairConflictPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await repairConflictPage.goto(`${pathToFileURL(htmlPath).href}?http=1&repair-contract-conflict=1`);
    await repairConflictPage.getByRole("button", { name: /补齐本机构建配方|Add local build recipe/ }).click();
    await repairConflictPage.getByText(/已有自定义构建文件|Existing custom build files/).waitFor();
    await repairConflictPage.close();

    const repairFailurePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await repairFailurePage.goto(`${pathToFileURL(htmlPath).href}?http=1&repair-contract-failure=1`);
    await repairFailurePage.getByRole("button", { name: /补齐本机构建配方|Add local build recipe/ }).click();
    await repairFailurePage.getByText(/本机文件写入失败|could not write the trusted build contract/).waitFor();
    assert.equal(
      await repairFailurePage.getByText(/opengrove-build-contract-|Application Support/).count(),
      0,
      "filesystem details must not be rendered when contract repair fails",
    );
    await repairFailurePage.close();

    const slowPublishPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    slowPublishPage.setDefaultTimeout(7_000);
    await slowPublishPage.goto(`${pathToFileURL(htmlPath).href}?http=1&slow-publish=1`);
    await slowPublishPage.getByLabel(/版本号|Version/).waitFor();
    await slowPublishPage.getByRole("button", { name: /^(发布|Publish)$/ }).click();
    await slowPublishPage.getByText("正在上传并准备候选源码", { exact: true }).waitFor();
    const slowPublishRequests = await slowPublishPage.evaluate(() => window.__releaseRequests);
    assert.equal(
      slowPublishRequests.some((request) => request.method === "GET" && request.path === "/apps/story-seed/publish"),
      true,
      "the page must poll the read-only journal while the initial publish request is pending",
    );
    assert.equal(
      slowPublishRequests.some(
        (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/reconcile",
      ),
      false,
      "read-only stage polling must not resubmit or reconcile while the initial publish request is pending",
    );
    await slowPublishPage.evaluate(() => window.__finishSlowPublish?.());
    await slowPublishPage.waitForFunction(() => window.__publishedResult?.version === "0.1.0");
    await slowPublishPage.close();

    const candidateFailurePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await candidateFailurePage.goto(`${pathToFileURL(htmlPath).href}?http=1&candidate-error=1`);
    await candidateFailurePage.getByLabel(/版本号|Version/).waitFor();
    await candidateFailurePage.getByRole("button", { name: /^(发布|Publish)$/ }).click();
    await candidateFailurePage
      .getByText(/GitHub 检测到发布内容中可能包含凭据|GitHub detected a possible credential/)
      .waitFor();
    await candidateFailurePage.getByText(/技术细节|Technical details/).click();
    await candidateFailurePage.getByText(/(失败阶段：|Failure stage: )candidate_ref_push/, { exact: true }).waitFor();
    await candidateFailurePage
      .getByText(/(请求编号：|Request ID: )0123456789abcdef0123456789abcdef/, { exact: true })
      .waitFor();
    assert.equal(
      await candidateFailurePage.getByText("sensitive Git remote failure", { exact: false }).count(),
      0,
      "candidate diagnostics must expose only the allowlisted stage and request ID",
    );
    await candidateFailurePage.close();

    const localBuildFailurePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await localBuildFailurePage.goto(`${pathToFileURL(htmlPath).href}?http=1&local-build-error=1`);
    await localBuildFailurePage.getByLabel(/版本号|Version/).waitFor();
    await localBuildFailurePage.getByRole("button", { name: /^(发布|Publish)$/ }).click();
    await localBuildFailurePage
      .getByText("本机发布构建失败。请展开详情检查失败命令和输出；远端发布尚未创建。", { exact: true })
      .waitFor();
    await localBuildFailurePage.getByText("技术细节", { exact: true }).click();
    await localBuildFailurePage
      .getByText("本机构建命令 2：npm run build -- --target ui …（参数已截断）", { exact: true })
      .waitFor();
    await localBuildFailurePage.getByText("退出码：23", { exact: true }).waitFor();
    await localBuildFailurePage.getByText("标准输出（已截断）", { exact: true }).waitFor();
    await localBuildFailurePage.getByText("generated ui bundle", { exact: true }).waitFor();
    await localBuildFailurePage.getByText("错误输出（已截断）", { exact: true }).waitFor();
    await localBuildFailurePage.getByText("build.mjs: target ui failed", { exact: true }).waitFor();
    await localBuildFailurePage.close();

    const autoResumePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    autoResumePage.setDefaultTimeout(5_000);
    await autoResumePage.goto(`${pathToFileURL(htmlPath).href}?http=1&recoverable-stale=1`);
    await autoResumePage.getByLabel(/版本号|Version/).waitFor();
    await autoResumePage.getByRole("button", { name: /^(发布|Publish)$/ }).click();
    await autoResumePage.waitForFunction(() => window.__publishedResult?.version === "0.1.0");
    assert.equal(
      await autoResumePage.getByText("app_release_publish_base_stale", { exact: true }).count(),
      0,
      "a recoverable same-intent finalize race must never expose an internal stale-base code",
    );
    const autoResumeRequests = await autoResumePage.evaluate(() => window.__releaseRequests);
    assert.equal(
      autoResumeRequests.filter((request) => request.method === "POST" && request.path === "/apps/story-seed/publish")
        .length,
      1,
      "one user publish action must create only one release intent",
    );
    assert.equal(
      autoResumeRequests.filter(
        (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/reconcile",
      ).length,
      2,
      "the page must automatically retry a transient same-intent finalization race",
    );
    assert.equal(
      await autoResumePage.getByRole("button", { name: /继续发布|Continue publishing/ }).count(),
      0,
      "a healthy same-session publish must not require a second user confirmation",
    );
    await autoResumePage.close();

    const exhaustedRecoveryPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    exhaustedRecoveryPage.setDefaultTimeout(7_000);
    await exhaustedRecoveryPage.goto(`${pathToFileURL(htmlPath).href}?http=1&recoverable-stale-exhausted=1`);
    await exhaustedRecoveryPage.getByLabel(/版本号|Version/).waitFor();
    await exhaustedRecoveryPage.getByRole("button", { name: /^(发布|Publish)$/ }).click();
    await exhaustedRecoveryPage.waitForFunction(
      () =>
        window.__releaseRequests.filter(
          (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/reconcile",
        ).length === 2,
    );
    const continueAfterExhaustion = exhaustedRecoveryPage.getByRole("button", {
      name: /继续发布|Continue publishing/,
    });
    await continueAfterExhaustion.waitFor();
    await exhaustedRecoveryPage.waitForTimeout(2_500);
    assert.equal(
      await exhaustedRecoveryPage.evaluate(
        () =>
          window.__releaseRequests.filter(
            (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/reconcile",
          ).length,
      ),
      2,
      "exhausted automatic recovery must pause after its bounded attempts",
    );
    await continueAfterExhaustion.click();
    await exhaustedRecoveryPage.waitForFunction(() => window.__publishedResult?.version === "0.1.0");
    assert.equal(
      await exhaustedRecoveryPage.evaluate(
        () =>
          window.__releaseRequests.filter(
            (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/reconcile",
          ).length,
      ),
      3,
      "manual continue must remain available after automatic recovery is exhausted",
    );
    await exhaustedRecoveryPage.close();

    const finalizeTimeoutPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    finalizeTimeoutPage.setDefaultTimeout(7_000);
    await finalizeTimeoutPage.goto(`${pathToFileURL(htmlPath).href}?http=1&finalize-timeout=1`);
    await finalizeTimeoutPage.getByLabel(/版本号|Version/).waitFor();
    await finalizeTimeoutPage.getByRole("button", { name: /^(发布|Publish)$/ }).click();
    await finalizeTimeoutPage.getByText(/发布服务响应超时|release service timed out/i).waitFor();
    await finalizeTimeoutPage.getByRole("button", { name: /继续发布|Continue publishing/ }).waitFor();
    await finalizeTimeoutPage.waitForTimeout(2_500);
    assert.equal(
      await finalizeTimeoutPage.evaluate(
        () =>
          window.__releaseRequests.filter(
            (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/reconcile",
          ).length,
      ),
      0,
      "a transport timeout must pause automatic reconcile instead of retrying the same large finalize forever",
    );
    await finalizeTimeoutPage.getByRole("button", { name: /继续发布|Continue publishing/ }).click();
    await finalizeTimeoutPage.waitForFunction(
      () =>
        window.__releaseRequests.filter(
          (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/reconcile",
        ).length === 1,
    );
    await finalizeTimeoutPage.getByRole("button", { name: /继续发布|Continue publishing/ }).waitFor();
    await finalizeTimeoutPage.close();

    const draftPreservePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await draftPreservePage.goto(`${pathToFileURL(htmlPath).href}?http=1`);
    await draftPreservePage.getByLabel(/版本号/).fill("0.3.0");
    await draftPreservePage.getByLabel(/版本说明/).fill("管理员准备发布的说明");
    await draftPreservePage.getByRole("button", { name: "保存本机草稿" }).click();
    await draftPreservePage.waitForFunction(() =>
      window.__releaseRequests.some((request) => request.method === "PUT" && request.path === "/apps/story-seed/draft"),
    );
    await draftPreservePage.waitForTimeout(50);
    assert.equal(
      await draftPreservePage.getByLabel(/版本号/).inputValue(),
      "0.3.0",
      "saving the local draft must preserve the Admin's pending formal version",
    );
    assert.equal(
      await draftPreservePage.getByLabel(/版本说明/).inputValue(),
      "管理员准备发布的说明",
      "saving the local draft must preserve the Admin's pending release notes",
    );
    await draftPreservePage.close();

    const remoteFailurePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await remoteFailurePage.goto(`${pathToFileURL(htmlPath).href}?http=1&formal-error=1`);
    await remoteFailurePage.getByRole("button", { name: /保存本机草稿|Save local draft/ }).waitFor();
    assert.equal(
      await remoteFailurePage.getByRole("button", { name: /^(发布|Publish)$/ }).isDisabled(),
      true,
      "a failed Release Control prepare must disable only formal publishing",
    );
    await remoteFailurePage.getByText(/registry_request_failed:503/).waitFor();
    assert.equal(
      await remoteFailurePage.getByText("正在确认正式版本", { exact: true }).count(),
      0,
      "a failed formal prepare must show the failure state instead of claiming confirmation is still running",
    );
    await remoteFailurePage.getByRole("button", { name: /保存本机草稿|Save local draft/ }).click();
    await remoteFailurePage.waitForFunction(() =>
      window.__releaseRequests.some((request) => request.method === "PUT" && request.path === "/apps/story-seed/draft"),
    );
    await remoteFailurePage.close();

    const abandonRefetchPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    abandonRefetchPage.setDefaultTimeout(5_000);
    await abandonRefetchPage.goto(`${pathToFileURL(htmlPath).href}?http=1&abandon-refetch=1`);
    await abandonRefetchPage.getByRole("button", { name: /结束这次发布|End this release/ }).click();
    await abandonRefetchPage.getByText("正在确认正式版本", { exact: true }).waitFor();
    assert.equal(
      await abandonRefetchPage.getByRole("button", { name: /^(发布|Publish)$/ }).isDisabled(),
      true,
      "after abandoning a release, stale prepare data must not re-enable publish before the authoritative refetch completes",
    );
    await abandonRefetchPage.evaluate(() => window.__finishAbandonPrepare?.());
    await abandonRefetchPage.getByText("Registry 最新", { exact: true }).waitFor();
    await abandonRefetchPage.close();

    const unavailablePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await unavailablePage.goto(`${pathToFileURL(htmlPath).href}?http=1&formal-error=unavailable`);
    await unavailablePage.getByText("暂时无法连接发布服务，本机草稿未受影响。请稍后重试。", { exact: true }).waitFor();
    assert.equal(
      await unavailablePage.getByText("app_release_request_unavailable", { exact: true }).count(),
      0,
      "Release Control transport errors must not leak raw internal codes into the publish page",
    );
    await unavailablePage.close();

    const artifactFailurePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await artifactFailurePage.goto(`${pathToFileURL(htmlPath).href}?http=1&formal-error=artifact`);
    await artifactFailurePage
      .getByText("受信制品校验失败。已保存的发布记录仍可用于查询和恢复。", { exact: true })
      .waitFor();
    assert.equal(
      await artifactFailurePage.getByText("app_release_trusted_artifact_invalid", { exact: true }).count(),
      0,
      "trusted artifact failures must be actionable instead of exposing an internal code",
    );
    await artifactFailurePage.close();

    for (const internalError of ["identity", "error-response", "body-missing"]) {
      const invalidResponsePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await invalidResponsePage.goto(`${pathToFileURL(htmlPath).href}?http=1&formal-error=${internalError}`);
      await invalidResponsePage
        .getByText("发布服务返回了无法识别的响应。本机草稿和已保存的发布记录未受影响。", { exact: true })
        .waitFor();
      assert.equal(
        await invalidResponsePage.getByText(/^app_release_/, { exact: false }).count(),
        0,
        `internal response code ${internalError} must not be shown to the user`,
      );
      await invalidResponsePage.close();
    }

    for (const [identityError, expectedMessage] of [
      ["unauthorized", "登录状态失效或没有访问权限，请重新登录后再试"],
      ["identity-unavailable", "暂时无法连接发布服务，本机草稿未受影响。请稍后重试。"],
    ]) {
      const identityErrorPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await identityErrorPage.goto(`${pathToFileURL(htmlPath).href}?http=1&formal-error=${identityError}`);
      await identityErrorPage.getByText(expectedMessage, { exact: true }).waitFor();
      assert.equal(
        await identityErrorPage.getByText(/^release_control_/, { exact: false }).count(),
        0,
        `identity error ${identityError} must be actionable instead of exposing an internal code`,
      );
      await identityErrorPage.close();
    }

    const blockedPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await blockedPage.goto(`${pathToFileURL(htmlPath).href}?blocked=1`);
    const blockedKeepLocalButton = blockedPage.getByRole("button", {
      name: /保留本机修改并结束本次发布|Keep local changes and end this release/,
    });
    await blockedKeepLocalButton.waitFor();
    await blockedKeepLocalButton.click();
    await blockedPage.waitForFunction(() =>
      window.__releaseRequests.some(
        (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/keep-local",
      ),
    );
    const blockedRequests = await blockedPage.evaluate(() => window.__releaseRequests);
    assert.ok(
      blockedRequests.some(
        (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/reconcile",
      ),
      "Registry-ready recovery must first attempt journal reconciliation",
    );
    assert.equal(
      blockedRequests.filter(
        (request) => request.method === "POST" && request.path === "/apps/story-seed/publish/keep-local",
      ).length,
      1,
      "the explicit keep-local resolution must close the blocked release through its HTTP seam",
    );
    await blockedPage.close();

    const memberPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await memberPage.goto(`${pathToFileURL(htmlPath).href}?http=1&member=1`);
    await memberPage.getByRole("button", { name: /保存本机草稿|Save local draft/ }).waitFor();
    const memberRequests = await memberPage.evaluate(() => window.__releaseRequests);
    assert.equal(
      memberRequests.some((request) => request.method === "GET" && request.path === "/apps/story-seed/publish"),
      false,
      "a non-admin draft page must not query the Admin-only publish progress endpoint",
    );
    await memberPage.close();
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-app-store-publish-page ok");

function entrySource(path, toast, confirm, globalStyles, appStoreStyles) {
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
    import {
      AppStorePublishPage,
      AppStorePublishReleaseEditor,
    } from ${JSON.stringify(path)};
    import { ToastProvider } from ${JSON.stringify(toast)};
    import { ConfirmProvider } from ${JSON.stringify(confirm)};
    import ${JSON.stringify(globalStyles)};
    import ${JSON.stringify(appStoreStyles)};

    const initialRelease = {
      identity: {
        appId: "story-seed",
        packageKey: "pkg-story-seed",
        source: "registry",
        appRoot: "/tmp/story-seed",
        workspaceRoot: "/tmp/story-seed/workspace",
      },
      app: { title: "故事种子", description: "故事大纲工作台", icon: "ui/icon.png" },
      version: "0.1.0",
      latestPublishedVersion: "0.0.9",
      releaseNotes: "",
      visibility: "restricted",
      minHostReleaseNumber: 0,
      employees: [{
        memberId: "member-app-story-seed-writer",
        name: "本机架构师",
        role: "和作者共同创作大纲",
        kernel: "claude-code",
        model: "deepseek-v4-pro",
        reasoningEffort: "high",
        contextTokenBudget: 200000,
        accessMode: "full-access",
        color: "#148a47",
        availableSkillIds: ["app:story-seed/story-outline"],
        defaultSkillIds: ["app:story-seed/story-outline"],
        visibility: "private",
        publicDescription: "故事架构师",
        publicSkills: ["故事设计"],
      }],
      checks: [
        { id: "manifest-and-ui", label: "App manifest 与 UI 入口", severity: "blocking", status: "passed", detail: "有效" },
        { id: "trusted-build-contract", label: "本机发布构建", severity: "blocking", status: "passed", detail: "build_contract_valid" },
        {
          id: "portable-package",
          label: "包结构与平台元数据",
          severity: "blocking",
          status: "passed",
          detail: "包结构、Workspace 边界和 runtime receipt 有效",
        },
        { id: "version", label: "版本号", severity: "blocking", status: "passed", detail: "可发布" },
        { id: "trial-run", label: "完整试运行", severity: "warning", status: "warning", detail: "尚未试运行" },
        { id: "release-notes", label: "版本说明", severity: "warning", status: "warning", detail: "尚未填写" },
      ],
    };
    window.__releaseCalls = [];
    window.__lastDraftEmployee = undefined;
    window.__retryBuildCalls = 0;
    window.__abandonPublishCalls = 0;
    window.__keepLocalChangesCalls = 0;
    function Harness() {
      const [open, setOpen] = useState(true);
      const [release, setRelease] = useState(() => structuredClone(initialRelease));
      const [applyToCurrentApp, setApplyToCurrentApp] = useState(true);
      const [localDraft, setLocalDraft] = useState();
      const [canPublish, setCanPublish] = useState(true);
      const [publishProgress, setPublishProgress] = useState();
      if (!open) return <button onClick={() => {
        setRelease(structuredClone(initialRelease));
        setApplyToCurrentApp(true);
        setOpen(true);
      }}>重新打开发布页</button>;
      return <>
        <button onClick={() => setCanPublish((value) => !value)}>切换普通成员</button>
        <button onClick={() => setRelease((current) => ({
          ...current,
          checks: current.checks.map((check) => check.id === "portable-package"
            ? { ...check, status: check.status === "blocked" ? "passed" : "blocked" }
            : check),
        }))}>切换包阻断</button>
        <button onClick={() => setPublishProgress({
          localAppId: "story-seed",
          appId: "story-seed",
          packageKey: "opengrove.story-seed",
          version: "0.1.1",
          title: "故事种子",
          visibility: "restricted",
          phase: "remote_pending",
          remoteStatus: "trusted_build_failed",
          allowedActions: ["retry_build", "abandon"],
          applyToCurrentApp: true,
          state: "needs-retry",
          retryable: true,
          updatedAt: new Date().toISOString(),
        })}>模拟构建失败</button>
        <button onClick={() => setPublishProgress({
          localAppId: "story-seed",
          appId: "story-seed",
          packageKey: "opengrove.story-seed",
          version: "0.1.1",
          title: "故事种子",
          visibility: "restricted",
          phase: "remote_pending",
          remoteStatus: "trusted_build_failed",
          allowedActions: ["abandon"],
          buildFailure: {
            stage: "artifact_gate",
            code: "package_manifest_invalid",
            retryable: false,
            workflowRunId: "32824193615",
          },
          applyToCurrentApp: true,
          state: "needs-retry",
          retryable: false,
          updatedAt: new Date().toISOString(),
        })}>模拟确定性失败</button>
        <button onClick={() => setPublishProgress({
          localAppId: "story-seed",
          appId: "story-seed",
          packageKey: "opengrove.story-seed",
          version: "0.1.1",
          title: "故事种子",
          visibility: "restricted",
          phase: "remote_blocked",
          remoteStatus: "trusted_build_failed",
          allowedActions: ["abandon"],
          blockedRelease: {
            id: "old-release-from-another-device",
            status: "trusted_build_failed",
            packageKey: "opengrove.story-seed",
            version: "0.1.0",
            sourceSha256: "f".repeat(64),
            createdAt: new Date().toISOString(),
            allowedActions: ["abandon"],
            buildFailure: {
              stage: "artifact_gate",
              code: "package_manifest_invalid",
              retryable: false,
              workflowRunId: "32824193615",
            },
            matchesCurrentSource: false,
            matchesCurrentRequest: false,
          },
          applyToCurrentApp: true,
          state: "blocked",
          retryable: false,
          updatedAt: new Date().toISOString(),
        })}>模拟旧发布占用</button>
        <button onClick={() => setPublishProgress(releaseProgress({
          phase: "draft_saved",
        }))}>模拟上传阶段</button>
        <button onClick={() => setPublishProgress(releaseProgress({
          phase: "intent_created",
          remoteStatus: "awaiting_candidate",
        }))}>模拟候选阶段</button>
        <button onClick={() => setPublishProgress(releaseProgress({
          phase: "remote_pending",
          remoteStatus: "building",
        }))}>模拟构建阶段</button>
        <button onClick={() => setPublishProgress(releaseProgress({
          phase: "remote_pending",
          remoteStatus: "artifact_accepted",
        }))}>模拟登记阶段</button>
        <button onClick={() => setPublishProgress(releaseProgress({
          phase: "registry_ready",
          remoteStatus: "published",
          state: "registry-ready",
        }))}>模拟收尾阶段</button>
        <button onClick={() => setPublishProgress(undefined)}>清除模拟阶段</button>
        <button onClick={() => setPublishProgress({
          localAppId: "story-seed",
          appId: "story-seed",
          packageKey: "opengrove.story-seed",
          version: "0.1.1",
          title: "故事种子",
          visibility: "restricted",
          phase: "registry_ready",
          remoteStatus: "published",
          allowedActions: [],
          applyToCurrentApp: true,
          state: "registry-ready",
          retryable: true,
          updatedAt: new Date().toISOString(),
        })}>模拟本机收尾阻断</button>
        <AppStorePublishReleaseEditor
          release={release}
          publishBaseVersion="0.0.8"
          canPublish={canPublish}
          applyToCurrentApp={applyToCurrentApp}
          localDraft={localDraft}
          publishProgress={publishProgress}
          publishRecoveryBlocked={publishProgress?.state === "registry-ready"}
          providers={[{
            id: "ww",
            name: "WW",
            protocol: "anthropic-compatible",
            anthropicBaseUrl: "https://ww.test",
            apiKey: "ww_test_key",
            enabled: true,
            models: [{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }],
          }]}
          modelProviderBindings={[{ modelId: "deepseek-v4-pro", providerId: "ww" }]}
          onBack={() => setOpen(false)}
          onChange={setRelease}
          onApplyToCurrentAppChange={setApplyToCurrentApp}
          onSaveDraft={(candidate) => {
            window.__lastDraftEmployee = structuredClone(candidate.employees[0]);
            setLocalDraft({
              schemaVersion: 1,
              localAppId: "story-seed",
              appId: "story-seed",
              savedAt: new Date().toISOString(),
              archiveSha256: "a".repeat(64),
              archiveSize: 1024,
              contentDigest: "b".repeat(64),
              workingContentDigest: "c".repeat(64),
              publishBase: {
                packageKey: "opengrove.story-seed",
                version: "0.0.8",
                releaseCommitSha: "d".repeat(40),
                archiveSha256: "e".repeat(64),
              },
              employees: structuredClone(candidate.employees),
            });
          }}
          onPublish={(submitted, options) => {
            window.__releaseCalls.push({
              release: structuredClone(submitted),
              applyToCurrentApp: options.applyToCurrentApp,
            });
            window.__publishedResult = { title: submitted.app.title };
          }}
          onRetryPublishBuild={() => {
            window.__retryBuildCalls += 1;
          }}
          onAbandonPublish={() => {
            window.__abandonPublishCalls += 1;
          }}
          onKeepLocalChanges={() => {
            window.__keepLocalChangesCalls += 1;
          }}
        />
      </>;
    }
    function HttpHarness() {
      const blockedMode = new URLSearchParams(window.location.search).has("blocked");
      const formalErrorMode = new URLSearchParams(window.location.search).get("formal-error");
      const recoverableStaleExhaustedMode = new URLSearchParams(window.location.search).has("recoverable-stale-exhausted");
      const recoverableStaleMode = new URLSearchParams(window.location.search).has("recoverable-stale")
        || recoverableStaleExhaustedMode;
      const finalizeTimeoutMode = new URLSearchParams(window.location.search).has("finalize-timeout");
      const slowPublishMode = new URLSearchParams(window.location.search).has("slow-publish");
      const candidateErrorMode = new URLSearchParams(window.location.search).has("candidate-error");
      const localBuildErrorMode = new URLSearchParams(window.location.search).has("local-build-error");
      const abandonRefetchMode = new URLSearchParams(window.location.search).has("abandon-refetch");
      const repairContractMode = new URLSearchParams(window.location.search).has("repair-contract");
      const repairContractConflictMode = new URLSearchParams(window.location.search).has("repair-contract-conflict");
      const repairContractFailureMode = new URLSearchParams(window.location.search).has("repair-contract-failure");
      const canPublish = !new URLSearchParams(window.location.search).has("member");
      window.__backCalls ??= 0;
      window.__releaseStarted ??= false;
      window.__formalPrepareCount ??= 0;
      window.__releaseAbandoned ??= false;
      window.__contractRepaired ??= false;
      const preparedRelease = () => {
        if ((!repairContractMode && !repairContractConflictMode && !repairContractFailureMode) || window.__contractRepaired) return initialRelease;
        return {
          ...initialRelease,
          checks: initialRelease.checks.map((check) => check.id === "trusted-build-contract"
            ? { ...check, status: "blocked", severity: "blocking", detail: "build_contract_missing" }
            : check),
        };
      };
      const registryReadyProgress = {
        localAppId: "story-seed",
        appId: "story-seed",
        packageKey: "opengrove.story-seed",
        version: "0.1.0",
        title: "故事种子",
        visibility: "restricted",
        phase: "registry_ready",
        allowedActions: [],
        remoteIntentId: "intent-story-seed",
        remoteStatus: "published",
        applyToCurrentApp: true,
        state: "registry-ready",
        retryable: true,
        updatedAt: new Date().toISOString(),
      };
      window.__releaseRequests = [];
      window.fetch = async (input, init = {}) => {
        const method = init.method ?? "GET";
        const path = new URL(String(input), "http://opengrove.test").pathname;
        window.__releaseRequests.push({ method, path });
        if (method === "GET" && path === "/apps/story-seed/draft") {
          return jsonResponse(404, { ok: false, error: "local_app_draft_not_found" });
        }
        if (method === "GET" && path === "/apps/story-seed/draft/prepare") {
          return jsonResponse(200, { ok: true, release: preparedRelease() });
        }
        if (method === "GET" && path === "/apps/story-seed/publish/prepare") {
          window.__formalPrepareCount += 1;
          if (abandonRefetchMode && window.__formalPrepareCount > 1) {
            await new Promise((resolve) => {
              window.__finishAbandonPrepare = resolve;
            });
          }
          if (formalErrorMode) {
            return jsonResponse(503, {
              ok: false,
              error: formalErrorMode === "unavailable"
                ? "app_release_request_unavailable"
                : formalErrorMode === "artifact"
                  ? "app_release_trusted_artifact_invalid"
                  : formalErrorMode === "identity"
                    ? "app_release_response_identity_mismatch"
                    : formalErrorMode === "error-response"
                      ? "app_release_error_response_invalid"
                    : formalErrorMode === "body-missing"
                      ? "app_release_response_body_missing"
                      : formalErrorMode === "unauthorized"
                        ? "release_control_unauthorized"
                        : formalErrorMode === "identity-unavailable"
                          ? "release_control_identity_unavailable"
                : "registry_request_failed:503",
            });
          }
          return jsonResponse(200, { ok: true, release: preparedRelease() });
        }
        if (method === "POST" && path === "/apps/story-seed/publish/build-contract") {
          if (repairContractConflictMode) {
            return jsonResponse(409, { ok: false, error: "app_release_build_contract_repair_conflict" });
          }
          if (repairContractFailureMode) {
            return jsonResponse(409, { ok: false, error: "app_release_build_contract_repair_failed" });
          }
          window.__contractRepaired = true;
          return jsonResponse(200, { ok: true });
        }
        if (method === "GET" && path === "/apps/story-seed/versions") {
          return jsonResponse(200, {
            ok: true,
            localAppId: "story-seed",
            packageKey: "opengrove.story-seed",
            status: {
              activeContent: "formal",
              selectedVersion: {
                packageKey: "opengrove.story-seed",
                version: "0.0.8",
                releaseCommitSha: "d".repeat(40),
                archiveSha256: "e".repeat(64),
              },
              versions: [],
              hasUnsavedChanges: false,
            },
          });
        }
        if (
          method === "GET"
          && (
            path === "/apps/story-seed/publish"
            || path === "/apps/story-seed/publish/status"
          )
        ) {
          if (abandonRefetchMode && !window.__releaseAbandoned) {
            return jsonResponse(200, {
              ok: true,
              progress: {
                localAppId: "story-seed",
                appId: "story-seed",
                packageKey: "opengrove.story-seed",
                version: "0.1.0",
                title: "故事种子",
                visibility: "restricted",
                phase: "remote_pending",
                remoteStatus: "trusted_build_failed",
                allowedActions: ["retry_build", "abandon"],
                applyToCurrentApp: false,
                state: "needs-retry",
                retryable: true,
                updatedAt: new Date().toISOString(),
              },
            });
          }
          if (blockedMode) {
            return jsonResponse(200, { ok: true, progress: registryReadyProgress });
          }
          if (recoverableStaleMode && window.__releaseStarted) {
            return jsonResponse(200, {
              ok: true,
              progress: {
                localAppId: "story-seed",
                appId: "story-seed",
                packageKey: "opengrove.story-seed",
                version: "0.1.0",
                title: "故事种子",
                visibility: "restricted",
                phase: "remote_pending",
                allowedActions: [],
                remoteIntentId: "intent-story-seed",
                remoteStatus: "artifact_accepted",
                applyToCurrentApp: false,
                state: "publishing",
                retryable: true,
                updatedAt: new Date().toISOString(),
              },
            });
          }
          if (finalizeTimeoutMode && window.__releaseStarted) {
            return jsonResponse(200, {
              ok: true,
              progress: {
                localAppId: "story-seed",
                appId: "story-seed",
                packageKey: "opengrove.story-seed",
                version: "0.1.0",
                title: "故事种子",
                visibility: "restricted",
                phase: "remote_pending",
                allowedActions: [],
                remoteIntentId: "intent-story-seed",
                remoteStatus: "finalizing",
                applyToCurrentApp: false,
                state: "publishing",
                retryable: true,
                updatedAt: new Date().toISOString(),
              },
            });
          }
          if (slowPublishMode && window.__releaseStarted) {
            return jsonResponse(200, {
              ok: true,
              progress: {
                localAppId: "story-seed",
                appId: "story-seed",
                packageKey: "opengrove.story-seed",
                version: "0.1.0",
                title: "故事种子",
                visibility: "restricted",
                phase: "draft_saved",
                allowedActions: [],
                applyToCurrentApp: false,
                state: "publishing",
                retryable: true,
                updatedAt: new Date().toISOString(),
              },
            });
          }
          return jsonResponse(404, { ok: false, error: "app_store_publish_journal_missing" });
        }
        if (method === "POST" && path === "/apps/story-seed/publish/reconcile" && recoverableStaleMode) {
          const reconcileRequestCount = window.__releaseRequests.filter((request) => (
            request.method === "POST" && request.path === "/apps/story-seed/publish/reconcile"
          )).length;
          if (reconcileRequestCount === 1 || (recoverableStaleExhaustedMode && reconcileRequestCount === 2)) {
            return jsonResponse(409, {
              ok: false,
              error: "app_release_publish_base_stale",
              progress: {
                localAppId: "story-seed",
                appId: "story-seed",
                packageKey: "opengrove.story-seed",
                version: "0.1.0",
                title: "故事种子",
                visibility: "restricted",
                phase: "remote_pending",
                allowedActions: [],
                remoteIntentId: "intent-story-seed",
                remoteStatus: "artifact_accepted",
                applyToCurrentApp: false,
                state: "publishing",
                retryable: true,
                updatedAt: new Date().toISOString(),
              },
            });
          }
          window.__releaseStarted = false;
          return jsonResponse(200, {
            ok: true,
            progress: {
              localAppId: "story-seed",
              appId: "story-seed",
              packageKey: "opengrove.story-seed",
              version: "0.1.0",
              title: "故事种子",
              visibility: "restricted",
              phase: "local_finalized",
              allowedActions: [],
              remoteIntentId: "intent-story-seed",
              remoteStatus: "published",
              applyToCurrentApp: false,
              state: "published",
              retryable: false,
              updatedAt: new Date().toISOString(),
            },
          });
        }
        if (method === "POST" && path === "/apps/story-seed/publish/reconcile" && finalizeTimeoutMode) {
          return jsonResponse(504, {
            ok: false,
            error: "app_release_request_timeout",
            progress: {
              localAppId: "story-seed",
              appId: "story-seed",
              packageKey: "opengrove.story-seed",
              version: "0.1.0",
              title: "故事种子",
              visibility: "restricted",
              phase: "remote_pending",
              allowedActions: [],
              remoteIntentId: "intent-story-seed",
              remoteStatus: "finalizing",
              applyToCurrentApp: false,
              state: "publishing",
              retryable: true,
              updatedAt: new Date().toISOString(),
            },
          });
        }
        if (method === "POST" && path === "/apps/story-seed/publish/reconcile" && blockedMode) {
          return jsonResponse(409, {
            ok: false,
            error: "app_store_publish_draft_changed",
            progress: registryReadyProgress,
          });
        }
        if (method === "POST" && path === "/apps/story-seed/publish/abandon" && abandonRefetchMode) {
          window.__releaseAbandoned = true;
          return jsonResponse(200, {
            ok: true,
            progress: {
              localAppId: "story-seed",
              appId: "story-seed",
              packageKey: "opengrove.story-seed",
              version: "0.1.0",
              title: "故事种子",
              visibility: "restricted",
              phase: "remote_closed",
              allowedActions: [],
              remoteStatus: "abandoned",
              applyToCurrentApp: false,
              state: "closed",
              retryable: false,
              updatedAt: new Date().toISOString(),
            },
          });
        }
        if (method === "POST" && path === "/apps/story-seed/publish/keep-local" && blockedMode) {
          return jsonResponse(200, {
            ok: true,
            progress: {
              ...registryReadyProgress,
              phase: "local_preserved",
              state: "published",
              retryable: false,
              updatedAt: new Date().toISOString(),
            },
          });
        }
        if (method === "POST" && path === "/apps/story-seed/publish") {
          if (localBuildErrorMode) {
            return jsonResponse(422, {
              ok: false,
              error: "app_release_local_build_command_failed",
              detail: {
                commandIndex: 2,
                argv: ["npm", "run", "build", "--", "--target", "ui"],
                argvTruncated: true,
                exitCode: 23,
                stdout: "generated ui bundle",
                stderr: "build.mjs: target ui failed",
                stdoutTruncated: true,
                stderrTruncated: true,
              },
            });
          }
          if (candidateErrorMode) {
            return jsonResponse(422, {
              ok: false,
              error: "app_release_secret_blocked",
              requestId: "0123456789abcdef0123456789abcdef",
              candidateStage: "candidate_ref_push",
            });
          }
          window.__releaseStarted = recoverableStaleMode || slowPublishMode || finalizeTimeoutMode;
          if (slowPublishMode) {
            await new Promise((resolve) => {
              window.__finishSlowPublish = resolve;
            });
          }
          if (finalizeTimeoutMode) {
            return jsonResponse(504, {
              ok: false,
              error: "app_release_request_timeout",
              progress: {
                localAppId: "story-seed",
                appId: "story-seed",
                packageKey: "opengrove.story-seed",
                version: "0.1.0",
                title: "故事种子",
                visibility: "restricted",
                phase: "remote_pending",
                allowedActions: [],
                remoteIntentId: "intent-story-seed",
                remoteStatus: "finalizing",
                applyToCurrentApp: false,
                state: "publishing",
                retryable: true,
                updatedAt: new Date().toISOString(),
              },
            });
          }
          return jsonResponse(200, {
            ok: true,
            progress: {
              localAppId: "story-seed",
              appId: "story-seed",
              packageKey: "opengrove.story-seed",
              version: "0.1.0",
              title: "故事种子",
              visibility: "restricted",
              phase: recoverableStaleMode ? "remote_pending" : "local_finalized",
              allowedActions: [],
              remoteIntentId: "intent-story-seed",
              remoteStatus: recoverableStaleMode ? "artifact_accepted" : "published",
              applyToCurrentApp: false,
              state: recoverableStaleMode ? "publishing" : "published",
              retryable: recoverableStaleMode,
              updatedAt: new Date().toISOString(),
            },
          });
        }
        if (method === "PUT" && path === "/apps/story-seed/draft") {
          return jsonResponse(200, { ok: true, draft: { savedAt: new Date().toISOString() } });
        }
        throw new Error("unexpected_request:" + method + ":" + path);
      };
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      return (
        <QueryClientProvider client={queryClient}>
          <AppStorePublishPage
            app={{ id: "story-seed", title: "故事种子" }}
            canPublish={canPublish}
            onBack={() => { window.__backCalls += 1; }}
            onPublished={() => {
              window.__publishedResult = { version: "0.1.0" };
            }}
          />
        </QueryClientProvider>
      );
    }
    function jsonResponse(status, value) {
      return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    function releaseProgress(overrides = {}) {
      return {
        localAppId: "story-seed",
        appId: "story-seed",
        packageKey: "opengrove.story-seed",
        version: "0.1.1",
        title: "故事种子",
        visibility: "restricted",
        phase: "remote_pending",
        allowedActions: [],
        applyToCurrentApp: false,
        state: "publishing",
        retryable: true,
        updatedAt: new Date().toISOString(),
        ...overrides,
      };
    }
    if (!localStorage.getItem("opengroveLanguage")) localStorage.setItem("opengroveLanguage", "zh-CN");
    createRoot(document.getElementById("root")!).render(
      <ToastProvider>
        <ConfirmProvider>
          {new URLSearchParams(window.location.search).has("http")
            || new URLSearchParams(window.location.search).has("blocked")
            || new URLSearchParams(window.location.search).has("formal-error")
            ? <HttpHarness />
            : <Harness />}
        </ConfirmProvider>
      </ToastProvider>,
    );
  `;
}
