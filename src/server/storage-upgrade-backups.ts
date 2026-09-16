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
  readPersistedBackupSettings,
  STORE_APP_LAYOUT_BACKUP_RECEIPT,
  recordConfirmedStoreAppBackup,
  type StoreAppBackupContext,
  type StoreAppLayoutBackupCandidate,
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
  layout?: StoreAppLayoutBackupCandidate;
}
interface DeletionPlan {
  token: string;
  expiresAt: number;
  authority: string;
  items: BackupItem[];
}
const plans = new WeakMap<object, DeletionPlan>();

/** Public error boundary: filesystem paths and implementation errors stay in server diagnostics. */
export function upgradeBackupErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return [
    "storage_backup_confirmation_required",
    "storage_backup_plan_stale",
    "storage_backup_active_reference",
  ].includes(code)
    ? code
    : "storage_backup_action_failed";
}

export function upgradeBackupInput(state: BridgeState): UpgradeBackupInput {
  const storeRoot = appStoreDataRoot(state);
  const paths = resolveStateMigrationPaths(state.store.path);
  const saved = readPersistedBackupSettings(bridgeSettingsPath(state));
  return {
    context: {
      roots: {
        legacyProgramsRoot: legacyAppStoreProgramsRoot(storeRoot),
        legacyWorkspacesRoot: legacyAppStoreRoot(),
        programsRoot: currentAppStoreProgramsRoot(storeRoot),
        workspacesRoot: defaultAppStoreRoot(),
      },
      mountedApps: state.settings.mountedApps,
      persistedMountedApps: saved?.mountedApps,
      uninstalledAppIds: state.settings.uninstalledStoreAppIds,
      persistedUninstalledAppIds: saved?.uninstalledStoreAppIds,
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
  const { references, complete } =
    layouts.length || forDeletion ? await mountedBackupReferences(input.context) : { references: [], complete: true };
  for (const item of layouts) {
    if (backupHasReferences(item, references)) {
      item.backup.state = "protected";
      item.backup.reason = "active_reference";
    } else if (!complete) {
      item.backup.state = "protected";
      item.backup.reason = "reference_scan_failed";
    }
    try {
      const tree = await inspectBackupTree(item.path);
      items.push({
        path: item.path,
        fingerprint: tree.fingerprint,
        identity: identity(item.path),
        backup: { ...item.backup, bytes: tree.bytes },
        layout: item,
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
    // State snapshots are independently owned by the state migration registry. An unrelated
    // unreadable App subtree does not invalidate that ownership; observed references still protect them.
    if (forDeletion && backupHasReferences({ path, sourcePath: path }, references)) {
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

/** Read-only preview: only an in-memory, single-use confirmation plan is created. */
export async function prepareUpgradeBackupDeletion(
  owner: object,
  getInput: () => UpgradeBackupInput,
): Promise<StorageBackupDeletionPreview> {
  plans.delete(owner);
  const input = getInput();
  const authority = activationAuthority(input);
  const items = await inspectUpgradeBackups(getInput(), true);
  if (authority !== activationAuthority(getInput())) throw new Error("storage_backup_plan_stale");
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
  const confirmed: BackupItem[] = [];
  for (const item of plan.items) {
    const fresh = current.find((entry) => entry.path === item.path);
    if (
      !fresh ||
      fresh.fingerprint !== item.fingerprint ||
      fresh.identity !== item.identity ||
      (fresh.backup.kind === "app-layout" && fresh.backup.state !== "verified")
    )
      throw new Error("storage_backup_plan_stale");
    confirmed.push(fresh);
  }
  // No await between the final authority check and the filesystem mutations.
  // Other Bridge requests cannot change mounts inside this critical section.
  if (plan.authority !== activationAuthority(getInput())) throw new Error("storage_backup_plan_stale");
  let removedFiles = 0;
  let reclaimedBytes = 0;
  let retainedFiles = 0;
  const partial: Array<{ item: BackupItem; addedReceiptBytes: number }> = [];
  for (const item of confirmed) {
    let addedReceiptBytes = 0;
    try {
      if (identity(item.path) !== item.identity || lstatSync(item.path).isSymbolicLink())
        throw new Error("storage_backup_plan_stale");
      // fs.rm removes links themselves; it never traverses linked directories.
      // Keep the discoverable name so interruption/partial failure cannot hide retained data.
      if (item.backup.kind === "app-layout") {
        const receiptPath = join(item.path, STORE_APP_LAYOUT_BACKUP_RECEIPT);
        const needsReceipt = !readdirSync(item.path).includes(STORE_APP_LAYOUT_BACKUP_RECEIPT);
        recordConfirmedStoreAppBackup(item.layout!, getInput().context);
        if (needsReceipt) addedReceiptBytes = lstatSync(receiptPath).size;
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
      partial.push({ item, addedReceiptBytes });
      console.warn("storage_upgrade_backup_delete_failed", { error: String(error) });
    }
  }
  // All mutations are complete. Count the original bytes removed by partial deletions too.
  for (const { item, addedReceiptBytes } of partial) {
    try {
      if (identity(item.path) !== item.identity) continue;
      const remaining = await inspectBackupTree(item.path);
      reclaimedBytes += Math.max(0, item.backup.bytes - Math.max(0, remaining.bytes - addedReceiptBytes));
    } catch (error) {
      // non-critical-fallback: when remaining bytes cannot be inspected, report only proven removals.
      console.warn("storage_backup_remaining_size_unavailable", { error: String(error) });
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
        uninstalled: input.context.uninstalledAppIds,
        persistedUninstalled: input.context.persistedUninstalledAppIds,
      }),
    )
    .digest("hex");
}
function identity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}
