import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { tailwindStylesPlugin } from "./esbuild-tailwind-plugin.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-settings-layout-ui-"));
const entryPath = join(tempDir, "entry.tsx");
const bundlePath = join(tempDir, "entry.js");
const htmlPath = join(tempDir, "index.html");
const componentPath = join(projectRoot, "web/src/components/sidebar/settings-dialog.tsx");
const globalStylesPath = join(projectRoot, "web/src/styles.css");

try {
  const settingsDialogSource = await readFile(componentPath, "utf8");
  assert.equal(
    settingsDialogSource.includes("settings-restart-note"),
    false,
    "autosave progress must not be appended as a content row below every settings panel",
  );
  assert.equal(
    settingsDialogSource.includes('t("common.saving")'),
    false,
    "the settings shell must keep ordinary autosave progress silent",
  );
  await writeFile(entryPath, entrySource(componentPath, globalStylesPath), "utf8");
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
    '<!doctype html><html><head><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><div id="apps-root"></div><div id="updates-root"></div><div id="provider-root"></div><script src="./entry.js"></script></body></html>',
    "utf8",
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor();

    assert.deepEqual(
      await page.locator("[data-settings-section]").evaluateAll((items) =>
        items.slice(0, 5).map((item) => ({
          id: item.getAttribute("data-settings-section"),
          dividerAfter: getComputedStyle(item).marginBottom === "13px",
        })),
      ),
      [
        { id: "mode", dividerAfter: false },
        { id: "kernels", dividerAfter: false },
        { id: "appearance", dividerAfter: false },
        { id: "desktop", dividerAfter: false },
        { id: "updates", dividerAfter: true },
      ],
      "Software Update must remain in the standard settings group above the developer-only divider",
    );

    assert.deepEqual(
      await page.locator(".settings-screen").evaluate((element) => {
        const sidebar = element.querySelector(".settings-screen-sidebar");
        const main = element.querySelector(".settings-screen-main");
        const style = getComputedStyle(element);
        const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null;
        const mainStyle = main ? getComputedStyle(main) : null;
        return {
          sidebarWidth: style.gridTemplateColumns.split(" ")[0],
          gap: style.gap,
          padding: style.padding,
          rootBackground: style.backgroundColor,
          separateSurfaces:
            sidebarStyle?.backgroundColor === mainStyle?.backgroundColor &&
            sidebarStyle?.backgroundColor !== style.backgroundColor,
          sidebarRadius: sidebarStyle?.borderRadius,
          mainRadius: mainStyle?.borderRadius,
        };
      }),
      {
        sidebarWidth: "244px",
        gap: "10px",
        padding: "4px 10px 16px",
        rootBackground: "rgba(0, 0, 0, 0)",
        separateSurfaces: true,
        sidebarRadius: "12px",
        mainRadius: "12px",
      },
      "embedded settings should share the employee page's two-pane shell",
    );

    assert.deepEqual(
      await page.getByRole("switch", { name: "开发者模式" }).evaluate((element) => {
        const track = getComputedStyle(element);
        const thumb = element.firstElementChild ? getComputedStyle(element.firstElementChild) : null;
        const list = element.closest(".settings-list");
        return {
          trackVisible: track.backgroundColor !== (list ? getComputedStyle(list).backgroundColor : ""),
          thumbVisible: thumb?.backgroundColor !== track.backgroundColor,
        };
      }),
      {
        trackVisible: true,
        thumbVisible: true,
      },
      "settings switches should keep both the track and thumb visible in dark mode",
    );
    await page.getByRole("switch", { name: "直接与内核对话" }).click();
    assert.equal(
      await page.locator("html").getAttribute("data-last-settings-payload"),
      "directKernelChatEnabled",
      "saving one setting must submit only that setting",
    );
    const modeSectionWidth = await page
      .locator(".settings-screen-main .settings-list-section")
      .evaluate((section) => Math.round(section.getBoundingClientRect().width));

    await page.getByRole("button", { name: "内核", exact: true }).click();
    await page.getByRole("heading", { name: "内核", exact: true }).waitFor();
    const kernelSectionWidth = await page
      .locator(".settings-screen-main .settings-list-section")
      .evaluate((section) => Math.round(section.getBoundingClientRect().width));
    const kernelChoiceLayout = await page.locator("[data-kernel-choice]").evaluateAll((choices) => {
      const grid = choices[0]?.parentElement;
      return {
        count: choices.length,
        columnCount: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
        borderless: choices.every((choice) => getComputedStyle(choice).borderTopWidth === "0px"),
        shadowless: choices.every((choice) => getComputedStyle(choice).boxShadow === "none"),
        compact: choices.every((choice) => choice.getBoundingClientRect().height <= 68),
      };
    });
    assert.deepEqual(
      kernelChoiceLayout,
      {
        count: 4,
        columnCount: 1,
        borderless: true,
        shadowless: true,
        compact: true,
      },
      "Kernel management should use the shared compact, borderless single-list language without a selected state",
    );
    const firstKernelChoice = page.locator("[data-kernel-choice]").first();
    await firstKernelChoice.getByRole("button", { name: "展开内核设置", exact: true }).click();
    const expandedKernelWidths = await page
      .locator("[data-kernel-choice]")
      .evaluateAll((choices) => choices.slice(0, 2).map((choice) => Math.round(choice.getBoundingClientRect().width)));
    assert.equal(
      expandedKernelWidths[0],
      expandedKernelWidths[1],
      "Expanding Kernel details must not turn one choice into a full-width row",
    );

    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByRole("heading", { name: "外观", exact: true }).waitFor();
    const appearanceSectionWidth = await page
      .locator(".settings-screen-main .settings-list-section")
      .evaluate((section) => Math.round(section.getBoundingClientRect().width));
    assert.deepEqual(
      [modeSectionWidth, kernelSectionWidth, appearanceSectionWidth],
      [modeSectionWidth, modeSectionWidth, modeSectionWidth],
      "Settings tabs must use one shared content width instead of sizing each panel independently",
    );
    const appearanceSelect = page.locator(".settings-appearance-section [data-inline-select-button]").first();
    await appearanceSelect.click();
    const appearanceMenuMetrics = await overlaySurfaceMetrics(page.getByRole("listbox"));
    assert.deepEqual(
      surfaceContract(appearanceMenuMetrics),
      { dataSize: "regular", minWidth: 232, maxWidth: 280 },
      "appearance pickers should explicitly consume the regular surface contract",
    );
    assert.ok(
      appearanceMenuMetrics.width >= 231.5 && appearanceMenuMetrics.width <= 280.5,
      `appearance picker width must stay inside the regular 232–280px range; got ${appearanceMenuMetrics.width}px`,
    );
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "语音", exact: true }).click();
    await page.getByRole("heading", { name: "语音", exact: true }).waitFor();
    const voiceSelect = page.locator(".settings-preference-row [data-inline-select-button]").first();
    await voiceSelect.click();
    const voiceMenuMetrics = await overlaySurfaceMetrics(page.getByRole("listbox"));
    assert.deepEqual(
      surfaceContract(voiceMenuMetrics),
      { dataSize: "regular", minWidth: 232, maxWidth: 280 },
      "voice pickers should explicitly consume the regular surface contract",
    );
    assert.ok(
      voiceMenuMetrics.width >= 231.5 && voiceMenuMetrics.width <= 280.5,
      `voice picker width must stay inside the regular 232–280px range; got ${voiceMenuMetrics.width}px`,
    );
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 720, height: 860 });
    assert.deepEqual(
      await page.locator(".settings-screen").evaluate((element) => ({
        columnCount: getComputedStyle(element).gridTemplateColumns.split(" ").length,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
      {
        columnCount: 1,
        viewportWidth: 720,
        scrollWidth: 720,
      },
      "embedded settings should collapse without horizontal overflow",
    );

    const apps = page.locator("#apps-root");
    const automaticAppUpdateSwitch = apps.getByRole("switch", { name: "settings.appAutoUpdate" });
    assert.equal(await automaticAppUpdateSwitch.getAttribute("aria-checked"), "true");
    await automaticAppUpdateSwitch.click();
    assert.equal(await page.locator("html").getAttribute("data-automatic-app-updates"), "false");
    assert.equal(
      await apps.locator(".settings-mounted-app-title-input").count(),
      1,
      "mounted Apps must remain renameable",
    );
    assert.equal(
      await apps.locator(".settings-mounted-app-path-input").count(),
      1,
      "mounted App paths must remain editable",
    );
    const mountedAppLayout = await apps.locator(".settings-mounted-app-row").evaluate((row) => {
      const controls = row.querySelector(".settings-mounted-app-controls");
      const title = row.querySelector(".settings-mounted-app-title-input");
      const path = row.querySelector(".settings-mounted-app-path-input");
      if (!(controls instanceof HTMLElement) || !(title instanceof HTMLElement) || !(path instanceof HTMLElement))
        return null;
      const rowBox = row.getBoundingClientRect();
      const controlsBox = controls.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const pathBox = path.getBoundingClientRect();
      return {
        contained: controlsBox.right <= rowBox.right + 0.5,
        titleWidth: titleBox.width,
        pathWidth: pathBox.width,
      };
    });
    assert.ok(mountedAppLayout?.contained, "mounted App controls must stay inside their settings row");
    assert.ok((mountedAppLayout?.titleWidth ?? 0) >= 120, "the mounted App title must keep a usable edit width");
    assert.ok((mountedAppLayout?.pathWidth ?? 0) >= 160, "the mounted App path must keep a usable edit width");
    assert.equal(
      await apps.getByRole("heading", { name: "创建 App", exact: true }).count(),
      0,
      "the Settings Apps page must not expose App creation",
    );
    assert.equal(
      await apps.getByRole("heading", { name: "settings.privateRegistry", exact: true }).count(),
      0,
      "the Settings Apps page must not expose the legacy private registry controls",
    );

    const updates = page.locator("#updates-root");
    assert.match(
      await updates.locator(".settings-update-status-row").innerText(),
      /0\.6\.1/,
      "Software Update must show the semantic package version instead of the internal release number",
    );
    await updates.getByRole("button", { name: "检查更新", exact: true }).click();
    await updates.getByText("已是最新版本", { exact: true }).waitFor();
    assert.equal(
      await updates.locator(".settings-desktop-action-row .settings-list-row-main strong").textContent(),
      "检查更新",
      "checking for updates must not replace the setting title with the result",
    );
    assert.equal(
      await updates.locator(".settings-update-check-result").textContent(),
      "已是最新版本",
      "the update result must render as separate feedback beside the action",
    );
    assert.equal(
      await page.locator("html").getAttribute("data-update-metadata-checked"),
      "yes",
      "Dev must still complete the WW metadata check when native auto-update is unsupported",
    );

    const providerRoot = page.locator("#provider-root");
    const inactiveProvider = providerRoot.getByText("Inactive Provider", { exact: true });
    assert.equal(
      await inactiveProvider.isVisible(),
      false,
      "an untouched unavailable Provider must not appear in the main list",
    );
    assert.equal(
      await providerRoot.getByText("Added Disabled Provider", { exact: true }).isVisible(),
      true,
      "a Provider the user already added must remain in the main list when disabled",
    );
    assert.equal(
      await providerRoot.getByRole("button", { name: "Log in", exact: true }).count(),
      1,
      "only a definitely missing account should expose Log in",
    );
    assert.equal(
      await providerRoot.getByRole("button", { name: "Log out", exact: true }).count(),
      1,
      "an authenticated Kernel account with native logout should expose only Log out",
    );
    const loginAction = providerRoot.getByRole("button", { name: "Log in", exact: true }).first();
    const logoutAction = providerRoot.getByRole("button", { name: "Log out", exact: true });
    assert.equal(
      await loginAction.isDisabled(),
      true,
      "the active Kernel Login action must remain disabled while its session runs",
    );
    assert.equal(
      await logoutAction.isDisabled(),
      true,
      "a running Kernel Login must serialize actions across every Kernel",
    );
    await providerRoot.locator("[data-finish-login-session]").evaluate((element) => element.click());
    const [loginActionStyle, logoutActionStyle] = await Promise.all([
      loginAction.evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: style.width, height: style.height, background: style.backgroundColor, color: style.color };
      }),
      logoutAction.evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: style.width, height: style.height, background: style.backgroundColor, color: style.color };
      }),
    ]);
    assert.equal(
      logoutActionStyle.width,
      loginActionStyle.width,
      "Login and Logout actions should have the same width",
    );
    assert.equal(
      logoutActionStyle.height,
      loginActionStyle.height,
      "Login and Logout actions should have the same height",
    );
    assert.equal(
      logoutActionStyle.background,
      loginActionStyle.background,
      "Logout should not use a filled danger background",
    );
    assert.notEqual(
      logoutActionStyle.color,
      loginActionStyle.color,
      "Logout should communicate danger through text color only",
    );
    assert.equal(
      await providerRoot.getByText("Log in again", { exact: true }).count(),
      0,
      "the Login list must not expose a redundant re-login action",
    );
    const kimiLoginRow = providerRoot.locator(".settings-provider-row.login-row").filter({ hasText: "Kimi Code" });
    assert.equal(
      await kimiLoginRow.getByRole("button", { name: "Log in", exact: true }).count(),
      0,
      "an authenticated Kernel without native logout must not masquerade re-login as Log in",
    );
    await providerRoot.getByText("Status unavailable", { exact: true }).waitFor();
    await providerRoot.getByText("CLI unavailable", { exact: true }).first().waitFor();
    const configuredPathRow = providerRoot
      .locator(".settings-provider-row.login-row")
      .filter({ hasText: "Unavailable Login" });
    await configuredPathRow.getByText("Configured CLI path not found: /missing/claude").waitFor();
    await configuredPathRow.getByRole("button", { name: "Reset path", exact: true }).click();
    assert.equal(
      await page.locator("html").getAttribute("data-reset-kernel-path"),
      "pi",
      "an invalid configured CLI path must provide a direct reset to automatic discovery",
    );

    await providerRoot.getByRole("button", { name: "添加 Provider", exact: true }).click();
    const providerPicker = page.getByRole("dialog", { name: "添加 Provider" });
    await providerPicker.waitFor();
    await providerPicker.getByRole("searchbox", { name: "搜索 Provider" }).fill("inactive");
    assert.equal(
      await providerPicker.locator(".settings-provider-catalog-row").count(),
      1,
      "the Add Provider dialog should filter the catalog without changing the main list",
    );
    await providerPicker.getByRole("searchbox", { name: "搜索 Provider" }).fill("");
    const catalogLabels = await providerPicker.locator(".settings-provider-catalog-row strong").allTextContents();
    assert.equal(catalogLabels.at(-1), "添加自定义 Provider", "Custom Provider should remain the final catalog option");
    await providerPicker.getByText("Inactive Provider", { exact: true }).click();
    await providerPicker.getByRole("heading", { name: "Inactive Provider", exact: true }).waitFor();
    assert.equal(
      await inactiveProvider.isVisible(),
      false,
      "choosing a catalog entry should open its dialog form instead of leaking it into the main list",
    );
    await page.keyboard.press("Escape");
    await providerPicker.getByRole("searchbox", { name: "搜索 Provider" }).waitFor();
    await providerPicker.getByRole("searchbox", { name: "搜索 Provider" }).fill("bedrock");
    await providerPicker.getByText("AWS Bedrock", { exact: true }).click();
    await providerPicker.getByRole("heading", { name: "AWS Bedrock", exact: true }).waitFor();
    assert.equal(
      await providerPicker.locator('input[type="password"]').count(),
      1,
      "Bedrock must keep an optional ABSK/API key input alongside ambient AWS credentials",
    );
    await page.keyboard.press("Escape");
    await providerPicker.getByRole("searchbox", { name: "搜索 Provider" }).waitFor();
    await providerPicker.getByRole("searchbox", { name: "搜索 Provider" }).fill("vertex");
    await providerPicker.getByText("Google Vertex AI", { exact: true }).click();
    await providerPicker.getByRole("heading", { name: "Google Vertex AI", exact: true }).waitFor();
    assert.equal(
      await providerPicker.locator('input[type="password"]').count(),
      0,
      "Google Vertex must use ADC without exposing an API key field",
    );
    await providerPicker.getByText(/Google Application Default Credentials/).waitFor();
    await page.keyboard.press("Escape");
    await providerPicker.getByRole("searchbox", { name: "搜索 Provider" }).waitFor();
    await providerPicker.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await providerPicker.count(), 0, "cancel should close the Add Provider dialog");

    await page.getByRole("button", { name: "模型提供方", exact: true }).click();
    const savedProvider = page.locator(".settings-provider-item").filter({ hasText: "Saved Provider" });
    const savedProviderSwitch = savedProvider.getByRole("switch");
    await savedProviderSwitch.click();
    assert.equal(
      await savedProviderSwitch.getAttribute("aria-checked"),
      "false",
      "a Provider switch must update immediately",
    );
    assert.equal(await savedProvider.count(), 1, "disabling a saved Provider must keep it in the list");
    await savedProvider.getByRole("button", { name: /Saved Provider/ }).click();
    await savedProvider.getByRole("button", { name: "移除提供方" }).click();
    const removeProviderDialog = page.getByRole("dialog", { name: "移除提供方" });
    await removeProviderDialog.getByRole("button", { name: "删除", exact: true }).click();
    assert.equal(await savedProvider.count(), 0, "deleting a Provider must update the list immediately");

    const providerRow = providerRoot.locator(".settings-model-provider-row");
    const providerTrigger = providerRoot.getByRole("button", { name: "暂不选择" });
    assert.ok(
      await providerTrigger.evaluate((element) => element.getBoundingClientRect().width < 260),
      "the model Provider hover target should wrap its content instead of spanning the whole value column",
    );
    const providerRowBackground = await providerRow.evaluate((element) => getComputedStyle(element).backgroundColor);
    await providerTrigger.hover();
    assert.equal(
      await providerRow.evaluate((element) => getComputedStyle(element).backgroundColor),
      providerRowBackground,
      "hovering the model Provider control should not highlight the full settings row",
    );
    await providerTrigger.click();
    const providerMenu = page.locator('[role="listbox"][data-state="open"][data-size="compact"]');
    const providerOptions = providerMenu.getByRole("option");
    assert.equal(
      await providerOptions.count(),
      2,
      "the Provider menu should contain one route and one no-selection action",
    );
    assert.match(
      await providerOptions.first().textContent(),
      /Test Provider/,
      "the available Provider should remain first",
    );
    assert.equal(
      await providerOptions.last().textContent(),
      "暂不选择",
      "the clearly named no-selection action should remain last",
    );
    assert.ok(
      await providerMenu.evaluate(
        (menu) => menu.getAttribute("data-size") === "compact" && menu.getBoundingClientRect().width <= 200,
      ),
      "the Provider menu should use the compact popup width instead of spanning the settings row",
    );
    assert.ok(
      await providerMenu.evaluate(
        (menu, trigger) => {
          const menuBox = menu.getBoundingClientRect();
          const triggerBox = trigger.getBoundingClientRect();
          return Math.abs(menuBox.right - triggerBox.right) <= 1;
        },
        await providerTrigger.elementHandle(),
      ),
      "the Provider menu should open beside the right-aligned trigger instead of jumping to the left edge of its column",
    );
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-settings-layout-ui harness ok");

async function overlaySurfaceMetrics(locator) {
  return locator.evaluate((menu) => {
    const style = getComputedStyle(menu);
    return {
      dataSize: menu.getAttribute("data-size"),
      minWidth: Number.parseFloat(style.minWidth),
      maxWidth: Number.parseFloat(style.maxWidth),
      width: Number.parseFloat(style.width),
    };
  });
}

function surfaceContract(metrics) {
  const { width: _width, ...contract } = metrics;
  return contract;
}

function entrySource(component, globalStyles) {
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { SettingsDialog } from ${JSON.stringify(component)};
    import { SettingsAppsPanel } from ${JSON.stringify(join(projectRoot, "web/src/components/sidebar/settings-apps-panel.tsx"))};
    import { SettingsUpdatePanel } from ${JSON.stringify(join(projectRoot, "web/src/components/sidebar/settings-update-panel.tsx"))};
    import { ConfirmProvider } from ${JSON.stringify(join(projectRoot, "web/src/components/ui/confirm-dialog.tsx"))};
    import { SettingsProviderSection } from ${JSON.stringify(join(projectRoot, "web/src/components/sidebar/settings-provider-section.tsx"))};
    import { emptyProviderForm, providerFormFromProfile } from ${JSON.stringify(join(projectRoot, "web/src/components/sidebar/settings-model.ts"))};
    import ${JSON.stringify(globalStyles)};

    document.documentElement.style.setProperty("--opengrove-sidebar-width", "244px");
    document.documentElement.style.setProperty("--app-page-top-inset", "4px");
    document.documentElement.style.setProperty("--app-page-bottom-inset", "16px");
    document.documentElement.dataset.resolvedTheme = "dark";
    localStorage.setItem("opengroveLanguage", "zh-CN");
    const unsupportedUpdateState = {
      supported: false,
      stage: "unsupported" as const,
      busy: false,
      updateAvailable: false,
      downloaded: false,
      canAutoInstall: false,
      autoDownload: true,
      currentVersion: "0.6.1",
      message: "当前运行环境不是打包安装版。",
      log: [],
    };
    window.openGroveDesktop = {
      apiBase: "opengrove-desktop://ui/api",
      bridgeStartupState: { stage: "ready", generation: 1 },
      versions: { app: "0.6.1", clientReleaseNumber: 10026 },
      getClientUpdateState: async () => unsupportedUpdateState,
      checkForClientUpdate: async () => unsupportedUpdateState,
    };
    createRoot(document.getElementById("root")!).render(
      <SettingsDialog
        embedded
        settings={{
          developerMode: true,
          providers: [{
            id: "saved-provider",
            name: "Saved Provider",
            custom: true,
            origin: "user",
            enabled: true,
            protocol: "openai-compatible",
            openaiBaseUrl: "https://saved-provider.test/v1",
            models: [{ id: "saved-model", label: "Saved Model" }],
          }],
          customProviders: [{
            id: "saved-provider",
            name: "Saved Provider",
            custom: true,
            origin: "user",
            enabled: true,
            protocol: "openai-compatible",
            openaiBaseUrl: "https://saved-provider.test/v1",
            models: [{ id: "saved-model", label: "Saved Model" }],
          }],
          appStore: {
            registryUrl: "https://registry.example.test",
            registryToken: "ogst_preserved",
          },
        }}
        loading={false}
        saving={false}
        error=""
        onClose={() => undefined}
        onSave={(payload) => {
          document.documentElement.dataset.lastSettingsPayload = Object.keys(payload).sort().join(",");
        }}
      />,
    );
    createRoot(document.getElementById("apps-root")!).render(
      <SettingsAppsPanel
        t={(key) => key === "app.createApp" ? "创建 App" : key}
        mountedApps={[{ id: "notes", title: "Notes", path: "/apps/notes", enabled: true }]}
        automaticUpdates={true}
        loading={false}
        saving={false}
        onPatchMountedAppDraft={() => undefined}
        onUpdateMountedApp={() => undefined}
        onRemoveMountedApp={() => undefined}
        onSetAutomaticUpdates={(enabled) => {
          document.documentElement.dataset.automaticAppUpdates = String(enabled);
        }}
      />,
    );
    createRoot(document.getElementById("updates-root")!).render(
      <ConfirmProvider>
        <SettingsUpdatePanel
          clientUpdate={{
            ok: true,
            current: 10026,
            latest: {
              version: 10026,
              downloadUrl: "https://downloads.example.test/OpenGrove.dmg",
              releaseNotes: "Current release",
            },
          }}
          onCheckClientUpdate={async () => {
            document.documentElement.dataset.updateMetadataChecked = "yes";
          }}
        />
      </ConfirmProvider>,
    );
    function ProviderFixture() {
      const [providerAddOpen, setProviderAddOpen] = useState(false);
      const [providerDetailOpen, setProviderDetailOpen] = useState(false);
      const [kernelLoginSession, setKernelLoginSession] = useState({
        id: "00000000-0000-4000-8000-000000000001",
        kernelId: "codex",
        action: "login",
        status: "running",
        output: "",
        startedAt: "2026-08-19T00:00:00.000Z",
      });
      const [providerDraftName, setProviderDraftName] = useState("");
      const [detailForm, setDetailForm] = useState(emptyProviderForm());
      const translations: Record<string, string> = {
        "common.back": "返回",
        "common.cancel": "取消",
        "settings.addCustomProvider": "添加自定义 Provider",
        "settings.addProvider": "添加 Provider",
        "settings.ambientVertexHint": "Google Application Default Credentials",
        "settings.customProvider": "自定义",
        "settings.logIn": "Log in",
        "settings.logOut": "Log out",
        "settings.loginStatusAuthenticated": "Logged in",
        "settings.loginStatusMissing": "Not logged in",
        "settings.loginStatusUnknown": "Status unavailable",
        "settings.loginStatusUnavailable": "CLI unavailable",
        "settings.loginConfiguredCliMissing": "Configured CLI path not found: {path}",
        "settings.loginConfiguredCliFailed": "Configured CLI could not run: {path}",
        "settings.resetCliPath": "Reset path",
        "settings.modelDefaultProviders": "模型默认 Provider",
        "settings.modelProviderNoSelection": "暂不选择",
        "settings.newProvider": "新 Provider",
        "settings.noProvidersFound": "未找到 Provider",
        "settings.searchProviders": "搜索 Provider",
      };
      return <>
        <button hidden type="button" data-finish-login-session onClick={() => setKernelLoginSession(undefined)}>
          Finish fixture Login
        </button>
        <SettingsProviderSection
        t={(key, replacements) => Object.entries(replacements ?? {}).reduce(
          (value, [name, replacement]) => value.replaceAll("{" + name + "}", String(replacement)),
          translations[key] ?? key,
        )}
        providers={[{
          id: "test-provider",
          name: "Test Provider",
          protocol: "anthropic-compatible",
          anthropicBaseUrl: "https://provider.test",
          apiKeyEnv: "TEST_PROVIDER_API_KEY",
          enabled: true,
          models: [{ id: "test-model", label: "Test Model" }],
        }, {
          id: "inactive-provider",
          name: "Inactive Provider",
          protocol: "anthropic-compatible",
          anthropicBaseUrl: "https://inactive.test",
          apiKeyEnv: "INACTIVE_PROVIDER_API_KEY",
          enabled: false,
          models: [{ id: "inactive-model", label: "Inactive Model" }],
          runtime: {
            active: false,
            usable: false,
            credential: { status: "missing", configured: false, source: "environment", writable: true },
          },
        }, {
          id: "added-disabled-provider",
          name: "Added Disabled Provider",
          protocol: "anthropic-compatible",
          anthropicBaseUrl: "https://added-disabled.test",
          apiKeyEnv: "ADDED_DISABLED_PROVIDER_API_KEY",
          custom: true,
          origin: "builtin",
          enabled: false,
          models: [{ id: "added-disabled-model", label: "Added Disabled Model" }],
          runtime: {
            active: false,
            usable: false,
            credential: { status: "missing", configured: false, source: "environment", writable: true },
          },
        }, {
          id: "aws-bedrock",
          name: "AWS Bedrock",
          protocol: "anthropic-compatible",
          anthropicBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          enabled: false,
          models: [{ id: "sonnet", label: "Sonnet" }],
          runtime: {
            active: false,
            usable: false,
            credential: { status: "missing", configured: false, source: "environment", writable: true },
          },
        }, {
          id: "google-vertex",
          name: "Google Vertex AI",
          protocol: "anthropic-compatible",
          enabled: false,
          models: [{ id: "gemini", label: "Gemini" }],
          runtime: {
            active: false,
            usable: false,
            credential: { status: "missing", configured: false, source: "environment", writable: true },
          },
        }]}
        kernels={[{ id: "claude-code", label: "Claude Agent", available: true }]}
        kernelLogins={[{
          kernelId: "codex",
          label: "Codex",
          status: "missing",
          loginAvailable: true,
          logoutAvailable: true,
        }, {
          kernelId: "claude-code",
          label: "Claude Agent",
          status: "authenticated",
          loginAvailable: true,
          logoutAvailable: true,
        }, {
          kernelId: "kimi",
          label: "Kimi Code",
          status: "authenticated",
          loginAvailable: true,
          logoutAvailable: false,
        }, {
          kernelId: "hermes",
          label: "Unknown Login",
          status: "unknown",
          loginAvailable: true,
          logoutAvailable: true,
        }, {
          kernelId: "pi",
          label: "Unavailable Login",
          status: "unavailable",
          loginAvailable: false,
          logoutAvailable: false,
          configuredCommand: "/missing/claude",
          configuredCommandIssue: "missing",
        }, {
          kernelId: "opencode",
          label: "Generic Unavailable Login",
          status: "unavailable",
          loginAvailable: false,
          logoutAvailable: false,
        }]}
        kernelLoginsLoading={false}
        kernelLoginSession={kernelLoginSession}
        kernelLoginActionPending={false}
        modelProviderBindings={[]}
        selectedProviderId=""
        providerDetailOpen={providerDetailOpen}
        providerAddOpen={providerAddOpen}
        providerDraftName={providerDraftName}
        detailForm={detailForm}
        editableProviderModels={[]}
        providerFormError=""
        providerSaveState="idle"
        providerApiKeyVisible={false}
        loading={false}
        saving={false}
        onSelectProvider={() => undefined}
        onOpenProviderAdd={() => setProviderAddOpen(true)}
        onCloseProviderAdd={() => {
          setProviderAddOpen(false);
          setProviderDetailOpen(false);
          setProviderDraftName("");
        }}
        onStartAddProvider={() => {
          setProviderDetailOpen(true);
          setProviderDraftName("新 Provider");
          setDetailForm(emptyProviderForm());
        }}
        onStartAddProviderFrom={(provider) => {
          setProviderDetailOpen(true);
          setProviderDraftName(provider.name);
          setDetailForm(providerFormFromProfile(provider));
        }}
        onCloseProviderDetail={() => {
          setProviderDetailOpen(false);
          setProviderDraftName("");
        }}
        onSetProviderDeleteTargetId={() => undefined}
        onSetProviderEnabled={() => undefined}
        onResetKernelBinaryPath={(kernelId) => { document.documentElement.dataset.resetKernelPath = kernelId; }}
        onBindModelProvider={() => undefined}
        onSaveProviderProfile={() => undefined}
        onUpdateProviderField={() => undefined}
        onUpdatePrimaryBaseUrl={() => undefined}
        onSetProviderModels={() => undefined}
        onUpdateProviderModel={() => undefined}
        onRemoveProviderModelAt={() => undefined}
        onAddProviderModel={() => undefined}
        onToggleProviderApiKeyVisible={() => undefined}
        />
      </>;
    }
    createRoot(document.getElementById("provider-root")!).render(
      <ProviderFixture />,
    );
  `;
}
