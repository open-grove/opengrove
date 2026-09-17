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
    import { NetworkAuthorizationProvider } from ${source("web/src/components/rooms/network-authorization-provider.tsx")};
    import { RemoteAgentDialog } from ${source("web/src/components/rooms/remote-agent-panel.tsx")};
    import { ToastProvider } from ${source("web/src/components/ui/toast.tsx")};
    import { ConfirmProvider } from ${source("web/src/components/ui/confirm-dialog.tsx")};
    import { MotionMenu } from ${source("web/src/components/ui/motion/menu.tsx")};
    import { RemoteAgentMenuItem } from ${source("web/src/components/rooms/remote-agent-menu-item.tsx")};
    import { useNetworkConfiguration } from ${source("web/src/components/rooms/use-network-configuration.ts")};
    import { RoomMessageStream } from ${source("web/src/components/rooms/room-message-stream.tsx")};
    import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
    import { setLanguagePreference } from ${source("web/src/i18n.ts")};
    import ${source("web/src/styles/tokens.css")};
    import ${source("web/src/styles/reset.css")};
    import ${source("web/src/styles/primitives.css")};
    import ${source("web/src/styles/base/document.css")};
    setLanguagePreference("zh-CN");
    window.__setLanguage = setLanguagePreference;
    window.__calls = [];
    window.__errorCode = "external_role_required";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    window.__reloadConfiguration = () => queryClient.resetQueries({ queryKey: ["network", "configuration"] });
    window.fetch = async (url, init) => {
      if (String(url).includes("/network/account/authorization?")) {
        if (init?.method === "DELETE") {
          if (window.__cancelFails) return Response.json({error:"connection_unavailable"},{status:503});
          window.__oauthCanceled = true; return Response.json({ok:true});
        }
        window.__polls = (window.__polls ?? 0) + 1;
        return Response.json({ok:true,status:window.__oauthPending ? "pending" : "authorized",expiresAt:Date.now()+600000});
      }
      if (String(url).endsWith("/network/account") && init?.method === "POST") {
        window.__connects = (window.__connects ?? 0) + 1;
        if (window.__connectError) return Response.json({error:window.__connectError},{status:400});
        return window.__oauthPending
          ? Response.json({ok:true,authorizationUrl:"https://identity.example/oauth/authorize?state=fixture",authorizationId:"fixture",expiresAt:Date.now()+600000})
          : Response.json({ok:true,account:{id:"sender",owner:"owner",name:"client",address:"owner/client@agents.example"}});
      }
      if (String(url).endsWith("/network/account")) {
        await window.__configurationGate;
        return window.__configurationMode === "error"
          ? Response.json({ error: "service_unavailable" }, { status: 503 })
          : Response.json({ ok: true, configured: window.__configurationMode === "configured" });
      }
      window.__calls.push({ url: String(url), body: JSON.parse(init.body), credentials: init.credentials });
      return window.__errorCode ? Response.json({ error: window.__errorCode }, { status: 403 }) : Response.json({ ok: true, memberId: "remote-test" });
    };
    function MenuFixture() {
      const configuration = useNetworkConfiguration();
      const [open, setOpen] = useState(true);
      return <MotionMenu open={open} onOpenChange={setOpen} trigger={<button>Menu</button>}>
        <RemoteAgentMenuItem configuration={configuration} onSelect={() => { window.__selected = true; }} />
      </MotionMenu>;
    }
    function Fixture() {
      const [open, setOpen] = useState(true);
      const [scenario, setScenario] = useState("dialog");
      const [needsInput, setNeedsInput] = useState(false);
      const [stoppable, setStoppable] = useState(false);
      window.__setOpen = setOpen;
      window.__showMenu = () => setScenario("menu");
      window.__showRemoteStatus = (value) => { setNeedsInput(value); setScenario("messages"); };
      window.__showPendingFailure = () => { setStoppable(true); setNeedsInput(false); setScenario("messages"); };
      if (scenario === "menu") return <MenuFixture />;
      if (scenario === "messages") return <ConfirmProvider><RoomMessageStream
        roomId="remote-status" members={[]} runtimeEventsByRunId={new Map()}
        onResolveApproval={() => {}} onResolveQuestion={() => {}} onInsertPrompt={() => {}}
        onCancelRun={(id) => { window.__stoppedMessage = id; setStoppable(false); }}
        messages={[{
          id: "remote-result", senderId: "remote-test", senderName: "Remote", senderType: "agent",
          text: "Synthetic remote result", targetIds: [], status: stoppable ? "failed" : "done", createdAt: "2026-09-11T00:00:00.000Z",
          remoteTask: { pending: stoppable, needsInput, messageId: "remote-result", triggerMessageId: "input",
            statusText: needsInput ? "Please confirm the target." : "Completed." },
        }]}
      /></ConfirmProvider>;
      return <RemoteAgentDialog open={open} onOpenChange={setOpen} onAdded={async (id) => {
        window.__added = id;
        if (window.__refreshFails) throw new Error("fixture refresh failed");
      }} />;
    }
    createRoot(document.getElementById("root")).render(
      <QueryClientProvider client={queryClient}><ToastProvider><NetworkAuthorizationProvider><Fixture /></NetworkAuthorizationProvider></ToastProvider></QueryClientProvider>
    );
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
    assert.equal(await page.getByLabel("Agent 地址").getAttribute("maxlength"), "512");
    assert.equal(await page.getByLabel("备注名（可选）").getAttribute("maxlength"), "80");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.evaluate(() => window.__setOpen(true));
    await expect(page.getByLabel("Agent 地址")).toHaveValue("");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByLabel("Agent 地址").fill("owner/agent@agents.example");
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
      window.__oauthPending = true;
    });
    const beforeAuthorization = await page.evaluate(() => window.__calls.length);
    await page.getByRole("button", { name: "添加云端员工", exact: true }).click();
    await expect(page.getByRole("heading", { name: "授权云端员工", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "在浏览器中授权" })).toHaveAttribute(
      "href",
      /^https:\/\/identity\.example\/oauth\/authorize/,
    );
    assert.equal(
      await page.evaluate(() => window.__calls.length),
      beforeAuthorization,
      "contact creation waits for authorization",
    );
    await page.evaluate(() => {
      window.__cancelFails = true;
    });
    await page.getByRole("button", { name: "取消", exact: true }).last().click();
    await expect(page.getByRole("alert")).toContainText("取消尚未成功");
    await expect(page.getByRole("heading", { name: "授权云端员工", exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.__cancelFails = false;
    });
    await page.getByRole("button", { name: "取消", exact: true }).last().click();
    await expect.poll(() => page.evaluate(() => window.__oauthCanceled)).toBe(true);
    assert.equal(await page.evaluate(() => window.__calls.length), beforeAuthorization);
    await page.getByRole("button", { name: "添加云端员工", exact: true }).click();
    await expect(page.getByRole("heading", { name: "授权云端员工", exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.__oauthPending = false;
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.__added), "remote-test");
    await page.evaluate(() => {
      window.__refreshFails = true;
      window.__setOpen(true);
    });
    await page.getByLabel("Agent 地址").fill("owner/another@agents.example");
    await page.getByRole("button", { name: "添加云端员工", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("员工已添加，但通讯录刷新失败");
    await page.evaluate(() => {
      window.__configurationMode = "error";
      window.__configurationGate = new Promise((resolve) => {
        window.__releaseConfiguration = resolve;
      });
      window.__showMenu();
    });
    const item = page.getByRole("menuitem", { name: "添加云端员工", exact: true });
    await expect(item).toContainText("正在检查是否可用");
    await expect(item).toHaveAccessibleDescription("正在检查是否可用…");
    await expect(item).not.toContainText("设置 → 网络");
    await expect(item).toHaveAttribute("aria-disabled", "true");
    await item.focus();
    await expect(item).toBeFocused();
    await item.press("Enter");
    assert.equal(await page.evaluate(() => Boolean(window.__selected)), false);
    await page.evaluate(() => window.__releaseConfiguration());
    await expect(item).toContainText("选择此项可重试");
    await page.evaluate(() => {
      window.__configurationMode = "unconfigured";
    });
    await item.press("Enter");
    await expect(item).toContainText("设置 → 网络");
    const menuBounds = await page.getByRole("menu").boundingBox();
    assert.ok(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 390);
    await page.screenshot({ path: join(root, ".artifacts/remote-agent-menu.png") });
    await item.press("Enter");
    assert.equal(await page.evaluate(() => Boolean(window.__selected)), false);
    await page.evaluate(async () => {
      window.__configurationMode = "configured";
      await window.__reloadConfiguration();
    });
    await expect(item).toHaveAttribute("aria-disabled", "false");
    await item.press("Enter");
    assert.equal(await page.evaluate(() => window.__selected), true);
    await page.evaluate(() => window.__showRemoteStatus(false));
    await expect(page.getByText("Synthetic remote result", { exact: true })).toBeVisible();
    await expect(page.getByText("Completed.", { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.__showRemoteStatus(true));
    await expect(page.getByText("Please confirm the target.", { exact: true })).toBeVisible();
    await page.evaluate(() => window.__showPendingFailure());
    const stop = page.getByRole("button", { name: "停止", exact: true });
    await expect(stop).toBeVisible();
    await stop.focus();
    await stop.press("Enter");
    assert.equal(await page.evaluate(() => window.__stoppedMessage), "remote-result");
    await expect(stop).toHaveCount(0);
    await page.evaluate(() => {
      window.__oauthPending = true;
      window.__oauthCanceled = false;
      window.__connects = 0;
      window.__polls = 0;
      window.__showPendingFailure();
    });
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByRole("heading", { name: "授权云端员工", exact: true })).toBeVisible();
    await page.evaluate(() => window.__showMenu());
    await expect(page.getByRole("heading", { name: "授权云端员工", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__polls)).toBeGreaterThan(0);
    assert.equal(
      await page.evaluate(() => window.__oauthCanceled),
      false,
      "removing the originating message must not cancel authorization",
    );
    assert.equal(await page.evaluate(() => window.__connects), 1, "pending status checks must not reconnect");
    await page.evaluate(() => {
      window.__oauthPending = false;
    });
    await expect(page.getByRole("heading", { name: "授权云端员工", exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.__connects), 2, "connect once after consent completes");
    await page.evaluate(() => {
      window.__connectError = "remote_router_not_registered";
      window.__showPendingFailure();
    });
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "暂时无法重连" })).toContainText(
      "账号服务尚未登记这个 Router，请联系它的管理员。",
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(
  "remote Agent UI: setup, refresh failures, configuration states, keyboard access, localization and completed status passed",
);
