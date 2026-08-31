import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tarCommand } from "../archive/tar-command.js";

const MAX_APP_STORE_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_APP_STORE_FILES = 25_000;

export type AppStoreArchiveKind = "app" | "employee";

export function unpackAppStoreArchive(
  archivePath: string,
  target: string,
): { ok: true } | { ok: false; error: string } {
  const entries = listArchiveEntries(archivePath);
  if (!entries.ok) return entries;
  if (entries.entries.length > MAX_APP_STORE_FILES) {
    return { ok: false, error: "app_store_archive_file_count_exceeded" };
  }
  if (entries.entries.some((entry) => !isSafeAppStoreArchiveEntry(entry))) {
    return { ok: false, error: "app_store_archive_path_invalid" };
  }
  if (isTarArchive(archivePath) && !tarEntryTypesSafe(archivePath)) {
    return { ok: false, error: "app_store_archive_entry_type_invalid" };
  }
  const lower = archivePath.toLowerCase();
  const command = lower.endsWith(".zip")
    ? { bin: "unzip", args: ["-q", archivePath, "-d", target] }
    : { bin: tarCommand(), args: ["-xf", archivePath, "-C", target] };
  const result = spawnSync(command.bin, command.args, { encoding: "utf8" });
  if (result.status === 0) return { ok: true };
  return { ok: false, error: `${command.bin} failed: ${(result.stderr || result.stdout || "").trim()}` };
}

export function isSafeAppStoreArchiveEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split("/").some((segment) => segment === "..");
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

function listArchiveEntries(archivePath: string): { ok: true; entries: string[] } | { ok: false; error: string } {
  const lower = archivePath.toLowerCase();
  const command = lower.endsWith(".zip")
    ? { bin: "unzip", args: ["-Z1", archivePath] }
    : { bin: tarCommand(), args: ["-tf", archivePath] };
  const result = spawnSync(command.bin, command.args, { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: `${command.bin} failed: ${(result.stderr || result.stdout || "").trim()}` };
  }
  return {
    ok: true,
    entries: result.stdout
      .split(/\r?\n/g)
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}

function tarEntryTypesSafe(archivePath: string): boolean {
  const result = spawnSync(tarCommand(), ["-tvf", archivePath], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return result.stdout
    .split(/\r?\n/g)
    .filter(Boolean)
    .every((line) => {
      const type = line[0] ?? "";
      return type === "-" || type === "d";
    });
}

function isTarArchive(archivePath: string): boolean {
  const lower = archivePath.toLowerCase();
  return lower.endsWith(".tar") || lower.endsWith(".tgz") || lower.endsWith(".tar.gz");
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
