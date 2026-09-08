import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LocalFilesystemWorkspaceStore,
  type WorkspaceScope,
  type WorkspaceReadOptions,
} from "../server/workspace-store.js";

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

test("write acknowledgement describes submitted bytes even if a later reader observes another writer", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-write-ack-"));
  try {
    const scope: WorkspaceScope = { kind: "local", appId: "test", root };
    class ExternalWriterBeforeRead extends LocalFilesystemWorkspaceStore {
      override readFile(scope: WorkspaceScope, path: string, options?: WorkspaceReadOptions) {
        writeFileSync(join(scope.root, path), "external");
        return super.readFile(scope, path, options);
      }
    }
    const store = new ExternalWriterBeforeRead();
    const saved = store.writeFile(scope, "file.txt", "hello", { expectedRevision: "missing" });
    assert.equal(saved?.content, "hello");
    assert.equal(saved?.revision, "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    assert.equal(saved?.entry.size, 5);
    assert.equal(store.readFile(scope, "file.txt", { textSizeLimit: 100 })?.content, "external");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
