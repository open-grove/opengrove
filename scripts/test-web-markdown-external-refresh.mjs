import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-markdown-external-refresh-"));
const initialContent = "# 中文章节\n\n- 原来的中文内容\n";
const externalContent = "# English Chapter\n\n- The replacement written by the employee.\n";
let browser;

try {
  const entryPath = join(tempDir, "entry.tsx");
  await writeFile(entryPath, entrySource());
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    outfile: join(tempDir, "entry.js"),
    nodePaths: [join(projectRoot, "node_modules")],
    loader: { ".css": "empty" },
    define: { "import.meta.env": "{}" },
    logOverride: { "ignored-bare-import": "silent" },
  });
  const htmlPath = join(tempDir, "index.html");
  await writeFile(
    htmlPath,
    '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="./entry.js"></script>',
  );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(htmlPath).href);
  const editor = page.locator(".milkdown .ProseMirror");
  await editor.waitFor();
  // Milkdown notifies after 200 ms; autosave waits another 800 ms.
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.dirty), false, "loading must not mark the draft dirty");
  await page.evaluate((value) => window.replaceFile(value), externalContent);
  await expect(editor).toContainText("English Chapter");
  await page.waitForTimeout(1_400);
  const result = await page.evaluate(() => ({ saves: window.saves, content: window.fileContent, dirty: window.dirty }));
  assert.match(await editor.innerText(), /English Chapter/, "external content must stay visible");
  assert.deepEqual(result.saves, [], "viewing an externally refreshed file must not trigger autosave");
  assert.equal(result.content, externalContent, "external file contents must remain byte-for-byte unchanged");
  assert.equal(result.dirty, false, "external refresh must not mark the draft dirty");

  const finalContent = "# Final Chapter\n\n- The latest external version.\n";
  await page.evaluate((value) => window.replaceFile(value), "# Intermediate Chapter\n");
  await expect(editor).toContainText("Intermediate Chapter");
  await page.evaluate((value) => window.replaceFile(value), finalContent);
  await expect(editor).toContainText("Final Chapter");
  await page.waitForTimeout(1_200);
  assert.deepEqual(await page.evaluate(() => window.saves), [], "successive external updates must not autosave");
  assert.equal(await page.evaluate(() => window.fileContent), finalContent);

  // A real edit arriving before the delayed external notification must still save.
  await page.evaluate((value) => window.replaceFile(value), externalContent);
  await expect(editor).toContainText("English Chapter");
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("User addition.");
  await expect.poll(() => page.evaluate(() => window.saves.length)).toBe(1);
  const saved = await page.evaluate(() => window.fileContent);
  assert.match(saved, /English Chapter/);
  assert.match(saved, /User addition\./);
  assert.doesNotMatch(saved, /中文章节|Final Chapter/);
  await page.waitForTimeout(1_200);
  assert.equal(await page.evaluate(() => window.saves.length), 1, "the save echo must not trigger another save");
  assert.equal(await page.evaluate(() => window.dirty), false);
  await checkWorkbenchPolling(page, htmlPath);
  assert.deepEqual(errors, []);
  console.log("web-markdown-external-refresh passed");
} finally {
  await browser?.close();
  await rm(tempDir, { recursive: true, force: true });
}

function entrySource() {
  const previewPath = resolve(projectRoot, "web/src/components/shared/file-preview-panel.tsx");
  const workbenchPath = resolve(projectRoot, "web/src/components/apps/mounted-app-workbench.tsx");
  const confirmPath = resolve(projectRoot, "web/src/components/ui/confirm-dialog.tsx");
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
    import { FilePreviewPanel } from ${JSON.stringify(previewPath)};
    import { MountedAppWorkbench } from ${JSON.stringify(workbenchPath)};
    import { ConfirmProvider } from ${JSON.stringify(confirmPath)};

    window.saves = [];
    function Harness() {
      const [content, setContent] = useState(${JSON.stringify(initialContent)});
      window.fileContent = content;
      window.replaceFile = setContent;
      return <FilePreviewPanel
        file={{ name: "outline.md", path: "outline.md", mimeType: "text/markdown", content }}
        loading={false}
        selectedPath="outline.md"
        onDirtyStateChange={(state) => { window.dirty = state.dirty; }}
        onSaveText={async (value) => { window.saves.push(value); setContent(value); }}
      />;
    }
    function WorkbenchHarness() {
      const [path, setPath] = useState("");
      return <MountedAppWorkbench
        app={{ name: "refresh-harness", metadata: {}, deployments: [] }}
        selectedPath={path}
        onSelectedPathChange={setPath}
      />;
    }
    window.__OPENGROVE_API_BASE__ = "http://opengrove.test/api/";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    createRoot(document.getElementById("root")).render(
      <QueryClientProvider client={queryClient}><ConfirmProvider>
        {location.search ? <WorkbenchHarness /> : <Harness />}
      </ConfirmProvider></QueryClientProvider>
    );
  `;
}

async function checkWorkbenchPolling(page, htmlPath) {
  let content = initialContent;
  let reads = 0;
  const writes = [];
  const entry = { name: "outline.md", path: "outline.md", kind: "file", mimeType: "text/markdown" };
  await page.route("http://opengrove.test/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body;
    if (request.method() !== "GET") {
      writes.push(request.postData());
      await route.fulfill({ status: 500, body: "Unexpected write while viewing" });
      return;
    }
    if (path.endsWith("/files")) {
      body = { ok: true, entries: [entry], truncated: false, revision: String(reads) };
    } else if (path.endsWith("/flows")) {
      body = { ok: true, flows: [], revision: "1" };
    } else if (path.endsWith("/file")) {
      reads++;
      body = { ok: true, file: { ...entry, content }, revision: String(reads) };
    } else {
      throw new Error(`Unexpected harness request: ${request.url()}`);
    }
    await route.fulfill({ json: body });
  });
  await page.goto(`${pathToFileURL(htmlPath).href}?workbench`);
  await page.getByText("outline.md", { exact: true }).click();
  const editor = page.locator(".milkdown .ProseMirror");
  await expect(editor).toContainText("中文章节");
  content = externalContent;
  await expect(editor).toContainText("English Chapter", { timeout: 5_000 });
  assert.ok(reads >= 2, "a clean open file must continue polling for external changes");
  await page.waitForTimeout(1_200);
  assert.deepEqual(writes, [], "workbench refresh must not write back to the file API");
}
