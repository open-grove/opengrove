import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "opengrove-file-conflicts-"));
let browser;
try {
  const entry = join(temporary, "entry.tsx");
  await writeFile(
    entry,
    `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { FilePreviewPanel } from ${JSON.stringify(join(root, "web/src/components/shared/file-preview-panel.tsx"))};
    import { FileSaveConflict } from ${JSON.stringify(join(root, "web/src/components/shared/file-draft.ts"))};
    const initial = { content: "# Original\\n\\nBase paragraph.\\n", revision: "1" };
    let disk = JSON.parse(localStorage.getItem("fixture:disk") || "null") || initial;
    window.saves = [];
    window.disk = disk;
    function Harness() {
      const [file, setFile] = useState(disk);
      const [path, setPath] = useState("outline.md");
      window.selectFile = setPath;
      window.replaceFile = (content) => {
        disk = { content, revision: disk.revision === "missing" ? "1" : String(Number(disk.revision) + 1) };
        localStorage.setItem("fixture:disk", JSON.stringify(disk));
        window.disk = disk;
        setFile(disk);
      };
      window.deleteFile = () => {
        disk = { content: "", revision: "missing" };
        window.disk = disk;
        localStorage.setItem("fixture:disk", JSON.stringify(disk));
        setFile(disk);
      };
      return <FilePreviewPanel key={path} selectedPath={path} loading={false} draftKey={"fixture:" + path}
        revision={file.revision} file={{ path, name: path, mimeType: "text/markdown", content: file.content }}
        onDirtyStateChange={(state) => { window.dirtyState = state; }}
        onSaveText={async (content, expectedRevision) => {
          window.saves.push({ content, expectedRevision, path });
          if (window.holdNextSave) {
            window.holdNextSave = false;
            await new Promise((resolve) => { window.releaseSave = resolve; });
          }
          if (window.failSave) throw new Error("network unavailable");
          if (expectedRevision !== disk.revision) throw new FileSaveConflict();
          window.replaceFile(content);
          return disk;
        }} />;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `,
  );
  await build({
    entryPoints: [entry],
    outfile: join(temporary, "entry.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    nodePaths: [join(root, "node_modules")],
    define: { "import.meta.env": "{}" },
  });
  const html = join(temporary, "index.html");
  await writeFile(
    html,
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="entry.css"><style>body{margin:24px;font-family:system-ui}#root{height:850px}.file-preview-workbench{height:100%}</style><div id="root"></div><script src="entry.js"></script>',
  );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
  page.on("dialog", (dialog) => dialog.accept());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(html).href);
  const editor = page.locator(".milkdown .ProseMirror");
  await expect(editor).toContainText("Original");
  await page.waitForTimeout(400);
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("Human draft.");
  // An external refresh immediately after input must see the draft as dirty.
  await page.evaluate(() => window.replaceFile("# Agent version\n\nExternal edit.\n"));
  await expect(page.getByText(/automatic saving is paused/)).toBeVisible();
  await expect(editor).toContainText("Human draft.");
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.saves.length), 0, "conflicted drafts must not autosave");
  assert.equal(
    await page.evaluate(() => window.dirtyState.save()),
    false,
    "conflicts require explicit review to write",
  );
  assert.equal(await page.evaluate(() => window.dirtyState.preserve()), true, "a durable conflict permits navigation");
  await page.reload();
  await expect(editor).toContainText("Human draft.");
  await expect(page.getByText(/automatic saving is paused/)).toBeVisible();
  await page.getByRole("button", { name: "Compare changes", exact: true }).click();
  const left = page.locator(".cm-merge-a .cm-content");
  const right = page.locator(".cm-merge-b .cm-content");
  await expect(left).toContainText("Agent version");
  await expect(right).toContainText("Human draft.");
  if (process.env.OPENGROVE_TEST_SCREENSHOT) await page.screenshot({ path: process.env.OPENGROVE_TEST_SCREENSHOT });
  await page.evaluate(() => window.replaceFile("# Newer Agent version\n\nAnother edit.\n"));
  await expect(page.getByRole("button", { name: "Save reviewed result" })).toBeDisabled();
  await expect(right).toContainText("Human draft.");
  await page.getByRole("button", { name: "Compare changes", exact: true }).click();
  await expect(left).toContainText("Newer Agent version");
  await page.getByRole("button", { name: "Copy entire disk version to result" }).click();
  await expect(right).toContainText("Newer Agent version");
  await right.press("ControlOrMeta+z");
  await expect(right).toContainText("Human draft.");
  await right.click();
  await right.press("ControlOrMeta+a");
  await page.keyboard.insertText("# Reviewed result\n\nHuman and Agent edits kept.\n");
  await page.evaluate(() => {
    window.failSave = true;
  });
  await page.getByRole("button", { name: "Save reviewed result" }).click();
  await expect(page.getByText(/The result was not saved/)).toBeVisible();
  await expect(right).toContainText("Human and Agent edits kept.");
  await page.evaluate(() => {
    window.failSave = false;
  });
  await page.getByRole("button", { name: "Save reviewed result" }).click();
  await expect(editor).toContainText("Reviewed result");
  assert.equal(await page.evaluate(() => window.disk.content), "# Reviewed result\n\nHuman and Agent edits kept.\n");
  await expect.poll(() => page.evaluate(() => window.dirtyState.dirty)).toBe(false);
  assert.equal(
    await page.evaluate(
      () => Object.keys(localStorage).filter((key) => key.startsWith("opengrove:file-draft:")).length,
    ),
    0,
  );

  // Input during an in-flight save must remain dirty and save with the returned revision.
  await page.evaluate(() => {
    window.holdNextSave = true;
  });
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("First input.");
  await expect.poll(() => page.evaluate(() => typeof window.releaseSave)).toBe("function");
  await page.keyboard.insertText(" Newer input.");
  await page.waitForTimeout(300);
  await page.evaluate(() => window.releaseSave());
  await expect.poll(() => page.evaluate(() => window.disk.content)).toMatch(/First input\. Newer input\./);
  await expect.poll(() => page.evaluate(() => window.dirtyState.dirty)).toBe(false);

  // A failed save and switching away must preserve the draft across a real reload.
  await page.addInitScript(() => {
    window.failSave = true;
  });
  await page.evaluate(() => {
    window.failSave = true;
  });
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText(" Unsaved recovery.");
  await expect(page.getByText("Save failed. Your draft is still here.")).toBeVisible();
  assert.equal(await page.evaluate(() => window.dirtyState.save()), false);
  await page.evaluate(() => window.selectFile("other.md"));
  await expect(editor).not.toContainText("Unsaved recovery.");
  await page.evaluate(() => window.selectFile("outline.md"));
  await expect(editor).toContainText("Unsaved recovery.");
  await page.reload();
  await expect(editor).toContainText("Unsaved recovery.");
  await page.evaluate(() => window.deleteFile());
  await expect(page.getByText("This file was deleted from disk. Saving will recreate it.")).toBeVisible();
  await expect(editor).toContainText("Unsaved recovery.");
  await page.reload();
  await expect(editor).toContainText("Unsaved recovery.");
  await page.getByRole("button", { name: "Compare changes", exact: true }).click();
  await expect(left).toHaveText("");
  await expect(right).toContainText("Unsaved recovery.");
  await page.evaluate(() => {
    window.failSave = false;
  });
  await page.getByRole("button", { name: "Save reviewed result" }).click();
  await expect(editor).toContainText("Unsaved recovery.");
  assert.notEqual(await page.evaluate(() => window.disk.revision), "missing");
  // Storage failure must be visible; an in-memory draft is not durable recovery.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "drafts") throw new DOMException("quota exceeded", "QuotaExceededError");
      return put.apply(this, args);
    };
    window.failSave = true;
  });
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText(" Storage unavailable.");
  await expect(page.getByText(/The draft could not be stored locally/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download my draft" })).toBeVisible();
  assert.equal(await page.evaluate(() => window.dirtyState.preserve()), false, "failed backup must block navigation");
  assert.deepEqual(errors, []);
  console.log("web-file-save-conflicts passed");
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
