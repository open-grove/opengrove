import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import git from "isomorphic-git";
import { canonicalPortableRelativePath } from "../app-builder/portable-path.js";
import { appReleaseSourcePathExcluded } from "./app-release-source-exclusions.js";
import { writePrivateFileAtomically } from "../storage/private-file.js";

const MANAGED_BRANCH = "opengrove-work";
const DEFAULT_AUTHOR = {
  name: "OpenGrove",
  email: "opengrove@localhost",
};

// ---------------------------------------------------------------------------
// Revision targets and working-copy pointers

export interface AppRevisionTarget {
  localAppId: string;
  appRoot: string;
  workspacePath: string;
}

export interface AppSavePoint {
  commitSha: string;
  savedAt: string;
}

export interface AppRevisionStatus {
  commitSha: string;
  savedAt: string;
  dirty: boolean;
  changedFiles: string[];
}

export interface AppRevisionSourceIssue {
  code: "app_revision_symlink_not_supported" | "app_revision_entry_type_invalid";
  path: string;
}

export interface AppRevisionRecoveryCheckpoint {
  checkpointId: string;
  commitSha: string;
  indexSha256: string;
  objectManifestSha256: string;
}

export function validAppRevisionRecoveryCheckpoint(value: unknown): value is AppRevisionRecoveryCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Partial<AppRevisionRecoveryCheckpoint>;
  if (
    typeof checkpoint.checkpointId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(checkpoint.checkpointId) ||
    typeof checkpoint.commitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(checkpoint.commitSha) ||
    typeof checkpoint.indexSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.indexSha256) ||
    typeof checkpoint.objectManifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.objectManifestSha256)
  ) {
    return false;
  }
  return true;
}

export function appRevisionSourceIssue(error: unknown): AppRevisionSourceIssue | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^(app_revision_(?:symlink_not_supported|entry_type_invalid)):(.+)$/u.exec(message);
  if (!match?.[1] || !match[2]) return undefined;
  const path = canonicalPortableRelativePath(match[2]);
  if (!path || path === "." || path !== match[2]) return undefined;
  return {
    code: match[1] as AppRevisionSourceIssue["code"],
    path,
  };
}

export function appRevisionTarget(input: {
  localAppId: string;
  appRoot: string;
  manifest: unknown;
}): AppRevisionTarget {
  return {
    localAppId: input.localAppId,
    appRoot: input.appRoot,
    workspacePath: appRevisionWorkspacePath(input.manifest),
  };
}

export function appRevisionWorkspacePath(manifest: unknown): string {
  const root = revisionRecord(manifest);
  const ui = revisionRecord(root.ui);
  const workspace = revisionRecord(root.workspace);
  const declared = revisionString(ui.workspace) || revisionString(workspace.path) || "workspace";
  const normalized = canonicalPortableRelativePath(declared);
  if (!normalized || normalized === ".") throw new Error("app_revision_workspace_path_invalid");
  return normalized;
}

export function isAppRevisionUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === "app_revision_repository_not_found";
}

interface AppRevisionRepository {
  gitdir: string;
}

type WorkingCopyPointer = { kind: "managed" } | { kind: "external"; gitdir: string } | { kind: "stale-external" };

export function managedAppRevisionGitDirectory(root: string, localAppId: string): string {
  const normalizedLocalAppId = localAppId.trim();
  if (!normalizedLocalAppId) throw new Error("app_revision_local_app_id_invalid");
  return resolve(root, `${sha256(normalizedLocalAppId)}.git`);
}

export function attachManagedAppRevisionWorkingCopy(input: {
  revisionsRoot: string;
  localAppId: string;
  appRoot: string;
}): boolean {
  const gitdir = managedAppRevisionGitDirectory(input.revisionsRoot, input.localAppId);
  const repository = pathEntry(gitdir);
  if (!repository) return false;
  if (!repository.isDirectory() || repository.isSymbolicLink()) {
    throw new Error("app_revision_repository_not_found");
  }
  const pointerPath = resolve(input.appRoot, ".git");
  if (pathEntry(pointerPath)) throw new Error("app_revision_existing_repository_requires_adoption");
  writePrivateFileAtomically(pointerPath, `gitdir: ${gitdir}\n`);
  return true;
}

export function isManagedAppRevisionWorkingCopy(input: {
  revisionsRoot: string;
  localAppId: string;
  appRoot: string;
}): boolean {
  const pointerPath = resolve(input.appRoot, ".git");
  const pointer = pathEntry(pointerPath);
  if (!pointer?.isFile() || pointer.isSymbolicLink()) return false;
  const match = /^gitdir:\s+(.+)\s*$/.exec(readFileSync(pointerPath, "utf8"));
  if (!match?.[1]) return false;
  const gitdir = resolve(isAbsolute(match[1]) ? match[1] : resolve(input.appRoot, match[1]));
  return gitdir === managedAppRevisionGitDirectory(input.revisionsRoot, input.localAppId);
}

export function restoreManagedAppRevisionCheckpoint(input: {
  revisionsRoot: string;
  localAppId: string;
  appRoot: string;
  checkpoint: AppRevisionRecoveryCheckpoint;
}): void {
  if (!validAppRevisionRecoveryCheckpoint(input.checkpoint)) {
    throw new Error("app_revision_recovery_checkpoint_invalid");
  }
  const gitdir = managedAppRevisionGitDirectory(input.revisionsRoot, input.localAppId);
  const repository = pathEntry(gitdir);
  if (!repository?.isDirectory() || repository.isSymbolicLink()) {
    throw new Error("app_revision_recovery_repository_invalid");
  }
  const head = readFileSync(resolve(gitdir, "HEAD"), "utf8");
  if (head !== `ref: refs/heads/${MANAGED_BRANCH}\n`) {
    throw new Error("app_revision_recovery_branch_invalid");
  }
  const checkpointRoot = recoveryCheckpointRoot(gitdir, input.checkpoint.checkpointId);
  const manifestBytes = readFileSync(resolve(checkpointRoot, "objects.json"));
  if (createHash("sha256").update(manifestBytes).digest("hex") !== input.checkpoint.objectManifestSha256) {
    throw new Error("app_revision_recovery_checkpoint_invalid");
  }
  const manifest = parseRecoveryObjectManifest(manifestBytes);
  if (manifest.commitSha !== input.checkpoint.commitSha) throw new Error("app_revision_recovery_checkpoint_invalid");
  const recoveryObjects = new Map<string, RecoveryGitObject>();
  for (const oid of manifest.objectOids) {
    recoveryObjects.set(oid, readRecoveryGitObject(resolve(checkpointRoot, "objects", oid), oid));
  }
  if (!validRecoveryGitCommitTree(recoveryObjects, input.checkpoint.commitSha)) {
    throw new Error("app_revision_recovery_checkpoint_invalid");
  }
  const recoveryIndex = readFileSync(recoveryCheckpointIndexPath(gitdir, input.checkpoint.checkpointId));
  if (
    createHash("sha256").update(recoveryIndex).digest("hex") !== input.checkpoint.indexSha256 ||
    !validGitIndexEnvelope(recoveryIndex)
  ) {
    throw new Error("app_revision_recovery_checkpoint_invalid");
  }
  for (const [oid, object] of recoveryObjects) {
    writePrivateFileAtomically(resolve(gitdir, "objects", oid.slice(0, 2), oid.slice(2)), object.deflated);
  }
  writePrivateFileAtomically(resolve(gitdir, "refs", "heads", MANAGED_BRANCH), `${input.checkpoint.commitSha}\n`);
  writePrivateFileAtomically(resolve(gitdir, "index"), recoveryIndex);
}

export function removeManagedAppRevisionCheckpoint(input: {
  revisionsRoot: string;
  localAppId: string;
  checkpoint: AppRevisionRecoveryCheckpoint;
}): void {
  if (!validAppRevisionRecoveryCheckpoint(input.checkpoint)) return;
  const gitdir = managedAppRevisionGitDirectory(input.revisionsRoot, input.localAppId);
  rmSync(recoveryCheckpointRoot(gitdir, input.checkpoint.checkpointId), { recursive: true, force: true });
}

export function pruneManagedAppRevisionCheckpoints(input: {
  revisionsRoot: string;
  retainedCheckpointIds: ReadonlySet<string>;
}): void {
  const root = pathEntry(input.revisionsRoot);
  if (!root) return;
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("app_revision_repository_root_invalid");
  for (const repository of readdirSync(input.revisionsRoot, { withFileTypes: true })) {
    if (!repository.isDirectory() || repository.isSymbolicLink() || !/^[a-f0-9]{64}\.git$/u.test(repository.name)) {
      continue;
    }
    const gitdir = resolve(input.revisionsRoot, repository.name);
    const recoveryRoot = resolve(gitdir, "opengrove-recovery");
    const entry = pathEntry(recoveryRoot);
    if (!entry) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("app_revision_recovery_directory_invalid");
    for (const checkpointDirectory of readdirSync(recoveryRoot, { withFileTypes: true })) {
      if (!checkpointDirectory.isDirectory() || checkpointDirectory.isSymbolicLink()) continue;
      if (
        !/^[a-f0-9]{32}$/u.test(checkpointDirectory.name) ||
        input.retainedCheckpointIds.has(checkpointDirectory.name)
      ) {
        continue;
      }
      rmSync(resolve(recoveryRoot, checkpointDirectory.name), { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Save-point lifecycle

export class AppRevisionStore {
  constructor(private readonly root: string) {}

  async ensureWorkingCopy(target: AppRevisionTarget): Promise<AppSavePoint> {
    const normalized = this.normalizedTarget(target);
    const gitdir = this.managedGitDirectory(normalized.localAppId);
    const pointerPath = resolve(normalized.appRoot, ".git");
    const pointer = pathEntry(pointerPath);
    if (pointer) {
      const workingCopy = await this.readWorkingCopyPointer(normalized, pointerPath, pointer);
      if (workingCopy.kind === "stale-external") {
        writePrivateFileAtomically(pointerPath, `gitdir: ${gitdir}\n`);
      }
    }

    const repository = await this.ensureManagedRepository(normalized);
    if (!pointer) writePrivateFileAtomically(pointerPath, `gitdir: ${gitdir}\n`);
    try {
      return await this.readSavePoint(normalized.appRoot, repository.gitdir);
    } catch (error) {
      if ((error as { code?: string }).code !== "NotFoundError") throw error;
      await this.stageSourceTree(normalized, repository);
      return this.commit(normalized.appRoot, repository.gitdir, "Initial OpenGrove App save point");
    }
  }

  async captureRecoveryCheckpoint(target: AppRevisionTarget): Promise<AppRevisionRecoveryCheckpoint> {
    const normalized = this.normalizedTarget(target);
    const gitdir = this.managedGitDirectory(normalized.localAppId);
    const repository = pathEntry(gitdir);
    if (!repository?.isDirectory() || repository.isSymbolicLink()) {
      throw new Error("app_revision_recovery_repository_invalid");
    }
    const head = readFileSync(resolve(gitdir, "HEAD"), "utf8");
    if (head !== `ref: refs/heads/${MANAGED_BRANCH}\n`) {
      throw new Error("app_revision_recovery_branch_invalid");
    }
    const commitSha = await git.resolveRef({ fs, gitdir, ref: MANAGED_BRANCH });
    if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw new Error("app_revision_recovery_checkpoint_invalid");
    const objectOids = await revisionObjectOids(gitdir, commitSha);
    const recoveryIndex = readFileSync(resolve(gitdir, "index"));
    if (!validGitIndexEnvelope(recoveryIndex)) throw new Error("app_revision_recovery_checkpoint_invalid");
    const checkpointId = randomBytes(16).toString("hex");
    const checkpointRoot = recoveryCheckpointRoot(gitdir, checkpointId);
    const checkpointIndexPath = recoveryCheckpointIndexPath(gitdir, checkpointId);
    try {
      writePrivateFileAtomically(checkpointIndexPath, recoveryIndex);
      for (const oid of objectOids) {
        const object = await git.readObject({ fs, gitdir, oid, format: "content" });
        if (
          object.format !== "content" ||
          (object.type !== "commit" && object.type !== "tree" && object.type !== "blob")
        ) {
          throw new Error("app_revision_recovery_checkpoint_invalid");
        }
        const content = Buffer.from(object.object);
        const wrapped = Buffer.concat([Buffer.from(`${object.type} ${content.length}\0`, "ascii"), content]);
        if (createHash("sha1").update(wrapped).digest("hex") !== oid) {
          throw new Error("app_revision_recovery_checkpoint_invalid");
        }
        writePrivateFileAtomically(resolve(checkpointRoot, "objects", oid), deflateSync(wrapped));
      }
      const manifestBytes = Buffer.from(
        `${JSON.stringify({ schemaVersion: 1, commitSha, objectOids: [...objectOids].sort() })}\n`,
        "utf8",
      );
      writePrivateFileAtomically(resolve(checkpointRoot, "objects.json"), manifestBytes);
      const checkpoint: AppRevisionRecoveryCheckpoint = {
        checkpointId,
        commitSha,
        indexSha256: createHash("sha256").update(recoveryIndex).digest("hex"),
        objectManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      };
      if (!validAppRevisionRecoveryCheckpoint(checkpoint)) {
        throw new Error("app_revision_recovery_checkpoint_invalid");
      }
      return checkpoint;
    } catch (error) {
      rmSync(checkpointRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async inspect(target: AppRevisionTarget): Promise<AppRevisionStatus> {
    const normalized = this.normalizedTarget(target);
    await this.reattachManagedWorkingCopy(normalized);
    const repository = this.requireRepository(normalized);
    const commitSha = await git.resolveRef({ fs, gitdir: repository.gitdir, ref: "HEAD" });
    const commit = await git.readCommit({ fs, gitdir: repository.gitdir, oid: commitSha });
    const committedFiles = await readRevisionFiles(repository.gitdir, commitSha);
    const matrix = await this.sourceStatusMatrix(normalized, repository);
    const rows = new Map(matrix.map((row) => [row[0], row] as const));
    const changedFiles = new Set<string>();
    const candidatePaths = new Set([...rows.keys(), ...committedFiles.keys()]);
    for (const path of [...candidatePaths].sort((left, right) => left.localeCompare(right))) {
      if (appReleaseSourcePathExcluded(path, normalized.workspacePath)) continue;
      const committed = committedFiles.get(path);
      const row = rows.get(path);
      if (!row || row[2] === 0) {
        if (committed) changedFiles.add(path);
        continue;
      }
      const workingFile = revisionWorkingFile(normalized.appRoot, path);
      if (!committed || row[1] !== row[2] || workingFile.executable !== committed.executable) {
        changedFiles.add(path);
      }
    }
    const orderedChangedFiles = [...changedFiles].sort((left, right) => left.localeCompare(right));
    return {
      commitSha,
      savedAt: new Date(commit.commit.author.timestamp * 1_000).toISOString(),
      dirty: orderedChangedFiles.length > 0,
      changedFiles: orderedChangedFiles,
    };
  }

  async saveIfChanged(target: AppRevisionTarget & { message: string }): Promise<AppSavePoint> {
    let savePoint = await this.ensureWorkingCopy(target);
    if ((await this.inspect(target)).dirty) {
      savePoint = await this.save(target);
    }
    return savePoint;
  }

  async save(target: AppRevisionTarget & { message: string }): Promise<AppSavePoint> {
    const normalized = this.normalizedTarget(target);
    const message = target.message.trim();
    if (!message || message.length > 2_000) throw new Error("app_revision_save_message_invalid");
    await this.reattachManagedWorkingCopy(normalized);
    const repository = this.requireRepository(normalized);
    const commitSha = await git.resolveRef({ fs, gitdir: repository.gitdir, ref: "HEAD" });
    const committedFiles = await readRevisionFiles(repository.gitdir, commitSha);
    const stagedFiles = await this.stageSourceTree(normalized, repository);
    if (sameRevisionFiles(committedFiles, stagedFiles)) {
      return this.readSavePoint(normalized.appRoot, repository.gitdir);
    }
    return this.commit(normalized.appRoot, repository.gitdir, message);
  }

  async restoreSavePoint(target: AppRevisionTarget & { commitSha: string }): Promise<AppSavePoint> {
    if (!/^[a-f0-9]{40}$/.test(target.commitSha)) throw new Error("app_revision_save_point_invalid");
    const normalized = this.normalizedTarget(target);
    await this.reattachManagedWorkingCopy(normalized);
    const repository = this.requireRepository(normalized);
    const expectedFiles = await readRevisionFiles(repository.gitdir, target.commitSha);
    const indexedFiles = new Set(await git.listFiles({ fs, dir: normalized.appRoot, gitdir: repository.gitdir }));
    for (const filepath of [...new Set([...expectedFiles.keys(), ...indexedFiles])].sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (expectedFiles.has(filepath)) {
        await git.resetIndex({
          fs,
          dir: normalized.appRoot,
          gitdir: repository.gitdir,
          filepath,
          ref: target.commitSha,
        });
      } else {
        await git.updateIndex({
          fs,
          dir: normalized.appRoot,
          gitdir: repository.gitdir,
          filepath,
          remove: true,
          force: true,
        });
      }
    }
    const branch = await git.currentBranch({
      fs,
      dir: normalized.appRoot,
      gitdir: repository.gitdir,
      fullname: true,
    });
    if (!branch) throw new Error("app_revision_branch_unavailable");
    await git.writeRef({
      fs,
      dir: normalized.appRoot,
      gitdir: repository.gitdir,
      ref: branch,
      value: target.commitSha,
      force: true,
    });
    return this.readSavePoint(normalized.appRoot, repository.gitdir);
  }

  async materialize(input: {
    localAppId: string;
    appRoot: string;
    workspacePath: string;
    commitSha: string;
    targetRoot: string;
  }): Promise<void> {
    if (!/^[a-f0-9]{40}$/.test(input.commitSha)) {
      throw new Error("app_revision_save_point_invalid");
    }
    const targetRoot = resolve(input.targetRoot);
    if (pathEntry(targetRoot)) {
      throw new Error("app_revision_materialize_target_exists");
    }
    const repository = this.requireRepository(
      this.normalizedTarget({
        localAppId: input.localAppId.trim(),
        appRoot: input.appRoot,
        workspacePath: input.workspacePath,
      }),
    );
    mkdirSync(targetRoot, { recursive: true });
    try {
      const workspacePath = normalizedRelativePath(input.workspacePath);
      const files = await readRevisionFiles(repository.gitdir, input.commitSha);
      for (const [path, file] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
        if (appReleaseSourcePathExcluded(path, workspacePath)) continue;
        const canonicalPath = canonicalPortableRelativePath(path);
        if (!canonicalPath || canonicalPath === "." || canonicalPath !== path) {
          throw new Error(`app_revision_path_invalid:${path}`);
        }
        if (file.mode === "120000") throw new Error(`app_revision_symlink_not_supported:${path}`);
        if (file.mode === "160000") throw new Error(`app_revision_submodule_not_supported:${path}`);
        const destination = resolve(targetRoot, path);
        if (destination !== targetRoot && !destination.startsWith(`${targetRoot}${sep}`)) {
          throw new Error(`app_revision_path_invalid:${path}`);
        }
        const blob = await git.readBlob({ fs, gitdir: repository.gitdir, oid: file.oid });
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, Buffer.from(blob.blob), { mode: file.executable ? 0o755 : 0o644 });
        chmodSync(destination, file.executable ? 0o755 : 0o644);
      }
    } catch (error) {
      rmSync(targetRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private normalizedTarget(target: AppRevisionTarget): AppRevisionTarget {
    const localAppId = target.localAppId.trim();
    if (!localAppId) throw new Error("app_revision_local_app_id_invalid");
    const appRoot = resolve(target.appRoot);
    const appRootEntry = pathEntry(appRoot);
    if (!appRootEntry?.isDirectory() || appRootEntry.isSymbolicLink()) {
      throw new Error("app_revision_app_root_invalid");
    }
    const workspacePath = canonicalPortableRelativePath(target.workspacePath);
    if (!workspacePath || workspacePath === ".") throw new Error("app_revision_workspace_path_invalid");
    return { localAppId, appRoot, workspacePath };
  }

  private managedGitDirectory(localAppId: string): string {
    return managedAppRevisionGitDirectory(this.root, localAppId);
  }

  private requireRepository(target: AppRevisionTarget): AppRevisionRepository {
    const gitdir = this.managedGitDirectory(target.localAppId);
    const entry = pathEntry(gitdir);
    if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error("app_revision_repository_not_found");
    normalizeManagedGitIndexVersion(gitdir);
    return { gitdir };
  }

  private async ensureManagedRepository(target: AppRevisionTarget): Promise<AppRevisionRepository> {
    const gitdir = this.managedGitDirectory(target.localAppId);
    const entry = pathEntry(gitdir);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new Error("app_revision_repository_not_found");
    }
    if (!entry) mkdirSync(gitdir, { recursive: true, mode: 0o700 });
    if (!pathEntry(resolve(gitdir, "HEAD"))) {
      await git.init({ fs, dir: target.appRoot, gitdir, defaultBranch: MANAGED_BRANCH });
    }
    normalizeManagedGitIndexVersion(gitdir);
    ensureManagedGitExcludes(gitdir, target.workspacePath);
    return { gitdir };
  }

  private async readWorkingCopyPointer(
    target: AppRevisionTarget,
    pointerPath: string,
    pointer: NonNullable<ReturnType<typeof statSync>>,
  ): Promise<WorkingCopyPointer> {
    if (pointer.isSymbolicLink() || (!pointer.isDirectory() && !pointer.isFile())) {
      throw new Error("app_revision_existing_repository_requires_adoption");
    }
    if (pointer.isDirectory()) return { kind: "external", gitdir: pointerPath };
    const match = /^gitdir:\s+(.+)\s*$/.exec(readFileSync(pointerPath, "utf8"));
    if (!match?.[1]) throw new Error("app_revision_existing_repository_requires_adoption");
    const gitdir = resolve(isAbsolute(match[1]) ? match[1] : resolve(target.appRoot, match[1]));
    if (gitdir === this.managedGitDirectory(target.localAppId)) return { kind: "managed" };
    const entry = pathEntry(gitdir);
    if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error("app_revision_repository_not_found");
    const worktreeBacklink = gitWorktreeBacklink(gitdir);
    if (worktreeBacklink) {
      if (sameExistingPath(worktreeBacklink, pointerPath)) return { kind: "external", gitdir };
      if (this.managedRepositoryExists(target.localAppId)) return { kind: "stale-external" };
      throw new Error("app_revision_existing_repository_requires_adoption");
    }
    const configuredWorktree = await git.getConfig({ fs, gitdir, path: "core.worktree" });
    if (
      typeof configuredWorktree === "string" &&
      configuredWorktree.trim() &&
      sameExistingPath(resolve(gitdir, configuredWorktree), target.appRoot)
    ) {
      return { kind: "external", gitdir };
    }
    throw new Error("app_revision_existing_repository_requires_adoption");
  }

  private managedRepositoryExists(localAppId: string): boolean {
    const entry = pathEntry(this.managedGitDirectory(localAppId));
    return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
  }

  private async reattachManagedWorkingCopy(target: AppRevisionTarget): Promise<void> {
    const pointerPath = resolve(target.appRoot, ".git");
    const pointer = pathEntry(pointerPath);
    if (!pointer) {
      if (this.managedRepositoryExists(target.localAppId)) {
        writePrivateFileAtomically(pointerPath, `gitdir: ${this.managedGitDirectory(target.localAppId)}\n`);
      }
      return;
    }
    const workingCopy = await this.readWorkingCopyPointer(target, pointerPath, pointer);
    if (workingCopy.kind === "stale-external") {
      writePrivateFileAtomically(pointerPath, `gitdir: ${this.managedGitDirectory(target.localAppId)}\n`);
    }
  }

  private async externalTrackedFiles(target: AppRevisionTarget): Promise<Set<string>> {
    const pointerPath = resolve(target.appRoot, ".git");
    const pointer = pathEntry(pointerPath);
    if (!pointer) return new Set();
    const workingCopy = await this.readWorkingCopyPointer(target, pointerPath, pointer);
    if (workingCopy.kind !== "external") return new Set();
    try {
      return new Set(await git.listFiles({ fs, dir: target.appRoot, gitdir: workingCopy.gitdir }));
    } catch (error) {
      if ((error as { code?: string }).code === "NotFoundError") return new Set();
      throw error;
    }
  }

  private async sourceStatusMatrix(target: AppRevisionTarget, repository: AppRevisionRepository) {
    const matrix = await git.statusMatrix({ fs, dir: target.appRoot, gitdir: repository.gitdir });
    const rows = new Map<string, (typeof matrix)[number]>(matrix.map((row) => [row[0], row]));
    for (const filepath of await this.externalTrackedFiles(target)) {
      if (rows.has(filepath) || appReleaseSourcePathExcluded(filepath, target.workspacePath)) continue;
      const entry = pathEntry(resolve(target.appRoot, filepath));
      if (!entry) continue;
      revisionWorkingFile(target.appRoot, filepath);
      rows.set(filepath, [filepath, 0, 2, 0]);
    }
    return [...rows.values()];
  }

  private async readSavePoint(appRoot: string, gitdir: string): Promise<AppSavePoint> {
    const commitSha = await git.resolveRef({ fs, gitdir, ref: "HEAD" });
    const commit = await git.readCommit({ fs, dir: appRoot, gitdir, oid: commitSha });
    return {
      commitSha,
      savedAt: new Date(commit.commit.author.timestamp * 1_000).toISOString(),
    };
  }

  private async commit(appRoot: string, gitdir: string, message: string): Promise<AppSavePoint> {
    const commitSha = await git.commit({
      fs,
      dir: appRoot,
      gitdir,
      message,
      author: DEFAULT_AUTHOR,
    });
    return {
      commitSha,
      savedAt: new Date().toISOString(),
    };
  }

  private async stageSourceTree(
    target: AppRevisionTarget,
    repository: AppRevisionRepository,
  ): Promise<Map<string, RevisionFile>> {
    const stagedFiles = new Map<string, RevisionFile>();
    for (const [filepath, head, workdir, stage] of await this.sourceStatusMatrix(target, repository)) {
      if (appReleaseSourcePathExcluded(filepath, target.workspacePath) || workdir === 0) {
        if (head !== 0 || stage !== 0) {
          await git.updateIndex({
            fs,
            dir: target.appRoot,
            gitdir: repository.gitdir,
            filepath,
            remove: true,
            force: true,
          });
        }
        continue;
      }
      const workingFile = revisionWorkingFile(target.appRoot, filepath);
      const oid = await git.updateIndex({
        fs,
        dir: target.appRoot,
        gitdir: repository.gitdir,
        filepath,
        add: true,
        force: true,
      });
      if (typeof oid !== "string") throw new Error(`app_revision_index_update_failed:${filepath}`);
      stagedFiles.set(filepath, {
        oid,
        mode: workingFile.executable ? "100755" : "100644",
        executable: workingFile.executable,
      });
    }
    if (!stagedFiles.has("opengrove.app.json")) throw new Error("app_revision_manifest_required");
    return stagedFiles;
  }
}

// ---------------------------------------------------------------------------
// Managed repository policy

function ensureManagedGitExcludes(gitdir: string, workspacePath: string): void {
  const excludePath = resolve(gitdir, "info", "exclude");
  // Store Apps bind Workspace through a symlink/junction, so the exact entry
  // must be ignored whether it is a directory or a link.
  const workspacePattern = `/${escapeGitIgnorePath(workspacePath)}`;
  const contents = `${[
    "# OpenGrove-managed working copy exclusions",
    workspacePattern,
    "**/.DS_Store",
    "**/.env",
    "**/.env.*",
    "**/.opengrove-package-manifest.json",
    "**/.opengrove-store-package.json",
    "**/.opengrove-store-package.json.*",
    "**/node_modules/",
    "**/cache/",
    "**/.cache/",
    "**/.venv/",
    "**/venv/",
    "**/__pycache__/",
    "**/.claude/",
    "**/.codex/",
    "**/.gemini/",
    "**/.kimi/",
    "**/.opencode/",
    "**/.aws/",
    "**/.azure/",
  ].join("\n")}\n`;
  if (pathEntry(excludePath)?.isFile() && readFileSync(excludePath, "utf8") === contents) return;
  mkdirSync(dirname(excludePath), { recursive: true, mode: 0o700 });
  writePrivateFileAtomically(excludePath, contents);
}

function escapeGitIgnorePath(path: string): string {
  let escaped = "";
  for (const character of path) {
    escaped += "\\*?[]#! ".includes(character) ? `\\${character}` : character;
  }
  return escaped;
}

// ---------------------------------------------------------------------------
// Revision tree reads and comparisons

interface RevisionFile {
  oid: string;
  mode: string;
  executable: boolean;
}

async function revisionObjectOids(gitdir: string, commitSha: string): Promise<Set<string>> {
  const commit = await git.readCommit({ fs, gitdir, oid: commitSha });
  const objectOids = new Set<string>([commitSha]);
  const visit = async (treeOid: string): Promise<void> => {
    if (objectOids.has(treeOid)) return;
    objectOids.add(treeOid);
    const tree = await git.readTree({ fs, gitdir, oid: treeOid });
    for (const entry of tree.tree) {
      if (entry.type === "tree") await visit(entry.oid);
      else if (entry.type === "blob") objectOids.add(entry.oid);
      else throw new Error("app_revision_recovery_checkpoint_invalid");
    }
  };
  await visit(commit.commit.tree);
  return objectOids;
}

async function readRevisionFiles(gitdir: string, commitSha: string): Promise<Map<string, RevisionFile>> {
  const commit = await git.readCommit({ fs, gitdir, oid: commitSha });
  const files = new Map<string, RevisionFile>();
  const visit = async (treeOid: string, parentPath: string): Promise<void> => {
    const tree = await git.readTree({ fs, gitdir, oid: treeOid });
    for (const entry of tree.tree) {
      const path = parentPath ? `${parentPath}/${entry.path}` : entry.path;
      if (entry.type === "tree") {
        await visit(entry.oid, path);
        continue;
      }
      files.set(path, {
        oid: entry.oid,
        mode: entry.mode,
        executable: entry.mode === "100755",
      });
    }
  };
  await visit(commit.commit.tree, "");
  return files;
}

// ---------------------------------------------------------------------------
// Path and value helpers

function normalizedRelativePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function gitWorktreeBacklink(gitdir: string): string | undefined {
  const backlinkPath = resolve(gitdir, "gitdir");
  const backlink = pathEntry(backlinkPath);
  if (!backlink?.isFile() || backlink.isSymbolicLink()) return undefined;
  const value = readFileSync(backlinkPath, "utf8").trim();
  return value || undefined;
}

function revisionWorkingFile(appRoot: string, path: string): { absolutePath: string; executable: boolean } {
  const canonicalPath = canonicalPortableRelativePath(path);
  if (!canonicalPath || canonicalPath === "." || canonicalPath !== path) {
    throw new Error(`app_revision_path_invalid:${path}`);
  }
  const absolutePath = resolve(appRoot, path);
  const entry = lstatSync(absolutePath);
  if (entry.isSymbolicLink()) throw new Error(`app_revision_symlink_not_supported:${path}`);
  if (!entry.isFile()) throw new Error(`app_revision_entry_type_invalid:${path}`);
  return { absolutePath, executable: Boolean(entry.mode & 0o111) };
}

function sameRevisionFiles(left: Map<string, RevisionFile>, right: Map<string, RevisionFile>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, file] of left) {
    const other = right.get(path);
    if (!other || other.oid !== file.oid || other.executable !== file.executable) return false;
  }
  return true;
}

function sameExistingPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function pathEntry(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validGitIndexEnvelope(index: Buffer): boolean {
  if (index.length < 32 || index.subarray(0, 4).toString("ascii") !== "DIRC") return false;
  const version = index.readUInt32BE(4);
  if (version !== 2 && version !== 3 && version !== 4) return false;
  const body = index.subarray(0, -20);
  return createHash("sha1").update(body).digest().equals(index.subarray(-20));
}

function normalizeManagedGitIndexVersion(gitdir: string): void {
  const indexPath = resolve(gitdir, "index");
  const entry = pathEntry(indexPath);
  if (!entry) return;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("app_revision_index_invalid");
  const index = readFileSync(indexPath);
  if (!validGitIndexEnvelope(index)) throw new Error("app_revision_index_invalid");
  if (index.readUInt32BE(4) !== 4) return;
  writePrivateFileAtomically(indexPath, convertGitIndexV4ToV2(index));
}

function convertGitIndexV4ToV2(index: Buffer): Buffer {
  if (!validGitIndexEnvelope(index) || index.readUInt32BE(4) !== 4) {
    throw new Error("app_revision_index_invalid");
  }
  const body = index.subarray(0, -20);
  const entryCount = body.readUInt32BE(8);
  const entries: Buffer[] = [];
  let offset = 12;
  let previousPath = Buffer.alloc(0);
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const entryStart = offset;
    if (offset + 62 > body.length) throw new Error("app_revision_index_invalid");
    const flags = body.readUInt16BE(offset + 60);
    offset += 62;
    if ((flags & 0x4000) !== 0) {
      if (offset + 2 > body.length) throw new Error("app_revision_index_invalid");
      offset += 2;
    }
    const header = body.subarray(entryStart, offset);
    const decoded = readGitIndexV4RemoveCount(body, offset);
    offset = decoded.offset;
    const nul = body.indexOf(0, offset);
    if (nul < offset || decoded.removeCount > previousPath.length) throw new Error("app_revision_index_invalid");
    const path = Buffer.concat([
      previousPath.subarray(0, previousPath.length - decoded.removeCount),
      body.subarray(offset, nul),
    ]);
    const declaredPathLength = flags & 0x0fff;
    if (!path.length || (declaredPathLength < 0x0fff && declaredPathLength !== path.length)) {
      throw new Error("app_revision_index_invalid");
    }
    const unpadded = Buffer.concat([header, path, Buffer.from([0])]);
    const padding = (8 - (unpadded.length % 8)) % 8;
    entries.push(Buffer.concat([unpadded, Buffer.alloc(padding)]));
    previousPath = path;
    offset = nul + 1;
  }
  const header = Buffer.from(body.subarray(0, 12));
  header.writeUInt32BE(2, 4);
  const convertedBody = Buffer.concat([header, ...entries, body.subarray(offset)]);
  return Buffer.concat([convertedBody, createHash("sha1").update(convertedBody).digest()]);
}

function readGitIndexV4RemoveCount(value: Buffer, start: number): { removeCount: number; offset: number } {
  let offset = start;
  if (offset >= value.length) throw new Error("app_revision_index_invalid");
  let byte = value[offset++]!;
  let removeCount = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (offset >= value.length || removeCount > 0x00ff_ffff) throw new Error("app_revision_index_invalid");
    byte = value[offset++]!;
    removeCount = ((removeCount + 1) << 7) | (byte & 0x7f);
  }
  return { removeCount, offset };
}

interface RecoveryGitObject {
  type: "commit" | "tree" | "blob";
  body: Buffer;
  deflated: Buffer;
}

function readRecoveryGitObject(path: string, oid: string): RecoveryGitObject {
  if (!/^[a-f0-9]{40}$/u.test(oid)) throw new Error("app_revision_recovery_checkpoint_invalid");
  const entry = pathEntry(path);
  if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error("app_revision_recovery_checkpoint_invalid");
  const deflated = readFileSync(path);
  const inflated = inflateSync(deflated);
  const nul = inflated.indexOf(0);
  if (nul <= 0) throw new Error("app_revision_recovery_checkpoint_invalid");
  const header = inflated.subarray(0, nul).toString("ascii");
  const match = /^(commit|tree|blob) ([0-9]+)$/u.exec(header);
  const body = inflated.subarray(nul + 1);
  if (!match?.[1] || Number(match[2]) !== body.length) {
    throw new Error("app_revision_recovery_checkpoint_invalid");
  }
  if (createHash("sha1").update(inflated).digest("hex") !== oid) {
    throw new Error("app_revision_recovery_checkpoint_invalid");
  }
  return { type: match[1] as RecoveryGitObject["type"], body, deflated };
}

function validRecoveryGitCommitTree(objects: ReadonlyMap<string, RecoveryGitObject>, commitSha: string): boolean {
  const commit = objects.get(commitSha);
  if (commit?.type !== "commit") return false;
  const treeMatch = /^tree ([a-f0-9]{40})$/mu.exec(commit.body.toString("utf8"));
  if (!treeMatch?.[1]) return false;
  const visitedObjects = new Set<string>([commitSha]);
  const validatedTrees = new Set<string>();
  const visitTree = (treeSha: string): boolean => {
    if (validatedTrees.has(treeSha)) return true;
    validatedTrees.add(treeSha);
    visitedObjects.add(treeSha);
    const tree = objects.get(treeSha);
    if (tree?.type !== "tree") return false;
    let offset = 0;
    while (offset < tree.body.length) {
      const space = tree.body.indexOf(0x20, offset);
      const nul = space < 0 ? -1 : tree.body.indexOf(0, space + 1);
      if (space <= offset || nul <= space + 1 || nul + 21 > tree.body.length) return false;
      const mode = tree.body.subarray(offset, space).toString("ascii");
      const name = tree.body.subarray(space + 1, nul).toString("utf8");
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) return false;
      const oid = tree.body.subarray(nul + 1, nul + 21).toString("hex");
      const object = objects.get(oid);
      if (mode === "40000") {
        if (!visitTree(oid)) return false;
      } else if ((mode !== "100644" && mode !== "100755") || object?.type !== "blob") {
        return false;
      } else {
        visitedObjects.add(oid);
      }
      offset = nul + 21;
    }
    return offset === tree.body.length;
  };
  return visitTree(treeMatch[1]) && visitedObjects.size === objects.size;
}

function parseRecoveryObjectManifest(value: Buffer): { commitSha: string; objectOids: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    throw new Error("app_revision_recovery_checkpoint_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("app_revision_recovery_checkpoint_invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.commitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(record.commitSha) ||
    !Array.isArray(record.objectOids) ||
    !record.objectOids.length ||
    record.objectOids.some((oid) => typeof oid !== "string" || !/^[a-f0-9]{40}$/u.test(oid)) ||
    new Set(record.objectOids).size !== record.objectOids.length
  ) {
    throw new Error("app_revision_recovery_checkpoint_invalid");
  }
  return { commitSha: record.commitSha, objectOids: record.objectOids as string[] };
}

function recoveryCheckpointRoot(gitdir: string, checkpointId: string): string {
  return resolve(gitdir, "opengrove-recovery", checkpointId);
}

function recoveryCheckpointIndexPath(gitdir: string, checkpointId: string): string {
  return resolve(recoveryCheckpointRoot(gitdir, checkpointId), "index");
}

function revisionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function revisionString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
