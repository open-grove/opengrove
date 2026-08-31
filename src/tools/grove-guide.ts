import type { JsonObject, JsonValue, ToolDefinition, ToolResult, ToolSpec, UserLanguagePreference } from "../core.js";
import { DEFAULT_LOCALE } from "../localization/locale-registry.js";

export interface GroveGuideMountedApp {
  id?: string;
  title?: string;
  path?: string;
  enabled?: boolean;
}

export interface GroveGuideStatusContext {
  profile?: string;
  workspaceRoot?: string;
  cwd?: string;
  mountedApps?: GroveGuideMountedApp[];
  language?(): UserLanguagePreference | undefined;
}

export function createGroveGuideStatusTool(
  spec: ToolSpec,
  context: GroveGuideStatusContext,
): ToolDefinition<JsonObject, JsonValue> {
  return {
    spec,
    async execute(): Promise<ToolResult<JsonValue>> {
      return {
        ok: true,
        value: buildGroveGuideStatus(context) as unknown as JsonValue,
      };
    },
  };
}

export function buildGroveGuideStatus(context: GroveGuideStatusContext): JsonObject {
  const copy = GROVE_GUIDE_COPY[context.language?.() ?? DEFAULT_LOCALE];
  const mountedApps = (context.mountedApps ?? [])
    .filter((app) => app.enabled !== false)
    .map((app) => ({
      id: app.id ?? "",
      title: app.title ?? app.id ?? "",
      path: app.path ?? "",
    }));
  return compactJsonObject({
    product: "OpenGrove",
    mode: "local-runtime",
    profile: context.profile || "local",
    architecture: {
      local: copy.architectureLocal,
      rule: copy.architectureRule,
    },
    current: {
      workspaceRoot: context.workspaceRoot ?? "",
      cwd: context.cwd ?? "",
      mountedAppCount: mountedApps.length,
      mountedApps,
    },
    links: copy.links,
    requirements: copy.requirements,
    nextSteps: mountedApps.length ? copy.nextStepsWithApps : copy.nextStepsWithoutApps,
  });
}

const GROVE_GUIDE_COPY = {
  "zh-CN": {
    architectureLocal: [
      "本机 bridge 承载 UI、房间、员工和 App",
      "workspace、App 目录和产物都在这台电脑上",
      "kernel（Claude Agent / Codex 等）在本机运行",
      "App 商店通过 OpenGrove Release Control 下载包到本机安装",
    ],
    architectureRule:
      "员工执行和工作区文件读写发生在本机；账号与托管 Provider 由 OpenGrove Cloud API 提供，App Store 与正式版本由 OpenGrove Release Control 提供。",
    links: {
      appStore: "左侧栏 -> 资源 -> App 商店",
      createApp: "左侧栏 -> 我的App -> 新建应用",
      settings: "左侧栏 -> 设置 -> Apps 管理已挂载目录",
    },
    requirements: [
      "至少一个可用 kernel（如 Claude Agent 或 Codex CLI）。",
      "App 产物写入各 App 自己的 workspace 目录。",
    ],
    nextStepsWithApps: ["打开左侧栏「我的App」里的工作台，或在 App 群聊里直接派活。"],
    nextStepsWithoutApps: ["用左侧栏 -> 我的App -> 新建应用 创建或导入第一个工作台。"],
  },
  en: {
    architectureLocal: [
      "The local bridge hosts the UI, Rooms, Employees, and Apps",
      "Workspaces, App directories, and artifacts live on this machine",
      "Kernels (Claude Agent, Codex, and others) run on this machine",
      "The App Store downloads packages from OpenGrove Release Control and installs them locally",
    ],
    architectureRule:
      "Employee execution and workspace file access happen on this machine; accounts and hosted Providers come from the OpenGrove Cloud API, and the App Store and formal versions come from OpenGrove Release Control.",
    links: {
      appStore: "Sidebar -> Resources -> App Store",
      createApp: "Sidebar -> My Apps -> New App",
      settings: "Sidebar -> Settings -> Apps to manage mounted directories",
    },
    requirements: [
      "At least one available Kernel (such as Claude Agent or Codex CLI).",
      "App artifacts are written into each App's own workspace directory.",
    ],
    nextStepsWithApps: ["Open a workbench under My Apps in the sidebar, or assign work directly in an App group chat."],
    nextStepsWithoutApps: ["Use Sidebar -> My Apps -> New App to create or import your first workbench."],
  },
} satisfies Record<
  UserLanguagePreference,
  {
    architectureLocal: string[];
    architectureRule: string;
    links: { appStore: string; createApp: string; settings: string };
    requirements: string[];
    nextStepsWithApps: string[];
    nextStepsWithoutApps: string[];
  }
>;

function compactJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (Array.isArray(item)) {
      output[key] = item.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry) ? compactJsonObject(entry) : entry,
      ) as JsonValue;
    } else if (item && typeof item === "object") {
      output[key] = compactJsonObject(item);
    } else {
      output[key] = item as JsonValue;
    }
  }
  return output;
}
