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

export type SettingsStorageCategoryId =
  | "apps-and-workspaces"
  | "conversations-and-system"
  | "rebuildable"
  | "backups"
  | "other";

export type SettingsStorageOverview = {
  totalBytes: number;
  scannedAt: string;
  categories: Array<{ id: SettingsStorageCategoryId; bytes: number }>;
  locations: Array<{
    id: "system" | "apps" | "updater";
    path: string;
    bytes: number;
    movable: boolean;
  }>;
};

export function settingsStorageTotalBytes(
  stats: SettingsStorageStats | undefined,
  overview?: SettingsStorageOverview,
): number {
  if (overview) return overview.totalBytes;
  if (!stats) return 0;
  return stats.databaseBytes + stats.blobBytes + stats.migrationBackupBytes;
}

export function settingsStorageCategoryBytes(
  overview: SettingsStorageOverview | undefined,
  id: SettingsStorageCategoryId,
  stats?: SettingsStorageStats,
): number {
  const scanned = overview?.categories.find((category) => category.id === id)?.bytes;
  if (scanned !== undefined) return scanned;
  if (!stats) return 0;
  if (id === "conversations-and-system") {
    return Math.max(0, stats.databaseBytes + stats.blobBytes - stats.orphanBlobBytes);
  }
  if (id === "rebuildable") return stats.orphanBlobBytes;
  if (id === "backups") return stats.migrationBackupBytes;
  return 0;
}
