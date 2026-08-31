import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

import { resolveMcpAppDisplayMode } from "../web/src/components/apps/mcp-app-display-mode.ts";

assert.equal(resolveMcpAppDisplayMode("fullscreen"), "fullscreen");
assert.equal(resolveMcpAppDisplayMode("inline"), "inline");
assert.equal(resolveMcpAppDisplayMode("pip"), "inline");

const projectRoot = resolve(import.meta.dirname, "..");
const viewSource = await readFile(resolve(projectRoot, "web/src/components/apps/mounted-mcp-app-view.tsx"), "utf8");
assert.match(
  viewSource,
  /displayMode:\s*displayModeRef\.current/u,
  "iframe reload must inherit the live host display mode",
);
assert.match(viewSource, /mounted-app-fullscreen-exit/u, "fullscreen must expose a Host-owned exit control");
assert.match(
  viewSource,
  /opengrove\/mcp-app-exit-fullscreen/u,
  "fullscreen must accept relayed Escape from the sandboxed View",
);
assert.match(
  viewSource,
  /const \{ language, t \} = useI18n\(\)/u,
  "MCP App host context must follow the resolved interface language",
);
assert.match(
  viewSource,
  /currentHostContext\.locale === locale[\s\S]*?setHostContext\(nextHostContext\)/u,
  "an in-flight MCP App must receive locale changes without rebuilding the iframe",
);
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-mcp-app-display-mode-"));
const entryPath = join(tempDir, "entry.js");
const bundlePath = join(tempDir, "bundle.js");
const htmlPath = join(tempDir, "index.html");

try {
  await writeFile(
    entryPath,
    `
    import ${JSON.stringify(resolve(projectRoot, "web/src/components/apps/mounted-app-workbench.css"))};
    document.body.innerHTML = ` +
      "`" +
      `
      <main class="app-shell">
        <header class="app-titlebar">OpenGrove</header>
        <aside class="host-sidebar">主导航</aside>
        <section class="mounted-app-web-view" data-display-mode="fullscreen">
          <div class="mounted-app-web-frame-shell">审核 App</div>
        </section>
      </main>
    ` +
      "`" +
      `;
  `,
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  await writeFile(
    htmlPath,
    [
      "<!doctype html>",
      '<html><head><meta charset="utf-8"><link rel="stylesheet" href="./bundle.css"><style>',
      "html,body{margin:0;width:100%;height:100%}",
      ".app-shell{--app-titlebar-height:44px;display:grid;grid-template-columns:260px 1fr;grid-template-rows:44px 1fr;width:100%;height:100%}",
      ".app-titlebar{grid-column:1/-1;z-index:90;background:white}",
      ".host-sidebar{grid-row:2;background:#eee}",
      ".mounted-app-web-view{grid-column:2;grid-row:2}",
      '</style></head><body><script src="./bundle.js"></script></body></html>',
    ].join(""),
    "utf8",
  );

  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(pathToFileURL(htmlPath).href);
    const box = await page.locator('.mounted-app-web-view[data-display-mode="fullscreen"]').boundingBox();
    assert.deepEqual(box, { x: 0, y: 44, width: 1100, height: 716 });
    const css = await readFile(resolve(projectRoot, "web/src/components/apps/mounted-app-workbench.css"), "utf8");
    assert.match(css, /data-display-mode="fullscreen"/u);
  } finally {
    await browser.close();
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-mcp-app-display-mode-harness ok");

async function launchChromium() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}
