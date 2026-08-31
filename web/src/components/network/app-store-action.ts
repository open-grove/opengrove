import type { AppStorePackageRecord } from "../../bridge";
import { rawDiagnosticText, translate, type TranslationFn } from "../../i18n";

export type AppStorePackageActionKind =
  | "install"
  | "update"
  | "host-update"
  | "reinstall"
  | "relink"
  | "conflict"
  | "open"
  | "repair"
  | "inspect"
  | "installed";

export interface AppStorePackageAction {
  kind: AppStorePackageActionKind;
  label: string;
}

export function resolveAppStorePackageAction(
  item: AppStorePackageRecord,
  t: TranslationFn = translate,
): AppStorePackageAction {
  if (item.hostUpdateRequired) return { kind: "host-update", label: t("appStore.actionHostUpdate") };
  if ((item.publishKind ?? "app") === "employee") {
    return item.installed
      ? { kind: "installed", label: t("appStore.actionInstalled") }
      : { kind: "install", label: t("common.install") };
  }
  if (item.installState === "needs_relink") return { kind: "relink", label: t("appStore.actionRelink") };
  if (item.installState === "source_conflict") return { kind: "conflict", label: t("appStore.sourceConflict") };
  if (!item.installed) return { kind: "install", label: t("common.install") };
  if (item.repairable) return { kind: "repair", label: t("appStore.actionRepair") };
  if (item.installState === "legacy_unknown") {
    return item.updateSafe === false
      ? item.openable
        ? { kind: "open", label: t("appStore.actionOpen") }
        : { kind: "inspect", label: t("appStore.needsInspection") }
      : { kind: "reinstall", label: t("appStore.actionReinstall") };
  }
  if (item.openIssue && item.openIssue !== "ui_not_workbench") {
    return { kind: "inspect", label: t("appStore.needsInspection") };
  }
  if (item.updateAvailable && item.updateSafe !== false) return { kind: "update", label: t("appStore.actionUpdate") };
  if (item.openable !== false) return { kind: "open", label: t("appStore.actionOpen") };
  return { kind: "installed", label: t("appStore.actionInstalled") };
}

export function formatAppStoreInstallError(error: string, t: TranslationFn = translate): string {
  if (error === "registry_not_configured") return t("appStore.errRegistryNotConfigured");
  if (error === "admin_required" || error === "forbidden") return t("appStore.errNoPublishPermission");
  if (error === "app_store_version_exists") return t("appStore.errVersionExists");
  if (error === "app_store_package_exists") return t("appStore.errPackageExists");
  if (error === "app_store_package_id_invalid") return t("appStore.errPackageIdInvalid");
  if (error === "app_store_repair_not_available") return t("appStore.errRepairNotAvailable");
  if (error === "app_store_repair_in_progress") return t("appStore.errRepairInProgress");
  if (error === "app_store_repair_required") return t("appStore.errRepairRequired");
  if (error === "app_store_relink_required") return t("appStore.errRelinkRequired");
  if (error === "app_store_relink_not_available") return t("appStore.errRelinkNotAvailable");
  if (error === "app_store_source_conflict" || error === "app_install_source_conflict")
    return t("appStore.errSourceConflict");
  if (error === "app_install_evidence_unreadable") return t("appStore.errEvidenceUnreadable");
  if (error === "app_store_update_not_safe") return t("appStore.errUpdateNotSafe");
  if (error === "app_store_host_update_required") return t("appStore.errHostUpdateRequired");
  if (error === "app_store_package_id_required") return t("appStore.errPackageIdRequired");
  if (error === "app_store_publish_target_changed") return t("appStore.errPublishTargetChanged");
  if (error === "app_store_publish_intent_changed") return t("appStore.errPublishIntentChanged");
  if (error.startsWith("app_store_publish_recovery_")) return t("appStore.errPublishRecoveryFailed");
  if (error === "app_store_install_target_changed") return t("appStore.errInstallTargetChanged");
  if (error === "app_store_cleanup_not_safe") return t("appStore.errCleanupNotSafe");
  if (error === "app_store_cleanup_target_changed") return t("appStore.errCleanupTargetChanged");
  if (error === "app_store_package_not_found") return t("appStore.errPackageNotFound");
  if (error === "app_store_version_contract_invalid") return t("appStore.errVersionContractInvalid");
  if (/archive_(?:checksum_invalid|checksum_mismatch|sha256_mismatch|size_mismatch)|archive.*failed/.test(error))
    return t("appStore.errArchiveCorrupted");
  if (/archive_(?:too_large|unpacked_too_large|file_count_exceeded)/.test(error))
    return t("appStore.errArchiveTooLarge");
  if (/archive_(?:symlink_rejected|entry_type_invalid|path_invalid)/.test(error)) return t("appStore.errArchiveUnsafe");
  if (/manifest_(?:required|invalid)|package_manifest_required/.test(error)) return t("appStore.errManifestMissing");
  if (error === "invalid_package_visibility") return t("appStore.errInvalidVisibility");
  if (error === "not_authenticated" || error === "unauthorized") return t("appStore.errNotAuthenticated");
  return rawDiagnosticText(error);
}
