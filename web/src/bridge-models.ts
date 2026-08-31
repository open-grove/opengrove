import { translate } from "./i18n";

export const DEFAULT_MODEL_ID = "deepseek-v4-flash";
const LEGACY_NATIVE_MODEL_ID = "native";

export const MODEL_OPTIONS = [
  {
    id: DEFAULT_MODEL_ID,
    get label() {
      return translate("model.deepseekV4Flash");
    },
  },
  {
    id: "deepseek-v4-pro",
    get label() {
      return translate("model.deepseekV4Pro");
    },
  },
  {
    id: "claude-opus-4-8",
    get label() {
      return translate("model.claudeOpus48");
    },
  },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "MiMo-V2-Pro", label: "MiMo-V2-Pro" },
] as const;

export type KnownModelId = (typeof MODEL_OPTIONS)[number]["id"];
export type ModelId = string;
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type RuntimeAccessMode = "default" | "auto-review" | "full-access";
export type ResponseSpeed = "standard" | "fast";
export type KernelPreference = "codex" | "claude-code" | "hermes" | "pi" | "openclaw" | "opencode" | "kimi";
export interface RuntimeControlOption {
  id: string;
  label: string;
  description?: string;
  defaultProviderId?: string;
  apiModelId?: string;
  canonicalModelId?: string;
  family?: string;
  status?: "alpha" | "beta" | "deprecated";
}
export interface RuntimeControls {
  kernel: KernelPreference;
  source: string;
  models: RuntimeControlOption[];
  defaultModel?: string;
  reasoningEfforts: RuntimeControlOption[];
  defaultReasoningEffort?: string;
  speedTiers: RuntimeControlOption[];
  defaultSpeedTier?: string;
}
export type ViewId = "chat" | "app" | "ops" | "extensions" | "rooms" | "contacts" | "app-store" | "settings";

export function createClientId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function supportedModel(value: string): ModelId {
  const model = value?.trim();
  return !model || model === LEGACY_NATIVE_MODEL_ID ? DEFAULT_MODEL_ID : model;
}

export function modelLabel(modelId: string): string {
  return MODEL_OPTIONS.find((model) => model.id === modelId)?.label ?? modelId;
}

export function supportedView(value: string): ViewId {
  if (value === "app" || value === "apps" || value === "mounted-app" || value === "user-app") {
    return "app";
  }
  if (
    value === "ops" ||
    value === "ops-center" ||
    value === "sessions" ||
    value === "runs" ||
    value === "activity" ||
    value === "automation"
  ) {
    return "ops";
  }
  if (
    value === "extensions" ||
    value === "extension-manager" ||
    value === "skills" ||
    value === "tools" ||
    value === "mcp"
  ) {
    return "extensions";
  }
  if (value === "app-store" || value === "store" || value === "marketplace" || value === "network-store") {
    return "app-store";
  }
  if (value === "contacts" || value === "address-book" || value === "people") {
    return "contacts";
  }
  if (value === "rooms" || value === "team" || value === "team-chat" || value === "collaboration") {
    return "rooms";
  }
  if (
    value === "library" ||
    value === "object-studio" ||
    value === "objects" ||
    value === "inbox" ||
    value === "artifacts"
  ) {
    return "app-store";
  }
  if (value === "settings" || value === "capability-settings" || value === "context" || value === "memory") {
    return "settings";
  }
  return "chat";
}
