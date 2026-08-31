import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appEnvName } from "../identity.js";
import { createBridgeState } from "../server/bridge-state.js";
import { defaultAppGroupRoomId } from "../server/app-room-ids.js";
import {
  appBuilderMemberId,
  OPENGROVE_APP_BUILDER_MEMBER_ID,
  OPENGROVE_APP_WORKSPACE_GUARD_SKILL_NAME,
  pmAgentMemberId,
} from "../server/bridge-mounted-app-employees.js";
import { loadBridgeSettings } from "../server/bridge-settings-store.js";
import { handleAppsRoute } from "../server/routes/apps.js";
import { handleRoomMemberRoutes } from "../server/routes/rooms/member-routes.js";
import { validateAppReleaseBuildContract } from "../server/app-release-build-contract.js";
import { packApp } from "../app-builder/cli.js";
import { defaultOpenGroveAppsDir } from "../storage/default-data-dir.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-app-create-"));
const settingsPath = join(tempRoot, "bridge-settings.json");
const overriddenEnv = {
  [appEnvName("USER_DATA_DIR")]: join(tempRoot, "user-data"),
  [appEnvName("BRIDGE_SETTINGS_PATH")]: settingsPath,
  [appEnvName("APP_STORE_APPS_DIR")]: join(tempRoot, "apps"),
};
const previousEnv = Object.fromEntries(Object.keys(overriddenEnv).map((name) => [name, process.env[name]]));

try {
  Object.assign(process.env, overriddenEnv);
  const state = createBridgeState({ statePath: join(tempRoot, "state.json") });
  state.settings.languagePreference = "zh-CN";

  async function callApps(path: string, payload: unknown, method = "POST"): Promise<{ status: number; data: any }> {
    const calls: Array<{ status: number; data: any }> = [];
    const handled = await handleAppsRoute({
      request: { method } as any,
      response: {} as any,
      url: new URL(`http://opengrove.test${path}`),
      state,
      sendJson: (_response, status, data) => calls.push({ status, data }),
      readJsonBody: async () => payload,
    });
    assert.equal(handled, true, `route should claim ${path}`);
    assert.ok(calls[0], "route should respond");
    return calls[0];
  }

  async function callRoomMembers(path: string, method = "DELETE"): Promise<{ status: number; data: any }> {
    const calls: Array<{ status: number; data: any }> = [];
    const handled = await handleRoomMemberRoutes({
      request: { method } as any,
      response: {} as any,
      url: new URL(`http://opengrove.test${path}`),
      state,
      sendJson: (_response, status, data) => calls.push({ status, data }),
      readJsonBody: async () => ({}),
    });
    assert.equal(handled, true, `room member route should claim ${path}`);
    assert.ok(calls[0], "room member route should respond");
    return calls[0];
  }

  const callCreate = (payload: unknown) => callApps("/apps/create", payload);

  // ===== 输入校验 =====
  const missing = await callCreate({});
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error, "app_title_or_source_required");

  const badSource = await callCreate({ source: join(tempRoot, "does-not-exist") });
  assert.equal(badSource.status, 400);
  assert.equal(badSource.data.error, "app_source_must_be_local_directory");
  const badIcon = await callCreate({ title: "Bad Icon", icon: "https://example.test/icon.svg" });
  assert.equal(badIcon.status, 400);
  assert.equal(badIcon.data.error, "app_icon_invalid");

  // ===== 从名称+描述 scaffold =====
  const created = await callCreate({
    title: "测试工作台 Demo",
    description: "整理测试记录",
    icon: "phosphor:books",
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.ok, true);
  assert.equal(created.data.mode, "scaffolded");
  assert.match(
    created.data.savePoint?.commitSha,
    /^[a-f0-9]{40}$/u,
    "a created App must immediately expose a built-in Git save point",
  );
  const appId = created.data.appId as string;
  assert.ok(appId, "scaffold should produce an app id");
  assert.ok(existsSync(join(created.data.appRoot, "opengrove.app.json")));
  assert.equal(statSync(join(created.data.appRoot, ".git")).isFile(), true, "Host-managed Apps use a Git pointer");
  assert.match(readFileSync(join(created.data.appRoot, ".git"), "utf8"), /^gitdir: .+\n$/u);
  const createdManifest = JSON.parse(readFileSync(join(created.data.appRoot, "opengrove.app.json"), "utf8")) as {
    icon?: string;
    ui?: { surface?: string };
    employees?: unknown[];
  };
  assert.equal(createdManifest.icon, "phosphor:books");
  assert.equal(createdManifest.ui?.surface, "setup");
  assert.equal(createdManifest.employees, undefined, "new App must not declare a placeholder Operator");
  assert.equal(existsSync(join(created.data.appRoot, "ui", "index.html")), false, "new App must not emit demo HTML");
  assert.equal(
    existsSync(join(created.data.appRoot, ".opengrove-build.json")),
    true,
    "new Apps must carry a trusted build contract before the author reaches publishing",
  );
  assert.equal(
    existsSync(join(created.data.appRoot, ".gitignore")),
    true,
    "new Apps must ignore local build byproducts by default",
  );
  const cleanCheckoutRoot = join(tempRoot, "clean-checkout");
  const cloned = spawnSync("git", ["clone", "--quiet", created.data.appRoot, cleanCheckoutRoot], {
    encoding: "utf8",
  });
  assert.equal(cloned.status, 0, `new App repository must clone cleanly: ${cloned.stderr}`);
  const built = spawnSync(process.execPath, ["build.mjs"], {
    cwd: cleanCheckoutRoot,
    encoding: "utf8",
  });
  assert.equal(
    built.status,
    0,
    `a newly scaffolded App must build from a fresh checkout without author edits: ${built.stderr}`,
  );
  assert.equal(
    spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: cleanCheckoutRoot,
      encoding: "utf8",
    }).stdout,
    "",
    "the default trusted build must reproduce committed outputs without dirtying the checkout",
  );

  const mounted = state.settings.mountedApps.find((app) => app.id === appId);
  assert.ok(mounted, "created app should be mounted in settings");
  assert.equal(mounted?.enabled, true);
  assert.equal(mounted?.appBuilderEnabled, true, "only a newly scaffolded App should opt into App Builder seeding");
  assert.equal(
    loadBridgeSettings(state).mountedApps.find((app) => app.id === appId)?.appBuilderEnabled,
    true,
    "the creation marker must survive a settings reload",
  );
  assert.ok(existsSync(settingsPath), "settings should be persisted");

  // App 资料可独立修改，且图标只接受受支持的系统 token 或安全栅格图。
  const identityBefore = await callApps(`/apps/${encodeURIComponent(appId)}/identity`, undefined, "GET");
  assert.equal(identityBefore.status, 200);
  assert.equal(identityBefore.data.app.icon, "phosphor:books");
  const updatedIdentity = await callApps(
    `/apps/${encodeURIComponent(appId)}/identity`,
    {
      title: "测试工作台",
      description: "统一后的 App 资料",
      icon: "phosphor:chart-bar",
    },
    "PATCH",
  );
  assert.equal(updatedIdentity.status, 200);
  assert.equal(updatedIdentity.data.app.title, "测试工作台");
  assert.equal(updatedIdentity.data.app.description, "统一后的 App 资料");
  assert.equal(updatedIdentity.data.app.icon, "phosphor:chart-bar");
  const rejectedIdentityIcon = await callApps(
    `/apps/${encodeURIComponent(appId)}/identity`,
    {
      title: "测试工作台",
      description: "不应被破坏",
      icon: "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=",
    },
    "PATCH",
  );
  assert.equal(rejectedIdentityIcon.status, 400);
  assert.equal(rejectedIdentityIcon.data.error, "app_icon_invalid");
  const identityAfterReject = await callApps(`/apps/${encodeURIComponent(appId)}/identity`, undefined, "GET");
  assert.equal(identityAfterReject.data.app.description, "统一后的 App 资料");

  // App 默认群应存在，严格只有 App 构建师和 PM。
  const roomId = defaultAppGroupRoomId(appId);
  const appRoom = state.app.rooms.getRoom(roomId);
  const builderId = appBuilderMemberId(appId);
  const builder = state.app.rooms.listMembers().find((member) => member.id === builderId);
  assert.ok(appRoom, "default app group room should exist");
  assert.ok(appRoom?.memberIds.includes(builderId), "new App should include the built-in App Builder employee");
  assert.equal(
    builder?.workspaceRoot,
    created.data.appRoot,
    "App Builder must be scoped to the whole current App root so it can maintain manifest, UI source, skills, and commands",
  );
  assert.equal(
    builder?.role,
    [
      `你是 appId="${appId}" 的 OpenGrove App 构建师。`,
      "面向不懂代码的业务同学，先用业务语言说明用户会看到什么，不主动要求他们理解代码、命令或协议。",
      "已绑定 App 时，收到页面、数据或交互需求后，先检查当前 App 已有能力：能做的直接推进；缺后端数据时继续完成不依赖真实数据的 UI、交互、空状态和接入边界，并整理可直接转交的协作说明；不得用假数据冒充已接通。",
      "负责创建、导入、调整和验证这个 OpenGrove App。",
      "业务专属 UI 留在 App 包内；需要保留文件工作台时，使用 file-workbench 的 App-owned MCP View Tab。",
      `App workspace: ${created.data.appRoot}`,
    ].join("\n"),
    "App Builder role should describe its responsibility without imposing a requirements workflow",
  );
  assert.deepEqual(
    new Set(appRoom?.memberIds),
    new Set([builderId, pmAgentMemberId(appId)]),
    "new App setup room should contain exactly App Builder and PM",
  );
  const messages = state.app.rooms.listMessages(roomId);
  const welcome = messages.find((message) => message.text.includes("施工队已就位"));
  assert.ok(welcome, "App Builder welcome message should be posted");
  assert.equal(welcome?.senderId, builderId);

  // ===== 纯中文名称稳定且不冲突 =====
  const chineseA = await callCreate({ title: "故事花园", description: "做一个可交互的故事数据看板" });
  const chineseB = await callCreate({ title: "故事数据后台" });
  assert.equal(chineseA.status, 200);
  assert.equal(chineseB.status, 200);
  assert.notEqual(chineseA.data.appId, chineseB.data.appId);
  assert.notEqual(chineseA.data.appId, "opengrove-app");
  const duplicateChinese = await callCreate({ title: "故事花园" });
  assert.equal(duplicateChinese.status, 409);
  assert.equal(
    basename(duplicateChinese.data.appRoot),
    chineseA.data.appId,
    "same Chinese title should resolve to the same stable id",
  );

  // 固定选择不依赖模型可用性；不可运行时仍将 App 名称和初步想法写入 Builder 上下文。
  const chineseBuilderId = appBuilderMemberId(chineseA.data.appId);
  state.app.rooms.patchMember(chineseBuilderId, { kernel: "browser" });
  const selectedView = await callApps(`/apps/${encodeURIComponent(chineseA.data.appId)}/setup`, { choice: "view" });
  assert.equal(selectedView.status, 200);
  assert.equal(selectedView.data.ui.surface, "setup", "custom View remains in setup until a valid build exists");
  assert.equal(selectedView.data.setup.choice, "view");
  assert.equal(
    selectedView.data.builderScheduled,
    false,
    "the deterministic choice must succeed without a runnable model",
  );
  const customChoiceMessage = state.app.rooms
    .listMessages(defaultAppGroupRoomId(chineseA.data.appId))
    .find((message) => message.senderType === "user" && message.text.includes("我要创建一个名为"));
  assert.equal(
    customChoiceMessage?.text,
    [
      "我要创建一个名为「故事花园」的 OpenGrove App，并为它做一个自定义界面。",
      "我的初步想法是：做一个可交互的故事数据看板",
      "请先介绍一下你能为这个 App 做什么。我们先聊一聊需求，把目标和想法梳理清楚，再决定怎么开始。",
    ].join("\n"),
  );
  assert.deepEqual(customChoiceMessage?.targetIds, [chineseBuilderId]);

  // ===== Host setup 选择原子落盘 =====
  const selectedWorkbench = await callApps(`/apps/${encodeURIComponent(appId)}/setup`, { choice: "file-workbench" });
  assert.equal(selectedWorkbench.status, 200);
  assert.equal(selectedWorkbench.data.ui.surface, "file-workbench");
  assert.deepEqual(
    validateAppReleaseBuildContract(created.data.appRoot),
    { ok: true, detail: "build_contract_valid" },
    "the built-in workbench choice must be immediately ready for trusted publishing",
  );
  assert.equal(
    packApp(created.data.appRoot, { outputPath: join(tempRoot, "created-app.tgz") }).packageManifest.appId,
    appId,
    "a newly created App must become packable after choosing its deterministic workbench",
  );
  const workbenchChoiceMessage = state.app.rooms
    .listMessages(roomId)
    .find((message) => message.senderType === "user" && message.text.includes("内置工作台 UI"));
  assert.ok(workbenchChoiceMessage, "the deterministic Host choice should be persisted in the App room ledger");
  assert.deepEqual(workbenchChoiceMessage?.targetIds, [builderId], "the choice should become Builder context");
  const workbenchManifestText = readFileSync(join(created.data.appRoot, "opengrove.app.json"), "utf8");
  assert.equal(JSON.parse(workbenchManifestText).ui.surface, "file-workbench");
  const invalidViewPatch = await callApps(
    `/apps/${encodeURIComponent(appId)}/runtime`,
    {
      surface: "view",
      view: { protocol: "mcp-app" },
    },
    "PATCH",
  );
  assert.equal(invalidViewPatch.status, 400);
  assert.equal(
    readFileSync(join(created.data.appRoot, "opengrove.app.json"), "utf8"),
    workbenchManifestText,
    "a rejected manifest patch must leave the original file byte-for-byte intact",
  );
  mkdirSync(join(created.data.appRoot, "ui"), { recursive: true });
  writeFileSync(join(created.data.appRoot, "ui", "index.html"), "<!doctype html><title>real view</title>\n");
  const validViewPatch = await callApps(
    `/apps/${encodeURIComponent(appId)}/runtime`,
    {
      surface: "view",
      view: {
        protocol: "mcp-app",
        entry: "ui/index.html",
        tools: [],
        csp: {},
      },
    },
    "PATCH",
  );
  assert.equal(validViewPatch.status, 200);
  assert.equal(validViewPatch.data.ui.surface, "view");
  assert.ok(validViewPatch.data.revision, "runtime changes should expose a manifest revision");
  assert.ok(
    state.app.events
      .list()
      .some(
        (event) =>
          event.type === "runtime.diagnostic" &&
          event.name === "app.runtime-changed" &&
          event.data.appId === appId &&
          event.data.surface === "view",
      ),
    "an atomic manifest patch should emit an App-scoped runtime-changed event",
  );
  writeFileSync(join(created.data.appRoot, "ui", "index.html"), "<!doctype html><title>rebuilt view</title>\n");
  const rebuiltRuntime = await callApps(`/apps/${encodeURIComponent(appId)}/runtime`, undefined, "GET");
  assert.equal(rebuiltRuntime.status, 200);
  assert.notEqual(
    rebuiltRuntime.data.revision,
    validViewPatch.data.revision,
    "direct bundle changes should alter the polled runtime revision and force a safe View remount",
  );

  // ===== 同名冲突 =====
  const duplicate = await callCreate({ title: "测试工作台 Demo" });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error, "app_directory_already_exists");

  state.settings.uninstalledStoreAppIds = [appId];
  const remountedCreated = await callCreate({ source: created.data.appRoot });
  assert.equal(remountedCreated.status, 200);
  assert.equal(
    state.settings.uninstalledStoreAppIds.includes(appId),
    false,
    "mounting a local App must clear its stale Store uninstall marker before recreation",
  );
  assert.equal(
    state.settings.mountedApps.find((app) => app.id === appId)?.appBuilderEnabled,
    true,
    "remounting an existing scaffolded App must preserve its Builder lifecycle",
  );
  assert.equal(
    state.app.rooms.listMembers().find((member) => member.id === builderId)?.disabled,
    false,
    "a hot reload must not retire the scoped Builder that performs it",
  );
  assert.equal(
    state.app.rooms.getRoom(roomId)?.memberIds.includes(builderId),
    true,
    "the Builder remains a visible member of the App group after remount",
  );

  // ===== 导入本地普通项目目录 =====
  const sourceDir = join(tempRoot, "plain-project");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "main.py"), "print('hi')\n");
  const imported = await callCreate({ source: sourceDir, title: "Imported Project" });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.mode, "imported");
  const importedMount = state.settings.mountedApps.find((app) => app.id === imported.data.appId);
  assert.ok(importedMount);
  assert.equal(importedMount?.appBuilderEnabled, false);
  assert.equal(
    state.app.rooms.listMembers().some((member) => member.id === appBuilderMemberId(imported.data.appId)),
    false,
    "an imported project should not receive an App Builder by default",
  );

  // ===== 导入已是 App 的目录：原地挂载，不复制 =====
  const existingAppDir = join(tempRoot, "existing-app");
  mkdirSync(join(existingAppDir, "workspace"), { recursive: true });
  writeFileSync(
    join(existingAppDir, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "existing-app",
        title: "Existing App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(existingAppDir, "program.txt"), "existing history\n", "utf8");
  assert.equal(spawnSync("git", ["init", "--quiet", existingAppDir]).status, 0);
  assert.equal(spawnSync("git", ["-C", existingAppDir, "add", "-A"]).status, 0);
  assert.equal(
    spawnSync("git", [
      "-C",
      existingAppDir,
      "-c",
      "user.name=Existing Author",
      "-c",
      "user.email=existing@example.com",
      "commit",
      "--quiet",
      "-m",
      "Existing App history",
    ]).status,
    0,
  );
  const existingHead = spawnSync("git", ["-C", existingAppDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(join(existingAppDir, "program.txt"), "uncommitted author edit\n", "utf8");
  const mountedExisting = await callCreate({ source: existingAppDir });
  assert.equal(mountedExisting.status, 200);
  assert.equal(mountedExisting.data.appId, "existing-app");
  assert.equal(mountedExisting.data.appRoot, existingAppDir, "existing app should mount in place");
  assert.match(mountedExisting.data.savePoint.commitSha, /^[a-f0-9]{40}$/u);
  assert.notEqual(
    mountedExisting.data.savePoint.commitSha,
    existingHead,
    "OpenGrove save points for an external repository must live outside the user's branch",
  );
  assert.equal(
    spawnSync("git", ["-C", existingAppDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    existingHead,
    "adopting an existing repository must not create or rewrite its commits",
  );
  assert.match(
    spawnSync("git", ["-C", existingAppDir, "status", "--porcelain"], { encoding: "utf8" }).stdout,
    /program\.txt/u,
    "adopting an existing repository must preserve its uncommitted author edit",
  );
  assert.equal(state.settings.mountedApps.find((app) => app.id === "existing-app")?.appBuilderEnabled, false);
  assert.equal(
    state.app.rooms.listMembers().some((member) => member.id === appBuilderMemberId("existing-app")),
    false,
    "an existing App mounted in place should keep only its own employees",
  );

  const existingRoomId = defaultAppGroupRoomId("existing-app");
  assert.deepEqual(
    state.app.rooms.getRoom(existingRoomId)?.memberIds,
    [pmAgentMemberId("existing-app")],
    "an existing App without declared employees should start with PM only",
  );
  const rejectedForeignRoom = await callApps("/apps/existing-app/employees/app-builder", { roomId });
  assert.equal(rejectedForeignRoom.status, 400);
  assert.equal(rejectedForeignRoom.data.error, "app_group_room_required");
  assert.notEqual(
    loadBridgeSettings(state).mountedApps.find((app) => app.id === "existing-app")?.appBuilderEnabled,
    true,
    "a foreign App group must not enable the scoped App Builder binding",
  );
  const enabledExistingBuilder = await callApps("/apps/existing-app/employees/app-builder", { roomId: existingRoomId });
  assert.equal(enabledExistingBuilder.status, 200);
  assert.equal(enabledExistingBuilder.data.ok, true);
  assert.equal(enabledExistingBuilder.data.member.id, appBuilderMemberId("existing-app"));
  assert.equal(enabledExistingBuilder.data.member.employeeDefinitionId, OPENGROVE_APP_BUILDER_MEMBER_ID);
  assert.equal(enabledExistingBuilder.data.member.appId, "existing-app");
  assert.equal(enabledExistingBuilder.data.member.workspaceRoot, existingAppDir);
  assert.ok(
    enabledExistingBuilder.data.member.defaultSkillIds.includes(OPENGROVE_APP_WORKSPACE_GUARD_SKILL_NAME),
    "on-demand App Builder binding should retain the workspace guard skill",
  );
  assert.equal(
    loadBridgeSettings(state).mountedApps.find((app) => app.id === "existing-app")?.appBuilderEnabled,
    true,
    "on-demand App Builder binding must persist the lifecycle marker",
  );
  assert.ok(
    state.app.rooms.getRoom(existingRoomId)?.memberIds.includes(appBuilderMemberId("existing-app")),
    "the scoped App Builder should join the selected App group",
  );
  assert.equal(
    state.app.rooms.getRoom(existingRoomId)?.memberIds.includes(OPENGROVE_APP_BUILDER_MEMBER_ID),
    false,
    "the global App Builder definition must never join an App group directly",
  );

  const existingBuilderId = appBuilderMemberId("existing-app");
  const removedFromGroup = await callRoomMembers(
    `/rooms/${encodeURIComponent(existingRoomId)}/members/${encodeURIComponent(existingBuilderId)}`,
  );
  assert.equal(removedFromGroup.status, 200);
  assert.equal(state.app.rooms.getRoom(existingRoomId)?.memberIds.includes(existingBuilderId), false);
  assert.equal(
    state.app.rooms.listMembers().find((member) => member.id === existingBuilderId)?.disabled,
    false,
    "the HTTP group-removal route must leave the employee globally enabled",
  );
  assert.equal(state.app.rooms.listDeletedMemberIds().includes(existingBuilderId), false);

  const reboundAfterGroupRemoval = await callApps("/apps/existing-app/employees/app-builder", {
    roomId: existingRoomId,
  });
  assert.equal(reboundAfterGroupRemoval.status, 200);
  assert.equal(state.app.rooms.getRoom(existingRoomId)?.memberIds.includes(existingBuilderId), true);

  // Older builds represented a group removal as a globally disabled seed tombstone.
  // A deliberate rebind must revive that scoped binding instead of returning a silent 500 forever.
  state.app.rooms.removeMember(existingRoomId, existingBuilderId);
  state.app.rooms.patchMember(existingBuilderId, {
    disabled: true,
    status: "offline",
    lastActive: "已移除",
  });
  const reboundExistingBuilder = await callApps("/apps/existing-app/employees/app-builder", { roomId: existingRoomId });
  assert.equal(reboundExistingBuilder.status, 200, "explicit rebind should recover a legacy Builder tombstone");
  assert.equal(reboundExistingBuilder.data.member.id, existingBuilderId);
  assert.equal(reboundExistingBuilder.data.member.disabled, false);
  assert.equal(state.app.rooms.getRoom(existingRoomId)?.memberIds.includes(existingBuilderId), true);
  assert.equal(
    state.app.rooms.getRoom(existingRoomId)?.memberIds.filter((memberId) => memberId === existingBuilderId).length,
    1,
    "rebind stays idempotent",
  );

  // ===== Dev profile 隔离：新建与导入必须落进 Bridge 解析的 profile Apps 目录 =====
  const devAppsRoot = join(tempRoot, "OpenGroveDev-production", "apps");
  const devSourceDir = join(tempRoot, "dev-plain-project");
  mkdirSync(devSourceDir, { recursive: true });
  writeFileSync(join(devSourceDir, "main.py"), "print('dev')\n");
  const appsDirEnv = appEnvName("APP_STORE_APPS_DIR");
  const previousAppsDirEnv = process.env[appsDirEnv];
  try {
    process.env[appsDirEnv] = devAppsRoot;
    const devCreated = await callCreate({ title: "Dev Profile App" });
    assert.equal(devCreated.status, 200);
    assert.equal(
      devCreated.data.appRoot,
      join(devAppsRoot, devCreated.data.appId),
      "a created App must land in the bridge-resolved profile apps directory",
    );
    assert.equal(
      existsSync(join(devCreated.data.appRoot, "opengrove.app.json")),
      true,
      "the profile-scoped App must actually be scaffolded on disk",
    );
    const devImported = await callCreate({ source: devSourceDir, title: "Dev Profile Import" });
    assert.equal(devImported.status, 200);
    assert.equal(
      devImported.data.appRoot,
      join(devAppsRoot, devImported.data.appId),
      "an imported project must be copied into the same profile apps directory",
    );
  } finally {
    if (previousAppsDirEnv === undefined) delete process.env[appsDirEnv];
    else process.env[appsDirEnv] = previousAppsDirEnv;
  }
  const productionAppsDir = defaultOpenGroveAppsDir();
  assert.equal(
    existsSync(join(productionAppsDir, "dev-profile-app")),
    false,
    "a Dev profile create must never write into the production OpenGrove apps directory",
  );

  console.log("app-create-route-harness ok");
} finally {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
