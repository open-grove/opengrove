import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvName } from "../identity.js";
import { packAppStoreArchive } from "../server/app-store.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import {
  activeMountedAppRuns,
  forceStopMountedAppRuns,
  inspectMountedAppVersionStatus,
  mountedAppWorkingDigest,
} from "../server/app-version-manager.js";
import { resolveMountedAppTarget } from "../server/mounted-apps.js";
import { scheduleRoomAssistantRunsWithExecutor } from "../server/room-runs/scheduler.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-app-version-manager-"));
const appRoot = join(tempRoot, "apps", "versioned-app");
const previousUserData = process.env[appEnvName("USER_DATA_DIR")];

try {
  process.env[appEnvName("USER_DATA_DIR")] = join(tempRoot, "user-data");
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "versioned-app",
        title: "Versioned App",
        version: "1.0.0",
        ui: { surface: "none", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: {
          packageKey: "team.versioned-app",
          employeeDefaults: [
            {
              memberId: "member-app-versioned-app-worker",
              name: "Worker",
              role: "Works.",
              kernel: "codex",
              model: "native",
              color: "#2563eb",
              availableSkillIds: [],
              defaultSkillIds: [],
              visibility: "private",
              publicSkills: [],
            },
          ],
        },
        employees: [
          {
            id: "worker",
            name: "Worker",
            role: "Works.",
            kernel: "codex",
            model: "native",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(appRoot, "program.txt"), "formal program\n", "utf8");
  writeFileSync(join(appRoot, "workspace", "keep.md"), "runtime data\n", "utf8");

  const formalArchive = packAppStoreArchive({ appRoot, allowSetup: true });
  writeFileSync(
    join(appRoot, ".opengrove-package-manifest.json"),
    `${JSON.stringify(formalArchive.packageManifest, null, 2)}\n`,
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
        archiveSha256: formalArchive.archiveSha256,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const state = createBridgeState({ statePath: join(tempRoot, "state.json") });
  state.settings.mountedApps = [
    {
      id: "versioned-app",
      path: appRoot,
      enabled: true,
      title: "Versioned App",
    },
  ];
  recreateBridgeApp(state);
  const target = resolveMountedAppTarget(state, "versioned-app");
  assert.ok(target);
  const clean = inspectMountedAppVersionStatus({
    state,
    target,
    versions: [],
  });
  assert.equal(clean.activeContent, "formal");
  assert.equal(clean.selectedVersion?.version, "1.0.0");
  assert.equal(clean.hasUnsavedChanges, false);

  writeFileSync(join(appRoot, "program.txt"), "unsaved program\n", "utf8");
  const dirty = inspectMountedAppVersionStatus({
    state,
    target: resolveMountedAppTarget(state, "versioned-app")!,
    versions: [],
  });
  assert.equal(dirty.hasUnsavedChanges, true);
  const savedDraftDigest = mountedAppWorkingDigest(state, resolveMountedAppTarget(state, "versioned-app")!);
  const savedDraft = inspectMountedAppVersionStatus({
    state,
    target: resolveMountedAppTarget(state, "versioned-app")!,
    localDraft: {
      schemaVersion: 1,
      localAppId: "versioned-app",
      appId: "versioned-app",
      savedAt: "2026-07-29T12:00:00.000Z",
      archiveSha256: "a".repeat(64),
      archiveSize: 1,
      contentDigest: savedDraftDigest,
      workingContentDigest: savedDraftDigest,
      employees: [],
    },
    versions: [],
  });
  assert.equal(
    savedDraft.hasUnsavedChanges,
    false,
    "content already persisted in the one local draft is not an unsaved change",
  );
  const savedCandidateFromWorkingTree = inspectMountedAppVersionStatus({
    state,
    target: resolveMountedAppTarget(state, "versioned-app")!,
    localDraft: {
      schemaVersion: 1,
      localAppId: "versioned-app",
      appId: "versioned-app",
      savedAt: "2026-07-29T12:01:00.000Z",
      archiveSha256: "c".repeat(64),
      archiveSize: 1,
      contentDigest: "d".repeat(64),
      workingContentDigest: savedDraftDigest,
      employees: [],
    },
    versions: [],
  });
  assert.equal(
    savedCandidateFromWorkingTree.hasUnsavedChanges,
    false,
    "saving release-page defaults must also remember the exact working tree they were prepared from",
  );

  const worker = state.app.rooms.listMembers().find((member) => member.appId === "versioned-app");
  assert.ok(worker);
  const room = state.app.rooms.createRoom({
    id: "version-switch-room",
    title: "Version switch",
    memberIds: [worker.id],
  });
  const posted = state.app.rooms.postUserMessage({
    roomId: room.id,
    text: "keep running",
    targetIds: [worker.id],
    assistantTargets: [worker],
  });
  const scheduled = scheduleRoomAssistantRunsWithExecutor(
    state,
    {
      roomId: room.id,
      triggerMessageId: posted.userMessage.id,
      targets: [worker],
      assistantMessages: posted.assistantMessages,
    },
    async (runState, input) => {
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      runState.app.rooms.updateMessage(input.roomId, input.assistantMessageId, {
        status: "interrupted",
        finishedAt: new Date().toISOString(),
      });
    },
  );
  assert.equal(scheduled.length, 1);
  assert.equal(activeMountedAppRuns(state, "versioned-app").length, 1);
  const stopped = await forceStopMountedAppRuns(state, "versioned-app", 2_000);
  assert.equal(stopped.stopped, true);
  assert.equal(activeMountedAppRuns(state, "versioned-app").length, 0);

  process.stdout.write("app version manager harness passed\n");
} finally {
  if (previousUserData === undefined) delete process.env[appEnvName("USER_DATA_DIR")];
  else process.env[appEnvName("USER_DATA_DIR")] = previousUserData;
  rmSync(tempRoot, { recursive: true, force: true });
}
