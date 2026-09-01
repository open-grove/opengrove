import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  await writeSized(workspaceCache, 23);
  await writeSized(programLookalike, 17);
  await mkdir(logDir, { recursive: true });

  const result = await cleanupDesktopRebuildableFiles({ workspaceRoots: [workspaceRoot], logDir });

  assert.equal(result.mediaCacheBytes, 23);
  await assert.rejects(() => readFile(workspaceCache), { code: "ENOENT" });
  assert.equal(await readFile(programLookalike, "utf8"), "x".repeat(17));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("desktop rebuildable cleanup ok");

async function writeSized(path, bytes) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x".repeat(bytes), "utf8");
}
