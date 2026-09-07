import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium, expect } from "@playwright/test";

// Run against an ordinary locally running product, using an isolated browser profile.
const url = process.argv[2];
if (!url) throw new Error("Usage: node scripts/test-web-app-rail-navigation-ui.mjs <product-url> [capture-directory]");
const captureDir = process.argv[3] ? resolve(process.argv[3]) : null;
if (captureDir) await mkdir(captureDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 760 }, locale: "zh-CN" });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(url);
  const handle = page.getByRole("separator", { name: "调整主导航宽度", exact: true });
  const panel = page.locator(".app-navigation-slot");
  const rail = page.locator(".app-rail");
  const toggle = page.locator("#app-navigation-toggle");
  const width = () => handle.getAttribute("aria-valuenow").then(Number);
  const floating = (value) => expect(panel).toHaveAttribute("data-floating", String(value));
  const expectWidth = (value) => expect.poll(width).toBe(value);
  async function dragTo(target) {
    const current = await width();
    const box = await handle.boundingBox();
    assert.ok(box);
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + 100);
    await page.mouse.down();
    await expect(handle).toHaveAttribute("data-resizing", "true");
    await expect(page.locator("body")).toHaveCSS("cursor", "col-resize");
    await page.mouse.move(x + target - current, box.y + 100, { steps: 10 });
    await page.mouse.up();
  }
  async function reveal() {
    await page.mouse.move(400, 150);
    await page.mouse.move(2, 150);
    await floating(true);
    await page.mouse.move(20, 150);
  }

  await expectWidth(126);
  const handleBounds = await handle.boundingBox();
  const contentBounds = await page.locator(".rooms-list-panel").boundingBox();
  assert.ok(
    Math.abs(handleBounds.x + handleBounds.width / 2 - contentBounds.x) < 1,
    "The resize affordance must align with the visible content panel edge",
  );
  await assertCursorOnly(handle);
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + 180);
  await assertCursorOnly(handle);
  if (captureDir) await page.screenshot({ path: join(captureDir, "navigation-resize-hover.png") });
  const roomHandle = page.getByRole("separator", { name: "调整侧边栏宽度", exact: true });
  const roomHandleBounds = await roomHandle.boundingBox();
  await page.mouse.move(roomHandleBounds.x + roomHandleBounds.width / 2, roomHandleBounds.y + 180);
  await assertCursorOnly(roomHandle);
  await page.mouse.move(600, 200);
  await dragTo(237);
  await expectWidth(237);
  await page.waitForTimeout(220);
  if (captureDir) await page.screenshot({ path: join(captureDir, "navigation-full.png") });
  await toggle.click();
  await expectWidth(0);
  await expect(page.locator("#app-main-navigation")).toHaveAttribute("inert", "");
  await page.waitForTimeout(350);
  const hiddenWorkspaceX = (await page.locator(".workspace").boundingBox()).x;
  await reveal();
  assert.equal(
    (await page.locator(".workspace").boundingBox()).x,
    hiddenWorkspaceX,
    "Hover reveal must not shift the workspace",
  );
  await expect(page.locator("#app-main-navigation")).toHaveCSS("border-radius", "0px");
  await expect(page.locator("#app-main-navigation")).toHaveCSS("border-right-width", "0px");
  await expect(page.locator("#app-main-navigation")).toHaveCSS("outline-style", "none");
  await expect(page.locator("#app-main-navigation")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  if (captureDir) await page.screenshot({ path: join(captureDir, "navigation-hover.png") });
  await page.locator(".app-user-button").click();
  await expect(page.locator(".app-account-menu")).toBeVisible();
  await page.mouse.move(600, 180);
  await page.waitForTimeout(450);
  await floating(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-account-menu")).toBeHidden();
  await floating(false);
  await toggle.click();
  await expectWidth(237);
  await page.reload();
  await expectWidth(237);

  await dragTo(90);
  await expectWidth(58);
  await expect(rail).toHaveAttribute("data-expanded", "false");
  await page.waitForTimeout(350);
  const titles = await rail.locator(".app-rail-section-title").evaluateAll((nodes) =>
    nodes.map((node) => ({
      text: node.textContent,
      width: node.clientWidth,
      textWidth: node.scrollWidth,
      visibility: getComputedStyle(node).visibility,
    })),
  );
  assert.equal(titles.length, 4);
  for (const title of titles) {
    assert.equal(title.visibility, "visible");
    assert.ok(title.textWidth <= title.width, `${title.text} must fit in icon mode`);
  }
  if (captureDir) await page.screenshot({ path: join(captureDir, "navigation-icons.png") });
  await toggle.click();
  await expectWidth(0);
  await page.reload();
  await expectWidth(0);
  await toggle.click();
  await expectWidth(58);
  await dragTo(90);
  await expectWidth(126);
  await dragTo(10);
  await expectWidth(0);
  await dragTo(180);
  await expectWidth(180);

  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 45, box.y + 120, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expectWidth(180);
  assert.equal(await page.locator("body").getAttribute("data-rail-resizing"), null);
  await handle.press("Home");
  await expectWidth(0);
  await handle.press("ArrowRight");
  await expectWidth(58);
  await handle.press("ArrowRight");
  await expectWidth(126);
  await handle.press("End");
  await expectWidth(280);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeHidden();
  await expect(page.locator(".mobile-nav")).toBeVisible();

  const migratedPage = await browser.newPage({
    viewport: { width: 1024, height: 760 },
    locale: "zh-CN",
  });
  migratedPage.on("pageerror", (error) => pageErrors.push(error.message));
  // An existing user's pre-refactor preference must migrate to the same icon mode.
  await migratedPage.addInitScript(() => {
    window.localStorage.setItem("opengroveRailExpanded", "false");
  });
  await migratedPage.goto(url);
  const migratedHandle = migratedPage.getByRole("separator", { name: "调整主导航宽度", exact: true });
  await expect(migratedHandle).toHaveAttribute("aria-valuenow", "58");
  assert.equal(await migratedPage.evaluate(() => window.localStorage.getItem("opengroveRailExpanded")), null);
  const migratedTitles = await migratedPage
    .locator(".app-rail-section-title")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({ text: node.textContent, fits: node.scrollWidth <= node.clientWidth })),
    );
  assert.deepEqual(
    migratedTitles.map((title) => title.text),
    ["原生 app", "我的App", "资源", "配置"],
  );
  assert.ok(
    migratedTitles.every((title) => title.fits),
    "Migrated icon-mode section headings must fit",
  );
  const migratedBox = await migratedHandle.boundingBox();
  await migratedPage.mouse.move(migratedBox.x + migratedBox.width / 2, migratedBox.y + 200);
  await assertCursorOnly(migratedHandle);
  if (captureDir) await migratedPage.screenshot({ path: join(captureDir, "navigation-migrated-icons.png") });
  assert.deepEqual(pageErrors, []);
  console.log(
    "web-app-rail-navigation-ui passed: boundary alignment, shared cursor-only handles, unframed overlay, resize, snap, restore, reload, hover, menus, headings, Escape, keyboard, mobile",
  );
} finally {
  await browser.close();
}

async function assertCursorOnly(handle) {
  await expect(handle).toHaveClass(/resize-handle/);
  await expect(handle).toHaveCSS("cursor", "col-resize");
  await expect(handle).toHaveCSS("background-image", "none");
  await expect(handle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(handle).toHaveCSS("border-width", "0px");
  const decorations = await handle.evaluate((node) =>
    ["::before", "::after"].map((pseudo) => getComputedStyle(node, pseudo).content),
  );
  assert.deepEqual(decorations, ["none", "none"], "Resize hit areas must not paint a line or gradient");
}
