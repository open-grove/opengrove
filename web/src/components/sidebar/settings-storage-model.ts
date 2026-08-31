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

export function settingsStorageTotalBytes(stats: SettingsStorageStats | undefined): number {
  if (!stats) return 0;
  return stats.databaseBytes + stats.blobBytes + stats.migrationBackupBytes;
}
