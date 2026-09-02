import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Atomically replaces a local secret-bearing file with owner-only permissions. */
export function writePrivateFileAtomically(path: string, contents: string | Buffer): void {
  const parent = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(parent, { recursive: true });

  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    if (typeof contents === "string") {
      writeFileSync(descriptor, contents, { encoding: "utf8" });
    } else {
      writeFileSync(descriptor, contents);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    renamed = true;
    fsyncDirectoryBestEffort(parent);
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      if (!renamed) rmSync(temporaryPath, { force: true });
    }
  }
}

export function writePrivateJsonAtomically(path: string, value: unknown): void {
  writePrivateFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fsyncDirectoryBestEffort(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // non-critical-fallback: Some platforms do not permit directory fsync; the atomic file rename remains complete.
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } catch {
      // Directory fsync/close is best-effort on unsupported platforms.
    }
  }
}
