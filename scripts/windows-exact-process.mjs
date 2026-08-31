import { spawnSync } from "node:child_process";
import { sanitizedWindowsPowerShellEnv, windowsPowerShellExecutable } from "./windows-powershell-env.mjs";

export const stopWindowsExactExecutableScript = [
  "$items = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:OPENGROVE_GATE_EXE }",
  "$items | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
].join("\n");

export const windowsExactExecutableRunningScript = [
  "$items = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:OPENGROVE_GATE_EXE }",
  "if ($items) { exit 0 } else { exit 1 }",
].join("\n");

export function stopWindowsExactExecutable(path, { run = spawnSync, env = process.env } = {}) {
  return run(windowsPowerShellExecutable, ["-NoProfile", "-Command", stopWindowsExactExecutableScript], {
    env: sanitizedWindowsPowerShellEnv(env, { OPENGROVE_GATE_EXE: path }),
    stdio: "ignore",
  });
}

export function isWindowsExactExecutableRunning(path, { run = spawnSync, env = process.env } = {}) {
  return (
    run(windowsPowerShellExecutable, ["-NoProfile", "-Command", windowsExactExecutableRunningScript], {
      env: sanitizedWindowsPowerShellEnv(env, { OPENGROVE_GATE_EXE: path }),
      stdio: "ignore",
    }).status === 0
  );
}
