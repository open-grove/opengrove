import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectOpenGroveStorage } from "../server/storage-overview.js";

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
    "works-and-files": 24,
    "apps-and-runtime": 43,
    rebuildable: 0,
    backups: 60 + Buffer.byteLength(recoveryMetadata),
    "conversations-and-system": 23,
  });
  assert.equal(overview.backups.length, 1, "one recovery transaction must appear as one backup");
  assert.deepEqual(overview.backups[0], {
    kind: "migration",
    bytes: 60 + Buffer.byteLength(recoveryMetadata),
    createdAt: "2026-08-28T01:28:52.000Z",
  });
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
