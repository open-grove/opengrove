import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { listStateMigrationBackupPaths, resolveStateMigrationPaths } from "../storage/migration-backups.js";
import type { OpenGroveStorageBackup, StorageBackupDeletionPreview } from "../storage/storage-overview-contract.js";
import { appStoreDataRoot, currentAppStoreProgramsRoot, defaultAppStoreRoot } from "./app-store.js";
import { bridgeSettingsPath } from "./bridge-settings-store.js";
import type { BridgeState } from "./bridge-types.js";
import { legacyAppStoreProgramsRoot, legacyAppStoreRoot } from "./migrations/store-app-layout-v2.js";
import {
  backupHasReferences,
  discoverStoreAppLayoutBackups,
  inspectBackupTree,
  mountedBackupReferences,
  readPersistedBackupMounts,
  STORE_APP_LAYOUT_BACKUP_RECEIPT,
  verifyStoreAppBackupActivation,
  type StoreAppBackupContext,
} from "./migrations/store-app-layout-v2-backups.js";

export interface UpgradeBackupInput {
  context: StoreAppBackupContext;
  stateBackupPaths: string[];
}
interface BackupItem {
  path: string;
  fingerprint: string;
  identity: string;
  backup: OpenGroveStorageBackup;
}
interface DeletionPlan {
  token: string;
  expiresAt: number;
  authority: string;
  items: BackupItem[];
}
const plans = new WeakMap<object, DeletionPlan>();

export function upgradeBackupInput(state: BridgeState): UpgradeBackupInput {
  const storeRoot = appStoreDataRoot(state);
  const paths = resolveStateMigrationPaths(state.store.path);
  return {
    context: {
      roots: {
        legacyProgramsRoot: legacyAppStoreProgramsRoot(storeRoot),
        legacyWorkspacesRoot: legacyAppStoreRoot(),
        programsRoot: currentAppStoreProgramsRoot(storeRoot),
        workspacesRoot: defaultAppStoreRoot(),
      },
      mountedApps: state.settings.mountedApps,
      persistedMountedApps: readPersistedBackupMounts(bridgeSettingsPath(state)),
      appInitialized: state.appInitialized === true,
      initializedMountedApps: state.initializedMountedApps,
    },
    stateBackupPaths:
      state.store.kind === "sqlite" ? listStateMigrationBackupPaths(paths.databasePath, paths.legacyPath) : [],
  };
}

export async function inspectUpgradeBackups(input: UpgradeBackupInput, forDeletion = false): Promise<BackupItem[]> {
  const items: BackupItem[] = [];
  const layouts = discoverStoreAppLayoutBackups(input.context);
  let references: string[] | undefined;
  try {
    references = layouts.length || forDeletion ? await mountedBackupReferences(input.context) : [];
  } catch (error) {
    console.warn("storage_backup_reference_inspection_failed", { error: String(error) });
  }
  for (const item of layouts) {
    if (!references || backupHasReferences(item, references)) {
      item.backup.state = "protected";
      item.backup.reason = references ? "active_reference" : "unsafe_path";
    }
    try {
      const tree = await inspectBackupTree(item.path);
      items.push({
        path: item.path,
        fingerprint: tree.fingerprint,
        identity: identity(item.path),
        backup: { ...item.backup, bytes: tree.bytes },
      });
    } catch (error) {
      console.warn("storage_backup_tree_inspection_failed", { appId: item.backup.appId, error: String(error) });
      items.push({
        path: item.path,
        fingerprint: "",
        identity: "",
        backup: { ...item.backup, state: "protected", reason: "unsafe_path" },
      });
    }
  }
  for (const path of input.stateBackupPaths) {
    if (forDeletion && (!references || backupHasReferences({ path, sourcePath: path }, references))) {
      throw new Error("storage_backup_active_reference");
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    const tree = await inspectBackupTree(path);
    items.push({
      path: resolve(path),
      fingerprint: tree.fingerprint,
      identity: identity(path),
      backup: { kind: "migration", bytes: tree.bytes, createdAt: stat.mtime.toISOString() },
    });
  }
  return items;
}

export async function prepareUpgradeBackupDeletion(
  owner: object,
  getInput: () => UpgradeBackupInput,
): Promise<StorageBackupDeletionPreview> {
  plans.delete(owner);
  const input = getInput();
  const authority = activationAuthority(input);
  const historical = discoverStoreAppLayoutBackups(input.context);
  const failedVerification = new Set<string>();
  for (const item of historical) {
    if (item.backup.state !== "unverified") continue;
    if (!verifyStoreAppBackupActivation(item, getInput().context)) failedVerification.add(item.backup.id);
  }
  const items = await inspectUpgradeBackups(getInput(), true);
  if (authority !== activationAuthority(getInput())) throw new Error("storage_backup_plan_stale");
  for (const item of items) {
    if (item.backup.kind === "app-layout" && failedVerification.has(item.backup.id)) {
      item.backup.state = "protected";
      item.backup.reason = "verification_failed";
    }
  }
  const eligible = items.filter((item) => item.backup.kind === "migration" || item.backup.state === "verified");
  const plan: DeletionPlan = { token: randomUUID(), expiresAt: Date.now() + 10 * 60_000, authority, items: eligible };
  plans.set(owner, plan);
  return {
    token: plan.token,
    bytes: eligible.reduce((sum, item) => sum + item.backup.bytes, 0),
    backups: eligible.map((item) => item.backup),
    protectedBackups: items.flatMap((item) =>
      item.backup.kind === "app-layout" && item.backup.state !== "verified" ? [item.backup] : [],
    ),
  };
}

/** Caller holds the Run maintenance lease. Never accept a filesystem path from the client. */
export async function deleteConfirmedUpgradeBackups(
  owner: object,
  token: string | undefined,
  getInput: () => UpgradeBackupInput,
): Promise<{ removedFiles: number; reclaimedBytes: number; retainedFiles: number }> {
  const plan = plans.get(owner);
  plans.delete(owner);
  if (!plan || !token || token !== plan.token || plan.expiresAt < Date.now())
    throw new Error("storage_backup_confirmation_required");
  if (plan.authority !== activationAuthority(getInput())) throw new Error("storage_backup_plan_stale");
  const current = await inspectUpgradeBackups(getInput(), true);
  for (const item of plan.items) {
    const fresh = current.find((entry) => entry.path === item.path);
    if (
      !fresh ||
      fresh.fingerprint !== item.fingerprint ||
      fresh.identity !== item.identity ||
      (fresh.backup.kind === "app-layout" && fresh.backup.state !== "verified")
    )
      throw new Error("storage_backup_plan_stale");
  }
  // No await between the final authority check and the filesystem mutations.
  // Other Bridge requests cannot change mounts inside this critical section.
  if (plan.authority !== activationAuthority(getInput())) throw new Error("storage_backup_plan_stale");
  let removedFiles = 0;
  let reclaimedBytes = 0;
  let retainedFiles = 0;
  for (const item of plan.items) {
    try {
      if (identity(item.path) !== item.identity || lstatSync(item.path).isSymbolicLink())
        throw new Error("storage_backup_plan_stale");
      // fs.rm removes links themselves; it never traverses linked directories.
      // Keep the discoverable name so interruption/partial failure cannot hide retained data.
      if (item.backup.kind === "app-layout") {
        // Keep attribution until all data is removed, so failures remain manageable.
        for (const name of readdirSync(item.path)) {
          if (name !== STORE_APP_LAYOUT_BACKUP_RECEIPT)
            rmSync(join(item.path, name), { recursive: true, force: false });
        }
        rmSync(join(item.path, STORE_APP_LAYOUT_BACKUP_RECEIPT), { force: false });
        rmdirSync(item.path);
      } else {
        rmSync(item.path, { recursive: true, force: false });
      }
      removedFiles += 1;
      reclaimedBytes += item.backup.bytes;
    } catch (error) {
      retainedFiles += 1;
      console.warn("storage_upgrade_backup_delete_failed", { error: String(error) });
    }
  }
  return { removedFiles, reclaimedBytes, retainedFiles };
}

function activationAuthority(input: UpgradeBackupInput): string {
  const mountFields = (mounts: StoreAppBackupContext["mountedApps"] | undefined) =>
    mounts?.map((mount) => ({
      id: mount.id,
      path: mount.path,
      workspacePath: mount.workspacePath,
      enabled: mount.enabled,
      policyIssue: mount.policyIssue,
    }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        roots: input.context.roots,
        live: mountFields(input.context.mountedApps),
        saved: mountFields(input.context.persistedMountedApps),
        running: mountFields(input.context.initializedMountedApps),
        initialized: input.context.appInitialized,
      }),
    )
    .digest("hex");
}
function identity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}
