import crossSpawn from "cross-spawn";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hostCommandSearchPath, resolveHostCommandPath } from "../environment/command-path.js";
import { appPackageExcludedPaths, type AppPackageManifest } from "../app-builder/cli.js";
import {
  canonicalPortableRelativePath,
  portablePathCollisionKey,
  portablePathsOverlap,
} from "../app-builder/portable-path.js";
import { readAppReleaseBuildContract, type AppReleaseBuildRecipe } from "./app-release-build-contract.js";
import { createAppReleaseBuildBudget, type AppReleaseBuildBudget } from "./app-release-build-budget.js";
import {
  appReleaseBuildOutputPlanForOutput,
  copyAppReleaseBuildOutputPlan,
  planAppReleaseBuildOutputs,
  sameAppReleaseBuildOutputPlan,
  type AppReleaseBuildOutputPlan,
} from "./app-release-build-output.js";
import { materializeAppReleaseDraftTree } from "./app-release-draft-tree.js";
import type { MountedAppReleaseDraft } from "./app-release.js";
import {
  appStoreDataRoot,
  appStoreInstallContainerRoot,
  assertAppStorePublishTargetSnapshotUnchanged,
  captureAppStoreTargetSnapshot,
  withAppStoreInstallLock,
  type AppStorePublishTargetSnapshot,
} from "./app-store.js";
import { appVersionActivationJournalRoot, listAppVersionActivationJournals } from "./app-version-activation-journal.js";
import { mountedAppWorkingManifest, mountedAppWorkingPackageManifestForRoot } from "./app-version-manager.js";
import { appCandidateContentDigest } from "./app-content-digest.js";
import type { OpenGroveAppManifest } from "../app-builder/manifest.js";
import { appReleaseSourcePathExcluded } from "./app-release-source-exclusions.js";
import type { BridgeState } from "./bridge-types.js";
import type { LocalAppDraftSavePoint, LocalAppDraftStore, LocalAppDraftSummary } from "./local-app-drafts.js";
import {
  appRevisionStore,
  mountedAppRevisionTarget,
  saveMountedAppDraft,
  saveMountedAppDraftForRelease,
} from "./mounted-app-draft-service.js";
import { readMountedAppManifest, type MountedAppTarget } from "./mounted-apps.js";

const MAX_BUILD_LOG_BYTES = 64 * 1024;
const MAX_BUILD_DIAGNOSTIC_ARGUMENTS = 64;
const MAX_BUILD_DIAGNOSTIC_ARGV_CHARACTERS = 8 * 1024;
const activeReleaseBuilds = new Set<string>();

export interface AppReleaseInstallGenerationFence {
  installContainerRoot: string;
  appRootSnapshot: AppStorePublishTargetSnapshot;
  mountedPath: string;
  mountedWorkspacePath?: string;
  programGenerations?: string[];
}

export interface AppReleaseManifestSnapshot {
  path: string;
  bytes: Buffer;
  fingerprint: {
    dev: number;
    ino: number;
    mode: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  };
}

export interface AppReleaseWorkingCopyFence {
  source: "live" | "save-point";
  manifest?: AppReleaseManifestSnapshot;
  savePointCommitSha?: string;
  digest: string;
  fileModes: Record<string, number>;
}

export interface AppReleaseBuildCommandResult {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface AppReleaseBuildCommandFailureDiagnostic extends AppReleaseBuildCommandResult {
  commandIndex: number;
  argvTruncated: boolean;
}

export class AppReleaseBuildCommandError extends Error {
  readonly diagnostic: AppReleaseBuildCommandFailureDiagnostic;

  constructor(commandIndex: number, result: AppReleaseBuildCommandResult) {
    super(`app_release_local_build_command_failed:${commandIndex + 1}`);
    this.name = "AppReleaseBuildCommandError";
    const diagnosticArgv = boundedDiagnosticArgv(result.argv);
    const diagnosticStdout = boundedDiagnosticText(result.stdout, result.stdoutTruncated);
    const diagnosticStderr = boundedDiagnosticText(result.stderr, result.stderrTruncated);
    this.diagnostic = {
      commandIndex: commandIndex + 1,
      argv: diagnosticArgv.argv,
      argvTruncated: diagnosticArgv.truncated,
      exitCode: result.exitCode,
      stdout: diagnosticStdout.text,
      stderr: diagnosticStderr.text,
      stdoutTruncated: diagnosticStdout.truncated,
      stderrTruncated: diagnosticStderr.truncated,
    };
  }
}

export interface AppReleaseBuildResult {
  commands: AppReleaseBuildCommandResult[];
  outputs: string[];
}

export interface PreparedMountedAppReleaseBuild {
  draft: LocalAppDraftSummary;
  build: AppReleaseBuildResult;
}

export function saveMountedAppReleasePrebuildDraft(input: {
  state: BridgeState;
  target: MountedAppTarget;
  submission: unknown;
  draftStore: LocalAppDraftStore;
  savePoint?: LocalAppDraftSavePoint;
  sourceRootOverride?: string;
}): {
  draft: LocalAppDraftSummary;
  installFence: AppReleaseInstallGenerationFence;
  workingCopyFence: AppReleaseWorkingCopyFence;
} {
  const installContainerRoot = appStoreInstallContainerRoot(input.target.appRoot, input.target.id);
  return withReleaseInstallGenerationLock({ installContainerRoot }, () => {
    const installFence = captureReleaseInstallGenerationUnlocked(input.state, input.target, installContainerRoot);
    const frozenSource = Boolean(input.sourceRootOverride);
    const sourceRoot = input.sourceRootOverride ?? input.target.appRoot;
    const manifestSnapshot = frozenSource ? undefined : captureLiveManifestSnapshot(input.target.appRoot);
    if (!frozenSource) assertTargetManifestMatchesDisk(input.target);
    const workingState = appWorkingTreeStateForRoot(
      sourceRoot,
      mountedAppWorkingManifest(input.state, input.target),
      nonExpiringBuildBudget(),
    );
    const draft = saveMountedAppDraft({
      state: input.state,
      target: input.target,
      submission: input.submission,
      store: input.draftStore,
      ...(frozenSource ? { appRootOverride: sourceRoot, workingContentDigestOverride: workingState.digest } : {}),
      ...(input.savePoint ? { savePoint: input.savePoint } : {}),
    });
    if (manifestSnapshot) assertLiveManifestSnapshotUnchanged(input.target.appRoot, manifestSnapshot);
    const savedWorkingState = appWorkingTreeStateForRoot(
      sourceRoot,
      mountedAppWorkingManifest(input.state, input.target),
      nonExpiringBuildBudget(),
    );
    if (
      savedWorkingState.digest !== workingState.digest ||
      !sameWorkingFileModes(savedWorkingState.fileModes, workingState.fileModes) ||
      draft.workingContentDigest !== workingState.digest
    ) {
      throw new Error("local_app_draft_working_copy_changed");
    }
    assertReleaseInstallGenerationUnchanged(input.state, input.target, installFence);
    return {
      draft,
      installFence,
      workingCopyFence: {
        source: frozenSource ? "save-point" : "live",
        ...(manifestSnapshot ? { manifest: manifestSnapshot } : {}),
        ...(frozenSource && input.savePoint ? { savePointCommitSha: input.savePoint.commitSha } : {}),
        digest: workingState.digest,
        fileModes: { ...workingState.fileModes },
      },
    };
  });
}

export async function saveMountedAppReleasePrebuildDraftWithRevision(input: {
  state: BridgeState;
  target: MountedAppTarget;
  submission: unknown;
  draftStore: LocalAppDraftStore;
}): Promise<ReturnType<typeof saveMountedAppReleasePrebuildDraft>> {
  const revisions = appRevisionStore(input.state);
  const revisionTarget = mountedAppRevisionTarget(input.target);
  const savePoint = await revisions.saveIfChanged({
    ...revisionTarget,
    message: "Freeze App source for release",
  });
  const materializationRoot = mkdtempSync(join(tmpdir(), "opengrove-release-save-point-"));
  const sourceRoot = join(materializationRoot, "app");
  try {
    await revisions.materialize({
      ...revisionTarget,
      commitSha: savePoint.commitSha,
      targetRoot: sourceRoot,
    });
    return saveMountedAppReleasePrebuildDraft({
      ...input,
      savePoint,
      sourceRootOverride: sourceRoot,
    });
  } finally {
    rmSync(materializationRoot, { recursive: true, force: true });
  }
}

interface ExecutedAppReleaseBuildRecipe {
  build: AppReleaseBuildResult;
  outputPlan: AppReleaseBuildOutputPlan;
}

export async function prepareMountedAppReleaseBuild(input: {
  state: BridgeState;
  target: MountedAppTarget;
  release: MountedAppReleaseDraft;
  packageKey: string;
  draftStore: LocalAppDraftStore;
  prebuildDraft: LocalAppDraftSummary;
  installFence?: AppReleaseInstallGenerationFence;
  workingCopyFence?: AppReleaseWorkingCopyFence;
  timeoutMs?: number;
  signal?: AbortSignal;
  budget?: AppReleaseBuildBudget;
}): Promise<PreparedMountedAppReleaseBuild> {
  const budget =
    input.budget ??
    createAppReleaseBuildBudget({
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  budget.checkpoint();
  const buildKey = appStoreInstallContainerRoot(input.target.appRoot, input.target.id);
  if (activeReleaseBuilds.has(buildKey)) {
    throw new Error("app_release_local_build_in_progress");
  }
  activeReleaseBuilds.add(buildKey);
  try {
    return await prepareMountedAppReleaseBuildExclusive(input, budget);
  } finally {
    activeReleaseBuilds.delete(buildKey);
  }
}

async function prepareMountedAppReleaseBuildExclusive(
  input: {
    state: BridgeState;
    target: MountedAppTarget;
    release: MountedAppReleaseDraft;
    packageKey: string;
    draftStore: LocalAppDraftStore;
    prebuildDraft: LocalAppDraftSummary;
    installFence?: AppReleaseInstallGenerationFence;
    workingCopyFence?: AppReleaseWorkingCopyFence;
    timeoutMs?: number;
    signal?: AbortSignal;
    budget?: AppReleaseBuildBudget;
  },
  budget: AppReleaseBuildBudget,
): Promise<PreparedMountedAppReleaseBuild> {
  budget.checkpoint();
  if (input.installFence && !input.workingCopyFence) {
    throw new Error("app_release_local_build_prebuild_fence_required");
  }
  const installFence = input.installFence ?? captureReleaseInstallGeneration(input.state, input.target);
  withReleaseInstallGenerationLock(installFence, () => {
    assertReleaseInstallGenerationUnchanged(input.state, input.target, installFence);
  });
  budget.checkpoint();
  const draftTree = materializeAppReleaseDraftTree({
    draftStore: input.draftStore,
    localAppId: input.target.localAppId,
    expectedDraftDigest: input.prebuildDraft.contentDigest,
    expectedDraftArchiveSha256: input.prebuildDraft.archiveSha256,
    release: input.release,
    packageKey: input.packageKey,
  });
  let prepared: PreparedMountedAppReleaseBuild | undefined;
  try {
    budget.checkpoint();
    const contract = readAppReleaseBuildContract(draftTree.appRoot);
    budget.checkpoint();
    if (contract.status === "missing") throw new Error("build_contract_missing");
    if (contract.status === "invalid") throw new Error("build_contract_invalid");
    const workingManifest = mountedAppWorkingManifest(input.state, input.target);
    const prebuildWorkingState = input.workingCopyFence
      ? {
          digest: input.workingCopyFence.digest,
          fileModes: { ...input.workingCopyFence.fileModes },
        }
      : appWorkingTreeStateForRoot(input.target.appRoot, workingManifest, budget);
    const sourceBoundToSavePoint = input.workingCopyFence?.source === "save-point";
    const prebuildManifestSnapshot = sourceBoundToSavePoint
      ? undefined
      : (input.workingCopyFence?.manifest ?? captureLiveManifestSnapshot(input.target.appRoot));
    if (prebuildManifestSnapshot) {
      assertLiveManifestSnapshotUnchanged(input.target.appRoot, prebuildManifestSnapshot);
      assertTargetManifestMatchesDisk(input.target);
    }
    if (prebuildWorkingState.digest !== input.prebuildDraft.workingContentDigest) {
      throw new Error("local_app_draft_working_copy_changed");
    }
    const materializedPrebuildState = appWorkingTreeStateForRoot(draftTree.appRoot, workingManifest, budget);
    if (!sameWorkingFileModes(prebuildWorkingState.fileModes, materializedPrebuildState.fileModes)) {
      throw new Error("local_app_draft_working_copy_changed");
    }
    const executed = await runAppReleaseBuildRecipeWithBudget({
      appRoot: draftTree.appRoot,
      recipe: contract.recipe,
      budget,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    assertBuildOutputsReachFormalPackageAndCandidate({
      appRoot: draftTree.appRoot,
      manifest: draftTree.projectedManifest,
      outputPlan: executed.outputPlan,
    });
    budget.checkpoint();
    const builtDraftTree = materializeAppReleaseDraftTree({
      draftStore: input.draftStore,
      localAppId: input.target.localAppId,
      expectedDraftDigest: input.prebuildDraft.contentDigest,
      expectedDraftArchiveSha256: input.prebuildDraft.archiveSha256,
      release: input.release,
      packageKey: input.packageKey,
    });
    let draft: LocalAppDraftSummary;
    try {
      for (const output of executed.build.outputs) {
        budget.checkpoint();
        rmSync(resolveInside(builtDraftTree.appRoot, output), { recursive: true, force: true });
      }
      copyAppReleaseBuildOutputPlan({
        sourceRoot: draftTree.appRoot,
        targetRoot: builtDraftTree.appRoot,
        plan: executed.outputPlan,
        budget,
      });
      const copiedOutputPlan = planAppReleaseBuildOutputs({
        appRoot: builtDraftTree.appRoot,
        outputs: executed.build.outputs,
        budget,
      });
      if (!sameAppReleaseBuildOutputPlan(executed.outputPlan, copiedOutputPlan)) {
        throw new Error("app_release_local_build_output_changed");
      }
      draft = saveBuiltReleaseDraft({
        state: input.state,
        target: input.target,
        release: input.release,
        draftStore: input.draftStore,
        prebuildDraft: input.prebuildDraft,
        builtAppRoot: builtDraftTree.appRoot,
        prebuildWorkingState,
        prebuildManifestSnapshot,
        sourceBoundToSavePoint,
        installFence,
        budget,
      });
    } finally {
      builtDraftTree.dispose();
    }
    // This checkpoint intentionally happens after the local commit point. If
    // the deadline elapsed while freezing the built draft, keep that exact
    // draft but stop before any remote intent exists. The live App is unchanged.
    budget.checkpoint();
    prepared = { draft, build: executed.build };
  } finally {
    draftTree.dispose();
  }
  budget.checkpoint();
  return prepared;
}

function assertBuildOutputsReachFormalPackageAndCandidate(input: {
  appRoot: string;
  manifest: OpenGroveAppManifest;
  outputPlan: AppReleaseBuildOutputPlan;
}): void {
  const filePaths = input.outputPlan.files.map((file) => file.path);
  const formalExcluded = appPackageExcludedPaths(input.appRoot, filePaths, { manifestOverride: input.manifest });
  const workspacePath = normalizedBuildPath(
    input.manifest.ui?.workspace || input.manifest.workspace?.path || "workspace",
  );
  const candidateExcluded = filePaths.filter((path) => appReleaseSourcePathExcluded(path, workspacePath));
  const excluded = formalExcluded[0] ?? candidateExcluded[0];
  if (excluded) {
    throw new Error(`app_release_local_build_output_not_publishable:${excluded}`);
  }
}

type WorkingFileModes = Record<string, number>;

interface AppWorkingTreeState {
  packageManifest: AppPackageManifest;
  digest: string;
  fileModes: WorkingFileModes;
}

function appWorkingTreeStateForRoot(
  appRoot: string,
  manifest: OpenGroveAppManifest,
  budget: AppReleaseBuildBudget,
): AppWorkingTreeState {
  const packageManifest = mountedAppWorkingPackageManifestForRoot(appRoot, manifest);
  const fileModes: WorkingFileModes = {};
  for (const path of Object.keys(packageManifest.files).sort()) {
    budget.checkpoint();
    const stat = lstatSync(resolveInside(appRoot, path));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`app_release_local_build_file_changed:${path}`);
    }
    fileModes[path] = stat.mode & 0o777;
  }
  budget.checkpoint();
  return {
    packageManifest,
    digest: appCandidateContentDigest(packageManifest),
    fileModes,
  };
}

function currentWorkingTreeState(
  state: BridgeState,
  target: MountedAppTarget,
  budget: AppReleaseBuildBudget,
): AppWorkingTreeState {
  return appWorkingTreeStateForRoot(target.appRoot, mountedAppWorkingManifest(state, target), budget);
}

function sameWorkingFileModes(expected: WorkingFileModes, actual: WorkingFileModes): boolean {
  const expectedPaths = Object.keys(expected).sort();
  const actualPaths = Object.keys(actual).sort();
  return (
    expectedPaths.length === actualPaths.length &&
    expectedPaths.every((path, index) => path === actualPaths[index] && expected[path] === actual[path])
  );
}

/**
 * Executes an already validated release recipe inside a disposable App tree.
 * The caller owns that tree and must never point this function at the live App.
 */
export async function runAppReleaseBuildRecipe(input: {
  appRoot: string;
  recipe: AppReleaseBuildRecipe;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AppReleaseBuildResult> {
  const budget = createAppReleaseBuildBudget({
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const executed = await runAppReleaseBuildRecipeWithBudget({
    appRoot: input.appRoot,
    recipe: input.recipe,
    budget,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return executed.build;
}

async function runAppReleaseBuildRecipeWithBudget(input: {
  appRoot: string;
  recipe: AppReleaseBuildRecipe;
  budget: AppReleaseBuildBudget;
  signal?: AbortSignal;
}): Promise<ExecutedAppReleaseBuildRecipe> {
  if (process.platform === "win32") {
    throw new Error("app_release_local_build_platform_unsupported");
  }
  input.budget.checkpoint();
  const appRoot = resolve(input.appRoot);
  const workingDirectory = resolveInside(appRoot, input.recipe.workingDirectory);
  const outputs = validateOutputPaths(appRoot, input.recipe.outputs, input.recipe.workingDirectory);
  input.budget.checkpoint();
  const privateEnvironmentRoot = mkdtempSync(join(tmpdir(), "opengrove-release-build-env-"));
  let executed: ExecutedAppReleaseBuildRecipe | undefined;
  try {
    for (const output of outputs) {
      input.budget.checkpoint();
      rmSync(resolveInside(appRoot, output), { recursive: true, force: true });
      input.budget.checkpoint();
    }

    const commands: AppReleaseBuildCommandResult[] = [];
    for (const argv of input.recipe.commands) {
      const commandIndex = commands.length;
      input.budget.checkpoint();
      const result = await runBuildCommand({
        argv,
        cwd: workingDirectory,
        env: releaseBuildEnvironment(privateEnvironmentRoot),
        timeoutMs: input.budget.remainingMs(),
        signal: input.signal,
      });
      commands.push(result);
      if (result.exitCode !== 0) {
        throw new AppReleaseBuildCommandError(commandIndex, result);
      }
      input.budget.checkpoint();
    }

    const outputPlan = planAppReleaseBuildOutputs({
      appRoot,
      outputs,
      budget: input.budget,
    });
    for (const output of outputs) {
      if (appReleaseBuildOutputPlanForOutput(outputPlan, output).files.length === 0) {
        throw new Error(`app_release_local_build_output_empty:${output}`);
      }
    }
    input.budget.checkpoint();
    executed = {
      build: { commands, outputs },
      outputPlan,
    };
  } finally {
    rmSync(privateEnvironmentRoot, { recursive: true, force: true });
  }
  input.budget.checkpoint();
  return executed;
}

function fileFingerprint(stat: Stats): AppReleaseManifestSnapshot["fingerprint"] {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFileFingerprint(expected: AppReleaseManifestSnapshot["fingerprint"], actual: Stats): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.mode === actual.mode &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs
  );
}

function assertTargetManifestMatchesDisk(target: MountedAppTarget): void {
  const current = readMountedAppManifest(target.appRoot);
  if (current.status !== "valid" || !current.manifest || !isDeepStrictEqual(current.manifest, target.manifest)) {
    throw new Error("local_app_draft_working_copy_changed");
  }
}

function captureLiveManifestSnapshot(appRoot: string): AppReleaseManifestSnapshot {
  const manifest = readMountedAppManifest(appRoot);
  if (!manifest.manifestPath) throw new Error("app_release_local_build_manifest_invalid");
  const stat = lstatSync(manifest.manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("app_release_local_build_manifest_invalid");
  return {
    path: resolve(manifest.manifestPath),
    bytes: readFileSync(manifest.manifestPath),
    fingerprint: fileFingerprint(stat),
  };
}

function assertLiveManifestSnapshotUnchanged(appRoot: string, expected: AppReleaseManifestSnapshot): void {
  const current = readMountedAppManifest(appRoot);
  if (!current.manifestPath || resolve(current.manifestPath) !== expected.path) {
    throw new Error("local_app_draft_working_copy_changed");
  }
  const stat = lstatSync(current.manifestPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !sameFileFingerprint(expected.fingerprint, stat) ||
    !readFileSync(current.manifestPath).equals(expected.bytes)
  ) {
    throw new Error("local_app_draft_working_copy_changed");
  }
}

function saveBuiltReleaseDraft(input: {
  state: BridgeState;
  target: MountedAppTarget;
  release: MountedAppReleaseDraft;
  draftStore: LocalAppDraftStore;
  prebuildDraft: LocalAppDraftSummary;
  builtAppRoot: string;
  prebuildWorkingState: Pick<AppWorkingTreeState, "digest" | "fileModes">;
  prebuildManifestSnapshot?: AppReleaseManifestSnapshot;
  sourceBoundToSavePoint: boolean;
  installFence: AppReleaseInstallGenerationFence;
  budget: AppReleaseBuildBudget;
}): LocalAppDraftSummary {
  input.budget.checkpoint();
  const recoveryRoot = mkdtempSync(join(tmpdir(), "opengrove-release-build-draft-"));
  const prebuildDraftArchive = join(recoveryRoot, "prebuild-draft.tgz");
  try {
    const currentDraftArchive = input.draftStore.archivePath(input.target.localAppId);
    if (!currentDraftArchive) throw new Error("local_app_draft_not_found");
    copyFileSync(currentDraftArchive, prebuildDraftArchive);

    return withReleaseInstallGenerationLock(input.installFence, () => {
      input.budget.checkpoint();
      assertReleaseInstallGenerationUnchanged(input.state, input.target, input.installFence);
      if (input.prebuildManifestSnapshot) {
        assertLiveManifestSnapshotUnchanged(input.target.appRoot, input.prebuildManifestSnapshot);
        input.budget.checkpoint();
        const currentPrebuildState = currentWorkingTreeState(input.state, input.target, input.budget);
        if (
          currentPrebuildState.digest !== input.prebuildDraft.workingContentDigest ||
          !sameWorkingFileModes(input.prebuildWorkingState.fileModes, currentPrebuildState.fileModes)
        ) {
          throw new Error("local_app_draft_working_copy_changed");
        }
      }
      input.budget.checkpoint();
      const saved = saveMountedAppDraftForRelease({
        state: input.state,
        target: input.target,
        release: input.release,
        store: input.draftStore,
        expectedWorkingContentDigest: input.prebuildDraft.workingContentDigest,
        publishBase: input.prebuildDraft.publishBase,
        expectedPrevious: input.prebuildDraft,
        appRootOverride: input.builtAppRoot,
        ...(input.sourceBoundToSavePoint
          ? { workingContentDigestOverride: input.prebuildDraft.workingContentDigest }
          : {}),
        ...(input.prebuildDraft.savePoint ? { savePoint: input.prebuildDraft.savePoint } : {}),
      });
      try {
        if (input.prebuildManifestSnapshot) {
          assertLiveManifestSnapshotUnchanged(input.target.appRoot, input.prebuildManifestSnapshot);
          const postSaveState = currentWorkingTreeState(input.state, input.target, nonExpiringBuildBudget());
          if (
            postSaveState.digest !== input.prebuildDraft.workingContentDigest ||
            !sameWorkingFileModes(input.prebuildWorkingState.fileModes, postSaveState.fileModes)
          ) {
            throw new Error("local_app_draft_working_copy_changed");
          }
        }
      } catch {
        try {
          input.draftStore.restorePreviousIfContentUnchanged({
            previous: input.prebuildDraft,
            expectedCurrent: saved,
            archivePath: prebuildDraftArchive,
          });
        } catch {
          throw new Error("app_store_publish_draft_changed");
        }
        throw new Error("local_app_draft_working_copy_changed");
      }
      return saved;
    });
  } finally {
    rmSync(recoveryRoot, { recursive: true, force: true });
  }
}

export function captureReleaseInstallGeneration(
  state: BridgeState,
  target: MountedAppTarget,
): AppReleaseInstallGenerationFence {
  const installContainerRoot = appStoreInstallContainerRoot(target.appRoot, target.id);
  return withReleaseInstallGenerationLock({ installContainerRoot }, () =>
    captureReleaseInstallGenerationUnlocked(state, target, installContainerRoot),
  );
}

function captureReleaseInstallGenerationUnlocked(
  state: BridgeState,
  target: MountedAppTarget,
  installContainerRoot: string,
): AppReleaseInstallGenerationFence {
  assertNoVersionActivation(state, target.localAppId);
  const mounted = currentMountedApp(state, target);
  assertMountedAppMatchesTarget(mounted, target);
  const programGenerations = captureProgramGenerations(target.appRoot, installContainerRoot);
  try {
    return {
      installContainerRoot,
      appRootSnapshot: captureAppStoreTargetSnapshot(target.appRoot),
      mountedPath: resolve(mounted.path),
      ...(mounted.workspacePath?.trim() ? { mountedWorkspacePath: resolve(mounted.workspacePath) } : {}),
      ...(programGenerations ? { programGenerations } : {}),
    };
  } catch {
    throw new Error("app_release_local_build_install_changed");
  }
}

function assertReleaseInstallGenerationUnchanged(
  state: BridgeState,
  target: MountedAppTarget,
  fence: AppReleaseInstallGenerationFence,
): void {
  assertNoVersionActivation(state, target.localAppId);
  const mounted = currentMountedApp(state, target);
  assertMountedAppMatchesTarget(mounted, target);
  if (
    resolve(mounted.path) !== fence.mountedPath ||
    (mounted.workspacePath?.trim() ? resolve(mounted.workspacePath) : undefined) !== fence.mountedWorkspacePath
  ) {
    throw new Error("app_release_local_build_install_changed");
  }
  try {
    assertAppStorePublishTargetSnapshotUnchanged(target.appRoot, fence.appRootSnapshot);
  } catch {
    throw new Error("app_release_local_build_install_changed");
  }
  const programGenerations = captureProgramGenerations(target.appRoot, fence.installContainerRoot);
  const capturedProgramGenerations = fence.programGenerations;
  if (
    capturedProgramGenerations &&
    programGenerations?.some((generation) => !capturedProgramGenerations.includes(generation))
  ) {
    throw new Error("app_release_local_build_install_changed");
  }
}

function assertMountedAppMatchesTarget(mounted: ReturnType<typeof currentMountedApp>, target: MountedAppTarget): void {
  const mountedWorkspacePath = mounted.workspacePath?.trim() ? resolve(mounted.workspacePath) : undefined;
  if (
    resolve(mounted.path) !== resolve(target.appRoot) ||
    (mountedWorkspacePath !== undefined && mountedWorkspacePath !== resolve(target.workspaceRoot))
  ) {
    throw new Error("app_release_local_build_install_changed");
  }
}

function currentMountedApp(state: BridgeState, target: MountedAppTarget) {
  const matches = state.settings.mountedApps.filter((mounted) => mounted.id === target.localAppId);
  if (matches.length !== 1 || !matches[0]?.path?.trim()) {
    throw new Error("app_release_local_build_install_changed");
  }
  return matches[0];
}

function assertNoVersionActivation(state: BridgeState, localAppId: string): void {
  let journals;
  try {
    journals = listAppVersionActivationJournals(appVersionActivationJournalRoot(appStoreDataRoot(state)));
  } catch {
    throw new Error("app_release_local_build_install_changed");
  }
  if (journals.some((journal) => journal.record.localAppId === localAppId)) {
    throw new Error("app_release_local_build_install_changed");
  }
}

function captureProgramGenerations(appRoot: string, installContainerRoot: string): string[] | undefined {
  if (resolve(appRoot) === resolve(installContainerRoot)) return undefined;
  const appProgramsRoot = dirname(dirname(resolve(appRoot)));
  try {
    return readdirSync(appProgramsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new Error("app_release_local_build_install_changed");
  }
}

function withReleaseInstallGenerationLock<T>(
  fence: Pick<AppReleaseInstallGenerationFence, "installContainerRoot">,
  run: () => T,
): T {
  try {
    return withAppStoreInstallLock(fence.installContainerRoot, run);
  } catch (error) {
    if (error instanceof Error && error.message === "app_store_install_target_changed") {
      throw new Error("app_release_local_build_install_changed");
    }
    throw error;
  }
}

function nonExpiringBuildBudget(): AppReleaseBuildBudget {
  return {
    checkpoint() {},
    remainingMs: () => Number.MAX_SAFE_INTEGER,
  };
}

function validateOutputPaths(appRoot: string, declaredOutputs: string[], workingDirectory: string): string[] {
  const outputs = declaredOutputs.map(normalizedBuildPath);
  const workspacePath = declaredWorkspacePath(appRoot);
  const protectedPaths = [
    ".git",
    ".opengrove-build.json",
    ".opengrove-package-manifest.json",
    ".opengrove-store-package.json",
    "opengrove.app.json",
    workspacePath,
  ].map(normalizedBuildPath);
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index]!;
    if (output === "." || protectedPaths.some((path) => portablePathsOverlap(output, path))) {
      throw new Error(`app_release_local_build_output_protected:${output}`);
    }
    if (outputContainsWorkingDirectory(output, normalizedBuildPath(workingDirectory))) {
      throw new Error(`app_release_local_build_output_working_directory:${output}`);
    }
    for (let otherIndex = index + 1; otherIndex < outputs.length; otherIndex += 1) {
      if (portablePathsOverlap(output, outputs[otherIndex]!)) {
        throw new Error(`app_release_local_build_outputs_overlap:${output}`);
      }
    }
    resolveInside(appRoot, output);
  }
  return outputs;
}

function declaredWorkspacePath(appRoot: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(appRoot, "opengrove.app.json"), "utf8")) as {
      ui?: { workspace?: unknown };
      workspace?: { path?: unknown };
    };
    const value =
      typeof manifest.ui?.workspace === "string"
        ? manifest.ui.workspace
        : typeof manifest.workspace?.path === "string"
          ? manifest.workspace.path
          : "workspace";
    return value || "workspace";
  } catch {
    throw new Error("app_release_local_build_manifest_invalid");
  }
}

function releaseBuildEnvironment(privateRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  const home = join(privateRoot, "home");
  const temporary = join(privateRoot, "tmp");
  const cache = join(privateRoot, "cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const searchPath = hostCommandSearchPath({
    path: environment.PATH ?? environment.Path,
    execPath: process.execPath,
    environment: process.env,
  });
  const releaseEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    PATH: searchPath,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: join(privateRoot, "config"),
    npm_config_cache: join(cache, "npm"),
    NO_COLOR: "1",
  };
  if (process.platform === "win32") releaseEnvironment.Path = searchPath;
  return releaseEnvironment;
}

function runBuildCommand(input: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<AppReleaseBuildCommandResult> {
  if (input.signal?.aborted) {
    return Promise.reject(new Error("app_release_local_build_cancelled"));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const invocation = resolveBuildInvocation(input.argv, input.env, input.cwd);
    const detached = process.platform !== "win32";
    const child = crossSpawn(invocation.command, invocation.args, {
      cwd: input.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached,
    });
    const stdout = new BoundedBytes(MAX_BUILD_LOG_BYTES);
    const stderr = new BoundedBytes(MAX_BUILD_LOG_BYTES);
    let settled = false;
    let terminationReason: "timeout" | "cancelled" | undefined;
    let treeCleanup: Promise<void> | undefined;
    const stopProcessTree = () => {
      treeCleanup ??= terminateProcessTree(child.pid, child.kill.bind(child));
      return treeCleanup;
    };
    const terminate = (reason: "timeout" | "cancelled") => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      void stopProcessTree().then(
        () =>
          rejectOnce(
            new Error(reason === "timeout" ? "app_release_local_build_timed_out" : "app_release_local_build_cancelled"),
          ),
        () => rejectOnce(new Error("app_release_local_build_process_cleanup_failed")),
      );
    };
    const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);
    timeout.unref?.();
    const onAbort = () => terminate("cancelled");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    const cleanup = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.once("error", (error) => {
      void stopProcessTree().then(
        () => rejectOnce(new Error(`app_release_local_build_command_unavailable:${error.message}`)),
        () => rejectOnce(new Error("app_release_local_build_process_cleanup_failed")),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      void (async () => {
        try {
          await stopProcessTree();
        } catch {
          rejectOnce(new Error("app_release_local_build_process_cleanup_failed"));
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        if (terminationReason === "timeout") {
          rejectPromise(new Error("app_release_local_build_timed_out"));
          return;
        }
        if (terminationReason === "cancelled") {
          rejectPromise(new Error("app_release_local_build_cancelled"));
          return;
        }
        const out = stdout.finish();
        const err = stderr.finish();
        resolvePromise({
          argv: [...input.argv],
          exitCode: code ?? -1,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
        });
      })();
    });
  });
}

function resolveBuildInvocation(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const requested = argv[0]!;
  const basename = requested.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  if (!requested.includes("/") && !requested.includes("\\") && (basename === "node" || basename === "node.exe")) {
    return {
      command: process.execPath,
      args: argv.slice(1),
      env: process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env,
    };
  }
  const explicitCommand = isAbsolute(requested)
    ? requested
    : requested.includes("/") || requested.includes("\\")
      ? resolve(cwd, requested)
      : requested;
  const resolved = resolveHostCommandPath(explicitCommand, {
    path: env.PATH,
    execPath: process.execPath,
    environment: env,
  });
  return {
    command: resolved ?? explicitCommand,
    args: argv.slice(1),
    env,
  };
}

async function terminateProcessTree(
  pid: number | undefined,
  killChild: (signal?: NodeJS.Signals | number) => boolean,
): Promise<void> {
  if (!pid) return;
  signalPosixProcessTree(pid, killChild, "SIGTERM");
  if (await waitForPosixProcessTreeExit(pid, 100)) return;
  signalPosixProcessTree(pid, killChild, "SIGKILL");
  if (await waitForPosixProcessTreeExit(pid, 2_000)) return;
  throw new Error("app_release_local_build_process_cleanup_failed");
}

function signalPosixProcessTree(
  pid: number,
  killChild: (signal?: NodeJS.Signals | number) => boolean,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
  }
  try {
    killChild(signal);
  } catch {
    // The direct child may already be gone while its process group is empty.
  }
}

async function waitForPosixProcessTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

class BoundedBytes {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    if (this.retainedBytes >= this.limit) return;
    const retained = chunk.subarray(0, this.limit - this.retainedBytes);
    this.chunks.push(retained);
    this.retainedBytes += retained.byteLength;
  }

  finish(): { text: string; truncated: boolean } {
    return {
      text: Buffer.concat(this.chunks, this.retainedBytes).toString("utf8"),
      truncated: this.totalBytes > this.retainedBytes,
    };
  }
}

function boundedDiagnosticArgv(argv: string[]): { argv: string[]; truncated: boolean } {
  const bounded: string[] = [];
  let remainingCharacters = MAX_BUILD_DIAGNOSTIC_ARGV_CHARACTERS;
  let truncated = argv.length > MAX_BUILD_DIAGNOSTIC_ARGUMENTS;
  for (const argument of argv.slice(0, MAX_BUILD_DIAGNOSTIC_ARGUMENTS)) {
    if (remainingCharacters <= 0) {
      truncated = true;
      break;
    }
    if (argument.length > remainingCharacters) {
      bounded.push(argument.slice(0, remainingCharacters));
      truncated = true;
      remainingCharacters = 0;
      break;
    }
    bounded.push(argument);
    remainingCharacters -= argument.length;
  }
  if (bounded.length < argv.length) truncated = true;
  return { argv: bounded, truncated };
}

function boundedDiagnosticText(value: string, alreadyTruncated: boolean): { text: string; truncated: boolean } {
  const bounded = new BoundedBytes(MAX_BUILD_LOG_BYTES);
  bounded.append(Buffer.from(value, "utf8"));
  const result = bounded.finish();
  return {
    text: result.text,
    truncated: alreadyTruncated || result.truncated,
  };
}

function resolveInside(root: string, value: string): string {
  const target = resolve(root, value);
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot) ||
    resolve(root, pathFromRoot) !== target
  ) {
    throw new Error(`app_release_local_build_path_invalid:${value}`);
  }
  return target;
}

function normalizedBuildPath(value: string): string {
  const normalized = canonicalPortableRelativePath(value);
  if (!normalized) {
    throw new Error(`app_release_local_build_path_invalid:${value}`);
  }
  return normalized;
}

function outputContainsWorkingDirectory(output: string, workingDirectory: string): boolean {
  const outputKey = portablePathCollisionKey(output);
  const workingDirectoryKey = portablePathCollisionKey(workingDirectory);
  if (workingDirectoryKey === ".") return outputKey === ".";
  return outputKey === workingDirectoryKey || workingDirectoryKey.startsWith(`${outputKey}/`);
}
