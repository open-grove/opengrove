import { normalizeAppStorePackageKey } from "../app-store-package-identity.js";
import { normalizeAppIconValue } from "../app-icons/icon-value.js";
import { assertAppReleaseEligibility, validateAppRoot } from "../app-builder/cli.js";
import type { OpenGroveAppManifest } from "../app-builder/manifest.js";
import type { JsonObject } from "../core.js";
import { ROOM_MEMBER_AVATAR_DATA_URL_MAX_LENGTH, normalizedRoomMemberAvatarDataUrl } from "../rooms/avatar-data-url.js";
import type { RoomChannelMember } from "../rooms/channel-store.js";
import { readAppStorePackageInstallMarker, type AppStorePackageRecord } from "./app-store.js";
import { mountedAppSkillNames, publicEmployeeRole } from "./bridge-mounted-app-employees.js";
import type { BridgeState } from "./bridge-types.js";
import { resolveMountedAppTarget } from "./mounted-apps.js";
import { validateAppReleaseBuildContract } from "./app-release-build-contract.js";
import {
  KERNEL_CAPABILITY_REQUIREMENTS_MIN_HOST_RELEASE,
  normalizeRequiredKernelCapabilities,
} from "../kernel/capabilities/requirements.js";
import type { KernelCapabilityId } from "../kernel/capabilities/types.js";

// ===== Release contract and lifecycle =====

export type AppReleaseCheckSeverity = "blocking" | "warning";
export type AppReleaseCheckStatus = "passed" | "blocked" | "warning";

export interface AppReleaseCheck {
  id: string;
  label: string;
  severity: AppReleaseCheckSeverity;
  status: AppReleaseCheckStatus;
  detail: string;
}

export interface AppReleaseEmployeeDefaults {
  memberId: string;
  name: string;
  avatarMode?: RoomChannelMember["avatarMode"];
  avatarSeed?: string;
  avatarDataUrl?: string;
  role: string;
  kernel: string;
  model: string;
  reasoningEffort?: RoomChannelMember["reasoningEffort"];
  contextTokenBudget?: number;
  accessMode?: RoomChannelMember["accessMode"];
  color: string;
  availableSkillIds: string[];
  defaultSkillIds: string[];
  requiredKernelCapabilities?: KernelCapabilityId[];
  visibility: RoomChannelMember["visibility"];
  publicDescription?: string;
  publicSkills: string[];
  inputSpec?: string;
  outputSpec?: string;
}

export interface MountedAppReleaseDraft {
  identity: {
    appId: string;
    packageId?: string;
    packageKey?: string;
    source: "mounted" | "registry";
    appRoot: string;
    workspaceRoot: string;
  };
  app: {
    title: string;
    description: string;
    icon?: string;
  };
  version: string;
  latestPublishedVersion?: string;
  releaseNotes: string;
  visibility: "public" | "restricted";
  minHostReleaseNumber?: number;
  employees: AppReleaseEmployeeDefaults[];
  checks: AppReleaseCheck[];
}

export interface AppReleaseEmployeeOverridePatch {
  memberId: string;
  userOverrides: string[];
}

export class AppReleaseValidationError extends Error {
  constructor(
    message: string,
    readonly checks: AppReleaseCheck[],
    readonly status = 409,
  ) {
    super(message);
  }
}

export function prepareMountedAppRelease(input: {
  state: BridgeState;
  appId: string;
  registryPackages: AppStorePackageRecord[];
  includePackageSafetyCheck?: boolean;
}): MountedAppReleaseDraft {
  const baseline = mountedAppReleaseBaseline(input);
  return {
    ...baseline,
    checks: releaseChecks({
      state: input.state,
      appId: baseline.identity.appId,
      appRoot: baseline.identity.appRoot,
      manifest: resolveMountedAppTarget(input.state, input.appId)!.manifest as OpenGroveAppManifest,
      employees: baseline.employees,
      version: baseline.version,
      latestPublishedVersion: baseline.latestPublishedVersion,
      releaseNotes: baseline.releaseNotes,
      includePackageSafetyCheck: input.includePackageSafetyCheck !== false,
    }),
  };
}

function mountedAppReleaseBaseline(input: {
  state: BridgeState;
  appId: string;
  registryPackages: AppStorePackageRecord[];
}): Omit<MountedAppReleaseDraft, "checks"> {
  const target = resolveMountedAppTarget(input.state, input.appId);
  if (!target) throw new Error("mounted_app_not_found");
  const manifest = target.manifest as JsonObject;
  const marker = readAppStorePackageInstallMarker(target.appRoot);
  const manifestStore = record(manifest.store);
  const packageKey =
    normalizeAppStorePackageKey(marker?.packageKey) ?? normalizeAppStorePackageKey(manifestStore.packageKey);
  const latestPackage = latestRegistryPackage(input.registryPackages, target.id, packageKey);
  const latestPublishedVersion = latestPackage?.version;
  const declaredMinHostReleaseNumber =
    typeof manifestStore.minHostReleaseNumber === "number" &&
    Number.isSafeInteger(manifestStore.minHostReleaseNumber) &&
    manifestStore.minHostReleaseNumber > 0
      ? manifestStore.minHostReleaseNumber
      : 0;
  const employees = mountedAppEffectiveEmployeeDefaults(input.state, target.id);
  const minHostReleaseNumber = employees.some((employee) => Boolean(employee.requiredKernelCapabilities?.length))
    ? Math.max(declaredMinHostReleaseNumber, KERNEL_CAPABILITY_REQUIREMENTS_MIN_HOST_RELEASE)
    : declaredMinHostReleaseNumber;
  const version = latestPublishedVersion ? incrementPatch(latestPublishedVersion) : "0.1.0";
  return {
    identity: {
      appId: target.id,
      ...(latestPackage?.packageId ? { packageId: latestPackage.packageId } : {}),
      ...(packageKey ? { packageKey } : {}),
      source: marker?.source === "registry" ? "registry" : "mounted",
      appRoot: target.appRoot,
      workspaceRoot: target.workspaceRoot,
    },
    app: {
      title: stringValue(manifest.title) || target.title,
      description: stringValue(manifest.description),
      ...(manifestIcon(manifest) ? { icon: manifestIcon(manifest) } : {}),
    },
    version,
    ...(latestPublishedVersion ? { latestPublishedVersion } : {}),
    releaseNotes: "",
    visibility: manifestStore.visibility === "public" ? "public" : "restricted",
    minHostReleaseNumber,
    employees,
  };
}

export function stageMountedAppRelease(input: {
  state: BridgeState;
  appId: string;
  registryPackages: AppStorePackageRecord[];
  release: unknown;
}): MountedAppReleaseDraft {
  const baseline = { ...mountedAppReleaseBaseline(input), checks: [] };
  const release = normalizeMountedAppReleaseSubmission(baseline, input.release);
  const target = resolveMountedAppTarget(input.state, input.appId);
  if (!target) throw new Error("mounted_app_not_found");
  const manifest = mountedAppReleaseManifest(target.manifest as JsonObject, release);
  release.checks = releaseChecks({
    state: input.state,
    appId: target.id,
    appRoot: target.appRoot,
    manifest,
    employees: release.employees,
    version: release.version,
    latestPublishedVersion: release.latestPublishedVersion,
    releaseNotes: release.releaseNotes,
  });
  if (release.checks.some((check) => check.severity === "blocking" && check.status === "blocked")) {
    throw new AppReleaseValidationError("app_store_release_blocked", release.checks);
  }
  return release;
}

export function finalizedReleaseManifest(
  manifest: OpenGroveAppManifest,
  publishedPackage: AppStorePackageRecord,
): OpenGroveAppManifest {
  return {
    ...manifest,
    version: publishedPackage.version,
    store: {
      ...manifest.store,
      ...(publishedPackage.packageKey ? { packageKey: publishedPackage.packageKey } : {}),
    },
  };
}

const RELEASE_EMPLOYEE_FIELDS = [
  "name",
  "avatarMode",
  "avatarSeed",
  "avatarDataUrl",
  "role",
  "kernel",
  "model",
  "reasoningEffort",
  "contextTokenBudget",
  "accessMode",
  "color",
  "availableSkillIds",
  "defaultSkillIds",
  "requiredKernelCapabilities",
  "visibility",
  "publicDescription",
  "publicSkills",
  "inputSpec",
  "outputSpec",
] as const;

export function preserveLocalEmployeeStateAfterRelease(
  state: BridgeState,
  appId: string,
  releasedEmployees: AppReleaseEmployeeDefaults[],
): void {
  const patches = localEmployeeOverridePatchesAfterRelease(state, appId, releasedEmployees);
  let changed = false;
  for (const patch of patches) {
    state.app.rooms.patchMember(patch.memberId, { userOverrides: patch.userOverrides });
    changed = true;
  }
  if (changed) state.store.saveFrom(state.app);
}

export function localEmployeeOverridePatchesAfterRelease(
  state: BridgeState,
  appId: string,
  releasedEmployees: AppReleaseEmployeeDefaults[],
): AppReleaseEmployeeOverridePatch[] {
  const releasedById = new Map(releasedEmployees.map((employee) => [employee.memberId, employee]));
  return state.app.rooms.listMembers().flatMap((member) => {
    if (member.appId !== appId || member.disabled) return [];
    const released = releasedById.get(member.id);
    if (!released) return [];
    const differing = RELEASE_EMPLOYEE_FIELDS.filter(
      (field) => !releaseFieldEqual(field, member[field], released[field]),
    );
    return differing.length
      ? [
          {
            memberId: member.id,
            userOverrides: uniqueStrings([...(member.userOverrides ?? []), ...differing]),
          },
        ]
      : [];
  });
}

function releaseFieldEqual(
  field: (typeof RELEASE_EMPLOYEE_FIELDS)[number],
  localValue: unknown,
  releasedValue: unknown,
): boolean {
  if (field === "role") return publicEmployeeRole(String(localValue ?? "")) === String(releasedValue ?? "");
  if (Array.isArray(localValue) || Array.isArray(releasedValue)) {
    return JSON.stringify(localValue ?? []) === JSON.stringify(releasedValue ?? []);
  }
  return localValue === releasedValue;
}

function releaseEmployeeDefaults(member: RoomChannelMember): AppReleaseEmployeeDefaults {
  return {
    memberId: member.id,
    name: member.name,
    ...(member.avatarMode ? { avatarMode: member.avatarMode } : {}),
    ...(member.avatarSeed ? { avatarSeed: member.avatarSeed } : {}),
    ...(member.avatarDataUrl ? { avatarDataUrl: member.avatarDataUrl } : {}),
    role: publicEmployeeRole(member.role),
    kernel: member.kernel,
    model: member.model,
    ...(member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {}),
    ...(member.contextTokenBudget ? { contextTokenBudget: member.contextTokenBudget } : {}),
    ...(member.accessMode ? { accessMode: member.accessMode } : {}),
    color: member.color,
    availableSkillIds: [...(member.availableSkillIds ?? [])],
    defaultSkillIds: [...(member.defaultSkillIds ?? [])],
    requiredKernelCapabilities: [...(member.requiredKernelCapabilities ?? [])],
    visibility: member.visibility,
    ...(member.publicDescription ? { publicDescription: member.publicDescription } : {}),
    publicSkills: [...(member.publicSkills ?? [])],
    ...(member.inputSpec ? { inputSpec: member.inputSpec } : {}),
    ...(member.outputSpec ? { outputSpec: member.outputSpec } : {}),
  };
}

export function mountedAppEffectiveEmployeeDefaults(state: BridgeState, appId: string): AppReleaseEmployeeDefaults[] {
  return state.app.rooms
    .listMembers()
    .filter((member) => member.appId === appId && !member.disabled && !member.employeeDefinitionId)
    .map(releaseEmployeeDefaults);
}

// ===== Publish readiness checks =====

function releaseChecks(input: {
  state: BridgeState;
  appId: string;
  appRoot: string;
  manifest: OpenGroveAppManifest;
  employees: AppReleaseEmployeeDefaults[];
  version: string;
  latestPublishedVersion?: string;
  releaseNotes: string;
  includePackageSafetyCheck?: boolean;
}): AppReleaseCheck[] {
  const report = validateAppRoot(input.appRoot);
  let eligibilityError: unknown;
  if (report.ok === true && input.includePackageSafetyCheck !== false) {
    try {
      assertAppReleaseEligibility(input.appRoot, { manifestOverride: input.manifest });
    } catch (error) {
      eligibilityError = error;
    }
  }
  const validationPassed = report.ok === true && eligibilityError === undefined;
  const checks: AppReleaseCheck[] = [
    {
      id: "manifest-and-ui",
      label: "Manifest and UI entry",
      severity: "blocking",
      status: validationPassed ? "passed" : "blocked",
      detail: validationPassed
        ? "manifest_and_ui_valid"
        : eligibilityError instanceof Error
          ? eligibilityError.message
          : eligibilityError === undefined
            ? reportIssues(report)
            : String(eligibilityError),
    },
  ];
  const buildContract = validateAppReleaseBuildContract(input.appRoot);
  checks.push({
    id: "trusted-build-contract",
    label: "Local release build",
    severity: "blocking",
    status: buildContract.ok ? "passed" : "blocked",
    detail: buildContract.detail,
  });
  const localSkills = new Set(mountedAppSkillNames(input.appRoot, input.manifest as JsonObject));
  const missingSkills = uniqueStrings(
    input.employees.flatMap((employee) =>
      [...employee.availableSkillIds, ...employee.defaultSkillIds]
        .map((skillId) => localAppSkillName(skillId, input.appId))
        .filter((name): name is string => Boolean(name && !localSkills.has(name))),
    ),
  );
  checks.push({
    id: "employee-skills",
    label: "Employee Skills",
    severity: "blocking",
    status: missingSkills.length ? "blocked" : "passed",
    detail: missingSkills.length ? `missing_app_skills:${missingSkills.join(",")}` : "employee_skills_valid",
  });
  const versionIsValid = Boolean(semanticVersion(input.version));
  const versionIsNewer =
    !input.latestPublishedVersion || compareVersions(input.version, input.latestPublishedVersion) > 0;
  checks.push({
    id: "version",
    label: "Version",
    severity: "blocking",
    status: versionIsValid && versionIsNewer ? "passed" : "blocked",
    detail: !versionIsValid
      ? "version_format_invalid"
      : versionIsNewer
        ? "version_valid"
        : `version_must_exceed:${input.latestPublishedVersion}`,
  });
  const memberIds = new Set(input.employees.map((employee) => employee.memberId));
  const completedMemberIds = new Set(
    input.state.app.rooms
      .snapshot()
      .messages.filter((message) => memberIds.has(message.senderId) && message.status === "done")
      .map((message) => message.senderId),
  );
  const completedTrial = memberIds.size > 0 && [...memberIds].every((memberId) => completedMemberIds.has(memberId));
  checks.push({
    id: "trial-run",
    label: "Local employee trial run",
    severity: "warning",
    status: completedTrial ? "passed" : "warning",
    detail: completedTrial ? "employee_trial_valid" : "employee_trial_missing",
  });
  checks.push({
    id: "release-notes",
    label: "Release notes",
    severity: "warning",
    status: input.releaseNotes ? "passed" : "warning",
    detail: input.releaseNotes ? "release_notes_present" : "release_notes_missing",
  });
  return checks;
}

// ===== Submitted snapshot normalization =====

export function normalizeMountedAppReleaseSubmission(
  baseline: MountedAppReleaseDraft,
  value: unknown,
): MountedAppReleaseDraft {
  const input = value === undefined || value === null ? baseline : record(value);
  const app = record(input.app);
  const title = boundedRequiredString(app.title, "app_store_release_title_required", 120);
  const description = boundedString(app.description, "app_store_release_description_invalid", 4_000);
  const submittedIcon = boundedString(app.icon, "app_store_release_icon_invalid", 1_500_000);
  const icon = submittedIcon === baseline.app.icon ? submittedIcon : normalizeAppIconValue(submittedIcon);
  if (submittedIcon && !icon) {
    throw new AppReleaseValidationError("app_store_release_icon_invalid", baseline.checks, 400);
  }
  const version = stringValue(input.version);
  const releaseNotes = boundedString(input.releaseNotes, "app_store_release_notes_too_long", 800);
  const visibility =
    input.visibility === "public" ? "public" : input.visibility === "restricted" ? "restricted" : undefined;
  if (!semanticVersion(version))
    throw new AppReleaseValidationError("app_store_release_version_invalid", baseline.checks, 400);
  if (!visibility) throw new AppReleaseValidationError("invalid_package_visibility", baseline.checks, 400);
  const employeeInputs = Array.isArray(input.employees) ? input.employees.map(record) : [];
  const expectedIds = baseline.employees.map((employee) => employee.memberId);
  const submittedIds = employeeInputs.map((employee) => stringValue(employee.memberId));
  if (
    employeeInputs.length !== expectedIds.length ||
    new Set(submittedIds).size !== expectedIds.length ||
    expectedIds.some((memberId) => !submittedIds.includes(memberId))
  ) {
    throw new AppReleaseValidationError("app_store_release_employee_set_changed", baseline.checks);
  }
  return {
    ...baseline,
    app: { title, description, ...(icon ? { icon } : {}) },
    version,
    releaseNotes,
    visibility,
    employees: expectedIds.map((memberId) =>
      normalizeReleaseEmployee(employeeInputs.find((employee) => stringValue(employee.memberId) === memberId) ?? {}),
    ),
  };
}

export function normalizeReleaseEmployee(input: Record<string, unknown>): AppReleaseEmployeeDefaults {
  const avatarMode =
    input.avatarMode === "generated" || input.avatarMode === "initials" || input.avatarMode === "upload"
      ? input.avatarMode
      : undefined;
  const reasoning = stringValue(input.reasoningEffort);
  const reasoningEffort = ["low", "medium", "high", "xhigh", "max"].includes(reasoning)
    ? (reasoning as RoomChannelMember["reasoningEffort"])
    : undefined;
  const access = stringValue(input.accessMode);
  const accessMode = ["default", "auto-review", "full-access"].includes(access)
    ? (access as RoomChannelMember["accessMode"])
    : undefined;
  const contextTokenBudget = Number(input.contextTokenBudget);
  if (input.contextTokenBudget !== undefined && (!Number.isInteger(contextTokenBudget) || contextTokenBudget <= 0)) {
    throw new AppReleaseValidationError("app_store_release_context_budget_invalid", [], 400);
  }
  const submittedAvatarDataUrl = boundedString(
    input.avatarDataUrl,
    "app_store_release_avatar_invalid",
    ROOM_MEMBER_AVATAR_DATA_URL_MAX_LENGTH,
  );
  const avatarDataUrl = submittedAvatarDataUrl ? normalizedRoomMemberAvatarDataUrl(submittedAvatarDataUrl) : undefined;
  if (
    submittedAvatarDataUrl &&
    (!avatarDataUrl || !/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(avatarDataUrl))
  ) {
    throw new AppReleaseValidationError("app_store_release_avatar_invalid", [], 400);
  }
  const avatarSeed = boundedString(input.avatarSeed, "app_store_release_avatar_seed_invalid", 512);
  const publicDescription = boundedString(
    input.publicDescription,
    "app_store_release_public_description_invalid",
    4_000,
  );
  const inputSpec = boundedString(input.inputSpec, "app_store_release_input_spec_invalid", 8_000);
  const outputSpec = boundedString(input.outputSpec, "app_store_release_output_spec_invalid", 8_000);
  return {
    memberId: boundedRequiredString(input.memberId, "app_store_release_member_id_required", 240),
    name: boundedRequiredString(input.name, "app_store_release_employee_name_required", 120),
    ...(avatarMode ? { avatarMode } : {}),
    ...(avatarSeed ? { avatarSeed } : {}),
    ...(avatarDataUrl ? { avatarDataUrl } : {}),
    role: boundedString(input.role, "app_store_release_employee_role_invalid", 40_000),
    kernel: boundedRequiredString(input.kernel, "app_store_release_kernel_required", 120),
    model: boundedRequiredString(input.model, "app_store_release_model_required", 240),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(input.contextTokenBudget !== undefined ? { contextTokenBudget } : {}),
    ...(accessMode ? { accessMode } : {}),
    color: boundedRequiredString(input.color, "app_store_release_color_required", 64),
    availableSkillIds: stringArray(input.availableSkillIds),
    defaultSkillIds: stringArray(input.defaultSkillIds),
    requiredKernelCapabilities: normalizeRequiredKernelCapabilities(input.requiredKernelCapabilities),
    visibility: input.visibility === "public" ? "public" : "private",
    ...(publicDescription ? { publicDescription } : {}),
    publicSkills: stringArray(input.publicSkills),
    ...(inputSpec ? { inputSpec } : {}),
    ...(outputSpec ? { outputSpec } : {}),
  };
}

// ===== Release manifest projection =====

export function mountedAppReleaseManifest(source: JsonObject, release: MountedAppReleaseDraft): OpenGroveAppManifest {
  const manifest = structuredClone(source) as OpenGroveAppManifest;
  manifest.title = release.app.title;
  manifest.description = release.app.description;
  manifest.version = release.version;
  if (release.app.icon) (manifest as Record<string, unknown>).icon = release.app.icon;
  else delete (manifest as Record<string, unknown>).icon;
  manifest.store = {
    ...manifest.store,
    ...(release.identity.packageKey ? { packageKey: release.identity.packageKey } : {}),
    visibility: release.visibility,
    releaseNotes: release.releaseNotes,
    ...(release.minHostReleaseNumber && release.minHostReleaseNumber > 0
      ? { minHostReleaseNumber: release.minHostReleaseNumber }
      : {}),
    employeeDefaults: release.employees.map((employee) => ({ ...employee })),
  };
  return manifest;
}

// ===== Version and validation utilities =====

function latestRegistryPackage(
  packages: AppStorePackageRecord[],
  appId: string,
  packageKey: string | undefined,
): AppStorePackageRecord | undefined {
  return packages
    .filter((item) => Boolean(packageKey && item.packageKey === packageKey && item.appId === appId))
    .sort((left, right) => compareVersions(right.version, left.version))[0];
}

export function compareVersions(left: string, right: string): number {
  const leftParts = semanticVersion(left);
  const rightParts = semanticVersion(right);
  if (!leftParts || !rightParts) return left.localeCompare(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function incrementPatch(version: string): string {
  const parts = semanticVersion(version);
  return parts ? `${parts[0]}.${parts[1]}.${parts[2] + 1}` : "0.1.0";
}

function semanticVersion(value: string): [number, number, number] | undefined {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function manifestIcon(manifest: JsonObject): string | undefined {
  return stringValue(manifest.icon) || stringValue(record(manifest.ui).icon) || undefined;
}

function localAppSkillName(skillId: string, appId: string): string | undefined {
  const prefix = `app:${appId}/`;
  return skillId.startsWith(prefix) ? skillId.slice(prefix.length) : undefined;
}

function reportIssues(report: Record<string, unknown>): string {
  const validation = record(report.validation);
  const issues = Array.isArray(validation.issues) ? validation.issues.map(stringValue).filter(Boolean) : [];
  return issues.join("; ") || "app_manifest_or_ui_invalid";
}

function boundedRequiredString(value: unknown, error: string, maxLength: number): string {
  const text = stringValue(value);
  if (!text || text.length > maxLength) throw new AppReleaseValidationError(error, [], 400);
  return text;
}

function boundedString(value: unknown, error: string, maxLength: number): string {
  const text = stringValue(value);
  if (text.length > maxLength) throw new AppReleaseValidationError(error, [], 400);
  return text;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value.map(stringValue).filter(Boolean)) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
