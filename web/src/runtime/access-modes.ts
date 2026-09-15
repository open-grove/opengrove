import { runtimeAccessIssue } from "../../../src/runtime-access";
import type { RuntimeAccessMode, RuntimeControls } from "../bridge-models";
import type { TranslationKey } from "../i18n";

export function accessModeUnavailableKey(
  kernel: string | undefined,
  mode: RuntimeAccessMode,
  model: string,
  controls?: RuntimeControls,
): TranslationKey | undefined {
  const supported = controls?.kernel === kernel && controls?.autoReviewModelIds?.includes(model) === true;
  const issue = runtimeAccessIssue(kernel, mode, supported);
  if (issue === "gateway-managed") return "composer.accessGatewayManaged";
  if (issue === "auto-review-unverified") return "composer.autoReviewUnverified";
  if (issue === "auto-review-unavailable") return "composer.autoReviewUnavailable";
  return undefined;
}
