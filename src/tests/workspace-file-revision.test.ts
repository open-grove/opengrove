import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalFilesystemWorkspaceStore, type WorkspaceScope } from "../server/workspace-store.js";

test("a stale save preserves an external edit even with identical size and mtime", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-file-revision-"));
  try {
    const store = new LocalFilesystemWorkspaceStore();
    const scope: WorkspaceScope = { kind: "local", appId: "test", root };
    const path = join(root, "outline.md");
    writeFileSync(path, "old\n");
    const initial = store.readFile(scope, "outline.md", { textSizeLimit: 100 });
    const stat = statSync(path);
    writeFileSync(path, "new\n");
    utimesSync(path, stat.atime, stat.mtime);
    assert.throws(
      () => store.writeFile(scope, "outline.md", "human\n", { expectedRevision: initial?.revision }),
      /workspace_file_conflict/,
    );
    assert.equal(readFileSync(path, "utf8"), "new\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
