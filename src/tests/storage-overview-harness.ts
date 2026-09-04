import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectOpenGroveStorage } from "../server/storage-overview.js";
import { bridgeUserDataDirectory } from "../server/storage-paths.js";
import type { BridgeState } from "../server/bridge-types.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-storage-overview-"));

try {
  const userDataDir = join(root, "profile");
  const currentProgramsRoot = join(root, "programs");
  const currentWorkspacesRoot = join(root, "workspaces");
  const legacyProgramsRoot = join(userDataDir, "data", "app-store", "programs");
  const legacyAppsRoot = join(userDataDir, "apps");
  const stateRecoveryRoot = join(userDataDir, "data", "local-state.before-legacy-recovery");
  const recoveryMetadata = '{"version":1,"createdAt":"2026-08-28T01:28:52.000Z"}\n';

  writeSized(join(currentProgramsRoot, "story-seed", "0.2.0", "app", "index.js"), 17);
  writeSized(join(currentWorkspacesRoot, "story-seed", "workspace", "story.md"), 11);
  writeSized(join(legacyProgramsRoot, "legacy-app", "0.1.0", "app", "index.js"), 19);
  writeSized(join(legacyAppsRoot, "legacy-app.legacy-v2", "index.js"), 7);
  writeSized(join(legacyAppsRoot, "legacy-app.legacy-v2", "workspace", "draft.md"), 13);
  writeSized(join(currentWorkspacesRoot, "unmounted-app", "workspace", ".cache", "opengrove-media", "orphan.mp4"), 41);
  writeSized(join(userDataDir, "data", "local-state.sqlite"), 23);
  writeSized(join(stateRecoveryRoot, "local-state.sqlite"), 29);
  writeSized(join(stateRecoveryRoot, "state-blobs", "message.blob"), 31);
  writeText(join(stateRecoveryRoot, "recovery.json"), recoveryMetadata);

  const overview = await inspectOpenGroveStorage({
    roots: {
      userDataDir,
      programRoots: [currentProgramsRoot, legacyProgramsRoot],
      currentWorkspacesRoot,
      legacyAppsRoot,
      externalWorkspaceRoots: [],
      appStoreRoots: [join(userDataDir, "data", "app-store")],
    },
    stateBackupPaths: [stateRecoveryRoot],
  });

  assert.deepEqual(categoryMap(overview.categories), {
    "works-and-files": 65,
    "apps-and-runtime": 43,
    rebuildable: 0,
    backups: 60 + Buffer.byteLength(recoveryMetadata),
    "conversations-and-system": 23,
  });
  assert.equal(overview.backups.length, 1, "one recovery transaction must appear as one backup");
  assert.equal(
    overview.cleanupCandidates.rebuildableBytes,
    0,
    "unmounted Workspace media must not be advertised as removable when cleanup has no authority over it",
  );
  const mountedMediaOverview = await inspectOpenGroveStorage({
    roots: {
      userDataDir,
      programRoots: [currentProgramsRoot, legacyProgramsRoot],
      currentWorkspacesRoot,
      legacyAppsRoot,
      externalWorkspaceRoots: [join(currentWorkspacesRoot, "unmounted-app", "workspace")],
      appStoreRoots: [join(userDataDir, "data", "app-store")],
    },
    stateBackupPaths: [stateRecoveryRoot],
  });
  assert.equal(
    mountedMediaOverview.cleanupCandidates.rebuildableBytes,
    41,
    "the same media cache becomes removable once its Workspace is mounted and authorized",
  );
  assert.deepEqual(overview.backups[0], {
    kind: "migration",
    bytes: 60 + Buffer.byteLength(recoveryMetadata),
    createdAt: "2026-08-28T01:28:52.000Z",
  });

  const customDataDir = join(root, "custom", "data");
  assert.equal(
    bridgeUserDataDirectory({
      store: { kind: "sqlite", path: join(customDataDir, "local-state.sqlite") },
    } as BridgeState),
    customDataDir,
    "a custom data directory named 'data' must not promote unrelated parent files into the storage scan",
  );

  const broadWorkspaceOverview = await inspectOpenGroveStorage({
    roots: {
      userDataDir,
      programRoots: [currentProgramsRoot],
      currentWorkspacesRoot,
      legacyAppsRoot,
      externalWorkspaceRoots: [root],
      appStoreRoots: [join(userDataDir, "data", "app-store")],
    },
  });
  assert.equal(
    categoryMap(broadWorkspaceOverview.categories)["conversations-and-system"],
    23 + 60 + Buffer.byteLength(recoveryMetadata),
    "a broad Workspace ancestor must not swallow the more specific user-data category",
  );

  if (process.platform !== "win32") {
    const inaccessibleRoot = join(root, "inaccessible-workspace");
    writeSized(join(inaccessibleRoot, "private.txt"), 37);
    chmodSync(inaccessibleRoot, 0);
    try {
      const partialOverview = await inspectOpenGroveStorage({
        roots: {
          userDataDir,
          programRoots: [currentProgramsRoot],
          currentWorkspacesRoot,
          legacyAppsRoot,
          externalWorkspaceRoots: [inaccessibleRoot],
          appStoreRoots: [],
        },
      });
      assert.ok(partialOverview.totalBytes > 0, "one unreadable root must not hide all readable storage totals");
    } finally {
      chmodSync(inaccessibleRoot, 0o700);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("storage overview harness ok");

function writeSized(path: string, bytes: number): void {
  writeText(path, "x".repeat(bytes));
}

function writeText(path: string, value: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function categoryMap(categories: Array<{ id: string; bytes: number }>): Record<string, number> {
  return Object.fromEntries(categories.map((category) => [category.id, category.bytes]));
}
