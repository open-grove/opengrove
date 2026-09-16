// Supports: OpenGrove 0.7.0 legacy Bridge errors and shared Client errors.
// https://github.com/open-grove/opengrove/issues/107
// Remove when: all Web requests have migrated from the OpenGrove 0.7.0 Bridge API
// to Client; until then keep the same status and code semantics for both errors.
export function sessionRequiredCode(error: unknown): "authentication_required" | "session_required" | undefined {
  if (!(error instanceof Error) || !("status" in error) || error.status !== 401) return undefined;
  for (const value of ["code" in error ? error.code : undefined, error.message]) {
    if (value === "authentication_required" || value === "session_required") return value;
  }
  return undefined;
}
