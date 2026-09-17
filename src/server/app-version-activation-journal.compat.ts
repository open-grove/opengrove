import {
  CURRENT_PERSISTED_AGENT_STATE_VERSION,
  normalizePersistedAgentState,
  type PersistedAgentState,
} from "../storage/json-state-store.js";

/**
 * PR #585 Dev builds captured the then-current persisted Agent state inside activation journals.
 * Issue: https://github.com/open-grove/opengrove/issues/585
 * Supports: OpenGrove 0.6.2 Dev persisted Agent state versions 1 through 9.
 * Remove when: OpenGrove 0.7.0 no longer accepts pre-merge 0.6.2 Dev activation journals.
 */
export function normalizeActivationJournalAgentState(value: unknown): PersistedAgentState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("app_version_activation_journal_corrupted");
  }
  const record = value as Record<string, unknown>;
  const version = record.version;
  if (!Number.isInteger(version) || Number(version) < 1 || Number(version) > CURRENT_PERSISTED_AGENT_STATE_VERSION) {
    throw new Error("app_version_activation_journal_corrupted");
  }
  return normalizePersistedAgentState(record);
}

/**
 * OpenGrove 0.6.6 Dev initially wrote schema v1 activation journals before
 * source-revision recovery became part of the transaction contract.
 * Supports: schema v1 journals with no trustworthy source checkpoint.
 * Remove when: OpenGrove 0.7.0 no longer accepts 0.6.6 Dev activation journals.
 */
export function normalizeLegacyAppVersionActivationJournal(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (value.schemaVersion !== 1) return undefined;
  const candidate: Record<string, unknown> = {
    ...value,
    schemaVersion: 2,
    ...(value.kind === "formal"
      ? {
          previousSourceRevisionState: "repository-unavailable",
          legacySourceRevisionUnavailable: true,
        }
      : {}),
  };
  delete candidate.previousSourceRevision;
  return candidate;
}
