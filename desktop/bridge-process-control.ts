import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const processQueryOptions = {
  encoding: "utf8" as const,
  timeout: process.platform === "win32" ? 8_000 : 2_000,
  maxBuffer: 64 * 1024,
  windowsHide: true,
};

interface DesktopBridgeProcessControlDependencies {
  isAlive?(pid: number): boolean;
  kill?(pid: number, signal: NodeJS.Signals): void;
  readCommandLine?(pid: number): string | Promise<string>;
  wait?(delayMs: number): Promise<void>;
}

export async function stopOwnedDesktopBridgeProcesses(
  pids: number[],
  dependencies: DesktopBridgeProcessControlDependencies = {},
): Promise<void> {
  const targets = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (targets.length === 0) throw new Error("desktop_bridge_blocker_has_no_process");
  const readCommandLine = dependencies.readCommandLine ?? readDesktopProcessCommandLine;
  const isAlive = dependencies.isAlive ?? isProcessAlive;
  const kill = dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));
  const wait = dependencies.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  const signalled: number[] = [];
  for (const pid of targets) {
    if (!isAlive(pid)) continue;
    const commandLine = await readCommandLine(pid);
    if (!desktopBridgeCommandLooksOwned(commandLine)) {
      throw new Error(`desktop_bridge_blocker_not_owned:${pid}`);
    }
    if (isAlive(pid)) {
      kill(pid, "SIGTERM");
      signalled.push(pid);
    }
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (signalled.every((pid) => !isAlive(pid))) return;
    await wait(50);
  }
  throw new Error(`desktop_bridge_blocker_did_not_stop:${signalled.join(",")}`);
}

export async function ownedDesktopBridgeProcessIds(pids: number[]): Promise<number[]> {
  const owned: number[] = [];
  for (const pid of new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))) {
    try {
      if (desktopBridgeCommandLooksOwned(await readDesktopProcessCommandLine(pid))) owned.push(pid);
    } catch {
      // non-critical-fallback: omit process controls when ownership cannot be verified.
    }
  }
  return owned;
}

export async function desktopBridgeListenerProcessIds(port: number): Promise<number[]> {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return [];
  try {
    const output =
      process.platform === "win32"
        ? (
            await execFileAsync(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `(Get-NetTCPConnection -State Listen -LocalPort ${port}).OwningProcess`,
              ],
              processQueryOptions,
            )
          ).stdout
        : (
            await execFileAsync(
              process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
              ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
              processQueryOptions,
            )
          ).stdout;
    return [
      ...new Set(
        output
          .split(/\s+/u)
          .map(Number)
          .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      ),
    ];
  } catch {
    // non-critical-fallback: the retry action remains available when listener inspection is unavailable.
    return [];
  }
}

export function desktopBridgeCommandLooksOwned(commandLine: string): boolean {
  const normalized = commandLine.trim().replace(/\\/gu, "/").replace(/["']/gu, "");
  if (/(?:^|[/\s])desktop-bridge-entry\.(?:js|cjs|mjs)(?:$|\s)/iu.test(normalized)) return true;
  return /opengrove[^\s]*\/dist\/cli\.(?:js|cjs|mjs)\s+(?:start|bridge|web)(?:$|\s)/iu.test(normalized);
}

async function readDesktopProcessCommandLine(pid: number): Promise<string> {
  if (process.platform === "linux") {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/gu, " ");
  }
  if (process.platform === "win32") {
    return (
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
        ],
        processQueryOptions,
      )
    ).stdout.trim();
  }
  return (await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="], processQueryOptions)).stdout.trim();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeCode(error, "ESRCH");
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}
