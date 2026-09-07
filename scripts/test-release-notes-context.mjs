import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "opengrove-release-context-"));
const env = {
  ...process.env,
  GIT_DIR: join(root, ".git"),
  GIT_WORK_TREE: root,
  GIT_AUTHOR_NAME: "Release context test",
  GIT_AUTHOR_EMAIL: "release-context@example.test",
  GIT_COMMITTER_NAME: "Release context test",
  GIT_COMMITTER_EMAIL: "release-context@example.test",
};
const script = fileURLToPath(new URL("./release-notes-context.mjs", import.meta.url));

function git(args) {
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

try {
  git(["init", "--quiet"]);
  writeFileSync(join(root, "package.json"), '{"version":"1.2.2"}\n');
  git(["add", "package.json"]);
  git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial release"]);
  const previousRelease = git(["rev-parse", "HEAD"]);
  git(["-c", "tag.gpgsign=false", "tag", "v1.2.2"]);
  for (const [version, message] of [
    ["1.2.3", "Product change"],
    ["1.2.4", "Technical change"],
  ]) {
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ version })}\n`);
    git(["add", "package.json"]);
    git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message]);
  }
  git(["-c", "tag.gpgsign=false", "tag", "documentation-snapshot"]);
  const defaultRange = spawnSync(process.execPath, [script, "--json"], { env, encoding: "utf8" });
  assert.equal(defaultRange.status, 0, defaultRange.stderr);
  const context = JSON.parse(defaultRange.stdout);
  assert.equal(context.from, "v1.2.2", "non-release tags must not hide changes from the inventory");
  assert.deepEqual(
    context.commits.map((commit) => commit.subject),
    ["Product change", "Technical change"],
  );
  assert.deepEqual(context.files, ["M\tpackage.json"]);
  const explicitRange = spawnSync(process.execPath, [script, "--from", previousRelease, "--to", "HEAD", "--json"], {
    env,
    encoding: "utf8",
  });
  assert.equal(explicitRange.status, 0, explicitRange.stderr);
  assert.equal(JSON.parse(explicitRange.stdout).from, previousRelease);
  const reversed = spawnSync(process.execPath, [script, "--from", "HEAD", "--to", "HEAD~1"], { env, encoding: "utf8" });
  assert.equal(reversed.status, 1);
  assert.match(reversed.stderr, /--from.*must be an ancestor of --to/u);
  const missing = spawnSync(process.execPath, [script, "--from", "missing-ref"], { env, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stderr, /must be an ancestor/u, "unresolvable refs retain their original Git error");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("release notes context tests passed");
