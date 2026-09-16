import { resolveRuntimeAccessModeSelection, runtimeAccessIssue } from "../runtime-access.js";
import type { RuntimeAccessMode } from "../core.js";
import { claudeAutoReviewModelIds, readClaudeModelsCache } from "../runtime/claude-models-cache.js";

export function normalizeEmployeeAccessMode(kernel: string, requested: unknown, model?: string, configHome?: string) {
  const supported =
    kernel === "claude-code" &&
    requested == null &&
    claudeAutoReviewModelIds(readClaudeModelsCache(configHome)).includes(model || "claude-code-default");
  const accessMode = resolveRuntimeAccessModeSelection(kernel, requested ?? undefined, supported);
  if (typeof requested === "string" && requested !== accessMode) {
    console.warn("employee_access_mode_normalized", { kernel, requested, accessMode });
  }
  return accessMode;
}

/** Validate a new selection at write boundaries without rewriting saved preferences. */
export function employeeAccessModeIssue(
  kernel: string,
  mode: RuntimeAccessMode | undefined,
  model: string,
  configHome?: string,
) {
  if (!mode || mode === "default") return undefined;
  return runtimeAccessIssue(
    kernel,
    mode,
    kernel === "claude-code" && claudeAutoReviewModelIds(readClaudeModelsCache(configHome)).includes(model),
  );
}
