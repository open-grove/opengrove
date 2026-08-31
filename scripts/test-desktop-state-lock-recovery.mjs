import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const testRoot = mkdtempSync(join(tmpdir(), "opengrove-desktop-state-lock-recovery-"));
const bundlePath = join(testRoot, "state-lock-recovery.mjs");
const supervisorBundlePath = join(testRoot, "bridge-supervisor.mjs");
const processControlBundlePath = join(testRoot, "bridge-process-control.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop", "state-lock-recovery.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: bundlePath,
  });
  await build({
    entryPoints: [join(projectRoot, "desktop", "bridge-supervisor.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: supervisorBundlePath,
  });
  await build({
    entryPoints: [join(projectRoot, "desktop", "bridge-process-control.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: processControlBundlePath,
  });
  const { recoverStaleDesktopStateLocks } = await import(pathToFileURL(bundlePath).href);
  const { desktopBridgeBlockerDetails, DesktopBridgeSupervisor, isDesktopBridgeBlocker } = await import(
    pathToFileURL(supervisorBundlePath).href
  );
  const { desktopBridgeCommandLooksOwned, stopOwnedDesktopBridgeProcesses } = await import(
    pathToFileURL(processControlBundlePath).href
  );

  verifySameHostDeadLockRecovery(testRoot, recoverStaleDesktopStateLocks);
  verifyMachineIdentitySurvivesHostnameDrift(testRoot, recoverStaleDesktopStateLocks);
  verifyLegacyDesktopHostnameDriftRecovery(testRoot, recoverStaleDesktopStateLocks);
  verifyCrossHostLocksRemainProtected(testRoot, recoverStaleDesktopStateLocks);
  verifyLiveLocksRemainProtectedAndMalformedLocksRecover(testRoot, recoverStaleDesktopStateLocks);
  verifyUnreadableLockBlocks(testRoot, recoverStaleDesktopStateLocks);
  verifyUninspectableLockBlocks(testRoot, recoverStaleDesktopStateLocks);
  verifyRecoveryRaceDoesNotLeakFencedLock(testRoot, recoverStaleDesktopStateLocks);
  await verifyOwnedBridgeProcessControl(desktopBridgeCommandLooksOwned, stopOwnedDesktopBridgeProcesses);
  await verifySupervisorRecoversBeforeSpawn(
    testRoot,
    recoverStaleDesktopStateLocks,
    DesktopBridgeSupervisor,
    desktopBridgeBlockerDetails,
    isDesktopBridgeBlocker,
  );
  process.stdout.write("desktop state lock recovery: ok\n");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

async function verifyOwnedBridgeProcessControl(desktopBridgeCommandLooksOwned, stopOwnedDesktopBridgeProcesses) {
  assert.equal(
    desktopBridgeCommandLooksOwned(
      "/Applications/OpenGrove.app/Contents/MacOS/OpenGrove /app/dist/server/desktop-bridge-entry.js",
    ),
    true,
  );
  assert.equal(desktopBridgeCommandLooksOwned("node unrelated-worker.js"), false);
  assert.equal(
    desktopBridgeCommandLooksOwned("node /usr/local/lib/node_modules/opengrove/dist/cli.js web --port 37371"),
    true,
  );

  const killed = [];
  const alive = new Set([4242]);
  await stopOwnedDesktopBridgeProcesses([4242], {
    isAlive: (pid) => alive.has(pid),
    kill: (pid, signal) => {
      killed.push({ pid, signal });
      alive.delete(pid);
    },
    readCommandLine: () => "node /app/dist/server/desktop-bridge-entry.js",
    wait: async () => undefined,
  });
  assert.deepEqual(killed, [{ pid: 4242, signal: "SIGTERM" }]);

  await assert.rejects(
    () =>
      stopOwnedDesktopBridgeProcesses([4243], {
        isAlive: () => true,
        kill: () => assert.fail("an unrelated process must never be killed"),
        readCommandLine: () => "node unrelated-worker.js",
        wait: async () => undefined,
      }),
    /desktop_bridge_blocker_not_owned:4243/u,
  );
}

async function verifySupervisorRecoversBeforeSpawn(
  root,
  recoverStaleDesktopStateLocks,
  DesktopBridgeSupervisor,
  desktopBridgeBlockerDetails,
  isDesktopBridgeBlocker,
) {
  const userDataDir = join(root, "supervisor", "OpenGrove");
  const dataDir = join(userDataDir, "data");
  const statePaths = [join(dataDir, "local-state.sqlite"), join(dataDir, "local-state.json")];
  mkdirSync(dataDir, { recursive: true });
  for (const statePath of statePaths) {
    writeFileSync(statePath, "", "utf8");
    writeHolderLock(statePath, 24_200, hostname());
  }

  const recoveredEvents = [];
  const supervisor = new DesktopBridgeSupervisor({
    appRoot: projectRoot,
    resourcesPath: projectRoot,
    userDataDir,
    token: "test-token",
    isPackaged: true,
    channel: "stable",
    onStateLockRecovered: (recovered) => recoveredEvents.push(recovered),
    recoverStateLocks: (targetUserDataDir) => {
      const result = recoverStaleDesktopStateLocks(targetUserDataDir, {
        isProcessAlive: () => false,
      });
      return {
        recovered: result.recovered,
        blockers: [
          {
            lockPath: join(dataDir, "synthetic.lock"),
            statePath: join(dataDir, "synthetic"),
            reason: "untrusted_lock",
            detail: "synthetic blocker prevents the test from spawning a Bridge",
            repairable: true,
          },
        ],
      };
    },
  });

  await assert.rejects(
    () => supervisor.start({ allowReuse: false }),
    (error) => {
      assert.equal(error?.code, "LOCAL_STATE_LOCKED");
      assert.equal(isDesktopBridgeBlocker(error), true);
      assert.deepEqual(desktopBridgeBlockerDetails(error).actions, ["repair_state_access", "open_data_dir", "retry"]);
      return true;
    },
  );
  assert.equal(isDesktopBridgeBlocker(new Error("unrelated startup failure")), false);
  assert.equal(supervisor.diagnostics().status, "failed");
  assert.equal(recoveredEvents.length, 2);
  for (const statePath of statePaths) {
    assert.equal(existsSync(`${statePath}.lock`), false);
  }
}

function verifySameHostDeadLockRecovery(root, recoverStaleDesktopStateLocks) {
  const userDataDir = join(root, "same-host-dead", "OpenGrove");
  const dataDir = join(userDataDir, "data");
  const statePaths = [join(dataDir, "local-state.sqlite"), join(dataDir, "local-state.json")];
  mkdirSync(dataDir, { recursive: true });
  for (const statePath of statePaths) {
    writeFileSync(statePath, "", "utf8");
    writeHolderLock(statePath, 24_200, hostname());
  }

  const result = recoverStaleDesktopStateLocks(userDataDir, {
    isProcessAlive: () => false,
  });

  assert.equal(result.recovered.length, 2);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.recovered.map((item) => basename(item.statePath)).sort(), [
    "local-state.json",
    "local-state.sqlite",
  ]);
  for (const statePath of statePaths) {
    assert.equal(existsSync(`${statePath}.lock`), false);
  }
  assert.deepEqual(
    readdirSync(dataDir).filter((entry) => entry.includes(".lock.recover.")),
    [],
  );
}

function verifyCrossHostLocksRemainProtected(root, recoverStaleDesktopStateLocks) {
  const userDataDir = join(root, "cross-host", "OpenGrove");
  const dataDir = join(userDataDir, "data");
  const statePath = join(dataDir, "local-state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath, "", "utf8");
  writeHolderLock(statePath, 24_200, "another-machine.local", "machine-b");

  const result = recoverStaleDesktopStateLocks(userDataDir, {
    isProcessAlive: () => false,
    machineId: "machine-a",
  });

  assert.deepEqual(result.recovered, []);
  assert.deepEqual(
    result.blockers.map((item) => item.reason),
    ["foreign_host"],
  );
  assert.equal(existsSync(`${statePath}.lock`), true);
}

function verifyMachineIdentitySurvivesHostnameDrift(root, recoverStaleDesktopStateLocks) {
  const userDataDir = join(root, "machine-id-hostname-drift", "OpenGrove");
  const statePath = join(userDataDir, "data", "local-state.sqlite");
  mkdirSync(join(userDataDir, "data"), { recursive: true });
  writeFileSync(statePath, "", "utf8");
  writeHolderLock(statePath, 24_200, "old-mac-name.local", "stable-machine-a");

  const result = recoverStaleDesktopStateLocks(userDataDir, {
    isProcessAlive: () => false,
    machineId: "stable-machine-a",
  });

  assert.equal(result.recovered.length, 1);
  assert.deepEqual(result.blockers, []);
  assert.equal(existsSync(`${statePath}.lock`), false);
}

function verifyLegacyDesktopHostnameDriftRecovery(root, recoverStaleDesktopStateLocks) {
  const userDataDir = join(root, "legacy-hostname-drift", "OpenGrove");
  const statePath = join(userDataDir, "data", "local-state.sqlite");
  mkdirSync(join(userDataDir, "data"), { recursive: true });
  writeFileSync(statePath, "", "utf8");
  writeHolderLock(statePath, 24_200, "old-mac-name.local");

  const result = recoverStaleDesktopStateLocks(userDataDir, {
    allowLegacyHostnameDriftRecovery: true,
    isProcessAlive: () => false,
    machineId: "stable-machine-a",
  });

  assert.equal(result.recovered.length, 1);
  assert.deepEqual(result.blockers, []);
  assert.equal(existsSync(`${statePath}.lock`), false);
}

function verifyLiveLocksRemainProtectedAndMalformedLocksRecover(root, recoverStaleDesktopStateLocks) {
  const userDataDir = join(root, "protected", "OpenGrove");
  const dataDir = join(userDataDir, "data");
  const liveStatePath = join(dataDir, "local-state.sqlite");
  const invalidStatePath = join(dataDir, "local-state.json");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(liveStatePath, "", "utf8");
  writeFileSync(invalidStatePath, "", "utf8");
  writeHolderLock(liveStatePath, 1234, hostname());
  writeFileSync(`${invalidStatePath}.lock`, "not-json\n", "utf8");

  const result = recoverStaleDesktopStateLocks(userDataDir, {
    isProcessAlive: (pid) => pid === 1234,
  });

  assert.deepEqual(
    result.blockers.map((item) => item.reason),
    ["holder_alive"],
  );
  assert.equal(existsSync(`${liveStatePath}.lock`), true);
  assert.equal(existsSync(`${invalidStatePath}.lock`), false);
  assert.equal(JSON.parse(readFileSync(`${liveStatePath}.lock`, "utf8")).pid, 1234);
  assert.deepEqual(
    result.recovered.map((item) => item.reason),
    ["untrusted_lock"],
  );
  assert.deepEqual(
    readdirSync(dataDir).filter((entry) => entry.includes(".lock.recover.")),
    [],
  );
}

function verifyRecoveryRaceDoesNotLeakFencedLock(root, recoverStaleDesktopStateLocks) {
  const userDataDir = join(root, "recovery-race", "OpenGrove");
  const dataDir = join(userDataDir, "data");
  const statePath = join(dataDir, "local-state.sqlite");
  const lockPath = `${statePath}.lock`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath, "", "utf8");
  writeHolderLock(statePath, 24_200, hostname());

  const replacementPid = 24_201;
  const replacementLock = `${JSON.stringify({
    pid: replacementPid,
    startedAt: "2026-08-08T10:00:00.000Z",
    statePath: resolve(statePath),
    host: hostname(),
  })}\n`;
  let changedMovedRead = false;
  let publishedReplacement = false;
  const fileSystem = {
    existsSync,
    linkSync(source, destination) {
      if (String(source).includes(".lock.recover.") && !publishedReplacement) {
        publishedReplacement = true;
        writeFileSync(lockPath, replacementLock, { encoding: "utf8", flag: "wx" });
      }
      linkSync(source, destination);
    },
    lstatSync,
    readFileSync(path, encoding) {
      const raw = readFileSync(path, encoding);
      if (String(path).includes(".lock.recover.") && !changedMovedRead) {
        changedMovedRead = true;
        return raw.replace(hostname(), "changed-host.local");
      }
      return raw;
    },
    renameSync,
    unlinkSync,
  };

  const result = recoverStaleDesktopStateLocks(userDataDir, {
    fileSystem,
    isProcessAlive: (pid) => pid === replacementPid,
  });

  assert.equal(publishedReplacement, true);
  assert.deepEqual(result.recovered, []);
  assert.deepEqual(
    result.blockers.map((item) => item.reason),
    ["holder_alive"],
  );
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, replacementPid);
  assert.deepEqual(
    readdirSync(dataDir).filter((entry) => entry.includes(".lock.recover.")),
    [],
  );
}

function verifyUnreadableLockBlocks(root, recoverStaleDesktopStateLocks) {
  const userDataDir = join(root, "unreadable", "OpenGrove");
  const dataDir = join(userDataDir, "data");
  const statePath = join(dataDir, "local-state.sqlite");
  const lockPath = `${statePath}.lock`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath, "", "utf8");
  writeFileSync(lockPath, "unreadable-lock\n", "utf8");

  const fileSystem = {
    existsSync,
    linkSync,
    lstatSync,
    readFileSync(path, encoding) {
      if (String(path).includes(".lock") && existsSync(path)) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return readFileSync(path, encoding);
    },
    renameSync,
    unlinkSync,
  };
  const result = recoverStaleDesktopStateLocks(userDataDir, { fileSystem });

  assert.deepEqual(
    result.blockers.map((item) => item.reason),
    ["untrusted_lock"],
  );
  assert.deepEqual(result.recovered, []);
  assert.equal(existsSync(lockPath), true);
  assert.deepEqual(
    readdirSync(dataDir).filter((entry) => entry.includes(".lock.recover.")),
    [],
  );
}

function verifyUninspectableLockBlocks(root, recoverStaleDesktopStateLocks) {
  const userDataDir = join(root, "uninspectable", "OpenGrove");
  const dataDir = join(userDataDir, "data");
  const statePath = join(dataDir, "local-state.sqlite");
  const lockPath = `${statePath}.lock`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath, "", "utf8");
  writeFileSync(lockPath, "uninspectable-lock\n", "utf8");

  const fileSystem = {
    existsSync,
    linkSync,
    lstatSync(path) {
      if (String(path).endsWith("local-state.sqlite.lock")) {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }
      return lstatSync(path);
    },
    readFileSync,
    renameSync,
    unlinkSync,
  };
  const result = recoverStaleDesktopStateLocks(userDataDir, { fileSystem });

  assert.deepEqual(
    result.blockers.map((item) => item.reason),
    ["untrusted_lock"],
  );
  assert.deepEqual(result.recovered, []);
  assert.equal(existsSync(lockPath), true);
}

function writeHolderLock(statePath, pid, host, machineId) {
  writeFileSync(
    `${statePath}.lock`,
    `${JSON.stringify({
      pid,
      startedAt: "2026-08-06T02:50:55.478Z",
      statePath: resolve(statePath),
      host,
      ...(machineId ? { machineId } : {}),
    })}\n`,
    "utf8",
  );
}
