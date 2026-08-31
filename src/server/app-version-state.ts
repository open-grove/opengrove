import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeAppStorePackageKey, normalizeArchiveSha256 } from "../app-store-package-identity.js";
import { writePrivateJsonAtomically } from "./private-file.js";
export { appCandidateContentDigest } from "./app-content-digest.js";

const APP_VERSION_STATE_SCHEMA_VERSION = 1;

export interface SelectedFormalAppVersion {
  packageKey: string;
  version: string;
  archiveSha256: string;
  releaseCommitSha?: string;
}

export interface MountedAppVersionState {
  schemaVersion: 1;
  localAppId: string;
  activeContent: "formal" | "local-draft";
  selectedVersion?: SelectedFormalAppVersion;
  activeContentDigest?: string;
  updatedAt: string;
}

export class MountedAppVersionStateStore {
  constructor(private readonly root: string) {}

  read(localAppId: string): MountedAppVersionState | undefined {
    const path = this.path(localAppId);
    if (!existsSync(path)) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("app_version_state_invalid");
    }
    if (!isMountedAppVersionState(value, localAppId)) {
      throw new Error("app_version_state_invalid");
    }
    return cloneState(value);
  }

  write(input: {
    localAppId: string;
    activeContent: MountedAppVersionState["activeContent"];
    selectedVersion?: SelectedFormalAppVersion;
    activeContentDigest?: string;
  }): MountedAppVersionState {
    const activeContentDigest = normalizeContentDigest(input.activeContentDigest);
    const state: MountedAppVersionState = {
      schemaVersion: APP_VERSION_STATE_SCHEMA_VERSION,
      localAppId: input.localAppId,
      activeContent: input.activeContent,
      ...(input.selectedVersion ? { selectedVersion: normalizeSelectedVersion(input.selectedVersion) } : {}),
      ...(activeContentDigest ? { activeContentDigest } : {}),
      updatedAt: new Date().toISOString(),
    };
    writePrivateJsonAtomically(this.path(input.localAppId), state);
    return cloneState(state);
  }

  restore(localAppId: string, previous: MountedAppVersionState | undefined): void {
    if (previous) {
      writePrivateJsonAtomically(this.path(localAppId), previous);
      return;
    }
    rmSync(this.path(localAppId), { force: true });
  }

  private path(localAppId: string): string {
    const key = createHash("sha256").update(localAppId, "utf8").digest("hex");
    return join(this.root, `${key}.json`);
  }
}

export function selectedFormalVersionFromMarker(
  marker: Record<string, unknown> | undefined,
): SelectedFormalAppVersion | undefined {
  if (stringValue(marker?.source) !== "registry") return undefined;
  const isLocalDraft = stringValue(marker?.activeContent) === "local-draft";
  if (isLocalDraft && !/^[a-f0-9]{64}$/.test(stringValue(marker?.draftContentDigest).toLowerCase())) {
    return undefined;
  }
  const selected = isLocalDraft ? record(marker?.selectedVersion) : (marker ?? {});
  const packageKey = normalizeAppStorePackageKey(selected.packageKey);
  const markerPackageKey = normalizeAppStorePackageKey(marker?.packageKey);
  const version = stringValue(selected.version);
  const archiveSha256 = normalizeArchiveSha256(selected.archiveSha256);
  const releaseCommitSha = stringValue(selected.releaseCommitSha);
  if (markerPackageKey && markerPackageKey !== packageKey) return undefined;
  if (!packageKey || !/^\d+\.\d+\.\d+$/.test(version) || !archiveSha256) return undefined;
  if (releaseCommitSha && !/^[a-f0-9]{40}$/.test(releaseCommitSha)) return undefined;
  return {
    packageKey,
    version,
    archiveSha256,
    ...(releaseCommitSha ? { releaseCommitSha } : {}),
  };
}

function normalizeSelectedVersion(value: SelectedFormalAppVersion): SelectedFormalAppVersion {
  const packageKey = normalizeAppStorePackageKey(value.packageKey);
  const archiveSha256 = normalizeArchiveSha256(value.archiveSha256);
  const version = stringValue(value.version);
  const releaseCommitSha = stringValue(value.releaseCommitSha);
  if (
    !packageKey ||
    !archiveSha256 ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    (releaseCommitSha && !/^[a-f0-9]{40}$/.test(releaseCommitSha))
  ) {
    throw new Error("app_version_state_invalid");
  }
  return {
    packageKey,
    version,
    archiveSha256,
    ...(releaseCommitSha ? { releaseCommitSha } : {}),
  };
}

function isMountedAppVersionState(value: unknown, localAppId: string): value is MountedAppVersionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<MountedAppVersionState>;
  if (
    state.schemaVersion !== APP_VERSION_STATE_SCHEMA_VERSION ||
    state.localAppId !== localAppId ||
    !new Set(["formal", "local-draft"]).has(String(state.activeContent)) ||
    typeof state.updatedAt !== "string"
  ) {
    return false;
  }
  try {
    if (state.selectedVersion) normalizeSelectedVersion(state.selectedVersion);
    normalizeContentDigest(state.activeContentDigest);
    return true;
  } catch {
    return false;
  }
}

function normalizeContentDigest(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const digest = stringValue(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("app_version_state_invalid");
  return digest;
}

function cloneState(state: MountedAppVersionState): MountedAppVersionState {
  return {
    ...state,
    ...(state.selectedVersion ? { selectedVersion: { ...state.selectedVersion } } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
