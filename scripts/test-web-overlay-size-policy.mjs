import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { tailwindStylesPlugin } from "./esbuild-tailwind-plugin.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-overlay-size-policy-"));
const entryPath = join(tempDir, "entry.tsx");
const bundlePath = join(tempDir, "entry.js");
const htmlPath = join(tempDir, "index.html");
const globalStylesPath = join(projectRoot, "web/src/styles.css");
const expectedSizes = {
  compact: { minWidth: "140px", maxWidth: "200px", usedMin: 140, usedMax: 200 },
  content: { minWidth: "160px", maxWidth: "260px", usedMin: 160, usedMax: 260 },
  regular: { minWidth: "232px", maxWidth: "280px", usedMin: 232, usedMax: 280 },
  wide: { minWidth: "280px", maxWidth: "320px", usedMin: 280, usedMax: 320 },
  picker: { minWidth: "320px", maxWidth: "360px", usedMin: 320, usedMax: 360 },
};

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
    plugins: [tailwindStylesPlugin(globalStylesPath)],
  });
  await writeFile(
    htmlPath,
    '<!doctype html><html><head><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script src="./entry.js"></script></body></html>',
    "utf8",
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    for (const [size, expected] of Object.entries(expectedSizes)) {
      await page.goto(`${pathToFileURL(htmlPath).href}?size=${size}&kind=menu`);
      await page.getByRole("button", { name: "Actions" }).click();
      const menu = page.getByRole("menu");
      await menu.waitFor();
      assert.equal(await menu.getAttribute("role"), "menu", "MotionMenu must retain its menu role");
      assert.equal(await menu.getAttribute("aria-label"), `actions-${size}`, "MotionMenu must retain its label");
      assert.equal(
        await menu.getByRole("menuitem", { name: "Run action" }).count(),
        1,
        "MotionMenu must retain action-menu semantics",
      );

      const menuMetrics = await surfaceMetrics(menu);
      assert.deepEqual(
        surfaceContract(menuMetrics),
        {
          minWidth: expected.minWidth,
          maxWidth: expected.maxWidth,
          dataSize: size,
          boxSizing: "border-box",
        },
        `MotionMenu must consume the shared ${size} surface size`,
      );
      assertUsedWidth(menuMetrics.width, expected, `MotionMenu ${size}`);

      await page.goto(`${pathToFileURL(htmlPath).href}?size=${size}&kind=select`);
      await page.getByRole("button", { name: "Choose value" }).click();
      const popover = page.getByRole("listbox");
      await popover.waitFor();
      assert.equal(
        await popover.getByRole("option", { name: "Choose value" }).count(),
        1,
        "MotionPopover must retain selection semantics when used by a Select",
      );

      const popoverMetrics = await surfaceMetrics(popover);
      assert.deepEqual(
        surfaceContract(popoverMetrics),
        surfaceContract(menuMetrics),
        `InlineSelect and MotionMenu must resolve identical ${size} width bounds`,
      );
      assertUsedWidth(popoverMetrics.width, expected, `InlineSelect ${size}`);
    }

    await page.goto(`${pathToFileURL(htmlPath).href}?kind=room-select`);
    await page.getByRole("button", { name: "Default access" }).click();
    const descriptivePopover = page.getByRole("listbox");
    await descriptivePopover.waitFor();
    const descriptivePopoverMetrics = await surfaceMetrics(descriptivePopover);
    assert.deepEqual(
      surfaceContract(descriptivePopoverMetrics),
      {
        minWidth: expectedSizes.wide.minWidth,
        maxWidth: expectedSizes.wide.maxWidth,
        dataSize: "wide",
        boxSizing: "border-box",
      },
      "descriptive RoomInlineSelect menus must use the shared wide surface contract",
    );
    assertUsedWidth(descriptivePopoverMetrics.width, expectedSizes.wide, "RoomInlineSelect descriptive menu");

    await page.goto(`${pathToFileURL(htmlPath).href}?kind=room-model-select`);
    const modelTrigger = page.getByRole("button", { name: "Opus 4.8" });
    const modelTriggerWidth = await modelTrigger.evaluate((element) => element.getBoundingClientRect().width);
    await modelTrigger.click();
    const modelPopover = page.getByRole("listbox");
    await modelPopover.waitFor();
    const modelPopoverMetrics = await surfaceMetrics(modelPopover);
    const modelPopoverWidth = Number.parseFloat(modelPopoverMetrics.width);
    assert.deepEqual(
      surfaceContract(modelPopoverMetrics),
      {
        minWidth: expectedSizes.content.minWidth,
        maxWidth: expectedSizes.content.maxWidth,
        dataSize: "content",
        boxSizing: "border-box",
      },
      "plain-text model RoomInlineSelect menus must use the shared content-sized Select contract",
    );
    assert.ok(
      modelPopoverWidth >= modelTriggerWidth && modelPopoverWidth <= expectedSizes.content.usedMax,
      `RoomInlineSelect model menus must respect the trigger and the content width cap; got trigger ${modelTriggerWidth}px and menu ${modelPopoverWidth}px`,
    );
    const opusLineCount = await page
      .getByRole("option", { name: "Claude Opus 4.8", exact: true })
      .evaluate((element) => {
        const label = element.querySelector("strong");
        if (!label) return 0;
        const range = document.createRange();
        range.selectNodeContents(label);
        return range.getClientRects().length;
      });
    assert.equal(
      opusLineCount,
      1,
      "RoomInlineSelect model labels must stay on one line inside the content-sized surface",
    );
    assert.equal(
      await page.getByRole("option", { name: "Claude Fable 5", exact: true }).locator("strong").getAttribute("title"),
      "Claude Fable 5",
      "truncated model titles must remain readable through the native title affordance",
    );

    await page.goto(`${pathToFileURL(htmlPath).href}?kind=employee-model-select`);
    await page.getByRole("button", { name: "Opus 4.8", exact: true }).click();
    const employeeModelPopover = page.getByRole("listbox");
    await employeeModelPopover.waitFor();
    assert.deepEqual(
      surfaceContract(await surfaceMetrics(employeeModelPopover)),
      {
        minWidth: expectedSizes.content.minWidth,
        maxWidth: expectedSizes.content.maxWidth,
        dataSize: "content",
        boxSizing: "border-box",
      },
      "the real EmployeeDialog model picker must use the content-sized Select contract",
    );
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-overlay-size-policy harness ok");

async function surfaceMetrics(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      width: style.width,
      minWidth: style.minWidth,
      maxWidth: style.maxWidth,
      dataSize: element.getAttribute("data-size"),
      boxSizing: style.boxSizing,
    };
  });
}

function surfaceContract(metrics) {
  const { width: _width, ...contract } = metrics;
  return contract;
}

function assertUsedWidth(width, expected, label) {
  const widthPx = Number.parseFloat(width);
  assert.ok(
    widthPx >= expected.usedMin && widthPx <= expected.usedMax,
    `${label} must render inside the shared ${expected.usedMin}–${expected.usedMax}px bounds; got ${width}`,
  );
}

function entrySource() {
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { InlineSelect } from ${JSON.stringify(join(projectRoot, "web/src/components/sidebar/settings-inline-select.tsx"))};
    import { EmployeeDialog } from ${JSON.stringify(join(projectRoot, "web/src/components/rooms/employee-dialog.tsx"))};
    import { RoomInlineSelect } from ${JSON.stringify(join(projectRoot, "web/src/components/rooms/room-inline-select.tsx"))};
    import { MotionMenu, MotionMenuItem } from ${JSON.stringify(join(projectRoot, "web/src/components/ui/motion/menu.tsx"))};
    import type { BoundedOverlaySurfaceSize } from ${JSON.stringify(join(projectRoot, "web/src/components/ui/motion/overlay-surface.ts"))};
    import ${JSON.stringify(globalStylesPath)};

    const params = new URL(window.location.href).searchParams;
    const size = (params.get("size") ?? "content") as BoundedOverlaySurfaceSize;
    const kind = params.get("kind") ?? "menu";

    function Fixture() {
      const [open, setOpen] = useState(false);
      return kind === "menu" ? (
        <main style={{ padding: 80 }}>
          <MotionMenu
            open={open}
            onOpenChange={setOpen}
            size={size}
            ariaLabel={\`actions-\${size}\`}
            align="start"
            trigger={<button type="button">Actions</button>}
          >
            <MotionMenuItem>Run action</MotionMenuItem>
          </MotionMenu>
        </main>
      ) : kind === "select" ? (
        <main style={{ padding: 80 }}>
          <InlineSelect
            value="choice"
            options={[{ id: "choice", label: "Choose value" }]}
            menuSize={size}
            align="start"
            onChange={() => undefined}
          />
        </main>
      ) : kind === "room-select" ? (
        <main style={{ width: 140, padding: 80 }}>
          <RoomInlineSelect
            value="default"
            menuSize="wide"
            options={[
              { id: "default", label: "Default access", description: "Follow the current kernel rules and ask before risky operations" },
              { id: "review", label: "Auto review", description: "Ask only when a risky operation is detected" },
              { id: "full", label: "Full access", description: "Minimize interruptions while retaining kernel safeguards" },
            ]}
            onChange={() => undefined}
          />
        </main>
      ) : kind === "employee-model-select" ? (
        <main style={{ width: 420, padding: 40 }}>
          <EmployeeDialog
            embedded
            open
            activeTab="runtime"
            activeKernel="codex"
            activeModel="opus"
            runtimeControls={{
              kernel: "codex",
              models: [
                { id: "opus", label: "Opus 4.8" },
                { id: "fable", label: "Fable 5 with an intentionally long model name" },
              ],
              reasoningEfforts: [],
            }}
            kernelOptions={[{ id: "codex", label: "Codex", available: true, installed: true }]}
            providers={undefined}
            modelProviderBindings={undefined}
            initialMember={{
              id: "employee-overlay-test",
              name: "Overlay tester",
              kernel: "codex",
              model: "opus",
              role: "Test overlay sizing",
              status: "idle",
              color: "#2563eb",
              lastActive: "",
              source: "local",
            }}
            showTabs={false}
            showPreview={false}
            showCancel={false}
            showRuntimeNote={false}
            showSubmitActions={false}
            onOpenChange={() => undefined}
            onCreate={() => undefined}
          />
        </main>
      ) : (
        <main style={{ width: 110, padding: 80 }}>
          <RoomInlineSelect
            value="opus"
            menuSize="content"
            options={[
              { id: "opus", label: "Opus 4.8" },
              { id: "claude-opus", label: "Claude Opus 4.8" },
              { id: "claude-fable", label: "Claude Fable 5" },
              { id: "claude-sonnet", label: "Claude Sonnet 5" },
            ]}
            onChange={() => undefined}
          />
        </main>
      );
    }

    createRoot(document.getElementById("root")!).render(<Fixture />);
  `;
}
