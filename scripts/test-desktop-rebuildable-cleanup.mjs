import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-rebuildable-cleanup-"));
const bundlePath = join(tempDir, "rebuildable-cleanup.mjs");
const maintenanceBundlePath = join(tempDir, "storage-maintenance-operation.mjs");

try {
  const desktopMainSource = await readFile(join(projectRoot, "desktop/main.ts"), "utf8");
  assert.doesNotMatch(
    desktopMainSource,
    /postBridgeStorageAction[\s\S]*?signal:\s*AbortSignal\.timeout\(10_000\)/,
    "destructive local storage actions must await the Bridge result instead of abandoning it after 10 seconds",
  );
  const cleanupFlowSource = desktopMainSource.slice(
    desktopMainSource.indexOf("async function cleanupDesktopRebuildableStorage"),
    desktopMainSource.indexOf("async function measureDesktopPathsBestEffort"),
  );
  assert.doesNotMatch(
    cleanupFlowSource,
    /supervisor\.(?:stop|start)\(/u,
    "cache cleanup must keep the Bridge process alive while its maintenance lease is owned",
  );
  assert.match(
    cleanupFlowSource,
    /runDesktopStorageMaintenance\(\{[\s\S]*release:\s*async[\s\S]*releaseDesktopStorageMaintenanceGate/u,
    "desktop cleanup must delegate lease completion to the tested maintenance lifecycle",
  );
  await build({
    entryPoints: [join(projectRoot, "desktop/rebuildable-storage-cleanup.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: bundlePath,
  });
  await build({
    entryPoints: [join(projectRoot, "desktop/storage-maintenance-operation.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: maintenanceBundlePath,
  });
  const { cleanupDesktopRebuildableFiles } = await import(pathToFileURL(bundlePath).href);
  const { runDesktopStorageMaintenance } = await import(pathToFileURL(maintenanceBundlePath).href);

  const maintenanceEvents = [];
  const maintenanceResult = await runDesktopStorageMaintenance({
    acquire: async () => {
      maintenanceEvents.push("acquire");
      return "lease-a";
    },
    run: async (leaseId) => {
      maintenanceEvents.push(`run:${leaseId}`);
      return 42;
    },
    release: async (leaseId) => {
      maintenanceEvents.push(`release:${leaseId}`);
    },
    onReleased: () => {
      maintenanceEvents.push("ready");
    },
  });
  assert.equal(maintenanceResult, 42);
  assert.deepEqual(maintenanceEvents, ["acquire", "run:lease-a", "release:lease-a", "ready"]);

  const cleanupError = new Error("cleanup_failed");
  const releaseAfterFailureError = new Error("release_after_cleanup_failed");
  let reportedReleaseError;
  await assert.rejects(
    runDesktopStorageMaintenance({
      acquire: async () => "lease-b",
      run: async () => {
        throw cleanupError;
      },
      release: async () => {
        throw releaseAfterFailureError;
      },
      onReleaseError: (error) => {
        reportedReleaseError = error;
      },
    }),
    (error) => error === cleanupError,
    "a release failure must not replace the cleanup failure the user needs to diagnose",
  );
  assert.equal(reportedReleaseError, releaseAfterFailureError);

  const releaseAfterSuccessError = new Error("release_after_success_failed");
  await assert.rejects(
    runDesktopStorageMaintenance({
      acquire: async () => "lease-c",
      run: async () => 7,
      release: async () => {
        throw releaseAfterSuccessError;
      },
    }),
    (error) => error === releaseAfterSuccessError,
    "a successful cleanup must not claim success while the maintenance gate remains closed",
  );
  const workspaceRoot = join(tempDir, "workspaces", "story-seed", "workspace");
  const workspaceCache = join(workspaceRoot, ".cache", "opengrove-media", "video.mp4");
  const programRoot = join(tempDir, "programs", "story-seed", "app");
  const programLookalike = join(programRoot, ".cache", "opengrove-media", "keep.bin");
  const logDir = join(tempDir, "logs");
  const updaterCacheDir = join(tempDir, "opengrove-updater");
  const chromiumCacheDirs = [
    join(tempDir, "Cache"),
    join(tempDir, "DawnWebGPUCache"),
    join(tempDir, "DawnGraphiteCache"),
  ];
  await writeSized(workspaceCache, 23);
  await writeSized(programLookalike, 17);
  await writeSized(join(logDir, "desktop-main.log"), 29);
  await writeSized(join(logDir, "desktop-main.log.1"), 13);
  await writeSized(join(logDir, "bridge.log"), 19);
  await writeSized(join(logDir, "bridge-crash.log"), 37);
  await writeSized(join(logDir, "bridge-crash.log.2"), 17);
  await writeSized(join(logDir, "desktop-restart.log"), 41);
  await writeSized(join(updaterCacheDir, "pending.zip"), 31);
  await writeSized(join(chromiumCacheDirs[0], "http-cache"), 7);
  await writeSized(join(chromiumCacheDirs[1], "webgpu-cache"), 11);
  await writeSized(join(chromiumCacheDirs[2], "graphite-cache"), 13);

  const result = await cleanupDesktopRebuildableFiles({
    workspaceRoots: [workspaceRoot],
    logDir,
    updaterCacheDir,
  });
  assert.equal(result.reclaimedBytes, 84);
  assert.equal(result.mediaCacheBytes, 23);
  assert.equal(result.logBytes, 30);
  assert.equal(result.chromiumCacheBytes, 0);
  assert.equal(result.updaterCacheBytes, 31);
  assert.equal(await readFile(programLookalike, "utf8"), "x".repeat(17));
  await assert.rejects(() => lstat(workspaceCache), { code: "ENOENT" });
  await assert.rejects(() => lstat(join(logDir, "desktop-main.log.1")), { code: "ENOENT" });
  await assert.rejects(() => lstat(join(logDir, "bridge-crash.log.2")), { code: "ENOENT" });
  for (const [currentLog, bytes] of [
    ["desktop-main.log", 29],
    ["bridge.log", 19],
    ["bridge-crash.log", 37],
    ["desktop-restart.log", 41],
  ]) {
    assert.equal(
      await readFile(join(logDir, currentLog), "utf8"),
      "x".repeat(bytes),
      `${currentLog} evidence remains unchanged for diagnostics`,
    );
  }
  assert.equal((await lstat(logDir)).isDirectory(), true);
  assert.equal((await lstat(updaterCacheDir)).isDirectory(), true);
  for (const cacheDir of chromiumCacheDirs) {
    assert.equal((await lstat(cacheDir)).isDirectory(), true);
    assert.equal(
      (await readdir(cacheDir)).length,
      1,
      `${cacheDir} is unrelated to filesystem cleanup and must remain untouched`,
    );
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("desktop rebuildable cleanup ok");

async function writeSized(path, bytes) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x".repeat(bytes), "utf8");
}
