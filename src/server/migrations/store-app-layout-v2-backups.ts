import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writePrivateJsonAtomically } from "../../storage/private-file.js";
import type { OpenGroveAppLayoutBackup } from "../../storage/storage-overview-contract.js";
import { appStoreAppDirectoryName, isValidAppStoreAppId } from "../app-store-app-id.js";
import { readAppStorePackageInstallMarker } from "../app-store-install-marker.js";
import type { BridgeMountedAppSettings } from "../bridge-types.js";
import { parsePersistedAppSettings } from "../bridge-settings-store.js";
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
  uninstalledAppIds?: string[];
  persistedUninstalledAppIds?: string[];
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
  verification: "migration" | "activation" | "retirement";
  appId: string;
  sourcePath: string;
  workspacePath?: string;
  verifiedAt: string;
  createdAt: string;
  workspaceIdentity?: string;
  backupIdentity: string;
}

/** Read-only and fail-closed: never use loadBridgeSettings, which may repair corrupt settings. */
export function readPersistedBackupSettings(path: string): ReturnType<typeof parsePersistedAppSettings> | undefined {
  try {
    return parsePersistedAppSettings(JSON.parse(readFileSync(path, "utf8")));
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
        result.push(candidate(path, appId, Boolean(receipt), context, receipt));
        continue;
      }
      const oldWorkspace = join(context.roots.legacyWorkspacesRoot, appId, metadata.workspaceRelativePath);
      const link = join(appRoot, metadata.workspaceRelativePath);
      if (entry(link)?.isSymbolicLink() && sameLocation(resolve(dirname(link), readlinkSync(link)), oldWorkspace)) {
        programEvidence.add(appId);
      }
      result.push(candidate(path, appId, true, context, receipt));
    }
  }
  for (const path of directories(context.roots.legacyWorkspacesRoot).filter((path) => path.endsWith(SUFFIX))) {
    const appId = basename(path).slice(0, -SUFFIX.length);
    if (!isValidAppStoreAppId(appId)) continue;
    const metadata = backupProgramMetadata(appId, path);
    const receipt = readReceipt(path);
    result.push(candidate(path, appId, Boolean(metadata || programEvidence.has(appId) || receipt), context, receipt));
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
  receipt: BackupReceipt | undefined,
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
    const mount = context.mountedApps.find((mount) => mount.id === appId);
    backup.appStatus = mount ? (mount.enabled ? "active" : "disabled") : "uninstalled";
    if (mount?.workspacePath) backup.workspacePath = resolve(mount.workspacePath);
    if (entry(join(path, STORE_APP_LAYOUT_BACKUP_RECEIPT)) && !receipt) {
      backup.state = "protected";
      backup.reason = "unsafe_path";
      return item;
    }
    if (
      receipt &&
      (receipt.appId !== appId ||
        !sameLocation(receipt.sourcePath, sourcePath) ||
        receipt.backupIdentity !== directoryIdentity(path))
    ) {
      backup.state = "protected";
      backup.reason = "unsafe_path";
      return item;
    }
    if (
      attributed &&
      (!receipt ||
        backup.appStatus === "uninstalled" ||
        (receipt.workspacePath !== undefined &&
          mount?.workspacePath !== undefined &&
          sameLocation(receipt.workspacePath, mount.workspacePath) &&
          receipt.workspaceIdentity === directoryIdentity(mount.workspacePath)))
    ) {
      backup.state = "verified";
      delete backup.reason;
      if (receipt) backup.createdAt = receipt.createdAt;
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
  if (!ordinaryDirectory(item.path) || !sameLocation(dirname(item.path), dirname(item.sourcePath)))
    return "unsafe_path";
  if (entry(item.sourcePath)) return "active_reference";
  try {
    for (const other of [...context.mountedApps, ...context.persistedMountedApps, ...context.initializedMountedApps]) {
      for (const root of [other.path, ...(other.workspacePath ? [other.workspacePath] : [])]) {
        if (overlaps(root, item.path) || overlaps(root, item.sourcePath)) return "active_reference";
      }
    }
  } catch (error) {
    console.warn("storage_backup_reference_scan_failed", { appId: item.backup.appId, error: String(error) });
    return "reference_scan_failed";
  }
  if (!mount && !saved && !initialized) {
    // Absence alone is not proof of uninstall: require the product's saved uninstall record.
    return context.uninstalledAppIds?.includes(item.backup.appId) &&
      context.persistedUninstalledAppIds?.includes(item.backup.appId)
      ? undefined
      : "app_not_mounted";
  }
  if (
    !mount ||
    !saved ||
    !initialized ||
    mount.policyIssue ||
    initialized.policyIssue ||
    mount.enabled !== saved.enabled ||
    mount.enabled !== initialized.enabled ||
    !mount.workspacePath ||
    !saved.workspacePath ||
    !initialized.workspacePath ||
    !sameLocation(mount.path, saved.path) ||
    !sameLocation(mount.path, initialized.path) ||
    !sameLocation(mount.workspacePath, saved.workspacePath) ||
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
    if (
      retired.has(item.path) &&
      validatedAppIds.includes(item.backup.appId) &&
      !backupActivationIssue(item, context)
    ) {
      try {
        writeReceipt(item, context, "migration");
      } catch (error) {
        // Retirement already succeeded. Receipt failure must not be reported as a deferred rename.
        console.warn("store_app_layout_backup_receipt_failed", {
          appId: item.backup.appId,
          path: item.path,
          error: String(error),
        });
      }
    }
  }
}

/** Confirmed deletion only: preserve ownership evidence if removal is interrupted. */
export function recordConfirmedStoreAppBackup(
  item: StoreAppLayoutBackupCandidate,
  context: StoreAppBackupContext,
): void {
  if (!item.attributed || item.backup.state !== "verified" || backupActivationIssue(item, context))
    throw new Error("storage_backup_plan_stale");
  if (!entry(join(item.path, STORE_APP_LAYOUT_BACKUP_RECEIPT)))
    writeReceipt(item, context, item.backup.appStatus === "uninstalled" ? "retirement" : "activation");
}

function writeReceipt(
  item: StoreAppLayoutBackupCandidate,
  context: StoreAppBackupContext,
  verification: BackupReceipt["verification"],
): void {
  const workspacePath = context.mountedApps.find((mount) => mount.id === item.backup.appId)?.workspacePath;
  const receipt: BackupReceipt = {
    schemaVersion: 1,
    kind: "store-app-layout-v2-backup",
    verification,
    appId: item.backup.appId,
    sourcePath: resolve(item.sourcePath),
    ...(workspacePath
      ? { workspacePath: resolve(workspacePath), workspaceIdentity: directoryIdentity(workspacePath) }
      : {}),
    verifiedAt: new Date().toISOString(),
    createdAt: item.backup.createdAt,
    backupIdentity: directoryIdentity(item.path),
  };
  writePrivateJsonAtomically(join(item.path, STORE_APP_LAYOUT_BACKUP_RECEIPT), receipt);
}

function readReceipt(path: string): BackupReceipt | undefined {
  try {
    const file = join(path, STORE_APP_LAYOUT_BACKUP_RECEIPT);
    const stat = entry(file);
    if (!stat?.isFile() || stat.isSymbolicLink()) return undefined;
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.kind !== "store-app-layout-v2-backup" ||
      !["migration", "activation", "retirement"].includes(String(value.verification)) ||
      typeof value.appId !== "string" ||
      typeof value.sourcePath !== "string" ||
      !isAbsolute(value.sourcePath) ||
      (value.verification !== "retirement" &&
        (typeof value.workspacePath !== "string" ||
          !isAbsolute(value.workspacePath) ||
          typeof value.workspaceIdentity !== "string")) ||
      (value.verification === "retirement" &&
        (value.workspacePath !== undefined || value.workspaceIdentity !== undefined)) ||
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

export async function mountedBackupReferences(
  context: StoreAppBackupContext,
): Promise<{ references: string[]; complete: boolean }> {
  const references = new Set<string>();
  const visited = new Set<string>();
  let complete = true;
  const record = (path: string) => {
    references.add(resolve(path));
    references.add(location(path));
  };
  const visit = async (path: string): Promise<void> => {
    if (visited.has(path)) return;
    visited.add(path);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        record(resolve(dirname(path), await readlink(path)));
      } else if (stat.isDirectory()) {
        for (const name of await readdir(path)) await visit(join(path, name));
      }
    } catch (error) {
      if (fsCode(error) === "ENOENT") return;
      complete = false;
      console.warn("storage_backup_reference_scan_failed", { path, error: String(error) });
    }
  };
  for (const mount of [
    ...context.mountedApps,
    ...(context.persistedMountedApps ?? []),
    ...(context.initializedMountedApps ?? []),
  ]) {
    for (const root of [mount.path, ...(mount.workspacePath ? [mount.workspacePath] : [])]) {
      try {
        record(root);
      } catch (error) {
        complete = false;
        console.warn("storage_backup_reference_scan_failed", { path: root, error: String(error) });
      }
      await visit(resolve(root));
    }
  }
  return { references: [...references], complete };
}

export function backupHasReferences(
  item: Pick<StoreAppLayoutBackupCandidate, "path" | "sourcePath">,
  references: string[],
): boolean {
  const targets = [item.path, item.sourcePath].flatMap((path) => [resolve(path), location(path)]);
  return references.some((path) => targets.some((target) => inside(path, target) || inside(target, path)));
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
