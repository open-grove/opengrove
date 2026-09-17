import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { tailwindStylesPlugin } from "./esbuild-tailwind-plugin.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-provider-toggle-ui-"));
const entryPath = join(tempDir, "entry.tsx");
const htmlPath = join(tempDir, "index.html");
const globalStylesPath = join(projectRoot, "web/src/styles.css");
const storageKey = "provider-toggle-settings";
const initialBindings = [
  { modelId: "flash-model", providerId: "ww" },
  { modelId: "opus-model", providerId: "ww" },
  { modelId: "other-model", providerId: "backup" },
];

try {
  await writeFile(entryPath, entrySource(), "utf8");
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: join(tempDir, "entry.js"),
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pathToFileURL(htmlPath).href);
    const provider = page.locator(".settings-provider-item").filter({ has: page.getByText("WW", { exact: true }) });
    const toggle = provider.getByRole("switch");
    const modelChoice = (label) =>
      page.locator(".settings-model-provider-row").filter({ hasText: label }).getByRole("button");
    const savedSettings = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);

    await expect(modelChoice("Flash Model")).toHaveAccessibleName("WW");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    assert.deepEqual(
      (await savedSettings()).modelProviderBindings,
      initialBindings,
      "disabling a Provider must preserve its model defaults and unrelated defaults",
    );
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(modelChoice("Flash Model")).toHaveAccessibleName("WW (不可用)");
    await toggle.click();
    await expect(modelChoice("Flash Model")).toHaveAccessibleName("WW");
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(modelChoice("Opus Model")).toHaveAccessibleName("WW");
    await expect(modelChoice("Unbound Model")).toHaveAccessibleName("暂不选择");
    assert.deepEqual((await savedSettings()).modelProviderBindings, initialBindings);

    // An explicit clear remains a user choice across subsequent toggles.
    await modelChoice("Flash Model").click();
    await page.getByRole("option", { name: "暂不选择", exact: true }).click();
    await expect(modelChoice("Flash Model")).toHaveAccessibleName("暂不选择");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await expect(modelChoice("Flash Model")).toHaveAccessibleName("暂不选择");
    assert.deepEqual((await savedSettings()).modelProviderBindings, [
      { modelId: "opus-model", providerId: "ww" },
      { modelId: "other-model", providerId: "backup" },
    ]);

    // Deletion, unlike temporary disabling, removes defaults for this Provider.
    await provider.locator(".settings-provider-summary").click();
    await provider.getByRole("button", { name: "移除提供方", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
    await expect(provider).toHaveCount(0);
    await page.reload();
    await expect(modelChoice("Opus Model")).toHaveAccessibleName("暂不选择");
    await expect(modelChoice("Other Model")).toHaveAccessibleName("Backup");
    assert.deepEqual((await savedSettings()).modelProviderBindings, [{ modelId: "other-model", providerId: "backup" }]);
    assert.deepEqual(errors, [], "settings interactions must not throw browser errors");
    console.log("web-provider-toggle-ui passed");
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function entrySource() {
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { SettingsDialog } from ${JSON.stringify(join(projectRoot, "web/src/components/sidebar/settings-dialog.tsx"))};
    import type { BridgeSettings, ProviderProfile } from ${JSON.stringify(join(projectRoot, "web/src/bridge-settings-types.ts"))};
    import ${JSON.stringify(globalStylesPath)};

    localStorage.setItem("opengroveLanguage", "zh-CN");
    const sharedModels = [
      { id: "flash-model", label: "Flash Model" },
      { id: "opus-model", label: "Opus Model" },
    ];
    const initialSettings: BridgeSettings = {
      developerMode: true,
      kernel: "claude-code",
      activeKernel: "claude-code",
      activeModel: "flash-model",
      kernels: [{ id: "claude-code", label: "Claude Code", available: true }],
      kernelProxy: { enabled: false, proxyUrl: "", noProxy: "", nodeUseEnvProxy: false },
      customProviders: [
        {
          id: "ww", name: "WW", custom: true, origin: "user", enabled: true,
          protocol: "anthropic-compatible", anthropicBaseUrl: "https://ww.example.test",
          apiKey: "fixture-only", credentialKind: "api-key",
          models: [...sharedModels, { id: "unbound-model", label: "Unbound Model" }],
        },
        {
          id: "backup", name: "Backup", custom: true, origin: "user", enabled: true,
          protocol: "anthropic-compatible", anthropicBaseUrl: "https://backup.example.test",
          apiKey: "fixture-only", credentialKind: "api-key",
          models: [...sharedModels, { id: "other-model", label: "Other Model" }],
        },
      ],
      modelProviderBindings: ${JSON.stringify(initialBindings)},
    };
    // The host returns runtime metadata separately from persisted profiles.
    function providerView(profile: ProviderProfile): ProviderProfile {
      return {
        ...profile,
        bindings: { "claude-code": "anthropic-compatible" },
        runtime: {
          active: profile.enabled !== false,
          usable: profile.enabled !== false,
          credential: { status: "configured", configured: true, source: "inline", writable: true },
        },
      };
    }
    function Fixture() {
      const [settings, setSettings] = useState<BridgeSettings>(() => {
        const saved = localStorage.getItem(${JSON.stringify(storageKey)});
        return saved ? JSON.parse(saved) : initialSettings;
      });
      return <SettingsDialog
        embedded initialSection="providers"
        settings={{ ...settings, providers: (settings.customProviders ?? []).map(providerView) }}
        loading={false} saving={false} error="" onClose={() => undefined}
        onSave={(patch) => {
          const next = { ...settings, ...patch };
          localStorage.setItem(${JSON.stringify(storageKey)}, JSON.stringify(next));
          setSettings(next);
        }}
      />;
    }
    createRoot(document.getElementById("root")!).render(<Fixture />);
  `;
}
