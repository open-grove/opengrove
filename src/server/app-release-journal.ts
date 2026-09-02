import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeReleaseEmployee,
  type AppReleaseEmployeeDefaults,
  type MountedAppReleaseDraft,
} from "./app-release.js";
import {
  MAX_APP_RELEASE_SOURCE_FILES,
  type AppReleaseSourceFile,
  type AppReleaseSourceSnapshot,
} from "./app-release-source-snapshot.js";
import { compareUtf8Bytes } from "./utf8-byte-order.js";
import { writePrivateFileAtomically, writePrivateJsonAtomically } from "../storage/private-file.js";
import { normalizeLocalAppReleasePublishBase, validLocalAppReleasePublishBase } from "./app-release-publish-base.js";
import type { LocalAppDraftPublishBase } from "./local-app-drafts.js";
import {
  isAppReleaseJournalRemoteStatus,
  isReleaseControlActions,
  isReleaseControlBuildFailure,
  isReleaseControlStatus,
  type AppReleaseJournalRemoteStatus,
  type ReleaseControlAction,
  type ReleaseControlBuildFailure,
  type ReleaseControlStatus,
} from "./app-release-status.js";
import { normalizeLegacyAppReleaseJournal } from "./app-release-journal.compat.js";

const APP_RELEASE_JOURNAL_SCHEMA_VERSION = 1;

// ===== Persisted journal contracts =====

export type AppReleaseJournalPhase =
  | "draft_saved"
  | "intent_created"
  | "source_snapshot_uploaded"
  | "remote_blocked"
  | "remote_conflict"
  | "remote_pending"
  | "remote_closed"
  | "registry_ready"
  | "local_preserved"
  | "local_finalized";

export type AppReleaseTerminalReason = "publish_base_stale" | "abandoned" | "local_changes_preserved";

export interface AppReleaseJournalRelease {
  app: MountedAppReleaseDraft["app"];
  version: string;
  releaseNotes: string;
  visibility: MountedAppReleaseDraft["visibility"];
  /** Missing only on terminal schema-v1 records written before the host gate was persisted. */
  minHostReleaseNumber?: number;
  employees: AppReleaseEmployeeDefaults[];
}

export interface AppReleaseRegistryIdentity {
  packageKey: string;
  version: string;
  releaseCommitSha: string;
  archiveSha256: string;
  archiveSize: number;
}

export interface AppReleaseBlockedRelease {
  id: string;
  status: ReleaseControlStatus;
  packageKey: string;
  version: string;
  sourceSha256: string;
  createdAt: string;
  allowedActions: ReleaseControlAction[];
  requestId?: string;
  matchesCurrentSource: boolean;
  matchesCurrentRequest: boolean;
  buildFailure?: ReleaseControlBuildFailure;
}

export interface AppReleaseJournalRecord {
  schemaVersion: 1;
  revision: number;
  localAppId: string;
  appId: string;
  /** Missing only on terminal schema-v1 records written before package identity was persisted. */
  packageId?: string;
  organization: string;
  packageKey: string;
  expectedMainSha: string | null;
  publishBase: LocalAppDraftPublishBase;
  draftDigest: string;
  sourceSnapshot: {
    sha256: string;
    size: number;
    files: AppReleaseSourceFile[];
    archiveFile: string;
  };
  release: AppReleaseJournalRelease;
  applyToCurrentApp: boolean;
  idempotencyKey: string;
  intentDigest: string;
  phase: AppReleaseJournalPhase;
  remoteIntentId?: string;
  remoteStatus?: AppReleaseJournalRemoteStatus;
  buildFailure?: ReleaseControlBuildFailure;
  /** Missing only on journals written before Release Control exposed action policy. */
  allowedActions?: ReleaseControlAction[];
  conflictRequestId?: string;
  blockedRelease?: AppReleaseBlockedRelease;
  registryVersion?: AppReleaseRegistryIdentity;
  terminalReason?: AppReleaseTerminalReason;
  createdAt: string;
  updatedAt: string;
}

// ===== Journal lifecycle =====

export class AppReleaseJournalStore {
  constructor(private readonly root: string) {}

  createOrResume(input: {
    localAppId: string;
    appId: string;
    packageId: string;
    organization: string;
    packageKey: string;
    expectedMainSha: string | null;
    publishBase?: LocalAppDraftPublishBase;
    draftDigest: string;
    sourceSnapshot: AppReleaseSourceSnapshot;
    release: MountedAppReleaseDraft;
    applyToCurrentApp: boolean;
  }): AppReleaseJournalRecord {
    const intent = canonicalJournalIntent(input);
    const intentDigest = sha256(Buffer.from(JSON.stringify(intent), "utf8"));
    const idempotencyKey = `og-app-release-${intentDigest}`;
    const existing = this.read(input.localAppId);
    if (existing && !terminalAppReleaseJournal(existing)) {
      if (existing.intentDigest !== intentDigest || existing.idempotencyKey !== idempotencyKey) {
        throw new Error("app_store_publish_intent_changed");
      }
      this.readSnapshot(existing);
      return cloneRecord(existing);
    }
    if (existing && existing.intentDigest === intentDigest && existing.idempotencyKey === idempotencyKey) {
      return cloneRecord(existing);
    }

    const journalRoot = this.journalRoot(input.localAppId);
    const snapshotsRoot = join(journalRoot, "snapshots");
    mkdirSync(snapshotsRoot, { recursive: true });
    const archiveFile = `snapshots/${input.sourceSnapshot.sha256}.tar.gz`;
    const archivePath = join(journalRoot, archiveFile);
    writeExactSnapshot(archivePath, input.sourceSnapshot.bytes, input.sourceSnapshot.sha256, input.sourceSnapshot.size);
    const now = new Date().toISOString();
    const record: AppReleaseJournalRecord = {
      schemaVersion: APP_RELEASE_JOURNAL_SCHEMA_VERSION,
      revision: 1,
      ...intent,
      sourceSnapshot: {
        sha256: input.sourceSnapshot.sha256,
        size: input.sourceSnapshot.size,
        files: input.sourceSnapshot.files.map((file) => ({ ...file })),
        archiveFile,
      },
      idempotencyKey,
      intentDigest,
      phase: "draft_saved",
      createdAt: now,
      updatedAt: now,
    };
    if (existing) this.archiveTerminalRecord(existing);
    writePrivateJsonAtomically(this.currentPath(input.localAppId), record);
    if (existing) {
      const previousSnapshot = join(journalRoot, existing.sourceSnapshot.archiveFile);
      if (previousSnapshot !== archivePath) rmSync(previousSnapshot, { force: true });
    }
    return cloneRecord(record);
  }

  read(localAppId: string): AppReleaseJournalRecord | undefined {
    const path = this.currentPath(localAppId);
    if (!existsSync(path)) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("app_store_publish_journal_corrupted");
    }
    value = normalizeLegacyAppReleaseJournal(value);
    if (!isJournalRecord(value, localAppId)) {
      throw new Error("app_store_publish_journal_corrupted");
    }
    return cloneRecord(value);
  }

  readSnapshot(record: AppReleaseJournalRecord): Buffer {
    const current = this.read(record.localAppId);
    if (
      !current ||
      current.intentDigest !== record.intentDigest ||
      current.sourceSnapshot.archiveFile !== record.sourceSnapshot.archiveFile
    ) {
      throw new Error("app_store_publish_journal_changed");
    }
    const path = join(this.journalRoot(record.localAppId), current.sourceSnapshot.archiveFile);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new Error("app_store_publish_snapshot_missing");
    }
    if (bytes.byteLength !== current.sourceSnapshot.size || sha256(bytes) !== current.sourceSnapshot.sha256) {
      throw new Error("app_store_publish_snapshot_corrupted");
    }
    return bytes;
  }

  recordRemote(input: {
    localAppId: string;
    expectedRevision: number;
    intentId: string;
    status: ReleaseControlStatus;
    phase: "intent_created" | "source_snapshot_uploaded" | "remote_pending";
    buildFailure?: ReleaseControlBuildFailure;
    allowedActions: ReleaseControlAction[];
  }): AppReleaseJournalRecord {
    return this.update(input.localAppId, input.expectedRevision, (record) => ({
      ...record,
      phase: input.phase,
      remoteIntentId: input.intentId,
      remoteStatus: input.status,
      buildFailure: input.buildFailure ? structuredClone(input.buildFailure) : undefined,
      allowedActions: [...input.allowedActions],
      blockedRelease: undefined,
    }));
  }

  recordBlocked(input: {
    localAppId: string;
    expectedRevision: number;
    conflict: AppReleaseBlockedRelease;
  }): AppReleaseJournalRecord {
    return this.update(input.localAppId, input.expectedRevision, (record) => ({
      ...record,
      phase: "remote_blocked",
      remoteIntentId: input.conflict.id,
      remoteStatus: input.conflict.status,
      buildFailure: input.conflict.buildFailure ? structuredClone(input.conflict.buildFailure) : undefined,
      allowedActions: [...input.conflict.allowedActions],
      blockedRelease: structuredClone(input.conflict),
    }));
  }

  recordOpaqueConflict(input: {
    localAppId: string;
    expectedRevision: number;
    requestId?: string;
  }): AppReleaseJournalRecord {
    return this.update(input.localAppId, input.expectedRevision, (record) => {
      const {
        remoteIntentId: _remoteIntentId,
        remoteStatus: _remoteStatus,
        buildFailure: _buildFailure,
        allowedActions: _allowedActions,
        conflictRequestId: _conflictRequestId,
        blockedRelease: _blockedRelease,
        ...rest
      } = record;
      const requestId = input.requestId && /^[a-f0-9]{32}$/.test(input.requestId) ? input.requestId : undefined;
      return {
        ...rest,
        phase: "remote_conflict",
        ...(requestId ? { conflictRequestId: requestId } : {}),
      };
    });
  }

  clearBlocked(input: { localAppId: string; expectedRevision: number }): AppReleaseJournalRecord {
    return this.update(input.localAppId, input.expectedRevision, (record) => {
      if (record.phase !== "remote_blocked") {
        throw new Error("app_store_publish_blocked_release_invalid");
      }
      const {
        remoteIntentId: _remoteIntentId,
        remoteStatus: _remoteStatus,
        buildFailure: _buildFailure,
        allowedActions: _allowedActions,
        blockedRelease: _blockedRelease,
        ...rest
      } = record;
      return { ...rest, phase: "draft_saved" };
    });
  }

  clearOpaqueConflict(input: { localAppId: string; expectedRevision: number }): AppReleaseJournalRecord {
    return this.update(input.localAppId, input.expectedRevision, (record) => {
      if (record.phase !== "remote_conflict") {
        throw new Error("app_store_publish_opaque_conflict_invalid");
      }
      const {
        remoteIntentId: _remoteIntentId,
        remoteStatus: _remoteStatus,
        buildFailure: _buildFailure,
        allowedActions: _allowedActions,
        conflictRequestId: _conflictRequestId,
        blockedRelease: _blockedRelease,
        ...rest
      } = record;
      return { ...rest, phase: "draft_saved" };
    });
  }

  markRegistryReady(input: {
    localAppId: string;
    expectedRevision: number;
    intentId: string;
    status: ReleaseControlStatus;
    registryVersion: AppReleaseRegistryIdentity;
  }): AppReleaseJournalRecord {
    return this.update(input.localAppId, input.expectedRevision, (record) => ({
      ...record,
      phase: "registry_ready",
      remoteIntentId: input.intentId,
      remoteStatus: input.status,
      buildFailure: undefined,
      allowedActions: [],
      blockedRelease: undefined,
      registryVersion: { ...input.registryVersion },
    }));
  }

  markRemoteClosed(input: {
    localAppId: string;
    expectedRevision: number;
    intentId: string;
    reason: Extract<AppReleaseTerminalReason, "publish_base_stale" | "abandoned">;
  }): AppReleaseJournalRecord {
    return this.update(input.localAppId, input.expectedRevision, (record) => ({
      ...record,
      phase: "remote_closed",
      remoteIntentId: input.intentId,
      remoteStatus: input.reason,
      buildFailure: undefined,
      allowedActions: [],
      blockedRelease: undefined,
      terminalReason: input.reason,
    }));
  }

  markLocalPreserved(input: { localAppId: string; expectedRevision: number }): AppReleaseJournalRecord {
    return this.update(input.localAppId, input.expectedRevision, (record) => {
      if (record.phase !== "registry_ready") {
        throw new Error("app_store_publish_local_resolution_invalid");
      }
      return {
        ...record,
        phase: "local_preserved",
        terminalReason: "local_changes_preserved",
      };
    });
  }

  markLocalFinalized(input: { localAppId: string; expectedRevision: number }): AppReleaseJournalRecord {
    const updated = this.update(input.localAppId, input.expectedRevision, (record) => ({
      ...record,
      phase: "local_finalized",
    }));
    rmSync(join(this.journalRoot(updated.localAppId), updated.sourceSnapshot.archiveFile), { force: true });
    return updated;
  }

  private update(
    localAppId: string,
    expectedRevision: number,
    apply: (record: AppReleaseJournalRecord) => AppReleaseJournalRecord,
  ): AppReleaseJournalRecord {
    const current = this.read(localAppId);
    if (!current) throw new Error("app_store_publish_journal_missing");
    if (current.revision !== expectedRevision) {
      throw new Error("app_store_publish_journal_changed");
    }
    const updated = apply(cloneRecord(current));
    updated.revision = current.revision + 1;
    updated.updatedAt = new Date().toISOString();
    if (!isJournalRecord(updated, localAppId)) {
      throw new Error("app_store_publish_journal_corrupted");
    }
    writePrivateJsonAtomically(this.currentPath(localAppId), updated);
    return cloneRecord(updated);
  }

  private currentPath(localAppId: string): string {
    return join(this.journalRoot(localAppId), "current.json");
  }

  private archiveTerminalRecord(record: AppReleaseJournalRecord): void {
    if (!terminalAppReleaseJournal(record)) {
      throw new Error("app_store_publish_journal_not_terminal");
    }
    const path = join(this.journalRoot(record.localAppId), "history", `${record.intentDigest}.json`);
    if (existsSync(path)) {
      let archived: unknown;
      try {
        archived = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        throw new Error("app_store_publish_history_corrupted");
      }
      if (JSON.stringify(archived) !== JSON.stringify(record)) {
        throw new Error("app_store_publish_history_conflict");
      }
      return;
    }
    writePrivateJsonAtomically(path, record);
  }

  private journalRoot(localAppId: string): string {
    return join(this.root, createHash("sha256").update(localAppId, "utf8").digest("hex"));
  }
}

// ===== Canonicalization and validation =====

function canonicalJournalIntent(input: {
  localAppId: string;
  appId: string;
  packageId: string;
  organization: string;
  packageKey: string;
  expectedMainSha: string | null;
  publishBase?: LocalAppDraftPublishBase;
  draftDigest: string;
  sourceSnapshot: AppReleaseSourceSnapshot;
  release: MountedAppReleaseDraft;
  applyToCurrentApp: boolean;
}): Omit<
  AppReleaseJournalRecord,
  | "schemaVersion"
  | "revision"
  | "sourceSnapshot"
  | "idempotencyKey"
  | "intentDigest"
  | "phase"
  | "remoteIntentId"
  | "remoteStatus"
  | "blockedRelease"
  | "registryVersion"
  | "terminalReason"
  | "createdAt"
  | "updatedAt"
> & {
  sourceSnapshot: Omit<AppReleaseJournalRecord["sourceSnapshot"], "archiveFile">;
} {
  const publishBase = normalizePublishBase(input.publishBase);
  const expectedMainSha = input.expectedMainSha?.trim().toLowerCase() || null;
  if (
    !safeIdentifier(input.localAppId) ||
    !safeIdentifier(input.appId) ||
    !safeIdentifier(input.packageId) ||
    !safeOrganization(input.organization) ||
    !safePackageKey(input.packageKey) ||
    !sha256Pattern(input.draftDigest) ||
    !sha256Pattern(input.sourceSnapshot.sha256) ||
    input.sourceSnapshot.size !== input.sourceSnapshot.bytes.byteLength ||
    sha256(input.sourceSnapshot.bytes) !== input.sourceSnapshot.sha256 ||
    (expectedMainSha !== null && !commitShaPattern(expectedMainSha))
  ) {
    throw new Error("app_store_publish_intent_invalid");
  }
  if (
    (expectedMainSha === null && publishBase.releaseCommitSha !== undefined) ||
    (expectedMainSha !== null && publishBase.releaseCommitSha !== expectedMainSha)
  ) {
    throw new Error("app_store_publish_base_invalid");
  }
  const release = canonicalRelease(input.release);
  return {
    localAppId: input.localAppId.trim(),
    appId: input.appId.trim(),
    packageId: input.packageId.trim(),
    organization: input.organization.trim(),
    packageKey: input.packageKey.trim(),
    expectedMainSha,
    publishBase,
    draftDigest: input.draftDigest.toLowerCase(),
    sourceSnapshot: {
      sha256: input.sourceSnapshot.sha256.toLowerCase(),
      size: input.sourceSnapshot.size,
      files: input.sourceSnapshot.files.map((file) => ({ ...file })),
    },
    release,
    applyToCurrentApp: input.applyToCurrentApp === true,
  };
}

function canonicalRelease(release: MountedAppReleaseDraft): AppReleaseJournalRelease {
  if (
    !/^\d+\.\d+\.\d+$/.test(release.version.trim()) ||
    (release.visibility !== "public" && release.visibility !== "restricted") ||
    (release.minHostReleaseNumber !== undefined &&
      (!Number.isSafeInteger(release.minHostReleaseNumber) || release.minHostReleaseNumber < 0)) ||
    !release.app.title.trim()
  ) {
    throw new Error("app_store_publish_intent_invalid");
  }
  const employees = release.employees.map((employee) =>
    normalizeReleaseEmployee(employee as unknown as Record<string, unknown>),
  );
  if (employees.length > 1_000 || new Set(employees.map((employee) => employee.memberId)).size !== employees.length) {
    throw new Error("app_store_publish_intent_invalid");
  }
  return {
    app: {
      title: release.app.title.trim(),
      description: release.app.description.trim(),
      ...(release.app.icon?.trim() ? { icon: release.app.icon.trim() } : {}),
    },
    version: release.version.trim(),
    releaseNotes: release.releaseNotes.trim(),
    visibility: release.visibility,
    minHostReleaseNumber: release.minHostReleaseNumber ?? 0,
    employees: employees.map((employee) => ({
      ...employee,
      availableSkillIds: [...employee.availableSkillIds],
      defaultSkillIds: [...employee.defaultSkillIds],
      publicSkills: [...employee.publicSkills],
    })),
  };
}

function normalizePublishBase(value?: LocalAppDraftPublishBase): LocalAppDraftPublishBase {
  return normalizeLocalAppReleasePublishBase(value) ?? {};
}

function isJournalRecord(value: unknown, localAppId: string): value is AppReleaseJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AppReleaseJournalRecord>;
  if (
    record.schemaVersion !== APP_RELEASE_JOURNAL_SCHEMA_VERSION ||
    record.localAppId !== localAppId ||
    !Number.isSafeInteger(record.revision) ||
    Number(record.revision) <= 0 ||
    !safeIdentifier(String(record.appId ?? "")) ||
    (record.packageId !== undefined && !safeIdentifier(String(record.packageId))) ||
    !safeOrganization(String(record.organization ?? "")) ||
    !safePackageKey(String(record.packageKey ?? "")) ||
    !sha256Pattern(String(record.draftDigest ?? "")) ||
    !sha256Pattern(String(record.intentDigest ?? "")) ||
    !/^og-app-release-[a-f0-9]{64}$/.test(String(record.idempotencyKey ?? "")) ||
    !new Set<AppReleaseJournalPhase>([
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
    ]).has(record.phase as AppReleaseJournalPhase) ||
    !validDateString(record.createdAt) ||
    !validDateString(record.updatedAt) ||
    typeof record.applyToCurrentApp !== "boolean"
  ) {
    return false;
  }
  if (record.packageId === undefined && !terminalAppReleaseJournal(record)) {
    return false;
  }
  const snapshot = record.sourceSnapshot;
  if (
    !snapshot ||
    !sha256Pattern(snapshot.sha256) ||
    !Number.isSafeInteger(snapshot.size) ||
    snapshot.size <= 0 ||
    !Array.isArray(snapshot.files) ||
    snapshot.files.length <= 0 ||
    snapshot.files.length > MAX_APP_RELEASE_SOURCE_FILES ||
    !/^snapshots\/[a-f0-9]{64}\.tar\.gz$/.test(snapshot.archiveFile) ||
    snapshot.archiveFile !== `snapshots/${snapshot.sha256}.tar.gz` ||
    !validSourceFiles(snapshot.files)
  ) {
    return false;
  }
  if (
    (record.expectedMainSha !== null && !commitShaPattern(String(record.expectedMainSha))) ||
    !validPublishBase(record.publishBase) ||
    (record.expectedMainSha === null
      ? record.publishBase?.releaseCommitSha !== undefined
      : record.publishBase?.releaseCommitSha !== record.expectedMainSha)
  ) {
    return false;
  }
  let release: AppReleaseJournalRelease;
  try {
    release = canonicalRelease({
      identity: {
        appId: String(record.appId),
        source: "mounted",
        appRoot: "/journal-validation",
        workspaceRoot: "/journal-validation/workspace",
      },
      app: record.release?.app ?? { title: "", description: "" },
      version: String(record.release?.version ?? ""),
      releaseNotes: String(record.release?.releaseNotes ?? ""),
      visibility: record.release?.visibility ?? "restricted",
      minHostReleaseNumber: record.release?.minHostReleaseNumber,
      employees: record.release?.employees ?? [],
      checks: [],
    });
  } catch {
    return false;
  }
  if (record.release?.minHostReleaseNumber === undefined && terminalAppReleaseJournal(record)) {
    delete release.minHostReleaseNumber;
  }
  if (JSON.stringify(release) !== JSON.stringify(record.release)) return false;
  if (record.remoteIntentId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(record.remoteIntentId))
    return false;
  if (record.remoteStatus !== undefined && !isAppReleaseJournalRemoteStatus(record.remoteStatus)) return false;
  if (
    record.buildFailure !== undefined &&
    (record.remoteStatus !== "trusted_build_failed" || !isReleaseControlBuildFailure(record.buildFailure))
  )
    return false;
  if (record.allowedActions !== undefined && !isReleaseControlActions(record.allowedActions)) return false;
  if (
    record.conflictRequestId !== undefined &&
    (record.phase !== "remote_conflict" || !/^[a-f0-9]{32}$/.test(record.conflictRequestId))
  )
    return false;
  const hasBlockedRelease = record.phase === "remote_blocked";
  if (hasBlockedRelease !== Boolean(record.blockedRelease)) return false;
  if (record.blockedRelease && !validBlockedRelease(record.blockedRelease, record)) return false;
  const remotePhase = record.phase !== "draft_saved" && record.phase !== "remote_conflict";
  const hasRemoteIntentId = record.remoteIntentId !== undefined;
  const hasRemoteStatus = record.remoteStatus !== undefined;
  const hasRegistryVersion =
    record.phase === "registry_ready" || record.phase === "local_preserved" || record.phase === "local_finalized";
  const terminalReasonValid =
    record.phase === "remote_closed"
      ? (record.terminalReason === "publish_base_stale" || record.terminalReason === "abandoned") &&
        record.remoteStatus === record.terminalReason
      : record.phase === "local_preserved"
        ? record.terminalReason === "local_changes_preserved"
        : record.terminalReason === undefined;
  if (
    hasRemoteIntentId !== hasRemoteStatus ||
    remotePhase !== hasRemoteIntentId ||
    hasRegistryVersion !== Boolean(record.registryVersion) ||
    !terminalReasonValid ||
    (record.registryVersion && !validRegistryIdentity(record.registryVersion, record))
  ) {
    return false;
  }
  const digestInput = {
    localAppId: record.localAppId,
    appId: record.appId,
    ...(record.packageId === undefined ? {} : { packageId: record.packageId }),
    organization: record.organization,
    packageKey: record.packageKey,
    expectedMainSha: record.expectedMainSha,
    publishBase: record.publishBase,
    draftDigest: record.draftDigest,
    sourceSnapshot: {
      sha256: snapshot.sha256,
      size: snapshot.size,
      files: snapshot.files,
    },
    release: record.release,
    applyToCurrentApp: record.applyToCurrentApp,
  };
  const digest = sha256(Buffer.from(JSON.stringify(digestInput), "utf8"));
  return record.intentDigest === digest && record.idempotencyKey === `og-app-release-${digest}`;
}

export function terminalAppReleaseJournal(record: { phase?: AppReleaseJournalPhase }): boolean {
  return record.phase === "remote_closed" || record.phase === "local_preserved" || record.phase === "local_finalized";
}

function cloneRecord(record: AppReleaseJournalRecord): AppReleaseJournalRecord {
  return structuredClone(record);
}

// ===== Durable file writes =====

function writeExactSnapshot(path: string, bytes: Buffer, digest: string, size: number): void {
  if (bytes.byteLength !== size || sha256(bytes) !== digest) {
    throw new Error("app_store_publish_snapshot_invalid");
  }
  if (existsSync(path)) {
    if (statSync(path).size !== size || sha256(readFileSync(path)) !== digest) {
      throw new Error("app_store_publish_snapshot_conflict");
    }
    return;
  }
  writePrivateFileAtomically(path, bytes);
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.trim());
}

function safeOrganization(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.trim());
}

function safePackageKey(value: string): boolean {
  const normalized = value.trim();
  return normalized.length <= 160 && normalized.split(".").every((segment) => safeIdentifier(segment));
}

function validSourceFiles(files: AppReleaseSourceFile[]): boolean {
  let previousPath: string | undefined;
  for (const file of files) {
    if (
      typeof file.path !== "string" ||
      file.path.length <= 0 ||
      file.path.length > 1_024 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      !sha256Pattern(String(file.sha256)) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      (file.mode !== "100644" && file.mode !== "100755") ||
      (previousPath !== undefined && compareUtf8Bytes(previousPath, file.path) >= 0)
    ) {
      return false;
    }
    previousPath = file.path;
  }
  return files.some((file) => file.path === "opengrove.app.json");
}

function validPublishBase(value: LocalAppDraftPublishBase | undefined): boolean {
  return value !== undefined && validLocalAppReleasePublishBase(value);
}

function validRegistryIdentity(value: AppReleaseRegistryIdentity, record: Partial<AppReleaseJournalRecord>): boolean {
  return (
    value.packageKey === record.packageKey &&
    value.version === record.release?.version &&
    commitShaPattern(String(value.releaseCommitSha)) &&
    sha256Pattern(String(value.archiveSha256)) &&
    Number.isSafeInteger(value.archiveSize) &&
    value.archiveSize > 0
  );
}

function validBlockedRelease(value: AppReleaseBlockedRelease, record: Partial<AppReleaseJournalRecord>): boolean {
  const matchesCurrentSource =
    value.version === record.release?.version && value.sourceSha256 === record.sourceSnapshot?.sha256;
  return (
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.id) &&
    isReleaseControlStatus(value.status) &&
    safePackageKey(value.packageKey) &&
    value.packageKey === record.packageKey &&
    /^\d+\.\d+\.\d+$/.test(value.version) &&
    sha256Pattern(value.sourceSha256) &&
    validDateString(value.createdAt) &&
    isReleaseControlActions(value.allowedActions) &&
    value.allowedActions.every((action) => action === "abandon" || value.matchesCurrentRequest) &&
    (value.requestId === undefined || /^[a-f0-9]{32}$/.test(value.requestId)) &&
    value.matchesCurrentSource === matchesCurrentSource &&
    typeof value.matchesCurrentRequest === "boolean" &&
    (!value.matchesCurrentRequest || matchesCurrentSource) &&
    value.id === record.remoteIntentId &&
    value.status === record.remoteStatus &&
    isDeepStrictEqual(value.allowedActions, record.allowedActions) &&
    (value.buildFailure === undefined
      ? record.buildFailure === undefined
      : isReleaseControlBuildFailure(value.buildFailure) && isDeepStrictEqual(value.buildFailure, record.buildFailure))
  );
}

function validDateString(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function commitShaPattern(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

function sha256Pattern(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
