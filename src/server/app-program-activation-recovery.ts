import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { normalizeLegacyAppProgramActivationRecoveryRecord } from "./app-program-activation-recovery.compat.js";
import { isAppStoreAppDirectoryName } from "./app-store-app-id.js";
import { writePrivateFileAtomically } from "../storage/private-file.js";

const ACTIVATION_RECOVERY_SCHEMA_VERSION = 2;
const ACTIVATION_RECOVERY_FILE = ".opengrove-activation-recovery.json";

export type AppProgramActivationKind = "formal" | "local-draft";

interface AppProgramActivationRecoveryRecord {
  schemaVersion: 2;
  phase: "activating" | "committed";
  kind: AppProgramActivationKind;
  appRoot: string;
  transactionRoot: string;
  stagedAppRoot: string;
  previousAppRoot: string;
  previousWorkspaceRelativePath: string;
  nextWorkspaceRelativePath: string;
  previousWorkspacePresent: boolean;
  previousGitPresent: boolean;
}

export interface AppProgramActivationRecovery {
  backupContainer: string;
  previousAppRoot: string;
}

/**
 * Store program generations can already have a relatively deep, versioned path.
 * Keep their draft transactions in the Store staging area so Windows does not
 * exceed MAX_PATH while preserving same-volume atomic renames. Legacy and
 * external mounts continue to use the adjacent transaction directory.
 */
export function appProgramActivationTransactionParent(kind: AppProgramActivationKind, appRoot: string): string {
  const storeRoot = kind === "local-draft" ? sideBySideStoreRoot(appRoot) : undefined;
  return storeRoot
    ? join(storeRoot, "staging", "draft-transactions")
    : join(dirname(resolve(appRoot)), transactionDirectoryName(kind));
}

export function beginAppProgramActivationRecovery(input: {
  kind: AppProgramActivationKind;
  appRoot: string;
  transactionRoot: string;
  stagedAppRoot: string;
  previousWorkspaceRelativePath: string;
  nextWorkspaceRelativePath: string;
  previousWorkspacePresent: boolean;
  previousGitPresent: boolean;
}): AppProgramActivationRecovery {
  const appRoot = resolve(input.appRoot);
  const backupParent = appProgramActivationBackupParent(input.kind, appRoot);
  mkdirSync(backupParent, { recursive: true });
  const backupContainer = mkdtempSync(join(backupParent, `${shortActivationPathKey(appRoot)}-`));
  const previousAppRoot = join(backupContainer, "previous-app");
  const record: AppProgramActivationRecoveryRecord = {
    schemaVersion: ACTIVATION_RECOVERY_SCHEMA_VERSION,
    phase: "activating",
    kind: input.kind,
    appRoot,
    transactionRoot: resolve(input.transactionRoot),
    stagedAppRoot: resolve(input.stagedAppRoot),
    previousAppRoot,
    previousWorkspaceRelativePath: input.previousWorkspaceRelativePath,
    nextWorkspaceRelativePath: input.nextWorkspaceRelativePath,
    previousWorkspacePresent: input.previousWorkspacePresent,
    previousGitPresent: input.previousGitPresent,
  };
  assertRecoveryRecordPaths(record, backupContainer);
  atomicWriteJson(join(backupContainer, ACTIVATION_RECOVERY_FILE), record);
  return { backupContainer, previousAppRoot };
}

export function commitAppProgramActivationRecovery(appRoot: string): boolean {
  const resolvedAppRoot = resolve(appRoot);
  const candidates = activationRecoveryCandidates(resolvedAppRoot);
  if (!candidates.length) return false;
  if (candidates.length !== 1) throw new Error("app_program_activation_recovery_ambiguous");
  const backupContainer = candidates[0]!;
  const record = readRecoveryRecord(backupContainer);
  if (record.appRoot !== resolvedAppRoot) {
    throw new Error("app_program_activation_recovery_path_invalid");
  }
  const appEntry = pathEntry(record.appRoot);
  const previousEntry = pathEntry(record.previousAppRoot);
  if (
    !appEntry?.isDirectory() ||
    appEntry.isSymbolicLink() ||
    !previousEntry?.isDirectory() ||
    previousEntry.isSymbolicLink()
  ) {
    throw new Error("app_program_activation_recovery_commit_invalid");
  }
  if (record.phase !== "committed") {
    atomicWriteJson(join(backupContainer, ACTIVATION_RECOVERY_FILE), {
      ...record,
      phase: "committed",
    } satisfies AppProgramActivationRecoveryRecord);
  }
  return true;
}

export function recoverInterruptedAppProgramActivations(appRoots: string[]): {
  recovered: string[];
  failed: Array<{ appRoot: string; error: string }>;
} {
  const recovered: string[] = [];
  const failed: Array<{ appRoot: string; error: string }> = [];
  for (const candidate of new Set(appRoots.map((appRoot) => resolve(appRoot)))) {
    try {
      if (recoverInterruptedActivationForApp(candidate)) recovered.push(candidate);
    } catch (error) {
      failed.push({
        appRoot: candidate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { recovered, failed };
}

export function finalizeInterruptedAppProgramActivation(appRoot: string): boolean {
  const resolvedAppRoot = resolve(appRoot);
  if (!commitAppProgramActivationRecovery(resolvedAppRoot)) return false;
  return finalizeCommittedAppProgramActivation(resolvedAppRoot);
}

export function finalizeCommittedAppProgramActivation(appRoot: string): boolean {
  const resolvedAppRoot = resolve(appRoot);
  const candidates = activationRecoveryCandidates(resolvedAppRoot);
  if (!candidates.length) return false;
  if (candidates.length !== 1) throw new Error("app_program_activation_recovery_ambiguous");
  const backupContainer = candidates[0]!;
  const record = readRecoveryRecord(backupContainer);
  if (record.phase !== "committed") {
    throw new Error("app_program_activation_recovery_not_committed");
  }
  removeRecoveredActivation(record, backupContainer);
  return true;
}

function recoverInterruptedActivationForApp(appRoot: string): boolean {
  const candidates = activationRecoveryCandidates(appRoot);
  if (!candidates.length) return false;
  if (candidates.length !== 1) throw new Error("app_program_activation_recovery_ambiguous");
  recoverActivation(candidates[0]!, appRoot);
  return true;
}

function activationRecoveryCandidates(appRoot: string): string[] {
  return (["formal", "local-draft"] as const).flatMap((kind) => {
    const prefixes = [`${shortActivationPathKey(appRoot)}-`, `${activationPathKey(appRoot)}-`];
    return activationRecoveryBackupParents(kind, appRoot).flatMap((backupParent) => {
      if (!existsSync(backupParent)) return [];
      return readdirSync(backupParent, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() && !entry.isSymbolicLink() && prefixes.some((prefix) => entry.name.startsWith(prefix)),
        )
        .map((entry) => join(backupParent, entry.name))
        .filter((backupContainer) => existsSync(join(backupContainer, ACTIVATION_RECOVERY_FILE)));
    });
  });
}

function recoverActivation(backupContainer: string, expectedAppRoot: string): void {
  const record = readRecoveryRecord(backupContainer);
  if (record.appRoot !== expectedAppRoot) {
    throw new Error("app_program_activation_recovery_path_invalid");
  }
  if (record.phase === "committed") {
    const appEntry = pathEntry(record.appRoot);
    if (!appEntry?.isDirectory() || appEntry.isSymbolicLink()) {
      throw new Error("app_program_activation_recovery_commit_invalid");
    }
    removeRecoveredActivation(record, backupContainer);
    return;
  }
  const previousEntry = pathEntry(record.previousAppRoot);
  const appEntry = pathEntry(record.appRoot);
  if (!previousEntry) {
    if (!appEntry?.isDirectory() || appEntry.isSymbolicLink()) {
      throw new Error("app_program_activation_recovery_target_missing");
    }
    removeRecoveredActivation(record, backupContainer);
    return;
  }
  if (!previousEntry.isDirectory() || previousEntry.isSymbolicLink()) {
    throw new Error("app_program_activation_recovery_previous_invalid");
  }

  const interruptedAppRoot = join(backupContainer, "interrupted-app");
  const interruptedEntry = pathEntry(interruptedAppRoot);
  if (interruptedEntry && (!interruptedEntry.isDirectory() || interruptedEntry.isSymbolicLink())) {
    throw new Error("app_program_activation_recovery_target_changed");
  }
  let recoverySource = interruptedEntry
    ? interruptedAppRoot
    : pathEntry(record.stagedAppRoot)?.isDirectory()
      ? record.stagedAppRoot
      : undefined;
  if (appEntry) {
    if (interruptedEntry) {
      throw new Error("app_program_activation_recovery_target_changed");
    }
    if (!appEntry.isDirectory() || appEntry.isSymbolicLink()) {
      throw new Error("app_program_activation_recovery_target_invalid");
    }
    renameSync(record.appRoot, interruptedAppRoot);
    recoverySource = interruptedAppRoot;
  }

  restorePreservedEntry({
    wasPresent: record.previousWorkspacePresent,
    sourcePath: recoverySource ? resolve(recoverySource, record.nextWorkspaceRelativePath) : undefined,
    targetPath: resolve(record.previousAppRoot, record.previousWorkspaceRelativePath),
    errorCode: "app_program_activation_recovery_workspace_missing",
  });
  restorePreservedEntry({
    wasPresent: record.previousGitPresent,
    sourcePath: recoverySource ? join(recoverySource, ".git") : undefined,
    targetPath: join(record.previousAppRoot, ".git"),
    errorCode: "app_program_activation_recovery_git_missing",
  });
  if (pathEntry(record.appRoot)) {
    throw new Error("app_program_activation_recovery_target_changed");
  }
  renameSync(record.previousAppRoot, record.appRoot);
  removeRecoveredActivation(record, backupContainer);
}

function restorePreservedEntry(input: {
  wasPresent: boolean;
  sourcePath?: string;
  targetPath: string;
  errorCode: string;
}): void {
  if (!input.wasPresent) return;
  const targetEntry = pathEntry(input.targetPath);
  if (targetEntry) return;
  if (!input.sourcePath) throw new Error(input.errorCode);
  const sourceEntry = pathEntry(input.sourcePath);
  if (!sourceEntry || sourceEntry.isSymbolicLink()) throw new Error(input.errorCode);
  mkdirSync(dirname(input.targetPath), { recursive: true });
  renameSync(input.sourcePath, input.targetPath);
}

function removeRecoveredActivation(record: AppProgramActivationRecoveryRecord, backupContainer: string): void {
  rmSync(backupContainer, { recursive: true, force: true });
  rmSync(record.transactionRoot, { recursive: true, force: true });
  const lockPath = join(dirname(record.appRoot), ".opengrove-install-locks", activationPathKey(record.appRoot));
  try {
    rmdirSync(lockPath);
  } catch {
    // non-critical-fallback: Preserve a non-empty or replaced lock rather than deleting another transaction's data.
  }
}

function readRecoveryRecord(backupContainer: string): AppProgramActivationRecoveryRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(backupContainer, ACTIVATION_RECOVERY_FILE), "utf8"));
  } catch {
    throw new Error("app_program_activation_recovery_corrupted");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("app_program_activation_recovery_corrupted");
  }
  const compatibleValue = normalizeLegacyAppProgramActivationRecoveryRecord(value as Record<string, unknown>);
  const record = compatibleValue as Partial<Omit<AppProgramActivationRecoveryRecord, "schemaVersion">> & {
    schemaVersion?: number;
  };
  if (
    record.schemaVersion !== ACTIVATION_RECOVERY_SCHEMA_VERSION ||
    (record.phase !== "activating" && record.phase !== "committed") ||
    (record.kind !== "formal" && record.kind !== "local-draft") ||
    typeof record.appRoot !== "string" ||
    typeof record.transactionRoot !== "string" ||
    typeof record.stagedAppRoot !== "string" ||
    typeof record.previousAppRoot !== "string" ||
    typeof record.previousWorkspaceRelativePath !== "string" ||
    typeof record.nextWorkspaceRelativePath !== "string" ||
    typeof record.previousWorkspacePresent !== "boolean" ||
    typeof record.previousGitPresent !== "boolean"
  ) {
    throw new Error("app_program_activation_recovery_corrupted");
  }
  const normalized = {
    ...record,
    schemaVersion: ACTIVATION_RECOVERY_SCHEMA_VERSION,
  } as AppProgramActivationRecoveryRecord;
  assertRecoveryRecordPaths(normalized, backupContainer);
  return normalized;
}

function assertRecoveryRecordPaths(record: AppProgramActivationRecoveryRecord, backupContainer: string): void {
  const appRoot = resolve(record.appRoot);
  const resolvedBackupContainer = resolve(backupContainer);
  const transactionRoot = resolve(record.transactionRoot);
  const stagedAppRoot = resolve(record.stagedAppRoot);
  if (
    !activationRecoveryBackupParents(record.kind, appRoot).includes(dirname(resolvedBackupContainer)) ||
    !activationRecoveryTransactionParents(record.kind, appRoot).includes(dirname(transactionRoot)) ||
    stagedAppRoot !== join(transactionRoot, "next-app") ||
    resolve(record.previousAppRoot) !== join(resolvedBackupContainer, "previous-app") ||
    !safeRelativePath(record.previousWorkspaceRelativePath) ||
    !safeRelativePath(record.nextWorkspaceRelativePath)
  ) {
    throw new Error("app_program_activation_recovery_path_invalid");
  }
}

function safeRelativePath(path: string): boolean {
  const normalized = relative(".", path);
  return Boolean(path) && !path.startsWith(sep) && normalized !== ".." && !normalized.startsWith(`..${sep}`);
}

function backupDirectoryName(kind: AppProgramActivationKind): string {
  return kind === "formal" ? ".opengrove-install-backups" : ".opengrove-draft-backups";
}

function transactionDirectoryName(kind: AppProgramActivationKind): string {
  return kind === "formal" ? ".opengrove-install-transactions" : ".opengrove-draft-transactions";
}

function activationPathKey(appRoot: string): string {
  return createHash("sha256").update(resolve(appRoot)).digest("hex");
}

function shortActivationPathKey(appRoot: string): string {
  return activationPathKey(appRoot).slice(0, 16);
}

export function appProgramActivationBackupParent(kind: AppProgramActivationKind, appRoot: string): string {
  const storeRoot = kind === "local-draft" ? sideBySideStoreRoot(appRoot) : undefined;
  return storeRoot
    ? join(storeRoot, "staging", "draft-backups")
    : join(dirname(resolve(appRoot)), backupDirectoryName(kind));
}

function activationRecoveryBackupParents(kind: AppProgramActivationKind, appRoot: string): string[] {
  return uniqueResolvedPaths([
    appProgramActivationBackupParent(kind, appRoot),
    join(dirname(resolve(appRoot)), backupDirectoryName(kind)),
  ]);
}

function activationRecoveryTransactionParents(kind: AppProgramActivationKind, appRoot: string): string[] {
  return uniqueResolvedPaths([
    appProgramActivationTransactionParent(kind, appRoot),
    join(dirname(resolve(appRoot)), transactionDirectoryName(kind)),
  ]);
}

function sideBySideStoreRoot(appRoot: string): string | undefined {
  const resolvedAppRoot = resolve(appRoot);
  if (basename(resolvedAppRoot) !== "app") return undefined;
  const generationRoot = dirname(resolvedAppRoot);
  const appProgramsRoot = dirname(generationRoot);
  const programsRoot = dirname(appProgramsRoot);
  if (
    basename(programsRoot) !== "programs" ||
    (!/^[a-f0-9]{64}$/.test(basename(appProgramsRoot)) && !isAppStoreAppDirectoryName(basename(appProgramsRoot)))
  ) {
    return undefined;
  }
  return dirname(programsRoot);
}

function uniqueResolvedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function pathEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  writePrivateFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}
