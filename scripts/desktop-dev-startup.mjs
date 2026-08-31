import { existsSync, linkSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const DEV_STATE_FILES = ["local-state.sqlite", "local-state.json"];
const MAX_NEW_LOG_BYTES = 64 * 1024;
let recoveryCounter = 0;

export function recoverStaleDesktopDevStateLocks(userDataPath, { isProcessAlive = defaultIsProcessAlive } = {}) {
  const recovered = [];
  const dataPath = join(resolve(userDataPath), "data");

  for (const stateFile of DEV_STATE_FILES) {
    const statePath = join(dataPath, stateFile);
    const lockPath = `${statePath}.lock`;
    const observed = readTrustedDevLock(lockPath, statePath);
    if (!observed || isProcessAlive(observed.holder.pid)) continue;

    const fencedPath = nextRecoveryPath(lockPath);
    try {
      renameSync(lockPath, fencedPath);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) continue;
      throw error;
    }

    const moved = readTrustedDevLock(fencedPath, statePath);
    if (!moved || moved.raw !== observed.raw) {
      restoreMovedLock(fencedPath, lockPath);
      continue;
    }

    unlinkSync(fencedPath);
    recovered.push({
      lockPath,
      holder: observed.holder,
    });
  }

  return recovered;
}

export function createDesktopDevStartupMonitor(userDataPath) {
  const logsPath = join(resolve(userDataPath), "logs");
  const bridgeLog = snapshotLog(join(logsPath, "bridge-crash.log"));
  const desktopLog = snapshotLog(join(logsPath, "desktop-main.log"));

  return {
    readFailure() {
      const bridgeText = readNewLogText(bridgeLog);
      const desktopText = readNewLogText(desktopLog);
      const bridgeExited = /bridge exited code=[^\r\n]*/iu.test(bridgeText);
      const desktopFailed = /desktop startup failed:[^\r\n]*/iu.test(desktopText);

      const stateFailure = lastMatchingLine(bridgeText, /^state_[a-z_]+:/iu);
      if (bridgeExited && stateFailure) return stateFailure;
      if (!desktopFailed) return undefined;

      const bridgeFailure = lastMatchingLine(bridgeText, /(?:error|failed|fatal)/iu);
      if (bridgeFailure) return bridgeFailure;

      const desktopFailure = lastMatchingLine(desktopText, /desktop startup failed:/iu);
      if (desktopFailure) return stripLogTimestamp(desktopFailure);

      return (
        lastMatchingLine(bridgeText, /bridge exited code=/iu) ??
        "the desktop process exited before its Bridge became ready"
      );
    },
  };
}

function readTrustedDevLock(lockPath, expectedStatePath) {
  let raw;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return undefined;
    throw error;
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isLockHolder(value) || resolve(value.statePath) !== resolve(expectedStatePath)) {
    return undefined;
  }
  return { holder: value, raw };
}

function isLockHolder(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.startedAt === "string" &&
      typeof value.statePath === "string" &&
      typeof value.host === "string",
  );
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeCode(error, "ESRCH");
  }
}

function nextRecoveryPath(lockPath) {
  const base = `${lockPath}.recover.${process.pid}.${Date.now()}`;
  let candidate = `${base}.${++recoveryCounter}`;
  while (existsSync(candidate)) {
    candidate = `${base}.${++recoveryCounter}`;
  }
  return candidate;
}

function restoreMovedLock(movedPath, lockPath) {
  try {
    linkSync(movedPath, lockPath);
  } catch {
    // A new owner may already have published a lock, or restoration itself may
    // have failed. Keep the fenced copy rather than deleting uncertain state.
    return;
  }
  try {
    unlinkSync(movedPath);
  } catch {
    // Best-effort race recovery only.
  }
}

function snapshotLog(path) {
  return { path, size: fileSize(path) };
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readNewLogText(snapshot) {
  let bytes;
  try {
    bytes = readFileSync(snapshot.path);
  } catch {
    return "";
  }
  if (bytes.length === snapshot.size) return "";

  const appendedAt = bytes.length >= snapshot.size ? snapshot.size : 0;
  const boundedAt = Math.max(appendedAt, bytes.length - MAX_NEW_LOG_BYTES);
  return bytes.subarray(boundedAt).toString("utf8");
}

function lastMatchingLine(text, pattern) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => pattern.test(line))
    .at(-1);
}

function stripLogTimestamp(line) {
  return line.replace(/^\[[^\]]+\]\s*/u, "");
}

function isNodeCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}
