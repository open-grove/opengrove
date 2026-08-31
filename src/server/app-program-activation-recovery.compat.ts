/**
 * Compatibility for activation journals written by pre-merge PR #585 Dev builds.
 * Schema v1 had no committed phase, so every surviving record is an interrupted activation.
 * Issue: https://github.com/open-grove/opengrove/issues/585
 * Supports: OpenGrove 0.6.2 Dev activation journal schema version 1.
 * Remove when: OpenGrove 0.7.0 no longer accepts pre-merge 0.6.2 Dev data directories.
 */
export function normalizeLegacyAppProgramActivationRecoveryRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return value.schemaVersion === 1 ? { ...value, schemaVersion: 2, phase: "activating" } : value;
}
