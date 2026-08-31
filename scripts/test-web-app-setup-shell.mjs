import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { startOpenGroveServer } from "../dist/server/create-server.js";

const projectRoot = resolve(import.meta.dirname, "..");
const testRoot = await mkdtemp(join(tmpdir(), "opengrove-app-setup-shell-"));
const fixtureRoot = join(testRoot, "custom-setup-fixture");
const workbenchViewRoot = join(testRoot, "workbench-view-tab");
const noneRoot = join(testRoot, "none-fixture");
const settingsPath = join(testRoot, "bridge-settings.json");
const statePath = join(testRoot, "state.json");
const envKeys = [
  "OPENGROVE_BRIDGE_SETTINGS_PATH",
  "OPENGROVE_ENABLE_BROWSER_UI",
  "OPENGROVE_MCP_APP_SANDBOX_ORIGIN",
  "OPENGROVE_USER_DATA_DIR",
  "OPENGROVE_WEB_AUTH_MODE",
  "OPENGROVE_WORKSPACES_DIR",
];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let browser;
let server;

try {
  await cp(resolve(projectRoot, "examples/mcp-app-basic"), fixtureRoot, { recursive: true });
  const fixtureManifestPath = join(fixtureRoot, "opengrove.app.json");
  const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, "utf8"));
  const viewContract = fixtureManifest.ui.view;
  fixtureManifest.id = "custom-setup-fixture";
  fixtureManifest.title = "Custom Setup Fixture";
  fixtureManifest.ui = { surface: "setup", workspace: "workspace" };
  await writeFile(fixtureManifestPath, `${JSON.stringify(fixtureManifest, null, 2)}\n`);

  await cp(resolve(projectRoot, "examples/mcp-app-basic"), workbenchViewRoot, { recursive: true });
  const workbenchViewManifestPath = join(workbenchViewRoot, "opengrove.app.json");
  const workbenchViewManifest = JSON.parse(await readFile(workbenchViewManifestPath, "utf8"));
  workbenchViewManifest.id = "workbench-view-tab";
  workbenchViewManifest.title = "Workbench View Tab";
  workbenchViewManifest.ui = {
    surface: "file-workbench",
    workspace: "workspace",
    tabs: [
      { component: "file-tree", label: "创作空间" },
      { id: "work-management", component: "view", label: "作品管理", view: viewContract },
      { id: "broken", component: "view", label: "故障视图", view: viewContract },
    ],
  };
  await writeFile(workbenchViewManifestPath, `${JSON.stringify(workbenchViewManifest, null, 2)}\n`);

  await mkdir(join(noneRoot, "workspace"), { recursive: true });
  await writeFile(
    join(noneRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "none-fixture",
        title: "None Fixture",
        version: "0.1.0",
        ui: { surface: "none", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        developerMode: true,
        mountedApps: [
          { id: "custom-setup-fixture", title: "Custom Setup Fixture", path: fixtureRoot, enabled: true },
          { id: "workbench-view-tab", title: "Workbench View Tab", path: workbenchViewRoot, enabled: true },
          { id: "none-fixture", title: "None Fixture", path: noneRoot, enabled: true },
        ],
      },
      null,
      2,
    )}\n`,
  );

  process.env.OPENGROVE_BRIDGE_SETTINGS_PATH = settingsPath;
  process.env.OPENGROVE_ENABLE_BROWSER_UI = "1";
  process.env.OPENGROVE_USER_DATA_DIR = testRoot;
  process.env.OPENGROVE_WEB_AUTH_MODE = "bridge-token";
  process.env.OPENGROVE_WORKSPACES_DIR = join(testRoot, "workspaces");
  delete process.env.OPENGROVE_MCP_APP_SANDBOX_ORIGIN;

  server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    bridgeToken: "",
    profile: "test",
    runtimeEnvironment: "test",
    statePath,
  });
  if (!server.listening) await new Promise((resolveListen) => server.once("listening", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const hostOrigin = `http://127.0.0.1:${address.port}`;

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await page.addInitScript(() => {
    window.localStorage.setItem("opengroveActiveMountedAppId", "removed-app");
    window.__opengroveMountedAppSurfaceHistory = [];
    const recordMountedAppSurface = () => {
      const surface = document.querySelector(".mounted-app-view")?.getAttribute("data-surface");
      if (surface && window.__opengroveMountedAppSurfaceHistory.at(-1) !== surface) {
        window.__opengroveMountedAppSurfaceHistory.push(surface);
      }
    };
    new MutationObserver(recordMountedAppSurface).observe(document, {
      attributes: true,
      attributeFilter: ["data-surface"],
      childList: true,
      subtree: true,
    });
    window.addEventListener("DOMContentLoaded", recordMountedAppSurface);
  });
  await page.goto(`${hostOrigin}/ui/?view=app`);
  await page.waitForTimeout(1_000);
  const createAppButton = page.getByRole("button", { name: /^(New App|新建应用)$/ });
  if ((await createAppButton.count()) === 0) {
    throw new Error(`create button missing; body=${(await page.locator("body").innerText()).slice(0, 4_000)}`);
  }
  const appView = page.locator(".mounted-app-view");
  await assertEventually(async () => (await appView.getAttribute("data-surface")) === "setup");
  const initialSurfaceHistory = await page.evaluate(() => window.__opengroveMountedAppSurfaceHistory);
  assert.equal(
    initialSurfaceHistory.some((surface) => surface === "empty" || surface === "none"),
    false,
    `a stale stored App id must not flash an empty/no-canvas surface; history=${initialSurfaceHistory.join(",")}`,
  );

  // Real UI create path: the Host renders setup immediately, without waiting for a model turn.
  await createAppButton.click();
  const dialog = page.getByRole("dialog", { name: "新建应用" });
  await dialog.getByLabel("App 名称").fill("浏览器工作台回归");
  await dialog.getByLabel("描述").fill("验证 Host setup 和内置工作台");
  await dialog.getByRole("button", { name: "创建并打开" }).click();
  await appView.waitFor();
  await assertEventually(async () => (await appView.getAttribute("data-surface")) === "setup");
  assert.equal(await page.locator(".mounted-app-shell-header").count(), 0, "Apps must not add a second titlebar");
  await appView.locator(".mounted-app-developer-chat").waitFor({ state: "visible" });
  await appView.getByText("你的施工队已就位。", { exact: false }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "退出 App 开发模式" }).waitFor({ state: "visible" });
  await appView.getByRole("heading", { name: "浏览器工作台回归", exact: true }).waitFor({ state: "visible" });

  const setupResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/setup"),
  );
  await appView.getByRole("button", { name: /用内置工作台 UI/ }).click();
  const setupResponse = await setupResponsePromise;
  const setupResponseBody = await setupResponse.text();
  assert.equal(setupResponse.status(), 200, `selecting the built-in workbench failed: ${setupResponseBody}`);
  assert.equal(
    JSON.parse(setupResponseBody).app?.title,
    "浏览器工作台回归",
    "the setup choice must apply to the newly created App",
  );
  await assertEventually(async () => (await appView.getAttribute("data-surface")) === "file-workbench");
  await appView.locator(".workspace-workbench-layout").waitFor({ state: "visible" });
  const workbenchEditor = appView.locator(".workspace-workbench-editor");
  const workbenchChat = appView.locator(".mounted-app-chat-pane");
  const workbenchResizeHandle = appView.locator(".mounted-app-resize-handle-chat");
  await workbenchEditor.waitFor({ state: "visible" });
  await workbenchChat.waitFor({ state: "visible" });
  await workbenchResizeHandle.waitFor({ state: "visible" });
  assert.equal(
    await workbenchEditor.evaluate((element) => getComputedStyle(element).borderWidth),
    "0px",
    "the App editor surface must use the shared borderless page frame",
  );
  assert.equal(
    await workbenchChat.evaluate((element) => getComputedStyle(element).borderWidth),
    "0px",
    "the App chat surface must use the shared borderless page frame",
  );
  assert.equal(
    await appView.locator(".mounted-app-tree-pane").evaluate((element) => getComputedStyle(element).borderRightWidth),
    "1px",
    "removing the outer frame must preserve the file tree's internal column divider",
  );
  assert.equal(
    await workbenchResizeHandle.evaluate((element) => getComputedStyle(element, "::after").opacity),
    "0",
    "the workbench resize indicator must stay invisible until hover or drag",
  );
  const workbenchResizeHandleBounds = await workbenchResizeHandle.boundingBox();
  assert.ok(workbenchResizeHandleBounds);
  const workbenchResizeX = workbenchResizeHandleBounds.x + workbenchResizeHandleBounds.width / 2;
  const workbenchResizeY = workbenchResizeHandleBounds.y + workbenchResizeHandleBounds.height / 2;
  const workbenchChatBeforeDrag = await workbenchChat.boundingBox();
  assert.ok(workbenchChatBeforeDrag);
  const workbenchChatMinimum = Number(await workbenchResizeHandle.getAttribute("aria-valuemin"));
  const dragDirection = workbenchChatBeforeDrag.width > workbenchChatMinimum + 40 ? 1 : -1;
  await page.evaluate(() => {
    const originalSetPointerCapture = Element.prototype.setPointerCapture;
    window.__opengroveOriginalSetPointerCapture = originalSetPointerCapture;
    Element.prototype.setPointerCapture = function setPointerCaptureFailureFixture(pointerId) {
      if (this.classList.contains("mounted-app-resize-handle-chat")) {
        throw new DOMException("pointer capture unavailable", "NotFoundError");
      }
      return originalSetPointerCapture.call(this, pointerId);
    };
  });
  await page.mouse.move(workbenchResizeX, workbenchResizeY);
  await page.mouse.down();
  await page.mouse.move(workbenchResizeX + dragDirection * 40, workbenchResizeY);
  await page.mouse.up();
  await page.evaluate(() => {
    Element.prototype.setPointerCapture = window.__opengroveOriginalSetPointerCapture;
    delete window.__opengroveOriginalSetPointerCapture;
  });
  assert.equal(
    await workbenchResizeHandle.getAttribute("data-resizing"),
    null,
    "failed pointer capture must not leave resize UI state or listeners behind",
  );
  const workbenchChatAfterCaptureFailure = await workbenchChat.boundingBox();
  assert.ok(workbenchChatAfterCaptureFailure);
  assert.ok(
    Math.abs(workbenchChatAfterCaptureFailure.width - workbenchChatBeforeDrag.width) < 2,
    "pointer movement after capture failure must not resize the workbench",
  );
  await page.mouse.move(workbenchResizeX, workbenchResizeY);
  await page.mouse.down();
  await page.mouse.move(workbenchResizeX + dragDirection * 40, workbenchResizeY);
  const workbenchChatAfterDrag = await workbenchChat.boundingBox();
  assert.ok(workbenchChatAfterDrag);
  assert.ok(
    dragDirection > 0
      ? workbenchChatAfterDrag.width < workbenchChatBeforeDrag.width - 20
      : workbenchChatAfterDrag.width > workbenchChatBeforeDrag.width + 20,
    "dragging toward available space must resize the workbench chat panel",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  assert.equal(
    await workbenchResizeHandle.getAttribute("data-resizing"),
    null,
    "window blur must end the active workbench resize",
  );
  await page.mouse.move(workbenchResizeX + dragDirection * 120, workbenchResizeY);
  const workbenchChatAfterBlur = await workbenchChat.boundingBox();
  assert.ok(workbenchChatAfterBlur);
  assert.ok(
    Math.abs(workbenchChatAfterBlur.width - workbenchChatAfterDrag.width) < 2,
    "pointer movement after window blur must not keep resizing the workbench",
  );
  const releasedHandleBounds = await workbenchResizeHandle.boundingBox();
  assert.ok(releasedHandleBounds);
  await page.mouse.move(
    releasedHandleBounds.x + releasedHandleBounds.width / 2,
    releasedHandleBounds.y + releasedHandleBounds.height / 2,
  );
  await page.mouse.up();
  await page.getByRole("button", { name: "退出 App 开发模式" }).click();
  await workbenchChat.waitFor({ state: "hidden" });
  await workbenchResizeHandle.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "进入 App 开发模式" }).click();
  await workbenchChat.waitFor({ state: "visible" });

  // Apps without a visual surface keep their original canvas and default developer mode closed.
  await page.getByRole("button", { name: "None Fixture", exact: true }).click();
  await assertEventually(async () => (await appView.getAttribute("data-surface")) === "none");
  await appView.getByText("这个 App 没有画布", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "进入 App 开发模式" }).waitFor({ state: "visible" });
  await appView.locator(".mounted-app-developer-chat").waitFor({ state: "hidden" });

  // A file-workbench can hand one tab's canvas to its App-owned MCP View while retaining Host tabs and chat.
  await page.getByRole("button", { name: "Workbench View Tab", exact: true }).click();
  await assertEventually(async () => (await appView.getAttribute("data-surface")) === "file-workbench");
  const viewTabWorkbenchChat = appView.locator(".mounted-app-chat-pane");
  await viewTabWorkbenchChat.waitFor({ state: "visible" });
  await appView.getByRole("tab", { name: "作品管理", exact: true }).click();
  await appView.locator('[data-mcp-app="true"]').waitFor();
  assert.equal(
    await appView.locator(".mounted-app-tree-pane").count(),
    0,
    "the App-owned View owns the full workbench canvas",
  );
  assert.equal(await viewTabWorkbenchChat.isVisible(), true, "a View Tab failure or success must not remove Host chat");
  const workbenchViewFrame = await frameWithSelector(page, "#list-files");
  await workbenchViewFrame.locator("#list-files").click();
  await assertEventually(
    async () => (await workbenchViewFrame.locator("#output").textContent())?.includes("README.md") === true,
  );

  const workbenchViewEntry = join(workbenchViewRoot, "ui", "index.html");
  await writeFile(
    workbenchViewEntry,
    `${await readFile(workbenchViewEntry, "utf8")}\n<!-- workbench view rebuilt -->\n`,
  );
  const rebuiltWorkbenchViewFrame = await frameWithSelector(page, "#list-files", workbenchViewFrame);
  await rebuiltWorkbenchViewFrame.locator("#list-files").click();
  await assertEventually(
    async () => (await rebuiltWorkbenchViewFrame.locator("#output").textContent())?.includes("README.md") === true,
  );

  await page.route("**/api/apps/workbench-view-tab/mcp-app/contract?view=broken", async (route) => {
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "fixture_view_failed" }),
    });
  });
  await appView.getByRole("tab", { name: "故障视图", exact: true }).click();
  await appView.getByRole("alert").waitFor();
  assert.match(await appView.getByRole("alert").innerText(), /fixture_view_failed/u);
  assert.equal(await viewTabWorkbenchChat.isVisible(), true, "a failed View Tab must stay isolated from Host chat");

  await appView.getByRole("tab", { name: "创作空间", exact: true }).click();
  await appView.locator(".mounted-app-tree-pane").waitFor({ state: "visible" });
  assert.equal(
    await appView.locator('.mounted-app-view-tab-pane[data-active="true"] [data-mcp-app="true"]').count(),
    0,
  );
  assert.equal(
    await appView.locator('[data-mcp-app="true"]').count(),
    1,
    "an initialized View Tab stays mounted while hidden so form and iframe state survive tab switches",
  );

  // Custom path: record the fixed Host choice, then simulate the Builder's first verified bundle patch.
  await page.getByRole("button", { name: "Custom Setup Fixture", exact: true }).click();
  await assertEventually(async () => (await appView.getAttribute("data-surface")) === "setup");
  await page.getByRole("button", { name: "退出 App 开发模式" }).waitFor();
  await appView.getByRole("button", { name: /从零搭建专属界面/ }).click();
  await appView.getByText("选择已交给构建师。", { exact: false }).waitFor();
  const patchResponse = await fetch(`${hostOrigin}/api/apps/custom-setup-fixture/runtime`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface: "view", view: viewContract }),
  });
  assert.equal(patchResponse.status, 200);
  await assertEventually(async () => (await appView.getAttribute("data-surface")) === "view", 4_000);
  await page.getByRole("button", { name: "进入 App 开发模式" }).waitFor({ state: "visible" });
  await appView.locator(".mounted-app-developer-chat").waitFor({ state: "hidden" });

  const viewFrame = await frameWithSelector(page, "#list-files");
  await viewFrame.locator("#list-files").click();
  await assertEventually(
    async () => (await viewFrame.locator("#output").textContent())?.includes("README.md") === true,
  );

  // A direct bundle rebuild changes the runtime revision, remounts the iframe,
  // and must complete a fresh SDK handshake before tools work again.
  const builtViewPath = join(fixtureRoot, "ui", "index.html");
  await writeFile(builtViewPath, `${await readFile(builtViewPath, "utf8")}\n<!-- rebuilt -->\n`);
  const rebuiltViewFrame = await frameWithSelector(page, "#list-files", viewFrame);
  await rebuiltViewFrame.locator("#list-files").click();
  await assertEventually(
    async () => (await rebuiltViewFrame.locator("#output").textContent())?.includes("README.md") === true,
  );

  // Leaving developer mode hides the existing Room without unmounting it or losing a draft.
  await page.getByRole("button", { name: "进入 App 开发模式" }).click();
  const developerChat = appView.locator(".mounted-app-developer-chat");
  const developerResizeHandle = appView.locator(".mounted-app-developer-resize-handle");
  await developerChat.waitFor({ state: "visible" });
  await developerResizeHandle.waitFor({ state: "visible" });
  assert.equal(
    await developerResizeHandle.evaluate((element) => getComputedStyle(element, "::after").opacity),
    "0",
    "the developer resize indicator must stay invisible until hover or drag",
  );
  const chatBeforeResize = await developerChat.boundingBox();
  const handleBounds = await developerResizeHandle.boundingBox();
  assert.ok(chatBeforeResize && handleBounds);
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
  await assertEventually(
    async () => await developerResizeHandle.evaluate((element) => getComputedStyle(element, "::after").opacity === "1"),
  );
  await page.mouse.down();
  await page.mouse.move(handleBounds.x + handleBounds.width / 2 + 120, handleBounds.y + handleBounds.height / 2);
  await page.mouse.up();
  const chatAfterResize = await developerChat.boundingBox();
  assert.ok(
    chatAfterResize && chatAfterResize.width < chatBeforeResize.width - 80,
    "dragging right must narrow the developer panel",
  );
  const rememberedDeveloperPanelWidth = chatAfterResize.width;

  const composer = developerChat.locator("textarea").first();
  await composer.waitFor();
  await composer.fill("这段草稿不能丢");
  await page.getByRole("button", { name: "退出 App 开发模式" }).click();
  await page.getByRole("button", { name: "进入 App 开发模式" }).click();
  await composer.waitFor({ state: "visible" });
  assert.equal(await composer.inputValue(), "这段草稿不能丢");
  await page.getByRole("button", { name: "None Fixture", exact: true }).click();
  await page.getByRole("button", { name: "Custom Setup Fixture", exact: true }).click();
  await assertEventually(async () => (await appView.getAttribute("data-surface")) === "view");
  await page.getByRole("button", { name: "退出 App 开发模式" }).waitFor({ state: "visible" });
  await appView.locator(".mounted-app-developer-chat").waitFor({ state: "visible" });
  await assertEventually(async () => {
    const bounds = await appView.locator(".mounted-app-developer-chat").boundingBox();
    return Boolean(bounds && Math.abs(bounds.width - rememberedDeveloperPanelWidth) < 2);
  });

  console.log("web-app-setup-shell Playwright regression passed");
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(testRoot, { recursive: true, force: true });
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

async function frameWithSelector(page, selector, excludedFrame) {
  let selected;
  await assertEventually(async () => {
    for (const frame of page.frames()) {
      if (frame === excludedFrame) continue;
      try {
        if (await frame.locator(selector).count()) {
          selected = frame;
          return true;
        }
      } catch {
        // Runtime revision reloads detach the previous frame while this poll is in flight.
      }
    }
    return false;
  }, 10_000);
  return selected;
}

async function assertEventually(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.fail(`condition did not become true within ${timeoutMs}ms`);
}
