import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appBuilderMemberId,
  mountedAppDefaultEmployees,
  mountedAppEmployeeSummaries,
  mountedAppMemberId,
  mountedAppMemberSlug,
  OPENGROVE_APP_BUILDER_SKILL_NAME,
  OPENGROVE_APP_BUILDER_MEMBER_ID,
  OPENGROVE_APP_WORKSPACE_GUARD_SKILL_NAME,
  PM_AGENT_SKILL_NAME,
} from "../server/bridge-mounted-app-employees.js";
import { defaultBridgeSettings } from "../server/bridge-settings-store.js";
import type { BridgeSettings } from "../server/bridge-types.js";
import { isBuiltinSystemMemberId } from "../rooms/channel-store.js";

// ===== P3 harness: PM 规划 agent(系统内置模板,每 app 实例化) =====
// 覆盖规格 P3:
//   - 构造一个 mounted app(含 employees)→ seed 后断言该 app 出现 member-app-<app>-pm 成员。
//   - PM 成员 role 含该 app 的员工名单。
//   - PM 成员是普通 app 成员(不是 grove-guide 那种幽灵成员):进成员库、有 appId。
//   - disablePmAgent 可显式关闭 App 的可选 PM。

function createApp(
  tempRoot: string,
  appId: string,
  appTitle: string,
  employees: unknown[],
  manifestExtra: Record<string, unknown> = {},
): string {
  const appRoot = join(tempRoot, appId);
  const workspaceRoot = join(appRoot, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    JSON.stringify({
      id: appId,
      title: appTitle,
      workspace: { path: "workspace" },
      employees,
      ...manifestExtra,
    }),
  );
  return appRoot;
}

function settingsForApp(appId: string, appRoot: string): BridgeSettings {
  return {
    ...defaultBridgeSettings(),
    mountedApps: [{ id: appId, path: appRoot, enabled: true }],
  };
}

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-pm-agent-seed-"));
try {
  // ===== 例 1:app 含 2 个 employees → 自动长出 PM 成员,role 含员工名单 =====
  const appRoot = createApp(
    tempRoot,
    "demo-app",
    "演示应用",
    [
      { id: "analyst", name: "分析师", kernel: "claude-code", role: "只读数据分析" },
      { id: "operator", name: "运营", kernel: "claude-code", role: "执行投放操作" },
    ],
    {
      defaultLocale: "zh-CN",
      locales: {
        en: {
          title: "Demo App",
          employees: {
            analyst: {
              name: "Analyst",
              publicDescription: "Localized public summary",
            },
          },
        },
      },
      ui: { agentContext: "APP_UI_AGENT_CONTEXT_MARKER" },
    },
  );
  writeFileSync(join(appRoot, "AGENTS.md"), "APP_AGENTS_CONTEXT_MARKER\n");

  const demoSettings = {
    ...settingsForApp("demo-app", appRoot),
    languagePreference: "en",
  } satisfies BridgeSettings;
  const defaultMembers = mountedAppDefaultEmployees(demoSettings);
  assert.equal(
    defaultMembers.some((member) => member.id === appBuilderMemberId("demo-app")),
    false,
    "mounted Apps must not receive an App Builder unless creation explicitly enabled it",
  );

  const demoSettingsWithBuilder: BridgeSettings = {
    ...demoSettings,
    mountedApps: demoSettings.mountedApps.map((app) => ({ ...app, appBuilderEnabled: true })),
  };
  const members = mountedAppDefaultEmployees(demoSettingsWithBuilder);

  const pmMember = members.find((member) => member.id === "member-app-demo-app-pm");
  const analystMember = members.find((member) => member.id === "member-app-demo-app-analyst");
  const appBuilder = members.find((member) => member.id === appBuilderMemberId("demo-app"));
  assert.ok(appBuilder, "every mounted App should automatically gain an App Builder");
  assert.equal(appBuilder.appId, "demo-app");
  assert.equal(appBuilder.employeeDefinitionId, OPENGROVE_APP_BUILDER_MEMBER_ID);
  assert.equal(appBuilder.name, "App 构建师");
  assert.equal(appBuilder.kernel, "claude-code");
  assert.equal(appBuilder.model, "claude-opus-4-8");
  assert.deepEqual(appBuilder.defaultSkillIds, [
    OPENGROVE_APP_BUILDER_SKILL_NAME,
    OPENGROVE_APP_WORKSPACE_GUARD_SKILL_NAME,
  ]);
  assert.deepEqual(appBuilder.availableSkillIds, appBuilder.defaultSkillIds);
  assert.match(appBuilder.role, /已绑定 App 时.*先检查当前 App 已有能力/);
  assert.equal(
    appBuilder.publicDescription,
    "帮助业务同学修改 App 页面和流程，判断现有能力，继续完成可交付部分并说明所需后端支持。",
  );
  assert.equal(appBuilder.inputSpec, "业务目标、页面问题、希望新增的数据或交互，或现有项目目录。");
  assert.equal(appBuilder.outputSpec, "可运行且经过验证的 App 改动、等待真实数据接入的部分，以及必要的后端协作说明。");
  assert.deepEqual(appBuilder.publicSkills, ["App 创建", "App 导入", "页面与流程改造", "数据能力判断"]);
  assert.ok(pmMember, "member-app-demo-app-pm member should be appended automatically");
  assert.equal(pmMember.employeeDefinitionId, "pm", "App PM should bind to the shared global PM employee definition");
  assert.equal(analystMember?.name, "分析师", "locale must not change the canonical runtime name");
  assert.equal(
    analystMember?.kernel,
    "claude-code",
    "a valid App Employee must remain seeded even when its Kernel is not the active system Kernel",
  );
  assert.equal(analystMember?.displayName, "Analyst", "locale only provides the display name");
  assert.equal(analystMember?.displayPublicDescription, "Localized public summary");
  assert.equal(analystMember?.model, "deepseek-v4-flash", "App Employees without a model use the product fallback");
  assert.equal(pmMember.appId, "demo-app", "PM member carries an appId and is a regular app member");
  assert.equal(pmMember.name, "演示应用 PM", "PM runtime name keeps the manifest default locale");
  assert.equal(pmMember.displayName, "Demo App PM", "PM display name follows the UI language");
  assert.equal(pmMember.source, "local");
  assert.doesNotMatch(
    pmMember.role,
    /演示应用|Demo App/,
    "PM stable prompt must not inject the App display name in any language",
  );
  assert.doesNotMatch(
    pmMember.role,
    /\((分析师|运营)\)/,
    "PM stable prompt must not inject employee display or canonical names",
  );
  assert.match(pmMember.role, /member-app-demo-app-analyst/);
  assert.match(pmMember.role, /member-app-demo-app-operator/);
  // role 不应把自己列进可编排名单。
  assert.ok(
    !pmMember.role.includes("member-app-demo-app-pm (Demo App PM)"),
    "PM must not list itself in the orchestration roster",
  );
  // 默认 skill 是 pm-planner;默认 kernel 落在 hostTools-capable(claude-code)。
  assert.deepEqual(pmMember.defaultSkillIds, [PM_AGENT_SKILL_NAME]);
  assert.equal(pmMember.kernel, "claude-code", "PM default kernel should be the hostTools-capable claude-code");
  assert.equal(pmMember.model, "deepseek-v4-flash", "PM must use its concrete product model default");
  assert.equal(pmMember.reasoningEffort, "medium", "PM default reasoning effort should be medium");
  assert.doesNotMatch(pmMember.role, /来源信封标记为 PM 自动路由|PM 未提及消息路由规则/);
  assert.match(pmMember.role, /用户直接要求你规划或编排工作流/);
  assert.equal(pmMember.workspaceRoot, join(appRoot, "workspace"), "PM should use the mounted App's workspace");
  assert.ok(
    pmMember.role.includes("APP_UI_AGENT_CONTEXT_MARKER"),
    "PM stable definition should include ui.agentContext",
  );
  assert.ok(pmMember.role.includes("APP_AGENTS_CONTEXT_MARKER"), "PM stable definition should include App AGENTS.md");
  assert.ok(pmMember.role.includes(`App 根目录：${appRoot}`), "PM stable definition should include the App root");
  assert.ok(
    pmMember.role.includes(`App 工作区：${join(appRoot, "workspace")}`),
    "PM stable definition should include the App workspace",
  );
  const publicPm = mountedAppEmployeeSummaries(demoSettingsWithBuilder).find((member) => member.id === pmMember.id);
  assert.equal(publicPm?.role, '你是 appId="demo-app" 的 OpenGrove App PM Agent。');
  assert.doesNotMatch(publicPm?.role ?? "", /APP_AGENTS_CONTEXT_MARKER|App 根目录|App 工作区/);
  console.log("P3 例1 PM 成员自动实例化 + role 含员工名单 passed");

  // ===== 例 2:PM 成员不是 grove-guide 那种幽灵成员(isBuiltinSystemMemberId 不含它) =====
  assert.equal(isBuiltinSystemMemberId("member-app-demo-app-pm"), false, "PM is not a built-in system ghost member");
  assert.equal(isBuiltinSystemMemberId(pmMember.id), false);
  console.log("P3 例2 PM 是普通 app 成员非幽灵 passed");

  // ===== 例 3:PM 成员 id 走 seed sync 前缀,会被 stale/restore 逻辑管理 =====
  // shouldDisableStaleMountedAppSeedMember 用 member.id.startsWith(`member-app-${slug}-`) 判断,
  // PM id = member-app-demo-app-pm 也命中此前缀,无需额外改 stale/restore 逻辑。
  assert.ok(
    pmMember.id.startsWith("member-app-demo-app-"),
    "PM id should match the seed sync stale/restore prefix check",
  );
  console.log("P3 例3 PM id 命中 seed sync 前缀 passed");

  // ===== 例 4:disablePmAgent 可关闭可选 PM =====
  const disabledAppRoot = createApp(
    tempRoot,
    "no-pm-app",
    "No PM App",
    [{ id: "worker", name: "Worker", kernel: "claude-code", role: "干活" }],
    { disablePmAgent: true },
  );

  const disabledSettings = settingsForApp("no-pm-app", disabledAppRoot);
  const disabledMembers = mountedAppDefaultEmployees({
    ...disabledSettings,
    mountedApps: disabledSettings.mountedApps.map((app) => ({ ...app, appBuilderEnabled: true })),
  });

  const disabledPm = disabledMembers.find((member) => member.id === "member-app-no-pm-app-pm");
  assert.equal(disabledPm, undefined, "disablePmAgent=true does not generate the optional PM");
  assert.equal(disabledMembers.length, 2, "disabling the PM keeps regular employees and the App Builder");
  console.log("P3 例4 disablePmAgent 可关闭 PM passed");

  const separatedAppRoot = createApp(tempRoot, "separated-app", "Separated App", [
    { id: "worker", name: "Worker", kernel: "claude-code", role: "Works in stable Workspace." },
  ]);
  const stableWorkspaceRoot = join(tempRoot, "stable-workspaces", "separated-app");
  mkdirSync(stableWorkspaceRoot, { recursive: true });
  const separatedMembers = mountedAppDefaultEmployees({
    ...settingsForApp("separated-app", separatedAppRoot),
    mountedApps: [
      {
        id: "separated-app",
        path: separatedAppRoot,
        workspacePath: stableWorkspaceRoot,
        enabled: true,
        appBuilderEnabled: true,
      },
    ],
  });
  assert.ok(separatedMembers.length > 0);
  const separatedAppBuilder = separatedMembers.find((member) => member.id === appBuilderMemberId("separated-app"));
  assert.equal(
    separatedMembers
      .filter((member) => member !== separatedAppBuilder)
      .every((member) => member.workspaceRoot === stableWorkspaceRoot),
    true,
    "business Employees must use the persisted Host Workspace binding instead of the replaceable Program link path",
  );
  assert.equal(
    separatedAppBuilder?.workspaceRoot,
    separatedAppRoot,
    "the App Builder intentionally edits the active Program generation, not business Workspace data",
  );

  assert.notEqual(
    mountedAppMemberSlug("a:b"),
    mountedAppMemberSlug("a-b"),
    "two valid App ids must never share a generated Employee namespace",
  );
  const colonAppRoot = createApp(tempRoot, "a:b", "Colon App", [
    { id: "worker", name: "Colon Worker", kernel: "claude-code", role: "work" },
  ]);
  const hyphenAppRoot = createApp(tempRoot, "a-b", "Hyphen App", [
    { id: "worker", name: "Hyphen Worker", kernel: "claude-code", role: "work" },
  ]);
  const collisionSafeMembers = mountedAppDefaultEmployees({
    mountedApps: [
      { id: "a:b", path: colonAppRoot, enabled: true },
      { id: "a-b", path: hyphenAppRoot, enabled: true },
    ],
  } as never);
  const colonMembers = collisionSafeMembers.filter((member) => member.appId === "a:b");
  const hyphenMembers = collisionSafeMembers.filter((member) => member.appId === "a-b");
  assert.equal(colonMembers.length, 2);
  assert.equal(hyphenMembers.length, 2);
  assert.equal(
    colonMembers.some((member) => hyphenMembers.some((candidate) => candidate.id === member.id)),
    false,
    "two simultaneously mounted valid Apps must not overwrite each other's PM or worker rows",
  );
  assert.notEqual(
    mountedAppMemberId("tuple-a", "b-c"),
    mountedAppMemberId("tuple-a-b", "c"),
    "the App/Employee separator must not allow tuple-boundary collisions",
  );
  assert.equal(mountedAppMemberId("tuple-a", "b-c"), "member-app-tuple-a-b%2Dc");

  // ===== 例 5:无显式 employees 的 app → 只保留 PM,不生成含义不明的 Operator =====
  const emptyAppRoot = createApp(tempRoot, "empty-app", "Empty App", []);
  const emptyMembers = mountedAppDefaultEmployees(settingsForApp("empty-app", emptyAppRoot));
  const emptyPm = emptyMembers.find((member) => member.id === "member-app-empty-app-pm");
  assert.ok(emptyPm, "an app without explicit employees should still gain a PM");
  assert.equal(
    emptyMembers.some((member) => member.id === "member-app-empty-app-operator"),
    false,
    "no fallback Operator should be auto-filled when there are no explicit employees",
  );
  assert.equal(
    emptyMembers.length,
    1,
    "without explicit employees and with the Builder disabled, only the PM should exist",
  );
  assert.deepEqual(
    emptyPm.availableSkillIds,
    [PM_AGENT_SKILL_NAME],
    "a PM-only App should carry the App capabilities and keep at least the planning Skill",
  );
  assert.match(emptyPm.role, /当前没有可委派员工[\s\S]*自己完成[\s\S]*提示用户新增员工/);
  console.log("P3 例5 无显式 employees 的 app 只保留可自行处理的 PM passed");

  const emptyBuilderSettings = settingsForApp("empty-app", emptyAppRoot);
  const emptyBuilderMembers = mountedAppDefaultEmployees({
    ...emptyBuilderSettings,
    mountedApps: emptyBuilderSettings.mountedApps.map((app) => ({ ...app, appBuilderEnabled: true })),
  });
  const emptyBuilderPm = emptyBuilderMembers.find((member) => member.id === "member-app-empty-app-pm");
  assert.match(emptyBuilderPm?.role ?? "", new RegExp(`${appBuilderMemberId("empty-app")}:`));
  assert.doesNotMatch(
    emptyBuilderPm?.role ?? "",
    /当前没有可委派员工/,
    "when the roster already has a Builder, the PM prompt must not claim there are no delegable employees",
  );

  // ===== 例 6:manifest 不能用保留 id 覆盖 Host-owned App 构建师 =====
  const collisionAppRoot = createApp(tempRoot, "collision-app", "Collision App", [
    {
      id: "app-builder",
      name: "Manifest Builder",
      kernel: "codex",
      role: "This manifest entry must not replace the Host builder.",
    },
    {
      id: "pm",
      name: "Manifest PM",
      kernel: "codex",
      role: "This manifest entry must not replace the Host PM.",
    },
  ]);
  const collisionMembers = mountedAppDefaultEmployees({
    mountedApps: [{ id: "collision-app", path: collisionAppRoot, appBuilderEnabled: true }],
  } as never);
  const collisionBuilders = collisionMembers.filter((member) => member.id === appBuilderMemberId("collision-app"));
  assert.equal(collisionBuilders.length, 1, "a reserved id collision must keep only one App Builder");
  assert.equal(collisionBuilders[0]?.name, "App 构建师");
  assert.equal(collisionBuilders[0]?.employeeDefinitionId, OPENGROVE_APP_BUILDER_MEMBER_ID);
  assert.deepEqual(collisionBuilders[0]?.defaultSkillIds, [
    OPENGROVE_APP_BUILDER_SKILL_NAME,
    OPENGROVE_APP_WORKSPACE_GUARD_SKILL_NAME,
  ]);
  const collisionPms = collisionMembers.filter((member) => member.id === "member-app-collision-app-pm");
  assert.equal(collisionPms.length, 1, "a reserved id collision must keep only one App PM");
  assert.equal(collisionPms[0]?.name, "Collision App PM");
  assert.equal(collisionPms[0]?.employeeDefinitionId, "pm");
  assert.equal(
    collisionMembers.some((member) => member.name === "Manifest Builder"),
    false,
  );
  assert.equal(
    collisionMembers.some((member) => member.name === "Manifest PM"),
    false,
  );
  console.log("P3 例6 manifest 无法覆盖 Host App 构建师或 PM passed");

  // ===== 例 7:坏 App 完整隔离，不能只丢业务员工却留下 Host 生成成员 =====
  const invalidAppRoot = join(tempRoot, "invalid-app");
  mkdirSync(join(invalidAppRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(invalidAppRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "invalid-app",
      title: "Invalid App",
      workspace: "workspace",
      employees: [{ id: "worker", name: "Worker", kernel: "claude-code" }],
    }),
  );
  assert.deepEqual(
    mountedAppDefaultEmployees({
      ...settingsForApp("invalid-app", invalidAppRoot),
      mountedApps: [{ id: "invalid-app", path: invalidAppRoot, enabled: true, appBuilderEnabled: true }],
    }),
    [],
    "an invalid App manifest must be isolated as a whole instead of seeding a partial PM or App Builder roster",
  );
  console.log("P3 例7 坏 App 完整隔离 passed");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("pm-agent-seed-harness passed");
