import { pathToFileURL } from "node:url";
import { startLocalProfile } from "../profiles/local.js";
import { isStateFileLockError } from "../storage/state-file-lock.js";
import type { LocalBridgeServerOptions } from "./bridge-types.js";

export function startLocalBridgeServer(options: LocalBridgeServerOptions = {}) {
  return startLocalProfile(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startLocalBridgeServer();
  } catch (error) {
    if (isStateFileLockError(error)) {
      process.stderr.write(`${friendlyStateLockMessage(error)}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function friendlyStateLockMessage(
  error: Error & {
    code?: string;
    lockPath?: string;
    statePath?: string;
    holder?: { pid: number; host: string; startedAt: string };
  },
): string {
  if (error.code === "STATE_LOCKED") {
    const holder = error.holder
      ? `pid ${error.holder.pid} on ${error.holder.host} since ${error.holder.startedAt}`
      : "another process";
    return `Another OpenGrove bridge is already using ${error.statePath ?? "this state file"} (${holder}). Stop it first, or set OPENGROVE_STATE_PATH to a different file.`;
  }
  if (error.code === "state_lock_unreadable") {
    return `OpenGrove cannot trust the state lock ${error.lockPath ?? ""}. Delete that lock file manually after confirming no bridge is running, or set OPENGROVE_STATE_PATH to a different file.`;
  }
  return error.message;
}
