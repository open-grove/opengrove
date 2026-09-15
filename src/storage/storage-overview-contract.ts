export const OPEN_GROVE_STORAGE_CATEGORY_IDS = [
  "works-and-files",
  "apps-and-runtime",
  "rebuildable",
  "backups",
  "conversations-and-system",
] as const;

export type OpenGroveStorageCategoryId = (typeof OPEN_GROVE_STORAGE_CATEGORY_IDS)[number];
export type OpenGroveStorageBackupKind = "migration" | "app-layout";
export const APP_BACKUP_PROTECTION_REASONS = [
  "activation_unconfirmed",
  "workspace_unavailable",
  "active_reference",
  "unsafe_path",
  "missing_receipt",
  "reference_scan_failed",
  "app_not_mounted",
] as const;
export interface OpenGroveAppLayoutBackup {
  kind: "app-layout";
  id: string;
  appId: string;
  bytes: number;
  createdAt: string;
  state: "verified" | "unverified" | "protected";
  appStatus?: "active" | "disabled" | "uninstalled";
  reason?: (typeof APP_BACKUP_PROTECTION_REASONS)[number];
  workspacePath?: string;
}
export type OpenGroveStorageBackup = OpenGroveAppLayoutBackup | { kind: "migration"; bytes: number; createdAt: string };

export interface StorageBackupDeletionPreview {
  token: string;
  bytes: number;
  backups: OpenGroveStorageBackup[];
  protectedBackups: OpenGroveAppLayoutBackup[];
}

export interface OpenGroveStorageOverview {
  totalBytes: number;
  scannedAt: string;
  categories: Array<{ id: OpenGroveStorageCategoryId; bytes: number }>;
  cleanupCandidates: { rebuildableBytes: number };
  backups: OpenGroveStorageBackup[];
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
  const backups = array(input.backups, "storage_overview_backups_invalid").map(parseStorageBackup);
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

export function parseStorageBackup(value: unknown): OpenGroveStorageBackup {
  const backup = record(value, "storage_overview_backup_invalid");
  if (typeof backup.createdAt !== "string" || Number.isNaN(Date.parse(backup.createdAt))) {
    throw new Error("storage_overview_backup_created_at_invalid");
  }
  const bytes = nonNegativeNumber(backup.bytes, "storage_overview_backup_bytes_invalid");
  if (backup.kind === "migration") return { kind: "migration", bytes, createdAt: backup.createdAt };
  if (
    backup.kind !== "app-layout" ||
    typeof backup.id !== "string" ||
    !backup.id ||
    typeof backup.appId !== "string" ||
    !backup.appId ||
    !["verified", "unverified", "protected"].includes(String(backup.state)) ||
    (backup.reason !== undefined &&
      !APP_BACKUP_PROTECTION_REASONS.includes(backup.reason as OpenGroveAppLayoutBackup["reason"] & string)) ||
    (backup.workspacePath !== undefined && typeof backup.workspacePath !== "string") ||
    (backup.appStatus !== undefined && !["active", "disabled", "uninstalled"].includes(String(backup.appStatus))) ||
    (backup.state === "verified" &&
      (backup.appStatus === undefined ||
        backup.reason !== undefined ||
        (backup.appStatus !== "uninstalled" &&
          (typeof backup.workspacePath !== "string" || !backup.workspacePath.trim())))) ||
    (backup.state !== "verified" && backup.reason === undefined)
  )
    throw new Error("storage_overview_backup_invalid");
  return {
    kind: "app-layout",
    id: backup.id,
    appId: backup.appId,
    bytes,
    createdAt: backup.createdAt,
    state: backup.state as OpenGroveAppLayoutBackup["state"],
    ...(backup.appStatus !== undefined ? { appStatus: backup.appStatus as OpenGroveAppLayoutBackup["appStatus"] } : {}),
    ...(backup.reason !== undefined ? { reason: backup.reason as OpenGroveAppLayoutBackup["reason"] } : {}),
    ...(typeof backup.workspacePath === "string" ? { workspacePath: backup.workspacePath } : {}),
  };
}

export function parseStorageBackupDeletionPreview(value: unknown): StorageBackupDeletionPreview {
  const input = record(value, "storage_backup_preview_invalid");
  if (typeof input.token !== "string" || !input.token) throw new Error("storage_backup_preview_invalid");
  const protectedBackups = array(input.protectedBackups, "storage_backup_preview_invalid").map(parseStorageBackup);
  if (protectedBackups.some((item) => item.kind !== "app-layout" || item.state === "verified"))
    throw new Error("storage_backup_preview_invalid");
  const backups = array(input.backups, "storage_backup_preview_invalid").map(parseStorageBackup);
  if (backups.some((item) => item.kind === "app-layout" && item.state !== "verified"))
    throw new Error("storage_backup_preview_invalid");
  return {
    token: input.token,
    bytes: nonNegativeNumber(input.bytes, "storage_backup_preview_invalid"),
    backups,
    protectedBackups: protectedBackups as OpenGroveAppLayoutBackup[],
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
