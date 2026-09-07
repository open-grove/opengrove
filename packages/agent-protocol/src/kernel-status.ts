/** Stable Host-owned status codes rendered by the Kernel settings surface. */
export type KernelOptionUnavailableCode =
  | "ww_provider_key_missing"
  | "provider_verification_required"
  | "provider_key_missing"
  | "provider_disabled"
  | "provider_unsupported"
  | "provider_not_found"
  | "provider_selection_required"
  | "kernel_provider_unavailable"
  | "kernel_executable_missing"
  | "kernel_runtime_unavailable";
