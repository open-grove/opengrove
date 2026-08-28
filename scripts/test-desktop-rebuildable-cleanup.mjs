import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-rebuildable-cleanup-"));
const bundlePath = join(tempDir, "rebuildable-cleanup.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop/rebuildable-storage-cleanup.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: bundlePath,
  });
  const { cleanupDesktopRebuildableFiles } = await import(pathToFileURL(bundlePath).href);
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
    chromiumCacheDirs,
    updaterCacheDir,
  });
  assert.equal(result.reclaimedBytes, 115);
  assert.equal(result.mediaCacheBytes, 23);
  assert.equal(result.logBytes, 30);
  assert.equal(result.chromiumCacheBytes, 31);
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
    assert.deepEqual(await readdir(cacheDir), [], `${cacheDir} must be empty after deterministic disk cleanup`);
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("desktop rebuildable cleanup ok");

async function writeSized(path, bytes) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x".repeat(bytes), "utf8");
}
