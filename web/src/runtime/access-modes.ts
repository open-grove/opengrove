import { runtimeAccessIssue } from "../../../src/runtime-access";
import type { RuntimeAccessMode } from "../bridge-models";
import type { TranslationKey } from "../i18n";

export { resolveRuntimeAccessModeSelection as resolveAccessModeSelection } from "../../../src/runtime-access";

export function accessModeUnavailableKey(
  kernel: string | undefined,
  mode: RuntimeAccessMode,
): TranslationKey | undefined {
  const issue = runtimeAccessIssue(kernel, mode);
  if (issue === "gateway-managed") return "composer.accessGatewayManaged";
  if (issue === "auto-review-unavailable") return "composer.autoReviewUnavailable";
  return undefined;
}
