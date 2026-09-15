import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writePrivateJsonAtomically } from "../../storage/private-file.js";
import type { OpenGroveAppLayoutBackup } from "../../storage/storage-overview-contract.js";
import { appStoreAppDirectoryName, isValidAppStoreAppId } from "../app-store-app-id.js";
import { readAppStorePackageInstallMarker } from "../app-store-install-marker.js";
import type { BridgeMountedAppSettings } from "../bridge-types.js";
import { inspectLegacyStoreProgramMetadata, type StoreAppLayoutRoots } from "./store-app-layout-v2.js";

/**
 * Supports: retained layout-v2 backups created by OpenGrove >=0.6.6, including pre-receipt backups.
 * Remove when: backups produced by OpenGrove >=0.6.6 no longer need management; no scheduled release.
 * Activation and backup ownership: https://github.com/open-grove/opengrove/issues/95
 */
export const STORE_APP_LAYOUT_BACKUP_RECEIPT = ".opengrove-layout-backup.json";
const SUFFIX = ".legacy-v2";

export interface StoreAppBackupContext {
  roots: StoreAppLayoutRoots;
  mountedApps: BridgeMountedAppSettings[];
  persistedMountedApps?: BridgeMountedAppSettings[];
  appInitialized: boolean;
  initializedMountedApps?: BridgeMountedAppSettings[];
}

export interface StoreAppLayoutBackupCandidate {
  path: string;
  sourcePath: string;
  attributed: boolean;
  backup: OpenGroveAppLayoutBackup;
}

interface BackupReceipt {
  schemaVersion: 1;
  kind: "store-app-layout-v2-backup";
  verification: "migration" | "activation";
  appId: string;
  sourcePath: string;
  workspacePath: string;
  verifiedAt: string;
  createdAt: string;
  workspaceIdentity: string;
  backupIdentity: string;
}

/** Read-only and fail-closed: never use loadBridgeSettings, which may repair corrupt settings. */
export function readPersistedBackupMounts(path: string): BridgeMountedAppSettings[] | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(data) || !Array.isArray(data.mountedApps)) return undefined;
    const mounts: BridgeMountedAppSettings[] = [];
    for (const value of data.mountedApps) {
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.path !== "string" ||
        !value.path.trim() ||
        typeof value.enabled !== "boolean" ||
        (value.workspacePath !== undefined && typeof value.workspacePath !== "string")
      )
        return undefined;
      mounts.push({
        id: value.id,
        path: value.path,
        enabled: value.enabled,
        ...(typeof value.workspacePath === "string" ? { workspacePath: value.workspacePath } : {}),
      });
    }
    return new Set(mounts.map((mount) => mount.id)).size === mounts.length ? mounts : undefined;
  } catch {
    // non-critical-fallback: unavailable activation evidence protects every App backup.
    return undefined;
  }
}

export function discoverStoreAppLayoutBackups(context: StoreAppBackupContext): StoreAppLayoutBackupCandidate[] {
  const result: StoreAppLayoutBackupCandidate[] = [];
  const programEvidence = new Set<string>();
  for (const bucket of directories(context.roots.legacyProgramsRoot)) {
    if (!/^[a-f0-9]{64}$/.test(basename(bucket))) continue;
    for (const path of directories(bucket).filter((path) => path.endsWith(SUFFIX))) {
      const appRoot = join(path, "app");
      const marker = readAppStorePackageInstallMarker(appRoot);
      const receipt = readReceipt(path);
      const appId = typeof marker?.appId === "string" ? marker.appId : (receipt?.appId ?? "");
      if (!isValidAppStoreAppId(appId)) continue;
      const metadata = backupProgramMetadata(appId, appRoot);
      if (!metadata) {
        // A partial deletion may leave only its receipt. Keep it visible and inspectable.
        result.push(candidate(path, appId, Boolean(receipt), context));
        continue;
      }
      const oldWorkspace = join(context.roots.legacyWorkspacesRoot, appId, metadata.workspaceRelativePath);
      const link = join(appRoot, metadata.workspaceRelativePath);
      if (entry(link)?.isSymbolicLink() && sameLocation(resolve(dirname(link), readlinkSync(link)), oldWorkspace)) {
        programEvidence.add(appId);
      }
      result.push(candidate(path, appId, true, context));
    }
  }
  for (const path of directories(context.roots.legacyWorkspacesRoot).filter((path) => path.endsWith(SUFFIX))) {
    const appId = basename(path).slice(0, -SUFFIX.length);
    if (!isValidAppStoreAppId(appId)) continue;
    const metadata = backupProgramMetadata(appId, path);
    const receipt = readReceipt(path);
    result.push(candidate(path, appId, Boolean(metadata || programEvidence.has(appId) || receipt), context));
  }
  return result;
}

function backupProgramMetadata(appId: string, path: string) {
  try {
    return inspectLegacyStoreProgramMetadata(appId, path);
  } catch (error) {
    console.warn("store_app_layout_backup_metadata_unavailable", { appId, error: String(error) });
    return undefined;
  }
}

function candidate(
  path: string,
  appId: string,
  attributed: boolean,
  context: StoreAppBackupContext,
): StoreAppLayoutBackupCandidate {
  const sourcePath = path.slice(0, -SUFFIX.length);
  const backup: OpenGroveAppLayoutBackup = {
    kind: "app-layout",
    id: createHash("sha256").update(resolve(path)).digest("hex"),
    appId,
    bytes: 0,
    createdAt: entry(path)!.ctime.toISOString(),
    state: "unverified",
    reason: "missing_receipt",
  };
  const item = {
    path: resolve(path),
    sourcePath,
    attributed,
    backup,
  };
  const issue = backupActivationIssue(item, context);
  if (issue) {
    backup.state = "protected";
    backup.reason = issue;
  } else {
    const mount = context.mountedApps.find((mount) => mount.id === appId)!;
    backup.workspacePath = resolve(mount.workspacePath!);
    const receipt = readReceipt(path);
    if (entry(join(path, STORE_APP_LAYOUT_BACKUP_RECEIPT)) && !receipt) {
      backup.state = "protected";
      backup.reason = "unsafe_path";
      return item;
    }
    if (
      receipt &&
      receipt.appId === appId &&
      sameLocation(receipt.sourcePath, sourcePath) &&
      sameLocation(receipt.workspacePath, mount.workspacePath!) &&
      receipt.workspaceIdentity === directoryIdentity(mount.workspacePath!) &&
      receipt.backupIdentity === directoryIdentity(path)
    ) {
      backup.state = "verified";
      delete backup.reason;
      backup.createdAt = receipt.createdAt;
    } else if (receipt) {
      backup.state = "protected";
      backup.reason = "workspace_unavailable";
    }
  }
  return item;
}

export function backupActivationIssue(
  item: StoreAppLayoutBackupCandidate,
  context: StoreAppBackupContext,
): OpenGroveAppLayoutBackup["reason"] {
  if (!context.appInitialized || !context.persistedMountedApps || !context.initializedMountedApps)
    return "activation_unconfirmed";
  const mount = context.mountedApps.find((mount) => mount.id === item.backup.appId);
  const saved = context.persistedMountedApps.find((mount) => mount.id === item.backup.appId);
  const initialized = context.initializedMountedApps.find((mount) => mount.id === item.backup.appId);
  if (
    !mount?.enabled ||
    mount.policyIssue ||
    !saved?.enabled ||
    !mount.workspacePath ||
    !saved.workspacePath ||
    !sameLocation(mount.path, saved.path) ||
    !sameLocation(mount.workspacePath, saved.workspacePath)
  ) {
    return "activation_unconfirmed";
  }
  if (
    !initialized?.enabled ||
    initialized.policyIssue ||
    !initialized.workspacePath ||
    !sameLocation(mount.path, initialized.path) ||
    !sameLocation(mount.workspacePath, initialized.workspacePath)
  )
    return "activation_unconfirmed";
  const appId = item.backup.appId;
  const programContainer = join(context.roots.programsRoot, appStoreAppDirectoryName(appId));
  const workspaceContainer = join(context.roots.workspacesRoot, appStoreAppDirectoryName(appId));
  const metadata = backupProgramMetadata(appId, mount.path);
  if (
    !metadata ||
    !ordinaryDirectory(mount.path) ||
    !ordinaryDirectory(mount.workspacePath) ||
    !inside(programContainer, mount.path) ||
    !inside(location(programContainer), location(mount.path)) ||
    !inside(workspaceContainer, mount.workspacePath) ||
    !inside(location(workspaceContainer), location(mount.workspacePath)) ||
    !sameLocation(join(workspaceContainer, metadata.workspaceRelativePath), mount.workspacePath)
  )
    return "workspace_unavailable";
  const binding = join(mount.path, metadata.workspaceRelativePath);
  if (!entry(binding)?.isSymbolicLink() || !sameLocation(binding, mount.workspacePath)) return "workspace_unavailable";
  if (!ordinaryDirectory(item.path) || !sameLocation(dirname(item.path), dirname(item.sourcePath)))
    return "unsafe_path";
  if (entry(item.sourcePath)) return "active_reference";
  for (const other of [...context.mountedApps, ...context.persistedMountedApps, ...context.initializedMountedApps]) {
    const roots = [other.path, ...(other.workspacePath ? [other.workspacePath] : [])];
    for (const root of roots) {
      if (overlaps(root, item.path) || overlaps(root, item.sourcePath)) return "active_reference";
    }
  }
  return undefined;
}

/** Called only for paths just retired after persisted activation and App recreation. */
export function recordStoreAppLayoutBackups(
  paths: string[],
  context: StoreAppBackupContext,
  validatedAppIds: string[],
): void {
  if (!paths.length) return;
  const retired = new Set(paths.map((path) => resolve(path)));
  for (const item of discoverStoreAppLayoutBackups(context)) {
    if (retired.has(item.path) && validatedAppIds.includes(item.backup.appId) && !backupActivationIssue(item, context))
      writeReceipt(item, context, "migration");
  }
}

/** Verify current activation, not content equality with a historical snapshot. */
export function verifyStoreAppBackupActivation(
  item: StoreAppLayoutBackupCandidate,
  context: StoreAppBackupContext,
): boolean {
  if (!item.attributed || backupActivationIssue(item, context)) return false;
  try {
    // Older versions did not record migration completion. Record only what we can verify now.
    // Normal edits, new files, and intentional deletions in the current Workspace are allowed.
    writeReceipt(item, context, "activation");
    return true;
  } catch (error) {
    console.warn("store_app_layout_backup_activation_verification_failed", {
      appId: item.backup.appId,
      error: String(error),
    });
    return false;
  }
}

function writeReceipt(
  item: StoreAppLayoutBackupCandidate,
  context: StoreAppBackupContext,
  verification: BackupReceipt["verification"],
): void {
  const workspacePath = context.mountedApps.find((mount) => mount.id === item.backup.appId)!.workspacePath!;
  const receipt: BackupReceipt = {
    schemaVersion: 1,
    kind: "store-app-layout-v2-backup",
    verification,
    appId: item.backup.appId,
    sourcePath: resolve(item.sourcePath),
    workspacePath: resolve(workspacePath),
    verifiedAt: new Date().toISOString(),
    createdAt: item.backup.createdAt,
    workspaceIdentity: directoryIdentity(workspacePath),
    backupIdentity: directoryIdentity(item.path),
  };
  writePrivateJsonAtomically(join(item.path, STORE_APP_LAYOUT_BACKUP_RECEIPT), receipt);
}

function readReceipt(path: string): BackupReceipt | undefined {
  try {
    const file = join(path, STORE_APP_LAYOUT_BACKUP_RECEIPT);
    if (!entry(file)?.isFile() || entry(file)?.isSymbolicLink()) return undefined;
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.kind !== "store-app-layout-v2-backup" ||
      (value.verification !== "migration" && value.verification !== "activation") ||
      typeof value.appId !== "string" ||
      typeof value.sourcePath !== "string" ||
      !isAbsolute(value.sourcePath) ||
      typeof value.workspacePath !== "string" ||
      !isAbsolute(value.workspacePath) ||
      typeof value.workspaceIdentity !== "string" ||
      typeof value.backupIdentity !== "string" ||
      typeof value.verifiedAt !== "string" ||
      typeof value.createdAt !== "string" ||
      Number.isNaN(Date.parse(value.createdAt)) ||
      Number.isNaN(Date.parse(value.verifiedAt))
    )
      return undefined;
    return value as unknown as BackupReceipt;
  } catch {
    // non-critical-fallback: missing or malformed evidence never authorizes deletion.
    return undefined;
  }
}

/** No links are followed. Metadata fingerprints bind the confirmation to the inspected tree. */
export async function inspectBackupTree(root: string): Promise<{ bytes: number; fingerprint: string }> {
  let bytes = 0;
  const digest = createHash("sha256");
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path, { bigint: true });
    digest.update(
      JSON.stringify([
        relative(root, path),
        String(stat.dev),
        String(stat.ino),
        String(stat.mode),
        String(stat.size),
        String(stat.mtimeNs),
        String(stat.ctimeNs),
      ]),
    );
    if (stat.isSymbolicLink()) {
      digest.update(await readlink(path));
      return;
    }
    if (stat.isFile()) {
      bytes += Number(stat.size);
      return;
    }
    if (!stat.isDirectory()) throw new Error("storage_backup_unsafe_entry");
    for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  };
  await visit(root);
  return { bytes, fingerprint: digest.digest("hex") };
}

export async function mountedBackupReferences(context: StoreAppBackupContext): Promise<string[]> {
  const references = new Set<string>();
  const visited = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (visited.has(path)) return;
    visited.add(path);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (fsCode(error) === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      references.add(resolve(dirname(path), await readlink(path)));
      references.add(location(path));
    } else if (stat.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
    }
  };
  for (const mount of [
    ...context.mountedApps,
    ...(context.persistedMountedApps ?? []),
    ...(context.initializedMountedApps ?? []),
  ]) {
    for (const root of [mount.path, ...(mount.workspacePath ? [mount.workspacePath] : [])]) {
      references.add(root);
      await visit(resolve(root));
    }
  }
  return [...references];
}

export function backupHasReferences(
  item: Pick<StoreAppLayoutBackupCandidate, "path" | "sourcePath">,
  references: string[],
): boolean {
  return references.some((path) => overlaps(path, item.path) || overlaps(path, item.sourcePath));
}

function directories(root: string): string[] {
  try {
    if (!ordinaryDirectory(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((value) => value.isDirectory() && !value.isSymbolicLink())
      .map((value) => join(root, value.name));
  } catch (error) {
    if (fsCode(error) === "ENOENT") return [];
    throw error;
  }
}
function entry(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (fsCode(error) === "ENOENT") return undefined;
    throw error;
  }
}
function ordinaryDirectory(path: string): boolean {
  const stat = entry(path);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}
function directoryIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function location(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (fsCode(error) !== "ENOENT") throw error;
    const parent = dirname(resolve(path));
    return parent === resolve(path) ? resolve(path) : join(location(parent), basename(path));
  }
}
function sameLocation(left: string, right: string): boolean {
  return inside(location(left), location(right)) && inside(location(right), location(left));
}
function overlaps(left: string, right: string): boolean {
  return inside(location(left), location(right)) || inside(location(right), location(left));
}
function fsCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
