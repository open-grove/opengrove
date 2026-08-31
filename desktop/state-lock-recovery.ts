import { existsSync, linkSync, lstatSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { LEGACY_JSON_STATE_FILE_NAME, SQLITE_STATE_FILE_NAME } from "../src/storage/default-data-dir.js";
import { localMachineIdentity } from "../src/storage/machine-identity.js";
import { canonicalizeStatePath } from "../src/storage/state-identity.js";

const DESKTOP_STATE_FILE_NAMES = [SQLITE_STATE_FILE_NAME, LEGACY_JSON_STATE_FILE_NAME] as const;
let recoveryCounter = 0;

export interface DesktopStateLockHolder {
  readonly pid: number;
  readonly startedAt: string;
  readonly statePath: string;
  readonly host: string;
  readonly machineId?: string;
}

export type RecoveredDesktopStateLock =
  | {
      readonly reason: "dead_holder";
      readonly lockPath: string;
      readonly statePath: string;
      readonly holder: DesktopStateLockHolder;
    }
  | {
      readonly reason: "untrusted_lock";
      readonly lockPath: string;
      readonly statePath: string;
      readonly detail: string;
    };

export type DesktopStateLockBlockerReason =
  | "holder_alive"
  | "foreign_host"
  | "untrusted_lock"
  | "recovery_failed"
  | "recovery_race";

export interface DesktopStateLockBlocker {
  readonly lockPath: string;
  readonly statePath: string;
  readonly reason: DesktopStateLockBlockerReason;
  readonly detail: string;
  readonly holder?: DesktopStateLockHolder;
  readonly repairable?: boolean;
}

export interface DesktopStateLockRecoveryResult {
  readonly recovered: RecoveredDesktopStateLock[];
  readonly blockers: DesktopStateLockBlocker[];
}

interface DesktopStateLockRecoveryOptions {
  allowLegacyHostnameDriftRecovery?: boolean;
  isProcessAlive?(pid: number): boolean;
  machineId?: string;
  fileSystem?: DesktopStateLockFileSystem;
}

interface DesktopStateLockFileSystem {
  existsSync(path: string): boolean;
  linkSync(existingPath: string, newPath: string): void;
  lstatSync(path: string): { dev: number; ino: number };
  readFileSync(path: string, encoding: "utf8"): string;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
}

interface DesktopStateLockIdentity {
  readonly dev: number;
  readonly ino: number;
}

type ObservedDesktopStateLock =
  | { kind: "missing" }
  | {
      kind: "trusted";
      identity: DesktopStateLockIdentity;
      raw: string;
      holder: DesktopStateLockHolder;
    }
  | {
      kind: "untrusted";
      identity: DesktopStateLockIdentity;
      detail: string;
      recoverable: boolean;
      repairable: boolean;
      raw?: string;
    };

const defaultFileSystem: DesktopStateLockFileSystem = {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
};

/**
 * Current atomic publication cannot expose partially written lock contents, so
 * readable malformed artifacts are safe to fence and remove. Valid locks are
 * recovered only when their stable machine identity matches and the PID is
 * dead. Legacy Desktop locks may opt into one-time hostname-drift recovery when
 * they live inside the machine-local Desktop userData boundary.
 */
export function recoverStaleDesktopStateLocks(
  userDataDir: string,
  options: DesktopStateLockRecoveryOptions = {},
): DesktopStateLockRecoveryResult {
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const machineId = options.machineId ?? localMachineIdentity();
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const recovered: RecoveredDesktopStateLock[] = [];
  const blockers: DesktopStateLockBlocker[] = [];

  for (const fileName of DESKTOP_STATE_FILE_NAMES) {
    const statePath = canonicalizeStatePath(join(userDataDir, "data", fileName));
    const result = recoverStateLock(
      statePath,
      isProcessAlive,
      fileSystem,
      machineId,
      options.allowLegacyHostnameDriftRecovery === true,
    );
    if (result.kind === "recovered") {
      recovered.push(result.value);
    } else if (result.kind === "blocked") {
      blockers.push(result.value);
    }
  }

  return { recovered, blockers };
}

function recoverStateLock(
  statePath: string,
  isProcessAlive: (pid: number) => boolean,
  fileSystem: DesktopStateLockFileSystem,
  machineId: string,
  allowLegacyHostnameDriftRecovery: boolean,
):
  | { kind: "none" }
  | { kind: "recovered"; value: RecoveredDesktopStateLock }
  | { kind: "blocked"; value: DesktopStateLockBlocker } {
  const lockPath = `${statePath}.lock`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = observeDesktopStateLock(lockPath, statePath, fileSystem);
    if (observed.kind === "missing") return { kind: "none" };
    if (observed.kind === "untrusted") {
      if (observed.recoverable) {
        const recoveryPath = nextRecoveryPath(lockPath, fileSystem);
        try {
          fileSystem.renameSync(lockPath, recoveryPath);
        } catch (error) {
          if (isNodeCode(error, "ENOENT")) continue;
          return {
            kind: "blocked",
            value: blocker(lockPath, statePath, "recovery_failed", messageOf(error)),
          };
        }
        const moved = observeDesktopStateLock(recoveryPath, statePath, fileSystem);
        if (!sameUntrustedLock(moved, observed)) {
          restoreMovedLock(recoveryPath, lockPath, fileSystem);
          continue;
        }
        safeUnlink(recoveryPath, fileSystem);
        return {
          kind: "recovered",
          value: {
            reason: "untrusted_lock",
            lockPath,
            statePath,
            detail: observed.detail,
          },
        };
      }
      return {
        kind: "blocked",
        value: blocker(lockPath, statePath, "untrusted_lock", observed.detail, undefined, observed.repairable),
      };
    }
    const holderBelongsToCurrentMachine = observed.holder.machineId
      ? observed.holder.machineId === machineId
      : observed.holder.host === hostname() || allowLegacyHostnameDriftRecovery;
    if (!holderBelongsToCurrentMachine) {
      return {
        kind: "blocked",
        value: blocker(
          lockPath,
          statePath,
          "foreign_host",
          `lock belongs to host ${observed.holder.host}; current host is ${hostname()}`,
          observed.holder,
        ),
      };
    }
    if (isProcessAlive(observed.holder.pid)) {
      return {
        kind: "blocked",
        value: blocker(
          lockPath,
          statePath,
          "holder_alive",
          `lock holder pid ${observed.holder.pid} is still running`,
          observed.holder,
        ),
      };
    }

    const recoveryPath = nextRecoveryPath(lockPath, fileSystem);
    try {
      fileSystem.renameSync(lockPath, recoveryPath);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) continue;
      return {
        kind: "blocked",
        value: blocker(lockPath, statePath, "recovery_failed", messageOf(error), observed.holder),
      };
    }

    const moved = observeDesktopStateLock(recoveryPath, statePath, fileSystem);
    if (
      moved.kind !== "trusted" ||
      !sameLockIdentity(moved.identity, observed.identity) ||
      moved.raw !== observed.raw
    ) {
      restoreMovedLock(recoveryPath, lockPath, fileSystem);
      continue;
    }

    safeUnlink(recoveryPath, fileSystem);
    return {
      kind: "recovered",
      value: {
        reason: "dead_holder",
        lockPath,
        statePath,
        holder: observed.holder,
      },
    };
  }

  return {
    kind: "blocked",
    value: blocker(
      lockPath,
      statePath,
      "recovery_race",
      "lock could not be recovered after repeated ownership changes",
    ),
  };
}

function observeDesktopStateLock(
  lockPath: string,
  expectedStatePath: string,
  fileSystem: DesktopStateLockFileSystem,
): ObservedDesktopStateLock {
  let identity: DesktopStateLockIdentity;
  try {
    const stats = fileSystem.lstatSync(lockPath);
    identity = { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return { kind: "missing" };
    return {
      kind: "untrusted",
      identity: { dev: 0, ino: 0 },
      detail: `cannot inspect lock: ${messageOf(error)}`,
      recoverable: false,
      repairable: true,
    };
  }

  let raw: string;
  try {
    raw = fileSystem.readFileSync(lockPath, "utf8");
  } catch (error) {
    return {
      kind: "untrusted",
      identity,
      detail: `cannot read lock: ${messageOf(error)}`,
      recoverable: false,
      repairable: true,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return {
      kind: "untrusted",
      identity,
      detail: "lock is not valid JSON",
      recoverable: true,
      repairable: false,
      raw,
    };
  }
  if (!isDesktopStateLockHolder(value)) {
    return {
      kind: "untrusted",
      identity,
      detail: "lock does not contain a valid holder",
      recoverable: true,
      repairable: false,
      raw,
    };
  }
  if (canonicalizeStatePath(value.statePath) !== expectedStatePath) {
    return {
      kind: "untrusted",
      identity,
      detail: "lock state path does not match the Desktop state file",
      recoverable: false,
      repairable: false,
      raw,
    };
  }
  return { kind: "trusted", identity, raw, holder: value };
}

function sameLockIdentity(left: DesktopStateLockIdentity, right: DesktopStateLockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameUntrustedLock(
  left: ObservedDesktopStateLock,
  right: Extract<ObservedDesktopStateLock, { kind: "untrusted" }>,
): boolean {
  return (
    left.kind === "untrusted" &&
    left.recoverable &&
    sameLockIdentity(left.identity, right.identity) &&
    left.raw === right.raw
  );
}

function isDesktopStateLockHolder(value: unknown): value is DesktopStateLockHolder {
  const holder = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return (
    Number.isInteger(holder.pid) &&
    (holder.pid as number) > 0 &&
    typeof holder.startedAt === "string" &&
    typeof holder.statePath === "string" &&
    typeof holder.host === "string" &&
    (holder.machineId === undefined || typeof holder.machineId === "string")
  );
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeCode(error, "ESRCH");
  }
}

function nextRecoveryPath(lockPath: string, fileSystem: DesktopStateLockFileSystem): string {
  const base = `${lockPath}.recover.${process.pid}.${Date.now()}`;
  let candidate = `${base}.${++recoveryCounter}`;
  while (fileSystem.existsSync(candidate)) {
    candidate = `${base}.${++recoveryCounter}`;
  }
  return candidate;
}

function restoreMovedLock(movedPath: string, lockPath: string, fileSystem: DesktopStateLockFileSystem): void {
  try {
    fileSystem.linkSync(movedPath, lockPath);
  } catch {
    // Another contender may already have published a new lock. Keep that lock
    // and discard only the fenced copy that this recovery attempt moved.
  }
  safeUnlink(movedPath, fileSystem);
}

function safeUnlink(path: string, fileSystem: DesktopStateLockFileSystem): void {
  try {
    fileSystem.unlinkSync(path);
  } catch {
    // The stale lock is already out of the active lock path. Cleanup is best-effort.
  }
}

function blocker(
  lockPath: string,
  statePath: string,
  reason: DesktopStateLockBlockerReason,
  detail: string,
  holder?: DesktopStateLockHolder,
  repairable?: boolean,
): DesktopStateLockBlocker {
  return { lockPath, statePath, reason, detail, holder, repairable };
}

function isNodeCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
