import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type WindowsCommandQuery = (
  executable: "powershell.exe",
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => string | undefined;

export interface WindowsEnvironmentProbe {
  platform?: NodeJS.Platform;
  query?: WindowsCommandQuery;
}

// PowerShell emits UTF-8 explicitly; reg.exe's console code page can corrupt
// non-ASCII user/install directories when Node decodes redirected output.
const REGISTRY_PATH_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$paths = @(
  [string][Environment]::GetEnvironmentVariable('Path', 'Machine')
  [string][Environment]::GetEnvironmentVariable('Path', 'User')
)
ConvertTo-Json -InputObject $paths -Compress
`;

/** Read current registry values: a running desktop process retains its old PATH. */
export function refreshWindowsPath(
  environment: NodeJS.ProcessEnv,
  probe: WindowsEnvironmentProbe = {},
): NodeJS.ProcessEnv {
  if ((probe.platform ?? process.platform) !== "win32") return environment;
  const query = probe.query ?? queryWindowsCommand;
  const paths = [windowsEnvironmentValue(environment, "PATH") ?? ""];
  const output = query(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", REGISTRY_PATH_QUERY],
    environment,
  );
  if (output?.trim()) {
    try {
      const values: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
      if (!Array.isArray(values) || !values.every((value) => typeof value === "string"))
        throw new Error("expected PATH strings");
      paths.push(
        ...values.map((value: string) =>
          value.replace(
            /%([^%]+)%/g,
            (reference: string, name: string) => windowsEnvironmentValue(environment, name) ?? reference,
          ),
        ),
      );
    } catch {
      console.warn("[windows-discovery] Registry PATH query returned invalid JSON");
    }
  }
  const unique = new Map<string, string>();
  for (const entry of paths.flatMap((value) => value.split(";"))) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (directory && !unique.has(directory.toLowerCase())) unique.set(directory.toLowerCase(), directory);
  }
  // Node passes only one case-insensitive PATH key to Windows children.
  const merged = { ...environment };
  for (const key of Object.keys(merged)) if (key.toLowerCase() === "path") delete merged[key];
  merged.PATH = [...unique.values()].join(";");
  return merged;
}

export function windowsEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return (
    environment[name] ?? Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  );
}

/** Fixed system executables and bounded probes; never resolve helpers from a project PATH. */
export const queryWindowsCommand: WindowsCommandQuery = (executable, args, environment) => {
  const systemRoot =
    windowsEnvironmentValue(environment, "SystemRoot") || windowsEnvironmentValue(environment, "WINDIR");
  if (!systemRoot) return undefined;
  const command = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", executable);
  const result = spawnSync(command, args, {
    env: environment,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    console.warn(`[windows-discovery] ${executable} probe failed: ${result.error.message}`);
    return undefined;
  }
  if (result.status !== 0) {
    console.warn(`[windows-discovery] ${executable} probe exited with status ${result.status}`);
    return undefined;
  }
  return result.stdout;
};
