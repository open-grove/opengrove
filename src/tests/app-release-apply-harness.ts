import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvName } from "../identity.js";
import {
  AppReleaseCoordinator,
  type AppReleaseRegistryAccess,
  type AppReleaseRemoteAccess,
} from "../server/app-release-coordinator.js";
import {
  ReleaseControlClientError,
  releaseControlStartMetadata,
  type ReleaseControlIntent,
} from "../server/app-release-client.js";
import type { AppReleaseJournalRecord } from "../server/app-release-journal.js";
import type { AppStoreFormalVersion } from "../server/app-store-registry.js";
import {
  appStoreDataRoot,
  importAppStorePackage,
  packAppStoreArchive,
  readAppStorePackageInstallMarker,
  type AppStorePackageRecord,
} from "../server/app-store.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import { MountedAppVersionStateStore } from "../server/app-version-state.js";
import { localAppDraftStore, saveMountedAppDraft } from "../server/mounted-app-draft-service.js";
import { resolveMountedAppTarget } from "../server/mounted-apps.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-app-release-apply-"));
const appsRoot = join(root, "apps");
const appRoot = join(appsRoot, "apply-app");
const formalRoot = join(root, "formal");
const previousUserData = process.env[appEnvName("USER_DATA_DIR")];
const previousAppsRoot = process.env[appEnvName("APP_STORE_APPS_DIR")];

try {
  process.env[appEnvName("USER_DATA_DIR")] = join(root, "user-data");
  process.env[appEnvName("APP_STORE_APPS_DIR")] = appsRoot;
  writeApp(appRoot, {
    version: "0.0.0",
    title: "Apply App",
    program: "local source before publish",
    contextTokenBudget: 100_000,
    packageKey: undefined,
  });
  writeFileSync(join(appRoot, "workspace", "keep.md"), "workspace survives apply\n", "utf8");
  const originalWorkspaceStat = statSync(join(appRoot, "workspace"));

  const state = createBridgeState({ statePath: join(root, "state.json") });
  state.settings.mountedApps = [
    {
      id: "apply-app",
      path: appRoot,
      enabled: true,
      title: "Apply App",
    },
  ];
  recreateBridgeApp(state);
  const target = resolveMountedAppTarget(state, "apply-app");
  assert.ok(target);

  writeApp(formalRoot, {
    version: "0.1.0",
    title: "Applied Formal App",
    program: "exact CI-built formal program",
    contextTokenBudget: 200_000,
    packageKey: "opengrove.apply-app",
  });
  const formalArchive = packAppStoreArchive({ appRoot: formalRoot });
  const releaseCommitSha = "c".repeat(40);
  const catalogPackage = catalogFixture({
    archiveSha256: formalArchive.archiveSha256,
    archiveSize: formalArchive.archiveSize,
    releaseCommitSha,
  });
  const formalVersion: AppStoreFormalVersion = {
    packageKey: "opengrove.apply-app",
    packageId: "apply-app",
    appId: "apply-app",
    title: "Applied Formal App",
    version: "0.1.0",
    publishedBy: "Admin",
    publishedAt: "2026-07-30T00:00:00Z",
    releaseCommitSha,
    releaseNotes: "Apply exact formal package",
    artifactSource: "github-release",
    archiveName: formalArchive.fileName,
    archiveSize: formalArchive.archiveSize,
    archiveSha256: formalArchive.archiveSha256,
    minHostReleaseNumber: 0,
    availability: "available",
    downloadReference: "/v1/app-store/packages/opengrove.apply-app/versions/0.1.0/archive",
  };
  let registryReady = false;
  const registry: AppReleaseRegistryAccess = {
    listVersions: async () => (registryReady ? [structuredClone(formalVersion)] : []),
    importVersion: async () =>
      importAppStorePackage({
        state,
        package: catalogPackage,
        archiveBytes: formalArchive.bytes,
      }),
  };
  const client: AppReleaseRemoteAccess = {
    findByIdempotencyKey: async () => {
      throw new ReleaseControlClientError(404, "app_release_not_found");
    },
    findById: async () => {
      throw new Error("unexpected remote lookup by id");
    },
    start: async (record, sourceSnapshot) => {
      assert.equal(sourceSnapshot.byteLength, record.sourceSnapshot.size);
      registryReady = true;
      return publishedIntent(record, {
        archiveSha256: formalArchive.archiveSha256,
        archiveSize: formalArchive.archiveSize,
        releaseCommitSha,
      });
    },
    retryCandidate: async () => {
      throw new Error("unexpected candidate retry");
    },
    retryBuild: async () => {
      throw new Error("unexpected build retry");
    },
    abandon: async () => {
      throw new Error("unexpected release abandon");
    },
    finalize: async () => {
      throw new Error("unexpected finalize");
    },
  };
  const draftStore = localAppDraftStore(state);
  const deleteDraftIfUnchanged = draftStore.deleteIfContentUnchanged.bind(draftStore);
  let injectDraftDeleteFailure = true;
  let newerDraftDigest = "";
  draftStore.deleteIfContentUnchanged = (input) => {
    if (injectDraftDeleteFailure) {
      injectDraftDeleteFailure = false;
      const activeTarget = resolveMountedAppTarget(state, "apply-app");
      assert.ok(activeTarget);
      newerDraftDigest = saveMountedAppDraft({
        state,
        target: activeTarget,
        submission: {
          app: {
            title: "Newer draft saved after formal activation",
            description: "Must survive idempotent release finalization",
            icon: "",
          },
          employees: [employeeDefaults(200_000)],
        },
        store: draftStore,
      }).contentDigest;
      throw new Error("injected_draft_delete_failure");
    }
    return deleteDraftIfUnchanged(input);
  };
  const coordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    client,
    draftStore,
  });
  await assert.rejects(
    () =>
      coordinator.start({
        release: {
          app: {
            title: "Applied Formal App",
            description: "Published and applied",
            icon: "",
          },
          version: "0.1.0",
          releaseNotes: "Apply exact formal package",
          visibility: "restricted",
          employees: [employeeDefaults(200_000)],
        },
        applyToCurrentApp: true,
      }),
    /injected_draft_delete_failure/,
    "a local bookkeeping failure may happen after exact formal activation",
  );
  assert.equal(coordinator.readProgress()?.phase, "registry_ready");
  const result = await coordinator.resume();

  assert.equal(result.state, "published");
  assert.equal(result.phase, "local_finalized");
  assert.equal(
    draftStore.read(target.localAppId)?.contentDigest,
    newerDraftDigest,
    "idempotent finalization must preserve a newer draft saved after activation",
  );
  const appliedTarget = resolveMountedAppTarget(state, "apply-app");
  assert.ok(appliedTarget);
  assert.notEqual(appliedTarget.appRoot, appRoot, "formal activation must switch the mounted program pointer");
  assert.equal(appliedTarget.workspaceRoot, join(appRoot, "workspace"));
  assert.equal(readFileSync(join(appliedTarget.appRoot, "program.txt"), "utf8"), "exact CI-built formal program\n");
  assert.equal(readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"), "workspace survives apply\n");
  const currentWorkspaceStat = statSync(join(appRoot, "workspace"));
  assert.equal(currentWorkspaceStat.dev, originalWorkspaceStat.dev);
  assert.equal(
    currentWorkspaceStat.ino,
    originalWorkspaceStat.ino,
    "formal activation must not replace the Workspace directory",
  );
  const marker = readAppStorePackageInstallMarker(appliedTarget.appRoot);
  assert.equal(marker?.version, "0.1.0");
  assert.equal(marker?.archiveSha256, formalArchive.archiveSha256);
  const versionState = new MountedAppVersionStateStore(join(appStoreDataRoot(state), "version-state")).read(
    target.localAppId,
  );
  assert.equal(versionState?.activeContent, "formal");
  assert.deepEqual(versionState?.selectedVersion, {
    packageKey: "opengrove.apply-app",
    version: "0.1.0",
    releaseCommitSha,
    archiveSha256: formalArchive.archiveSha256,
  });
  assert.equal(
    state.app.rooms.listMembers().find((member) => member.id === "member-app-apply-app-writer")?.contextTokenBudget,
    200_000,
    "formal activation must adopt the complete employee defaults from the exact package",
  );

  process.stdout.write("app release apply harness passed\n");
} finally {
  if (previousUserData === undefined) delete process.env[appEnvName("USER_DATA_DIR")];
  else process.env[appEnvName("USER_DATA_DIR")] = previousUserData;
  if (previousAppsRoot === undefined) delete process.env[appEnvName("APP_STORE_APPS_DIR")];
  else process.env[appEnvName("APP_STORE_APPS_DIR")] = previousAppsRoot;
  rmSync(root, { recursive: true, force: true });
}

function writeApp(
  rootPath: string,
  input: {
    version: string;
    title: string;
    program: string;
    contextTokenBudget: number;
    packageKey: string | undefined;
  },
): void {
  mkdirSync(join(rootPath, "workspace"), { recursive: true });
  writeFileSync(
    join(rootPath, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "apply-app",
        title: input.title,
        description: "",
        version: input.version,
        ui: { surface: "none", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: {
          ...(input.packageKey ? { packageKey: input.packageKey } : {}),
          employeeDefaults: [employeeDefaults(input.contextTokenBudget)],
        },
        employees: [
          {
            id: "writer",
            name: "Writer",
            role: "Writes.",
            kernel: "claude-code",
            model: "deepseek-v4-pro",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(rootPath, "program.txt"), `${input.program}\n`, "utf8");
  mkdirSync(join(rootPath, "web"), { recursive: true });
  mkdirSync(join(rootPath, "ui"), { recursive: true });
  writeFileSync(join(rootPath, "web", "program.txt"), `${input.program}\n`, "utf8");
  writeFileSync(join(rootPath, "ui", "program.txt"), `${input.program}\n`, "utf8");
  writeFileSync(
    join(rootPath, "build.mjs"),
    [
      'import { cpSync, mkdirSync, rmSync } from "node:fs";',
      'rmSync("ui", { recursive: true, force: true });',
      'mkdirSync("ui", { recursive: true });',
      'cpSync("web", "ui", { recursive: true });',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(rootPath, ".opengrove-build.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        workingDirectory: ".",
        inputs: ["web", "build.mjs"],
        outputs: ["ui"],
        commands: [["node", "build.mjs"]],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function employeeDefaults(contextTokenBudget: number) {
  return {
    memberId: "member-app-apply-app-writer",
    name: "Writer",
    role: "Writes.",
    kernel: "claude-code",
    model: "deepseek-v4-pro",
    reasoningEffort: "high" as const,
    contextTokenBudget,
    accessMode: "full-access" as const,
    color: "#148a47",
    availableSkillIds: [],
    defaultSkillIds: [],
    visibility: "private" as const,
    publicSkills: [],
  };
}

function catalogFixture(input: {
  archiveSha256: string;
  archiveSize: number;
  releaseCommitSha: string;
}): AppStorePackageRecord {
  return {
    id: "apply-app",
    packageId: "apply-app",
    packageKey: "opengrove.apply-app",
    title: "Applied Formal App",
    summary: "",
    version: "0.1.0",
    category: "app",
    publishKind: "app",
    installMode: "workspace",
    appId: "apply-app",
    workspaceName: "workspace",
    requirements: [],
    capabilities: [],
    backupScopes: [],
    status: "available",
    visibility: "restricted",
    publisher: "Admin",
    usageCount: 0,
    source: "registry",
    archiveName: "apply-app-0.1.0.tgz",
    archiveSize: input.archiveSize,
    archiveSha256: input.archiveSha256,
    releaseCommitSha: input.releaseCommitSha,
  };
}

function publishedIntent(
  record: AppReleaseJournalRecord,
  input: {
    archiveSha256: string;
    archiveSize: number;
    releaseCommitSha: string;
  },
): ReleaseControlIntent {
  const metadata = releaseControlStartMetadata(record);
  return {
    id: "apply-intent",
    status: "published",
    allowedActions: [],
    ...metadata,
    candidateSha: input.releaseCommitSha,
    gatedArchiveName: "apply-app-0.1.0.tgz",
    gatedArchiveSize: input.archiveSize,
    gatedArchiveSha256: input.archiveSha256,
    publishedByUserId: 1,
    createdAt: "2026-07-30T00:00:00Z",
    publishedAt: "2026-07-30T00:01:00Z",
  };
}
