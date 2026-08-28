import {
  OPEN_GROVE_STORAGE_CATEGORY_IDS,
  parseOpenGroveStorageOverview,
  type OpenGroveStorageCategoryId,
  type OpenGroveStorageOverview,
} from "../../../../src/storage/storage-overview-contract";

export type SettingsStorageStats = {
  kind: "sqlite" | "json" | "memory";
  databaseBytes: number;
  blobBytes: number;
  orphanBlobBytes: number;
  migrationBackupBytes: number;
  categories: Array<{
    collection: string;
    records: number;
    payloadBytes: number;
    referencedBlobBytes: number;
  }>;
};

export type SettingsStorageCategoryId = OpenGroveStorageCategoryId;
export type SettingsStorageOverview = OpenGroveStorageOverview;
export const settingsStorageCategoryIds = OPEN_GROVE_STORAGE_CATEGORY_IDS;

export type SettingsStorageCleanupEstimates = {
  unreferencedFilesBytes: number;
  rebuildableBytes: number;
  migrationBackupBytes: number;
};

export function parseSettingsStorageResponse(value: unknown): {
  stats: SettingsStorageStats;
  overview: SettingsStorageOverview;
  cleanupEstimates: SettingsStorageCleanupEstimates;
} {
  const response = record(value, "settings_storage_response_invalid");
  if (response.ok !== true) throw new Error("settings_storage_response_not_ok");
  return {
    stats: parseStorageStats(response.stats),
    overview: parseOpenGroveStorageOverview(response.overview),
    cleanupEstimates: parseCleanupEstimates(response.cleanupEstimates),
  };
}

function parseCleanupEstimates(value: unknown): SettingsStorageCleanupEstimates {
  const estimates = record(value, "settings_storage_cleanup_estimates_invalid");
  return {
    unreferencedFilesBytes: nonNegativeNumber(
      estimates.unreferencedFilesBytes,
      "settings_storage_unreferenced_estimate_invalid",
    ),
    rebuildableBytes: nonNegativeNumber(estimates.rebuildableBytes, "settings_storage_rebuildable_estimate_invalid"),
    migrationBackupBytes: nonNegativeNumber(estimates.migrationBackupBytes, "settings_storage_backup_estimate_invalid"),
  };
}

export function settingsStorageTotalBytes(overview?: SettingsStorageOverview): number {
  return overview?.totalBytes ?? 0;
}

export function settingsStorageCategoryBytes(
  overview: SettingsStorageOverview | undefined,
  id: SettingsStorageCategoryId,
): number {
  return overview?.categories.find((category) => category.id === id)?.bytes ?? 0;
}

function parseStorageStats(value: unknown): SettingsStorageStats {
  const stats = record(value, "settings_storage_stats_invalid");
  if (stats.kind !== "sqlite" && stats.kind !== "json" && stats.kind !== "memory") {
    throw new Error("settings_storage_kind_invalid");
  }
  return {
    kind: stats.kind,
    databaseBytes: nonNegativeNumber(stats.databaseBytes, "settings_storage_database_bytes_invalid"),
    blobBytes: nonNegativeNumber(stats.blobBytes, "settings_storage_blob_bytes_invalid"),
    orphanBlobBytes: nonNegativeNumber(stats.orphanBlobBytes, "settings_storage_orphan_bytes_invalid"),
    migrationBackupBytes: nonNegativeNumber(stats.migrationBackupBytes, "settings_storage_backup_bytes_invalid"),
    categories: array(stats.categories, "settings_storage_categories_invalid").map((value) => {
      const category = record(value, "settings_storage_category_invalid");
      if (typeof category.collection !== "string") throw new Error("settings_storage_collection_invalid");
      return {
        collection: category.collection,
        records: nonNegativeNumber(category.records, "settings_storage_records_invalid"),
        payloadBytes: nonNegativeNumber(category.payloadBytes, "settings_storage_payload_bytes_invalid"),
        referencedBlobBytes: nonNegativeNumber(
          category.referencedBlobBytes,
          "settings_storage_referenced_blob_bytes_invalid",
        ),
      };
    }),
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
