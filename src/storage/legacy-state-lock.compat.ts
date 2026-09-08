import { execFileSync } from "node:child_process";

interface LegacyLockHolder {
  readonly pid: number;
  readonly startedAt: string;
}

export interface LegacyLockInspectionOptions {
  isProcessAlive?(pid: number): boolean;
  readProcessStartedAt?(pid: number): number | undefined;
}

/**
 * Supports: PID-only markers written by OpenGrove <=0.6.6.
 * Remove when: OpenGrove <=0.6.6 writers and their persisted markers are unsupported.
 * New writers use state-ownership.ts, not process-table probes. Unknown process
 * information is never evidence that a legacy writer has exited.
 */
export function inspectLegacyStateLock(
  holder: LegacyLockHolder,
  options: LegacyLockInspectionOptions = {},
): "dead_holder" | "reused_pid" | "holder_alive" {
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  if (!isAlive(holder.pid)) return "dead_holder";
  const recordedAt = Date.parse(holder.startedAt);
  if (!Number.isFinite(recordedAt)) return "holder_alive";
  const processStartedAt = (options.readProcessStartedAt ?? readProcessStartedAt)(holder.pid);
  // ps has one-second resolution. Keep a margin for timestamp rounding; an
  // ambiguous overlap must preserve the old writer's exclusion.
  if (processStartedAt !== undefined && processStartedAt > recordedAt + 2_000) return "reused_pid";
  return "holder_alive";
}

export function readProcessStartedAt(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  query: (file: string, args: string[]) => string = queryProcess,
): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const raw =
      platform === "win32"
        ? query("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
          ]).trim()
        : query("/bin/ps", ["-p", String(pid), "-o", "lstart="]).trim();
    if (!raw) return undefined;
    const timestamp = Date.parse(platform === "win32" ? raw : `${raw} UTC`);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  } catch {
    // non-critical-fallback: unavailable process metadata preserves the lock.
    return undefined;
  }
}

function queryProcess(file: string, args: string[]): string {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    timeout: 2_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}
