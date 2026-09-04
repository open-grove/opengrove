/**
 * Supports: OpenGrove <=0.6.5 Store App layouts.
 * Target: OpenGrove 0.6.6 Store App layout v2.
 * Remove when: every supported direct upgrade source already uses layout v2 (OpenGrove >=0.6.6).
 */

export const STORE_APP_LAYOUT_V2 = {
  id: "store-app-layout-v2",
  layoutVersion: 2,
  introducedIn: "0.6.6",
  supports: "OpenGrove <=0.6.5 Store App layouts",
  removeWhen: "Every supported direct upgrade source already uses layout v2 (OpenGrove >=0.6.6)",
} as const;

export const STORE_APP_LAYOUT_V2_LOG_EVENTS = {
  migrationStarted: "store_app_layout_migration_started",
  copyCompleted: "store_app_layout_copy_completed",
  migrationDeferred: "store_app_layout_migration_deferred",
  activationDeferred: "store_app_layout_activation_deferred",
  finalValidationDeferred: "store_app_layout_final_validation_deferred",
  pointerSwitchDeferred: "store_app_layout_pointer_switch_deferred",
  migrationCompleted: "store_app_layout_migration_completed",
  postActivationStatePersistDeferred: "store_app_layout_post_activation_state_persist_deferred",
  legacyPathsRetired: "store_app_layout_legacy_paths_retired",
  legacyRetirementDeferred: "store_app_layout_legacy_retirement_deferred",
  programCleanupDeferred: "app_store_program_cleanup_deferred",
} as const;
