import { lstat, mkdir, opendir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { mcpAppMediaCachePath } from "../src/mcp-app-media-cache-path.js";

export interface DesktopRebuildableCleanupResult {
  reclaimedBytes: number;
  mediaCacheBytes: number;
  logBytes: number;
  chromiumCacheBytes: number;
  updaterCacheBytes: number;
}

export async function cleanupDesktopRebuildableFiles(input: {
  workspaceRoots: readonly string[];
  logDir: string;
  updaterCacheDir?: string;
}): Promise<DesktopRebuildableCleanupResult> {
  const workspaceCachePaths = [
    ...new Set(input.workspaceRoots.map((workspaceRoot) => resolve(mcpAppMediaCachePath(workspaceRoot)))),
  ];
  const mediaCacheBytes = (
    await Promise.all(workspaceCachePaths.map((path) => removePath(path, { recreate: false })))
  ).reduce((total, bytes) => total + bytes, 0);
  const logBytes = await removeRotatedLogs(resolve(input.logDir));
  // Chromium owns these paths while the retained renderer is alive. The desktop
  // Host clears them through Electron's Session API instead of raw filesystem rm.
  const chromiumCacheBytes = 0;
  const updaterCacheBytes = input.updaterCacheDir
    ? await removePath(resolve(input.updaterCacheDir), { recreate: true })
    : 0;
  return {
    reclaimedBytes: mediaCacheBytes + logBytes + chromiumCacheBytes + updaterCacheBytes,
    mediaCacheBytes,
    logBytes,
    chromiumCacheBytes,
    updaterCacheBytes,
  };
}

async function removeRotatedLogs(logDir: string): Promise<number> {
  let reclaimedBytes = 0;
  let directory;
  try {
    directory = await opendir(logDir);
  } catch (error) {
    if (isMissingPathError(error)) return 0;
    throw error;
  }
  for await (const entry of directory) {
    if (!entry.isFile() || !/\.log\.\d+$/.test(entry.name)) continue;
    const path = resolve(logDir, entry.name);
    reclaimedBytes += await measureDesktopPathBytes(path);
    await rm(path, { force: true });
  }
  return reclaimedBytes;
}

async function removePath(path: string, options: { recreate: boolean }): Promise<number> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return 0;
    throw error;
  }
  if (metadata.isSymbolicLink()) return 0;
  const bytes = await measureDesktopPathBytes(path);
  await rm(path, { recursive: true, force: true });
  if (options.recreate) await mkdir(path, { recursive: true });
  return bytes;
}

export async function measureDesktopPathBytes(path: string): Promise<number> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return 0;
    throw error;
  }
  if (metadata.isSymbolicLink()) return 0;
  if (!metadata.isDirectory()) return metadata.isFile() ? metadata.size : 0;
  let total = 0;
  const directory = await opendir(path);
  for await (const entry of directory) total += await measureDesktopPathBytes(resolve(path, entry.name));
  return total;
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR"),
  );
}
