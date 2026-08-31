import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findAppStoreArchiveRoot,
  isSafeAppStoreArchiveEntry,
  validateAppStoreExtractedTree,
} from "../server/app-store-archive.js";

test("App Store archive paths reject traversal and absolute entries", () => {
  assert.equal(isSafeAppStoreArchiveEntry("app/opengrove.app.json"), true);
  assert.equal(isSafeAppStoreArchiveEntry("./app/assets/icon.png"), true);
  assert.equal(isSafeAppStoreArchiveEntry("../outside"), false);
  assert.equal(isSafeAppStoreArchiveEntry("app/../../outside"), false);
  assert.equal(isSafeAppStoreArchiveEntry("/absolute/path"), false);
  assert.equal(isSafeAppStoreArchiveEntry("C:\\absolute\\path"), false);
});

test("App Store archive root discovery follows package kind and ignores dependency trees", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-store-archive-root-"));
  try {
    mkdirSync(join(root, "wrapper", "app"), { recursive: true });
    mkdirSync(join(root, "wrapper", "node_modules", "fake"), { recursive: true });
    writeFileSync(join(root, "wrapper", "app", "opengrove.app.json"), "{}");
    writeFileSync(join(root, "wrapper", "node_modules", "fake", "employee.json"), "{}");
    assert.equal(findAppStoreArchiveRoot(root, "app"), join(root, "wrapper", "app"));
    assert.equal(findAppStoreArchiveRoot(root, "employee"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("App Store extracted trees reject symbolic links", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-app-store-archive-tree-"));
  try {
    writeFileSync(join(root, "target.txt"), "safe");
    symlinkSync(join(root, "target.txt"), join(root, "linked.txt"));
    assert.throws(() => validateAppStoreExtractedTree(root), /app_store_archive_symlink_rejected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
