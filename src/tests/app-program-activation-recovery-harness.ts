import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appProgramActivationTransactionParent,
  beginAppProgramActivationRecovery,
  commitAppProgramActivationRecovery,
  finalizeInterruptedAppProgramActivation,
  recoverInterruptedAppProgramActivations,
} from "../server/app-program-activation-recovery.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-app-program-recovery-"));

try {
  const formalAppRoot = join(tempRoot, "apps", "formal-app");
  const formalTransactionRoot = join(tempRoot, "apps", ".opengrove-install-transactions", "formal-transaction");
  const formalStagedRoot = join(formalTransactionRoot, "next-app");
  writeProgramTree(formalAppRoot, "previous formal");
  writeProgramTree(formalStagedRoot, "interrupted formal");
  mkdirSync(join(formalAppRoot, ".git"), { recursive: true });
  writeFileSync(join(formalAppRoot, ".git", "HEAD"), "ref: refs/heads/local\n", "utf8");

  const formalRecovery = beginAppProgramActivationRecovery({
    kind: "formal",
    appRoot: formalAppRoot,
    transactionRoot: formalTransactionRoot,
    stagedAppRoot: formalStagedRoot,
    previousWorkspaceRelativePath: "workspace",
    nextWorkspaceRelativePath: "workspace",
    previousWorkspacePresent: true,
    previousGitPresent: true,
  });
  renameSync(formalAppRoot, formalRecovery.previousAppRoot);
  rmSync(join(formalStagedRoot, "workspace"), { recursive: true, force: true });
  renameSync(join(formalRecovery.previousAppRoot, "workspace"), join(formalStagedRoot, "workspace"));
  renameSync(join(formalRecovery.previousAppRoot, ".git"), join(formalStagedRoot, ".git"));
  renameSync(formalStagedRoot, formalAppRoot);
  renameSync(formalAppRoot, join(formalRecovery.backupContainer, "interrupted-app"));

  const formalResult = recoverInterruptedAppProgramActivations([formalAppRoot]);
  assert.deepEqual(formalResult.failed, []);
  assert.deepEqual(formalResult.recovered, [formalAppRoot]);
  assert.equal(readFileSync(join(formalAppRoot, "program.txt"), "utf8"), "previous formal\n");
  assert.equal(readFileSync(join(formalAppRoot, "workspace", "keep.md"), "utf8"), "keep\n");
  assert.equal(readFileSync(join(formalAppRoot, ".git", "HEAD"), "utf8"), "ref: refs/heads/local\n");
  assert.equal(existsSync(formalTransactionRoot), false);
  assert.equal(existsSync(formalRecovery.backupContainer), false);

  const draftAppRoot = join(tempRoot, "apps", "draft-app");
  const draftTransactionRoot = join(tempRoot, "apps", ".opengrove-draft-transactions", "draft-transaction");
  const draftStagedRoot = join(draftTransactionRoot, "next-app");
  writeProgramTree(draftAppRoot, "previous draft base");
  writeProgramTree(draftStagedRoot, "prepared local draft");
  const draftRecovery = beginAppProgramActivationRecovery({
    kind: "local-draft",
    appRoot: draftAppRoot,
    transactionRoot: draftTransactionRoot,
    stagedAppRoot: draftStagedRoot,
    previousWorkspaceRelativePath: "workspace",
    nextWorkspaceRelativePath: "workspace",
    previousWorkspacePresent: true,
    previousGitPresent: false,
  });

  const draftResult = recoverInterruptedAppProgramActivations([draftAppRoot]);
  assert.deepEqual(draftResult.failed, []);
  assert.deepEqual(draftResult.recovered, [draftAppRoot]);
  assert.equal(readFileSync(join(draftAppRoot, "program.txt"), "utf8"), "previous draft base\n");
  assert.equal(existsSync(draftTransactionRoot), false);
  assert.equal(existsSync(draftRecovery.backupContainer), false);

  const storeRoot = join(tempRoot, "store");
  const sideBySideAppRoot = join(storeRoot, "programs", "a".repeat(64), "1.0.0-archive-generation", "app");
  const sideBySideTransactionParent = appProgramActivationTransactionParent("local-draft", sideBySideAppRoot);
  assert.equal(sideBySideTransactionParent, join(storeRoot, "staging", "draft-transactions"));
  const sideBySideTransactionRoot = join(sideBySideTransactionParent, "draft-transaction");
  const sideBySideStagedRoot = join(sideBySideTransactionRoot, "next-app");
  writeProgramTree(sideBySideAppRoot, "previous side-by-side program");
  writeProgramTree(sideBySideStagedRoot, "prepared side-by-side draft");
  const sideBySideRecovery = beginAppProgramActivationRecovery({
    kind: "local-draft",
    appRoot: sideBySideAppRoot,
    transactionRoot: sideBySideTransactionRoot,
    stagedAppRoot: sideBySideStagedRoot,
    previousWorkspaceRelativePath: "workspace",
    nextWorkspaceRelativePath: "workspace",
    previousWorkspacePresent: true,
    previousGitPresent: false,
  });
  assert.equal(
    sideBySideRecovery.backupContainer.startsWith(join(storeRoot, "staging", "draft-backups")),
    true,
    "Store-managed generations must keep recovery data out of their deep Program path",
  );
  renameSync(sideBySideAppRoot, sideBySideRecovery.previousAppRoot);
  rmSync(join(sideBySideStagedRoot, "workspace"), { recursive: true, force: true });
  renameSync(join(sideBySideRecovery.previousAppRoot, "workspace"), join(sideBySideStagedRoot, "workspace"));
  renameSync(sideBySideStagedRoot, sideBySideAppRoot);
  const sideBySideResult = recoverInterruptedAppProgramActivations([sideBySideAppRoot]);
  assert.deepEqual(sideBySideResult.failed, []);
  assert.deepEqual(sideBySideResult.recovered, [sideBySideAppRoot]);
  assert.equal(readFileSync(join(sideBySideAppRoot, "program.txt"), "utf8"), "previous side-by-side program\n");
  assert.equal(existsSync(sideBySideRecovery.backupContainer), false);
  assert.equal(existsSync(sideBySideTransactionRoot), false);

  const committedAppRoot = join(tempRoot, "apps", "committed-app");
  const committedTransactionRoot = join(tempRoot, "apps", ".opengrove-install-transactions", "committed-transaction");
  const committedStagedRoot = join(committedTransactionRoot, "next-app");
  writeProgramTree(committedAppRoot, "previous committed");
  writeProgramTree(committedStagedRoot, "new committed");
  const committedRecovery = beginAppProgramActivationRecovery({
    kind: "formal",
    appRoot: committedAppRoot,
    transactionRoot: committedTransactionRoot,
    stagedAppRoot: committedStagedRoot,
    previousWorkspaceRelativePath: "workspace",
    nextWorkspaceRelativePath: "workspace",
    previousWorkspacePresent: true,
    previousGitPresent: false,
  });
  renameSync(committedAppRoot, committedRecovery.previousAppRoot);
  rmSync(join(committedStagedRoot, "workspace"), { recursive: true, force: true });
  renameSync(join(committedRecovery.previousAppRoot, "workspace"), join(committedStagedRoot, "workspace"));
  renameSync(committedStagedRoot, committedAppRoot);
  assert.equal(finalizeInterruptedAppProgramActivation(committedAppRoot), true);
  assert.equal(readFileSync(join(committedAppRoot, "program.txt"), "utf8"), "new committed\n");
  assert.equal(readFileSync(join(committedAppRoot, "workspace", "keep.md"), "utf8"), "keep\n");
  assert.equal(existsSync(committedRecovery.backupContainer), false);
  assert.equal(existsSync(committedTransactionRoot), false);
  assert.equal(finalizeInterruptedAppProgramActivation(committedAppRoot), false);

  const cleanupFailureAppRoot = join(tempRoot, "apps", "cleanup-failure-app");
  const cleanupFailureTransactionRoot = join(
    tempRoot,
    "apps",
    ".opengrove-install-transactions",
    "cleanup-failure-transaction",
  );
  const cleanupFailureStagedRoot = join(cleanupFailureTransactionRoot, "next-app");
  writeProgramTree(cleanupFailureAppRoot, "previous cleanup failure");
  writeProgramTree(cleanupFailureStagedRoot, "new cleanup failure");
  const cleanupFailureRecovery = beginAppProgramActivationRecovery({
    kind: "formal",
    appRoot: cleanupFailureAppRoot,
    transactionRoot: cleanupFailureTransactionRoot,
    stagedAppRoot: cleanupFailureStagedRoot,
    previousWorkspaceRelativePath: "workspace",
    nextWorkspaceRelativePath: "workspace",
    previousWorkspacePresent: true,
    previousGitPresent: false,
  });
  renameSync(cleanupFailureAppRoot, cleanupFailureRecovery.previousAppRoot);
  rmSync(join(cleanupFailureStagedRoot, "workspace"), { recursive: true, force: true });
  renameSync(join(cleanupFailureRecovery.previousAppRoot, "workspace"), join(cleanupFailureStagedRoot, "workspace"));
  renameSync(cleanupFailureStagedRoot, cleanupFailureAppRoot);
  commitAppProgramActivationRecovery(cleanupFailureAppRoot);

  const cleanupFailureResult = recoverInterruptedAppProgramActivations([cleanupFailureAppRoot]);
  assert.deepEqual(cleanupFailureResult.failed, []);
  assert.deepEqual(cleanupFailureResult.recovered, [cleanupFailureAppRoot]);
  assert.equal(
    readFileSync(join(cleanupFailureAppRoot, "program.txt"), "utf8"),
    "new cleanup failure\n",
    "startup cleanup after a committed activation must preserve the new program tree",
  );
  assert.equal(readFileSync(join(cleanupFailureAppRoot, "workspace", "keep.md"), "utf8"), "keep\n");
  assert.equal(existsSync(cleanupFailureRecovery.backupContainer), false);
  assert.equal(existsSync(cleanupFailureTransactionRoot), false);

  process.stdout.write("app program activation recovery harness passed\n");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function writeProgramTree(root: string, program: string): void {
  mkdirSync(join(root, "workspace"), { recursive: true });
  writeFileSync(join(root, "program.txt"), `${program}\n`, "utf8");
  writeFileSync(join(root, "workspace", "keep.md"), "keep\n", "utf8");
}
