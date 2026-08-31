import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_JSON_STATE_FILE_NAME, SQLITE_STATE_FILE_NAME } from "../src/storage/default-data-dir.js";

export function repairDesktopStateAccess(userDataDir: string): void {
  const dataDir = join(userDataDir, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const sqlitePath = join(dataDir, SQLITE_STATE_FILE_NAME);
  const legacyJsonPath = join(dataDir, LEGACY_JSON_STATE_FILE_NAME);
  for (const path of [
    sqlitePath,
    `${sqlitePath}-wal`,
    `${sqlitePath}-shm`,
    `${sqlitePath}-journal`,
    `${sqlitePath}.lock`,
    legacyJsonPath,
    `${legacyJsonPath}.lock`,
    join(dataDir, "bridge-settings.json"),
  ]) {
    repairOwnedFile(path);
  }
  repairOwnedTree(join(dataDir, "state-blobs"));
}

function repairOwnedFile(path: string): void {
  if (!existsSync(path)) return;
  const entry = lstatSync(path);
  if (entry.isFile()) chmodSync(path, 0o600);
}

function repairOwnedTree(path: string): void {
  if (!existsSync(path)) return;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return;
  if (entry.isFile()) {
    chmodSync(path, 0o600);
    return;
  }
  if (!entry.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const child of readdirSync(path)) {
    repairOwnedTree(join(path, child));
  }
}
