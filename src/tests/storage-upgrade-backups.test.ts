import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateStoreAppLayoutsV2, retireLegacyStoreAppLayoutsV2 } from "../server/migrations/store-app-layout-v2.js";
import {
  discoverStoreAppLayoutBackups,
  readPersistedBackupMounts,
  recordStoreAppLayoutBackups,
  STORE_APP_LAYOUT_BACKUP_RECEIPT,
  type StoreAppBackupContext,
} from "../server/migrations/store-app-layout-v2-backups.js";
import {
  deleteConfirmedUpgradeBackups,
  inspectUpgradeBackups,
  prepareUpgradeBackupDeletion,
} from "../server/storage-upgrade-backups.js";
import { inspectOpenGroveStorage } from "../server/storage-overview.js";

function fixture(receipt = true) {
  const root = mkdtempSync(join(tmpdir(), "opengrove-upgrade-backups-"));
  const roots = {
    legacyProgramsRoot: join(root, "old-programs"),
    legacyWorkspacesRoot: join(root, "apps"),
    programsRoot: join(root, "programs"),
    workspacesRoot: join(root, "workspaces"),
  };
  const appId = "backup-app";
  const source = join(roots.legacyWorkspacesRoot, appId);
  mkdirSync(join(source, "workspace"), { recursive: true });
  writeFileSync(join(source, "workspace", "story.md"), "my original story");
  writeFileSync(
    join(source, "opengrove.app.json"),
    JSON.stringify({ id: appId, ui: { surface: "file-workbench", workspace: "workspace" } }),
  );
  writeFileSync(
    join(source, ".opengrove-store-package.json"),
    JSON.stringify({ schemaVersion: 1, source: "registry", appId, version: "1.0.0", archiveSha256: "a".repeat(64) }),
  );
  const oldMount = { id: appId, path: source, enabled: true };
  const migration = migrateStoreAppLayoutsV2({ roots, mountedApps: [oldMount] });
  assert.deepEqual(migration.failures, []);
  const settingsPath = join(root, "bridge-settings.json");
  const mountedApps = migration.mountedApps;
  const initializedMountedApps = mountedApps.map((mount) => ({ ...mount }));
  writeFileSync(settingsPath, JSON.stringify({ mountedApps }));
  const context = (): StoreAppBackupContext => ({
    roots,
    mountedApps,
    initializedMountedApps,
    persistedMountedApps: readPersistedBackupMounts(settingsPath),
    appInitialized: true,
  });
  const retirement = retireLegacyStoreAppLayoutsV2({ roots, mountedApps });
  assert.equal(retirement.renamed.length, 1);
  if (receipt) recordStoreAppLayoutBackups(retirement.renamed, context(), [appId]);
  const stateBackup = join(root, "local-state.before-sqlite-migration.json");
  writeFileSync(stateBackup, "database backup");
  const owner = {};
  const input = () => ({ context: context(), stateBackupPaths: existsSync(stateBackup) ? [stateBackup] : [] });
  return {
    root,
    roots,
    source,
    oldMount,
    mountedApps,
    initializedMountedApps,
    settingsPath,
    context,
    owner,
    input,
    stateBackup,
    backup: retirement.renamed[0]!,
    workspace: mountedApps[0]!.workspacePath!,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("verified App backups share Update backups accounting and confirmed deletion with database backups", async () => {
  const f = fixture();
  try {
    const items = await inspectUpgradeBackups(f.input());
    const layout = items.find((item) => item.backup.kind === "app-layout")!;
    assert.equal(layout.backup.kind === "app-layout" && layout.backup.state, "verified");
    const overview = await inspectOpenGroveStorage({
      roots: {
        userDataDir: f.root,
        programRoots: [f.roots.programsRoot],
        currentWorkspacesRoot: f.roots.workspacesRoot,
        legacyAppsRoot: f.roots.legacyWorkspacesRoot,
        externalWorkspaceRoots: [],
        appStoreRoots: [],
      },
      stateBackupPaths: [f.stateBackup],
      appLayoutBackups: items.flatMap((item) =>
        item.backup.kind === "app-layout" ? [{ path: item.path, backup: item.backup }] : [],
      ),
    });
    assert.equal(
      overview.categories.find((item) => item.id === "works-and-files")?.bytes,
      17,
      "the retained old story must no longer count as a live work",
    );
    assert.equal(overview.categories.find((item) => item.id === "backups")?.bytes, layout.backup.bytes + 15);
    assert.equal(overview.cleanupCandidates.rebuildableBytes, 0);
    await assert.rejects(deleteConfirmedUpgradeBackups(f.owner, undefined, f.input), /confirmation_required/);
    const preview = await prepareUpgradeBackupDeletion(f.owner, f.input);
    assert.equal(preview.backups.length, 2);
    assert.deepEqual(preview.protectedBackups, []);
    assert.equal(existsSync(f.backup), true, "preview never deletes data");
    const deleted = await deleteConfirmedUpgradeBackups(f.owner, preview.token, f.input);
    assert.equal(deleted.removedFiles, 2);
    assert.equal(deleted.retainedFiles, 0);
    assert.equal(existsSync(f.backup), false);
    assert.equal(readFileSync(join(f.workspace, "story.md"), "utf8"), "my original story");
    await assert.rejects(deleteConfirmedUpgradeBackups(f.owner, preview.token, f.input), /confirmation_required/);
  } finally {
    f.close();
  }
});

test("pre-receipt backups verify current activation without certifying historical content", async () => {
  const f = fixture(false);
  try {
    assert.equal(discoverStoreAppLayoutBackups(f.context())[0]?.backup.state, "unverified");
    const preview = await prepareUpgradeBackupDeletion(f.owner, f.input);
    assert.equal(preview.backups.length, 2);
    assert.equal(
      JSON.parse(readFileSync(join(f.backup, STORE_APP_LAYOUT_BACKUP_RECEIPT), "utf8")).verification,
      "activation",
    );
  } finally {
    f.close();
  }
});

for (const change of ["add", "edit", "delete"] as const) {
  test(`normal Workspace ${change} does not prevent confirmed deletion of an older backup`, async () => {
    const f = fixture(false);
    try {
      if (change === "add") writeFileSync(join(f.workspace, "new.md"), "new work");
      if (change === "edit") writeFileSync(join(f.workspace, "story.md"), "my revised story");
      if (change === "delete") rmSync(join(f.workspace, "story.md"));
      const preview = await prepareUpgradeBackupDeletion(f.owner, f.input);
      assert.equal(preview.backups.length, 2, "only activation and retirement determine backup eligibility");
      assert.deepEqual(preview.protectedBackups, []);
      assert.equal(existsSync(f.backup), true, "the old version remains available until the user confirms");
      writeFileSync(join(f.workspace, "after-preview.md"), "work continued after preview");
      const removed = await deleteConfirmedUpgradeBackups(f.owner, preview.token, f.input);
      assert.equal(removed.removedFiles, 2);
      assert.equal(existsSync(f.backup), false);
      assert.equal(readFileSync(join(f.workspace, "after-preview.md"), "utf8"), "work continued after preview");
      if (change === "add") assert.equal(readFileSync(join(f.workspace, "new.md"), "utf8"), "new work");
      if (change === "edit") assert.equal(readFileSync(join(f.workspace, "story.md"), "utf8"), "my revised story");
      if (change === "delete") assert.equal(existsSync(join(f.workspace, "story.md")), false);
    } finally {
      f.close();
    }
  });
}

for (const scenario of [
  "unsaved-switch",
  "runtime-not-switched",
  "missing-target",
  "replaced-target",
  "reference",
  "nested-reference",
  "corrupt-receipt",
] as const) {
  test(`App backup remains protected: ${scenario}`, async () => {
    const f = fixture();
    try {
      if (scenario === "unsaved-switch") writeFileSync(f.settingsPath, JSON.stringify({ mountedApps: [f.oldMount] }));
      if (scenario === "runtime-not-switched") f.initializedMountedApps[0] = f.oldMount;
      if (scenario === "missing-target" || scenario === "replaced-target") {
        renameSync(f.workspace, `${f.workspace}-retained`);
        if (scenario === "replaced-target") mkdirSync(f.workspace);
      }
      if (scenario === "reference") {
        f.mountedApps.push({ id: "another-app", path: f.backup, enabled: false });
        writeFileSync(f.settingsPath, JSON.stringify({ mountedApps: f.mountedApps }));
      }
      if (scenario === "nested-reference")
        symlinkSync(f.backup, join(f.workspace, "old-files"), process.platform === "win32" ? "junction" : "dir");
      if (scenario === "corrupt-receipt") writeFileSync(join(f.backup, STORE_APP_LAYOUT_BACKUP_RECEIPT), "{invalid");
      const preview = await prepareUpgradeBackupDeletion(f.owner, f.input);
      assert.equal(preview.backups.length, 1, "only the independent database backup is eligible");
      assert.equal(preview.protectedBackups.length, 1);
      assert.equal(existsSync(f.backup), true);
    } finally {
      f.close();
    }
  });
}

for (const scenario of ["workspace-switch", "backup-write", "backup-link-substitution"] as const) {
  test(`stale confirmation deletes nothing: ${scenario}`, async () => {
    const f = fixture();
    try {
      const preview = await prepareUpgradeBackupDeletion(f.owner, f.input);
      const sentinel = join(f.root, "external");
      mkdirSync(sentinel);
      writeFileSync(join(sentinel, "keep"), "external data");
      if (scenario === "workspace-switch") f.mountedApps[0]!.workspacePath = sentinel;
      if (scenario === "backup-write") writeFileSync(join(f.backup, "workspace", "new.md"), "new backup data");
      if (scenario === "backup-link-substitution") {
        renameSync(f.backup, `${f.backup}-retained`);
        symlinkSync(sentinel, f.backup, process.platform === "win32" ? "junction" : "dir");
      }
      await assert.rejects(deleteConfirmedUpgradeBackups(f.owner, preview.token, f.input), /plan_stale/);
      assert.equal(existsSync(f.stateBackup), true, "validate the complete confirmed set before deleting any item");
      assert.equal(readFileSync(join(sentinel, "keep"), "utf8"), "external data");
    } finally {
      f.close();
    }
  });
}

test("deletion removes a backed-up link without traversing its external target", async () => {
  const f = fixture();
  try {
    const external = join(f.root, "external");
    mkdirSync(external);
    writeFileSync(join(external, "keep"), "external data");
    symlinkSync(external, join(f.backup, "linked-folder"), process.platform === "win32" ? "junction" : "dir");
    const preview = await prepareUpgradeBackupDeletion(f.owner, f.input);
    assert.equal((await deleteConfirmedUpgradeBackups(f.owner, preview.token, f.input)).removedFiles, 2);
    assert.equal(readFileSync(join(external, "keep"), "utf8"), "external data");
  } finally {
    f.close();
  }
});

test("later retirement cannot mint evidence without copy validation in that activation", () => {
  const f = fixture(false);
  try {
    recordStoreAppLayoutBackups([f.backup], f.context(), []);
    assert.equal(existsSync(join(f.backup, STORE_APP_LAYOUT_BACKUP_RECEIPT)), false);
  } finally {
    f.close();
  }
});

test("database backups referenced from a Workspace cannot be deleted", async () => {
  const f = fixture();
  try {
    f.mountedApps.push({ id: "database-recovery", path: f.stateBackup, enabled: false });
    await assert.rejects(prepareUpgradeBackupDeletion(f.owner, f.input), /storage_backup_active_reference/);
    assert.equal(existsSync(f.stateBackup), true);
    assert.equal(existsSync(f.backup), true);
  } finally {
    f.close();
  }
});

test("partial deletion preserves the receipt and keeps the remaining backup manageable", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const f = fixture();
  const oldWorkspace = join(f.backup, "workspace");
  try {
    chmodSync(oldWorkspace, 0o500);
    const preview = await prepareUpgradeBackupDeletion(f.owner, f.input);
    const result = await deleteConfirmedUpgradeBackups(f.owner, preview.token, f.input);
    assert.equal(result.retainedFiles, 1);
    assert.equal(result.removedFiles, 1);
    assert.equal(existsSync(join(f.backup, STORE_APP_LAYOUT_BACKUP_RECEIPT)), true);
    const retained = await inspectUpgradeBackups(f.input());
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.backup.kind, "app-layout");
    assert.ok(retained[0]!.backup.bytes >= 17);
    assert.equal(readFileSync(join(f.workspace, "story.md"), "utf8"), "my original story");
  } finally {
    if (existsSync(oldWorkspace)) chmodSync(oldWorkspace, 0o700);
    f.close();
  }
});
