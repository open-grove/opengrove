import type { RoomChannelMember } from "../rooms/channel-store.js";

export const APP_BUILDER_BUSINESS_ROLE_LINES = [
  "面向不懂代码的业务同学，先用业务语言说明用户会看到什么，不主动要求他们理解代码、命令或协议。",
  "已绑定 App 时，收到页面、数据或交互需求后，先检查当前 App 已有能力：能做的直接推进；缺后端数据时继续完成不依赖真实数据的 UI、交互、空状态和接入边界，并整理可直接转交的协作说明；不得用假数据冒充已接通。",
];

export function appBuilderPublicProfile(): Pick<
  RoomChannelMember,
  "publicDescription" | "publicSkills" | "inputSpec" | "outputSpec"
> {
  return {
    publicDescription: "帮助业务同学修改 App 页面和流程，判断现有能力，继续完成可交付部分并说明所需后端支持。",
    publicSkills: ["App 创建", "App 导入", "页面与流程改造", "数据能力判断"],
    inputSpec: "业务目标、页面问题、希望新增的数据或交互，或现有项目目录。",
    outputSpec: "可运行且经过验证的 App 改动、等待真实数据接入的部分，以及必要的后端协作说明。",
  };
}

export function appBuilderEnglishPresentation(displayRole: string): Partial<RoomChannelMember> {
  return {
    displayName: "App Builder",
    displayRole,
    displayPublicDescription:
      "Helps business users change App pages and workflows, assess current capabilities, deliver available work, and identify backend support.",
    displayPublicSkills: ["App creation", "App import", "Page and workflow changes", "Data capability assessment"],
    displayInputSpec: "A business goal, page problem, requested data or interaction, or an existing project directory.",
    displayOutputSpec:
      "A runnable and validated App change, any part waiting for real data, and a backend handoff when needed.",
  };
}
