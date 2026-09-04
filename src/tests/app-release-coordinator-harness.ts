import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
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
import { AppReleaseJournalStore, type AppReleaseJournalRecord } from "../server/app-release-journal.js";
import { appStoreDataRoot } from "../server/app-store.js";
import type { AppStoreFormalVersion } from "../server/app-store-registry.js";
import { AppReleaseBuildCommandError } from "../server/app-release-local-build.js";
import { prepareMountedAppRelease } from "../server/app-release.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import { localAppDraftStore, saveMountedAppDraft } from "../server/mounted-app-draft-service.js";
import { resolveMountedAppTarget } from "../server/mounted-apps.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-app-release-coordinator-"));
const appRoot = join(root, "apps", "release-app");
const previousUserData = process.env[appEnvName("USER_DATA_DIR")];
const previousPath = process.env.PATH;
const prepareTarMarker = join(root, "prepare-invoked-tar");

try {
  process.env[appEnvName("USER_DATA_DIR")] = join(root, "user-data");
  if (process.platform !== "win32") {
    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeTar = join(fakeBin, "tar");
    writeFileSync(fakeTar, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${prepareTarMarker}'\nexec /usr/bin/tar "$@"\n`, "utf8");
    chmodSync(fakeTar, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
  }
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "release-app",
        title: "Release App",
        description: "Local source",
        ui: { surface: "none", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: { minHostReleaseNumber: 42 },
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
  writeFileSync(join(appRoot, "program.txt"), "release source\n", "utf8");
  writeFileSync(join(appRoot, "workspace", "keep.md"), "business data\n", "utf8");

  const state = createBridgeState({ statePath: join(root, "state.json") });
  state.settings.mountedApps = [
    {
      id: "release-app-mount",
      path: appRoot,
      enabled: true,
      title: "Release App",
    },
  ];
  recreateBridgeApp(state);
  const target = resolveMountedAppTarget(state, "release-app");
  assert.ok(target);
  const writerId = "member-app-release-app-writer";
  state.app.rooms.patchMember(writerId, {
    contextTokenBudget: 200_000,
    reasoningEffort: "high",
    accessMode: "full-access",
  });
  const missingContract = prepareMountedAppRelease({
    state,
    appId: "release-app",
    registryPackages: [],
  });
  assert.deepEqual(
    missingContract.checks.find((check) => check.id === "trusted-build-contract"),
    {
      id: "trusted-build-contract",
      label: "Local release build",
      severity: "blocking",
      status: "blocked",
      detail: "build_contract_missing",
    },
    "Apps without a declared reproducible build must fail closed before publishing",
  );
  writeFileSync(
    join(appRoot, ".opengrove-build.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        workingDirectory: ".",
        inputs: ["program.txt"],
        outputs: ["program.txt.generated"],
        commands: [
          ["busybox", "env", "env", "BUILD_MODE=release", "sh", "-e", "-c", "cp program.txt program.txt.generated"],
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(appRoot, "program.txt.generated"), "release source\n", "utf8");
  const shellStringContract = prepareMountedAppRelease({
    state,
    appId: "release-app",
    registryPackages: [],
  });
  assert.equal(
    shellStringContract.checks.find((check) => check.id === "trusted-build-contract")?.detail,
    "build_contract_invalid",
    "trusted builds must preserve argv boundaries instead of evaluating a shell string",
  );
  writeFileSync(
    join(appRoot, ".opengrove-build.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        workingDirectory: ".",
        inputs: ["program.txt"],
        outputs: ["program.txt.generated"],
        commands: [["env", "-S", "sh -c 'cp program.txt program.txt.generated'"]],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  assert.equal(
    prepareMountedAppRelease({ state, appId: "release-app", registryPackages: [] }).checks.find(
      (check) => check.id === "trusted-build-contract",
    )?.detail,
    "build_contract_invalid",
    "env split-string must not recreate a shell command string behind the argv contract",
  );
  writeBuildFixture(appRoot);
  const localPathFixture = ["", "Users", "validation-user", "private", "build"].join("/");
  writeFileSync(join(appRoot, "local-path-example.txt"), `${localPathFixture}\n`, "utf8");
  const opaqueContentRelease = prepareMountedAppRelease({ state, appId: "release-app", registryPackages: [] });
  assert.equal(
    opaqueContentRelease.checks.some((check) => check.id === "portable-package"),
    false,
    "publish preparation must not claim to predict the complete formal package",
  );
  assert.equal(
    opaqueContentRelease.checks.find((check) => check.id === "manifest-and-ui")?.status,
    "passed",
    "opaque App contents must not affect product-level release eligibility",
  );
  rmSync(join(appRoot, "local-path-example.txt"), { force: true });
  rmSync(prepareTarMarker, { force: true });
  const readyRelease = prepareMountedAppRelease({ state, appId: "release-app", registryPackages: [] });
  assert.equal(
    readyRelease.checks.some((check) => check.id === "portable-package"),
    false,
  );
  if (process.platform !== "win32") {
    assert.equal(
      existsSync(prepareTarMarker),
      false,
      "opening the publish editor must stream package-safety checks without constructing a tar archive",
    );
  }

  const manifestPath = join(appRoot, "opengrove.app.json");
  const releaseManifest = readFileSync(manifestPath, "utf8");
  mkdirSync(join(appRoot, "ui"), { recursive: true });
  writeFileSync(join(appRoot, "ui", "view.html"), "<main>ready</main>\n", "utf8");
  const excludedUiManifest = JSON.parse(releaseManifest) as Record<string, unknown>;
  excludedUiManifest.ui = {
    surface: "view",
    workspace: "workspace",
    view: { protocol: "mcp-app", entry: "ui/view.html" },
  };
  excludedUiManifest.store = {
    minHostReleaseNumber: 42,
    packExclude: ["ui/**"],
  };
  writeFileSync(manifestPath, `${JSON.stringify(excludedUiManifest, null, 2)}\n`, "utf8");
  const excludedUiRelease = prepareMountedAppRelease({ state, appId: "release-app", registryPackages: [] });
  assert.equal(
    excludedUiRelease.checks.find((check) => check.id === "manifest-and-ui")?.status,
    "blocked",
    "a user packExclude that removes the required UI entry must remain an immediate local blocker",
  );
  assert.match(
    excludedUiRelease.checks.find((check) => check.id === "manifest-and-ui")?.detail ?? "",
    /pack_ui_entry_excluded:ui\.entry:ui\/view\.html/u,
  );
  writeFileSync(manifestPath, releaseManifest, "utf8");

  const formalVersions: AppStoreFormalVersion[] = [];
  const draftStore = localAppDraftStore(state);
  let versionListCalls = 0;
  const releaseArtifacts = new Map([
    [
      "0.1.0",
      {
        commitSha: "a".repeat(40),
        archiveSha256: "1".repeat(64),
        archiveSize: 12_345,
      },
    ],
    [
      "0.2.0",
      {
        commitSha: "b".repeat(40),
        archiveSha256: "2".repeat(64),
        archiveSize: 23_456,
      },
    ],
    [
      "0.3.0",
      {
        commitSha: "c".repeat(40),
        archiveSha256: "3".repeat(64),
        archiveSize: 34_567,
      },
    ],
    [
      "0.4.0",
      {
        commitSha: "d".repeat(40),
        archiveSha256: "4".repeat(64),
        archiveSize: 45_678,
      },
    ],
    [
      "0.5.0",
      {
        commitSha: "e".repeat(40),
        archiveSha256: "5".repeat(64),
        archiveSize: 56_789,
      },
    ],
    [
      "0.6.0",
      {
        commitSha: "f".repeat(40),
        archiveSha256: "6".repeat(64),
        archiveSize: 67_890,
      },
    ],
    [
      "0.6.2",
      {
        commitSha: "6".repeat(40),
        archiveSha256: "a".repeat(64),
        archiveSize: 70_602,
      },
    ],
    [
      "0.6.3",
      {
        commitSha: "5".repeat(40),
        archiveSha256: "b".repeat(64),
        archiveSize: 70_603,
      },
    ],
    [
      "0.6.4",
      {
        commitSha: "4".repeat(40),
        archiveSha256: "c".repeat(64),
        archiveSize: 70_604,
      },
    ],
    [
      "0.7.0",
      {
        commitSha: "7".repeat(40),
        archiveSha256: "7".repeat(64),
        archiveSize: 78_901,
      },
    ],
    [
      "0.7.1",
      {
        commitSha: "1".repeat(40),
        archiveSha256: "d".repeat(64),
        archiveSize: 78_902,
      },
    ],
    [
      "0.7.2",
      {
        commitSha: "2".repeat(40),
        archiveSha256: "e".repeat(64),
        archiveSize: 78_903,
      },
    ],
    [
      "0.8.0",
      {
        commitSha: "8".repeat(40),
        archiveSha256: "8".repeat(64),
        archiveSize: 89_012,
      },
    ],
    [
      "0.9.0",
      {
        commitSha: "9".repeat(40),
        archiveSha256: "9".repeat(64),
        archiveSize: 90_123,
      },
    ],
  ]);
  const registerVersion = (version: string) => {
    if (formalVersions.some((item) => item.version === version)) return;
    const artifact = releaseArtifacts.get(version)!;
    formalVersions.unshift({
      packageKey: "opengrove.release-app",
      packageId: "release-app",
      appId: "release-app",
      title: "Release App",
      version,
      publishedBy: "Admin",
      publishedAt: "2026-07-30T00:00:00Z",
      releaseCommitSha: artifact.commitSha,
      releaseNotes: `${version} release`,
      artifactSource: "github-release",
      archiveName: `release-app-${version}.tgz`,
      archiveSize: artifact.archiveSize,
      archiveSha256: artifact.archiveSha256,
      minHostReleaseNumber: 0,
      availability: "available",
      downloadReference: `/v1/app-store/packages/opengrove.release-app/versions/${version}/archive`,
    });
  };
  const registry: AppReleaseRegistryAccess = {
    listVersions: async () => {
      versionListCalls += 1;
      if (versionListCalls === 1) {
        const releaseSavePoint = draftStore.read(target.localAppId)?.savePoint?.commitSha;
        assert.ok(releaseSavePoint, "publishing must freeze the editable App at a local Git save point");
        assert.match(releaseSavePoint, /^[a-f0-9]{40}$/u);
        assert.equal(
          draftStore.read(target.localAppId)?.employees[0]?.contextTokenBudget,
          200_000,
          "the publish action must atomically save current employee defaults before the first remote read",
        );
        writeFileSync(join(appRoot, "program.txt"), "edit made after release save point\n", "utf8");
      }
      return structuredClone(formalVersions);
    },
    importVersion: async () => {
      throw new Error("apply=false must not download or activate the formal package");
    },
  };

  const remote = remoteFixture(registerVersion, releaseArtifacts);
  const coordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: remote.client,
  });
  const firstRelease = releaseSubmission("0.1.0", 200_000);
  const advancePublishBase = draftStore.advancePublishBaseIfContentUnchanged.bind(draftStore);
  let rejectNextPublishBaseAdvance = true;
  draftStore.advancePublishBaseIfContentUnchanged = (input) => {
    if (rejectNextPublishBaseAdvance) {
      rejectNextPublishBaseAdvance = false;
      throw new Error("app_store_publish_draft_changed");
    }
    return advancePublishBase(input);
  };
  rmSync(prepareTarMarker, { force: true });
  await assert.rejects(
    () =>
      coordinator.start({
        release: firstRelease,
        applyToCurrentApp: false,
      }),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError &&
      error.message === "app_store_publish_draft_changed" &&
      error.status === 409 &&
      error.progress?.phase === "registry_ready",
    "a publishBase CAS loss must remain recoverable at registry_ready",
  );
  const firstJournal = new AppReleaseJournalStore(join(appStoreDataRoot(state), "app-release-journals")).read(
    target.localAppId,
  );
  assert.ok(firstJournal?.savePoint, "the durable release journal must retain a local Git save point");
  assert.equal(
    firstJournal?.savePoint?.commitSha,
    draftStore.read(target.localAppId)?.savePoint?.commitSha,
    "the durable release journal must retain the exact local Git save point used for this release",
  );
  assert.equal(
    readFileSync(join(appRoot, "ui", "index.html"), "utf8"),
    "stale fixture output\n",
    "release building must not mutate the live App",
  );
  assert.equal(
    readCanonicalSourceFile(remote.sourceUploads[0]!, "ui/index.html"),
    "fixture source\n",
    "the frozen candidate source must contain the locally built output",
  );
  assert.equal(
    readCanonicalSourceFile(remote.sourceUploads[0]!, "program.txt"),
    "release source\n",
    "publishing must keep using its selected save point when the live App changes afterward",
  );
  assert.equal(
    readFileSync(join(appRoot, "program.txt"), "utf8"),
    "edit made after release save point\n",
    "the later author edit must remain in the live working copy",
  );
  if (process.platform !== "win32") {
    assert.equal(
      tarCreateInvocationCount(prepareTarMarker),
      2,
      "a declared local build creates one recoverable prebuild draft and one authoritative postbuild draft, but no formal package",
    );
  }
  assert.equal(coordinator.readProgress()?.phase, "registry_ready");
  const first = await coordinator.resume();
  assert.equal(first.state, "published");
  assert.equal(first.phase, "local_finalized");
  assert.deepEqual(remote.createBodies[0]?.publishBase, {
    releaseCommitSha: "",
    version: "",
    archiveSha256: "",
  });
  assert.equal(remote.createBodies[0]?.minHostReleaseNumber, 42);
  assert.ok(remote.sourceUploads[0]?.byteLength);
  assert.equal(remote.lookupKeys[0], remote.createBodies[0]?.idempotencyKey);
  const firstDraft = draftStore.read(target.localAppId);
  assert.equal(firstDraft?.employees[0]?.contextTokenBudget, 200_000);
  assert.deepEqual(firstDraft?.publishBase, {
    packageKey: "opengrove.release-app",
    version: "0.1.0",
    releaseCommitSha: "a".repeat(40),
    archiveSha256: "1".repeat(64),
  });
  assert.equal(readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"), "business data\n");

  const second = await coordinator.start({
    release: releaseSubmission("0.2.0", 200_000),
    applyToCurrentApp: true,
  });
  assert.equal(second.state, "publishing");
  assert.equal(second.remoteStatus, "building");
  assert.equal(
    second.remoteIntentId,
    "intent-2",
    "Host progress must carry the durable Release Control intent id for safe cross-service correlation",
  );
  assert.deepEqual(
    remote.createBodies[1]?.publishBase,
    {
      version: "0.1.0",
      releaseCommitSha: "a".repeat(40),
      archiveSha256: "1".repeat(64),
    },
    "Release Control publishBase must use its exact three-field public contract",
  );
  assert.equal(Object.prototype.hasOwnProperty.call(remote.createBodies[1]?.publishBase ?? {}, "packageKey"), false);
  const uploadsBeforeReadOnlyRefresh = remote.sourceUploads.length;
  await assert.rejects(
    () =>
      new AppReleaseCoordinator({
        state,
        target,
        registry,
        draftStore,
        client: {
          ...remote.client,
          findById: async () => {
            throw new ReleaseControlClientError(404, "app_release_not_found");
          },
        },
      }).refreshRemoteProgress(),
    (error: unknown) =>
      error instanceof ReleaseControlClientError && error.status === 404 && error.message === "app_release_not_found",
    "a missing known intent must fail closed instead of presenting stale publishing progress",
  );
  const remotelyPublished = await coordinator.refreshRemoteProgress();
  assert.equal(remotelyPublished.phase, "registry_ready");
  assert.equal(
    remote.sourceUploads.length,
    uploadsBeforeReadOnlyRefresh,
    "read-only progress polling must discover the durable intent without replaying its source",
  );
  const newDraft = saveMountedAppDraft({
    state,
    target,
    submission: {
      app: {
        title: "A newer local draft",
        description: "Saved while the remote publish was finishing",
        icon: "",
      },
      employees: firstRelease.employees,
    },
    store: draftStore,
  });
  const beforeResumeArchive = newDraft.archiveSha256;
  await assert.rejects(
    () => coordinator.resume(),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError &&
      error.message === "app_store_publish_draft_changed" &&
      error.progress?.phase === "registry_ready",
  );
  assert.equal(coordinator.readProgress()?.phase, "registry_ready");
  assert.equal(draftStore.read(target.localAppId)?.archiveSha256, beforeResumeArchive);
  assert.equal(draftStore.read(target.localAppId)?.contentDigest, newDraft.contentDigest);
  assert.deepEqual(
    draftStore.read(target.localAppId)?.publishBase,
    firstDraft?.publishBase,
    "the newly saved draft must not be silently rebased after remote Registry success",
  );
  const unavailableAppRoot = `${appRoot}.being-edited`;
  renameSync(appRoot, unavailableAppRoot);
  const preserved = coordinator.resolveKeepLocalChanges();
  renameSync(unavailableAppRoot, appRoot);
  assert.equal(preserved.phase, "local_preserved");
  assert.equal(preserved.state, "published");
  assert.equal(draftStore.read(target.localAppId)?.contentDigest, newDraft.contentDigest);
  assert.deepEqual(
    draftStore.read(target.localAppId)?.publishBase,
    firstDraft?.publishBase,
    "explicitly ending local finalization must preserve the newer draft and its base",
  );
  const secondFormal = formalVersions.find((item) => item.version === "0.2.0");
  assert.ok(secondFormal?.releaseCommitSha);
  draftStore.advancePublishBaseIfContentUnchanged({
    localAppId: target.localAppId,
    expectedContentDigest: newDraft.contentDigest,
    publishBase: {
      packageKey: secondFormal.packageKey,
      version: secondFormal.version,
      releaseCommitSha: secondFormal.releaseCommitSha,
      archiveSha256: secondFormal.archiveSha256,
    },
  });
  const third = await coordinator.start({
    release: releaseSubmission("0.3.0", 200_000),
    applyToCurrentApp: false,
  });
  assert.equal(third.version, "0.3.0");
  assert.equal(third.state, "needs-retry");
  assert.deepEqual(third.allowedActions, ["abandon"]);
  assert.deepEqual(third.buildFailure, {
    stage: "artifact_gate",
    code: "package_manifest_invalid",
    retryable: false,
    workflowRunId: "32824193615",
  });
  assert.equal(remote.createBodies[2]?.version, "0.3.0");
  const sourceUploadsBeforeRetry = remote.sourceUploads.length;
  await assert.rejects(
    () => coordinator.resume({ retryFailedBuild: true }),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError && error.message === "app_store_publish_retry_invalid",
    "deterministic build failures must not be submitted to the same retry path",
  );
  assert.equal(
    remote.sourceUploads.length,
    sourceUploadsBeforeRetry,
    "retrying a durable failed intent must never read or upload the source snapshot again",
  );
  assert.deepEqual(remote.retriedIntentIds, []);
  const abandoned = await coordinator.endBlockedRelease();
  assert.equal(abandoned.state, "closed");
  assert.equal(abandoned.remoteStatus, "abandoned");
  assert.deepEqual(remote.abandonedIntentIds, ["intent-3"]);

  let durableMetadata: ReleaseControlStartMetadata | undefined;
  let durableUploadCount = 0;
  let durableLookupCount = 0;
  let durableCandidateRetryCount = 0;
  const disconnectingClient: AppReleaseRemoteAccess = {
    findByIdempotencyKey: async (idempotencyKey) => {
      durableLookupCount += 1;
      if (!durableMetadata || durableMetadata.idempotencyKey !== idempotencyKey) {
        throw new ReleaseControlClientError(404, "app_release_not_found");
      }
      return intentFixture("intent-after-lost-response", durableMetadata, "awaiting_candidate", releaseArtifacts);
    },
    findById: async (intentId) => {
      assert.equal(intentId, "intent-after-lost-response");
      assert.ok(durableMetadata);
      return intentFixture(intentId, durableMetadata, "awaiting_candidate", releaseArtifacts);
    },
    start: async (record, sourceSnapshot) => {
      durableUploadCount += 1;
      assert.ok(sourceSnapshot.byteLength > 0);
      durableMetadata = releaseControlStartMetadata(record);
      // Release Control has durably persisted this intent, but the Host loses
      // the response before it can record the remote intent id locally.
      throw new ReleaseControlClientError(503, "app_release_request_unavailable", "e".repeat(32));
    },
    retryCandidate: async (intentId) => {
      durableCandidateRetryCount += 1;
      assert.equal(intentId, "intent-after-lost-response");
      assert.ok(durableMetadata);
      registerVersion(durableMetadata.version);
      return intentFixture(intentId, durableMetadata, "published", releaseArtifacts);
    },
    retryBuild: async () => {
      throw new Error("unexpected retry");
    },
    abandon: async () => {
      throw new Error("unexpected abandon");
    },
    finalize: async () => {
      throw new Error("unexpected finalize");
    },
  };
  const disconnectedCoordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: disconnectingClient,
  });
  await assert.rejects(
    () =>
      disconnectedCoordinator.start({
        release: releaseSubmission("0.4.0", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) =>
      error instanceof ReleaseControlClientError && error.message === "app_release_request_unavailable",
    "a lost POST response must leave the local journal recoverable",
  );
  assert.equal(durableUploadCount, 1);
  assert.equal(disconnectedCoordinator.readProgress()?.phase, "draft_saved");

  const restartedCoordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: disconnectingClient,
  });
  const recoveredAfterRestart = await restartedCoordinator.resume();
  assert.equal(recoveredAfterRestart.state, "published");
  assert.equal(recoveredAfterRestart.phase, "local_finalized");
  assert.equal(durableUploadCount, 1, "restart recovery must not upload the source twice");
  assert.equal(durableLookupCount, 2, "the restarted Host must recover the persisted intent by idempotency key");
  assert.equal(durableCandidateRetryCount, 1, "the restarted Host must resume candidate preparation once");

  const secretBlockedClient: AppReleaseRemoteAccess = {
    ...disconnectingClient,
    findByIdempotencyKey: async () => {
      throw new ReleaseControlClientError(404, "app_release_not_found");
    },
    start: async (record) => {
      const metadata = releaseControlStartMetadata(record);
      const rejectedIntent = intentFixture("secret-blocked-intent", metadata, "abandoned", releaseArtifacts);
      throw new ReleaseControlClientError(
        422,
        "app_release_secret_blocked",
        "f".repeat(32),
        "candidate_ref_push",
        undefined,
        rejectedIntent,
      );
    },
  };
  const secretBlockedCoordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: secretBlockedClient,
  });
  await assert.rejects(
    () =>
      secretBlockedCoordinator.start({
        release: releaseSubmission("0.9.0", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) => error instanceof ReleaseControlClientError && error.message === "app_release_secret_blocked",
    "GitHub Push Protection must remain an actionable release error",
  );
  const closedAfterSecretBlock = secretBlockedCoordinator.readProgress();
  assert.equal(closedAfterSecretBlock?.phase, "remote_closed");
  assert.equal(closedAfterSecretBlock?.remoteIntentId, "secret-blocked-intent");
  assert.equal(closedAfterSecretBlock?.remoteStatus, "abandoned");

  const crossDeviceMetadata = new Map<string, ReleaseControlStartMetadata>();
  const crossDeviceStatuses = new Map<string, ReleaseControlIntent["status"]>();
  const crossDeviceAllowedActions = new Map<string, ReleaseControlIntent["allowedActions"]>();
  const startsByVersion = new Map<string, number>();
  let crossDeviceSourceSubmissions = 0;
  let crossDeviceRetries = 0;
  let crossDeviceAbandons = 0;
  const crossDeviceClient: AppReleaseRemoteAccess = {
    findByIdempotencyKey: async () => {
      throw new ReleaseControlClientError(404, "app_release_not_found");
    },
    findById: async (intentId) => {
      const metadata = crossDeviceMetadata.get(intentId);
      if (!metadata) throw new ReleaseControlClientError(404, "app_release_not_found");
      const intent = intentFixture(
        intentId,
        metadata,
        crossDeviceStatuses.get(intentId) ?? "trusted_build_failed",
        releaseArtifacts,
      );
      return {
        ...intent,
        allowedActions: crossDeviceAllowedActions.get(intentId) ?? intent.allowedActions,
      };
    },
    start: async (record) => {
      crossDeviceSourceSubmissions += 1;
      const metadata = releaseControlStartMetadata(record);
      const starts = (startsByVersion.get(metadata.version) ?? 0) + 1;
      startsByVersion.set(metadata.version, starts);
      if (starts === 1) {
        const intentId = `existing-${metadata.version}`;
        const status =
          metadata.version === "0.6.2" || metadata.version === "0.6.3" ? "building" : "trusted_build_failed";
        const allowedActions: ReleaseControlIntent["allowedActions"] =
          status === "building" ? [] : ["retry_build", "abandon"];
        crossDeviceMetadata.set(intentId, metadata);
        crossDeviceStatuses.set(intentId, status);
        crossDeviceAllowedActions.set(intentId, allowedActions);
        throw new ReleaseControlClientError(409, "app_release_in_progress", "a".repeat(32), undefined, {
          id: intentId,
          status,
          packageKey: metadata.packageKey,
          version: metadata.version,
          sourceSha256: metadata.sourceSha256,
          createdAt: "2026-08-18T04:00:00.000Z",
          allowedActions,
        });
      }
      const intentId = `replacement-${metadata.version}`;
      crossDeviceMetadata.set(intentId, metadata);
      crossDeviceStatuses.set(intentId, "published");
      registerVersion(metadata.version);
      return intentFixture(intentId, metadata, "published", releaseArtifacts);
    },
    retryCandidate: async () => {
      throw new Error("unexpected candidate retry");
    },
    retryBuild: async (intentId) => {
      crossDeviceRetries += 1;
      const metadata = crossDeviceMetadata.get(intentId);
      if (!metadata) throw new Error("unknown blocked release");
      crossDeviceStatuses.set(intentId, "building");
      return intentFixture(intentId, metadata, "building", releaseArtifacts);
    },
    abandon: async (intentId) => {
      crossDeviceAbandons += 1;
      const metadata = crossDeviceMetadata.get(intentId);
      if (!metadata) throw new Error("unknown blocked release");
      crossDeviceStatuses.set(intentId, "abandoned");
      return intentFixture(intentId, metadata, "abandoned", releaseArtifacts);
    },
    finalize: async (intentId) => {
      const metadata = crossDeviceMetadata.get(intentId);
      if (!metadata) throw new Error("unknown blocked release");
      crossDeviceStatuses.set(intentId, "published");
      registerVersion(metadata.version);
      return intentFixture(intentId, metadata, "published", releaseArtifacts);
    },
  };
  const crossDeviceCoordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  });
  await assert.rejects(
    () =>
      crossDeviceCoordinator.start({
        release: releaseSubmission("0.5.0", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError &&
      error.message === "app_release_in_progress" &&
      error.progress?.state === "blocked" &&
      error.progress.blockedRelease?.id === "existing-0.5.0" &&
      error.progress.blockedRelease.requestId === "a".repeat(32) &&
      error.progress.blockedRelease.matchesCurrentRequest === true,
    "a cross-device conflict must become a stable local blocked state",
  );
  assert.equal(crossDeviceCoordinator.readProgress()?.state, "blocked");
  assert.equal(crossDeviceSourceSubmissions, 1);

  const restartedBlockedCoordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  });
  assert.equal(
    restartedBlockedCoordinator.readProgress()?.blockedRelease?.id,
    "existing-0.5.0",
    "the adopted remote task must survive a Host restart",
  );
  let preflightedLocalBuilds = 0;
  await assert.rejects(
    () =>
      new AppReleaseCoordinator({
        state,
        target,
        registry,
        draftStore,
        client: crossDeviceClient,
        prepareLocalReleaseBuild: async () => {
          preflightedLocalBuilds += 1;
          throw new Error("unfinished release must be rejected before local build");
        },
      }).start({
        release: releaseSubmission("0.5.1", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError &&
      error.message === "app_store_publish_in_progress" &&
      error.progress?.state === "blocked" &&
      error.progress.blockedRelease?.id === "existing-0.5.0",
    "an unfinished publish journal must be surfaced before saving or rebuilding a different candidate",
  );
  assert.equal(preflightedLocalBuilds, 0);
  const replaced = await restartedBlockedCoordinator.endBlockedRelease();
  assert.equal(replaced.state, "published");
  assert.equal(replaced.version, "0.5.0");
  assert.equal(crossDeviceAbandons, 1);
  assert.equal(crossDeviceSourceSubmissions, 2, "abandoning the old task must start exactly one replacement intent");

  await assert.rejects(
    () =>
      restartedBlockedCoordinator.start({
        release: releaseSubmission("0.6.0", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) => error instanceof AppReleaseCoordinatorError && error.progress?.state === "blocked",
  );
  const submissionsBeforeRetry = crossDeviceSourceSubmissions;
  const retriedBlocked = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).resume({ retryFailedBuild: true });
  assert.equal(retriedBlocked.state, "publishing");
  assert.equal(retriedBlocked.remoteIntentId, "existing-0.6.0");
  assert.equal(crossDeviceRetries, 1);
  assert.equal(
    crossDeviceSourceSubmissions,
    submissionsBeforeRetry,
    "continuing an adopted old task must not create or upload another candidate",
  );
  crossDeviceStatuses.set("existing-0.6.0", "artifact_accepted");
  const acceptedAfterAdoption = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).refreshRemoteProgress();
  assert.equal(acceptedAfterAdoption.remoteStatus, "artifact_accepted");
  const finalizedAfterAdoption = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).resume();
  assert.equal(finalizedAfterAdoption.state, "published");
  assert.equal(finalizedAfterAdoption.phase, "local_finalized");
  assert.equal(
    crossDeviceSourceSubmissions,
    submissionsBeforeRetry,
    "an adopted build must finalize without creating or uploading another candidate",
  );

  await assert.rejects(
    () =>
      restartedBlockedCoordinator.start({
        release: releaseSubmission("0.6.1", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) => error instanceof AppReleaseCoordinatorError && error.progress?.state === "blocked",
  );
  const submissionsBeforeExternalAbandon = crossDeviceSourceSubmissions;
  crossDeviceStatuses.set("existing-0.6.1", "abandoned");
  const externallyAbandoned = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).refreshRemoteProgress();
  assert.equal(externallyAbandoned.state, "closed");
  assert.equal(externallyAbandoned.phase, "remote_closed");
  assert.equal(
    crossDeviceSourceSubmissions,
    submissionsBeforeExternalAbandon,
    "read-only status refresh must not start current local content after another device abandons the old task",
  );

  await assert.rejects(
    () =>
      restartedBlockedCoordinator.start({
        release: releaseSubmission("0.6.2", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError &&
      error.progress?.state === "blocked" &&
      error.progress.blockedRelease?.allowedActions.length === 0,
    "an active build must not initially expose the end action",
  );
  const submissionsBeforeExpiry = crossDeviceSourceSubmissions;
  crossDeviceAllowedActions.set("existing-0.6.2", ["abandon"]);
  const expiredBlocked = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).refreshRemoteProgress();
  assert.deepEqual(expiredBlocked.blockedRelease?.allowedActions, ["abandon"]);
  assert.equal(
    crossDeviceSourceSubmissions,
    submissionsBeforeExpiry,
    "learning that a task expired must not upload another source snapshot",
  );
  const replacedExpired = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).endBlockedRelease();
  assert.equal(replacedExpired.state, "published");
  assert.equal(replacedExpired.version, "0.6.2");
  assert.equal(
    crossDeviceSourceSubmissions,
    submissionsBeforeExpiry + 1,
    "ending an expired task must create exactly one replacement intent",
  );

  await assert.rejects(
    () =>
      restartedBlockedCoordinator.start({
        release: releaseSubmission("0.6.3", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) => error instanceof AppReleaseCoordinatorError && error.progress?.state === "blocked",
  );
  const submissionsBeforeRemoteProgress = crossDeviceSourceSubmissions;
  crossDeviceStatuses.set("existing-0.6.3", "artifact_accepted");
  const adoptedAccepted = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).refreshRemoteProgress();
  assert.equal(adoptedAccepted.state, "publishing");
  assert.equal(adoptedAccepted.remoteStatus, "artifact_accepted");
  const publishedAfterRemoteProgress = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).resume();
  assert.equal(publishedAfterRemoteProgress.state, "published");
  assert.equal(publishedAfterRemoteProgress.version, "0.6.3");
  assert.equal(
    crossDeviceSourceSubmissions,
    submissionsBeforeRemoteProgress,
    "adopting a remotely advanced task must not upload another source snapshot",
  );

  await assert.rejects(
    () =>
      restartedBlockedCoordinator.start({
        release: releaseSubmission("0.6.4", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) => error instanceof AppReleaseCoordinatorError && error.progress?.state === "blocked",
  );
  const sameSourceDifferentRequest = crossDeviceMetadata.get("existing-0.6.4");
  assert.ok(sameSourceDifferentRequest);
  crossDeviceMetadata.set("existing-0.6.4", {
    ...sameSourceDifferentRequest,
    releaseNotes: "Release notes created on another administrator's device.",
  });
  const differentRequestBlocked = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).refreshRemoteProgress();
  assert.equal(differentRequestBlocked.blockedRelease?.matchesCurrentSource, true);
  assert.equal(differentRequestBlocked.blockedRelease?.matchesCurrentRequest, false);
  assert.deepEqual(
    differentRequestBlocked.blockedRelease?.allowedActions,
    ["abandon"],
    "the same source with different release metadata must not expose retry actions",
  );
  await assert.rejects(
    () =>
      new AppReleaseCoordinator({
        state,
        target,
        registry,
        draftStore,
        client: crossDeviceClient,
      }).resume({ retryFailedBuild: true }),
    (error: unknown) =>
      error instanceof ReleaseControlClientError && error.message === "app_release_response_identity_mismatch",
    "a task created from different release metadata must not be resumed as the current request",
  );
  const replacedDifferentRequest = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).endBlockedRelease();
  assert.equal(replacedDifferentRequest.state, "published");
  assert.equal(replacedDifferentRequest.version, "0.6.4");

  await assert.rejects(
    () =>
      restartedBlockedCoordinator.start({
        release: releaseSubmission("0.7.0", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) => error instanceof AppReleaseCoordinatorError && error.progress?.state === "blocked",
  );
  crossDeviceStatuses.set("existing-0.7.0", "published");
  registerVersion("0.7.0");
  const externallyPublished = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).refreshRemoteProgress();
  assert.equal(externallyPublished.state, "registry-ready");
  assert.equal(externallyPublished.phase, "registry_ready");
  const sourceSubmissionsBeforeFinalization = crossDeviceSourceSubmissions;
  const externallyPublishedFinalized = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: crossDeviceClient,
  }).resume();
  assert.equal(externallyPublishedFinalized.state, "published");
  assert.equal(externallyPublishedFinalized.phase, "local_finalized");
  assert.equal(
    crossDeviceSourceSubmissions,
    sourceSubmissionsBeforeFinalization,
    "finalizing an adopted published task must not create or upload another candidate",
  );

  let structuredLookupUnavailable = true;
  const transientConflictClient: AppReleaseRemoteAccess = {
    ...crossDeviceClient,
    findById: async (intentId) => {
      if (structuredLookupUnavailable) {
        throw new ReleaseControlClientError(503, "release_control_dependency_unavailable");
      }
      return crossDeviceClient.findById(intentId);
    },
    start: async (record, source) => {
      const metadata = releaseControlStartMetadata(record);
      if (structuredLookupUnavailable) {
        throw new ReleaseControlClientError(409, "app_release_in_progress", "e".repeat(32), undefined, {
          id: `transient-${metadata.version}`,
          status: "building",
          packageKey: metadata.packageKey,
          version: metadata.version,
          sourceSha256: metadata.sourceSha256,
          createdAt: "2026-08-18T04:00:00.000Z",
          allowedActions: [],
        });
      }
      assert.equal(source.length, metadata.sourceSize);
      registerVersion(metadata.version);
      return intentFixture("replacement-after-transient-conflict", metadata, "published", releaseArtifacts);
    },
  };
  const transientConflictCoordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: transientConflictClient,
  });
  await assert.rejects(
    () =>
      transientConflictCoordinator.start({
        release: releaseSubmission("0.7.1", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) =>
      error instanceof ReleaseControlClientError &&
      error.status === 503 &&
      error.message === "release_control_dependency_unavailable",
    "a temporary structured-conflict lookup failure must stay retryable",
  );
  assert.equal(
    transientConflictCoordinator.readProgress()?.phase,
    "draft_saved",
    "a temporary lookup failure must not be persisted as an opaque ownership conflict",
  );
  structuredLookupUnavailable = false;
  const publishedAfterTransientConflict = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: transientConflictClient,
  }).resume();
  assert.equal(publishedAfterTransientConflict.state, "published");
  assert.equal(publishedAfterTransientConflict.version, "0.7.1");

  let legacyStructuredConflictActive = true;
  let legacyStructuredConflictStarts = 0;
  const legacyStructuredConflictClient: AppReleaseRemoteAccess = {
    ...crossDeviceClient,
    findById: async (intentId) => {
      if (intentId === "legacy-hidden-release") {
        throw new ReleaseControlClientError(404, "app_release_not_found");
      }
      return crossDeviceClient.findById(intentId);
    },
    start: async (record) => {
      legacyStructuredConflictStarts += 1;
      const metadata = releaseControlStartMetadata(record);
      if (legacyStructuredConflictActive) {
        throw new ReleaseControlClientError(409, "app_release_in_progress", "f".repeat(32), undefined, {
          id: "legacy-hidden-release",
          status: "building",
          packageKey: metadata.packageKey,
          version: metadata.version,
          sourceSha256: metadata.sourceSha256,
          createdAt: "2026-08-18T04:00:00.000Z",
          allowedActions: [],
        });
      }
      registerVersion(metadata.version);
      return intentFixture("replacement-after-legacy-conflict", metadata, "published", releaseArtifacts);
    },
  };
  const legacyStructuredConflictCoordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: legacyStructuredConflictClient,
  });
  await assert.rejects(
    () =>
      legacyStructuredConflictCoordinator.start({
        release: releaseSubmission("0.7.2", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError &&
      error.message === "app_release_in_progress_unavailable" &&
      error.progress?.phase === "remote_conflict" &&
      error.progress.requestId === "f".repeat(32),
    "an older RC that hides a structured conflict must become an explicit opaque state",
  );
  assert.equal(legacyStructuredConflictStarts, 1, "the 404 compatibility fallback must not resubmit automatically");
  assert.equal(legacyStructuredConflictCoordinator.readProgress()?.phase, "remote_conflict");
  legacyStructuredConflictActive = false;
  const publishedAfterLegacyStructuredConflict = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: legacyStructuredConflictClient,
  }).resume();
  assert.equal(publishedAfterLegacyStructuredConflict.state, "published");
  assert.equal(publishedAfterLegacyStructuredConflict.version, "0.7.2");
  assert.equal(
    legacyStructuredConflictStarts,
    2,
    "only an explicit recheck may submit after the hidden old task is gone",
  );

  let opaqueConflictStarts = 0;
  let opaqueConflictLookups = 0;
  let opaqueConflictActive = true;
  const opaqueConflictClient: AppReleaseRemoteAccess = {
    ...crossDeviceClient,
    findByIdempotencyKey: async () => {
      opaqueConflictLookups += 1;
      throw new ReleaseControlClientError(404, "app_release_not_found");
    },
    start: async (record) => {
      opaqueConflictStarts += 1;
      if (opaqueConflictActive) {
        throw new ReleaseControlClientError(409, "app_release_in_progress", "b".repeat(32));
      }
      const metadata = releaseControlStartMetadata(record);
      registerVersion(metadata.version);
      return intentFixture("replacement-after-opaque-conflict", metadata, "published", releaseArtifacts);
    },
  };
  const opaqueConflictCoordinator = new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: opaqueConflictClient,
  });
  await assert.rejects(
    () =>
      opaqueConflictCoordinator.start({
        release: releaseSubmission("0.8.0", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) =>
      error instanceof AppReleaseCoordinatorError &&
      error.message === "app_release_in_progress_unavailable" &&
      error.progress?.phase === "remote_conflict" &&
      error.progress.state === "blocked" &&
      error.progress.retryable === false &&
      error.progress.requestId === "b".repeat(32) &&
      error.progress.remoteIntentId === undefined &&
      error.progress.blockedRelease === undefined,
    "an unowned conflict must become an opaque stopped state instead of fake publishing",
  );
  assert.equal(opaqueConflictStarts, 1);
  const lookupsBeforeOpaqueRefresh = opaqueConflictLookups;
  const opaqueConflictAfterRestart = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: opaqueConflictClient,
  }).refreshRemoteProgress();
  assert.equal(opaqueConflictAfterRestart.phase, "remote_conflict");
  assert.equal(opaqueConflictAfterRestart.state, "blocked");
  assert.equal(
    opaqueConflictAfterRestart.requestId,
    "b".repeat(32),
    "an opaque conflict must retain only its safe support reference across restart",
  );
  assert.equal(
    opaqueConflictLookups,
    lookupsBeforeOpaqueRefresh,
    "an opaque unowned conflict must not poll an idempotency key that cannot identify the old task",
  );
  opaqueConflictActive = false;
  const publishedAfterOpaqueConflict = await new AppReleaseCoordinator({
    state,
    target,
    registry,
    draftStore,
    client: opaqueConflictClient,
  }).resume();
  assert.equal(publishedAfterOpaqueConflict.state, "published");
  assert.equal(publishedAfterOpaqueConflict.version, "0.8.0");
  assert.equal(opaqueConflictStarts, 2, "an explicit recheck may submit once after the inaccessible old task is gone");

  const remoteStartsBeforeLocalBuildFailure = remote.createBodies.length;
  const expectedLocalBuildFailureDetail = {
    cause: "app_release_local_build_command_failed:2",
    commandIndex: 2,
    argv: [process.execPath, "build.mjs", "--release"],
    argvTruncated: false,
    exitCode: 17,
    stdout: "compiled 3 files\n",
    stderr: "build fixture failed\n",
    stdoutTruncated: false,
    stderrTruncated: true,
  };
  await assert.rejects(
    () =>
      new AppReleaseCoordinator({
        state,
        target,
        registry,
        draftStore,
        client: remote.client,
        prepareLocalReleaseBuild: async () => {
          throw new AppReleaseBuildCommandError(1, {
            argv: [process.execPath, "build.mjs", "--release"],
            exitCode: 17,
            stdout: "compiled 3 files\n",
            stderr: "build fixture failed\n",
            stdoutTruncated: false,
            stderrTruncated: true,
          });
        },
      }).start({
        release: releaseSubmission("0.9.0", 200_000),
        applyToCurrentApp: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppReleaseCoordinatorError);
      assert.equal(error.message, "app_release_local_build_command_failed");
      assert.equal(error.status, 409);
      assert.deepEqual(error.detail, expectedLocalBuildFailureDetail);
      assert.doesNotMatch(error.message, /build fixture failed/u);
      return true;
    },
    "a local build failure must remain a clean, actionable Host error",
  );
  assert.equal(
    remote.createBodies.length,
    remoteStartsBeforeLocalBuildFailure,
    "a local build failure must not create a Release Control intent or upload source",
  );

  process.stdout.write("app release coordinator harness passed\n");
} finally {
  if (previousUserData === undefined) delete process.env[appEnvName("USER_DATA_DIR")];
  else process.env[appEnvName("USER_DATA_DIR")] = previousUserData;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(root, { recursive: true, force: true });
}

function readCanonicalSourceFile(archive: Buffer, expectedPath: string): string | undefined {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return undefined;
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/u, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(text(124, 12).trim() || "0", 8);
    const dataOffset = offset + 512;
    if (path === expectedPath) return tar.subarray(dataOffset, dataOffset + size).toString("utf8");
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

function releaseSubmission(version: string, contextTokenBudget: number) {
  return {
    app: {
      title: "Release App",
      description: "Published through the Git-backed flow",
      icon: "",
    },
    version,
    releaseNotes: `${version} release`,
    visibility: "restricted" as const,
    employees: [
      {
        memberId: "member-app-release-app-writer",
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
      },
    ],
  };
}

function tarCreateInvocationCount(markerPath: string): number {
  if (!existsSync(markerPath)) return 0;
  return readFileSync(markerPath, "utf8")
    .split(/\r?\n/g)
    .map((line) => line.trim().split(/\s+/g)[0] ?? "")
    .filter((firstArgument) => firstArgument.startsWith("-") && firstArgument.includes("c")).length;
}

function remoteFixture(
  registerVersion: (version: string) => void,
  artifacts: Map<
    string,
    {
      commitSha: string;
      archiveSha256: string;
      archiveSize: number;
    }
  >,
): {
  client: AppReleaseRemoteAccess;
  createBodies: ReleaseControlStartMetadata[];
  sourceUploads: Buffer[];
  lookupKeys: string[];
  retriedIntentIds: string[];
  abandonedIntentIds: string[];
} {
  const createBodies: ReleaseControlStartMetadata[] = [];
  const sourceUploads: Buffer[] = [];
  const lookupKeys: string[] = [];
  const retriedIntentIds: string[] = [];
  const abandonedIntentIds: string[] = [];
  const metadataByIntent = new Map<string, ReleaseControlStartMetadata>();
  const statusByIntent = new Map<string, ReleaseControlIntent["status"]>();
  const start = async (record: AppReleaseJournalRecord, sourceSnapshot: Buffer): Promise<ReleaseControlIntent> => {
    const metadata = releaseControlStartMetadata(record);
    createBodies.push(metadata);
    sourceUploads.push(Buffer.from(sourceSnapshot));
    const published = record.release.version === "0.1.0";
    if (published) registerVersion(record.release.version);
    const intentId = `intent-${createBodies.findIndex((item) => item.version === record.release.version) + 1}`;
    metadataByIntent.set(intentId, metadata);
    const status = published ? "published" : record.release.version === "0.3.0" ? "trusted_build_failed" : "building";
    statusByIntent.set(intentId, status);
    return intentFixture(intentId, metadata, status, artifacts);
  };
  return {
    client: {
      findByIdempotencyKey: async (idempotencyKey) => {
        lookupKeys.push(idempotencyKey);
        const entry = [...metadataByIntent.entries()].find(([, value]) => value.idempotencyKey === idempotencyKey);
        if (!entry) {
          throw new ReleaseControlClientError(404, "app_release_not_found");
        }
        const [intentId, metadata] = entry;
        let status = statusByIntent.get(intentId) ?? "awaiting_candidate";
        if (status === "building") {
          status = "published";
          statusByIntent.set(intentId, status);
          registerVersion(metadata.version);
        }
        return intentFixture(intentId, metadata, status, artifacts);
      },
      findById: async (intentId) => {
        const metadata = metadataByIntent.get(intentId);
        if (!metadata) throw new ReleaseControlClientError(404, "app_release_not_found");
        let status = statusByIntent.get(intentId) ?? "awaiting_candidate";
        if (status === "building") {
          status = "published";
          statusByIntent.set(intentId, status);
          registerVersion(metadata.version);
        }
        return intentFixture(intentId, metadata, status, artifacts);
      },
      start,
      retryCandidate: async () => {
        throw new Error("unexpected candidate retry");
      },
      retryBuild: async (intentId) => {
        const metadata = metadataByIntent.get(intentId);
        if (!metadata) throw new Error("unknown release intent");
        retriedIntentIds.push(intentId);
        return intentFixture(intentId, metadata, "trusted_build_failed", artifacts);
      },
      abandon: async (intentId) => {
        const metadata = metadataByIntent.get(intentId);
        if (!metadata) throw new Error("unknown release intent");
        abandonedIntentIds.push(intentId);
        return intentFixture(intentId, metadata, "abandoned", artifacts);
      },
      finalize: async () => {
        throw new Error("unexpected finalize");
      },
    },
    createBodies,
    sourceUploads,
    lookupKeys,
    retriedIntentIds,
    abandonedIntentIds,
  };
}

function writeBuildFixture(rootPath: string): void {
  mkdirSync(join(rootPath, "web"), { recursive: true });
  mkdirSync(join(rootPath, "ui"), { recursive: true });
  writeFileSync(join(rootPath, "web", "index.html"), "fixture source\n", "utf8");
  writeFileSync(join(rootPath, "ui", "index.html"), "stale fixture output\n", "utf8");
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

function intentFixture(
  id: string,
  metadata: ReleaseControlStartMetadata,
  status: ReleaseControlIntent["status"],
  artifacts: Map<
    string,
    {
      commitSha: string;
      archiveSha256: string;
      archiveSize: number;
    }
  >,
): ReleaseControlIntent {
  const artifact = artifacts.get(metadata.version)!;
  const complete = status === "published";
  return {
    id,
    status,
    allowedActions:
      status === "awaiting_candidate"
        ? ["retry_candidate"]
        : status === "building"
          ? ["retry_build"]
          : status === "trusted_build_failed"
            ? metadata.version === "0.3.0"
              ? ["abandon"]
              : ["retry_build", "abandon"]
            : [],
    ...metadata,
    ...(complete
      ? {
          candidateSha: artifact.commitSha,
          gatedArchiveName: `release-app-${metadata.version}.tgz`,
          gatedArchiveSha256: artifact.archiveSha256,
          gatedArchiveSize: artifact.archiveSize,
          publishedAt: "2026-07-30T00:01:00Z",
        }
      : {}),
    publishedByUserId: 1,
    createdAt: "2026-07-30T00:00:00Z",
    ...(status === "trusted_build_failed" && metadata.version === "0.3.0"
      ? {
          buildFailure: {
            stage: "artifact_gate" as const,
            code: "package_manifest_invalid",
            retryable: false,
            workflowRunId: "32824193615",
          },
        }
      : {}),
  };
}
