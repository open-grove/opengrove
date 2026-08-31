#!/usr/bin/env node
// Visual regression harness for the web UI. This is the safety net for the CSS
// refactor: capture a baseline of every view in light + dark, then after each
// refactor step re-capture and diff pixel-by-pixel. A non-zero diff means the
// step changed rendering (intended or a bug — you decide per shot).
//
// Prereq: a local bridge must be running and serving /ui/. Start one with:
//   OPENGROVE_ENABLE_BROWSER_UI=1 OPENGROVE_BRIDGE_PORT=37371 node dist/server/local-bridge.js
//
// Usage:
//   node scripts/visual-regression.mjs --update          # write/refresh baseline
//   node scripts/visual-regression.mjs                   # compare to baseline
//   node scripts/visual-regression.mjs --url http://127.0.0.1:37371/ui/
//
// Output: PNGs under scripts/.visual/{baseline,current,diff}/.
import { chromium } from "@playwright/test";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outRoot = join(scriptDir, ".visual");
const baselineDir = join(outRoot, "baseline");
const currentDir = join(outRoot, "current");
const diffDir = join(outRoot, "diff");

const args = process.argv.slice(2);
const update = args.includes("--update");
const urlArg = (() => {
  const i = args.indexOf("--url");
  return i >= 0 ? args[i + 1] : undefined;
})();
const baseUrl = urlArg ?? process.env.OPENGROVE_UI_URL ?? "http://127.0.0.1:37371/ui/";
const THEME_STORAGE_KEY = "opengroveTheme";
const THEME_CHANGE_EVENT = "opengrove-theme-change";

// Diff that affects less than this fraction of the page is treated as dynamic
// content noise (timestamps, relative times, live status text) rather than a
// style regression. A real CSS change touches whole regions and blows past it.
// Override with --tolerance <fraction>.
const tolerance = (() => {
  const i = args.indexOf("--tolerance");
  return i >= 0 ? Number(args[i + 1]) : 0.005; // 0.5% of pixels
})();

// Navigation uses product-owned semantic ids. Display copy and locale are
// intentionally absent from this contract.
const VIEWS = [
  { id: "chat", railSection: "chat" },
  {
    id: "rooms",
    railSection: "rooms",
    subviews: [
      { id: "messages", roomView: "rooms" },
      { id: "contacts", roomView: "contacts" },
    ],
  },
  { id: "extensions", railSection: "extensions" },
  { id: "app-store", railSection: "network" },
  {
    id: "settings",
    railSection: "settings",
    subviews: [
      { id: "mode", settingsSection: "mode" },
      { id: "kernels", settingsSection: "kernels" },
      { id: "ops", settingsSection: "ops" },
      { id: "providers", settingsSection: "providers" },
      { id: "apps", settingsSection: "apps" },
      { id: "voice", settingsSection: "voice" },
      // SettingsSectionId "network" is scoped to the settings panel; the rail
      // section with the same id opens the App Store.
      { id: "network", settingsSection: "network" },
      { id: "desktop", settingsSection: "desktop" },
      { id: "appearance", settingsSection: "appearance" },
    ],
  },
];
const THEMES = ["light", "dark"];
const VIEWPORT = { width: 1440, height: 900 };

// Interaction states the static views don't show. Each opens a surface, gets
// screenshotted, then closes. Run after the per-theme view sweep (page is on
// the last view). These are required coverage: if a trigger disappears, fail
// loudly instead of taking a stale screenshot of the previous view.
const INTERACTIONS = [
  {
    id: "composer-focus",
    async open(page) {
      await gotoRailSection(page, "chat", ["chat"]);
      const input = page.locator(".opengrove-question").first();
      if (!(await input.count())) throw new Error("composer-focus input not found: .opengrove-question");
      await input.click({ timeout: 5000 });
      await input.fill("Preview text for visual regression");
    },
    async close(page) {
      const input = page.locator(".opengrove-question").first();
      await input.fill("").catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    },
  },
  {
    id: "employee-dialog",
    async open(page) {
      await gotoRailSection(page, "rooms", ["rooms", "contacts"]);
      await gotoRoomView(page, "contacts");
      const addEmployee = await requiredLocator(
        page,
        '[data-room-action="add-employee"]',
        "employee-dialog add action",
      );
      await addEmployee.click({
        timeout: 5000,
      });
      await page.locator(".employee-dialog").waitFor({ state: "visible", timeout: 5000 });
    },
    async close(page) {
      await page.keyboard.press("Escape").catch(() => {});
    },
  },
];

mkdirSync(baselineDir, { recursive: true });
mkdirSync(currentDir, { recursive: true });
mkdirSync(diffDir, { recursive: true });

// Hide content that legitimately changes between loads (avatars colored by
// status, timestamps, relative times, run durations) so the diff reflects
// layout/style, not data churn. Layout is preserved via visibility:hidden.
const STABILIZE_CSS = `
  .rooms-avatar, .member-avatar, .room-group-avatar,
  [class*="-time"], [class*="time-"], [class*="-duration"],
  [class*="lastActive"], [class*="-ago"], [class*="timestamp"],
  .settings-kernel-auth-status,
  /* rooms message stream + conversation list churn between loads (active
     conversation, ordering, message text) — hide their content so the shot
     compares layout, not data. */
  .room-message-stream, .rooms-chat-list, .room-chat-header-title {
    visibility: hidden !important;
  }
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
`;

async function setTheme(page, theme) {
  await page.evaluate(
    ({ eventName, storageKey, theme: nextTheme }) => {
      window.localStorage.setItem(storageKey, nextTheme);
      document.documentElement.dataset.theme = nextTheme;
      document.documentElement.dataset.resolvedTheme = nextTheme;
      document.documentElement.style.colorScheme = nextTheme;
      window.dispatchEvent(new Event(eventName));
    },
    { eventName: THEME_CHANGE_EVENT, storageKey: THEME_STORAGE_KEY, theme },
  );
  await page.waitForFunction(
    (nextTheme) => {
      const root = document.documentElement;
      return root.dataset.theme === nextTheme && root.dataset.resolvedTheme === nextTheme;
    },
    theme,
    { timeout: 3000 },
  );
}

async function requiredLocator(page, selector, context) {
  const locator = page.locator(`${selector}:visible`);
  const count = await locator.count();
  if (count === 0) {
    throw new Error(`${context}: required target not found: ${selector}`);
  }
  if (count > 1) {
    throw new Error(`${context}: expected one visible target, found ${count}: ${selector}`);
  }
  return locator;
}

async function gotoRailSection(page, sectionId, expectedViews) {
  const selector = `[data-rail-section="${sectionId}"]`;
  const target = await requiredLocator(page, selector, `rail section ${sectionId}`);
  await target.click({ timeout: 5000 });
  await page.waitForFunction(
    (views) => views.includes(document.querySelector(".app-shell")?.getAttribute("data-view") ?? ""),
    expectedViews,
    { timeout: 5000 },
  );
  await page.waitForTimeout(400);
}

async function gotoRoomView(page, viewId) {
  const selector = `[data-room-view-target="${viewId}"]`;
  const target = await requiredLocator(page, selector, `room view ${viewId}`);
  if ((await target.getAttribute("data-active")) !== "true") {
    await target.click({ timeout: 5000 });
  }
  await page.waitForFunction(
    (nextView) => document.querySelector(".app-shell")?.getAttribute("data-view") === nextView,
    viewId,
    { timeout: 5000 },
  );
  await page.waitForTimeout(400);
}

async function gotoSettingsSection(page, sectionId) {
  const selector = `[data-settings-section="${sectionId}"]`;
  const target = await requiredLocator(page, selector, `settings section ${sectionId}`);
  if ((await target.getAttribute("data-active")) !== "true") {
    await target.click({ timeout: 5000 });
  }
  await page.waitForFunction(
    (nextSection) =>
      document.querySelector(`[data-settings-section="${nextSection}"]`)?.getAttribute("data-active") === "true",
    sectionId,
    { timeout: 5000 },
  );
  await page.waitForTimeout(400);
}

async function setDeveloperMode(page, enabled) {
  return page.evaluate(async (nextEnabled) => {
    const apiBase =
      document.querySelector('meta[name="opengrove-api-base"]')?.getAttribute("content")?.trim() || "/api/";
    const endpoint = new URL("settings", new URL(apiBase, window.location.href));
    const response = await fetch(endpoint, {
      method: "PATCH",
      cache: "no-store",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ developerMode: nextEnabled }),
    });
    if (!response.ok) {
      throw new Error(`settings patch failed: ${response.status} ${await response.text()}`);
    }
  }, enabled);
}

async function prepareCoverageMode(page) {
  const developerMode = await page.evaluate(async () => {
    const apiBase =
      document.querySelector('meta[name="opengrove-api-base"]')?.getAttribute("content")?.trim() || "/api/";
    const endpoint = new URL("settings", new URL(apiBase, window.location.href));
    const response = await fetch(endpoint, {
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`settings read failed: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json();
    return payload?.settings?.developerMode === true;
  });
  if (!developerMode) {
    await setDeveloperMode(page, true);
  }
  return developerMode;
}

async function run() {
  const targetDir = update ? baselineDir : currentDir;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  // Inject the stabilizer into every document/navigation.
  await page.addInitScript((css) => {
    const apply = () => {
      const style = document.createElement("style");
      style.id = "og-visual-stabilizer";
      style.textContent = css;
      document.head?.appendChild(style);
    };
    if (document.head) apply();
    else document.addEventListener("DOMContentLoaded", apply);
  }, STABILIZE_CSS);

  const shots = [];
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 20000 });
  } catch (error) {
    console.error(`Failed to load ${baseUrl}. Is the bridge running?`);
    console.error(`  OPENGROVE_ENABLE_BROWSER_UI=1 OPENGROVE_BRIDGE_PORT=37371 node dist/server/local-bridge.js`);
    await browser.close();
    process.exit(2);
  }

  let originalDeveloperMode;
  try {
    originalDeveloperMode = await prepareCoverageMode(page);
    if (!originalDeveloperMode) {
      await page.reload({ waitUntil: "networkidle", timeout: 20000 });
    }
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await page.waitForTimeout(300);
      for (const view of VIEWS) {
        await gotoRailSection(page, view.railSection, view.id === "rooms" ? ["rooms", "contacts"] : [view.id]);
        if (view.subviews) {
          for (const sub of view.subviews) {
            if (sub.roomView) {
              await gotoRoomView(page, sub.roomView);
            }
            if (sub.settingsSection) {
              await gotoSettingsSection(page, sub.settingsSection);
            }
            const name = `${view.id}-${sub.id}.${theme}.png`;
            await page.screenshot({ path: join(targetDir, name), fullPage: false });
            shots.push(name);
          }
        } else {
          const name = `${view.id}.${theme}.png`;
          await page.screenshot({ path: join(targetDir, name), fullPage: false });
          shots.push(name);
        }
      }

      // Interaction states: fail if a required trigger is absent so the harness
      // cannot silently stop covering a surface this refactor depends on.
      for (const inter of INTERACTIONS) {
        try {
          await inter.open(page);
          await page.waitForTimeout(700);
          const name = `i-${inter.id}.${theme}.png`;
          await page.screenshot({ path: join(targetDir, name), fullPage: false });
          shots.push(name);
          if (inter.close) await inter.close(page).catch(() => {});
          await page.waitForTimeout(300);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`interaction ${inter.id}.${theme} failed: ${message}`);
        }
      }
    }
  } finally {
    try {
      if (originalDeveloperMode === false) {
        try {
          await setDeveloperMode(page, false);
        } catch (error) {
          console.warn("Warning: failed to restore developer mode after visual regression:", error);
        }
      }
    } finally {
      await browser.close();
    }
  }

  if (update) {
    console.log(`Baseline updated: ${shots.length} shots in ${baselineDir}`);
    return;
  }

  // Compare.
  let failed = 0;
  let missing = 0;
  let noise = 0;
  rmSync(diffDir, { recursive: true, force: true });
  mkdirSync(diffDir, { recursive: true });
  for (const name of shots) {
    const basePath = join(baselineDir, name);
    if (!existsSync(basePath)) {
      console.log(`  NEW   ${name} (no baseline)`);
      missing += 1;
      continue;
    }
    const baseImg = PNG.sync.read(readFileSync(basePath));
    const curImg = PNG.sync.read(readFileSync(join(currentDir, name)));
    if (baseImg.width !== curImg.width || baseImg.height !== curImg.height) {
      console.log(
        `  SIZE  ${name} (dimension change ${baseImg.width}x${baseImg.height} -> ${curImg.width}x${curImg.height})`,
      );
      failed += 1;
      continue;
    }
    const { width, height } = baseImg;
    const diff = new PNG({ width, height });
    const changed = pixelmatch(baseImg.data, curImg.data, diff.data, width, height, { threshold: 0.15 });
    const fraction = changed / (width * height);
    const pct = (fraction * 100).toFixed(3);
    if (changed === 0) {
      console.log(`  ok    ${name}`);
    } else if (fraction <= tolerance) {
      // Within noise budget — likely dynamic content (timestamps/status).
      console.log(`  noise ${name}  ${changed} px (${pct}%, within ${(tolerance * 100).toFixed(2)}%)`);
      noise += 1;
    } else {
      writeFileSync(join(diffDir, name), PNG.sync.write(diff));
      console.log(`  DIFF  ${name}  ${changed} px (${pct}%)  <-- exceeds tolerance`);
      failed += 1;
    }
  }
  console.log("");
  console.log(`Compared ${shots.length} shots: ${failed} regressed, ${noise} within-noise, ${missing} new.`);
  if (missing > 0) {
    console.log("New shots have no baseline. Run with --update after confirming they are expected.");
  }
  if (failed > 0) {
    console.log(`Diff images written to ${diffDir}`);
  }
  if (failed > 0 || missing > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
