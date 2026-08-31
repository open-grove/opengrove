import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readAppEnv } from "../identity.js";

// 卸载不做不可逆删除:目录移入系统废纸篓(或平台等价目录),用户可自行恢复。
export function moveToTrash(targetPath: string): string {
  const trashRoot = resolveTrashRoot(targetPath);
  mkdirSync(trashRoot, { recursive: true });
  const trashedName = uniqueTrashName(trashRoot, basename(targetPath));
  const destination = join(trashRoot, trashedName);
  try {
    renameSync(targetPath, destination);
  } catch {
    // 跨卷 rename 会 EXDEV:复制成功后再删原目录,失败时原目录保持原样。
    cpSync(targetPath, destination, { recursive: true, errorOnExist: true, force: false });
    rmSync(targetPath, { recursive: true, force: true });
  }
  writeLinuxTrashInfo(trashRoot, trashedName, targetPath);
  return destination;
}

function resolveTrashRoot(targetPath: string): string {
  const override = readAppEnv("TRASH_DIR")?.trim();
  if (override) return override;
  if (process.platform === "darwin") return join(homedir(), ".Trash");
  if (process.platform === "linux") {
    const xdgDataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
    return join(xdgDataHome, "Trash", "files");
  }
  return join(dirname(targetPath), ".opengrove-trash");
}

function uniqueTrashName(trashRoot: string, name: string): string {
  if (!existsSync(join(trashRoot, name))) return name;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = `${name} ${stamp}`;
  let counter = 1;
  while (existsSync(join(trashRoot, candidate))) {
    candidate = `${name} ${stamp}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function writeLinuxTrashInfo(trashRoot: string, trashedName: string, originalPath: string): void {
  // freedesktop Trash 规范要求 info 文件,否则桌面环境无法列出/还原该条目。
  if (process.platform !== "linux" || basename(dirname(trashRoot)) !== "Trash") return;
  const infoDir = join(dirname(trashRoot), "info");
  try {
    mkdirSync(infoDir, { recursive: true });
    writeFileSync(
      join(infoDir, `${trashedName}.trashinfo`),
      `[Trash Info]\nPath=${encodeURI(originalPath)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`,
      "utf8",
    );
  } catch {
    // 写不了 info 文件不影响卸载本身;文件仍在 files/ 下可手动找回。
  }
}
