import assert from "node:assert/strict";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { appEnvName } from "../identity.js";
import { snapshotPersistedAgentState } from "../storage/json-state-store.js";
import { beginAppProgramActivationRecovery } from "../server/app-program-activation-recovery.js";
import {
  appVersionActivationJournalRoot,
  appVersionActivationJournalKey,
  beginAppVersionActivationJournal,
  commitAppVersionActivationJournal,
  listAppVersionActivationJournals,
} from "../server/app-version-activation-journal.js";
import { appStoreDataRoot } from "../server/app-store.js";
import { createBridgeState, recreateBridgeApp, saveBridgeSettings } from "../server/bridge-state.js";
import { AppRevisionStore, removeManagedAppRevisionCheckpoint } from "../server/app-revision-store.js";
import { MountedAppVersionStateStore } from "../server/app-version-state.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-version-startup-recovery-"));
const appsRoot = join(tempRoot, "apps");
const appRoot = join(appsRoot, "versioned-app");
const statePath = join(tempRoot, "state.sqlite");
const previousUserData = process.env[appEnvName("USER_DATA_DIR")];
const previousAppsDir = process.env[appEnvName("APP_STORE_APPS_DIR")];

try {
  process.env[appEnvName("USER_DATA_DIR")] = join(tempRoot, "user-data");
  process.env[appEnvName("APP_STORE_APPS_DIR")] = appsRoot;
  writeApp(appRoot, "1.0.0", 100_000, "formal v1");
  writeFileSync(join(appRoot, "workspace", "keep.md"), "business data\n", "utf8");
  await git.init({ fs, dir: appRoot, defaultBranch: "main" });

  let state = createBridgeState({ statePath });
  state.settings.mountedApps = [
    {
      id: "local-versioned-app",
      path: appRoot,
      enabled: true,
      title: "Versioned App",
    },
  ];
  recreateBridgeApp(state);
  state.store.saveFrom(state.app);
  saveBridgeSettings(state);

  const revisionTarget = {
    localAppId: "local-versioned-app",
    appRoot,
    workspacePath: "workspace",
  };
  const revisions = new AppRevisionStore(join(appStoreDataRoot(state), "app-revisions"));
  const v1SavePoint = await revisions.ensureWorkingCopy(revisionTarget);
  const v1RevisionCheckpoint = await revisions.captureRecoveryCheckpoint(revisionTarget);

  const versionStore = new MountedAppVersionStateStore(join(appStoreDataRoot(state), "version-state"));
  const v1State = versionStore.write({
    localAppId: "local-versioned-app",
    activeContent: "formal",
    selectedVersion: selectedVersion("1.0.0", "1"),
  });
  const previousAgentState = snapshotPersistedAgentState(state.app, { compactVolatile: false });
  beginAppVersionActivationJournal({
    root: appVersionActivationJournalRoot(appStoreDataRoot(state)),
    kind: "formal",
    localAppId: "local-versioned-app",
    appRoot,
    previousMountedApps: state.settings.mountedApps,
    previousUninstalledStoreAppIds: state.settings.uninstalledStoreAppIds,
    previousAgentState,
    previousVersionState: v1State,
    previousSourceRevision: v1RevisionCheckpoint,
  });
  simulateCompletedProgramSwap(tempRoot, appRoot, "2.0.0", 200_000, "formal v2");
  const interruptedV2SavePoint = await revisions.saveIfChanged({
    ...revisionTarget,
    message: "Interrupted formal v2 activation",
  });
  assert.notEqual(interruptedV2SavePoint.commitSha, v1SavePoint.commitSha);
  versionStore.write({
    localAppId: "local-versioned-app",
    activeContent: "formal",
    selectedVersion: selectedVersion("2.0.0", "2"),
  });
  recreateBridgeApp(state, {
    authoritativeEmployeeConfigAppId: "versioned-app",
  });
  const postJournalRoom = state.app.rooms.createRoom({
    id: "room-created-after-activation-journal",
    title: "Created while activation was in flight",
  });
  state.app.rooms.postUserMessage({
    roomId: postJournalRoom.id,
    text: "this durable message must survive startup rollback",
    targetIds: [],
    assistantTargets: [],
  });
  state.store.saveFrom(state.app);
  await state.store.close?.();

  state = createBridgeState({ statePath });
  assert.equal(readFileSync(join(appRoot, "program.txt"), "utf8"), "formal v1\n");
  assert.equal(readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"), "business data\n");
  assert.equal(workerBudget(state), 100_000);
  assert.equal(
    state.app.rooms
      .snapshot()
      .messages.some(
        (message) =>
          message.roomId === postJournalRoom.id &&
          message.text === "this durable message must survive startup rollback",
      ),
    true,
    "startup rollback must not replace newer durable Rooms with the journal's older whole-state snapshot",
  );
  assert.equal(versionStore.read("local-versioned-app")?.selectedVersion?.version, "1.0.0");
  const recoveredRevision = await revisions.inspect(revisionTarget);
  assert.equal(recoveredRevision.commitSha, v1SavePoint.commitSha);
  assert.equal(recoveredRevision.dirty, false, "startup rollback must restore the revision index with HEAD");
  const recoveredCheckpoint = await revisions.captureRecoveryCheckpoint(revisionTarget);
  assert.equal(recoveredCheckpoint.commitSha, v1RevisionCheckpoint.commitSha);
  assert.equal(
    recoveredCheckpoint.indexSha256,
    v1RevisionCheckpoint.indexSha256,
    "startup rollback must restore the exact pre-activation revision HEAD and index bytes",
  );
  removeManagedAppRevisionCheckpoint({
    revisionsRoot: join(appStoreDataRoot(state), "app-revisions"),
    localAppId: revisionTarget.localAppId,
    checkpoint: recoveredCheckpoint,
  });
  assert.deepEqual(listAppVersionActivationJournals(appVersionActivationJournalRoot(appStoreDataRoot(state))), []);

  const committedPreviousAgentState = snapshotPersistedAgentState(state.app, { compactVolatile: false });
  const committedJournal = beginAppVersionActivationJournal({
    root: appVersionActivationJournalRoot(appStoreDataRoot(state)),
    kind: "formal",
    localAppId: "local-versioned-app",
    appRoot,
    previousMountedApps: state.settings.mountedApps,
    previousUninstalledStoreAppIds: state.settings.uninstalledStoreAppIds,
    previousAgentState: committedPreviousAgentState,
    previousVersionState: versionStore.read("local-versioned-app"),
    previousSourceRevision: await revisions.captureRecoveryCheckpoint(revisionTarget),
  });
  simulateCompletedProgramSwap(tempRoot, appRoot, "2.0.0", 200_000, "formal v2 committed");
  const committedV2SavePoint = await revisions.saveIfChanged({
    ...revisionTarget,
    message: "Committed formal v2 activation",
  });
  versionStore.write({
    localAppId: "local-versioned-app",
    activeContent: "formal",
    selectedVersion: selectedVersion("2.0.0", "2"),
  });
  recreateBridgeApp(state, {
    authoritativeEmployeeConfigAppId: "versioned-app",
  });
  state.store.saveFrom(state.app);
  saveBridgeSettings(state);
  commitAppVersionActivationJournal(committedJournal);
  await state.store.close?.();

  state = createBridgeState({ statePath });
  assert.equal(readFileSync(join(appRoot, "program.txt"), "utf8"), "formal v2 committed\n");
  assert.equal(readFileSync(join(appRoot, "workspace", "keep.md"), "utf8"), "business data\n");
  assert.equal(workerBudget(state), 200_000);
  assert.equal(versionStore.read("local-versioned-app")?.selectedVersion?.version, "2.0.0");
  assert.equal((await revisions.inspect(revisionTarget)).commitSha, committedV2SavePoint.commitSha);
  assert.deepEqual(listAppVersionActivationJournals(appVersionActivationJournalRoot(appStoreDataRoot(state))), []);
  assert.equal(
    existsSync(join(appsRoot, ".opengrove-install-backups")),
    true,
    "the shared backup parent may remain, but committed transaction contents must be gone",
  );
  await state.store.close?.();

  writeFileSync(
    join(
      appVersionActivationJournalRoot(appStoreDataRoot(state)),
      `${appVersionActivationJournalKey("local-versioned-app")}.json`,
    ),
    "{not-json\n",
    "utf8",
  );
  state = createBridgeState({ statePath });
  assert.equal(
    state.settings.mountedApps.find((mountedApp) => mountedApp.id === "local-versioned-app")?.enabled,
    false,
    "a corrupt recovery record must isolate only its mounted App without preventing OpenGrove startup",
  );
  await state.store.close?.();

  process.stdout.write("app version startup recovery harness passed\n");
} finally {
  if (previousUserData === undefined) delete process.env[appEnvName("USER_DATA_DIR")];
  else process.env[appEnvName("USER_DATA_DIR")] = previousUserData;
  if (previousAppsDir === undefined) delete process.env[appEnvName("APP_STORE_APPS_DIR")];
  else process.env[appEnvName("APP_STORE_APPS_DIR")] = previousAppsDir;
  rmSync(tempRoot, { recursive: true, force: true });
}

function simulateCompletedProgramSwap(
  root: string,
  targetAppRoot: string,
  version: string,
  contextTokenBudget: number,
  program: string,
): void {
  const transactionParent = join(root, "apps", ".opengrove-install-transactions");
  mkdirSync(transactionParent, { recursive: true });
  const transactionRoot = mkdtempSync(join(transactionParent, "startup-recovery-"));
  const stagedAppRoot = join(transactionRoot, "next-app");
  writeApp(stagedAppRoot, version, contextTokenBudget, program);
  const recovery = beginAppProgramActivationRecovery({
    kind: "formal",
    appRoot: targetAppRoot,
    transactionRoot,
    stagedAppRoot,
    previousWorkspaceRelativePath: "workspace",
    nextWorkspaceRelativePath: "workspace",
    previousWorkspacePresent: true,
    previousGitPresent: true,
  });
  renameSync(targetAppRoot, recovery.previousAppRoot);
  rmSync(join(stagedAppRoot, "workspace"), { recursive: true, force: true });
  renameSync(join(recovery.previousAppRoot, "workspace"), join(stagedAppRoot, "workspace"));
  renameSync(join(recovery.previousAppRoot, ".git"), join(stagedAppRoot, ".git"));
  renameSync(stagedAppRoot, targetAppRoot);
}

function writeApp(root: string, version: string, contextTokenBudget: number, program: string): void {
  mkdirSync(join(root, "workspace"), { recursive: true });
  writeFileSync(
    join(root, "opengrove.app.json"),
    `${JSON.stringify(
      {
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
              name: "Worker",
              role: `Works in ${version}.`,
              kernel: "claude-code",
              model: "deepseek-v4-pro",
              reasoningEffort: "high",
              contextTokenBudget,
              accessMode: "default",
              visibility: "private",
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
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(root, "program.txt"), `${program}\n`, "utf8");
}

function selectedVersion(version: string, digit: string) {
  return {
    packageKey: "team.versioned-app",
    version,
    archiveSha256: digit.repeat(64),
    releaseCommitSha: digit.repeat(40),
  };
}

function workerBudget(state: ReturnType<typeof createBridgeState>): number | undefined {
  return state.app.rooms.listMembers().find((member) => member.id === "member-app-versioned-app-worker")
    ?.contextTokenBudget;
}
