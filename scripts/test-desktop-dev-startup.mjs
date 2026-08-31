import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createDesktopDevStartupMonitor, recoverStaleDesktopDevStateLocks } from "./desktop-dev-startup.mjs";

const root = mkdtempSync(join(tmpdir(), "opengrove-desktop-dev-startup-"));

try {
  verifyStaleLocalLockRecovery(root);
  verifyLiveAndUntrustedLocksArePreserved(root);
  verifyStartupFailureReporting(root);
  verifyDesktopOnlyFailureReporting(root);
  process.stdout.write("desktop-dev startup recovery: ok\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function verifyStaleLocalLockRecovery(testRoot) {
  const userDataPath = join(testRoot, "stale", "OpenGroveDev");
  const dataPath = join(userDataPath, "data");
  mkdirSync(dataPath, { recursive: true });

  const statePaths = [join(dataPath, "local-state.sqlite"), join(dataPath, "local-state.json")];
  for (const statePath of statePaths) {
    writeFileSync(statePath, "", "utf8");
    writeHolderLock(statePath, 56_674, "previous-host.local");
  }

  const recovered = recoverStaleDesktopDevStateLocks(userDataPath, {
    isProcessAlive: () => false,
  });

  assert.equal(recovered.length, 2);
  for (const statePath of statePaths) {
    assert.equal(existsSync(`${statePath}.lock`), false);
    const recoveryArtifacts = readdirSync(dataPath).filter((entry) =>
      entry.startsWith(`${basename(statePath)}.lock.recover.`),
    );
    assert.deepEqual(recoveryArtifacts, []);
  }
}

function verifyLiveAndUntrustedLocksArePreserved(testRoot) {
  const userDataPath = join(testRoot, "preserved", "OpenGroveDev");
  const dataPath = join(userDataPath, "data");
  mkdirSync(dataPath, { recursive: true });

  const liveStatePath = join(dataPath, "local-state.sqlite");
  writeFileSync(liveStatePath, "", "utf8");
  writeHolderLock(liveStatePath, 1234, "previous-host.local");

  const invalidStatePath = join(dataPath, "local-state.json");
  writeFileSync(invalidStatePath, "", "utf8");
  writeFileSync(`${invalidStatePath}.lock`, "not-json\n", "utf8");

  const recovered = recoverStaleDesktopDevStateLocks(userDataPath, {
    isProcessAlive: (pid) => pid === 1234,
  });

  assert.deepEqual(recovered, []);
  assert.equal(existsSync(`${liveStatePath}.lock`), true);
  assert.equal(existsSync(`${invalidStatePath}.lock`), true);

  const mismatchedUserDataPath = join(testRoot, "mismatched", "OpenGroveDev");
  const mismatchedStatePath = join(mismatchedUserDataPath, "data", "local-state.sqlite");
  mkdirSync(join(mismatchedUserDataPath, "data"), { recursive: true });
  writeFileSync(mismatchedStatePath, "", "utf8");
  writeHolderLock(mismatchedStatePath, 5678, "previous-host.local", resolve(testRoot, "other.sqlite"));
  assert.deepEqual(recoverStaleDesktopDevStateLocks(mismatchedUserDataPath, { isProcessAlive: () => false }), []);
  assert.equal(existsSync(`${mismatchedStatePath}.lock`), true);
}

function verifyStartupFailureReporting(testRoot) {
  const userDataPath = join(testRoot, "monitor", "OpenGroveDev");
  const logsPath = join(userDataPath, "logs");
  mkdirSync(logsPath, { recursive: true });
  const bridgeLogPath = join(logsPath, "bridge-crash.log");
  const desktopLogPath = join(logsPath, "desktop-main.log");

  writeFileSync(
    bridgeLogPath,
    "state_locked: an old failure that must not be reported\nbridge exited code=1 signal=null\n",
    "utf8",
  );
  writeFileSync(desktopLogPath, "[old] desktop startup failed: Error: desktop_bridge_exited:1\n", "utf8");
  const monitor = createDesktopDevStartupMonitor(userDataPath);
  assert.equal(monitor.readFailure(), undefined);

  appendFileSync(bridgeLogPath, "Error: bridge_app_not_initialized\nbridge exited code=1 signal=null\n", "utf8");
  assert.equal(
    monitor.readFailure(),
    undefined,
    "a retryable Bridge child exit must not make the dev restart command fail before desktop recovery finishes",
  );

  appendFileSync(
    bridgeLogPath,
    "state_locked: local-state.sqlite held by dead pid 56674\nbridge exited code=1 signal=null\n",
    "utf8",
  );
  appendFileSync(desktopLogPath, "[new] desktop startup failed: Error: desktop_bridge_exited:1\n", "utf8");

  assert.equal(monitor.readFailure(), "state_locked: local-state.sqlite held by dead pid 56674");
}

function verifyDesktopOnlyFailureReporting(testRoot) {
  const userDataPath = join(testRoot, "desktop-only-monitor", "OpenGroveDev");
  const logsPath = join(userDataPath, "logs");
  mkdirSync(logsPath, { recursive: true });
  const desktopLogPath = join(logsPath, "desktop-main.log");
  writeFileSync(desktopLogPath, "", "utf8");
  const monitor = createDesktopDevStartupMonitor(userDataPath);
  appendFileSync(
    desktopLogPath,
    "[2026-08-07T14:24:01.624Z] desktop startup failed: Error: bootstrap_failed\n",
    "utf8",
  );
  assert.equal(monitor.readFailure(), "desktop startup failed: Error: bootstrap_failed");
}

function writeHolderLock(statePath, pid, host, holderStatePath = resolve(statePath)) {
  writeFileSync(
    `${statePath}.lock`,
    `${JSON.stringify({
      pid,
      startedAt: "2026-08-07T05:20:03.787Z",
      statePath: holderStatePath,
      host,
    })}\n`,
    "utf8",
  );
}
