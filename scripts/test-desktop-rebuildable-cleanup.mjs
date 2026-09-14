import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { release, tmpdir, version } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  assert.match(
    cleanupFlowSource,
    /withCacheCleanup\(\(canClearUpdaterCache\)\s*=>\s*runDesktopStorageMaintenance/u,
    "updater admission must stay closed through maintenance lease completion",
  );
  assert.match(
    cleanupFlowSource,
    /const updaterCacheDir = canClearUpdaterCache \? supervisor\.updaterCacheDirectory\(\) : undefined/u,
    "cache deletion requires the updater manager's reservation, not a stale UI snapshot",
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

  const outsideRoot = join(tempDir, "outside-cleanup");
  const preservedFiles = [
    join(outsideRoot, "sentinel.txt"),
    join(workspaceRoot, "作品.md"),
    join(tempDir, "data", "conversations.json"),
    join(tempDir, "data", "settings.json"),
    join(tempDir, "data", "account.json"),
    join(tempDir, "knowledge", "notes.md"),
    join(programRoot, "index.html"),
  ];
  for (const [index, file] of preservedFiles.entries()) await writeSized(file, 100 + index);
  preservedFiles.push(
    programLookalike,
    ...["desktop-main.log", "bridge.log", "bridge-crash.log", "desktop-restart.log"].map((file) => join(logDir, file)),
  );
  const linkedWorkspace = join(tempDir, "workspaces", "linked-cache");
  const linkedCache = join(linkedWorkspace, ".cache", "opengrove-media");
  const linkedUpdater = join(tempDir, "linked-updater");
  const linkPaths = [
    join(dirname(workspaceCache), "outside-link"),
    join(updaterCacheDir, "outside-link"),
    linkedCache,
    linkedUpdater,
  ];
  for (const link of linkPaths) {
    await mkdir(dirname(link), { recursive: true });
    await symlink(outsideRoot, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  }
  const filesystem = await inspectFilesystemLinks(linkPaths);
  const before = await checksums(preservedFiles);

  const result = await cleanupDesktopRebuildableFiles({
    workspaceRoots: [workspaceRoot, linkedWorkspace],
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
  assert.equal((await lstat(linkedCache)).isSymbolicLink(), true, "a linked cache root must be skipped");
  assert.deepEqual(await readdir(updaterCacheDir), [], "updater cleanup must remove the nested link itself");
  const linkedUpdaterResult = await cleanupDesktopRebuildableFiles({
    workspaceRoots: [],
    logDir,
    updaterCacheDir: linkedUpdater,
  });
  assert.equal(linkedUpdaterResult.reclaimedBytes, 0);
  assert.equal((await lstat(linkedUpdater)).isSymbolicLink(), true, "a linked updater root must be skipped");
  const after = await checksums(preservedFiles);
  assert.deepEqual(after, before, "cleanup must preserve every file outside its rebuildable boundaries");

  const receiptPath = process.env.OPENGROVE_STORAGE_ACCEPTANCE_RECEIPT;
  if (receiptPath) {
    const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    const receipt = {
      schemaVersion: 1,
      evidenceKind: "real-filesystem-cleanup",
      executionEnvironment: process.env.GITHUB_ACTIONS === "true" ? "github-actions-runner" : "local-host",
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
      candidateSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
      clientVersion: manifest.version,
      clientReleaseNumber: manifest.clientReleaseNumber,
      checkedAt: new Date().toISOString(),
      os: { platform: process.platform, release: release(), version: version() },
      nodeVersion: process.version,
      filesystem,
      testRoot: tempDir,
      linkPaths,
      outsideRoot,
      entryPoint: "desktop/rebuildable-storage-cleanup.ts#cleanupDesktopRebuildableFiles",
      before,
      after,
      cleanupResult: result,
      linkedUpdaterResult,
      passed: true,
    };
    await mkdir(dirname(resolve(receiptPath)), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
  console.log(`real filesystem cleanup: ${filesystem.linkType}; ${preservedFiles.length} files preserved`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("desktop rebuildable cleanup ok");

async function writeSized(path, bytes) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x".repeat(bytes), "utf8");
}

async function checksums(paths) {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]),
    ),
  );
}

async function inspectFilesystemLinks(linkPaths) {
  const { type } = await statfs(tempDir);
  if (process.platform !== "win32") {
    return {
      statfsType: type,
      name: process.platform === "darwin" && type === 26 ? "APFS" : null,
      linkType: "directory-symlink",
    };
  }
  const result = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
    $ErrorActionPreference = 'Stop'
    $drive = [System.IO.Path]::GetPathRoot($env:OPENGROVE_STORAGE_TEST_ROOT).Substring(0, 1)
    $volume = Get-Volume -DriveLetter $drive
    $paths = ConvertFrom-Json -InputObject $env:OPENGROVE_STORAGE_TEST_LINKS
    $links = @(foreach ($linkPath in $paths) {
      $item = Get-Item -LiteralPath $linkPath -Force
      @{ path = $item.FullName; linkType = $item.LinkType; target = @($item.Target) }
    })
    @{ name = [string]$volume.FileSystemType; links = $links } | ConvertTo-Json -Depth 5 -Compress
  `,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENGROVE_STORAGE_TEST_ROOT: tempDir,
          OPENGROVE_STORAGE_TEST_LINKS: JSON.stringify(linkPaths),
        },
      },
    ),
  );
  assert.equal(result.name, "NTFS", "Windows release acceptance requires an actual NTFS volume");
  assert.equal(result.links.length, linkPaths.length);
  for (const link of result.links) assert.equal(link.linkType, "Junction", link.path);
  return { ...result, statfsType: type, linkType: "directory-junction" };
}
