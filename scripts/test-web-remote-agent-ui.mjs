import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "opengrove-remote-ui-"));
const source = (path) => JSON.stringify(join(root, path));
try {
  await writeFile(
    join(temporary, "entry.tsx"),
    `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { RemoteAgentDialog } from ${source("web/src/components/rooms/remote-agent-panel.tsx")};
    import { setLanguagePreference } from ${source("web/src/i18n.ts")};
    import ${source("web/src/styles/tokens.css")};
    import ${source("web/src/styles/reset.css")};
    import ${source("web/src/styles/primitives.css")};
    import ${source("web/src/styles/base/document.css")};
    setLanguagePreference("zh-CN");
    window.__setLanguage = setLanguagePreference;
    window.__calls = [];
    window.__errorCode = "external_role_required";
    window.fetch = async (url, init) => {
      window.__calls.push({ url: String(url), body: JSON.parse(init.body), credentials: init.credentials });
      return window.__errorCode ? Response.json({ error: window.__errorCode }, { status: 403 }) : Response.json({ ok: true, memberId: "remote-test" });
    };
    function Fixture() {
      const [open, setOpen] = useState(true);
      return <RemoteAgentDialog open={open} onOpenChange={setOpen} onAdded={async (id) => { window.__added = id; }} />;
    }
    createRoot(document.getElementById("root")).render(<Fixture />);
  `,
  );
  await build({
    entryPoints: [join(temporary, "entry.tsx")],
    outfile: join(temporary, "entry.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    nodePaths: [join(root, "node_modules")],
    define: { "import.meta.env": '{"DEV":false}' },
  });
  await writeFile(
    join(temporary, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="opengrove-api-base" content="https://bridge.example/api/"><link rel="stylesheet" href="./entry.css"><style>body { font-family: sans-serif; }</style></head><body><div id="root"></div><script src="./entry.js"></script></body></html>`,
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pathToFileURL(join(temporary, "index.html")).href);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(2);
    assert.doesNotMatch(await page.getByRole("dialog").innerText(), /CLI|profile|通信账号|配置名/);
    await page.getByLabel("Agent 地址").fill("owner/agent@agents.example");
    await page.getByLabel("备注名（可选）").fill("云端同事");
    await page.getByRole("button", { name: "添加云端员工", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("只有 OpenGrove 管理员可以添加云端员工并聊天。");
    const [call] = await page.evaluate(() => window.__calls);
    assert.equal(call.url, "https://bridge.example/api/network/contacts");
    assert.deepEqual(call.body, { address: "owner/agent@agents.example", name: "云端同事" });
    assert.equal(call.credentials, "include");
    await page.evaluate(() => {
      window.__errorCode = "not_authenticated";
    });
    await page.getByRole("button", { name: "添加云端员工", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("请使用管理员账号登录 OpenGrove 后重试。");
    await page.evaluate(() => window.__setLanguage("en"));
    await expect(page.getByRole("heading", { name: "Add remote Agent" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.getByRole("dialog").boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, "the entire dialog fits the viewport");
    assert.equal(await page.getByRole("dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth), true);
    await page.evaluate(() => window.__setLanguage("zh-CN"));
    await mkdir(join(root, ".artifacts"), { recursive: true });
    await page.screenshot({ path: join(root, ".artifacts/remote-agent-ui.png") });
    await page.evaluate(() => {
      window.__errorCode = "";
    });
    await page.getByRole("button", { name: "添加云端员工", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.__added), "remote-test");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(
  "remote Agent dialog: account-free setup, access errors, localization, narrow layout and contact opening passed",
);
