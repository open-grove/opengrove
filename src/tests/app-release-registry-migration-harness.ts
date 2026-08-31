import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvName } from "../identity.js";
import {
  AppReleaseCoordinator,
  AppReleaseCoordinatorError,
  type AppReleaseRegistryAccess,
  type AppReleaseRemoteAccess,
} from "../server/app-release-coordinator.js";
import {
  ReleaseControlClientError,
  releaseControlStartMetadata,
  type ReleaseControlIntent,
  type ReleaseControlStartMetadata,
} from "../server/app-release-client.js";
import type { AppReleaseJournalRecord } from "../server/app-release-journal.js";
import type { AppStoreFormalVersion } from "../server/app-store-registry.js";
import { appStoreDataRoot } from "../server/app-store.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import { localAppDraftStore } from "../server/mounted-app-draft-service.js";
import { resolveMountedAppTarget } from "../server/mounted-apps.js";
import { MountedAppVersionStateStore } from "../server/app-version-state.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-registry-migration-"));
const appRoot = join(root, "apps", "legacy-app");
const previousUserData = process.env[appEnvName("USER_DATA_DIR")];
const archiveSha256 = "b".repeat(64);

try {
  process.env[appEnvName("USER_DATA_DIR")] = join(root, "user-data");
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "legacy-app",
        title: "Legacy App",
        description: "Installed from the Registry before Git-backed releases existed.",
        ui: { surface: "none", workspace: "workspace" },
        workspace: { path: "workspace" },
        employees: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(appRoot, "program.txt"), "locally edited legacy source\n", "utf8");
  mkdirSync(join(appRoot, "web"), { recursive: true });
  mkdirSync(join(appRoot, "ui"), { recursive: true });
  writeFileSync(join(appRoot, "web", "index.html"), "legacy source\n", "utf8");
  writeFileSync(join(appRoot, "ui", "index.html"), "legacy source\n", "utf8");
  writeFileSync(join(appRoot, "build.mjs"), deterministicBuildScript(), "utf8");
  writeFileSync(
    join(appRoot, ".opengrove-build.json"),
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
  writeFileSync(join(appRoot, "workspace", "keep.md"), "business data\n", "utf8");

  const state = createBridgeState({ statePath: join(root, "state.json") });
  state.settings.mountedApps = [
    {
      id: "legacy-app-mount",
      path: appRoot,
      enabled: true,
      title: "Legacy App",
    },
  ];
  recreateBridgeApp(state);
  const target = resolveMountedAppTarget(state, "legacy-app");
  assert.ok(target);
  new MountedAppVersionStateStore(join(appStoreDataRoot(state), "version-state")).write({
    localAppId: target.localAppId,
    activeContent: "formal",
    selectedVersion: {
      packageKey: "opengrove.legacy-app",
      version: "1.2.3",
      archiveSha256,
    },
  });

  let authoritativeArchiveSha256 = archiveSha256;
  let authoritativeAppId = "legacy-app";
  let formalVersions = [legacyFormalVersion(authoritativeArchiveSha256, authoritativeAppId)];
  const registry: AppReleaseRegistryAccess = {
    listVersions: async () => formalVersions,
    importVersion: async () => {
      throw new Error("apply=false must not replace the mounted App");
    },
  };
  const remote = remoteFixture((input, commitSha, publishedArchiveSha256, archiveSize) => {
    formalVersions = [
      gitFormalVersion(input.version, commitSha, publishedArchiveSha256, archiveSize),
      ...formalVersions,
    ];
  });
  const draftStore = localAppDraftStore(state);
  const coordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: remote.client,
  });

  const release = {
    app: {
      title: "Legacy App",
      description: "First Git-backed version built from the exact Registry latest.",
      icon: "",
    },
    version: "1.2.4",
    releaseNotes: "Migrate the existing Registry lineage to trusted Git releases.",
    visibility: "restricted" as const,
    employees: [],
  };
  authoritativeArchiveSha256 = "9".repeat(64);
  formalVersions = [legacyFormalVersion(authoritativeArchiveSha256, authoritativeAppId)];
  await assert.rejects(
    () => coordinator.start({ release, applyToCurrentApp: false }),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError &&
      error.message === "app_store_publish_base_stale" &&
      error.status === 409,
  );
  assert.equal(remote.createBodies.length, 0);
  authoritativeArchiveSha256 = archiveSha256;
  authoritativeAppId = "another-app";
  formalVersions = [legacyFormalVersion(authoritativeArchiveSha256, authoritativeAppId)];
  await assert.rejects(
    () => coordinator.start({ release, applyToCurrentApp: false }),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError &&
      error.message === "app_store_publish_identity_mismatch" &&
      error.status === 409,
  );
  assert.equal(remote.createBodies.length, 0);
  authoritativeAppId = "legacy-app";
  formalVersions = [legacyFormalVersion(authoritativeArchiveSha256, authoritativeAppId)];

  const progress = await coordinator.start({
    release,
    applyToCurrentApp: false,
  });

  assert.equal(progress.state, "published");
  assert.equal(progress.phase, "local_finalized");
  assert.equal(remote.createBodies.length, 1);
  assert.equal(remote.createBodies[0]?.expectedMainSha, null);
  assert.deepEqual(remote.createBodies[0]?.publishBase, {
    releaseCommitSha: "",
    version: "1.2.3",
    archiveSha256,
  });
  assert.deepEqual(draftStore.read(target.localAppId)?.publishBase, {
    packageKey: "opengrove.legacy-app",
    version: "1.2.4",
    releaseCommitSha: "c".repeat(40),
    archiveSha256: "d".repeat(64),
  });
  assert.equal(formalVersions[0]?.version, "1.2.4");
  assert.equal(formalVersions[0]?.releaseCommitSha, "c".repeat(40));
  assert.equal(formalVersions[0]?.archiveSha256, "d".repeat(64));

  const next = await coordinator.start({
    release: { ...release, version: "1.2.5" },
    applyToCurrentApp: false,
  });
  assert.equal(next.state, "published");
  assert.deepEqual(remote.createBodies[1]?.publishBase, {
    version: "1.2.4",
    releaseCommitSha: "c".repeat(40),
    archiveSha256: "d".repeat(64),
  });
  assert.equal(remote.createBodies[1]?.expectedMainSha, "c".repeat(40));

  // A Store update made by an older Host could preserve the exact formal
  // version/archive while dropping its Git release identity. The current
  // Registry record is sufficient to restore that identity without asking the
  // user to reinstall an already-current App.
  new MountedAppVersionStateStore(join(appStoreDataRoot(state), "version-state")).write({
    localAppId: target.localAppId,
    activeContent: "formal",
    selectedVersion: {
      packageKey: "opengrove.legacy-app",
      version: "1.2.5",
      archiveSha256: "d".repeat(64),
    },
  });
  const draftRecordPath = join(
    appStoreDataRoot(state),
    "local-drafts",
    createHash("sha256").update(target.localAppId, "utf8").digest("hex"),
    "current.json",
  );
  const draftRecord = JSON.parse(readFileSync(draftRecordPath, "utf8")) as {
    publishBase: { releaseCommitSha?: string };
  };
  delete draftRecord.publishBase.releaseCommitSha;
  writeFileSync(draftRecordPath, `${JSON.stringify(draftRecord, null, 2)}\n`, "utf8");

  const repaired = await coordinator.start({
    release: { ...release, version: "1.2.6" },
    applyToCurrentApp: false,
  });
  assert.equal(repaired.state, "published");
  assert.deepEqual(remote.createBodies[2]?.publishBase, {
    version: "1.2.5",
    releaseCommitSha: "c".repeat(40),
    archiveSha256: "d".repeat(64),
  });
  assert.equal(remote.createBodies[2]?.expectedMainSha, "c".repeat(40));

  // An App installed from the retired Store can be absent from the new
  // Registry even though its local formal identity is still intact. The Host
  // must not reinterpret that lineage as a new package: the exact old baseline
  // has to be migrated before a strictly newer version can be published.
  const freshRegistryRoot = join(root, "fresh-registry");
  const freshAppRoot = join(freshRegistryRoot, "apps", "legacy-app");
  mkdirSync(join(freshAppRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(freshAppRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "legacy-app",
        title: "Legacy App",
        description: "Installed from the retired Registry.",
        ui: { surface: "none", workspace: "workspace" },
        workspace: { path: "workspace" },
        employees: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(freshAppRoot, "program.txt"), "retired Registry source\n", "utf8");
  mkdirSync(join(freshAppRoot, "web"), { recursive: true });
  mkdirSync(join(freshAppRoot, "ui"), { recursive: true });
  writeFileSync(join(freshAppRoot, "web", "index.html"), "retired Registry source\n", "utf8");
  writeFileSync(join(freshAppRoot, "ui", "index.html"), "retired Registry source\n", "utf8");
  writeFileSync(join(freshAppRoot, "build.mjs"), deterministicBuildScript(), "utf8");
  writeFileSync(
    join(freshAppRoot, ".opengrove-build.json"),
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
  const freshState = createBridgeState({ statePath: join(freshRegistryRoot, "state.json") });
  freshState.settings.mountedApps = [
    {
      id: "fresh-registry-legacy-app-mount",
      path: freshAppRoot,
      enabled: true,
      title: "Legacy App",
    },
  ];
  recreateBridgeApp(freshState);
  const freshTarget = resolveMountedAppTarget(freshState, "legacy-app");
  assert.ok(freshTarget);
  new MountedAppVersionStateStore(join(appStoreDataRoot(freshState), "version-state")).write({
    localAppId: freshTarget.localAppId,
    activeContent: "formal",
    selectedVersion: {
      packageKey: "opengrove.legacy-app",
      version: "1.2.3",
      archiveSha256,
    },
  });
  const freshRegistryVersions: AppStoreFormalVersion[] = [];
  const freshRegistry: AppReleaseRegistryAccess = {
    listVersions: async () => freshRegistryVersions,
    importVersion: async () => {
      throw new Error("apply=false must not replace the mounted App");
    },
  };
  const freshRemote = remoteFixture(() => {
    throw new Error("an unmigrated retired-Store baseline must not reach Release Control");
  });
  await assert.rejects(
    () =>
      new AppReleaseCoordinator({
        state: freshState,
        target: freshTarget,
        registry: freshRegistry,
        client: freshRemote.client,
      }).start({
        release: { ...release, version: "1.2.4" },
        applyToCurrentApp: false,
      }),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError &&
      error.message === "app_store_publish_base_missing" &&
      error.status === 409,
  );
  assert.equal(freshRemote.createBodies.length, 0);

  process.stdout.write("app release Registry migration harness passed\n");
} finally {
  if (previousUserData === undefined) delete process.env[appEnvName("USER_DATA_DIR")];
  else process.env[appEnvName("USER_DATA_DIR")] = previousUserData;
  rmSync(root, { recursive: true, force: true });
}

function legacyFormalVersion(authoritativeArchiveSha256: string, authoritativeAppId: string): AppStoreFormalVersion {
  return {
    packageKey: "opengrove.legacy-app",
    packageId: "legacy-app",
    appId: authoritativeAppId,
    title: "Legacy App",
    version: "1.2.3",
    publishedBy: "Admin",
    publishedAt: "2026-07-30T00:00:00Z",
    releaseCommitSha: null,
    releaseNotes: "Legacy Registry release",
    artifactSource: "registry",
    archiveName: "legacy-app-1.2.3.tgz",
    archiveSize: 12_345,
    archiveSha256: authoritativeArchiveSha256,
    minHostReleaseNumber: 0,
    availability: "available",
    downloadReference: "/v1/app-store/packages/opengrove.legacy-app/versions/1.2.3/archive",
  };
}

function gitFormalVersion(
  version: string,
  releaseCommitSha: string,
  publishedArchiveSha256: string,
  archiveSize: number,
): AppStoreFormalVersion {
  return {
    ...legacyFormalVersion(publishedArchiveSha256, "legacy-app"),
    version,
    releaseCommitSha,
    artifactSource: "github-release",
    archiveName: `legacy-app-${version}.tgz`,
    archiveSize,
  };
}

function deterministicBuildScript(): string {
  return [
    'import { cpSync, mkdirSync, rmSync } from "node:fs";',
    'rmSync("ui", { recursive: true, force: true });',
    'mkdirSync("ui", { recursive: true });',
    'cpSync("web", "ui", { recursive: true });',
    "",
  ].join("\n");
}

function remoteFixture(
  registerVersion: (
    input: ReleaseControlStartMetadata,
    commitSha: string,
    archiveSha256: string,
    archiveSize: number,
  ) => void,
): {
  client: AppReleaseRemoteAccess;
  createBodies: ReleaseControlStartMetadata[];
} {
  const createBodies: ReleaseControlStartMetadata[] = [];
  let intentNumber = 0;
  const start = async (record: AppReleaseJournalRecord, sourceSnapshot: Buffer): Promise<ReleaseControlIntent> => {
    assert.equal(sourceSnapshot.byteLength, record.sourceSnapshot.size);
    const input = releaseControlStartMetadata(record);
    createBodies.push(input);
    intentNumber += 1;
    registerVersion(input, "c".repeat(40), "d".repeat(64), 54_321);
    return intentFixture(input, intentNumber);
  };
  return {
    client: {
      findByIdempotencyKey: async () => {
        throw new ReleaseControlClientError(404, "app_release_not_found");
      },
      findById: async () => {
        throw new Error("unexpected remote lookup by id");
      },
      start,
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
    },
    createBodies,
  };
}

function intentFixture(input: ReleaseControlStartMetadata, intentNumber = 1): ReleaseControlIntent {
  const commitSha = "c".repeat(40);
  const publishedArchiveSha256 = "d".repeat(64);
  return {
    id: `intent-registry-migration-${intentNumber}`,
    status: "published",
    allowedActions: [],
    ...input,
    candidateSha: commitSha,
    gatedArchiveName: `legacy-app-${input.version}.tgz`,
    gatedArchiveSha256: publishedArchiveSha256,
    gatedArchiveSize: 54_321,
    publishedByUserId: 1,
    createdAt: "2026-07-30T00:00:00Z",
    publishedAt: "2026-07-30T00:01:00Z",
  };
}
