import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-updater-cache-cleanup-"));
const originalFetch = globalThis.fetch;

try {
  const bundlePath = join(tempDir, "updater-cache-cleanup.cjs");
  await build({
    stdin: {
      contents: `
        export { DesktopClientUpdateManager } from "./desktop/client-update-manager.ts";
        export { cleanupDesktopRebuildableFiles } from "./desktop/rebuildable-storage-cleanup.ts";
        export { autoUpdater } from "electron-updater";
      `,
      resolveDir: projectRoot,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    outfile: bundlePath,
    plugins: [
      {
        name: "electron-updater-stub",
        setup(build) {
          build.onResolve({ filter: /^electron-updater$/ }, () => ({ path: "updater", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: `
              import { EventEmitter } from "node:events";
              export const autoUpdater = new EventEmitter();
              autoUpdater.setFeedURL = () => {};
            `,
          }));
        },
      },
    ],
  });
  const { DesktopClientUpdateManager, cleanupDesktopRebuildableFiles, autoUpdater } = createRequire(import.meta.url)(
    bundlePath,
  );
  const logDir = join(tempDir, "logs");
  const updaterCacheDir = join(tempDir, "updater");
  const installer = join(updaterCacheDir, "pending.zip");
  await mkdir(logDir);
  await mkdir(updaterCacheDir);

  function managerFor({ autoDownload = true, prepareForInstall = async () => {} } = {}) {
    autoUpdater.removeAllListeners();
    autoUpdater.checkForUpdates = async () => {};
    autoUpdater.downloadUpdate = async () => {};
    autoUpdater.quitAndInstall = () => {};
    globalThis.fetch = async () => updateResponse();
    return new DesktopClientUpdateManager({
      enabled: true,
      currentVersion: "0.5.18",
      autoDownload,
      getApiBase: () => "http://127.0.0.1:9999/api",
      getCookieHeader: () => undefined,
      applySetCookieHeaders: () => {},
      prepareForInstall,
      log: () => {},
      onStateChange: () => {},
    });
  }

  function cleanupFiles(canClearCache) {
    return cleanupDesktopRebuildableFiles({
      workspaceRoots: [],
      logDir,
      updaterCacheDir: canClearCache ? updaterCacheDir : undefined,
    });
  }

  async function finishDownload() {
    await writeFile(installer, "new installer");
    autoUpdater.emit("update-downloaded", { version: "0.5.19" });
  }

  // A check already in flight can finish downloading before filesystem cleanup.
  {
    const manager = managerFor();
    const metadata = Promise.withResolvers();
    globalThis.fetch = () => metadata.promise;
    autoUpdater.checkForUpdates = async () => {
      autoUpdater.emit("update-available", { version: "0.5.19" });
      await finishDownload();
    };
    const checking = manager.checkForUpdates();
    assert.equal(manager.snapshot().stage, "checking");
    await writeFile(join(logDir, "desktop-main.log.1"), "old log");
    const result = await manager.withCacheCleanup(async (canClearCache) => {
      assert.equal(canClearCache, false, "an in-flight check reserves the updater cache");
      metadata.resolve(updateResponse());
      await checking;
      return cleanupFiles(canClearCache);
    });
    assert.equal(await readFile(installer, "utf8"), "new installer");
    assert.equal(result.updaterCacheBytes, 0);
    assert.equal(result.logBytes, 7, "other rebuildable files still get cleaned");
  }

  // Admission closes synchronously, before the asynchronous cleanup callback runs.
  {
    const manager = managerFor();
    const entered = Promise.withResolvers();
    const finishCleanup = Promise.withResolvers();
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return updateResponse();
    };
    autoUpdater.checkForUpdates = finishDownload;
    const cleaning = manager.withCacheCleanup(async (canClearCache) => {
      assert.equal(canClearCache, true);
      entered.resolve();
      await finishCleanup.promise;
      return cleanupFiles(canClearCache);
    });
    const checking = manager.checkForUpdates();
    const secondCheck = manager.checkForUpdates();
    await entered.promise;
    await setImmediate();
    assert.equal(fetchCalls, 0, "new update checks wait for cache deletion to finish");
    finishCleanup.resolve();
    await Promise.all([cleaning, checking, secondCheck]);
    assert.equal(fetchCalls, 1, "queued checks still share one update operation");
    assert.equal(await readFile(installer, "utf8"), "new installer");
  }

  // A manual download, including enabling auto-download, uses the same admission gate.
  {
    const manager = managerFor({ autoDownload: false });
    await manager.checkForUpdates();
    let downloadCalls = 0;
    autoUpdater.downloadUpdate = async () => {
      downloadCalls += 1;
      await finishDownload();
    };
    const entered = Promise.withResolvers();
    const finishCleanup = Promise.withResolvers();
    const cleaning = manager.withCacheCleanup(async (canClearCache) => {
      assert.equal(canClearCache, true);
      entered.resolve();
      await finishCleanup.promise;
      return cleanupFiles(canClearCache);
    });
    manager.setAutoDownload(true);
    const downloading = manager.downloadUpdate();
    await entered.promise;
    await setImmediate();
    assert.equal(downloadCalls, 0);
    finishCleanup.resolve();
    await Promise.all([cleaning, downloading]);
    assert.equal(downloadCalls, 1);
    assert.equal(await readFile(installer, "utf8"), "new installer");
  }

  // UI state can already be "available" while the native update check is unresolved.
  {
    const manager = managerFor({ autoDownload: false });
    const nativeCheck = Promise.withResolvers();
    const entered = Promise.withResolvers();
    autoUpdater.checkForUpdates = () => {
      entered.resolve();
      return nativeCheck.promise;
    };
    const checking = manager.checkForUpdates();
    await entered.promise;
    assert.equal(manager.snapshot().stage, "available");
    await manager.withCacheCleanup(async (canClearCache) => {
      assert.equal(canClearCache, false, "operation ownership matters even when the UI is not busy");
      return cleanupFiles(canClearCache);
    });
    nativeCheck.resolve();
    await checking;
  }

  // Downloads keep the cache reserved after checkForUpdates has resolved.
  for (const stage of ["downloading", "downloaded", "installing"]) {
    const manager = managerFor();
    await writeFile(installer, "new installer");
    await manager.checkForUpdates();
    autoUpdater.emit("update-available", { version: "0.5.19" });
    if (stage !== "downloading") await finishDownload();
    if (stage === "installing") await manager.installUpdate();
    assert.equal(manager.snapshot().stage, stage);
    await manager.withCacheCleanup(async (canClearCache) => {
      assert.equal(canClearCache, false, `${stage} must keep its installer`);
      return cleanupFiles(canClearCache);
    });
    assert.equal(await readFile(installer, "utf8"), "new installer");
  }

  // Installation cannot quit the Host while its storage cleanup is still active.
  {
    let installCalls = 0;
    const manager = managerFor({
      prepareForInstall: async () => {
        installCalls += 1;
      },
    });
    await finishDownload();
    const finishCleanup = Promise.withResolvers();
    const cleaning = manager.withCacheCleanup(async (canClearCache) => {
      assert.equal(canClearCache, false);
      await finishCleanup.promise;
      return cleanupFiles(canClearCache);
    });
    const installing = manager.installUpdate();
    await setImmediate();
    assert.equal(installCalls, 0);
    finishCleanup.resolve();
    await Promise.all([cleaning, installing]);
    assert.equal(installCalls, 1);
  }

  // Cleanup errors reach the caller and release admission for subsequent updates.
  for (const synchronous of [false, true]) {
    const manager = managerFor();
    await writeFile(installer, "old installer");
    const failure = new Error("cache deletion failed");
    const finishCleanup = Promise.withResolvers();
    const cleaning = manager.withCacheCleanup(
      synchronous
        ? () => {
            throw failure;
          }
        : async () => {
            await finishCleanup.promise;
            throw failure;
          },
    );
    const rejected = assert.rejects(cleaning, (error) => error === failure);
    const checking = manager.checkForUpdates();
    finishCleanup.resolve();
    await rejected;
    assert.equal((await checking).stage, "available");
    const result = await manager.withCacheCleanup(cleanupFiles);
    assert.equal(result.updaterCacheBytes, 13);
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(tempDir, { recursive: true, force: true });
}

console.log("desktop updater cache cleanup ok");

function updateResponse() {
  return Response.json({
    ok: true,
    current: 10022,
    latest: { version: 10023, downloadUrl: "https://example.test/releases/opengrove.dmg" },
  });
}
