// Supports legacy Bridge errors and shared Client errors during the migration in
// https://github.com/open-grove/opengrove/issues/107. Keep status and code semantics
// identical; remove the legacy error adapter when all Web requests use Client.
export function sessionRequiredCode(error: unknown): "authentication_required" | "session_required" | undefined {
  if (!(error instanceof Error) || !("status" in error) || error.status !== 401) return undefined;
  for (const value of ["code" in error ? error.code : undefined, error.message]) {
    if (value === "authentication_required" || value === "session_required") return value;
  }
  return undefined;
}
