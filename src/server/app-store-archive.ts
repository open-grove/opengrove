import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import AdmZip from "adm-zip";
import { extract, list, type ReadEntry } from "tar";

const MAX_APP_STORE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_APP_STORE_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_APP_STORE_FILES = 25_000;

export type AppStoreArchiveKind = "app" | "employee";

export function unpackAppStoreArchive(
  archivePath: string,
  target: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const archive = lstatSync(archivePath);
    if (!archive.isFile()) throw new Error("app_store_archive_file_invalid");
    if (archive.size > MAX_APP_STORE_ARCHIVE_BYTES) throw new Error("app_store_archive_too_large");
    const targetEntry = lstatSync(target);
    if (!targetEntry.isDirectory() || targetEntry.isSymbolicLink() || readdirSync(target).length) {
      throw new Error("app_store_archive_target_invalid");
    }
    if (archivePath.toLowerCase().endsWith(".zip")) {
      unpackZipArchive(archivePath, target);
    } else {
      unpackTarArchive(archivePath, target);
    }
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return {
      ok: false,
      error: detail.startsWith("app_store_archive_")
        ? detail
        : `app_store_archive_extract_failed: ${code ? `${code}: ` : ""}${detail}`,
    };
  }
}

export function isSafeAppStoreArchiveEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /[\x00-\x1f<>:"|?*]/.test(normalized)) return false;
  return !normalized
    .split("/")
    .some(
      (segment) =>
        segment === ".." ||
        (segment !== "." &&
          (/[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment))),
    );
}

export function validateAppStoreExtractedTree(root: string): void {
  let totalBytes = 0;
  let entries = 0;
  const queue = [root];
  while (queue.length) {
    const current = queue.shift() ?? "";
    const stat = lstatSync(current);
    entries += 1;
    if (entries > MAX_APP_STORE_FILES) {
      throw new Error("app_store_archive_file_count_exceeded");
    }
    if (stat.isSymbolicLink()) {
      throw new Error("app_store_archive_symlink_rejected");
    }
    if (stat.isFile()) {
      totalBytes += stat.size;
      if (totalBytes > MAX_APP_STORE_UNPACKED_BYTES) {
        throw new Error("app_store_archive_unpacked_too_large");
      }
      continue;
    }
    if (!stat.isDirectory()) {
      throw new Error("app_store_archive_entry_type_invalid");
    }
    for (const name of readdirSync(current)) {
      queue.push(join(current, name));
    }
  }
}

export function copyAppStoreExtractedTree(sourceRoot: string, targetRoot: string): void {
  const stat = lstatSync(sourceRoot);
  if (stat.isSymbolicLink()) {
    throw new Error("app_store_archive_symlink_rejected");
  }
  if (stat.isDirectory()) {
    mkdirSync(targetRoot, { recursive: true });
    for (const name of readdirSync(sourceRoot)) {
      if (name === "node_modules" || name === ".git" || name === "__MACOSX") continue;
      copyAppStoreExtractedTree(join(sourceRoot, name), join(targetRoot, name));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error("app_store_archive_entry_type_invalid");
  }
  mkdirSync(dirname(targetRoot), { recursive: true });
  copyFileSync(sourceRoot, targetRoot);
}

export function findAppStoreArchiveRoot(root: string, kind: AppStoreArchiveKind): string | undefined {
  const manifestFile = kind === "employee" ? "employee.json" : "opengrove.app.json";
  const direct = singleDirectoryRoot(root) ?? root;
  if (existsSync(join(direct, manifestFile))) return direct;
  const queue = [direct];
  while (queue.length) {
    const current = queue.shift() ?? "";
    for (const name of safeReadDir(current)) {
      if (name === "__MACOSX" || name === ".git" || name === "node_modules") continue;
      const candidate = join(current, name);
      if (!safeStatIsDirectory(candidate)) continue;
      if (existsSync(join(candidate, manifestFile))) return candidate;
      queue.push(candidate);
    }
  }
  return undefined;
}

// Validate every entry's path, type, and size before writing. The target is a fresh, Host-owned
// staging directory; links and duplicate file paths never enter the extracted tree.
function archiveEntryValidator(): (path: string, directory: boolean, size: number) => string {
  let entries = 0;
  let bytes = 0;
  const paths = new Map<string, boolean>();
  return (path, directory, size) => {
    if (++entries > MAX_APP_STORE_FILES) throw new Error("app_store_archive_file_count_exceeded");
    if (!isSafeAppStoreArchiveEntry(path)) throw new Error("app_store_archive_path_invalid");
    if (!Number.isSafeInteger(size) || size < 0 || (directory && size !== 0)) {
      throw new Error("app_store_archive_size_invalid");
    }
    bytes += size;
    if (bytes > MAX_APP_STORE_UNPACKED_BYTES) throw new Error("app_store_archive_unpacked_too_large");
    const parts = path
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== ".");
    if (!parts.length && !directory) throw new Error("app_store_archive_path_invalid");
    for (let i = 1; i <= parts.length; i++) {
      const relative = parts.slice(0, i).join("/");
      const key = process.platform === "win32" ? relative.normalize("NFC").toLowerCase() : relative;
      const isDirectory = i < parts.length || directory;
      const previous = paths.get(key);
      if (previous !== undefined && (!previous || !isDirectory)) {
        throw new Error("app_store_archive_path_conflict");
      }
      paths.set(key, isDirectory);
      if (paths.size > MAX_APP_STORE_FILES) throw new Error("app_store_archive_file_count_exceeded");
    }
    return parts.join("/");
  };
}

function validateTarEntry(entry: ReadEntry, validate: ReturnType<typeof archiveEntryValidator>): void {
  if (entry.type !== "File" && entry.type !== "OldFile" && entry.type !== "Directory") {
    throw new Error("app_store_archive_entry_type_invalid");
  }
  entry.path = validate(entry.path, entry.type === "Directory", entry.size) || ".";
  // Preserve executable bits without restoring ownership or special permission bits.
  entry.mode = ((entry.mode ?? 0o644) & 0o777) | (entry.type === "Directory" ? 0o700 : 0o600);
}

function unpackTarArchive(archivePath: string, target: string): void {
  const validate = archiveEntryValidator();
  const parser = list({ sync: true, strict: true, onReadEntry: (entry) => validateTarEntry(entry, validate) });
  parser.on("ignoredEntry", () => {
    throw new Error("app_store_archive_entry_type_invalid");
  });
  parser.on("error", (error) => {
    throw error;
  });
  const fd = openSync(archivePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let size: number;
    while ((size = readSync(fd, buffer)) > 0) parser.write(buffer.subarray(0, size));
    parser.end();
  } finally {
    closeSync(fd);
  }
  const validateExtractedEntry = archiveEntryValidator();
  extract({
    file: archivePath,
    cwd: target,
    sync: true,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    filter: (_path, entry) => {
      if (!("type" in entry)) throw new Error("app_store_archive_entry_type_invalid");
      validateTarEntry(entry, validateExtractedEntry);
      return true;
    },
  });
}

function unpackZipArchive(archivePath: string, target: string): void {
  const zip = new AdmZip(archivePath);
  if (zip.getEntryCount() > MAX_APP_STORE_FILES) throw new Error("app_store_archive_file_count_exceeded");
  const validate = archiveEntryValidator();
  const entries = zip.getEntries().map((entry) => {
    const type = (entry.attr >>> 16) & 0o170000;
    if (type !== 0 && type !== (entry.isDirectory ? 0o040000 : 0o100000)) {
      throw new Error("app_store_archive_entry_type_invalid");
    }
    if (entry.header.flags & 1 || (entry.header.method !== 0 && entry.header.method !== 8)) {
      throw new Error("app_store_archive_zip_encoding_unsupported");
    }
    const path = validate(entry.entryName, entry.isDirectory, entry.header.size);
    return { entry, path };
  });
  for (const { entry, path } of entries) {
    const outputPath = join(target, path);
    if (entry.isDirectory) {
      mkdirSync(outputPath, { recursive: true });
      continue;
    }
    const data = entry.getData();
    if (data.length !== entry.header.size || crc32(data) !== entry.header.crc) {
      throw new Error("app_store_archive_zip_content_invalid");
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, data, { flag: "wx", mode: ((entry.attr >>> 16) & 0o777) | 0o600 });
  }
}

function singleDirectoryRoot(root: string): string | undefined {
  const entries = safeReadDir(root).filter((name) => name !== "__MACOSX" && name !== ".DS_Store");
  if (entries.length !== 1) return undefined;
  const candidate = join(root, entries[0] ?? "");
  return safeStatIsDirectory(candidate) ? candidate : undefined;
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeStatIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
