import { resolveRuntimeAccessModeSelection } from "../runtime-access.js";
import { claudeAutoReviewModelIds, readClaudeModelsCache } from "../runtime/claude-models-cache.js";

export function normalizeEmployeeAccessMode(kernel: string, requested: unknown, model?: string, configHome?: string) {
  const supported =
    kernel === "claude-code" &&
    requested === undefined &&
    claudeAutoReviewModelIds(readClaudeModelsCache(configHome)).includes(model || "claude-code-default");
  const accessMode = resolveRuntimeAccessModeSelection(kernel, requested, supported);
  if (typeof requested === "string" && requested !== accessMode) {
    console.warn("employee_access_mode_normalized", { kernel, requested, accessMode });
  }
  return accessMode;
}
