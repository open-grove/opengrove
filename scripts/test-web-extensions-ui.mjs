import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { tailwindStylesPlugin } from "./esbuild-tailwind-plugin.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-extensions-ui-"));
const entryPath = join(tempDir, "entry.tsx");
const bundlePath = join(tempDir, "entry.js");
const htmlPath = join(tempDir, "index.html");
const componentPath = join(projectRoot, "web/src/components/extensions/extensions-view.tsx");
const globalStylesPath = join(projectRoot, "web/src/styles.css");

try {
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
    '<!doctype html><html><head><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script src="./entry.js"></script></body></html>',
    "utf8",
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.getByRole("heading", { name: "技能", exact: true }).waitFor();

    assert.equal(
      await page.getByRole("tab", { name: /技能 2/ }).count(),
      1,
      "the extension categories should render as a counted side navigation",
    );
    assert.equal(
      await page.getByRole("article").count(),
      2,
      "the selected category should render its compact operational rows",
    );
    assert.equal(
      await page
        .locator('[data-view="extensions"] > div')
        .evaluate((element) => getComputedStyle(element).borderTopWidth),
      "0px",
      "the extension workspace must not sit inside another bordered card",
    );
    assert.deepEqual(
      await page.locator('[data-view="extensions"] > div').evaluate((element) => {
        const sidebar = element.querySelector("aside");
        const workspace = element.querySelector("main");
        const style = getComputedStyle(element);
        const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null;
        const workspaceStyle = workspace ? getComputedStyle(workspace) : null;
        const sidebarBackground = sidebarStyle?.backgroundColor;
        const workspaceBackground = workspaceStyle?.backgroundColor;
        return {
          sidebarWidth: style.gridTemplateColumns.split(" ")[0],
          gap: style.gap,
          pageBackground: style.backgroundColor,
          matchingSurfaceBackgrounds: sidebarBackground === workspaceBackground,
          sidebarRadius: sidebarStyle?.borderRadius,
          workspaceRadius: workspaceStyle?.borderRadius,
        };
      }),
      {
        sidebarWidth: "244px",
        gap: "10px",
        pageBackground: "rgba(0, 0, 0, 0)",
        matchingSurfaceBackgrounds: true,
        sidebarRadius: "12px",
        workspaceRadius: "12px",
      },
      "extensions should reuse the employee page's two independent surface layout",
    );

    const search = page.getByRole("searchbox", { name: "搜索扩展" });
    await search.focus();
    assert.deepEqual(
      await search.evaluate((element) => {
        const field = element.closest("label");
        const style = field ? getComputedStyle(field) : null;
        return { outlineWidth: style?.outlineWidth, boxShadow: style?.boxShadow };
      }),
      { outlineWidth: "1px", boxShadow: "none" },
      "search focus should use a quiet single-pixel outline instead of a heavy ring",
    );
    await search.fill("dogfood");
    assert.equal(await page.getByRole("article").count(), 1, "search should narrow the active extension category");
    await page.getByText("Dogfood", { exact: true }).waitFor();
    await page.getByRole("button", { name: "清除筛选" }).click();

    await page.getByRole("combobox", { name: "按来源筛选" }).selectOption("native");
    assert.equal(
      await page.getByRole("article").count(),
      1,
      "source filtering should use normalized inventory provenance",
    );
    await page.getByText("Grove Guide", { exact: true }).waitFor();
    await page.getByRole("button", { name: "清除筛选" }).click();

    await page.getByRole("combobox", { name: "按部署状态筛选" }).selectOption("disabled");
    assert.equal(await page.getByRole("article").count(), 1, "status filtering should reflect enabled deployments");
    await page.getByText("Grove Guide", { exact: true }).waitFor();
    await page.getByRole("button", { name: "清除筛选" }).click();

    await page.getByRole("combobox", { name: "按目标内核筛选" }).selectOption("codex");
    assert.equal(await page.getByRole("article").count(), 1, "kernel filtering should match deployment targets");
    await page.getByText("Dogfood", { exact: true }).waitFor();
    await page.getByRole("button", { name: "清除筛选" }).click();

    const dogfoodRow = page.getByRole("article").filter({ hasText: "Dogfood" });
    await dogfoodRow.getByRole("button", { name: "发布", exact: true }).click();
    await page.getByRole("button", { name: "Claude Agent", exact: true }).click();
    assert.deepEqual(
      await page.evaluate(() => window.__extensionActions.at(-1)),
      {
        path: "/extensions/skills/publish",
        payload: {
          librarySkillId: "dogfood",
          targetKernelIds: ["claude-code"],
          scope: "user",
          replace: false,
        },
      },
      "the redesign must preserve the existing skill publication contract",
    );

    await page.getByRole("tab", { name: /MCP 服务 1/ }).click();
    await page.getByRole("heading", { name: "MCP 服务", exact: true }).waitFor();
    assert.equal(await page.getByRole("article").count(), 1, "category navigation should switch the operational list");

    await page.setViewportSize({ width: 720, height: 860 });
    assert.equal(
      await page
        .locator('[data-view="extensions"] > div')
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
      1,
      "the extension workspace should collapse to one column on narrow screens",
    );
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-extensions-ui harness ok");

function entrySource(component, globalStyles) {
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import type { BridgeSettings, ExtensionInventoryRecord } from ${JSON.stringify(join(projectRoot, "web/src/bridge.ts"))};
    import { ExtensionsView } from ${JSON.stringify(component)};
    import ${JSON.stringify(globalStyles)};

    const deployment = (overrides: Record<string, unknown>) => ({
      id: "deployment",
      itemId: "item",
      kind: "skill",
      scope: "user",
      status: "available",
      enabled: true,
      managedByOpenGrove: false,
      readonly: false,
      system: false,
      metadata: {},
      ...overrides,
    });

    const item = (overrides: Record<string, unknown>) => ({
      id: "item",
      kind: "skill",
      name: "item",
      title: "Item",
      description: "",
      enabled: true,
      managedByOpenGrove: false,
      readonly: false,
      system: false,
      source: { origin: "local", path: "/skills/item" },
      deployments: [],
      permissions: [],
      commandUsages: [],
      childIds: [],
      tags: [],
      metadata: {},
      ...overrides,
    });

    const extensions: ExtensionInventoryRecord = {
      scannedAt: new Date(0).toISOString(),
      workspaceRoot: "/workspace",
      items: [
        item({
          id: "skill-dogfood",
          name: "dogfood",
          title: "Dogfood",
          description: "Exploratory QA of web apps.",
          source: { origin: "local", path: "/skills/dogfood" },
          deployments: [
            deployment({
              id: "dogfood-library",
              itemId: "skill-dogfood",
              scope: "managed",
              managedByOpenGrove: true,
              sourcePath: "/skills/dogfood",
            }),
            deployment({
              id: "dogfood-codex",
              itemId: "skill-dogfood",
              kernelId: "codex",
              targetPath: "/codex/skills/dogfood",
              managedByOpenGrove: true,
            }),
          ],
        }),
        item({
          id: "skill-guide",
          name: "grove-guide",
          title: "Grove Guide",
          description: "Guide OpenGrove users through local setup.",
          enabled: false,
          readonly: true,
          system: true,
          source: { origin: "system", path: "/bundled/grove-guide" },
          deployments: [
            deployment({
              id: "guide-library",
              itemId: "skill-guide",
              enabled: false,
              scope: "managed",
              managedByOpenGrove: true,
              readonly: true,
              system: true,
            }),
          ],
        }),
        item({
          id: "mcp-files",
          kind: "mcp",
          name: "files",
          title: "Files MCP",
          description: "Local file access server.",
          deployments: [
            deployment({
              id: "mcp-files-codex",
              itemId: "mcp-files",
              kind: "mcp",
              kernelId: "codex",
              configPath: "/codex/config.toml",
            }),
          ],
        }),
      ],
      deployments: [],
      commandUsages: [],
      summary: { itemCount: 3, deploymentCount: 4, enabledDeploymentCount: 3 },
    };

    const settings = {
      kernel: "codex",
      activeKernel: "codex",
      activeModel: "gpt-5",
      kernels: [
        { id: "codex", label: "Codex", available: true },
        { id: "claude-code", label: "Claude Agent", available: true },
      ],
      kernelProxy: { enabled: false },
    } as BridgeSettings;

    window.__extensionActions = [];
    document.documentElement.style.setProperty("--opengrove-sidebar-width", "244px");
    localStorage.setItem("opengroveLanguage", "zh-CN");
    createRoot(document.getElementById("root")!).render(
      <ExtensionsView
        extensions={extensions}
        settings={settings}
        onAction={(path, payload) => window.__extensionActions.push({ path, payload })}
      />,
    );
  `;
}
