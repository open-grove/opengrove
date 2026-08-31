import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonStateStore } from "../storage/json-state-store.js";
import { acquireStateFileLock, isStateFileLockError } from "../storage/state-file-lock.js";
import { canonicalizeStatePath } from "../storage/state-identity.js";
import { localMachineIdentity } from "../storage/machine-identity.js";
import { installDesktopBridgeParentLifecycle } from "../server/desktop-bridge-entry.js";

const currentFile = fileURLToPath(import.meta.url);
const childStartupTimeoutMs = 30_000;
const childResultTimeoutMs = 10_000;

if (process.argv[2] === "lock-child") {
  await runLockChild();
} else if (process.argv[2] === "sleep-child") {
  await new Promise(() => undefined);
} else {
  await runHarness();
}

async function runHarness(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "opengrove-state-lock-"));
  try {
    await verifyAcquireRelease(root);
    await verifySelfHeld(root);
    await verifyDeadPidStaleLock(root);
    await verifyHostnameDriftOnSameMachine(root);
    await verifyDifferentMachineHolder(root);
    await verifyDesktopBridgeStopsWhenParentDisconnects();
    await verifyAbandonedRecoveryArtifactsCleanAfterAcquire(root);
    await verifyEpermHolderIsTreatedAlive(root);
    await verifyCrossHostHolder(root);
    await verifyJsonStoreLockRelease(root);
    await verifyConcurrentStaleSteal(root);
    await verifySymlinkCanonicalization(root);
    await verifyUnreadableLock(root);
    console.log("state-file-lock-harness ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function verifyDesktopBridgeStopsWhenParentDisconnects(): Promise<void> {
  let onMessage: ((message: unknown) => void) | undefined;
  let onDisconnect: (() => void) | undefined;
  let closeCount = 0;
  let exitCount = 0;
  installDesktopBridgeParentLifecycle(
    {
      close(callback) {
        closeCount += 1;
        callback();
      },
    },
    {
      onMessage(listener) {
        onMessage = listener;
      },
      onDisconnect(listener) {
        onDisconnect = listener;
      },
      exit() {
        exitCount += 1;
      },
    },
  );
  onMessage?.({ type: "unrelated" });
  assert.equal(closeCount, 0);
  onDisconnect?.();
  onMessage?.({ type: "opengrove.desktop.bridge.shutdown" });
  assert.equal(closeCount, 1);
  assert.equal(exitCount, 1);

  let stalledDisconnect: (() => void) | undefined;
  let forcedConnectionCloseCount = 0;
  let forcedExitCount = 0;
  installDesktopBridgeParentLifecycle(
    {
      close() {
        // Reproduce a long-lived request that prevents graceful close from completing.
      },
      closeAllConnections() {
        forcedConnectionCloseCount += 1;
      },
    },
    {
      onMessage() {},
      onDisconnect(listener) {
        stalledDisconnect = listener;
      },
      exit() {
        forcedExitCount += 1;
      },
    },
    { forceExitAfterMs: 10 },
  );
  stalledDisconnect?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(forcedConnectionCloseCount, 1, "disconnect must terminate long-lived Bridge connections");
  assert.equal(forcedExitCount, 1, "disconnect must force the orphaned Bridge to exit by its deadline");
}

async function verifyAbandonedRecoveryArtifactsCleanAfterAcquire(root: string): Promise<void> {
  const statePath = join(root, "abandoned-recovery", "state.json");
  mkdirSync(dirname(statePath), { recursive: true });
  const lockPath = `${canonicalizeStatePath(statePath)}.lock`;
  const abandonedRecovery = `${lockPath}.recover.999.123.1`;
  const abandonedSteal = `${lockPath}.steal.999.1`;
  writeFileSync(abandonedRecovery, "old recovery fence\n", "utf8");
  writeFileSync(abandonedSteal, "old steal fence\n", "utf8");

  const lock = acquireStateFileLock(statePath);
  assert.equal(existsSync(abandonedRecovery), false);
  assert.equal(existsSync(abandonedSteal), false);
  lock.release();
}

async function verifyAcquireRelease(root: string): Promise<void> {
  const statePath = join(root, "basic", "state.json");
  const first = acquireStateFileLock(statePath);
  assert.equal(existsSync(first.lockPath), true);
  first.release();
  assert.equal(existsSync(first.lockPath), false);
  const second = acquireStateFileLock(statePath);
  second.release();
}

async function verifySelfHeld(root: string): Promise<void> {
  const statePath = join(root, "self-held", "state.json");
  const lock = acquireStateFileLock(statePath);
  assert.throws(
    () => acquireStateFileLock(statePath),
    (error: unknown) => isStateFileLockError(error) && error.code === "STATE_LOCKED" && error.selfHeld === true,
  );
  lock.release();
}

async function verifyDeadPidStaleLock(root: string): Promise<void> {
  const statePath = join(root, "dead-pid", "state.json");
  const deadPid = await createDeadPid();
  const lockPath = writeHolderLock(statePath, deadPid);
  const lock = acquireStateFileLock(statePath);
  assert.equal(lock.lockPath, lockPath);
  lock.release();
}

async function verifyHostnameDriftOnSameMachine(root: string): Promise<void> {
  const statePath = join(root, "same-machine-hostname-drift", "state.json");
  const deadPid = await createDeadPid();
  const lockPath = writeHolderLock(statePath, deadPid, "old-hostname.local", localMachineIdentity());
  const lock = acquireStateFileLock(statePath);
  assert.equal(lock.lockPath, lockPath);
  lock.release();
}

async function verifyDifferentMachineHolder(root: string): Promise<void> {
  const statePath = join(root, "different-machine", "state.json");
  const deadPid = await createDeadPid();
  writeHolderLock(statePath, deadPid, hostname(), "different-machine-id");
  assert.throws(
    () => acquireStateFileLock(statePath),
    (error: unknown) => isStateFileLockError(error) && error.code === "STATE_LOCKED",
  );
  unlinkSync(`${canonicalizeStatePath(statePath)}.lock`);
}

async function verifyCrossHostHolder(root: string): Promise<void> {
  const statePath = join(root, "cross-host", "state.json");
  writeHolderLock(statePath, process.pid, "not-this-host");
  assert.throws(
    () => acquireStateFileLock(statePath),
    (error: unknown) => isStateFileLockError(error) && error.code === "STATE_LOCKED",
  );
  unlinkSync(`${canonicalizeStatePath(statePath)}.lock`);
}

async function verifyEpermHolderIsTreatedAlive(root: string): Promise<void> {
  const statePath = join(root, "eperm-holder", "state.json");
  const deniedPid = 424242;
  writeHolderLock(statePath, deniedPid);
  const originalKill = process.kill;
  const mockedKill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === deniedPid && signal === 0) {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
    return originalKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  process.kill = mockedKill;
  try {
    assert.throws(
      () => acquireStateFileLock(statePath),
      (error: unknown) => isStateFileLockError(error) && error.code === "STATE_LOCKED",
    );
  } finally {
    process.kill = originalKill;
    unlinkSync(`${canonicalizeStatePath(statePath)}.lock`);
  }
}

async function verifyJsonStoreLockRelease(root: string): Promise<void> {
  const statePath = join(root, "store", "state.json");
  const first = createJsonStateStore(statePath);
  assert.throws(
    () => createJsonStateStore(statePath),
    (error: unknown) => isStateFileLockError(error) && error.code === "STATE_LOCKED",
  );
  await first.close?.();
  const second = createJsonStateStore(statePath);
  await second.close?.();
}

async function verifyConcurrentStaleSteal(root: string): Promise<void> {
  const statePath = join(root, "concurrent-stale", "state.json");
  const deadPid = await createDeadPid();
  const lockPath = writeHolderLock(statePath, deadPid);
  const holdMs = "5000";
  const children = Array.from({ length: 8 }, () =>
    fork(currentFile, ["lock-child", statePath, holdMs], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    }),
  );
  try {
    await Promise.all(children.map(waitForChildReady));
    const resultPromises = children.map(waitForChildResult);
    for (const child of children) {
      child.send({ type: "start" } satisfies ParentStartMessage);
    }
    const results = (await Promise.all(resultPromises)).map((message) => message.result);
    const successes = results.filter((result) => result.ok);
    assert.equal(successes.length, 1, JSON.stringify(results));
    const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    assert.equal(holder.pid, successes[0]?.pid);
  } finally {
    await Promise.all(children.map(waitForExit));
  }
}

async function verifySymlinkCanonicalization(root: string): Promise<void> {
  const realDir = join(root, "real");
  const linkDir = join(root, "links");
  mkdirSync(realDir, { recursive: true });
  const realState = join(realDir, "state.json");
  const linkState = join(linkDir, "state.json");
  writeFileSync(realState, "{}\n", "utf8");
  if (process.platform === "win32") {
    symlinkSync(realDir, linkDir, "junction");
  } else {
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(realState, linkState);
  }
  const lock = acquireStateFileLock(realState);
  assert.throws(
    () => acquireStateFileLock(linkState),
    (error: unknown) => isStateFileLockError(error) && error.code === "STATE_LOCKED",
  );
  lock.release();
}

async function verifyUnreadableLock(root: string): Promise<void> {
  const statePath = join(root, "bad-lock", "state.json");
  mkdirSync(dirname(statePath), { recursive: true });
  const lockPath = `${canonicalizeStatePath(statePath)}.lock`;
  writeFileSync(lockPath, "", "utf8");
  assert.throws(
    () => acquireStateFileLock(statePath),
    (error: unknown) => isStateFileLockError(error) && error.code === "state_lock_unreadable",
  );
  unlinkSync(lockPath);
}

async function runLockChild(): Promise<void> {
  const statePath = requiredArg(3);
  const holdMs = Number(process.argv[4] ?? "500");
  sendChildMessage({ type: "ready", pid: process.pid });
  await waitForParentStart();
  try {
    const lock = acquireStateFileLock(statePath);
    sendChildMessage({ type: "result", result: { ok: true, pid: process.pid, lockPath: lock.lockPath } });
    await delay(holdMs);
    lock.release();
    process.exit(0);
  } catch (error) {
    sendChildMessage({
      type: "result",
      result: { ok: false, code: errorCode(error), message: messageOf(error), pid: process.pid },
    });
    process.exit(0);
  }
}

async function createDeadPid(): Promise<number> {
  const child = fork(currentFile, ["sleep-child"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const pid = child.pid;
  assert.equal(typeof pid, "number");
  child.kill("SIGKILL");
  await waitForExit(child);
  return pid as number;
}

function writeHolderLock(statePath: string, pid: number, host = hostname(), machineId?: string): string {
  mkdirSync(dirname(statePath), { recursive: true });
  const canonical = canonicalizeStatePath(statePath);
  const lockPath = `${canonical}.lock`;
  writeFileSync(
    lockPath,
    `${JSON.stringify({
      pid,
      startedAt: "2026-06-16T00:00:00.000Z",
      statePath: canonical,
      host,
      ...(machineId ? { machineId } : {}),
    })}\n`,
    "utf8",
  );
  return lockPath;
}

function waitForChildReady(child: ChildProcess): Promise<ChildReadyMessage> {
  return waitForChildMessage(child, "ready", childStartupTimeoutMs);
}

function waitForChildResult(child: ChildProcess): Promise<ChildResultMessage> {
  return waitForChildMessage(child, "result", childResultTimeoutMs);
}

function waitForChildMessage<T extends ChildMessage["type"]>(
  child: ChildProcess,
  type: T,
  timeoutMs: number,
): Promise<Extract<ChildMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const pid = child.pid ?? "unknown";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`child_${type}_timeout:${pid}`));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      if (!isChildMessageOfType(message, type)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`child_exited_before_${type}:${pid}:${code ?? signal ?? "unknown"}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([once(child, "exit"), delay(3_000).then(() => child.kill("SIGKILL"))]);
}

function waitForParentStart(): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (!isParentStartMessage(message)) return;
      cleanup();
      resolve();
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("parent_disconnected_before_start"));
    };
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

function sendChildMessage(message: ChildMessage): void {
  process.send?.(message);
}

function isChildMessageOfType<T extends ChildMessage["type"]>(
  message: unknown,
  type: T,
): message is Extract<ChildMessage, { type: T }> {
  return Boolean(message && typeof message === "object" && "type" in message && message.type === type);
}

function isParentStartMessage(message: unknown): message is ParentStartMessage {
  return Boolean(message && typeof message === "object" && "type" in message && message.type === "start");
}

function requiredArg(index: number): string {
  const value = process.argv[index];
  if (value === undefined) throw new Error(`missing child argument ${index}`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ChildResult {
  ok: boolean;
  pid?: number;
  code?: string;
  message?: string;
  lockPath?: string;
}

interface ChildReadyMessage {
  type: "ready";
  pid: number;
}

interface ChildResultMessage {
  type: "result";
  result: ChildResult;
}

type ChildMessage = ChildReadyMessage | ChildResultMessage;

interface ParentStartMessage {
  type: "start";
}
