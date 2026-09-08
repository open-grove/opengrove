import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  // Wait beyond initialization and the autosave delay to catch unintended writes.
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

  // A real edit immediately after an external refresh must still save.
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
    import { ToastProvider } from ${JSON.stringify(resolve(projectRoot, "web/src/components/ui/toast.tsx"))};
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
        revision={content}
        onDirtyStateChange={(state) => { window.dirty = state.dirty; }}
        onSaveText={async (value) => { window.saves.push(value); setContent(value); return { content: value, revision: value }; }}
      />;
    }
    function WorkbenchHarness() {
      const [path, setPath] = useState("");
      window.selectWorkbenchFile = setPath;
      return <MountedAppWorkbench
        app={{ name: "refresh-harness", metadata: { ui: { tabs: [{ component: "file-tree", label: "Files" }, { component: "dashboard", label: "Dashboard", source: { type: "local_mock" } }] } }, deployments: [] }}
        selectedPath={path}
        onSelectedPathChange={setPath}
      />;
    }
    window.__OPENGROVE_API_BASE__ = "http://opengrove.test/api/";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    createRoot(document.getElementById("root")).render(
      <QueryClientProvider client={queryClient}><ConfirmProvider><ToastProvider>
        {location.search ? <WorkbenchHarness /> : <Harness />}
      </ToastProvider></ConfirmProvider></QueryClientProvider>
    );
  `;
}

async function checkWorkbenchPolling(page, htmlPath) {
  const revisionFor = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  let content = initialContent;
  let reads = 0;
  const writes = [];
  let allowWrites = false;
  let conflictNextSave = false;
  let missingFile = false;
  let missingReads = 0;
  let holdFiles = false;
  let releaseFiles;
  const entry = { name: "outline.md", path: "outline.md", kind: "file", mimeType: "text/markdown" };
  const other = { ...entry, name: "other.md", path: "other.md" };
  await page.route("http://opengrove.test/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body;
    if (request.method() !== "GET") {
      writes.push(request.postData());
      if (!allowWrites) throw new Error("Unexpected write while viewing");
      const expected = new URL(request.url()).searchParams.get("expectedRevision");
      if (conflictNextSave) {
        conflictNextSave = false;
        content = "# Concurrent Agent write\n\nKeep this edit.\n";
      }
      if (expected !== revisionFor(content)) {
        await route.fulfill({ status: 409, json: { ok: false, error: "workspace_file_conflict" } });
      } else {
        content = request.postData();
        await route.fulfill({ json: { ok: true, revision: revisionFor(content), entry, entries: [entry, other] } });
      }
      return;
    }
    if (path.endsWith("/files")) {
      if (holdFiles)
        await new Promise((resolve) => {
          releaseFiles = resolve;
        });
      body = {
        app: { id: "fixture", workspaceRoot: "/fixture/workspace" },
        ok: true,
        entries: [entry, other],
        truncated: false,
        revision: String(reads),
      };
    } else if (path.endsWith("/dashboard")) {
      body = { ok: true, items: [], source: "local_mock" };
    } else if (path.endsWith("/flows")) {
      body = { ok: true, flows: [], revision: "1" };
    } else if (path.endsWith("/file")) {
      reads++;
      if (missingFile) {
        missingReads++;
        await route.fulfill({ status: 404, json: { error: "app_file_not_found", revision: "missing" } });
        return;
      }
      const isOther = new URL(request.url()).searchParams.get("path") === "other.md";
      body = {
        ok: true,
        file: { ...(isOther ? other : entry), content: isOther ? "# Other file\n" : content },
        revision: revisionFor(isOther ? "# Other file\n" : content),
      };
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
  // Reading a normalized Markdown document and switching files must also avoid a write.
  await page.getByText("other.md", { exact: true }).click();
  await expect(editor).toContainText("Other file");
  await page.getByText("outline.md", { exact: true }).click();
  await expect(editor).toContainText("English Chapter");
  assert.equal(writes.length, 0);
  allowWrites = true;
  conflictNextSave = true;
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("My workbench edit.");
  await expect(page.getByText(/automatic saving is paused/)).toBeVisible();
  await expect(editor).toContainText("My workbench edit.");
  assert.equal(writes.length, 1, "a rejected save must stop retrying automatically");
  await page.getByText("other.md", { exact: true }).click();
  await expect(editor).toContainText("Other file");
  await page.getByText("outline.md", { exact: true }).click();
  await expect(editor).toContainText("My workbench edit.");
  await page.getByRole("tab", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Dashboard", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(editor).toHaveCount(0);
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByText("outline.md", { exact: true }).click();
  await expect(editor).toContainText("My workbench edit.");
  await page.getByRole("button", { name: "Compare changes", exact: true }).click();
  await expect(page.locator(".cm-merge-a .cm-content")).toContainText("Concurrent Agent write");
  const result = page.locator(".cm-merge-b .cm-content");
  await expect(result).toContainText("My workbench edit.");
  await result.click();
  await result.press("ControlOrMeta+a");
  await page.keyboard.insertText("# Final workbench result\n\nBoth changes reviewed.\n");
  await page.getByRole("button", { name: "Save reviewed result" }).click();
  await expect(editor).toContainText("Final workbench result");
  assert.equal(content, "# Final workbench result\n\nBoth changes reviewed.\n");
  await page.getByText("other.md", { exact: true }).click();
  await expect(editor).toContainText("Other file");
  await page.getByText("outline.md", { exact: true }).click();
  conflictNextSave = true;
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("Restore deleted draft.");
  await expect(page.getByText(/automatic saving is paused/)).toBeVisible();
  await page.getByText("other.md", { exact: true }).click();
  await expect(editor).toContainText("Other file");

  // A deleted-file 404 has no App metadata. Wait for stable workspace identity,
  // then recover under the same key even if the directory response arrives late.
  missingFile = true;
  holdFiles = true;
  await page.goto(`${pathToFileURL(htmlPath).href}?workbench-missing`);
  await expect.poll(() => typeof releaseFiles).toBe("function");
  await page.evaluate(() => window.selectWorkbenchFile("outline.md"));
  await expect.poll(() => missingReads).toBeGreaterThan(0);
  await expect(editor).toHaveCount(0);
  holdFiles = false;
  releaseFiles();
  await expect(editor).toContainText("Restore deleted draft.");
  await expect(page.getByText(/automatic saving is paused/)).toBeVisible();
  const writesBeforeDiscard = writes.length;
  await page.getByRole("button", { name: "Discard my draft", exact: true }).click();
  await expect(editor).not.toContainText("Restore deleted draft.");
  await page.waitForTimeout(900);
  assert.equal(writes.length, writesBeforeDiscard, "discard adopts disk without writing");

  // Failed backup prevents navigation with a visible explanation.
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  await editor.click();
  await page.keyboard.insertText("Only in memory.");
  await page.getByText("other.md", { exact: true }).click();
  await expect(editor).toContainText("Only in memory.");
  await expect(page.getByText(/Your latest changes could not be backed up/)).toBeVisible();
}
