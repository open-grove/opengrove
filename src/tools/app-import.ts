import type { JsonObject, JsonValue, ToolDefinition, ToolResult, ToolSpec, UserLanguagePreference } from "../core.js";
import { DEFAULT_LOCALE } from "../localization/locale-registry.js";

export interface AppImportMountedApp {
  id?: string;
  title?: string;
  path?: string;
  enabled?: boolean;
}

export interface AppImportInput {
  source?: string;
  title?: string;
  description?: string;
  force?: boolean;
}

export type AppImportResult = JsonObject;

export interface AppImportContext {
  profile?: string;
  workspaceRoot?: string;
  cwd?: string;
  mountedApps?: AppImportMountedApp[];
  importApp?(input: AppImportInput): Promise<AppImportResult>;
  language?(): UserLanguagePreference | undefined;
}

export function createAppImportTool(spec: ToolSpec, context: AppImportContext): ToolDefinition<JsonObject, JsonValue> {
  return {
    spec,
    async execute(input): Promise<ToolResult<JsonValue>> {
      if (typeof context.importApp !== "function") {
        return {
          ok: true,
          value: compactJsonObject({
            status: "unavailable",
            message: APP_IMPORT_UNAVAILABLE_COPY[context.language?.() ?? DEFAULT_LOCALE],
            profile: context.profile ?? "local",
            workspaceRoot: context.workspaceRoot ?? "",
            mountedApps: context.mountedApps ?? [],
          }) as unknown as JsonValue,
        };
      }
      try {
        const result = await context.importApp({
          source: readString(input.source),
          title: readString(input.title),
          description: readString(input.description),
          force: input.force === true,
        });
        return {
          ok: true,
          value: result as unknown as JsonValue,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

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

const APP_IMPORT_UNAVAILABLE_COPY = {
  "zh-CN": "当前 OpenGrove 实例未提供 App 导入能力。请确认这是要安装和运行 App 的电脑。",
  en: "This OpenGrove instance does not provide App import. Confirm this is the machine that should install and run the App.",
} satisfies Record<UserLanguagePreference, string>;
