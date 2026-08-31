#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const baseUrl = argValue("--url", process.env.OPENGROVE_UI_URL ?? "http://127.0.0.1:37371/ui/");
const label = argValue("--label", "current").replace(/[^a-zA-Z0-9._-]+/g, "-");
const outDir = resolve(argValue("--out", ".artifacts/refactor-verification"));
const failOnConsole = !args.includes("--allow-console");

const DESKTOP_VIEWPORT = { width: 1440, height: 960 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

const DESKTOP_SHOTS = [
  { id: "chat" },
  { id: "employees", nav: "Employees" },
  { id: "extensions", nav: "Extensions" },
  { id: "app-store", nav: "App Store" },
];

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const manifest = {
  label,
  url: baseUrl,
  capturedAt: new Date().toISOString(),
  screenshots: [],
  console: [],
};

try {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      manifest.console.push({
        type: message.type(),
        text: message.text(),
      });
    }
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForTimeout(1_000);

  for (const shot of DESKTOP_SHOTS) {
    if (shot.nav) {
      await clickRailButton(page, shot.nav);
    }
    await waitForViewReady(page, shot.id);
    await capture(page, shot.id);
  }

  const mobile = await browser.newPage({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
  });
  mobile.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      manifest.console.push({
        type: message.type(),
        text: message.text(),
      });
    }
  });
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await mobile.waitForTimeout(1_000);
  await waitForViewReady(mobile, "mobile-chat");
  await capture(mobile, "mobile-chat");

  const manifestPath = join(outDir, `${label}-manifest.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (failOnConsole && manifest.console.length > 0) {
    console.error(`refactor-ui-smoke captured ${manifest.console.length} console warnings/errors`);
    console.error(JSON.stringify(manifest.console, null, 2));
    process.exitCode = 1;
  } else {
    console.log(`refactor-ui-smoke captured ${manifest.screenshots.length} screenshots`);
    console.log(manifestPath);
  }
} finally {
  await browser.close();
}

async function clickRailButton(page, label) {
  const button = page.locator(`button[aria-label="${cssString(label)}"]`);
  const count = await button.count();
  if (count !== 1) {
    throw new Error(`Expected one rail button "${label}", got ${count}`);
  }
  await button.click({ timeout: 5_000 });
}

async function capture(page, id) {
  const filename = `${label}-${id}.png`;
  const path = join(outDir, filename);
  await page.screenshot({ path, fullPage: true });
  manifest.screenshots.push({
    id,
    path,
  });
}

async function waitForViewReady(page, id) {
  await page.waitForFunction(
    ({ viewId }) => {
      const main = document.querySelector("main, .workspace");
      const text = (main?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (viewId === "chat" || viewId === "mobile-chat") {
        return Boolean(document.querySelector(".chat-view")) && text.length > 40;
      }
      return text.length > 40;
    },
    { viewId: id },
    { timeout: 8_000 },
  );
}

function cssString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
