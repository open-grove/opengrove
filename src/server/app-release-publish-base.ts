import { normalizeAppStorePackageKey } from "../app-store-package-identity.js";

const versionPattern = /^\d+\.\d+\.\d+$/;
const commitPattern = /^[a-f0-9]{40}$/;
const archivePattern = /^[a-f0-9]{64}$/;

export interface LocalAppReleasePublishBase {
  packageKey: string;
  version: string;
  releaseCommitSha?: string;
  archiveSha256: string;
}

export type PublicAppReleasePublishBase = Omit<LocalAppReleasePublishBase, "packageKey">;

export function normalizeLocalAppReleasePublishBase(value: unknown): LocalAppReleasePublishBase | undefined {
  if (value === undefined) return undefined;
  const input = strictRecord(value);
  if (!Object.keys(input).length) return undefined;
  const releaseCommitSha = optionalString(input.releaseCommitSha).toLowerCase();
  const expectedKeys = releaseCommitSha
    ? ["archiveSha256", "packageKey", "releaseCommitSha", "version"]
    : ["archiveSha256", "packageKey", "version"];
  if (!hasExactKeys(input, expectedKeys)) throw new Error("app_store_publish_base_invalid");
  const packageKey = normalizeAppStorePackageKey(input.packageKey);
  const version = requiredString(input.version);
  const archiveSha256 = requiredString(input.archiveSha256).toLowerCase();
  if (
    !packageKey ||
    !versionPattern.test(version) ||
    !archivePattern.test(archiveSha256) ||
    (releaseCommitSha && !commitPattern.test(releaseCommitSha))
  ) {
    throw new Error("app_store_publish_base_invalid");
  }
  return {
    packageKey,
    version,
    ...(releaseCommitSha ? { releaseCommitSha } : {}),
    archiveSha256,
  };
}

export function normalizePublicAppReleasePublishBase(value: unknown): PublicAppReleasePublishBase | undefined {
  if (value === undefined) return undefined;
  const input = strictRecord(value);
  if (!Object.keys(input).length) return undefined;
  const releaseCommitSha = optionalString(input.releaseCommitSha).toLowerCase();
  const expectedKeys = releaseCommitSha
    ? ["archiveSha256", "releaseCommitSha", "version"]
    : ["archiveSha256", "version"];
  if (!hasExactKeys(input, expectedKeys)) throw new Error("app_store_publish_base_invalid");
  const version = requiredString(input.version);
  const archiveSha256 = requiredString(input.archiveSha256).toLowerCase();
  if (
    !versionPattern.test(version) ||
    !archivePattern.test(archiveSha256) ||
    (releaseCommitSha && !commitPattern.test(releaseCommitSha))
  ) {
    throw new Error("app_store_publish_base_invalid");
  }
  return {
    version,
    ...(releaseCommitSha ? { releaseCommitSha } : {}),
    archiveSha256,
  };
}

export function publicAppReleasePublishBase(value: unknown): PublicAppReleasePublishBase | Record<string, never> {
  const local = normalizeLocalAppReleasePublishBase(value);
  if (!local) return {};
  return {
    version: local.version,
    ...(local.releaseCommitSha ? { releaseCommitSha: local.releaseCommitSha } : {}),
    archiveSha256: local.archiveSha256,
  };
}

export function validLocalAppReleasePublishBase(value: unknown): boolean {
  try {
    normalizeLocalAppReleasePublishBase(value);
    return true;
  } catch {
    return false;
  }
}

export function validPublicAppReleasePublishBase(value: unknown): boolean {
  try {
    normalizePublicAppReleasePublishBase(value);
    return true;
  } catch {
    return false;
  }
}

function strictRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("app_store_publish_base_invalid");
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("app_store_publish_base_invalid");
  }
  return value.trim();
}

function optionalString(value: unknown): string {
  if (value === undefined) return "";
  return requiredString(value);
}
