import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { tailwindStylesPlugin } from "./esbuild-tailwind-plugin.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-mounted-app-group-deletion-"));
const entryPath = join(tempDir, "entry.tsx");
const bundlePath = join(tempDir, "bundle.js");
const htmlPath = join(tempDir, "index.html");
const globalStylesPath = resolve(projectRoot, "web/src/styles.css");

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
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [tailwindStylesPlugin(globalStylesPath)],
  });
  await writeFile(
    htmlPath,
    [
      "<!doctype html>",
      "<html>",
      '<head><meta charset="utf-8"><title>Mounted App group deletion</title><link rel="stylesheet" href="./bundle.css"></head>',
      '<body><button id="overlay-outside-target" type="button" aria-label="Outside overlays" style="position:fixed;right:4px;bottom:4px;z-index:9999;width:20px;height:20px"></button><div id="root"></div><script src="./bundle.js"></script></body>',
      "</html>",
    ].join("\n"),
    "utf8",
  );
  await runBrowserHarness(htmlPath);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-mounted-app-group-deletion-harness ok");

async function runBrowserHarness(path) {
  const browser = await launchChromiumForHarness();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(pathToFileURL(path).href);
    await page
      .getByRole("button", { name: /故事种子 群组/ })
      .first()
      .waitFor();
    await testHeaderOverlayExclusivity(page);
    await testHeaderOverlayDismissal(page);

    await openGroupPicker(page);
    await page.getByText("0 位员工 · 工作流协作现场", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await openGroupSettings(page);
    assert.equal(
      await page.locator(".rooms-member-row").count(),
      1,
      "an empty App group remains selectable and exposes its owner/settings row",
    );
    await page.getByRole("button", { name: "添加成员" }).click();
    await page.locator(".rooms-member-picker-option").filter({ hasText: "Story Seed PM" }).click();
    await page.locator(".rooms-member-row").filter({ hasText: "Story Seed PM" }).waitFor();
    await page.getByRole("button", { name: "添加成员" }).click();
    await page.locator(".rooms-member-picker-option").filter({ hasText: "Screenwriter" }).click();
    await page.locator(".rooms-member-row").filter({ hasText: "Screenwriter" }).waitFor();
    await page.getByRole("button", { name: "关闭" }).click();
    await page.evaluate(() => {
      window.__memberAddCalls = [];
    });

    await openGroupSettings(page);
    const pmRow = page.locator(".rooms-member-row").filter({ hasText: "Story Seed PM" });
    await pmRow.waitFor();
    await pmRow.hover();
    assert.equal(await pmRow.locator(".rooms-member-row-danger-action").count(), 1, "the optional PM can be removed");
    assert.equal(
      await pmRow.getByText("群主", { exact: true }).count(),
      0,
      "the optional PM is not presented as the Room owner",
    );
    await page.locator(".rooms-member-row").filter({ hasText: "Screenwriter" }).waitFor();
    const settingsBox = await page.locator(".mounted-app-member-popover").boundingBox();
    assert.ok(settingsBox && settingsBox.height > 200, "group settings popover should retain its content height");
    await page.getByRole("button", { name: "添加成员" }).click();
    const restoreEditor = page.locator(".rooms-member-picker-option").filter({ hasText: "Lead Editor" });
    await restoreEditor.click();
    await page.locator(".rooms-member-row").filter({ hasText: "Lead Editor" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__memberAddCalls), [
      {
        roomId: "app-room--story-seed--group--default",
        member: {
          id: "member-app-story-seed-editor",
          name: "金牌编辑",
          displayName: "Lead Editor",
          kernel: "codex",
          model: "gpt-5",
          role: "审核大纲",
          status: "idle",
          color: "#7c3aed",
          lastActive: "已配置",
          source: "local",
          appId: "story-seed",
          disabled: false,
        },
      },
    ]);

    await page.getByRole("button", { name: "添加成员" }).click();
    const addBuilder = page.locator(".rooms-member-picker-option").filter({ hasText: "App 构建师" });
    await addBuilder.click();
    await page.getByText("添加员工失败：app_builder_binding_failed").waitFor();
    assert.equal(await page.locator(".rooms-member-row").filter({ hasText: "App 构建师" }).count(), 0);

    const screenwriterRow = page.locator(".rooms-member-row").filter({ hasText: "Screenwriter" });
    await screenwriterRow.hover();
    await screenwriterRow.locator(".rooms-member-row-danger-action").click();
    await page.getByText("移除员工失败：member_remove_failed").waitFor();
    await page.locator(".rooms-member-row").filter({ hasText: "Screenwriter" }).waitFor();
    await page.getByRole("button", { name: "关闭" }).click();

    await openGroupPicker(page);
    await page.getByRole("dialog", { name: "切换 App 聊天" }).getByText("3 位员工 · 工作流协作现场").waitFor();
    await page.getByRole("button", { name: /大纲评审群组/ }).click();
    await openDissolveGroupDialog(page);
    await page.getByText("确定解散“大纲评审群组”吗？", { exact: false }).waitFor();
    await page.getByRole("button", { name: "取消" }).click();
    assert.equal(await page.evaluate(() => window.__archiveCalls.length), 0);

    await selectGroup(page, "故事种子 群组");
    await selectGroup(page, "备用评审群组");
    await openDissolveGroupDialog(page);
    await page.getByRole("button", { name: "解散群聊", exact: true }).click();
    await page.getByRole("dialog", { name: "解散群聊" }).waitFor({ state: "detached" });
    await page.locator(".mounted-app-room-target").getByText("故事种子 群组").waitFor();
    const defaultComposer = page.getByRole("textbox", { name: "发送给 故事种子 群组" });

    await selectGroup(page, "大纲评审群组");
    await openDissolveGroupDialog(page);
    await page.getByRole("button", { name: "解散群聊", exact: true }).click();
    await page.getByText(/archive_failed/).waitFor();
    await page.getByRole("button", { name: "取消" }).click();
    await page.locator(".mounted-app-room-target").getByText("大纲评审群组").waitFor();

    await openDissolveGroupDialog(page);
    await page.getByRole("button", { name: "解散群聊", exact: true }).click();
    await page.getByRole("dialog", { name: "解散群聊" }).waitFor({ state: "detached" });

    assert.deepEqual(await page.evaluate(() => window.__archiveCalls), [
      { roomId: "app-room--story-seed--group--backup", body: { archived: true } },
      { roomId: "app-room--story-seed--group--review", body: { archived: true } },
      { roomId: "app-room--story-seed--group--review", body: { archived: true } },
    ]);
    await page.locator(".mounted-app-room-target").getByText("故事种子 群组").waitFor();
    await openGroupPicker(page);
    assert.equal(await page.getByRole("button", { name: /大纲评审群组/ }).count(), 0);
    await page.keyboard.press("Escape");

    await defaultComposer.fill("");
    await page.evaluate(() => window.__setLanguage("en"));
    await page.locator("[data-i18n-memo-probe]").getByText("Everyone", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Mention a member" }).click();
    await page.getByRole("option", { name: /Everyone/ }).click();
    assert.equal(await page.locator(".mounted-app-room-chat .opengrove-question").inputValue(), "@all ");
    await page.locator(".mounted-app-room-chat-header .room-header-more-button").click();
    await page.locator(".room-header-more-menu").getByRole("menuitem", { name: "Group settings" }).click();
    await page.getByRole("dialog", { name: "Group settings" }).waitFor();
    assert.deepEqual(await page.locator(".rooms-member-row strong").allTextContents(), [
      "Me",
      "Story Seed PM",
      "Lead Editor",
      "Screenwriter",
    ]);
  } finally {
    await browser.close();
  }
}

async function testHeaderOverlayExclusivity(page) {
  await openGroupPicker(page);
  await page.getByRole("button", { name: "搜索聊天记录" }).click();
  await page.getByRole("dialog", { name: "搜索聊天记录" }).waitFor();
  await page.getByRole("dialog", { name: "切换 App 聊天" }).waitFor({ state: "detached" });

  await page.locator(".mounted-app-room-target").click();
  await page.getByRole("dialog", { name: "切换 App 聊天" }).waitFor();
  await page.getByRole("dialog", { name: "搜索聊天记录" }).waitFor({ state: "detached" });

  await page.locator(".mounted-app-room-chat-header .room-header-more-button").click();
  await page.locator(".room-header-more-menu").waitFor();
  await page.getByRole("dialog", { name: "切换 App 聊天" }).waitFor({ state: "detached" });
  await page.locator(".mounted-app-room-chat-header .room-header-more-button").click();
  await page.locator(".room-header-more-menu").waitFor({ state: "detached" });
}

async function testHeaderOverlayDismissal(page) {
  await openGroupPicker(page);
  await page.locator("#overlay-outside-target").click();
  await page.getByRole("dialog", { name: "切换 App 聊天" }).waitFor({ state: "detached" });

  await openGroupPicker(page);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "切换 App 聊天" }).waitFor({ state: "detached" });
  assert.equal(
    await page.locator(".mounted-app-room-target").evaluate((element) => element === document.activeElement),
    true,
    "Escape must return focus to the group picker trigger",
  );

  await openGroupSettings(page);
  await page.locator("#overlay-outside-target").click();
  await page.getByRole("dialog", { name: "群设置" }).waitFor({ state: "detached" });

  await openGroupSettings(page);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "群设置" }).waitFor({ state: "detached" });
  assert.equal(
    await page
      .locator(".mounted-app-room-chat-header .room-header-more-button")
      .evaluate((element) => element === document.activeElement),
    true,
    "Escape must return focus to the group settings trigger",
  );
}

async function openGroupPicker(page) {
  await page.locator(".mounted-app-room-target").click();
  await page.locator('[role="dialog"][aria-label="切换 App 聊天"][data-state="open"]').waitFor();
  await page.evaluate(() => new Promise((resolvePromise) => requestAnimationFrame(() => resolvePromise())));
}

async function selectGroup(page, title) {
  await openGroupPicker(page);
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await page.locator(".mounted-app-room-target").getByText(title).waitFor();
}

async function openGroupSettings(page) {
  await page.locator(".mounted-app-room-chat-header .room-header-more-button").click();
  await page.locator(".room-header-more-menu").getByRole("menuitem", { name: "群设置" }).click();
  await page.getByRole("dialog", { name: "群设置" }).waitFor();
  await page.evaluate(() => new Promise((resolvePromise) => requestAnimationFrame(() => resolvePromise())));
}

async function openDissolveGroupDialog(page) {
  await page.locator(".mounted-app-room-chat-header .room-header-more-button").click();
  await page.locator(".room-header-more-menu").getByRole("menuitem", { name: "解散群聊" }).click();
  await page.getByRole("dialog", { name: "解散群聊" }).waitFor();
}

async function launchChromiumForHarness() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) throw error;
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

function entrySource() {
  const panelPath = resolve(projectRoot, "web/src/components/apps/mounted-app-chat-panel.tsx");
  const confirmPath = resolve(projectRoot, "web/src/components/ui/confirm-dialog.tsx");
  const roomsSharedStatePath = resolve(projectRoot, "web/src/components/rooms/rooms-shared-state.ts");
  return `
    import React, { useMemo } from "react";
    import { createRoot } from "react-dom/client";
    import { MountedAppChatPanel } from ${JSON.stringify(panelPath)};
    import { ConfirmProvider } from ${JSON.stringify(confirmPath)};
    import { useRoomsSharedState } from ${JSON.stringify(roomsSharedStatePath)};
    import { setLanguagePreference, useI18n } from ${JSON.stringify(resolve(projectRoot, "web/src/i18n.ts"))};
    import ${JSON.stringify(globalStylesPath)};

    setLanguagePreference("zh-CN");
    window.__setLanguage = setLanguagePreference;

    function LanguageMemoProbe() {
      const { t } = useI18n();
      const label = useMemo(() => t("mountedApp.mentionAll"), [t]);
      return <span data-i18n-memo-probe>{label}</span>;
    }

    const createdAt = "2026-07-14T00:00:00.000Z";
    const member = {
      id: "employee-writer",
      name: "剧本专家",
      displayName: "Screenwriter",
      kernel: "codex",
      model: "gpt-5",
      role: "创作剧本",
      status: "idle",
      color: "#2563eb",
      lastActive: "刚刚",
      source: "local",
      appId: "story-seed",
    };
    const pmMember = {
      id: "member-app-story-seed-pm",
      name: "故事种子 PM",
      displayName: "Story Seed PM",
      kernel: "codex",
      model: "gpt-5",
      role: "协调故事种子员工",
      status: "idle",
      color: "#1d4ed8",
      lastActive: "已配置",
      source: "local",
      appId: "story-seed",
      defaultSkillIds: ["pm-planner"],
    };
    const defaultRoom = {
      id: "app-room--story-seed--group--default",
      kind: "group",
      scope: { kind: "app", appId: "story-seed", role: "default" },
      title: "故事种子 群组",
      badge: "故事种子",
      memberIds: [],
      adminMemberIds: [],
      pinned: false,
      archived: false,
      unread: 0,
      updatedAt: createdAt,
    };
    const removedMember = {
      id: "member-app-story-seed-editor",
      name: "金牌编辑",
      displayName: "Lead Editor",
      kernel: "codex",
      model: "gpt-5",
      role: "审核大纲",
      status: "offline",
      color: "#7c3aed",
      lastActive: "已移除",
      source: "local",
      appId: "story-seed",
      disabled: true,
    };
    const globalBuilder = {
      id: "app-builder",
      employeeDefinitionId: "app-builder",
      name: "App 构建师",
      kernel: "codex",
      model: "gpt-5",
      role: "构建 App",
      status: "idle",
      color: "#7c3aed",
      lastActive: "已配置",
      source: "local",
    };
    const customRoom = {
      ...defaultRoom,
      id: "app-room--story-seed--group--review",
      scope: { kind: "app", appId: "story-seed", role: "group" },
      title: "大纲评审群组",
    };
    const backupRoom = {
      ...defaultRoom,
      id: "app-room--story-seed--group--backup",
      scope: { kind: "app", appId: "story-seed", role: "group" },
      title: "备用评审群组",
    };
    window.__archiveCalls = [];
    window.__memberAddCalls = [];
    let archiveAttempts = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith("/rooms?")) {
        return Response.json({
          ok: true,
          rooms: [defaultRoom, customRoom, backupRoom],
          members: [pmMember, member, removedMember, globalBuilder],
          messages: [],
          currentEventSeq: 10,
          deletedMemberIds: [removedMember.id],
        });
      }
      if (url.startsWith("/rooms/events?")) {
        return Response.json({ ok: true, events: [], currentEventSeq: 10, hasMore: false });
      }
      if (url === "/rooms/" + encodeURIComponent(defaultRoom.id) + "/members" && init.method === "POST") {
        const body = JSON.parse(String(init.body));
        window.__memberAddCalls.push({ roomId: defaultRoom.id, member: body });
        return Response.json({ ok: true, member: body, currentEventSeq: 11 });
      }
      if (url === "/apps/story-seed/employees/app-builder" && init.method === "POST") {
        return Response.json({ error: "app_builder_binding_failed" }, { status: 500 });
      }
      if (url === "/rooms/" + encodeURIComponent(defaultRoom.id) + "/members/" + encodeURIComponent(member.id) && init.method === "DELETE") {
        return Response.json({ error: "member_remove_failed" }, { status: 500 });
      }
      const archivedRoom = [customRoom, backupRoom].find((room) => url === "/rooms/" + encodeURIComponent(room.id));
      if (archivedRoom && init.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        window.__archiveCalls.push({ roomId: archivedRoom.id, body });
        if (archivedRoom.id === customRoom.id) archiveAttempts += 1;
        if (archivedRoom.id === customRoom.id && archiveAttempts === 1) {
          return Response.json({ error: "archive_failed" }, { status: 500 });
        }
        return Response.json({ ok: true, room: { ...archivedRoom, archived: true }, currentEventSeq: 11 });
      }
      return Response.json({ error: "unexpected_request:" + url }, { status: 500 });
    };

    const app = {
      id: "app:story-seed",
      kind: "app",
      name: "story-seed",
      title: "故事种子",
      description: "Story Seed",
      enabled: true,
      managedByOpenGrove: true,
      readonly: false,
      system: false,
      deployments: [],
      permissions: [],
      commandUsages: [],
      childIds: [],
      tags: [],
      metadata: {},
    };

    function Harness() {
      const rooms = useRoomsSharedState({ enabled: true, sessionKey: "mounted-app-group-deletion" });
      return (
        <ConfirmProvider>
          <LanguageMemoProbe />
          <MountedAppChatPanel
            app={app}
            selectedPath=""
            roomsState={rooms.snapshot}
            roomsHydrated={rooms.snapshot.hydrated}
            setRoomsState={rooms.actions.setRoomsState}
          />
        </ConfirmProvider>
      );
    }

    createRoot(document.getElementById("root")).render(
      <Harness />
    );
  `;
}
