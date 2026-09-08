import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "opengrove-state-ownership-"));
try {
  const bundle = join(root, "ownership.mjs");
  await build({
    stdin: {
      contents: [
        'export * from "./desktop/state-lock-recovery.ts";',
        'export * from "./src/storage/state-file-lock.ts";',
        'export * from "./src/storage/legacy-state-lock.compat.ts";',
        'export * from "./desktop/bridge-child-shutdown.ts";',
      ].join("\n"),
      resolveDir: projectRoot,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: bundle,
  });
  const {
    recoverStaleDesktopStateLocks,
    acquireStateFileLock,
    inspectLegacyStateLock,
    readProcessStartedAt,
    stopDesktopBridgeChild,
  } = await import(pathToFileURL(bundle).href);
  const userDataDir = join(root, "reused-pid", "OpenGrove");
  mkdirSync(join(userDataDir, "data"), { recursive: true });
  const statePath = join(userDataDir, "data", "local-state.sqlite");
  writeFileSync(statePath, "user data must not change");
  writeFileSync(
    `${statePath}.lock`,
    JSON.stringify({
      pid: process.pid,
      startedAt: "2000-01-01T00:00:00.000Z",
      statePath,
      host: hostname(),
      ownershipProtocol: "sqlite-v1",
    }),
  );
  const result = recoverStaleDesktopStateLocks(userDataDir);
  assert.deepEqual(result.blockers, [], "a released OS lock must not be held hostage by a reused PID");
  assert.equal(result.recovered.length, 1);
  assert.equal(readFileSync(statePath, "utf8"), "user data must not change");
  const ownLock = acquireStateFileLock(statePath);
  assert.equal(recoverStaleDesktopStateLocks(userDataDir).blockers.length, 1);
  assert.throws(() => acquireStateFileLock(statePath), { code: "STATE_LOCKED" });
  ownLock.release();

  const childFile = join(root, "writer.mjs");
  writeFileSync(
    childFile,
    `
    import { acquireStateFileLock } from ${JSON.stringify(pathToFileURL(bundle).href)};
    const lock = acquireStateFileLock(process.argv[2]);
    process.send({ ready: true });
    setInterval(() => {}, 1000);
  `,
  );
  const child = fork(childFile, [statePath], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const childExited = once(child, "exit");
  try {
    await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    const liveMarker = readFileSync(`${statePath}.lock`, "utf8");
    assert.throws(() => acquireStateFileLock(statePath), { code: "STATE_LOCKED" });
    assert.equal(recoverStaleDesktopStateLocks(userDataDir).blockers.length, 1);
    assert.equal(readFileSync(`${statePath}.lock`, "utf8"), liveMarker);
    // Metadata damage must not let recovery bypass an active OS lock.
    writeFileSync(`${statePath}.lock`, "broken marker");
    assert.equal(recoverStaleDesktopStateLocks(userDataDir).blockers.length, 1);
    assert.equal(readFileSync(`${statePath}.lock`, "utf8"), "broken marker");
    writeFileSync(`${statePath}.lock`, liveMarker);
    child.kill("SIGKILL");
    await childExited;
    assert.deepEqual(recoverStaleDesktopStateLocks(userDataDir).blockers, []);
    writeFileSync(`${statePath}.lock`, JSON.stringify({ ...JSON.parse(liveMarker), pid: process.ppid }));
    // The storage entry point must also recover a released native owner even
    // when its marker points at another live process, without desktop preflight.
    acquireStateFileLock(statePath).release();
    assert.equal(readFileSync(statePath, "utf8"), "user data must not change");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await childExited;
  }

  // Upgrade from the PID-only protocol used through 0.6.6: a process born
  // after the marker was written cannot be its original owner.
  writeFileSync(
    `${statePath}.lock`,
    JSON.stringify({
      pid: process.pid,
      startedAt: "2000-01-01T00:00:00.000Z",
      statePath,
      host: hostname(),
    }),
  );
  assert.deepEqual(recoverStaleDesktopStateLocks(userDataDir).blockers, [], "recover a reused legacy PID");
  const holder = { pid: 1234, startedAt: "2026-09-08T00:00:00.000Z" };
  const before = () => Date.parse("2026-09-07T00:00:00.000Z");
  const after = () => Date.parse("2026-09-08T00:01:00.000Z");
  assert.equal(
    inspectLegacyStateLock(holder, { isProcessAlive: () => true, readProcessStartedAt: before }),
    "holder_alive",
  );
  assert.equal(
    inspectLegacyStateLock(holder, { isProcessAlive: () => true, readProcessStartedAt: after }),
    "reused_pid",
  );
  assert.equal(
    inspectLegacyStateLock(holder, { isProcessAlive: () => true, readProcessStartedAt: () => undefined }),
    "holder_alive",
  );
  assert.equal(
    inspectLegacyStateLock(holder, { isProcessAlive: () => false, readProcessStartedAt: before }),
    "dead_holder",
  );
  assert.equal(
    readProcessStartedAt(1234, "win32", (file, args) => {
      assert.equal(file, "powershell.exe");
      assert.ok(args.at(-1).includes("Get-Process -Id 1234 -ErrorAction Stop"));
      return "2026-09-08T00:01:00.0000000Z\r\n";
    }),
    Date.parse("2026-09-08T00:01:00.000Z"),
  );
  assert.equal(
    readProcessStartedAt(1234, "linux", () => "Tue Sep  8 00:01:00 2026\n"),
    Date.parse("2026-09-08T00:01:00.000Z"),
  );
  assert.equal(
    readProcessStartedAt(1234, "win32", () => {
      throw new Error("access denied");
    }),
    undefined,
  );

  const signalled = Object.assign(new EventEmitter(), {
    pid: 1234,
    killed: true,
    exitCode: null,
    signalCode: null,
    connected: false,
    kill: () => true,
  });
  let stopped = false;
  const stopping = stopDesktopBridgeChild(signalled).then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false, "a signal sent earlier is not proof of process exit");
  signalled.emit("exit", null, "SIGTERM");
  await stopping;

  const signals = [];
  const stuck = Object.assign(new EventEmitter(), {
    pid: 1234,
    exitCode: null,
    signalCode: null,
    connected: false,
    kill: (signal) => {
      signals.push(signal);
      return true;
    },
  });
  await assert.rejects(
    stopDesktopBridgeChild(stuck, { gracefulTimeoutMs: 10, forceTimeoutMs: 10 }),
    /desktop_bridge_exit_timeout/,
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  console.log("state ownership: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
