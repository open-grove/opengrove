import { execFile, execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface LegacyLockHolder {
  readonly pid: number;
  readonly startedAt: string;
}

export interface LegacyLockInspectionOptions {
  isProcessAlive?(pid: number): boolean;
  readProcessStartedAt?(pid: number): number | undefined;
}

export interface AsyncLegacyLockInspectionOptions {
  isProcessAlive?(pid: number): boolean;
  readProcessStartedAt?(pid: number): number | undefined | Promise<number | undefined>;
}

export async function inspectLegacyStateLockAsync(
  holder: LegacyLockHolder,
  options: AsyncLegacyLockInspectionOptions = {},
): Promise<"dead_holder" | "reused_pid" | "holder_alive"> {
  if (!(options.isProcessAlive ?? isProcessAlive)(holder.pid)) return "dead_holder";
  const startedAt = await (options.readProcessStartedAt ?? readProcessStartedAtAsync)(holder.pid);
  return inspectLegacyStateLock(holder, {
    isProcessAlive: options.isProcessAlive,
    readProcessStartedAt: () => startedAt,
  });
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
  query: (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string = execFileSync,
): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const command = processStartCommand(pid, platform);
    return parseProcessStartedAt(query(command.file, command.args, processQueryOptions(platform)), platform);
  } catch {
    // non-critical-fallback: unavailable process metadata preserves the lock.
    return undefined;
  }
}

export async function readProcessStartedAtAsync(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  query: (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => Promise<string> = async (
    file,
    args,
    options,
  ) => (await execFileAsync(file, args, options)).stdout,
): Promise<number | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const command = processStartCommand(pid, platform);
    return parseProcessStartedAt(await query(command.file, command.args, processQueryOptions(platform)), platform);
  } catch {
    // non-critical-fallback: unavailable process metadata preserves the lock.
    return undefined;
  }
}

function processStartCommand(pid: number, platform: NodeJS.Platform): { file: string; args: string[] } {
  return platform === "win32"
    ? {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
      }
    : { file: "/bin/ps", args: ["-p", String(pid), "-o", "lstart="] };
}

function parseProcessStartedAt(output: string, platform: NodeJS.Platform): number | undefined {
  const raw = output.trim();
  if (!raw) return undefined;
  const timestamp = Date.parse(platform === "win32" ? raw : `${raw} UTC`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function processQueryOptions(platform: NodeJS.Platform): ExecFileSyncOptionsWithStringEncoding {
  return {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    // Windows PowerShell cold startup can exceed a short POSIX ps budget.
    timeout: platform === "win32" ? 8_000 : 2_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}
