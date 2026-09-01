import { opendir, lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { mcpAppMediaCachePath } from "../mcp-app-media-cache-path.js";
import {
  OPEN_GROVE_STORAGE_CATEGORY_IDS,
  type OpenGroveStorageCategoryId,
  type OpenGroveStorageOverview,
} from "../storage/storage-overview-contract.js";

export interface OpenGroveStorageRoots {
  userDataDir: string;
  programRoots: readonly string[];
  currentWorkspacesRoot: string;
  legacyAppsRoot: string;
  externalWorkspaceRoots: readonly string[];
  appStoreRoots: readonly string[];
  updaterCacheDir?: string;
}

export async function inspectOpenGroveStorage(input: {
  roots: OpenGroveStorageRoots;
  stateBackupPaths?: readonly string[];
  rebuildableFilePaths?: readonly string[];
  orphanBlobBytes?: number;
}): Promise<OpenGroveStorageOverview> {
  const roots = resolveRoots(input.roots);
  const stateBackupPaths = uniquePaths(input.stateBackupPaths ?? []);
  const rebuildableFilePaths = new Set(uniquePaths(input.rebuildableFilePaths ?? []));
  const backups = (await Promise.all(stateBackupPaths.map((path) => inspectBackup(path)))).filter(
    (backup): backup is NonNullable<typeof backup> => Boolean(backup),
  );
  const categoryBytes = emptyCategoryBytes();
  let rebuildableBytes = 0;

  const scanRoots = minimalRoots([
    roots.userDataDir,
    ...roots.programRoots,
    roots.currentWorkspacesRoot,
    roots.legacyAppsRoot,
    ...roots.externalWorkspaceRoots,
    ...roots.appStoreRoots,
    ...(roots.updaterCacheDir ? [roots.updaterCacheDir] : []),
    ...stateBackupPaths,
  ]);
  for (const scanRoot of scanRoots) {
    await walkRegularFiles(scanRoot, async (path, bytes) => {
      const category = classifyPath(path, roots, stateBackupPaths);
      categoryBytes[category] += bytes;
      if (isCleanupCandidate(path, roots, stateBackupPaths, rebuildableFilePaths)) rebuildableBytes += bytes;
    });
  }

  const orphanBlobBytes = Math.max(0, input.orphanBlobBytes ?? 0);
  const reclassifiedOrphanBytes = Math.min(categoryBytes["conversations-and-system"], orphanBlobBytes);
  categoryBytes["conversations-and-system"] -= reclassifiedOrphanBytes;
  categoryBytes.rebuildable += reclassifiedOrphanBytes;

  return {
    totalBytes: Object.values(categoryBytes).reduce((total, bytes) => total + bytes, 0),
    scannedAt: new Date().toISOString(),
    categories: OPEN_GROVE_STORAGE_CATEGORY_IDS.map((id) => ({ id, bytes: categoryBytes[id] })),
    cleanupCandidates: { rebuildableBytes },
    backups: backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  };
}

type ResolvedStorageRoots = Omit<OpenGroveStorageRoots, "updaterCacheDir"> & { updaterCacheDir?: string };
type CategoryBytes = Record<OpenGroveStorageCategoryId, number>;

function resolveRoots(roots: OpenGroveStorageRoots): ResolvedStorageRoots {
  return {
    userDataDir: resolve(roots.userDataDir),
    programRoots: uniquePaths(roots.programRoots),
    currentWorkspacesRoot: resolve(roots.currentWorkspacesRoot),
    legacyAppsRoot: resolve(roots.legacyAppsRoot),
    externalWorkspaceRoots: uniquePaths(roots.externalWorkspaceRoots),
    appStoreRoots: uniquePaths(roots.appStoreRoots),
    updaterCacheDir: roots.updaterCacheDir?.trim() ? resolve(roots.updaterCacheDir) : undefined,
  };
}

async function inspectBackup(
  path: string,
): Promise<{ kind: "migration"; bytes: number; createdAt: string } | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink()) return undefined;
  let bytes = 0;
  await walkRegularFiles(path, async (_filePath, fileBytes) => {
    bytes += fileBytes;
  });
  return {
    kind: "migration",
    bytes,
    createdAt: metadata.isDirectory()
      ? await recoveryCreatedAt(path, metadata.mtime.toISOString())
      : metadata.mtime.toISOString(),
  };
}

async function recoveryCreatedAt(root: string, fallback: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(resolve(root, "recovery.json"), "utf8")) as { createdAt?: unknown };
    return typeof parsed.createdAt === "string" && !Number.isNaN(Date.parse(parsed.createdAt))
      ? parsed.createdAt
      : fallback;
  } catch {
    return fallback;
  }
}

async function walkRegularFiles(root: string, visit: (path: string, bytes: number) => Promise<void>): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    await visit(resolve(root), metadata.size);
    return;
  }
  if (!metadata.isDirectory()) return;
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (entry.isSymbolicLink()) continue;
    await walkRegularFiles(resolve(root, entry.name), visit);
  }
}

function classifyPath(
  path: string,
  roots: ResolvedStorageRoots,
  stateBackupPaths: readonly string[],
): OpenGroveStorageCategoryId {
  if (stateBackupPaths.some((root) => pathIsInside(root, path))) return "backups";
  if (isWorkspaceMediaCache(path, roots)) return "rebuildable";
  if (roots.updaterCacheDir && pathIsInside(roots.updaterCacheDir, path)) return "rebuildable";
  if (roots.externalWorkspaceRoots.some((root) => pathIsInside(root, path))) return "works-and-files";
  if (pathIsInside(roots.currentWorkspacesRoot, path)) return "works-and-files";
  if (pathIsInside(roots.legacyAppsRoot, path)) return classifyLegacyAppPath(path, roots.legacyAppsRoot);
  if (roots.programRoots.some((root) => pathIsInside(root, path))) return "apps-and-runtime";
  if (roots.appStoreRoots.some((root) => pathIsInside(root, path))) return "apps-and-runtime";
  if (pathIsInside(roots.userDataDir, path) && rebuildableUserDataPath(path, roots.userDataDir)) {
    return "rebuildable";
  }
  return "conversations-and-system";
}

function classifyLegacyAppPath(path: string, legacyAppsRoot: string): OpenGroveStorageCategoryId {
  const segments = normalizedRelative(legacyAppsRoot, path).split("/");
  return segments[1]?.toLowerCase() === "workspace" ? "works-and-files" : "apps-and-runtime";
}

function isCleanupCandidate(
  path: string,
  roots: ResolvedStorageRoots,
  stateBackupPaths: readonly string[],
  rebuildableFilePaths: ReadonlySet<string>,
): boolean {
  if (stateBackupPaths.some((root) => pathIsInside(root, path))) return false;
  if (rebuildableFilePaths.has(resolve(path))) return true;
  if (isWorkspaceMediaCache(path, roots)) return true;
  if (roots.updaterCacheDir && pathIsInside(roots.updaterCacheDir, path)) return true;
  if (!pathIsInside(roots.userDataDir, path)) return false;
  const segments = normalizedRelative(roots.userDataDir, path).split("/");
  const topLevel = segments[0]?.toLowerCase() ?? "";
  if (["cache", "code cache", "gpucache", "dawncache", "dawnwebgpucache", "dawngraphitecache"].includes(topLevel)) {
    return true;
  }
  return topLevel === "logs" && /\.log\.\d+$/.test(segments.at(-1) ?? "");
}

function isWorkspaceMediaCache(path: string, roots: ResolvedStorageRoots): boolean {
  const workspaceRoots = [
    ...roots.externalWorkspaceRoots,
    ...discoverWorkspaceRootsForPath(path, roots.currentWorkspacesRoot),
    ...discoverWorkspaceRootsForPath(path, roots.legacyAppsRoot),
  ];
  return workspaceRoots.some((workspaceRoot) => pathIsInside(mcpAppMediaCachePath(workspaceRoot), path));
}

function discoverWorkspaceRootsForPath(path: string, containerRoot: string): string[] {
  if (!pathIsInside(containerRoot, path)) return [];
  const segments = normalizedRelative(containerRoot, path).split("/");
  return segments.length >= 2 && segments[1]?.toLowerCase() === "workspace"
    ? [resolve(containerRoot, segments[0] ?? "", segments[1] ?? "")]
    : [];
}

function rebuildableUserDataPath(path: string, userDataDir: string): boolean {
  const topLevel = normalizedRelative(userDataDir, path).split("/")[0]?.toLowerCase() ?? "";
  return [
    "logs",
    "cache",
    "code cache",
    "gpucache",
    "dawncache",
    "dawnwebgpucache",
    "dawngraphitecache",
    "crashpad",
  ].includes(topLevel);
}

function minimalRoots(paths: readonly string[]): string[] {
  const sorted = uniquePaths(paths).sort((left, right) => left.split(sep).length - right.split(sep).length);
  const roots: string[] = [];
  for (const candidate of sorted) {
    if (!roots.some((root) => pathIsInside(root, candidate))) roots.push(candidate);
  }
  return roots;
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim()).map((path) => resolve(path)))];
}

function pathIsInside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function normalizedRelative(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).split(sep).join("/");
}

function emptyCategoryBytes(): CategoryBytes {
  return {
    "works-and-files": 0,
    "apps-and-runtime": 0,
    rebuildable: 0,
    backups: 0,
    "conversations-and-system": 0,
  };
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR"),
  );
}
