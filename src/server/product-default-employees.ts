import {
  GROVE_GUIDE_MEMBER_ID,
  GROVE_GUIDE_SKILL_NAME,
  type RoomChannelMember,
  type RoomChannelStore,
} from "../rooms/channel-store.js";
import { OPENGROVE_PM_MEMBER_ID, PM_AGENT_SKILL_NAME } from "../rooms/room-pm.js";
import { OPENGROVE_APP_BUILDER_MEMBER_ID, OPENGROVE_APP_BUILDER_SKILL_NAME } from "./bridge-mounted-app-employees.js";
import { DEFAULT_LOCALE, localizedValue, type SupportedLocale } from "../localization/locale-registry.js";
import {
  APP_BUILDER_BUSINESS_ROLE_LINES,
  appBuilderEnglishPresentation,
  appBuilderPublicProfile,
} from "./app-builder-employee-contract.js";
import { PRODUCT_EMPLOYEE_RUNTIME_DEFAULTS } from "./product-employee-defaults.js";

export { GROVE_GUIDE_MEMBER_ID, GROVE_GUIDE_SKILL_NAME };

const GROVE_GUIDE_WELCOME_MESSAGE_ID = "opengrove-newcomer-guide-welcome-v1";

export function productDefaultEmployees(language: SupportedLocale = DEFAULT_LOCALE): RoomChannelMember[] {
  const employees = [groveGuideEmployee(), appBuilderEmployee(), pmEmployee()];
  return localizedValue(PRODUCT_EMPLOYEE_PRESENTERS, language)(employees);
}

export function isProductDefaultEmployeeId(memberId: string): boolean {
  return (
    memberId === GROVE_GUIDE_MEMBER_ID ||
    memberId === OPENGROVE_APP_BUILDER_MEMBER_ID ||
    memberId === OPENGROVE_PM_MEMBER_ID
  );
}

export function syncGroveGuideWelcome(
  rooms: RoomChannelStore,
  roomId = `direct-${GROVE_GUIDE_MEMBER_ID}`,
  language: SupportedLocale = DEFAULT_LOCALE,
): boolean {
  const guide = rooms.listMembers().find((member) => member.id === GROVE_GUIDE_MEMBER_ID && !member.disabled);
  if (!guide) return false;
  const room = rooms.openDirect({
    id: roomId,
    memberId: GROVE_GUIDE_MEMBER_ID,
    title: guide.name,
  });
  const text = localizedValue(GROVE_GUIDE_WELCOME_MESSAGES, language);
  const existing = rooms.getMessage(room.id, GROVE_GUIDE_WELCOME_MESSAGE_ID);
  if (existing) {
    const senderName = guide.displayName || guide.name;
    if (existing.text === text && existing.senderName === senderName) return false;
    rooms.updateMessage(room.id, existing.id, { text, senderName });
    return true;
  }
  rooms.postAgentMessage({
    id: GROVE_GUIDE_WELCOME_MESSAGE_ID,
    roomId: room.id,
    senderId: guide.id,
    senderName: guide.displayName || guide.name,
    text,
  });
  return true;
}

const GROVE_GUIDE_WELCOME_MESSAGES = {
  "zh-CN":
    "你好，我是 OpenGrove 的新手引导员。你可以直接告诉我想完成什么，也可以创建一个 App，或者先让我带你看看员工、房间和本机 Kernel 怎么协作。",
  en: "Hi, I’m the OpenGrove getting-started guide. Tell me what you want to accomplish, create an App, or ask me to show you how employees, rooms, and local kernels work together.",
} satisfies Record<SupportedLocale, string>;

const PRODUCT_EMPLOYEE_PRESENTERS = {
  "zh-CN": (employees: RoomChannelMember[]) => employees,
  en: (employees: RoomChannelMember[]) => employees.map(withEnglishProductPresentation),
} satisfies Record<SupportedLocale, (employees: RoomChannelMember[]) => RoomChannelMember[]>;

function withEnglishProductPresentation(member: RoomChannelMember): RoomChannelMember {
  if (member.id === GROVE_GUIDE_MEMBER_ID) {
    return {
      ...member,
      displayName: "Getting Started Guide",
      displayRole: "Help new OpenGrove users understand the product and choose one small, actionable next step.",
      displayPublicDescription: "Helps first-time OpenGrove users find the shortest useful next step.",
      displayPublicSkills: ["Getting started", "Apps and employees", "Local kernel troubleshooting"],
      displayInputSpec: "What the user wants to accomplish or a question about using OpenGrove.",
      displayOutputSpec: "A concise explanation and one immediately actionable next step.",
    };
  }
  if (member.id === OPENGROVE_APP_BUILDER_MEMBER_ID) {
    return {
      ...member,
      ...appBuilderEnglishPresentation(
        "Helps business users change App pages and workflows, verifies what the current App can support, continues deliverable work when backend data is missing, and prepares a backend handoff.",
      ),
    };
  }
  if (member.id === OPENGROVE_PM_MEMBER_ID) {
    return {
      ...member,
      displayName: "OpenGrove PM",
      displayRole: "Understands goals, coordinates App employees, and creates workflows when needed.",
      displayPublicDescription: "Understands goals, coordinates App employees, and creates workflows when needed.",
      displayPublicSkills: ["Task planning", "Employee coordination", "Workflow orchestration"],
      displayInputSpec: "A goal or coordination request within a specific App.",
      displayOutputSpec: "A clear execution plan, employee assignments, or a runnable workflow.",
    };
  }
  return member;
}

function groveGuideEmployee(): RoomChannelMember {
  const runtime = PRODUCT_EMPLOYEE_RUNTIME_DEFAULTS[GROVE_GUIDE_MEMBER_ID];
  return {
    id: GROVE_GUIDE_MEMBER_ID,
    name: "新手引导员",
    kernel: runtime.kernel,
    model: runtime.model,
    role: "你是 OpenGrove 的新手引导员。简短介绍产品，先理解用户想完成什么，再给出一个最小、可执行的下一步。",
    status: "idle",
    color: "#168a53",
    lastActive: "已配置",
    availableSkillIds: [GROVE_GUIDE_SKILL_NAME],
    defaultSkillIds: [GROVE_GUIDE_SKILL_NAME],
    accessMode: "default",
    reasoningEffort: "medium",
    source: "local",
    sourceLabel: "OpenGrove",
    visibility: "private",
    publicDescription: "帮助第一次使用 OpenGrove 的用户找到最短下一步。",
    publicSkills: ["新手引导", "App 与员工介绍", "本机 Kernel 排障"],
    inputSpec: "用户当前想完成的事情，或对 OpenGrove 使用方式的疑问。",
    outputSpec: "简短说明和一个可立即执行的下一步。",
  };
}

function appBuilderEmployee(): RoomChannelMember {
  const runtime = PRODUCT_EMPLOYEE_RUNTIME_DEFAULTS[OPENGROVE_APP_BUILDER_MEMBER_ID];
  return {
    id: OPENGROVE_APP_BUILDER_MEMBER_ID,
    employeeDefinitionId: OPENGROVE_APP_BUILDER_MEMBER_ID,
    name: "App 构建师",
    kernel: runtime.kernel,
    model: runtime.model,
    role: [
      "你是 OpenGrove 唯一的 App 构建师员工。",
      "从某个 App 工作台调用时，Host 会把该 App 的 id、根目录和 workspace 绑定到本次运行，只在该范围内工作。",
      ...APP_BUILDER_BUSINESS_ROLE_LINES,
      "业务专属 UI 应留在 App 包内；需要保留文件工作台时，使用 file-workbench 的 App-owned MCP View Tab，不要为业务文案、布局或交互修改 OpenGrove Host。",
      "在通讯录直接对话且用户没有指定 App 时，先请用户选择或新建 App；不要猜测目标，不要修改 OpenGrove Host。",
    ].join("\n"),
    status: "idle",
    color: "#7c3aed",
    lastActive: "已配置",
    availableSkillIds: [OPENGROVE_APP_BUILDER_SKILL_NAME],
    defaultSkillIds: [OPENGROVE_APP_BUILDER_SKILL_NAME],
    toolIds: ["opengrove.app.import"],
    accessMode: "default",
    reasoningEffort: "medium",
    source: "local",
    sourceLabel: "OpenGrove",
    visibility: "private",
    ...appBuilderPublicProfile(),
  };
}

function pmEmployee(): RoomChannelMember {
  const runtime = PRODUCT_EMPLOYEE_RUNTIME_DEFAULTS[OPENGROVE_PM_MEMBER_ID];
  return {
    id: OPENGROVE_PM_MEMBER_ID,
    employeeDefinitionId: OPENGROVE_PM_MEMBER_ID,
    name: "PM",
    kernel: runtime.kernel,
    model: runtime.model,
    role: [
      "你是 OpenGrove 唯一的 PM 员工。",
      "从某个 App 群聊或工作台调用时，Host 会把该 App 的员工、房间、根目录和 workspace 绑定到本次运行，只在该范围内规划与协调。",
      "在通讯录直接对话且用户没有指定 App 时，先请用户选择或新建 App；不要猜测目标 App，也不要跨 App 委派员工。",
    ].join("\n"),
    status: "idle",
    color: "#1d4ed8",
    lastActive: "已配置",
    availableSkillIds: [PM_AGENT_SKILL_NAME],
    defaultSkillIds: [PM_AGENT_SKILL_NAME],
    accessMode: "default",
    reasoningEffort: "medium",
    source: "local",
    sourceLabel: "OpenGrove",
    visibility: "private",
    publicDescription: "理解目标、协调 App 员工，并在需要时创建工作流。",
    publicSkills: ["任务规划", "员工协调", "工作流编排"],
    inputSpec: "需要在某个 App 中完成的目标或待协调的工作。",
    outputSpec: "清晰的执行计划、员工分工，或可运行的工作流。",
  };
}
