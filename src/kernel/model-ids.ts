export const BRIDGE_MODEL_IDS = [
  "native",
  "MiMo-V2-Pro",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "claude-opus-4-8",
  "claude-opus-4-6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
] as const;

export type BridgeKnownModelId = (typeof BRIDGE_MODEL_IDS)[number];
export type BridgeModelId = string;

// Compatibility input emitted by older Employee/bootstrap state. New state
// uses the concrete product default below and only reads this value in migration.
export const LEGACY_NATIVE_MODEL_ID: BridgeKnownModelId = "native";
export const DEFAULT_BRIDGE_MODEL_ID: BridgeKnownModelId = "deepseek-v4-flash";
