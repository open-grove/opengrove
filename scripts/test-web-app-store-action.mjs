import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-app-store-action-"));
const entryPath = join(tempDir, "app-store-action-entry.ts");
const bundlePath = join(tempDir, "app-store-action-entry.cjs");
const actionModulePath = join(projectRoot, "web/src/components/network/app-store-action.ts");
const queryModulePath = join(projectRoot, "web/src/components/network/app-store-query.ts");
const bridgeTypesPath = join(projectRoot, "web/src/bridge-settings-types.ts");
const require = createRequire(import.meta.url);

try {
  await writeFile(
    entryPath,
    `
    import assert from "node:assert/strict";
    import type { AppStorePackageRecord } from ${JSON.stringify(bridgeTypesPath)};
    import { formatAppStoreInstallError, resolveAppStorePackageAction } from ${JSON.stringify(actionModulePath)};
    import {
      appStoreUpdateCount,
      appStoreQueryKeys,
      resolveAppStoreCatalogQueryPolicy,
      resolveAppStoreSaveAndPublishPolicy,
    } from ${JSON.stringify(queryModulePath)};

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: { getItem: () => "en" },
        location: { search: "" },
        navigator: { language: "en", languages: ["en"] },
      },
    });

    const base: AppStorePackageRecord = {
      id: "story-seed-package",
      title: "故事种子",
      summary: "Story Seed",
      version: "1.0.0",
      category: "工作台",
      installMode: "workspace",
      appId: "story-seed",
      workspaceName: "故事种子 Workspace",
      requirements: [],
      capabilities: [],
      backupScopes: [],
      status: "available",
      publisher: "OpenGrove",
      usageCount: 0,
      source: "registry",
    };

    assert.deepEqual(resolveAppStorePackageAction(base), { kind: "install", label: "Install" });
    assert.equal(appStoreUpdateCount(undefined), 0, "a missing catalog must not invent an update badge");
    assert.equal(
      appStoreUpdateCount({
        ok: true,
        architecture: {},
        registryConfigured: true,
        packages: [
          base,
          { ...base, id: "safe-update", updateAvailable: true, updateSafe: true },
          { ...base, id: "manual-update", updateAvailable: true, updateSafe: false },
          { ...base, id: "current", updateAvailable: false },
        ],
      }),
      2,
      "the App Store badge counts every available update, including one that needs manual handling",
    );
    assert.equal(
      formatAppStoreInstallError("app_store_version_contract_invalid"),
      "The App Store returned inconsistent version details, so installation stopped to protect local content. Refresh and retry; if it persists, send the incident reference to an administrator",
      "formal-version contract failures must be actionable instead of exposing an internal code",
    );
    assert.deepEqual(
      appStoreQueryKeys.catalog({
        userId: undefined,
        registryUrl: "",
        registryConfigured: false,
      }),
      ["app-store", "anonymous", "", false],
      "the catalog cache identity must come from the shared key factory",
    );
    assert.deepEqual(
      resolveAppStoreCatalogQueryPolicy({ kind: "live" }),
      { enabled: true, refetchInterval: false, staleTime: 60_000, refetchOnWindowFocus: true },
    );
    assert.deepEqual(
      resolveAppStoreCatalogQueryPolicy({
        kind: "static",
        data: {
          ok: true,
          architecture: {},
          registryConfigured: true,
          packages: [],
        },
      }),
      { enabled: false, refetchInterval: false },
      "a static visual-review catalog must never fetch or poll the Bridge",
    );
    assert.deepEqual(
      resolveAppStoreSaveAndPublishPolicy({
        mountedAppCount: 1,
        isAdmin: false,
      }),
      {
        showEntry: true,
        canUploadArchive: false,
        canFormalPublish: false,
      },
      "a non-admin App user must reach the shared local-draft page without formal publishing actions",
    );
    assert.deepEqual(
      resolveAppStoreSaveAndPublishPolicy({
        mountedAppCount: 1,
        isAdmin: true,
      }),
      {
        showEntry: true,
        canUploadArchive: true,
        canFormalPublish: true,
      },
      "formal publishing follows the Release Control contract, not legacy App Store Registry configuration",
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, installed: true, updateAvailable: true, hostUpdateRequired: true }),
      { kind: "host-update", label: "Update OpenGrove first" },
      "an incompatible App update must prompt for a Host update instead of installing",
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, installState: "source_conflict", openIssue: "source_conflict" }),
      { kind: "conflict", label: "Source conflict" },
    );
    assert.deepEqual(
      resolveAppStorePackageAction({
        ...base,
        installed: true,
        installState: "needs_relink",
        openable: true,
        openIssue: "store_relink_required",
        updateSafe: false,
      }),
      { kind: "relink", label: "Relink" },
    );
    assert.deepEqual(
      resolveAppStorePackageAction({
        ...base,
        installed: true,
        installState: "legacy_unknown",
        openIssue: "install_evidence_missing",
        updateSafe: true,
      }),
      { kind: "reinstall", label: "Reinstall" },
    );
    assert.deepEqual(
      resolveAppStorePackageAction({
        ...base,
        installed: true,
        installState: "legacy_unknown",
        openIssue: "install_evidence_missing",
        openable: true,
        updateSafe: false,
      }),
      { kind: "open", label: "Open" },
      "a legacy custom-path mount must keep its working Store open entry",
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, installed: true, openable: true }),
      { kind: "open", label: "Open" },
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, installed: true, openable: false, repairable: true, openIssue: "app_root_missing" }),
      { kind: "repair", label: "Repair" },
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, installed: true, openable: false, openIssue: "ui_not_workbench" }),
      { kind: "installed", label: "Installed" },
    );
    assert.deepEqual(
      resolveAppStorePackageAction({
        ...base,
        installed: true,
        openable: false,
        openIssue: "app_id_mismatch",
        updateAvailable: true,
        updateSafe: false,
      }),
      { kind: "inspect", label: "Needs inspection" },
      "an unsafe update must not bypass an identity warning",
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, installed: true, openable: true, updateAvailable: true, updateSafe: true }),
      { kind: "update", label: "Update" },
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, installed: true, openable: true, updateAvailable: true, updateSafe: false }),
      { kind: "open", label: "Open" },
      "custom-path and alias mounts remain openable but must not be rewritten by Store updates",
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, installed: true, openable: false, openIssue: "ui_not_workbench", updateAvailable: true, updateSafe: true }),
      { kind: "update", label: "Update" },
      "a canonical non-workbench App can still receive a safe program-file update",
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, installed: true, updateAvailable: true }),
      { kind: "update", label: "Update" },
      "older Bridge responses without updateSafe should retain the legacy Update action",
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, installed: true }),
      { kind: "open", label: "Open" },
      "older Bridge responses without openable should keep the legacy Open action",
    );
    assert.deepEqual(
      resolveAppStorePackageAction({ ...base, publishKind: "employee", installed: true }),
      { kind: "installed", label: "Installed" },
    );

    export function runAppStoreActionHarness() {}
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
  });
  require(bundlePath).runAppStoreActionHarness();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("web-app-store-action ok");
