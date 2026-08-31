import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { appEnvName } from "../identity.js";
import { appCandidateContentDigest } from "../server/app-content-digest.js";
import { mountedAppWorkingDigest } from "../server/app-version-manager.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import type { BridgeState } from "../server/bridge-types.js";
import { extractAppStoreAppArchive, packAppStoreArchive } from "../server/app-store.js";
import { MountedAppVersionStateStore } from "../server/app-version-state.js";
import { LocalAppDraftStore } from "../server/local-app-drafts.js";
import { localAppDraftStore, saveMountedAppDraft } from "../server/mounted-app-draft-service.js";
import { resolveMountedAppTarget } from "../server/mounted-apps.js";
import { handleAppStoreRoute } from "../server/routes/app-store.js";
import { handleAppsRoute } from "../server/routes/apps.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-local-app-draft-"));
const appRoot = join(tempRoot, "new-local-app");
const userDataRoot = join(tempRoot, "user-data");
const overriddenEnv = {
  [appEnvName("USER_DATA_DIR")]: userDataRoot,
  [appEnvName("BRIDGE_SETTINGS_PATH")]: join(tempRoot, "bridge-settings.json"),
};
const previousEnv = Object.fromEntries(Object.keys(overriddenEnv).map((name) => [name, process.env[name]]));

try {
  Object.assign(process.env, overriddenEnv);
  assert.equal(
    appCandidateContentDigest({
      schemaVersion: 1,
      packageKey: "opengrove.story-seed",
      packageId: "story-seed",
      appId: "story-seed",
      version: "0.2.22",
      workspacePath: "workspace",
      files: {
        "opengrove.app.json": `sha256:${"1".repeat(64)}`,
        "ui/index.html": `sha256:${"2".repeat(64)}`,
      },
      provenance: { commit: "excluded-from-runtime-content-identity" },
    }),
    "744053a273118265258742484b251a57f4c4b0fcd12a4ae97f1e1e9ff9d5f448",
    "draft content identity must use the same canonical package-manifest contract as formal versions",
  );
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "new-local-app",
        title: "New Local App",
        description: "A new App without a package key.",
        icon: "seed",
        ui: { surface: "setup", workspace: "workspace" },
        workspace: { path: "workspace" },
        employees: [
          {
            id: "writer",
            name: "Writer",
            role: "Writes from the local App.",
            kernel: "claude-code",
            model: "claude-code-default",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(appRoot, "source.txt"), "draft program v1\n", "utf8");
  mkdirSync(join(appRoot, "assets"), { recursive: true });
  writeFileSync(join(appRoot, "assets", "prompt.txt"), "portable App resource\n", "utf8");
  writeFileSync(join(appRoot, "workspace", "keep.md"), "workspace is runtime data\n", "utf8");

  const state = mountedState(join(tempRoot, "state-before-restart.json"));
  const writerId = "member-app-new-local-app-writer";
  state.app.rooms.patchMember(writerId, {
    name: "Local Writer",
    avatarMode: "upload",
    avatarSeed: "local-writer-seed",
    avatarDataUrl: "data:image/png;base64,aGFybmVzcw==",
    role: "Writes the complete local draft.",
    kernel: "codex",
    model: "deepseek-v4-pro",
    reasoningEffort: "high",
    contextTokenBudget: 200_000,
    accessMode: "full-access",
    color: "#148a47",
    availableSkillIds: ["app:new-local-app/draft-skill"],
    defaultSkillIds: ["app:new-local-app/draft-skill"],
    visibility: "public",
    publicDescription: "Draft employee configuration",
    publicSkills: ["draft writing"],
    inputSpec: "A local prompt",
    outputSpec: "A complete local draft",
    userOverrides: [
      "name",
      "avatarMode",
      "avatarSeed",
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
  state.store.saveFrom(state.app);

  const prepared = await callApps(state, "/apps/new-local-app/draft/prepare", "GET");
  assert.equal(prepared.status, 200);
  assert.equal(prepared.data.release.identity.appId, "new-local-app");
  assert.equal(
    prepared.data.release.app.icon,
    "seed",
    "legacy installed App icon tokens remain part of the prepared draft identity",
  );
  assert.equal(
    prepared.data.release.employees.find((employee: { memberId: string }) => employee.memberId === writerId)
      ?.contextTokenBudget,
    200_000,
    "local draft preparation must use the complete effective employee configuration without WW",
  );
  prepared.data.release.app.title = "New Local App Draft";
  prepared.data.release.employees.find((employee: { memberId: string }) => employee.memberId === writerId).name =
    "Draft Candidate Writer";
  const workingContentDigestBeforeSave = mountedAppWorkingDigest(
    state,
    resolveMountedAppTarget(state, "new-local-app")!,
  );
  const saved = await callApps(state, "/apps/new-local-app/draft", "PUT", {
    app: prepared.data.release.app,
    employees: prepared.data.release.employees,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.ok, true);
  assert.equal(saved.data.draft.localAppId, "new-local-app-mount");
  assert.equal(saved.data.draft.appId, "new-local-app");
  assert.match(saved.data.draft.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(saved.data.draft.workingContentDigest, workingContentDigestBeforeSave);
  assert.notEqual(
    saved.data.draft.workingContentDigest,
    saved.data.draft.contentDigest,
    "release-page-only default changes produce a saved candidate distinct from the active working tree",
  );
  assert.equal(saved.data.draft.publishBase, undefined);
  assert.equal(
    saved.data.draft.employees.find((employee: { memberId: string }) => employee.memberId === writerId)?.name,
    "Draft Candidate Writer",
  );
  assert.equal(
    state.app.rooms.listMembers().find((member) => member.id === writerId)?.name,
    "Local Writer",
    "saving a candidate must not silently activate it",
  );
  assert.equal(
    saved.data.draft.employees.find((employee: { memberId: string }) => employee.memberId === writerId)
      ?.contextTokenBudget,
    200_000,
  );
  const rejectedChangedLegacyIcon = await callApps(state, "/apps/new-local-app/draft", "PUT", {
    app: { ...prepared.data.release.app, icon: "../outside.png" },
    employees: prepared.data.release.employees,
  });
  assert.equal(rejectedChangedLegacyIcon.status, 400);
  assert.equal(rejectedChangedLegacyIcon.data.error, "app_store_release_icon_invalid");
  const draftBeforeConcurrentChange = localAppDraftStore(state).read("new-local-app-mount");
  assert.throws(
    () =>
      saveMountedAppDraft({
        state,
        target: resolveMountedAppTarget(state, "new-local-app")!,
        submission: {
          app: prepared.data.release.app,
          employees: prepared.data.release.employees,
        },
        packArchive: (options) => {
          const archive = packAppStoreArchive(options);
          writeFileSync(join(appRoot, "source.txt"), "changed while saving\n", "utf8");
          return archive;
        },
      }),
    /local_app_draft_working_copy_changed/,
    "a live program-tree change during packing must abort before replacing the saved draft",
  );
  assert.equal(
    localAppDraftStore(state).read("new-local-app-mount")?.contentDigest,
    draftBeforeConcurrentChange?.contentDigest,
  );
  writeFileSync(join(appRoot, "source.txt"), "draft program v1\n", "utf8");

  let staleExpectedDigestPacked = false;
  assert.throws(
    () =>
      saveMountedAppDraft({
        state,
        target: resolveMountedAppTarget(state, "new-local-app")!,
        expectedWorkingContentDigest: "f".repeat(64),
        packArchive: (options) => {
          staleExpectedDigestPacked = true;
          return packAppStoreArchive(options);
        },
      }),
    /local_app_draft_working_copy_changed/,
    "a caller binding a build result to an older working tree must fail before packing",
  );
  assert.equal(staleExpectedDigestPacked, false);

  const explicitPublishBase = {
    packageKey: "team.new-local-app",
    version: "0.2.0",
    releaseCommitSha: "a".repeat(40),
    archiveSha256: "b".repeat(64),
  };
  const explicitlyBasedDraft = saveMountedAppDraft({
    state,
    target: resolveMountedAppTarget(state, "new-local-app")!,
    store: new LocalAppDraftStore(join(tempRoot, "explicit-base-drafts")),
    publishBase: explicitPublishBase,
  });
  assert.deepEqual(
    explicitlyBasedDraft.publishBase,
    explicitPublishBase,
    "a postbuild draft must be able to inherit the prebuild draft's verified publish base exactly",
  );

  const casDraftStore = new LocalAppDraftStore(join(tempRoot, "cas-drafts"));
  const casArchive = packAppStoreArchive({
    appRoot,
    allowSetup: true,
    purpose: "local-draft",
  });
  const casPrebuild = casDraftStore.save({
    localAppId: "new-local-app-mount",
    appId: "new-local-app",
    archive: casArchive,
    employees: [],
  });
  const casConcurrent = casDraftStore.save({
    localAppId: "new-local-app-mount",
    appId: "new-local-app",
    archive: casArchive,
    employees: [],
    publishBase: explicitPublishBase,
  });
  assert.throws(
    () =>
      casDraftStore.save({
        localAppId: "new-local-app-mount",
        appId: "new-local-app",
        archive: casArchive,
        employees: [],
        expectedPrevious: casPrebuild,
      }),
    /app_store_publish_draft_changed/u,
    "a postbuild save must not overwrite a draft record saved during the build",
  );
  assert.deepEqual(
    casDraftStore.read("new-local-app-mount"),
    casConcurrent,
    "the concurrent draft record must remain authoritative after a failed CAS",
  );

  const legacyRecordPath = draftRecordPath("new-local-app-mount");
  const legacyRecord = JSON.parse(readFileSync(legacyRecordPath, "utf8"));
  delete legacyRecord.appId;
  delete legacyRecord.contentDigest;
  writeFileSync(legacyRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");

  const restartedState = mountedState(join(tempRoot, "state-after-restart.json"));
  const loaded = await callApps(restartedState, "/apps/new-local-app/draft", "GET");
  assert.equal(loaded.status, 200);
  assert.equal(loaded.data.draft.localAppId, "new-local-app-mount");
  assert.equal(loaded.data.draft.appId, "new-local-app");
  assert.equal(
    loaded.data.draft.contentDigest,
    saved.data.draft.contentDigest,
    "reading a pre-contentDigest record must derive the canonical package content identity",
  );
  const migratedRecord = JSON.parse(readFileSync(legacyRecordPath, "utf8"));
  assert.equal(migratedRecord.appId, "new-local-app");
  assert.equal(migratedRecord.contentDigest, saved.data.draft.contentDigest);
  assert.equal(
    loaded.data.draft.employees.find((employee: { memberId: string }) => employee.memberId === writerId)
      ?.contextTokenBudget,
    200_000,
  );
  const stableIdentityManifest = JSON.parse(readFileSync(join(appRoot, "opengrove.app.json"), "utf8"));
  stableIdentityManifest.id = "temporarily-renamed-business-app";
  writeFileSync(join(appRoot, "opengrove.app.json"), `${JSON.stringify(stableIdentityManifest, null, 2)}\n`, "utf8");
  const loadedThroughStableMountIdentity = await callApps(restartedState, "/apps/new-local-app-mount/draft", "GET");
  assert.equal(loadedThroughStableMountIdentity.status, 200);
  assert.equal(loadedThroughStableMountIdentity.data.draft.localAppId, "new-local-app-mount");
  assert.equal(loadedThroughStableMountIdentity.data.draft.appId, "new-local-app");
  stableIdentityManifest.id = "new-local-app";
  writeFileSync(join(appRoot, "opengrove.app.json"), `${JSON.stringify(stableIdentityManifest, null, 2)}\n`, "utf8");

  const blockedOpenBeforeFirstPublish = await callApps(restartedState, "/apps/new-local-app/draft/open", "POST");
  assert.equal(blockedOpenBeforeFirstPublish.status, 409);
  assert.equal(blockedOpenBeforeFirstPublish.data.error, "local_app_draft_activation_requires_version_manager");
  assert.equal(
    JSON.parse(readFileSync(join(appRoot, "opengrove.app.json"), "utf8")).title,
    "New Local App",
    "the T2 route must not replace the live App before T4 owns Run stop and activation state",
  );
  activateDraftForHarness(restartedState);
  assert.equal(
    JSON.parse(readFileSync(join(appRoot, "opengrove.app.json"), "utf8")).title,
    "New Local App Draft",
    "the draft candidate App information must be restored before the first formal publish",
  );
  assert.equal(
    existsSync(join(appRoot, ".opengrove-package-manifest.json")),
    false,
    "opening a draft must preserve the absence of formal package metadata",
  );
  assert.equal(
    restartedState.app.rooms.listMembers().find((member) => member.id === writerId)?.name,
    "Draft Candidate Writer",
  );

  const storeMarker = `${JSON.stringify(
    {
      schemaVersion: 1,
      source: "registry",
      packageKey: "team.new-local-app",
      appId: "new-local-app",
      version: "0.1.0",
      archiveSha256: "a".repeat(64),
    },
    null,
    2,
  )}\n`;
  const packageManifest = `${JSON.stringify({ schemaVersion: 1, appId: "new-local-app" }, null, 2)}\n`;
  writeFileSync(join(appRoot, ".opengrove-store-package.json"), storeMarker, "utf8");
  writeFileSync(join(appRoot, ".opengrove-package-manifest.json"), packageManifest, "utf8");
  writeFileSync(join(appRoot, ".git"), "gitdir: /machine-only/repo/worktrees/new-local-app\n", "utf8");
  writeFileSync(join(appRoot, "source.txt"), "unsaved program v2\n", "utf8");
  writeFileSync(join(appRoot, "assets", "prompt.txt"), "unsaved App resource\n", "utf8");
  writeFileSync(join(appRoot, "workspace", "keep.md"), "workspace changed after draft save\n", "utf8");
  const changedManifest = JSON.parse(readFileSync(join(appRoot, "opengrove.app.json"), "utf8"));
  changedManifest.title = "Unsaved Local Title";
  writeFileSync(join(appRoot, "opengrove.app.json"), `${JSON.stringify(changedManifest, null, 2)}\n`, "utf8");
  recreateBridgeApp(restartedState);
  restartedState.app.rooms.patchMember(writerId, {
    name: "Unsaved Writer",
    contextTokenBudget: 64_000,
    userOverrides: ["name", "contextTokenBudget"],
  });
  restartedState.store.saveFrom(restartedState.app);

  const blockedOpen = await callApps(restartedState, "/apps/new-local-app/draft/open", "POST");
  assert.equal(blockedOpen.status, 409);
  assert.equal(readFileSync(join(appRoot, "source.txt"), "utf8"), "unsaved program v2\n");
  activateDraftForHarness(restartedState);
  const openedDraft = await callApps(restartedState, "/apps/new-local-app/draft", "GET");
  assert.equal(openedDraft.data.draft.localAppId, "new-local-app-mount");
  assert.equal(openedDraft.data.draft.appId, "new-local-app");
  assert.equal(readFileSync(join(appRoot, "source.txt"), "utf8"), "draft program v1\n");
  assert.equal(readFileSync(join(appRoot, "assets", "prompt.txt"), "utf8"), "portable App resource\n");
  assert.equal(JSON.parse(readFileSync(join(appRoot, "opengrove.app.json"), "utf8")).title, "New Local App Draft");
  assert.equal(
    readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"),
    "workspace changed after draft save\n",
    "opening a draft must preserve current Workspace runtime data",
  );
  const reopenedWriter = restartedState.app.rooms.listMembers().find((member) => member.id === writerId);
  assert.equal(reopenedWriter?.name, "Draft Candidate Writer");
  assert.equal(reopenedWriter?.avatarMode, "upload");
  assert.equal(reopenedWriter?.avatarSeed, "local-writer-seed");
  assert.equal(reopenedWriter?.avatarDataUrl, "data:image/png;base64,aGFybmVzcw==");
  assert.ok(
    reopenedWriter?.role.startsWith("Writes the complete local draft."),
    "the saved public role should remain the runtime role prefix",
  );
  assert.equal(reopenedWriter?.kernel, "codex");
  assert.equal(reopenedWriter?.model, "deepseek-v4-pro");
  assert.equal(reopenedWriter?.reasoningEffort, "high");
  assert.equal(reopenedWriter?.contextTokenBudget, 200_000);
  assert.equal(reopenedWriter?.accessMode, "full-access");
  assert.equal(reopenedWriter?.color, "#148a47");
  assert.deepEqual(reopenedWriter?.availableSkillIds, ["app:new-local-app/draft-skill"]);
  assert.deepEqual(reopenedWriter?.defaultSkillIds, ["app:new-local-app/draft-skill"]);
  assert.equal(reopenedWriter?.visibility, "public");
  assert.equal(reopenedWriter?.publicDescription, "Draft employee configuration");
  assert.deepEqual(reopenedWriter?.publicSkills, ["draft writing"]);
  assert.equal(reopenedWriter?.inputSpec, "A local prompt");
  assert.equal(reopenedWriter?.outputSpec, "A complete local draft");
  assert.equal(reopenedWriter?.userOverrides, undefined, "opened draft defaults become authoritative");
  const draftMarker = JSON.parse(readFileSync(join(appRoot, ".opengrove-store-package.json"), "utf8"));
  assert.deepEqual(draftMarker, {
    schemaVersion: 1,
    source: "registry",
    packageKey: "team.new-local-app",
    appId: "new-local-app",
    activeContent: "local-draft",
    draftContentDigest: loaded.data.draft.contentDigest,
    selectedVersion: {
      packageKey: "team.new-local-app",
      version: "0.1.0",
      archiveSha256: "a".repeat(64),
    },
  });
  assert.equal(
    existsSync(join(appRoot, ".opengrove-package-manifest.json")),
    false,
    "draft bytes must not retain the formal package-manifest identity",
  );
  assert.equal(
    readFileSync(join(appRoot, ".git"), "utf8"),
    "gitdir: /machine-only/repo/worktrees/new-local-app\n",
    "opening a draft must preserve the machine-local Git worktree link",
  );

  writeFileSync(join(appRoot, "source.txt"), "draft program v2\n", "utf8");
  writeFileSync(join(appRoot, ".env"), "SECRET=must-not-enter-draft\n", "utf8");
  mkdirSync(join(appRoot, "src"), { recursive: true });
  writeFileSync(join(appRoot, "src", "editable.ts"), "export const editable = true;\n", "utf8");
  const manifestWithUntrustedPackExclude = JSON.parse(readFileSync(join(appRoot, "opengrove.app.json"), "utf8"));
  manifestWithUntrustedPackExclude.store = { packExclude: ["src/**"] };
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify(manifestWithUntrustedPackExclude, null, 2)}\n`,
    "utf8",
  );
  mkdirSync(join(appRoot, ".claude"), { recursive: true });
  writeFileSync(
    join(appRoot, ".claude", "auth.json"),
    JSON.stringify({ access_token: "machine-only-claude-session" }),
    "utf8",
  );
  mkdirSync(join(appRoot, ".codex"), { recursive: true });
  writeFileSync(
    join(appRoot, ".codex", "session.json"),
    JSON.stringify({ session: "machine-only-codex-session" }),
    "utf8",
  );
  writeFileSync(join(appRoot, "cookies.json"), JSON.stringify({ cookie: "machine-only-cookie" }), "utf8");
  mkdirSync(join(appRoot, "node_modules", "machine-only"), { recursive: true });
  writeFileSync(join(appRoot, "node_modules", "machine-only", "cache.txt"), "cache\n", "utf8");
  mkdirSync(join(appRoot, "cache"), { recursive: true });
  writeFileSync(join(appRoot, "cache", "runtime.bin"), "runtime cache\n", "utf8");
  mkdirSync(join(appRoot, "assets", "cache"), { recursive: true });
  writeFileSync(join(appRoot, "assets", "cache", "runtime.bin"), "nested runtime cache\n", "utf8");
  const secondSaved = await callApps(restartedState, "/apps/new-local-app/draft", "PUT");
  assert.equal(secondSaved.status, 200);
  assert.notEqual(secondSaved.data.draft.archiveSha256, saved.data.draft.archiveSha256);
  assert.equal(
    secondSaved.data.draft.publishBase,
    undefined,
    "resaving an active pre-release draft must not silently adopt formal provenance as its publish base",
  );
  assert.equal(
    readdirSync(draftArchivesRoot("new-local-app-mount")).length,
    1,
    "replacing a draft should garbage-collect the superseded archive",
  );
  const extractedDraftRoot = join(tempRoot, "extracted-current-draft");
  extractAppStoreAppArchive({
    archivePath: join(draftArchivesRoot("new-local-app-mount"), `${secondSaved.data.draft.archiveSha256}.tgz`),
    targetRoot: extractedDraftRoot,
  });
  assert.equal(readFileSync(join(extractedDraftRoot, "source.txt"), "utf8"), "draft program v2\n");
  assert.equal(readFileSync(join(extractedDraftRoot, "assets", "prompt.txt"), "utf8"), "portable App resource\n");
  assert.equal(
    readFileSync(join(extractedDraftRoot, "src", "editable.ts"), "utf8"),
    "export const editable = true;\n",
    "a local draft must preserve editable source even when the App asks the release packer to exclude it",
  );
  for (const excluded of [
    "workspace",
    ".git",
    ".env",
    "node_modules",
    "cache",
    "assets/cache",
    ".claude",
    ".codex",
    "cookies.json",
    ".opengrove-store-package.json",
  ]) {
    assert.equal(
      existsSync(join(extractedDraftRoot, excluded)),
      false,
      `${excluded} must stay out of the local draft archive`,
    );
  }

  const newerSelectedVersionMarker = `${JSON.stringify(
    {
      schemaVersion: 1,
      source: "registry",
      packageKey: "team.new-local-app",
      appId: "new-local-app",
      version: "0.2.0",
      archiveSha256: "b".repeat(64),
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(appRoot, ".opengrove-store-package.json"), newerSelectedVersionMarker, "utf8");
  const resavedOldDraft = await callApps(restartedState, "/apps/new-local-app/draft", "PUT");
  assert.equal(resavedOldDraft.status, 200);
  assert.equal(
    resavedOldDraft.data.draft.publishBase,
    undefined,
    "saving an existing pre-release draft must not silently adopt the current formal version as its Publish Base",
  );

  const failedCandidateSave = await callApps(restartedState, "/apps/new-local-app/draft", "PUT", {
    app: secondSaved.data.draft.app,
    employees: [],
  });
  assert.equal(failedCandidateSave.status, 409);
  const afterFailedCandidateSave = await callApps(restartedState, "/apps/new-local-app/draft", "GET");
  assert.equal(
    afterFailedCandidateSave.data.draft.archiveSha256,
    resavedOldDraft.data.draft.archiveSha256,
    "an invalid Employee candidate must leave the previous draft current",
  );

  const validManifestText = readFileSync(join(appRoot, "opengrove.app.json"), "utf8");
  writeFileSync(join(appRoot, "opengrove.app.json"), "{ invalid manifest", "utf8");
  const failedSave = await callApps(restartedState, "/apps/new-local-app-mount/draft", "PUT");
  assert.equal(failedSave.status, 409);
  writeFileSync(join(appRoot, "opengrove.app.json"), validManifestText, "utf8");
  const afterFailedSave = await callApps(restartedState, "/apps/new-local-app/draft", "GET");
  assert.equal(
    afterFailedSave.data.draft.archiveSha256,
    resavedOldDraft.data.draft.archiveSha256,
    "a failed save must leave the previous current draft readable",
  );
  assert.equal(readdirSync(draftArchivesRoot("new-local-app-mount")).length, 1);

  const selectedFormalPublishBase = {
    packageKey: "team.new-local-app",
    version: "0.3.0",
    releaseCommitSha: "c".repeat(40),
    archiveSha256: "d".repeat(64),
  };
  new MountedAppVersionStateStore(join(tempRoot, "app-store", "version-state")).write({
    localAppId: "new-local-app-mount",
    activeContent: "formal",
    selectedVersion: selectedFormalPublishBase,
    activeContentDigest: mountedAppWorkingDigest(
      restartedState,
      resolveMountedAppTarget(restartedState, "new-local-app")!,
    ),
  });
  const resavedAfterFormalSelection = await callApps(restartedState, "/apps/new-local-app/draft", "PUT");
  assert.deepEqual(
    resavedAfterFormalSelection.data.draft.publishBase,
    selectedFormalPublishBase,
    "saving while an explicit formal version is active must adopt that exact publish base even when an older draft has identical working content",
  );

  mkdirSync(join(appRoot, "config"), { recursive: true });
  const opaqueConfig = JSON.stringify({
    model_key: "global.anthropic.claude-opus-4-6-v1",
    endpoint: "http://192.168.1.10",
  });
  writeFileSync(join(appRoot, "config", "runtime.json"), opaqueConfig, "utf8");
  const savedWithOpaqueContent = await callApps(restartedState, "/apps/new-local-app/draft", "PUT");
  assert.equal(savedWithOpaqueContent.status, 200);
  assert.notEqual(
    savedWithOpaqueContent.data.draft.archiveSha256,
    resavedAfterFormalSelection.data.draft.archiveSha256,
    "the public draft-save route must treat App file contents as opaque",
  );
  const extractedOpaqueDraftRoot = join(tempRoot, "extracted-opaque-draft");
  extractAppStoreAppArchive({
    archivePath: join(
      draftArchivesRoot("new-local-app-mount"),
      `${savedWithOpaqueContent.data.draft.archiveSha256}.tgz`,
    ),
    targetRoot: extractedOpaqueDraftRoot,
  });
  assert.equal(readFileSync(join(extractedOpaqueDraftRoot, "config", "runtime.json"), "utf8"), opaqueConfig);
  rmSync(join(appRoot, "config", "runtime.json"), { force: true });

  const failedActivationFixture = createDraftSwapFixture("failed-activation");
  symlinkSync(
    join(failedActivationFixture.appRoot, "workspace", "keep.md"),
    join(failedActivationFixture.appRoot, ".git"),
  );
  let injectedWorkspaceReturnFailure = false;
  const failedActivationStore = new LocalAppDraftStore(failedActivationFixture.storeRoot, {
    rename(source, destination) {
      if (
        !injectedWorkspaceReturnFailure &&
        source.includes(`${sep}.opengrove-draft-transactions${sep}`) &&
        destination.includes(`${sep}.opengrove-draft-backups${sep}`) &&
        source.endsWith(`${sep}workspace`) &&
        destination.endsWith(`${sep}workspace`)
      ) {
        injectedWorkspaceReturnFailure = true;
        throw new Error("injected_workspace_return_failure");
      }
      renameSync(source, destination);
    },
  });
  const failedActivationPrepared = failedActivationStore.prepareOpen({
    localAppId: failedActivationFixture.appId,
    appRoot: failedActivationFixture.appRoot,
  });
  assert.deepEqual(
    Object.keys(failedActivationPrepared).sort(),
    ["appId", "appRoot", "localAppId"],
    "the prepared handle must not expose mutable staging or recovery paths",
  );
  assert.equal(Object.isFrozen(failedActivationPrepared), true);
  assert.equal(
    readFileSync(join(failedActivationFixture.appRoot, "source.txt"), "utf8"),
    "currently active program\n",
    "preparing a draft must finish extraction and validation without activating it before Runs stop",
  );
  assert.throws(
    () => failedActivationStore.activatePreparedOpen(failedActivationPrepared),
    /local_app_draft_open_rollback_failed/,
  );
  assert.equal(
    findFileWithContent(failedActivationFixture.parentRoot, "keep.md", "failed activation workspace\n"),
    true,
    "an activation and rollback failure must preserve the only Workspace copy for recovery",
  );
  failedActivationStore.cancelPreparedOpen(failedActivationPrepared);
  assert.equal(
    findFileWithContent(failedActivationFixture.parentRoot, "keep.md", "failed activation workspace\n"),
    true,
    "cancel must never delete a transaction retained for manual recovery",
  );

  const tamperedPreparedFixture = createDraftSwapFixture("tampered-prepared");
  const tamperedPreparedStore = new LocalAppDraftStore(tamperedPreparedFixture.storeRoot);
  const tamperedPrepared = tamperedPreparedStore.prepareOpen({
    localAppId: tamperedPreparedFixture.appId,
    appRoot: tamperedPreparedFixture.appRoot,
  });
  const transactionParent = join(tamperedPreparedFixture.parentRoot, ".opengrove-draft-transactions");
  const [preparedTransactionName] = readdirSync(transactionParent);
  assert.ok(preparedTransactionName);
  writeFileSync(
    join(transactionParent, preparedTransactionName, "next-app", "source.txt"),
    "tampered after preparation\n",
    "utf8",
  );
  assert.throws(
    () => tamperedPreparedStore.activatePreparedOpen(tamperedPrepared),
    /local_app_draft_prepared_content_changed/,
  );
  assert.equal(
    readFileSync(join(tamperedPreparedFixture.appRoot, "source.txt"), "utf8"),
    "currently active program\n",
    "staging tampering must fail before the active App is touched",
  );

  const replacedPreparedFixture = createDraftSwapFixture("replaced-prepared");
  const replacedPreparedStore = new LocalAppDraftStore(replacedPreparedFixture.storeRoot);
  const replacedPrepared = replacedPreparedStore.prepareOpen({
    localAppId: replacedPreparedFixture.appId,
    appRoot: replacedPreparedFixture.appRoot,
  });
  writeFileSync(join(replacedPreparedFixture.appRoot, "source.txt"), "newer saved draft program\n", "utf8");
  replacedPreparedStore.save({
    localAppId: replacedPreparedFixture.appId,
    appId: replacedPreparedFixture.appId,
    archive: packAppStoreArchive({
      appRoot: replacedPreparedFixture.appRoot,
      allowSetup: true,
      purpose: "local-draft",
    }),
    employees: [],
  });
  writeFileSync(join(replacedPreparedFixture.appRoot, "source.txt"), "active program after replacement\n", "utf8");
  assert.throws(
    () => replacedPreparedStore.activatePreparedOpen(replacedPrepared),
    /local_app_draft_target_changed/,
    "a prepared draft must not activate after the one saved draft has been replaced",
  );
  assert.equal(
    readFileSync(join(replacedPreparedFixture.appRoot, "source.txt"), "utf8"),
    "active program after replacement\n",
  );
  replacedPreparedStore.cancelPreparedOpen(replacedPrepared);

  const failedStateRollbackFixture = createDraftSwapFixture("failed-state-rollback");
  writeFileSync(
    join(failedStateRollbackFixture.appRoot, ".git"),
    "gitdir: /machine-only/repo/worktrees/failed-state-rollback\n",
    "utf8",
  );
  let injectedGitReturnFailure = false;
  const failedStateRollbackStore = new LocalAppDraftStore(failedStateRollbackFixture.storeRoot, {
    rename(source, destination) {
      if (
        !injectedGitReturnFailure &&
        source.endsWith(`${sep}failed-app${sep}.git`) &&
        destination.endsWith(`${sep}previous-app${sep}.git`)
      ) {
        injectedGitReturnFailure = true;
        throw new Error("injected_git_return_failure");
      }
      renameSync(source, destination);
    },
  });
  const failedStateRollbackPrepared = failedStateRollbackStore.prepareOpen({
    localAppId: failedStateRollbackFixture.appId,
    appRoot: failedStateRollbackFixture.appRoot,
  });
  assert.equal(
    readFileSync(join(failedStateRollbackFixture.appRoot, "source.txt"), "utf8"),
    "currently active program\n",
  );
  const failedStateRollbackActivation = failedStateRollbackStore.activatePreparedOpen(failedStateRollbackPrepared);
  assert.throws(
    () => failedStateRollbackStore.activatePreparedOpen(failedStateRollbackPrepared),
    /local_app_draft_prepared_invalid/,
    "a prepared transaction must be single-use",
  );
  assert.throws(
    () => failedStateRollbackStore.rollbackOpen(failedStateRollbackActivation),
    /injected_git_return_failure/,
  );
  assert.equal(
    readFileSync(join(failedStateRollbackFixture.appRoot, "workspace", "keep.md"), "utf8"),
    "failed state rollback workspace\n",
    "a failed state rollback must reactivate a complete tree instead of detaching Workspace",
  );

  const publishBaseFixture = createDraftSwapFixture("publish-base-cas");
  const publishBaseStore = new LocalAppDraftStore(publishBaseFixture.storeRoot);
  const publishBaseDraft = publishBaseStore.read(publishBaseFixture.appId)!;
  const firstPublishedBase = {
    packageKey: "opengrove.publish-base-cas",
    version: "0.1.0",
    releaseCommitSha: "a".repeat(40),
    archiveSha256: "b".repeat(64),
  };
  const advancedPublishBase = publishBaseStore.advancePublishBaseIfContentUnchanged({
    localAppId: publishBaseFixture.appId,
    expectedContentDigest: publishBaseDraft.contentDigest,
    publishBase: firstPublishedBase,
  });
  assert.deepEqual(advancedPublishBase.publishBase, firstPublishedBase);
  assert.equal(advancedPublishBase.archiveSha256, publishBaseDraft.archiveSha256);
  assert.equal(
    advancedPublishBase.savedAt,
    publishBaseDraft.savedAt,
    "advancing formal ancestry must not masquerade as a new user draft save",
  );
  writeFileSync(join(publishBaseFixture.appRoot, "source.txt"), "newer local draft after remote publish\n", "utf8");
  const newerDraft = publishBaseStore.save({
    localAppId: publishBaseFixture.appId,
    appId: publishBaseFixture.appId,
    archive: packAppStoreArchive({
      appRoot: publishBaseFixture.appRoot,
      allowSetup: true,
      purpose: "local-draft",
    }),
    employees: [],
    publishBase: firstPublishedBase,
  });
  assert.notEqual(newerDraft.contentDigest, publishBaseDraft.contentDigest);
  assert.throws(
    () =>
      publishBaseStore.advancePublishBaseIfContentUnchanged({
        localAppId: publishBaseFixture.appId,
        expectedContentDigest: publishBaseDraft.contentDigest,
        publishBase: {
          packageKey: firstPublishedBase.packageKey,
          version: "0.2.0",
          releaseCommitSha: "c".repeat(40),
          archiveSha256: "d".repeat(64),
        },
      }),
    /app_store_publish_draft_changed/,
  );
  assert.deepEqual(
    publishBaseStore.read(publishBaseFixture.appId),
    newerDraft,
    "a changed draft must remain byte-for-byte referenced by the old record after CAS refusal",
  );

  const retainedUninstall = await callAppStore(restartedState, "/app-store/uninstall", {
    appId: "new-local-app-mount",
  });
  assert.equal(retainedUninstall.status, 200);
  assert.equal(retainedUninstall.data.uninstall.localDraftDisposition, "retained");
  remount(restartedState);
  const retainedAfterRemount = await callApps(restartedState, "/apps/new-local-app/draft", "GET");
  assert.equal(
    retainedAfterRemount.data.draft.archiveSha256,
    savedWithOpaqueContent.data.draft.archiveSha256,
    "the default uninstall path must retain the local draft",
  );

  const deletedUninstall = await callAppStore(restartedState, "/app-store/uninstall", {
    appId: "new-local-app-mount",
    deleteLocalDraft: true,
  });
  assert.equal(deletedUninstall.status, 200);
  assert.equal(deletedUninstall.data.uninstall.localDraftDisposition, "deleted");
  remount(restartedState);
  const deletedAfterRemount = await callApps(restartedState, "/apps/new-local-app/draft", "GET");
  assert.equal(deletedAfterRemount.status, 404);
  assert.equal(deletedAfterRemount.data.error, "local_app_draft_not_found");

  process.stdout.write("local app draft harness passed\n");
} finally {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

function mountedState(statePath: string): BridgeState {
  const state = createBridgeState({ statePath });
  remount(state);
  return state;
}

function remount(state: BridgeState): void {
  state.settings.mountedApps = [
    {
      id: "new-local-app-mount",
      path: appRoot,
      enabled: true,
      title: "New Local App",
      appBuilderEnabled: true,
    },
  ];
  state.settings.uninstalledStoreAppIds = [];
  recreateBridgeApp(state);
}

async function callApps(
  state: BridgeState,
  path: string,
  method: "GET" | "PUT" | "POST",
  payload: unknown = {},
): Promise<{ status: number; data: any }> {
  const calls: Array<{ status: number; data: any }> = [];
  const handled = await handleAppsRoute({
    request: { method } as any,
    response: {} as any,
    url: new URL(`http://opengrove.test${path}`),
    state,
    sendJson: (_response, status, data) => calls.push({ status, data }),
    readJsonBody: async () => payload,
  });
  assert.equal(handled, true, `route should claim ${path}`);
  assert.ok(calls[0], "route should respond");
  return calls[0];
}

async function callAppStore(
  state: BridgeState,
  path: string,
  payload: unknown,
): Promise<{ status: number; data: any }> {
  const calls: Array<{ status: number; data: any }> = [];
  const handled = await handleAppStoreRoute({
    request: { method: "POST", headers: {} } as any,
    response: {} as any,
    url: new URL(`http://opengrove.test${path}`),
    state,
    sendJson: (_response, status, data) => calls.push({ status, data }),
    readJsonBody: async () => payload,
  });
  assert.equal(handled, true, `route should claim ${path}`);
  assert.ok(calls[0], "route should respond");
  return calls[0];
}

function draftArchivesRoot(localAppId: string): string {
  const key = createHash("sha256").update(localAppId, "utf8").digest("hex");
  return join(tempRoot, "app-store", "local-drafts", key, "archives");
}

function draftRecordPath(localAppId: string): string {
  const key = createHash("sha256").update(localAppId, "utf8").digest("hex");
  return join(tempRoot, "app-store", "local-drafts", key, "current.json");
}

function activateDraftForHarness(state: BridgeState): void {
  const store = new LocalAppDraftStore(join(tempRoot, "app-store", "local-drafts"));
  const prepared = store.prepareOpen({
    localAppId: "new-local-app-mount",
    appRoot,
  });
  const activation = store.activatePreparedOpen(prepared);
  try {
    recreateBridgeApp(state, {
      authoritativeEmployeeConfigAppId: "new-local-app",
      deferPersistedStateSave: true,
    });
    state.store.saveFrom(state.app);
    store.commitOpen(activation);
    store.finalizeOpen(activation);
  } catch (error) {
    store.rollbackOpen(activation);
    throw error;
  }
}

function createDraftSwapFixture(name: string): {
  appId: string;
  appRoot: string;
  parentRoot: string;
  storeRoot: string;
} {
  const appId = `draft-${name}`;
  const parentRoot = join(tempRoot, name);
  const appRoot = join(parentRoot, "app");
  const storeRoot = join(parentRoot, "draft-store");
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: appId,
        title: `Draft ${name}`,
        ui: { surface: "setup", workspace: "workspace" },
        workspace: { path: "workspace" },
        employees: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(appRoot, "source.txt"), "saved draft program\n", "utf8");
  writeFileSync(join(appRoot, "workspace", "keep.md"), `${name.replaceAll("-", " ")} workspace\n`, "utf8");
  const store = new LocalAppDraftStore(storeRoot);
  store.save({
    localAppId: appId,
    appId,
    archive: packAppStoreArchive({ appRoot, allowSetup: true }),
    employees: [],
  });
  writeFileSync(join(appRoot, "source.txt"), "currently active program\n", "utf8");
  return { appId, appRoot, parentRoot, storeRoot };
}

function findFileWithContent(root: string, fileName: string, expected: string): boolean {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (findFileWithContent(path, fileName, expected)) return true;
      continue;
    }
    if (entry.isFile() && entry.name === fileName && readFileSync(path, "utf8") === expected) {
      return true;
    }
  }
  return false;
}
