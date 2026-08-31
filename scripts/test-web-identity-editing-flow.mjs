import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-identity-editing-flow-"));
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
  });
  await writeFile(htmlPath, fixtureHtml(), "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
    await page.goto(pathToFileURL(htmlPath).href);
    await testEmployeePageFlow(page);
    await testEmployeeReasoningKernelSwitch(page);
    await testEmployeeReasoningCapabilityStates(page);
    await testEmployeeReasoningServerDefault(page);
    await testEmployeeReasoningDefaultHierarchy(page);
    await testEmployeeAutosaveEchoPreservesExternalChanges(page);
    await testEmployeeRestoreAppDefaults(page);
    await testEmployeeAutosaveNavigation(page);
    await testEmployeeAutosaveSerializesConcurrentChanges(page);
    await testUnavailableKernelCopy(page);
    await testEmployeeDialogFlow(page);
    await testAppPageFlow(page);
    await testAppDialogFlow(page);
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

// ===== Employee reasoning behavior =====

async function testEmployeeReasoningCapabilityStates(page) {
  await renderFixture(page, "employee-reasoning-loading");
  const loadingSurface = page.locator("#identity-root .contacts-employee-settings-surface");
  const loadingReasoningField = loadingSurface.locator(".employee-dialog-field").filter({ hasText: "思考等级" });
  await loadingReasoningField.waitFor({ state: "visible" });
  assert.match(
    (await loadingReasoningField.innerText()).replace(/\s+/g, ""),
    /思考等级中/,
    "loading runtime capabilities must keep the effective medium reasoning level visible",
  );
  await loadingSurface.locator(".employee-dialog-kernel-list").getByRole("button", { name: "Pi", exact: true }).click();
  await page.waitForFunction(() => window.__savedEmployeeKernel === "pi");
  assert.equal(
    await page.evaluate(() => window.__savedEmployeeReasoningEffort),
    undefined,
    "switching Kernels while capabilities load must not persist the fallback reasoning level",
  );

  await renderFixture(page, "employee-reasoning-unsupported");
  const unsupportedSurface = page.locator("#identity-root .contacts-employee-settings-surface");
  assert.equal(
    await unsupportedSurface.locator(".employee-dialog-field").filter({ hasText: "思考等级" }).count(),
    0,
    "only an explicit unsupported capability declaration may hide the reasoning control",
  );
}

async function testEmployeeReasoningServerDefault(page) {
  await renderFixture(page, "employee-reasoning-server-default");
  const reasoningField = page.locator("#identity-root .employee-dialog-field").filter({ hasText: "思考等级" });
  await reasoningField.waitFor({ state: "visible" });
  assert.equal(
    (await reasoningField.getByRole("button").innerText()).trim(),
    "高",
    "the reasoning control must display the Kernel default declared by the Host",
  );
}

async function testEmployeeReasoningDefaultHierarchy(page) {
  await renderFixture(page, "employee-reasoning-app-default");
  let surface = page.locator("#identity-root .contacts-employee-settings-surface");
  let reasoningField = surface.locator(".employee-dialog-field").filter({ hasText: "思考等级" });
  assert.equal(
    (await reasoningField.getByRole("button").innerText()).trim(),
    "低",
    "an Employee without a user override must display the compatible App default",
  );

  await renderFixture(page, "employee-reasoning-user-override");
  surface = page.locator("#identity-root .contacts-employee-settings-surface");
  reasoningField = surface.locator(".employee-dialog-field").filter({ hasText: "思考等级" });
  assert.equal(
    (await reasoningField.getByRole("button").innerText()).trim(),
    "高",
    "an explicit user choice must win over the App default",
  );

  await renderFixture(page, "employee-reasoning-app-default-incompatible");
  surface = page.locator("#identity-root .contacts-employee-settings-surface");
  reasoningField = surface.locator(".employee-dialog-field").filter({ hasText: "思考等级" });
  assert.equal((await reasoningField.getByRole("button").innerText()).trim(), "最大");
  await surface.locator(".employee-dialog-kernel-list").getByRole("button", { name: "Pi", exact: true }).click();
  await page.waitForFunction(() => window.__savedEmployeeKernel === "pi");
  assert.equal(
    (await reasoningField.getByRole("button").innerText()).trim(),
    "中",
    "an App default unsupported by the selected Kernel must fall back to the Kernel default",
  );
  assert.equal(
    await page.evaluate(() => window.__savedEmployeeReasoningEffort),
    undefined,
    "falling back to a Kernel default must not create a user reasoning override",
  );
  await page.waitForTimeout(50);
}

async function testEmployeeAutosaveEchoPreservesExternalChanges(page) {
  await renderFixture(page, "employee-autosave-external-merge");
  const editor = page.locator("#identity-root .employee-dialog-embedded");
  await editor.getByRole("textbox", { name: "员工名称" }).fill("Alice");
  await page.waitForFunction(() => window.__employeeExternalRoleApplied === true);
  await editor.getByRole("tab").nth(2).click();
  assert.equal(
    await editor.locator(".employee-dialog-responsibility-textarea").inputValue(),
    "外部同步的职责",
    "an external field change merged with an autosave echo must still refresh the draft",
  );
}

async function testEmployeeReasoningKernelSwitch(page) {
  await renderFixture(page, "employee-reasoning-kernel-switch");
  const surface = page.locator("#identity-root .contacts-employee-settings-surface");
  const kernelList = surface.locator(".employee-dialog-kernel-list");
  const reasoningField = surface.locator(".employee-dialog-field").filter({ hasText: "思考等级" });

  await reasoningField.waitFor({ state: "visible" });
  assert.equal(
    (await reasoningField.getByRole("button").innerText()).trim(),
    "中",
    "an employee without an explicit reasoning override must show the effective medium level",
  );

  await reasoningField.getByRole("button").click();
  await page.getByRole("option", { name: "高", exact: true }).click();
  await page.waitForFunction(() => window.__savedEmployeeReasoningEffort === "high");

  await kernelList.getByRole("button", { name: "Pi", exact: true }).click();
  await page.waitForFunction(() => window.__savedEmployeeKernel === "pi");
  await reasoningField.waitFor({ state: "visible" });
  assert.equal(
    (await reasoningField.getByRole("button").innerText()).trim(),
    "中",
    "Pi must expose a valid effective reasoning level after the Kernel switch",
  );
  assert.equal(
    await page.evaluate(() => window.__savedEmployeeReasoningEffort),
    undefined,
    "switching to a supported Kernel must not persist its default as a user choice",
  );
  await reasoningField.getByRole("button").click();
  assert.deepEqual(
    await page.getByRole("option").allInnerTexts(),
    ["低", "中", "高", "超高", "最大"],
    "Pi must expose every reasoning level declared by its runtime contract",
  );
  await page.getByRole("option", { name: "中", exact: true }).click();

  await kernelList.getByRole("button", { name: "Claude Agent", exact: true }).click();
  await page.waitForFunction(() => window.__savedEmployeeKernel === "claude-code");
  await reasoningField.waitFor({ state: "visible" });
  assert.equal(
    (await reasoningField.getByRole("button").innerText()).trim(),
    "高",
    "switching back after autosave and member reload must restore Claude's reasoning draft",
  );
  assert.equal(await page.evaluate(() => window.__savedEmployeeModel), "claude-custom");
  assert.equal(await page.evaluate(() => window.__savedEmployeeProviderId), "claude-provider");
  assert.equal(await page.evaluate(() => window.__savedEmployeeReasoningEffort), "high");
}

async function testEmployeeAutosaveNavigation(page) {
  await renderFixture(page, "employee-page");
  const surface = page.locator("#identity-root .contacts-employee-settings-surface");
  const contextBudget = surface.getByRole("spinbutton", { name: "上下文窗口（tokens）" });
  await page.evaluate(() => {
    window.__blockEmployeeSaves = true;
  });

  await contextBudget.fill("777000");
  await surface.getByRole("button", { name: "能力", exact: true }).click();
  await page.waitForFunction(() => window.__employeeSaveAttempts === 1);
  assert.equal(
    await surface.locator(".contacts-employee-subpage-header").count(),
    0,
    "employee subpage navigation must wait for the pending settings save",
  );
  await page.evaluate(() => {
    window.__blockEmployeeSaves = false;
    window.__releaseEmployeeSave?.();
  });
  await surface.locator(".contacts-employee-subpage-header").waitFor();
  assert.equal(
    await page.evaluate(() => window.__employeeSaveAttempts),
    1,
    "switching employee subpages must flush a pending debounced settings change",
  );
  assert.equal(
    await page.evaluate(() => window.__savedEmployeeContextTokenBudget),
    777000,
    "the flushed employee patch must retain the pending context budget",
  );

  await surface.getByRole("button", { name: "返回员工概览" }).click();
  await contextBudget.waitFor({ state: "visible" });
  assert.equal(
    await contextBudget.inputValue(),
    "777000",
    "returning to the employee overview must show the persisted setting",
  );
}

async function testEmployeeAutosaveSerializesConcurrentChanges(page) {
  await renderFixture(page, "employee-page");
  const surface = page.locator("#identity-root .contacts-employee-settings-surface");
  const kernelList = surface.locator(".employee-dialog-kernel-list");
  await page.evaluate(() => {
    window.__blockEmployeeSaves = true;
  });

  await kernelList.getByRole("button", { name: "Claude Agent" }).click();
  await page.waitForFunction(() => window.__employeeSaveAttempts === 1);
  await kernelList.getByRole("button", { name: "Codex" }).click();
  await page.evaluate(() => {
    window.__blockEmployeeSaves = false;
    window.__releaseEmployeeSave?.();
  });
  await page.waitForFunction(() => window.__employeeSaveAttempts === 2 && window.__savedEmployeeKernel === "codex");
  const saveProbe = await page.evaluate(() => ({
    attempts: window.__employeeSaveAttempts,
    count: window.__savedEmployeeCount,
    kernel: window.__savedEmployeeKernel,
  }));
  assert.equal(
    saveProbe.kernel,
    "codex",
    "the newest queued employee setting must win after the in-flight save finishes",
  );
  assert.equal(saveProbe.attempts, 2, "concurrent employee setting changes must serialize without duplicate writes");
  assert.equal(
    saveProbe.count,
    2,
    "a setting changed during an in-flight save must be queued and persisted afterwards",
  );
}

console.log("web-identity-editing-flow harness ok");

async function testEmployeeRestoreAppDefaults(page) {
  await page.setViewportSize({ width: 360, height: 860 });
  await setFixtureLanguage(page, "en");
  await renderFixture(page, "employee-page");
  const surface = page.locator("#identity-root .contacts-employee-settings-surface");
  const summaryBox = await surface.locator(".contacts-employee-summary").boundingBox();
  const identityBox = await surface.locator(".contacts-employee-identity").boundingBox();
  const restoreBox = await surface.getByRole("button", { name: "Restore defaults" }).boundingBox();
  assertTopRightAction(summaryBox, restoreBox, "the page restore action");
  assertNoIntersection(restoreBox, identityBox, "the page restore action must not overlap the employee identity");

  await setFixtureLanguage(page, "zh-CN");
  await renderFixture(page, "employee-dialog");
  const dialog = page.getByRole("dialog", { name: "员工资料与运行设置" });
  const dialogSummaryBox = await dialog.locator(".contacts-employee-summary").boundingBox();
  const dialogIdentityBox = await dialog.locator(".contacts-employee-identity").boundingBox();
  const dialogRestoreBox = await dialog.getByRole("button", { name: "恢复默认配置" }).boundingBox();
  const dialogCloseBox = await dialog.locator(".employee-settings-dialog-close").boundingBox();
  assertTopRightAction(dialogSummaryBox, dialogRestoreBox, "the dialog restore action");
  assertNoIntersection(
    dialogRestoreBox,
    dialogIdentityBox,
    "the dialog restore action must not overlap the employee identity",
  );
  assertNoIntersection(
    dialogRestoreBox,
    dialogCloseBox,
    "the dialog restore action must not overlap the dialog close button",
  );

  await page.setViewportSize({ width: 1180, height: 860 });
  await renderFixture(page, "employee-page");

  assert.equal(
    await surface.getByRole("button", { name: "员工操作" }).count(),
    0,
    "App-default restoration must not be hidden behind an overflow menu",
  );
  await surface.getByRole("button", { name: "恢复默认配置" }).click();

  const confirmation = page.getByRole("dialog", { name: "恢复 App 默认配置？" });
  await confirmation.waitFor();
  assert.match(
    await confirmation.textContent(),
    /4 项本机修改/,
    "the confirmation must disclose how many local overrides will be replaced",
  );
  assert.match(await confirmation.textContent(), /员工名称/, "the confirmation must name the employee-name change");
  for (const changedSetting of ["模型", "可用 skill", "人设 / 职责"]) {
    assert.match(
      await confirmation.textContent(),
      new RegExp(changedSetting),
      `the confirmation must name the ${changedSetting} change`,
    );
  }
  assert.match(
    await confirmation.textContent(),
    /Provider 绑定会保留/,
    "the confirmation must disclose that the local Provider binding is retained",
  );

  await confirmation.getByRole("button", { name: "取消" }).click();
  assert.equal(
    await page.evaluate(() => window.__employeeRestoreAttempts),
    0,
    "cancelling must not send a restore request",
  );
  assert.equal(
    await surface.getByRole("button", { name: "恢复默认配置" }).count(),
    1,
    "cancelling must retain the restore action",
  );

  await surface.getByRole("button", { name: "恢复默认配置" }).click();
  await page.getByRole("dialog", { name: "恢复 App 默认配置？" }).getByRole("button", { name: "恢复" }).click();
  await page.waitForFunction(() => window.__employeeRestoreAttempts === 1);
  const successToast = page.getByRole("status").filter({ hasText: "已恢复 App 默认配置，下次运行生效" });
  await successToast.waitFor();
  assert.equal(
    await surface.getByRole("button", { name: "恢复默认配置" }).count(),
    0,
    "the direct restore button must disappear after all App overrides are cleared",
  );

  await renderFixture(page, "employee-page");
  await page.evaluate(() => {
    window.__failNextEmployeeRestore = true;
  });
  const retrySurface = page.locator("#identity-root .contacts-employee-settings-surface");
  await retrySurface.getByRole("button", { name: "恢复默认配置" }).click();
  await page.getByRole("dialog", { name: "恢复 App 默认配置？" }).getByRole("button", { name: "恢复" }).click();
  const errorToast = page.getByRole("alert").filter({ hasText: "保存失败：模拟恢复失败" });
  await errorToast.waitFor();
  assert.equal(
    await retrySurface.getByRole("button", { name: "恢复默认配置" }).count(),
    1,
    "a failed restore must keep the action available",
  );
  await errorToast.getByRole("button", { name: "重试" }).click();
  const retryConfirmation = page.getByRole("dialog", { name: "恢复 App 默认配置？" });
  await retryConfirmation.waitFor();
  assert.equal(
    await page.evaluate(() => window.__employeeRestoreAttempts),
    1,
    "retry must ask for confirmation before sending again",
  );
  await retryConfirmation.getByRole("button", { name: "恢复" }).click();
  await page.waitForFunction(() => window.__employeeRestoreAttempts === 2);
  await page.getByRole("status").filter({ hasText: "已恢复 App 默认配置，下次运行生效" }).waitFor();
  assert.equal(
    await retrySurface.getByRole("button", { name: "恢复默认配置" }).count(),
    0,
    "a successful retry must clear the restore action",
  );
}

async function setFixtureLanguage(page, language) {
  await page.evaluate((nextLanguage) => window.__setIdentityFixtureLanguage(nextLanguage), language);
  await page.waitForFunction((nextLanguage) => document.documentElement.lang === nextLanguage, language);
}

function assertTopRightAction(container, action, label) {
  assert.ok(container && action, `${label} must be measurable`);
  const tolerance = 0.5;
  assert.ok(
    action.x >= container.x - tolerance &&
      action.y >= container.y - tolerance &&
      action.x + action.width <= container.x + container.width + tolerance &&
      action.y + action.height <= container.y + container.height + tolerance,
    `${label} must stay inside the employee summary`,
  );
  assert.ok(
    action.x + action.width / 2 >= container.x + container.width / 2 &&
      action.y + action.height / 2 <= container.y + container.height / 2,
    `${label} must stay in the employee summary's top-right quadrant`,
  );
}

function assertNoIntersection(first, second, message) {
  assert.ok(first && second, `${message}: both elements must be measurable`);
  assert.ok(
    first.x + first.width <= second.x ||
      second.x + second.width <= first.x ||
      first.y + first.height <= second.y ||
      second.y + second.height <= first.y,
    message,
  );
}

async function renderFixture(page, mode) {
  const revision = await page.evaluate((nextMode) => window.__renderIdentityFixture(nextMode), mode);
  await page.waitForFunction(
    (nextRevision) =>
      document.querySelector("#identity-root")?.getAttribute("data-fixture-revision") === String(nextRevision),
    revision,
  );
  if (
    mode === "employee-page" ||
    mode === "employee-unavailable-kernel" ||
    mode === "employee-reasoning-kernel-switch" ||
    mode === "employee-reasoning-loading" ||
    mode === "employee-reasoning-unsupported" ||
    mode === "employee-reasoning-server-default" ||
    mode === "employee-reasoning-app-default" ||
    mode === "employee-reasoning-user-override" ||
    mode === "employee-reasoning-app-default-incompatible"
  ) {
    await page.locator("#identity-root .contacts-employee-settings-surface").waitFor();
  } else if (mode === "employee-autosave-external-merge") {
    await page.locator("#identity-root .employee-dialog-embedded").waitFor();
  } else if (mode === "employee-dialog") {
    await page.getByRole("dialog", { name: "员工资料与运行设置" }).waitFor();
  } else if (mode === "app-page") {
    await page.getByRole("button", { name: "更换 App 图标" }).waitFor();
  } else {
    await page.getByRole("dialog", { name: "App 设置测试" }).waitFor();
  }
}

async function waitForAvatarImage(locator) {
  await locator.locator("img").waitFor({ state: "attached" });
  await locator.locator("img").waitFor({ state: "visible" });
  return locator.locator("img").getAttribute("src");
}

async function testEmployeePageFlow(page) {
  await renderFixture(page, "employee-page");
  const surface = page.locator("#identity-root .contacts-employee-settings-surface");
  const outerAvatar = surface.locator(".contacts-employee-avatar .rooms-avatar");
  const outerSource = await waitForAvatarImage(outerAvatar);

  assert.ok(outerSource?.startsWith("data:image/svg+xml"));
  assert.equal(await surface.getByRole("textbox", { name: "员工名称" }).inputValue(), "分析师");
  assert.equal(await surface.getByRole("button", { name: "基本资料" }).count(), 0);
  assert.equal(
    await surface.getByRole("button", { name: "保存", exact: true }).count(),
    0,
    "existing employee settings must persist immediately without a Save button",
  );
  assert.equal(
    await surface.locator(".employee-dialog-runtime-card").count(),
    1,
    "the employee overview must mount one runtime editor",
  );
  const activitySummaryDensity = await surface.locator(".contacts-employee-activity-summary").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      gap: style.rowGap,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
    };
  });
  assert.deepEqual(
    activitySummaryDensity,
    { gap: "12px", paddingTop: "12px", paddingBottom: "12px" },
    "the employee activity summary must retain its compact vertical density",
  );
  const inlineSelectField = surface
    .locator(".employee-dialog-runtime-fields > .employee-dialog-field")
    .filter({ hasText: /^权限/ });
  const inlineSelectLabel = inlineSelectField.getByText("权限", { exact: true });
  const inlineSelect = inlineSelectField.locator("[data-inline-select-button]");
  await inlineSelectLabel.click();
  assert.equal(
    await inlineSelect.getAttribute("aria-expanded"),
    "false",
    "clicking a runtime row label must not activate its inline select",
  );
  const emptyContextBudget = surface.getByRole("spinbutton", { name: "上下文窗口（tokens）" });
  const emptyContextBudgetSizing = await emptyContextBudget.evaluate((element) => ({
    fieldSizing: getComputedStyle(element).fieldSizing,
    width: element.getBoundingClientRect().width,
  }));
  assert.equal(
    emptyContextBudgetSizing.fieldSizing,
    "content",
    "the context budget control must size itself from its current value or placeholder",
  );
  assert.ok(
    emptyContextBudgetSizing.width >= 180,
    "the empty context budget control must leave enough room for its explanatory placeholder",
  );
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(() => window.__savedEmployeeCount),
    0,
    "the inline runtime editor must not save until the user changes a field",
  );

  await surface.getByRole("button", { name: "头像" }).click();
  assert.equal(await page.locator(".modal-overlay").count(), 1);
  assert.equal(await page.locator(".employee-avatar-picker-subpage").count(), 0);
  const picker = page.getByRole("dialog", { name: "头像" });
  const previewSource = await waitForAvatarImage(picker.locator(".employee-avatar-picker-preview .rooms-avatar"));
  assert.equal(
    previewSource,
    outerSource,
    "the direct avatar editor must preserve the displayed App employee identity",
  );
  const tabs = picker.locator(".employee-dialog-avatar-tabs");
  const generatedTab = picker.getByRole("tab", { name: "系统头像" });
  const initialsTab = picker.getByRole("tab", { name: "名字字母" });
  const uploadTab = picker.getByRole("tab", { name: "上传图片" });
  assert.equal(await tabs.getByRole("tab").count(), 3);
  assert.equal(await generatedTab.getAttribute("aria-selected"), "true");
  assert.equal(await generatedTab.locator(".employee-dialog-avatar-tab-thumb").count(), 1);
  assert.notEqual(
    await tabs.evaluate((element) => getComputedStyle(element).backgroundColor),
    await generatedTab
      .locator(".employee-dialog-avatar-tab-thumb")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    "the active avatar tab must have a visually distinct surface",
  );
  assert.equal(
    await picker
      .locator(".employee-dialog-avatar-tabs + .employee-dialog-avatar-panel")
      .getByRole("button", { name: "换一组" })
      .count(),
    1,
    "New set must live inside the System avatar tab panel",
  );
  await generatedTab.focus();
  await generatedTab.press("ArrowRight");
  assert.equal(await initialsTab.getAttribute("aria-selected"), "true", "avatar tabs must support arrow-key selection");
  assert.equal(
    await initialsTab.evaluate((element) => element === document.activeElement),
    true,
    "arrow-key tab selection must move focus",
  );
  await initialsTab.press("ArrowLeft");
  await picker.getByRole("tabpanel", { name: "系统头像" }).waitFor();
  const generatedOptions = picker.getByRole("radiogroup", { name: "系统头像" }).getByRole("radio");
  const checkedIndex = await generatedOptions.evaluateAll((elements) =>
    elements.findIndex((element) => element.getAttribute("aria-checked") === "true"),
  );
  const activeGeneratedOption = generatedOptions.nth(checkedIndex);
  const nextGeneratedOption = generatedOptions.nth((checkedIndex + 1) % (await generatedOptions.count()));
  await activeGeneratedOption.focus();
  await activeGeneratedOption.press("ArrowRight");
  assert.equal(
    await nextGeneratedOption.getAttribute("aria-checked"),
    "true",
    "generated avatars must support arrow-key selection",
  );
  assert.equal(
    await nextGeneratedOption.evaluate((element) => element === document.activeElement),
    true,
    "arrow-key avatar selection must move focus",
  );
  const generatedHeight = await picker.evaluate((element) => element.getBoundingClientRect().height);
  await initialsTab.click();
  await picker.getByRole("tabpanel", { name: "名字字母" }).waitFor();
  assert.equal(await picker.getByRole("button", { name: "换一组" }).count(), 0);
  const initialsHeight = await picker.evaluate((element) => element.getBoundingClientRect().height);
  await uploadTab.click();
  await picker.getByRole("tabpanel", { name: "上传图片" }).waitFor();
  const uploadHeight = await picker.evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(
    Math.max(generatedHeight, initialsHeight, uploadHeight) - Math.min(generatedHeight, initialsHeight, uploadHeight) <
      0.5,
    "switching avatar tabs must not resize the dialog",
  );
  await page.keyboard.press("Escape");
  await page.locator(".modal-overlay").waitFor({ state: "detached" });

  const kernelList = surface.locator(".employee-dialog-kernel-list");
  await kernelList.waitFor({ state: "visible" });
  const kernelListLayout = await kernelList.evaluate((element) => {
    const listBounds = element.getBoundingClientRect();
    const optionBounds = [...element.querySelectorAll("button")].map((option) => option.getBoundingClientRect());
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      optionCount: optionBounds.length,
      allOptionsContained: optionBounds.every(
        (bounds) =>
          bounds.top >= listBounds.top - 1 &&
          bounds.right <= listBounds.right + 1 &&
          bounds.bottom <= listBounds.bottom + 1 &&
          bounds.left >= listBounds.left - 1,
      ),
    };
  });
  assert.ok(
    kernelListLayout.scrollHeight <= kernelListLayout.clientHeight + 1,
    "the Kernel selector must expand without an internal scroll range",
  );
  assert.ok(
    kernelListLayout.optionCount > 0 && kernelListLayout.allOptionsContained,
    "the expanded Kernel selector must contain every option within its visible bounds",
  );
  assert.ok(
    await kernelList.locator('[data-brand="claude-code"] path[fill="#D97757"]').count(),
    "Claude Agent must retain its brand color in the kernel selector",
  );
  assert.ok(
    await kernelList.locator('[data-brand="codex"] stop[stop-color="#B1A7FF"]').count(),
    "Codex must retain its brand gradient in the kernel selector",
  );
  assert.ok(
    await kernelList.locator('[data-brand="openclaw"] stop[stop-color="#FF4D4D"]').count(),
    "OpenClaw must retain its brand gradient in the kernel selector",
  );
  await assertCurrentColor(kernelList.locator('[data-brand="hermes"] svg'), "--c-violet", "Hermes");
  await assertCurrentColor(kernelList.locator('[data-brand="pi"] svg'), "--c-link", "Pi");
  await assertCurrentColor(kernelList.locator('[data-brand="opencode"] svg'), "--c-text", "OpenCode");
  await kernelList.getByRole("button", { name: "Claude Agent" }).click();
  await page.waitForFunction(() => window.__savedEmployeeKernel === "claude-code");
  assert.equal(
    await page.evaluate(() => window.__savedEmployeeCount),
    1,
    "a runtime change must persist once without duplicate hidden editors",
  );
  assert.equal(
    await surface.getByText(/已保存|正在保存/).count(),
    0,
    "successful employee autosave must remain silent and must not shift the page layout",
  );
  await page.evaluate(() => {
    window.__failNextEmployeeSave = true;
  });
  await kernelList.getByRole("button", { name: "Codex" }).click();
  const saveError = page.getByRole("alert");
  await saveError.waitFor({ state: "visible" });
  assert.match(await saveError.textContent(), /保存失败/);
  assert.equal(
    await surface.getByRole("alert").count(),
    0,
    "autosave feedback must not insert a status row into the employee layout",
  );
  assert.equal(
    await page.evaluate(() => window.__savedEmployeeKernel),
    "claude-code",
    "a failed immediate save must not pretend that the new value reached persistence",
  );
  await saveError.getByRole("button", { name: "重试" }).click();
  await page.waitForFunction(() => window.__savedEmployeeKernel === "codex");
  assert.equal(
    await page.evaluate(() => window.__employeeSaveAttempts),
    3,
    "a failed immediate save must expose one explicit retry path",
  );
  const contextBudget = surface.getByRole("spinbutton", { name: "上下文窗口（tokens）" });
  await contextBudget.fill("-1");
  assert.equal(await contextBudget.getAttribute("aria-invalid"), "true");
  await kernelList.getByRole("button", { name: "Claude Agent" }).click();
  await page.waitForFunction(() => window.__savedEmployeeKernel === "claude-code");
  assert.equal(
    await page.evaluate(() => window.__employeeSaveAttempts),
    4,
    "an invalid unrelated text field must not block an immediate Kernel patch",
  );
  assert.ok(
    await page.locator('#outside-codex-avatar [data-brand="codex"] stop[stop-color="#B1A7FF"]').count(),
    "the external default Codex avatar must use the same brand gradient",
  );
}

async function assertCurrentColor(locator, token, label) {
  const colors = await locator.evaluate((element, tokenName) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${tokenName})`;
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(element).color, expected };
  }, token);
  assert.equal(colors.actual, colors.expected, `${label} must retain its assigned kernel color`);
}

async function testUnavailableKernelCopy(page) {
  await renderFixture(page, "employee-unavailable-kernel");
  const surface = page.locator("#identity-root .contacts-employee-settings-surface");

  const warning = surface.locator(".employee-dialog-warning");
  await warning.waitFor({ state: "visible" });
  assert.equal(await warning.textContent(), "OpenClaw 运行环境未配置");
}

async function testEmployeeDialogFlow(page) {
  await renderFixture(page, "employee-dialog");
  assert.equal(await page.locator(".modal-overlay").count(), 1);
  const dialog = page.getByRole("dialog", { name: "员工资料与运行设置" });
  const outerSource = await waitForAvatarImage(dialog.locator(".contacts-employee-avatar .rooms-avatar"));
  const nameInput = dialog.getByRole("textbox", { name: "员工名称" });
  assert.equal(await nameInput.inputValue(), "分析师");
  await nameInput.fill("不应保存");
  await nameInput.press("Escape");
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__savedEmployeeName), "", "Escape must cancel the employee name edit");
  assert.equal(await nameInput.inputValue(), "分析师");
  assert.notEqual(
    await page.evaluate(() => window.__employeeDialogOpenChange),
    false,
    "Escape in the name field must not request closing the employee dialog",
  );
  assert.equal(await dialog.getByRole("button", { name: "基本资料" }).count(), 0);

  await dialog.getByRole("button", { name: "头像" }).click();
  assert.equal(
    await page.locator(".modal-overlay").count(),
    1,
    "avatar editing inside a dialog must not stack another dialog",
  );
  const subpage = dialog.locator(".employee-avatar-picker-subpage");
  await subpage.waitFor({ state: "visible" });
  assert.equal(
    await subpage.getByRole("button", { name: "返回" }).evaluate((element) => element === document.activeElement),
    true,
    "the avatar subpage must receive focus when it opens",
  );
  assert.equal(
    await dialog.locator('input[aria-label="员工名称"]').evaluate((element) => element.closest("[inert]") !== null),
    true,
    "covered employee controls must be inert while the avatar subpage is open",
  );
  const previewSource = await waitForAvatarImage(subpage.locator(".employee-avatar-picker-preview .rooms-avatar"));
  assert.equal(previewSource, outerSource);
  await page.keyboard.press("Escape");
  await subpage.waitFor({ state: "detached" });
  assert.notEqual(
    await page.evaluate(() => window.__employeeDialogOpenChange),
    false,
    "Escape in the avatar subpage must return without closing the parent employee dialog",
  );
  await dialog.getByRole("button", { name: "头像" }).click();
  await subpage.waitFor({ state: "visible" });
  await subpage.getByRole("button", { name: "返回" }).click();
  await subpage.waitFor({ state: "detached" });

  await nameInput.fill("高级分析师");
  await nameInput.press("Enter");
  await page.waitForFunction(() => window.__savedEmployeeName === "高级分析师");
}

async function testAppPageFlow(page) {
  await renderFixture(page, "app-page");
  await page.getByRole("button", { name: "更换 App 图标" }).click();
  assert.equal(await page.locator(".modal-overlay").count(), 1);
  assert.equal(await page.locator(".app-icon-picker-subpage").count(), 0);
  assert.equal(await page.getByRole("dialog", { name: "App 图标" }).count(), 1);
  await page.keyboard.press("Escape");
  await page.locator(".modal-overlay").waitFor({ state: "detached" });
}

async function testAppDialogFlow(page) {
  await renderFixture(page, "app-dialog");
  assert.equal(await page.locator(".modal-overlay").count(), 1);
  const dialog = page.getByRole("dialog", { name: "App 设置测试" });
  await dialog.getByRole("button", { name: "更换 App 图标" }).click();
  assert.equal(
    await page.locator(".modal-overlay").count(),
    1,
    "App icon editing inside a dialog must stay in the same dialog",
  );
  const subpage = dialog.locator(".app-icon-picker-subpage");
  await subpage.waitFor({ state: "visible" });
  assert.equal(await subpage.getByRole("heading", { name: "App 图标" }).count(), 1);
  assert.equal(
    await subpage.getByRole("button", { name: "返回" }).evaluate((element) => element === document.activeElement),
    true,
    "the App icon subpage must receive focus when it opens",
  );
  await page.keyboard.press("Escape");
  await subpage.waitFor({ state: "detached" });
  assert.notEqual(
    await page.evaluate(() => window.__appDialogOpenChange),
    false,
    "Escape in the App icon subpage must not close the parent App dialog",
  );
}

function entrySource() {
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { EmployeeSettingsDialog, EmployeeSettingsSurface } from ${JSON.stringify(resolve(projectRoot, "web/src/components/rooms/employee-settings-surface.tsx"))};
    import { EmployeeDialog } from ${JSON.stringify(resolve(projectRoot, "web/src/components/rooms/employee-dialog.tsx"))};
    import { RoomMemberAvatar } from ${JSON.stringify(resolve(projectRoot, "web/src/components/rooms/member-avatar.tsx"))};
    import { defaultMemberIdForKernel } from ${JSON.stringify(resolve(projectRoot, "web/src/components/rooms/rooms-model.ts"))};
    import { AppIconPickerField, DEFAULT_APP_SYSTEM_ICON } from ${JSON.stringify(resolve(projectRoot, "web/src/components/apps/app-icon-picker.tsx"))};
    import { Dialog, DialogContent, DialogTitle } from ${JSON.stringify(resolve(projectRoot, "web/src/components/ui/dialog.tsx"))};
    import { ToastProvider } from ${JSON.stringify(resolve(projectRoot, "web/src/components/ui/toast.tsx"))};
    import { ConfirmProvider } from ${JSON.stringify(resolve(projectRoot, "web/src/components/ui/confirm-dialog.tsx"))};
    import { setLanguagePreference } from ${JSON.stringify(resolve(projectRoot, "web/src/i18n.ts"))};
    import ${JSON.stringify(resolve(projectRoot, "web/src/styles/tokens.css"))};

    setLanguagePreference("zh-CN");
    window.__setIdentityFixtureLanguage = setLanguagePreference;
    const rootElement = document.getElementById("identity-root");
    const root = createRoot(rootElement);
    const kernelOptions = [
      ["claude-code", "Claude Agent"],
      ["codex", "Codex"],
      ["hermes", "Hermes"],
      ["pi", "Pi"],
      ["openclaw", "OpenClaw"],
      ["opencode", "OpenCode"],
    ].map(([id, label]) => ({
      id,
      label,
      available: true,
      installed: true,
      models: [{ id: "native", label: "Native" }],
    }));
    const unavailableOpenClaw = {
      ...kernelOptions.find((kernel) => kernel.id === "openclaw"),
      available: false,
      installed: false,
      reason: "OpenClaw Gateway is not configured.",
      unavailableCode: "kernel_runtime_unavailable",
      executableProbe: {
        role: "optional-diagnostic",
        status: "failed",
        path: "/custom/openclaw",
        requestedCommand: "/custom/openclaw",
        source: "environment",
        sourceName: "OPENGROVE_OPENCLAW_BIN",
        exitCode: 2,
      },
    };
    const initialMember = {
      id: "app-analyst-binding",
      employeeDefinitionId: "analyst",
      appId: "story-data",
      name: "分析师",
      kernel: "codex",
      model: "native",
      role: "分析",
      status: "idle",
      color: "#f3e8a5",
      lastActive: "",
      source: "local",
      avatarMode: "generated",
      userOverrides: ["name", "model", "availableSkillIds", "role"],
      manifestDefaults: {
        name: "App 默认分析师",
        kernel: "codex",
        model: "native",
        role: "App 默认分析职责",
        availableSkillIds: [],
      },
    };

    const reasoningEfforts = ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id }));
    const reasoningKernelIds = new Set(["claude-code", "codex", "pi"]);
    const runtimeControlsByKernel = Object.fromEntries(kernelOptions.map((kernel) => {
      const supportsReasoning = reasoningKernelIds.has(kernel.id);
      return [kernel.id, {
        kernel: kernel.id,
        source: "test-runtime",
        models: kernel.id === "claude-code"
          ? [{ id: "native", label: "Native" }, { id: "claude-custom", label: "Claude Custom" }]
          : [{ id: "native", label: "Native" }],
        defaultModel: "native",
        reasoningEfforts: supportsReasoning ? reasoningEfforts : [],
        defaultReasoningEffort: supportsReasoning ? "medium" : undefined,
        speedTiers: [],
      }];
    }));

    function EmployeeFixture({ dialog, unavailableKernel = false, reasoningState = "supported" }) {
      const usesReasoningFixture = reasoningState !== "default";
      const unavailableMember = { ...initialMember, kernel: "openclaw" };
      const appReasoningDefault = reasoningState === "app-default"
        || reasoningState === "user-override"
        ? "low"
        : reasoningState === "app-default-incompatible"
          ? "max"
          : undefined;
      const userReasoningOverride = reasoningState === "user-override";
      const reasoningMember = {
        ...initialMember,
        kernel: "claude-code",
        model: "claude-custom",
        providerId: "claude-provider",
        reasoningEffort: userReasoningOverride ? "high" : appReasoningDefault,
        manifestDefaults: {
          ...initialMember.manifestDefaults,
          reasoningEffort: appReasoningDefault,
        },
        userOverrides: userReasoningOverride
          ? [...initialMember.userOverrides, "reasoningEffort"]
          : initialMember.userOverrides,
      };
      const [member, setMember] = React.useState(
        unavailableKernel ? unavailableMember : usesReasoningFixture ? reasoningMember : initialMember,
      );
      const codexMember = {
        ...initialMember,
        id: defaultMemberIdForKernel("codex"),
        employeeDefinitionId: undefined,
        appId: undefined,
        name: "Codex",
        color: "#2563eb",
      };
      const save = async (nextMember) => {
        window.__employeeSaveAttempts += 1;
        if (window.__failNextEmployeeSave) {
          window.__failNextEmployeeSave = false;
          throw new Error("模拟持久化失败");
        }
        if (window.__blockEmployeeSaves) {
          await new Promise((resolve) => { window.__releaseEmployeeSave = resolve; });
        }
        window.__savedEmployeeName = nextMember.name;
        window.__savedEmployeeKernel = nextMember.kernel;
        window.__savedEmployeeModel = nextMember.model;
        window.__savedEmployeeProviderId = nextMember.providerId;
        window.__savedEmployeeReasoningEffort = nextMember.reasoningEffort;
        window.__savedEmployeeContextTokenBudget = nextMember.contextTokenBudget;
        window.__savedEmployeeCount += 1;
        setMember(nextMember);
      };
      const shared = {
        member,
        rooms: [],
        activeKernel: usesReasoningFixture ? "claude-code" : "codex",
        activeModel: "native",
        kernelOptions: unavailableKernel
          ? kernelOptions.map((kernel) => kernel.id === "openclaw" ? unavailableOpenClaw : kernel)
          : kernelOptions,
        runtimeControlsByKernel: reasoningState === "loading"
          ? undefined
          : reasoningState === "unsupported"
            ? {
                ...runtimeControlsByKernel,
                "claude-code": {
                  ...runtimeControlsByKernel["claude-code"],
                  reasoningEfforts: [],
                  defaultReasoningEffort: undefined,
                },
              }
            : reasoningState === "server-default"
              ? {
                  ...runtimeControlsByKernel,
                  "claude-code": {
                    ...runtimeControlsByKernel["claude-code"],
                    defaultReasoningEffort: "high",
                  },
                }
            : reasoningState === "app-default-incompatible"
              ? {
                  ...runtimeControlsByKernel,
                  pi: {
                    ...runtimeControlsByKernel.pi,
                    reasoningEfforts: reasoningEfforts.filter((option) => option.id === "low" || option.id === "medium"),
                    defaultReasoningEffort: "medium",
                  },
                }
            : runtimeControlsByKernel,
        onSave: save,
        onRestoreAppDefaults: async () => {
          window.__employeeRestoreAttempts += 1;
          if (window.__failNextEmployeeRestore) {
            window.__failNextEmployeeRestore = false;
            throw new Error("模拟恢复失败");
          }
          setMember((current) => ({
            ...current,
            name: current.manifestDefaults?.name ?? current.name,
            kernel: current.manifestDefaults?.kernel ?? current.kernel,
            model: current.manifestDefaults?.model ?? current.model,
            role: current.manifestDefaults?.role ?? current.role,
            availableSkillIds: current.manifestDefaults?.availableSkillIds,
            userOverrides: [],
          }));
        },
      };
      return (
        <>
          <div id="outside-codex-avatar">
            <RoomMemberAvatar member={codexMember} showStatus={false} />
          </div>
          {dialog
            ? <EmployeeSettingsDialog
                {...shared}
                open
                onOpenChange={(nextOpen) => { window.__employeeDialogOpenChange = nextOpen; }}
              />
            : <EmployeeSettingsSurface {...shared} />}
        </>
      );
    }

    function EmployeeAutosaveEchoFixture() {
      const [member, setMember] = React.useState({
        ...initialMember,
        name: "原始名称",
        role: "原始职责",
      });
      return (
        <EmployeeDialog
          embedded
          open
          activeKernel="codex"
          activeModel="native"
          runtimeControlsByKernel={runtimeControlsByKernel}
          kernelOptions={kernelOptions}
          providers={[]}
          modelProviderBindings={[]}
          initialMember={member}
          showPreview={false}
          showSubmitActions={false}
          onDraftPatch={(patch) => {
            window.__employeeExternalRoleApplied = true;
            setMember((current) => ({
              ...current,
              ...patch,
              role: "外部同步的职责",
            }));
          }}
          onOpenChange={() => undefined}
          onCreate={() => undefined}
        />
      );
    }

    function AppFixture({ dialog }) {
      const [icon, setIcon] = React.useState(DEFAULT_APP_SYSTEM_ICON);
      const field = (
        <AppIconPickerField
          value={icon}
          title="故事数据后台"
          onChange={setIcon}
        />
      );
      return dialog ? (
        <Dialog open onOpenChange={(nextOpen) => { window.__appDialogOpenChange = nextOpen; }}>
          <DialogContent aria-label="App 设置测试">
            <DialogTitle>App 设置测试</DialogTitle>
            {field}
          </DialogContent>
        </Dialog>
      ) : field;
    }

    function FixtureCommit({ revision }) {
      React.useLayoutEffect(() => {
        rootElement.dataset.fixtureRevision = String(revision);
      }, [revision]);
      return null;
    }

    window.__renderIdentityFixture = (mode) => {
      window.__identityFixtureRevision = (window.__identityFixtureRevision ?? 0) + 1;
      const revision = window.__identityFixtureRevision;
      const fixtureKey = mode + "-" + revision;
      window.__savedEmployeeName = "";
      window.__savedEmployeeKernel = "";
      window.__savedEmployeeModel = "";
      window.__savedEmployeeProviderId = undefined;
      window.__savedEmployeeReasoningEffort = undefined;
      window.__savedEmployeeContextTokenBudget = undefined;
      window.__savedEmployeeCount = 0;
      window.__employeeSaveAttempts = 0;
      window.__employeeRestoreAttempts = 0;
      window.__blockEmployeeSaves = false;
      window.__releaseEmployeeSave = undefined;
      window.__failNextEmployeeSave = false;
      window.__failNextEmployeeRestore = false;
      window.__employeeDialogOpenChange = undefined;
      window.__appDialogOpenChange = undefined;
      window.__employeeExternalRoleApplied = false;
      rootElement.dataset.fixture = mode;
      const renderWithToasts = (fixture) => root.render(
        <ToastProvider key={fixtureKey}>
          <ConfirmProvider>
            <FixtureCommit revision={revision} />
            {fixture}
          </ConfirmProvider>
        </ToastProvider>,
      );
      if (mode === "employee-page") renderWithToasts(<EmployeeFixture dialog={false} reasoningState="default" />);
      if (mode === "employee-reasoning-kernel-switch") renderWithToasts(<EmployeeFixture dialog={false} />);
      if (mode === "employee-reasoning-loading") renderWithToasts(<EmployeeFixture dialog={false} reasoningState="loading" />);
      if (mode === "employee-reasoning-unsupported") renderWithToasts(<EmployeeFixture dialog={false} reasoningState="unsupported" />);
      if (mode === "employee-reasoning-server-default") renderWithToasts(<EmployeeFixture dialog={false} reasoningState="server-default" />);
      if (mode === "employee-reasoning-app-default") renderWithToasts(<EmployeeFixture dialog={false} reasoningState="app-default" />);
      if (mode === "employee-reasoning-user-override") renderWithToasts(<EmployeeFixture dialog={false} reasoningState="user-override" />);
      if (mode === "employee-reasoning-app-default-incompatible") renderWithToasts(<EmployeeFixture dialog={false} reasoningState="app-default-incompatible" />);
      if (mode === "employee-autosave-external-merge") renderWithToasts(<EmployeeAutosaveEchoFixture />);
      if (mode === "employee-unavailable-kernel") renderWithToasts(<EmployeeFixture dialog={false} unavailableKernel reasoningState="default" />);
      if (mode === "employee-dialog") renderWithToasts(<EmployeeFixture dialog reasoningState="default" />);
      if (mode === "app-page") renderWithToasts(<AppFixture dialog={false} />);
      if (mode === "app-dialog") renderWithToasts(<AppFixture dialog />);
      return revision;
    };
  `;
}

function fixtureHtml() {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <link rel="stylesheet" href="./entry.css">
        <style>
          html, body, #identity-root { min-height: 100%; }
          body { margin: 0; font-family: var(--font-sans); font-size: var(--fs-base); letter-spacing: var(--letter-spacing); }
          #identity-root { height: 820px; }
        </style>
      </head>
      <body>
        <div id="identity-root"></div>
        <script src="./entry.js"></script>
      </body>
    </html>`;
}
