import type { OpenGroveAppManifest } from "../app-builder/manifest.js";
import { normalizeAppIconValue } from "../app-icons/icon-value.js";
import { join } from "node:path";
import {
  AppReleaseValidationError,
  compareVersions,
  mountedAppEffectiveEmployeeDefaults,
  normalizeReleaseEmployee,
  type AppReleaseEmployeeDefaults,
  type MountedAppReleaseDraft,
} from "./app-release.js";
import { appCandidateContentDigest } from "./app-content-digest.js";
import { appStoreDataRoot, packAppStoreArchive, readAppStorePackageInstallMarker } from "./app-store.js";
import { mountedAppWorkingDigest } from "./app-version-manager.js";
import {
  MountedAppVersionStateStore,
  selectedFormalVersionFromMarker,
  type SelectedFormalAppVersion,
} from "./app-version-state.js";
import type { BridgeState } from "./bridge-types.js";
import { LocalAppDraftStore, type LocalAppDraftPublishBase, type LocalAppDraftSummary } from "./local-app-drafts.js";
import type { MountedAppTarget } from "./mounted-apps.js";

export function localAppDraftStore(state: BridgeState): LocalAppDraftStore {
  return new LocalAppDraftStore(join(appStoreDataRoot(state), "local-drafts"));
}

export function saveMountedAppDraft(input: {
  state: BridgeState;
  target: MountedAppTarget;
  submission?: unknown;
  store?: LocalAppDraftStore;
  packArchive?: typeof packAppStoreArchive;
  expectedWorkingContentDigest?: string;
  publishBase?: LocalAppDraftPublishBase;
  expectedPrevious?: LocalAppDraftSummary;
  appRootOverride?: string;
}): LocalAppDraftSummary {
  const body = record(input.submission);
  const effectiveEmployees = mountedAppEffectiveEmployeeDefaults(input.state, input.target.id);
  const employees = localAppDraftEmployees(body.employees, effectiveEmployees);
  const workingContentDigest = mountedAppWorkingDigest(input.state, input.target);
  if (input.expectedWorkingContentDigest !== undefined && workingContentDigest !== input.expectedWorkingContentDigest) {
    throw new AppReleaseValidationError("local_app_draft_working_copy_changed", [], 409);
  }
  const sourceManifest = structuredClone(input.target.manifest) as OpenGroveAppManifest;
  applyLocalAppDraftIdentity(sourceManifest, body.app);
  sourceManifest.store = {
    ...sourceManifest.store,
    employeeDefaults: employees.map((employee) => ({ ...employee })),
  };
  const archive = (input.packArchive ?? packAppStoreArchive)({
    appRoot: input.appRootOverride ?? input.target.appRoot,
    manifestOverride: sourceManifest,
    allowSetup: true,
    purpose: "local-draft",
  });
  if (mountedAppWorkingDigest(input.state, input.target) !== workingContentDigest) {
    throw new AppReleaseValidationError("local_app_draft_working_copy_changed", [], 409);
  }
  const store = input.store ?? localAppDraftStore(input.state);
  const existingDraft = store.read(input.target.localAppId);
  const marker = readAppStorePackageInstallMarker(input.target.appRoot);
  const versionState = new MountedAppVersionStateStore(join(appStoreDataRoot(input.state), "version-state")).read(
    input.target.localAppId,
  );
  const selectedVersion = versionState?.selectedVersion ?? selectedFormalVersionFromMarker(marker);
  const publishedWithoutSwitch =
    versionState?.activeContent === "formal" &&
    existingDraft?.workingContentDigest === workingContentDigest &&
    Boolean(
      selectedVersion &&
        existingDraft.publishBase?.packageKey === selectedVersion.packageKey &&
        existingDraft.publishBase.version &&
        existingDraft.publishBase.releaseCommitSha &&
        existingDraft.publishBase.archiveSha256 &&
        compareVersions(existingDraft.publishBase.version, selectedVersion.version) > 0,
    );
  const activeLocalDraft =
    versionState?.activeContent === "local-draft" ||
    publishedWithoutSwitch ||
    (!versionState && stringValue(marker?.activeContent) === "local-draft") ||
    (!versionState && existingDraft?.workingContentDigest === workingContentDigest) ||
    (!versionState && existingDraft?.contentDigest === appCandidateContentDigest(archive.packageManifest)) ||
    (!versionState && !selectedVersion && Boolean(existingDraft));
  const publishBase =
    input.publishBase ??
    (activeLocalDraft
      ? existingDraft?.publishBase
      : selectedVersion
        ? localAppDraftPublishBaseFromSelectedVersion(selectedVersion)
        : (existingDraft?.publishBase ?? localAppDraftPublishBase(marker)));
  return store.save({
    localAppId: input.target.localAppId,
    appId: input.target.id,
    archive,
    employees,
    workingContentDigest,
    ...(publishBase ? { publishBase } : {}),
    ...(input.expectedPrevious ? { expectedPrevious: input.expectedPrevious } : {}),
  });
}

export function saveMountedAppDraftForRelease(input: {
  state: BridgeState;
  target: MountedAppTarget;
  release: MountedAppReleaseDraft;
  store?: LocalAppDraftStore;
  expectedWorkingContentDigest?: string;
  publishBase?: LocalAppDraftPublishBase;
  expectedPrevious?: LocalAppDraftSummary;
  appRootOverride?: string;
}): LocalAppDraftSummary {
  return saveMountedAppDraft({
    state: input.state,
    target: input.target,
    submission: {
      app: input.release.app,
      employees: input.release.employees,
    },
    ...(input.store ? { store: input.store } : {}),
    ...(input.expectedWorkingContentDigest !== undefined
      ? { expectedWorkingContentDigest: input.expectedWorkingContentDigest }
      : {}),
    ...(input.publishBase ? { publishBase: input.publishBase } : {}),
    ...(input.expectedPrevious ? { expectedPrevious: input.expectedPrevious } : {}),
    ...(input.appRootOverride ? { appRootOverride: input.appRootOverride } : {}),
  });
}

function localAppDraftEmployees(
  submitted: unknown,
  effective: AppReleaseEmployeeDefaults[],
): AppReleaseEmployeeDefaults[] {
  if (submitted === undefined) return effective;
  const inputs = Array.isArray(submitted) ? submitted.map(record) : [];
  const normalized = inputs.map(normalizeReleaseEmployee);
  const expectedIds = effective.map((employee) => employee.memberId);
  const submittedIds = normalized.map((employee) => employee.memberId);
  if (
    normalized.length !== expectedIds.length ||
    new Set(submittedIds).size !== expectedIds.length ||
    expectedIds.some((memberId) => !submittedIds.includes(memberId))
  ) {
    throw new AppReleaseValidationError("app_store_release_employee_set_changed", [], 409);
  }
  return expectedIds.map((memberId) => normalized.find((employee) => employee.memberId === memberId)!);
}

function applyLocalAppDraftIdentity(manifest: OpenGroveAppManifest, submitted: unknown): void {
  if (submitted === undefined) return;
  const app = record(submitted);
  if (Object.prototype.hasOwnProperty.call(app, "title")) {
    manifest.title = stringValue(app.title);
  }
  if (Object.prototype.hasOwnProperty.call(app, "description")) {
    manifest.description = stringValue(app.description);
  }
  if (Object.prototype.hasOwnProperty.call(app, "icon")) {
    const submittedIcon = stringValue(app.icon);
    const existingIcon = stringValue(manifest.icon) || stringValue(record(manifest.ui).icon);
    if (submittedIcon === existingIcon) return;
    const icon = submittedIcon ? normalizeAppIconValue(submittedIcon) : undefined;
    if (submittedIcon && !icon) {
      throw new AppReleaseValidationError("app_store_release_icon_invalid", [], 400);
    }
    if (icon) (manifest as Record<string, unknown>).icon = icon;
    else delete (manifest as Record<string, unknown>).icon;
  }
}

function localAppDraftPublishBase(marker: Record<string, unknown> | undefined): LocalAppDraftPublishBase | undefined {
  if (!marker || stringValue(marker.source) !== "registry") return undefined;
  const packageKey = stringValue(marker.packageKey);
  const version = stringValue(marker.version);
  const releaseCommitSha = stringValue(marker.releaseCommitSha);
  const archiveSha256 = stringValue(marker.archiveSha256);
  if (!packageKey && !version && !releaseCommitSha && !archiveSha256) return undefined;
  return {
    ...(packageKey ? { packageKey } : {}),
    ...(version ? { version } : {}),
    ...(releaseCommitSha ? { releaseCommitSha } : {}),
    ...(archiveSha256 ? { archiveSha256 } : {}),
  };
}

function localAppDraftPublishBaseFromSelectedVersion(
  selectedVersion: SelectedFormalAppVersion,
): LocalAppDraftPublishBase {
  return {
    packageKey: selectedVersion.packageKey,
    version: selectedVersion.version,
    ...(selectedVersion.releaseCommitSha ? { releaseCommitSha: selectedVersion.releaseCommitSha } : {}),
    archiveSha256: selectedVersion.archiveSha256,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
