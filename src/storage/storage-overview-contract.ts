export const OPEN_GROVE_STORAGE_CATEGORY_IDS = [
  "works-and-files",
  "apps-and-runtime",
  "rebuildable",
  "backups",
  "conversations-and-system",
] as const;

export type OpenGroveStorageCategoryId = (typeof OPEN_GROVE_STORAGE_CATEGORY_IDS)[number];
export type OpenGroveStorageBackupKind = "migration";

export interface OpenGroveStorageOverview {
  totalBytes: number;
  scannedAt: string;
  categories: Array<{ id: OpenGroveStorageCategoryId; bytes: number }>;
  cleanupCandidates: { rebuildableBytes: number };
  backups: Array<{
    kind: OpenGroveStorageBackupKind;
    bytes: number;
    createdAt: string;
  }>;
}

export function parseOpenGroveStorageOverview(value: unknown): OpenGroveStorageOverview {
  const input = record(value, "storage_overview_invalid");
  const categories = array(input.categories, "storage_overview_categories_invalid").map((value) => {
    const category = record(value, "storage_overview_category_invalid");
    if (!OPEN_GROVE_STORAGE_CATEGORY_IDS.includes(category.id as OpenGroveStorageCategoryId)) {
      throw new Error("storage_overview_category_id_invalid");
    }
    return {
      id: category.id as OpenGroveStorageCategoryId,
      bytes: nonNegativeNumber(category.bytes, "storage_overview_category_bytes_invalid"),
    };
  });
  if (
    categories.length !== OPEN_GROVE_STORAGE_CATEGORY_IDS.length ||
    new Set(categories.map((category) => category.id)).size !== OPEN_GROVE_STORAGE_CATEGORY_IDS.length
  ) {
    throw new Error("storage_overview_categories_incomplete");
  }
  const backups = array(input.backups, "storage_overview_backups_invalid").map((value) => {
    const backup = record(value, "storage_overview_backup_invalid");
    if (backup.kind !== "migration") throw new Error("storage_overview_backup_kind_invalid");
    if (typeof backup.createdAt !== "string" || Number.isNaN(Date.parse(backup.createdAt))) {
      throw new Error("storage_overview_backup_created_at_invalid");
    }
    return {
      kind: backup.kind as OpenGroveStorageBackupKind,
      bytes: nonNegativeNumber(backup.bytes, "storage_overview_backup_bytes_invalid"),
      createdAt: backup.createdAt,
    };
  });
  if (typeof input.scannedAt !== "string" || Number.isNaN(Date.parse(input.scannedAt))) {
    throw new Error("storage_overview_scanned_at_invalid");
  }
  return {
    totalBytes: nonNegativeNumber(input.totalBytes, "storage_overview_total_invalid"),
    scannedAt: input.scannedAt,
    categories,
    cleanupCandidates: {
      rebuildableBytes: nonNegativeNumber(
        record(input.cleanupCandidates, "storage_overview_cleanup_candidates_invalid").rebuildableBytes,
        "storage_overview_rebuildable_cleanup_bytes_invalid",
      ),
    },
    backups,
  };
}

function record(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function array(value: unknown, errorCode: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(errorCode);
  return value;
}

function nonNegativeNumber(value: unknown, errorCode: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(errorCode);
  return value;
}
