import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateAppStoreEmployeeDefaults } from "../app-builder/manifest.js";
import { appCandidateContentDigest } from "./app-content-digest.js";
import { extractAppStoreAppArchive } from "./app-store.js";
import type { LocalAppDraftRecord } from "./local-app-drafts.js";

type PreContentIdentityDraftRecord = Omit<LocalAppDraftRecord, "appId" | "contentDigest" | "workingContentDigest"> & {
  appId?: string;
  contentDigest?: string;
  workingContentDigest?: string;
};

interface LocalAppDraftRecordCompatibilityInput {
  localAppId: string;
  draftRoot: string;
  verifyArchivePath(record: Pick<LocalAppDraftRecord, "archiveFile" | "archiveSize" | "archiveSha256">): string;
  readPackageManifest(appRoot: string): Record<string, unknown>;
  assertPackageTree(appRoot: string, packageManifest: Record<string, unknown>): void;
  writeRecord(path: string, bytes: Buffer): void;
}

/**
 * Issue: https://github.com/open-grove/opengrove/issues/555
 * Supports: draft records written by Host 0.6.1 and earlier.
 * Remove when: the minimum supported source Host version is 0.6.2.
 */
export function readCompatibleLocalAppDraftRecord(
  input: LocalAppDraftRecordCompatibilityInput,
): LocalAppDraftRecord | undefined {
  const path = join(input.draftRoot, "current.json");
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("local_app_draft_record_invalid");
  }
  if (!isPreContentIdentityRecord(value, input.localAppId)) {
    throw new Error("local_app_draft_record_invalid");
  }
  if (value.appId && value.contentDigest && value.workingContentDigest) {
    return value as LocalAppDraftRecord;
  }

  const archivePath = input.verifyArchivePath(value as LocalAppDraftRecord);
  const migrationRoot = mkdtempSync(join(input.draftRoot, ".record-migration-"));
  const extractedRoot = join(migrationRoot, "app");
  try {
    extractAppStoreAppArchive({ archivePath, targetRoot: extractedRoot });
    const packageManifest = input.readPackageManifest(extractedRoot);
    input.assertPackageTree(extractedRoot, packageManifest);
    const appId = stringValue(packageManifest.appId);
    if (!appId || (value.appId && value.appId !== appId)) {
      throw new Error("local_app_draft_identity_mismatch");
    }
    const contentDigest = appCandidateContentDigest(packageManifest);
    if (value.contentDigest && value.contentDigest !== contentDigest) {
      throw new Error("local_app_draft_content_identity_mismatch");
    }
    const migrated: LocalAppDraftRecord = {
      ...value,
      appId,
      contentDigest,
      workingContentDigest: value.workingContentDigest ?? contentDigest,
    };
    input.writeRecord(path, Buffer.from(`${JSON.stringify(migrated, null, 2)}\n`, "utf8"));
    return migrated;
  } finally {
    rmSync(migrationRoot, { recursive: true, force: true });
  }
}

function isPreContentIdentityRecord(value: unknown, localAppId: string): value is PreContentIdentityDraftRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<PreContentIdentityDraftRecord>;
  return (
    record.schemaVersion === 1 &&
    record.localAppId === localAppId &&
    (record.appId === undefined || (typeof record.appId === "string" && Boolean(record.appId.trim()))) &&
    (record.contentDigest === undefined || /^[a-f0-9]{64}$/.test(record.contentDigest)) &&
    (record.workingContentDigest === undefined || /^[a-f0-9]{64}$/.test(record.workingContentDigest)) &&
    (record.savePoint === undefined ||
      (typeof record.savePoint === "object" &&
        record.savePoint !== null &&
        /^[a-f0-9]{40}$/.test(record.savePoint.commitSha) &&
        validCanonicalDate(record.savePoint.savedAt))) &&
    typeof record.savedAt === "string" &&
    typeof record.archiveFile === "string" &&
    /^archives\/[a-f0-9]{64}\.tgz$/.test(record.archiveFile) &&
    /^[a-f0-9]{64}$/.test(record.archiveSha256 ?? "") &&
    Number.isSafeInteger(record.archiveSize) &&
    (record.archiveSize ?? -1) >= 0 &&
    Array.isArray(record.employees) &&
    validateAppStoreEmployeeDefaults(record.employees).length === 0
  );
}

function validCanonicalDate(value: unknown): boolean {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
