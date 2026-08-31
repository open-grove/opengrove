import { execFileSync } from "node:child_process";
import { sep } from "node:path";

const PROCESS_TABLE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export function readOpenGroveDevProcessTable({ execFile = execFileSync } = {}) {
  try {
    return execFile("ps", ["eww", "-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: PROCESS_TABLE_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    // Do not attach the child-process error: it may retain the complete
    // environment-bearing process table in stdout/output fields.
    throw new Error(`OpenGrove Dev process scan failed (${code})`);
  }
}

export function isOpenGroveDevProcess(command, projectRoot, profileName) {
  if (!command) return false;

  const profileMatch = command.match(/(?:^|\s)OPENGROVE_DESKTOP_DEV_PROFILE=([^\s]+)(?=\s|$)/u);
  const processProfileName = profileMatch?.[1];
  if (profileName ? processProfileName !== profileName : processProfileName !== undefined) return false;

  // Current builds use one user-level Dev app, while older worktrees can still
  // have a project-local copy. Both share the same single-instance lock and
  // must be stopped before a restart can prove which source tree is running.
  if (command.includes(`${sep}OpenGrove Dev.app${sep}`)) {
    return true;
  }

  if (!command.includes(projectRoot)) return false;
  return (
    command.includes(`${sep}release${sep}desktop${sep}mac-arm64${sep}OpenGrove.app${sep}`) ||
    command.includes(`${sep}dist${sep}server${sep}desktop-bridge-entry.js`) ||
    command.includes(`${sep}scripts${sep}launch-desktop-dev.mjs`)
  );
}
