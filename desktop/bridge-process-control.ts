import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface DesktopBridgeProcessControlDependencies {
  isAlive?(pid: number): boolean;
  kill?(pid: number, signal: NodeJS.Signals): void;
  readCommandLine?(pid: number): string;
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

  for (const pid of targets) {
    const commandLine = readCommandLine(pid);
    if (!desktopBridgeCommandLooksOwned(commandLine)) {
      throw new Error(`desktop_bridge_blocker_not_owned:${pid}`);
    }
  }
  for (const pid of targets) {
    if (isAlive(pid)) kill(pid, "SIGTERM");
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (targets.every((pid) => !isAlive(pid))) return;
    await wait(50);
  }
  throw new Error(`desktop_bridge_blocker_did_not_stop:${targets.join(",")}`);
}

export function ownedDesktopBridgeProcessIds(pids: number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))].filter((pid) => {
    try {
      return desktopBridgeCommandLooksOwned(readDesktopProcessCommandLine(pid));
    } catch {
      return false;
    }
  });
}

export function desktopBridgeListenerProcessIds(port: number): number[] {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return [];
  try {
    const output =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-NetTCPConnection -State Listen -LocalPort ${port}).OwningProcess`,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
          )
        : execFileSync(
            process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
            ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          );
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

function readDesktopProcessCommandLine(pid: number): string {
  if (process.platform === "linux") {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/gu, " ");
  }
  if (process.platform === "win32") {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    ).trim();
  }
  return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
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
