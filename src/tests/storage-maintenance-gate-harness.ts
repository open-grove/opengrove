import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activeBridgeRunIds,
  beginBridgeRunMaintenance,
  bridgeRunMaintenanceActive,
  endBridgeRunMaintenance,
  registerActiveBridgeRun,
} from "../server/active-runs.js";
import { createBridgeState, saveBridgeSettings } from "../server/bridge-state.js";
import type { BridgeState } from "../server/bridge-types.js";
import { handleSettingsRoute } from "../server/routes/settings.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ContentBlobStore } from "../storage/content-blob-store.js";
import { inspectUnreferencedAppStoreArchives } from "../server/app-store.js";

const rootState = {} as BridgeState;
const scopedState = { rootState } as BridgeState;

const firstAdmission = beginBridgeRunMaintenance(scopedState);
assert.equal(firstAdmission.ok, true);
assert.equal(bridgeRunMaintenanceActive(rootState), true);
assert.throws(
  () => registerActiveBridgeRun(rootState, "run-during-maintenance"),
  /bridge_runs_paused_for_storage_maintenance/,
  "run admission remains closed until the matching maintenance lease is released",
);
assert.equal(endBridgeRunMaintenance(rootState, "wrong-lease"), false);
assert.equal(firstAdmission.ok && endBridgeRunMaintenance(scopedState, firstAdmission.leaseId), true);
assert.equal(bridgeRunMaintenanceActive(rootState), false);

const releaseRun = registerActiveBridgeRun(scopedState, "active-run");
assert.deepEqual([...activeBridgeRunIds(rootState)], ["active-run"]);
assert.deepEqual(beginBridgeRunMaintenance(rootState), {
  ok: false,
  error: "storage_maintenance_active_runs",
  activeRuns: 1,
});
releaseRun();

const secondAdmission = beginBridgeRunMaintenance(rootState);
assert.equal(secondAdmission.ok, true);
assert.deepEqual(beginBridgeRunMaintenance(rootState), {
  ok: false,
  error: "storage_maintenance_in_progress",
  activeRuns: 0,
});
assert.equal(secondAdmission.ok && endBridgeRunMaintenance(rootState, secondAdmission.leaseId), true);

const abandonedRootState = {} as BridgeState;
const beginMaintenanceAt = beginBridgeRunMaintenance as unknown as (
  state: BridgeState,
  now: number,
) => ReturnType<typeof beginBridgeRunMaintenance>;
const registerRunAt = registerActiveBridgeRun as unknown as (
  state: BridgeState,
  runId: string,
  now: number,
) => () => void;
const abandonedAdmission = beginMaintenanceAt(abandonedRootState, 1_000);
assert.equal(abandonedAdmission.ok, true);
const releaseAfterAbandonedMaintenance = registerRunAt(
  abandonedRootState,
  "run-after-abandoned-maintenance",
  Number.MAX_SAFE_INTEGER,
);
assert.deepEqual(
  [...activeBridgeRunIds(abandonedRootState)],
  ["run-after-abandoned-maintenance"],
  "an abandoned idle maintenance lease must expire instead of blocking every future Run until restart",
);
releaseAfterAbandonedMaintenance();

if (process.platform !== "win32") {
  const inaccessibleStore = mkdtempSync(join(tmpdir(), "opengrove-inaccessible-archives-"));
  const archiveRoot = join(inaccessibleStore, "archives");
  try {
    mkdirSync(archiveRoot, { recursive: true });
    writeFileSync(join(inaccessibleStore, "catalog.json"), '{"packages":[]}\n', "utf8");
    chmodSync(archiveRoot, 0);
    assert.deepEqual(
      inspectUnreferencedAppStoreArchives(inaccessibleStore),
      { candidates: [], reclaimableBytes: 0 },
      "an unreadable archive root must fail closed instead of failing the whole storage overview",
    );
  } finally {
    chmodSync(archiveRoot, 0o700);
    rmSync(inaccessibleStore, { recursive: true, force: true });
  }
}

let cleanupCalls = 0;
const routeDir = mkdtempSync(join(tmpdir(), "opengrove-storage-maintenance-route-"));
const appStoreRoot = join(routeDir, "app-store");
const currentProgramRoot = join(appStoreRoot, "programs", "a".repeat(64), "current", "app");
const obsoleteGenerationRoot = join(appStoreRoot, "programs", "b".repeat(64), "obsolete");
const obsoleteProgramRoot = join(obsoleteGenerationRoot, "app");
const workspaceRoot = join(routeDir, "apps", "current", "user-content");
const workspaceMediaCache = join(workspaceRoot, ".cache", "opengrove-media", "preview.mp4");
const workspaceUnrelatedCache = join(workspaceRoot, ".cache", "author-notes", "keep.txt");
const settingsPath = join(routeDir, "state.json");
const accountPath = join(routeDir, "account.json");
const knowledgePath = join(routeDir, "knowledge", "index.json");
const referencedArchive = join(appStoreRoot, "archives", "current", "current.tgz");
const orphanArchive = join(appStoreRoot, "archives", "obsolete", "obsolete.tgz");
for (const path of [currentProgramRoot, obsoleteProgramRoot, workspaceRoot, dirname(knowledgePath)]) {
  mkdirSync(path, { recursive: true });
}
writeFileSync(join(currentProgramRoot, "app.js"), "current app", "utf8");
writeFileSync(join(obsoleteProgramRoot, "app.js"), "obsolete app", "utf8");
writeFileSync(
  join(obsoleteGenerationRoot, ".opengrove-cleanup-pending"),
  `${JSON.stringify({
    schemaVersion: 1,
    kind: "program-generation-cleanup",
    appRoot: obsoleteProgramRoot,
    createdAt: new Date().toISOString(),
  })}\n`,
  "utf8",
);
writeFileSync(settingsPath, "conversation database sentinel", "utf8");
writeFileSync(accountPath, "account sentinel", "utf8");
writeFileSync(knowledgePath, "knowledge sentinel", "utf8");
writeFileSync(join(workspaceRoot, "work.txt"), "workspace sentinel", "utf8");
mkdirSync(dirname(workspaceMediaCache), { recursive: true });
mkdirSync(dirname(workspaceUnrelatedCache), { recursive: true });
writeFileSync(workspaceMediaCache, "rebuildable media cache", "utf8");
writeFileSync(workspaceUnrelatedCache, "user-owned cache", "utf8");
mkdirSync(dirname(referencedArchive), { recursive: true });
mkdirSync(dirname(orphanArchive), { recursive: true });
writeFileSync(referencedArchive, "referenced archive", "utf8");
writeFileSync(orphanArchive, "orphan archive", "utf8");
writeFileSync(
  join(appStoreRoot, "catalog.json"),
  `${JSON.stringify({
    packages: [
      {
        id: "current",
        appId: "current",
        source: "registry",
        archiveFile: "archives/current/current.tgz",
      },
    ],
  })}\n`,
  "utf8",
);
const routeState = {
  settings: { mountedApps: [{ id: "current", path: currentProgramRoot, workspacePath: workspaceRoot }] },
  store: {
    kind: "json",
    path: join(routeDir, "state.json"),
    cleanupOrphanedBlobs: () => {
      cleanupCalls += 1;
      return { removedBlobs: 0, reclaimedBytes: 0 };
    },
  },
} as unknown as BridgeState;
const releaseRouteRun = registerActiveBridgeRun(routeState, "route-active-run");
let routeStatus = 0;
let routePayload: unknown;
await handleSettingsRoute({
  request: { method: "POST" } as IncomingMessage,
  response: {} as ServerResponse,
  url: new URL("http://localhost/settings/storage/cleanup"),
  state: routeState,
  sendJson: (_response, status, payload) => {
    routeStatus = status;
    routePayload = payload;
  },
  readJsonBody: async () => ({}),
});
assert.equal(routeStatus, 409);
assert.match((routePayload as { error: string }).error, /^desktop_storage_maintenance_active_runs:/);
assert.equal(cleanupCalls, 0, "the real cleanup route must not delete while a Run is active");
releaseRouteRun();

await handleSettingsRoute({
  request: { method: "POST" } as IncomingMessage,
  response: {} as ServerResponse,
  url: new URL("http://localhost/settings/storage/cleanup"),
  state: routeState,
  sendJson: (_response, status, payload) => {
    routeStatus = status;
    routePayload = payload;
  },
  readJsonBody: async () => ({}),
});
assert.equal(routeStatus, 200);
assert.equal((routePayload as { ok: boolean }).ok, true);
assert.equal(cleanupCalls, 1);
assert.equal(bridgeRunMaintenanceActive(routeState), false, "the route must release its maintenance gate");
for (const path of [settingsPath, accountPath, knowledgePath, workspaceRoot, currentProgramRoot, referencedArchive]) {
  assert.equal(existsSync(path), true, `safe cleanup must preserve ${path}`);
}
assert.equal(existsSync(obsoleteProgramRoot), false, "an explicitly retired program generation should be deleted");
assert.equal(existsSync(orphanArchive), false, "an archive absent from a valid Registry catalog should be deleted");
assert.equal(existsSync(workspaceMediaCache), false, "safe cleanup must delete mounted Workspace media cache files");
assert.equal(existsSync(workspaceUnrelatedCache), true, "safe cleanup must preserve unrelated Workspace cache files");

const desktopLease = beginBridgeRunMaintenance(routeState);
assert.equal(desktopLease.ok, true);
await handleSettingsRoute({
  request: { method: "POST" } as IncomingMessage,
  response: {} as ServerResponse,
  url: new URL("http://localhost/settings/storage/cleanup"),
  state: routeState,
  sendJson: (_response, status, payload) => {
    routeStatus = status;
    routePayload = payload;
  },
  readJsonBody: async () => ({ leaseId: desktopLease.ok ? desktopLease.leaseId : "" }),
});
assert.equal(routeStatus, 200);
assert.equal(cleanupCalls, 2);
assert.equal(bridgeRunMaintenanceActive(routeState), true, "the desktop-owned lease spans Bridge and disk cleanup");
assert.equal(desktopLease.ok && endBridgeRunMaintenance(routeState, desktopLease.leaseId), true);
rmSync(routeDir, { recursive: true, force: true });

const realRoot = mkdtempSync(join(tmpdir(), "opengrove-storage-real-store-"));
const realStatePath = join(realRoot, "local-state.sqlite");
const realAppStoreRoot = join(realRoot, "app-store");
const realProgramRoot = join(realAppStoreRoot, "programs", "c".repeat(64), "current", "app");
const realWorkspaceRoot = join(realRoot, "apps", "current", "workspace");
const realAccountPath = join(realRoot, "auth-cookies.json");
const realResetBackup = join(realRoot, "data", "reset-backups", "reset.json");
const realReferencedArchive = join(realAppStoreRoot, "archives", "current", "current.tgz");
try {
  mkdirSync(realProgramRoot, { recursive: true });
  mkdirSync(realWorkspaceRoot, { recursive: true });
  mkdirSync(dirname(realReferencedArchive), { recursive: true });
  mkdirSync(dirname(realResetBackup), { recursive: true });
  writeFileSync(
    join(realProgramRoot, "opengrove.app.json"),
    `${JSON.stringify({ id: "current", title: "Current", workspace: { path: "workspace" } })}\n`,
    "utf8",
  );
  writeFileSync(join(realProgramRoot, "app.js"), "current program sentinel", "utf8");
  writeFileSync(join(realWorkspaceRoot, "work.txt"), "real workspace sentinel", "utf8");
  writeFileSync(realAccountPath, "real account sentinel", "utf8");
  writeFileSync(realResetBackup, "real reset recovery backup", "utf8");
  writeFileSync(realReferencedArchive, "real referenced archive", "utf8");
  writeFileSync(
    join(realAppStoreRoot, "catalog.json"),
    `${JSON.stringify({
      packages: [
        {
          id: "current",
          appId: "current",
          source: "registry",
          archiveFile: "archives/current/current.tgz",
        },
      ],
    })}\n`,
    "utf8",
  );

  const realState = createBridgeState({ statePath: realStatePath });
  realState.settings.mountedApps = [
    { id: "current", title: "Current", path: realProgramRoot, workspacePath: realWorkspaceRoot, enabled: true },
  ];
  saveBridgeSettings(realState);
  const sharedLease = beginBridgeRunMaintenance(realState);
  assert.equal(sharedLease.ok, true);
  await handleSettingsRoute({
    request: { method: "POST" } as IncomingMessage,
    response: {} as ServerResponse,
    url: new URL("http://localhost/settings/storage/clear-history"),
    state: realState,
    sendJson: (_response, status, payload) => {
      routeStatus = status;
      routePayload = payload;
    },
    readJsonBody: async () => ({
      scope: "rebuildable-caches",
      leaseId: sharedLease.ok ? sharedLease.leaseId : "",
    }),
  });
  assert.equal(routeStatus, 200);
  assert.equal(
    bridgeRunMaintenanceActive(realState),
    true,
    "the supplied lease must remain active across both safe-cleanup Bridge actions",
  );
  assert.equal(sharedLease.ok && endBridgeRunMaintenance(realState, sharedLease.leaseId), true);
  const room = realState.app.rooms.createRoom({ id: "storage-real-room", title: "Storage real room" });
  const conversationText = `real conversation:${"消息".repeat(200_000)}`;
  realState.app.rooms.postUserMessage({ roomId: room.id, text: conversationText });
  realState.app.knowledge.upsert({
    id: "storage-real-knowledge",
    type: "project_doc",
    title: "Storage real knowledge",
    body: `real knowledge:${"知识".repeat(200_000)}`,
  });
  realState.store.saveFrom(realState.app);
  const orphanStore = new ContentBlobStore(join(realRoot, "state-blobs"), { thresholdBytes: 1 });
  orphanStore.encode(`unreferenced:${"x".repeat(32_000)}`);
  assert.ok((realState.store.storageStats?.().orphanBlobBytes ?? 0) > 0);

  await handleSettingsRoute({
    request: { method: "POST" } as IncomingMessage,
    response: {} as ServerResponse,
    url: new URL("http://localhost/settings/storage/cleanup"),
    state: realState,
    sendJson: (_response, status, payload) => {
      routeStatus = status;
      routePayload = payload;
    },
    readJsonBody: async () => ({}),
  });
  assert.equal(routeStatus, 200);
  assert.ok(((routePayload as { cleanup: { removedBlobs: number } }).cleanup.removedBlobs ?? 0) > 0);
  for (const path of [
    realStatePath,
    join(realRoot, "bridge-settings.json"),
    realAccountPath,
    realProgramRoot,
    realWorkspaceRoot,
    realReferencedArchive,
    realResetBackup,
  ]) {
    assert.equal(existsSync(path), true, `real safe cleanup must preserve ${path}`);
  }
  for (const protectedScope of ["reset-backups", "room-event-archive", "runtime-events"]) {
    await handleSettingsRoute({
      request: { method: "POST" } as IncomingMessage,
      response: {} as ServerResponse,
      url: new URL("http://localhost/settings/storage/clear-history"),
      state: realState,
      sendJson: (_response, status, payload) => {
        routeStatus = status;
        routePayload = payload;
      },
      readJsonBody: async () => ({ scope: protectedScope }),
    });
    assert.equal(routeStatus, 400, `${protectedScope} must not be a user-deletable storage scope`);
    assert.deepEqual(routePayload, { ok: false, error: "unknown_history_clear_scope" });
  }
  assert.equal(existsSync(realResetBackup), true, "reset recovery files must remain protected");
  await realState.store.close?.();

  const restarted = createBridgeState({ statePath: realStatePath });
  assert.equal(restarted.app.rooms.listMessages(room.id)[0]?.text, conversationText);
  assert.equal(restarted.app.knowledge.get("storage-real-knowledge")?.title, "Storage real knowledge");
  assert.equal(restarted.settings.mountedApps[0]?.path, realProgramRoot);
  assert.equal(existsSync(join(realWorkspaceRoot, "work.txt")), true);
  await restarted.store.close?.();
} finally {
  rmSync(realRoot, { recursive: true, force: true });
}

console.log("storage-maintenance-gate-harness ok");
