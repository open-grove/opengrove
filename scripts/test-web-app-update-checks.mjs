import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-web-app-updates-"));
try {
  const bundlePath = join(tempDir, "entry.js");
  await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { useAppUpdateChecks } from "./web/src/runtime/use-app-update-checks";
        function Harness() {
          const [userId, setUserId] = useState("");
          const [automatic, setAutomatic] = useState(true);
          const schedule = useAppUpdateChecks({ authenticated: Boolean(userId), userId, automatic });
          return <>
            <output>{userId || "signed-out"}:{String(automatic)}</output>
            <button onClick={() => setUserId("owner")}>Sign in</button>
            <button onClick={() => setUserId("")}>Sign out</button>
            <button onClick={() => setAutomatic(false)}>Disable App updates</button>
            <button onClick={() => setAutomatic(true)}>Enable App updates</button>
            <button onClick={schedule}>Settings save completed</button>
          </>;
        }
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider>
        );
      `,
      resolveDir: projectRoot,
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    outfile: bundlePath,
  });
  const bundle = await readFile(bundlePath, "utf8");
  const requests = [];
  const errors = [];
  let failNext = false;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.clock.install();
    page.on("console", (message) => {
      if (message.type() === "warning") errors.push(message.text());
    });
    await page.route("http://opengrove.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        await route.fulfill({
          contentType: "text/html",
          body: '<meta name="opengrove-api-base" content="/api"><div id="root"></div><script src="/entry.js"></script>',
        });
      } else if (url.pathname === "/entry.js") {
        await route.fulfill({ contentType: "application/javascript", body: bundle });
      } else {
        requests.push({ method: route.request().method(), path: url.pathname });
        const fail = failNext;
        failNext = false;
        await route.fulfill({
          status: fail ? 503 : 200,
          json: fail ? { error: "app_update_schedule_unavailable" } : { ok: true, status: "scheduled" },
        });
      }
    });
    await page.goto("http://opengrove.test/");
    await expect(page.locator("output")).toHaveText("signed-out:true");
    assert.equal(requests.length, 0, "signed-out clients must not schedule App updates");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("output")).toHaveText("owner:true");
    assert.equal(requests.length, 0, "login/session restoration already owns the initial App check");

    await page.clock.fastForward(6 * 60 * 60_000);
    await expect.poll(() => requests.length).toBe(1);
    assert.deepEqual(requests[0], { method: "POST", path: "/api/app-store/updates" });
    await page.getByRole("button", { name: "Disable App updates" }).click();
    await expect(page.locator("output")).toHaveText("owner:false");
    await page.clock.fastForward(6 * 60 * 60_000);
    assert.equal(requests.length, 1, "disabling automatic updates cancels the periodic request");

    await page.getByRole("button", { name: "Enable App updates" }).click();
    await expect(page.locator("output")).toHaveText("owner:true");
    assert.equal(requests.length, 1, "optimistic re-enable must wait for settings to be saved");
    await page.getByRole("button", { name: "Settings save completed" }).click();
    await expect.poll(() => requests.length).toBe(2);

    await page.getByRole("button", { name: "Disable App updates" }).click();
    await expect(page.locator("output")).toHaveText("owner:false");
    await page.getByRole("button", { name: "Enable App updates" }).click();
    await expect(page.locator("output")).toHaveText("owner:true");
    // A failed save rolls the optimistic setting back without calling onSuccess.
    await page.getByRole("button", { name: "Disable App updates" }).click();
    await expect(page.locator("output")).toHaveText("owner:false");
    await page.clock.fastForward(6 * 60 * 60_000);
    assert.equal(requests.length, 2, "failed preference saves must not schedule App updates");
    await page.getByRole("button", { name: "Enable App updates" }).click();

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator("output")).toHaveText("signed-out:true");
    await page.clock.fastForward(6 * 60 * 60_000);
    await page.getByRole("button", { name: "Settings save completed" }).click();
    assert.equal(requests.length, 2, "logout stops both periodic and explicit scheduling");

    failNext = true;
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("output")).toHaveText("owner:true");
    await page.clock.fastForward(6 * 60 * 60_000);
    await expect.poll(() => errors.some((message) => message.includes("app_update_schedule_failed"))).toBe(true);
    assert.equal(requests.length, 3);
    await page.clock.fastForward(6 * 60 * 60_000);
    await expect.poll(() => requests.length).toBe(4);
    assert.ok(requests.every(({ method, path }) => method === "POST" && path === "/api/app-store/updates"));
  } finally {
    await browser.close();
  }

  const appSource = await readFile(join(projectRoot, "web/src/app.tsx"), "utf8");
  assert.match(
    appSource,
    /if \(payload\.appUpdates\?\.automatic === true\) \{\s*scheduleAppUpdates\(\);\s*\}/u,
    "saving App update preferences must use the independent scheduling command",
  );
  const querySource = await readFile(join(projectRoot, "web/src/runtime/use-bridge-queries.ts"), "utf8");
  assert.match(
    querySource,
    /useAppUpdateChecks\(\{\s*authenticated: authPolicy\.sessionAuthenticated,/u,
    "local accountless access must not authorize App update scheduling",
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
console.log("web App update checks ok");
