/** Picker availability and runtime validation share this policy; it is not a capability certification. */
export type RuntimeAccessIssue = "gateway-managed" | "auto-review-unavailable";
export function defaultRuntimeAccessMode(kernel: string | undefined): "default" | "auto-review" {
  return kernel && !runtimeAccessIssue(kernel, "auto-review") ? "auto-review" : "default";
}

/** Normalize saved selections at creation/import/kernel-switch boundaries, never during execution. */
export function resolveRuntimeAccessModeSelection(
  kernel: string | undefined,
  requested: unknown,
): "default" | "auto-review" | "full-access" {
  const mode =
    requested === "default" || requested === "auto-review" || requested === "full-access"
      ? requested
      : defaultRuntimeAccessMode(kernel);
  if (kernel === "openclaw") return "default";
  if (kernel && runtimeAccessIssue(kernel, mode) === "auto-review-unavailable") return "default";
  return mode;
}

export function runtimeAccessIssue(
  kernel: string | undefined,
  mode: "default" | "auto-review" | "full-access",
): RuntimeAccessIssue | undefined {
  if (kernel === "openclaw") return "gateway-managed";
  if (mode !== "auto-review") return undefined;
  // Supported Claude models are verified before release, not by the user's model cache.
  if (kernel === "codex" || kernel === "hermes" || kernel === "claude-code") return undefined;
  return "auto-review-unavailable";
}

export function assertRuntimeAccessMode(
  kernel: string,
  mode: "default" | "auto-review" | "full-access" | undefined,
): void {
  // OpenClaw's default means retaining Gateway policy. No per-employee override is sent.
  if (!mode || (kernel === "openclaw" && mode === "default")) return;
  const issue = runtimeAccessIssue(kernel, mode);
  if (issue) throw new Error(`runtime_access_mode_unavailable: ${kernel}/${mode} (${issue})`);
}

/** Recognize the native acknowledgement that Auto was replaced by Ask. */
export function autoReviewFallbackReason(event: {
  type?: unknown;
  name?: unknown;
  data?: unknown;
}): string | undefined {
  if (event.type !== "runtime.diagnostic" || event.name !== "claude.auto_review.fallback") return undefined;
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return undefined;
  const data = event.data as Record<string, unknown>;
  return data.kernel === "claude-code" &&
    data.from === "auto-review" &&
    data.to === "default" &&
    typeof data.reason === "string"
    ? data.reason
    : undefined;
}
