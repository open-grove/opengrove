import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-desktop-client-update-"));
const entryPath = join(tempDir, "desktop-client-update-entry.ts");
const bundlePath = join(tempDir, "desktop-client-update-entry.cjs");
const updaterStubPath = join(tempDir, "electron-updater-stub.ts");
const presentationModulePath = join(projectRoot, "web/src/client-update-presentation.ts");
const policyModulePath = join(projectRoot, "desktop/client-update-policy.ts");
const managerModulePath = join(projectRoot, "desktop/client-update-manager.ts");
const preferencesModulePath = join(projectRoot, "desktop/client-update-preferences.ts");
const require = createRequire(import.meta.url);

try {
  await writeFile(
    updaterStubPath,
    `
    import { EventEmitter } from "node:events";

    class AutoUpdaterStub extends EventEmitter {
      autoDownload = false;
      autoInstallOnAppQuit = false;
      logger = null;
      downloadCalls = 0;
      setFeedURL() {}
      async checkForUpdates() {}
      async downloadUpdate() { this.downloadCalls += 1; }
      quitAndInstall() {}
    }

    export const autoUpdater = new AutoUpdaterStub();
  `,
    "utf8",
  );
  await writeFile(
    entryPath,
    `
    import assert from "node:assert/strict";
    import {
      nextClientUpdateMetadataRefreshRelease,
      resolveTitlebarClientUpdate,
      resolveTitlebarClientUpdateAction,
    } from ${JSON.stringify(presentationModulePath)};
    import { DESKTOP_CLIENT_UPDATE_POLICY } from ${JSON.stringify(policyModulePath)};
    import { DesktopClientUpdateManager } from ${JSON.stringify(managerModulePath)};
    import {
      normalizeDesktopClientUpdatePreferences,
      readDesktopClientUpdatePreferences,
      writeDesktopClientUpdatePreferences,
    } from ${JSON.stringify(preferencesModulePath)};
    import { autoUpdater } from "electron-updater";

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: { getItem: () => "en" },
        location: { search: "" },
        navigator: { language: "en", languages: ["en"] },
      },
    });

    const noRemoteUpdate = { ok: true, current: 10005, latest: null };
    const remoteUpdate = {
      ok: true,
      current: 10005,
      latest: {
        version: 10006,
        downloadUrl: "https://example.test/releases/opengrove.exe",
        releaseNotes: "Release notes",
      },
    };
    const desktopBase = {
      supported: true,
      stage: "idle" as const,
      busy: false,
      updateAvailable: false,
      downloaded: false,
      canAutoInstall: false,
      autoDownload: true,
      currentVersion: "0.5.1",
      message: "idle",
      log: [],
    };

    assert.equal(resolveTitlebarClientUpdate(noRemoteUpdate, desktopBase).visible, false);
    assert.equal(resolveTitlebarClientUpdate(remoteUpdate, desktopBase).visible, true);

    const downloading = {
      ...desktopBase,
      stage: "downloading" as const,
      busy: true,
      updateAvailable: true,
      downloadUrl: "https://example.test/releases/from-desktop.exe",
    };
    assert.deepEqual(
      resolveTitlebarClientUpdate(noRemoteUpdate, downloading),
      {
        visible: true,
        downloadUrl: "https://example.test/releases/from-desktop.exe",
        releaseNotes: undefined,
      },
      "a late main-process update must remain visible while the renderer query is stale",
    );

    assert.equal(
      resolveTitlebarClientUpdate(noRemoteUpdate, {
        ...downloading,
        stage: "downloaded",
        busy: false,
        downloaded: true,
        canAutoInstall: true,
      }).visible,
      true,
      "a downloaded update must expose the explicit install action",
    );
    assert.equal(
      resolveTitlebarClientUpdate(remoteUpdate, downloading).downloadUrl,
      downloading.downloadUrl,
      "the main-process download URL is authoritative when both sources are available",
    );
    assert.deepEqual(
      resolveTitlebarClientUpdateAction(resolveTitlebarClientUpdate(remoteUpdate, downloading), downloading),
      {
        kind: "none",
        busy: true,
        disabled: true,
        label: "Downloading update",
        message: "Downloading update",
      },
      "downloading must never turn the update button into a browser link",
    );
    assert.equal(
      resolveTitlebarClientUpdateAction(resolveTitlebarClientUpdate(remoteUpdate, {
        ...downloading,
        stage: "downloaded",
        busy: false,
        downloaded: true,
        canAutoInstall: true,
      }), {
        ...downloading,
        stage: "downloaded",
        busy: false,
        downloaded: true,
        canAutoInstall: true,
      }).kind,
      "install",
    );
    assert.deepEqual(
      resolveTitlebarClientUpdateAction(resolveTitlebarClientUpdate(remoteUpdate, {
        ...desktopBase,
        stage: "error",
        updateAvailable: true,
        downloadUrl: remoteUpdate.latest.downloadUrl,
        message: "自动更新失败。",
      }), {
        ...desktopBase,
        stage: "error",
        updateAvailable: true,
        downloadUrl: remoteUpdate.latest.downloadUrl,
        message: "自动更新失败。",
      }),
      {
        kind: "manual-download",
        busy: false,
        disabled: false,
        label: "Auto-update failed — download manually",
        message: "Automatic update failed.",
      },
    );

    assert.equal(DESKTOP_CLIENT_UPDATE_POLICY.autoDownload, true);
    assert.equal(
      DESKTOP_CLIENT_UPDATE_POLICY.autoInstallOnAppQuit,
      false,
      "normal app quit must not silently install a downloaded update",
    );
    assert.deepEqual(normalizeDesktopClientUpdatePreferences({ autoDownload: false }), { autoDownload: false });
    assert.deepEqual(normalizeDesktopClientUpdatePreferences({ autoDownload: "false" }), { autoDownload: true });
    const preferencesPath = ${JSON.stringify(join(tempDir, "client-update-preferences.json"))};
    writeDesktopClientUpdatePreferences(preferencesPath, { autoDownload: false });
    assert.deepEqual(readDesktopClientUpdatePreferences(preferencesPath), { autoDownload: false });

    assert.equal(
      nextClientUpdateMetadataRefreshRelease({ ...desktopBase, updateAvailable: true, latestReleaseNumber: 10006 }, undefined),
      10006,
    );
    assert.equal(
      nextClientUpdateMetadataRefreshRelease({ ...desktopBase, updateAvailable: true, latestReleaseNumber: 10006 }, 10006),
      undefined,
      "repeated state events for one release should not refetch remote metadata",
    );
    assert.equal(
      nextClientUpdateMetadataRefreshRelease({ ...desktopBase, updateAvailable: true, latestReleaseNumber: 10007 }, 10006),
      10007,
      "a newer release in the same renderer session must refresh its notes",
    );

    function managerFor(responses: Array<Response | Error>, autoDownload = true) {
      globalThis.fetch = async () => {
        const response = responses.shift();
        if (!response) throw new Error("unexpected fetch");
        if (response instanceof Error) throw response;
        return response;
      };
      return new DesktopClientUpdateManager({
        enabled: true,
        currentVersion: "0.5.18",
        autoDownload,
        getApiBase: () => "http://127.0.0.1:9999/api",
        getCookieHeader: () => "session=test",
        applySetCookieHeaders: () => {},
        prepareForInstall: async () => {},
        log: () => {},
        onStateChange: () => {},
      });
    }

    function updateResponse(current: number, latest: number) {
      return new Response(JSON.stringify({
        ok: true,
        current,
        latest: {
          version: latest,
          downloadUrl: "https://example.test/releases/opengrove.dmg",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    async function assertManagerFailureState() {
    const currentReleaseManager = managerFor([
      updateResponse(10022, 10022),
      new Error("client-update HTTP 502 auth_unavailable"),
    ]);
    const currentReleaseState = await currentReleaseManager.checkForUpdates();
    assert.equal(currentReleaseState.stage, "up-to-date");
    assert.equal(currentReleaseState.updateAvailable, false);
    assert.ok(currentReleaseState.downloadUrl, "the current release can retain its download URL");

    const failedRefreshState = await currentReleaseManager.checkForUpdates();
    assert.equal(failedRefreshState.stage, "error");
    assert.equal(
      failedRefreshState.updateAvailable,
      false,
      "a failed refresh must not turn the current release download URL into a new update",
    );
    assert.equal(
      resolveTitlebarClientUpdate({
        ok: true,
        current: 10022,
        latest: {
          version: 10022,
          downloadUrl: failedRefreshState.downloadUrl!,
        },
      }, failedRefreshState).visible,
      false,
      "the title bar must stay clear when no newer release was confirmed",
    );

    const newerReleaseManager = managerFor([
      updateResponse(10022, 10023),
      new Error("client-update HTTP 502 auth_unavailable"),
    ]);
    assert.equal((await newerReleaseManager.checkForUpdates()).updateAvailable, true);
    autoUpdater.emit("error", new Error("automatic update transport failed"));
    assert.equal(
      newerReleaseManager.snapshot().updateAvailable,
      true,
      "an automatic updater error must preserve a previously confirmed update",
    );
    assert.equal(
      (await newerReleaseManager.checkForUpdates()).updateAvailable,
      true,
      "a failed refresh must preserve a previously confirmed update",
    );

    }

    async function assertManualDownloadState() {
      const manualManager = managerFor([updateResponse(10022, 10023)], false);
      await assert.rejects(
        manualManager.downloadUpdate(),
        /安装版更新当前不可自动下载/,
        "downloadUpdate must reject instead of throwing before it returns a Promise",
      );
      const availableState = await manualManager.checkForUpdates();
      assert.equal(availableState.stage, "available");
      assert.equal(availableState.autoDownload, false);
      assert.equal(autoUpdater.autoDownload, false);
      autoUpdater.emit("update-available", { version: "0.5.19" });
      assert.equal(manualManager.snapshot().stage, "available", "manual update mode must stay available after electron-updater confirms the release");
      const downloadsBefore = autoUpdater.downloadCalls;
      const downloadingState = await manualManager.downloadUpdate();
      assert.equal(downloadingState.stage, "downloading");
      assert.equal(autoUpdater.downloadCalls, downloadsBefore + 1);
      assert.equal(manualManager.setAutoDownload(true).autoDownload, true);
      assert.equal(autoUpdater.autoDownload, true);
    }

    export async function runDesktopClientUpdateHarness() {
      await assertManagerFailureState();
      await assertManualDownloadState();
    }
  `,
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
    plugins: [
      {
        name: "electron-updater-stub",
        setup(build) {
          build.onResolve({ filter: /^electron-updater$/ }, () => ({ path: updaterStubPath }));
        },
      },
    ],
  });
  await require(bundlePath).runDesktopClientUpdateHarness();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("desktop-client-update ok");
