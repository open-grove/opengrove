/** Picker availability and runtime validation share this policy; it is not a capability certification. */
export type RuntimeAccessIssue = "gateway-managed" | "auto-review-unavailable" | "auto-review-unverified";

export function runtimeAccessIssue(
  kernel: string | undefined,
  mode: "default" | "auto-review" | "full-access",
  nativeAutoReviewSupported = false,
): RuntimeAccessIssue | undefined {
  if (kernel === "openclaw") return "gateway-managed";
  if (mode !== "auto-review") return undefined;
  if (kernel === "codex" || kernel === "hermes") return undefined;
  if (kernel === "claude-code") return nativeAutoReviewSupported ? undefined : "auto-review-unverified";
  return "auto-review-unavailable";
}

export function assertRuntimeAccessMode(
  kernel: string,
  mode: "default" | "auto-review" | "full-access" | undefined,
  nativeAutoReviewSupported = false,
): void {
  // OpenClaw's default means retaining Gateway policy. No per-employee override is sent.
  if (!mode || (kernel === "openclaw" && mode === "default")) return;
  const issue = runtimeAccessIssue(kernel, mode, nativeAutoReviewSupported);
  if (issue) throw new Error(`runtime_access_mode_unavailable: ${kernel}/${mode} (${issue})`);
}
