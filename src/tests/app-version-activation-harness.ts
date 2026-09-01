import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appEnvName } from "../identity.js";
import {
  appStoreDataRoot,
  captureAppStorePublishTarget,
  disposePreparedAppStorePackageInstall,
  importAppStorePackage,
  packAppStoreArchive,
  prepareAppStorePackageInstall,
  readAppStorePackageInstallMarker,
} from "../server/app-store.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import { mountedAppEffectiveEmployeeDefaults } from "../server/app-release.js";
import {
  activateImportedFormalAppVersion,
  activatePreparedLocalAppDraft,
  activeMountedAppRuns,
  forceStopMountedAppRuns,
} from "../server/app-version-manager.js";
import { AppRevisionStore, managedAppRevisionGitDirectory } from "../server/app-revision-store.js";
import { MountedAppVersionStateStore, selectedFormalVersionFromMarker } from "../server/app-version-state.js";
import { resolveMountedAppTarget } from "../server/mounted-apps.js";
import { LocalAppDraftStore } from "../server/local-app-drafts.js";
import { scheduleRoomAssistantRunsWithExecutor } from "../server/room-runs/scheduler.js";
import { handleAppsRoute } from "../server/routes/apps.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-app-version-activation-"));
const appsRoot = join(tempRoot, "apps");
const appRoot = join(tempRoot, "mounted-source", "versioned-app");
const sourceRoot = join(tempRoot, "formal-v2");
const previousUserData = process.env[appEnvName("USER_DATA_DIR")];
const previousAppsDir = process.env[appEnvName("APP_STORE_APPS_DIR")];
const previousFetch = globalThis.fetch;
let stateStore: ReturnType<typeof createBridgeState>["store"] | undefined;

function appManifest(version: string, contextTokenBudget: number) {
  const isSecondVersion = version === "2.0.0";
  return {
    id: "versioned-app",
    title: "Versioned App",
    description: "",
    version,
    ui: { surface: "none", workspace: "workspace" },
    workspace: { path: "workspace" },
    store: {
      packageKey: "team.versioned-app",
      employeeDefaults: [
        {
          memberId: "member-app-versioned-app-worker",
          name: isSecondVersion ? "Published Worker" : "Worker",
          avatarMode: "initials",
          avatarSeed: isSecondVersion ? "published-worker" : "worker",
          role: `Works in ${version}.`,
          kernel: "claude-code",
          model: isSecondVersion ? "deepseek-v4-pro" : "deepseek-v4-flash",
          reasoningEffort: isSecondVersion ? "xhigh" : "high",
          contextTokenBudget,
          accessMode: isSecondVersion ? "auto-review" : "default",
          color: isSecondVersion ? "#148a47" : "#2563eb",
          availableSkillIds: isSecondVersion ? ["app:versioned/research", "app:versioned/write"] : [],
          defaultSkillIds: isSecondVersion ? ["app:versioned/research"] : [],
          visibility: isSecondVersion ? "public" : "private",
          publicDescription: isSecondVersion ? "Published employee defaults" : undefined,
          publicSkills: isSecondVersion ? ["research", "writing"] : [],
          inputSpec: isSecondVersion ? "A clear assignment" : undefined,
          outputSpec: isSecondVersion ? "A verified result" : undefined,
        },
        {
          memberId: "member-app-versioned-app-pm",
          name: "Versioned App PM",
          role: "Plans work for Versioned App.",
          kernel: "claude-code",
          model: "deepseek-v4-pro",
          reasoningEffort: "high",
          contextTokenBudget,
          accessMode: "default",
          color: "#1d4ed8",
          availableSkillIds: ["pm-planner"],
          defaultSkillIds: ["pm-planner"],
          visibility: "private",
          publicSkills: [],
        },
      ],
    },
    employees: [
      {
        id: "worker",
        name: "Worker",
        role: `Works in ${version}.`,
        kernel: "claude-code",
        model: "deepseek-v4-pro",
      },
    ],
  };
}

function writeApp(root: string, version: string, contextTokenBudget: number, program: string) {
  mkdirSync(join(root, "workspace"), { recursive: true });
  writeFileSync(
    join(root, "opengrove.app.json"),
    `${JSON.stringify(appManifest(version, contextTokenBudget), null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(root, "program.txt"), `${program}\n`, "utf8");
}

try {
  process.env[appEnvName("USER_DATA_DIR")] = join(tempRoot, "user-data");
  process.env[appEnvName("APP_STORE_APPS_DIR")] = appsRoot;

  writeApp(appRoot, "1.0.0", 100_000, "formal v1");
  writeFileSync(join(appRoot, "workspace", "keep.md"), "business data\n", "utf8");
  mkdirSync(join(appRoot, ".git"), { recursive: true });
  writeFileSync(join(appRoot, ".git", "HEAD"), "ref: refs/heads/local-work\n", "utf8");
  const v1Archive = packAppStoreArchive({ appRoot, allowSetup: true });
  writeFileSync(
    join(appRoot, ".opengrove-package-manifest.json"),
    `${JSON.stringify(v1Archive.packageManifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(appRoot, ".opengrove-store-package.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        source: "registry",
        packageKey: "team.versioned-app",
        packageId: "versioned-app",
        appId: "versioned-app",
        version: "1.0.0",
        archiveSha256: v1Archive.archiveSha256,
        releaseCommitSha: "1".repeat(40),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  writeApp(sourceRoot, "2.0.0", 200_000, "formal v2");
  const v2Archive = packAppStoreArchive({ appRoot: sourceRoot, allowSetup: true });

  const state = createBridgeState({ statePath: join(tempRoot, "state.json") });
  stateStore = state.store;
  state.settings.mountedApps = [
    {
      id: "local-versioned-app",
      path: appRoot,
      enabled: true,
      title: "Versioned App",
    },
  ];
  recreateBridgeApp(state);

  const imported = importAppStorePackage({
    state,
    package: {
      id: "versioned-app",
      packageId: "versioned-app",
      packageKey: "team.versioned-app",
      appId: "versioned-app",
      title: "Versioned App",
      summary: "",
      version: "2.0.0",
      category: "test",
      publishKind: "app",
      installMode: "workspace",
      workspaceName: "Versioned App",
      requirements: [],
      capabilities: [],
      backupScopes: [],
      status: "available",
      visibility: "restricted",
      publisher: "OpenGrove Team",
      usageCount: 0,
      source: "registry",
      archiveName: v2Archive.fileName,
      archiveSize: v2Archive.archiveSize,
      archiveSha256: v2Archive.archiveSha256,
      releaseCommitSha: "2".repeat(40),
    },
    archiveBytes: v2Archive.bytes,
  });
  const versionStore = new MountedAppVersionStateStore(join(appStoreDataRoot(state), "version-state"));
  versionStore.write({
    localAppId: "local-versioned-app",
    activeContent: "formal",
    selectedVersion: selectedFormalVersionFromMarker(readAppStorePackageInstallMarker(appRoot)),
  });

  const preparedV2 = prepareAppStorePackageInstall({
    packageId: imported.id,
    settings: state.settings,
    storeRoot: appStoreDataRoot(state),
    adoptTargetSnapshot: captureAppStorePublishTarget(appRoot),
  });
  assert.ok(preparedV2);
  const formalStagingRoot = join(appStoreDataRoot(state), "staging");
  assert.ok(
    readdirSync(formalStagingRoot).some((entry) => entry.startsWith("formal-")),
    "formal version preparation must stage inside the Store-owned volume",
  );
  assert.equal(
    existsSync(join(resolve(appRoot, ".."), ".opengrove-install-transactions")),
    false,
    "formal preparation must not create transaction trees beside a potentially cross-volume legacy App",
  );
  const activation = await activateImportedFormalAppVersion({
    state,
    localAppId: "local-versioned-app",
    prepared: preparedV2,
    selectedVersion: {
      packageKey: "team.versioned-app",
      version: "2.0.0",
      archiveSha256: v2Archive.archiveSha256,
      releaseCommitSha: "2".repeat(40),
    },
    versionStore,
    persistBridgeSettings: () => undefined,
  });
  disposePreparedAppStorePackageInstall(preparedV2);
  assert.equal(readdirSync(formalStagingRoot).length, 0, "disposing a formal install must clean Store staging");
  assert.equal(activation.install.packageChanged, true);
  const activeProgramRoot = () => {
    const mountedApp = state.settings.mountedApps.find((candidate) => candidate.id === "local-versioned-app");
    assert.ok(mountedApp);
    return mountedApp.path;
  };
  assert.equal(
    state.settings.mountedApps.find((mountedApp) => mountedApp.id === "local-versioned-app")?.id,
    "local-versioned-app",
    "a formal version switch must preserve the stable mounted App identity",
  );
  assert.notEqual(resolve(activeProgramRoot()), resolve(appRoot));
  assert.equal(resolve(state.settings.mountedApps[0]?.workspacePath ?? ""), resolve(appRoot, "workspace"));
  assert.equal(readFileSync(join(activeProgramRoot(), "program.txt"), "utf8"), "formal v2\n");
  assert.equal(readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"), "business data\n");
  assert.equal(readFileSync(join(activeProgramRoot(), ".git", "HEAD"), "utf8"), "ref: refs/heads/local-work\n");
  assert.equal(versionStore.read("local-versioned-app")?.selectedVersion?.version, "2.0.0");
  assert.equal(versionStore.read("local-versioned-app")?.activeContent, "formal");
  const worker = state.app.rooms.listMembers().find((member) => member.id === "member-app-versioned-app-worker");
  assert.deepEqual(
    {
      name: worker?.name,
      avatarMode: worker?.avatarMode,
      avatarSeed: worker?.avatarSeed,
      role: worker?.role,
      kernel: worker?.kernel,
      model: worker?.model,
      reasoningEffort: worker?.reasoningEffort,
      contextTokenBudget: worker?.contextTokenBudget,
      accessMode: worker?.accessMode,
      color: worker?.color,
      availableSkillIds: worker?.availableSkillIds,
      defaultSkillIds: worker?.defaultSkillIds,
      visibility: worker?.visibility,
      publicDescription: worker?.publicDescription,
      publicSkills: worker?.publicSkills,
      inputSpec: worker?.inputSpec,
      outputSpec: worker?.outputSpec,
    },
    {
      name: "Published Worker",
      avatarMode: "initials",
      avatarSeed: "published-worker",
      role: "Works in 2.0.0.\nApp ID: versioned-app\nWorkspace scope: declared workspace",
      kernel: "claude-code",
      model: "deepseek-v4-pro",
      reasoningEffort: "xhigh",
      contextTokenBudget: 200_000,
      accessMode: "auto-review",
      color: "#148a47",
      availableSkillIds: ["app:versioned/research", "app:versioned/write"],
      defaultSkillIds: ["app:versioned/research"],
      visibility: "public",
      publicDescription: "Published employee defaults",
      publicSkills: ["research", "writing"],
      inputSpec: "A clear assignment",
      outputSpec: "A verified result",
    },
  );

  const rollbackSource = join(tempRoot, "formal-v3");
  writeApp(rollbackSource, "3.0.0", 300_000, "formal v3");
  const v3Archive = packAppStoreArchive({ appRoot: rollbackSource, allowSetup: true });
  const v3 = importAppStorePackage({
    state,
    package: {
      ...imported,
      version: "3.0.0",
      archiveName: v3Archive.fileName,
      archiveSize: v3Archive.archiveSize,
      archiveSha256: v3Archive.archiveSha256,
      releaseCommitSha: "3".repeat(40),
    },
    archiveBytes: v3Archive.bytes,
  });
  const saveSnapshot = state.store.saveSnapshot?.bind(state.store);
  assert.ok(saveSnapshot, "the SQLite state store must persist an already captured transaction snapshot");
  let capturedSnapshotSaveCount = 0;
  state.store.saveSnapshot = (snapshot) => {
    capturedSnapshotSaveCount += 1;
    return saveSnapshot(snapshot);
  };
  const restoreSnapshotInto = state.store.restoreSnapshotInto?.bind(state.store);
  assert.ok(restoreSnapshotInto, "the SQLite state store must restore captured snapshots with its retention policy");
  let capturedSnapshotRestoreCount = 0;
  state.store.restoreSnapshotInto = (app, snapshot) => {
    capturedSnapshotRestoreCount += 1;
    return restoreSnapshotInto(app, snapshot);
  };
  let injectedActivationAttempts = 0;
  const formalActivationSnapshots: unknown[] = [];
  const preparedV3 = prepareAppStorePackageInstall({
    packageId: v3.id,
    settings: state.settings,
    storeRoot: appStoreDataRoot(state),
    adoptTargetSnapshot: captureAppStorePublishTarget(activeProgramRoot()),
  });
  assert.ok(preparedV3);
  await assert.rejects(
    async () =>
      activateImportedFormalAppVersion({
        state,
        localAppId: "local-versioned-app",
        prepared: preparedV3,
        selectedVersion: {
          packageKey: "team.versioned-app",
          version: "3.0.0",
          archiveSha256: v3Archive.archiveSha256,
          releaseCommitSha: "3".repeat(40),
        },
        versionStore,
        activateBridgeApp: (_state, options) => {
          injectedActivationAttempts += 1;
          formalActivationSnapshots.push(options?.agentStateSnapshot);
          if (injectedActivationAttempts === 1) throw new Error("injected_activation_failure");
          recreateBridgeApp(state, options);
        },
        persistBridgeSettings: () => undefined,
      }),
    /injected_activation_failure/,
  );
  assert.equal(formalActivationSnapshots.length, 2);
  assert.ok(
    formalActivationSnapshots.every(Boolean),
    "formal activation and rollback must reuse the captured state snapshot",
  );
  assert.equal(
    capturedSnapshotSaveCount,
    1,
    "formal activation must persist its captured snapshot without taking it twice",
  );
  assert.equal(capturedSnapshotRestoreCount, 1, "formal rollback must restore through the state store policy");
  disposePreparedAppStorePackageInstall(preparedV3);
  assert.equal(readFileSync(join(activeProgramRoot(), "program.txt"), "utf8"), "formal v2\n");
  assert.equal(readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"), "business data\n");
  assert.equal(readFileSync(join(activeProgramRoot(), ".git", "HEAD"), "utf8"), "ref: refs/heads/local-work\n");
  assert.equal(versionStore.read("local-versioned-app")?.selectedVersion?.version, "2.0.0");
  assert.equal(resolveMountedAppTarget(state, "versioned-app")?.manifest.version, "2.0.0");

  const releaseControlUrl = "https://release-control.version.test";
  state.settings.appStore = {
    registryUrl: "https://legacy-ww-registry.version.test",
    registryToken: "version-session",
    releaseControlUrl,
  };
  let exactDownloadCount = 0;
  let exposeInvalidVersion = false;
  let exposeSecondVersion = false;
  const invalidArchive = Buffer.from("not a valid App archive", "utf8");
  const invalidArchiveSha256 = createHash("sha256").update(invalidArchive).digest("hex");
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(
      url.startsWith(releaseControlUrl),
      true,
      "formal version catalog and download must never fall back to the legacy WW Registry URL",
    );
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    assert.equal(authorization, "Bearer version-session");
    if (url.endsWith("/v1/app-store/packages")) {
      return Response.json({
        packages: [
          {
            id: "versioned-app",
            packageId: "versioned-app",
            packageKey: "team.versioned-app",
            appId: "versioned-app",
            title: "Versioned App",
            summary: "",
            version: "2.0.0",
            category: "test",
            publishKind: "app",
            installMode: "workspace",
            workspaceName: "Versioned App",
            requirements: [],
            capabilities: [],
            backupScopes: [],
            status: "available",
            visibility: "restricted",
            publisher: "OpenGrove Team",
            usageCount: 0,
            archiveName: v2Archive.fileName,
            archiveSize: v2Archive.archiveSize,
            archiveSha256: v2Archive.archiveSha256,
          },
        ],
      });
    }
    if (url.endsWith("/v1/app-store/packages/team.versioned-app/versions")) {
      return Response.json({
        versions: [
          ...(exposeSecondVersion
            ? [
                {
                  packageKey: "team.versioned-app",
                  packageId: "versioned-app",
                  appId: "versioned-app",
                  title: "Versioned App",
                  version: "2.0.0",
                  publishedBy: "OpenGrove Team",
                  publishedAt: "2026-07-29T12:00:00Z",
                  releaseCommitSha: "2".repeat(40),
                  releaseNotes: "Current target",
                  artifactSource: "github-release",
                  archiveName: v2Archive.fileName,
                  archiveSize: v2Archive.archiveSize,
                  archiveSha256: v2Archive.archiveSha256,
                  minHostReleaseNumber: 0,
                  availability: "available",
                  downloadReference: `/v1/app-store/packages/team.versioned-app/versions/2.0.0/download?archiveSha256=${v2Archive.archiveSha256}`,
                },
              ]
            : []),
          ...(exposeInvalidVersion
            ? [
                {
                  packageKey: "team.versioned-app",
                  packageId: "versioned-app",
                  appId: "versioned-app",
                  title: "Versioned App",
                  version: "0.9.0",
                  publishedBy: "OpenGrove Team",
                  publishedAt: "2026-07-19T10:00:00Z",
                  releaseCommitSha: "9".repeat(40),
                  releaseNotes: "Invalid staging fixture",
                  artifactSource: "github-release",
                  archiveName: "invalid-v0.9.0.tgz",
                  archiveSize: invalidArchive.byteLength,
                  archiveSha256: invalidArchiveSha256,
                  minHostReleaseNumber: 0,
                  availability: "available",
                  downloadReference: `/v1/app-store/packages/team.versioned-app/versions/0.9.0/download?archiveSha256=${invalidArchiveSha256}`,
                },
              ]
            : []),
          {
            packageKey: "team.versioned-app",
            packageId: "versioned-app",
            appId: "versioned-app",
            title: "Versioned App",
            version: "1.0.0",
            publishedBy: "OpenGrove Team",
            publishedAt: "2026-07-29T10:00:00Z",
            releaseCommitSha: "1".repeat(40),
            releaseNotes: "Rollback target",
            artifactSource: "github-release",
            archiveName: v1Archive.fileName,
            archiveSize: v1Archive.archiveSize,
            archiveSha256: v1Archive.archiveSha256,
            minHostReleaseNumber: 0,
            availability: "available",
            downloadReference: `/v1/app-store/packages/team.versioned-app/versions/1.0.0/download?archiveSha256=${v1Archive.archiveSha256}`,
          },
        ],
      });
    }
    if (url.includes("/versions/0.9.0/download")) {
      return new Response(invalidArchive as unknown as BodyInit, {
        status: 200,
        headers: { "content-length": String(invalidArchive.byteLength) },
      });
    }
    if (url.includes("/versions/1.0.0/download")) {
      exactDownloadCount += 1;
      return new Response(v1Archive.bytes as unknown as BodyInit, {
        status: 200,
      });
    }
    if (url.includes("/versions/2.0.0/download")) {
      exactDownloadCount += 1;
      return new Response(v2Archive.bytes as unknown as BodyInit, {
        status: 200,
        headers: { "content-length": String(v2Archive.archiveSize) },
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  const listed = await callAppsRoute(state, "/apps/versioned-app/versions", "GET");
  assert.equal(listed.status, 200);
  assert.equal(listed.data.status.selectedVersion.version, "2.0.0");
  assert.equal(listed.data.status.versions[0].version, "1.0.0");

  const ambiguousTarget = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: { kind: "formal", version: "1.0.0" },
  });
  assert.equal(ambiguousTarget.status, 400);
  assert.equal(ambiguousTarget.data.error, "app_version_target_invalid");
  assert.equal(exactDownloadCount, 0, "a formal switch must identify the exact immutable archive");

  writeFileSync(join(activeProgramRoot(), "program.txt"), "unsaved local edit\n", "utf8");
  const blocked = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: {
      kind: "formal",
      version: "1.0.0",
      archiveSha256: v1Archive.archiveSha256,
    },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, "app_version_unsaved_changes");
  assert.equal(exactDownloadCount, 0, "dirty checks must happen before exact-version download");
  writeFileSync(join(activeProgramRoot(), "program.txt"), "formal v2\n", "utf8");

  const switched = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: {
      kind: "formal",
      version: "1.0.0",
      archiveSha256: v1Archive.archiveSha256,
    },
  });
  assert.equal(switched.status, 200);
  assert.equal(exactDownloadCount, 1);
  assert.equal(readFileSync(join(activeProgramRoot(), "program.txt"), "utf8"), "formal v1\n");
  assert.equal(readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"), "business data\n");
  assert.equal(switched.data.status.selectedVersion.version, "1.0.0");
  assert.equal(
    switched.data.status.hasUnsavedChanges,
    false,
    "activating an exact formal archive must establish a clean working baseline",
  );
  assert.equal(
    state.app.rooms.listMembers().find((member) => member.id === "member-app-versioned-app-worker")?.contextTokenBudget,
    100_000,
  );

  exposeSecondVersion = true;
  const finalWriteWorker = state.app.rooms
    .listMembers()
    .find((member) => member.id === "member-app-versioned-app-worker");
  assert.ok(finalWriteWorker);
  const finalWriteRoom = state.app.rooms.createRoom({
    id: "version-final-write-room",
    title: "Version final write",
    memberIds: [finalWriteWorker.id],
  });
  const finalWriteMessage = state.app.rooms.postUserMessage({
    roomId: finalWriteRoom.id,
    text: "write one last source change while stopping",
    targetIds: [finalWriteWorker.id],
    assistantTargets: [finalWriteWorker],
  });
  scheduleRoomAssistantRunsWithExecutor(
    state,
    {
      roomId: finalWriteRoom.id,
      triggerMessageId: finalWriteMessage.userMessage.id,
      targets: [finalWriteWorker],
      assistantMessages: finalWriteMessage.assistantMessages,
    },
    async (runState, input) => {
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      writeFileSync(join(activeProgramRoot(), "program.txt"), "run final edit\n", "utf8");
      runState.app.rooms.updateMessage(input.roomId, input.assistantMessageId, {
        status: "interrupted",
        finishedAt: new Date().toISOString(),
      });
    },
  );
  const changedWhileStopping = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: {
      kind: "formal",
      version: "2.0.0",
      archiveSha256: v2Archive.archiveSha256,
    },
    forceStop: true,
  });
  assert.equal(changedWhileStopping.status, 409);
  assert.equal(changedWhileStopping.data.error, "app_version_unsaved_changes");
  assert.equal(
    readFileSync(join(activeProgramRoot(), "program.txt"), "utf8"),
    "run final edit\n",
    "a final source write from a stopped run must not be overwritten without discard confirmation",
  );
  writeFileSync(join(activeProgramRoot(), "program.txt"), "formal v1\n", "utf8");

  exposeInvalidVersion = true;
  const runningWorker = state.app.rooms.listMembers().find((member) => member.id === "member-app-versioned-app-worker");
  assert.ok(runningWorker);
  const runningRoom = state.app.rooms.createRoom({
    id: "version-staging-room",
    title: "Version staging",
    memberIds: [runningWorker.id],
  });
  const runningMessage = state.app.rooms.postUserMessage({
    roomId: runningRoom.id,
    text: "keep running until the target is staged",
    targetIds: [runningWorker.id],
    assistantTargets: [runningWorker],
  });
  scheduleRoomAssistantRunsWithExecutor(
    state,
    {
      roomId: runningRoom.id,
      triggerMessageId: runningMessage.userMessage.id,
      targets: [runningWorker],
      assistantMessages: runningMessage.assistantMessages,
    },
    async (runState, input) => {
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      runState.app.rooms.updateMessage(input.roomId, input.assistantMessageId, {
        status: "interrupted",
        finishedAt: new Date().toISOString(),
      });
    },
  );
  assert.equal(activeMountedAppRuns(state, "versioned-app").length, 1);
  const invalidStaging = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: {
      kind: "formal",
      version: "0.9.0",
      archiveSha256: invalidArchiveSha256,
    },
    discardUnsavedChanges: true,
    forceStop: true,
  });
  assert.notEqual(invalidStaging.status, 200);
  assert.equal(
    activeMountedAppRuns(state, "versioned-app").length,
    1,
    "archive staging must fail before the currently running App task is stopped",
  );
  await forceStopMountedAppRuns(state, "versioned-app", 2_000);

  writeFileSync(join(activeProgramRoot(), "program.txt"), "saved local draft\n", "utf8");
  state.app.rooms.patchMember("member-app-versioned-app-worker", {
    name: "Draft Worker",
    avatarMode: "initials",
    avatarSeed: "draft-worker",
    role: "Works from the saved draft.",
    model: "deepseek-v4-pro",
    reasoningEffort: "high",
    contextTokenBudget: 222_000,
    accessMode: "full-access",
    color: "#7c3aed",
    visibility: "public",
    publicDescription: "Saved draft employee defaults",
    publicSkills: ["drafting"],
    inputSpec: "A draft assignment",
    outputSpec: "A draft result",
    userOverrides: [
      "name",
      "avatarMode",
      "avatarSeed",
      "role",
      "model",
      "reasoningEffort",
      "contextTokenBudget",
      "accessMode",
      "color",
      "visibility",
      "publicDescription",
      "publicSkills",
      "inputSpec",
      "outputSpec",
    ],
  });
  state.store.saveFrom(state.app);
  writeFileSync(
    join(activeProgramRoot(), "local-build-path-example.txt"),
    `${["", "Users", "draft-user", "private-build"].join("/")}\n`,
  );
  const opaqueContentPreparedDraft = await callAppsRoute(state, "/apps/versioned-app/draft/prepare", "GET");
  assert.equal(
    opaqueContentPreparedDraft.data.release.checks.some((check: { id: string }) => check.id === "portable-package"),
    false,
    "draft preparation must not claim to predict the complete formal package",
  );
  assert.equal(
    opaqueContentPreparedDraft.data.release.checks.find((check: { id: string }) => check.id === "manifest-and-ui")
      ?.status,
    "passed",
    "opaque App contents must not affect product-level draft validation",
  );
  rmSync(join(activeProgramRoot(), "local-build-path-example.txt"), { force: true });
  const preparedDraft = await callAppsRoute(state, "/apps/versioned-app/draft/prepare", "GET");
  assert.equal(preparedDraft.status, 200);
  const draftEmployee = preparedDraft.data.release.employees.find(
    (employee: { memberId: string }) => employee.memberId === "member-app-versioned-app-worker",
  );
  assert.ok(draftEmployee);
  Object.assign(draftEmployee, {
    name: "Draft Worker",
    avatarMode: "initials",
    avatarSeed: "draft-worker",
    role: "Works from the saved draft.",
    model: "deepseek-v4-pro",
    reasoningEffort: "high",
    contextTokenBudget: 222_000,
    accessMode: "full-access",
    color: "#7c3aed",
    visibility: "public",
    publicDescription: "Saved draft employee defaults",
    publicSkills: ["drafting"],
    inputSpec: "A draft assignment",
    outputSpec: "A draft result",
  });
  const savedDraft = await callAppsRoute(state, "/apps/versioned-app/draft", "PUT", {
    app: preparedDraft.data.release.app,
    employees: preparedDraft.data.release.employees,
  });
  assert.equal(savedDraft.status, 200, JSON.stringify(savedDraft.data));
  assert.equal(savedDraft.data.draft.localAppId, "local-versioned-app");
  assert.deepEqual(savedDraft.data.draft.publishBase, {
    packageKey: "team.versioned-app",
    version: "1.0.0",
    releaseCommitSha: "1".repeat(40),
    archiveSha256: v1Archive.archiveSha256,
  });
  assert.deepEqual(
    mountedAppEffectiveEmployeeDefaults(state, "versioned-app"),
    savedDraft.data.draft.employees,
    "the saved candidate must match the live effective Employee configuration in this fixture",
  );
  const savedDraftStatus = await callAppsRoute(state, "/apps/versioned-app/versions", "GET");
  assert.equal(savedDraftStatus.status, 200);
  assert.equal(
    savedDraftStatus.data.status.hasUnsavedChanges,
    false,
    "saving the live working tree as the one local draft must clear the dirty gate",
  );
  assert.equal(
    savedDraftStatus.data.status.sourceSavePoint.commitSha,
    savedDraft.data.draft.savePoint.commitSha,
    "version management must expose the current local source save point without a system Git dependency",
  );
  assert.equal(savedDraftStatus.data.status.sourceChangedFileCount, 0);

  if (process.platform !== "win32") {
    const linkedProgramPath = join(activeProgramRoot(), "linked-program.txt");
    symlinkSync("program.txt", linkedProgramPath);
    try {
      const linkedSourceStatus = await callAppsRoute(state, "/apps/versioned-app/versions", "GET");
      assert.equal(linkedSourceStatus.status, 200, JSON.stringify(linkedSourceStatus.data));
      assert.equal(linkedSourceStatus.data.status.sourceStatusError, "app_revision_symlink_not_supported");
      assert.equal(linkedSourceStatus.data.status.sourceStatusPath, "linked-program.txt");

      const linkedSourceSave = await callAppsRoute(state, "/apps/versioned-app/draft", "PUT", {
        app: preparedDraft.data.release.app,
        employees: preparedDraft.data.release.employees,
      });
      assert.equal(linkedSourceSave.status, 422, JSON.stringify(linkedSourceSave.data));
      assert.equal(linkedSourceSave.data.error, "app_revision_symlink_not_supported");
      assert.equal(linkedSourceSave.data.path, "linked-program.txt");
    } finally {
      rmSync(linkedProgramPath, { force: true });
    }
  }

  const revisionGitDirectory = managedAppRevisionGitDirectory(
    join(appStoreDataRoot(state), "app-revisions"),
    "local-versioned-app",
  );
  const revisionHeadPath = join(revisionGitDirectory, "HEAD");
  const revisionHead = readFileSync(revisionHeadPath, "utf8");
  try {
    writeFileSync(revisionHeadPath, "ref: refs/heads/missing-save-point\n", "utf8");
    const corruptedRevisionStatus = await callAppsRoute(state, "/apps/versioned-app/versions", "GET");
    assert.equal(
      corruptedRevisionStatus.status,
      500,
      "a damaged source-save-point repository must be diagnosed instead of silently hiding revision status",
    );
  } finally {
    writeFileSync(revisionHeadPath, revisionHead, "utf8");
  }

  writeFileSync(join(activeProgramRoot(), "program.txt"), "unsaved after draft save\n", "utf8");
  const dirtySourceStatus = await callAppsRoute(state, "/apps/versioned-app/versions", "GET");
  assert.equal(dirtySourceStatus.status, 200);
  assert.equal(dirtySourceStatus.data.status.hasUnsavedChanges, true);
  assert.equal(dirtySourceStatus.data.status.sourceChangedFileCount, 1);
  state.app.rooms.patchMember("member-app-versioned-app-worker", {
    contextTokenBudget: 64_000,
    userOverrides: ["contextTokenBudget"],
  });
  state.store.saveFrom(state.app);
  const registryFetch = globalThis.fetch;
  let offlineDraftFetchCount = 0;
  globalThis.fetch = async () => {
    offlineDraftFetchCount += 1;
    throw new Error("offline");
  };
  const blockedDraftSwitch = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: { kind: "local-draft" },
  });
  assert.equal(blockedDraftSwitch.status, 409);
  assert.equal(blockedDraftSwitch.data.error, "app_version_unsaved_changes");
  assert.equal(offlineDraftFetchCount, 0, "a local draft switch must not require Registry access");

  const openedDraft = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: { kind: "local-draft" },
    discardUnsavedChanges: true,
  });
  assert.equal(openedDraft.status, 200, JSON.stringify(openedDraft.data));
  assert.equal(offlineDraftFetchCount, 0);
  assert.equal(openedDraft.data.status.activeContent, "local-draft");
  assert.equal(openedDraft.data.status.selectedVersion.version, "1.0.0");
  assert.equal(openedDraft.data.status.hasUnsavedChanges, false);
  assert.equal(readFileSync(join(activeProgramRoot(), "program.txt"), "utf8"), "saved local draft\n");
  assert.equal(readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"), "business data\n");
  assert.equal(readFileSync(join(activeProgramRoot(), ".git", "HEAD"), "utf8"), "ref: refs/heads/local-work\n");
  assert.equal(
    existsSync(join(dirname(activeProgramRoot()), ".opengrove-draft-transactions")),
    false,
    "a side-by-side Store program must not nest draft transactions under its deep generation path",
  );
  const draftStagingRoot = join(appStoreDataRoot(state), "staging", "draft-transactions");
  const draftBackupRoot = join(appStoreDataRoot(state), "staging", "draft-backups");
  assert.deepEqual(readdirSync(draftStagingRoot), [], "a completed draft switch must clean staging");
  assert.deepEqual(readdirSync(draftBackupRoot), [], "a finalized draft switch must clean recovery backup data");
  const openedDraftWorker = state.app.rooms
    .listMembers()
    .find((member) => member.id === "member-app-versioned-app-worker");
  assert.equal(openedDraftWorker?.name, "Draft Worker");
  assert.equal(openedDraftWorker?.model, "deepseek-v4-pro");
  assert.equal(openedDraftWorker?.reasoningEffort, "high");
  assert.equal(openedDraftWorker?.contextTokenBudget, 222_000);
  assert.equal(openedDraftWorker?.accessMode, "full-access");
  assert.equal(openedDraftWorker?.visibility, "public");
  assert.equal(openedDraftWorker?.userOverrides, undefined);
  assert.deepEqual(
    (await callAppsRoute(state, "/apps/versioned-app/draft", "GET")).data.draft.publishBase,
    savedDraft.data.draft.publishBase,
    "opening a draft must not rewrite its publish base",
  );

  globalThis.fetch = registryFetch;
  const revisionHeadBeforeFailedFormalSwitch = readFileSync(revisionHeadPath, "utf8");
  try {
    rmSync(revisionHeadPath);
    mkdirSync(revisionHeadPath);
    const failedFormalSwitch = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
      target: {
        kind: "formal",
        version: "2.0.0",
        archiveSha256: v2Archive.archiveSha256,
      },
    });
    assert.equal(failedFormalSwitch.status, 502);
    assert.equal(
      versionStore.read("local-versioned-app")?.activeContent,
      "local-draft",
      "a source save-point failure must roll back the formal version switch",
    );
    assert.equal(
      readFileSync(join(activeProgramRoot(), "program.txt"), "utf8"),
      "saved local draft\n",
      "a source save-point failure must leave the previously active draft mounted",
    );
  } finally {
    rmSync(revisionHeadPath, { recursive: true });
    writeFileSync(revisionHeadPath, revisionHeadBeforeFailedFormalSwitch, "utf8");
  }
  const targetBeforePersistFailure = resolveMountedAppTarget(state, "local-versioned-app");
  assert.ok(targetBeforePersistFailure);
  const revisionStore = new AppRevisionStore(dirname(revisionGitDirectory));
  const revisionBeforePersistFailure = await revisionStore.inspect({
    localAppId: targetBeforePersistFailure.localAppId,
    appRoot: targetBeforePersistFailure.appRoot,
    workspacePath: "workspace",
  });
  const preparedPersistFailure = prepareAppStorePackageInstall({
    packageId: imported.id,
    settings: state.settings,
    storeRoot: appStoreDataRoot(state),
    adoptTargetSnapshot: captureAppStorePublishTarget(activeProgramRoot()),
  });
  assert.ok(preparedPersistFailure);
  let persistAttempts = 0;
  await assert.rejects(
    () =>
      activateImportedFormalAppVersion({
        state,
        localAppId: "local-versioned-app",
        prepared: preparedPersistFailure,
        selectedVersion: {
          packageKey: "team.versioned-app",
          version: "2.0.0",
          archiveSha256: v2Archive.archiveSha256,
          releaseCommitSha: "2".repeat(40),
        },
        versionStore,
        persistBridgeSettings: () => {
          persistAttempts += 1;
          if (persistAttempts === 1) throw new Error("injected_settings_persist_failure");
        },
      }),
    /injected_settings_persist_failure/,
  );
  disposePreparedAppStorePackageInstall(preparedPersistFailure);
  assert.equal(persistAttempts, 2, "formal activation failure must persist the restored settings");
  assert.equal(versionStore.read("local-versioned-app")?.activeContent, "local-draft");
  assert.equal(readFileSync(join(activeProgramRoot(), "program.txt"), "utf8"), "saved local draft\n");
  const targetAfterPersistFailure = resolveMountedAppTarget(state, "local-versioned-app");
  assert.ok(targetAfterPersistFailure);
  const revisionAfterPersistFailure = await revisionStore.inspect({
    localAppId: targetAfterPersistFailure.localAppId,
    appRoot: targetAfterPersistFailure.appRoot,
    workspacePath: "workspace",
  });
  assert.equal(
    revisionAfterPersistFailure.commitSha,
    revisionBeforePersistFailure.commitSha,
    "a post-save-point activation failure must restore the previous revision HEAD",
  );
  assert.equal(
    revisionAfterPersistFailure.dirty,
    revisionBeforePersistFailure.dirty,
    "rolling back revision metadata must preserve the pre-activation dirty truth",
  );
  const switchedFromDraftToV2 = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: {
      kind: "formal",
      version: "2.0.0",
      archiveSha256: v2Archive.archiveSha256,
    },
  });
  assert.equal(switchedFromDraftToV2.status, 200, JSON.stringify(switchedFromDraftToV2.data));
  assert.equal(switchedFromDraftToV2.data.status.activeContent, "formal");
  assert.equal(switchedFromDraftToV2.data.status.selectedVersion.version, "2.0.0");
  assert.equal(
    switchedFromDraftToV2.data.status.hasUnsavedChanges,
    false,
    "switching away from a saved draft must establish a clean formal baseline",
  );
  assert.equal(readFileSync(join(activeProgramRoot(), "program.txt"), "utf8"), "formal v2\n");
  assert.equal(readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"), "business data\n");
  assert.equal(
    readFileSync(join(activeProgramRoot(), ".git"), "utf8"),
    `gitdir: ${revisionGitDirectory}\n`,
    "formal activation must reattach source history instead of copying an external repository",
  );
  assert.equal(
    (
      await new AppRevisionStore(join(appStoreDataRoot(state), "app-revisions")).inspect({
        localAppId: "local-versioned-app",
        appRoot: activeProgramRoot(),
        workspacePath: "workspace",
      })
    ).dirty,
    false,
    "formal activation must advance the managed source baseline to the exact installed package",
  );
  assert.deepEqual(
    (await callAppsRoute(state, "/apps/versioned-app/draft", "GET")).data.draft.publishBase,
    savedDraft.data.draft.publishBase,
    "switching a formal version must retain the saved draft and its original publish base",
  );

  globalThis.fetch = async () => {
    offlineDraftFetchCount += 1;
    throw new Error("offline");
  };
  const reopenedDraft = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: { kind: "local-draft" },
  });
  assert.equal(reopenedDraft.status, 200, JSON.stringify(reopenedDraft.data));
  assert.equal(reopenedDraft.data.status.activeContent, "local-draft");
  assert.equal(reopenedDraft.data.status.hasUnsavedChanges, false);
  assert.equal(
    reopenedDraft.data.status.selectedVersion.version,
    "2.0.0",
    "opening a draft must retain the device-selected formal version",
  );
  assert.equal(readFileSync(join(activeProgramRoot(), "program.txt"), "utf8"), "saved local draft\n");
  assert.equal(offlineDraftFetchCount, 0);
  globalThis.fetch = registryFetch;

  const returnedToV2 = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: {
      kind: "formal",
      version: "2.0.0",
      archiveSha256: v2Archive.archiveSha256,
    },
  });
  assert.equal(returnedToV2.status, 200, JSON.stringify(returnedToV2.data));
  writeFileSync(join(activeProgramRoot(), "program.txt"), "rebased draft on v2\n", "utf8");
  const rebasedDraftCandidate = await callAppsRoute(state, "/apps/versioned-app/draft/prepare", "GET");
  const rebasedDraft = await callAppsRoute(state, "/apps/versioned-app/draft", "PUT", {
    app: rebasedDraftCandidate.data.release.app,
    employees: rebasedDraftCandidate.data.release.employees,
  });
  assert.equal(rebasedDraft.status, 200, JSON.stringify(rebasedDraft.data));
  assert.deepEqual(
    rebasedDraft.data.draft.publishBase,
    {
      packageKey: "team.versioned-app",
      version: "2.0.0",
      releaseCommitSha: "2".repeat(40),
      archiveSha256: v2Archive.archiveSha256,
    },
    "saving new work from an active formal version must advance the replacement draft base",
  );
  const restoredFormalBeforeFailure = await callAppsRoute(state, "/apps/versioned-app/versions/switch", "POST", {
    target: {
      kind: "formal",
      version: "2.0.0",
      archiveSha256: v2Archive.archiveSha256,
    },
  });
  assert.equal(restoredFormalBeforeFailure.status, 200);
  const transactionalDraftStore = new LocalAppDraftStore(join(appStoreDataRoot(state), "local-drafts"));
  const transactionalVersionStore = new MountedAppVersionStateStore(join(appStoreDataRoot(state), "version-state"));
  const preparedFailureDraft = transactionalDraftStore.prepareOpen({
    localAppId: "local-versioned-app",
    appRoot: activeProgramRoot(),
  });
  const draftCapturedSnapshotSaveCountBefore = capturedSnapshotSaveCount;
  const draftCapturedSnapshotRestoreCountBefore = capturedSnapshotRestoreCount;
  let draftActivationAttempts = 0;
  const draftActivationSnapshots: unknown[] = [];
  assert.throws(
    () =>
      activatePreparedLocalAppDraft({
        state,
        localAppId: "local-versioned-app",
        draftStore: transactionalDraftStore,
        prepared: preparedFailureDraft,
        selectedVersion: transactionalVersionStore.read("local-versioned-app")?.selectedVersion,
        versionStore: transactionalVersionStore,
        activateBridgeApp: (_state, options) => {
          draftActivationAttempts += 1;
          draftActivationSnapshots.push(options?.agentStateSnapshot);
          if (draftActivationAttempts === 1) throw new Error("injected_draft_activation_failure");
          recreateBridgeApp(state, options);
        },
        persistBridgeSettings: () => undefined,
      }),
    /injected_draft_activation_failure/,
  );
  assert.equal(draftActivationSnapshots.length, 2);
  assert.ok(
    draftActivationSnapshots.every(Boolean),
    "draft activation and rollback must reuse the captured state snapshot",
  );
  assert.equal(
    capturedSnapshotSaveCount,
    draftCapturedSnapshotSaveCountBefore + 1,
    "draft activation must persist its captured snapshot without taking it twice",
  );
  assert.equal(
    capturedSnapshotRestoreCount,
    draftCapturedSnapshotRestoreCountBefore + 1,
    "draft rollback must restore through the state store policy",
  );
  transactionalDraftStore.cancelPreparedOpen(preparedFailureDraft);
  assert.equal(readFileSync(join(activeProgramRoot(), "program.txt"), "utf8"), "formal v2\n");
  assert.equal(readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"), "business data\n");
  assert.equal(readFileSync(join(activeProgramRoot(), ".git"), "utf8"), `gitdir: ${revisionGitDirectory}\n`);
  assert.equal(transactionalVersionStore.read("local-versioned-app")?.activeContent, "formal");
  assert.equal(transactionalVersionStore.read("local-versioned-app")?.selectedVersion?.version, "2.0.0");
  const workerAfterDraftRollback = state.app.rooms
    .listMembers()
    .find((member) => member.id === "member-app-versioned-app-worker");
  assert.equal(workerAfterDraftRollback?.name, "Published Worker");
  assert.equal(workerAfterDraftRollback?.contextTokenBudget, 200_000);
  assert.equal(workerAfterDraftRollback?.userOverrides, undefined);
  assert.equal(
    (await callAppsRoute(state, "/apps/versioned-app/draft", "GET")).data.draft.archiveSha256,
    rebasedDraft.data.draft.archiveSha256,
    "a failed activation must retain the saved draft",
  );

  process.stdout.write("app version activation harness passed\n");
} finally {
  globalThis.fetch = previousFetch;
  await stateStore?.close?.();
  if (previousUserData === undefined) delete process.env[appEnvName("USER_DATA_DIR")];
  else process.env[appEnvName("USER_DATA_DIR")] = previousUserData;
  if (previousAppsDir === undefined) delete process.env[appEnvName("APP_STORE_APPS_DIR")];
  else process.env[appEnvName("APP_STORE_APPS_DIR")] = previousAppsDir;
  rmSync(tempRoot, { recursive: true, force: true });
}

async function callAppsRoute(
  state: ReturnType<typeof createBridgeState>,
  path: string,
  method: "GET" | "POST" | "PUT",
  payload: unknown = {},
): Promise<{ status: number; data: any }> {
  const calls: Array<{ status: number; data: any }> = [];
  const handled = await handleAppsRoute({
    request: { method, headers: {} } as any,
    response: {} as any,
    url: new URL(`http://opengrove.test${path}`),
    state,
    sendJson: (_response, status, data) => calls.push({ status, data }),
    readJsonBody: async () => payload,
  });
  assert.equal(handled, true);
  assert.ok(calls[0]);
  return calls[0];
}
