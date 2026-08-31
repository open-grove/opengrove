import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-web-app-directory-picker-"));
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
    plugins: [cssStubPlugin()],
  });
  await writeFile(
    htmlPath,
    "<!doctype html><html><body><div id='root'></div><script src='./entry.js'></script></body></html>",
    "utf8",
  );
  await runBrowserHarness(htmlPath);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function runBrowserHarness(path) {
  const browser = await launchChromiumForHarness();
  try {
    const page = await browser.newPage({
      locale: "zh-CN",
      viewport: { width: 900, height: 700 },
    });
    await page.goto(pathToFileURL(path).href);
    await page.waitForSelector("[data-harness-ready='true']", { state: "attached" });

    const chooseButton = page.getByRole("button", { name: "选择文件夹" });
    await chooseButton.click();
    await assertInputValue(page.getByLabel("本地目录"), "C:\\Projects\\demo-app");
    await assertInputValue(page.getByLabel("App 名称"), "demo-app");
    assert.equal(
      await page.evaluate(() => window.__helpCalls),
      0,
      "desktop selection must not fall back to Grove help",
    );

    await page.evaluate(() => {
      window.__pickerMode = "cancelled";
    });
    await chooseButton.click();
    await assertInputValue(page.getByLabel("本地目录"), "C:\\Projects\\demo-app");

    await page.evaluate(() => {
      window.__pickerMode = "error";
    });
    await chooseButton.click();
    await page.getByText("选择 App 文件夹失败：native_dialog_failed").waitFor();
    await chooseButton.waitFor();

    await page.evaluate(() => {
      delete window.openGroveDesktop;
      window.__pickerMode = "selected";
    });
    await chooseButton.click();
    await page.waitForFunction(() => window.__helpCalls === 1);
    assert.equal(await page.getByText("选择 App 文件夹失败：native_dialog_failed").count(), 1);

    console.log("web-app-directory-picker harness ok");
  } finally {
    await browser.close();
  }
}

async function assertInputValue(locator, expected) {
  await locator.waitFor();
  assert.equal(await locator.inputValue(), expected);
}

async function launchChromiumForHarness() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

function cssStubPlugin() {
  return {
    name: "css-stub",
    setup(buildApi) {
      buildApi.onResolve({ filter: /\.css$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path),
        namespace: "css-empty",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "css-empty" }, () => ({ contents: "", loader: "js" }));
    },
  };
}

function entrySource() {
  const workflowPath = resolve(projectRoot, "web/src/app-create-workflow.ts");
  const wizardPath = resolve(projectRoot, "web/src/components/apps/app-create-wizard.tsx");
  const i18nPath = resolve(projectRoot, "web/src/i18n.ts");
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { useAppCreateWorkflow } from ${JSON.stringify(workflowPath)};
    import { AppCreateWizard } from ${JSON.stringify(wizardPath)};
    import { setLanguagePreference } from ${JSON.stringify(i18nPath)};

    setLanguagePreference("zh-CN");

    window.__helpCalls = 0;
    window.__pickerMode = "selected";
    window.openGroveDesktop = {
      chooseDirectory: async () => {
        if (window.__pickerMode === "error") throw new Error("native_dialog_failed");
        if (window.__pickerMode === "cancelled") return { status: "cancelled" };
        return { status: "selected", path: "C:\\\\Projects\\\\demo-app" };
      },
    };

    function Harness() {
      const [messages, setMessages] = useState([]);
      const workflow = useAppCreateWorkflow({
        notify: {
          error: (message) => setMessages((current) => [...current, message]),
          success: (message) => setMessages((current) => [...current, message]),
        },
        askGroveForLocalFolderHelp: async () => { window.__helpCalls += 1; },
        canChooseLocalDirectory: false,
        chooseWorkspaceBridgeOutdatedMessage: "bridge outdated",
        folderTitleFromPath: (path) => path.replace(/[\\\\/]+$/, "").split(/[\\\\/]/).filter(Boolean).at(-1) || "App",
        setConversationSortMenuOpen: () => {},
        setProjectMenuOpenId: () => {},
        setRoomsAppView: () => {},
        setRoomsFocusRoomId: () => {},
        setView: () => {},
      });
      return React.createElement(React.Fragment, null,
        React.createElement(AppCreateWizard, {
          title: workflow.appDraftTitle,
          source: workflow.appDraftPath,
          description: workflow.appDraftDescription,
          localFolderPicking: workflow.appFolderPickerPending,
          canRequestAgent: true,
          onTitleChange: workflow.setAppDraftTitle,
          onSourceChange: workflow.setAppDraftPath,
          onDescriptionChange: workflow.setAppDraftDescription,
          onChooseLocalFolder: workflow.chooseAppImportFolder,
          onCancel: () => {},
          onRequestAgent: () => {},
        }),
        React.createElement("div", { "data-harness-ready": "true", hidden: true }),
        ...messages.map((message, index) => React.createElement("p", { key: index }, message)),
      );
    }

    createRoot(document.getElementById("root")).render(React.createElement(Harness));
  `;
}
