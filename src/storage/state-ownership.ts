import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalizeStatePath } from "./state-identity.js";

export const STATE_OWNERSHIP_PROTOCOL = "sqlite-v1";

export interface StateOwnership {
  readonly released: boolean;
  release(): void;
}

const ownedPaths = new Set<string>();

/**
 * A separate, empty SQLite database supplies OS-backed exclusion for the whole
 * writer lifetime, including JSON stores and in-memory snapshots. Its inode
 * must never be removed or replaced: doing so could create two independent
 * locks. No business data or transaction is held in this coordination file.
 */
export function acquireStateOwnership(statePath: string): StateOwnership | undefined {
  const canonical = canonicalizeStatePath(statePath);
  // Reject duplicate acquisitions in this process without opening another
  // SQLite connection. SQLite's VFS manages its own OS file-lock bookkeeping.
  if (ownedPaths.has(canonical)) return undefined;
  mkdirSync(dirname(canonical), { recursive: true });
  const database = new DatabaseSync(`${canonical}.lock.sqlite`, { timeout: 0 });
  try {
    database.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (isOwnershipBusy(error)) return undefined;
    throw error;
  }
  ownedPaths.add(canonical);
  let released = false;
  return {
    get released() {
      return released;
    },
    release() {
      if (released) return;
      try {
        database.close();
      } finally {
        // A failed close may leave the connection open: retain exclusion and
        // the retryable handle until it actually closes.
        if (!database.isOpen) {
          ownedPaths.delete(canonical);
          released = true;
        }
      }
    },
  };
}

function isOwnershipBusy(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("errcode" in error)) return false;
  return typeof error.errcode === "number" && (error.errcode & 0xff) === 5;
}
