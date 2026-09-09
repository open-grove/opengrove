import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startOpenGroveServer } from "../dist/server/create-server.js";

const root = await mkdtemp(join(tmpdir(), "opengrove-compact-layout-"));
const overrides = {
  OPENGROVE_BRIDGE_SETTINGS_PATH: join(root, "settings.json"),
  OPENGROVE_ENABLE_BROWSER_UI: "1",
  OPENGROVE_USER_DATA_DIR: root,
  OPENGROVE_WEB_AUTH_MODE: "bridge-token",
  OPENGROVE_WORKSPACES_DIR: join(root, "workspaces"),
};
const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
let browser;
let server;
try {
  await writeFile(overrides.OPENGROVE_BRIDGE_SETTINGS_PATH, JSON.stringify({ mountedApps: [] }));
  Object.assign(process.env, overrides);
  server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    bridgeToken: "",
    profile: "test",
    runtimeEnvironment: "test",
    statePath: join(root, "state.json"),
  });
  if (!server.listening)
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 664 }, locale: "zh-CN", hasTouch: true });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${address.port}`;
  const settings = await page.request.patch(`${origin}/api/settings`, {
    data: { developerMode: true, directKernelChatEnabled: true },
  });
  assert.ok(settings.ok(), await settings.text());
  const employeeId = "compact-layout-employee";
  const member = await page.request.post(`${origin}/api/rooms/members`, {
    data: {
      id: employeeId,
      name: "Compact employee",
      kernel: "codex",
      model: "default",
      role: "agent",
      status: "idle",
      source: "local",
    },
  });
  assert.ok(member.ok(), await member.text());
  const created = await page.request.post(`${origin}/api/rooms`, {
    data: { title: "Compact group", memberIds: [employeeId] },
  });
  assert.ok(created.ok(), await created.text());
  const { room } = await created.json();
  const postMessage = await page.request.post(`${origin}/api/rooms/${room.id}/agent-messages`, {
    data: { senderId: employeeId, text: "Unread while the list is visible" },
  });
  assert.ok(postMessage.ok(), await postMessage.text());
  await page.goto(`${origin}/ui/`);
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });
  const toggle = page.locator("#app-navigation-toggle");
  await expect(toggle).toBeVisible({ timeout: 1500 });
  await toggle.click();
  const nav = page.getByRole("dialog", { name: "导航", exact: true });
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: "设置", exact: true }).click();
  await expect(nav).toBeHidden();
  await expect(page.locator(".settings-screen")).toBeVisible();
  for (const width of [320, 360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 664 });
    const bounds = await page.locator(".workspace").boundingBox();
    assert.ok(bounds.x <= 12 && bounds.width >= width - 24, "Compact content must use the full window width");
    assert.ok(bounds.x + bounds.width <= width, "The workspace must fit inside the viewport");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.setViewportSize({ width: 390, height: 664 });
  await toggle.click();
  await nav.getByRole("button", { name: /^员工/ }).click();
  await expect(page.locator(".rooms-list-panel")).toBeVisible();
  await expect(page.locator(".room-main-panel")).toBeHidden();
  const groupButton = page.locator(".rooms-list-panel").getByRole("button", { name: /Compact group/ });
  await expect(groupButton).toHaveAttribute("aria-label", /1.*未读/);
  await groupButton.click();
  await expect(page.locator(".room-main-panel")).toBeVisible();
  const draft = page.locator(".room-main-panel textarea");
  await draft.fill("保留未发送草稿");
  await page.getByRole("button", { name: "消息列表", exact: true }).click();
  await expect(page.locator(".rooms-list-panel")).toBeVisible();
  await expect(groupButton).toBeFocused();
  await expect(groupButton).not.toHaveAttribute("aria-label", /未读/);
  await page
    .locator(".rooms-list-panel")
    .getByRole("button", { name: /Compact group/ })
    .click();
  await expect(draft).toHaveValue("保留未发送草稿");
  await page.getByRole("button", { name: "消息列表", exact: true }).click();
  await page.locator(".rooms-list-panel").getByRole("button", { name: "通讯录", exact: true }).click();
  await expect(page.locator(".contacts-nav-panel")).toBeVisible();
  const employeeButton = page.locator(".contacts-nav-panel").getByRole("button", { name: /Compact employee/ });
  await employeeButton.click();
  await expect(page.getByRole("button", { name: "员工列表", exact: true })).toBeVisible();
  await expect(page.locator(".contacts-nav-panel")).toBeHidden();
  assert.ok(
    await page.locator(".contacts-main-panel").evaluate((node) => node.scrollWidth <= node.clientWidth),
    "Employee details must fit a phone without horizontal scrolling",
  );
  await page.getByRole("button", { name: "员工列表", exact: true }).click();
  await expect(page.locator(".contacts-nav-panel")).toBeVisible();
  await expect(employeeButton).toBeFocused();
  await toggle.click();
  await nav.getByRole("button", { name: "新建应用", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "新建应用", exact: true });
  await expect(createDialog).toBeVisible();
  const modal = await createDialog.boundingBox();
  assert.ok(modal.x >= 0 && modal.x + modal.width <= 390 && modal.y + modal.height <= 664);
  await page.keyboard.press("Escape");
  await expect(createDialog).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const handle = page.getByRole("separator", { name: "调整主导航宽度", exact: true });
  await expect(handle).toBeVisible();
  assert.equal(
    await handle.getAttribute("aria-valuenow"),
    "126",
    "Compact navigation must not overwrite desktop width",
  );
  assert.deepEqual(errors, []);
  console.log("web-compact-layout passed");
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
}
