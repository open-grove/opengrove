import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER_FILE = ".opengrove-owner.json";

/** Written before credentials are copied; launch intent precedes spawning a child. */
export function recordHermesHomeOwner(
  home: string,
  phase: "preparing" | "launching" | "running",
  gatewayPid?: number,
): void {
  const path = join(home, OWNER_FILE);
  const pending = `${path}.tmp`;
  writeFileSync(pending, JSON.stringify({ schemaVersion: 1, hostPid: process.pid, phase, gatewayPid }), {
    mode: 0o600,
  });
  renameSync(pending, path);
}

/** Never infer ownership from the directory name alone or delete a possibly live gateway's home. */
export function cleanupAbandonedHermesHomes(): void {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    console.warn("hermes_home_recovery_scan_failed");
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("opengrove-hermes-")) continue;
    const home = join(root, entry);
    let fd: number | undefined;
    try {
      const directory = lstatSync(home);
      if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())) continue;
      if (!lstatSync(join(home, OWNER_FILE)).isFile()) continue;
      fd = openSync(join(home, OWNER_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const receipt = fstatSync(fd);
      if (
        !receipt.isFile() ||
        receipt.size > 1024 ||
        receipt.nlink !== 1 ||
        (process.getuid && receipt.uid !== process.getuid())
      )
        continue;
      const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const owner = parsed as Record<string, unknown>;
      if (owner.schemaVersion !== 1 || !validPid(owner.hostPid) || !processHasExited(owner.hostPid)) continue;
      if (owner.phase === "running") {
        if (!validPid(owner.gatewayPid) || !processHasExited(owner.gatewayPid)) continue;
      } else if (owner.phase !== "preparing") {
        // A crash during spawn can leave an unrecorded live child. Keep it.
        continue;
      }
      closeSync(fd);
      fd = undefined;
      const current = lstatSync(home);
      if (current.dev !== directory.dev || current.ino !== directory.ino || !current.isDirectory()) continue;
      rmSync(home, { recursive: true, force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ELOOP") console.warn("hermes_home_recovery_deferred", { code });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function processHasExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
