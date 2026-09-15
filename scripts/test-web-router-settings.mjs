import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "opengrove-router-settings-ui-"));
const source = (path) => JSON.stringify(join(root, path));
try {
  await writeFile(
    join(temporary, "entry.tsx"),
    `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { SettingsDialog } from ${source("web/src/components/sidebar/settings-dialog.tsx")};
    import { ToastProvider } from ${source("web/src/components/ui/toast.tsx")};
    import { ConfirmProvider } from ${source("web/src/components/ui/confirm-dialog.tsx")};
    import { setLanguagePreference } from ${source("web/src/i18n.ts")};
    import ${source("web/src/styles/tokens.css")};
    import ${source("web/src/styles/reset.css")};
    import ${source("web/src/styles/primitives.css")};
    import ${source("web/src/styles/base/document.css")};
    setLanguagePreference("zh-CN");
    window.__setLanguage = setLanguagePreference;
    window.__saved = [];
    function Fixture() {
      const [settings, setSettings] = useState({
        developerMode: false, kernel: "codex", activeKernel: "codex", activeModel: "default",
        kernels: [], agentRouterUrl: "", agentRouterManaged: false,
        kernelProxy: { enabled: false, proxyUrl: "", noProxy: "", nodeUseEnvProxy: false },
      });
      window.__manage = () => setSettings((value) => ({ ...value, agentRouterUrl: "https://managed.example/_agent-router/v1", agentRouterManaged: true }));
      return <SettingsDialog settings={settings} loading={false} saving={false} error="" initialSection="network"
        onClose={() => {}} onSave={(payload) => {
          window.__saved.push(payload);
          setSettings((value) => ({ ...value, ...payload }));
        }} />;
    }
    createRoot(document.getElementById("root")).render(<ToastProvider><ConfirmProvider><Fixture /></ConfirmProvider></ToastProvider>);
  `,
  );
  await build({
    entryPoints: [join(temporary, "entry.tsx")],
    outfile: join(temporary, "entry.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    nodePaths: [join(root, "node_modules")],
    define: { "import.meta.env": '{"DEV":false}' },
  });
  await writeFile(
    join(temporary, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./entry.css"><style>body { font-family: sans-serif; }</style></head><body><div id="root"></div><script src="./entry.js"></script></body></html>`,
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1040, height: 820 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pathToFileURL(join(temporary, "index.html")).href);
    const input = page.getByRole("textbox", { name: /云端员工服务地址/ });
    const save = page.getByRole("button", { name: "保存地址", exact: true });
    await expect(page.getByRole("heading", { name: "网络", exact: true })).toBeVisible();
    await expect(input).toHaveValue("");
    await expect(save).toBeDisabled();
    await input.fill("https://agents.example/_agent-router/v1");
    await input.blur();
    assert.deepEqual(
      await page.evaluate(() => window.__saved),
      [],
      "editing must not select a trusted service until Save",
    );
    await save.click();
    assert.deepEqual(await page.evaluate(() => window.__saved), [
      { agentRouterUrl: "https://agents.example/_agent-router/v1" },
    ]);
    await expect(save).toBeDisabled();
    await mkdir(join(root, ".artifacts"), { recursive: true });
    await page.screenshot({ path: join(root, ".artifacts/router-settings-desktop.png") });
    await input.fill("");
    await input.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.__saved.at(-1)), { agentRouterUrl: "" });
    await page.evaluate(() => window.__setLanguage("en"));
    await expect(page.getByRole("textbox", { name: /Service address \(Router\)/ })).toHaveValue("");
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = page.getByRole("dialog");
    const bounds = await dialog.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: join(root, ".artifacts/router-settings-mobile.png") });
    await page.evaluate(() => window.__manage());
    const managed = page.getByRole("textbox", { name: /Service address \(Router\)/ });
    await expect(managed).toHaveValue("https://managed.example/_agent-router/v1");
    await expect(managed).toHaveAttribute("readonly", "");
    await expect(
      page.getByText("This address is managed by the startup environment. Change it there and restart OpenGrove."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save address", exact: true })).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(
  "Router settings UI: standard mode, explicit save, clearing, environment ownership, localization and responsive layout passed",
);
