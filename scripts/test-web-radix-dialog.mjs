import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { tailwindStylesPlugin } from "./esbuild-tailwind-plugin.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-radix-dialog-"));
const entryPath = join(tempDir, "radix-dialog-entry.tsx");
const bundlePath = join(tempDir, "radix-dialog-entry.js");
const htmlPath = join(tempDir, "index.html");
const globalStylesPath = resolve(projectRoot, "web/src/styles.css");

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
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  await writeFile(
    htmlPath,
    [
      "<!doctype html>",
      "<html>",
      '<head><meta charset="utf-8"><title>Radix Dialog ref probe</title><link rel="stylesheet" href="./radix-dialog-entry.css"></head>',
      '<body><div id="root"></div><script src="./radix-dialog-entry.js"></script></body>',
      "</html>",
    ].join("\n"),
    "utf8",
  );

  await runBrowserHarness(htmlPath);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function runBrowserHarness(path) {
  const browser = await launchChromiumForHarness();

  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(pathToFileURL(path).href);
    await page.waitForTimeout(500);

    const renderCount = await page.evaluate(() => globalThis.__opengroveRadixDialogRenderCount);
    const dialogCount = await page.locator('[role="dialog"]').count();

    assert.deepEqual(pageErrors, [], `Dialog triggered a React renderer error:\n${pageErrors.join("\n")}`);
    assert.ok(renderCount < 25, `Dialog entered a ref-driven render loop (${renderCount} renders)`);
    assert.equal(dialogCount, 1, "Dialog should remain mounted");

    const input = page.getByRole("textbox", { name: "Group name" });
    await input.waitFor();
    assert.equal(
      await input.evaluate((element) => document.activeElement === element),
      true,
      "the create-group name field should receive initial focus",
    );
    const focusStyle = await input.evaluate((element) => {
      const inputStyle = getComputedStyle(element);
      const dialog = element.closest('[role="dialog"]');
      return {
        outlineStyle: inputStyle.outlineStyle,
        boxShadow: inputStyle.boxShadow,
        borderRadius: inputStyle.borderRadius,
        dialogWidth: dialog?.getBoundingClientRect().width,
      };
    });
    assert.equal(focusStyle.outlineStyle, "none", "the global bright-blue outline must be suppressed");
    assert.notEqual(focusStyle.boxShadow, "none", "focused inputs still need a visible, tokenized focus cue");
    assert.equal(focusStyle.borderRadius, "10px", "the name field should use the shared input radius");
    assert.equal(focusStyle.dialogWidth, 460, "the one-field dialog should remain compact");
    if (process.env.OPENGROVE_DIALOG_SCREENSHOT) {
      await page.screenshot({ path: process.env.OPENGROVE_DIALOG_SCREENSHOT });
    }
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Open uninstall choice" }).click();
    const uninstallDialog = page.getByRole("dialog", { name: "Remove App?" });
    await uninstallDialog.waitFor();
    const keepDraftButton = uninstallDialog.getByRole("button", { name: "Keep draft and uninstall" });
    const deleteDraftButton = uninstallDialog.getByRole("button", { name: "Delete draft too" });
    assert.equal(
      await keepDraftButton.getAttribute("class"),
      "primary-button",
      "the safe default uninstall choice must use the primary button style",
    );
    assert.equal(
      await deleteDraftButton.getAttribute("class"),
      "danger-button confirm-dialog-alternate",
      "the irreversible draft deletion choice must use the danger button style",
    );
    await uninstallDialog.getByRole("button", { name: "Delete draft too" }).click();
    await page.waitForFunction(() => globalThis.__opengroveConfirmResults?.length === 1);

    await page.getByRole("button", { name: "Open uninstall choice" }).click();
    await page
      .getByRole("dialog", { name: "Remove App?" })
      .getByRole("button", { name: "Keep draft and uninstall" })
      .click();
    await page.waitForFunction(() => globalThis.__opengroveConfirmResults?.length === 2);

    await page.getByRole("button", { name: "Open uninstall choice" }).click();
    await page.getByRole("dialog", { name: "Remove App?" }).getByRole("button", { name: "Cancel" }).click();
    await page.waitForFunction(() => globalThis.__opengroveConfirmResults?.length === 3);

    assert.deepEqual(
      await page.evaluate(() => globalThis.__opengroveConfirmResults),
      ["alternate", "primary", null],
      "confirm must return the user's explicit three-state choice",
    );

    console.log("web-radix-dialog-harness ok");
  } finally {
    await browser.close();
  }
}

async function launchChromiumForHarness() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) {
      throw error;
    }
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

function entrySource() {
  const dialogPath = resolve(projectRoot, "web/src/components/ui/dialog.tsx");
  const mountedAppStylesPath = resolve(projectRoot, "web/src/components/apps/mounted-app-workbench.css");
  const confirmPath = resolve(projectRoot, "web/src/components/ui/confirm-dialog.tsx");

  return `
    import React, { useReducer, useState } from "react";
    import { createRoot } from "react-dom/client";
    import ${JSON.stringify(globalStylesPath)};
    import ${JSON.stringify(mountedAppStylesPath)};
    import { ConfirmProvider, useConfirm } from ${JSON.stringify(confirmPath)};
    import {
      Dialog,
      DialogContent,
      DialogTitle,
    } from ${JSON.stringify(dialogPath)};

    globalThis.__opengroveRadixDialogRenderCount = 0;
    globalThis.__opengroveConfirmResults = [];

    function ConfirmChoiceProbe() {
      const confirm = useConfirm();
      return <button onClick={async () => {
        const result = await confirm({
          title: "Remove App?",
          body: "Keep or delete its local draft.",
          confirmLabel: "Keep draft and uninstall",
          alternateLabel: "Delete draft too",
          cancelLabel: "Cancel",
          alternateDanger: true,
        });
        globalThis.__opengroveConfirmResults.push(result);
      }}>Open uninstall choice</button>;
    }

    function Probe({ onClose }) {
      globalThis.__opengroveRadixDialogRenderCount += 1;
      const [, forceRender] = useReducer((count) => count + 1, 0);

      return (
        <Dialog open>
          <DialogContent
            className="mounted-app-create-group-dialog"
            aria-label="New group"
            aria-describedby="radix-dialog-probe-description"
            ref={(node) => {
              if (node) forceRender();
            }}
          >
            <DialogTitle>New group</DialogTitle>
            <form className="mounted-app-create-group-form">
              <label className="mounted-app-create-group-field">
                <span>Group name</span>
                <input autoFocus defaultValue="Drama Studio group 2" />
              </label>
              <div className="modal-actions">
                <button className="ghost-button" type="button" onClick={onClose}>Cancel</button>
                <button className="primary-button" type="submit">Create</button>
              </div>
            </form>
            <p id="radix-dialog-probe-description" hidden>Verifies React 19 callback-ref stability.</p>
          </DialogContent>
        </Dialog>
      );
    }

    function Harness() {
      const [probeOpen, setProbeOpen] = useState(true);
      return <>
        {probeOpen ? <Probe onClose={() => setProbeOpen(false)} /> : null}
        <ConfirmChoiceProbe />
      </>;
    }

    createRoot(document.getElementById("root")).render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );
  `;
}
