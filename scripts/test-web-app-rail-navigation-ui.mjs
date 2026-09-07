import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startOpenGroveServer } from "../dist/server/create-server.js";

// Use the built product with an empty, isolated Bridge; no existing rooms or Apps.
// `npm run test:ui` builds both server and web before Playwright runs this harness.
const testRoot = await mkdtemp(join(tmpdir(), "opengrove-rail-navigation-"));
const captureDir = process.argv[2] ? resolve(process.argv[2]) : null;
const envOverrides = {
  OPENGROVE_BRIDGE_SETTINGS_PATH: join(testRoot, "bridge-settings.json"),
  OPENGROVE_ENABLE_BROWSER_UI: "1",
  OPENGROVE_MCP_APP_SANDBOX_ORIGIN: undefined,
  OPENGROVE_USER_DATA_DIR: testRoot,
  OPENGROVE_WEB_AUTH_MODE: "bridge-token",
  OPENGROVE_WORKSPACES_DIR: join(testRoot, "workspaces"),
};
const previousEnv = Object.fromEntries(Object.keys(envOverrides).map((key) => [key, process.env[key]]));
let browser;
let server;
try {
  if (captureDir) await mkdir(captureDir, { recursive: true });
  await writeFile(envOverrides.OPENGROVE_BRIDGE_SETTINGS_PATH, JSON.stringify({ mountedApps: [] }));
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    bridgeToken: "",
    profile: "test",
    runtimeEnvironment: "test",
    statePath: join(testRoot, "state.json"),
  });
  if (!server.listening)
    await new Promise((resolveListen, reject) => {
      server.once("listening", resolveListen);
      server.once("error", reject);
    });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/ui/?view=app-store`;
  browser = await chromium.launch({ headless: true });
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
  await expect(page.locator(".app-store-page")).toBeVisible();
  await expect(page.locator(".rooms-list-panel")).toHaveCount(0);
  const handleBounds = await handle.boundingBox();
  const contentBounds = await page.locator(".app-store-page").boundingBox();
  assert.ok(
    Math.abs(handleBounds.x + handleBounds.width / 2 - contentBounds.x) < 1,
    "The resize affordance must align with the visible content panel edge",
  );
  await assertCursorOnly(handle);
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + 180);
  await assertCursorOnly(handle);
  if (captureDir) await page.screenshot({ path: join(captureDir, "navigation-resize-hover.png") });
  // Reach the separator through actual Tab navigation, then inspect its painted focus indicator.
  await page.keyboard.press("Tab");
  for (let i = 0; i < 30 && !(await handle.evaluate((node) => node === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(handle).toBeFocused();
  const focusLine = await handle.evaluate((node) => {
    const style = getComputedStyle(node, "::after");
    return { content: style.content, width: style.width, background: style.backgroundColor };
  });
  assert.equal(focusLine.content, '\"\"', "Keyboard focus must paint a visible separator indicator");
  assert.equal(focusLine.width, "2px");
  assert.notEqual(focusLine.background, "rgba(0, 0, 0, 0)");
  if (captureDir) await page.screenshot({ path: join(captureDir, "navigation-keyboard-focus.png") });
  await page.keyboard.press("Tab");
  await assertCursorOnly(handle);
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
  assert.equal(await handle.getAttribute("data-resizing"), null);
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
  // Add an App through the real API only after the empty-instance navigation checks.
  const settingsResponse = await page.request.patch(new URL("/api/settings", url).href, {
    data: { developerMode: true },
  });
  assert.ok(settingsResponse.ok(), await settingsResponse.text());
  const createResponse = await page.request.post(new URL("/api/apps/create", url).href, {
    data: { title: "导航菜单回归" },
  });
  assert.ok(createResponse.ok(), await createResponse.text());
  const createdApp = await createResponse.json();
  assert.equal(createdApp.ok, true);
  await page.setViewportSize({ width: 1024, height: 760 });
  await page.reload();
  await handle.press("Home");
  await handle.press("ArrowRight");
  await expectWidth(58);
  const appEntry = page.locator('.app-rail-user-tab[title="导航菜单回归"]');
  const appOverflow = page.locator(".app-rail-user-tab-menu-button");
  await appEntry.hover();
  await expect(appOverflow).toBeHidden();
  await appEntry.focus();
  await expect(appOverflow).toBeHidden();
  await appEntry.click({ button: "right" });
  const appMenu = page.getByRole("menu", { name: "导航菜单回归 操作" });
  await expect(appMenu).toBeVisible();
  await expect(appMenu.getByRole("menuitem")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(appMenu).toBeHidden();
  await appEntry.press("Shift+F10");
  await expect(appMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(appMenu).toBeHidden();
  if (captureDir) await page.screenshot({ path: join(captureDir, "navigation-compact-app-hover.png") });
  await handle.press("ArrowRight");
  await expectWidth(126);
  await appEntry.hover();
  await expect(appOverflow).toBeVisible();
  await appOverflow.click();
  const overflowMenu = page.getByRole("menu", { name: "导航菜单回归 更多操作" });
  await expect(overflowMenu).toBeVisible();
  await expect(overflowMenu.getByRole("menuitem")).toHaveCount(3);
  if (captureDir) await page.screenshot({ path: join(captureDir, "navigation-expanded-menu.png") });
  await page.keyboard.press("Escape");
  const roomSnapshot = await page.request.get(new URL("/api/rooms", url).href).then((response) => response.json());
  const appRoom = roomSnapshot.rooms.find(
    (room) => room.scope?.appId === createdApp.appId && room.scope.role === "default",
  );
  assert.ok(appRoom, "Creating an App must create its own default room");
  const senderId = appRoom.memberIds.find((id) => id.endsWith("-pm"));
  assert.ok(senderId, "The fixture App must have a coordinator");
  const readUrl = new URL(`/api/rooms/${appRoom.id}/read`, url).href;
  const markRead = async () => {
    const snapshot = await page.request.get(new URL("/api/rooms", url).href).then((response) => response.json());
    const response = await page.request.post(readUrl, { data: { observedEventSeq: snapshot.currentEventSeq } });
    assert.ok(response.ok(), await response.text());
    await page.reload();
  };
  const measureClearance = () =>
    appEntry.evaluate((entry) => {
      const label = entry.querySelector('[class*="buttonLabel"]');
      const anchor = entry.querySelector('[class*="iconUnreadAnchor"]');
      const badge = anchor.querySelector("[data-variant]");
      const rail = entry.closest(".app-rail");
      const labelX = label.getBoundingClientRect().left;
      return {
        gap: Number.parseFloat(getComputedStyle(rail).getPropertyValue("--app-rail-label-gap")),
        clear: badge
          ? labelX - badge.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(badge).outlineWidth)
          : null,
        badgeCenter: badge
          ? (badge.getBoundingClientRect().left + badge.getBoundingClientRect().right) / 2 -
            anchor.getBoundingClientRect().left
          : null,
        aligned: Array.from(rail.querySelectorAll('[class*="buttonLabel"]')).every(
          (node) => Math.abs(node.getBoundingClientRect().left - labelX) < 0.1,
        ),
      };
    });
  await markRead();
  await expect(appEntry).toHaveAttribute("aria-label", "导航菜单回归");
  await expect.poll(async () => (await measureClearance()).gap).toBe(0);
  let sent = 0;
  for (const count of [1, 12, 100]) {
    while (sent < count) {
      const response = await page.request.post(new URL(`/api/rooms/${appRoom.id}/agent-messages`, url).href, {
        data: { senderId, text: `导航角标消息 ${++sent}` },
      });
      assert.ok(response.ok(), await response.text());
    }
    await page.reload();
    await expect(appEntry).toHaveAttribute("aria-label", `导航菜单回归，${count} 条未读`);
    await expect.poll(async () => (await measureClearance()).clear).toBeCloseTo(0.25, 1);
    const geometry = await measureClearance();
    assert.ok(
      Math.abs(geometry.clear - 0.25) < 0.05,
      "Badge outlines should clear aligned labels without excess whitespace",
    );
    assert.ok(
      Math.abs(geometry.badgeCenter - 25) < 0.05,
      "The badge center must stay attached to the same icon corner",
    );
    assert.ok(geometry.aligned, "All expanded labels must remain aligned");
    if (count === 1)
      assert.ok(Math.abs(geometry.gap - 2.75) < 0.05, "Single-digit reminders must not reserve the 99+ gap");
    if (captureDir) await page.screenshot({ path: join(captureDir, `navigation-spacing-${count}.png`) });
  }
  await markRead();
  await expect.poll(async () => (await measureClearance()).gap).toBe(0);
  // Installed Apps may have a translated display name but no explicit icon.
  const manifestPath = join(createdApp.appRoot, "opengrove.app.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.title = "故事花园";
  manifest.locales = { en: { title: "Story Garden" } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const appIcon = page.locator(".app-rail-user-tab-icon svg");
  let originalIcon;
  for (const languagePreference of ["zh-CN", "en"]) {
    const response = await page.request.patch(new URL("/api/settings", url).href, {
      data: { languagePreference },
    });
    assert.ok(response.ok(), await response.text());
    await page.reload();
    await expect(page.locator(".app-rail-user-tab")).toHaveAttribute(
      "title",
      languagePreference === "en" ? "Story Garden" : "故事花园",
    );
    const icon = await appIcon.innerHTML();
    if (originalIcon === undefined) originalIcon = icon;
    else assert.equal(icon, originalIcon, "Translating an App title must not change its icon");
  }
  assert.deepEqual(pageErrors, []);
  console.log(
    "web-app-rail-navigation-ui passed: boundary alignment, cursor-only hover and visible keyboard focus, unframed overlay, resize, snap, restore, reload, hover, menus, headings, Escape, keyboard, mobile",
  );
} finally {
  await browser?.close();
  if (server?.listening)
    await new Promise((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(testRoot, { recursive: true, force: true });
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
