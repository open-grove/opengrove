import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommandPath } from "../kernel/discovery.js";

const TERMINAL_ROOT_PREFIX = "opengrove-kernel-login-";

export interface SystemTerminalCommand {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  unsetEnvironment: string[];
}

export interface SystemTerminalLaunch {
  cleanupRoot: string;
  resultPath: string;
  launcher: ChildProcess;
}

export function launchSystemTerminalCommand(
  input: SystemTerminalCommand,
  platform: NodeJS.Platform = process.platform,
): SystemTerminalLaunch {
  const cleanupRoot = mkdtempSync(join(tmpdir(), TERMINAL_ROOT_PREFIX));
  const resultPath = join(cleanupRoot, "exit-code");
  try {
    if (platform === "darwin") {
      const scriptPath = join(cleanupRoot, "OpenGrove Kernel Login.command");
      writeFileSync(scriptPath, systemTerminalScript(input, resultPath, platform), { encoding: "utf8", mode: 0o700 });
      chmodSync(scriptPath, 0o700);
      return {
        cleanupRoot,
        resultPath,
        launcher: spawn("/usr/bin/open", ["-a", "Terminal", scriptPath], {
          stdio: "ignore",
          windowsHide: true,
        }),
      };
    }
    if (platform === "win32") {
      const scriptPath = join(cleanupRoot, "opengrove-kernel-login.ps1");
      writeFileSync(scriptPath, systemTerminalScript(input, resultPath, platform), "utf8");
      const startCommand = [
        "Start-Process",
        "-FilePath",
        powershellQuote("powershell.exe"),
        "-ArgumentList",
        `@(${["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath].map(powershellQuote).join(",")})`,
      ].join(" ");
      const encoded = Buffer.from(startCommand, "utf16le").toString("base64");
      return {
        cleanupRoot,
        resultPath,
        launcher: spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
          stdio: "ignore",
          windowsHide: true,
        }),
      };
    }
    const scriptPath = join(cleanupRoot, "opengrove-kernel-login.sh");
    writeFileSync(scriptPath, systemTerminalScript(input, resultPath, platform), { encoding: "utf8", mode: 0o700 });
    chmodSync(scriptPath, 0o700);
    const terminal = linuxTerminalInvocation(scriptPath);
    return {
      cleanupRoot,
      resultPath,
      launcher: spawn(terminal.command, terminal.args, {
        stdio: "ignore",
        windowsHide: true,
      }),
    };
  } catch (error) {
    rmSync(cleanupRoot, { recursive: true, force: true });
    throw error;
  }
}

export function systemTerminalScript(
  input: SystemTerminalCommand,
  resultPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? powershellTerminalScript(input, resultPath) : posixTerminalScript(input, resultPath);
}

export function cleanupStaleSystemTerminalRoots(options: { root?: string; now?: number; maxAgeMs: number }): void {
  const root = options.root ?? tmpdir();
  const now = options.now ?? Date.now();
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith(TERMINAL_ROOT_PREFIX)) continue;
      const path = join(root, name);
      try {
        if (now - statSync(path).mtimeMs >= options.maxAgeMs) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // Cleanup is best-effort; session creation still owns current failures.
      }
    }
  } catch {
    // non-critical-fallback: A missing or unreadable temp root must not prevent the bridge from starting.
  }
}

function linuxTerminalInvocation(scriptPath: string): { command: string; args: string[] } {
  const candidates = [
    { command: "x-terminal-emulator", args: ["-e", scriptPath] },
    { command: "gnome-terminal", args: ["--", "sh", scriptPath] },
    { command: "konsole", args: ["-e", "sh", scriptPath] },
    { command: "xfce4-terminal", args: ["-e", `sh ${shellQuote(scriptPath)}`] },
    { command: "xterm", args: ["-e", "sh", scriptPath] },
  ];
  const candidate = candidates.find(({ command }) => resolveCommandPath(command));
  if (!candidate) throw new Error("kernel_login_terminal_unavailable");
  return candidate;
}

function posixTerminalScript(input: SystemTerminalCommand, resultPath: string): string {
  const environment = Object.entries(input.environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `export ${shellName(key)}=${shellQuote(value)}`);
  return [
    "#!/bin/sh",
    ...input.unsetEnvironment.map((key) => `unset ${shellName(key)}`),
    ...environment,
    `cd ${shellQuote(input.cwd)}`,
    [input.command, ...input.args].map(shellQuote).join(" "),
    "opengrove_status=$?",
    `printf '%s' "$opengrove_status" > ${shellQuote(resultPath)}`,
    'if [ "$opengrove_status" -eq 0 ]; then',
    "  printf '\\nLogin complete. This window can be closed.\\n'",
    "else",
    "  printf '\\nLogin failed (exit %s). Review the CLI output above.\\n' \"$opengrove_status\"",
    "fi",
    'exit "$opengrove_status"',
    "",
  ].join("\n");
}

function powershellTerminalScript(input: SystemTerminalCommand, resultPath: string): string {
  const environment = Object.entries(input.environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `$env:${powershellName(key)} = ${powershellQuote(value)}`);
  return [
    ...input.unsetEnvironment.map((key) => `$env:${powershellName(key)} = $null`),
    ...environment,
    `Set-Location -LiteralPath ${powershellQuote(input.cwd)}`,
    `& ${[input.command, ...input.args].map(powershellQuote).join(" ")}`,
    "$opengroveStatus = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }",
    `Set-Content -LiteralPath ${powershellQuote(resultPath)} -Value $opengroveStatus -NoNewline`,
    "if ($opengroveStatus -eq 0) {",
    '  Write-Host "`nLogin complete. This window can be closed."',
    "} else {",
    '  Write-Host "`nLogin failed (exit $opengroveStatus). Review the CLI output above."',
    '  [void](Read-Host "Press Enter to close")',
    "}",
    "exit $opengroveStatus",
    "",
  ].join("\r\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("invalid_terminal_environment_name");
  return value;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("invalid_terminal_environment_name");
  return value;
}
