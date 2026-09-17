import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  appStoreDataRoot,
  packAppStoreArchive,
  importAppStorePackage,
  installAppStorePackage,
  finalizeAppStoreRevisionInstall,
  type AppStoreRevisionInstallRollback,
} from "../server/app-store.js";
import { createBridgeState } from "../server/bridge-state.js";
import { appEnvName } from "../identity.js";

for (const replaceSettings of [false, true]) {
  test(`failed installation preserves a concurrent successful App (replace settings: ${replaceSettings})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "opengrove-concurrent-installs-"));
    const previousUserData = process.env[appEnvName("USER_DATA_DIR")];
    const previousApps = process.env[appEnvName("APP_STORE_APPS_DIR")];
    process.env[appEnvName("USER_DATA_DIR")] = join(root, "user-data");
    process.env[appEnvName("APP_STORE_APPS_DIR")] = join(root, "apps");
    const state = createBridgeState({ statePath: join(root, "data", "state.json") });
    let releaseGate: () => void = () => undefined;
    let enteredGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredGate = resolve;
    });
    try {
      const makePackage = (id: string) => {
        const source = join(root, "sources", id);
        mkdirSync(join(source, "workspace"), { recursive: true });
        writeFileSync(
          join(source, "opengrove.app.json"),
          JSON.stringify({
            id,
            title: id,
            version: "1.0.0",
            ui: { surface: "none", workspace: "workspace" },
            workspace: { path: "workspace" },
            employees: [],
          }),
        );
        writeFileSync(join(source, "program.txt"), id);
        const archive = packAppStoreArchive({ appRoot: source, allowSetup: true });
        return importAppStorePackage({
          state,
          package: {
            id,
            packageId: id,
            packageKey: `team.${id}`,
            appId: id,
            title: id,
            summary: "",
            version: "1.0.0",
            category: "test",
            publishKind: "app",
            installMode: "workspace",
            workspaceName: id,
            requirements: [],
            capabilities: [],
            backupScopes: [],
            status: "available",
            visibility: "restricted",
            publisher: "Tests",
            usageCount: 0,
            source: "registry",
            archiveName: archive.fileName,
            archiveSize: archive.archiveSize,
            archiveSha256: archive.archiveSha256,
            releaseCommitSha: "1".repeat(40),
          },
          archiveBytes: archive.bytes,
        });
      };
      const a = makePackage("concurrent-a");
      const b = makePackage("concurrent-b");
      const installingA = assert.rejects(
        installAppStorePackage({
          packageId: a.id,
          settings: state.settings,
          state,
          storeRoot: appStoreDataRoot(state),
          revisions: {
            async saveIfChanged() {
              enteredGate();
              await gate;
              throw new Error("injected_source_save_failure");
            },
          },
        }),
        /injected_source_save_failure/,
      );
      await entered;
      await assert.rejects(
        installAppStorePackage({
          packageId: a.id,
          settings: state.settings,
          state,
          storeRoot: appStoreDataRoot(state),
        }),
        /app_store_install_in_progress/,
      );
      if (replaceSettings) state.settings = structuredClone(state.settings);
      state.settings.appUpdates.automatic = false;
      let pendingActivation: AppStoreRevisionInstallRollback | undefined;
      const installedB = await installAppStorePackage({
        packageId: b.id,
        settings: state.settings,
        state,
        storeRoot: appStoreDataRoot(state),
        onRevisionSavePointCreated: (rollback) => {
          pendingActivation = rollback;
        },
      });
      await assert.rejects(
        installAppStorePackage({
          packageId: b.id,
          settings: state.settings,
          state,
          storeRoot: appStoreDataRoot(state),
        }),
        /app_store_install_in_progress/,
      );
      assert.ok(pendingActivation);
      finalizeAppStoreRevisionInstall(pendingActivation);
      assert.ok(installedB);
      assert.equal(installedB.status, "installed");
      releaseGate();
      await installingA;
      assert.deepEqual(
        state.settings.mountedApps.map((app) => app.id),
        ["concurrent-b"],
      );
      assert.equal(state.settings.appUpdates.automatic, false);
      assert.equal(existsSync(installedB.appRoot!), true);
    } finally {
      releaseGate();
      await state.store.close?.();
      if (previousUserData === undefined) delete process.env[appEnvName("USER_DATA_DIR")];
      else process.env[appEnvName("USER_DATA_DIR")] = previousUserData;
      if (previousApps === undefined) delete process.env[appEnvName("APP_STORE_APPS_DIR")];
      else process.env[appEnvName("APP_STORE_APPS_DIR")] = previousApps;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
