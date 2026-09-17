import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { list as listTar } from "tar";
import { appEnvName } from "../identity.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import { resolveMountedAppTarget } from "../server/mounted-apps.js";
import { localAppDraftStore, appRevisionStore, mountedAppRevisionTarget } from "../server/mounted-app-draft-service.js";
import { saveMountedAppReleasePrebuildDraftWithRevision } from "../server/app-release-local-build.js";

test("release preparation uses the manifest from its immutable source save point", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-release-source-point-"));
  const previousUserData = process.env[appEnvName("USER_DATA_DIR")];
  let state: ReturnType<typeof createBridgeState> | undefined;
  try {
    process.env[appEnvName("USER_DATA_DIR")] = join(root, "user-data");
    const appRoot = join(root, "app");
    mkdirSync(join(appRoot, "workspace"), { recursive: true });
    const manifestPath = join(appRoot, "opengrove.app.json");
    const manifest = {
      id: "release-source-point",
      title: "Source Point",
      ui: { surface: "none", workspace: "workspace" },
      workspace: { path: "workspace" },
      runtimeEnv: {
        providerKeys: [{ providerId: "provider-a", env: { apiKey: "APP_PROVIDER_KEY" }, required: false }],
      },
      store: { minHostReleaseNumber: 42 },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(appRoot, "program.txt"), "source expects provider B");
    state = createBridgeState({ statePath: join(root, "state.json") });
    state.settings.mountedApps = [{ id: "source-point-mount", path: appRoot, enabled: true }];
    recreateBridgeApp(state);
    const target = resolveMountedAppTarget(state, "release-source-point");
    assert.ok(target);
    manifest.runtimeEnv.providerKeys[0]!.providerId = "provider-b";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const draftStore = localAppDraftStore(state);
    const result = await saveMountedAppReleasePrebuildDraftWithRevision({ state, target, submission: {}, draftStore });
    assert.ok(result.draft.savePoint);
    const frozenRoot = join(root, "frozen");
    await appRevisionStore(state).materialize({
      ...mountedAppRevisionTarget(target),
      commitSha: result.draft.savePoint.commitSha,
      targetRoot: frozenRoot,
    });
    const archivePath = draftStore.archivePath(target.localAppId);
    assert.ok(archivePath);
    let draftManifest = "";
    await listTar({
      file: archivePath,
      onReadEntry: (entry) => {
        if (entry.path.replace(/^\.\//, "") === "opengrove.app.json")
          entry.on("data", (chunk: Buffer) => {
            draftManifest += chunk.toString("utf8");
          });
      },
    });
    assert.match(readFileSync(join(frozenRoot, "opengrove.app.json"), "utf8"), /"providerId":\s*"provider-b"/);
    assert.match(draftManifest, /"providerId":\s*"provider-b"/);
  } finally {
    await state?.store.close?.();
    if (previousUserData === undefined) delete process.env[appEnvName("USER_DATA_DIR")];
    else process.env[appEnvName("USER_DATA_DIR")] = previousUserData;
    rmSync(root, { recursive: true, force: true });
  }
});
