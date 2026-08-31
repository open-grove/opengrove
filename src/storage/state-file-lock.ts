import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { canonicalizeStatePath } from "./state-identity.js";
import { localMachineIdentity } from "./machine-identity.js";

export interface StateFileLock {
  readonly lockPath: string;
  readonly statePath: string;
  release(): void;
}

interface LockHolder {
  pid: number;
  startedAt: string;
  statePath: string;
  host: string;
  machineId?: string;
}

interface StateFileLockError extends Error {
  code: "STATE_LOCKED" | "state_lock_unreadable" | "state_lock_contended";
  holder?: LockHolder;
  lockPath?: string;
  statePath?: string;
  selfHeld?: boolean;
}

const heldLocks = new Map<string, StateFileLock>();
const currentHost = hostname();
const currentMachineId = localMachineIdentity();
let lockAttemptCounter = 0;

export function acquireStateFileLock(statePath: string): StateFileLock {
  mkdirSync(dirname(resolve(statePath)), { recursive: true });
  const canonical = canonicalizeStatePath(statePath);
  mkdirSync(dirname(canonical), { recursive: true });
  const lockPath = `${canonical}.lock`;
  const existing = heldLocks.get(canonical);
  if (existing) {
    throw lockedError(
      canonical,
      lockPath,
      {
        pid: process.pid,
        host: currentHost,
        machineId: currentMachineId,
        startedAt: new Date().toISOString(),
        statePath: canonical,
      },
      true,
    );
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const holder = createHolder(canonical);
    const publishResult = tryPublishLock(lockPath, holder);
    if (publishResult === "acquired") {
      let released = false;
      const lock: StateFileLock = {
        lockPath,
        statePath: canonical,
        release() {
          if (released) return;
          released = true;
          if (heldLocks.get(canonical) === lock) {
            heldLocks.delete(canonical);
          }
          releaseLockFile(lockPath, holder);
          cleanupOwnArtifacts(lockPath);
        },
      };
      heldLocks.set(canonical, lock);
      cleanupAbandonedArtifactsWhileHeld(lockPath);
      return lock;
    }

    const current = readLockHolder(lockPath, canonical);
    if (!current) {
      continue;
    }
    if (!isStaleHolder(current, canonical)) {
      throw lockedError(canonical, lockPath, current, false);
    }
    if (!stealStaleLock(lockPath, canonical, current)) {
      continue;
    }
  }

  throw lockError(
    "state_lock_contended",
    `state_lock_contended: ${canonical} could not acquire ${lockPath} after repeated stale lock races`,
    canonical,
    lockPath,
  );
}

export function isStateFileLockError(error: unknown): error is StateFileLockError {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as { code?: unknown }).code === "STATE_LOCKED" ||
        (error as { code?: unknown }).code === "state_lock_unreadable" ||
        (error as { code?: unknown }).code === "state_lock_contended"),
  );
}

function createHolder(statePath: string): LockHolder {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    statePath,
    host: currentHost,
    machineId: currentMachineId,
  };
}

function tryPublishLock(lockPath: string, holder: LockHolder): "acquired" | "exists" {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const tmpPath = `${lockPath}.${process.pid}.${++lockAttemptCounter}.tmp`;
    try {
      writeFileSync(tmpPath, `${JSON.stringify(holder)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (isNodeCode(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
    try {
      linkSync(tmpPath, lockPath);
      safeUnlink(tmpPath);
      return "acquired";
    } catch (error) {
      safeUnlink(tmpPath);
      if (isNodeCode(error, "EEXIST")) {
        return "exists";
      }
      throw error;
    }
  }
  throw new Error(`state_lock_temp_contended: ${lockPath}`);
}

function readLockHolder(lockPath: string, canonical: string): LockHolder | undefined {
  let raw = "";
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) {
      return undefined;
    }
    throw unreadableError(canonical, lockPath, `cannot read lock: ${messageOf(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unreadableError(canonical, lockPath, "lock file is empty or not valid JSON");
  }
  if (!isLockHolder(parsed) || parsed.statePath !== canonical) {
    throw unreadableError(canonical, lockPath, "lock file is missing a valid holder");
  }
  return parsed;
}

function isStaleHolder(holder: LockHolder, canonical: string): boolean {
  if (holder.machineId ? holder.machineId !== currentMachineId : holder.host !== currentHost) {
    return false;
  }
  if (holder.pid === process.pid && !heldLocks.has(canonical)) {
    return true;
  }
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    return isNodeCode(error, "ESRCH");
  }
}

function stealStaleLock(lockPath: string, canonical: string, stale: LockHolder): boolean {
  const recoveryPath = `${lockPath}.recover`;
  const recoveryHolder = createHolder(canonical);
  if (tryPublishLock(recoveryPath, recoveryHolder) === "exists") {
    return false;
  }
  const fenced = `${lockPath}.steal.${process.pid}.${++lockAttemptCounter}`;
  try {
    const current = readLockHolder(lockPath, canonical);
    if (!current || !sameHolder(current, stale)) {
      return false;
    }
    try {
      renameSync(lockPath, fenced);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
    const moved = readMovedHolder(fenced, canonical);
    if (!moved || !sameHolder(moved, stale)) {
      restoreMovedLock(fenced, lockPath);
      return false;
    }
    safeUnlink(fenced);
    return true;
  } finally {
    releaseLockFile(recoveryPath, recoveryHolder);
  }
}

function readMovedHolder(path: string, canonical: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isLockHolder(parsed) && parsed.statePath === canonical) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function restoreMovedLock(fenced: string, lockPath: string): void {
  try {
    linkSync(fenced, lockPath);
  } catch {
    // If another contender already published a lock, keep that lock and drop the
    // moved file. The caller will re-read on the next attempt.
  }
  safeUnlink(fenced);
}

function releaseLockFile(lockPath: string, holder: LockHolder): void {
  try {
    const current = readLockHolder(lockPath, holder.statePath);
    if (current && sameHolder(current, holder)) {
      safeUnlink(lockPath);
    }
  } catch {
    // Release is best-effort; never delete a lock we cannot prove is ours.
  }
}

function cleanupOwnArtifacts(lockPath: string): void {
  const dir = dirname(lockPath);
  const prefix = basename(lockPath);
  try {
    for (const entry of readdirSync(dir)) {
      if (
        (entry.startsWith(`${prefix}.${process.pid}.`) && entry.endsWith(".tmp")) ||
        entry.startsWith(`${prefix}.steal.${process.pid}.`)
      ) {
        safeUnlink(resolve(dir, entry));
      }
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function cleanupAbandonedArtifactsWhileHeld(lockPath: string): void {
  const dir = dirname(lockPath);
  const prefix = basename(lockPath);
  try {
    for (const entry of readdirSync(dir)) {
      if (
        entry === `${prefix}.recover` ||
        entry.startsWith(`${prefix}.recover.`) ||
        entry.startsWith(`${prefix}.steal.`)
      ) {
        safeUnlink(resolve(dir, entry));
      }
    }
  } catch {
    // non-critical-fallback: fenced files are inactive; a later lock holder can retry cleanup.
  }
}

function isLockHolder(value: unknown): value is LockHolder {
  const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return (
    Number.isInteger(item.pid) &&
    (item.pid as number) > 0 &&
    typeof item.startedAt === "string" &&
    typeof item.statePath === "string" &&
    typeof item.host === "string" &&
    (item.machineId === undefined || typeof item.machineId === "string")
  );
}

function sameHolder(left: LockHolder, right: LockHolder): boolean {
  return (
    left.pid === right.pid &&
    left.host === right.host &&
    left.machineId === right.machineId &&
    left.startedAt === right.startedAt &&
    left.statePath === right.statePath
  );
}

function lockedError(canonical: string, lockPath: string, holder: LockHolder, selfHeld: boolean): StateFileLockError {
  const error = lockError(
    "STATE_LOCKED",
    `state_locked: ${canonical} held by pid ${holder.pid} on ${holder.host} since ${holder.startedAt}`,
    canonical,
    lockPath,
    holder,
  );
  error.selfHeld = selfHeld;
  return error;
}

function unreadableError(canonical: string, lockPath: string, reason: string): StateFileLockError {
  return lockError(
    "state_lock_unreadable",
    `state_lock_unreadable: ${lockPath} cannot be trusted (${reason}). Delete it manually or use another OPENGROVE_STATE_PATH.`,
    canonical,
    lockPath,
  );
}

function lockError(
  code: StateFileLockError["code"],
  message: string,
  statePath: string,
  lockPath: string,
  holder?: LockHolder,
): StateFileLockError {
  const error = new Error(message) as StateFileLockError;
  error.code = code;
  error.statePath = statePath;
  error.lockPath = lockPath;
  error.holder = holder;
  return error;
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
