import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-native-ui-interactions-"));
const entryPath = join(tempDir, "native-ui-interactions-entry.tsx");
const bundlePath = join(tempDir, "native-ui-interactions-entry.js");
const htmlPath = join(tempDir, "index.html");

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
  });
  await writeFile(
    htmlPath,
    [
      "<!doctype html>",
      "<html>",
      '<head><meta charset="utf-8"><title>OpenGrove native UI interaction harness</title></head>',
      '<body><div id="root"></div><script src="./native-ui-interactions-entry.js"></script></body>',
      "</html>",
    ].join("\n"),
    "utf8",
  );
  await runBrowserHarness(htmlPath);
  console.log("web-native-ui-interactions-harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function runBrowserHarness(path) {
  const browser = await launchChromiumForHarness();
  try {
    const failures = [];
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(pathToFileURL(path).href);
    const resizeHandle = page.getByTestId("sidebar-resize-handle");
    await resizeHandle.waitFor();

    const composerResizeHandle = page.getByTestId("composer-resize-handle");
    const composerBox = await composerResizeHandle.boundingBox();
    assert.ok(composerBox, "composer resize handle should be measurable");
    const initialComposerHeight = Number(await composerResizeHandle.getAttribute("data-composer-height"));
    await page.mouse.move(composerBox.x + composerBox.width / 2, composerBox.y + composerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(composerBox.x + composerBox.width / 2, composerBox.y + composerBox.height / 2 - 4);
    await page.waitForFunction((initialHeight) => {
      const handle = document.querySelector("[data-testid='composer-resize-handle']");
      return Number(handle?.getAttribute("data-composer-height")) > initialHeight;
    }, initialComposerHeight);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    const interruptedComposerHeight = Number(await composerResizeHandle.getAttribute("data-composer-height"));
    await page.mouse.move(composerBox.x + composerBox.width / 2, composerBox.y + composerBox.height / 2 + 10);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const composerHeightAfterInterruption = Number(await composerResizeHandle.getAttribute("data-composer-height"));
    recordFailure(failures, "interrupted composer resize", () =>
      assert.equal(
        composerHeightAfterInterruption,
        interruptedComposerHeight,
        "window blur should stop composer resizing and remove its pointermove listener",
      ),
    );
    await page.mouse.up();

    const handleBox = await resizeHandle.boundingBox();
    assert.ok(handleBox, "sidebar resize handle should be measurable");
    const initialSidebarWidth = Number(await resizeHandle.getAttribute("data-sidebar-width"));
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    assert.equal(
      await page.locator("body").getAttribute("data-sidebar-resizing"),
      "true",
      "pointerdown should enter sidebar resizing mode",
    );
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 30, handleBox.y + handleBox.height / 2);
    await page.waitForFunction((initialWidth) => {
      const handle = document.querySelector("[data-testid='sidebar-resize-handle']");
      return Number(handle?.getAttribute("data-sidebar-width")) > initialWidth;
    }, initialSidebarWidth);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    const sidebarResizingState = await page.locator("body").getAttribute("data-sidebar-resizing");
    recordFailure(failures, "interrupted sidebar resize", () =>
      assert.equal(sidebarResizingState, null, "window blur should always leave sidebar resizing mode"),
    );
    await page.mouse.up();

    const [navigationCss, resetCss, threadCss] = await Promise.all([
      readFile(join(projectRoot, "web/src/components/sidebar/app-navigation.module.css"), "utf8"),
      readFile(join(projectRoot, "web/src/styles/reset.css"), "utf8"),
      readFile(join(projectRoot, "web/src/components/chat/thread.css"), "utf8"),
    ]);
    await page.addStyleTag({
      content: [resetCss, navigationCss, threadCss].join("\n"),
    });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--motion-fast", "0s");
      document.documentElement.style.setProperty("--motion-ease", "linear");
      document.documentElement.style.setProperty("--dur-fast", "0s");
      document.documentElement.style.setProperty("--ease", "linear");

      const navigation = document.createElement("nav");
      navigation.className = "nav";
      navigation.dataset.testid = "desktop-navigation";
      navigation.style.cssText = "width: 120px; height: 60px";
      navigation.innerHTML = "<div style='height: 180px'>Scrollable navigation</div>";
      document.body.append(navigation);

      const toggle = document.createElement("button");
      toggle.className = "thread-activity-edit-diff-toggle";
      toggle.dataset.testid = "rotated-toggle";
      toggle.setAttribute("aria-expanded", "true");
      toggle.textContent = "Toggle diff";
      document.body.append(toggle);
    });

    const scrollbarStyles = await page.getByTestId("desktop-navigation").evaluate((element) => ({
      standardWidth: getComputedStyle(element).scrollbarWidth,
      webkitDisplay: getComputedStyle(element, "::-webkit-scrollbar").display,
    }));
    recordFailure(failures, "standard desktop navigation scrollbar", () =>
      assert.notEqual(
        scrollbarStyles.standardWidth,
        "none",
        "desktop navigation should follow the platform scrollbar preference",
      ),
    );
    recordFailure(failures, "WebKit desktop navigation scrollbar", () =>
      assert.notEqual(
        scrollbarStyles.webkitDisplay,
        "none",
        "desktop navigation should not hide the WebKit scrollbar fallback",
      ),
    );

    const rotatedToggle = page.getByTestId("rotated-toggle");
    const transformBeforePress = await rotatedToggle.evaluate((element) => getComputedStyle(element).transform);
    const toggleBox = await rotatedToggle.boundingBox();
    assert.ok(toggleBox, "rotated toggle should be measurable");
    await page.mouse.move(toggleBox.x + toggleBox.width / 2, toggleBox.y + toggleBox.height / 2);
    await page.mouse.down();
    const pressedStyles = await rotatedToggle.evaluate((element) => {
      const styles = getComputedStyle(element);
      return { transform: styles.transform, scale: styles.scale };
    });
    recordFailure(failures, "button transform composition", () =>
      assert.equal(
        pressedStyles.transform,
        transformBeforePress,
        "button press feedback must preserve the component transform",
      ),
    );
    recordFailure(failures, "button press feedback", () =>
      assert.equal(pressedStyles.scale, "0.985", "ordinary buttons should retain press feedback"),
    );
    await page.mouse.up();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await rotatedToggle.hover();
    await page.mouse.down();
    assert.equal(
      await rotatedToggle.evaluate((element) => element.matches(":active")),
      true,
      "reduced-motion assertion requires an actively pressed button",
    );
    const reducedMotionStyles = await rotatedToggle.evaluate((element) => {
      const styles = getComputedStyle(element);
      return { transform: styles.transform, scale: styles.scale };
    });
    recordFailure(failures, "reduced-motion static transform", () =>
      assert.equal(
        reducedMotionStyles.transform,
        transformBeforePress,
        "reduced motion must preserve static state transforms",
      ),
    );
    recordFailure(failures, "reduced-motion press feedback", () =>
      assert.equal(reducedMotionStyles.scale, "none", "reduced motion should disable only press scaling"),
    );
    await page.mouse.up();
    assert.deepEqual(failures, [], failures.join("\n\n"));
  } finally {
    await browser.close();
  }
}

function recordFailure(failures, name, check) {
  try {
    check();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
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
  const layoutResizePath = resolve(projectRoot, "web/src/runtime/app-layout-resize.ts");
  return `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { useAppLayoutResize } from ${JSON.stringify(layoutResizePath)};

    function Harness() {
      const [composerHeight, setComposerHeight] = useState(56);
      const { sidebarWidth, onComposerPointerDown, onSidebarResizePointerDown } = useAppLayoutResize({
        composerHeight,
        setComposerHeight,
      });
      return React.createElement(React.Fragment, null,
        React.createElement("div", {
          onPointerDown: onComposerPointerDown,
          style: { width: "200px", height: "80px", paddingTop: "20px" },
        }, React.createElement("div", {
          "data-action": "resize-composer",
          "data-testid": "composer-resize-handle",
          "data-composer-height": composerHeight,
          style: { width: "200px", height: "20px" },
        })),
        React.createElement("div", {
          "data-testid": "sidebar-resize-handle",
          "data-sidebar-width": sidebarWidth,
          onPointerDown: onSidebarResizePointerDown,
          style: { width: "20px", height: "200px" },
        }),
      );
    }

    createRoot(document.getElementById("root")).render(React.createElement(Harness));
  `;
}
