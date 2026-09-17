import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { create, Header, type HeaderData } from "tar";
import AdmZip from "adm-zip";
import {
  findAppStoreArchiveRoot,
  isSafeAppStoreArchiveEntry,
  unpackAppStoreArchive,
  validateAppStoreExtractedTree,
} from "../server/app-store-archive.js";

for (const extension of ["tar", "tgz", "tar.gz", "zip"]) {
  test(`App Store extracts ${extension} with no external archive tools`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "opengrove-archive-故事 种子-"));
    const environment = process.env;
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      const archive = join(root, `故事 种子.${extension}`);
      mkdirSync(source);
      mkdirSync(target);
      writeFileSync(join(source, "opengrove.app.json"), '{"id":"story-seed"}');
      writeFileSync(join(source, "剧本.txt"), "故事种子");
      const longName = `${"long-".repeat(24)}剧本.txt`;
      writeFileSync(join(source, longName), "extended header");
      if (extension === "zip") {
        const zip = new AdmZip();
        zip.addLocalFolder(source);
        zip.writeZip(archive);
      } else {
        create({ file: archive, cwd: source, gzip: extension !== "tar", sync: true }, ["."]);
      }
      process.env = {
        ...environment,
        PATH: "",
        Path: "",
        SystemRoot: join(root, "missing"),
        WINDIR: join(root, "missing"),
      };
      const spawn = t.mock.method(childProcess, "spawnSync", () => {
        throw new Error("External archive tools disabled");
      });
      syncBuiltinESMExports();
      t.after(() => {
        spawn.mock.restore();
        syncBuiltinESMExports();
      });
      assert.deepEqual(unpackAppStoreArchive(archive, target), { ok: true });
      assert.equal(readFileSync(join(target, "opengrove.app.json"), "utf8"), '{"id":"story-seed"}');
      assert.equal(readFileSync(join(target, "剧本.txt"), "utf8"), "故事种子");
      assert.equal(readFileSync(join(target, longName), "utf8"), "extended header");
      assert.equal(spawn.mock.callCount(), 0);
    } finally {
      process.env = environment;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

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
function archiveFixture(extension: string, bytes: Buffer, run: (archive: string, target: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "opengrove-archive-check-"));
  try {
    const archive = join(root, `fixture.${extension}`);
    const target = join(root, "target");
    writeFileSync(archive, bytes);
    mkdirSync(target);
    run(archive, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function tarFixture(
  entries: Array<{ path: string; type?: HeaderData["type"]; size?: number; body?: string; mode?: number }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = new Header({
      ...entry,
      type: entry.type ?? "File",
      size: entry.size ?? body.length,
      mode: entry.mode ?? 0o644,
      ...(entry.type === "Link" || entry.type === "SymbolicLink" ? { linkpath: "../outside" } : {}),
    });
    const block = Buffer.alloc(512);
    header.encode(block);
    blocks.push(block, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function zipFixture(entries: Array<{ path: string; body?: string; mode?: number }>): Buffer {
  const zip = new AdmZip();
  for (const [index, entry] of entries.entries()) {
    const temporaryName = `fixture-${index}`;
    zip.addFile(temporaryName, Buffer.from(entry.body ?? ""));
    const added = zip.getEntry(temporaryName)!;
    added.entryName = entry.path;
    added.attr = ((entry.mode ?? 0o100644) << 16) >>> 0;
  }
  return zip.toBuffer();
}

for (const extension of ["tar", "zip"]) {
  test(`App Store normalizes ${extension} path separators`, () => {
    const entries = [{ path: "app\\nested\\file.txt", body: "contents" }];
    archiveFixture(extension, extension === "tar" ? tarFixture(entries) : zipFixture(entries), (archive, target) => {
      assert.deepEqual(unpackAppStoreArchive(archive, target), { ok: true });
      assert.equal(readFileSync(join(target, "app", "nested", "file.txt"), "utf8"), "contents");
    });
  });
  test(`App Store rejects ${extension} aliases for the same file`, () => {
    const entries = [
      { path: "app/file.txt", body: "first" },
      { path: "./app/file.txt", body: "second" },
    ];
    archiveFixture(extension, extension === "tar" ? tarFixture(entries) : zipFixture(entries), (archive, target) => {
      assert.deepEqual(unpackAppStoreArchive(archive, target), { ok: false, error: "app_store_archive_path_conflict" });
      assert.deepEqual(readdirSync(target), []);
    });
  });
  for (const path of [
    "../outside",
    "app/../../outside",
    "/absolute",
    "C:/outside",
    "C:outside",
    "file:stream",
    "app\\..\\outside",
    "app/NUL.txt",
    "app/trailing.",
  ]) {
    test(`App Store rejects ${extension} path ${path} before writing`, () => {
      const fixture =
        extension === "tar" ? tarFixture([{ path, body: "unsafe" }]) : zipFixture([{ path, body: "unsafe" }]);
      archiveFixture(extension, fixture, (archive, target) => {
        assert.deepEqual(unpackAppStoreArchive(archive, target), {
          ok: false,
          error: "app_store_archive_path_invalid",
        });
        assert.deepEqual(readdirSync(target), []);
      });
    });
  }
  test(`App Store rejects ${extension} file/directory collisions before writing`, () => {
    const entries = [
      { path: "app", body: "file" },
      { path: "app/child", body: "child" },
    ];
    archiveFixture(extension, extension === "tar" ? tarFixture(entries) : zipFixture(entries), (archive, target) => {
      assert.deepEqual(unpackAppStoreArchive(archive, target), { ok: false, error: "app_store_archive_path_conflict" });
      assert.deepEqual(readdirSync(target), []);
    });
  });
  test(`App Store preserves executable bits in ${extension}`, { skip: process.platform === "win32" }, () => {
    const entries = [{ path: "run.sh", body: "#!/bin/sh\n", mode: 0o100755 }];
    archiveFixture(extension, extension === "tar" ? tarFixture(entries) : zipFixture(entries), (archive, target) => {
      assert.deepEqual(unpackAppStoreArchive(archive, target), { ok: true });
      assert.equal(statSync(join(target, "run.sh")).mode & 0o777, 0o755);
    });
  });
  for (const [first, second] of [
    ["A.txt", "a.txt"],
    ["caf\u00e9.txt", "cafe\u0301.txt"],
  ] as const) {
    test(`App Store rejects ${extension} case/Unicode aliases ${first}/${second}`, {
      skip: process.platform === "linux",
    }, () => {
      const entries = [
        { path: first, body: "first" },
        { path: second, body: "second" },
      ];
      archiveFixture(extension, extension === "tar" ? tarFixture(entries) : zipFixture(entries), (archive, target) => {
        assert.deepEqual(unpackAppStoreArchive(archive, target), {
          ok: false,
          error: "app_store_archive_path_conflict",
        });
      });
    });
  }
  test(`App Store keeps missing-file errors for ${extension}`, (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    archiveFixture(extension, Buffer.alloc(0), (archive, target) => {
      rmSync(archive);
      const result = unpackAppStoreArchive(archive, target);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error, "app_store_archive_extract_failed: ENOENT");
        assert.equal(result.error.includes(archive), false);
        assert.equal(result.error.includes(target), false);
      }
      assert.equal(warn.mock.callCount(), 1);
      const [event, context, error] = warn.mock.calls[0]!.arguments;
      assert.equal(event, "app_store_archive_extract_failed");
      assert.deepEqual(context, { archivePath: archive, target });
      assert.ok(error instanceof Error);
      assert.match(error.message, /ENOENT/);
      assert.ok(error.message.includes(archive));
      assert.ok(error.stack?.includes(error.message));
    });
  });
  test(`App Store refuses a nonempty ${extension} extraction target`, () => {
    archiveFixture(extension, extension === "tar" ? tarFixture([]) : zipFixture([]), (archive, target) => {
      writeFileSync(join(target, "sentinel"), "keep");
      assert.deepEqual(unpackAppStoreArchive(archive, target), {
        ok: false,
        error: "app_store_archive_target_invalid",
      });
      assert.equal(readFileSync(join(target, "sentinel"), "utf8"), "keep");
    });
  });
}

for (const type of ["Link", "SymbolicLink", "CharacterDevice", "BlockDevice", "FIFO"] as const) {
  test(`App Store rejects TAR ${type} entries`, () => {
    archiveFixture("tar", tarFixture([{ path: "unsafe", type }]), (archive, target) => {
      assert.deepEqual(unpackAppStoreArchive(archive, target), {
        ok: false,
        error: "app_store_archive_entry_type_invalid",
      });
      assert.deepEqual(readdirSync(target), []);
    });
  });
}

for (const mode of [0o120777, 0o020644, 0o060644, 0o010644]) {
  test(`App Store rejects ZIP special mode ${mode.toString(8)}`, () => {
    archiveFixture("zip", zipFixture([{ path: "unsafe", mode }]), (archive, target) => {
      assert.deepEqual(unpackAppStoreArchive(archive, target), {
        ok: false,
        error: "app_store_archive_entry_type_invalid",
      });
      assert.deepEqual(readdirSync(target), []);
    });
  });
}

test("App Store rejects oversized TAR entries before reading their body", () => {
  archiveFixture("tar", tarFixture([{ path: "large", size: 1024 * 1024 * 1024 + 1 }]), (archive, target) => {
    assert.deepEqual(unpackAppStoreArchive(archive, target), {
      ok: false,
      error: "app_store_archive_unpacked_too_large",
    });
    assert.deepEqual(readdirSync(target), []);
  });
});

test("App Store rejects excessive TAR entries", () => {
  const fixture = tarFixture(Array.from({ length: 25_001 }, (_, index) => ({ path: `file-${index}` })));
  archiveFixture("tar", fixture, (archive, target) => {
    assert.deepEqual(unpackAppStoreArchive(archive, target), {
      ok: false,
      error: "app_store_archive_file_count_exceeded",
    });
    assert.deepEqual(readdirSync(target), []);
  });
});

test("App Store rejects oversized ZIP entries from directory metadata", () => {
  const fixture = zipFixture([{ path: "large", body: "small" }]);
  const central = fixture.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  fixture.writeUInt32LE(1024 * 1024 * 1024 + 1, central + 24);
  archiveFixture("zip", fixture, (archive, target) => {
    assert.deepEqual(unpackAppStoreArchive(archive, target), {
      ok: false,
      error: "app_store_archive_unpacked_too_large",
    });
    assert.deepEqual(readdirSync(target), []);
  });
});

test("App Store rejects excessive ZIP entries from directory metadata", () => {
  const fixture = zipFixture([{ path: "file" }]);
  fixture.writeUInt16LE(25_001, fixture.length - 14);
  fixture.writeUInt16LE(25_001, fixture.length - 12);
  archiveFixture("zip", fixture, (archive, target) => {
    const result = unpackAppStoreArchive(archive, target);
    assert.equal(result.ok, false);
    assert.deepEqual(readdirSync(target), []);
  });
});

for (const declaredSize of [0, 1]) {
  test(`App Store bounds ZIP inflation when the header lies about size ${declaredSize}`, () => {
    const fixture = zipFixture([{ path: "bomb", body: "a".repeat(100_000) }]);
    const central = fixture.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    fixture.writeUInt32LE(declaredSize, central + 24);
    fixture.writeUInt32LE(declaredSize, 22);
    archiveFixture("zip", fixture, (archive, target) => {
      assert.equal(unpackAppStoreArchive(archive, target).ok, false);
      assert.equal(existsSync(join(target, "bomb")), false);
    });
  });
}

test("App Store rejects ZIP files with a corrupt checksum", () => {
  const fixture = zipFixture([{ path: "file", body: "payload" }]);
  const central = fixture.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  fixture.writeUInt32LE(0, central + 16);
  fixture.writeUInt32LE(0, 14);
  archiveFixture("zip", fixture, (archive, target) => {
    assert.equal(unpackAppStoreArchive(archive, target).ok, false);
    assert.deepEqual(readdirSync(target), []);
  });
});

for (const [extension, bytes] of [
  ["tar", tarFixture([{ path: "truncated", body: "payload" }]).subarray(0, 515)],
  ["tgz", gzipSync(tarFixture([{ path: "file", body: "data" }])).subarray(0, 30)],
  ["zip", Buffer.from("not a zip")],
] as const) {
  test(`App Store rejects corrupt ${extension} archives`, () => {
    archiveFixture(extension, bytes, (archive, target) => {
      const result = unpackAppStoreArchive(archive, target);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /^app_store_archive_extract_failed(?:: [A-Z][A-Z0-9_]+)?$/);
      assert.deepEqual(readdirSync(target), []);
    });
  });
}

test("App Store logs the original ZIP error while returning only the public code", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  archiveFixture("zip", Buffer.from("not a zip"), (archive, target) => {
    assert.deepEqual(unpackAppStoreArchive(archive, target), {
      ok: false,
      error: "app_store_archive_extract_failed",
    });
    assert.equal(warn.mock.callCount(), 1);
    const [event, context, error] = warn.mock.calls[0]!.arguments;
    assert.equal(event, "app_store_archive_extract_failed");
    assert.deepEqual(context, { archivePath: archive, target });
    assert.ok(error instanceof Error);
    assert.equal(error.message, "ADM-ZIP: Invalid or unsupported zip format. No END header found");
    assert.ok(error.stack?.includes(error.message));
  });
});

test("TAR preflight rejects truncated input without opening output files or leaking handles", (t) => {
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const active = new Set<number>();
  const opened: string[] = [];
  const open = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpen(...args);
    active.add(fd);
    opened.push(String(args[0]));
    return fd;
  });
  const close = t.mock.method(fs, "closeSync", (fd: number) => {
    const result = originalClose(fd);
    active.delete(fd);
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    open.mock.restore();
    close.mock.restore();
    syncBuiltinESMExports();
    for (const fd of active) originalClose(fd);
  });
  const corrupt = tarFixture([{ path: "truncated", body: "payload" }]).subarray(0, 515);
  archiveFixture("tar", corrupt, (archive, target) => {
    opened.length = 0;
    assert.deepEqual(unpackAppStoreArchive(archive, target), {
      ok: false,
      error: "app_store_archive_extract_failed: TAR_BAD_ARCHIVE",
    });
    assert.equal(opened.includes(join(target, "truncated")), false);
    assert.equal(active.size, 0);
    assert.deepEqual(readdirSync(target), []);
  });
});

test("App Store accepts TAR archives larger than 256 MiB", () => {
  const size = 257 * 1024 * 1024;
  archiveFixture("tar", tarFixture([{ path: "app/large.bin", size }]), (archive, target) => {
    // Use a sparse zero-filled file body, followed by the two TAR end blocks,
    // instead of allocating a package-sized buffer in the test runner.
    fs.truncateSync(archive, 512 + size + 1024);
    assert.deepEqual(unpackAppStoreArchive(archive, target), { ok: true });
    assert.equal(statSync(join(target, "app", "large.bin")).size, size);
  });
});

for (const extension of ["tar", "zip"]) {
  test(`App Store rejects ${extension} archives over 1 GiB before parsing`, () => {
    archiveFixture(extension, Buffer.alloc(0), (archive, target) => {
      fs.truncateSync(archive, 1024 * 1024 * 1024 + 1);
      assert.deepEqual(unpackAppStoreArchive(archive, target), { ok: false, error: "app_store_archive_too_large" });
      assert.deepEqual(readdirSync(target), []);
    });
  });
}
