import type { StoredFileDraft } from "../file-draft-store";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/66
 * Supports: OpenGrove 0.6.6 development builds of PR #67 (b03b4af), using localStorage draft format v1.
 * Remove when: OpenGrove 0.7.0 retires upgrades from these preview builds and their drafts have been migrated or exported.
 */
export function readLegacyFileDraft(key: string): StoredFileDraft | undefined {
  const raw = localStorage.getItem(`opengrove:file-draft:v1:${key}`);
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("base" in value) ||
    !("draft" in value) ||
    typeof value.draft !== "string" ||
    !value.base ||
    typeof value.base !== "object" ||
    !("revision" in value.base) ||
    typeof value.base.revision !== "string"
  )
    throw new Error("invalid_legacy_file_draft");
  return { baseRevision: value.base.revision, draft: value.draft };
}

export function removeLegacyFileDraft(key: string): void {
  // Fail recovery until this succeeds: leaving a legacy copy behind could
  // resurrect a discarded draft after its IndexedDB record is removed.
  localStorage.removeItem(`opengrove:file-draft:v1:${key}`);
}
