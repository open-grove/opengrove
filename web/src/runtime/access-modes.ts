import { resolveRuntimeAccessModeSelection, runtimeAccessSelectionIssue } from "../../../src/runtime-access";
import type { RuntimeAccessMode, RuntimeControls } from "../bridge-models";
import type { TranslationKey } from "../i18n";

export function accessModeUnavailableKey(
  kernel: string | undefined,
  mode: RuntimeAccessMode,
  model: string,
  controls?: RuntimeControls,
  saved?: { kernel: string; accessMode?: RuntimeAccessMode },
): TranslationKey | undefined {
  const supported = controls?.kernel === kernel && controls?.autoReviewModelIds?.includes(model) === true;
  const issue = runtimeAccessSelectionIssue(kernel, mode, supported, saved);
  if (issue === "gateway-managed") return "composer.accessGatewayManaged";
  if (issue === "auto-review-unverified") return "composer.autoReviewUnverified";
  if (issue === "auto-review-unavailable") return "composer.autoReviewUnavailable";
  return undefined;
}

export function resolveAccessModeSelection(
  kernel: string | undefined,
  requested: RuntimeAccessMode | undefined,
  model: string,
  controls?: RuntimeControls,
): RuntimeAccessMode {
  const supported = controls?.kernel === kernel && controls?.autoReviewModelIds?.includes(model) === true;
  return resolveRuntimeAccessModeSelection(kernel, requested, supported);
}
