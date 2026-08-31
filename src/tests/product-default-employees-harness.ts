import assert from "node:assert/strict";
import { RoomChannelStore } from "../rooms/channel-store.js";
import {
  GROVE_GUIDE_MEMBER_ID,
  GROVE_GUIDE_SKILL_NAME,
  productDefaultEmployees,
  syncGroveGuideWelcome,
} from "../server/product-default-employees.js";
import {
  OPENGROVE_APP_BUILDER_MEMBER_ID,
  OPENGROVE_APP_BUILDER_SKILL_NAME,
} from "../server/bridge-mounted-app-employees.js";
import { OPENGROVE_PM_MEMBER_ID, PM_AGENT_SKILL_NAME } from "../rooms/room-pm.js";
import { DEFAULT_BRIDGE_MODEL_ID } from "../server/bridge-types.js";
import {
  legacyNativeEmployeeModelReplacementV1,
  migrateLegacyNativeEmployeeModelsV1,
} from "../server/migrations/native-employee-model-v1.js";
import { resolveProviderRoute } from "../server/provider-profiles.js";

assert.equal(
  DEFAULT_BRIDGE_MODEL_ID,
  "deepseek-v4-flash",
  "new Bridge state must start from the concrete product model",
);
assert.equal(
  legacyNativeEmployeeModelReplacementV1({
    id: OPENGROVE_PM_MEMBER_ID,
    employeeDefinitionId: OPENGROVE_PM_MEMBER_ID,
    kernel: "claude-code",
    model: "native",
  }),
  "deepseek-v4-flash",
);
assert.equal(
  legacyNativeEmployeeModelReplacementV1({
    id: OPENGROVE_APP_BUILDER_MEMBER_ID,
    employeeDefinitionId: OPENGROVE_APP_BUILDER_MEMBER_ID,
    kernel: "claude-code",
    model: "native",
  }),
  "claude-opus-4-8",
);
assert.equal(
  legacyNativeEmployeeModelReplacementV1({
    id: "member-app-story-seed-worker",
    kernel: "claude-code",
    model: "native",
  }),
  "deepseek-v4-flash",
);
assert.equal(
  legacyNativeEmployeeModelReplacementV1({
    id: "legacy-unscoped-employee",
    kernel: "claude-code",
    model: "native",
  }),
  "deepseek-v4-flash",
  "unscoped legacy Employees must not retain the bootstrap sentinel",
);
assert.equal(
  legacyNativeEmployeeModelReplacementV1({
    id: "legacy-unconfigured-employee",
    kernel: "claude-code",
    model: "",
  }),
  "deepseek-v4-flash",
  "legacy Employees without a configured model must receive the product fallback",
);
assert.equal(
  legacyNativeEmployeeModelReplacementV1({
    id: "member-app-story-seed-user-choice",
    kernel: "claude-code",
    model: "native",
    userOverrides: ["model"],
  }),
  "deepseek-v4-flash",
  "the retired native sentinel must migrate even when an old UI marked it as a user override",
);
assert.equal(
  legacyNativeEmployeeModelReplacementV1({
    id: OPENGROVE_PM_MEMBER_ID,
    employeeDefinitionId: OPENGROVE_PM_MEMBER_ID,
    kernel: "codex",
    model: "native",
    userOverrides: ["kernel", "model"],
  }),
  "codex-default",
  "a product Employee on an explicitly selected Kernel must follow that Kernel default",
);
assert.equal(
  legacyNativeEmployeeModelReplacementV1({
    id: OPENGROVE_PM_MEMBER_ID,
    employeeDefinitionId: OPENGROVE_PM_MEMBER_ID,
    kernel: "remote-a2a",
    model: "native",
  }),
  undefined,
  "the Host must not assign a Bridge product model to a non-Bridge Kernel",
);

const legacyRooms = new RoomChannelStore();
legacyRooms.upsertMember({
  id: "legacy-explicit-native",
  name: "Legacy Explicit Native",
  kernel: "codex",
  model: "native",
  role: "testing",
  status: "idle",
  color: "blue",
  lastActive: "configured",
  userOverrides: ["kernel", "model"],
  source: "local",
});
assert.equal(migrateLegacyNativeEmployeeModelsV1(legacyRooms), true);
const migratedLegacyMember = legacyRooms.listMembers().find((member) => member.id === "legacy-explicit-native");
assert.equal(migratedLegacyMember?.model, "codex-default");
assert.deepEqual(
  migratedLegacyMember?.userOverrides,
  ["kernel"],
  "following a Kernel default must not remain pinned as a model override",
);
assert.equal(
  migrateLegacyNativeEmployeeModelsV1(legacyRooms),
  false,
  "the data transform remains idempotent inside its one-time gate",
);

const rooms = new RoomChannelStore();
const employees = productDefaultEmployees("zh-CN");
rooms.ensureOpenGroup(employees);

const guide = rooms.listMembers().find((member) => member.id === GROVE_GUIDE_MEMBER_ID);
assert.ok(guide, "OpenGrove should seed the newcomer guide employee");
assert.equal(guide.name, "新手引导员");
assert.equal(guide.kernel, "claude-code", "Grove must use the product Kernel instead of the active Runtime");
assert.equal(guide.model, "deepseek-v4-flash", "Grove must use its concrete product model default");
assert.deepEqual(guide.defaultSkillIds, [GROVE_GUIDE_SKILL_NAME]);
assert.deepEqual(guide.availableSkillIds, [GROVE_GUIDE_SKILL_NAME]);

const appBuilder = rooms.listMembers().find((member) => member.id === OPENGROVE_APP_BUILDER_MEMBER_ID);
assert.ok(appBuilder, "OpenGrove should expose one logical App Builder Employee");
assert.equal(appBuilder.employeeDefinitionId, OPENGROVE_APP_BUILDER_MEMBER_ID);
assert.equal(appBuilder.name, "App 构建师");
assert.equal(appBuilder.kernel, "claude-code", "App Builder must use the product Kernel");
assert.equal(appBuilder.model, "claude-opus-4-8", "App Builder must use its concrete product model default");
assert.deepEqual(appBuilder.defaultSkillIds, [OPENGROVE_APP_BUILDER_SKILL_NAME]);
assert.deepEqual(appBuilder.availableSkillIds, [OPENGROVE_APP_BUILDER_SKILL_NAME]);
assert.match(appBuilder.role, /没有指定 App 时/);
assert.match(appBuilder.role, /已绑定 App 时.*先检查当前 App 已有能力/);
assert.equal(
  appBuilder.publicDescription,
  "帮助业务同学修改 App 页面和流程，判断现有能力，继续完成可交付部分并说明所需后端支持。",
);
assert.equal(appBuilder.inputSpec, "业务目标、页面问题、希望新增的数据或交互，或现有项目目录。");
assert.equal(appBuilder.outputSpec, "可运行且经过验证的 App 改动、等待真实数据接入的部分，以及必要的后端协作说明。");
assert.deepEqual(appBuilder.publicSkills, ["App 创建", "App 导入", "页面与流程改造", "数据能力判断"]);

const pm = rooms.listMembers().find((member) => member.id === OPENGROVE_PM_MEMBER_ID);
assert.ok(pm, "OpenGrove should expose one logical PM Employee");
assert.equal(pm.employeeDefinitionId, OPENGROVE_PM_MEMBER_ID);
assert.equal(pm.name, "PM");
assert.equal(pm.kernel, "claude-code", "PM must use the product Kernel");
assert.equal(pm.model, "deepseek-v4-flash", "PM must use its concrete product model default");
assert.deepEqual(pm.defaultSkillIds, [PM_AGENT_SKILL_NAME]);
assert.deepEqual(pm.availableSkillIds, [PM_AGENT_SKILL_NAME]);
assert.match(pm.role, /没有指定 App 时/);

for (const employee of [guide, appBuilder, pm]) {
  assert.equal(employee.providerId, undefined, `${employee.id} must inherit its model Provider default`);
  const route = resolveProviderRoute(employee.kernel as "claude-code", employee.model, employee.providerId, [
    { modelId: "claude-opus-4-8", providerId: "ww" },
    { modelId: "deepseek-v4-pro", providerId: "ww" },
    { modelId: "deepseek-v4-flash", providerId: "ww" },
  ]);
  assert.equal(route.providerId, "ww");
  assert.equal(route.source, "model");
}

const scopedRoomId = `session-user-test:direct-${GROVE_GUIDE_MEMBER_ID}`;
assert.equal(
  syncGroveGuideWelcome(rooms, scopedRoomId, "zh-CN"),
  true,
  "first connected Kernel should create the scoped welcome conversation",
);
assert.equal(
  syncGroveGuideWelcome(rooms, scopedRoomId, "zh-CN"),
  false,
  "reconnect should not duplicate the welcome message",
);

const room = rooms.getRoom(scopedRoomId);
assert.ok(room, "newcomer guide should have a direct room");
assert.equal(
  rooms.getRoom(`direct-${GROVE_GUIDE_MEMBER_ID}`),
  undefined,
  "session welcome must not leak into an unscoped room",
);
const greetings = rooms.listMessages(room.id).filter((message) => message.senderId === GROVE_GUIDE_MEMBER_ID);
assert.equal(greetings.length, 1);
assert.match(greetings[0]?.text ?? "", /你好，我是 OpenGrove 的新手引导员/);

const englishRooms = new RoomChannelStore();
const englishEmployees = productDefaultEmployees("en");
englishRooms.ensureOpenGroup(englishEmployees);
const englishGuide = englishRooms.listMembers().find((member) => member.id === GROVE_GUIDE_MEMBER_ID);
const englishBuilder = englishRooms.listMembers().find((member) => member.id === OPENGROVE_APP_BUILDER_MEMBER_ID);
const englishPm = englishRooms.listMembers().find((member) => member.id === OPENGROVE_PM_MEMBER_ID);
assert.equal(englishGuide?.displayName, "Getting Started Guide");
assert.equal(englishBuilder?.displayName, "App Builder");
assert.deepEqual(englishBuilder?.displayPublicSkills, [
  "App creation",
  "App import",
  "Page and workflow changes",
  "Data capability assessment",
]);
assert.equal(
  englishBuilder?.displayPublicDescription,
  "Helps business users change App pages and workflows, assess current capabilities, deliver available work, and identify backend support.",
);
assert.match(englishBuilder?.displayOutputSpec ?? "", /waiting for real data.*backend handoff/i);
assert.equal(englishPm?.displayName, "OpenGrove PM");
assert.doesNotMatch(
  [
    englishGuide?.displayName,
    englishGuide?.displayRole,
    englishGuide?.displayPublicDescription,
    englishBuilder?.displayName,
    englishBuilder?.displayRole,
    englishPm?.displayName,
    englishPm?.displayRole,
  ].join(""),
  /\p{Script=Han}/u,
);
assert.equal(syncGroveGuideWelcome(englishRooms, "direct-guide-en", "en"), true);
const englishGreeting = englishRooms.listMessages("direct-guide-en")[0];
assert.match(englishGreeting?.text ?? "", /getting-started guide/i);
assert.doesNotMatch(`${englishGreeting?.senderName}${englishGreeting?.text}`, /\p{Script=Han}/u);

console.log("product-default-employees-harness ok");
