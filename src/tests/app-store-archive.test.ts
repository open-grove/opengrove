import assert from "node:assert/strict";
import childProcess, { type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tarCommand } from "../archive/tar-command.js";
import {
  findAppStoreArchiveRoot,
  isSafeAppStoreArchiveEntry,
  unpackAppStoreArchive,
  validateAppStoreExtractedTree,
} from "../server/app-store-archive.js";

test("App Store archive errors identify a missing unpacking tool", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-missing-archive-tool-"));
  const environment = process.env;
  try {
    const missingRoot = join(root, "missing-windows");
    assert.equal(existsSync(missingRoot), false);
    process.env = { ...environment, SystemRoot: missingRoot, WINDIR: missingRoot, PATH: "", Path: "" };
    const result = unpackAppStoreArchive(join(root, "app.tgz"), join(root, "target"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /tar.*failed/);
    assert.match(result.error, /ENOENT/);
  } finally {
    process.env = environment;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [archive, operation] of [
  ["app.tgz", "-tf"],
  ["app.tgz", "-tvf"],
  ["app.tgz", "-xf"],
  ["app.zip", "-Z1"],
  ["app.zip", "-q"],
] as const) {
  const failures: { label: string; result: Partial<SpawnSyncReturns<string>>; expected: RegExp[] }[] = [
    {
      label: "system error",
      result: { error: Object.assign(new Error("access denied"), { code: "EACCES", errno: -13 }) },
      expected: [/EACCES/, /errno -13/, /access denied/],
    },
    { label: "empty output", result: { status: 7 }, expected: [/exit code 7/] },
    { label: "signal", result: { signal: "SIGTERM" }, expected: [/signal SIGTERM/] },
  ];
  for (const failure of failures) {
    test(`App Store ${archive} ${operation} preserves ${failure.label}`, (t) => {
      const spawn = t.mock.method(childProcess, "spawnSync", (_bin: string, args: string[]) => {
        const result: SpawnSyncReturns<string> = {
          pid: 1,
          output: [],
          stdout: "",
          stderr: "",
          status: null,
          signal: null,
        };
        if (args[0] === operation) return { ...result, ...failure.result };
        return { ...result, status: 0, stdout: args[0] === "-tvf" ? "-rw-r--r-- app/file.txt\n" : "app/file.txt\n" };
      });
      syncBuiltinESMExports();
      t.after(() => {
        spawn.mock.restore();
        syncBuiltinESMExports();
      });
      const result = unpackAppStoreArchive(archive, "target");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.ok(result.error.includes(operation), "the error identifies which archive operation failed");
      for (const expected of failure.expected) assert.match(result.error, expected);
    });
  }
}

test("App Store extracts an archive with spaces and Unicode in its paths", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-archive-故事 种子-"));
  const environment = process.env;
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    const archive = join(root, "故事 种子.tgz");
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, "opengrove.app.json"), '{"id":"story-seed"}');
    childProcess.execFileSync(tarCommand(), ["-czf", archive, "-C", source, "."]);
    if (process.platform === "win32") {
      process.env = { ...environment, PATH: "", Path: "" };
    }
    assert.deepEqual(unpackAppStoreArchive(archive, target), { ok: true });
    assert.equal(readFileSync(join(target, "opengrove.app.json"), "utf8"), '{"id":"story-seed"}');
  } finally {
    process.env = environment;
    rmSync(root, { recursive: true, force: true });
  }
});

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
