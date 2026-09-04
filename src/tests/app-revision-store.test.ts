import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import git from "isomorphic-git";
import {
  AppRevisionStore,
  isManagedAppRevisionWorkingCopy,
  managedAppRevisionGitDirectory,
  pruneManagedAppRevisionCheckpoints,
  restoreManagedAppRevisionCheckpoint,
} from "../server/app-revision-store.js";

test("managed App revisions materialize source without local runtime state", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-"));
  const appRoot = join(root, "app");
  const materializedRoot = join(root, "materialized");
  try {
    mkdirSync(join(appRoot, "ui"), { recursive: true });
    mkdirSync(join(appRoot, "web"), { recursive: true });
    mkdirSync(join(appRoot, "metadata"), { recursive: true });
    mkdirSync(join(appRoot, "workspace"), { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"revision-fixture","version":"0.1.0"}\n', "utf8");
    writeFileSync(join(appRoot, "ui", "index.html"), "<h1>first save point</h1>\n", "utf8");
    writeFileSync(join(appRoot, ".gitignore"), "ignored.txt\n", "utf8");
    writeFileSync(join(appRoot, "workspace", "private.txt"), "local workspace data\n", "utf8");
    writeFileSync(join(appRoot, ".env"), "PRIVATE_TOKEN=not-for-history\n", "utf8");
    writeFileSync(join(appRoot, "web", ".env"), "NESTED_TOKEN=not-for-history\n", "utf8");
    writeFileSync(join(appRoot, "metadata", ".DS_Store"), "machine metadata\n", "utf8");

    const store = new AppRevisionStore(join(root, "revisions"));
    const savePoint = await store.ensureWorkingCopy({
      localAppId: "local-revision-fixture",
      appRoot,
      workspacePath: "workspace",
    });
    const excludeFile = readFileSync(
      join(managedAppRevisionGitDirectory(join(root, "revisions"), "local-revision-fixture"), "info", "exclude"),
      "utf8",
    );
    assert.match(excludeFile, /^# OpenGrove-managed working copy exclusions$/m);
    assert.match(excludeFile, /^\/workspace$/m);

    assert.match(savePoint.commitSha, /^[a-f0-9]{40}$/);
    const savedFiles = await git.listFiles({
      fs,
      gitdir: managedAppRevisionGitDirectory(join(root, "revisions"), "local-revision-fixture"),
      ref: savePoint.commitSha,
    });
    assert.equal(savedFiles.includes("web/.env"), false, "nested credentials must not enter the save point tree");
    assert.equal(
      savedFiles.includes("metadata/.DS_Store"),
      false,
      "nested machine files must not enter the save point tree",
    );
    assert.equal(readFileSync(join(appRoot, ".git"), "utf8").startsWith("gitdir: "), true);
    assert.equal(
      isManagedAppRevisionWorkingCopy({
        revisionsRoot: join(root, "revisions"),
        localAppId: "local-revision-fixture",
        appRoot,
      }),
      true,
    );

    await store.materialize({
      localAppId: "local-revision-fixture",
      appRoot,
      workspacePath: "workspace",
      commitSha: savePoint.commitSha,
      targetRoot: materializedRoot,
    });

    assert.equal(readFileSync(join(materializedRoot, "ui", "index.html"), "utf8"), "<h1>first save point</h1>\n");
    assert.equal(existsSync(join(materializedRoot, "workspace")), false);
    assert.equal(existsSync(join(materializedRoot, ".env")), false);
    assert.equal(existsSync(join(materializedRoot, "web", ".env")), false);
    assert.equal(existsSync(join(materializedRoot, "metadata", ".DS_Store")), false);
    assert.equal(existsSync(join(materializedRoot, ".git")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing App repositories keep their branch, index, ignores, and history untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-adopt-"));
  const appRoot = join(root, "existing-app");
  const materializedRoot = join(root, "materialized-existing");
  try {
    mkdirSync(join(appRoot, "ui"), { recursive: true });
    mkdirSync(join(appRoot, "workspace"), { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"existing-revision","version":"0.1.0"}\n', "utf8");
    writeFileSync(join(appRoot, "ui", "index.html"), "existing history\n", "utf8");
    writeFileSync(join(appRoot, "ui", "tracked-but-ignored.js"), "tracked source\n", "utf8");
    writeFileSync(join(appRoot, "workspace", "private.txt"), "already tracked local state\n", "utf8");
    writeFileSync(join(appRoot, ".gitignore"), "private.pem\nui/tracked-but-ignored.js\n", "utf8");
    runGit(appRoot, "init", "--quiet", "--initial-branch=topic");
    runGit(appRoot, "config", "user.name", "Existing Author");
    runGit(appRoot, "config", "user.email", "existing@example.com");
    runGit(appRoot, "add", ".");
    runGit(appRoot, "add", "--force", "ui/tracked-but-ignored.js");
    runGit(appRoot, "commit", "--quiet", "--message", "Existing App history");
    const existingCommit = runGit(appRoot, "rev-parse", "HEAD");
    writeFileSync(join(appRoot, "private.pem"), "ignored private material\n", "utf8");
    writeFileSync(join(appRoot, "ui", "index.html"), "staged author edit\n", "utf8");
    runGit(appRoot, "add", "ui/index.html");
    const statusBeforeAdoption = runGit(appRoot, "status", "--porcelain=v1");

    const store = new AppRevisionStore(join(root, "opengrove-revisions"));
    const adopted = await store.ensureWorkingCopy({
      localAppId: "local-existing-revision",
      appRoot,
      workspacePath: "workspace",
    });
    assert.match(adopted.commitSha, /^[a-f0-9]{40}$/u);
    assert.notEqual(adopted.commitSha, existingCommit, "OpenGrove save points live outside the user branch");
    assert.equal(existsSync(join(appRoot, ".git", "HEAD")), true);
    assert.equal(
      isManagedAppRevisionWorkingCopy({
        revisionsRoot: join(root, "opengrove-revisions"),
        localAppId: "local-existing-revision",
        appRoot,
      }),
      false,
    );
    assert.equal(runGit(appRoot, "rev-parse", "HEAD"), existingCommit);
    assert.equal(runGit(appRoot, "status", "--porcelain=v1"), statusBeforeAdoption);

    writeFileSync(join(appRoot, "ui", "index.html"), "saved by OpenGrove\n", "utf8");
    const statusBeforeSave = runGit(appRoot, "status", "--porcelain=v1");
    const saved = await store.save({
      localAppId: "local-existing-revision",
      appRoot,
      workspacePath: "workspace",
      message: "Save App changes",
    });
    assert.notEqual(saved.commitSha, adopted.commitSha);
    assert.equal(runGit(appRoot, "rev-parse", "HEAD"), existingCommit, "saving must not advance the user branch");
    assert.equal(
      runGit(appRoot, "status", "--porcelain=v1"),
      statusBeforeSave,
      "saving must not rewrite the user index or working status",
    );

    await store.materialize({
      localAppId: "local-existing-revision",
      appRoot,
      workspacePath: "workspace",
      commitSha: saved.commitSha,
      targetRoot: materializedRoot,
    });
    assert.equal(readFileSync(join(materializedRoot, "ui", "index.html"), "utf8"), "saved by OpenGrove\n");
    assert.equal(
      readFileSync(join(materializedRoot, "ui", "tracked-but-ignored.js"), "utf8"),
      "tracked source\n",
      "a file already tracked by an adopted repository remains source even when an ignore rule also matches it",
    );
    assert.equal(existsSync(join(materializedRoot, "workspace")), false);
    assert.equal(
      existsSync(join(materializedRoot, "private.pem")),
      false,
      "ignored files must stay out of save points",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed App revisions expose dirty changes and preserve earlier save points", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-save-"));
  const appRoot = join(root, "app");
  try {
    mkdirSync(join(appRoot, "ui"), { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"revision-save","version":"0.1.0"}\n', "utf8");
    writeFileSync(join(appRoot, "ui", "index.html"), "before\n", "utf8");
    const store = new AppRevisionStore(join(root, "revisions"));
    const first = await store.ensureWorkingCopy({
      localAppId: "local-revision-save",
      appRoot,
      workspacePath: "workspace",
    });

    writeFileSync(join(appRoot, "ui", "index.html"), "after\n", "utf8");
    const dirty = await store.inspect({
      localAppId: "local-revision-save",
      appRoot,
      workspacePath: "workspace",
    });
    assert.equal(dirty.commitSha, first.commitSha);
    assert.equal(dirty.dirty, true);
    assert.deepEqual(dirty.changedFiles, ["ui/index.html"]);
    assert.doesNotThrow(() => new Date(dirty.savedAt).toISOString());

    const second = await store.save({
      localAppId: "local-revision-save",
      appRoot,
      workspacePath: "workspace",
      message: "Update the App UI",
    });
    assert.notEqual(second.commitSha, first.commitSha);
    const clean = await store.inspect({
      localAppId: "local-revision-save",
      appRoot,
      workspacePath: "workspace",
    });
    assert.equal(clean.commitSha, second.commitSha);
    assert.equal(clean.dirty, false);
    assert.deepEqual(clean.changedFiles, []);

    const restoredRoot = join(root, "restored-first");
    await store.materialize({
      localAppId: "local-revision-save",
      appRoot,
      workspacePath: "workspace",
      commitSha: first.commitSha,
      targetRoot: restoredRoot,
    });
    assert.equal(readFileSync(join(restoredRoot, "ui", "index.html"), "utf8"), "before\n");
    const afterMaterialize = await store.inspect({
      localAppId: "local-revision-save",
      appRoot,
      workspacePath: "workspace",
    });
    assert.equal(afterMaterialize.commitSha, second.commitSha);
    assert.equal(afterMaterialize.dirty, false);
    assert.deepEqual(afterMaterialize.changedFiles, []);
    assert.equal(
      afterMaterialize.savedAt,
      clean.savedAt,
      "materializing an earlier save point must not move the live working copy HEAD",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignored source files do not make the working copy dirty or enter a save point", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-ignored-"));
  const appRoot = join(root, "app");
  try {
    mkdirSync(join(appRoot, "ui"), { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"revision-ignored","version":"0.1.0"}\n', "utf8");
    writeFileSync(join(appRoot, ".gitignore"), "ui/\n", "utf8");
    writeFileSync(join(appRoot, "ui", "index.html"), "first\n", "utf8");
    const store = new AppRevisionStore(join(root, "revisions"));
    const first = await store.ensureWorkingCopy({
      localAppId: "local-revision-ignored",
      appRoot,
      workspacePath: "workspace",
    });

    writeFileSync(join(appRoot, "ui", "second.html"), "second\n", "utf8");
    const dirty = await store.inspect({
      localAppId: "local-revision-ignored",
      appRoot,
      workspacePath: "workspace",
    });
    assert.equal(dirty.commitSha, first.commitSha);
    assert.equal(dirty.dirty, false);
    assert.deepEqual(dirty.changedFiles, []);

    const second = await store.saveIfChanged({
      localAppId: "local-revision-ignored",
      appRoot,
      workspacePath: "workspace",
      message: "Save ignored source file",
    });
    assert.equal(second.commitSha, first.commitSha);
    assert.deepEqual(await git.listFiles({ fs, dir: appRoot, ref: second.commitSha }), [
      ".gitignore",
      "opengrove.app.json",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked Git worktrees keep their real repository and index untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-worktree-"));
  const repositoryRoot = join(root, "repository");
  const appRoot = join(root, "app-worktree");
  const materializedRoot = join(root, "materialized-worktree");
  try {
    mkdirSync(join(repositoryRoot, "ui"), { recursive: true });
    writeFileSync(join(repositoryRoot, "opengrove.app.json"), '{"id":"linked-worktree","version":"0.1.0"}\n', "utf8");
    writeFileSync(join(repositoryRoot, "ui", "index.html"), "committed\n", "utf8");
    runGit(repositoryRoot, "init", "--quiet", "--initial-branch=main");
    runGit(repositoryRoot, "config", "user.name", "Worktree Author");
    runGit(repositoryRoot, "config", "user.email", "worktree@example.com");
    runGit(repositoryRoot, "add", ".");
    runGit(repositoryRoot, "commit", "--quiet", "--message", "Worktree base");
    runGit(repositoryRoot, "worktree", "add", "--quiet", "-b", "app-work", appRoot);

    writeFileSync(join(appRoot, "ui", "index.html"), "staged worktree edit\n", "utf8");
    runGit(appRoot, "add", "ui/index.html");
    const headBefore = runGit(appRoot, "rev-parse", "HEAD");
    const statusBefore = runGit(appRoot, "status", "--porcelain=v1");
    const store = new AppRevisionStore(join(root, "opengrove-revisions"));
    const savePoint = await store.ensureWorkingCopy({
      localAppId: "local-linked-worktree",
      appRoot,
      workspacePath: "workspace",
    });

    assert.match(savePoint.commitSha, /^[a-f0-9]{40}$/u);
    assert.equal(runGit(appRoot, "rev-parse", "HEAD"), headBefore);
    assert.equal(runGit(appRoot, "status", "--porcelain=v1"), statusBefore);
    assert.equal(runGit(repositoryRoot, "fsck", "--full"), "");

    await store.materialize({
      localAppId: "local-linked-worktree",
      appRoot,
      workspacePath: "workspace",
      commitSha: savePoint.commitSha,
      targetRoot: materializedRoot,
    });
    assert.equal(readFileSync(join(materializedRoot, "ui", "index.html"), "utf8"), "staged worktree edit\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a relocated linked worktree reattaches to its managed OpenGrove save points", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-worktree-reattach-"));
  const repositoryRoot = join(root, "repository");
  const appRoot = join(root, "app-worktree");
  const activatedRoot = join(root, "activated-app");
  const revisionsRoot = join(root, "opengrove-revisions");
  try {
    mkdirSync(repositoryRoot, { recursive: true });
    writeFileSync(join(repositoryRoot, "opengrove.app.json"), '{"id":"linked-reattach","version":"0.1.0"}\n');
    writeFileSync(join(repositoryRoot, "program.txt"), "linked source\n", "utf8");
    runGit(repositoryRoot, "init", "--quiet", "--initial-branch=main");
    runGit(repositoryRoot, "config", "user.name", "Worktree Author");
    runGit(repositoryRoot, "config", "user.email", "worktree@example.com");
    runGit(repositoryRoot, "add", ".");
    runGit(repositoryRoot, "commit", "--quiet", "--message", "Worktree base");
    runGit(repositoryRoot, "worktree", "add", "--quiet", "-b", "app-work", appRoot);

    const store = new AppRevisionStore(revisionsRoot);
    const first = await store.ensureWorkingCopy({
      localAppId: "local-linked-reattach",
      appRoot,
      workspacePath: "workspace",
    });
    cpSync(appRoot, activatedRoot, { recursive: true });

    const reattached = await store.ensureWorkingCopy({
      localAppId: "local-linked-reattach",
      appRoot: activatedRoot,
      workspacePath: "workspace",
    });
    assert.equal(reattached.commitSha, first.commitSha);
    assert.match(
      readFileSync(join(activatedRoot, ".git"), "utf8"),
      /^gitdir: .+\/opengrove-revisions\/[a-f0-9]{64}\.git\n$/u,
      "the activated program must point at OpenGrove save points instead of a stale external worktree gitdir",
    );
    assert.equal(runGit(repositoryRoot, "fsck", "--full"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executable-bit changes create a restorable save point", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-mode-"));
  const appRoot = join(root, "app");
  const materializedRoot = join(root, "materialized-mode");
  try {
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"revision-mode","version":"0.1.0"}\n', "utf8");
    writeFileSync(join(appRoot, "run.sh"), "#!/bin/sh\n", { mode: 0o644 });
    const store = new AppRevisionStore(join(root, "revisions"));
    const first = await store.ensureWorkingCopy({
      localAppId: "local-revision-mode",
      appRoot,
      workspacePath: "workspace",
    });

    chmodSync(join(appRoot, "run.sh"), 0o755);
    assert.equal(
      (await store.inspect({ localAppId: "local-revision-mode", appRoot, workspacePath: "workspace" })).dirty,
      true,
    );
    const second = await store.saveIfChanged({
      localAppId: "local-revision-mode",
      appRoot,
      workspacePath: "workspace",
      message: "Make the App command executable",
    });
    assert.notEqual(second.commitSha, first.commitSha);
    assert.equal(
      (await store.inspect({ localAppId: "local-revision-mode", appRoot, workspacePath: "workspace" })).dirty,
      false,
    );

    await store.materialize({
      localAppId: "local-revision-mode",
      appRoot,
      workspacePath: "workspace",
      commitSha: second.commitSha,
      targetRoot: materializedRoot,
    });
    assert.equal(statSync(join(materializedRoot, "run.sh")).mode & 0o777, 0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a save after interrupted index staging recovers one complete source save point", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-recovery-"));
  const appRoot = join(root, "app");
  const materializedRoot = join(root, "materialized-recovery");
  try {
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"revision-recovery","version":"0.1.0"}\n', "utf8");
    writeFileSync(join(appRoot, "program.txt"), "first\n", "utf8");
    const store = new AppRevisionStore(join(root, "revisions"));
    const first = await store.ensureWorkingCopy({
      localAppId: "local-revision-recovery",
      appRoot,
      workspacePath: "workspace",
    });
    const pointer = /^gitdir:\s+(.+)\s*$/u.exec(readFileSync(join(appRoot, ".git"), "utf8"));
    assert.ok(pointer?.[1]);

    writeFileSync(join(appRoot, "program.txt"), "partially staged\n", "utf8");
    await git.add({ fs, dir: appRoot, gitdir: pointer[1], filepath: "program.txt" });
    writeFileSync(join(appRoot, "program.txt"), "final after restart\n", "utf8");

    const saved = await store.saveIfChanged({
      localAppId: "local-revision-recovery",
      appRoot,
      workspacePath: "workspace",
      message: "Recover interrupted App save",
    });
    assert.notEqual(saved.commitSha, first.commitSha);
    assert.equal(
      (await store.inspect({ localAppId: "local-revision-recovery", appRoot, workspacePath: "workspace" })).dirty,
      false,
    );
    await store.materialize({
      localAppId: "local-revision-recovery",
      appRoot,
      workspacePath: "workspace",
      commitSha: saved.commitSha,
      targetRoot: materializedRoot,
    });
    assert.equal(readFileSync(join(materializedRoot, "program.txt"), "utf8"), "final after restart\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing empty repository receives its first OpenGrove save point", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-empty-"));
  const appRoot = join(root, "empty-repository-app");
  const materializedRoot = join(root, "materialized-empty");
  try {
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"empty-repository","version":"0.1.0"}\n', "utf8");
    await git.init({ fs, dir: appRoot, defaultBranch: "main" });
    const userStatusBefore = runGit(appRoot, "status", "--porcelain=v1");

    const store = new AppRevisionStore(join(root, "revisions"));
    const first = await store.ensureWorkingCopy({
      localAppId: "local-empty-repository",
      appRoot,
      workspacePath: "workspace",
    });

    assert.match(first.commitSha, /^[a-f0-9]{40}$/u);
    assert.equal(runGit(appRoot, "status", "--porcelain=v1"), userStatusBefore);
    await store.materialize({
      localAppId: "local-empty-repository",
      appRoot,
      workspacePath: "workspace",
      commitSha: first.commitSha,
      targetRoot: materializedRoot,
    });
    assert.equal(
      readFileSync(join(materializedRoot, "opengrove.app.json"), "utf8"),
      '{"id":"empty-repository","version":"0.1.0"}\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an App cannot redirect revision writes into an unrelated repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-pointer-"));
  const appRoot = join(root, "app");
  const unrelatedRoot = join(root, "unrelated");
  try {
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(unrelatedRoot, { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"pointer-fixture","version":"0.1.0"}\n', "utf8");
    await git.init({ fs, dir: unrelatedRoot, defaultBranch: "main" });
    writeFileSync(join(appRoot, ".git"), `gitdir: ${join(unrelatedRoot, ".git")}\n`, "utf8");

    const store = new AppRevisionStore(join(root, "revisions"));
    await assert.rejects(
      () =>
        store.ensureWorkingCopy({
          localAppId: "local-pointer-fixture",
          appRoot,
          workspacePath: "workspace",
        }),
      /app_revision_existing_repository_requires_adoption/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fabricated recovery checkpoint cannot move a managed App revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-fake-recovery-"));
  const appRoot = join(root, "app");
  const revisionsRoot = join(root, "revisions");
  try {
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"fake-recovery","version":"0.1.0"}\n', "utf8");
    writeFileSync(join(appRoot, "program.txt"), "trusted source\n", "utf8");
    const store = new AppRevisionStore(revisionsRoot);
    const savePoint = await store.ensureWorkingCopy({
      localAppId: "local-fake-recovery",
      appRoot,
      workspacePath: "workspace",
    });

    assert.throws(
      () =>
        restoreManagedAppRevisionCheckpoint({
          revisionsRoot,
          localAppId: "local-fake-recovery",
          appRoot,
          checkpoint: {
            checkpointId: "f".repeat(32),
            commitSha: "3".repeat(40),
            indexSha256: "4".repeat(64),
            objectManifestSha256: "5".repeat(64),
          },
        }),
      /ENOENT|app_revision_recovery_checkpoint_invalid/u,
    );
    assert.equal(
      (
        await store.inspect({
          localAppId: "local-fake-recovery",
          appRoot,
          workspacePath: "workspace",
        })
      ).commitSha,
      savePoint.commitSha,
      "an untrusted journal value must not move the private revision branch",
    );

    const checkpoint = await store.captureRecoveryCheckpoint({
      localAppId: "local-fake-recovery",
      appRoot,
      workspacePath: "workspace",
    });
    const gitdir = managedAppRevisionGitDirectory(revisionsRoot, "local-fake-recovery");
    const commit = await git.readCommit({ fs, gitdir, oid: savePoint.commitSha });
    const tree = await git.readTree({ fs, gitdir, oid: commit.commit.tree });
    const blobOid = tree.tree.find((entry) => entry.type === "blob")?.oid;
    assert.ok(blobOid);
    const poisonedManifest = Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, commitSha: blobOid, objectOids: [blobOid] })}\n`,
      "utf8",
    );
    writeFileSync(join(gitdir, "opengrove-recovery", checkpoint.checkpointId, "objects.json"), poisonedManifest);
    assert.throws(
      () =>
        restoreManagedAppRevisionCheckpoint({
          revisionsRoot,
          localAppId: "local-fake-recovery",
          appRoot,
          checkpoint: {
            ...checkpoint,
            commitSha: blobOid,
            objectManifestSha256: createHash("sha256").update(poisonedManifest).digest("hex"),
          },
        }),
      /app_revision_recovery_checkpoint_invalid/u,
      "a hash-valid blob must not be accepted as a recovery commit",
    );
    assert.equal(
      (await store.inspect({ localAppId: "local-fake-recovery", appRoot, workspacePath: "workspace" })).commitSha,
      savePoint.commitSha,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recovery checkpoint survives Git gc and an index v4 working copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-gc-recovery-"));
  const appRoot = join(root, "app");
  const revisionsRoot = join(root, "revisions");
  try {
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"gc-recovery","version":"0.1.0"}\n', "utf8");
    writeFileSync(join(appRoot, "program.txt"), "before gc\n", "utf8");
    const store = new AppRevisionStore(revisionsRoot);
    const first = await store.ensureWorkingCopy({
      localAppId: "local-gc-recovery",
      appRoot,
      workspacePath: "workspace",
    });
    runGit(appRoot, "gc", "--prune=now");
    runGit(appRoot, "update-index", "--index-version=4");
    const checkpoint = await store.captureRecoveryCheckpoint({
      localAppId: "local-gc-recovery",
      appRoot,
      workspacePath: "workspace",
    });

    writeFileSync(join(appRoot, "program.txt"), "after checkpoint\n", "utf8");
    const second = await store.save({
      localAppId: "local-gc-recovery",
      appRoot,
      workspacePath: "workspace",
      message: "Advance before recovery",
    });
    assert.notEqual(second.commitSha, first.commitSha);
    runGit(appRoot, "gc", "--prune=now");

    restoreManagedAppRevisionCheckpoint({
      revisionsRoot,
      localAppId: "local-gc-recovery",
      appRoot,
      checkpoint,
    });
    const recovered = await store.inspect({
      localAppId: "local-gc-recovery",
      appRoot,
      workspacePath: "workspace",
    });
    assert.equal(recovered.commitSha, first.commitSha);
    assert.equal(recovered.dirty, true, "recovery restores revision metadata without overwriting the program tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup cleanup removes only unreferenced recovery checkpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-revision-prune-recovery-"));
  const appRoot = join(root, "app");
  const revisionsRoot = join(root, "revisions");
  try {
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, "opengrove.app.json"), '{"id":"prune-recovery","version":"0.1.0"}\n', "utf8");
    const store = new AppRevisionStore(revisionsRoot);
    await store.ensureWorkingCopy({ localAppId: "local-prune-recovery", appRoot, workspacePath: "workspace" });
    const retained = await store.captureRecoveryCheckpoint({
      localAppId: "local-prune-recovery",
      appRoot,
      workspacePath: "workspace",
    });
    const orphaned = await store.captureRecoveryCheckpoint({
      localAppId: "local-prune-recovery",
      appRoot,
      workspacePath: "workspace",
    });

    pruneManagedAppRevisionCheckpoints({
      revisionsRoot,
      retainedCheckpointIds: new Set([retained.checkpointId]),
    });
    assert.doesNotThrow(() =>
      restoreManagedAppRevisionCheckpoint({
        revisionsRoot,
        localAppId: "local-prune-recovery",
        appRoot,
        checkpoint: retained,
      }),
    );
    assert.throws(
      () =>
        restoreManagedAppRevisionCheckpoint({
          revisionsRoot,
          localAppId: "local-prune-recovery",
          appRoot,
          checkpoint: orphaned,
        }),
      /ENOENT/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runGit(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
