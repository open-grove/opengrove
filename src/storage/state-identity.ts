import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function canonicalizeStatePath(statePath: string): string {
  const resolved = resolve(statePath);
  try {
    if (existsSync(resolved)) {
      return realpathSync.native(resolved);
    }
    const parent = dirname(resolved);
    if (existsSync(parent)) {
      return join(realpathSync.native(parent), basename(resolved));
    }
  } catch {
    // Fall through to the resolved path. The lock layer is fail-closed where it
    // has stronger context; state identity should stay deterministic.
  }
  return resolved;
}

export function stateIdFor(statePath: string): string {
  const canonical = canonicalizeStatePath(statePath);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
