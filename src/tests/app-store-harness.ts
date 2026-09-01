import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { appStorePackageDetailSchema, appStorePackageIndexEntrySchema } from "#agent-protocol";
import { validateAppStoreEmployeeDefaults } from "../app-builder/manifest.js";
import { ROOM_MEMBER_AVATAR_MAX_BYTES } from "../rooms/avatar-data-url.js";
import {
  type AppReleaseCheck,
  AppReleaseValidationError,
  type MountedAppReleaseDraft,
  normalizeReleaseEmployee,
} from "../server/app-release.js";
import { validateAppReleaseBuildContract } from "../server/app-release-build-contract.js";
import { AppRevisionStore, managedAppRevisionGitDirectory } from "../server/app-revision-store.js";
import {
  type AppStorePackageRecord,
  appStoreDataRoot,
  captureAppStorePublishTarget,
  cleanupUnreferencedAppStoreProgramGenerations,
  currentAppStoreProgramsRoot,
  defaultAppStoreRoot,
  importAppStorePackage,
  installAppStorePackage,
  installedEmployeePackageIds,
  listAppStorePackages,
  markAppStorePublishRecoveryPublished,
  packAppStoreArchive,
  packEmployeeStoreArchive,
  prepareAppStorePublishRecovery,
  writeAppStorePackageInstallMarker,
} from "../server/app-store.js";
import { legacyAppStoreProgramsRoot } from "../server/migrations/store-app-layout-v2.js";
import {
  ensureInstalledAppStoreAppsCurrent,
  scheduleInstalledAppStoreUpdatesAfterAuth,
} from "../server/app-store-auto-updates.js";
import { presentAppStoreCatalogPackages } from "../server/app-store-presentation.js";
import {
  mergeAppStoreCatalogPackages,
  readAppStoreRegistryConfig,
  releaseControlRegistryConfig,
  resolveRegistryDownloadUrl,
} from "../server/app-store-registry.js";
import {
  appStorePackageInstallSafetyError,
  inspectAppStorePackageRuntimeState,
  mountedAppWorkspaceBindingIssue,
} from "../server/app-store-runtime-state.js";
import { mountedAppWorkingDigest } from "../server/app-version-manager.js";
import { MountedAppVersionStateStore } from "../server/app-version-state.js";
import { publicEmployeeRole } from "../server/bridge-mounted-app-employees.js";
import type { BridgeSecurity } from "../server/bridge-security.js";
import { loadBridgeSettings } from "../server/bridge-settings-store.js";
import { createBridgeState, recreateBridgeApp, saveBridgeSettings } from "../server/bridge-state.js";
import { DEFAULT_BRIDGE_MODEL_ID } from "../server/bridge-types.js";
import { readClientReleaseNumber } from "../server/client-release.js";
import {
  ensureDefaultStoreAppsInstalledAfterAuth,
  scheduleDefaultStoreAppsInstalledAfterAuth,
} from "../server/default-store-apps.js";
import { migrateStoreWorkspaceBindingsV1 } from "../server/migrations/store-workspace-binding-v1.js";
import { resolveMountedAppTarget } from "../server/mounted-apps.js";
import { handleAppStoreRoute } from "../server/routes/app-store.js";
import { handleAppsRoute } from "../server/routes/apps.js";
import { resolveSystemEmployeeRuntime } from "../server/system-employee-runtime.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-app-store-"));
const currentHostReleaseNumber = readClientReleaseNumber();
if (currentHostReleaseNumber === null) throw new Error("app-store-harness requires a valid clientReleaseNumber");

assert.equal(
  resolveRegistryDownloadUrl(
    "https://opengrove-test.example/app-release-api",
    "/v1/app-store/packages/story-seed/versions/0.2.27/download?archiveSha256=abc",
  ),
  "https://opengrove-test.example/app-release-api/v1/app-store/packages/story-seed/versions/0.2.27/download?archiveSha256=abc",
  "Release Control may return a service-relative download reference behind an ingress prefix",
);

const previousReleaseControlUrlForRegistryConfig = process.env.OPENGROVE_RELEASE_CONTROL_URL;
process.env.OPENGROVE_RELEASE_CONTROL_URL = "https://opengrove-test.example/app-release-api";
assert.deepEqual(
  releaseControlRegistryConfig("ww-session-token"),
  {
    baseUrl: "https://opengrove-test.example/app-release-api",
    registryToken: "ww-session-token",
  },
  "a WW session authenticates Release Control but must never turn WW into the App Store base URL",
);
if (previousReleaseControlUrlForRegistryConfig === undefined) {
  delete process.env.OPENGROVE_RELEASE_CONTROL_URL;
} else {
  process.env.OPENGROVE_RELEASE_CONTROL_URL = previousReleaseControlUrlForRegistryConfig;
}

const localizedCatalogSource: AppStorePackageRecord = {
  id: "story-seed",
  packageId: "story-seed",
  title: "故事种子",
  summary: "把故事种子发展成完整故事。",
  version: "0.2.31",
  category: "内容创作",
  publishKind: "app",
  installMode: "workspace",
  appId: "story-seed",
  workspaceName: "故事种子",
  requirements: [],
  capabilities: [],
  agents: [
    {
      id: "story-architect",
      name: "故事架构师",
      role: "负责故事架构。",
      publicSkills: ["故事设计"],
    },
  ],
  backupScopes: [],
  status: "available",
  publisher: "中文发布者",
  usageCount: 1,
  source: "registry",
};
const englishCatalog = presentAppStoreCatalogPackages([localizedCatalogSource], "en", () => ({
  id: "story-seed",
  title: "故事种子",
  locales: {
    en: {
      title: "Story Seed",
      description: "Develop a story seed into a complete story.",
      employees: {
        "story-architect": {
          name: "Story Architect",
          role: "Designs the story structure.",
          publicSkills: ["Story design"],
        },
      },
    },
  },
}));
assert.equal(englishCatalog[0]?.title, "Story Seed");
assert.equal(englishCatalog[0]?.summary, "Develop a story seed into a complete story.");
assert.equal(englishCatalog[0]?.agents?.[0]?.name, "Story Architect");
assert.equal(englishCatalog[0]?.publisher, "中文发布者", "publisher names are user data, not translated system copy");
const legacyEnglishCatalog = presentAppStoreCatalogPackages(
  [
    {
      ...localizedCatalogSource,
      id: "legacy-writing-room",
      appId: "legacy-writing-room",
      packageId: "legacy-writing-room",
    },
  ],
  "en",
);
assert.equal(legacyEnglishCatalog[0]?.title, "故事种子");
assert.equal(legacyEnglishCatalog[0]?.summary, "把故事种子发展成完整故事。");
assert.equal(legacyEnglishCatalog[0]?.agents?.[0]?.name, "故事架构师");
const canonicalEnglishCatalog = presentAppStoreCatalogPackages(
  [
    {
      ...localizedCatalogSource,
      defaultLocale: "en",
      title: "Canonical English App",
      summary: "Canonical English description.",
      publisher: "Example Publisher",
      agents: [
        {
          id: "story-architect",
          name: "Canonical Architect",
          role: "Canonical role.",
        },
      ],
    },
  ],
  "en",
);
assert.equal(canonicalEnglishCatalog[0]?.title, "Canonical English App");
assert.equal(canonicalEnglishCatalog[0]?.summary, "Canonical English description.");
assert.equal(canonicalEnglishCatalog[0]?.agents?.[0]?.name, "Canonical Architect");
assert.deepEqual(
  presentAppStoreCatalogPackages([localizedCatalogSource], "zh-CN"),
  [localizedCatalogSource],
  "Chinese presentation keeps canonical publisher metadata",
);

const normalizedReleaseEmployee = normalizeReleaseEmployee({
  memberId: "member-app-release-avatar",
  name: "Release Avatar",
  avatarMode: "upload",
  avatarSeed: "release-avatar-seed",
  avatarDataUrl: "data:image/png;base64,c2FmZQ==",
  role: "Checks release employee normalization.",
  kernel: "codex",
  model: "gpt",
  color: "#64748b",
  availableSkillIds: [],
  defaultSkillIds: [],
  visibility: "private",
  publicSkills: [],
});
assert.equal(normalizedReleaseEmployee.avatarMode, "upload");
assert.equal(normalizedReleaseEmployee.avatarSeed, "release-avatar-seed");
assert.equal(normalizedReleaseEmployee.avatarDataUrl, "data:image/png;base64,c2FmZQ==");
const maximumReleaseAvatarDataUrl = `data:image/png;base64,${Buffer.alloc(ROOM_MEMBER_AVATAR_MAX_BYTES).toString("base64")}`;
assert.equal(
  normalizeReleaseEmployee({
    ...normalizedReleaseEmployee,
    avatarDataUrl: maximumReleaseAvatarDataUrl,
  }).avatarDataUrl,
  maximumReleaseAvatarDataUrl,
  "release submission accepts the same advertised 1.5 MB raw avatar as the editor",
);
assert.throws(
  () =>
    normalizeReleaseEmployee({
      ...normalizedReleaseEmployee,
      avatarDataUrl: `data:image/png;base64,${Buffer.alloc(ROOM_MEMBER_AVATAR_MAX_BYTES + 1).toString("base64")}`,
    }),
  (error: unknown) => error instanceof AppReleaseValidationError && error.status === 400,
  "release submission rejects avatar payloads above the shared raw-byte limit",
);
assert.throws(
  () =>
    normalizeReleaseEmployee({
      ...normalizedReleaseEmployee,
      avatarDataUrl: "https://tracker.example/avatar.png",
    }),
  (error: unknown) => error instanceof AppReleaseValidationError && error.status === 400,
  "release employee normalization must reject remote avatar URLs",
);

const escapedRegistryInstallRoot = join(dirname(tempRoot), `escaped-registry-install-${process.pid}`);
const previousRegistryUrl = process.env.OPENGROVE_APP_STORE_REGISTRY_URL;
const previousRegistryToken = process.env.OPENGROVE_APP_STORE_REGISTRY_TOKEN;
const previousReleaseControlUrl = process.env.OPENGROVE_RELEASE_CONTROL_URL;
const previousWwBaseUrl = process.env.OPENGROVE_WW_BASE_URL;
const previousAppsDir = process.env.OPENGROVE_APP_STORE_APPS_DIR;
const previousProgramsDir = process.env.OPENGROVE_PROGRAMS_DIR;
const previousWorkspacesDir = process.env.OPENGROVE_WORKSPACES_DIR;
const previousLegacyAppsDir = process.env.OPENGROVE_LEGACY_APPS_DIR;
process.env.OPENGROVE_PROGRAMS_DIR = join(tempRoot, "programs-v2");
delete process.env.OPENGROVE_WORKSPACES_DIR;
process.env.OPENGROVE_LEGACY_APPS_DIR = join(tempRoot, "legacy-apps");
const cloudStorePackages = new Map<string, { pkg: AppStorePackageRecord; bytes: Buffer }>();
let publishedPackageTemplate: AppStorePackageRecord | undefined;
let lastPublishAuthorization: string | undefined;
let lastPublishIdempotencyKey: string | undefined;
const publishIdempotencyResponses = new Map<string, AppStorePackageRecord>();
let fakeOssUrl = "";
let lastSignedDownloadAuthorization: string | string[] | undefined;
let lastSignedDownloadClientRelease: string | string[] | undefined;
let signedDownloadRequestCount = 0;
const registryClientReleaseHeaders: Array<string | undefined> = [];
const failingSignedDownloadPackageIds = new Set<string>();
const defaultPolicyRequestCounts = new Map<string, number>();
const registryCatalogRequestCounts = new Map<string, number>();
const failedPolicyDownloadRequestCounts = new Map<string, number>();
let markDelayedDefaultPolicyRequestStarted = () => {};
const delayedDefaultPolicyRequestStarted = new Promise<void>((resolve) => {
  markDelayedDefaultPolicyRequestStarted = resolve;
});
let releaseDelayedDefaultPolicyRequest = () => {};
const delayedDefaultPolicyRequestRelease = new Promise<void>((resolve) => {
  releaseDelayedDefaultPolicyRequest = resolve;
});
let releaseDelayedCatalogRequest = () => {};
const delayedCatalogRequestRelease = new Promise<void>((resolve) => {
  releaseDelayedCatalogRequest = resolve;
});

interface ReleaseHarnessResponseData {
  ok?: boolean;
  error: string;
  detail?: unknown;
  appliedToCurrentApp?: boolean;
  release: MountedAppReleaseDraft;
  checks: AppReleaseCheck[];
  archive: {
    archiveSha256?: string;
    packageManifest?: Record<string, unknown>;
  };
  package: AppStorePackageRecord;
}

interface ReleaseHarnessCall {
  status: number;
  data: ReleaseHarnessResponseData;
}

function captureReleaseResponse(calls: ReleaseHarnessCall[]) {
  return (_response: ServerResponse, status: number, data: unknown) => {
    calls.push({ status, data: data as ReleaseHarnessResponseData });
  };
}
const fakeOss = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const match = url.pathname.match(/^\/signed-download\/([^/]+)$/);
  if (request.method === "GET" && match) {
    signedDownloadRequestCount += 1;
    lastSignedDownloadAuthorization = request.headers.authorization;
    lastSignedDownloadClientRelease = request.headers["x-opengrove-client-release"];
    const packageId = decodeURIComponent(match[1] || "");
    if (failingSignedDownloadPackageIds.has(packageId)) {
      sendTestJson(response, 503, { ok: false, error: "archive_temporarily_unavailable" });
      return;
    }
    const entry = findCloudStorePackage(packageId);
    if (!entry) {
      sendTestJson(response, 404, { ok: false, error: "app_store_archive_not_found" });
      return;
    }
    sendTestBytes(response, 200, entry.bytes, "application/gzip");
    return;
  }
  sendTestJson(response, 404, { ok: false, error: "not_found" });
});
const fakeCloud = createServer((request, response) => {
  void handleFakeCloudRequest(request, response).catch((error) => {
    sendTestJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  });
});

try {
  const corruptMarkerRoot = join(tempRoot, "corrupt-install-marker");
  mkdirSync(corruptMarkerRoot, { recursive: true });
  const corruptMarkerPath = join(corruptMarkerRoot, ".opengrove-store-package.json");
  writeFileSync(corruptMarkerPath, "{not-json", "utf8");
  const regeneratedMarker = writeAppStorePackageInstallMarker({
    appRoot: corruptMarkerRoot,
    item: localizedCatalogSource,
  });
  assert.equal(regeneratedMarker.appId, localizedCatalogSource.appId);
  assert.equal(JSON.parse(readFileSync(corruptMarkerPath, "utf8")).appId, localizedCatalogSource.appId);
  assert.equal(
    readdirSync(corruptMarkerRoot).filter(
      (name) => name.startsWith(".opengrove-store-package.json.corrupt-") && name.endsWith(".bak"),
    ).length,
    1,
    "a corrupt install marker must be quarantined once and replaced with verified registry metadata",
  );

  const compatibilityNotice = {
    packageKey: "demo.future-app",
    packageId: "demo.future-app",
    appId: "future-app",
    title: "Future App",
    version: "2.0.0",
    minHostReleaseNumber: currentHostReleaseNumber + 1,
    publisher: "Demo",
    namespace: "demo",
    publishedAt: "2026-07-22T00:00:00Z",
    visibility: "private",
    requirements: { providers: [], env: [], system: [] },
  };
  assert.equal(
    appStorePackageIndexEntrySchema.safeParse(compatibilityNotice).success,
    true,
    "catalog compatibility notices must not require install archive metadata",
  );
  assert.equal(
    appStorePackageDetailSchema.safeParse({ ...compatibilityNotice, versions: [] }).success,
    false,
    "package details must keep requiring install archive metadata",
  );
  assert.equal(
    appStorePackageDetailSchema.safeParse({
      ...compatibilityNotice,
      archiveSha256: "a".repeat(64),
      archiveSize: 0,
      versions: [],
    }).success,
    true,
    "package details with complete install archive metadata must remain valid",
  );

  assert.deepEqual(
    validateAppStoreEmployeeDefaults([
      {
        memberId: "member-app-safe-worker",
        name: "Safe Worker",
        kernel: "codex",
        model: "gpt",
        avatarDataUrl: "data:image/png;base64,c2FmZQ==",
      },
    ]),
    [],
  );
  assert.match(
    validateAppStoreEmployeeDefaults([
      {
        memberId: "member-app-leaky-worker",
        name: "Leaky Worker",
        kernel: "codex",
        model: "gpt",
        avatarDataUrl: "https://tracker.example/avatar.png",
      },
    ]).join(" "),
    /avatarDataUrl/,
    "install-time employee defaults must reject remote avatar URLs",
  );
  fakeOss.listen(0, "127.0.0.1");
  await once(fakeOss, "listening");
  const fakeOssAddress = fakeOss.address() as AddressInfo;
  fakeOssUrl = `http://127.0.0.1:${fakeOssAddress.port}`;
  fakeCloud.listen(0, "127.0.0.1");
  await once(fakeCloud, "listening");
  const fakeCloudAddress = fakeCloud.address() as AddressInfo;
  const fakeCloudUrl = `http://127.0.0.1:${fakeCloudAddress.port}`;
  process.env.OPENGROVE_WW_BASE_URL = fakeCloudUrl;
  process.env.OPENGROVE_APP_STORE_REGISTRY_URL = fakeCloudUrl;
  process.env.OPENGROVE_APP_STORE_REGISTRY_TOKEN = "reg_harness";
  process.env.OPENGROVE_RELEASE_CONTROL_URL = fakeCloudUrl;
  process.env.OPENGROVE_APP_STORE_APPS_DIR = tempRoot;

  const workspaceBindingStatePath = join(tempRoot, "workspace-binding-migration", "state.sqlite");
  const workspaceBindingState = createBridgeState({ statePath: workspaceBindingStatePath });
  const workspaceBindingStoreRoot = appStoreDataRoot(workspaceBindingState);
  const workspaceBindingAppId = "workspace-binding-app";
  const workspaceBindingProgramRoot = join(
    legacyAppStoreProgramsRoot(workspaceBindingStoreRoot),
    "a".repeat(64),
    "0.1.0-harness",
    "app",
  );
  const workspaceBindingRoot = join(tempRoot, workspaceBindingAppId, "workspace");
  mkdirSync(workspaceBindingProgramRoot, { recursive: true });
  mkdirSync(workspaceBindingRoot, { recursive: true });
  writeFileSync(join(workspaceBindingRoot, "migration-note.md"), "persistent\n", "utf8");
  writeFileSync(
    join(workspaceBindingProgramRoot, "opengrove.app.json"),
    JSON.stringify({
      id: workspaceBindingAppId,
      title: "Workspace Binding App",
      ui: { surface: "file-workbench", workspace: "workspace" },
      store: { packageKey: "harness.workspace-binding-app" },
    }),
    "utf8",
  );
  writeFileSync(
    join(workspaceBindingProgramRoot, ".opengrove-store-package.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: "registry",
      appId: workspaceBindingAppId,
      packageKey: "harness.workspace-binding-app",
    }),
    "utf8",
  );
  symlinkSync(
    workspaceBindingRoot,
    join(workspaceBindingProgramRoot, "workspace"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    mountedAppWorkspaceBindingIssue(
      {
        id: workspaceBindingAppId,
        path: workspaceBindingProgramRoot,
        workspacePath: workspaceBindingRoot,
        enabled: true,
      },
      {
        appStoreRoot: tempRoot,
        programsRoot: legacyAppStoreProgramsRoot(workspaceBindingStoreRoot),
      },
    ),
    undefined,
    "a verified Store junction into its own Host container must remain a valid settings binding",
  );
  const escapedWorkspaceParent = join(tempRoot, "escaped-workspace-parent");
  const escapedWorkspaceRoot = join(tempRoot, workspaceBindingAppId, "redirect", "workspace");
  const escapedWorkspaceProgramRoot = join(
    legacyAppStoreProgramsRoot(workspaceBindingStoreRoot),
    "c".repeat(64),
    "0.1.0-escaped-harness",
    "app",
  );
  mkdirSync(join(escapedWorkspaceParent, "workspace"), { recursive: true });
  symlinkSync(
    escapedWorkspaceParent,
    join(tempRoot, workspaceBindingAppId, "redirect"),
    process.platform === "win32" ? "junction" : "dir",
  );
  mkdirSync(escapedWorkspaceProgramRoot, { recursive: true });
  writeFileSync(
    join(escapedWorkspaceProgramRoot, "opengrove.app.json"),
    JSON.stringify({
      id: workspaceBindingAppId,
      title: "Escaped Workspace Binding App",
      ui: { surface: "file-workbench", workspace: "workspace" },
    }),
    "utf8",
  );
  symlinkSync(
    escapedWorkspaceRoot,
    join(escapedWorkspaceProgramRoot, "workspace"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    mountedAppWorkspaceBindingIssue(
      {
        id: workspaceBindingAppId,
        path: escapedWorkspaceProgramRoot,
        workspacePath: escapedWorkspaceRoot,
        enabled: true,
      },
      {
        appStoreRoot: tempRoot,
        programsRoot: legacyAppStoreProgramsRoot(workspaceBindingStoreRoot),
      },
    ),
    "app_workspace_binding_invalid",
    "a Store Workspace must not escape its own Host container through a parent link",
  );
  workspaceBindingState.settings.mountedApps = [
    {
      id: workspaceBindingAppId,
      path: workspaceBindingProgramRoot,
      enabled: true,
    },
  ];
  saveBridgeSettings(workspaceBindingState);
  await workspaceBindingState.store.close?.();

  const migratedWorkspaceBindingState = createBridgeState({ statePath: workspaceBindingStatePath });
  try {
    const migratedWorkspaceBindingMount = migratedWorkspaceBindingState.settings.mountedApps.find(
      (mountedApp) => mountedApp.id === workspaceBindingAppId,
    );
    assert.ok(
      migratedWorkspaceBindingMount,
      `workspace binding migration lost its mount: ${JSON.stringify(migratedWorkspaceBindingState.settings.mountedApps)}`,
    );
    assert.equal(
      resolve(migratedWorkspaceBindingMount.workspacePath ?? ""),
      resolve(realpathSync.native(workspaceBindingRoot)),
      "startup migration must recover the external Workspace target from a verified Store junction",
    );
    assert.equal(
      resolve(loadBridgeSettings(migratedWorkspaceBindingState).mountedApps[0]?.workspacePath ?? ""),
      resolve(realpathSync.native(workspaceBindingRoot)),
      "the recovered Workspace binding must be persisted in bridge-settings.json",
    );
  } finally {
    await migratedWorkspaceBindingState.store.close?.();
  }

  const brokenWorkspaceBindingAppId = "broken-workspace-binding-app";
  const brokenWorkspaceBindingProgramRoot = join(
    legacyAppStoreProgramsRoot(workspaceBindingStoreRoot),
    "b".repeat(64),
    "0.1.0-broken-harness",
    "app",
  );
  mkdirSync(join(brokenWorkspaceBindingProgramRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(brokenWorkspaceBindingProgramRoot, "opengrove.app.json"),
    JSON.stringify({
      id: brokenWorkspaceBindingAppId,
      title: "Broken Workspace Binding App",
      ui: { surface: "file-workbench", workspace: "workspace" },
    }),
    "utf8",
  );
  writeFileSync(
    join(brokenWorkspaceBindingProgramRoot, ".opengrove-store-package.json"),
    JSON.stringify({ schemaVersion: 1, source: "registry", appId: brokenWorkspaceBindingAppId }),
    "utf8",
  );
  const failedWorkspaceBindingMigration = migrateStoreWorkspaceBindingsV1({
    mountedApps: [
      {
        id: brokenWorkspaceBindingAppId,
        path: brokenWorkspaceBindingProgramRoot,
        enabled: true,
      },
    ],
    storeRoot: workspaceBindingStoreRoot,
  });
  assert.deepEqual(failedWorkspaceBindingMigration.recoveredAppIds, []);
  assert.deepEqual(
    failedWorkspaceBindingMigration.failures,
    [
      {
        appId: brokenWorkspaceBindingAppId,
        appRoot: resolve(brokenWorkspaceBindingProgramRoot),
        reason: "binding_unrecoverable",
      },
    ],
    "a Store generation with an unrecoverable Workspace link must produce startup diagnostic evidence",
  );

  await withAppStoreAppsDirCleared(async () => {
    const fallbackRoot = defaultAppStoreRoot();
    assert.equal(isAbsolute(fallbackRoot), true, "default app install root should be absolute");
    assert.notEqual(
      fallbackRoot,
      "/opt/opengrove-apps",
      "default app install root should not require root permissions",
    );
  });

  const savedRegistryRoot = join(tempRoot, "saved-registry-settings");
  mkdirSync(savedRegistryRoot, { recursive: true });
  writeFileSync(
    join(savedRegistryRoot, "bridge-settings.json"),
    JSON.stringify({
      appStore: {
        registryUrl: "https://saved-registry.example.test",
      },
    }),
    "utf8",
  );
  const savedRegistryState = createBridgeState({
    statePath: join(savedRegistryRoot, "local-state.json"),
  });
  assert.equal(
    savedRegistryState.settings.appStore?.registryUrl,
    fakeCloudUrl,
    "an explicit App Store registry environment must override a registry saved by another desktop profile",
  );
  savedRegistryState.settings.appStore = {
    registryUrl: "https://saved-registry.example.test",
    registryToken: "saved-production-token",
  };
  assert.deepEqual(
    readAppStoreRegistryConfig(savedRegistryState),
    {
      baseUrl: fakeCloudUrl,
      registryToken: "reg_harness",
    },
    "explicit registry environment remains authoritative after a runtime settings patch",
  );
  delete process.env.OPENGROVE_APP_STORE_REGISTRY_TOKEN;
  assert.deepEqual(
    readAppStoreRegistryConfig(savedRegistryState),
    {
      baseUrl: fakeCloudUrl,
    },
    "a saved token from another registry must not follow an explicit registry URL override",
  );
  process.env.OPENGROVE_APP_STORE_REGISTRY_TOKEN = "reg_harness";

  const sessionSecurity: BridgeSecurity = {
    authMode: "session",
    allowedOrigins: [],
  };
  const adminSessionSecurity: BridgeSecurity = {
    ...sessionSecurity,
    wwBaseUrl: fakeCloudUrl,
  };

  // ===== 未配置云端：商店明确不可用 =====
  await withRegistryEnvCleared(async () => {
    const unconfiguredStoreState = createBridgeState({ statePath: join(tempRoot, "unconfigured-store-state.json") });
    unconfiguredStoreState.settings.appStore = { registryUrl: "" };
    const unconfiguredCatalogCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "GET" } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store"),
      state: unconfiguredStoreState,
      sendJson: (_response, status, data) => unconfiguredCatalogCalls.push({ status, data }),
      readJsonBody: async () => ({}),
    });
    assert.equal(unconfiguredCatalogCalls[0]?.status, 200);
    assert.equal(unconfiguredCatalogCalls[0]?.data.registryConfigured, false);
    assert.equal(unconfiguredCatalogCalls[0]?.data.registryCatalogError, "registry_not_configured");
    assert.deepEqual(
      unconfiguredCatalogCalls[0]?.data.packages,
      [],
      "catalog should stay empty until a private registry is configured",
    );
  });

  // ===== 云端注册表 App：目录、安装、更新 =====
  const registryRoot = join(tempRoot, "registry-source");
  mkdirSync(join(registryRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(registryRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "registry-demo-app",
      title: "Registry Demo App",
      version: "0.3.0",
      description: "Registry app package",
      disablePmAgent: true,
      ui: { surface: "file-workbench", workspace: "workspace" },
      workspace: { path: "workspace", name: "Registry Workspace" },
      employees: [{ id: "operator", name: "Old Operator", role: "Old package role" }],
      store: {
        requirements: { env: ["REGISTRY_DEMO_KEY"] },
        capabilities: ["registry install"],
        employeeDefaults: [
          {
            memberId: "member-app-registry-demo-app-operator",
            name: "Old Operator",
            role: "Old package role",
            kernel: "claude-code",
            model: "old-package-model",
            reasoningEffort: "medium",
            contextTokenBudget: 100000,
            accessMode: "default",
            color: "#111111",
            avatarDataUrl: "data:image/png;base64,b2xk",
            availableSkillIds: ["old-available"],
            defaultSkillIds: ["old-default"],
            visibility: "private",
            publicDescription: "Old package description",
            publicSkills: ["old-public-skill"],
            inputSpec: "Old package input",
            outputSpec: "Old package output",
          },
        ],
      },
    }),
    "utf8",
  );
  const registryArchivePath = join(tempRoot, "registry-demo-app.tar.gz");
  execFileSync("tar", ["-czf", registryArchivePath, "-C", registryRoot, "."]);
  const registryArchive = readFileSync(registryArchivePath);
  const cloudRegistryPackage: AppStorePackageRecord = {
    id: "harness.registry-demo-app",
    packageKey: "harness.registry-demo-app",
    packageId: "registry-demo-app",
    title: "Registry Demo App",
    summary: "Registry app package",
    version: "0.3.0",
    category: "工作台",
    publishKind: "app",
    installMode: "workspace",
    appId: "registry-demo-app",
    workspaceName: "Registry Workspace",
    requirements: ["env:REGISTRY_DEMO_KEY"],
    capabilities: ["registry install"],
    backupScopes: [],
    status: "available",
    publisher: "Harness Cloud",
    usageCount: 0,
    source: "registry",
    archiveName: "registry-demo-app.tar.gz",
    archiveSize: registryArchive.byteLength,
    archiveSha256: createHash("sha256").update(registryArchive).digest("hex"),
  };
  cloudStorePackages.set(cloudRegistryPackage.id, { pkg: cloudRegistryPackage, bytes: registryArchive });

  rmSync(escapedRegistryInstallRoot, { recursive: true, force: true });
  const traversalRegistryPackage: AppStorePackageRecord = {
    ...cloudRegistryPackage,
    id: "harness.traversal-app",
    packageKey: "harness.traversal-app",
    packageId: "traversal-app",
    appId: `../${basename(escapedRegistryInstallRoot)}`,
    title: "Traversal App",
  };
  cloudStorePackages.set(traversalRegistryPackage.id, {
    pkg: traversalRegistryPackage,
    bytes: registryArchive,
  });
  const traversalRegistryIdPackage: AppStorePackageRecord = {
    ...cloudRegistryPackage,
    id: "../evil",
    packageKey: "harness.traversal-employee-id",
    packageId: "traversal-employee-id",
    appId: "traversal-employee-id",
    publishKind: "employee",
    installMode: "contacts",
    title: "Traversal Employee ID",
  };
  cloudStorePackages.set(traversalRegistryIdPackage.id, {
    pkg: traversalRegistryIdPackage,
    bytes: registryArchive,
  });

  const storySeedRoot = join(tempRoot, "story-seed-source");
  mkdirSync(join(storySeedRoot, "workspace"), { recursive: true });
  mkdirSync(join(storySeedRoot, "bin"), { recursive: true });
  writeFileSync(
    join(storySeedRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "story-seed",
        title: "故事种子",
        version: "0.2.12",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: { packageKey: "opengrove.story-seed" },
        capabilities: {
          cli: [
            {
              id: "story-seed",
              command: "story-seed",
              doctor: ["doctor"],
              smoke: ["smoke"],
              commands: ["doctor", "smoke"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(storySeedRoot, "bin", "story-seed"),
    "#!/usr/bin/env node\nconsole.log(process.argv[2] === 'doctor' ? 'ok' : 'story-seed')\n",
    "utf8",
  );
  chmodSync(join(storySeedRoot, "bin", "story-seed"), 0o755);
  const storySeedArchivePath = join(tempRoot, "story-seed.tar.gz");
  execFileSync("tar", ["-czf", storySeedArchivePath, "-C", storySeedRoot, "."]);
  const storySeedArchive = readFileSync(storySeedArchivePath);
  const storySeedPackage: AppStorePackageRecord = {
    id: "cloud-story-seed",
    packageKey: "opengrove.story-seed",
    packageId: "opengrove.story-seed",
    title: "故事种子",
    summary: "Story Seed default App",
    version: "0.2.12",
    category: "工作台",
    publishKind: "app",
    installMode: "workspace",
    appId: "story-seed",
    workspaceName: "故事种子 Workspace",
    requirements: [],
    capabilities: [],
    backupScopes: [],
    status: "available",
    publisher: "Harness Cloud",
    usageCount: 0,
    source: "registry",
    archiveName: "story-seed.tar.gz",
    archiveSize: storySeedArchive.byteLength,
    archiveSha256: createHash("sha256").update(storySeedArchive).digest("hex"),
  };
  cloudStorePackages.set(storySeedPackage.id, { pkg: storySeedPackage, bytes: storySeedArchive });

  const retiredKnowledgeVaultPackage: AppStorePackageRecord = {
    ...storySeedPackage,
    id: "cloud-knowledge-vault",
    packageKey: "opengrove.knowledge-vault",
    packageId: "knowledge-vault-release",
    appId: "knowledge-vault",
    title: "资料库",
    summary: "Retired Knowledge Vault App",
  };
  cloudStorePackages.set(retiredKnowledgeVaultPackage.id, {
    pkg: retiredKnowledgeVaultPackage,
    bytes: storySeedArchive,
  });
  const retiredKnowledgeState = createBridgeState({ statePath: join(tempRoot, "retired-knowledge-state.json") });
  const retiredKnowledgeCatalogCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store"),
    state: retiredKnowledgeState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => retiredKnowledgeCatalogCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  assert.equal(
    retiredKnowledgeCatalogCalls[0]?.data.packages.some(
      (item: { packageKey?: string }) => item.packageKey === "opengrove.knowledge-vault",
    ),
    false,
    "the App Store catalog must hide the retired Knowledge Vault package",
  );
  const retiredKnowledgeInstallCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: retiredKnowledgeState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => retiredKnowledgeInstallCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: retiredKnowledgeVaultPackage.id }),
  });
  assert.equal(retiredKnowledgeInstallCalls[0]?.status, 410);
  assert.equal(retiredKnowledgeInstallCalls[0]?.data.error, "app_store_package_retired");
  const retiredKnowledgeArchiveCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: {} } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/packages/knowledge-vault/archive"),
    state: retiredKnowledgeState,
    sendJson: (_response, status, data) => retiredKnowledgeArchiveCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  assert.equal(retiredKnowledgeArchiveCalls[0]?.status, 410);
  assert.equal(retiredKnowledgeArchiveCalls[0]?.data.error, "app_store_package_retired");

  const missingStorySeedPath = join(tempRoot, "story-seed");
  const failedDefaultActivationState = createBridgeState({
    statePath: join(tempRoot, "failed-default-activation-state.json"),
  });
  let failDefaultActivation = true;
  const failedDefaultActivation = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: failedDefaultActivationState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 9,
    activateBridgeApp: (state) => {
      if (failDefaultActivation) {
        failDefaultActivation = false;
        throw new Error("app_store_activation_harness_failure");
      }
      recreateBridgeApp(state);
    },
  });
  assert.equal(failedDefaultActivation.ok, false);
  assert.equal(failedDefaultActivation.installed.length, 0);
  assert.equal(failedDefaultActivation.errors[0]?.error, "app_store_activation_harness_failure");
  assert.equal(existsSync(missingStorySeedPath), false, "failed default activation must roll back its fresh App tree");
  assert.equal(
    failedDefaultActivationState.settings.mountedApps.some((app) => app.id === "story-seed"),
    false,
  );
  assert.notEqual(
    failedDefaultActivationState.settings.defaultAppSync.lastSuccessfulClientReleaseNumber,
    currentHostReleaseNumber + 9,
    "a failed automatic install must leave the Host release eligible for retry",
  );

  const missingStorySeedStatePath = join(tempRoot, "missing-story-seed-state", "state.json");
  const missingStorySeedState = createBridgeState({ statePath: missingStorySeedStatePath });
  missingStorySeedState.settings.mountedApps = [
    {
      id: "story-seed",
      path: missingStorySeedPath,
      title: "故事种子",
      enabled: true,
    },
  ];
  const missingStorySeedSettingsBefore = JSON.stringify(missingStorySeedState.settings.mountedApps);
  const missingStorySeedCatalogCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store"),
    state: missingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => missingStorySeedCatalogCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  const missingStorySeedCatalogItem = missingStorySeedCatalogCalls[0]?.data.packages.find(
    (item: { packageKey?: string }) => item.packageKey === "opengrove.story-seed",
  );
  assert.equal(missingStorySeedCatalogItem?.installed, true);
  assert.equal(missingStorySeedCatalogItem?.openable, false);
  assert.equal(missingStorySeedCatalogItem?.repairable, true);
  assert.equal(missingStorySeedCatalogItem?.updateSafe, false);
  assert.equal(missingStorySeedCatalogItem?.openIssue, "app_root_missing");
  assert.equal(
    existsSync(missingStorySeedPath),
    false,
    "catalog reads must not repair a missing App in the background",
  );
  assert.equal(JSON.stringify(missingStorySeedState.settings.mountedApps), missingStorySeedSettingsBefore);
  const missingStorySeedDefaultSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: missingStorySeedState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
  });
  assert.equal(missingStorySeedDefaultSync.installed.length, 0);
  assert.equal(missingStorySeedDefaultSync.skipped[0]?.reason, "repair_required");
  assert.equal(existsSync(missingStorySeedPath), false, "default App sync must not repair an existing mount record");
  assert.equal(JSON.stringify(missingStorySeedState.settings.mountedApps), missingStorySeedSettingsBefore);

  const aliasMissingStorySeedState = createBridgeState({
    statePath: join(tempRoot, "alias-missing-story-seed-state.json"),
  });
  aliasMissingStorySeedState.settings.mountedApps = [
    {
      id: "story-seed-alias",
      path: missingStorySeedPath,
      enabled: true,
    },
  ];
  const aliasMissingSettingsBefore = JSON.stringify(aliasMissingStorySeedState.settings.mountedApps);
  assert.deepEqual(
    inspectAppStorePackageRuntimeState(
      { ...storySeedPackage, installed: true, installedAppId: "story-seed-alias" },
      aliasMissingStorySeedState.settings,
      { appStoreRoot: tempRoot },
    ),
    { openable: false, repairable: false, updateSafe: false, openIssue: "app_root_missing" },
  );
  const aliasMissingDefaultSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: aliasMissingStorySeedState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
  });
  assert.equal(aliasMissingDefaultSync.installed.length, 0);
  assert.equal(aliasMissingDefaultSync.skipped[0]?.reason, "repair_required");
  assert.equal(
    existsSync(missingStorySeedPath),
    false,
    "default sync must not rewrite a missing alias at the canonical path",
  );
  assert.equal(JSON.stringify(aliasMissingStorySeedState.settings.mountedApps), aliasMissingSettingsBefore);
  const aliasMissingCatalogCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store"),
    state: aliasMissingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => aliasMissingCatalogCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  const aliasMissingCatalogItem = aliasMissingCatalogCalls[0]?.data.packages.find(
    (item: { packageKey?: string }) => item.packageKey === storySeedPackage.packageKey,
  );
  assert.equal(aliasMissingCatalogItem?.installed, true);
  assert.equal(aliasMissingCatalogItem?.openable, false);
  assert.equal(aliasMissingCatalogItem?.repairable, false);
  assert.equal(aliasMissingCatalogItem?.openIssue, "app_root_missing");

  const validAliasDefaultState = createBridgeState({ statePath: join(tempRoot, "valid-alias-default-state.json") });
  validAliasDefaultState.settings.mountedApps = [
    {
      id: "story-seed-alias",
      path: storySeedRoot,
      enabled: true,
    },
  ];
  const validAliasSettingsBefore = JSON.stringify(validAliasDefaultState.settings.mountedApps);
  const validAliasDefaultSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: validAliasDefaultState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
  });
  assert.equal(validAliasDefaultSync.installed.length, 0);
  assert.equal(validAliasDefaultSync.skipped[0]?.reason, "relink_required");
  assert.equal(existsSync(missingStorySeedPath), false, "default sync must preserve a valid custom-path alias");
  assert.equal(JSON.stringify(validAliasDefaultState.settings.mountedApps), validAliasSettingsBefore);

  const missingStorySeedInstallCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: missingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => missingStorySeedInstallCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: storySeedPackage.id }),
  });
  assert.equal(missingStorySeedInstallCalls[0]?.status, 409);
  assert.equal(missingStorySeedInstallCalls[0]?.data.error, "app_store_repair_required");
  assert.equal(existsSync(missingStorySeedPath), false, "the legacy install endpoint must not repair missing files");
  assert.equal(JSON.stringify(missingStorySeedState.settings.mountedApps), missingStorySeedSettingsBefore);

  const noWorkbenchRoot = join(tempRoot, "no-workbench-runtime");
  mkdirSync(noWorkbenchRoot, { recursive: true });
  writeFileSync(
    join(noWorkbenchRoot, "opengrove.app.json"),
    JSON.stringify({ id: "registry-demo-app", title: "Registry Demo App" }),
    "utf8",
  );
  const noWorkbenchState = inspectAppStorePackageRuntimeState(
    { ...cloudRegistryPackage, installed: true, installedAppId: "registry-demo-app" },
    { mountedApps: [{ id: "registry-demo-app", path: noWorkbenchRoot, enabled: true }] },
    { appStoreRoot: tempRoot },
  );
  assert.deepEqual(noWorkbenchState, {
    openable: false,
    repairable: false,
    updateSafe: false,
    openIssue: "ui_not_workbench",
  });

  for (const uiKind of ["native", "custom"] as const) {
    const appId = `${uiKind}-runtime-app`;
    const appRoot = join(tempRoot, appId);
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(
      join(appRoot, "opengrove.app.json"),
      JSON.stringify({ id: appId, title: appId, ui: { kind: uiKind } }),
      "utf8",
    );
    assert.deepEqual(
      inspectAppStorePackageRuntimeState(
        { ...cloudRegistryPackage, id: appId, appId, installed: true, installedAppId: appId },
        { mountedApps: [{ id: appId, path: appRoot, enabled: true }] },
        { appStoreRoot: tempRoot },
      ),
      { openable: false, repairable: false, updateSafe: false, openIssue: "ui_not_workbench" },
      "an App without Store provenance must not be updated even at the canonical path",
    );
  }

  writeFileSync(join(storySeedRoot, "AGENTS.local.md"), "custom App instructions\n", "utf8");
  writeFileSync(join(storySeedRoot, "workspace", "user-outline.md"), "custom outline\n", "utf8");
  assert.deepEqual(
    inspectAppStorePackageRuntimeState(
      { ...storySeedPackage, installed: true, installedAppId: "story-seed" },
      { mountedApps: [{ id: "story-seed", path: registryRoot, enabled: true }] },
      { appStoreRoot: tempRoot },
    ),
    { openable: false, repairable: false, updateSafe: false, openIssue: "app_id_mismatch" },
    "a settings ID must not authorize replacing a different valid App",
  );

  assert.deepEqual(
    inspectAppStorePackageRuntimeState(
      { ...storySeedPackage, installed: true, installedAppId: "story-seed-alias" },
      { mountedApps: [{ id: "story-seed-alias", path: storySeedRoot, enabled: true }] },
      { appStoreRoot: tempRoot },
    ),
    { openable: true, openableAppId: "story-seed", repairable: false, updateSafe: false },
    "a valid alias/custom-path mount should open by manifest ID without changing its mount",
  );
  assert.equal(readFileSync(join(storySeedRoot, "AGENTS.local.md"), "utf8"), "custom App instructions\n");
  assert.equal(readFileSync(join(storySeedRoot, "workspace", "user-outline.md"), "utf8"), "custom outline\n");

  const jsoncRuntimeRoot = join(tempRoot, "jsonc-runtime-app");
  mkdirSync(join(jsoncRuntimeRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(jsoncRuntimeRoot, "opengrove.app.jsonc"),
    `{
      // JSONC manifests use the same parser as the mounted App scanner.
      "id": "jsonc-runtime-app",
      "title": "JSONC Runtime App",
      "ui": { "surface": "file-workbench", "workspace": "workspace", },
      "store": { "packageKey": "harness.jsonc-runtime-app", },
    }`,
    "utf8",
  );
  writeFileSync(join(jsoncRuntimeRoot, "workspace", "keep.md"), "preserve relink workspace\n", "utf8");
  assert.deepEqual(
    inspectAppStorePackageRuntimeState(
      {
        ...cloudRegistryPackage,
        id: "jsonc-runtime-app",
        appId: "jsonc-runtime-app",
        installed: true,
        installedAppId: "jsonc-runtime-app",
      },
      { mountedApps: [{ id: "jsonc-runtime-app", path: jsoncRuntimeRoot, enabled: true }] },
      { appStoreRoot: tempRoot },
    ),
    { openable: true, openableAppId: "jsonc-runtime-app", repairable: false, updateSafe: false },
  );

  const jsoncPackage: AppStorePackageRecord = {
    ...cloudRegistryPackage,
    id: "cloud-jsonc-runtime-app",
    packageId: "harness.jsonc-runtime-app",
    packageKey: "harness.jsonc-runtime-app",
    appId: "jsonc-runtime-app",
    title: "JSONC Runtime App",
  };
  cloudStorePackages.set(jsoncPackage.id, { pkg: jsoncPackage, bytes: registryArchive });
  const jsoncAliasState = createBridgeState({ statePath: join(tempRoot, "jsonc-alias-state.json") });
  jsoncAliasState.settings.mountedApps = [
    {
      id: "jsonc-runtime-alias",
      path: jsoncRuntimeRoot,
      enabled: true,
    },
  ];
  const jsoncCatalogCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store"),
    state: jsoncAliasState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => jsoncCatalogCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  const jsoncCatalogItem = jsoncCatalogCalls[0]?.data.packages.find(
    (item: { packageKey?: string }) => item.packageKey === jsoncPackage.packageKey,
  );
  assert.equal(jsoncCatalogItem?.installed, true);
  assert.equal(jsoncCatalogItem?.installState, "needs_relink");
  assert.equal(jsoncCatalogItem?.openable, true);
  assert.equal(jsoncCatalogItem?.openableAppId, "jsonc-runtime-app");
  assert.equal(jsoncCatalogItem?.openIssue, "store_relink_required");
  assert.equal(jsoncCatalogItem?.updateSafe, false);
  const jsoncMountsBeforeRelink = JSON.stringify(jsoncAliasState.settings.mountedApps);
  const jsoncRelinkCalls: Array<{ status: number; data: any }> = [];
  const jsoncRelinkHandled = await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/relink"),
    state: jsoncAliasState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => jsoncRelinkCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: jsoncPackage.id }),
  });
  assert.equal(jsoncRelinkHandled, true);
  assert.equal(jsoncRelinkCalls[0]?.status, 200);
  assert.equal(jsoncRelinkCalls[0]?.data.relink?.status, "relinked");
  assert.equal(jsoncRelinkCalls[0]?.data.relink?.openable, true);
  assert.equal(JSON.stringify(jsoncAliasState.settings.mountedApps), jsoncMountsBeforeRelink);
  assert.equal(readFileSync(join(jsoncRuntimeRoot, "workspace", "keep.md"), "utf8"), "preserve relink workspace\n");
  const jsoncMarkerPath = join(jsoncRuntimeRoot, ".opengrove-store-package.json");
  const jsoncRelinkMarker = JSON.parse(readFileSync(jsoncMarkerPath, "utf8")) as Record<string, unknown>;
  assert.equal(jsoncRelinkMarker.registryUrl, fakeCloudUrl);
  assert.equal(jsoncRelinkMarker.packageRef, `${fakeCloudUrl}#${jsoncPackage.packageKey}`);
  assert.equal(jsoncRelinkMarker.packageKey, jsoncPackage.packageKey);
  assert.equal(jsoncRelinkMarker.archiveSha256, undefined);
  assert.equal(jsoncRelinkMarker.fingerprint, undefined);
  const jsoncMarkerAfterFirstRelink = readFileSync(jsoncMarkerPath, "utf8");
  const repeatedJsoncRelinkCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/relink"),
    state: jsoncAliasState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => repeatedJsoncRelinkCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: jsoncPackage.id }),
  });
  assert.equal(repeatedJsoncRelinkCalls[0]?.status, 200);
  assert.equal(repeatedJsoncRelinkCalls[0]?.data.relink?.status, "already_linked");
  assert.equal(readFileSync(jsoncMarkerPath, "utf8"), jsoncMarkerAfterFirstRelink);

  assert.deepEqual(
    inspectAppStorePackageRuntimeState(
      { ...storySeedPackage, installed: true, installedAppId: "story-seed" },
      {
        mountedApps: [
          { id: "story-seed", path: storySeedRoot, enabled: true },
          { id: "story-seed", path: missingStorySeedPath, enabled: true },
        ],
      },
      { appStoreRoot: tempRoot },
    ),
    { openable: false, repairable: false, updateSafe: false, openIssue: "mount_conflict" },
  );

  for (const mountedApps of [
    [
      { id: "story-seed", path: missingStorySeedPath, enabled: true },
      { id: "story-seed-alias", path: storySeedRoot, enabled: true },
    ],
    [
      { id: "story-seed-alias", path: storySeedRoot, enabled: true },
      { id: "story-seed", path: missingStorySeedPath, enabled: true },
    ],
  ]) {
    assert.deepEqual(
      inspectAppStorePackageRuntimeState(
        { ...storySeedPackage, installed: true, installedAppId: mountedApps[0]!.id },
        { mountedApps },
        { appStoreRoot: tempRoot },
      ),
      { openable: false, repairable: false, updateSafe: false, openIssue: "mount_conflict" },
      "canonical and alias mounts for one package must conflict independent of settings order",
    );
  }

  const unsavedRoomId = "room-before-story-seed-repair";
  missingStorySeedState.app.rooms.createRoom({
    id: unsavedRoomId,
    title: "Unsaved before repair",
  });

  const storySeedInstallLock = join(
    dirname(missingStorySeedPath),
    ".opengrove-install-locks",
    createHash("sha256").update(resolve(missingStorySeedPath)).digest("hex"),
  );
  mkdirSync(dirname(storySeedInstallLock), { recursive: true });
  mkdirSync(storySeedInstallLock);
  const lockedStorySeedRepairCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: missingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => lockedStorySeedRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: storySeedPackage.id }),
  });
  assert.equal(lockedStorySeedRepairCalls[0]?.status, 409);
  assert.equal(lockedStorySeedRepairCalls[0]?.data.error, "app_store_install_target_changed");
  assert.equal(existsSync(missingStorySeedPath), false, "a competing installer lock must keep the target absent");
  assert.equal(existsSync(storySeedInstallLock), true, "repair must not remove another installer's lock");
  rmSync(storySeedInstallLock, { recursive: true, force: true });

  let failRepairActivation = true;
  const failedStorySeedRepairCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: missingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => failedStorySeedRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: storySeedPackage.id }),
    activateBridgeApp: (state) => {
      if (failRepairActivation) {
        failRepairActivation = false;
        throw new Error("app_store_activation_harness_failure");
      }
      recreateBridgeApp(state);
    },
  });
  assert.equal(failedStorySeedRepairCalls[0]?.status, 500);
  assert.equal(failedStorySeedRepairCalls[0]?.data.error, "app_store_activation_harness_failure");
  assert.match(failedStorySeedRepairCalls[0]?.data.incidentId ?? "", /^OG-\d{8}-[A-F0-9]{6}$/);
  assert.equal(
    existsSync(missingStorySeedPath),
    false,
    "failed repair activation must restore the missing-root state for retry",
  );

  const missingStorySeedRepairCalls: Array<{ status: number; data: any }> = [];
  const missingStorySeedRepairHandled = await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: missingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => missingStorySeedRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: storySeedPackage.id }),
  });
  assert.equal(missingStorySeedRepairHandled, true);
  assert.equal(missingStorySeedRepairCalls[0]?.status, 200);
  assert.equal(missingStorySeedRepairCalls[0]?.data.repair?.status, "repaired");
  assert.equal(missingStorySeedRepairCalls[0]?.data.repair?.openable, true);
  assert.equal(missingStorySeedRepairCalls[0]?.data.repair?.openableAppId, "story-seed");
  const repairedStorySeedMount = missingStorySeedState.settings.mountedApps.find((app) => app.id === "story-seed");
  assert.ok(repairedStorySeedMount);
  assert.notEqual(resolve(repairedStorySeedMount.path), resolve(missingStorySeedPath));
  assert.equal(resolve(repairedStorySeedMount.workspacePath ?? ""), resolve(missingStorySeedPath, "workspace"));
  assert.equal(existsSync(join(repairedStorySeedMount.path, "opengrove.app.json")), true);
  assert.equal(existsSync(storySeedInstallLock), false, "a successful fresh install must release its sibling lock");
  assert.equal(repairedStorySeedMount.id, "story-seed", "repair must preserve the stable mounted App identity");
  const restartedStorySeedMount = loadBridgeSettings(missingStorySeedState).mountedApps.find(
    (app) => app.id === "story-seed",
  );
  assert.ok(restartedStorySeedMount, "repair must persist the replacement mount before reporting success");
  assert.equal(resolve(restartedStorySeedMount.path), resolve(repairedStorySeedMount.path));
  assert.equal(resolve(restartedStorySeedMount.workspacePath ?? ""), resolve(missingStorySeedPath, "workspace"));
  assert.ok(
    missingStorySeedState.app.rooms.getRoom(unsavedRoomId),
    "repair must persist in-memory runtime state before rebuilding the Bridge App",
  );
  const repairedStorySeedCatalogCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store"),
    state: missingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => repairedStorySeedCatalogCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  const repairedStorySeedCatalogItem = repairedStorySeedCatalogCalls[0]?.data.packages.find(
    (item: { packageKey?: string }) => item.packageKey === "opengrove.story-seed",
  );
  assert.equal(repairedStorySeedCatalogItem?.openable, true);
  assert.equal(repairedStorySeedCatalogItem?.openableAppId, "story-seed");
  assert.equal(repairedStorySeedCatalogItem?.repairable, false);
  assert.equal(repairedStorySeedCatalogItem?.updateSafe, true);

  const aliasUpdateState = createBridgeState({ statePath: join(tempRoot, "alias-update-state.json") });
  aliasUpdateState.settings.mountedApps = [
    {
      id: "story-seed-alias",
      path: storySeedRoot,
      enabled: true,
    },
  ];
  const aliasUpdateSettingsBefore = JSON.stringify(aliasUpdateState.settings.mountedApps);
  const aliasInstructionsBefore = readFileSync(join(storySeedRoot, "AGENTS.local.md"), "utf8");
  const aliasWorkspaceBefore = readFileSync(join(storySeedRoot, "workspace", "user-outline.md"), "utf8");
  const aliasUpdateCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: aliasUpdateState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => aliasUpdateCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: storySeedPackage.id }),
  });
  assert.equal(aliasUpdateCalls[0]?.status, 409);
  assert.equal(aliasUpdateCalls[0]?.data.error, "app_store_relink_required");
  assert.equal(JSON.stringify(aliasUpdateState.settings.mountedApps), aliasUpdateSettingsBefore);
  assert.equal(readFileSync(join(storySeedRoot, "AGENTS.local.md"), "utf8"), aliasInstructionsBefore);
  assert.equal(readFileSync(join(storySeedRoot, "workspace", "user-outline.md"), "utf8"), aliasWorkspaceBefore);

  const alternateStorySeedPackage: AppStorePackageRecord = {
    ...storySeedPackage,
    id: "cloud-story-seed-alternate",
    packageId: "alternate.story-seed",
    packageKey: "alternate.story-seed",
    publisher: "Alternate Publisher",
  };
  cloudStorePackages.set(alternateStorySeedPackage.id, { pkg: alternateStorySeedPackage, bytes: storySeedArchive });
  const alternatePublisherCatalogCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store"),
    state: missingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => alternatePublisherCatalogCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  const alternatePublisherCatalogItem = alternatePublisherCatalogCalls[0]?.data.packages.find(
    (item: { packageKey?: string }) => item.packageKey === alternateStorySeedPackage.packageKey,
  );
  assert.equal(alternatePublisherCatalogItem?.installed, false);
  assert.equal(alternatePublisherCatalogItem?.installState, "source_conflict");
  assert.equal(alternatePublisherCatalogItem?.updateAvailable, false);
  assert.equal(alternatePublisherCatalogItem?.openIssue, "source_conflict");
  const storySeedMarkerBefore = readFileSync(
    join(repairedStorySeedMount.path, ".opengrove-store-package.json"),
    "utf8",
  );
  const alternatePublisherInstallCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: missingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => alternatePublisherInstallCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: alternateStorySeedPackage.id }),
  });
  assert.equal(alternatePublisherInstallCalls[0]?.status, 409);
  assert.equal(alternatePublisherInstallCalls[0]?.data.error, "app_store_source_conflict");
  assert.equal(
    readFileSync(join(repairedStorySeedMount.path, ".opengrove-store-package.json"), "utf8"),
    storySeedMarkerBefore,
    "a package with the same appId but a different packageKey must not replace the installed App",
  );

  const manualCanonicalPackage: AppStorePackageRecord = {
    ...storySeedPackage,
    id: "cloud-manual-canonical-app",
    packageId: "harness.manual-canonical-app",
    packageKey: "harness.manual-canonical-app",
    appId: "manual-canonical-app",
    title: "Manual Canonical App",
  };
  cloudStorePackages.set(manualCanonicalPackage.id, { pkg: manualCanonicalPackage, bytes: storySeedArchive });
  const manualCanonicalRoot = join(tempRoot, manualCanonicalPackage.appId);
  mkdirSync(join(manualCanonicalRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(manualCanonicalRoot, "opengrove.app.json"),
    JSON.stringify({
      id: manualCanonicalPackage.appId,
      ui: { surface: "file-workbench", workspace: "workspace" },
      store: { packageKey: manualCanonicalPackage.packageKey },
    }),
    "utf8",
  );
  writeFileSync(join(manualCanonicalRoot, "workspace", "user-content.md"), "preserve manual content\n", "utf8");
  const manualCanonicalState = createBridgeState({ statePath: join(tempRoot, "manual-canonical-state.json") });
  manualCanonicalState.settings.mountedApps = [
    {
      id: manualCanonicalPackage.appId,
      path: manualCanonicalRoot,
      enabled: true,
    },
  ];
  const manualCanonicalInstallCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: manualCanonicalState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => manualCanonicalInstallCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: manualCanonicalPackage.id }),
  });
  assert.equal(manualCanonicalInstallCalls[0]?.status, 409);
  assert.equal(manualCanonicalInstallCalls[0]?.data.error, "app_store_relink_required");
  assert.equal(
    readFileSync(join(manualCanonicalRoot, "workspace", "user-content.md"), "utf8"),
    "preserve manual content\n",
    "a hand-managed App at the canonical path must not be treated as Store-managed",
  );

  const healthyRepairCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: missingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => healthyRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: storySeedPackage.id }),
  });
  assert.equal(healthyRepairCalls[0]?.status, 409);
  assert.equal(healthyRepairCalls[0]?.data.error, "app_store_repair_not_available");

  const missingRepairPackageIdCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: missingStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => missingRepairPackageIdCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  assert.equal(missingRepairPackageIdCalls[0]?.status, 400);
  assert.equal(missingRepairPackageIdCalls[0]?.data.error, "app_store_package_id_required");

  const identityConflictState = createBridgeState({ statePath: join(tempRoot, "identity-conflict-state.json") });
  identityConflictState.settings.mountedApps = [
    {
      id: "story-seed",
      path: registryRoot,
      enabled: true,
    },
  ];
  const identityConflictSettingsBefore = JSON.stringify(identityConflictState.settings.mountedApps);
  const identityConflictManifestBefore = readFileSync(join(registryRoot, "opengrove.app.json"), "utf8");
  const identityConflictRepairCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: identityConflictState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => identityConflictRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: storySeedPackage.id }),
  });
  assert.equal(identityConflictRepairCalls[0]?.status, 409);
  assert.equal(identityConflictRepairCalls[0]?.data.error, "app_store_repair_not_available");
  assert.equal(JSON.stringify(identityConflictState.settings.mountedApps), identityConflictSettingsBefore);
  assert.equal(readFileSync(join(registryRoot, "opengrove.app.json"), "utf8"), identityConflictManifestBefore);

  const corruptStorySeedRoot = join(tempRoot, "corrupt-story-seed");
  mkdirSync(join(corruptStorySeedRoot, "workspace"), { recursive: true });
  writeFileSync(join(corruptStorySeedRoot, "opengrove.app.json"), "{ invalid", "utf8");
  writeFileSync(join(corruptStorySeedRoot, "workspace", "user-story.md"), "keep me\n", "utf8");
  const corruptStorySeedState = createBridgeState({ statePath: join(tempRoot, "corrupt-story-seed-state.json") });
  corruptStorySeedState.settings.mountedApps = [{ id: "story-seed", path: corruptStorySeedRoot, enabled: true }];
  assert.deepEqual(
    inspectAppStorePackageRuntimeState(
      { ...storySeedPackage, installed: true, installedAppId: "story-seed" },
      corruptStorySeedState.settings,
      { appStoreRoot: tempRoot },
    ),
    { openable: false, repairable: false, updateSafe: false, openIssue: "manifest_invalid" },
  );
  const corruptStorySeedRepairCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: corruptStorySeedState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => corruptStorySeedRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: storySeedPackage.id }),
  });
  assert.equal(corruptStorySeedRepairCalls[0]?.status, 409);
  assert.equal(readFileSync(join(corruptStorySeedRoot, "opengrove.app.json"), "utf8"), "{ invalid");
  assert.equal(readFileSync(join(corruptStorySeedRoot, "workspace", "user-story.md"), "utf8"), "keep me\n");

  const customMissingStorySeedPath = join(tempRoot, "custom-missing-story-seed");
  const customMissingState = createBridgeState({ statePath: join(tempRoot, "custom-missing-state.json") });
  customMissingState.settings.mountedApps = [
    {
      id: "story-seed",
      path: customMissingStorySeedPath,
      enabled: true,
    },
  ];
  const customMissingRepairCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: customMissingState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => customMissingRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: storySeedPackage.id }),
  });
  assert.equal(customMissingRepairCalls[0]?.status, 409);
  assert.equal(customMissingRepairCalls[0]?.data.error, "app_store_repair_not_available");
  assert.equal(existsSync(customMissingStorySeedPath), false);

  const unavailableRepairPackage: AppStorePackageRecord = {
    ...storySeedPackage,
    id: "cloud-unavailable-repair-app",
    packageId: "harness.unavailable-repair-app",
    packageKey: "harness.unavailable-repair-app",
    appId: "unavailable-repair-app",
    title: "Unavailable Repair App",
    archiveName: "unavailable-repair-app.tar.gz",
  };
  cloudStorePackages.set(unavailableRepairPackage.id, { pkg: unavailableRepairPackage, bytes: storySeedArchive });
  failingSignedDownloadPackageIds.add(unavailableRepairPackage.packageKey!);
  const unavailableRepairState = createBridgeState({ statePath: join(tempRoot, "unavailable-repair-state.json") });
  unavailableRepairState.settings.mountedApps = [
    {
      id: unavailableRepairPackage.appId,
      path: join(tempRoot, unavailableRepairPackage.appId),
      enabled: true,
    },
  ];
  const unavailableRepairCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: unavailableRepairState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => unavailableRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: unavailableRepairPackage.id }),
  });
  failingSignedDownloadPackageIds.delete(unavailableRepairPackage.packageKey!);
  assert.equal(unavailableRepairCalls[0]?.status, 502);
  assert.equal(unavailableRepairCalls[0]?.data.error, "registry_request_failed:503");
  assert.match(unavailableRepairCalls[0]?.data.incidentId ?? "", /^OG-\d{8}-[A-F0-9]{6}$/);
  assert.equal(typeof unavailableRepairCalls[0]?.data.traceId, "string");

  const invalidRepairArchive = Buffer.from("not a tar archive", "utf8");
  const invalidRepairPackage: AppStorePackageRecord = {
    ...storySeedPackage,
    id: "cloud-invalid-repair-app",
    packageId: "harness.invalid-repair-app",
    packageKey: "harness.invalid-repair-app",
    appId: "invalid-repair-app",
    title: "Invalid Repair App",
    archiveName: "invalid-repair-app.tar.gz",
    archiveSize: invalidRepairArchive.byteLength,
    archiveSha256: createHash("sha256").update(invalidRepairArchive).digest("hex"),
  };
  cloudStorePackages.set(invalidRepairPackage.id, { pkg: invalidRepairPackage, bytes: invalidRepairArchive });
  const invalidRepairPath = join(tempRoot, invalidRepairPackage.appId);
  const invalidRepairState = createBridgeState({ statePath: join(tempRoot, "invalid-repair-state.json") });
  invalidRepairState.settings.mountedApps = [
    {
      id: invalidRepairPackage.appId,
      path: invalidRepairPath,
      enabled: true,
    },
  ];
  const invalidRepairSettingsBefore = JSON.stringify(invalidRepairState.settings.mountedApps);
  const invalidRepairCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: invalidRepairState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => invalidRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: invalidRepairPackage.id }),
  });
  assert.equal(invalidRepairCalls[0]?.status, 500);
  assert.equal(existsSync(invalidRepairPath), false, "a failed archive repair must not expose a partial App root");
  assert.equal(JSON.stringify(invalidRepairState.settings.mountedApps), invalidRepairSettingsBefore);

  const missingInvalidRepairTarget = join(tempRoot, "missing-invalid-repair-target");
  if (process.platform === "win32") {
    mkdirSync(missingInvalidRepairTarget, { recursive: true });
    symlinkSync(missingInvalidRepairTarget, invalidRepairPath, "junction");
    rmSync(missingInvalidRepairTarget, { recursive: true, force: true });
  } else {
    symlinkSync(missingInvalidRepairTarget, invalidRepairPath);
  }
  const danglingRepairCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: invalidRepairState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => danglingRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: invalidRepairPackage.id }),
  });
  assert.equal(danglingRepairCalls[0]?.status, 409);
  assert.equal(danglingRepairCalls[0]?.data.error, "app_store_repair_not_available");
  assert.equal(lstatSync(invalidRepairPath).isSymbolicLink(), true, "repair must preserve a dangling symlink target");

  const disabledRepairState = createBridgeState({ statePath: join(tempRoot, "disabled-repair-state.json") });
  disabledRepairState.settings.mountedApps = [
    {
      id: "story-seed",
      path: missingStorySeedPath,
      enabled: false,
    },
  ];
  const disabledRepairCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/repair"),
    state: disabledRepairState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => disabledRepairCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: storySeedPackage.id }),
  });
  assert.equal(disabledRepairCalls[0]?.status, 409);
  assert.equal(disabledRepairCalls[0]?.data.error, "app_store_repair_not_available");

  const cloudRecruitState = createBridgeState({ statePath: join(tempRoot, "cloud-recruit-state.json") });
  const cloudCatalogCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => cloudCatalogCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  assert.equal(cloudCatalogCalls[0]?.status, 200);
  assert.equal(cloudCatalogCalls[0]?.data.profile, "local");
  assert.equal(cloudCatalogCalls[0]?.data.registryConfigured, true);
  const cloudCatalogPackage = cloudCatalogCalls[0]?.data.packages.find(
    (item: { id: string }) => item.id === cloudRegistryPackage.id,
  );
  assert.equal(cloudCatalogPackage?.source, "registry");
  assert.equal(cloudCatalogPackage?.packageKey, "harness.registry-demo-app");
  assert.equal(cloudCatalogPackage?.installed, false);
  assert.equal(
    cloudCatalogCalls[0]?.data.packages.some((item: { id: string }) => item.id === traversalRegistryPackage.id),
    false,
    "registry packages with an invalid appId must be rejected during normalization",
  );
  assert.equal(
    cloudCatalogCalls[0]?.data.packages.some((item: { id: string }) => item.id === traversalRegistryIdPackage.id),
    false,
    "registry packages with an invalid id must be rejected during normalization",
  );

  const traversalInstallCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => traversalInstallCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: traversalRegistryPackage.id }),
  });
  assert.equal(traversalInstallCalls[0]?.status, 404);
  assert.equal(traversalInstallCalls[0]?.data.error, "app_store_package_not_found");
  assert.equal(
    existsSync(escapedRegistryInstallRoot),
    false,
    "invalid registry appId must not write outside the Apps root",
  );

  const poisonedCacheState = createBridgeState({ statePath: join(tempRoot, "poisoned-cache-state.json") });
  assert.throws(
    () =>
      importAppStorePackage({
        state: poisonedCacheState,
        package: traversalRegistryPackage,
        archiveBytes: registryArchive,
      }),
    /app_store_package_invalid/,
    "the local import cache must reject an invalid appId",
  );
  assert.throws(
    () =>
      importAppStorePackage({
        state: poisonedCacheState,
        package: traversalRegistryIdPackage,
        archiveBytes: registryArchive,
      }),
    /app_store_package_invalid/,
    "the local import cache must reject an invalid package id",
  );
  assert.equal(existsSync(join(appStoreDataRoot(poisonedCacheState), "evil")), false);
  assert.equal(
    existsSync(escapedRegistryInstallRoot),
    false,
    "defense-in-depth checks must keep the escaped target absent",
  );

  const registryDemoRevisionRoot = join(appStoreDataRoot(cloudRecruitState), "app-revisions");
  const registryDemoGitDirectory = managedAppRevisionGitDirectory(registryDemoRevisionRoot, "registry-demo-app");
  let failFreshInstallActivation = true;
  const failedCloudRecruitCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => failedCloudRecruitCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
    activateBridgeApp: (state) => {
      if (failFreshInstallActivation) {
        failFreshInstallActivation = false;
        throw new Error("app_store_activation_harness_failure");
      }
      recreateBridgeApp(state);
    },
  });
  assert.equal(failedCloudRecruitCalls[0]?.status, 500);
  assert.equal(failedCloudRecruitCalls[0]?.data.error, "app_store_activation_harness_failure");
  assert.equal(
    existsSync(join(tempRoot, "registry-demo-app")),
    false,
    "failed fresh activation must remove only the tree created by that request",
  );
  assert.equal(
    cloudRecruitState.settings.mountedApps.some((app) => app.id === "registry-demo-app"),
    false,
  );
  assert.equal(
    existsSync(registryDemoGitDirectory),
    false,
    "failed fresh activation must remove the revision repository created by that request",
  );

  const registryDemoProgramBucket = join(
    currentAppStoreProgramsRoot(appStoreDataRoot(cloudRecruitState)),
    "registry-demo-app",
  );
  const registryDemoGenerations = () =>
    existsSync(registryDemoProgramBucket) ? readdirSync(registryDemoProgramBucket).sort() : [];
  const generationsBeforeFreshRevisionFailure = registryDemoGenerations();
  rmSync(registryDemoGitDirectory, { recursive: true, force: true });
  mkdirSync(dirname(registryDemoGitDirectory), { recursive: true });
  writeFileSync(registryDemoGitDirectory, "block revision repository creation\n", "utf8");
  const settingsBeforeFreshRevisionFailure = structuredClone(cloudRecruitState.settings);
  const failedFreshRevisionCalls: Array<{ status: number; data: any }> = [];
  try {
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/install"),
      state: cloudRecruitState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => failedFreshRevisionCalls.push({ status, data }),
      readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
    });
  } finally {
    rmSync(registryDemoGitDirectory, { recursive: true, force: true });
  }
  assert.equal(failedFreshRevisionCalls[0]?.status, 500);
  assert.deepEqual(
    cloudRecruitState.settings,
    settingsBeforeFreshRevisionFailure,
    "a failed initial save point must restore mounted App settings",
  );
  assert.equal(
    existsSync(join(tempRoot, "registry-demo-app")),
    false,
    "a failed initial save point must remove the uncommitted fresh installation",
  );
  assert.deepEqual(
    registryDemoGenerations(),
    generationsBeforeFreshRevisionFailure,
    "a failed initial save point must remove the uncommitted fresh program generation",
  );

  const settingsBeforePostCreateRevisionFailure = structuredClone(cloudRecruitState.settings);
  const generationsBeforePostCreateRevisionFailure = registryDemoGenerations();
  const failingRevisionStore: Pick<AppRevisionStore, "saveIfChanged"> = {
    async saveIfChanged(target) {
      await new AppRevisionStore(registryDemoRevisionRoot).saveIfChanged(target);
      throw new Error("injected_post_revision_create_failure");
    },
  };
  await assert.rejects(
    () =>
      installAppStorePackage({
        packageId: cloudRegistryPackage.id,
        settings: cloudRecruitState.settings,
        state: cloudRecruitState,
        storeRoot: appStoreDataRoot(cloudRecruitState),
        revisions: failingRevisionStore,
      }),
    /injected_post_revision_create_failure/,
  );
  assert.deepEqual(cloudRecruitState.settings, settingsBeforePostCreateRevisionFailure);
  assert.deepEqual(registryDemoGenerations(), generationsBeforePostCreateRevisionFailure);
  assert.equal(
    existsSync(registryDemoGitDirectory),
    false,
    "a failed fresh install must remove a revision repository created by that attempt",
  );

  const cloudRecruitCalls: Array<{ status: number; data: any }> = [];
  lastSignedDownloadAuthorization = undefined;
  lastSignedDownloadClientRelease = undefined;
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => cloudRecruitCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
  });
  assert.equal(cloudRecruitCalls[0]?.status, 200, JSON.stringify(cloudRecruitCalls[0]?.data));
  assert.equal(cloudRecruitCalls[0]?.data.install?.installMode, "workspace");
  assert.equal(cloudRecruitCalls[0]?.data.install?.mountedApp?.id, "registry-demo-app");
  assert.equal(cloudRecruitCalls[0]?.data.install?.openable, true);
  assert.equal(cloudRecruitCalls[0]?.data.install?.openableAppId, "registry-demo-app");
  assert.equal(
    lastSignedDownloadAuthorization,
    undefined,
    "OSS signed archive download must not receive registry bearer token",
  );
  assert.equal(
    lastSignedDownloadClientRelease,
    String(currentHostReleaseNumber),
    "the exact archive download must carry the Host release used to select a compatible catalog version",
  );
  const registryDemoMountAfterFresh = cloudRecruitState.settings.mountedApps.find(
    (app) => app.id === "registry-demo-app",
  );
  assert.ok(registryDemoMountAfterFresh);
  assert.notEqual(resolve(registryDemoMountAfterFresh.path), resolve(tempRoot, "registry-demo-app"));
  assert.equal(
    resolve(dirname(dirname(registryDemoMountAfterFresh.path))),
    resolve(currentAppStoreProgramsRoot(appStoreDataRoot(cloudRecruitState)), "registry-demo-app"),
    "fresh Store programs must use a readable app-id bucket instead of an opaque hash",
  );
  assert.equal(
    resolve(registryDemoMountAfterFresh.workspacePath ?? ""),
    resolve(tempRoot, "registry-demo-app", "workspace"),
  );
  assert.equal(existsSync(join(registryDemoMountAfterFresh.path, "opengrove.app.json")), true);
  assert.equal(
    registryDemoGitDirectory,
    managedAppRevisionGitDirectory(registryDemoRevisionRoot, registryDemoMountAfterFresh.id),
  );
  assert.equal(
    readFileSync(join(registryDemoMountAfterFresh.path, ".git"), "utf8"),
    `gitdir: ${registryDemoGitDirectory}\n`,
    "a Store App must be a Git working copy before install returns success",
  );
  const registryDemoRevision = await new AppRevisionStore(registryDemoRevisionRoot).inspect({
    localAppId: registryDemoMountAfterFresh.id,
    appRoot: registryDemoMountAfterFresh.path,
    workspacePath: "workspace",
  });
  assert.match(registryDemoRevision.commitSha, /^[a-f0-9]{40}$/);
  assert.equal(registryDemoRevision.dirty, false, "the installed package must be the initial clean save point");
  writeFileSync(join(registryDemoMountAfterFresh.workspacePath!, "agent-note.md"), "workspace stays local\n", "utf8");
  assert.equal(
    (
      await new AppRevisionStore(registryDemoRevisionRoot).inspect({
        localAppId: registryDemoMountAfterFresh.id,
        appRoot: registryDemoMountAfterFresh.path,
        workspacePath: "workspace",
      })
    ).dirty,
    false,
    "Workspace changes must not dirty the App source repository",
  );
  const cloudCatalogAfterRecruitCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => cloudCatalogAfterRecruitCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  assert.equal(cloudCatalogAfterRecruitCalls[0]?.status, 200);
  assert.equal(
    cloudCatalogAfterRecruitCalls[0]?.data.packages.find((item: { id: string }) => item.id === cloudRegistryPackage.id)
      ?.installed,
    true,
    "registry app install must show as installed on the next catalog refresh",
  );
  assert.equal(
    listAppStorePackages(cloudRecruitState.settings, {
      storeRoot: appStoreDataRoot(cloudRecruitState),
      installedEmployeePackageIds: installedEmployeePackageIds(cloudRecruitState),
      state: cloudRecruitState,
    }).find((item) => item.id === cloudRegistryPackage.id)?.installed,
    true,
  );

  const legacyMarkerPath = join(registryDemoMountAfterFresh.path, ".opengrove-store-package.json");
  const legacyMarker = JSON.parse(readFileSync(legacyMarkerPath, "utf8")) as Record<string, unknown>;
  delete legacyMarker.archiveSha256;
  delete legacyMarker.fingerprint;
  writeFileSync(legacyMarkerPath, `${JSON.stringify(legacyMarker, null, 2)}\n`, "utf8");
  writeFileSync(
    join(tempRoot, "registry-demo-app", "workspace", "legacy-note.md"),
    "preserve legacy workspace\n",
    "utf8",
  );
  const legacyCatalogCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => legacyCatalogCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  const legacyCatalogItem = legacyCatalogCalls[0]?.data.packages.find(
    (item: { id: string }) => item.id === cloudRegistryPackage.id,
  );
  assert.equal(legacyCatalogItem?.installed, true);
  assert.equal(legacyCatalogItem?.installState, "legacy_unknown");
  assert.equal(legacyCatalogItem?.updateAvailable, false);
  assert.equal(legacyCatalogItem?.updateSafe, true);
  assert.equal(legacyCatalogItem?.openIssue, "install_evidence_missing");
  const legacyReinstallCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => legacyReinstallCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
  });
  assert.equal(legacyReinstallCalls[0]?.status, 200);
  const registryDemoMountAfterLegacyReinstall = cloudRecruitState.settings.mountedApps.find(
    (app) => app.id === "registry-demo-app",
  );
  assert.ok(registryDemoMountAfterLegacyReinstall);
  const restoredLegacyMarker = JSON.parse(
    readFileSync(join(registryDemoMountAfterLegacyReinstall.path, ".opengrove-store-package.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(restoredLegacyMarker.archiveSha256, cloudRegistryPackage.archiveSha256);
  assert.equal(
    readFileSync(join(tempRoot, "registry-demo-app", "workspace", "legacy-note.md"), "utf8"),
    "preserve legacy workspace\n",
  );

  const badChecksumPackage: AppStorePackageRecord = {
    ...cloudRegistryPackage,
    id: "harness.bad-checksum-app",
    packageKey: "harness.bad-checksum-app",
    packageId: "bad-checksum-app",
    appId: "bad-checksum-app",
    title: "Bad Checksum App",
    archiveSha256: "0".repeat(64),
  };
  cloudStorePackages.set(badChecksumPackage.id, { pkg: badChecksumPackage, bytes: registryArchive });
  const badChecksumState = createBridgeState({ statePath: join(tempRoot, "bad-checksum-state.json") });
  const badChecksumCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: badChecksumState,
    traceId: "trace-app-store-bad-checksum",
    security: sessionSecurity,
    sendJson: (_response, status, data) => badChecksumCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: badChecksumPackage.id }),
  });
  assert.equal(badChecksumCalls[0]?.status, 502);
  assert.equal(badChecksumCalls[0]?.data.error, "app_store_archive_checksum_mismatch");
  assert.equal(badChecksumCalls[0]?.data.traceId, "trace-app-store-bad-checksum");
  assert.match(badChecksumCalls[0]?.data.incidentId ?? "", /^OG-\d{8}-[A-F0-9]{6}$/);
  assert.equal(existsSync(join(tempRoot, "bad-checksum-app", "opengrove.app.json")), false);

  const malformedChecksumRoot = join(tempRoot, "malformed-checksum-source");
  mkdirSync(join(malformedChecksumRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(malformedChecksumRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "malformed-checksum-app",
      title: "Malformed Checksum App",
      version: "1.0.0",
      ui: { surface: "file-workbench", workspace: "workspace" },
      workspace: { path: "workspace" },
      store: { packageKey: "harness.malformed-checksum-app" },
    }),
    "utf8",
  );
  const malformedChecksumArchivePath = join(tempRoot, "malformed-checksum-app.tar.gz");
  execFileSync("tar", ["-czf", malformedChecksumArchivePath, "-C", malformedChecksumRoot, "."]);
  const malformedChecksumArchive = readFileSync(malformedChecksumArchivePath);
  const malformedChecksumPackage: AppStorePackageRecord = {
    ...cloudRegistryPackage,
    id: "harness.malformed-checksum-app",
    packageKey: "harness.malformed-checksum-app",
    packageId: "malformed-checksum-app",
    appId: "malformed-checksum-app",
    title: "Malformed Checksum App",
    archiveSize: malformedChecksumArchive.byteLength,
    archiveSha256: "bad-value",
  };
  cloudStorePackages.set(malformedChecksumPackage.id, {
    pkg: malformedChecksumPackage,
    bytes: malformedChecksumArchive,
  });
  const malformedChecksumState = createBridgeState({
    statePath: join(tempRoot, "malformed-checksum-state.json"),
  });
  const malformedChecksumCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: malformedChecksumState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => malformedChecksumCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: malformedChecksumPackage.id }),
  });
  assert.equal(malformedChecksumCalls[0]?.status, 502);
  assert.equal(malformedChecksumCalls[0]?.data.error, "app_store_archive_checksum_invalid");
  assert.equal(existsSync(join(tempRoot, "malformed-checksum-app", "opengrove.app.json")), false);

  const defaultAppsInstallRoot = join(tempRoot, "default-apps-install-root");
  process.env.OPENGROVE_APP_STORE_APPS_DIR = defaultAppsInstallRoot;
  const defaultAppsStatePath = join(tempRoot, "default-apps-state", "state.json");
  const defaultAppsState = createBridgeState({ statePath: defaultAppsStatePath });
  assert.equal(
    defaultAppsState.settings.mountedApps.some((app) => app.id === "story-seed"),
    false,
    "story-seed should not be mounted before authenticated default App sync",
  );
  const defaultAppsSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: defaultAppsState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
  });
  assert.equal(defaultAppsSync.ok, true);
  assert.equal(defaultAppsSync.policyKey, "standard");
  assert.equal(defaultAppsSync.assignmentSource, "migration");
  assert.equal(defaultAppsSync.installed[0]?.appId, "story-seed");
  assert.equal(
    defaultAppsState.settings.mountedApps.some((app) => app.id === "story-seed" && app.enabled !== false),
    true,
  );
  const defaultStorySeedMount = defaultAppsState.settings.mountedApps.find((app) => app.id === "story-seed");
  assert.ok(defaultStorySeedMount);
  assert.equal(existsSync(join(defaultStorySeedMount.path, "opengrove.app.json")), true);
  assert.equal(
    resolve(defaultStorySeedMount.workspacePath ?? ""),
    resolve(defaultAppsInstallRoot, "story-seed", "workspace"),
  );
  assert.equal(defaultAppsState.settings.defaultAppSync.lastSuccessfulClientReleaseNumber, currentHostReleaseNumber);
  assert.deepEqual(defaultAppsState.settings.defaultAppSync.managedPackageKeys, ["opengrove.story-seed"]);
  const repeatDefaultAppsSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: defaultAppsState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
  });
  assert.equal(repeatDefaultAppsSync.installed.length, 0);
  assert.equal(repeatDefaultAppsSync.updated.length, 0);
  assert.equal(repeatDefaultAppsSync.skipped[0]?.reason, "already_installed");

  writeFileSync(
    join(defaultAppsInstallRoot, "story-seed", "workspace", "user-draft.md"),
    "keep this draft during the automatic update\n",
    "utf8",
  );
  const storySeedUpdateRoot = join(tempRoot, "story-seed-update-source");
  mkdirSync(join(storySeedUpdateRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(storySeedUpdateRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "story-seed",
        title: "故事种子",
        version: "0.2.13",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: { packageKey: "opengrove.story-seed" },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(storySeedUpdateRoot, "updated.txt"), "updated by Host release sync\n", "utf8");
  const storySeedUpdateArchivePath = join(tempRoot, "story-seed-0.2.13.tar.gz");
  execFileSync("tar", ["-czf", storySeedUpdateArchivePath, "-C", storySeedUpdateRoot, "."]);
  const storySeedUpdateArchive = readFileSync(storySeedUpdateArchivePath);
  const storySeedUpdatePackage: AppStorePackageRecord = {
    ...storySeedPackage,
    version: "0.2.13",
    archiveName: "story-seed-0.2.13.tar.gz",
    archiveSize: storySeedUpdateArchive.byteLength,
    archiveSha256: createHash("sha256").update(storySeedUpdateArchive).digest("hex"),
  };
  cloudStorePackages.set(storySeedPackage.id, { pkg: storySeedUpdatePackage, bytes: storySeedUpdateArchive });
  const upgradedHostSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: defaultAppsState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 1,
  });
  assert.equal(upgradedHostSync.ok, true);
  assert.equal(upgradedHostSync.updated[0]?.appId, "story-seed");
  const upgradedDefaultStorySeedMount = defaultAppsState.settings.mountedApps.find((app) => app.id === "story-seed");
  assert.ok(upgradedDefaultStorySeedMount);
  assert.notEqual(resolve(upgradedDefaultStorySeedMount.path), resolve(defaultStorySeedMount.path));
  assert.equal(existsSync(join(upgradedDefaultStorySeedMount.path, "updated.txt")), true);
  assert.equal(
    readFileSync(join(defaultAppsInstallRoot, "story-seed", "workspace", "user-draft.md"), "utf8"),
    "keep this draft during the automatic update\n",
    "automatic default App updates must preserve the App Workspace",
  );
  assert.equal(
    defaultAppsState.settings.defaultAppSync.lastSuccessfulClientReleaseNumber,
    currentHostReleaseNumber + 1,
  );

  cloudStorePackages.set(storySeedPackage.id, { pkg: storySeedPackage, bytes: storySeedArchive });
  const noDowngradeSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: defaultAppsState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 2,
  });
  assert.equal(noDowngradeSync.updated.length, 0);
  assert.equal(noDowngradeSync.skipped[0]?.reason, "installed_newer");
  assert.equal(existsSync(join(upgradedDefaultStorySeedMount.path, "updated.txt")), true);

  cloudStorePackages.set(storySeedPackage.id, {
    pkg: { ...storySeedUpdatePackage, version: "0.2.14" },
    bytes: storySeedUpdateArchive,
  });
  const downloadsBeforeSameHostSync = signedDownloadRequestCount;
  const sameHostSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: defaultAppsState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 2,
  });
  assert.equal(sameHostSync.updated.length, 0);
  assert.equal(sameHostSync.skipped[0]?.reason, "already_installed");
  assert.equal(
    signedDownloadRequestCount,
    downloadsBeforeSameHostSync,
    "the same Host release must not download default App updates again",
  );

  defaultAppsState.settings.defaultAppSync.managedPackageKeys = [];
  const downloadsBeforeManualInstallSync = signedDownloadRequestCount;
  const manualInstallSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: defaultAppsState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 3,
  });
  assert.equal(manualInstallSync.updated.length, 0);
  assert.equal(manualInstallSync.skipped[0]?.reason, "installed_manually");
  assert.equal(
    signedDownloadRequestCount,
    downloadsBeforeManualInstallSync,
    "a trusted Store App not installed by the default policy must stay user-managed",
  );
  const manualStoreVersionState = new MountedAppVersionStateStore(
    join(appStoreDataRoot(defaultAppsState), "version-state"),
  );
  const manualStoreTarget = resolveMountedAppTarget(defaultAppsState, "story-seed");
  assert.ok(manualStoreTarget);
  manualStoreVersionState.write({
    localAppId: manualStoreTarget.localAppId,
    activeContent: "formal",
    selectedVersion: {
      packageKey: "opengrove.story-seed",
      version: storySeedUpdatePackage.version,
      archiveSha256: storySeedUpdatePackage.archiveSha256!,
    },
    activeContentDigest: mountedAppWorkingDigest(defaultAppsState, manualStoreTarget),
  });

  const automaticUpdateSource = join(tempRoot, "story-seed-auto-update-source");
  mkdirSync(join(automaticUpdateSource, "workspace"), { recursive: true });
  writeFileSync(
    join(automaticUpdateSource, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "story-seed",
        title: "故事种子",
        version: "0.2.14",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: { packageKey: "opengrove.story-seed" },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(automaticUpdateSource, "auto-updated.txt"), "updated by automatic App updates\n", "utf8");
  const automaticUpdateArchivePath = join(tempRoot, "story-seed-0.2.14.tar.gz");
  execFileSync("tar", ["-czf", automaticUpdateArchivePath, "-C", automaticUpdateSource, "."]);
  const automaticUpdateArchive = readFileSync(automaticUpdateArchivePath);
  const automaticUpdatePackage: AppStorePackageRecord = {
    ...storySeedPackage,
    version: "0.2.14",
    archiveName: "story-seed-0.2.14.tar.gz",
    archiveSize: automaticUpdateArchive.byteLength,
    archiveSha256: createHash("sha256").update(automaticUpdateArchive).digest("hex"),
  };
  cloudStorePackages.set(storySeedPackage.id, { pkg: automaticUpdatePackage, bytes: automaticUpdateArchive });
  const automaticUpdateCheckAt = Date.parse("2026-08-28T06:00:00.000Z");
  const automaticUpdate = await ensureInstalledAppStoreAppsCurrent({
    state: defaultAppsState,
    request: { method: "GET", headers: {} } as any,
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    now: automaticUpdateCheckAt,
  });
  assert.equal(automaticUpdate.ok, true);
  assert.deepEqual(
    automaticUpdate.updated,
    [
      {
        appId: "story-seed",
        packageKey: "opengrove.story-seed",
        fromVersion: "0.2.13",
        toVersion: "0.2.14",
      },
    ],
    "automatic updates must include Store Apps regardless of how they were first installed",
  );
  const automaticallyUpdatedMount = defaultAppsState.settings.mountedApps.find((app) => app.id === "story-seed");
  assert.ok(automaticallyUpdatedMount);
  assert.equal(existsSync(join(automaticallyUpdatedMount.path, "auto-updated.txt")), true);
  assert.equal(
    readFileSync(join(defaultAppsInstallRoot, "story-seed", "workspace", "user-draft.md"), "utf8"),
    "keep this draft during the automatic update\n",
    "automatic App updates must preserve the existing Workspace",
  );
  assert.equal(defaultAppsState.settings.appUpdates.lastSuccessfulCheckAt, "2026-08-28T06:00:00.000Z");
  assert.deepEqual(
    new MountedAppVersionStateStore(join(appStoreDataRoot(defaultAppsState), "version-state")).read("story-seed")
      ?.selectedVersion,
    {
      packageKey: "opengrove.story-seed",
      version: "0.2.14",
      archiveSha256: automaticUpdatePackage.archiveSha256,
    },
    "automatic updates must use the same formal-version activation state as manual Store updates",
  );

  const pendingAutomaticUpdatePackage: AppStorePackageRecord = {
    ...automaticUpdatePackage,
    version: "0.2.15",
  };
  cloudStorePackages.set(storySeedPackage.id, {
    pkg: pendingAutomaticUpdatePackage,
    bytes: automaticUpdateArchive,
  });
  const automaticUpdateVersionStore = new MountedAppVersionStateStore(
    join(appStoreDataRoot(defaultAppsState), "version-state"),
  );
  const currentAutomaticUpdateTarget = resolveMountedAppTarget(defaultAppsState, "story-seed");
  assert.ok(currentAutomaticUpdateTarget);
  const currentAutomaticUpdateVersion = {
    packageKey: "opengrove.story-seed",
    version: automaticUpdatePackage.version,
    archiveSha256: automaticUpdatePackage.archiveSha256!,
  };
  const currentAutomaticUpdateDigest = mountedAppWorkingDigest(defaultAppsState, currentAutomaticUpdateTarget);
  const downloadsBeforeSafetySkips = signedDownloadRequestCount;

  automaticUpdateVersionStore.write({
    localAppId: currentAutomaticUpdateTarget.localAppId,
    activeContent: "local-draft",
    selectedVersion: currentAutomaticUpdateVersion,
    activeContentDigest: currentAutomaticUpdateDigest,
  });
  const localDraftSafetyCheck = await ensureInstalledAppStoreAppsCurrent({
    state: defaultAppsState,
    request: { method: "GET", headers: {} } as any,
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    now: automaticUpdateCheckAt + 1_000,
  });
  assert.equal(
    localDraftSafetyCheck.skipped.find((item) => item.packageKey === "opengrove.story-seed")?.reason,
    "local_draft_active",
    "automatic updates must not replace an active local draft",
  );
  automaticUpdateVersionStore.write({
    localAppId: currentAutomaticUpdateTarget.localAppId,
    activeContent: "formal",
    selectedVersion: currentAutomaticUpdateVersion,
    activeContentDigest: currentAutomaticUpdateDigest,
  });

  writeFileSync(join(currentAutomaticUpdateTarget.appRoot, "auto-updated.txt"), "unsaved local App change\n", "utf8");
  const unsavedSafetyCheck = await ensureInstalledAppStoreAppsCurrent({
    state: defaultAppsState,
    request: { method: "GET", headers: {} } as any,
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    now: automaticUpdateCheckAt + 2_000,
  });
  assert.equal(
    unsavedSafetyCheck.skipped.find((item) => item.packageKey === "opengrove.story-seed")?.reason,
    "unsaved_changes",
    "automatic updates must not replace unsaved App program changes",
  );
  writeFileSync(
    join(currentAutomaticUpdateTarget.appRoot, "auto-updated.txt"),
    "updated by automatic App updates\n",
    "utf8",
  );

  const activeUpdateWorker = defaultAppsState.app.rooms.upsertMember({
    id: "member-app-story-seed-auto-update-worker",
    appId: "story-seed",
    name: "Automatic Update Worker",
    kernel: "codex",
    model: "native",
    role: "Keeps the safety harness active.",
    status: "idle",
    color: "#2563eb",
    lastActive: "ready",
    source: "local",
  });
  const activeUpdateRoom = defaultAppsState.app.rooms.createRoom({
    id: "automatic-update-active-run-room",
    title: "Automatic update safety",
    memberIds: [activeUpdateWorker.id],
  });
  const activeUpdateMessage = defaultAppsState.app.rooms.postAgentMessage({
    roomId: activeUpdateRoom.id,
    senderId: activeUpdateWorker.id,
    senderName: activeUpdateWorker.name,
    text: "",
    status: "running",
  });
  defaultAppsState.app.rooms.updateMessage(activeUpdateRoom.id, activeUpdateMessage.id, {
    runId: "run-automatic-update-safety",
    status: "running",
  });
  const activeRunTarget = resolveMountedAppTarget(defaultAppsState, "story-seed");
  assert.ok(activeRunTarget);
  automaticUpdateVersionStore.write({
    localAppId: activeRunTarget.localAppId,
    activeContent: "formal",
    selectedVersion: currentAutomaticUpdateVersion,
    activeContentDigest: mountedAppWorkingDigest(defaultAppsState, activeRunTarget),
  });
  const activeRunSafetyCheck = await ensureInstalledAppStoreAppsCurrent({
    state: defaultAppsState,
    request: { method: "GET", headers: {} } as any,
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    now: automaticUpdateCheckAt + 3_000,
  });
  assert.equal(
    activeRunSafetyCheck.skipped.find((item) => item.packageKey === "opengrove.story-seed")?.reason,
    "active_runs",
    "automatic updates must not replace an App while one of its tasks is running",
  );
  defaultAppsState.app.rooms.updateMessage(activeUpdateRoom.id, activeUpdateMessage.id, {
    status: "done",
    finishedAt: new Date().toISOString(),
  });
  assert.equal(
    signedDownloadRequestCount,
    downloadsBeforeSafetySkips,
    "automatic update safety skips must happen before downloading an archive",
  );

  assert.deepEqual(
    scheduleInstalledAppStoreUpdatesAfterAuth({
      state: defaultAppsState,
      request: { method: "GET", headers: {} } as any,
      packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
      now: automaticUpdateCheckAt + 60_000,
    }),
    { status: "skipped", reason: "check_interval" },
    "successful checks must suppress duplicate work until the six-hour interval elapses",
  );
  defaultAppsState.settings.appUpdates.automatic = false;
  assert.deepEqual(
    scheduleInstalledAppStoreUpdatesAfterAuth({
      state: defaultAppsState,
      request: { method: "GET", headers: {} } as any,
      packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
      now: automaticUpdateCheckAt + 7 * 60 * 60_000,
    }),
    { status: "skipped", reason: "automatic_updates_disabled" },
  );
  defaultAppsState.settings.appUpdates.automatic = true;
  cloudStorePackages.set(storySeedPackage.id, { pkg: storySeedPackage, bytes: storySeedArchive });

  const previousDefaultTrashDir = process.env.OPENGROVE_TRASH_DIR;
  process.env.OPENGROVE_TRASH_DIR = join(tempRoot, "default-apps-trash");
  try {
    const defaultUninstallCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/uninstall"),
      state: defaultAppsState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => defaultUninstallCalls.push({ status, data }),
      readJsonBody: async () => ({ appId: "story-seed" }),
    });
    assert.equal(defaultUninstallCalls[0]?.status, 200);
    assert.equal(existsSync(join(defaultAppsInstallRoot, "story-seed")), false);
    await defaultAppsState.store.close?.();
    const restartedDefaultAppsState = createBridgeState({
      statePath: defaultAppsStatePath,
    });
    assert.deepEqual(restartedDefaultAppsState.settings.uninstalledStoreAppIds, ["story-seed"]);
    assert.deepEqual(restartedDefaultAppsState.settings.defaultAppSync.managedPackageKeys, []);
    const syncAfterDefaultUninstall = await ensureDefaultStoreAppsInstalledAfterAuth({
      state: restartedDefaultAppsState,
      request: { method: "POST", headers: {} } as any,
      installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
      packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
      clientReleaseNumber: currentHostReleaseNumber + 4,
    });
    assert.equal(syncAfterDefaultUninstall.installed.length, 0);
    assert.equal(syncAfterDefaultUninstall.skipped[0]?.reason, "disabled_by_user");
    assert.equal(
      existsSync(join(defaultAppsInstallRoot, "story-seed")),
      false,
      "a default Store App explicitly uninstalled by the user must not be installed again after auth",
    );
  } finally {
    restoreEnv("OPENGROVE_TRASH_DIR", previousDefaultTrashDir);
  }

  const disabledDefaultAppsState = createBridgeState({ statePath: join(tempRoot, "default-apps-disabled-state.json") });
  disabledDefaultAppsState.settings.mountedApps = [
    {
      id: "story-seed",
      path: join(tempRoot, "disabled-story-seed"),
      title: "故事种子",
      enabled: false,
    },
  ];
  const disabledDefaultAppsSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: disabledDefaultAppsState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
  });
  assert.equal(disabledDefaultAppsSync.installed.length, 0);
  assert.equal(disabledDefaultAppsSync.skipped[0]?.reason, "disabled_by_user");

  const failedCursorState = createBridgeState({ statePath: join(tempRoot, "failed-default-cursor", "state.json") });
  failedCursorState.settings.uninstalledStoreAppIds = ["story-seed"];
  const failedCursorSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: failedCursorState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 7,
    persistBridgeSettings: () => {
      throw new Error("default_app_cursor_save_failed");
    },
  });
  assert.equal(failedCursorSync.ok, false);
  assert.equal(failedCursorSync.errors[0]?.error, "default_app_cursor_save_failed");
  assert.notEqual(
    failedCursorState.settings.defaultAppSync.lastSuccessfulClientReleaseNumber,
    currentHostReleaseNumber + 7,
    "a failed release cursor write must remain retryable in the current process",
  );

  const unavailablePolicyAppsDir = join(tempRoot, "unavailable-policy-default-apps");
  process.env.OPENGROVE_APP_STORE_APPS_DIR = unavailablePolicyAppsDir;
  const missingPolicyState = createBridgeState({
    statePath: join(tempRoot, "missing-policy-default-state", "state.json"),
  });
  const missingPolicySync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: missingPolicyState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "missing_default_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "missing_default_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 8,
  });
  assert.equal(missingPolicySync.ok, true);
  assert.equal(missingPolicySync.installed[0]?.appId, "story-seed");
  assert.equal(
    missingPolicySync.skipped.find((item) => item.packageKey === "harness.missing-default-app")?.reason,
    "app_store_package_not_found",
  );
  assert.equal(
    missingPolicyState.settings.defaultAppSync.lastSuccessfulClientReleaseNumber,
    currentHostReleaseNumber + 8,
    "an unavailable policy entry must not block the successful Host release cursor",
  );

  const minimumUnavailableState = createBridgeState({
    statePath: join(tempRoot, "minimum-unavailable-default-state", "state.json"),
  });
  const minimumUnavailableSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: minimumUnavailableState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "minimum_unavailable_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "minimum_unavailable_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 9,
  });
  assert.equal(minimumUnavailableSync.ok, true);
  assert.equal(minimumUnavailableSync.installed.length, 0);
  assert.equal(minimumUnavailableSync.skipped[0]?.reason, "default_app_minimum_version_unavailable");
  assert.equal(
    minimumUnavailableState.settings.defaultAppSync.lastSuccessfulClientReleaseNumber,
    currentHostReleaseNumber + 9,
    "a policy version that this Store cannot provide yet must not block the release cursor",
  );

  const vegaPolicyAppsDir = join(tempRoot, "vega-policy-default-apps");
  process.env.OPENGROVE_APP_STORE_APPS_DIR = vegaPolicyAppsDir;
  const vegaPolicyState = createBridgeState({
    statePath: join(tempRoot, "vega-policy-default-state", "state.json"),
  });
  const vegaCatalogRequestsBefore = registryCatalogRequestCounts.get("vega_reviewer_harness") ?? 0;
  const vegaPolicySync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: vegaPolicyState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "vega_reviewer_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "vega_reviewer_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 10,
  });
  assert.equal(vegaPolicySync.ok, true);
  assert.equal(vegaPolicySync.status, "not_configured");
  assert.equal(vegaPolicySync.policyKey, "vega_reviewer");
  assert.equal(vegaPolicySync.assignmentSource, "invite_source");
  assert.equal(vegaPolicySync.installed.length, 0);
  assert.equal(existsSync(join(vegaPolicyAppsDir, "story-seed")), false);
  assert.equal(
    vegaPolicyState.settings.defaultAppSync.lastSuccessfulClientReleaseNumber,
    undefined,
    "an empty install policy must not mutate the local release cursor",
  );
  assert.equal(
    registryCatalogRequestCounts.get("vega_reviewer_harness") ?? 0,
    vegaCatalogRequestsBefore,
    "an empty install policy must not request the Store catalog",
  );

  {
    const token = "no_policy_endpoint_harness";
    const noPolicyState = createBridgeState({
      statePath: join(tempRoot, token, "state.json"),
    });
    const noPolicySync = await ensureDefaultStoreAppsInstalledAfterAuth({
      state: noPolicyState,
      request: { method: "POST", headers: {} } as any,
      installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: token },
      packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: token },
      clientReleaseNumber: currentHostReleaseNumber + 10,
    });
    assert.equal(noPolicySync.ok, false);
    assert.equal(noPolicySync.status, "deferred");
    assert.equal(noPolicySync.errors[0]?.error, "route_not_found");
    assert.equal(
      noPolicyState.settings.defaultAppSync.lastSuccessfulClientReleaseNumber,
      undefined,
      "a missing required install-policy route must remain retryable",
    );
  }

  for (const token of ["no_policy_body_harness"]) {
    const noPolicyState = createBridgeState({
      statePath: join(tempRoot, token, "state.json"),
    });
    const catalogRequestsBefore = registryCatalogRequestCounts.get(token) ?? 0;
    const noPolicySync = await ensureDefaultStoreAppsInstalledAfterAuth({
      state: noPolicyState,
      request: { method: "POST", headers: {} } as any,
      installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: token },
      packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: token },
      clientReleaseNumber: currentHostReleaseNumber + 10,
    });
    assert.equal(noPolicySync.ok, false);
    assert.equal(noPolicySync.status, "deferred");
    assert.equal(noPolicySync.errors[0]?.error, "app_store_install_policy_invalid");
    assert.equal(noPolicyState.settings.defaultAppSync.lastSuccessfulClientReleaseNumber, undefined);
    assert.equal(
      registryCatalogRequestCounts.get(token) ?? 0,
      catalogRequestsBefore,
      "a malformed install policy must not request the Store catalog",
    );
  }

  const relaxedPolicyAppsDir = join(tempRoot, "relaxed-policy-default-apps");
  process.env.OPENGROVE_APP_STORE_APPS_DIR = relaxedPolicyAppsDir;
  const relaxedPolicyState = createBridgeState({
    statePath: join(tempRoot, "relaxed-policy-default-state", "state.json"),
  });
  const relaxedPolicySync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: relaxedPolicyState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "relaxed_policy_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "relaxed_policy_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 10,
  });
  assert.equal(relaxedPolicySync.ok, true);
  assert.equal(relaxedPolicySync.status, "completed");
  assert.equal(relaxedPolicySync.policyKey, "Standard Policy 2026");
  assert.equal(relaxedPolicySync.assignmentSource, "Admin Migration");
  assert.equal(relaxedPolicySync.installed[0]?.appId, "story-seed");
  const relaxedPolicyMount = relaxedPolicyState.settings.mountedApps.find((app) => app.id === "story-seed");
  assert.ok(relaxedPolicyMount);
  assert.equal(
    existsSync(join(relaxedPolicyMount.path, "opengrove.app.json")),
    true,
    "diagnostic metadata and an unused latestVersion field must not reject a valid App assignment",
  );

  const mixedPolicyAppsDir = join(tempRoot, "mixed-policy-default-apps");
  process.env.OPENGROVE_APP_STORE_APPS_DIR = mixedPolicyAppsDir;
  const mixedPolicyState = createBridgeState({
    statePath: join(tempRoot, "mixed-policy-default-state", "state.json"),
  });
  const mixedPolicySync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: mixedPolicyState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "mixed_policy_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "mixed_policy_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 10,
  });
  assert.equal(mixedPolicySync.ok, true);
  assert.equal(mixedPolicySync.status, "completed");
  assert.equal(mixedPolicySync.installed[0]?.appId, "story-seed");
  assert.deepEqual(
    mixedPolicySync.skipped.map((item) => item.reason),
    ["policy_entry_invalid", "policy_entry_duplicate", "policy_entry_invalid"],
    "invalid and duplicate policy entries must be diagnosed separately without blocking valid Apps",
  );

  const allInvalidPolicyState = createBridgeState({
    statePath: join(tempRoot, "all-invalid-policy-default-state", "state.json"),
  });
  const allInvalidPolicySync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: allInvalidPolicyState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "all_invalid_policy_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "all_invalid_policy_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 10,
  });
  assert.equal(allInvalidPolicySync.ok, false);
  assert.equal(allInvalidPolicySync.status, "deferred");
  assert.equal(allInvalidPolicySync.errors[0]?.error, "app_store_install_policy_no_valid_entries");

  const invalidPolicyState = createBridgeState({
    statePath: join(tempRoot, "invalid-policy-default-state", "state.json"),
  });
  const invalidPolicySync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: invalidPolicyState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "invalid_policy_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "invalid_policy_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 10,
  });
  assert.equal(invalidPolicySync.ok, false);
  assert.equal(invalidPolicySync.status, "deferred");
  assert.equal(invalidPolicySync.errors[0]?.error, "app_store_install_policy_invalid");
  assert.equal(
    invalidPolicyState.settings.defaultAppSync.lastSuccessfulClientReleaseNumber,
    undefined,
    "a malformed install policy must stay retryable instead of recording a partial sync",
  );

  for (const token of [
    "invalid_policy_array_harness",
    "invalid_policy_string_harness",
    "invalid_policy_number_harness",
  ]) {
    const invalidBodyState = createBridgeState({
      statePath: join(tempRoot, token, "state.json"),
    });
    const invalidBodySync = await ensureDefaultStoreAppsInstalledAfterAuth({
      state: invalidBodyState,
      request: { method: "POST", headers: {} } as any,
      installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: token },
      packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: token },
      clientReleaseNumber: currentHostReleaseNumber + 10,
    });
    assert.equal(invalidBodySync.ok, false, `${token} must not be treated as an absent policy`);
    assert.equal(invalidBodySync.status, "deferred");
    assert.equal(invalidBodySync.errors[0]?.error, "app_store_install_policy_invalid");
  }

  const catalogTimeoutState = createBridgeState({
    statePath: join(tempRoot, "catalog-timeout-default-state", "state.json"),
  });
  const catalogTimeoutStartedAt = Date.now();
  const catalogTimeoutSync = await ensureDefaultStoreAppsInstalledAfterAuth({
    state: catalogTimeoutState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "slow_catalog_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "slow_catalog_harness" },
    clientReleaseNumber: currentHostReleaseNumber + 10,
    requestTimeoutMs: 25,
  });
  releaseDelayedCatalogRequest();
  assert.equal(catalogTimeoutSync.ok, false);
  assert.ok(catalogTimeoutSync.errors[0]?.error, "a stalled catalog request must report a retryable sync error");
  assert.ok(
    Date.now() - catalogTimeoutStartedAt < 1_000,
    "the default App catalog request must honor the configured timeout",
  );

  const transientPolicyDiagnosticsDir = join(tempRoot, "transient-policy-diagnostics");
  const previousDiagnosticsDir = process.env.OPENGROVE_DIAGNOSTICS_DIR;
  process.env.OPENGROVE_DIAGNOSTICS_DIR = transientPolicyDiagnosticsDir;
  try {
    const transientPolicyState = createBridgeState({
      statePath: join(tempRoot, "transient-policy-default-state", "state.json"),
    });
    const firstTransientSchedule = scheduleDefaultStoreAppsInstalledAfterAuth({
      state: transientPolicyState,
      request: { method: "POST", headers: {} } as any,
      installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "transient_policy_harness" },
      packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "transient_policy_harness" },
      userId: "transient-user",
    });
    assert.equal(firstTransientSchedule.status, "scheduled");
    await waitForHarness(
      () => (defaultPolicyRequestCounts.get("transient_policy_harness") ?? 0) === 1,
      "the transient install-policy request should complete once",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retryTransientSchedule = scheduleDefaultStoreAppsInstalledAfterAuth({
      state: transientPolicyState,
      request: { method: "POST", headers: {} } as any,
      installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "transient_policy_harness" },
      packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "transient_policy_harness" },
      userId: "transient-user",
    });
    assert.equal(
      retryTransientSchedule.status,
      "skipped",
      "a failed optional policy request must have a short retry floor",
    );
    assert.equal(retryTransientSchedule.reason, "deferred_retry_cooldown");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      defaultPolicyRequestCounts.get("transient_policy_harness") ?? 0,
      1,
      "repeated authentication must not hammer an unavailable optional policy endpoint",
    );
    const realDateNow = Date.now;
    let cooledTransientSchedule: ReturnType<typeof scheduleDefaultStoreAppsInstalledAfterAuth> | undefined;
    try {
      Date.now = () => realDateNow() + 30_100;
      cooledTransientSchedule = scheduleDefaultStoreAppsInstalledAfterAuth({
        state: transientPolicyState,
        request: { method: "POST", headers: {} } as any,
        installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "transient_policy_harness" },
        packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "transient_policy_harness" },
        userId: "transient-user",
      });
    } finally {
      Date.now = realDateNow;
    }
    assert.equal(
      cooledTransientSchedule?.status,
      "scheduled",
      "the optional policy must become retryable after the short deferred cooldown",
    );
    await waitForHarness(
      () => (defaultPolicyRequestCounts.get("transient_policy_harness") ?? 0) === 2,
      "the optional install policy should retry after its short cooldown",
    );
    assert.equal(
      existsSync(join(transientPolicyDiagnosticsDir, "problems.jsonl")),
      false,
      "an unavailable optional policy must not create a user-visible problem record",
    );
  } finally {
    restoreEnv("OPENGROVE_DIAGNOSTICS_DIR", previousDiagnosticsDir);
  }

  const failedPolicyAppsDir = join(tempRoot, "failed-policy-default-apps");
  process.env.OPENGROVE_APP_STORE_APPS_DIR = failedPolicyAppsDir;
  const failedPolicyState = createBridgeState({
    statePath: join(tempRoot, "failed-policy-default-state", "state.json"),
  });
  const firstFailedSchedule = scheduleDefaultStoreAppsInstalledAfterAuth({
    state: failedPolicyState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "failed_install_policy_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "failed_install_policy_harness" },
    userId: "failed-install-user",
  });
  assert.equal(firstFailedSchedule.status, "scheduled");
  await waitForHarness(
    () => (failedPolicyDownloadRequestCounts.get("failed_install_policy_harness") ?? 0) === 1,
    "the failing default App archive should be attempted once",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const immediateFailedRetry = scheduleDefaultStoreAppsInstalledAfterAuth({
    state: failedPolicyState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "failed_install_policy_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "failed_install_policy_harness" },
    userId: "failed-install-user",
  });
  assert.equal(immediateFailedRetry.status, "skipped");
  assert.equal(immediateFailedRetry.reason, "failed_retry_cooldown");
  assert.equal(
    failedPolicyDownloadRequestCounts.get("failed_install_policy_harness") ?? 0,
    1,
    "a failed install must not redownload its archive on every authentication check",
  );
  const realDateNowAfterFailure = Date.now;
  let cooledFailedSchedule: ReturnType<typeof scheduleDefaultStoreAppsInstalledAfterAuth> | undefined;
  try {
    Date.now = () => realDateNowAfterFailure() + 5 * 60 * 1000 + 100;
    cooledFailedSchedule = scheduleDefaultStoreAppsInstalledAfterAuth({
      state: failedPolicyState,
      request: { method: "POST", headers: {} } as any,
      installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "failed_install_policy_harness" },
      packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "failed_install_policy_harness" },
      userId: "failed-install-user",
    });
  } finally {
    Date.now = realDateNowAfterFailure;
  }
  assert.equal(cooledFailedSchedule?.status, "scheduled");
  await waitForHarness(
    () => (failedPolicyDownloadRequestCounts.get("failed_install_policy_harness") ?? 0) === 2,
    "the failed default App install should retry after five minutes",
  );

  const switchedUserAppsDir = join(tempRoot, "switched-user-default-apps");
  process.env.OPENGROVE_APP_STORE_APPS_DIR = switchedUserAppsDir;
  const switchedUserState = createBridgeState({
    statePath: join(tempRoot, "switched-user-default-state", "state.json"),
  });
  const switchedUserPolicyRequestsBefore = defaultPolicyRequestCounts.get("user_harness") ?? 0;
  const firstUserSchedule = scheduleDefaultStoreAppsInstalledAfterAuth({
    state: switchedUserState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "slow_user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "slow_user_harness" },
    userId: "user-a",
  });
  assert.equal(firstUserSchedule.status, "scheduled");
  await delayedDefaultPolicyRequestStarted;
  const switchedUserSchedule = scheduleDefaultStoreAppsInstalledAfterAuth({
    state: switchedUserState,
    request: { method: "POST", headers: {} } as any,
    installPolicyConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    packageRegistryConfig: { baseUrl: fakeCloudUrl, registryToken: "user_harness" },
    userId: "user-b",
  });
  assert.equal(switchedUserSchedule.status, "already_running");
  releaseDelayedDefaultPolicyRequest();
  await waitForHarness(
    () =>
      (defaultPolicyRequestCounts.get("user_harness") ?? 0) > switchedUserPolicyRequestsBefore &&
      switchedUserState.settings.mountedApps.some((app) => app.id === "story-seed" && app.enabled !== false),
    "a different user queued behind an in-flight sync must run without inheriting the first user's cooldown",
  );
  process.env.OPENGROVE_APP_STORE_APPS_DIR = tempRoot;

  mkdirSync(join(tempRoot, "registry-demo-app", "workspace", "projects"), { recursive: true });
  writeFileSync(
    join(tempRoot, "registry-demo-app", "workspace", "projects", "user-story.md"),
    "keep me during update\n",
    "utf8",
  );
  const registryDemoVersionStore = new MountedAppVersionStateStore(
    join(appStoreDataRoot(cloudRecruitState), "version-state"),
  );
  const registryDemoPackageKey = cloudRegistryPackage.packageKey;
  const registryDemoArchiveSha256 = cloudRegistryPackage.archiveSha256;
  assert.ok(registryDemoPackageKey);
  assert.ok(registryDemoArchiveSha256);
  registryDemoVersionStore.write({
    localAppId: "registry-demo-app",
    activeContent: "formal",
    selectedVersion: {
      packageKey: registryDemoPackageKey,
      version: cloudRegistryPackage.version,
      archiveSha256: registryDemoArchiveSha256,
    },
  });
  const registryDemoMemberId = "member-app-registry-demo-app-operator";
  const installedRegistryDemoMember = cloudRecruitState.app.rooms
    .listMembers()
    .find((member) => member.id === registryDemoMemberId);
  assert.ok(installedRegistryDemoMember, "the initial registry App must seed its published Employee");
  cloudRecruitState.app.rooms.upsertMember({
    ...installedRegistryDemoMember,
    name: "Local Operator",
    avatarDataUrl: "data:image/png;base64,bG9jYWw=",
    role: "Local role",
    kernel: "codex",
    model: "local-model",
    reasoningEffort: "low",
    contextTokenBudget: undefined,
    accessMode: "full-access",
    color: "#222222",
    availableSkillIds: ["local-available"],
    defaultSkillIds: [],
    visibility: "public",
    publicDescription: "Local description",
    publicSkills: [],
    inputSpec: "Local input",
    outputSpec: "Local output",
    status: "offline",
    lastActive: "已移除",
    disabled: true,
    userOverrides: [
      "name",
      "avatarDataUrl",
      "role",
      "kernel",
      "model",
      "reasoningEffort",
      "contextTokenBudget",
      "accessMode",
      "color",
      "availableSkillIds",
      "defaultSkillIds",
      "visibility",
      "publicDescription",
      "publicSkills",
      "inputSpec",
      "outputSpec",
    ],
  });
  cloudRecruitState.store.saveFrom(cloudRecruitState.app);

  const registryUpdateRoot = join(tempRoot, "registry-update-source");
  mkdirSync(join(registryUpdateRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(registryUpdateRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "registry-demo-app",
      title: "Registry Demo App",
      version: "0.4.0",
      description: "Updated registry app package",
      disablePmAgent: true,
      workspace: { path: "workspace", name: "Registry Workspace" },
      employees: [{ id: "operator", name: "Updated Operator", role: "Updated package role" }],
      store: {
        requirements: { env: ["REGISTRY_DEMO_KEY"] },
        capabilities: ["registry install"],
        employeeDefaults: [
          {
            memberId: "member-app-registry-demo-app-operator",
            name: "Updated Operator",
            role: "Updated package role",
            kernel: "claude-code",
            model: "updated-package-model",
            reasoningEffort: "high",
            contextTokenBudget: 200000,
            accessMode: "auto-review",
            color: "#333333",
            avatarDataUrl: "data:image/png;base64,dXBkYXRlZA==",
            availableSkillIds: ["updated-available"],
            defaultSkillIds: ["updated-default"],
            visibility: "private",
            publicDescription: "Updated package description",
            publicSkills: ["updated-public-skill"],
            inputSpec: "Updated package input",
            outputSpec: "Updated package output",
          },
        ],
      },
    }),
    "utf8",
  );
  writeFileSync(join(registryUpdateRoot, "updated.txt"), "registry update v0.4.0\n", "utf8");
  const registryUpdateArchivePath = join(tempRoot, "registry-demo-app-0.4.0.tar.gz");
  execFileSync("tar", ["-czf", registryUpdateArchivePath, "-C", registryUpdateRoot, "."]);
  const registryUpdateArchive = readFileSync(registryUpdateArchivePath);
  const cloudRegistryUpdatePackage: AppStorePackageRecord = {
    ...cloudRegistryPackage,
    version: "0.4.0",
    summary: "Updated registry app package",
    archiveName: "registry-demo-app-0.4.0.tar.gz",
    archiveSize: registryUpdateArchive.byteLength,
    archiveSha256: createHash("sha256").update(registryUpdateArchive).digest("hex"),
  };
  const registryProgramRootBeforeUpdate = cloudRecruitState.settings.mountedApps.find(
    (app) => app.id === "registry-demo-app",
  )?.path;
  assert.ok(registryProgramRootBeforeUpdate);

  const markerBeforeIncompatibleUpdate = readFileSync(
    join(registryProgramRootBeforeUpdate, ".opengrove-store-package.json"),
    "utf8",
  );
  const downloadsBeforeIncompatibleUpdate = signedDownloadRequestCount;
  cloudStorePackages.set(cloudRegistryPackage.id, {
    pkg: { ...cloudRegistryUpdatePackage, minHostReleaseNumber: currentHostReleaseNumber + 1 },
    bytes: registryUpdateArchive,
  });
  const incompatibleCatalogCalls: Array<{ status: number; data: { packages?: AppStorePackageRecord[] } }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as unknown as IncomingMessage,
    response: {} as ServerResponse,
    url: new URL("http://opengrove.test/app-store"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) =>
      incompatibleCatalogCalls.push({
        status,
        data: data as { packages?: AppStorePackageRecord[] },
      }),
    readJsonBody: async () => ({}),
  });
  const incompatibleCatalogPackage = incompatibleCatalogCalls[0]?.data.packages?.find(
    (item) => item.id === cloudRegistryPackage.id,
  );
  assert.equal(incompatibleCatalogCalls[0]?.status, 200);
  assert.equal(incompatibleCatalogPackage?.hostUpdateRequired, true);
  assert.equal(
    incompatibleCatalogPackage?.updateAvailable,
    false,
    "compatibility notices must not advertise an installable update archive",
  );
  const incompatibleUpdateCalls: Array<{ status: number; data: { error?: string } }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as unknown as IncomingMessage,
    response: {} as ServerResponse,
    url: new URL("http://opengrove.test/app-store/install"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => incompatibleUpdateCalls.push({ status, data: data as { error?: string } }),
    readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
  });
  assert.equal(incompatibleUpdateCalls[0]?.status, 409);
  assert.equal(incompatibleUpdateCalls[0]?.data.error, "app_store_host_update_required");
  assert.equal(
    signedDownloadRequestCount,
    downloadsBeforeIncompatibleUpdate,
    "an incompatible update must be rejected before download",
  );
  assert.equal(
    readFileSync(join(registryProgramRootBeforeUpdate, ".opengrove-store-package.json"), "utf8"),
    markerBeforeIncompatibleUpdate,
    "an incompatible update must not change the installed marker",
  );
  assert.equal(
    readFileSync(join(tempRoot, "registry-demo-app", "workspace", "projects", "user-story.md"), "utf8"),
    "keep me during update\n",
    "an incompatible update must not change the workspace",
  );

  const conflictingWorkspaceUpdateRoot = join(tempRoot, "registry-conflicting-workspace-source");
  mkdirSync(conflictingWorkspaceUpdateRoot, { recursive: true });
  writeFileSync(
    join(conflictingWorkspaceUpdateRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "registry-demo-app",
      title: "Registry Demo App",
      version: "0.3.5",
      workspace: { path: ".opengrove-store-package.json" },
    }),
    "utf8",
  );
  const conflictingWorkspaceArchivePath = join(tempRoot, "registry-demo-app-conflicting-workspace.tar.gz");
  execFileSync("tar", ["-czf", conflictingWorkspaceArchivePath, "-C", conflictingWorkspaceUpdateRoot, "."]);
  const conflictingWorkspaceArchive = readFileSync(conflictingWorkspaceArchivePath);
  const conflictingWorkspacePackage: AppStorePackageRecord = {
    ...cloudRegistryPackage,
    version: "0.3.5",
    archiveName: "registry-demo-app-conflicting-workspace.tar.gz",
    archiveSize: conflictingWorkspaceArchive.byteLength,
    archiveSha256: createHash("sha256").update(conflictingWorkspaceArchive).digest("hex"),
  };
  cloudStorePackages.set(cloudRegistryPackage.id, {
    pkg: conflictingWorkspacePackage,
    bytes: conflictingWorkspaceArchive,
  });
  const markerBeforeConflictingWorkspace = readFileSync(
    join(registryProgramRootBeforeUpdate, ".opengrove-store-package.json"),
    "utf8",
  );
  const conflictingWorkspaceCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => conflictingWorkspaceCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
  });
  assert.equal(conflictingWorkspaceCalls[0]?.status, 409);
  assert.equal(conflictingWorkspaceCalls[0]?.data.error, "app_store_update_not_safe");
  assert.equal(
    readFileSync(join(registryProgramRootBeforeUpdate, ".opengrove-store-package.json"), "utf8"),
    markerBeforeConflictingWorkspace,
    "a package workspace must not replace the Store marker",
  );
  assert.equal(
    readFileSync(join(tempRoot, "registry-demo-app", "workspace", "projects", "user-story.md"), "utf8"),
    "keep me during update\n",
  );

  cloudStorePackages.set(cloudRegistryPackage.id, { pkg: cloudRegistryUpdatePackage, bytes: registryUpdateArchive });
  const importedCatalogPath = join(appStoreDataRoot(cloudRecruitState), "catalog.json");
  rmSync(importedCatalogPath, { force: true });
  assert.equal(existsSync(importedCatalogPath), false, "the installed marker must survive an empty local catalog");
  const cloudCatalogUpdateCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "GET", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => cloudCatalogUpdateCalls.push({ status, data }),
    readJsonBody: async () => ({}),
  });
  const updateCatalogPackage = cloudCatalogUpdateCalls[0]?.data.packages.find(
    (item: { id: string }) => item.id === cloudRegistryPackage.id,
  );
  assert.equal(updateCatalogPackage?.installed, true);
  assert.equal(updateCatalogPackage?.updateAvailable, true);
  assert.equal(updateCatalogPackage?.updateSafe, true);
  assert.equal(updateCatalogPackage?.version, "0.4.0");

  const registryInstalledRoot = join(tempRoot, "registry-demo-app");
  const registryUpdateLock = join(
    dirname(registryInstalledRoot),
    ".opengrove-install-locks",
    createHash("sha256").update(resolve(registryInstalledRoot)).digest("hex"),
  );
  mkdirSync(dirname(registryUpdateLock), { recursive: true });
  mkdirSync(registryUpdateLock);
  const lockedUpdateCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => lockedUpdateCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
  });
  assert.equal(lockedUpdateCalls[0]?.status, 409);
  assert.equal(lockedUpdateCalls[0]?.data.error, "app_store_install_target_changed");
  assert.equal(
    readFileSync(join(registryInstalledRoot, "workspace", "projects", "user-story.md"), "utf8"),
    "keep me during update\n",
    "a failed activation lock must leave the existing workspace in place",
  );
  rmSync(registryUpdateLock, { recursive: true, force: true });

  const revisionHeadPath = join(registryDemoGitDirectory, "HEAD");
  const revisionHead = readFileSync(revisionHeadPath, "utf8");
  const settingsBeforeUpdateRevisionFailure = structuredClone(cloudRecruitState.settings);
  const generationsBeforeUpdateRevisionFailure = readdirSync(registryDemoProgramBucket).sort();
  const failedUpdateRevisionCalls: Array<{ status: number; data: any }> = [];
  rmSync(revisionHeadPath, { force: true });
  mkdirSync(revisionHeadPath);
  try {
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/install"),
      state: cloudRecruitState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => failedUpdateRevisionCalls.push({ status, data }),
      readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
    });
  } finally {
    rmSync(revisionHeadPath, { recursive: true, force: true });
    writeFileSync(revisionHeadPath, revisionHead, "utf8");
  }
  assert.equal(failedUpdateRevisionCalls[0]?.status, 500);
  assert.deepEqual(
    cloudRecruitState.settings,
    settingsBeforeUpdateRevisionFailure,
    "a failed update save point must restore the previous mounted App settings",
  );
  assert.deepEqual(
    readdirSync(registryDemoProgramBucket).sort(),
    generationsBeforeUpdateRevisionFailure,
    "a failed update save point must remove the uncommitted program generation",
  );

  const registryDemoMemberBeforeUpdate = cloudRecruitState.app.rooms
    .listMembers()
    .find((member) => member.id === registryDemoMemberId);
  assert.equal(
    registryDemoMemberBeforeUpdate?.name,
    "Local Operator",
    "the update precondition must retain the local Employee edit",
  );
  assert.equal(
    registryDemoMemberBeforeUpdate?.contextTokenBudget,
    undefined,
    "the update precondition must retain the blank local context budget",
  );
  assert.equal(
    registryDemoMemberBeforeUpdate?.disabled,
    true,
    "the update precondition includes a locally removed package Employee",
  );
  assert.ok(registryDemoMemberBeforeUpdate?.userOverrides?.includes("contextTokenBudget"));
  const markerBeforeFailedUpdate = readFileSync(
    join(registryProgramRootBeforeUpdate, ".opengrove-store-package.json"),
    "utf8",
  );
  const revisionBeforeFailedUpdate = await new AppRevisionStore(registryDemoRevisionRoot).inspect({
    localAppId: "registry-demo-app",
    appRoot: registryProgramRootBeforeUpdate,
    workspacePath: "workspace",
  });
  const revisionIndexBeforeFailedUpdate = readFileSync(join(registryDemoGitDirectory, "index"));
  const settingsBeforeFailedUpdate = structuredClone(cloudRecruitState.settings);
  let failUpdateSettingsPersist = true;
  const failedCloudUpdateCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => failedCloudUpdateCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
    persistBridgeSettings: (state) => {
      if (failUpdateSettingsPersist) {
        failUpdateSettingsPersist = false;
        throw new Error("app_store_settings_persist_harness_failure");
      }
      saveBridgeSettings(state);
    },
  });
  assert.equal(failedCloudUpdateCalls[0]?.status, 500);
  assert.equal(failedCloudUpdateCalls[0]?.data.error, "app_store_settings_persist_harness_failure");
  assert.equal(
    readFileSync(join(registryProgramRootBeforeUpdate, ".opengrove-store-package.json"), "utf8"),
    markerBeforeFailedUpdate,
  );
  assert.equal(
    existsSync(join(registryProgramRootBeforeUpdate, "updated.txt")),
    false,
    "failed activation must restore the old program tree",
  );
  assert.deepEqual(
    cloudRecruitState.settings,
    settingsBeforeFailedUpdate,
    "failed activation must restore mounted App settings",
  );
  const registryDemoMountAfterFailedUpdate = cloudRecruitState.settings.mountedApps.find(
    (app) => app.id === "registry-demo-app",
  );
  assert.ok(registryDemoMountAfterFailedUpdate);
  assert.equal(
    (
      await new AppRevisionStore(registryDemoRevisionRoot).inspect({
        localAppId: registryDemoMountAfterFailedUpdate.id,
        appRoot: registryDemoMountAfterFailedUpdate.path,
        workspacePath: "workspace",
      })
    ).commitSha,
    revisionBeforeFailedUpdate.commitSha,
    "failed Store update activation must restore the previous revision save point",
  );
  assert.deepEqual(
    readFileSync(join(registryDemoGitDirectory, "index")),
    revisionIndexBeforeFailedUpdate,
    "failed Store update activation must restore the previous revision index",
  );
  const memberAfterFailedUpdate = cloudRecruitState.app.rooms
    .listMembers()
    .find((member) => member.id === registryDemoMemberId);
  assert.equal(memberAfterFailedUpdate?.name, "Local Operator");
  assert.equal(memberAfterFailedUpdate?.contextTokenBudget, undefined);
  assert.equal(memberAfterFailedUpdate?.disabled, true);
  assert.ok(memberAfterFailedUpdate?.userOverrides?.includes("contextTokenBudget"));
  assert.deepEqual(
    registryDemoVersionStore.read("registry-demo-app")?.selectedVersion,
    {
      packageKey: registryDemoPackageKey,
      version: cloudRegistryPackage.version,
      archiveSha256: registryDemoArchiveSha256,
    },
    "a failed Store update must restore the previously selected formal version",
  );
  const legacyRegistryRootIdentity = lstatSync(registryInstalledRoot);
  const legacyRegistryWorkspaceRoot = join(registryInstalledRoot, "workspace");
  const legacyRegistryWorkspaceIdentity = lstatSync(legacyRegistryWorkspaceRoot);
  const protectedProgramPath = join(registryProgramRootBeforeUpdate, "protected-program.txt");
  if (process.platform === "darwin") {
    writeFileSync(protectedProgramPath, "immutable old program file\n", "utf8");
    execFileSync("chflags", ["uchg", protectedProgramPath]);
  }
  const cloudUpdateInstallCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => cloudUpdateInstallCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
  });
  assert.equal(cloudUpdateInstallCalls[0]?.status, 200);
  assert.equal(cloudUpdateInstallCalls[0]?.data.install?.mountedApp?.id, "registry-demo-app");
  assert.equal(cloudUpdateInstallCalls[0]?.data.install?.openable, false);
  assert.equal(cloudUpdateInstallCalls[0]?.data.install?.openIssue, "ui_not_workbench");
  const updatedRegistryMount = cloudRecruitState.settings.mountedApps.find((app) => app.id === "registry-demo-app") as
    | { path: string; workspacePath?: string }
    | undefined;
  assert.ok(updatedRegistryMount);
  assert.notEqual(
    resolve(updatedRegistryMount.path),
    resolve(registryInstalledRoot),
    "a Store update must switch only the program pointer to a side-by-side generation",
  );
  assert.equal(
    resolve(updatedRegistryMount.workspacePath ?? ""),
    resolve(legacyRegistryWorkspaceRoot),
    "the Host must bind the updated program to the existing Workspace path",
  );
  assert.equal(
    lstatSync(registryInstalledRoot).ino,
    legacyRegistryRootIdentity.ino,
    "the legacy App container must never be renamed or replaced during migration",
  );
  assert.equal(
    lstatSync(legacyRegistryWorkspaceRoot).ino,
    legacyRegistryWorkspaceIdentity.ino,
    "the existing Workspace directory must never move during an App update",
  );
  const registryMarker = JSON.parse(
    readFileSync(join(updatedRegistryMount.path, ".opengrove-store-package.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(registryMarker.version, "0.4.0");
  assert.equal(registryMarker.archiveSha256, cloudRegistryUpdatePackage.archiveSha256);
  assert.deepEqual(
    registryDemoVersionStore.read("registry-demo-app")?.selectedVersion,
    {
      packageKey: cloudRegistryUpdatePackage.packageKey,
      version: "0.4.0",
      archiveSha256: cloudRegistryUpdatePackage.archiveSha256,
    },
    "a Store update must make the installed formal package the selected running version",
  );
  assert.equal(readFileSync(join(updatedRegistryMount.path, "updated.txt"), "utf8"), "registry update v0.4.0\n");
  const updatedRegistryDemoMember = cloudRecruitState.app.rooms
    .listMembers()
    .find((member) => member.id === registryDemoMemberId);
  assert.ok(updatedRegistryDemoMember, "the updated registry App must keep its Employee mounted");
  assert.equal(updatedRegistryDemoMember.name, "Updated Operator");
  assert.equal(updatedRegistryDemoMember.avatarDataUrl, "data:image/png;base64,dXBkYXRlZA==");
  assert.equal(publicEmployeeRole(updatedRegistryDemoMember.role), "Updated package role");
  assert.equal(updatedRegistryDemoMember.kernel, "claude-code");
  assert.equal(updatedRegistryDemoMember.model, "updated-package-model");
  assert.equal(updatedRegistryDemoMember.reasoningEffort, "high");
  assert.equal(updatedRegistryDemoMember.contextTokenBudget, 200000);
  assert.equal(updatedRegistryDemoMember.accessMode, "auto-review");
  assert.equal(updatedRegistryDemoMember.color, "#333333");
  assert.deepEqual(updatedRegistryDemoMember.availableSkillIds, ["updated-available"]);
  assert.deepEqual(updatedRegistryDemoMember.defaultSkillIds, ["updated-default"]);
  assert.equal(updatedRegistryDemoMember.visibility, "private");
  assert.equal(updatedRegistryDemoMember.publicDescription, "Updated package description");
  assert.deepEqual(updatedRegistryDemoMember.publicSkills, ["updated-public-skill"]);
  assert.equal(updatedRegistryDemoMember.inputSpec, "Updated package input");
  assert.equal(updatedRegistryDemoMember.outputSpec, "Updated package output");
  assert.equal(
    updatedRegistryDemoMember.disabled,
    false,
    "the new App version must restore an Employee it still declares",
  );
  assert.equal(
    updatedRegistryDemoMember.userOverrides,
    undefined,
    "an App update must clear superseded local override markers",
  );
  cloudRecruitState.app.rooms.upsertMember({
    ...updatedRegistryDemoMember,
    name: "Local edit after update",
    contextTokenBudget: undefined,
    userOverrides: ["name", "contextTokenBudget"],
  });
  cloudRecruitState.store.saveFrom(cloudRecruitState.app);
  const identicalPackageInstallCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: cloudRecruitState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => identicalPackageInstallCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
  });
  assert.equal(identicalPackageInstallCalls[0]?.status, 200);
  assert.equal(identicalPackageInstallCalls[0]?.data.install?.status, "already_installed");
  const registryDemoMemberAfterIdenticalInstall = cloudRecruitState.app.rooms
    .listMembers()
    .find((member) => member.id === registryDemoMemberId);
  assert.equal(
    registryDemoMemberAfterIdenticalInstall?.name,
    "Local edit after update",
    "reinstalling identical package bytes is not an App update",
  );
  assert.equal(registryDemoMemberAfterIdenticalInstall?.contextTokenBudget, undefined);
  assert.deepEqual(registryDemoMemberAfterIdenticalInstall?.userOverrides, ["name", "contextTokenBudget"]);
  assert.equal(
    readFileSync(join(tempRoot, "registry-demo-app", "workspace", "projects", "user-story.md"), "utf8"),
    "keep me during update\n",
  );
  if (process.platform === "darwin") {
    if (existsSync(protectedProgramPath)) execFileSync("chflags", ["nouchg", protectedProgramPath]);
  }
  const orphanProgramRoot = join(
    appStoreDataRoot(cloudRecruitState),
    "programs",
    "a".repeat(64),
    "orphan-generation",
    "app",
  );
  mkdirSync(orphanProgramRoot, { recursive: true });
  writeFileSync(join(orphanProgramRoot, "orphan.txt"), "safe to reclaim\n", "utf8");
  writeFileSync(
    join(dirname(orphanProgramRoot), ".opengrove-cleanup-pending"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "program-generation-cleanup",
      appRoot: resolve(orphanProgramRoot),
      createdAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  const malformedMarkerProgramRoot = join(
    appStoreDataRoot(cloudRecruitState),
    "programs",
    "c".repeat(64),
    "malformed-marker-generation",
    "app",
  );
  mkdirSync(malformedMarkerProgramRoot, { recursive: true });
  writeFileSync(join(malformedMarkerProgramRoot, "unknown.txt"), "do not delete\n", "utf8");
  writeFileSync(join(dirname(malformedMarkerProgramRoot), ".opengrove-cleanup-pending"), "pending\n", "utf8");
  const unmarkedProgramRoot = join(
    appStoreDataRoot(cloudRecruitState),
    "programs",
    "b".repeat(64),
    "unmarked-generation",
    "app",
  );
  mkdirSync(unmarkedProgramRoot, { recursive: true });
  writeFileSync(join(unmarkedProgramRoot, "unknown.txt"), "do not infer ownership\n", "utf8");
  const generationCleanup = cleanupUnreferencedAppStoreProgramGenerations(
    appStoreDataRoot(cloudRecruitState),
    cloudRecruitState.settings,
  );
  assert.ok(generationCleanup.removed.includes(orphanProgramRoot));
  assert.equal(existsSync(orphanProgramRoot), false);
  assert.ok(generationCleanup.retained.includes(malformedMarkerProgramRoot));
  assert.equal(
    existsSync(malformedMarkerProgramRoot),
    true,
    "malformed cleanup-marker contents must never authorize recursive deletion",
  );
  assert.equal(
    existsSync(unmarkedProgramRoot),
    true,
    "generation cleanup must require an explicit committed cleanup marker",
  );
  assert.equal(existsSync(updatedRegistryMount.path), true, "generation cleanup must retain the active program");
  assert.equal(
    existsSync(registryProgramRootBeforeUpdate),
    false,
    "a previously locked N-1 program generation must be reclaimed after its lock is released",
  );
  rmSync(dirname(malformedMarkerProgramRoot), { recursive: true, force: true });

  if (process.platform !== "win32") {
    const installedManifestPath = join(updatedRegistryMount.path, "opengrove.app.json");
    const installedManifestBeforeSymlink = readFileSync(installedManifestPath, "utf8");
    const externalWorkspaceParent = join(tempRoot, "external-linked-workspace");
    mkdirSync(join(externalWorkspaceParent, "workspace"), { recursive: true });
    writeFileSync(join(externalWorkspaceParent, "workspace", "external-user.md"), "external user content\n", "utf8");
    const linkedWorkspaceParent = join(updatedRegistryMount.path, "linked");
    symlinkSync(externalWorkspaceParent, linkedWorkspaceParent);
    const linkedManifest = JSON.parse(installedManifestBeforeSymlink) as Record<string, unknown>;
    linkedManifest.workspace = { path: "linked/workspace" };
    writeFileSync(installedManifestPath, JSON.stringify(linkedManifest), "utf8");
    const linkedWorkspaceUpdateCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/install"),
      state: cloudRecruitState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => linkedWorkspaceUpdateCalls.push({ status, data }),
      readJsonBody: async () => ({ packageId: cloudRegistryPackage.id }),
    });
    assert.equal(linkedWorkspaceUpdateCalls[0]?.status, 409);
    assert.equal(linkedWorkspaceUpdateCalls[0]?.data.error, "app_store_update_not_safe");
    assert.equal(lstatSync(linkedWorkspaceParent).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(externalWorkspaceParent, "workspace", "external-user.md"), "utf8"),
      "external user content\n",
      "an intermediate workspace symlink must never move content outside the App root",
    );
    writeFileSync(installedManifestPath, installedManifestBeforeSymlink, "utf8");
    rmSync(linkedWorkspaceParent, { force: true });
  }

  const firstPublishAppRoot = join(tempRoot, "first-publish-app");
  mkdirSync(join(firstPublishAppRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(firstPublishAppRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "first-publish-app",
      title: "First Publish App",
      description: "Manifest description",
      ui: { surface: "file-workbench", workspace: "workspace" },
      workspace: { path: "workspace" },
      employees: [
        {
          id: "writer",
          name: "Manifest Writer",
          role: "Writes the first release.",
          kernel: "claude-code",
          model: "claude-code-default",
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(join(firstPublishAppRoot, "source.txt"), "first local publish\n", "utf8");
  writeFileSync(join(firstPublishAppRoot, "workspace", "keep.md"), "local workspace state\n", "utf8");
  const firstPublishState = createBridgeState({ statePath: join(tempRoot, "first-publish-state.json") });
  firstPublishState.settings.mountedApps = [
    {
      id: "first-publish-app",
      path: firstPublishAppRoot,
      enabled: true,
      title: "First Publish App",
      appBuilderEnabled: true,
    },
  ];
  recreateBridgeApp(firstPublishState);
  const firstPublishWriter = firstPublishState.app.rooms
    .listMembers()
    .find((member) => member.id === "member-app-first-publish-app-writer");
  assert.ok(firstPublishWriter);
  firstPublishState.app.rooms.patchMember(firstPublishWriter.id, {
    name: "Local Writer",
    role: "Turns a local story seed into a release-ready outline.",
    model: "deepseek-v4-pro",
    providerId: "ww",
    userOverrides: ["providerId"],
    reasoningEffort: "high",
    contextTokenBudget: 200_000,
    accessMode: "full-access",
    avatarDataUrl: "data:image/png;base64,aGFybmVzcw==",
    visibility: "public",
    publicDescription: "Public writer description",
    publicSkills: ["outline writing"],
    inputSpec: "A story seed",
    outputSpec: "A release-ready outline",
  });
  const legacyPrepareCalls: ReleaseHarnessCall[] = [];
  await handleAppStoreRoute({
    request: adminRequest("POST", "user_harness") as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/publish-mounted-app/prepare"),
    state: firstPublishState,
    security: adminSessionSecurity,
    sendJson: captureReleaseResponse(legacyPrepareCalls),
    readJsonBody: async () => {
      throw new Error("retired mounted prepare must not read a request body");
    },
  });
  assert.equal(legacyPrepareCalls[0]?.status, 410);
  assert.equal(legacyPrepareCalls[0]?.data.error, "app_store_mounted_publish_gone");
  const legacyPublishCalls: ReleaseHarnessCall[] = [];
  await handleAppStoreRoute({
    request: adminRequest("POST", "secondary_admin_harness") as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/publish-mounted-app"),
    state: firstPublishState,
    security: adminSessionSecurity,
    sendJson: captureReleaseResponse(legacyPublishCalls),
    readJsonBody: async () => {
      throw new Error("retired mounted publish must not read a request body");
    },
  });
  assert.equal(legacyPublishCalls[0]?.status, 410);
  assert.equal(legacyPublishCalls[0]?.data.error, "app_store_mounted_publish_gone");
  const legacyAppArchive = packAppStoreArchive({ appRoot: firstPublishAppRoot });
  assert.equal(legacyAppArchive.packageManifest.publishKind, undefined);
  const forgedEmployeeAppArchiveRoot = join(tempRoot, "forged-employee-app-archive");
  mkdirSync(forgedEmployeeAppArchiveRoot, { recursive: true });
  const forgedEmployeeAppSourcePath = join(tempRoot, "forged-employee-app-source.tgz");
  writeFileSync(forgedEmployeeAppSourcePath, legacyAppArchive.bytes);
  execFileSync("tar", ["-xzf", forgedEmployeeAppSourcePath, "-C", forgedEmployeeAppArchiveRoot]);
  const forgedEmployeeAppPackageId = String(legacyAppArchive.packageManifest.packageId);
  const nestedForgedEmployeeAppPackageManifestPath = join(
    forgedEmployeeAppArchiveRoot,
    forgedEmployeeAppPackageId,
    ".opengrove-package-manifest.json",
  );
  const forgedEmployeeAppPackageManifestPath = existsSync(nestedForgedEmployeeAppPackageManifestPath)
    ? nestedForgedEmployeeAppPackageManifestPath
    : join(forgedEmployeeAppArchiveRoot, ".opengrove-package-manifest.json");
  const forgedEmployeeAppPackageManifest = JSON.parse(
    readFileSync(forgedEmployeeAppPackageManifestPath, "utf8"),
  ) as Record<string, unknown>;
  forgedEmployeeAppPackageManifest.publishKind = "employee";
  writeFileSync(
    forgedEmployeeAppPackageManifestPath,
    `${JSON.stringify(forgedEmployeeAppPackageManifest, null, 2)}\n`,
    "utf8",
  );
  const forgedEmployeeAppArchivePath = join(tempRoot, "forged-employee-app.tgz");
  execFileSync("tar", ["-czf", forgedEmployeeAppArchivePath, "-C", forgedEmployeeAppArchiveRoot, "."]);
  lastPublishAuthorization = undefined;
  const forgedEmployeeAppPublishCalls: ReleaseHarnessCall[] = [];
  await handleAppStoreRoute({
    request: Object.assign(
      Readable.from([readFileSync(forgedEmployeeAppArchivePath)]),
      adminRequest("POST"),
    ) as unknown as IncomingMessage,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/publish-registry?fileName=forged-employee-app.tgz"),
    state: firstPublishState,
    security: adminSessionSecurity,
    sendJson: captureReleaseResponse(forgedEmployeeAppPublishCalls),
    readJsonBody: async () => ({}),
  });
  assert.equal(forgedEmployeeAppPublishCalls[0]?.status, 410);
  assert.equal(forgedEmployeeAppPublishCalls[0]?.data.error, "app_store_archive_publish_kind_not_supported");
  assert.equal(
    lastPublishAuthorization,
    undefined,
    "an App archive cannot bypass formal release by claiming to be an Employee package",
  );
  const explicitAppArchiveRoot = join(tempRoot, "explicit-app-archive");
  mkdirSync(explicitAppArchiveRoot, { recursive: true });
  writeFileSync(
    join(explicitAppArchiveRoot, ".opengrove-package-manifest.json"),
    JSON.stringify({ ...legacyAppArchive.packageManifest, publishKind: "app" }),
    "utf8",
  );
  const explicitAppArchivePath = join(tempRoot, "explicit-app.tgz");
  execFileSync("tar", ["-czf", explicitAppArchivePath, "-C", explicitAppArchiveRoot, "."]);
  lastPublishAuthorization = undefined;
  const directAppPublishCalls: ReleaseHarnessCall[] = [];
  await handleAppStoreRoute({
    request: Object.assign(
      Readable.from([readFileSync(explicitAppArchivePath)]),
      adminRequest("POST"),
    ) as unknown as IncomingMessage,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/publish-registry?fileName=registry-demo-app.tgz"),
    state: firstPublishState,
    security: adminSessionSecurity,
    sendJson: captureReleaseResponse(directAppPublishCalls),
    readJsonBody: async () => ({}),
  });
  assert.equal(directAppPublishCalls[0]?.status, 410);
  assert.equal(directAppPublishCalls[0]?.data.error, "app_store_archive_publish_kind_not_supported");
  assert.equal(
    lastPublishAuthorization,
    undefined,
    "a ready-made App archive must be rejected before any Registry publish request",
  );
  const strippedKindPublishCalls: ReleaseHarnessCall[] = [];
  await handleAppStoreRoute({
    request: Object.assign(Readable.from([legacyAppArchive.bytes]), adminRequest("POST")) as unknown as IncomingMessage,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/publish-registry?fileName=stripped-kind-app.tgz"),
    state: firstPublishState,
    security: adminSessionSecurity,
    sendJson: captureReleaseResponse(strippedKindPublishCalls),
    readJsonBody: async () => ({}),
  });
  assert.equal(strippedKindPublishCalls[0]?.status, 410);
  assert.equal(strippedKindPublishCalls[0]?.data.error, "app_store_archive_publish_kind_not_supported");
  assert.equal(
    lastPublishAuthorization,
    undefined,
    "an archive without an explicit employee publish kind must not bypass formal App release",
  );
  const unknownArchiveRoot = join(tempRoot, "unknown-kind-archive");
  mkdirSync(unknownArchiveRoot, { recursive: true });
  writeFileSync(
    join(unknownArchiveRoot, ".opengrove-package-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      packageId: "unknown-kind-package",
      appId: "unknown-kind-package",
      version: "0.1.0",
      files: {},
      excluded: [],
    }),
    "utf8",
  );
  const unknownArchivePath = join(tempRoot, "unknown-kind-package.tgz");
  execFileSync("tar", ["-czf", unknownArchivePath, "-C", unknownArchiveRoot, "."]);
  const unknownKindPublishCalls: ReleaseHarnessCall[] = [];
  await handleAppStoreRoute({
    request: Object.assign(
      Readable.from([readFileSync(unknownArchivePath)]),
      adminRequest("POST"),
    ) as unknown as IncomingMessage,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/publish-registry?fileName=unknown-kind-package.tgz"),
    state: firstPublishState,
    security: adminSessionSecurity,
    sendJson: captureReleaseResponse(unknownKindPublishCalls),
    readJsonBody: async () => ({}),
  });
  assert.equal(unknownKindPublishCalls[0]?.status, 410);
  assert.equal(unknownKindPublishCalls[0]?.data.error, "app_store_archive_publish_kind_not_supported");
  assert.equal(
    lastPublishAuthorization,
    undefined,
    "an unknown archive without employee.json must be rejected before Registry",
  );
  const nonAdminReleaseProgressCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: { method: "GET", headers: {} } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/first-publish-app/publish"),
      state: firstPublishState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(nonAdminReleaseProgressCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(nonAdminReleaseProgressCalls[0]?.status, 403);
  assert.equal(nonAdminReleaseProgressCalls[0]?.data.error, "admin_required");
  const nonAdminReleaseStatusCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: { method: "GET", headers: {} } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/first-publish-app/publish/status"),
      state: firstPublishState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(nonAdminReleaseStatusCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(nonAdminReleaseStatusCalls[0]?.status, 403);
  assert.equal(nonAdminReleaseStatusCalls[0]?.data.error, "admin_required");
  const missingReleaseProgressCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("GET", "secondary_admin_harness") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/first-publish-app/publish"),
      state: firstPublishState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(missingReleaseProgressCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(missingReleaseProgressCalls[0]?.status, 404);
  assert.equal(
    missingReleaseProgressCalls[0]?.data.error,
    "app_store_publish_journal_missing",
    "roles[] Admins may read resumable release state even when the primary role is user",
  );
  const missingReleaseStatusCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("GET", "secondary_admin_harness") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/first-publish-app/publish/status"),
      state: firstPublishState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(missingReleaseStatusCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(missingReleaseStatusCalls[0]?.status, 404);
  assert.equal(missingReleaseStatusCalls[0]?.data.error, "app_store_publish_journal_missing");
  const nonAdminGitPublishCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("POST", "user_harness") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/first-publish-app/publish"),
      state: firstPublishState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(nonAdminGitPublishCalls),
      readJsonBody: async () => ({ release: {} }),
    }),
    true,
  );
  assert.equal(nonAdminGitPublishCalls[0]?.status, 403);
  assert.equal(nonAdminGitPublishCalls[0]?.data.error, "admin_required");
  const nonAdminGitReconcileCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("POST", "user_harness") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/first-publish-app/publish/reconcile"),
      state: firstPublishState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(nonAdminGitReconcileCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(nonAdminGitReconcileCalls[0]?.status, 403);
  assert.equal(nonAdminGitReconcileCalls[0]?.data.error, "admin_required");
  const nonAdminKeepLocalCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("POST", "user_harness") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/first-publish-app/publish/keep-local"),
      state: firstPublishState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(nonAdminKeepLocalCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(nonAdminKeepLocalCalls[0]?.status, 403);
  assert.equal(nonAdminKeepLocalCalls[0]?.data.error, "admin_required");
  const nonAdminGitPrepareCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("GET", "user_harness") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/first-publish-app/publish/prepare"),
      state: firstPublishState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(nonAdminGitPrepareCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(nonAdminGitPrepareCalls[0]?.status, 403);
  assert.equal(nonAdminGitPrepareCalls[0]?.data.error, "admin_required");
  const repairBuildContractCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("POST") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/first-publish-app/publish/build-contract"),
      state: firstPublishState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(repairBuildContractCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(repairBuildContractCalls[0]?.status, 200);
  assert.equal(repairBuildContractCalls[0]?.data.ok, true);
  assert.equal(
    readFileSync(join(firstPublishAppRoot, "workspace", "keep.md"), "utf8"),
    "local workspace state\n",
    "repairing a legacy build contract must never touch Workspace",
  );
  assert.deepEqual(validateAppReleaseBuildContract(firstPublishAppRoot), { ok: true, detail: "build_contract_valid" });
  const customBuildAppRoot = join(tempRoot, "custom-build-app");
  mkdirSync(customBuildAppRoot, { recursive: true });
  writeFileSync(
    join(customBuildAppRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "custom-build-app",
      title: "Custom Build App",
      ui: { surface: "file-workbench", workspace: "workspace" },
      workspace: { path: "workspace" },
    }),
    "utf8",
  );
  writeFileSync(join(customBuildAppRoot, "build.mjs"), "throw new Error('custom build');\n", "utf8");
  const customBuildState = createBridgeState({ statePath: join(tempRoot, "custom-build-state.json") });
  customBuildState.settings.mountedApps = [
    {
      id: "custom-build-app",
      path: customBuildAppRoot,
      enabled: true,
      title: "Custom Build App",
      appBuilderEnabled: true,
    },
  ];
  recreateBridgeApp(customBuildState);
  const conflictingBuildContractCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("POST") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/custom-build-app/publish/build-contract"),
      state: customBuildState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(conflictingBuildContractCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(conflictingBuildContractCalls[0]?.status, 409);
  assert.equal(conflictingBuildContractCalls[0]?.data.error, "app_release_build_contract_repair_conflict");
  assert.equal(
    existsSync(join(customBuildAppRoot, ".opengrove-build.json")),
    false,
    "repair must not guess a contract for an existing custom build entry",
  );
  assert.equal(
    existsSync(join(customBuildAppRoot, "web")),
    false,
    "a rejected repair must not leave partial platform scaffold files",
  );
  rmSync(join(customBuildAppRoot, "build.mjs"));
  mkdirSync(join(customBuildAppRoot, "ui"), { recursive: true });
  writeFileSync(join(customBuildAppRoot, "ui", "index.html"), "<p>legacy static UI</p>\n", "utf8");
  const existingOutputContractCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("POST") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/custom-build-app/publish/build-contract"),
      state: customBuildState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(existingOutputContractCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(existingOutputContractCalls[0]?.status, 409);
  assert.equal(existingOutputContractCalls[0]?.data.error, "app_release_build_contract_repair_conflict");
  assert.equal(existsSync(join(customBuildAppRoot, "web")), false);
  assert.equal(
    readFileSync(join(customBuildAppRoot, "ui", "index.html"), "utf8"),
    "<p>legacy static UI</p>\n",
    "repair must not reinterpret existing generated output as platform source",
  );
  rmSync(join(customBuildAppRoot, "ui"), { recursive: true, force: true });
  mkdirSync(join(customBuildAppRoot, "web"), { recursive: true });
  writeFileSync(join(customBuildAppRoot, "web", "index.html"), "<p>custom source</p>\n", "utf8");
  const existingSourceContractCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("POST") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/custom-build-app/publish/build-contract"),
      state: customBuildState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(existingSourceContractCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(existingSourceContractCalls[0]?.status, 409);
  assert.equal(existingSourceContractCalls[0]?.data.error, "app_release_build_contract_repair_conflict");
  assert.equal(
    existsSync(join(customBuildAppRoot, ".opengrove-build.json")),
    false,
    "repair must not infer a copy build for pre-existing web source",
  );

  rmSync(join(customBuildAppRoot, "web"), { recursive: true, force: true });
  writeFileSync(
    join(customBuildAppRoot, "package.json"),
    JSON.stringify({
      scripts: { build: "vite build" },
      devDependencies: { vite: "latest" },
    }),
    "utf8",
  );
  const packageBuildContractCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("POST") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/custom-build-app/publish/build-contract"),
      state: customBuildState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(packageBuildContractCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(packageBuildContractCalls[0]?.status, 409);
  assert.equal(
    packageBuildContractCalls[0]?.data.error,
    "app_release_build_contract_repair_conflict",
    "repair must not replace an existing package build with the platform copy build",
  );
  assert.equal(existsSync(join(customBuildAppRoot, "web")), false);

  rmSync(join(customBuildAppRoot, "package.json"), { force: true });
  mkdirSync(join(customBuildAppRoot, "build.mjs"));
  const unreadableBuildContractCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("POST") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/custom-build-app/publish/build-contract"),
      state: customBuildState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(unreadableBuildContractCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(unreadableBuildContractCalls[0]?.status, 409);
  assert.equal(
    unreadableBuildContractCalls[0]?.data.error,
    "app_release_build_contract_repair_conflict",
    "filesystem diagnostics must not expose the App root through the HTTP response",
  );
  assert.equal(JSON.stringify(unreadableBuildContractCalls[0]?.data).includes(customBuildAppRoot), false);
  rmSync(join(customBuildAppRoot, "build.mjs"), { recursive: true, force: true });
  const gitPrepareCalls: ReleaseHarnessCall[] = [];
  assert.equal(
    await handleAppsRoute({
      request: adminRequest("GET") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/apps/first-publish-app/publish/prepare"),
      state: firstPublishState,
      security: adminSessionSecurity,
      sendJson: captureReleaseResponse(gitPrepareCalls),
      readJsonBody: async () => ({}),
    }),
    true,
  );
  assert.equal(gitPrepareCalls[0]?.status, 200);
  assert.equal(gitPrepareCalls[0]?.data.release.version, "0.1.0");
  const gitPreparedWriter = gitPrepareCalls[0]?.data.release.employees.find(
    (employee: { memberId: string }) => employee.memberId === firstPublishWriter.id,
  );
  assert.equal(gitPreparedWriter?.contextTokenBudget, 200_000);
  assert.equal(
    Object.prototype.hasOwnProperty.call(gitPreparedWriter ?? {}, "providerId"),
    false,
    "Git-backed App release drafts must not publish the publisher's local Provider route",
  );

  if (process.platform !== "win32") {
    const linkedPublishSource = join(firstPublishAppRoot, "linked-source.txt");
    symlinkSync("source.txt", linkedPublishSource);
    try {
      const linkedPublishCalls: ReleaseHarnessCall[] = [];
      assert.equal(
        await handleAppsRoute({
          request: adminRequest("POST") as any,
          response: { once: () => undefined, off: () => undefined } as any,
          url: new URL("http://opengrove.test/apps/first-publish-app/publish"),
          state: firstPublishState,
          security: adminSessionSecurity,
          sendJson: captureReleaseResponse(linkedPublishCalls),
          readJsonBody: async () => ({
            release: gitPrepareCalls[0]?.data.release,
            applyToCurrentApp: true,
          }),
        }),
        true,
      );
      assert.equal(linkedPublishCalls[0]?.status, 422, JSON.stringify(linkedPublishCalls[0]?.data));
      assert.equal(linkedPublishCalls[0]?.data.error, "app_revision_symlink_not_supported");
      assert.deepEqual(linkedPublishCalls[0]?.data.detail, { path: "linked-source.txt" });
    } finally {
      rmSync(linkedPublishSource, { force: true });
    }
  }

  // 旧 mounted 直传入口虽已退役，升级前落盘的 published recovery 仍需安全收尾。
  for (const targetChanged of [false, true]) {
    const suffix = targetChanged ? "changed" : "ready";
    const recoveryAppId = `legacy-recovery-${suffix}`;
    const recoveryAppRoot = join(tempRoot, recoveryAppId);
    mkdirSync(join(recoveryAppRoot, "workspace"), { recursive: true });
    writeFileSync(
      join(recoveryAppRoot, "opengrove.app.json"),
      JSON.stringify({
        id: recoveryAppId,
        title: `Legacy Recovery ${suffix}`,
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: { packageKey: `harness.${recoveryAppId}` },
      }),
      "utf8",
    );
    writeFileSync(join(recoveryAppRoot, "source.txt"), "published source\n", "utf8");
    const recoveryState = createBridgeState({
      statePath: join(tempRoot, `${recoveryAppId}-state.json`),
    });
    recoveryState.settings.mountedApps = [
      {
        id: recoveryAppId,
        path: recoveryAppRoot,
        enabled: true,
        title: `Legacy Recovery ${suffix}`,
      },
    ];
    const recoveryArchive = packAppStoreArchive({ appRoot: recoveryAppRoot });
    const idempotencyKey = `og-app-publish-${(targetChanged ? "b" : "a").repeat(64)}`;
    prepareAppStorePublishRecovery({
      state: recoveryState,
      idempotencyKey,
      targetSnapshot: captureAppStorePublishTarget(recoveryAppRoot),
      packageManifest: recoveryArchive.packageManifest,
      archive: recoveryArchive,
      packageKey: `harness.${recoveryAppId}`,
      visibility: "restricted",
    });
    markAppStorePublishRecoveryPublished({
      state: recoveryState,
      idempotencyKey,
      publishedPackage: {
        ...cloudRegistryPackage,
        id: `harness.${recoveryAppId}`,
        packageId: recoveryAppId,
        packageKey: `harness.${recoveryAppId}`,
        appId: recoveryAppId,
        title: `Legacy Recovery ${suffix}`,
        version: "0.1.0",
        archiveName: recoveryArchive.fileName,
        archiveSha256: recoveryArchive.archiveSha256,
        archiveSize: recoveryArchive.archiveSize,
      },
    });
    if (targetChanged) {
      writeFileSync(join(recoveryAppRoot, "source.txt"), "newer local source\n", "utf8");
    }
    const recoveryCatalogCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: adminRequest("GET") as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store"),
      state: recoveryState,
      security: adminSessionSecurity,
      sendJson: (_response, status, data) => recoveryCatalogCalls.push({ status, data }),
      readJsonBody: async () => ({}),
    });
    assert.equal(recoveryCatalogCalls[0]?.status, 200);
    assert.equal(recoveryCatalogCalls[0]?.data.publishRecovery.recovered, targetChanged ? 0 : 1);
    assert.equal(recoveryCatalogCalls[0]?.data.publishRecovery.failed, targetChanged ? 1 : 0);
    assert.equal(existsSync(join(recoveryAppRoot, ".opengrove-store-package.json")), !targetChanged);
    if (targetChanged) {
      assert.equal(
        readFileSync(join(recoveryAppRoot, "source.txt"), "utf8"),
        "newer local source\n",
        "legacy recovery must not overwrite a target that changed after remote publication",
      );
      assert.equal(
        readdirSync(join(appStoreDataRoot(recoveryState), "publish-recovery")).some(
          (name) => name === `${idempotencyKey}.json`,
        ),
        true,
      );
    }
  }

  // ===== 员工包：打包脱敏、token 门控、云端发布、注册表招聘 =====
  const employeeState = createBridgeState({ statePath: join(tempRoot, "employee-state.json") });
  const privateMemberId = "member-app-private-local-app-publisher";
  employeeState.app.rooms.upsertMember({
    id: privateMemberId,
    name: "Publisher",
    avatarMode: "generated",
    avatarSeed: "publisher-notionists-choice",
    kernel: "codex",
    model: DEFAULT_BRIDGE_MODEL_ID,
    role: [
      "Publishes reusable employee packs.",
      "Internal mounted app instruction that must not ship.",
      "App instructions:",
      "Use /private/local/app/root and hidden app manual.",
      "App: Secret Publisher (private-local-app)",
      "Workspace scope: /private/local/app/workspace",
    ].join("\n"),
    status: "idle",
    color: "#2563eb",
    lastActive: "now",
    defaultSkillIds: [],
    visibility: "public",
    publicDescription: "Publishes reusable employees without private local paths.",
    publicSkills: ["employee packaging"],
    inputSpec: "Employee id and optional packaging metadata.",
    outputSpec: "Installable employee package with dependency metadata.",
  });
  employeeState.store.saveFrom(employeeState.app);
  const systemEmployeeRuntime = resolveSystemEmployeeRuntime(employeeState);
  const publicDefaultEmployeeModel =
    systemEmployeeRuntime.kernel === "codex" ? systemEmployeeRuntime.model : DEFAULT_BRIDGE_MODEL_ID;
  const employeeArchive = packEmployeeStoreArchive({
    state: employeeState,
    memberId: privateMemberId,
    publisher: "Harness",
  });
  const employeeManifest = employeeArchive.manifest;
  assert.equal(employeeManifest.publishKind, "employee");
  assert.equal(employeeManifest.employee.name, "Publisher");
  assert.equal(employeeManifest.employee.avatarMode, "generated");
  assert.equal(employeeManifest.employee.avatarSeed, "publisher-notionists-choice");
  assert.notEqual(employeeManifest.employee.id, privateMemberId);
  assert.match(employeeManifest.employee.id, /^publisher-[a-f0-9]{8}$/);
  assert.doesNotMatch(employeeManifest.id, /private-local-app/);
  assert.equal(employeeManifest.employee.role, "Publishes reusable employee packs.");
  assert.doesNotMatch(
    employeeManifest.employee.role ?? "",
    /App instructions:|App:|Workspace scope:|Internal mounted app instruction|hidden app manual|private-local-app|\/private\/local/,
  );
  assert.doesNotMatch(
    employeeManifest.summary ?? "",
    /App instructions:|Internal mounted app instruction|hidden app manual|private-local-app|\/private\/local/,
  );
  assert.equal(employeeManifest.employee.visibility, "public");
  assert.equal(
    employeeManifest.employee.publicDescription,
    "Publishes reusable employees without private local paths.",
  );
  assert.deepEqual(employeeManifest.employee.publicSkills, ["employee packaging"]);
  assert.equal(employeeManifest.employee.inputSpec, "Employee id and optional packaging metadata.");
  assert.equal(employeeManifest.employee.outputSpec, "Installable employee package with dependency metadata.");
  assert.equal(employeeManifest.dependencies?.kernels?.[0], "codex");
  assert.equal(employeeManifest.employee.model, publicDefaultEmployeeModel);
  assert.equal(employeeArchive.fileName, `${employeeManifest.id}.tgz`);
  assert.equal(createHash("sha256").update(employeeArchive.bytes).digest("hex"), employeeArchive.archiveSha256);
  const employeeArchiveProbe = join(tempRoot, "employee-archive-probe.tgz");
  writeFileSync(employeeArchiveProbe, employeeArchive.bytes);
  const employeeArchiveEntries = execFileSync("tar", ["-tzf", employeeArchiveProbe], { encoding: "utf8" });
  assert.match(employeeArchiveEntries, /employee\.json/);
  assert.match(
    employeeArchiveEntries,
    /\.opengrove-package-manifest\.json/,
    "employee pack must carry the package manifest the cloud registry requires",
  );

  const noPublicSummaryMemberId = "member-app-private-no-public-summary";
  employeeState.app.rooms.upsertMember({
    id: noPublicSummaryMemberId,
    name: "No Public Summary",
    kernel: "codex",
    model: DEFAULT_BRIDGE_MODEL_ID,
    role: [
      "Safe visible lead.",
      "Private role note that must not become summary.",
      "App instructions:",
      "Never expose this internal prompt.",
      "Workspace scope: /private/no-summary",
    ].join("\n"),
    status: "idle",
    color: "#0f766e",
    lastActive: "now",
    defaultSkillIds: [],
    visibility: "public",
  });
  employeeState.store.saveFrom(employeeState.app);
  const noPublicSummaryArchive = packEmployeeStoreArchive({
    state: employeeState,
    memberId: noPublicSummaryMemberId,
    publisher: "Harness",
  });
  assert.equal(noPublicSummaryArchive.manifest.summary, "No Public Summary for OpenGrove Rooms.");
  assert.equal(noPublicSummaryArchive.manifest.employee.role, "Safe visible lead.");

  // 没有 admin session 时，发布在读取 registry token 前就必须被拒绝。
  await withRegistryEnvCleared(async () => {
    const tokenlessState = createBridgeState({ statePath: join(tempRoot, "tokenless-state.json") });
    tokenlessState.settings.appStore = { registryUrl: fakeCloudUrl };
    const tokenlessCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST" } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/publish-employee"),
      state: tokenlessState,
      sendJson: (_response, status, data) => tokenlessCalls.push({ status, data }),
      readJsonBody: async () => ({ memberId: privateMemberId }),
    });
    assert.equal(tokenlessCalls[0]?.status, 403);
    assert.equal(tokenlessCalls[0]?.data.error, "admin_required");
  });

  const employeePackageTemplate: AppStorePackageRecord = {
    id: employeeManifest.id,
    packageKey: `harness.${employeeManifest.id}`,
    packageId: employeeManifest.id,
    title: employeeManifest.title,
    summary: employeeManifest.summary ?? "Employee pack",
    version: employeeManifest.version || "0.1.0",
    category: "员工",
    publishKind: "employee",
    installMode: "contacts",
    appId: employeeManifest.id,
    workspaceName: "OpenGrove Rooms",
    requirements: [],
    capabilities: [],
    employee: {
      id: employeeManifest.employee.id,
      name: employeeManifest.employee.name,
      kernel: "codex",
    },
    backupScopes: [],
    status: "available",
    publisher: "Harness",
    usageCount: 0,
    source: "registry",
    archiveName: employeeArchive.fileName,
  };
  publishedPackageTemplate = {
    ...employeePackageTemplate,
    id: `${employeeManifest.id}-archive-upload`,
    packageId: `${employeeManifest.id}-archive-upload`,
    packageKey: `harness.${employeeManifest.id}-archive-upload`,
  };
  const directEmployeePublishCalls: ReleaseHarnessCall[] = [];
  await handleAppStoreRoute({
    request: Object.assign(Readable.from([employeeArchive.bytes]), adminRequest("POST")) as unknown as IncomingMessage,
    response: {} as any,
    url: new URL(
      `/app-store/publish-registry?fileName=${encodeURIComponent(employeeArchive.fileName)}`,
      "http://opengrove.test",
    ),
    state: employeeState,
    security: adminSessionSecurity,
    sendJson: captureReleaseResponse(directEmployeePublishCalls),
    readJsonBody: async () => ({}),
  });
  assert.equal(directEmployeePublishCalls[0]?.status, 200);
  assert.equal(directEmployeePublishCalls[0]?.data.package?.publishKind, "employee");
  const legacyEmployeeArchiveRoot = join(tempRoot, "legacy-employee-archive");
  mkdirSync(legacyEmployeeArchiveRoot, { recursive: true });
  writeFileSync(join(tempRoot, "legacy-employee-source.tgz"), employeeArchive.bytes);
  execFileSync("tar", ["-xzf", join(tempRoot, "legacy-employee-source.tgz"), "-C", legacyEmployeeArchiveRoot]);
  const legacyEmployeePackageManifestPath = join(
    legacyEmployeeArchiveRoot,
    employeeManifest.id,
    ".opengrove-package-manifest.json",
  );
  const legacyEmployeePackageManifest = JSON.parse(readFileSync(legacyEmployeePackageManifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  delete legacyEmployeePackageManifest.publishKind;
  writeFileSync(
    legacyEmployeePackageManifestPath,
    `${JSON.stringify(legacyEmployeePackageManifest, null, 2)}\n`,
    "utf8",
  );
  const legacyEmployeeArchivePath = join(tempRoot, "legacy-employee.tgz");
  execFileSync("tar", ["-czf", legacyEmployeeArchivePath, "-C", legacyEmployeeArchiveRoot, employeeManifest.id]);
  publishIdempotencyResponses.clear();
  publishedPackageTemplate = {
    ...employeePackageTemplate,
    id: `${employeeManifest.id}-legacy-archive-upload`,
    packageId: `${employeeManifest.id}-legacy-archive-upload`,
    packageKey: `harness.${employeeManifest.id}-legacy-archive-upload`,
  };
  lastPublishAuthorization = undefined;
  const legacyEmployeePublishCalls: ReleaseHarnessCall[] = [];
  await handleAppStoreRoute({
    request: Object.assign(
      Readable.from([readFileSync(legacyEmployeeArchivePath)]),
      adminRequest("POST"),
    ) as unknown as IncomingMessage,
    response: {} as any,
    url: new URL(
      `/app-store/publish-registry?fileName=${encodeURIComponent("legacy-employee.tgz")}`,
      "http://opengrove.test",
    ),
    state: employeeState,
    security: adminSessionSecurity,
    sendJson: captureReleaseResponse(legacyEmployeePublishCalls),
    readJsonBody: async () => ({}),
  });
  assert.equal(legacyEmployeePublishCalls[0]?.status, 200);
  assert.equal(legacyEmployeePublishCalls[0]?.data.package?.publishKind, "employee");
  assert.equal(
    lastPublishAuthorization,
    "Bearer reg_harness",
    "a legacy Employee archive must reach Registry after strict archive validation",
  );
  legacyEmployeePackageManifest.packageId = "different-employee-identity";
  writeFileSync(
    legacyEmployeePackageManifestPath,
    `${JSON.stringify(legacyEmployeePackageManifest, null, 2)}\n`,
    "utf8",
  );
  const mismatchedLegacyEmployeeArchivePath = join(tempRoot, "legacy-employee-mismatched.tgz");
  execFileSync("tar", [
    "-czf",
    mismatchedLegacyEmployeeArchivePath,
    "-C",
    legacyEmployeeArchiveRoot,
    employeeManifest.id,
  ]);
  lastPublishAuthorization = undefined;
  const mismatchedLegacyEmployeePublishCalls: ReleaseHarnessCall[] = [];
  await handleAppStoreRoute({
    request: Object.assign(
      Readable.from([readFileSync(mismatchedLegacyEmployeeArchivePath)]),
      adminRequest("POST"),
    ) as unknown as IncomingMessage,
    response: {} as any,
    url: new URL("/app-store/publish-registry?fileName=legacy-employee-mismatched.tgz", "http://opengrove.test"),
    state: employeeState,
    security: adminSessionSecurity,
    sendJson: captureReleaseResponse(mismatchedLegacyEmployeePublishCalls),
    readJsonBody: async () => ({}),
  });
  assert.equal(mismatchedLegacyEmployeePublishCalls[0]?.status, 410);
  assert.equal(lastPublishAuthorization, undefined, "legacy Employee package identity must match employee.json");
  legacyEmployeePackageManifest.packageId = employeeManifest.id;
  writeFileSync(
    legacyEmployeePackageManifestPath,
    `${JSON.stringify(legacyEmployeePackageManifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(legacyEmployeeArchiveRoot, employeeManifest.id, "opengrove.app.json"),
    JSON.stringify({
      id: employeeManifest.id,
      title: employeeManifest.title,
      ui: { kind: "none" },
      workspace: { path: "workspace" },
    }),
    "utf8",
  );
  const ambiguousLegacyEmployeeArchivePath = join(tempRoot, "legacy-employee-with-app.tgz");
  execFileSync("tar", [
    "-czf",
    ambiguousLegacyEmployeeArchivePath,
    "-C",
    legacyEmployeeArchiveRoot,
    employeeManifest.id,
  ]);
  const ambiguousLegacyEmployeePublishCalls: ReleaseHarnessCall[] = [];
  await handleAppStoreRoute({
    request: Object.assign(
      Readable.from([readFileSync(ambiguousLegacyEmployeeArchivePath)]),
      adminRequest("POST"),
    ) as unknown as IncomingMessage,
    response: {} as any,
    url: new URL("/app-store/publish-registry?fileName=legacy-employee-with-app.tgz", "http://opengrove.test"),
    state: employeeState,
    security: adminSessionSecurity,
    sendJson: captureReleaseResponse(ambiguousLegacyEmployeePublishCalls),
    readJsonBody: async () => ({}),
  });
  assert.equal(ambiguousLegacyEmployeePublishCalls[0]?.status, 410);
  assert.equal(
    lastPublishAuthorization,
    undefined,
    "an archive containing an App manifest cannot use legacy Employee compatibility",
  );
  cloudStorePackages.delete(`${employeeManifest.id}-archive-upload`);
  cloudStorePackages.delete(`${employeeManifest.id}-legacy-archive-upload`);
  publishIdempotencyResponses.clear();
  publishedPackageTemplate = employeePackageTemplate;
  const publishEmployeeCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: adminRequest("POST") as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/publish-employee"),
    state: employeeState,
    security: adminSessionSecurity,
    sendJson: (_response, status, data) => publishEmployeeCalls.push({ status, data }),
    readJsonBody: async () => ({ memberId: privateMemberId, publisher: "Harness" }),
  });
  assert.equal(publishEmployeeCalls[0]?.status, 200);
  assert.equal(publishEmployeeCalls[0]?.data.package?.publishKind, "employee");
  assert.equal(publishEmployeeCalls[0]?.data.package?.id, employeeManifest.id);
  assert.equal(lastPublishAuthorization, "Bearer reg_harness", "employee publish must use the registry token");

  const employeeInstallState = createBridgeState({ statePath: join(tempRoot, "employee-install-state.json") });
  const employeeAppDirectory = join(tempRoot, employeeManifest.id);
  mkdirSync(employeeAppDirectory, { recursive: true });
  const employeeDirectorySentinel = join(employeeAppDirectory, "keep.txt");
  writeFileSync(employeeDirectorySentinel, "employee installs must not touch App directories\n", "utf8");
  const employeeRecruitCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: employeeInstallState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => employeeRecruitCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: employeeManifest.id }),
  });
  assert.equal(employeeRecruitCalls[0]?.status, 200);
  const employeeInstall = employeeRecruitCalls[0]?.data.install;
  assert.equal(employeeInstall?.installMode, "contacts");
  assert.match(employeeInstall?.member?.id ?? "", /^member-store-local-/);
  assert.equal(employeeInstall?.member?.storePackageId, employeeManifest.id);
  assert.equal(employeeInstall?.member?.name, "Publisher");
  assert.equal(employeeInstall?.member?.avatarMode, "generated");
  assert.equal(employeeInstall?.member?.avatarSeed, "publisher-notionists-choice");
  assert.equal(employeeInstall?.member?.avatarDataUrl, undefined);
  assert.equal(employeeInstall?.member?.model, publicDefaultEmployeeModel);
  assert.equal(employeeInstall?.member?.visibility, "public");
  assert.equal(employeeInstall?.member?.publicDescription, "Publishes reusable employees without private local paths.");
  assert.deepEqual(employeeInstall?.member?.publicSkills, ["employee packaging"]);
  assert.equal(employeeInstall?.member?.inputSpec, "Employee id and optional packaging metadata.");
  assert.equal(employeeInstall?.member?.outputSpec, "Installable employee package with dependency metadata.");
  assert.equal(readFileSync(employeeDirectorySentinel, "utf8"), "employee installs must not touch App directories\n");
  assert.equal(
    listAppStorePackages(employeeInstallState.settings, {
      storeRoot: appStoreDataRoot(employeeInstallState),
      installedEmployeePackageIds: installedEmployeePackageIds(employeeInstallState),
      state: employeeInstallState,
    }).find((item) => item.id === employeeManifest.id)?.installed,
    true,
  );
  const installedEmployeePackage = publishEmployeeCalls[0]?.data.package as AppStorePackageRecord;
  const employeeCatalogUpdate = mergeAppStoreCatalogPackages(
    [{ ...installedEmployeePackage, archiveSha256: "1".repeat(64), installed: true }],
    [{ ...installedEmployeePackage, archiveSha256: "2".repeat(64) }],
    [installedEmployeePackage.id],
  )[0];
  assert.equal(employeeCatalogUpdate?.installed, true);
  assert.equal(employeeCatalogUpdate?.installState, "installed_current");
  assert.equal(
    employeeCatalogUpdate?.updateAvailable,
    false,
    "employee updates must wait for installed fingerprint evidence instead of trusting catalog cache data",
  );

  const crossRegistryPackageKey = "publisher.cross-registry-app";
  const crossRegistryAppId = "cross-registry-app";
  const crossRegistryCatalogItem = mergeAppStoreCatalogPackages(
    [],
    [
      {
        ...cloudRegistryPackage,
        id: "registry-b-cross-registry-app",
        appId: crossRegistryAppId,
        packageId: crossRegistryAppId,
        packageKey: crossRegistryPackageKey,
        packageRef: `https://registry-b.example.test#${crossRegistryPackageKey}`,
        archiveSha256: "2".repeat(64),
      },
    ],
    [],
    [
      {
        appId: crossRegistryAppId,
        mountedAppId: crossRegistryAppId,
        appRootExists: true,
        packageKey: crossRegistryPackageKey,
        packageRef: `https://registry-a.example.test#${crossRegistryPackageKey}`,
        archiveSha256: "1".repeat(64),
      },
    ],
  )[0];
  assert.equal(
    crossRegistryCatalogItem?.installed,
    true,
    "registry URL changes (IP→domain, http→https) must not orphan installed Apps as source conflicts",
  );
  assert.equal(crossRegistryCatalogItem?.installState, "update_available");
  assert.equal(crossRegistryCatalogItem?.updateAvailable, true);
  assert.equal(crossRegistryCatalogItem?.openIssue, undefined);

  const legacyUrlAppId = "legacy-url-app";
  const legacyUrlPackageKey = "publisher.legacy-url-app";
  const legacyUrlRoot = join(tempRoot, legacyUrlAppId);
  mkdirSync(join(legacyUrlRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(legacyUrlRoot, "opengrove.app.json"),
    JSON.stringify({
      id: legacyUrlAppId,
      title: "Legacy URL App",
      ui: { surface: "file-workbench", workspace: "workspace" },
      store: { packageKey: legacyUrlPackageKey },
    }),
    "utf8",
  );
  writeFileSync(
    join(legacyUrlRoot, ".opengrove-store-package.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        source: "registry",
        registryUrl: "https://legacy-registry.example.test",
        packageRef: `https://legacy-registry.example.test#${legacyUrlPackageKey}`,
        packageKey: legacyUrlPackageKey,
        packageId: legacyUrlAppId,
        appId: legacyUrlAppId,
        version: "0.1.1",
        archiveSha256: "1".repeat(64),
        fingerprint: "1".repeat(64),
        installedAt: "2026-07-07T04:18:48.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const legacyUrlItem: AppStorePackageRecord = {
    ...cloudRegistryPackage,
    id: "cloud-legacy-url-app",
    appId: legacyUrlAppId,
    packageId: legacyUrlAppId,
    packageKey: legacyUrlPackageKey,
    packageRef: `https://opengrove.example.test#${legacyUrlPackageKey}`,
    archiveSha256: "2".repeat(64),
  };
  const legacyUrlSettings = { mountedApps: [{ id: legacyUrlAppId, path: legacyUrlRoot, enabled: true }] };
  assert.deepEqual(
    inspectAppStorePackageRuntimeState(
      { ...legacyUrlItem, installed: true, installedAppId: legacyUrlAppId },
      legacyUrlSettings,
      { appStoreRoot: tempRoot },
    ),
    { openable: true, openableAppId: legacyUrlAppId, repairable: false, updateSafe: true },
    "a marker recorded under an old registry URL must stay Store-managed after the registry moves",
  );
  assert.equal(
    appStorePackageInstallSafetyError(legacyUrlItem, legacyUrlSettings, { appStoreRoot: tempRoot }),
    undefined,
    "registry URL migration (IP→domain, http→https) must not surface app_store_source_conflict",
  );

  const reinstallSourceRoot = join(tempRoot, "reinstall-app-source");
  mkdirSync(join(reinstallSourceRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(reinstallSourceRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "reinstall-app",
      title: "Reinstall App",
      ui: { surface: "file-workbench", workspace: "workspace" },
      store: { packageKey: "harness.reinstall-app" },
    }),
    "utf8",
  );
  writeFileSync(join(reinstallSourceRoot, "workspace", "seed.md"), "seed\n", "utf8");
  const reinstallArchivePath = join(tempRoot, "reinstall-app.tar.gz");
  execFileSync("tar", ["-czf", reinstallArchivePath, "-C", reinstallSourceRoot, "."]);
  const reinstallArchive = readFileSync(reinstallArchivePath);
  const reinstallPackage: AppStorePackageRecord = {
    ...storySeedPackage,
    id: "cloud-reinstall-app",
    packageId: "harness.reinstall-app",
    packageKey: "harness.reinstall-app",
    appId: "reinstall-app",
    title: "Reinstall App",
    archiveName: "reinstall-app.tar.gz",
    archiveSize: reinstallArchive.byteLength,
    archiveSha256: createHash("sha256").update(reinstallArchive).digest("hex"),
  };
  cloudStorePackages.set(reinstallPackage.id, { pkg: reinstallPackage, bytes: reinstallArchive });
  const reinstallState = createBridgeState({ statePath: join(tempRoot, "reinstall-state.json") });
  const reinstallCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: reinstallState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => reinstallCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: reinstallPackage.id }),
  });
  assert.equal(reinstallCalls[0]?.status, 200);
  const reinstallRoot = join(tempRoot, "reinstall-app");
  writeFileSync(join(reinstallRoot, "workspace", "user-note.md"), "user data\n", "utf8");

  // 侧边栏删除 = 只移除挂载记录,磁盘目录残留:同一个包必须能重装认领残留。
  reinstallState.settings.mountedApps = [];
  assert.equal(
    appStorePackageInstallSafetyError(reinstallPackage, reinstallState.settings, { appStoreRoot: tempRoot }),
    undefined,
    "a leftover root from the same package must not block reinstall after the mount record was removed",
  );
  const reinstallAgainCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: reinstallState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => reinstallAgainCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: reinstallPackage.id }),
  });
  assert.equal(reinstallAgainCalls[0]?.status, 200);
  assert.equal(reinstallState.settings.mountedApps[0]?.id, "reinstall-app");
  assert.equal(
    readFileSync(join(reinstallRoot, "workspace", "user-note.md"), "utf8"),
    "user data\n",
    "reinstalling over a same-package leftover must preserve workspace content",
  );

  // 异包残留(同 appId、不同 packageKey)仍然必须拒绝。
  const squatterPackage: AppStorePackageRecord = {
    ...reinstallPackage,
    id: "cloud-reinstall-squatter",
    packageId: "other.reinstall-app",
    packageKey: "other.reinstall-app",
    publisher: "Other Publisher",
  };
  cloudStorePackages.set(squatterPackage.id, { pkg: squatterPackage, bytes: reinstallArchive });
  const squatterState = createBridgeState({ statePath: join(tempRoot, "reinstall-squatter-state.json") });
  squatterState.settings.mountedApps = [];
  const squatterCalls: Array<{ status: number; data: any }> = [];
  await handleAppStoreRoute({
    request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
    response: {} as any,
    url: new URL("http://opengrove.test/app-store/install"),
    state: squatterState,
    security: sessionSecurity,
    sendJson: (_response, status, data) => squatterCalls.push({ status, data }),
    readJsonBody: async () => ({ packageId: squatterPackage.id }),
  });
  assert.equal(squatterCalls[0]?.status, 409);
  assert.equal(squatterCalls[0]?.data.error, "app_store_update_not_safe");
  assert.equal(
    readFileSync(join(reinstallRoot, "workspace", "user-note.md"), "utf8"),
    "user data\n",
    "a different package with the same appId must not take over a leftover root",
  );

  const previousTrashDir = process.env.OPENGROVE_TRASH_DIR;
  process.env.OPENGROVE_TRASH_DIR = join(tempRoot, "harness-trash");
  try {
    const uninstallCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/uninstall"),
      state: reinstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => uninstallCalls.push({ status, data }),
      readJsonBody: async () => ({ appId: "reinstall-app" }),
    });
    assert.equal(uninstallCalls[0]?.status, 200);
    assert.deepEqual(uninstallCalls[0]?.data.uninstall?.removedMountIds, ["reinstall-app"]);
    assert.equal(reinstallState.settings.mountedApps.length, 0);
    assert.deepEqual(reinstallState.settings.uninstalledStoreAppIds, ["reinstall-app"]);
    assert.equal(existsSync(reinstallRoot), false, "uninstalling a Store App must remove its canonical root");
    const trashedPath = uninstallCalls[0]?.data.uninstall?.trashedPath as string;
    assert.equal(typeof trashedPath, "string");
    assert.equal(
      readFileSync(join(trashedPath, "workspace", "user-note.md"), "utf8"),
      "user data\n",
      "uninstall must move the App to the trash instead of deleting it outright",
    );

    const uninstallAgainCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/uninstall"),
      state: reinstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => uninstallAgainCalls.push({ status, data }),
      readJsonBody: async () => ({ appId: "reinstall-app" }),
    });
    assert.equal(uninstallAgainCalls[0]?.status, 404);
    assert.equal(uninstallAgainCalls[0]?.data.error, "app_store_app_not_mounted");

    const failedReinstallSentinel = join(reinstallRoot, "preexisting-container.md");
    mkdirSync(reinstallRoot, { recursive: true });
    writeFileSync(failedReinstallSentinel, "keep pre-existing container data\n", "utf8");
    const failedReinstallInstallKey = createHash("sha256").update(resolve(reinstallRoot)).digest("hex");
    const failedReinstallProgramsRoot = join(
      currentAppStoreProgramsRoot(appStoreDataRoot(reinstallState)),
      failedReinstallInstallKey,
    );
    const failedReinstallBackupRoot = join(
      dirname(reinstallRoot),
      ".opengrove-uninstalled-workspaces",
      failedReinstallInstallKey,
    );
    const programGenerationsBeforeFailedReinstall = existsSync(failedReinstallProgramsRoot)
      ? readdirSync(failedReinstallProgramsRoot).sort()
      : [];
    const failedReinstallLock = join(dirname(reinstallRoot), ".opengrove-install-locks", failedReinstallInstallKey);
    mkdirSync(dirname(failedReinstallLock), { recursive: true });
    mkdirSync(failedReinstallLock);
    const failedReinstallCalls: Array<{ status: number; data: any }> = [];
    try {
      await handleAppStoreRoute({
        request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
        response: {} as any,
        url: new URL("http://opengrove.test/app-store/install"),
        state: reinstallState,
        security: sessionSecurity,
        sendJson: (_response, status, data) => failedReinstallCalls.push({ status, data }),
        readJsonBody: async () => ({ packageId: reinstallPackage.id }),
      });
      assert.equal(failedReinstallCalls[0]?.status, 409);
      assert.equal(failedReinstallCalls[0]?.data.error, "app_store_install_target_changed");
      assert.equal(
        existsSync(failedReinstallLock),
        true,
        "a failed reinstall must not remove another installer's lock",
      );
      assert.equal(
        readFileSync(failedReinstallSentinel, "utf8"),
        "keep pre-existing container data\n",
        "a failed reinstall must preserve data that predates the install",
      );
      assert.equal(
        existsSync(join(reinstallRoot, "workspace")),
        false,
        "a failed program install must roll back the Workspace copy restored for that attempt",
      );
      assert.equal(
        readFileSync(join(failedReinstallBackupRoot, "workspace", "user-note.md"), "utf8"),
        "user data\n",
        "the preserved Workspace must remain authoritative after a failed reinstall",
      );
      assert.deepEqual(
        existsSync(failedReinstallProgramsRoot) ? readdirSync(failedReinstallProgramsRoot).sort() : [],
        programGenerationsBeforeFailedReinstall,
        "a failed reinstall must still remove its incomplete program generation",
      );
    } finally {
      rmSync(failedReinstallLock, { recursive: true, force: true });
    }

    const reinstallAfterUninstallCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/install"),
      state: reinstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => reinstallAfterUninstallCalls.push({ status, data }),
      readJsonBody: async () => ({ packageId: reinstallPackage.id }),
    });
    assert.equal(reinstallAfterUninstallCalls[0]?.status, 200);
    assert.deepEqual(reinstallState.settings.uninstalledStoreAppIds, []);
    assert.equal(
      readFileSync(join(reinstallRoot, "workspace", "user-note.md"), "utf8"),
      "user data\n",
      "reinstalling after a successful trash move must restore the user's workspace",
    );
    assert.equal(
      readFileSync(failedReinstallSentinel, "utf8"),
      "keep pre-existing container data\n",
      "a successful retry must preserve unrelated container data",
    );
    assert.equal(
      existsSync(failedReinstallBackupRoot),
      false,
      "a successful retry must finalize and remove the preserved Workspace backup",
    );
    rmSync(failedReinstallSentinel, { force: true });

    // A missing program generation must not strand the independently persisted Workspace.
    const missingProgramMount = reinstallState.settings.mountedApps.find((app) => app.id === "reinstall-app");
    assert.ok(missingProgramMount);
    rmSync(missingProgramMount.path, { recursive: true, force: true });
    const missingProgramUninstallCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/uninstall"),
      state: reinstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => missingProgramUninstallCalls.push({ status, data }),
      readJsonBody: async () => ({ appId: "reinstall-app" }),
    });
    assert.equal(missingProgramUninstallCalls[0]?.status, 200);
    assert.equal(reinstallState.settings.mountedApps.length, 0);
    const missingProgramTrashedPath = missingProgramUninstallCalls[0]?.data.uninstall?.trashedPath as string;
    assert.equal(typeof missingProgramTrashedPath, "string");
    assert.equal(
      readFileSync(join(missingProgramTrashedPath, "workspace", "user-note.md"), "utf8"),
      "user data\n",
      "uninstall must preserve Workspace data even when the program generation is already missing",
    );

    const reinstallAfterMissingProgramCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/install"),
      state: reinstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => reinstallAfterMissingProgramCalls.push({ status, data }),
      readJsonBody: async () => ({ packageId: reinstallPackage.id }),
    });
    assert.equal(reinstallAfterMissingProgramCalls[0]?.status, 200);
    assert.equal(existsSync(join(reinstallRoot, "workspace")), true);
    assert.equal(
      existsSync(join(reinstallRoot, "workspace", "user-note.md")),
      false,
      "a reinstall after uninstall starts with a fresh Workspace; the removed data remains recoverable from trash",
    );
    writeFileSync(join(reinstallRoot, "workspace", "user-note.md"), "user data\n", "utf8");

    // 损坏的 Store 凭证不能让卸载假成功：先要求确认，确认后才移入废纸篓。
    const reinstalledMount = reinstallState.settings.mountedApps.find((app) => app.id === "reinstall-app");
    assert.ok(reinstalledMount);
    writeFileSync(join(reinstalledMount.path, ".opengrove-store-package.json"), "{ broken marker", "utf8");
    const corruptMarkerUninstallCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/uninstall"),
      state: reinstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => corruptMarkerUninstallCalls.push({ status, data }),
      readJsonBody: async () => ({ appId: "reinstall-app" }),
    });
    assert.equal(corruptMarkerUninstallCalls[0]?.status, 409);
    assert.equal(corruptMarkerUninstallCalls[0]?.data.error, "app_store_cleanup_confirmation_required");
    assert.equal(reinstallState.settings.mountedApps[0]?.id, "reinstall-app");
    assert.equal(existsSync(reinstallRoot), true);

    const confirmedCorruptMarkerUninstallCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/uninstall"),
      state: reinstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => confirmedCorruptMarkerUninstallCalls.push({ status, data }),
      readJsonBody: async () => ({ appId: "reinstall-app", allowUnverifiedTrash: true }),
    });
    assert.equal(confirmedCorruptMarkerUninstallCalls[0]?.status, 200);
    assert.equal(reinstallState.settings.mountedApps.length, 0);
    assert.equal(existsSync(reinstallRoot), false);
    assert.equal(
      readFileSync(
        join(confirmedCorruptMarkerUninstallCalls[0]?.data.uninstall.trashedPath, "workspace", "user-note.md"),
        "utf8",
      ),
      "user data\n",
    );

    // 同样的损坏残留会挡住重装：用户确认后先移入废纸篓，再安装新包。
    mkdirSync(join(reinstallRoot, "workspace"), { recursive: true });
    writeFileSync(
      join(reinstallRoot, "opengrove.app.json"),
      JSON.stringify({
        id: "reinstall-app",
        ui: { surface: "file-workbench", workspace: "workspace" },
      }),
      "utf8",
    );
    writeFileSync(join(reinstallRoot, ".opengrove-store-package.json"), "{ broken marker", "utf8");
    writeFileSync(join(reinstallRoot, "workspace", "stale-note.md"), "stale data\n", "utf8");
    const blockedResidualInstallCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/install"),
      state: reinstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => blockedResidualInstallCalls.push({ status, data }),
      readJsonBody: async () => ({ packageId: reinstallPackage.id }),
    });
    assert.equal(blockedResidualInstallCalls[0]?.status, 409);
    assert.equal(blockedResidualInstallCalls[0]?.data.error, "app_store_cleanup_confirmation_required");
    assert.equal(readFileSync(join(reinstallRoot, "workspace", "stale-note.md"), "utf8"), "stale data\n");

    const confirmedResidualInstallCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/install"),
      state: reinstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => confirmedResidualInstallCalls.push({ status, data }),
      readJsonBody: async () => ({ packageId: reinstallPackage.id, cleanupUnverifiedRoot: true }),
    });
    assert.equal(confirmedResidualInstallCalls[0]?.status, 200);
    assert.equal(reinstallState.settings.mountedApps[0]?.id, "reinstall-app");
    assert.equal(existsSync(join(reinstallState.settings.mountedApps[0]!.path, "opengrove.app.json")), true);
    assert.equal(existsSync(join(reinstallRoot, "workspace", "stale-note.md")), false);

    // 移入废纸篓失败时不能假装卸载成功：挂载和原目录都必须恢复。
    const blockedTrashRoot = join(tempRoot, "blocked-trash-root");
    writeFileSync(blockedTrashRoot, "not a directory\n", "utf8");
    process.env.OPENGROVE_TRASH_DIR = blockedTrashRoot;
    const failedTrashUninstallCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/uninstall"),
      state: reinstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => failedTrashUninstallCalls.push({ status, data }),
      readJsonBody: async () => ({ appId: "reinstall-app" }),
    });
    assert.equal(failedTrashUninstallCalls[0]?.status, 500);
    assert.equal(failedTrashUninstallCalls[0]?.data.error, "app_store_uninstall_failed");
    assert.equal(reinstallState.settings.mountedApps[0]?.id, "reinstall-app");
    assert.equal(existsSync(reinstallRoot), true);
    process.env.OPENGROVE_TRASH_DIR = join(tempRoot, "harness-trash");

    // 手动挂载的目录归用户所有:卸载只解除挂载,文件必须原地保留。
    const manualUninstallRoot = join(tempRoot, "manual-uninstall-source");
    mkdirSync(join(manualUninstallRoot, "workspace"), { recursive: true });
    writeFileSync(
      join(manualUninstallRoot, "opengrove.app.json"),
      JSON.stringify({ id: "manual-uninstall-app", ui: { surface: "file-workbench", workspace: "workspace" } }),
      "utf8",
    );
    const manualUninstallState = createBridgeState({ statePath: join(tempRoot, "manual-uninstall-state.json") });
    manualUninstallState.settings.mountedApps = [
      {
        id: "manual-folder-alias",
        path: manualUninstallRoot,
        enabled: true,
      },
    ];
    const manualUninstallCalls: Array<{ status: number; data: any }> = [];
    await handleAppStoreRoute({
      request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
      response: {} as any,
      url: new URL("http://opengrove.test/app-store/uninstall"),
      state: manualUninstallState,
      security: sessionSecurity,
      sendJson: (_response, status, data) => manualUninstallCalls.push({ status, data }),
      readJsonBody: async () => ({ appId: "manual-uninstall-app" }),
    });
    assert.equal(manualUninstallCalls[0]?.status, 200);
    assert.equal(manualUninstallCalls[0]?.data.uninstall?.trashedPath, undefined);
    assert.equal(manualUninstallState.settings.mountedApps.length, 0);
    assert.equal(
      readFileSync(join(manualUninstallRoot, "opengrove.app.json"), "utf8").includes("manual-uninstall-app"),
      true,
      "uninstalling a hand-mounted App must leave its files in place",
    );

    const previousPathCheckAppsDir = process.env.OPENGROVE_APP_STORE_APPS_DIR;
    process.env.OPENGROVE_APP_STORE_APPS_DIR = join(tempRoot, "path-check-apps");
    try {
      const escapedRoot = join(tempRoot, "escaped-uninstall-target");
      mkdirSync(escapedRoot, { recursive: true });
      writeFileSync(
        join(escapedRoot, ".opengrove-store-package.json"),
        JSON.stringify({ source: "registry", appId: "escaped-uninstall-target" }),
        "utf8",
      );
      const escapedState = createBridgeState({ statePath: join(tempRoot, "escaped-uninstall-state.json") });
      escapedState.settings.mountedApps = [
        {
          id: "escaped-mounted-record",
          path: escapedRoot,
          enabled: true,
        },
      ];
      const escapedCalls: Array<{ status: number; data: any }> = [];
      await handleAppStoreRoute({
        request: { method: "POST", headers: { cookie: "sample_cloud_session=harness" } } as any,
        response: {} as any,
        url: new URL("http://opengrove.test/app-store/uninstall"),
        state: escapedState,
        security: sessionSecurity,
        sendJson: (_response, status, data) => escapedCalls.push({ status, data }),
        readJsonBody: async () => ({ appId: "../escaped-uninstall-target" }),
      });
      assert.equal(escapedCalls[0]?.status, 400);
      assert.equal(escapedCalls[0]?.data.error, "app_store_app_id_invalid");
      assert.equal(escapedState.settings.mountedApps.length, 1);
      assert.equal(existsSync(escapedRoot), true, "an uninstall appId must not escape the managed Apps root");
    } finally {
      restoreEnv("OPENGROVE_APP_STORE_APPS_DIR", previousPathCheckAppsDir);
    }
  } finally {
    if (previousTrashDir === undefined) {
      delete process.env.OPENGROVE_TRASH_DIR;
    } else {
      process.env.OPENGROVE_TRASH_DIR = previousTrashDir;
    }
  }

  assert.ok(registryClientReleaseHeaders.length > 0, "the harness must make App Store Registry requests");
  assert.equal(
    registryClientReleaseHeaders.every((value) => value === String(currentHostReleaseNumber)),
    true,
    `every App Store Registry request must carry Host release ${currentHostReleaseNumber}: ${registryClientReleaseHeaders.join(",")}`,
  );
  console.log("app-store-harness ok");
} finally {
  await new Promise<void>((resolve, reject) => {
    fakeCloud.close((error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    fakeOss.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousRegistryUrl === undefined) {
    delete process.env.OPENGROVE_APP_STORE_REGISTRY_URL;
  } else {
    process.env.OPENGROVE_APP_STORE_REGISTRY_URL = previousRegistryUrl;
  }
  if (previousRegistryToken === undefined) {
    delete process.env.OPENGROVE_APP_STORE_REGISTRY_TOKEN;
  } else {
    process.env.OPENGROVE_APP_STORE_REGISTRY_TOKEN = previousRegistryToken;
  }
  if (previousReleaseControlUrl === undefined) {
    delete process.env.OPENGROVE_RELEASE_CONTROL_URL;
  } else {
    process.env.OPENGROVE_RELEASE_CONTROL_URL = previousReleaseControlUrl;
  }
  restoreEnv("OPENGROVE_WW_BASE_URL", previousWwBaseUrl);
  restoreEnv("OPENGROVE_APP_STORE_APPS_DIR", previousAppsDir);
  restoreEnv("OPENGROVE_PROGRAMS_DIR", previousProgramsDir);
  restoreEnv("OPENGROVE_WORKSPACES_DIR", previousWorkspacesDir);
  restoreEnv("OPENGROVE_LEGACY_APPS_DIR", previousLegacyAppsDir);
  removeHarnessTree(escapedRegistryInstallRoot);
  removeHarnessTree(tempRoot);
}

function removeHarnessTree(path: string): void {
  if (process.platform === "darwin" && existsSync(path)) {
    execFileSync("chflags", ["-R", "nouchg", path]);
  }
  try {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 20 : 3,
      retryDelay: 250,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM")) return;
    throw error;
  }
}

async function withRegistryEnvCleared(run: () => Promise<void>): Promise<void> {
  const saved = {
    longUrl: process.env.OPENGROVE_APP_STORE_REGISTRY_URL,
    longToken: process.env.OPENGROVE_APP_STORE_REGISTRY_TOKEN,
    shortUrl: process.env.APP_STORE_REGISTRY_URL,
    shortToken: process.env.APP_STORE_REGISTRY_TOKEN,
  };
  delete process.env.OPENGROVE_APP_STORE_REGISTRY_URL;
  delete process.env.OPENGROVE_APP_STORE_REGISTRY_TOKEN;
  delete process.env.APP_STORE_REGISTRY_URL;
  delete process.env.APP_STORE_REGISTRY_TOKEN;
  try {
    await run();
  } finally {
    restoreEnv("OPENGROVE_APP_STORE_REGISTRY_URL", saved.longUrl);
    restoreEnv("OPENGROVE_APP_STORE_REGISTRY_TOKEN", saved.longToken);
    restoreEnv("APP_STORE_REGISTRY_URL", saved.shortUrl);
    restoreEnv("APP_STORE_REGISTRY_TOKEN", saved.shortToken);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function waitForHarness(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function findCloudStorePackage(packageId: string): { pkg: AppStorePackageRecord; bytes: Buffer } | undefined {
  return (
    cloudStorePackages.get(packageId) ||
    [...cloudStorePackages.values()].find(
      (entry) => entry.pkg.packageKey === packageId || entry.pkg.packageId === packageId,
    )
  );
}

async function withAppStoreAppsDirCleared(run: () => Promise<void>): Promise<void> {
  const saved = process.env.OPENGROVE_APP_STORE_APPS_DIR;
  delete process.env.OPENGROVE_APP_STORE_APPS_DIR;
  try {
    await run();
  } finally {
    restoreEnv("OPENGROVE_APP_STORE_APPS_DIR", saved);
  }
}

async function handleFakeCloudRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/v1/app-store/")) {
    registryClientReleaseHeaders.push(
      typeof request.headers["x-opengrove-client-release"] === "string"
        ? request.headers["x-opengrove-client-release"]
        : undefined,
    );
  }
  if (request.method === "GET" && url.pathname === "/v1/auth/session") {
    sendTestJson(response, 200, {
      user: {
        userId: "user_harness",
        email: "harness@example.com",
        displayName: "Harness User",
        role: "user",
      },
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/users/me") {
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token !== "admin_harness" && token !== "secondary_admin_harness" && token !== "user_harness") {
      sendTestJson(response, 401, { error: { code: 110201, message: "access invalid" } });
      return;
    }
    sendTestJson(response, 200, {
      data: {
        user_id: token,
        email: `${token}@example.com`,
        display_name: token.includes("admin") ? "Harness Admin" : "Harness User",
        role: token === "admin_harness" ? "admin" : "user",
        roles: token.includes("admin") ? ["user", "admin"] : ["user"],
      },
      request_id: "req-users-me",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/app-store/install-policy") {
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    defaultPolicyRequestCounts.set(token, (defaultPolicyRequestCounts.get(token) ?? 0) + 1);
    if (token === "no_policy_endpoint_harness") {
      sendTestJson(response, 404, { error: "route_not_found" });
      return;
    }
    if (token === "no_policy_body_harness") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (token === "transient_policy_harness" && defaultPolicyRequestCounts.get(token) === 1) {
      sendTestJson(response, 503, { error: "temporarily_unavailable" });
      return;
    }
    if (token === "slow_user_harness") {
      markDelayedDefaultPolicyRequestStarted();
      await delayedDefaultPolicyRequestRelease;
    }
    const storySeed = findCloudStorePackage("opengrove.story-seed")?.pkg;
    if (token === "missing_default_harness") {
      sendTestJson(response, 200, {
        policyKey: "standard",
        assignmentSource: "admin",
        apps: [
          ...(storySeed
            ? [
                {
                  packageKey: storySeed.packageKey,
                  minimumVersion: "",
                  latestVersion: storySeed.version,
                  minHostReleaseNumber: storySeed.minHostReleaseNumber ?? 0,
                },
              ]
            : []),
          {
            packageKey: "harness.missing-default-app",
            minimumVersion: "",
            latestVersion: "1.0.0",
            minHostReleaseNumber: 0,
          },
        ],
      });
      return;
    }
    if (token === "minimum_unavailable_harness") {
      sendTestJson(response, 200, {
        policyKey: "standard",
        assignmentSource: "admin",
        apps: storySeed
          ? [
              {
                packageKey: storySeed.packageKey,
                minimumVersion: "999.0.0",
                latestVersion: storySeed.version,
                minHostReleaseNumber: storySeed.minHostReleaseNumber ?? 0,
              },
            ]
          : [],
      });
      return;
    }
    if (token === "invalid_policy_harness") {
      sendTestJson(response, 200, {
        policyKey: "standard",
        assignmentSource: "default",
        apps: "not-an-array",
      });
      return;
    }
    if (token === "invalid_policy_array_harness") {
      sendTestJson(response, 200, []);
      return;
    }
    if (token === "invalid_policy_string_harness") {
      sendTestJson(response, 200, "nope");
      return;
    }
    if (token === "invalid_policy_number_harness") {
      sendTestJson(response, 200, 42);
      return;
    }
    if (token === "mixed_policy_harness") {
      sendTestJson(response, 200, {
        policyKey: "standard",
        assignmentSource: "migration",
        apps: [
          ...(storySeed
            ? [
                {
                  packageKey: storySeed.packageKey,
                  minimumVersion: "",
                  minHostReleaseNumber: storySeed.minHostReleaseNumber ?? 0,
                },
              ]
            : []),
          { packageKey: "../invalid", minimumVersion: "" },
          ...(storySeed ? [{ packageKey: storySeed.packageKey, minimumVersion: "" }] : []),
          { packageKey: "invalid-minimum-version", minimumVersion: "v".repeat(65) },
        ],
      });
      return;
    }
    if (token === "all_invalid_policy_harness") {
      sendTestJson(response, 200, {
        policyKey: "broken-migration",
        assignmentSource: "migration",
        apps: [
          { packageKey: "../invalid", minimumVersion: "" },
          { packageKey: "invalid-minimum-version", minimumVersion: "v".repeat(65) },
        ],
      });
      return;
    }
    if (token === "relaxed_policy_harness") {
      sendTestJson(response, 200, {
        policyKey: "Standard Policy 2026",
        assignmentSource: "Admin Migration",
        apps: storySeed
          ? [
              {
                packageKey: storySeed.packageKey,
                minimumVersion: "",
                minHostReleaseNumber: storySeed.minHostReleaseNumber ?? 0,
              },
            ]
          : [],
      });
      return;
    }
    sendTestJson(response, 200, {
      policyKey: token === "slow_user_harness" || token === "vega_reviewer_harness" ? "vega_reviewer" : "standard",
      assignmentSource: token === "vega_reviewer_harness" ? "invite_source" : "migration",
      apps:
        token === "slow_user_harness" || token === "vega_reviewer_harness"
          ? []
          : storySeed
            ? [
                {
                  packageKey: storySeed.packageKey,
                  minimumVersion: "",
                  latestVersion: storySeed.version,
                  minHostReleaseNumber: storySeed.minHostReleaseNumber ?? 0,
                },
              ]
            : [],
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/app-store/packages") {
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    registryCatalogRequestCounts.set(token, (registryCatalogRequestCounts.get(token) ?? 0) + 1);
    if (token === "slow_catalog_harness") {
      await delayedCatalogRequestRelease;
      if (response.destroyed) return;
    }
    sendTestJson(response, 200, {
      packages: [...cloudStorePackages.values()].map((entry) => registryCatalogPackage(entry.pkg, request)),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/app-store/packages") {
    lastPublishAuthorization = request.headers.authorization;
    lastPublishIdempotencyKey = String(request.headers["idempotency-key"] || "") || undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (request.headers.authorization !== "Bearer reg_harness") {
      sendTestJson(response, 401, { ok: false, error: "store_token_invalid" });
      return;
    }
    if (!publishedPackageTemplate) {
      sendTestJson(response, 500, { ok: false, error: "publish_template_not_seeded" });
      return;
    }
    const replayedPackage = lastPublishIdempotencyKey
      ? publishIdempotencyResponses.get(lastPublishIdempotencyKey)
      : undefined;
    if (replayedPackage) {
      sendTestJson(response, 201, { package: replayedPackage });
      return;
    }
    const pkg: AppStorePackageRecord = {
      ...publishedPackageTemplate,
      archiveSize: bytes.byteLength,
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    };
    if (cloudStorePackages.has(pkg.id) || (pkg.packageKey && cloudStorePackages.has(pkg.packageKey))) {
      sendTestJson(response, 409, { ok: false, error: "app_store_package_exists" });
      return;
    }
    cloudStorePackages.set(pkg.id, { pkg, bytes });
    if (lastPublishIdempotencyKey) publishIdempotencyResponses.set(lastPublishIdempotencyKey, pkg);
    sendTestJson(response, 201, { package: pkg });
    return;
  }
  const appStoreVersionMatch = url.pathname.match(/^\/v1\/app-store\/packages\/([^/]+)\/versions$/);
  if (request.method === "POST" && appStoreVersionMatch) {
    lastPublishAuthorization = request.headers.authorization;
    lastPublishIdempotencyKey = String(request.headers["idempotency-key"] || "") || undefined;
    const packageKey = decodeURIComponent(appStoreVersionMatch[1] || "");
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (request.headers.authorization !== "Bearer reg_harness") {
      sendTestJson(response, 401, { ok: false, error: "store_token_invalid" });
      return;
    }
    if (!publishedPackageTemplate) {
      sendTestJson(response, 500, { ok: false, error: "publish_template_not_seeded" });
      return;
    }
    const replayedPackage = lastPublishIdempotencyKey
      ? publishIdempotencyResponses.get(lastPublishIdempotencyKey)
      : undefined;
    if (replayedPackage) {
      sendTestJson(response, 201, { package: replayedPackage });
      return;
    }
    const existing =
      cloudStorePackages.get(packageKey) ||
      [...cloudStorePackages.values()].find((entry) => entry.pkg.packageKey === packageKey);
    if (!existing) {
      sendTestJson(response, 404, { ok: false, error: "app_store_package_not_found" });
      return;
    }
    const pkg: AppStorePackageRecord = {
      ...publishedPackageTemplate,
      id: existing.pkg.id,
      packageKey,
      archiveSize: bytes.byteLength,
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    };
    cloudStorePackages.set(pkg.id, { pkg, bytes });
    if (lastPublishIdempotencyKey) publishIdempotencyResponses.set(lastPublishIdempotencyKey, pkg);
    sendTestJson(response, 201, { package: pkg });
    return;
  }
  const appStoreVersionDetailMatch = url.pathname.match(/^\/v1\/app-store\/packages\/([^/]+)\/versions\/([^/]+)$/);
  if (request.method === "GET" && appStoreVersionDetailMatch) {
    const packageKey = decodeURIComponent(appStoreVersionDetailMatch[1] || "");
    const version = decodeURIComponent(appStoreVersionDetailMatch[2] || "");
    const entry = findCloudStorePackage(packageKey);
    if (!entry || entry.pkg.version !== version) {
      sendTestJson(response, 404, { ok: false, error: "app_store_package_not_found" });
      return;
    }
    sendTestJson(response, 200, {
      version: {
        packageKey: entry.pkg.packageKey,
        packageId: entry.pkg.packageId || entry.pkg.id,
        appId: entry.pkg.appId,
        title: entry.pkg.title,
        version: entry.pkg.version,
        publishedBy: entry.pkg.publisher,
        publishedAt: entry.pkg.uploadedAt || "2026-08-01T00:00:00Z",
        releaseCommitSha: entry.pkg.releaseCommitSha ?? null,
        releaseNotes: entry.pkg.summary,
        artifactSource: entry.pkg.releaseCommitSha ? "github-release" : "registry",
        archiveName: entry.pkg.archiveName,
        archiveSize: entry.pkg.archiveSize,
        archiveSha256: entry.pkg.archiveSha256,
        minHostReleaseNumber: entry.pkg.minHostReleaseNumber ?? 0,
        availability: "available",
        downloadReference: `/v1/app-store/packages/${encodeURIComponent(packageKey)}/versions/${encodeURIComponent(version)}/download`,
      },
    });
    return;
  }
  const appStorePackageMatch = url.pathname.match(/^\/v1\/app-store\/packages\/([^/]+)$/);
  if (request.method === "GET" && appStorePackageMatch) {
    const packageId = decodeURIComponent(appStorePackageMatch[1] || "");
    const entry = findCloudStorePackage(packageId);
    if (!entry) {
      sendTestJson(response, 404, { ok: false, error: "app_store_package_not_found" });
      return;
    }
    if (registryPackageRequiresHostUpdate(entry.pkg, request)) {
      sendTestJson(response, 409, { ok: false, error: "app_store_host_update_required" });
      return;
    }
    sendTestJson(response, 200, { package: entry.pkg });
    return;
  }
  const appStoreDownloadUrlMatch = url.pathname.match(/^\/v1\/app-store\/packages\/([^/]+)\/download-url$/);
  if (request.method === "GET" && appStoreDownloadUrlMatch) {
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token === "failed_install_policy_harness") {
      failedPolicyDownloadRequestCounts.set(token, (failedPolicyDownloadRequestCounts.get(token) ?? 0) + 1);
      sendTestJson(response, 503, { error: "archive_temporarily_unavailable" });
      return;
    }
    const packageId = decodeURIComponent(appStoreDownloadUrlMatch[1] || "");
    const entry = findCloudStorePackage(packageId);
    if (!entry) {
      sendTestJson(response, 404, { ok: false, error: "app_store_archive_not_found" });
      return;
    }
    if (registryPackageRequiresHostUpdate(entry.pkg, request)) {
      sendTestJson(response, 409, { ok: false, error: "app_store_host_update_required" });
      return;
    }
    sendTestJson(response, 200, {
      url: `${fakeOssUrl}/signed-download/${encodeURIComponent(packageId)}?signature=test`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      archiveSha256: entry.pkg.archiveSha256,
      archiveSize: entry.bytes.byteLength,
      fileName: entry.pkg.archiveName,
    });
    return;
  }
  const appStoreDownloadMatch = url.pathname.match(/^\/v1\/app-store\/downloads\/([^/]+)$/);
  if (request.method === "GET" && appStoreDownloadMatch) {
    const packageId = decodeURIComponent(appStoreDownloadMatch[1] || "");
    const entry = findCloudStorePackage(packageId);
    if (!entry) {
      sendTestJson(response, 404, { ok: false, error: "app_store_archive_not_found" });
      return;
    }
    sendTestBytes(response, 200, entry.bytes, "application/gzip");
    return;
  }
  sendTestJson(response, 404, { ok: false, error: "not_found" });
}

function registryCatalogPackage(pkg: AppStorePackageRecord, request: IncomingMessage): AppStorePackageRecord {
  if (!registryPackageRequiresHostUpdate(pkg, request)) return pkg;
  const notice = { ...pkg };
  delete notice.archiveName;
  delete notice.archiveSize;
  delete notice.archiveSha256;
  return notice;
}

function registryPackageRequiresHostUpdate(pkg: AppStorePackageRecord, request: IncomingMessage): boolean {
  const rawReleaseNumber = request.headers["x-opengrove-client-release"];
  const clientReleaseNumber = typeof rawReleaseNumber === "string" ? Number(rawReleaseNumber) : 0;
  return (
    typeof pkg.minHostReleaseNumber === "number" &&
    pkg.minHostReleaseNumber > 0 &&
    clientReleaseNumber < pkg.minHostReleaseNumber
  );
}

// This long harness can pause beyond Node's default keep-alive window. Make
// fixture responses single-use so a later request never races a stale socket.
function sendTestJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    connection: "close",
  });
  response.end(JSON.stringify(data));
}

function adminRequest(method: string, token = "admin_harness"): { method: string; headers: Record<string, string> } {
  return {
    method,
    headers: {
      cookie: `opengrove_auth_access=${token}; opengrove_auth_refresh=refresh_harness; opengrove_auth_session=${token}`,
    },
  };
}

function sendTestBytes(response: ServerResponse, status: number, data: Buffer, contentType: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(data.byteLength),
    connection: "close",
  });
  response.end(data);
}
