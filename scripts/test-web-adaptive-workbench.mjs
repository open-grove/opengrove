import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const project = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "opengrove-adaptive-workbench-"));
let browser;
let server;
try {
  const source = `
    import React, { useEffect, useRef, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { WorkspaceWorkbenchLayout } from ${JSON.stringify(join(project, "web/src/components/shared/workspace-workbench-layout.tsx"))};
    import { ChatResourcePreviewPanel } from ${JSON.stringify(join(project, "web/src/components/chat/chat-resource-preview-panel.tsx"))};
    import { usePaneVisible } from ${JSON.stringify(join(project, "web/src/components/shared/adaptive-split-layout.tsx"))};
    import ${JSON.stringify(join(project, "web/src/components/apps/mounted-app-workbench.css"))};
    function Chat() {
      const visible = usePaneVisible();
      const id = useRef(crypto.randomUUID());
      return <aside className="mounted-app-chat-pane" data-chat-instance={id.current} data-visible={String(visible)}><textarea aria-label="Message draft" defaultValue="" /></aside>;
    }
    function App() {
      const [pane, setPane] = useState("workspace");
      const [detail, setDetail] = useState(false);
      const [preview, setPreview] = useState(false);
      return <><WorkspaceWorkbenchLayout pane={pane} onPaneChange={setPane} detailOpen={detail} onOpenDirectory={() => setDetail(false)}
        editorTopbar={<header>Project</header>}
        directory={<aside className="mounted-app-tree-pane"><button onClick={() => setDetail(true)}>chapter.md</button></aside>}
        directoryResizeHandle={<div className="mounted-app-resize-handle-files" />}
        preview={<section className="mounted-app-preview-pane"><textarea aria-label="File draft" defaultValue="" /><button onClick={() => setPane("chat")}>Attach selection</button><button onClick={() => setPreview(true)}>Preview resource</button></section>}
        chatResizeHandle={<div className="mounted-app-resize-handle-chat" />}
        chat={<Chat />} />{preview ? <ChatResourcePreviewPanel preview={{resource: {id: "resource", title: "chapter.md", origin: "workspace", kind: "file"}, selectedPath: "chapter.md", loading: false, error: "File is unavailable"}} onClose={() => setPreview(false)} /> : null}</>;
    }
    createRoot(document.getElementById("root")).render(<App />);
  `;
  await writeFile(join(root, "entry.tsx"), source);
  await build({
    entryPoints: [join(root, "entry.tsx")],
    outfile: join(root, "bundle.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    nodePaths: [join(project, "node_modules")],
  });
  await writeFile(
    join(root, "index.html"),
    '<html><head><link rel="stylesheet" href="bundle.css"><style>html,body,#root{height:100%;margin:0}button,textarea{box-sizing:border-box}textarea{max-width:100%}</style></head><body><div id="root"></div><script type="module" src="bundle.js"></script></body></html>',
  );
  server = createServer(async (request, response) => {
    const filename = request.url === "/" ? "index.html" : request.url?.slice(1);
    if (!["index.html", "bundle.js", "bundle.css"].includes(filename)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "Content-Type",
      filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : "text/html",
    );
    response.end(await readFile(join(root, filename)));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 664 }, locale: "en-US" });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const chat = page.locator("[data-chat-instance]");
  const instance = await chat.getAttribute("data-chat-instance");
  await expect(page.getByRole("tab", { name: "Workspace", exact: true })).toBeVisible();
  await expect(chat).toBeHidden();
  await expect(chat).toHaveAttribute("data-visible", "false");
  await page.getByRole("button", { name: "chapter.md" }).click();
  await page.getByRole("textbox", { name: "File draft" }).fill("unsaved chapter");
  await page.getByRole("button", { name: "Attach selection" }).click();
  await expect(chat).toBeVisible();
  await expect(chat).toHaveAttribute("data-visible", "true");
  await page.getByRole("textbox", { name: "Message draft" }).fill("unfinished message");
  await page.getByRole("tab", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "File draft" })).toHaveValue("unsaved chapter");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "File draft" })).toBeHidden();
  await page.getByRole("button", { name: "chapter.md" }).click();
  await expect(page.getByRole("textbox", { name: "File draft" })).toHaveValue("unsaved chapter");
  await page.getByRole("tab", { name: "Workspace", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("textbox", { name: "Message draft" })).toHaveValue("unfinished message");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole("tab", { name: "Workspace", exact: true })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "File draft" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message draft" })).toBeVisible();
  const primary = await page.locator(".adaptive-primary-pane").boundingBox();
  const secondary = await chat.boundingBox();
  assert.ok(primary.width > 600 && secondary.width >= 280 && secondary.x > primary.x + primary.width);
  assert.equal(
    await chat.getAttribute("data-chat-instance"),
    instance,
    "Resizing and switching must not remount a chat session",
  );
  await page.setViewportSize({ width: 390, height: 664 });
  await expect(page.getByRole("textbox", { name: "Message draft" })).toHaveValue("unfinished message");
  await page.getByRole("tab", { name: "Workspace", exact: true }).click();
  const previewButton = page.getByRole("button", { name: "Preview resource", exact: true });
  await previewButton.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const dialogBounds = await dialog.boundingBox();
  assert.equal(dialogBounds.width, 390);
  assert.equal(dialogBounds.height, 664);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(previewButton).toBeFocused();
  await expect(page.getByRole("textbox", { name: "File draft" })).toHaveValue("unsaved chapter");
  assert.deepEqual(errors, []);
  console.log("web-adaptive-workbench passed");
} finally {
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await rm(root, { recursive: true, force: true });
}
