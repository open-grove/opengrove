import type {
  AppReleaseAction,
  AppReleaseCheck,
  AppReleaseEmployeeDefaults,
  AppReleaseProgress,
  KernelOption,
  MountedAppReleaseDraft,
  SkillRecord,
} from "../../bridge";
import { rawDiagnosticText, type TranslationFn } from "../../i18n";
import { BridgeRequestError } from "../../bridge";
import type { RoomMember } from "../rooms/rooms-model";

const CHECK_DETAIL_CODES = {
  releaseNotesPresent: "release_notes_present",
  releaseNotesMissing: "release_notes_missing",
  versionFormatInvalid: "version_format_invalid",
  versionValid: "version_valid",
  versionMustExceed: "version_must_exceed",
} as const;

const KERNEL_PRODUCT_NAMES: Record<string, string> = {
  "claude-code": "Claude Agent",
  codex: "Codex",
  pi: "Pi",
  kimi: "Kimi CLI",
};

export function currentChecks(release: MountedAppReleaseDraft): AppReleaseCheck[] {
  return release.checks.map((check) => {
    if (check.id === "release-notes") {
      return release.releaseNotes.trim()
        ? { ...check, status: "passed", detail: CHECK_DETAIL_CODES.releaseNotesPresent }
        : { ...check, status: "warning", detail: CHECK_DETAIL_CODES.releaseNotesMissing };
    }
    if (check.id === "version") {
      const valid = /^\d+\.\d+\.\d+$/.test(release.version.trim());
      const newer =
        !release.latestPublishedVersion || compareVersions(release.version, release.latestPublishedVersion) > 0;
      return {
        ...check,
        status: valid && newer ? "passed" : "blocked",
        detail: !valid
          ? CHECK_DETAIL_CODES.versionFormatInvalid
          : newer
            ? CHECK_DETAIL_CODES.versionValid
            : [CHECK_DETAIL_CODES.versionMustExceed, release.latestPublishedVersion].join(":"),
      };
    }
    return check;
  });
}

export function translatedCheck(t: TranslationFn, check: AppReleaseCheck): { label: string; detail: string } {
  const labels: Partial<Record<AppReleaseCheck["id"], ReturnType<TranslationFn>>> = {
    "manifest-and-ui": t("appStore.release.checkManifest"),
    "trusted-build-contract": t("appStore.release.checkBuildContract"),
    "portable-package": t("appStore.release.checkPackage"),
    "employee-skills": t("appStore.release.checkSkills"),
    version: t("appStore.release.checkVersion"),
    "trial-run": t("appStore.release.checkTrial"),
    "release-notes": t("appStore.release.checkNotes"),
  };
  const details: Record<string, string> = {
    manifest_and_ui_valid: t("appStore.release.detailManifestValid"),
    build_contract_valid: t("appStore.release.detailBuildContractValid"),
    build_contract_missing: t("appStore.release.detailBuildContractMissing"),
    build_contract_invalid: t("appStore.release.detailBuildContractInvalid"),
    app_manifest_or_ui_invalid: t("appStore.release.detailManifestInvalid"),
    portable_package_valid: t("appStore.release.detailPackageValid"),
    employee_skills_valid: t("appStore.release.detailSkillsValid"),
    version_format_invalid: t("appStore.release.detailVersionInvalid"),
    version_valid: t("appStore.release.detailVersionValid"),
    employee_trial_valid: t("appStore.release.detailTrialValid"),
    employee_trial_missing: t("appStore.release.detailTrialMissing"),
    release_notes_present: t("appStore.release.detailNotesPresent"),
    release_notes_missing: t("appStore.release.detailNotesMissing"),
  };
  const detail = check.detail.startsWith("missing_app_skills:")
    ? t("appStore.release.detailSkillsMissing", { skills: check.detail.slice("missing_app_skills:".length) })
    : check.detail.startsWith("version_must_exceed:")
      ? t("appStore.release.detailVersionNewer", { version: check.detail.slice("version_must_exceed:".length) })
      : details[check.detail] || check.detail;
  return { label: labels[check.id] || check.label, detail };
}

export function releaseEmployeeToRoomMember(employee: AppReleaseEmployeeDefaults, appId: string): RoomMember {
  return {
    id: employee.memberId,
    name: employee.name,
    avatarMode: employee.avatarMode,
    avatarSeed: employee.avatarSeed,
    avatarDataUrl: employee.avatarDataUrl,
    role: employee.role,
    kernel: employee.kernel,
    model: employee.model,
    reasoningEffort: employee.reasoningEffort,
    contextTokenBudget: employee.contextTokenBudget,
    accessMode: employee.accessMode,
    color: employee.color,
    availableSkillIds: employee.availableSkillIds,
    defaultSkillIds: employee.defaultSkillIds,
    visibility: employee.visibility,
    publicDescription: employee.publicDescription,
    publicSkills: employee.publicSkills,
    inputSpec: employee.inputSpec,
    outputSpec: employee.outputSpec,
    status: "idle",
    lastActive: "",
    source: "local",
    appId,
  };
}

export function roomMemberToReleaseEmployee(
  employee: AppReleaseEmployeeDefaults,
  member: RoomMember,
): AppReleaseEmployeeDefaults {
  return {
    ...employee,
    name: member.name,
    avatarMode: member.avatarMode,
    avatarSeed: member.avatarSeed,
    avatarDataUrl: member.avatarDataUrl,
    role: member.role,
    kernel: member.kernel,
    model: member.model,
    reasoningEffort: member.reasoningEffort,
    contextTokenBudget: member.contextTokenBudget,
    accessMode: member.accessMode,
    color: member.color,
    availableSkillIds: member.availableSkillIds ?? [],
    defaultSkillIds: member.defaultSkillIds ?? [],
    visibility: member.visibility ?? "private",
    publicDescription: member.publicDescription,
    publicSkills: member.publicSkills ?? [],
    inputSpec: member.inputSpec,
    outputSpec: member.outputSpec,
  };
}

export function releaseKernelOptions(employees: AppReleaseEmployeeDefaults[]): KernelOption[] {
  return [...new Set(employees.map((employee) => employee.kernel))].map((kernel) => ({
    id: kernel as KernelOption["id"],
    label: kernelLabel(kernel),
    available: true,
    active: false,
    installed: true,
    bindingKind: "login" as const,
    bindingStatus: "ready" as const,
  }));
}

export function releaseSkillRecords(employees: AppReleaseEmployeeDefaults[]): SkillRecord[] {
  const skillIds = employees.flatMap((employee) => [...employee.availableSkillIds, ...employee.defaultSkillIds]);
  return [...new Set(skillIds)].map((skillId) => ({
    id: skillId,
    name: skillId,
    title: skillId,
    source: "app-release",
  }));
}

export function formatDraftSavedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function releaseErrorMessage(t: TranslationFn, error: string): string {
  const messages: Record<string, string> = {
    forbidden: t("appStore.release.errorForbidden"),
    admin_required: t("appStore.release.errorForbidden"),
    mounted_app_not_found: t("appStore.release.errorNotFound"),
    app_store_registry_not_configured: t("appStore.release.errorRegistry"),
    registry_not_configured: t("appStore.release.errorRegistry"),
    registry_token_required: t("appStore.release.errorToken"),
    app_store_release_blocked: t("appStore.release.errorBlocked"),
    app_store_release_version_invalid: t("appStore.release.errorVersion"),
    app_store_release_context_budget_invalid: t("appStore.release.errorContext"),
    app_store_release_employee_set_changed: t("appStore.release.errorEmployeeSet"),
    app_store_release_title_required: t("appStore.release.errorTitle"),
    app_store_release_employee_name_required: t("appStore.release.errorEmployeeName"),
    app_store_release_kernel_required: t("appStore.release.errorKernel"),
    app_store_release_model_required: t("appStore.release.errorModel"),
    app_store_publish_remote_succeeded_local_sync_failed: t("appStore.release.errorRemoteSync"),
    app_store_publish_target_changed: t("appStore.release.errorTarget"),
    app_store_publish_recovery_corrupted: t("appStore.release.errorRecovery"),
    app_store_publish_intent_changed: t("appStore.release.errorRecovery"),
    app_store_publish_journal_missing: t("appStore.release.errorJournalMissing"),
    app_store_publish_base_missing: t("appStore.release.errorBaseMissing"),
    app_store_publish_base_invalid: t("appStore.release.errorBaseInvalid"),
    app_store_publish_base_stale: t("appStore.release.errorBaseStale"),
    app_release_publish_base_stale: t("appStore.release.errorBaseStale"),
    app_store_publish_identity_mismatch: t("appStore.release.errorIdentity"),
    app_store_release_version_not_greater: t("appStore.release.errorVersionNewer"),
    app_store_publish_build_failed: t("appStore.release.errorBuildFailed"),
    app_release_local_build_command_failed: t("appStore.release.errorLocalBuildCommandFailed"),
    app_release_local_build_timed_out: t("appStore.release.errorLocalBuildTimedOut"),
    app_release_local_build_timeout_invalid: t("appStore.release.errorLocalBuildTimeoutInvalid"),
    app_release_local_build_cancelled: t("appStore.release.errorLocalBuildCancelled"),
    app_release_local_build_command_unavailable: t("appStore.release.errorLocalBuildCommandUnavailable"),
    app_release_local_build_in_progress: t("appStore.release.errorLocalBuildInProgress"),
    app_release_local_build_install_changed: t("appStore.release.errorLocalBuildInstallChanged"),
    app_release_local_build_manifest_invalid: t("appStore.release.errorLocalBuildManifestInvalid"),
    app_release_local_build_platform_unsupported: t("appStore.release.errorLocalBuildPlatformUnsupported"),
    app_release_local_build_output_depth_exceeded: t("appStore.release.errorLocalBuildOutputBudget"),
    app_release_local_build_output_entry_count_exceeded: t("appStore.release.errorLocalBuildOutputBudget"),
    app_release_local_build_output_file_count_exceeded: t("appStore.release.errorLocalBuildOutputBudget"),
    app_release_local_build_output_file_too_large: t("appStore.release.errorLocalBuildOutputBudget"),
    app_release_local_build_output_too_large: t("appStore.release.errorLocalBuildOutputBudget"),
    app_release_local_build_output_entry_type: t("appStore.release.errorLocalBuildOutputType"),
    app_release_local_build_output_symlink: t("appStore.release.errorLocalBuildOutputType"),
    app_release_local_build_output_changed: t("appStore.release.errorLocalBuildOutputUnstable"),
    app_release_local_build_output_missing: t("appStore.release.errorLocalBuildOutputUnstable"),
    app_release_local_build_output_empty: t("appStore.release.errorLocalBuildOutputUnstable"),
    app_release_local_build_file_changed: t("appStore.release.errorLocalBuildOutputUnstable"),
    app_release_local_build_output_path_collision: t("appStore.release.errorLocalBuildOutputPath"),
    app_release_local_build_output_protected: t("appStore.release.errorLocalBuildOutputPath"),
    app_release_local_build_output_working_directory: t("appStore.release.errorLocalBuildOutputPath"),
    app_release_local_build_outputs_overlap: t("appStore.release.errorLocalBuildOutputPath"),
    app_release_local_build_path_invalid: t("appStore.release.errorLocalBuildOutputPath"),
    app_release_local_build_output_not_publishable: t("appStore.release.errorLocalBuildOutputPath"),
    app_release_local_build_process_cleanup_failed: t("appStore.release.errorLocalBuildCommandFailed"),
    app_store_publish_abandoned: t("appStore.release.errorAbandoned"),
    app_store_publish_abandon_invalid: t("appStore.release.errorAbandonInvalid"),
    app_store_publish_draft_changed: t("appStore.release.errorDraftChanged"),
    app_store_publish_working_copy_changed: t("appStore.release.errorWorkingCopyChanged"),
    app_store_publish_active_runs: t("appStore.release.errorActiveRuns"),
    app_store_publish_registry_not_ready: t("appStore.release.errorRegistryPending"),
    app_store_publish_local_resolution_invalid: t("appStore.release.errorLocalResolution"),
    app_release_in_progress_unavailable: t("appStore.release.errorOpaqueConflict"),
    app_release_not_found: t("appStore.release.errorRemoteIntentUnavailable"),
    local_app_draft_working_copy_changed: t("appStore.release.errorDraftWorkingCopyChanged"),
    app_store_package_invalid: t("appStore.release.errorPackage"),
    app_store_package_key_invalid: t("appStore.release.errorPackage"),
    app_id_required: t("appStore.release.errorInput"),
    invalid_package_visibility: t("appStore.release.errorInput"),
    app_store_release_description_invalid: t("appStore.release.errorInput"),
    app_store_release_icon_invalid: t("appStore.release.errorInput"),
    app_store_release_notes_too_long: t("appStore.release.errorInput"),
    app_release_build_contract_repair_conflict: t("appStore.release.errorBuildContractRepairConflict"),
    app_release_build_contract_repair_failed: t("appStore.release.errorBuildContractRepairFailed"),
    app_store_release_avatar_invalid: t("appStore.release.errorInput"),
    app_store_release_employee_role_invalid: t("appStore.release.errorInput"),
    app_store_release_public_description_invalid: t("appStore.release.errorInput"),
    app_store_release_input_spec_invalid: t("appStore.release.errorInput"),
    app_store_release_output_spec_invalid: t("appStore.release.errorInput"),
    app_store_release_color_required: t("appStore.release.errorInput"),
    app_release_request_unavailable: t("appStore.release.errorServiceUnavailable"),
    app_release_request_timeout: t("appStore.release.errorServiceTimeout"),
    app_release_response_content_type_invalid: t("appStore.release.errorServiceResponse"),
    app_release_response_invalid: t("appStore.release.errorServiceResponse"),
    app_release_response_too_large: t("appStore.release.errorServiceResponse"),
    app_release_response_identity_mismatch: t("appStore.release.errorServiceResponse"),
    app_release_error_response_invalid: t("appStore.release.errorServiceResponse"),
    app_release_response_body_missing: t("appStore.release.errorServiceResponse"),
    app_release_trusted_artifact_invalid: t("appStore.release.errorTrustedArtifactInvalid"),
    app_release_secret_blocked: t("appStore.release.errorSecretBlocked"),
    release_control_unauthorized: t("appStore.registryError.unauthorized"),
    release_control_identity_unavailable: t("appStore.release.errorServiceUnavailable"),
    release_control_dependency_unavailable: t("appStore.release.errorServiceUnavailable"),
    release_control_not_ready: t("appStore.release.errorServiceUnavailable"),
  };
  return messages[error] || rawDiagnosticText(error);
}

export type AppReleaseVisibleStage =
  | "source-upload"
  | "candidate"
  | "trusted-build"
  | "registry"
  | "local-finalization";

export function releaseVisibleStage(progress: AppReleaseProgress): AppReleaseVisibleStage {
  if (progress.phase === "registry_ready") return "local-finalization";
  if (progress.phase === "draft_saved") return "source-upload";
  if (
    progress.phase === "intent_created" ||
    progress.phase === "source_snapshot_uploaded" ||
    progress.remoteStatus === "awaiting_candidate"
  ) {
    return "candidate";
  }
  if (progress.remoteStatus === "building" || progress.remoteStatus === "trusted_build_failed") {
    return "trusted-build";
  }
  if (
    progress.remoteStatus === "artifact_accepted" ||
    progress.remoteStatus === "finalizing" ||
    progress.remoteStatus === "published"
  ) {
    return "registry";
  }
  return "source-upload";
}

export function publishProgressFromError(error: unknown): AppReleaseProgress | undefined {
  if (!(error instanceof BridgeRequestError)) return undefined;
  const progress = error.payload?.progress;
  if (!isAppReleaseProgress(progress)) return undefined;
  return progress;
}

const CANDIDATE_FAILURE_STAGES = new Set([
  "source_load",
  "repository_prepare",
  "repository_auth",
  "repository_lookup",
  "repository_create",
  "repository_main_lookup",
  "repository_bootstrap",
  "candidate_publish",
  "candidate_auth",
  "candidate_main_lookup",
  "candidate_workspace",
  "candidate_git_init",
  "candidate_main_fetch",
  "candidate_source_materialize",
  "candidate_object_write",
  "candidate_commit_create",
  "candidate_ref_push",
  "source_close",
  "candidate_record",
  "build_auth",
  "build_dispatch",
  "dispatch_record",
]);

export interface AppReleaseFailureDiagnostic {
  candidateStage?: string;
  requestId?: string;
  localBuild?: {
    commandIndex: number;
    argv: string[];
    argvTruncated: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
}

export function releaseFailureDiagnostic(error: unknown): AppReleaseFailureDiagnostic | undefined {
  if (!(error instanceof BridgeRequestError)) return undefined;
  const localBuild = parseLocalBuildFailureDiagnostic(error);
  if (localBuild) return { localBuild };
  const candidateStage = error.payload?.candidateStage;
  if (typeof candidateStage !== "string" || !CANDIDATE_FAILURE_STAGES.has(candidateStage)) {
    return undefined;
  }
  return {
    candidateStage,
    ...(error.requestId ? { requestId: error.requestId } : {}),
  };
}

function parseLocalBuildFailureDiagnostic(
  error: BridgeRequestError,
): NonNullable<AppReleaseFailureDiagnostic["localBuild"]> | undefined {
  if (error.message !== "app_release_local_build_command_failed") return undefined;
  const detail = error.payload?.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const record = detail as Record<string, unknown>;
  const commandIndex = record.commandIndex;
  const argv = record.argv;
  const argvTruncated = record.argvTruncated;
  const exitCode = record.exitCode;
  const stdout = record.stdout;
  const stderr = record.stderr;
  const stdoutTruncated = record.stdoutTruncated;
  const stderrTruncated = record.stderrTruncated;
  if (
    !Number.isInteger(commandIndex) ||
    (commandIndex as number) < 1 ||
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((item) => typeof item === "string") ||
    typeof argvTruncated !== "boolean" ||
    !Number.isInteger(exitCode) ||
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    typeof stdoutTruncated !== "boolean" ||
    typeof stderrTruncated !== "boolean"
  ) {
    return undefined;
  }
  return {
    commandIndex: commandIndex as number,
    argv: [...argv] as string[],
    argvTruncated,
    exitCode: exitCode as number,
    stdout,
    stderr,
    stdoutTruncated,
    stderrTruncated,
  };
}

export function releaseInProgress(progress: AppReleaseProgress): boolean {
  return (
    progress.state === "publishing" ||
    progress.state === "blocked" ||
    progress.state === "needs-retry" ||
    progress.state === "registry-ready"
  );
}

export function releaseAutomaticallyRecoverable(progress: AppReleaseProgress | undefined): boolean {
  return progress?.retryable === true && (progress.state === "publishing" || progress.state === "registry-ready");
}

const MANUAL_RELEASE_RECOVERY_ERROR_CODES = new Set([
  "app_release_not_found",
  "app_release_in_progress",
  "app_release_in_progress_unavailable",
  "app_release_request_unavailable",
  "app_release_request_timeout",
  "app_release_response_content_type_invalid",
  "app_release_response_invalid",
  "app_release_response_too_large",
  "app_release_response_identity_mismatch",
  "app_release_error_response_invalid",
  "app_release_response_body_missing",
  "release_control_unauthorized",
  "release_control_identity_unavailable",
  "release_control_dependency_unavailable",
  "release_control_not_ready",
]);

export function releaseRecoveryRequiresManualContinue(error: unknown): boolean {
  return error instanceof BridgeRequestError && MANUAL_RELEASE_RECOVERY_ERROR_CODES.has(error.message);
}

export function isLocalPublishFinalizationConflict(error: unknown): boolean {
  return (
    error instanceof BridgeRequestError &&
    (error.message === "app_store_publish_draft_changed" || error.message === "app_store_publish_working_copy_changed")
  );
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function kernelLabel(value: string): string {
  return KERNEL_PRODUCT_NAMES[value] ?? value;
}

function isAppReleaseProgress(value: unknown): value is AppReleaseProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  const validPhases = new Set([
    "draft_saved",
    "intent_created",
    "source_snapshot_uploaded",
    "remote_blocked",
    "remote_conflict",
    "remote_pending",
    "remote_closed",
    "registry_ready",
    "local_preserved",
    "local_finalized",
  ]);
  return (
    typeof progress.localAppId === "string" &&
    typeof progress.appId === "string" &&
    typeof progress.packageKey === "string" &&
    typeof progress.version === "string" &&
    typeof progress.title === "string" &&
    (progress.visibility === "public" || progress.visibility === "restricted") &&
    typeof progress.phase === "string" &&
    validPhases.has(progress.phase) &&
    (progress.remoteIntentId === undefined || typeof progress.remoteIntentId === "string") &&
    (progress.buildFailure === undefined ||
      (progress.remoteStatus === "trusted_build_failed" && isBuildFailure(progress.buildFailure))) &&
    isAllowedActions(progress.allowedActions) &&
    (progress.requestId === undefined || /^[a-f0-9]{32}$/.test(String(progress.requestId))) &&
    typeof progress.applyToCurrentApp === "boolean" &&
    (progress.state === "publishing" ||
      progress.state === "blocked" ||
      progress.state === "needs-retry" ||
      progress.state === "registry-ready" ||
      progress.state === "closed" ||
      progress.state === "published") &&
    (progress.blockedRelease === undefined || isBlockedRelease(progress.blockedRelease)) &&
    typeof progress.retryable === "boolean" &&
    typeof progress.updatedAt === "string"
  );
}

function isBlockedRelease(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const blocked = value as Record<string, unknown>;
  const allowedActions = blocked.allowedActions;
  const matchesCurrentSource = blocked.matchesCurrentSource;
  const matchesCurrentRequest = blocked.matchesCurrentRequest;
  return (
    typeof blocked.id === "string" &&
    typeof blocked.status === "string" &&
    typeof blocked.packageKey === "string" &&
    /^\d+\.\d+\.\d+$/.test(String(blocked.version ?? "")) &&
    /^[a-f0-9]{64}$/.test(String(blocked.sourceSha256 ?? "")) &&
    typeof blocked.createdAt === "string" &&
    isAllowedActions(allowedActions) &&
    (blocked.requestId === undefined || typeof blocked.requestId === "string") &&
    typeof matchesCurrentSource === "boolean" &&
    typeof matchesCurrentRequest === "boolean" &&
    (!matchesCurrentRequest || matchesCurrentSource) &&
    allowedActions.every((action) => action === "abandon" || matchesCurrentRequest) &&
    (blocked.buildFailure === undefined ||
      (blocked.status === "trusted_build_failed" && isBuildFailure(blocked.buildFailure)))
  );
}

function isAllowedActions(value: unknown): value is AppReleaseAction[] {
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    new Set(value).size === value.length &&
    value.every((action) => action === "retry_candidate" || action === "retry_build" || action === "abandon")
  );
}

function isBuildFailure(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const failure = value as Record<string, unknown>;
  return (
    Object.keys(failure).length === 4 &&
    (failure.stage === "trusted_build" ||
      failure.stage === "artifact_pack" ||
      failure.stage === "artifact_gate" ||
      failure.stage === "workflow") &&
    typeof failure.code === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/.test(failure.code) &&
    typeof failure.retryable === "boolean" &&
    typeof failure.workflowRunId === "string" &&
    /^[1-9][0-9]{0,31}$/.test(failure.workflowRunId)
  );
}
