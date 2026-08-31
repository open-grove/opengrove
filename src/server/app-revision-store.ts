import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import git from "isomorphic-git";
import { canonicalPortableRelativePath } from "../app-builder/portable-path.js";
import { appReleaseSourcePathExcluded } from "./app-release-source-exclusions.js";
import { writePrivateFileAtomically } from "./private-file.js";

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

function revisionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function revisionString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
