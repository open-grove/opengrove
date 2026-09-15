import type { AppReleaseJournalRelease } from "./app-release-journal.js";

/**
 * PR #9 added requiredKernelCapabilities to release employees without changing
 * schema v1. Older journals authenticate the original shape, including absence.
 * Project only the canonical comparison back to that shape; never rewrite the
 * stored release or its digest. Explicit requirements retain strict validation.
 * Supports: OpenGrove 0.6.6 and earlier schema-v1 journals written before PR #9.
 * Remove when: OpenGrove 0.7.0 no longer accepts pre-PR-9 release journals.
 */
export function releaseForLegacyJournalComparison(
  canonical: AppReleaseJournalRelease,
  stored: AppReleaseJournalRelease,
): AppReleaseJournalRelease {
  return {
    ...canonical,
    employees: canonical.employees.map((employee, index) => {
      if (
        stored.employees[index] &&
        !Object.hasOwn(stored.employees[index], "requiredKernelCapabilities") &&
        employee.requiredKernelCapabilities?.length === 0
      ) {
        const legacyEmployee = { ...employee };
        delete legacyEmployee.requiredKernelCapabilities;
        return legacyEmployee;
      }
      return employee;
    }),
  };
}

/**
 * OpenGrove 0.6.2 Dev builds wrote registry_indexed after the old Host publish.
 * Issue: https://github.com/open-grove/opengrove/issues/585
 * Supports: OpenGrove 0.6.2 Dev release journals with registry_indexed.
 * Remove when: OpenGrove 0.7.0 no longer accepts pre-Release-Control 0.6.2 Dev data directories.
 */
export function normalizeLegacyAppReleaseJournal(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const normalized = record.remoteStatus === "registry_indexed" ? { ...record, remoteStatus: "published" } : record;
  const blockedRelease = normalized.blockedRelease;
  if (
    normalized.phase === "remote_blocked" &&
    blockedRelease &&
    typeof blockedRelease === "object" &&
    !Array.isArray(blockedRelease) &&
    !("matchesCurrentRequest" in blockedRelease)
  ) {
    const legacyBlockedRelease = blockedRelease as Record<string, unknown>;
    return {
      ...normalized,
      blockedRelease: {
        ...legacyBlockedRelease,
        /**
         * OpenGrove 0.6.5 Dev builds only persisted matchesCurrentSource.
         * Supports: journals created before complete release-request matching.
         * Remove when: no supported Host can reopen an OpenGrove 0.6.5 Dev journal.
         * Retry remains disabled until a fresh RC read proves the whole request.
         */
        matchesCurrentRequest: false,
        allowedActions: Array.isArray(legacyBlockedRelease.allowedActions)
          ? legacyBlockedRelease.allowedActions.filter((action: unknown) => action === "abandon")
          : legacyBlockedRelease.allowedActions,
      },
      allowedActions: Array.isArray(normalized.allowedActions)
        ? normalized.allowedActions.filter((action) => action === "abandon")
        : normalized.allowedActions,
    };
  }
  return normalized;
}
